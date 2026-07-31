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
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DB } from '../../db/client.js';
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
  rawMimeKey,
  getS3Storage,
  type S3Storage,
} from '../../storage/s3.js';
import {
  type ParsedInboundMessage,
  parseRawMessage,
  generateMessageId,
} from './parse-message.js';
import { sanitizeHtmlBodyForStorage } from '../sanitize-email-html.js';
import {
  DEFAULT_AI_MODEL_ID,
  DEFAULT_TRIAGE_PROMPT_VERSION,
  enqueueAiRun,
} from '../../ai/run-ledger.js';
import { refreshThreadSearchVector } from '../search/search-vector.js';
import { getSenderPreference } from '../sender-preference.js';
import { ingestRequireOwnerHeader } from '../../env.js';
import { hasTrustedTopReceivedHeader } from './rocketseed-relay.js';

const CENTURION_TRANSPORT_ID = 'transport-centurion';

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

export type PersistKind = 'stored' | 'quarantined' | 'duplicate';

export interface IngestMeta {
  /** Mailbox id the message was ingested from (e.g. `ingest-nava-legacy`). */
  ingestMailboxId: string;
  /** POP3 UIDL on the ingest mailbox. */
  pop3Uidl: string;
  /**
   * Incoming parse id. MUST equal the id passed to `parseRawMessage`, which
   * namespaces attachment S3 keys. New rows reuse it as `message.id`;
   * reconciled outbound rows keep their original id while delivered S3 keys
   * retain this incoming parse-id prefix.
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
}

export type PersistResult =
  | PersistStoredResult
  | PersistQuarantinedResult
  | PersistDuplicateResult;

export interface PersistOptions {
  /** DB handle (production: getDb(); tests: transaction-scoped handle). */
  db: DB;
  /** S3 storage override (tests inject a fake). */
  storage?: S3Storage;
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

  const rawMimeS3Key = meta.rawMimeS3Key ?? rawMimeKey({
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

  return db.transaction(async (tx) => {
    const transactionDb = tx as unknown as DB;
    await acquireIngestReplayLock(transactionDb, meta);
    return persistInboundMessageLocked({
      parsed,
      meta,
      opts,
      rawMimeS3Key,
      db: transactionDb,
    });
  });
}

async function persistInboundMessageLocked(args: {
  parsed: ParsedInboundMessage;
  meta: IngestMeta;
  opts: PersistOptions;
  rawMimeS3Key: string;
  db: DB;
}): Promise<PersistResult> {
  const { parsed, meta, opts, rawMimeS3Key, db } = args;
  const existingMessage = await findExistingIngestedMessage(db, meta);
  if (existingMessage) {
    return {
      kind: 'duplicate',
      transportId: existingMessage.transportId,
      messageId: existingMessage.id,
      rawMimeS3Key,
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

  const incomingMessageId = meta.messageId;
  let storedMessageId = incomingMessageId;
  let threadId = '';
  const transactionDb = db;
  const tx = db;
  {
    const transportIdentities = transportIdentitySet(
      transport.email,
      transport.sendFromConfig,
    );
    const fromAddress = (parsed.fromAddress ?? '').trim().toLowerCase();
    const fromEmail = normalizeEmailAddress(fromAddress);
    const mayReconcile =
      Boolean(fromEmail) &&
      transportIdentities.has(fromEmail) &&
      hasTrustedTopReceivedHeader(parsed.rawHeaderLines);
    const reconciliationCandidate = mayReconcile
      ? await findOutboundReconciliationCandidate(
          transactionDb,
          transport.id,
          parsed,
        )
      : undefined;

    if (reconciliationCandidate) {
      const deliveredAt = parsed.receivedAt ?? new Date();
      const now = new Date();

      const reconciled = await tx
        .update(message)
        .set({
          ingestMailboxId: meta.ingestMailboxId,
          pop3Uidl: meta.pop3Uidl,
          ownerHeaderValue: parsed.ownerHeaderValue,
          textBody: parsed.textBody,
          htmlBody: sanitizeHtmlBodyForStorage(parsed.htmlBody),
          rawMimeS3Key,
          receivedAt: deliveredAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(message.id, reconciliationCandidate.id),
            eq(message.transportId, transport.id),
            eq(message.direction, 'outbound'),
            isNull(message.ingestMailboxId),
          ),
        )
        .returning({ id: message.id, threadId: message.threadId });

      const reconciledRow = reconciled[0];
      if (!reconciledRow) {
        return {
          kind: 'duplicate',
          transportId: transport.id,
          messageId: reconciliationCandidate.id,
          rawMimeS3Key,
        };
      }
      storedMessageId = reconciledRow.id;
      threadId = reconciledRow.threadId;

      await tx
        .delete(attachment)
        .where(eq(attachment.messageId, reconciledRow.id));
      if (parsed.attachments.length > 0) {
        await tx.insert(attachment).values(
          parsed.attachments.map((a) => ({
            id: randomUUID(),
            messageId: reconciledRow.id,
            filename: a.filename,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            s3Key: a.s3Key,
            contentId: a.contentId,
            isInline: a.isInline,
          })),
        );
      }

      await refreshThreadSearchVector(transactionDb, threadId);
      if (opts.promoteQuarantineId) {
        await tx
          .delete(mailIngestQuarantine)
          .where(eq(mailIngestQuarantine.id, opts.promoteQuarantineId));
      }
      return {
        kind: 'stored',
        transportId: transport.id,
        messageId: storedMessageId,
        threadId,
        rawMimeS3Key,
        attachmentCount: parsed.attachments.length,
      };
    }

    const reconciledDuplicate = mayReconcile
      ? await findReconciledOutboundDuplicate(
          transactionDb,
          transport.id,
          parsed,
        )
      : undefined;
    if (reconciledDuplicate) {
      return {
        kind: 'duplicate',
        transportId: transport.id,
        messageId: reconciledDuplicate.id,
        rawMimeS3Key,
      };
    }

    threadId = await resolveThreadId({
      tx: transactionDb,
      transportId: transport.id,
      parsed,
      pop3Uidl: meta.pop3Uidl,
    });

    const transportEmail = (transport.email ?? '').trim().toLowerCase();
    const recipientEmails = [
      ...parsed.toAddresses,
      ...parsed.ccAddresses,
      ...parsed.bccAddresses,
    ].map(normalizeEmailAddress);
    const isSelfIngestLoopback =
      transportIdentities.size > 0 &&
      recipientEmails.some((a) => transportIdentities.has(a));
    const isHotelSent =
      Boolean(fromEmail) &&
      transportIdentities.has(fromEmail) &&
      !isSelfIngestLoopback;

    await tx.insert(message).values({
      id: incomingMessageId,
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
    });

    if (parsed.attachments.length > 0) {
      await tx.insert(attachment).values(
        parsed.attachments.map((a) => ({
          id: randomUUID(),
          messageId: incomingMessageId,
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
      const softLabelId = await ensureSoftQuarantineLabel(
        tx as unknown as DB,
        transport.id,
      );
      await applyThreadLabels(tx as unknown as DB, threadId, [softLabelId]);
    }

    await refreshThreadSearchVector(transactionDb, threadId);

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
          triggerMessageId: incomingMessageId,
          runKind: 'inbound_triage',
          idempotencyKey: `inbound-triage:${incomingMessageId}`,
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
  }

  return {
    kind: 'stored',
    transportId: transport.id,
    messageId: storedMessageId,
    threadId,
    rawMimeS3Key,
    attachmentCount: parsed.attachments.length,
  };
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

export function ingestReplayLockKey(
  meta: Pick<IngestMeta, 'ingestMailboxId' | 'pop3Uidl'>,
): string {
  return JSON.stringify([meta.ingestMailboxId, meta.pop3Uidl]);
}

async function acquireIngestReplayLock(
  db: DB,
  meta: Pick<IngestMeta, 'ingestMailboxId' | 'pop3Uidl'>,
): Promise<void> {
  const lockKey = ingestReplayLockKey(meta);
  await db.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))
  `);
}

async function findExistingIngestedMessage(
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
      ),
    )
    .limit(1);
  return rows[0];
}

type OutboundReconciliationMatch = {
  id: string;
  threadId: string;
};

async function findOutboundReconciliationCandidate(
  db: DB,
  transportId: string,
  parsed: ParsedInboundMessage,
): Promise<OutboundReconciliationMatch | undefined> {
  return findOutboundReconciliationMatch(db, transportId, parsed, false);
}

async function findReconciledOutboundDuplicate(
  db: DB,
  transportId: string,
  parsed: ParsedInboundMessage,
): Promise<OutboundReconciliationMatch | undefined> {
  return findOutboundReconciliationMatch(db, transportId, parsed, true);
}

async function findOutboundReconciliationMatch(
  db: DB,
  transportId: string,
  parsed: ParsedInboundMessage,
  reconciled: boolean,
): Promise<OutboundReconciliationMatch | undefined> {
  const reconciliationState = reconciled
    ? isNotNull(message.ingestMailboxId)
    : isNull(message.ingestMailboxId);
  if (hasOutboundCorrelationHeader(parsed)) {
    if (!parsed.outboundMessageId) return undefined;
    const rows = await db
      .select({
        id: message.id,
        threadId: message.threadId,
      })
      .from(message)
      .innerJoin(
        outboundSendQueue,
        and(
          eq(outboundSendQueue.messageId, message.id),
          eq(outboundSendQueue.transportId, message.transportId),
          eq(outboundSendQueue.status, 'sent'),
        ),
      )
      .where(
        and(
          eq(message.id, parsed.outboundMessageId),
          eq(message.transportId, transportId),
          eq(message.direction, 'outbound'),
          reconciliationState,
        ),
      )
      .limit(1);
    return rows[0];
  }

  if (!parsed.messageId) return undefined;
  const rows = await db
    .select({
      id: message.id,
      threadId: message.threadId,
    })
    .from(message)
    .innerJoin(
      outboundSendQueue,
      and(
        eq(outboundSendQueue.messageId, message.id),
        eq(outboundSendQueue.transportId, message.transportId),
        eq(outboundSendQueue.status, 'sent'),
      ),
    )
    .where(
      and(
        eq(message.messageIdHeader, parsed.messageId),
        eq(message.transportId, transportId),
        eq(message.direction, 'outbound'),
        reconciliationState,
      ),
    )
    .limit(2);
  return rows.length === 1 ? rows[0] : undefined;
}

function hasOutboundCorrelationHeader(
  parsed: ParsedInboundMessage,
): boolean {
  return parsed.rawHeaderLines.some(
    (header) => header.key.trim().toLowerCase() === 'x-zero-outbound-id',
  );
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
    transports.find((transport) =>
      directTo.has(normalizeEmailAddress(transport.email)),
    ) ?? null
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
  return [
    parsed.fromAddress,
    ...parsed.toAddresses,
    ...parsed.ccAddresses,
    ...parsed.bccAddresses,
  ]
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
    (transport) =>
      normalizeEmailAddress(transport.ownerHeaderValue) === normalizedHeader,
  );
  if (byOwnerHeader) return byOwnerHeader;

  return (
    transports.find((transport) =>
      transportIdentitySet(transport.email, transport.sendFromConfig).has(
        normalizedHeader,
      ),
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
      and(
        eq(mailboxTransport.id, CENTURION_TRANSPORT_ID),
        eq(mailboxTransport.isActive, true),
      ),
    )
    .limit(1);

  const centurion = centurionRows[0];
  if (!centurion) return null;

  const identities = transportIdentitySet(
    centurion.email,
    centurion.sendFromConfig,
  );
  if (equatedAddresses(parsed).some((address) => identities.has(address))) {
    return centurion;
  }
  return null;
}

async function ensureSoftQuarantineLabel(
  db: DB,
  transportId: string,
): Promise<string> {
  const id = `label-soft-quarantine-${transportId}`;
  await db
    .insert(mailLabel)
    .values({ id, transportId, name: 'soft-quarantine', color: null })
    .onConflictDoNothing({ target: [mailLabel.transportId, mailLabel.name] });
  return id;
}

/** From domain outside transport domain (minimal allowlist = transport domain). */
function isExternalFromDomain(
  fromEmail: string,
  transportEmail: string,
): boolean {
  const fromDomain = fromEmail.includes('@')
    ? fromEmail.slice(fromEmail.lastIndexOf('@') + 1)
    : '';
  const transportDomain = transportEmail.includes('@')
    ? transportEmail.slice(transportEmail.lastIndexOf('@') + 1)
    : '';
  if (!fromDomain || !transportDomain) return true;
  return fromDomain !== transportDomain;
}

async function applyThreadLabels(
  tx: DB,
  threadId: string,
  labelIds: string[],
): Promise<void> {
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
  const snippet = parsed.textBody
    ? parsed.textBody.slice(0, 200)
    : parsed.subject ?? '';

  const candidates = [
    ...(parsed.inReplyTo ? [parsed.inReplyTo] : []),
    ...parsed.references,
  ].filter(Boolean);
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
    .where(
      and(
        eq(mailThread.transportId, transportId),
        eq(mailThread.threadRootId, threadRootId),
      ),
    )
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
