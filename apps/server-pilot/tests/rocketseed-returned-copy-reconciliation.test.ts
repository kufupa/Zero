import {
  attachment,
  mailIngestMailbox,
  mailboxTransport,
  mailThread,
  message,
  outboundSendQueue,
} from '../src/db/schema/mail.js';
import { persistInboundMessage as persistInboundMessageImpl } from '../src/mail/ingest/store.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { parseRawMessage } from '../src/mail/ingest/parse-message.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import * as schema from '../src/db/schema/index.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { DB } from '../src/db/client.js';
import { eq, inArray, ne } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const reachable = await probeTestDb();

type PersistInboundArgs = Parameters<typeof persistInboundMessageImpl>;

function persistInboundMessage(...[parsed, raw, meta, opts]: PersistInboundArgs) {
  return persistInboundMessageImpl(parsed, raw, meta, {
    ...opts,
    ingestSource: 'live-pop3',
  });
}

function trustedReturnedCopy(args: {
  fromAddress?: string;
  includeAttachment?: boolean;
  outboundId?: string;
  ownerHeaderValue?: string;
  receivedLines?: string[];
  messageId: string;
  transportAddress: string;
}): Buffer {
  const body = args.includeAttachment
    ? [
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="task-2-boundary"',
        '',
        '--task-2-boundary',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'trusted returned copy',
        '--task-2-boundary',
        'Content-Type: application/octet-stream; name="returned.bin"',
        'Content-Disposition: attachment; filename="returned.bin"',
        'Content-Transfer-Encoding: base64',
        '',
        'dGFzay0y',
        '--task-2-boundary--',
      ]
    : ['', 'trusted returned copy'];
  const receivedLines = args.receivedLines ?? [
    'Received: from 172.24.0.10 by zimbra-a; Mon, 24 Aug 2026 12:00:00 +0000',
    'Received: from localhost by local-a; Mon, 24 Aug 2026 12:00:01 +0000',
    'Received: from localhost by local-b; Mon, 24 Aug 2026 12:00:02 +0000',
    'Received: from 172.24.0.8 by rocket-a; Mon, 24 Aug 2026 12:00:03 +0000',
    'Received: from 172.24.0.8 by rocket-b; Mon, 24 Aug 2026 12:00:04 +0000',
  ];

  return Buffer.from(
    [
      `X-Zero-Mailbox: ${args.ownerHeaderValue ?? args.transportAddress}`,
      ...(args.outboundId ? [`X-Zero-Outbound-Id: ${args.outboundId}`] : []),
      `Message-ID: <${args.messageId}>`,
      `From: ${args.fromAddress ?? args.transportAddress}`,
      `To: ${args.transportAddress}`,
      ...receivedLines,
      ...body,
    ].join('\r\n'),
  );
}

function richTrustedReturnedCopy(args: {
  messageId: string;
  outboundId: string;
  transportAddress: string;
}): Buffer {
  return Buffer.from(
    [
      `X-Zero-Mailbox: ${args.transportAddress}`,
      `X-Zero-Outbound-Id: ${args.outboundId}`,
      `Message-ID: <${args.messageId}>`,
      `In-Reply-To: <delivered-parent@zero.test>`,
      'References: <root@zero.test> <delivered-parent@zero.test>',
      `From: ${args.transportAddress}`,
      `To: ${args.transportAddress}`,
      'Cc: cc@zero.test',
      'Bcc: bcc@zero.test',
      'Subject: delivered Rocketseed representation',
      'Date: Mon, 24 Aug 2026 12:00:03 +0000',
      'Received: from 172.24.0.10 by zimbra-a; Mon, 24 Aug 2026 12:00:00 +0000',
      'Received: from localhost by local-a; Mon, 24 Aug 2026 12:00:01 +0000',
      'Received: from localhost by local-b; Mon, 24 Aug 2026 12:00:02 +0000',
      'Received: from 172.24.0.8 by rocket-a; Mon, 24 Aug 2026 12:00:03 +0000',
      'Received: from 172.24.0.8 by rocket-b; Mon, 24 Aug 2026 12:00:04 +0000',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="mixed-boundary"',
      '',
      '--mixed-boundary',
      'Content-Type: multipart/alternative; boundary="alternative-boundary"',
      '',
      '--alternative-boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Delivered plain text body.',
      '--alternative-boundary',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Delivered <strong>HTML</strong> body.</p>',
      '--alternative-boundary--',
      '--mixed-boundary',
      'Content-Type: application/octet-stream; name="delivered.bin"',
      'Content-Disposition: attachment; filename="delivered.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      'ZGVsaXZlcmVk',
      '--mixed-boundary--',
    ].join('\r\n'),
    'utf-8',
  );
}

async function seedCanonicalOutbound(
  db: import('../src/db/client.js').DB,
  opts: {
    direction?: 'inbound' | 'outbound';
    queueStatus?: string;
  } = {},
) {
  const transportId = 'transport-centurion';
  const transportRows = await db
    .select({ email: mailboxTransport.email })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.id, transportId))
    .limit(1);
  const transportAddress = transportRows[0]?.email;
  if (!transportAddress) throw new Error('missing test transport');

  const canonicalMessageId = randomUUID();
  const canonicalThreadId = randomUUID();
  const returnedMessageId = `returned-${randomUUID()}@zero.test`;
  const timestamp = new Date('2026-08-24T12:00:00.000Z');

  await db.insert(mailThread).values({
    id: canonicalThreadId,
    transportId,
    threadRootId: `task-2-${canonicalThreadId}`,
    subject: 'canonical outbound',
    snippet: 'preserve thread state',
    isArchived: true,
    isStarred: true,
    isRead: false,
    labelIds: ['task-2-preserved'],
    latestMessageAt: timestamp,
  });
  await db.insert(message).values({
    id: canonicalMessageId,
    transportId,
    threadId: canonicalThreadId,
    direction: opts.direction ?? 'outbound',
    fromAddress: transportAddress,
    toAddresses: [transportAddress],
    ccAddresses: [],
    bccAddresses: [],
    subject: 'canonical outbound',
    textBody: 'outbound body',
    messageIdHeader: returnedMessageId,
    references: [],
    isRead: false,
    isStarred: true,
    receivedAt: timestamp,
  });
  await db.insert(outboundSendQueue).values({
    id: randomUUID(),
    transportId,
    messageId: canonicalMessageId,
    sendAt: timestamp,
    status: opts.queueStatus ?? 'sent',
    smtpPayload: {},
    attempts: 1,
    lastError: null,
    claimedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return {
    canonicalMessageId,
    canonicalThreadId,
    returnedMessageId,
    transportAddress,
    transportId,
  };
}

function openConcurrentTestDb(): { client: ReturnType<typeof postgres>; db: DB } {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) throw new Error('missing disposable test database');
  const client = postgres(testDatabaseUrl, { max: 1, ssl: false });
  return {
    client,
    db: drizzle(client, { schema }) as unknown as DB,
  };
}

async function seedConcurrentCanonical(db: DB) {
  const suffix = randomUUID();
  const transportId = `task-2-transport-${suffix}`;
  const ingestMailboxId = `task-2-ingest-${suffix}`;
  const transportAddress = `task-2-${suffix}@zero.test`;
  const canonicalMessageId = randomUUID();
  const canonicalThreadId = randomUUID();
  const returnedMessageId = `returned-${randomUUID()}@zero.test`;
  const timestamp = new Date('2026-08-24T12:00:00.000Z');

  await db.insert(mailIngestMailbox).values({
    id: ingestMailboxId,
    email: `ingest-${suffix}@zero.test`,
    description: 'task 2 concurrent reconciliation',
    isActive: true,
  });
  await db.insert(mailboxTransport).values({
    id: transportId,
    email: transportAddress,
    ownerHeaderValue: transportAddress,
    isActive: true,
  });
  await db.insert(mailThread).values({
    id: canonicalThreadId,
    transportId,
    threadRootId: `task-2-${canonicalThreadId}`,
    subject: 'canonical outbound',
    snippet: 'concurrent reconciliation',
    isArchived: false,
    isStarred: false,
    isRead: true,
    labelIds: [],
    latestMessageAt: timestamp,
  });
  await db.insert(message).values({
    id: canonicalMessageId,
    transportId,
    threadId: canonicalThreadId,
    direction: 'outbound',
    fromAddress: transportAddress,
    toAddresses: [transportAddress],
    ccAddresses: [],
    bccAddresses: [],
    subject: 'canonical outbound',
    textBody: 'outbound body',
    messageIdHeader: returnedMessageId,
    references: [],
    isRead: true,
    isStarred: false,
    receivedAt: timestamp,
  });
  await db.insert(outboundSendQueue).values({
    id: randomUUID(),
    transportId,
    messageId: canonicalMessageId,
    sendAt: timestamp,
    status: 'sent',
    smtpPayload: {},
    attempts: 1,
    lastError: null,
    claimedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return {
    canonicalMessageId,
    ingestMailboxId,
    returnedMessageId,
    transportAddress,
    transportId,
  };
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('Rocketseed returned-copy reconciliation', () => {
  it('reconciles a trusted outbound UUID into its sent canonical message', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const result = await withSeededTestDb(async (db) => {
      const { canonicalMessageId, canonicalThreadId, returnedMessageId, transportAddress } =
        await seedCanonicalOutbound(db);
      const candidateMessageId = randomUUID();

      const raw = richTrustedReturnedCopy({
        outboundId: canonicalMessageId,
        messageId: returnedMessageId,
        transportAddress,
      });
      const parsed = await parseRawMessage(raw, {
        messageId: candidateMessageId,
        storage,
      });
      const persistResult = await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `task-2-${randomUUID()}`,
          messageId: candidateMessageId,
          rawMimeS3Key: 'raw-mime/task-2-enriched.eml',
        },
        { db, storage, skipAiEnqueue: true },
      );
      const rows = await db
        .select()
        .from(message)
        .where(inArray(message.id, [canonicalMessageId, candidateMessageId]));
      const threadRows = await db
        .select()
        .from(mailThread)
        .where(eq(mailThread.id, canonicalThreadId));
      const attachmentRows = await db
        .select()
        .from(attachment)
        .where(eq(attachment.messageId, canonicalMessageId));

      return {
        attachmentRows,
        canonicalMessageId,
        expectedRawMimeS3Key: 'raw-mime/task-2-enriched.eml',
        parsed,
        persistResult,
        rows,
        threadRows,
      };
    });

    expect(result.persistResult.kind).toBe('reconciled');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.id).toBe(result.canonicalMessageId);
    expect(result.rows[0]?.direction).toBe('outbound');
    expect(result.rows[0]?.isRead).toBe(false);
    expect(result.rows[0]?.isStarred).toBe(true);
    expect(result.rows[0]).toMatchObject({
      bccAddresses: result.parsed.bccAddresses,
      ccAddresses: result.parsed.ccAddresses,
      fromAddress: result.parsed.fromAddress,
      htmlBody: result.parsed.htmlBody,
      inReplyTo: result.parsed.inReplyTo,
      messageIdHeader: result.parsed.messageId,
      ownerHeaderValue: result.parsed.ownerHeaderValue,
      rawMimeS3Key: result.expectedRawMimeS3Key,
      receivedAt: result.parsed.receivedAt,
      references: result.parsed.references,
      subject: result.parsed.subject,
      textBody: result.parsed.textBody,
      toAddresses: result.parsed.toAddresses,
    });
    expect(result.threadRows).toHaveLength(1);
    expect(result.threadRows[0]?.isArchived).toBe(true);
    expect(result.threadRows[0]?.isStarred).toBe(true);
    expect(result.threadRows[0]?.isRead).toBe(false);
    expect(result.threadRows[0]?.labelIds).toEqual(['task-2-preserved']);
    expect(result.attachmentRows).toHaveLength(1);
    expect(result.attachmentRows[0]).toMatchObject({
      filename: result.parsed.attachments[0]?.filename,
      messageId: result.canonicalMessageId,
      s3Key: result.parsed.attachments[0]?.s3Key,
    });
  }, 30000);

  it('uses ordinary ingest without live POP3 reconciliation opt-in', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const result = await withSeededTestDb(async (db) => {
      const canonical = await seedCanonicalOutbound(db);
      const candidateMessageId = randomUUID();
      const raw = trustedReturnedCopy({
        outboundId: canonical.canonicalMessageId,
        messageId: canonical.returnedMessageId,
        transportAddress: canonical.transportAddress,
      });
      const parsed = await parseRawMessage(raw, {
        messageId: candidateMessageId,
        storage,
      });
      const persisted = await persistInboundMessageImpl(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `task-2-${randomUUID()}`,
          messageId: candidateMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const rows = await db
        .select({ id: message.id })
        .from(message)
        .where(inArray(message.id, [canonical.canonicalMessageId, candidateMessageId]));
      return { persisted, rows };
    });

    expect(result.persisted.kind).toBe('stored');
    expect(result.rows).toHaveLength(2);
  }, 30000);

  it('uses ordinary ingest when correlation points at an inbound row', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const result = await withSeededTestDb(async (db) => {
      const canonical = await seedCanonicalOutbound(db, { direction: 'inbound' });
      const candidateMessageId = randomUUID();
      const raw = trustedReturnedCopy({
        outboundId: canonical.canonicalMessageId,
        messageId: canonical.returnedMessageId,
        transportAddress: canonical.transportAddress,
      });
      const parsed = await parseRawMessage(raw, {
        messageId: candidateMessageId,
        storage,
      });
      const persistResult = await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `task-2-${randomUUID()}`,
          messageId: candidateMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const rows = await db
        .select({ id: message.id })
        .from(message)
        .where(inArray(message.id, [canonical.canonicalMessageId, candidateMessageId]));
      return { persistResult, rows };
    });

    expect(result.persistResult.kind).toBe('stored');
    expect(result.rows).toHaveLength(2);
  }, 30000);

  it('uses ordinary ingest when canonical queue is not sent', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const result = await withSeededTestDb(async (db) => {
      const canonical = await seedCanonicalOutbound(db, { queueStatus: 'pending' });
      const candidateMessageId = randomUUID();
      const raw = trustedReturnedCopy({
        outboundId: canonical.canonicalMessageId,
        messageId: canonical.returnedMessageId,
        transportAddress: canonical.transportAddress,
      });
      const parsed = await parseRawMessage(raw, {
        messageId: candidateMessageId,
        storage,
      });
      const persistResult = await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `task-2-${randomUUID()}`,
          messageId: candidateMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const rows = await db
        .select({ id: message.id })
        .from(message)
        .where(inArray(message.id, [canonical.canonicalMessageId, candidateMessageId]));
      return { persistResult, rows };
    });

    expect(result.persistResult.kind).toBe('stored');
    expect(result.rows).toHaveLength(2);
  }, 30000);

  it('reconciles an absent correlation header by exact Message-ID', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const result = await withSeededTestDb(async (db) => {
      const canonical = await seedCanonicalOutbound(db);
      const candidateMessageId = randomUUID();
      const raw = trustedReturnedCopy({
        messageId: canonical.returnedMessageId,
        transportAddress: canonical.transportAddress,
      });
      const parsed = await parseRawMessage(raw, {
        messageId: candidateMessageId,
        storage,
      });
      const persistResult = await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `task-2-${randomUUID()}`,
          messageId: candidateMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const rows = await db
        .select({ id: message.id })
        .from(message)
        .where(inArray(message.id, [canonical.canonicalMessageId, candidateMessageId]));
      return { persistResult, rows };
    });

    expect(result.persistResult.kind).toBe('reconciled');
    expect(result.rows).toHaveLength(1);
  }, 30000);

  it('does not fall back to Message-ID for malformed or unknown outbound IDs', async () => {
    const malformed = await withSeededTestDb(async (db) => {
      const storage = new FakeS3Storage('test-mail-bucket');
      const canonical = await seedCanonicalOutbound(db);
      const candidateMessageId = randomUUID();
      const raw = trustedReturnedCopy({
        outboundId: 'not-a-uuid',
        messageId: canonical.returnedMessageId,
        transportAddress: canonical.transportAddress,
      });
      const parsed = await parseRawMessage(raw, {
        messageId: candidateMessageId,
        storage,
      });
      const persistResult = await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `task-2-${randomUUID()}`,
          messageId: candidateMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const rows = await db
        .select({ id: message.id })
        .from(message)
        .where(inArray(message.id, [canonical.canonicalMessageId, candidateMessageId]));
      return { persistResult, rows };
    });
    const unknown = await withSeededTestDb(async (db) => {
      const storage = new FakeS3Storage('test-mail-bucket');
      const canonical = await seedCanonicalOutbound(db);
      const candidateMessageId = randomUUID();
      const raw = trustedReturnedCopy({
        outboundId: randomUUID(),
        messageId: canonical.returnedMessageId,
        transportAddress: canonical.transportAddress,
      });
      const parsed = await parseRawMessage(raw, {
        messageId: candidateMessageId,
        storage,
      });
      const persistResult = await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `task-2-${randomUUID()}`,
          messageId: candidateMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const rows = await db
        .select({ id: message.id })
        .from(message)
        .where(inArray(message.id, [canonical.canonicalMessageId, candidateMessageId]));
      return { persistResult, rows };
    });

    expect(malformed.persistResult.kind).toBe('stored');
    expect(malformed.rows).toHaveLength(2);
    expect(unknown.persistResult.kind).toBe('stored');
    expect(unknown.rows).toHaveLength(2);
  }, 30000);

  it('moves returned attachments onto the canonical outbound message', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const result = await withSeededTestDb(async (db) => {
      const canonical = await seedCanonicalOutbound(db);
      const candidateMessageId = randomUUID();
      const raw = trustedReturnedCopy({
        includeAttachment: true,
        outboundId: canonical.canonicalMessageId,
        messageId: canonical.returnedMessageId,
        transportAddress: canonical.transportAddress,
      });
      const parsed = await parseRawMessage(raw, {
        messageId: candidateMessageId,
        storage,
      });
      const persistResult = await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `task-2-${randomUUID()}`,
          messageId: candidateMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const attachmentRows = await db
        .select()
        .from(attachment)
        .where(eq(attachment.messageId, canonical.canonicalMessageId));
      return { attachmentRows, persistResult };
    });

    expect(result.persistResult.kind).toBe('reconciled');
    if (result.persistResult.kind !== 'reconciled') return;
    expect(result.persistResult.attachmentCount).toBe(1);
    expect(result.attachmentRows).toHaveLength(1);
  }, 30000);

  it('drains a replayed UIDL without a duplicate canonical attachment', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const result = await withSeededTestDb(async (db) => {
      const canonical = await seedCanonicalOutbound(db);
      const pop3Uidl = `task-2-${randomUUID()}`;
      const raw = trustedReturnedCopy({
        includeAttachment: true,
        outboundId: canonical.canonicalMessageId,
        messageId: canonical.returnedMessageId,
        transportAddress: canonical.transportAddress,
      });
      const firstMessageId = randomUUID();
      const secondMessageId = randomUUID();
      const firstParsed = await parseRawMessage(raw, {
        messageId: firstMessageId,
        storage,
      });
      const first = await persistInboundMessage(
        firstParsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl,
          messageId: firstMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const secondParsed = await parseRawMessage(raw, {
        messageId: secondMessageId,
        storage,
      });
      const second = await persistInboundMessage(
        secondParsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl,
          messageId: secondMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const rows = await db
        .select({ id: message.id })
        .from(message)
        .where(
          inArray(message.id, [canonical.canonicalMessageId, firstMessageId, secondMessageId]),
        );
      const attachmentRows = await db
        .select()
        .from(attachment)
        .where(eq(attachment.messageId, canonical.canonicalMessageId));
      return { attachmentRows, first, rows, second };
    });

    expect(result.first.kind).toBe('reconciled');
    expect(result.second.kind).toBe('duplicate');
    expect(result.rows).toHaveLength(1);
    expect(result.attachmentRows).toHaveLength(1);
  }, 30000);

  it('removes candidate attachment objects for a later physical copy', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const result = await withSeededTestDb(async (db) => {
      const canonical = await seedCanonicalOutbound(db);
      const raw = trustedReturnedCopy({
        includeAttachment: true,
        outboundId: canonical.canonicalMessageId,
        messageId: canonical.returnedMessageId,
        transportAddress: canonical.transportAddress,
      });
      const firstMessageId = randomUUID();
      const firstParsed = await parseRawMessage(raw, {
        messageId: firstMessageId,
        storage,
      });
      const first = await persistInboundMessage(
        firstParsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `task-2-${randomUUID()}`,
          messageId: firstMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const secondMessageId = randomUUID();
      const secondParsed = await parseRawMessage(raw, {
        messageId: secondMessageId,
        storage,
      });
      const second = await persistInboundMessage(
        secondParsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `task-2-${randomUUID()}`,
          messageId: secondMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const rows = await db
        .select({ id: message.id })
        .from(message)
        .where(
          inArray(message.id, [canonical.canonicalMessageId, firstMessageId, secondMessageId]),
        );
      const attachmentRows = await db
        .select()
        .from(attachment)
        .where(eq(attachment.messageId, canonical.canonicalMessageId));
      return {
        attachmentRows,
        canonicalAttachmentKey: firstParsed.attachments[0]?.s3Key,
        candidateAttachmentKey: secondParsed.attachments[0]?.s3Key,
        first,
        rows,
        second,
      };
    });

    expect(result.first.kind).toBe('reconciled');
    expect(result.second.kind).toBe('duplicate');
    expect(result.rows).toHaveLength(1);
    expect(result.attachmentRows).toHaveLength(1);
    expect(result.canonicalAttachmentKey).toBeTruthy();
    expect(result.candidateAttachmentKey).toBeTruthy();
    if (!result.canonicalAttachmentKey || !result.candidateAttachmentKey) return;
    expect(storage.get(result.canonicalAttachmentKey)).toBeDefined();
    expect(storage.get(result.candidateAttachmentKey)).toBeUndefined();
    expect(storage.get(result.first.rawMimeS3Key)).toBeDefined();
    expect(storage.get(result.second.rawMimeS3Key)).toBeDefined();
  }, 30000);

  it('reports candidate attachment cleanup failure without blocking duplicate drain', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const result = await withSeededTestDb(async (db) => {
      const canonical = await seedCanonicalOutbound(db);
      const raw = trustedReturnedCopy({
        includeAttachment: true,
        outboundId: canonical.canonicalMessageId,
        messageId: canonical.returnedMessageId,
        transportAddress: canonical.transportAddress,
      });
      const firstMessageId = randomUUID();
      const firstParsed = await parseRawMessage(raw, {
        messageId: firstMessageId,
        storage,
      });
      const first = await persistInboundMessage(
        firstParsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `task-2-${randomUUID()}`,
          messageId: firstMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const secondMessageId = randomUUID();
      const secondParsed = await parseRawMessage(raw, {
        messageId: secondMessageId,
        storage,
      });
      storage.deleteObject = async () => {
        throw new Error('injected candidate cleanup failure');
      };
      const second = await persistInboundMessage(
        secondParsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `task-2-${randomUUID()}`,
          messageId: secondMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      return {
        candidateAttachmentKey: secondParsed.attachments[0]?.s3Key,
        canonicalAttachmentKey: firstParsed.attachments[0]?.s3Key,
        first,
        second,
      };
    });

    expect(result.first.kind).toBe('reconciled');
    expect(result.second.kind).toBe('duplicate');
    if (result.second.kind !== 'duplicate') return;
    expect(result.second.candidateAttachmentCleanupFailureCount).toBe(1);
    expect(result.canonicalAttachmentKey).toBeTruthy();
    expect(result.candidateAttachmentKey).toBeTruthy();
    if (!result.canonicalAttachmentKey || !result.candidateAttachmentKey) return;
    expect(storage.get(result.canonicalAttachmentKey)).toBeDefined();
    expect(storage.get(result.candidateAttachmentKey)).toBeDefined();
    expect(storage.get(result.first.rawMimeS3Key)).toBeDefined();
    expect(storage.get(result.second.rawMimeS3Key)).toBeDefined();
  }, 30000);

  it('uses ordinary ingest when Task 1 sender, owner, or topology checks reject', async () => {
    const result = await withSeededTestDb(async (db) => {
      const storage = new FakeS3Storage('test-mail-bucket');
      const canonical = await seedCanonicalOutbound(db);
      const ownerAlias = `task-2-alias-${randomUUID()}@zero.test`;
      await db
        .update(mailboxTransport)
        .set({ sendFromConfig: { aliases: [ownerAlias] } })
        .where(eq(mailboxTransport.id, canonical.transportId));

      const attempts = [
        trustedReturnedCopy({
          fromAddress: `task-2-sender-${randomUUID()}@zero.test`,
          outboundId: canonical.canonicalMessageId,
          messageId: canonical.returnedMessageId,
          transportAddress: canonical.transportAddress,
        }),
        trustedReturnedCopy({
          outboundId: canonical.canonicalMessageId,
          ownerHeaderValue: ownerAlias,
          messageId: canonical.returnedMessageId,
          transportAddress: canonical.transportAddress,
        }),
        trustedReturnedCopy({
          outboundId: canonical.canonicalMessageId,
          messageId: canonical.returnedMessageId,
          receivedLines: [
            'Received: from 203.0.113.1 by zimbra-a; Mon, 24 Aug 2026 12:00:00 +0000',
            'Received: from localhost by local-a; Mon, 24 Aug 2026 12:00:01 +0000',
            'Received: from localhost by local-b; Mon, 24 Aug 2026 12:00:02 +0000',
            'Received: from 172.24.0.8 by rocket-a; Mon, 24 Aug 2026 12:00:03 +0000',
            'Received: from 172.24.0.8 by rocket-b; Mon, 24 Aug 2026 12:00:04 +0000',
          ],
          transportAddress: canonical.transportAddress,
        }),
      ];
      const candidateMessageIds: string[] = [];
      const persistResults = [];
      for (const raw of attempts) {
        const candidateMessageId = randomUUID();
        candidateMessageIds.push(candidateMessageId);
        const parsed = await parseRawMessage(raw, {
          messageId: candidateMessageId,
          storage,
        });
        persistResults.push(
          await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: `task-2-${randomUUID()}`,
              messageId: candidateMessageId,
            },
            { db, storage, skipAiEnqueue: true },
          ),
        );
      }
      const rows = await db
        .select({ id: message.id })
        .from(message)
        .where(inArray(message.id, [canonical.canonicalMessageId, ...candidateMessageIds]));
      return { persistResults, rows };
    });

    expect(result.persistResults.map((entry) => entry.kind)).toEqual([
      'stored',
      'stored',
      'stored',
    ]);
    expect(result.rows).toHaveLength(4);
  }, 30000);

  it('uses ordinary ingest when returned copy arrives through another transport', async () => {
    const result = await withSeededTestDb(async (db) => {
      const storage = new FakeS3Storage('test-mail-bucket');
      const canonical = await seedCanonicalOutbound(db);
      const otherTransport = await db
        .select({
          id: mailboxTransport.id,
          email: mailboxTransport.email,
        })
        .from(mailboxTransport)
        .where(ne(mailboxTransport.id, canonical.transportId))
        .limit(1);
      const other = otherTransport[0];
      if (!other) throw new Error('missing second test transport');

      const candidateMessageId = randomUUID();
      const raw = trustedReturnedCopy({
        outboundId: canonical.canonicalMessageId,
        messageId: canonical.returnedMessageId,
        transportAddress: other.email,
      });
      const parsed = await parseRawMessage(raw, {
        messageId: candidateMessageId,
        storage,
      });
      const persisted = await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `task-2-${randomUUID()}`,
          messageId: candidateMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const canonicalRow = await db
        .select({
          ingestMailboxId: message.ingestMailboxId,
          pop3Uidl: message.pop3Uidl,
        })
        .from(message)
        .where(eq(message.id, canonical.canonicalMessageId))
        .limit(1);
      return { canonicalRow: canonicalRow[0], persisted };
    });

    expect(result.persisted.kind).toBe('stored');
    expect(result.canonicalRow).toMatchObject({
      ingestMailboxId: null,
      pop3Uidl: null,
    });
  }, 30000);

  it('locks concurrent copies so only one reconciliation attaches', async () => {
    const setup = openConcurrentTestDb();
    const firstConnection = openConcurrentTestDb();
    const secondConnection = openConcurrentTestDb();
    let ingestMailboxId: string | undefined;
    let transportId: string | undefined;

    try {
      const canonical = await seedConcurrentCanonical(setup.db);
      ingestMailboxId = canonical.ingestMailboxId;
      transportId = canonical.transportId;
      const raw = trustedReturnedCopy({
        includeAttachment: true,
        outboundId: canonical.canonicalMessageId,
        messageId: canonical.returnedMessageId,
        transportAddress: canonical.transportAddress,
      });
      const firstMessageId = randomUUID();
      const secondMessageId = randomUUID();
      const firstStorage = new FakeS3Storage('test-mail-bucket');
      const secondStorage = new FakeS3Storage('test-mail-bucket');
      const [firstParsed, secondParsed] = await Promise.all([
        parseRawMessage(raw, {
          messageId: firstMessageId,
          storage: firstStorage,
        }),
        parseRawMessage(raw, {
          messageId: secondMessageId,
          storage: secondStorage,
        }),
      ]);
      const [first, second] = await Promise.all([
        persistInboundMessage(
          firstParsed,
          raw,
          {
            ingestMailboxId: canonical.ingestMailboxId,
            pop3Uidl: `task-2-${randomUUID()}`,
            messageId: firstMessageId,
          },
          {
            db: firstConnection.db,
            storage: firstStorage,
            skipAiEnqueue: true,
          },
        ),
        persistInboundMessage(
          secondParsed,
          raw,
          {
            ingestMailboxId: canonical.ingestMailboxId,
            pop3Uidl: `task-2-${randomUUID()}`,
            messageId: secondMessageId,
          },
          {
            db: secondConnection.db,
            storage: secondStorage,
            skipAiEnqueue: true,
          },
        ),
      ]);
      const rows = await setup.db
        .select({ id: message.id })
        .from(message)
        .where(
          inArray(message.id, [canonical.canonicalMessageId, firstMessageId, secondMessageId]),
        );
      const attachmentRows = await setup.db
        .select()
        .from(attachment)
        .where(eq(attachment.messageId, canonical.canonicalMessageId));

      expect([first.kind, second.kind].sort()).toEqual(['duplicate', 'reconciled']);
      expect(rows).toHaveLength(1);
      expect(attachmentRows).toHaveLength(1);
    } finally {
      if (transportId) {
        await setup.db.delete(mailboxTransport).where(eq(mailboxTransport.id, transportId));
      }
      if (ingestMailboxId) {
        await setup.db.delete(mailIngestMailbox).where(eq(mailIngestMailbox.id, ingestMailboxId));
        const remainingMailboxRows = await setup.db
          .select({ id: mailIngestMailbox.id })
          .from(mailIngestMailbox)
          .where(eq(mailIngestMailbox.id, ingestMailboxId));
        expect(remainingMailboxRows).toHaveLength(0);
      }
      await Promise.all([
        firstConnection.client.end(),
        secondConnection.client.end(),
        setup.client.end(),
      ]);
    }
  }, 60000);
});
