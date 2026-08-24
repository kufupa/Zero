/**
 * Persist an inbound message to Postgres + S3.
 *
 * Routing:
 *   1. Parse `X-Zero-Mailbox` header from the parsed message.
 *   2. Look up `mailboxTransport` by `ownerHeaderValue`. If found, store the
 *      message scoped to that transport (create/find a thread, insert
 *      `message` + `attachment` rows).
 *   3. If the header is missing, try direct `To` match against active transport
 *      emails; when `INGEST_REQUIRE_OWNER_HEADER=false`, also match Centurion
 *      transport email/aliases on To/Cc/Bcc/From. On miss quarantine with
 *      reason `missing_owner_header`. If the header is present but no matching
 *      transport (owner header or alias) -> quarantine with reason
 *      `unknown_transport`.
 *   4. Degraded containment: when `AI_WRITE_GATE_ENABLED` is not `'true'`,
 *      apply soft label `soft-quarantine` for From domains outside the
 *      transport domain (healthy gated path stays inbox-first).
 *
 * Persistence order (inside one PG transaction):
 *   - raw MIME already uploaded to S3 BEFORE this function is called (worker
 *     does S3 PUT before persisting; tests pass `rawMimeS3Key`).
 *   - attachments already uploaded to S3 during parsing (parse-message.ts).
 *   - insert `message` + `attachment` rows in one transaction; commit.
 *
 * The PG transaction here is the *real* commit for the worker's safety order.
 * If this commit succeeds, the worker is allowed to DELE the POP3 message.
 *
 * Tests run this inside `withTestDb` so the transaction is rolled back; in
 * production the transaction commits for real.
 */
import {
  emitRocketseedReturnedCopyTrustRejection,
  evaluateRocketseedReturnedCopyTrust,
  evaluateRocketseedReturnedCopyPrecheck,
  normalizeRocketseedMailbox,
} from './rocketseed-returned-copy.js';
import {
  attachment,
  mailIngestQuarantine,
  mailLabel,
  mailboxTransport,
  message,
  mailThread,
  outboundSendQueue,
} from '../../db/schema/mail.js';
import {
  DEFAULT_AI_MODEL_ID,
  DEFAULT_TRIAGE_PROMPT_VERSION,
  enqueueAiRun,
} from '../../ai/run-ledger.js';
import { type ParsedInboundMessage, parseRawMessage, generateMessageId } from './parse-message.js';
import { rawMimeKey, getS3Storage, type S3Storage } from '../../storage/s3.js';
import { parsePersistedDeliveryOutcome } from '../send/outbound-queue.js';
import { refreshThreadSearchVector } from '../search/search-vector.js';
import { sanitizeHtmlBodyForStorage } from '../sanitize-email-html.js';
import { getSenderPreference } from '../sender-preference.js';
import { ingestRequireOwnerHeader } from '../../env.js';
import { markThreadRead } from '../thread-read.js';
import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { randomUUID } from 'node:crypto';

const CENTURION_TRANSPORT_ID = 'transport-centurion';
export const CANDIDATE_ATTACHMENT_DELETE_CONCURRENCY = 4;

type RoutedTransport = {
  id: string;
  email: string;
  sendFromConfig: unknown;
};

export type QuarantineReason =
  | 'missing_owner_header'
  | 'unknown_transport'
  | 'message_too_large'
  | 'parse_failure';

export type PersistKind = 'stored' | 'quarantined' | 'duplicate' | 'reconciled';

export interface IngestMeta {
  /** Mailbox id the message was ingested from (e.g. `ingest-nava-legacy`). */
  ingestMailboxId: string;
  /** POP3 UIDL on the ingest mailbox. */
  pop3Uidl: string;
  /**
   * DB message id to use for the `message` row. MUST equal the id passed to
   * `parseRawMessage` (which namespaces attachment S3 keys as
   * `attachments/{messageId}/...`) so the S3 key prefix and the DB
   * `message.id` stay aligned. One UUID threaded through both layers.
   */
  messageId: string;
  /**
   * Optional pre-uploaded raw-mime S3 key. The worker pre-PUTs raw MIME to
   * S3 before persisting, so it passes the key here to avoid a second PUT.
   * When absent, `persistInboundMessage` uploads the raw bytes itself.
   */
  rawMimeS3Key?: string;
}

export interface PersistStoredResult {
  kind: 'stored';
  transportId: string;
  messageId: string;
  threadId: string;
  rawMimeS3Key: string;
  attachmentCount: number;
}

export interface PersistQuarantinedResult {
  kind: 'quarantined';
  quarantineId: string;
  reason: QuarantineReason;
  rawMimeS3Key: string;
}

export interface PersistDuplicateResult {
  kind: 'duplicate';
  transportId: string;
  messageId: string;
  rawMimeS3Key: string;
  candidateAttachmentCleanupFailureCount: number;
}

export interface PersistReconciledResult {
  kind: 'reconciled';
  transportId: string;
  messageId: string;
  rawMimeS3Key: string;
  attachmentCount: number;
}

export type PersistResult =
  | PersistStoredResult
  | PersistQuarantinedResult
  | PersistDuplicateResult
  | PersistReconciledResult;

export interface PersistOptions {
  /** DB handle (production: getDb(); tests: transaction-scoped handle). */
  db: DB;
  /** S3 storage override (tests inject a fake). */
  storage?: S3Storage;
  /**
   * Returned-copy reconciliation is only valid for newly retrieved POP3
   * messages. Historical promotion and rehydration must use ordinary ingest.
   */
  ingestSource?: 'live-pop3';
  /**
   * Promote path: skip existing-quarantine short-circuit and delete this row
   * atomically when the message insert commits.
   */
  promoteQuarantineId?: string;
  /**
   * Rehydrate path: restore rows without enqueueing inbound_triage (avoids
   * flooding Bedrock when bulk-recovering historical S3 MIME).
   */
  skipAiEnqueue?: boolean;
}

/**
 * Persist a parsed inbound message.
 *
 * Pre-conditions (worker enforces these):
 *   - raw MIME bytes have already been PUT to S3; pass the key via the
 *     `rawMimeS3Key` field of `meta`-derived input.
 *
 * If `rawMimeS3Key` is not provided, the function uploads the raw bytes to S3
 * itself (used by tests that call `persistInboundMessage` directly without
 * the worker's pre-PUT step).
 */
export async function persistInboundMessage(
  parsed: ParsedInboundMessage,
  raw: Buffer,
  meta: IngestMeta,
  opts: PersistOptions,
): Promise<PersistResult> {
  const { db } = opts;
  const storage = opts.storage ?? getS3Storage();

  const rawMimeS3Key =
    meta.rawMimeS3Key ??
    rawMimeKey({
      ingestMailboxId: meta.ingestMailboxId,
      pop3Uidl: meta.pop3Uidl,
    });
  if (!meta.rawMimeS3Key) {
    await storage.putObject({
      key: rawMimeS3Key,
      body: raw,
      contentType: 'message/rfc822',
    });
  }

  const existingMessage = await findExistingInboundMessage(db, meta);
  if (existingMessage) {
    const candidateAttachmentCleanupFailureCount = await cleanupCandidateAttachmentObjects(
      storage,
      parsed.attachments,
      meta.messageId,
      existingMessage.id,
    );
    return {
      kind: 'duplicate',
      transportId: existingMessage.transportId,
      messageId: existingMessage.id,
      rawMimeS3Key,
      candidateAttachmentCleanupFailureCount,
    };
  }

  const existingQuarantine = opts.promoteQuarantineId
    ? undefined
    : await findExistingQuarantine(db, meta);
  if (existingQuarantine) {
    return {
      kind: 'quarantined',
      quarantineId: existingQuarantine.id,
      reason: existingQuarantine.reason as QuarantineReason,
      rawMimeS3Key: existingQuarantine.rawMimeS3Key,
    };
  }

  // Routing ------------------------------------------------------------
  let transport: RoutedTransport | null = null;

  if (!parsed.ownerHeaderValue) {
    transport = await findDirectToTransport(db, parsed.toAddresses);
    if (!transport && !ingestRequireOwnerHeader()) {
      transport = await findCenturionEquatedTransport(db, parsed);
    }
    if (!transport) {
      return quarantineUnrouted({
        db,
        parsed,
        meta,
        rawMimeS3Key,
        reason: 'missing_owner_header',
      });
    }
    // Inbox-first: direct-To without X-Zero-Mailbox still stores + enqueues
    // triage; AI (when write gate on) may set spam later.
  } else {
    transport = await findTransportByStamp(db, parsed.ownerHeaderValue);
    if (!transport) {
      return quarantineUnrouted({
        db,
        parsed,
        meta,
        rawMimeS3Key,
        reason: 'unknown_transport',
      });
    }
  }

  const messageId = meta.messageId;
  let threadId = '';
  let duplicate: PersistDuplicateResult | null = null;
  let duplicateCanonicalMessageId = messageId;
  let reconciliation: PersistReconciledResult | null = null;
  await db.transaction(async (tx) => {
    const transactionDb = tx as unknown as DB;
    const correlationId =
      parsed.outboundCorrelation.kind === 'valid'
        ? parsed.outboundCorrelation.outboundId
        : parsed.outboundCorrelation.kind === 'absent'
          ? parsed.messageId
          : null;
    const useMessageIdFallback = parsed.outboundCorrelation.kind === 'absent';
    const hasEligibleLegacyReturnedCopyPrecheck =
      useMessageIdFallback &&
      correlationId !== null &&
      evaluateRocketseedReturnedCopyPrecheck({
        expectedTransportAddress: transport.email,
        parsed,
      }).trusted;
    const canonical =
      opts.ingestSource === 'live-pop3' &&
      correlationId &&
      (!useMessageIdFallback || hasEligibleLegacyReturnedCopyPrecheck)
        ? await findEligibleCanonicalOutbound(
            transactionDb,
            transport.id,
            correlationId,
            useMessageIdFallback,
          )
        : undefined;
    const hasEligibleLocalQueueRow =
      canonical?.queueStatus === 'sent' ||
      (canonical?.queueStatus === 'sending' &&
        hasProvenPersistedSendingDelivery({
          expectedTransportAddress: transport.email,
          messageIdHeader: canonical.messageIdHeader,
          parsedMessageId: parsed.messageId,
          requiresExactReturnedMessageId: parsed.outboundCorrelation.kind !== 'valid',
          smtpPayload: canonical.smtpPayload,
        }));
    const returnedCopyTrust = evaluateRocketseedReturnedCopyTrust({
      activeTransportId: canonical?.transportId ?? null,
      expectedTransportId: transport.id,
      expectedTransportAddress: transport.email,
      hasEligibleLocalQueueRow,
      parsed,
    });
    if (
      opts.ingestSource === 'live-pop3' &&
      parsed.outboundCorrelation.kind === 'valid' &&
      !returnedCopyTrust.trusted
    ) {
      emitRocketseedReturnedCopyTrustRejection(returnedCopyTrust.reason);
    }
    if (canonical && returnedCopyTrust.trusted) {
      if (canonical.ingestMailboxId || canonical.pop3Uidl) {
        duplicate = {
          kind: 'duplicate',
          transportId: canonical.transportId,
          messageId: canonical.id,
          rawMimeS3Key,
          candidateAttachmentCleanupFailureCount: 0,
        };
        duplicateCanonicalMessageId = canonical.id;
        return;
      }
      const durableSmtpMessageId =
        parsed.outboundCorrelation.kind === 'valid' &&
        canonical.queueStatus === 'sending' &&
        canonical.messageIdHeader === null
          ? (parsePersistedDeliveryOutcome(canonical.smtpPayload)?.messageId ?? null)
          : null;
      await transactionDb
        .update(message)
        .set({
          ingestMailboxId: meta.ingestMailboxId,
          pop3Uidl: meta.pop3Uidl,
          ownerHeaderValue: parsed.ownerHeaderValue,
          messageIdHeader: canonical.messageIdHeader ?? durableSmtpMessageId ?? parsed.messageId,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references,
          fromAddress: parsed.fromAddress ?? '',
          toAddresses: parsed.toAddresses,
          ccAddresses: parsed.ccAddresses,
          bccAddresses: parsed.bccAddresses,
          subject: parsed.subject,
          textBody: parsed.textBody,
          htmlBody: sanitizeHtmlBodyForStorage(parsed.htmlBody),
          rawMimeS3Key,
          receivedAt: parsed.receivedAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(message.id, canonical.id), eq(message.transportId, canonical.transportId)));
      if (parsed.attachments.length > 0) {
        await transactionDb.insert(attachment).values(
          parsed.attachments.map((a) => ({
            id: randomUUID(),
            messageId: canonical.id,
            filename: a.filename,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            s3Key: a.s3Key,
            contentId: a.contentId,
            isInline: a.isInline,
          })),
        );
      }
      reconciliation = {
        kind: 'reconciled',
        transportId: canonical.transportId,
        messageId: canonical.id,
        rawMimeS3Key,
        attachmentCount: parsed.attachments.length,
      };
      return;
    }

    threadId = await resolveThreadId({
      tx: tx as unknown as DB,
      transportId: transport.id,
      parsed,
      pop3Uidl: meta.pop3Uidl,
    });

    const transportEmail = (transport.email ?? '').trim().toLowerCase();
    const fromAddress = (parsed.fromAddress ?? '').trim().toLowerCase();
    const fromEmail = normalizeEmailAddress(fromAddress);
    const recipientEmails = [
      ...parsed.toAddresses,
      ...parsed.ccAddresses,
      ...parsed.bccAddresses,
    ].map(normalizeEmailAddress);
    const transportIdentities = transportIdentitySet(transport.email, transport.sendFromConfig);
    const isSelfIngestLoopback =
      transportIdentities.size > 0 && recipientEmails.some((a) => transportIdentities.has(a));
    const isHotelSent =
      Boolean(fromEmail) && transportIdentities.has(fromEmail) && !isSelfIngestLoopback;

    await tx.insert(message).values({
      id: messageId,
      transportId: transport.id,
      threadId,
      ingestMailboxId: meta.ingestMailboxId,
      direction: isHotelSent ? 'outbound' : 'inbound',
      pop3Uidl: meta.pop3Uidl,
      ownerHeaderValue: parsed.ownerHeaderValue,
      messageIdHeader: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      fromAddress: parsed.fromAddress ?? '',
      toAddresses: parsed.toAddresses,
      ccAddresses: parsed.ccAddresses,
      bccAddresses: parsed.bccAddresses,
      subject: parsed.subject,
      textBody: parsed.textBody,
      htmlBody: sanitizeHtmlBodyForStorage(parsed.htmlBody),
      rawMimeS3Key,
      receivedAt: parsed.receivedAt ?? new Date(),
      sentAt: parsed.receivedAt ?? null,
      isRead: isHotelSent,
    });

    if (isHotelSent) {
      await markThreadRead(tx as unknown as DB, transport.id, [threadId]);
    }

    if (parsed.attachments.length > 0) {
      await tx.insert(attachment).values(
        parsed.attachments.map((a) => ({
          id: randomUUID(),
          messageId,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          s3Key: a.s3Key,
          contentId: a.contentId,
          isInline: a.isInline,
        })),
      );
    }

    // Degraded soft-quarantine when AI write gate off: external From domains
    // only. Does not set spamAt — inbox-first until AI can triage.
    if (
      !isHotelSent &&
      process.env.AI_WRITE_GATE_ENABLED !== 'true' &&
      isExternalFromDomain(fromEmail, transportEmail)
    ) {
      const softLabelId = await ensureSoftQuarantineLabel(tx as unknown as DB, transport.id);
      await applyThreadLabels(tx as unknown as DB, threadId, [softLabelId]);
    }

    await refreshThreadSearchVector(tx as unknown as DB, threadId);

    if (!isHotelSent && parsed.fromAddress) {
      const preference = await getSenderPreference({
        db: tx as unknown as DB,
        transportId: transport.id,
        emailRaw: parsed.fromAddress,
      });
      if (preference === 'block') {
        await tx
          .update(mailThread)
          .set({ spamAt: new Date(), updatedAt: new Date() })
          .where(eq(mailThread.id, threadId));
      }
    }

    if (!isHotelSent && !opts.skipAiEnqueue) {
      await enqueueAiRun(
        {
          transportId: transport.id,
          threadId,
          triggerMessageId: messageId,
          runKind: 'inbound_triage',
          idempotencyKey: `inbound-triage:${messageId}`,
          modelId: DEFAULT_AI_MODEL_ID,
          promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
        },
        tx as unknown as DB,
      );
    }

    if (opts.promoteQuarantineId) {
      await tx
        .delete(mailIngestQuarantine)
        .where(eq(mailIngestQuarantine.id, opts.promoteQuarantineId));
    }
  });

  if (duplicate) {
    const candidateAttachmentCleanupFailureCount = await cleanupCandidateAttachmentObjects(
      storage,
      parsed.attachments,
      messageId,
      duplicateCanonicalMessageId,
    );
    return withCandidateAttachmentCleanupFailures(
      duplicate,
      candidateAttachmentCleanupFailureCount,
    );
  }
  if (reconciliation) return reconciliation;

  return {
    kind: 'stored',
    transportId: transport.id,
    messageId,
    threadId,
    rawMimeS3Key,
    attachmentCount: parsed.attachments.length,
  };
}

export async function cleanupCandidateAttachmentObjects(
  storage: S3Storage,
  attachments: ParsedInboundMessage['attachments'],
  candidateMessageId: string,
  canonicalMessageId: string,
): Promise<number> {
  if (candidateMessageId === canonicalMessageId) return 0;

  const candidatePrefix = `attachments/${candidateMessageId}/`;
  const keys = [
    ...new Set(
      attachments
        .map((attachment) => attachment.s3Key)
        .filter((key) => key.startsWith(candidatePrefix)),
    ),
  ];
  let nextKeyIndex = 0;
  let failureCount = 0;
  const deleteWorker = async () => {
    while (nextKeyIndex < keys.length) {
      const key = keys[nextKeyIndex++];
      if (!key) return;
      try {
        await storage.deleteObject(key);
      } catch {
        failureCount += 1;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(CANDIDATE_ATTACHMENT_DELETE_CONCURRENCY, keys.length) },
      deleteWorker,
    ),
  );
  return failureCount;
}

function withCandidateAttachmentCleanupFailures(
  result: PersistDuplicateResult,
  candidateAttachmentCleanupFailureCount: number,
): PersistDuplicateResult {
  return { ...result, candidateAttachmentCleanupFailureCount };
}

/**
 * Quarantine a message that exceeded ingest size limits. Called by the worker
 * when `parseRawMessage` throws `IngestTooLargeError` after raw MIME is
 * already in S3.
 */
export async function quarantineOversizedMessage(
  meta: Pick<IngestMeta, 'ingestMailboxId' | 'pop3Uidl'>,
  rawMimeS3Key: string,
  opts: Pick<PersistOptions, 'db'>,
  parsedHeaders?: Record<string, unknown>,
): Promise<PersistQuarantinedResult> {
  const existing = await findExistingQuarantine(opts.db, meta);
  if (existing) {
    return {
      kind: 'quarantined',
      quarantineId: existing.id,
      reason: existing.reason as QuarantineReason,
      rawMimeS3Key: existing.rawMimeS3Key,
    };
  }

  const quarantineId = randomUUID();
  await opts.db.insert(mailIngestQuarantine).values({
    id: quarantineId,
    ingestMailboxId: meta.ingestMailboxId,
    pop3Uidl: meta.pop3Uidl,
    rawMimeS3Key,
    reason: 'message_too_large',
    ownerHeaderValue: null,
    parsedHeaders: parsedHeaders ?? null,
  });
  return {
    kind: 'quarantined',
    quarantineId,
    reason: 'message_too_large',
    rawMimeS3Key,
  };
}

/**
 * Quarantine a poison message after repeated parse failures.
 */
export async function quarantineParseFailure(
  meta: Pick<IngestMeta, 'ingestMailboxId' | 'pop3Uidl'>,
  rawMimeS3Key: string,
  opts: Pick<PersistOptions, 'db'>,
  errorMessage?: string,
): Promise<PersistQuarantinedResult> {
  const existing = await findExistingQuarantine(opts.db, meta);
  if (existing) {
    return {
      kind: 'quarantined',
      quarantineId: existing.id,
      reason: existing.reason as QuarantineReason,
      rawMimeS3Key: existing.rawMimeS3Key,
    };
  }

  const quarantineId = randomUUID();
  await opts.db.insert(mailIngestQuarantine).values({
    id: quarantineId,
    ingestMailboxId: meta.ingestMailboxId,
    pop3Uidl: meta.pop3Uidl,
    rawMimeS3Key,
    reason: 'parse_failure',
    ownerHeaderValue: null,
    parsedHeaders: errorMessage ? { error: errorMessage } : null,
  });
  return {
    kind: 'quarantined',
    quarantineId,
    reason: 'parse_failure',
    rawMimeS3Key,
  };
}

async function findExistingInboundMessage(
  db: DB,
  meta: Pick<IngestMeta, 'ingestMailboxId' | 'pop3Uidl'>,
): Promise<{ id: string; transportId: string } | undefined> {
  const rows = await db
    .select({ id: message.id, transportId: message.transportId })
    .from(message)
    .where(
      and(
        eq(message.ingestMailboxId, meta.ingestMailboxId),
        eq(message.pop3Uidl, meta.pop3Uidl),
        eq(message.direction, 'inbound'),
      ),
    )
    .limit(1);
  return rows[0];
}

type CanonicalOutbound = {
  id: string;
  transportId: string;
  ingestMailboxId: string | null;
  pop3Uidl: string | null;
  messageIdHeader: string | null;
  queueStatus: string;
  smtpPayload: unknown;
};

async function findEligibleCanonicalOutbound(
  db: DB,
  transportId: string,
  correlationId: string,
  useMessageIdFallback: boolean,
): Promise<CanonicalOutbound | undefined> {
  if (!useMessageIdFallback) {
    return findCanonicalOutboundWithQueueLock(db, transportId, correlationId, ['sent', 'sending']);
  }

  // Legacy Message-ID correlation remains sent-only. This unlocked join only
  // identifies a sent candidate; locking follows queue first, then message.
  const [candidate] = await db
    .select({ id: message.id })
    .from(message)
    .innerJoin(
      outboundSendQueue,
      and(
        eq(outboundSendQueue.messageId, message.id),
        eq(outboundSendQueue.transportId, message.transportId),
      ),
    )
    .where(
      and(
        eq(message.messageIdHeader, correlationId),
        eq(message.transportId, transportId),
        eq(message.direction, 'outbound'),
        eq(outboundSendQueue.status, 'sent'),
      ),
    )
    .limit(1);
  if (!candidate) return undefined;

  return findCanonicalOutboundWithQueueLock(db, transportId, candidate.id, ['sent'], correlationId);
}

async function findCanonicalOutboundWithQueueLock(
  db: DB,
  transportId: string,
  canonicalMessageId: string,
  allowedQueueStatuses: readonly string[],
  expectedMessageIdHeader?: string,
): Promise<CanonicalOutbound | undefined> {
  const [queue] = await db
    .select({
      messageId: outboundSendQueue.messageId,
      transportId: outboundSendQueue.transportId,
      queueStatus: outboundSendQueue.status,
      smtpPayload: outboundSendQueue.smtpPayload,
    })
    .from(outboundSendQueue)
    .where(
      and(
        eq(outboundSendQueue.messageId, canonicalMessageId),
        eq(outboundSendQueue.transportId, transportId),
        inArray(outboundSendQueue.status, allowedQueueStatuses),
      ),
    )
    .limit(1)
    .for('update');
  if (!queue) return undefined;

  const [canonical] = await db
    .select({
      id: message.id,
      transportId: message.transportId,
      ingestMailboxId: message.ingestMailboxId,
      pop3Uidl: message.pop3Uidl,
      messageIdHeader: message.messageIdHeader,
    })
    .from(message)
    .where(
      expectedMessageIdHeader === undefined
        ? and(
            eq(message.id, queue.messageId),
            eq(message.transportId, queue.transportId),
            eq(message.direction, 'outbound'),
          )
        : and(
            eq(message.id, queue.messageId),
            eq(message.transportId, queue.transportId),
            eq(message.direction, 'outbound'),
            eq(message.messageIdHeader, expectedMessageIdHeader),
          ),
    )
    .limit(1)
    .for('update');
  if (!canonical) return undefined;

  return {
    ...canonical,
    queueStatus: queue.queueStatus,
    smtpPayload: queue.smtpPayload,
  };
}

function hasProvenPersistedSendingDelivery(args: {
  smtpPayload: unknown;
  parsedMessageId: string | null;
  requiresExactReturnedMessageId: boolean;
  expectedTransportAddress: string;
  messageIdHeader: string | null;
}): boolean {
  try {
    const outcome = parsePersistedDeliveryOutcome(args.smtpPayload);
    if (
      !outcome ||
      (args.requiresExactReturnedMessageId && outcome.messageId !== args.parsedMessageId)
    ) {
      return false;
    }

    const normalizedExpectedTransportAddress = normalizeRocketseedMailbox(
      args.expectedTransportAddress,
    );
    if (!normalizedExpectedTransportAddress) return false;
    if (
      !outcome.accepted.some(
        (recipient) => normalizeRocketseedMailbox(recipient) === normalizedExpectedTransportAddress,
      )
    ) {
      return false;
    }

    return (
      !args.requiresExactReturnedMessageId ||
      !args.messageIdHeader ||
      args.messageIdHeader === outcome.messageId
    );
  } catch {
    return false;
  }
}

async function findExistingQuarantine(
  db: DB,
  meta: Pick<IngestMeta, 'ingestMailboxId' | 'pop3Uidl'>,
): Promise<
  | {
      id: string;
      reason: string;
      rawMimeS3Key: string;
    }
  | undefined
> {
  const rows = await db
    .select({
      id: mailIngestQuarantine.id,
      reason: mailIngestQuarantine.reason,
      rawMimeS3Key: mailIngestQuarantine.rawMimeS3Key,
    })
    .from(mailIngestQuarantine)
    .where(
      and(
        eq(mailIngestQuarantine.ingestMailboxId, meta.ingestMailboxId),
        eq(mailIngestQuarantine.pop3Uidl, meta.pop3Uidl),
      ),
    )
    .limit(1);
  return rows[0];
}

async function findDirectToTransport(
  db: DB,
  toAddresses: string[],
): Promise<RoutedTransport | null> {
  if (toAddresses.length === 0) return null;
  const directTo = new Set(toAddresses.map(normalizeEmailAddress));
  const transports = await db
    .select({
      id: mailboxTransport.id,
      email: mailboxTransport.email,
      sendFromConfig: mailboxTransport.sendFromConfig,
    })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.isActive, true));

  return (
    transports.find((transport) => directTo.has(normalizeEmailAddress(transport.email))) ?? null
  );
}

function normalizeEmailAddress(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.match(/<([^>]+)>/)?.[1]?.toLowerCase() ?? trimmed;
}

function extractTransportAliases(sendFromConfig: unknown): string[] {
  if (!sendFromConfig || typeof sendFromConfig !== 'object') return [];
  const aliases = (sendFromConfig as { aliases?: unknown }).aliases;
  if (!Array.isArray(aliases)) return [];
  return aliases
    .filter((alias): alias is string => typeof alias === 'string')
    .map(normalizeEmailAddress)
    .filter(Boolean);
}

function transportIdentitySet(email: string, sendFromConfig: unknown): Set<string> {
  const identities = new Set<string>();
  const normalizedEmail = normalizeEmailAddress(email);
  if (normalizedEmail) identities.add(normalizedEmail);
  for (const alias of extractTransportAliases(sendFromConfig)) {
    identities.add(alias);
  }
  return identities;
}

function equatedAddresses(parsed: ParsedInboundMessage): string[] {
  return [parsed.fromAddress, ...parsed.toAddresses, ...parsed.ccAddresses, ...parsed.bccAddresses]
    .filter((address): address is string => Boolean(address))
    .map(normalizeEmailAddress)
    .filter(Boolean);
}

async function findTransportByStamp(
  db: DB,
  ownerHeaderValue: string,
): Promise<RoutedTransport | null> {
  const normalizedHeader = normalizeEmailAddress(ownerHeaderValue);
  const transports = await db
    .select({
      id: mailboxTransport.id,
      email: mailboxTransport.email,
      ownerHeaderValue: mailboxTransport.ownerHeaderValue,
      sendFromConfig: mailboxTransport.sendFromConfig,
    })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.isActive, true));

  const byOwnerHeader = transports.find(
    (transport) => normalizeEmailAddress(transport.ownerHeaderValue) === normalizedHeader,
  );
  if (byOwnerHeader) return byOwnerHeader;

  return (
    transports.find((transport) =>
      transportIdentitySet(transport.email, transport.sendFromConfig).has(normalizedHeader),
    ) ?? null
  );
}

async function findCenturionEquatedTransport(
  db: DB,
  parsed: ParsedInboundMessage,
): Promise<RoutedTransport | null> {
  const centurionRows = await db
    .select({
      id: mailboxTransport.id,
      email: mailboxTransport.email,
      sendFromConfig: mailboxTransport.sendFromConfig,
    })
    .from(mailboxTransport)
    .where(
      and(eq(mailboxTransport.id, CENTURION_TRANSPORT_ID), eq(mailboxTransport.isActive, true)),
    )
    .limit(1);

  const centurion = centurionRows[0];
  if (!centurion) return null;

  const identities = transportIdentitySet(centurion.email, centurion.sendFromConfig);
  if (equatedAddresses(parsed).some((address) => identities.has(address))) {
    return centurion;
  }
  return null;
}

async function ensureSoftQuarantineLabel(db: DB, transportId: string): Promise<string> {
  const id = `label-soft-quarantine-${transportId}`;
  await db
    .insert(mailLabel)
    .values({ id, transportId, name: 'soft-quarantine', color: null })
    .onConflictDoNothing({ target: [mailLabel.transportId, mailLabel.name] });
  return id;
}

/** From domain outside transport domain (minimal allowlist = transport domain). */
function isExternalFromDomain(fromEmail: string, transportEmail: string): boolean {
  const fromDomain = fromEmail.includes('@') ? fromEmail.slice(fromEmail.lastIndexOf('@') + 1) : '';
  const transportDomain = transportEmail.includes('@')
    ? transportEmail.slice(transportEmail.lastIndexOf('@') + 1)
    : '';
  if (!fromDomain || !transportDomain) return true;
  return fromDomain !== transportDomain;
}

async function applyThreadLabels(tx: DB, threadId: string, labelIds: string[]): Promise<void> {
  if (labelIds.length === 0) return;
  const rows = await tx
    .select({ labelIds: mailThread.labelIds })
    .from(mailThread)
    .where(eq(mailThread.id, threadId))
    .limit(1);
  const current = rows[0]?.labelIds ?? [];
  const next = [...new Set([...current, ...labelIds])];
  await tx
    .update(mailThread)
    .set({ labelIds: next, updatedAt: new Date() })
    .where(eq(mailThread.id, threadId));
}

async function quarantineUnrouted(args: {
  db: DB;
  parsed: ParsedInboundMessage;
  meta: IngestMeta;
  rawMimeS3Key: string;
  reason: QuarantineReason;
}): Promise<PersistQuarantinedResult> {
  const { db, parsed, meta, rawMimeS3Key, reason } = args;
  const existing = await findExistingQuarantine(db, meta);
  if (existing) {
    return {
      kind: 'quarantined',
      quarantineId: existing.id,
      reason: existing.reason as QuarantineReason,
      rawMimeS3Key: existing.rawMimeS3Key,
    };
  }

  const quarantineId = randomUUID();
  await db.insert(mailIngestQuarantine).values({
    id: quarantineId,
    ingestMailboxId: meta.ingestMailboxId,
    pop3Uidl: meta.pop3Uidl,
    rawMimeS3Key,
    reason,
    ownerHeaderValue: parsed.ownerHeaderValue,
    parsedHeaders: headerSummary(parsed),
  });
  return {
    kind: 'quarantined',
    quarantineId,
    reason,
    rawMimeS3Key,
  };
}

async function resolveThreadId(args: {
  tx: DB;
  transportId: string;
  parsed: ParsedInboundMessage;
  pop3Uidl: string;
}): Promise<string> {
  const { tx, transportId, parsed, pop3Uidl } = args;
  const now = parsed.receivedAt ?? new Date();
  const snippet = parsed.textBody ? parsed.textBody.slice(0, 200) : (parsed.subject ?? '');

  const candidates = [...(parsed.inReplyTo ? [parsed.inReplyTo] : []), ...parsed.references].filter(
    Boolean,
  );
  const uniqueCandidates = [...new Set(candidates)];

  if (uniqueCandidates.length > 0) {
    const parentRows = await tx
      .select({ threadId: message.threadId })
      .from(message)
      .where(
        and(
          eq(message.transportId, transportId),
          inArray(message.messageIdHeader, uniqueCandidates),
        ),
      )
      .limit(1);
    if (parentRows.length > 0) {
      const threadId = parentRows[0]!.threadId;
      await tx
        .update(mailThread)
        .set({
          latestMessageAt: now,
          snippet,
          isRead: false,
          updatedAt: new Date(),
        })
        .where(eq(mailThread.id, threadId));
      return threadId;
    }
  }

  const threadRootId = parsed.messageId ?? `no-message-id-${pop3Uidl}`;
  const existing = await tx
    .select({ id: mailThread.id })
    .from(mailThread)
    .where(and(eq(mailThread.transportId, transportId), eq(mailThread.threadRootId, threadRootId)))
    .limit(1);
  if (existing.length > 0) {
    const threadId = existing[0]!.id;
    await tx
      .update(mailThread)
      .set({
        latestMessageAt: now,
        snippet,
        isRead: false,
        updatedAt: new Date(),
      })
      .where(eq(mailThread.id, threadId));
    return threadId;
  }

  const threadId = randomUUID();
  await tx.insert(mailThread).values({
    id: threadId,
    transportId,
    threadRootId,
    subject: parsed.subject,
    snippet,
    isArchived: false,
    isStarred: false,
    isRead: false,
    labelIds: [],
    latestMessageAt: now,
  });
  return threadId;
}

function headerSummary(parsed: ParsedInboundMessage): Record<string, unknown> {
  return {
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    from: parsed.fromAddress,
    to: parsed.toAddresses,
    cc: parsed.ccAddresses,
    subject: parsed.subject,
    date: parsed.receivedAt ? parsed.receivedAt.toISOString() : null,
  };
}

/**
 * Convenience: parse + persist in one call. Tests use this when they don't
 * need to inspect the parsed message separately.
 */
export async function parseAndPersist(
  raw: Buffer,
  meta: Omit<IngestMeta, 'messageId'>,
  opts: PersistOptions,
): Promise<PersistResult> {
  const messageId = generateMessageId();
  const parsed = await parseRawMessage(raw, {
    messageId,
    storage: opts.storage,
  });
  return persistInboundMessage(parsed, raw, { ...meta, messageId }, opts);
}
