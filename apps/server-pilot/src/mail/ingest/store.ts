/**
 * Persist an inbound message to Postgres + S3.
 *
 * Routing:
 *   1. Parse `X-Zero-Mailbox` header from the parsed message.
 *   2. Look up `mailboxTransport` by `ownerHeaderValue`. If found, store the
 *      message scoped to that transport (create/find a thread, insert
 *      `message` + `attachment` rows).
 *   3. If the header is missing -> quarantine with reason `missing_owner_header`.
 *      If the header is present but no matching transport -> quarantine with
 *      reason `unknown_transport`.
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
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DB } from '../../db/client.js';
import {
  attachment,
  mailIngestQuarantine,
  mailboxTransport,
  message,
  mailThread,
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

export type QuarantineReason =
  | 'missing_owner_header'
  | 'unknown_transport'
  | 'message_too_large';

export type PersistKind = 'stored' | 'quarantined' | 'duplicate';

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

  // Raw MIME S3 key. The worker pre-uploads and passes the key via
  // `meta.rawMimeS3Key`; when absent, we upload the raw bytes here.
  const rawMimeS3Key = meta.rawMimeS3Key ?? rawMimeKey({
    ingestMailboxId: meta.ingestMailboxId,
    pop3Uidl: meta.pop3Uidl,
    receivedAt: parsed.receivedAt ?? undefined,
  });
  if (!meta.rawMimeS3Key) {
    await storage.putObject({
      key: rawMimeS3Key,
      body: raw,
      contentType: 'message/rfc822',
    });
  }

  // Routing ------------------------------------------------------------
  if (!parsed.ownerHeaderValue) {
    return quarantineUnrouted({
      db,
      parsed,
      meta,
      rawMimeS3Key,
      reason: 'missing_owner_header',
    });
  }

  const transportRows = await db
    .select({
      id: mailboxTransport.id,
      email: mailboxTransport.email,
    })
    .from(mailboxTransport)
    .where(
      and(
        eq(mailboxTransport.ownerHeaderValue, parsed.ownerHeaderValue),
        eq(mailboxTransport.isActive, true),
      ),
    )
    .limit(1);

  if (transportRows.length === 0) {
    return quarantineUnrouted({
      db,
      parsed,
      meta,
      rawMimeS3Key,
      reason: 'unknown_transport',
    });
  }

  const transport = transportRows[0]!;

  // Duplicate check ----------------------------------------------------
  // If we've already stored this UIDL on this ingest mailbox, return
  // `duplicate` without re-inserting. Worker treats duplicate as success
  // (safe to DELE — message already persisted).
  const existing = await db
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.ingestMailboxId, meta.ingestMailboxId),
        eq(message.pop3Uidl, meta.pop3Uidl),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return {
      kind: 'duplicate',
      transportId: transport.id,
      messageId: existing[0]!.id,
      rawMimeS3Key,
    };
  }

  // Thread resolution --------------------------------------------------
  const threadId = await resolveOrCreateThread({
    db,
    transportId: transport.id,
    parsed,
  });

  // Insert message + attachments --------------------------------------
  // Reuse the SAME messageId that parseRawMessage used to namespace the
  // attachment S3 keys (`attachments/{messageId}/...`) so the S3 key prefix
  // and the DB `message.id` stay aligned. Do NOT regenerate here.
  const messageId = meta.messageId;
  await db.transaction(async (tx) => {
    await tx.insert(message).values({
      id: messageId,
      transportId: transport.id,
      threadId,
      ingestMailboxId: meta.ingestMailboxId,
      direction: 'inbound',
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
      htmlBody: parsed.htmlBody,
      rawMimeS3Key,
      receivedAt: parsed.receivedAt ?? new Date(),
      sentAt: parsed.receivedAt ?? null,
    });

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
  });

  return {
    kind: 'stored',
    transportId: transport.id,
    messageId,
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

async function quarantineUnrouted(args: {
  db: DB;
  parsed: ParsedInboundMessage;
  meta: IngestMeta;
  rawMimeS3Key: string;
  reason: QuarantineReason;
}): Promise<PersistQuarantinedResult> {
  const { db, parsed, meta, rawMimeS3Key, reason } = args;
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

async function resolveOrCreateThread(args: {
  db: DB;
  transportId: string;
  parsed: ParsedInboundMessage;
}): Promise<string> {
  const { db, transportId, parsed } = args;

  // Thread root = Message-ID if present, else the pop3 uidl-derived stable id.
  const threadRootId =
    parsed.messageId ?? `no-message-id-${parsed.inReplyTo ?? 'root'}`;
  // Try to find an existing thread on this transport with the same root.
  const existing = await db
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
    return existing[0]!.id;
  }

  const threadId = randomUUID();
  await db.insert(mailThread).values({
    id: threadId,
    transportId,
    threadRootId,
    subject: parsed.subject,
    snippet: parsed.textBody
      ? parsed.textBody.slice(0, 200)
      : parsed.subject ?? '',
    isArchived: false,
    isStarred: false,
    isRead: false,
    labelIds: [],
    latestMessageAt: parsed.receivedAt ?? new Date(),
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
