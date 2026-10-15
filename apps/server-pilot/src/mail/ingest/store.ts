/**
 * Persist an inbound message to Postgres + S3.
 *
 * Routing:
 *   1. Parse `X-Zero-Mailbox` header from the parsed message.
 *   2. Look up `mailboxTransport` by `ownerHeaderValue`. If found, store the
 *      message scoped to that transport (create/find a thread, insert
 *      `message` + `attachment` rows).
 *   3. If the header is missing, try direct `To` identity match (email +
 *      aliases). Unique → route. One identity matching ≥2 transports →
 *      `ambiguous_transport`. Distinct addresses matching ≥2 hotel
 *      transports → store one copy per hotel (first owns the POP identity;
 *      extra copies use null ingest UIDL + fan-out provenance). `transport-nava`
 *      is dropped from unique/multi sets when a hotel also matches; ambiguous
 *      stays fail-closed. A fail-closed step does not fall through. When
 *      `INGEST_REQUIRE_OWNER_HEADER=false` and Direct-To is none, also match
 *      hotel transport identities on To/Cc/Bcc then From. On miss quarantine
 *      with `missing_owner_header`. If the header is present: unique owner
 *      header or identity → that transport; >1 match → `ambiguous_transport`;
 *      none → `unknown_transport`.
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
  attachment,
  mailIngestCandidateAttachmentCleanup,
  mailIngestQuarantine,
  mailIngestUidlClaim,
  mailIngestSourceReceipt,
  mailLabel,
  mailboxTransport,
  message,
  mailThread,
  outboundSendQueue,
} from '../../db/schema/mail.js';
import {
  emitRocketseedReturnedCopyTrustRejection,
  evaluateRocketseedReturnedCopyTrust,
  evaluateRocketseedReturnedCopyPrecheck,
  normalizeRocketseedMailbox,
} from './rocketseed-returned-copy.js';
import {
  findCanonicalCandidate,
  lockCanonicalMailbox,
  newCanonicalAttachments,
} from './canonical-identity.js';
import {
  DEFAULT_AI_MODEL_ID,
  DEFAULT_TRIAGE_PROMPT_VERSION,
  enqueueAiRun,
} from '../../ai/run-ledger.js';
import { enqueueInboundExtraction } from '../../ai/extraction/inbound-run.js';
import { classifyMailSource } from '../../ai/mail-source.js';
import { type ParsedInboundMessage, parseRawMessage, generateMessageId } from './parse-message.js';
import { enqueueShadowPrediction, rematchShadowPredictions } from '../../ai/shadow-evaluation.js';
import { ingestRequireOwnerHeader, isInboundTriageClassifierEnabled } from '../../env.js';
import { rawMimeKey, getS3Storage, type S3Storage } from '../../storage/s3.js';
import { parsePersistedDeliveryOutcome } from '../send/outbound-queue.js';
import { buildReferenceChain, canonicalMessageId } from './message-id.js';
import { refreshThreadSearchVector } from '../search/search-vector.js';
import { sanitizeHtmlBodyForStorage } from '../sanitize-email-html.js';
import { and, asc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import { getSenderPreference } from '../sender-preference.js';
import {
  admitLiveMessage,
  removeDeterministicAutomatedChannelCategory,
} from './live-admission.js';
import { createHash, randomUUID } from 'node:crypto';
import { markThreadRead } from '../thread-read.js';
import type { DB } from '../../db/client.js';

const CENTURION_TRANSPORT_ID = 'transport-centurion';
const DAVINCI_TRANSPORT_ID = 'transport-davinci';
const FAITH_TRANSPORT_ID = 'transport-faith';
const AYANDA_TRANSPORT_ID = 'transport-ayanda';
const NAVA_TRANSPORT_ID = 'transport-nava';
const HOTEL_EQUATED_TRANSPORT_IDS = [
  CENTURION_TRANSPORT_ID,
  DAVINCI_TRANSPORT_ID,
  FAITH_TRANSPORT_ID,
  AYANDA_TRANSPORT_ID,
] as const;
export const CANDIDATE_ATTACHMENT_DELETE_CONCURRENCY = 4;
export const CANDIDATE_ATTACHMENT_CLEANUP_SWEEP_LIMIT = 500;
const CANDIDATE_ATTACHMENT_CLEANUP_RETRY_BASE_MS = 1_000;
const CANDIDATE_ATTACHMENT_CLEANUP_RETRY_MAX_MS = 15 * 60 * 1_000;
const CANDIDATE_ATTACHMENT_CLEANUP_INSERT_CHUNK_SIZE = 250;
export const INGEST_UIDL_CLAIM_LEASE_MS = 10 * 60 * 1_000;

/** Add the trusted arrival stamp without replacing existing provenance keys or an existing stamp. */
function mergeDeliveredAtSourceProvenance(deliveredAt: Date) {
  const iso = deliveredAt.toISOString();
  return sql`case
    when ${message.sourceProvenance} is null then jsonb_build_object('deliveredAt', ${iso}::text)
    when jsonb_typeof(${message.sourceProvenance}) = 'object'
      and ${message.sourceProvenance} ? 'deliveredAt' then ${message.sourceProvenance}
    when jsonb_typeof(${message.sourceProvenance}) = 'object'
      then ${message.sourceProvenance} || jsonb_build_object('deliveredAt', ${iso}::text)
    else ${message.sourceProvenance}
  end`;
}

export type TransportMatchCandidate = {
  id: string;
  email: string;
  sendFromConfig: unknown;
};

type RoutedTransport = TransportMatchCandidate;

export type TransportMatchResult<T extends TransportMatchCandidate = TransportMatchCandidate> =
  | { kind: 'unique'; transport: T }
  | { kind: 'none' }
  | { kind: 'ambiguous'; ids: string[] }
  | { kind: 'multi'; ids: string[] };

export type QuarantineReason =
  | 'missing_owner_header'
  | 'unknown_transport'
  | 'ambiguous_transport'
  | 'multi_transport'
  | 'message_too_large'
  | 'parse_failure'
  | 'malformed_delivery_outcome';

export type PersistKind = 'stored' | 'quarantined' | 'duplicate' | 'reconciled' | 'deferred';

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
  candidateAttachmentCleanupFailureCount: number;
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

export interface PersistDeferredResult {
  kind: 'deferred';
  transportId: string;
  messageId: string;
  rawMimeS3Key: string;
  candidateAttachmentCleanupFailureCount: number;
}

export type PersistResult =
  | PersistStoredResult
  | PersistQuarantinedResult
  | PersistDuplicateResult
  | PersistReconciledResult
  | PersistDeferredResult;

export interface PersistOptions {
  /** DB handle (production: getDb(); tests: transaction-scoped handle). */
  db: DB;
  /** S3 storage override (tests inject a fake). */
  storage?: S3Storage;
  /** Narrow promotion-only transport route; generic ingest must not set this. */
  transportOverride?: 'transport-centurion';
  /** Optional trusted direction selected by a narrow historical promotion. */
  directionOverride?: 'inbound' | 'outbound';
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
  /**
   * Live POP3 worker's current UIDL lease. It may clean its own candidate
   * uploads while unrelated sweepers must defer until the lease is released.
   */
  activeIngestUidlClaimToken?: string;
  /** Internal fan-out: already-resolved hotel route; skip mailbox matching. */
  routedTransport?: TransportMatchCandidate;
  /**
   * Internal fan-out: first copy owns `(ingestMailboxId, pop3Uidl)` and the
   * source receipt. Extra copies persist with those columns null.
   */
  claimIngestIdentity?: boolean;
  /** Internal fan-out: delay candidate-upload deletion until every copy finishes. */
  skipAttachmentCleanup?: boolean;
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

  const claimIngestIdentity = opts.claimIngestIdentity !== false;
  const skipAttachmentCleanup = opts.skipAttachmentCleanup === true;
  const cleanupIfNeeded = (canonicalMessageId?: string) =>
    skipAttachmentCleanup
      ? Promise.resolve(0)
      : cleanupCandidateAttachmentTasks({
          db,
          storage,
          attachments: parsed.attachments,
          meta,
          canonicalMessageId,
          activeIngestUidlClaimToken: opts.activeIngestUidlClaimToken,
        });
  const existingMessage = claimIngestIdentity
    ? await findExistingMessageByIngestIdentity(db, meta)
    : undefined;

  const existingQuarantine = opts.promoteQuarantineId
    ? undefined
    : await findExistingQuarantine(db, meta);
  if (existingQuarantine) {
    const candidateAttachmentCleanupFailureCount = await cleanupIfNeeded();
    return {
      kind: 'quarantined',
      quarantineId: existingQuarantine.id,
      reason: existingQuarantine.reason as QuarantineReason,
      rawMimeS3Key: existingQuarantine.rawMimeS3Key,
      candidateAttachmentCleanupFailureCount,
    };
  }

  const duplicateExisting = async (): Promise<PersistDuplicateResult> =>
    withCandidateAttachmentCleanupFailures(
      {
        kind: 'duplicate',
        transportId: existingMessage!.transportId,
        messageId: existingMessage!.id,
        rawMimeS3Key,
        candidateAttachmentCleanupFailureCount: 0,
      },
      await cleanupIfNeeded(existingMessage!.id),
    );
  const fanOutMatched = (ids: string[]) =>
    existingMessage && existingMessage.transportId !== ids[0]
      ? duplicateExisting()
      : persistMultiTransportFanOut({
          parsed,
          raw,
          meta,
          opts,
          storage,
          rawMimeS3Key,
          ids,
        });

  // Routing ------------------------------------------------------------
  let transport: RoutedTransport | null = opts.routedTransport ?? null;

  if (opts.routedTransport) {
    transport = opts.routedTransport;
  } else if (opts.transportOverride !== undefined) {
    // Promotion has already applied its exact sender/recipient gate. Still
    // resolve the requested route from the active transport row; never trust
    // a caller-supplied id or a stale/hard-coded transport address.
    transport = await findActiveTransportById(db, opts.transportOverride);
    if (!transport) {
      return quarantineWithAttachmentCleanup({
        db,
        storage,
        parsed,
        meta,
        rawMimeS3Key,
        reason: 'unknown_transport',
        activeIngestUidlClaimToken: opts.activeIngestUidlClaimToken,
      });
    }
    // Explicit promotion route wins over owner-header/direct-To routing.
  } else if (!parsed.ownerHeaderValue) {
    const direct = await findDirectToTransport(db, parsed.toAddresses);
    if (direct.kind === 'unique') {
      transport = direct.transport;
    } else if (direct.kind === 'multi') {
      return fanOutMatched(direct.ids);
    } else if (direct.kind === 'ambiguous') {
      if (existingMessage) return duplicateExisting();
      return quarantineWithAttachmentCleanup({
        db,
        storage,
        parsed,
        meta,
        rawMimeS3Key,
        reason: 'ambiguous_transport',
        activeIngestUidlClaimToken: opts.activeIngestUidlClaimToken,
      });
    } else if (!ingestRequireOwnerHeader()) {
      const equated = await findEquatedHotelTransport(db, parsed);
      if (equated.kind === 'unique') {
        transport = equated.transport;
      } else if (equated.kind === 'multi') {
        return fanOutMatched(equated.ids);
      } else if (equated.kind === 'ambiguous') {
        if (existingMessage) return duplicateExisting();
        return quarantineWithAttachmentCleanup({
          db,
          storage,
          parsed,
          meta,
          rawMimeS3Key,
          reason: 'ambiguous_transport',
          activeIngestUidlClaimToken: opts.activeIngestUidlClaimToken,
        });
      }
    }
    if (!transport) {
      return quarantineWithAttachmentCleanup({
        db,
        storage,
        parsed,
        meta,
        rawMimeS3Key,
        reason: 'missing_owner_header',
        activeIngestUidlClaimToken: opts.activeIngestUidlClaimToken,
      });
    }
    // Inbox-first: direct-To without X-Zero-Mailbox still stores + enqueues
    // triage; AI (when write gate on) may set spam later.
  } else {
    const stamped = await findTransportByStamp(db, parsed.ownerHeaderValue);
    if (stamped.kind === 'unique') {
      transport = stamped.transport;
    } else if (stamped.kind === 'multi') {
      return fanOutMatched(stamped.ids);
    } else if (stamped.kind === 'ambiguous') {
      if (existingMessage) return duplicateExisting();
      return quarantineWithAttachmentCleanup({
        db,
        storage,
        parsed,
        meta,
        rawMimeS3Key,
        reason: 'ambiguous_transport',
        activeIngestUidlClaimToken: opts.activeIngestUidlClaimToken,
      });
    } else {
      return quarantineWithAttachmentCleanup({
        db,
        storage,
        parsed,
        meta,
        rawMimeS3Key,
        reason: 'unknown_transport',
        activeIngestUidlClaimToken: opts.activeIngestUidlClaimToken,
      });
    }
  }

  if (!transport) {
    return quarantineWithAttachmentCleanup({
      db,
      storage,
      parsed,
      meta,
      rawMimeS3Key,
      reason: 'missing_owner_header',
      activeIngestUidlClaimToken: opts.activeIngestUidlClaimToken,
    });
  }

  const messageId = claimIngestIdentity
    ? meta.messageId
    : fanOutCopyMessageId(meta.ingestMailboxId, meta.pop3Uidl, transport.id);

  if (existingMessage) {
    const candidateAttachmentCleanupFailureCount = await cleanupIfNeeded(existingMessage.id);
    return {
      kind: 'duplicate',
      transportId: existingMessage.transportId,
      messageId: existingMessage.id,
      rawMimeS3Key,
      candidateAttachmentCleanupFailureCount,
    };
  }
  let threadId = '';
  let duplicate: PersistDuplicateResult | null = null;
  let duplicateCanonicalMessageId = messageId;
  let deferred: Omit<PersistDeferredResult, 'candidateAttachmentCleanupFailureCount'> | null = null;
  let malformedDeliveryOutcomeQuarantine = false;
  let reconciliation: PersistReconciledResult | null = null;
  let ambiguousSource = false;
  await db.transaction(async (tx) => {
    const transactionDb = tx as unknown as DB;
    await lockCanonicalMailbox(transactionDb, transport.id);
    const retainSource = async (canonicalMessageId: string) => {
      if (!claimIngestIdentity) return;
      await tx
        .insert(mailIngestSourceReceipt)
        .values({
          id: randomUUID(),
          ingestMailboxId: meta.ingestMailboxId,
          pop3Uidl: meta.pop3Uidl,
          transportId: transport.id,
          canonicalMessageId,
          rawMimeS3Key,
          sha256: createHash('sha256').update(raw).digest('hex'),
        })
        .onConflictDoNothing({
          target: [mailIngestSourceReceipt.ingestMailboxId, mailIngestSourceReceipt.pop3Uidl],
        });
    };
    const existingSource = claimIngestIdentity
      ? await findExistingMessageByIngestIdentity(transactionDb, meta)
      : await findMessageByIdAndTransport(transactionDb, messageId, transport.id, {
          ingestMailboxId: meta.ingestMailboxId,
          pop3Uidl: meta.pop3Uidl,
        });
    if (existingSource) {
      duplicate = {
        kind: 'duplicate',
        transportId: transport.id,
        messageId: existingSource.id,
        rawMimeS3Key,
        candidateAttachmentCleanupFailureCount: 0,
      };
      duplicateCanonicalMessageId = existingSource.id;
      return;
    }
    await lockCandidateAttachmentCleanupOwnership(transactionDb, meta);
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
    const shouldDeferPreOutcomeReturnedCopy =
      opts.ingestSource === 'live-pop3' &&
      parsed.outboundCorrelation.kind === 'valid' &&
      canonical?.queueStatus === 'sending' &&
      !canonical.ingestMailboxId &&
      !canonical.pop3Uidl &&
      persistedDeliveryOutcomeState(canonical.smtpPayload) === 'absent' &&
      evaluateRocketseedReturnedCopyTrust({
        activeTransportId: canonical.transportId,
        expectedTransportId: transport.id,
        expectedTransportAddress: transport.email,
        hasEligibleLocalQueueRow: true,
        parsed,
      }).trusted;
    const shouldQuarantineMalformedDeliveryOutcome =
      opts.ingestSource === 'live-pop3' &&
      parsed.outboundCorrelation.kind === 'valid' &&
      canonical?.queueStatus === 'sending' &&
      !canonical.ingestMailboxId &&
      !canonical.pop3Uidl &&
      persistedDeliveryOutcomeState(canonical.smtpPayload) === 'malformed' &&
      evaluateRocketseedReturnedCopyTrust({
        activeTransportId: canonical.transportId,
        expectedTransportId: transport.id,
        expectedTransportAddress: transport.email,
        hasEligibleLocalQueueRow: true,
        parsed,
      }).trusted;
    if (
      opts.ingestSource === 'live-pop3' &&
      parsed.outboundCorrelation.kind === 'valid' &&
      !returnedCopyTrust.trusted &&
      !shouldDeferPreOutcomeReturnedCopy
    ) {
      emitRocketseedReturnedCopyTrustRejection(returnedCopyTrust.reason);
    }
    if (shouldDeferPreOutcomeReturnedCopy) {
      deferred = {
        kind: 'deferred',
        transportId: canonical.transportId,
        messageId: canonical.id,
        rawMimeS3Key,
      };
      return;
    }
    if (shouldQuarantineMalformedDeliveryOutcome) {
      malformedDeliveryOutcomeQuarantine = true;
      return;
    }
    if (canonical && returnedCopyTrust.trusted) {
      // A retry may reuse an attachment key whose deferred cleanup is still
      // durable. Drain that task first; otherwise reconciliation could attach
      // an object a later sweep is entitled to delete.
      if (
        await hasPendingCandidateAttachmentCleanup(transactionDb, {
          ingestMailboxId: meta.ingestMailboxId,
          pop3Uidl: meta.pop3Uidl,
        })
      ) {
        deferred = {
          kind: 'deferred',
          transportId: canonical.transportId,
          messageId: canonical.id,
          rawMimeS3Key,
        };
        return;
      }
      if (canonical.ingestMailboxId || canonical.pop3Uidl) {
        duplicate = {
          kind: 'duplicate',
          transportId: canonical.transportId,
          messageId: canonical.id,
          rawMimeS3Key,
          candidateAttachmentCleanupFailureCount: 0,
        };
        await retainSource(canonical.id);
        duplicateCanonicalMessageId = canonical.id;
        return;
      }
      const durableSmtpMessageId =
        parsed.outboundCorrelation.kind === 'valid' &&
        canonical.queueStatus === 'sending' &&
        canonical.messageIdHeader === null
          ? (parsePersistedDeliveryOutcome(canonical.smtpPayload)?.messageId ?? null)
          : null;
      const persistedHeaders = canonicalizePersistedHeaders(parsed);
      await transactionDb
        .update(message)
        .set({
          ingestMailboxId: meta.ingestMailboxId,
          pop3Uidl: meta.pop3Uidl,
          ownerHeaderValue: parsed.ownerHeaderValue,
          messageIdHeader:
            canonical.messageIdHeader ?? durableSmtpMessageId ?? persistedHeaders.messageIdHeader,
          inReplyTo: persistedHeaders.inReplyTo,
          references: persistedHeaders.references,
          fromAddress: parsed.fromAddress ?? '',
          toAddresses: parsed.toAddresses,
          ccAddresses: parsed.ccAddresses,
          subject: parsed.subject,
          textBody: parsed.textBody,
          htmlBody: sanitizeHtmlBodyForStorage(parsed.htmlBody),
          rawMimeS3Key,
          receivedAt: parsed.receivedAt,
          updatedAt: new Date(),
          ...(parsed.deliveredAt
            ? { sourceProvenance: mergeDeliveredAtSourceProvenance(parsed.deliveredAt) }
            : {}),
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
            sha256: a.sha256 ?? null,
            s3Key: a.s3Key,
            contentId: a.contentId,
            isInline: a.isInline,
          })),
        );
      }
      await retainSource(canonical.id);
      reconciliation = {
        kind: 'reconciled',
        transportId: canonical.transportId,
        messageId: canonical.id,
        rawMimeS3Key,
        attachmentCount: parsed.attachments.length,
      };
      return;
    }

    if (
      await hasPendingCandidateAttachmentCleanup(transactionDb, {
        ingestMailboxId: meta.ingestMailboxId,
        pop3Uidl: meta.pop3Uidl,
      })
    ) {
      deferred = {
        kind: 'deferred',
        transportId: transport.id,
        messageId: meta.messageId,
        rawMimeS3Key,
      };
      return;
    }

    const sender = normalizeEmailAddress(parsed.fromAddress ?? '');
    const identities = transportIdentitySet(transport.email, transport.sendFromConfig);
    const recipients = [...parsed.toAddresses, ...parsed.ccAddresses, ...parsed.bccAddresses].map(
      normalizeEmailAddress,
    );
    const direction =
      opts.directionOverride ??
      (identities.has(sender) && !recipients.some((a) => identities.has(a))
        ? 'outbound'
        : 'inbound');
    const sourceCandidate = await findCanonicalCandidate(transactionDb, transport.id, {
      internetMessageId: parsed.messageId,
      direction,
      fromAddress: parsed.fromAddress ?? '',
      toAddresses: parsed.toAddresses,
      ccAddresses: parsed.ccAddresses,
      authoredAt: parsed.receivedAt,
      textBody: parsed.textBody,
      htmlBody: parsed.htmlBody,
      attachments: parsed.attachments.map((a) => ({
        sizeBytes: a.sizeBytes,
        sha256: a.sha256 ?? null,
      })),
    });
    ambiguousSource = sourceCandidate.kind === 'ambiguous';
    if (sourceCandidate.kind === 'unique') {
      const found = sourceCandidate.message;
      await tx
        .update(message)
        .set({
          ingestMailboxId: claimIngestIdentity
            ? (found.ingestMailboxId ?? meta.ingestMailboxId)
            : found.ingestMailboxId,
          pop3Uidl: claimIngestIdentity ? (found.pop3Uidl ?? meta.pop3Uidl) : found.pop3Uidl,
          rawMimeS3Key: found.rawMimeS3Key ?? rawMimeS3Key,
          textBody: found.textBody ?? parsed.textBody,
          htmlBody: found.htmlBody ?? sanitizeHtmlBodyForStorage(parsed.htmlBody),
          ...(parsed.deliveredAt
            ? { sourceProvenance: mergeDeliveredAtSourceProvenance(parsed.deliveredAt) }
            : {}),
        })
        .where(eq(message.id, found.id));
      if (parsed.attachments.length) {
        const existing = await tx
          .select()
          .from(attachment)
          .where(eq(attachment.messageId, found.id));
        const additions = newCanonicalAttachments(existing, parsed.attachments);
        if (additions.length)
          await tx
            .insert(attachment)
            .values(additions.map((a) => ({ id: randomUUID(), messageId: found.id, ...a })));
      }
      if (!opts.skipAiEnqueue && opts.ingestSource === 'live-pop3')
        await admitLiveMessage(transactionDb, {
          transportId: transport.id,
          canonicalMessageId: found.id,
          evidence: {
            kind: 'verified-pop3',
            sourceReceiptId: `${meta.ingestMailboxId}:${meta.pop3Uidl}`,
          },
        });
      await retainSource(found.id);
      reconciliation = {
        kind: 'reconciled',
        transportId: transport.id,
        messageId: found.id,
        rawMimeS3Key,
        attachmentCount: parsed.attachments.length,
      };
      return;
    }

    if (ambiguousSource) {
      threadId = randomUUID();
      await tx.insert(mailThread).values({
        id: threadId,
        transportId: transport.id,
        threadRootId: `ambiguous:${messageId}`,
        historyOnly: true,
        isRead: true,
        subject: parsed.subject,
        latestMessageAt: parsed.receivedAt,
      });
    } else
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
    const inferredHotelSent =
      Boolean(fromEmail) && transportIdentities.has(fromEmail) && !isSelfIngestLoopback;
    const isHotelSent =
      opts.directionOverride === undefined
        ? inferredHotelSent
        : opts.directionOverride === 'outbound';
    const mailSourceDecision = !isHotelSent
      ? classifyMailSource({
          fromAddress: parsed.fromAddress,
          subject: parsed.subject,
          bodyText: parsed.textBody ?? parsed.htmlBody,
        })
      : null;
    const routeAsAutomatedChannel =
      mailSourceDecision !== null && mailSourceDecision.kind !== 'direct';

    const persistedHeaders = canonicalizePersistedHeaders(parsed);
    const sourceProvenance = {
      ...(ambiguousSource ? { source: 'pop3', attention: 'AMBIGUOUS_IDENTITY' } : {}),
      ...(parsed.deliveredAt ? { deliveredAt: parsed.deliveredAt.toISOString() } : {}),
      ...(!claimIngestIdentity
        ? {
            fanoutFrom: {
              ingestMailboxId: meta.ingestMailboxId,
              pop3Uidl: meta.pop3Uidl,
            },
          }
        : {}),
    };

    await tx.insert(message).values({
      id: messageId,
      transportId: transport.id,
      threadId,
      ingestMailboxId: claimIngestIdentity ? meta.ingestMailboxId : null,
      direction: isHotelSent ? 'outbound' : 'inbound',
      historyOnly: ambiguousSource,
      sourceProvenance: Object.keys(sourceProvenance).length > 0 ? sourceProvenance : null,
      pop3Uidl: claimIngestIdentity ? meta.pop3Uidl : null,
      ownerHeaderValue: parsed.ownerHeaderValue,
      messageIdHeader: persistedHeaders.messageIdHeader,
      inReplyTo: persistedHeaders.inReplyTo,
      references: persistedHeaders.references,
      fromAddress: parsed.fromAddress ?? '',
      toAddresses: parsed.toAddresses,
      ccAddresses: parsed.ccAddresses,
      bccAddresses: parsed.bccAddresses,
      subject: parsed.subject,
      textBody: parsed.textBody,
      htmlBody: sanitizeHtmlBodyForStorage(parsed.htmlBody),
      rawMimeS3Key,
      receivedAt: parsed.receivedAt,
      sentAt: parsed.receivedAt ?? null,
      isRead: isHotelSent || ambiguousSource,
    });

    if (isHotelSent && !ambiguousSource) {
      await markThreadRead(tx as unknown as DB, transport.id, [threadId]);
    }

    if (parsed.attachments.length > 0) {
      const attachmentsToStore = claimIngestIdentity
        ? parsed.attachments
        : await copyAttachmentsToMessageId(storage, parsed.attachments, messageId);
      await tx.insert(attachment).values(
        attachmentsToStore.map((a) => ({
          id: randomUUID(),
          messageId,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          sha256: a.sha256 ?? null,
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
      !ambiguousSource &&
      process.env.AI_WRITE_GATE_ENABLED !== 'true' &&
      isExternalFromDomain(fromEmail, transportEmail)
    ) {
      const softLabelId = await ensureSoftQuarantineLabel(tx as unknown as DB, transport.id);
      await applyThreadLabels(tx as unknown as DB, threadId, [softLabelId]);
    }

    await retainSource(messageId);
    await refreshThreadSearchVector(tx as unknown as DB, threadId);

    if (!isHotelSent && !ambiguousSource && parsed.fromAddress) {
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

    if (!ambiguousSource && !opts.skipAiEnqueue && opts.ingestSource === 'live-pop3') {
      await admitLiveMessage(transactionDb, {
        transportId: transport.id,
        canonicalMessageId: messageId,
        newlyPersisted: true,
        evidence: {
          kind: 'verified-pop3',
          sourceReceiptId: `${meta.ingestMailboxId}:${meta.pop3Uidl}`,
        },
      });
    } else if (!ambiguousSource && !opts.skipAiEnqueue) {
      if (!isHotelSent && mailSourceDecision?.kind === 'direct') {
        await removeDeterministicAutomatedChannelCategory(transactionDb, {
          transportId: transport.id,
          threadId,
        });
      }
      // INBOUND_TRIAGE_CLASSIFIER=off retires the inbound classifier run. Sent copies keep their baseline run.
      if (
        isHotelSent ||
        routeAsAutomatedChannel ||
        isInboundTriageClassifierEnabled(process.env)
      ) {
        await enqueueAiRun(
          {
            transportId: transport.id,
            threadId,
            triggerMessageId: messageId,
            runKind: 'inbound_triage',
            // An independently observed Sent copy has no Nava outbox row, but
            // still needs one fenced analytics generation. Keep its key
            // separate from inbound triage so retries cannot collide across
            // directions or imply local delivery authority.
            idempotencyKey: isHotelSent
              ? `external-sent-baseline:${messageId}`
              : `inbound-triage:${messageId}`,
            modelId: DEFAULT_AI_MODEL_ID,
            promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
            ...(mailSourceDecision ? { metrics: { mailSourceDecision } } : {}),
          },
          tx as unknown as DB,
        );
      }
      // On retired direct inbound mail, the read replaces its classifier run so spam and the baseline keep running.
      // Channel/system mail is source-routed above and must not enter extraction. Sent copies never get one.
      if (
        !isHotelSent &&
        !routeAsAutomatedChannel &&
        !isInboundTriageClassifierEnabled(process.env)
      ) {
        await enqueueInboundExtraction(
          {
            transportId: transport.id,
            threadId,
            messageId,
            ...(mailSourceDecision ? { metrics: { mailSourceDecision } } : {}),
          },
          tx as unknown as DB,
        );
      }

      // U13 shadow admission is a separate private purpose. It is queued only
      // after this inbound row/attachment transaction has the same committed
      // scope and never writes a draft, label, read state, or SMTP row.
      if (!isHotelSent && !routeAsAutomatedChannel) {
        await enqueueShadowPrediction({
          transportId: transport.id,
          threadId,
          triggerMessageId: messageId,
          db: tx as unknown as DB,
        });
      }
    }
    // External Sent/imported hotel mail is the delayed reference producer. A
    // rematch reads only private prediction rows and appends an assessment;
    // it never mutates the just-stored message or visible thread state.
    if (isHotelSent && !ambiguousSource && !opts.skipAiEnqueue) {
      await rematchShadowPredictions({
        transportId: transport.id,
        threadId,
        outboundMessageId: messageId,
        db: tx as unknown as DB,
      });
    }

    if (opts.promoteQuarantineId && opts.routedTransport === undefined) {
      await tx
        .delete(mailIngestQuarantine)
        .where(eq(mailIngestQuarantine.id, opts.promoteQuarantineId));
    }
  });

  if (duplicate) {
    return withCandidateAttachmentCleanupFailures(
      duplicate,
      await cleanupIfNeeded(duplicateCanonicalMessageId),
    );
  }
  const deferredResult = deferred as Omit<
    PersistDeferredResult,
    'candidateAttachmentCleanupFailureCount'
  > | null;
  if (deferredResult) {
    return {
      ...deferredResult,
      candidateAttachmentCleanupFailureCount: await cleanupIfNeeded(),
    };
  }
  if (malformedDeliveryOutcomeQuarantine) {
    return quarantineWithAttachmentCleanup({
      db,
      storage,
      parsed,
      meta,
      rawMimeS3Key,
      reason: 'malformed_delivery_outcome',
      activeIngestUidlClaimToken: opts.activeIngestUidlClaimToken,
      skipAttachmentCleanup,
    });
  }
  const reconciledResult = reconciliation as PersistReconciledResult | null;
  if (reconciledResult) {
    if (parsed.attachments.length) await cleanupIfNeeded(reconciledResult.messageId);
    return reconciledResult;
  }

  return {
    kind: 'stored',
    transportId: transport.id,
    messageId,
    threadId,
    rawMimeS3Key,
    attachmentCount: parsed.attachments.length,
  };
}

export function ownedCandidateAttachmentKeys(
  attachments: ParsedInboundMessage['attachments'],
  candidateMessageId: string,
): string[] {
  const candidatePrefix = `attachments/${candidateMessageId}/`;
  return [
    ...new Set(
      attachments
        .map((attachment) => attachment.s3Key)
        .filter((key) => key.startsWith(candidatePrefix) && key.length > candidatePrefix.length),
    ),
  ];
}

async function registerCandidateAttachmentCleanupTasks(
  db: DB,
  attachments: ParsedInboundMessage['attachments'],
  meta: IngestMeta,
): Promise<void> {
  const keys = ownedCandidateAttachmentKeys(attachments, meta.messageId);
  if (keys.length === 0) return;

  await db.transaction(async (tx) => {
    const transactionDb = tx as unknown as DB;
    // Cleanup registration and canonical attachment persistence share this
    // transaction-scoped fence. Either the task commits first and persistence
    // defers, or a canonical attachment commits first and cleanup skips it.
    await lockCandidateAttachmentCleanupOwnership(transactionDb, meta);
    const canonicalRows = await transactionDb
      .select({ s3Key: attachment.s3Key })
      .from(attachment)
      .where(inArray(attachment.s3Key, keys));
    const canonicalKeys = new Set(canonicalRows.map((row) => row.s3Key));
    const cleanupKeys = keys.filter((key) => !canonicalKeys.has(key));

    for (
      let start = 0;
      start < cleanupKeys.length;
      start += CANDIDATE_ATTACHMENT_CLEANUP_INSERT_CHUNK_SIZE
    ) {
      const chunk = cleanupKeys.slice(
        start,
        start + CANDIDATE_ATTACHMENT_CLEANUP_INSERT_CHUNK_SIZE,
      );
      await transactionDb
        .insert(mailIngestCandidateAttachmentCleanup)
        .values(
          chunk.map((s3Key) => ({
            s3Key,
            candidateMessageId: meta.messageId,
            ingestMailboxId: meta.ingestMailboxId,
            pop3Uidl: meta.pop3Uidl,
          })),
        )
        .onConflictDoNothing({ target: mailIngestCandidateAttachmentCleanup.s3Key });
    }
  });
}

async function lockCandidateAttachmentCleanupOwnership(
  db: DB,
  meta: Pick<IngestMeta, 'ingestMailboxId' | 'pop3Uidl'>,
): Promise<void> {
  await db.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${meta.ingestMailboxId}),
      hashtext(${meta.pop3Uidl})
    )
  `);
}

async function canonicalAttachmentKeys(db: DB, s3Keys: string[]): Promise<Set<string>> {
  if (s3Keys.length === 0) return new Set();
  const rows = await db
    .select({ s3Key: attachment.s3Key })
    .from(attachment)
    .where(inArray(attachment.s3Key, s3Keys));
  return new Set(rows.map((row) => row.s3Key));
}

async function deleteCandidateAttachmentCleanupTask(
  db: DB,
  task: Pick<CandidateAttachmentCleanupTask, 's3Key' | 'candidateMessageId'>,
): Promise<void> {
  await db
    .delete(mailIngestCandidateAttachmentCleanup)
    .where(
      and(
        eq(mailIngestCandidateAttachmentCleanup.s3Key, task.s3Key),
        eq(mailIngestCandidateAttachmentCleanup.candidateMessageId, task.candidateMessageId),
      ),
    );
}

function isOwnedCandidateAttachmentKey(s3Key: string, candidateMessageId: string): boolean {
  const prefix = `attachments/${candidateMessageId}/`;
  return s3Key.startsWith(prefix) && s3Key.length > prefix.length;
}

async function mapWithBoundedConcurrency<T, R>(
  values: T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await map(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export async function hasPendingCandidateAttachmentCleanup(
  db: DB,
  meta: Pick<IngestMeta, 'ingestMailboxId' | 'pop3Uidl'>,
): Promise<boolean> {
  // Do not use SKIP LOCKED here. A cleaner may hold the row lock while it
  // deletes S3; any POP3 retry must still see the pending work and defer.
  const rows = await db
    .select({ s3Key: mailIngestCandidateAttachmentCleanup.s3Key })
    .from(mailIngestCandidateAttachmentCleanup)
    .where(
      and(
        eq(mailIngestCandidateAttachmentCleanup.ingestMailboxId, meta.ingestMailboxId),
        eq(mailIngestCandidateAttachmentCleanup.pop3Uidl, meta.pop3Uidl),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function claimIngestUidl(
  db: DB,
  meta: Pick<IngestMeta, 'ingestMailboxId' | 'pop3Uidl'>,
): Promise<string | null> {
  const claimToken = randomUUID();
  const expiresAt = new Date(Date.now() + INGEST_UIDL_CLAIM_LEASE_MS);
  const claimed = await db
    .insert(mailIngestUidlClaim)
    .values({
      ingestMailboxId: meta.ingestMailboxId,
      pop3Uidl: meta.pop3Uidl,
      claimToken,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [mailIngestUidlClaim.ingestMailboxId, mailIngestUidlClaim.pop3Uidl],
      set: { claimToken, expiresAt },
      setWhere: lte(mailIngestUidlClaim.expiresAt, new Date()),
    })
    .returning({ claimToken: mailIngestUidlClaim.claimToken });
  return claimed[0]?.claimToken === claimToken ? claimToken : null;
}

export async function renewIngestUidlClaim(
  db: DB,
  meta: Pick<IngestMeta, 'ingestMailboxId' | 'pop3Uidl'>,
  claimToken: string,
): Promise<boolean> {
  const renewed = await db
    .update(mailIngestUidlClaim)
    .set({ expiresAt: new Date(Date.now() + INGEST_UIDL_CLAIM_LEASE_MS) })
    .where(
      and(
        eq(mailIngestUidlClaim.ingestMailboxId, meta.ingestMailboxId),
        eq(mailIngestUidlClaim.pop3Uidl, meta.pop3Uidl),
        eq(mailIngestUidlClaim.claimToken, claimToken),
      ),
    )
    .returning({ claimToken: mailIngestUidlClaim.claimToken });
  return renewed.length === 1;
}

export async function releaseIngestUidlClaim(
  db: DB,
  meta: Pick<IngestMeta, 'ingestMailboxId' | 'pop3Uidl'>,
  claimToken: string,
): Promise<void> {
  await db
    .delete(mailIngestUidlClaim)
    .where(
      and(
        eq(mailIngestUidlClaim.ingestMailboxId, meta.ingestMailboxId),
        eq(mailIngestUidlClaim.pop3Uidl, meta.pop3Uidl),
        eq(mailIngestUidlClaim.claimToken, claimToken),
      ),
    );
}

type CandidateAttachmentCleanupTask = {
  s3Key: string;
  candidateMessageId: string;
  ingestMailboxId: string;
  pop3Uidl: string;
  attempts: number;
};

type CandidateAttachmentCleanupBatchResult = {
  claimedTaskCount: number;
  selectedTaskCount: number;
  deletedTaskCount: number;
  failureCount: number;
  canContinue: boolean;
};

function nextCandidateAttachmentCleanupAttempt(attempts: number): Date {
  const exponent = Math.min(Math.max(attempts - 1, 0), 10);
  const delay = Math.min(
    CANDIDATE_ATTACHMENT_CLEANUP_RETRY_BASE_MS * 2 ** exponent,
    CANDIDATE_ATTACHMENT_CLEANUP_RETRY_MAX_MS,
  );
  return new Date(Date.now() + delay);
}

function ingestUidlScopeKey(
  args: Pick<CandidateAttachmentCleanupTask, 'ingestMailboxId' | 'pop3Uidl'>,
): string {
  return JSON.stringify([args.ingestMailboxId, args.pop3Uidl]);
}

async function deferCandidateAttachmentCleanupTask(
  db: DB,
  task: CandidateAttachmentCleanupTask,
): Promise<void> {
  const attempts = task.attempts + 1;
  await db
    .update(mailIngestCandidateAttachmentCleanup)
    .set({
      attempts: sql`${mailIngestCandidateAttachmentCleanup.attempts} + 1`,
      nextAttemptAt: nextCandidateAttachmentCleanupAttempt(attempts),
    })
    .where(
      and(
        eq(mailIngestCandidateAttachmentCleanup.s3Key, task.s3Key),
        eq(mailIngestCandidateAttachmentCleanup.candidateMessageId, task.candidateMessageId),
      ),
    );
}

async function deferCandidateAttachmentCleanupForActiveClaim(
  db: DB,
  task: CandidateAttachmentCleanupTask,
): Promise<void> {
  await db
    .update(mailIngestCandidateAttachmentCleanup)
    .set({
      nextAttemptAt: new Date(Date.now() + CANDIDATE_ATTACHMENT_CLEANUP_RETRY_BASE_MS),
    })
    .where(
      and(
        eq(mailIngestCandidateAttachmentCleanup.s3Key, task.s3Key),
        eq(mailIngestCandidateAttachmentCleanup.candidateMessageId, task.candidateMessageId),
      ),
    );
}

async function claimAndDeleteCandidateAttachmentCleanupTasks(args: {
  db: DB;
  storage: S3Storage;
  limit: number;
  meta?: Pick<IngestMeta, 'ingestMailboxId' | 'pop3Uidl'>;
  dueThrough: Date;
  activeIngestUidlClaimToken?: string;
}): Promise<CandidateAttachmentCleanupBatchResult> {
  let claimedTasks: CandidateAttachmentCleanupTask[] = [];
  try {
    return await args.db.transaction(async (tx) => {
      const transactionDb = tx as unknown as DB;
      const tasks = await transactionDb
        .select({
          s3Key: mailIngestCandidateAttachmentCleanup.s3Key,
          candidateMessageId: mailIngestCandidateAttachmentCleanup.candidateMessageId,
          ingestMailboxId: mailIngestCandidateAttachmentCleanup.ingestMailboxId,
          pop3Uidl: mailIngestCandidateAttachmentCleanup.pop3Uidl,
          attempts: mailIngestCandidateAttachmentCleanup.attempts,
        })
        .from(mailIngestCandidateAttachmentCleanup)
        .where(
          and(
            args.meta
              ? eq(mailIngestCandidateAttachmentCleanup.ingestMailboxId, args.meta.ingestMailboxId)
              : undefined,
            args.meta
              ? eq(mailIngestCandidateAttachmentCleanup.pop3Uidl, args.meta.pop3Uidl)
              : undefined,
            lte(mailIngestCandidateAttachmentCleanup.nextAttemptAt, args.dueThrough),
          ),
        )
        .orderBy(
          asc(mailIngestCandidateAttachmentCleanup.nextAttemptAt),
          asc(mailIngestCandidateAttachmentCleanup.s3Key),
        )
        .limit(args.limit)
        .for('update', { skipLocked: true });
      claimedTasks = tasks;
      if (tasks.length === 0) {
        return {
          claimedTaskCount: 0,
          selectedTaskCount: 0,
          deletedTaskCount: 0,
          failureCount: 0,
          canContinue: true,
        };
      }

      const taskScopes = [
        ...new Map(
          tasks.map((task) => [
            ingestUidlScopeKey(task),
            { ingestMailboxId: task.ingestMailboxId, pop3Uidl: task.pop3Uidl },
          ]),
        ).values(),
      ];
      const activeClaims = await transactionDb
        .select({
          ingestMailboxId: mailIngestUidlClaim.ingestMailboxId,
          pop3Uidl: mailIngestUidlClaim.pop3Uidl,
          claimToken: mailIngestUidlClaim.claimToken,
        })
        .from(mailIngestUidlClaim)
        .where(
          and(
            gt(mailIngestUidlClaim.expiresAt, new Date()),
            or(
              ...taskScopes.map((scope) =>
                and(
                  eq(mailIngestUidlClaim.ingestMailboxId, scope.ingestMailboxId),
                  eq(mailIngestUidlClaim.pop3Uidl, scope.pop3Uidl),
                ),
              ),
            ),
          ),
        );
      const activeClaimTokensByScope = new Map(
        activeClaims.map((claim) => [ingestUidlScopeKey(claim), claim.claimToken]),
      );
      const canonicalKeys = await canonicalAttachmentKeys(
        transactionDb,
        tasks.map((task) => task.s3Key),
      );
      // One transaction owns every claimed row. S3 calls stay bounded while
      // the locks remain held, so another worker cannot promote a stale key.
      const deletionResults = await mapWithBoundedConcurrency(
        tasks,
        CANDIDATE_ATTACHMENT_DELETE_CONCURRENCY,
        async (task) => {
          const activeClaimToken = activeClaimTokensByScope.get(ingestUidlScopeKey(task));
          if (activeClaimToken && activeClaimToken !== args.activeIngestUidlClaimToken) {
            return { task, disposition: 'active_claim' as const };
          }
          if (canonicalKeys.has(task.s3Key)) {
            return { task, disposition: 'canonical' as const };
          }
          if (!isOwnedCandidateAttachmentKey(task.s3Key, task.candidateMessageId)) {
            return { task, disposition: 'failed' as const };
          }
          try {
            await args.storage.deleteObject(task.s3Key);
            return { task, disposition: 'deleted' as const };
          } catch {
            return { task, disposition: 'failed' as const };
          }
        },
      );

      let deletedTaskCount = 0;
      let failureCount = 0;
      let activeClaimTaskCount = 0;
      for (const result of deletionResults) {
        if (result.disposition === 'active_claim') {
          await deferCandidateAttachmentCleanupForActiveClaim(transactionDb, result.task);
          activeClaimTaskCount += 1;
          continue;
        }
        if (result.disposition === 'canonical') {
          // A pre-existing task can outlive a prior failed deployment or a
          // crash. Once its key is canonical, delete only queue state.
          await deleteCandidateAttachmentCleanupTask(transactionDb, result.task);
          deletedTaskCount += 1;
          continue;
        }
        if (result.disposition === 'failed') {
          await deferCandidateAttachmentCleanupTask(transactionDb, result.task);
          failureCount += 1;
          continue;
        }
        await deleteCandidateAttachmentCleanupTask(transactionDb, result.task);
        deletedTaskCount += 1;
      }
      return {
        // A task deferred for another worker's active UIDL claim has not
        // consumed cleanup capacity. Continue this sweep so a full claimed
        // batch cannot starve later due cleanup rows.
        claimedTaskCount: tasks.length - activeClaimTaskCount,
        selectedTaskCount: tasks.length,
        deletedTaskCount,
        failureCount,
        canContinue: true,
      };
    });
  } catch {
    if (claimedTasks.length === 0) {
      return {
        claimedTaskCount: 0,
        selectedTaskCount: 0,
        deletedTaskCount: 0,
        failureCount: 1,
        canContinue: false,
      };
    }

    let canContinue = true;
    for (const task of claimedTasks) {
      try {
        // The transaction rolled back after an S3 operation or row delete.
        // Preserve every task and retry idempotent deletion after backoff.
        await deferCandidateAttachmentCleanupTask(args.db, task);
      } catch {
        canContinue = false;
      }
    }
    return {
      claimedTaskCount: claimedTasks.length,
      selectedTaskCount: claimedTasks.length,
      deletedTaskCount: 0,
      failureCount: claimedTasks.length,
      canContinue,
    };
  }
}

async function drainCandidateAttachmentCleanupTasks(args: {
  db: DB;
  storage: S3Storage;
  limit: number;
  meta?: Pick<IngestMeta, 'ingestMailboxId' | 'pop3Uidl'>;
  dueThrough?: Date;
  activeIngestUidlClaimToken?: string;
}): Promise<{
  failureCount: number;
  taskCount: number;
  limitReached: boolean;
  canContinue: boolean;
}> {
  const limit = Math.max(0, args.limit);
  if (limit === 0) {
    return { failureCount: 0, taskCount: 0, limitReached: true, canContinue: true };
  }

  let failureCount = 0;
  let claimedTaskCount = 0;
  let deletedTaskCount = 0;
  let canContinue = true;
  const dueThrough = args.dueThrough ?? new Date();
  while (claimedTaskCount < limit) {
    const result = await claimAndDeleteCandidateAttachmentCleanupTasks({
      ...args,
      limit: limit - claimedTaskCount,
      dueThrough,
    });
    failureCount += result.failureCount;
    claimedTaskCount += result.claimedTaskCount;
    deletedTaskCount += result.deletedTaskCount;
    if (result.selectedTaskCount === 0 || !result.canContinue) {
      canContinue = result.canContinue;
      break;
    }
  }
  return {
    failureCount,
    taskCount: deletedTaskCount,
    limitReached: claimedTaskCount >= limit,
    canContinue,
  };
}

export async function sweepCandidateAttachmentCleanupTasks(args: {
  db: DB;
  storage: S3Storage;
  limit?: number;
}): Promise<{ failureCount: number }> {
  return drainCandidateAttachmentCleanupTasks({
    ...args,
    limit: args.limit ?? CANDIDATE_ATTACHMENT_CLEANUP_SWEEP_LIMIT,
  });
}

async function cleanupCandidateAttachmentTasks(args: {
  db: DB;
  storage: S3Storage;
  attachments: ParsedInboundMessage['attachments'];
  meta: IngestMeta;
  canonicalMessageId?: string;
  activeIngestUidlClaimToken?: string;
}): Promise<number> {
  if (args.canonicalMessageId !== args.meta.messageId) {
    await registerCandidateAttachmentCleanupTasks(args.db, args.attachments, args.meta);
  }
  let failureCount = 0;
  const dueThrough = new Date();
  for (;;) {
    const result = await drainCandidateAttachmentCleanupTasks({
      db: args.db,
      storage: args.storage,
      meta: args.meta,
      limit: CANDIDATE_ATTACHMENT_CLEANUP_SWEEP_LIMIT,
      dueThrough,
      activeIngestUidlClaimToken: args.activeIngestUidlClaimToken,
    });
    failureCount += result.failureCount;
    if (!result.limitReached || !result.canContinue) {
      return failureCount;
    }
  }
}

/**
 * Persist and drain keys uploaded before `parseRawMessage` failed. Registration
 * errors propagate so the POP3 worker can retain the raw message fail-closed.
 */
export async function cleanupPartialParseFailureAttachments(args: {
  db: DB;
  storage: S3Storage;
  attachments: ParsedInboundMessage['attachments'];
  meta: IngestMeta;
  activeIngestUidlClaimToken?: string;
}): Promise<number> {
  return cleanupCandidateAttachmentTasks(args);
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
      candidateAttachmentCleanupFailureCount: 0,
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
    candidateAttachmentCleanupFailureCount: 0,
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
      candidateAttachmentCleanupFailureCount: 0,
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
    candidateAttachmentCleanupFailureCount: 0,
  };
}

async function findExistingMessageByIngestIdentity(
  db: DB,
  meta: Pick<IngestMeta, 'ingestMailboxId' | 'pop3Uidl'>,
): Promise<{ id: string; transportId: string } | undefined> {
  const [receipt] = await db
    .select({
      id: mailIngestSourceReceipt.canonicalMessageId,
      transportId: mailIngestSourceReceipt.transportId,
    })
    .from(mailIngestSourceReceipt)
    .where(
      and(
        eq(mailIngestSourceReceipt.ingestMailboxId, meta.ingestMailboxId),
        eq(mailIngestSourceReceipt.pop3Uidl, meta.pop3Uidl),
      ),
    )
    .limit(1);
  if (receipt) return receipt;
  const rows = await db
    .select({ id: message.id, transportId: message.transportId })
    .from(message)
    .where(
      and(eq(message.ingestMailboxId, meta.ingestMailboxId), eq(message.pop3Uidl, meta.pop3Uidl)),
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

  // Legacy Message-ID correlation remains sent-only and must fail closed when
  // a reused header identifies more than one outbound message.
  const candidates = await db
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
    .limit(2)
    .for('update');
  if (candidates.length !== 1) return undefined;

  return findCanonicalOutboundWithQueueLock(
    db,
    transportId,
    candidates[0]!.id,
    ['sent'],
    correlationId,
  );
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

function persistedDeliveryOutcomeState(smtpPayload: unknown): 'absent' | 'valid' | 'malformed' {
  try {
    return parsePersistedDeliveryOutcome(smtpPayload) === null ? 'absent' : 'valid';
  } catch {
    return 'malformed';
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
      parsedHeaders: unknown;
    }
  | undefined
> {
  const rows = await db
    .select({
      id: mailIngestQuarantine.id,
      reason: mailIngestQuarantine.reason,
      rawMimeS3Key: mailIngestQuarantine.rawMimeS3Key,
      parsedHeaders: mailIngestQuarantine.parsedHeaders,
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

async function loadActiveTransportsByIds(
  db: DB,
  ids: string[],
): Promise<RoutedTransport[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: mailboxTransport.id,
      email: mailboxTransport.email,
      sendFromConfig: mailboxTransport.sendFromConfig,
    })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.isActive, true));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

function fanOutCopyMessageId(
  ingestMailboxId: string,
  pop3Uidl: string,
  transportId: string,
): string {
  const hash = createHash('sha256')
    .update(`fanout:${ingestMailboxId}:${pop3Uidl}:${transportId}`)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(
    17,
    20,
  )}-${hash.slice(20, 32)}`;
}

function fanOutAttachmentKey(sourceKey: string, destMessageId: string): string {
  const prefixEnd = sourceKey.indexOf('/', 'attachments/'.length);
  const rest = prefixEnd >= 0 ? sourceKey.slice(prefixEnd + 1) : sourceKey;
  return `attachments/${destMessageId}/${rest}`;
}

async function copyAttachmentsToMessageId(
  storage: S3Storage,
  attachments: ParsedInboundMessage['attachments'],
  destMessageId: string,
): Promise<ParsedInboundMessage['attachments']> {
  const copied: ParsedInboundMessage['attachments'] = [];
  for (const attachmentItem of attachments) {
    const destKey = fanOutAttachmentKey(attachmentItem.s3Key, destMessageId);
    if (destKey !== attachmentItem.s3Key) {
      await storage.copyObject({
        sourceKey: attachmentItem.s3Key,
        destKey,
        contentType: attachmentItem.mimeType,
      });
    }
    copied.push({ ...attachmentItem, s3Key: destKey });
  }
  return copied;
}

async function findMessageByIdAndTransport(
  db: DB,
  id: string,
  transportId: string,
  fanoutFrom: { ingestMailboxId: string; pop3Uidl: string },
): Promise<{ id: string; transportId: string } | undefined> {
  const rows = await db
    .select({
      id: message.id,
      transportId: message.transportId,
      sourceProvenance: message.sourceProvenance,
    })
    .from(message)
    .where(and(eq(message.id, id), eq(message.transportId, transportId)))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  const from = (row.sourceProvenance as { fanoutFrom?: { ingestMailboxId?: unknown; pop3Uidl?: unknown } } | null)
    ?.fanoutFrom;
  if (from?.ingestMailboxId !== fanoutFrom.ingestMailboxId || from?.pop3Uidl !== fanoutFrom.pop3Uidl) {
    throw new Error('fan-out copy id collision');
  }
  return { id: row.id, transportId: row.transportId };
}

async function persistMultiTransportFanOut(args: {
  parsed: ParsedInboundMessage;
  raw: Buffer;
  meta: IngestMeta;
  opts: PersistOptions;
  storage: S3Storage;
  rawMimeS3Key: string;
  ids: string[];
}): Promise<PersistResult> {
  const transports = await loadActiveTransportsByIds(args.opts.db, args.ids);
  if (transports.length < 2) {
    return quarantineWithAttachmentCleanup({
      db: args.opts.db,
      storage: args.storage,
      parsed: args.parsed,
      meta: args.meta,
      rawMimeS3Key: args.rawMimeS3Key,
      reason: 'multi_transport',
      activeIngestUidlClaimToken: args.opts.activeIngestUidlClaimToken,
    });
  }

  let firstOwner: PersistResult | null = null;
  let incomplete = false;
  let allSucceeded = true;
  let copyError: unknown;
  for (let i = 0; i < transports.length; i++) {
    try {
      const one = await persistInboundMessage(
        args.parsed,
        args.raw,
        { ...args.meta, rawMimeS3Key: args.rawMimeS3Key },
        {
          ...args.opts,
          routedTransport: transports[i],
          claimIngestIdentity: i === 0,
          skipAttachmentCleanup: true,
        },
      );
      if (i === 0) firstOwner = one;
      if (one.kind === 'deferred') incomplete = true;
      if (one.kind !== 'stored' && one.kind !== 'duplicate' && one.kind !== 'reconciled') {
        allSucceeded = false;
      }
    } catch (err) {
      copyError = err;
      allSucceeded = false;
    }
  }

  const candidateAttachmentCleanupFailureCount = await cleanupCandidateAttachmentTasks({
    db: args.opts.db,
    storage: args.storage,
    attachments: args.parsed.attachments,
    meta: args.meta,
    activeIngestUidlClaimToken: args.opts.activeIngestUidlClaimToken,
  });

  if (copyError) throw copyError;
  if (incomplete || !firstOwner) {
    return {
      kind: 'deferred',
      transportId:
        firstOwner && 'transportId' in firstOwner ? firstOwner.transportId : transports[0]!.id,
      messageId:
        firstOwner && 'messageId' in firstOwner ? firstOwner.messageId : args.meta.messageId,
      rawMimeS3Key: args.rawMimeS3Key,
      candidateAttachmentCleanupFailureCount,
    };
  }

  if (allSucceeded && args.opts.promoteQuarantineId) {
    await args.opts.db
      .delete(mailIngestQuarantine)
      .where(eq(mailIngestQuarantine.id, args.opts.promoteQuarantineId));
  }

  if (firstOwner.kind !== 'stored' && firstOwner.kind !== 'reconciled') {
    return { ...firstOwner, candidateAttachmentCleanupFailureCount };
  }
  return firstOwner;
}

async function findDirectToTransport(
  db: DB,
  toAddresses: string[],
): Promise<TransportMatchResult<RoutedTransport>> {
  if (toAddresses.length === 0) return { kind: 'none' };
  const transports = await db
    .select({
      id: mailboxTransport.id,
      email: mailboxTransport.email,
      sendFromConfig: mailboxTransport.sendFromConfig,
    })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.isActive, true));

  return resolveTransportMatch(transports, toAddresses);
}

async function findActiveTransportById(
  db: DB,
  transportId: 'transport-centurion',
): Promise<RoutedTransport | null> {
  const rows = await db
    .select({
      id: mailboxTransport.id,
      email: mailboxTransport.email,
      sendFromConfig: mailboxTransport.sendFromConfig,
    })
    .from(mailboxTransport)
    .where(and(eq(mailboxTransport.id, transportId), eq(mailboxTransport.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
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

export function resolveTransportMatch<T extends TransportMatchCandidate>(
  candidates: T[],
  addresses: string[],
): TransportMatchResult<T> {
  const normalizedAddresses = [...new Set(addresses.map(normalizeEmailAddress).filter(Boolean))];
  if (normalizedAddresses.length === 0 || candidates.length === 0) return { kind: 'none' };

  const byId = new Map<string, T>();
  const ambiguousIds = new Set<string>();
  for (const address of normalizedAddresses) {
    const matchingIds = new Set<string>();
    for (const candidate of candidates) {
      if (transportIdentitySet(candidate.email, candidate.sendFromConfig).has(address)) {
        matchingIds.add(candidate.id);
        byId.set(candidate.id, candidate);
      }
    }
    if (matchingIds.size >= 2) {
      for (const id of matchingIds) ambiguousIds.add(id);
    }
  }

  if (ambiguousIds.size > 0) {
    return { kind: 'ambiguous', ids: [...ambiguousIds].sort() };
  }
  if (byId.size >= 2 && byId.has(NAVA_TRANSPORT_ID)) {
    const hotelMatched = [...byId.keys()].some((id) => id !== NAVA_TRANSPORT_ID);
    if (hotelMatched) byId.delete(NAVA_TRANSPORT_ID);
  }
  if (byId.size >= 2) {
    return { kind: 'multi', ids: [...byId.keys()].sort() };
  }
  const unique = [...byId.values()][0];
  return unique ? { kind: 'unique', transport: unique } : { kind: 'none' };
}

async function findTransportByStamp(
  db: DB,
  ownerHeaderValue: string,
): Promise<TransportMatchResult<RoutedTransport>> {
  const normalizedHeader = normalizeEmailAddress(ownerHeaderValue);
  if (!normalizedHeader) return { kind: 'none' };
  const transports = await db
    .select({
      id: mailboxTransport.id,
      email: mailboxTransport.email,
      ownerHeaderValue: mailboxTransport.ownerHeaderValue,
      sendFromConfig: mailboxTransport.sendFromConfig,
    })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.isActive, true));

  const matched = new Map<string, RoutedTransport>();
  for (const transport of transports) {
    if (normalizeEmailAddress(transport.ownerHeaderValue) === normalizedHeader) {
      matched.set(transport.id, transport);
    }
  }
  const identity = resolveTransportMatch(transports, [normalizedHeader]);
  if (identity.kind === 'unique') {
    matched.set(identity.transport.id, identity.transport);
  } else if (identity.kind === 'ambiguous' || identity.kind === 'multi') {
    for (const id of identity.ids) {
      const row = transports.find((transport) => transport.id === id);
      if (row) matched.set(id, row);
    }
  }

  if (matched.size > 1) return { kind: 'ambiguous', ids: [...matched.keys()].sort() };
  const unique = [...matched.values()][0];
  return unique ? { kind: 'unique', transport: unique } : { kind: 'none' };
}

async function findEquatedHotelTransport(
  db: DB,
  parsed: ParsedInboundMessage,
): Promise<TransportMatchResult<RoutedTransport>> {
  const rows = await db
    .select({
      id: mailboxTransport.id,
      email: mailboxTransport.email,
      sendFromConfig: mailboxTransport.sendFromConfig,
    })
    .from(mailboxTransport)
    .where(
      and(
        inArray(mailboxTransport.id, [...HOTEL_EQUATED_TRANSPORT_IDS]),
        eq(mailboxTransport.isActive, true),
      ),
    );

  const recipients = resolveTransportMatch(rows, [
    ...parsed.toAddresses,
    ...parsed.ccAddresses,
    ...parsed.bccAddresses,
  ]);
  if (recipients.kind !== 'none') return recipients;
  return resolveTransportMatch(rows, parsed.fromAddress ? [parsed.fromAddress] : []);
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
    if (existing.reason !== reason) {
      await db
        .update(mailIngestQuarantine)
        .set({
          reason,
          ownerHeaderValue: parsed.ownerHeaderValue,
          parsedHeaders: headerSummary(parsed),
        })
        .where(eq(mailIngestQuarantine.id, existing.id));
    }
    return {
      kind: 'quarantined',
      quarantineId: existing.id,
      reason,
      rawMimeS3Key: existing.rawMimeS3Key,
      candidateAttachmentCleanupFailureCount: 0,
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
    candidateAttachmentCleanupFailureCount: 0,
  };
}

async function quarantineWithAttachmentCleanup(
  args: Parameters<typeof quarantineUnrouted>[0] & {
    storage: S3Storage;
    activeIngestUidlClaimToken?: string;
    skipAttachmentCleanup?: boolean;
  },
): Promise<PersistQuarantinedResult> {
  const result = await quarantineUnrouted(args);
  if (args.skipAttachmentCleanup) {
    return { ...result, candidateAttachmentCleanupFailureCount: 0 };
  }
  const candidateAttachmentCleanupFailureCount = await cleanupCandidateAttachmentTasks({
    db: args.db,
    storage: args.storage,
    attachments: args.parsed.attachments,
    meta: args.meta,
    activeIngestUidlClaimToken: args.activeIngestUidlClaimToken,
  });
  return { ...result, candidateAttachmentCleanupFailureCount };
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

  const referenceChain = buildReferenceChain(parsed.inReplyTo, parsed.references);
  for (let i = referenceChain.length - 1; i >= 0; i--) {
    const parentThreadId = await findParentThreadByMessageIdHeader(
      tx,
      transportId,
      referenceChain[i]!,
    );
    if (parentThreadId) {
      await tx
        .update(mailThread)
        .set({
          latestMessageAt: now,
          snippet,
          isRead: false,
          updatedAt: new Date(),
        })
        .where(eq(mailThread.id, parentThreadId));
      return parentThreadId;
    }
  }

  const threadRootId = canonicalMessageId(parsed.messageId) ?? `no-message-id-${pop3Uidl}`;
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

function canonicalizePersistedReferences(references: readonly string[]): string[] {
  const canonicalRefs: string[] = [];
  const seen = new Set<string>();
  for (const ref of references) {
    const canon = canonicalMessageId(ref);
    if (!canon || seen.has(canon)) continue;
    seen.add(canon);
    canonicalRefs.push(canon);
  }
  return canonicalRefs;
}

function canonicalizePersistedHeaders(parsed: ParsedInboundMessage): {
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
} {
  return {
    messageIdHeader: canonicalMessageId(parsed.messageId),
    inReplyTo: canonicalMessageId(parsed.inReplyTo),
    references: canonicalizePersistedReferences(parsed.references),
  };
}

async function findParentThreadByMessageIdHeader(
  tx: DB,
  transportId: string,
  canonicalHeader: string,
): Promise<string | null> {
  const parentRows = await tx
    .select({ threadId: message.threadId })
    .from(message)
    .where(and(eq(message.transportId, transportId), eq(message.messageIdHeader, canonicalHeader)))
    .orderBy(asc(message.createdAt), asc(message.id))
    .limit(2);
  if (parentRows.length > 1) {
    console.warn(
      `ingest: duplicate message_id_header ${canonicalHeader} on transport ${transportId}; tie-break oldest`,
    );
  }
  return parentRows[0]?.threadId ?? null;
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
