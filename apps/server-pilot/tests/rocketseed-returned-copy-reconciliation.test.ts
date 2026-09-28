import {
  attachment,
  mailIngestCandidateAttachmentCleanup,
  mailIngestQuarantine,
  mailIngestMailbox,
  mailboxTransport,
  mailThread,
  message,
  outboundSendQueue,
} from '../src/db/schema/mail.js';
import {
  persistInboundMessage as persistInboundMessageImpl,
  sweepCandidateAttachmentCleanupTasks,
} from '../src/mail/ingest/store.js';
import {
  openTestDbSession,
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';
import { FakeSmtpTransport, __setSmtpTransportForTests } from '../src/mail/send/smtp.js';
import { RECLAIM_SENDING_AFTER_MS, flushDue } from '../src/mail/send/outbound-queue.js';
import { parseRawMessage } from '../src/mail/ingest/parse-message.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import { describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { eq, inArray, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const reachable = await probeTestDb();

type PersistInboundArgs = Parameters<typeof persistInboundMessageImpl>;
type TestSession = ReturnType<typeof openTestDbSession>;

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
  messageId: string | null;
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
      ...(args.messageId ? [`Message-ID: <${args.messageId}>`] : []),
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
    bccAddresses?: string[];
    direction?: 'inbound' | 'outbound';
    queueStatus?: string;
    returnedMessageId?: string;
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
  const queueId = randomUUID();
  const returnedMessageId = opts.returnedMessageId ?? `returned-${randomUUID()}@zero.test`;
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
    bccAddresses: opts.bccAddresses ?? [],
    subject: 'canonical outbound',
    textBody: 'outbound body',
    messageIdHeader: returnedMessageId,
    references: [],
    isRead: false,
    isStarred: true,
    receivedAt: timestamp,
  });
  await db.insert(outboundSendQueue).values({
    id: queueId,
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
    queueId,
    returnedMessageId,
    transportAddress,
    transportId,
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
      bccAddresses: [],
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

  it('retains canonical BCC audit recipients when a trusted returned copy omits BCC', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const auditBcc = `audit-${randomUUID()}@zero.test`;
    const result = await withSeededTestDb(async (db) => {
      const canonical = await seedCanonicalOutbound(db, {
        bccAddresses: [auditBcc],
      });
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
          pop3Uidl: `task-3-bcc-${randomUUID()}`,
          messageId: candidateMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const [canonicalRow] = await db
        .select({ bccAddresses: message.bccAddresses })
        .from(message)
        .where(eq(message.id, canonical.canonicalMessageId))
        .limit(1);

      return { canonicalRow, parsed, persistResult };
    });

    expect(result.persistResult.kind).toBe('reconciled');
    expect(result.parsed.bccAddresses).toEqual([]);
    expect(result.canonicalRow?.bccAddresses).toEqual([auditBcc]);
  }, 30000);

  it('reconciles strict UUID correlation from a sending row when returned Message-ID is missing or rewritten', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const cases = [
      { name: 'missing', returnedMessageId: null },
      {
        name: 'rewritten',
        returnedMessageId: `rewritten-${randomUUID()}@zero.test`,
      },
    ] as const;
    const results = await withSeededTestDb(async (db) => {
      const persisted = [];
      for (const testCase of cases) {
        const canonical = await seedCanonicalOutbound(db, { queueStatus: 'sending' });
        await db
          .update(outboundSendQueue)
          .set({
            smtpPayload: {
              deliveryOutcome: {
                messageId: canonical.returnedMessageId,
                accepted: [`Mailbox <${canonical.transportAddress.toUpperCase()}>`],
                rejected: [],
              },
            },
          })
          .where(eq(outboundSendQueue.id, canonical.queueId));
        const candidateMessageId = randomUUID();
        const raw = trustedReturnedCopy({
          outboundId: canonical.canonicalMessageId,
          messageId: testCase.returnedMessageId,
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
            pop3Uidl: `task-2b-${randomUUID()}`,
            messageId: candidateMessageId,
          },
          { db, storage, skipAiEnqueue: true, ingestSource: 'live-pop3' },
        );
        const rows = await db
          .select({ id: message.id })
          .from(message)
          .where(inArray(message.id, [canonical.canonicalMessageId, candidateMessageId]));
        const [canonicalRow] = await db
          .select({
            messageIdHeader: message.messageIdHeader,
            threadId: message.threadId,
          })
          .from(message)
          .where(eq(message.id, canonical.canonicalMessageId));
        const [queue] = await db
          .select({ status: outboundSendQueue.status })
          .from(outboundSendQueue)
          .where(eq(outboundSendQueue.id, canonical.queueId));
        persisted.push({ canonical, canonicalRow, persistResult, queue, rows });
      }
      return persisted;
    });

    for (const result of results) {
      expect(result.persistResult.kind).toBe('reconciled');
      expect(result.rows).toEqual([{ id: result.canonical.canonicalMessageId }]);
      expect(result.queue?.status).toBe('sending');
      expect(result.canonicalRow).toEqual({
        messageIdHeader: result.canonical.returnedMessageId,
        threadId: result.canonical.canonicalThreadId,
      });
    }
  }, 30000);

  it('finalizes a UUID-reconciled persisted outcome without another SMTP send', async () => {
    const smtp = new FakeSmtpTransport();
    __setSmtpTransportForTests(smtp);

    try {
      const storage = new FakeS3Storage('test-mail-bucket');
      const result = await withSeededTestDb(async (db) => {
        const canonical = await seedCanonicalOutbound(db, { queueStatus: 'sending' });
        await db
          .update(outboundSendQueue)
          .set({
            claimedAt: new Date(Date.now() - RECLAIM_SENDING_AFTER_MS - 1),
            smtpPayload: {
              from: canonical.transportAddress,
              to: [canonical.transportAddress],
              cc: [],
              bcc: [],
              subject: 'reconciled persisted outcome',
              html: '<p>reconciled persisted outcome</p>',
              text: 'reconciled persisted outcome',
              deliveryOutcome: {
                messageId: canonical.returnedMessageId,
                accepted: [canonical.transportAddress],
                rejected: [],
              },
            },
            smtpOutcomePersistedAt: new Date('2026-08-24T12:00:03.000Z'),
          })
          .where(eq(outboundSendQueue.id, canonical.queueId));
        const candidateMessageId = randomUUID();
        const raw = trustedReturnedCopy({
          outboundId: canonical.canonicalMessageId,
          messageId: `rewritten-${randomUUID()}@zero.test`,
          transportAddress: canonical.transportAddress,
        });
        const parsed = await parseRawMessage(raw, {
          messageId: candidateMessageId,
          storage,
        });
        const reconcileResult = await persistInboundMessage(
          parsed,
          raw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: `task-2b-${randomUUID()}`,
            messageId: candidateMessageId,
          },
          { db, storage, skipAiEnqueue: true },
        );
        const [queueBeforeFinalize] = await db
          .select({ status: outboundSendQueue.status })
          .from(outboundSendQueue)
          .where(eq(outboundSendQueue.id, canonical.queueId));
        const flushed = await flushDue({ db });
        const [queueAfterFinalize] = await db
          .select({ status: outboundSendQueue.status })
          .from(outboundSendQueue)
          .where(eq(outboundSendQueue.id, canonical.queueId));
        const rows = await db
          .select({ id: message.id })
          .from(message)
          .where(inArray(message.id, [canonical.canonicalMessageId, candidateMessageId]));
        const [canonicalRow] = await db
          .select({
            messageIdHeader: message.messageIdHeader,
            threadId: message.threadId,
          })
          .from(message)
          .where(eq(message.id, canonical.canonicalMessageId));
        return {
          canonical,
          canonicalRow,
          flushed,
          queueAfterFinalize,
          queueBeforeFinalize,
          reconcileResult,
          rows,
        };
      });

      expect(result.reconcileResult.kind).toBe('reconciled');
      expect(result.queueBeforeFinalize?.status).toBe('sending');
      expect(result.flushed).toEqual({ flushed: 1 });
      expect(result.queueAfterFinalize?.status).toBe('sent');
      expect(result.rows).toEqual([{ id: result.canonical.canonicalMessageId }]);
      expect(result.canonicalRow).toEqual({
        messageIdHeader: result.canonical.returnedMessageId,
        threadId: result.canonical.canonicalThreadId,
      });
      expect(smtp.sent).toHaveLength(0);
    } finally {
      __setSmtpTransportForTests(null);
    }
  }, 30000);

  it('preserves durable SMTP identity when UUID copies rewrite or omit Message-ID', async () => {
    const smtp = new FakeSmtpTransport();
    __setSmtpTransportForTests(smtp);

    try {
      const storage = new FakeS3Storage('test-mail-bucket');
      const results = await withSeededTestDb(async (db) => {
        const cases = [
          { name: 'missing', returnedMessageId: null },
          { name: 'rewritten', returnedMessageId: `rewritten-${randomUUID()}@zero.test` },
        ] as const;
        const persisted = [];

        for (const testCase of cases) {
          const canonical = await seedCanonicalOutbound(db, { queueStatus: 'sending' });
          const durableMessageId = `durable-${randomUUID()}@zero.test`;
          await db
            .update(message)
            .set({ messageIdHeader: null })
            .where(eq(message.id, canonical.canonicalMessageId));
          await db
            .update(outboundSendQueue)
            .set({
              claimedAt: new Date(Date.now() - RECLAIM_SENDING_AFTER_MS - 1),
              smtpPayload: {
                from: canonical.transportAddress,
                to: [canonical.transportAddress],
                cc: [],
                bcc: [],
                subject: 'durable outcome identity',
                html: '<p>durable outcome identity</p>',
                text: 'durable outcome identity',
                deliveryOutcome: {
                  messageId: durableMessageId,
                  accepted: [canonical.transportAddress],
                  rejected: [],
                },
              },
              smtpOutcomePersistedAt: new Date('2026-08-24T12:00:03.000Z'),
            })
            .where(eq(outboundSendQueue.id, canonical.queueId));

          const candidateMessageId = randomUUID();
          const raw = trustedReturnedCopy({
            outboundId: canonical.canonicalMessageId,
            messageId: testCase.returnedMessageId,
            transportAddress: canonical.transportAddress,
          });
          const parsed = await parseRawMessage(raw, {
            messageId: candidateMessageId,
            storage,
          });
          const reconcileResult = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: `durable-id-${randomUUID()}`,
              messageId: candidateMessageId,
            },
            { db, storage, skipAiEnqueue: true },
          );
          const flushed = await flushDue({ db });
          const [canonicalRow] = await db
            .select({ messageIdHeader: message.messageIdHeader })
            .from(message)
            .where(eq(message.id, canonical.canonicalMessageId))
            .limit(1);
          const [queue] = await db
            .select({ status: outboundSendQueue.status })
            .from(outboundSendQueue)
            .where(eq(outboundSendQueue.id, canonical.queueId))
            .limit(1);

          persisted.push({
            canonicalRow,
            durableMessageId,
            flushed,
            queue,
            reconcileResult,
          });
        }

        return persisted;
      });

      for (const result of results) {
        expect(result.reconcileResult.kind).toBe('reconciled');
        expect(result.flushed).toEqual({ flushed: 1 });
        expect(result.canonicalRow?.messageIdHeader).toBe(result.durableMessageId);
        expect(result.queue?.status).toBe('sent');
      }
      expect(smtp.sent).toHaveLength(0);
    } finally {
      __setSmtpTransportForTests(null);
    }
  }, 30000);

  it('defers only trusted UUID copies without a durable outcome and ordinarily ingests other candidates', async () => {
    const cases = [
      {
        name: 'missing outcome',
        queueStatus: 'sending',
        outcomeKind: 'missing',
        includeOutboundId: true,
      },
      {
        name: 'malformed outcome',
        queueStatus: 'sending',
        outcomeKind: 'malformed',
        includeOutboundId: true,
      },
      {
        name: 'missing accepted transport recipient',
        queueStatus: 'sending',
        outcomeKind: 'missing-transport-recipient',
        includeOutboundId: true,
      },
      {
        name: 'malformed accepted transport recipient wrapper',
        queueStatus: 'sending',
        outcomeKind: 'malformed-transport-recipient',
        includeOutboundId: true,
      },
      {
        name: 'pending queue',
        queueStatus: 'pending',
        outcomeKind: 'valid',
        includeOutboundId: true,
      },
      {
        name: 'cancelled queue',
        queueStatus: 'cancelled',
        outcomeKind: 'valid',
        includeOutboundId: true,
      },
      {
        name: 'message ID-only fallback while sending',
        queueStatus: 'sending',
        outcomeKind: 'valid',
        includeOutboundId: false,
      },
    ] as const;
    const storage = new FakeS3Storage('test-mail-bucket');
    const results = await withSeededTestDb(async (db) => {
      const persisted = [];
      for (const testCase of cases) {
        const canonical = await seedCanonicalOutbound(db, {
          queueStatus: testCase.queueStatus,
        });
        let smtpPayload: Record<string, unknown>;
        switch (testCase.outcomeKind) {
          case 'missing':
            smtpPayload = {};
            break;
          case 'malformed':
            smtpPayload = {
              deliveryOutcome: {
                messageId: canonical.returnedMessageId,
                accepted: [canonical.transportAddress],
              },
            };
            break;
          case 'missing-transport-recipient':
            smtpPayload = {
              deliveryOutcome: {
                messageId: canonical.returnedMessageId,
                accepted: ['other@zero.test'],
                rejected: [canonical.transportAddress],
              },
            };
            break;
          case 'malformed-transport-recipient':
            smtpPayload = {
              deliveryOutcome: {
                messageId: canonical.returnedMessageId,
                accepted: [`junk <${canonical.transportAddress}> trailing`],
                rejected: [],
              },
            };
            break;
          case 'valid':
            smtpPayload = {
              deliveryOutcome: {
                messageId: canonical.returnedMessageId,
                accepted: [canonical.transportAddress],
                rejected: [],
              },
            };
            break;
        }
        await db
          .update(outboundSendQueue)
          .set({
            claimedAt: testCase.queueStatus === 'sending' ? new Date() : null,
            smtpPayload,
          })
          .where(eq(outboundSendQueue.id, canonical.queueId));
        const candidateMessageId = randomUUID();
        const raw = trustedReturnedCopy({
          outboundId: testCase.includeOutboundId ? canonical.canonicalMessageId : undefined,
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
            pop3Uidl: `task-2b-${randomUUID()}`,
            messageId: candidateMessageId,
          },
          { db, storage, skipAiEnqueue: true },
        );
        const rows = await db
          .select({ id: message.id })
          .from(message)
          .where(inArray(message.id, [canonical.canonicalMessageId, candidateMessageId]));
        persisted.push({
          kind: persistResult.kind,
          name: testCase.name,
          rowCount: rows.length,
        });
      }
      return persisted;
    });

    expect(results).toEqual([
      { kind: 'deferred', name: 'missing outcome', rowCount: 1 },
      { kind: 'quarantined', name: 'malformed outcome', rowCount: 1 },
      { kind: 'stored', name: 'missing accepted transport recipient', rowCount: 2 },
      { kind: 'stored', name: 'malformed accepted transport recipient wrapper', rowCount: 2 },
      { kind: 'stored', name: 'pending queue', rowCount: 2 },
      { kind: 'stored', name: 'cancelled queue', rowCount: 2 },
      { kind: 'stored', name: 'message ID-only fallback while sending', rowCount: 2 },
    ]);
  }, 30000);

  it('retries durable candidate cleanup after malformed returned-copy cleanup fails', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const result = await withSeededTestDb(async (db) => {
      const canonical = await seedCanonicalOutbound(db, { queueStatus: 'sending' });
      await db
        .update(outboundSendQueue)
        .set({
          claimedAt: new Date(),
          smtpPayload: {
            deliveryOutcome: {
              messageId: canonical.returnedMessageId,
              accepted: [canonical.transportAddress],
            },
          },
        })
        .where(eq(outboundSendQueue.id, canonical.queueId));

      const pop3Uidl = `malformed-cleanup-${randomUUID()}`;
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
      const firstCandidateAttachmentKey = firstParsed.attachments[0]?.s3Key;
      if (!firstCandidateAttachmentKey) throw new Error('missing first candidate attachment');

      const originalDeleteObject = storage.deleteObject.bind(storage);
      let failFirstCleanup = true;
      storage.deleteObject = async (key) => {
        if (failFirstCleanup && key === firstCandidateAttachmentKey) {
          failFirstCleanup = false;
          throw new Error('injected first cleanup failure');
        }
        await originalDeleteObject(key);
      };
      let first: Awaited<ReturnType<typeof persistInboundMessage>>;
      try {
        first = await persistInboundMessage(
          firstParsed,
          raw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl,
            messageId: firstMessageId,
          },
          { db, storage, skipAiEnqueue: true },
        );
      } finally {
        storage.deleteObject = originalDeleteObject;
      }

      const candidateRowsAfterFirst = await db
        .select({ id: message.id })
        .from(message)
        .where(eq(message.id, firstMessageId));
      const quarantineRowsAfterFirst = await db
        .select({
          id: mailIngestQuarantine.id,
        })
        .from(mailIngestQuarantine)
        .where(eq(mailIngestQuarantine.pop3Uidl, pop3Uidl));
      const cleanupTasksAfterFirst = await db
        .select({ s3Key: mailIngestCandidateAttachmentCleanup.s3Key })
        .from(mailIngestCandidateAttachmentCleanup)
        .where(eq(mailIngestCandidateAttachmentCleanup.pop3Uidl, pop3Uidl));
      const foreignKey = `attachments/${randomUUID()}/001-foreign.bin`;
      await storage.putObject({
        key: foreignKey,
        body: Buffer.from('must not delete'),
        contentType: 'application/octet-stream',
      });
      await db
        .update(mailIngestQuarantine)
        .set({
          parsedHeaders: {
            candidateAttachmentCleanupKeys: [firstCandidateAttachmentKey, foreignKey],
          },
        })
        .where(eq(mailIngestQuarantine.id, quarantineRowsAfterFirst[0]!.id));
      await db
        .update(mailIngestCandidateAttachmentCleanup)
        .set({ nextAttemptAt: new Date() })
        .where(eq(mailIngestCandidateAttachmentCleanup.pop3Uidl, pop3Uidl));

      const retryMessageId = randomUUID();
      const retryParsed = await parseRawMessage(raw, {
        messageId: retryMessageId,
        storage,
      });
      const retryCandidateAttachmentKey = retryParsed.attachments[0]?.s3Key;
      if (!retryCandidateAttachmentKey) throw new Error('missing retry candidate attachment');
      const retry = await persistInboundMessage(
        retryParsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl,
          messageId: retryMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const candidateRowsAfterRetry = await db
        .select({ id: message.id })
        .from(message)
        .where(inArray(message.id, [firstMessageId, retryMessageId]));
      const cleanupTasksAfterRetry = await db
        .select({ s3Key: mailIngestCandidateAttachmentCleanup.s3Key })
        .from(mailIngestCandidateAttachmentCleanup)
        .where(eq(mailIngestCandidateAttachmentCleanup.pop3Uidl, pop3Uidl));

      return {
        candidateRowsAfterFirst,
        candidateRowsAfterRetry,
        cleanupTasksAfterFirst,
        cleanupTasksAfterRetry,
        first,
        firstCandidateAttachmentKey,
        foreignKey,
        quarantineRowsAfterFirst,
        retry,
        retryCandidateAttachmentKey,
      };
    });

    expect(result.quarantineRowsAfterFirst).toHaveLength(1);
    expect(result.candidateRowsAfterFirst).toEqual([]);
    expect(result.first.kind).toBe('quarantined');
    if (result.first.kind !== 'quarantined') return;
    expect(result.first.candidateAttachmentCleanupFailureCount).toBe(1);
    expect(result.cleanupTasksAfterFirst).toEqual([{ s3Key: result.firstCandidateAttachmentKey }]);

    expect(result.retry.kind).toBe('quarantined');
    if (result.retry.kind !== 'quarantined') return;
    expect(result.retry.candidateAttachmentCleanupFailureCount).toBe(0);
    expect(result.candidateRowsAfterRetry).toEqual([]);
    expect(storage.get(result.firstCandidateAttachmentKey)).toBeUndefined();
    expect(storage.get(result.retryCandidateAttachmentKey)).toBeUndefined();
    expect(storage.get(result.foreignKey)).toBeDefined();
    expect(result.cleanupTasksAfterRetry).toEqual([]);
  }, 30000);

  it('keeps deferred returned-copy cleanup durable through outcome reconciliation', async () => {
    const smtp = new FakeSmtpTransport();
    __setSmtpTransportForTests(smtp);

    try {
      const storage = new FakeS3Storage('test-mail-bucket');
      const result = await withSeededTestDb(async (db) => {
        const canonical = await seedCanonicalOutbound(db, { queueStatus: 'sending' });
        const pop3Uidl = `task-3-deferred-${randomUUID()}`;
        const raw = trustedReturnedCopy({
          includeAttachment: true,
          outboundId: canonical.canonicalMessageId,
          messageId: `rewritten-${randomUUID()}@zero.test`,
          transportAddress: canonical.transportAddress,
        });
        const firstMessageId = randomUUID();
        const firstParsed = await parseRawMessage(raw, {
          messageId: firstMessageId,
          storage,
        });
        const firstAttachmentKey = firstParsed.attachments[0]?.s3Key;
        if (!firstAttachmentKey) throw new Error('missing deferred attachment');
        const originalDeleteObject = storage.deleteObject.bind(storage);
        storage.deleteObject = async (key) => {
          if (key === firstAttachmentKey) {
            throw new Error('injected deferred cleanup failure');
          }
          await originalDeleteObject(key);
        };
        const first = await (async () => {
          try {
            return await persistInboundMessage(
              firstParsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl,
                messageId: firstMessageId,
              },
              { db, storage, skipAiEnqueue: true },
            );
          } finally {
            storage.deleteObject = originalDeleteObject;
          }
        })();
        const rowsAfterDeferral = await db
          .select({ id: message.id })
          .from(message)
          .where(inArray(message.id, [canonical.canonicalMessageId, firstMessageId]));
        const cleanupTasksAfterDeferral = await db
          .select({ s3Key: mailIngestCandidateAttachmentCleanup.s3Key })
          .from(mailIngestCandidateAttachmentCleanup)
          .where(eq(mailIngestCandidateAttachmentCleanup.pop3Uidl, pop3Uidl));
        const firstAttachment = storage.get(firstAttachmentKey);
        const firstRawMime = storage.get(first.rawMimeS3Key);

        await db
          .update(outboundSendQueue)
          .set({
            claimedAt: new Date(Date.now() - RECLAIM_SENDING_AFTER_MS - 1),
            smtpPayload: {
              from: canonical.transportAddress,
              to: [canonical.transportAddress],
              cc: [],
              bcc: [],
              subject: 'deferred returned copy',
              html: '<p>deferred returned copy</p>',
              text: 'deferred returned copy',
              deliveryOutcome: {
                messageId: canonical.returnedMessageId,
                accepted: [canonical.transportAddress],
                rejected: [],
              },
            },
            smtpOutcomePersistedAt: new Date('2026-08-24T12:00:03.000Z'),
          })
          .where(eq(outboundSendQueue.id, canonical.queueId));

        const retryMessageId = firstMessageId;
        const retryParsed = await parseRawMessage(raw, {
          messageId: retryMessageId,
          storage,
        });
        const retryAttachmentKey = retryParsed.attachments[0]?.s3Key;
        if (!retryAttachmentKey) throw new Error('missing reconciled attachment');
        const retry = await persistInboundMessage(
          retryParsed,
          raw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl,
            messageId: retryMessageId,
          },
          { db, storage, skipAiEnqueue: true },
        );
        await db
          .update(mailIngestCandidateAttachmentCleanup)
          .set({ nextAttemptAt: new Date() })
          .where(eq(mailIngestCandidateAttachmentCleanup.pop3Uidl, pop3Uidl));
        await sweepCandidateAttachmentCleanupTasks({ db, storage });
        const cleanupTasksAfterSweep = await db
          .select({ s3Key: mailIngestCandidateAttachmentCleanup.s3Key })
          .from(mailIngestCandidateAttachmentCleanup)
          .where(eq(mailIngestCandidateAttachmentCleanup.pop3Uidl, pop3Uidl));
        const attachmentAfterRetryCleanup = storage.get(firstAttachmentKey);
        const reconciledParsed = await parseRawMessage(raw, {
          messageId: retryMessageId,
          storage,
        });
        const reconciledAttachmentKey = reconciledParsed.attachments[0]?.s3Key;
        if (!reconciledAttachmentKey) throw new Error('missing final reconciled attachment');
        const reconciled = await persistInboundMessage(
          reconciledParsed,
          raw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl,
            messageId: retryMessageId,
          },
          { db, storage, skipAiEnqueue: true },
        );
        const flushed = await flushDue({ db });
        const [queue] = await db
          .select({ status: outboundSendQueue.status })
          .from(outboundSendQueue)
          .where(eq(outboundSendQueue.id, canonical.queueId))
          .limit(1);
        const rows = await db
          .select({ id: message.id })
          .from(message)
          .where(
            inArray(message.id, [canonical.canonicalMessageId, firstMessageId, retryMessageId]),
          );

        return {
          first,
          firstAttachmentKey,
          firstAttachment,
          firstRawMime,
          flushed,
          queue,
          retry,
          retryAttachmentKey,
          attachmentAfterRetryCleanup,
          reconciled,
          reconciledAttachmentKey,
          rows,
          rowsAfterDeferral,
          cleanupTasksAfterDeferral,
          cleanupTasksAfterSweep,
        };
      });

      expect(result.first.kind).toBe('deferred');
      if (result.first.kind !== 'deferred') return;
      expect(result.first.candidateAttachmentCleanupFailureCount).toBe(1);
      expect(result.rowsAfterDeferral).toEqual([{ id: expect.any(String) }]);
      expect(result.firstRawMime).toBeDefined();
      expect(result.cleanupTasksAfterDeferral).toEqual([{ s3Key: result.firstAttachmentKey }]);
      expect(result.firstAttachment).toBeDefined();
      expect(result.retry.kind).toBe('deferred');
      if (result.retry.kind !== 'deferred') return;
      expect(result.retry.candidateAttachmentCleanupFailureCount).toBe(0);
      expect(result.attachmentAfterRetryCleanup).toBeUndefined();
      expect(result.cleanupTasksAfterSweep).toEqual([]);
      expect(result.reconciled.kind).toBe('reconciled');
      expect(storage.get(result.reconciledAttachmentKey)).toBeDefined();
      expect(result.flushed).toEqual({ flushed: 1 });
      expect(result.queue?.status).toBe('sent');
      expect(result.rows).toHaveLength(1);
      expect(smtp.sent).toHaveLength(0);
    } finally {
      __setSmtpTransportForTests(null);
    }
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

  it('reconciles an absent correlation header against a sent Message-ID match', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const result = await withSeededTestDb(async (db) => {
      const returnedMessageId = `returned-${randomUUID()}@zero.test`;
      const pending = await seedCanonicalOutbound(db, {
        queueStatus: 'pending',
        returnedMessageId,
      });
      const canonical = await seedCanonicalOutbound(db, { returnedMessageId });
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
        .where(
          inArray(message.id, [
            pending.canonicalMessageId,
            canonical.canonicalMessageId,
            candidateMessageId,
          ]),
        );
      return { canonical, pending, persistResult, rows };
    });

    expect(result.persistResult.kind).toBe('reconciled');
    expect(result.rows.map((row) => row.id).sort()).toEqual(
      [result.pending.canonicalMessageId, result.canonical.canonicalMessageId].sort(),
    );
  }, 30000);

  it('does not reconcile an ambiguous sent Message-ID fallback', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const result = await withSeededTestDb(async (db) => {
      const returnedMessageId = `returned-${randomUUID()}@zero.test`;
      const firstCanonical = await seedCanonicalOutbound(db, { returnedMessageId });
      const secondCanonical = await seedCanonicalOutbound(db, { returnedMessageId });
      const candidateMessageId = randomUUID();
      const raw = trustedReturnedCopy({
        messageId: returnedMessageId,
        transportAddress: firstCanonical.transportAddress,
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
        .select({
          id: message.id,
          ingestMailboxId: message.ingestMailboxId,
          pop3Uidl: message.pop3Uidl,
        })
        .from(message)
        .where(
          inArray(message.id, [
            firstCanonical.canonicalMessageId,
            secondCanonical.canonicalMessageId,
            candidateMessageId,
          ]),
        );
      return { candidateMessageId, firstCanonical, persistResult, rows, secondCanonical };
    });

    expect(result.persistResult.kind).toBe('stored');
    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: result.firstCanonical.canonicalMessageId,
          ingestMailboxId: null,
          pop3Uidl: null,
        }),
        expect.objectContaining({
          id: result.secondCanonical.canonicalMessageId,
          ingestMailboxId: null,
          pop3Uidl: null,
        }),
        expect.objectContaining({
          id: result.candidateMessageId,
          ingestMailboxId: 'ingest-nava-legacy',
        }),
      ]),
    );
    expect(result.rows).toHaveLength(3);
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

  it('drains a reconciled outbound UIDL replay without a duplicate canonical attachment', async () => {
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

  it('treats inbound UIDL replay as duplicate of an outbound row with the same ingest identity', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const result = await withSeededTestDb(async (db) => {
      const canonical = await seedCanonicalOutbound(db);
      const pop3Uidl = `inbound-replay-${randomUUID()}`;
      await db
        .update(message)
        .set({
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl,
        })
        .where(eq(message.id, canonical.canonicalMessageId));

      const candidateMessageId = randomUUID();
      const raw = trustedReturnedCopy({
        messageId: `ordinary-inbound-${randomUUID()}@zero.test`,
        transportAddress: canonical.transportAddress,
      });
      const firstParsed = await parseRawMessage(raw, {
        messageId: candidateMessageId,
        storage,
      });
      const first = await persistInboundMessage(
        firstParsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl,
          messageId: candidateMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );

      const replayMessageId = randomUUID();
      const replayParsed = await parseRawMessage(raw, {
        messageId: replayMessageId,
        storage,
      });
      const replay = await persistInboundMessage(
        replayParsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl,
          messageId: replayMessageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      const rows = await db
        .select({
          direction: message.direction,
          id: message.id,
        })
        .from(message)
        .where(
          inArray(message.id, [canonical.canonicalMessageId, candidateMessageId, replayMessageId]),
        );
      return { candidateMessageId, canonical, first, replay, rows };
    });

    expect(result.first).toMatchObject({
      kind: 'duplicate',
      messageId: result.canonical.canonicalMessageId,
    });
    expect(result.replay).toMatchObject({
      kind: 'duplicate',
      messageId: result.canonical.canonicalMessageId,
    });
    expect(result.rows).toEqual([
      { direction: 'outbound', id: result.canonical.canonicalMessageId },
    ]);
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
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
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
      const diagnostics = warning.mock.calls.map(([event]) => JSON.parse(String(event)));
      expect(diagnostics).toEqual([
        {
          messageType: 'rocketseed_returned_copy_trust_rejected',
          reason: 'sender_mismatch',
        },
        {
          messageType: 'rocketseed_returned_copy_trust_rejected',
          reason: 'owner_mismatch',
        },
        {
          messageType: 'rocketseed_returned_copy_trust_rejected',
          reason: 'received_topology_mismatch',
        },
      ]);
      for (const diagnostic of diagnostics) {
        expect(Object.keys(diagnostic).sort()).toEqual(['messageType', 'reason']);
      }
    } finally {
      warning.mockRestore();
    }
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
    const setup: TestSession = openTestDbSession();
    const firstConnection: TestSession = openTestDbSession();
    const secondConnection: TestSession = openTestDbSession();
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
        await setup.db
          .delete(mailIngestCandidateAttachmentCleanup)
          .where(eq(mailIngestCandidateAttachmentCleanup.ingestMailboxId, ingestMailboxId));
        await setup.db.delete(mailIngestMailbox).where(eq(mailIngestMailbox.id, ingestMailboxId));
        const remainingMailboxRows = await setup.db
          .select({ id: mailIngestMailbox.id })
          .from(mailIngestMailbox)
          .where(eq(mailIngestMailbox.id, ingestMailboxId));
        expect(remainingMailboxRows).toHaveLength(0);
      }
      await Promise.all([firstConnection.close(), secondConnection.close(), setup.close()]);
    }
  }, 60000);
});
