/**
 * Recover `parse_failure` quarantine rows into normal message storage.
 *
 * These rows already passed MIME parse + routing, then died on a later
 * persist side-effect (historically `ai_workflow_run.executor_lane` missing).
 * Do not reuse missing-owner promotion: that path stamps ReserveCloud staff
 * copies outbound and skips everyone else.
 */
import {
  candidateMessageIdForPop3Uidl,
  parseRawMessage,
  uploadedAttachmentsFromParseFailure,
  type ParsedInboundMessage,
} from './parse-message.js';
import { cleanupPartialParseFailureAttachments, persistInboundMessage } from './store.js';
import {
  CENTURION_INGEST_MAILBOX_IDS,
  isCenturionIngestMailboxId,
  type PromoteQuarantineOptions,
  type PromoteQuarantineResult,
  type PromoteQuarantineRow,
} from './promote-quarantine.js';
import { mailIngestQuarantine, message } from '../../db/schema/mail.js';
import { getS3Storage, quarantineArchiveKey, type S3Storage } from '../../storage/s3.js';
import type { DB } from '../../db/client.js';
import { and, asc, eq, inArray } from 'drizzle-orm';

const PARSE_FAILURE_REASON = 'parse_failure';

export interface RecoverParseFailureOptions extends PromoteQuarantineOptions {
  /** Default true: bulk recover must not enqueue triage/shadow on a drifted schema. */
  skipAiEnqueue?: boolean;
}

export async function listParseFailureQuarantine(
  db: DB,
  limit?: number,
): Promise<PromoteQuarantineRow[]> {
  const query = db
    .select({
      id: mailIngestQuarantine.id,
      ingestMailboxId: mailIngestQuarantine.ingestMailboxId,
      pop3Uidl: mailIngestQuarantine.pop3Uidl,
      rawMimeS3Key: mailIngestQuarantine.rawMimeS3Key,
    })
    .from(mailIngestQuarantine)
    .where(
      and(
        eq(mailIngestQuarantine.reason, PARSE_FAILURE_REASON),
        inArray(mailIngestQuarantine.ingestMailboxId, [...CENTURION_INGEST_MAILBOX_IDS]),
      ),
    )
    .orderBy(asc(mailIngestQuarantine.createdAt));

  if (limit !== undefined) {
    return query.limit(limit);
  }
  return query;
}

export async function recoverParseFailureQuarantine(
  opts: RecoverParseFailureOptions,
): Promise<PromoteQuarantineResult> {
  const storage = opts.storage ?? getS3Storage();
  const rows = await listParseFailureQuarantine(opts.db, opts.limit);
  const skipAiEnqueue = opts.skipAiEnqueue !== false;

  const result: PromoteQuarantineResult = {
    scanned: rows.length,
    stored: 0,
    duplicate: 0,
    quarantined: 0,
    errors: 0,
    skipped: 0,
    errorIds: [],
    dryRunIds: [],
  };

  for (const row of rows) {
    const outcome = await recoverOneParseFailureRow(row, {
      db: opts.db,
      storage,
      dryRun: opts.dryRun ?? false,
      skipAiEnqueue,
    });

    switch (outcome.kind) {
      case 'dry-run':
        result.dryRunIds.push(row.id);
        break;
      case 'skipped':
        result.skipped = (result.skipped ?? 0) + 1;
        break;
      case 'stored':
        result.stored += 1;
        break;
      case 'duplicate':
        result.duplicate += 1;
        break;
      case 'quarantined':
        result.quarantined += 1;
        break;
      case 'error':
        result.errors += 1;
        result.errorIds.push(row.id);
        break;
    }
  }

  return result;
}

type RecoverOneOutcome =
  | { kind: 'dry-run' }
  | { kind: 'skipped' }
  | { kind: 'stored' }
  | { kind: 'duplicate' }
  | { kind: 'quarantined' }
  | { kind: 'error'; message: string };

async function recoverOneParseFailureRow(
  row: PromoteQuarantineRow,
  opts: { db: DB; storage: S3Storage; dryRun: boolean; skipAiEnqueue: boolean },
): Promise<RecoverOneOutcome> {
  const { db, storage } = opts;
  if (!isCenturionIngestMailboxId(row.ingestMailboxId)) {
    return { kind: 'skipped' };
  }
  const meta = {
    ingestMailboxId: row.ingestMailboxId,
    pop3Uidl: row.pop3Uidl,
  };
  const messageId = candidateMessageIdForPop3Uidl(row.ingestMailboxId, row.pop3Uidl);
  let parsed: ParsedInboundMessage | undefined;

  try {
    const object = await loadRecoverRawMime(storage, row);
    if (!object) {
      return {
        kind: 'error',
        message: `missing s3 object ${row.rawMimeS3Key} and archive ${quarantineArchiveKey(row)}`,
      };
    }

    if (opts.dryRun) {
      return { kind: 'dry-run' };
    }

    const existing = await findExistingMessageAnyDirection(db, meta);
    if (existing) {
      await db.delete(mailIngestQuarantine).where(eq(mailIngestQuarantine.id, row.id));
      return { kind: 'duplicate' };
    }

    parsed = await parseRawMessage(object.body, {
      messageId,
      storage,
    });

    const persistResult = await persistInboundMessage(
      parsed,
      object.body,
      {
        ...meta,
        messageId,
        rawMimeS3Key: row.rawMimeS3Key,
      },
      {
        db,
        storage,
        promoteQuarantineId: row.id,
        skipAiEnqueue: opts.skipAiEnqueue,
      },
    );

    if (persistResult.kind === 'stored') {
      return { kind: 'stored' };
    }
    if (persistResult.kind === 'duplicate') {
      await db.delete(mailIngestQuarantine).where(eq(mailIngestQuarantine.id, row.id));
      return { kind: 'duplicate' };
    }
    if (persistResult.kind === 'quarantined' && persistResult.reason !== PARSE_FAILURE_REASON) {
      await db
        .update(mailIngestQuarantine)
        .set({ reason: persistResult.reason })
        .where(eq(mailIngestQuarantine.id, row.id));
    }
    return { kind: 'quarantined' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const uploadedAttachments = [
      ...new Map(
        [...(parsed?.attachments ?? []), ...uploadedAttachmentsFromParseFailure(err)].map(
          (attachment) => [attachment.s3Key, attachment],
        ),
      ).values(),
    ];
    if (uploadedAttachments.length > 0) {
      try {
        await cleanupPartialParseFailureAttachments({
          db,
          storage,
          attachments: uploadedAttachments,
          meta: {
            ...meta,
            messageId,
            rawMimeS3Key: row.rawMimeS3Key,
          },
        });
      } catch (cleanupError) {
        const cleanupMessage =
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        return {
          kind: 'error',
          message: `${message}; candidate attachment cleanup registration failed: ${cleanupMessage}`,
        };
      }
    }
    return { kind: 'error', message };
  }
}

async function loadRecoverRawMime(
  storage: S3Storage,
  row: PromoteQuarantineRow,
): Promise<{ body: Buffer; contentType: string } | null> {
  const primary = await storage.getObject(row.rawMimeS3Key);
  if (primary) return primary;
  return storage.getObject(
    quarantineArchiveKey({
      ingestMailboxId: row.ingestMailboxId,
      pop3Uidl: row.pop3Uidl,
    }),
  );
}

async function findExistingMessageAnyDirection(
  db: DB,
  meta: Pick<PromoteQuarantineRow, 'ingestMailboxId' | 'pop3Uidl'>,
): Promise<{ id: string; transportId: string } | undefined> {
  const rows = await db
    .select({ id: message.id, transportId: message.transportId })
    .from(message)
    .where(
      and(eq(message.ingestMailboxId, meta.ingestMailboxId), eq(message.pop3Uidl, meta.pop3Uidl)),
    )
    .limit(1);
  return rows[0];
}
