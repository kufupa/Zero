/**
 * Recover `parse_failure` quarantine rows into normal message storage.
 *
 * These rows already passed MIME parse + routing, then died on a later
 * persist side-effect (historically `ai_workflow_run.executor_lane` missing).
 * Do not reuse missing-owner promotion: that path stamps ReserveCloud staff
 * copies outbound and skips everyone else.
 */
import {
  CENTURION_INGEST_MAILBOX_IDS,
  isCenturionIngestMailboxId,
  parsePromoteCliArgs,
  type PromoteQuarantineOptions,
  type PromoteQuarantineResult,
  type PromoteQuarantineRow,
} from './promote-quarantine.js';
import {
  cleanupPartialParseFailureAttachments,
  persistInboundMessage,
  claimIngestUidl,
  releaseIngestUidlClaim,
  type QuarantineReason,
} from './store.js';
import { completeFanoutAfterPrimary } from './fanout.js';
import {
  candidateMessageIdForPop3Uidl,
  parseRawMessage,
  uploadedAttachmentsFromParseFailure,
  type ParsedInboundMessage,
} from './parse-message.js';
import { getS3Storage, quarantineArchiveKey, type S3Storage } from '../../storage/s3.js';
import { mailIngestQuarantine } from '../../db/schema/mail.js';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DB } from '../../db/client.js';

const PARSE_FAILURE_REASON = 'parse_failure';
/** Same mark as `fanoutCopyPop3Uidl` — unit separator, not a `#t:` suffix. */
const COPY_UIDL_MARK = '\u001f';

export function parseRecoverCliArgs(argv: string[]): {
  dryRun: boolean;
  limit?: number;
  skipAiEnqueue: boolean;
} {
  if (argv.some((arg) => arg === '--reason' || arg.startsWith('--reason='))) {
    throw new Error('unknown argument: --reason');
  }
  if (argv.some((arg) => arg === '--mailbox' || arg.startsWith('--mailbox='))) {
    throw new Error('unknown argument: --mailbox');
  }
  const enqueueAi = argv.includes('--enqueue-ai');
  const rest = argv.filter((arg) => arg !== '--enqueue-ai');
  const parsed = parsePromoteCliArgs(rest);
  return { ...parsed, skipAiEnqueue: !enqueueAi };
}

function isFanoutCopyPop3Uidl(pop3Uidl: string): boolean {
  return pop3Uidl.includes(COPY_UIDL_MARK);
}

export interface RecoverParseFailureOptions extends PromoteQuarantineOptions {
  /** Default true: bulk recover must not enqueue triage/shadow on a drifted schema. */
  skipAiEnqueue?: boolean;
}

type RecoverErrorReason =
  | 'raw_mime_missing'
  | 'ingest_uidl_claim_pending'
  | 'recovery_failed'
  | 'attachment_cleanup_failed';
export type RecoverRowOutcome = {
  id: string;
  kind: RecoverOneOutcome['kind'];
  reason?: RecoverErrorReason | QuarantineReason;
};
export interface RecoverParseFailureResult extends PromoteQuarantineResult {
  /** Opaque row IDs and bounded reason codes; never SQL, MIME or error parameters. */
  outcomes: RecoverRowOutcome[];
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
): Promise<RecoverParseFailureResult> {
  const storage = opts.storage ?? getS3Storage();
  const rows = await listParseFailureQuarantine(opts.db, opts.limit);
  const skipAiEnqueue = opts.skipAiEnqueue !== false;

  const result: RecoverParseFailureResult = {
    scanned: rows.length,
    stored: 0,
    duplicate: 0,
    quarantined: 0,
    errors: 0,
    skipped: 0,
    errorIds: [],
    dryRunIds: [],
    outcomes: [],
  };

  for (const row of rows) {
    const outcome = await recoverOneParseFailureRow(row, {
      db: opts.db,
      storage,
      dryRun: opts.dryRun ?? false,
      skipAiEnqueue,
    });
    result.outcomes.push({
      id: row.id,
      kind: outcome.kind,
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
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
  | { kind: 'quarantined'; reason?: QuarantineReason }
  | { kind: 'error'; reason: RecoverErrorReason };

async function recoverOneParseFailureRow(
  row: PromoteQuarantineRow,
  opts: { db: DB; storage: S3Storage; dryRun: boolean; skipAiEnqueue: boolean },
): Promise<RecoverOneOutcome> {
  const { db, storage } = opts;
  if (!isCenturionIngestMailboxId(row.ingestMailboxId)) {
    return { kind: 'skipped' };
  }
  if (isFanoutCopyPop3Uidl(row.pop3Uidl)) {
    return { kind: 'skipped' };
  }
  const meta = {
    ingestMailboxId: row.ingestMailboxId,
    pop3Uidl: row.pop3Uidl,
  };
  const messageId = candidateMessageIdForPop3Uidl(row.ingestMailboxId, row.pop3Uidl);
  let parsed: ParsedInboundMessage | undefined;

  try {
    const loaded = await loadRecoverRawMime(storage, row);
    if (!loaded) {
      return {
        kind: 'error',
        reason: 'raw_mime_missing',
      };
    }

    if (opts.dryRun) {
      return { kind: 'dry-run' };
    }

    const claimToken = await claimIngestUidl(db, meta);
    if (!claimToken) {
      return { kind: 'error', reason: 'ingest_uidl_claim_pending' };
    }

    try {
      parsed = await parseRawMessage(loaded.object.body, {
        messageId,
        storage,
      });

      const persistMeta = {
        ...meta,
        messageId,
        ...(loaded.source === 'primary' ? { rawMimeS3Key: row.rawMimeS3Key } : {}),
      };
      const persistResult = await persistInboundMessage(
        parsed,
        loaded.object.body,
        persistMeta,
        {
          db,
          storage,
          deferQuarantineDelete: true,
          skipAiEnqueue: opts.skipAiEnqueue,
          activeIngestUidlClaimToken: claimToken,
        },
      );

      if (
        persistResult.kind === 'stored' ||
        persistResult.kind === 'duplicate' ||
        persistResult.kind === 'reconciled'
      ) {
        const copiesOk = await completeFanoutAfterPrimary({
          db,
          storage,
          raw: loaded.object.body,
          meta: persistMeta,
          persistResult,
          skipAiEnqueue: opts.skipAiEnqueue,
        });
        if (!copiesOk) {
          return { kind: 'error', reason: 'recovery_failed' };
        }
        await db.delete(mailIngestQuarantine).where(eq(mailIngestQuarantine.id, row.id));
        return persistResult.kind === 'duplicate' ? { kind: 'duplicate' } : { kind: 'stored' };
      }
      if (persistResult.kind === 'failed' || persistResult.kind === 'deferred') {
        return { kind: 'error', reason: 'recovery_failed' };
      }
      if (persistResult.kind === 'quarantined' && persistResult.reason !== PARSE_FAILURE_REASON) {
        await db
          .update(mailIngestQuarantine)
          .set({ reason: persistResult.reason })
          .where(eq(mailIngestQuarantine.id, row.id));
      }
      return {
        kind: 'quarantined',
        ...(persistResult.kind === 'quarantined' ? { reason: persistResult.reason } : {}),
      };
    } catch (err) {
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
            activeIngestUidlClaimToken: claimToken,
          });
        } catch {
          return {
            kind: 'error',
            reason: 'attachment_cleanup_failed',
          };
        }
      }
      return { kind: 'error', reason: 'recovery_failed' };
    } finally {
      await releaseIngestUidlClaim(db, meta, claimToken);
    }
  } catch {
    return { kind: 'error', reason: 'recovery_failed' };
  }
}

async function loadRecoverRawMime(
  storage: S3Storage,
  row: PromoteQuarantineRow,
): Promise<{
  object: { body: Buffer; contentType: string };
  source: 'primary' | 'archive';
} | null> {
  const primary = await storage.getObject(row.rawMimeS3Key);
  if (primary) return { object: primary, source: 'primary' };
  const archived = await storage.getObject(
    quarantineArchiveKey({
      ingestMailboxId: row.ingestMailboxId,
      pop3Uidl: row.pop3Uidl,
    }),
  );
  if (!archived) return null;
  return { object: archived, source: 'archive' };
}

