import { load } from 'cheerio';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/client';
import {
  attachment,
  mailIngestMailbox,
  mailboxTransport,
  mailThread,
  message,
  outboundSendQueue,
} from '../src/db/schema/mail';
import {
  createInlineAttachmentHandler,
  findAuthorizedInlineAttachment,
} from '../src/http/inline-attachment';
import {
  generateMessageId,
  parseRawMessage,
} from '../src/mail/ingest/parse-message';
import { persistInboundMessage } from '../src/mail/ingest/store';
import { BLOCKED_IMAGE_PLACEHOLDER } from '../src/mail/sanitize-email-html';
import {
  FakeS3Storage,
  resetS3Storage,
  setS3Storage,
} from '../src/storage/s3';
import { assertRequiredRocketseedDbReachable } from './helpers/rocketseed-db-gate';
import { callerFor } from './helpers/trpc-caller';
import { readFixture } from './helpers/fixtures';
import {
  TEST_DB_AVAILABLE,
  openTestDbConnection,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';

const OUTBOUND_ID = 'a0b1c2d3-e4f5-4a67-8b90-abcdef123456';
const UNKNOWN_OUTBOUND_ID = '11111111-2222-4333-8444-555555555555';
const TRANSPORT_ID = 'transport-centurion';
const TRANSPORT_EMAIL = 'sender@hotel.example.invalid';
const THREAD_ID = 'thread-rocketseed-original';
const SMTP_MESSAGE_ID = 'smtp-original@example.invalid';
const OLD_ATTACHMENT_KEY = 'attachments/local-original/original.pdf';
const DELIVERED_AT = new Date('2026-07-28T12:34:56.000Z');
const ORIGINAL_SENT_AT = new Date('2026-07-28T12:00:00.000Z');
const ORIGINAL_IN_REPLY_TO = 'parent-original@example.invalid';
const ORIGINAL_REFERENCES = [
  'root-original@example.invalid',
  ORIGINAL_IN_REPLY_TO,
];
const ORIGINAL_CC = ['cc-original@example.invalid'];
const INLINE_ORIGIN = 'https://mail.example.invalid';
const INLINE_ROUTE =
  '/api/mail/messages/:messageId/attachments/:attachmentId/inline';

const reachable = await probeTestDb();
assertRequiredRocketseedDbReachable({
  required: process.env.REQUIRE_ROCKETSEED_DB_TESTS === '1',
  databaseUrlConfigured: TEST_DB_AVAILABLE,
  reachable,
});
const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;

beforeEach(() => {
  process.env.BETTER_AUTH_URL = INLINE_ORIGIN;
});

afterEach(() => {
  if (originalBetterAuthUrl === undefined) {
    delete process.env.BETTER_AUTH_URL;
  } else {
    process.env.BETTER_AUTH_URL = originalBetterAuthUrl;
  }
});

function withFakeS3(): FakeS3Storage {
  const storage = new FakeS3Storage('test-mail-bucket');
  resetS3Storage();
  setS3Storage(storage);
  return storage;
}

function brandedFixture(): Buffer {
  return readFixture('rocketseed-branded-sent-copy.eml');
}

function replaceHeader(raw: Buffer, name: string, value: string | null): Buffer {
  const source = raw.toString('utf8');
  const pattern = new RegExp(`^${name}:.*\\r?$`, 'im');
  const replaced = value === null
    ? source.replace(new RegExp(`^${name}:.*\\r?\\n`, 'im'), '')
    : source.replace(pattern, `${name}: ${value}`);
  return Buffer.from(replaced, 'utf8');
}

function replaceTopReceivedChain(raw: Buffer, receivedLines: string[]): Buffer {
  const source = raw.toString('utf8');
  return Buffer.from(
    source.replace(/^Received:.*\r?\n/im, `${receivedLines.join('\r\n')}\r\n`),
    'utf8',
  );
}

async function configureSyntheticTransport(db: DB): Promise<void> {
  await db
    .update(mailboxTransport)
    .set({
      email: TRANSPORT_EMAIL,
      ownerHeaderValue: TRANSPORT_EMAIL,
      sendFromConfig: { aliases: ['alias@hotel.example.invalid'] },
    })
    .where(eq(mailboxTransport.id, TRANSPORT_ID));
}

async function seedOriginalMessage(
  db: DB,
  opts: {
    id?: string;
    transportId?: string;
    threadId?: string;
    direction?: 'inbound' | 'outbound';
    withAttachment?: boolean;
    queueStatus?: 'sent' | 'pending' | null;
  } = {},
): Promise<void> {
  const transportId = opts.transportId ?? TRANSPORT_ID;
  const threadId = opts.threadId ?? THREAD_ID;
  const id = opts.id ?? OUTBOUND_ID;

  await db.insert(mailThread).values({
    id: threadId,
    transportId,
    threadRootId: `root-${threadId}`,
    subject: 'Local unbranded subject',
    snippet: 'Local unbranded body',
    isArchived: false,
    isStarred: false,
    isRead: true,
    labelIds: [],
    latestMessageAt: new Date('2026-07-28T12:00:00.000Z'),
  });
  await db.insert(message).values({
    id,
    transportId,
    threadId,
    direction: opts.direction ?? 'outbound',
    fromAddress: TRANSPORT_EMAIL,
    toAddresses: ['guest@example.invalid'],
    ccAddresses: ORIGINAL_CC,
    bccAddresses: [TRANSPORT_EMAIL],
    subject: 'Local unbranded subject',
    textBody: 'Local unbranded body',
    htmlBody: '<p>Local unbranded body</p>',
    rawMimeS3Key: 'raw-mime/local-original.eml',
    messageIdHeader: SMTP_MESSAGE_ID,
    inReplyTo: ORIGINAL_IN_REPLY_TO,
    references: ORIGINAL_REFERENCES,
    isRead: true,
    isStarred: true,
    receivedAt: ORIGINAL_SENT_AT,
    sentAt: ORIGINAL_SENT_AT,
  });

  if (opts.queueStatus !== null) {
    await db.insert(outboundSendQueue).values({
      id: `queue-${id}`,
      transportId,
      messageId: id,
      sendAt: ORIGINAL_SENT_AT,
      status: opts.queueStatus ?? 'sent',
      smtpPayload: { synthetic: true },
    });
  }

  if (opts.withAttachment) {
    await db.insert(attachment).values({
      id: 'attachment-local-original',
      messageId: id,
      filename: 'original.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 8,
      s3Key: OLD_ATTACHMENT_KEY,
      contentId: null,
      isInline: false,
    });
  }
}

describe('Rocketseed branded sent-copy parser', () => {
  it('normalizes outbound UUID and preserves branded attachment metadata', async () => {
    const storage = withFakeS3();
    const parsed = await parseRawMessage(brandedFixture(), {
      messageId: generateMessageId(),
      storage,
    });

    expect(parsed.outboundMessageId).toBe(OUTBOUND_ID);
    expect(parsed.htmlBody).toContain('Delivered branded body.');
    expect(parsed.attachments).toHaveLength(3);
    expect(parsed.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filename: 'synthetic-banner.png',
          mimeType: 'image/png',
          contentId: 'image-banner@localhost',
          isInline: true,
        }),
        expect.objectContaining({
          filename: 'synthetic-footer.jpg',
          mimeType: 'image/jpeg',
          contentId: 'image-footer@localhost',
          isInline: true,
        }),
        expect.objectContaining({
          filename: 'synthetic-itinerary.pdf',
          mimeType: 'application/pdf',
          contentId: null,
          isInline: false,
        }),
      ]),
    );
  });

  it.each([
    'not-a-uuid',
    `${OUTBOUND_ID}-suffix`,
    `{${OUTBOUND_ID}}`,
  ])('rejects malformed outbound correlation %s', async (value) => {
    const storage = withFakeS3();
    const raw = replaceHeader(
      brandedFixture(),
      'X-Zero-Outbound-Id',
      value,
    );
    const parsed = await parseRawMessage(raw, {
      messageId: generateMessageId(),
      storage,
    });

    expect(parsed.outboundMessageId).toBeNull();
    expect(
      parsed.rawHeaderLines.some(
        (header) =>
          header.key.toLowerCase() === 'x-zero-outbound-id' &&
          header.line.includes(value),
      ),
    ).toBe(true);
  });
});

describe('ingest replay lock key', () => {
  it('is deterministic and tuple-safe for mailbox plus UIDL', async () => {
    const storeModule = await import('../src/mail/ingest/store');
    const lockKey = (
      storeModule as typeof storeModule & {
        ingestReplayLockKey?: (meta: {
          ingestMailboxId: string;
          pop3Uidl: string;
        }) => string;
      }
    ).ingestReplayLockKey;

    expect(lockKey).toBeTypeOf('function');
    if (!lockKey) return;
    expect(
      lockKey({ ingestMailboxId: 'mailbox:a', pop3Uidl: 'uidl:b' }),
    ).toBe(
      lockKey({ ingestMailboxId: 'mailbox:a', pop3Uidl: 'uidl:b' }),
    );
    expect(
      lockKey({ ingestMailboxId: 'mailbox:a', pop3Uidl: 'uidl:b' }),
    ).not.toBe(
      lockKey({ ingestMailboxId: 'mailbox', pop3Uidl: 'a:uidl:b' }),
    );
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'Rocketseed branded sent-copy reconciliation',
  () => {
    it('replaces delivered content on original outbound row without duplicates', async () => {
      const storage = withFakeS3();
      await storage.putObject({
        key: OLD_ATTACHMENT_KEY,
        body: Buffer.from('old-local-pdf'),
        contentType: 'application/pdf',
      });
      const raw = brandedFixture();
      const incomingParseId = generateMessageId();
      const parsed = await parseRawMessage(raw, {
        messageId: incomingParseId,
        storage,
      });

      const state = await withSeededTestDb(async (db) => {
        await configureSyntheticTransport(db);
        await seedOriginalMessage(db, { withAttachment: true });
        const beforeMessages = await db
          .select({ id: message.id })
          .from(message)
          .where(eq(message.transportId, TRANSPORT_ID));
        const beforeThreads = await db
          .select({ id: mailThread.id })
          .from(mailThread)
          .where(eq(mailThread.transportId, TRANSPORT_ID));

        const result = await persistInboundMessage(
          parsed,
          raw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-rocketseed-reconcile',
            messageId: incomingParseId,
          },
          { db, storage },
        );
        const replay = await persistInboundMessage(
          parsed,
          raw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-rocketseed-reconcile',
            messageId: generateMessageId(),
          },
          { db, storage },
        );

        const [stored] = await db
          .select()
          .from(message)
          .where(
            and(
              eq(message.id, OUTBOUND_ID),
              eq(message.transportId, TRANSPORT_ID),
            ),
          )
          .limit(1);
        const attachmentRows = await db
          .select()
          .from(attachment)
          .where(eq(attachment.messageId, OUTBOUND_ID));
        const incomingRows = await db
          .select({ id: message.id })
          .from(message)
          .where(eq(message.id, incomingParseId));
        const afterMessages = await db
          .select({ id: message.id })
          .from(message)
          .where(eq(message.transportId, TRANSPORT_ID));
        const afterThreads = await db
          .select({ id: mailThread.id })
          .from(mailThread)
          .where(eq(mailThread.transportId, TRANSPORT_ID));
        const caller = await callerFor('user-navaai', {
          db,
          requestedTransportId: TRANSPORT_ID,
        });
        const pdfAttachment = attachmentRows.find(
          (row) => row.mimeType === 'application/pdf',
        );
        expect(pdfAttachment).toBeDefined();
        const fetchPdfThroughFakePath = async () => {
          const originalBucket = process.env.S3_BUCKET;
          const originalRegion = process.env.AWS_REGION;
          delete process.env.S3_BUCKET;
          delete process.env.AWS_REGION;
          try {
            const pdfDownload = await caller.mail.getAttachment({
              messageId: OUTBOUND_ID,
              attachmentId: pdfAttachment!.id,
            });
            const foreignMailbox = await callerFor('user-navaai', {
              db,
              requestedTransportId: 'transport-nava',
            });
            await expect(
              foreignMailbox.mail.getAttachment({
                messageId: OUTBOUND_ID,
                attachmentId: pdfAttachment!.id,
              }),
            ).rejects.toThrow(/NOT_FOUND/);
            return pdfDownload;
          } finally {
            if (originalBucket === undefined) {
              delete process.env.S3_BUCKET;
            } else {
              process.env.S3_BUCKET = originalBucket;
            }
            if (originalRegion === undefined) {
              delete process.env.AWS_REGION;
            } else {
              process.env.AWS_REGION = originalRegion;
            }
          }
        };
        const pdfDownload = await fetchPdfThroughFakePath();
        const projectedThread = await caller.mail.get({ id: THREAD_ID });
        const projection = await caller.mail.processEmailContent({
          messageId: OUTBOUND_ID,
          html: stored?.htmlBody ?? '',
          shouldLoadImages: false,
          theme: 'light',
        });
        const $ = load(projection.processedHtml, null, false);
        const inlineRoutes = $('img[alt^="Synthetic Rocketseed"]')
          .map((_index, node) => $(node).attr('src'))
          .get();
        const app = new Hono();
        app.get(
          INLINE_ROUTE,
          createInlineAttachmentHandler({
            auth: {
              getSession: async (headers) => {
                const userId = headers.get('x-synthetic-user');
                return userId ? { user: { id: userId } } : null;
              },
            },
            db: {
              findAuthorizedAttachment: (input) =>
                findAuthorizedInlineAttachment(db, input),
            },
            storage,
          }),
        );

        for (const route of inlineRoutes) {
          const response = await app.request(route, {
            headers: { 'x-synthetic-user': 'user-navaai' },
          });
          const attachmentId = decodeURIComponent(
            new URL(route).pathname.split('/').at(-2) ?? '',
          );
          const storedAttachment = attachmentRows.find(
            (row) => row.id === attachmentId,
          );
          expect(response.status).toBe(200);
          expect(Buffer.from(await response.arrayBuffer())).toEqual(
            storage.stored.get(storedAttachment!.s3Key)?.body,
          );
        }
        const unauthorized = await app.request(inlineRoutes[0]!, {
          headers: { 'x-synthetic-user': 'user-foreign-mailbox' },
        });

        return {
          result,
          replay,
          stored,
          attachmentRows,
          incomingRows,
          beforeMessageCount: beforeMessages.length,
          afterMessageCount: afterMessages.length,
          beforeThreadCount: beforeThreads.length,
          afterThreadCount: afterThreads.length,
          pdfAttachment,
          pdfDownload,
          projectedThread,
          projection,
          inlineRoutes,
          unauthorizedStatus: unauthorized.status,
        };
      });

      expect(state.result).toMatchObject({
        kind: 'stored',
        transportId: TRANSPORT_ID,
        messageId: OUTBOUND_ID,
        threadId: THREAD_ID,
        attachmentCount: 3,
      });
      expect(state.replay).toMatchObject({
        kind: 'duplicate',
        transportId: TRANSPORT_ID,
        messageId: OUTBOUND_ID,
      });
      expect(state.incomingRows).toHaveLength(0);
      expect(state.afterMessageCount).toBe(state.beforeMessageCount);
      expect(state.afterThreadCount).toBe(state.beforeThreadCount);
      expect(state.stored).toMatchObject({
        id: OUTBOUND_ID,
        threadId: THREAD_ID,
        direction: 'outbound',
        ingestMailboxId: 'ingest-nava-legacy',
        pop3Uidl: 'uidl-rocketseed-reconcile',
        ownerHeaderValue: TRANSPORT_EMAIL,
        messageIdHeader: SMTP_MESSAGE_ID,
        inReplyTo: ORIGINAL_IN_REPLY_TO,
        references: ORIGINAL_REFERENCES,
        fromAddress: TRANSPORT_EMAIL,
        toAddresses: ['guest@example.invalid'],
        ccAddresses: ORIGINAL_CC,
        bccAddresses: [TRANSPORT_EMAIL],
        subject: 'Local unbranded subject',
        textBody: 'Delivered branded body.',
        rawMimeS3Key:
          'raw-mime/ingest-nava-legacy/uidl-rocketseed-reconcile.eml',
        isRead: true,
        isStarred: true,
      });
      expect(state.stored?.htmlBody).toContain('Delivered branded body.');
      expect(state.stored?.receivedAt).toEqual(DELIVERED_AT);
      expect(state.stored?.sentAt).toEqual(ORIGINAL_SENT_AT);
      expect(state.attachmentRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filename: 'synthetic-banner.png',
            mimeType: 'image/png',
            contentId: 'image-banner@localhost',
            isInline: true,
          }),
          expect.objectContaining({
            filename: 'synthetic-footer.jpg',
            mimeType: 'image/jpeg',
            contentId: 'image-footer@localhost',
            isInline: true,
          }),
          expect.objectContaining({
            filename: 'synthetic-itinerary.pdf',
            mimeType: 'application/pdf',
            contentId: null,
            isInline: false,
          }),
        ]),
      );
      expect(
        state.attachmentRows.some(
          (row) => row.s3Key === OLD_ATTACHMENT_KEY,
        ),
      ).toBe(false);
      expect(storage.stored.has(OLD_ATTACHMENT_KEY)).toBe(true);
      expect(state.projectedThread.id).toBe(THREAD_ID);
      expect(state.projectedThread.messages).toHaveLength(1);
      expect(state.projectedThread.messages[0]?.id).toBe(OUTBOUND_ID);
      expect(state.pdfDownload).toMatchObject({
        attachmentId: state.pdfAttachment!.id,
        filename: 'synthetic-itinerary.pdf',
        mimeType: 'application/pdf',
        size: state.pdfAttachment!.sizeBytes,
      });
      expect(state.pdfDownload.size).toBeGreaterThan(0);
      expect(state.pdfDownload.url).toMatch(
        /^zero-fake-s3:\/\/fake-mail-bucket\//,
      );
      expect(state.pdfDownload.url).toContain(
        'filename=synthetic-itinerary.pdf',
      );
      expect(state.pdfDownload.url).toContain('mime=application%2Fpdf');
      expect(
        state.projectedThread.messages[0]?.attachments?.map(
          (item) => item.filename,
        ),
      ).toContain('synthetic-itinerary.pdf');
      expect(state.inlineRoutes).toHaveLength(2);
      expect(
        state.inlineRoutes.every((route) =>
          route.startsWith(`${INLINE_ORIGIN}/api/mail/messages/`),
        ),
      ).toBe(true);
      expect(state.projection.processedHtml).not.toMatch(/\bcid:/i);
      expect(state.projection.processedHtml).not.toContain(
        'tracker.example.invalid',
      );
      expect(state.projection.processedHtml).toContain(BLOCKED_IMAGE_PLACEHOLDER);
      expect(state.unauthorizedStatus).toBe(404);
    }, 30000);

    it.each([
      ['absent', null],
      ['pending', 'pending'],
    ] as const)(
      'stores trusted self-copy separately when queue evidence is %s',
      async (label, queueStatus) => {
        const storage = withFakeS3();
        const raw = brandedFixture();
        const incomingParseId = generateMessageId();
        const parsed = await parseRawMessage(raw, {
          messageId: incomingParseId,
          storage,
        });

        const state = await withSeededTestDb(async (db) => {
          await configureSyntheticTransport(db);
          await seedOriginalMessage(db, { queueStatus });
          const result = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: `uidl-rocketseed-queue-${label}`,
              messageId: incomingParseId,
            },
            { db, storage },
          );
          const [original] = await db
            .select()
            .from(message)
            .where(eq(message.id, OUTBOUND_ID))
            .limit(1);
          const [incoming] = await db
            .select()
            .from(message)
            .where(eq(message.id, incomingParseId))
            .limit(1);
          return { result, original, incoming };
        });

        expect(state.result).toMatchObject({
          kind: 'stored',
          messageId: incomingParseId,
        });
        expect(state.original).toMatchObject({
          htmlBody: '<p>Local unbranded body</p>',
          ingestMailboxId: null,
          pop3Uidl: null,
        });
        expect(state.incoming?.id).toBe(incomingParseId);
      },
      30000,
    );

    it('stores forged-chain self-copy separately when trusted IP is only lower Received', async () => {
      const storage = withFakeS3();
      const raw = replaceTopReceivedChain(brandedFixture(), [
        'Received: from attacker.example.invalid ([203.0.113.9]) by ingest.example.invalid',
        'Received: from synthetic-rocketseed.example.invalid ([172.24.0.8]) by attacker.example.invalid',
      ]);
      const incomingParseId = generateMessageId();
      const parsed = await parseRawMessage(raw, {
        messageId: incomingParseId,
        storage,
      });

      const state = await withSeededTestDb(async (db) => {
        await configureSyntheticTransport(db);
        await seedOriginalMessage(db);
        const result = await persistInboundMessage(
          parsed,
          raw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-rocketseed-forged-chain',
            messageId: incomingParseId,
          },
          { db, storage },
        );
        const [original] = await db
          .select()
          .from(message)
          .where(eq(message.id, OUTBOUND_ID))
          .limit(1);
        const [incoming] = await db
          .select()
          .from(message)
          .where(eq(message.id, incomingParseId))
          .limit(1);
        return { result, original, incoming };
      });

      expect(state.result).toMatchObject({
        kind: 'stored',
        messageId: incomingParseId,
      });
      expect(state.original).toMatchObject({
        htmlBody: '<p>Local unbranded body</p>',
        ingestMailboxId: null,
        pop3Uidl: null,
      });
      expect(state.incoming?.id).toBe(incomingParseId);
    }, 30000);

    it('allows only one distinct-UIDL contender to reconcile attachments', async () => {
      const storage = withFakeS3();
      const runId = randomUUID();
      const outboundId = randomUUID();
      const transportId = `transport-rocketseed-${runId}`;
      const ingestMailboxId = `ingest-rocketseed-${runId}`;
      const threadId = `thread-rocketseed-${runId}`;
      const transportEmail = `sender-${runId}@hotel.example.invalid`;
      const pop3Uidls = [
        `uidl-rocketseed-${runId}-a`,
        `uidl-rocketseed-${runId}-b`,
      ];
      const raw = Buffer.from(
        brandedFixture()
          .toString('utf8')
          .replaceAll(TRANSPORT_EMAIL, transportEmail)
          .replace(OUTBOUND_ID, outboundId),
        'utf8',
      );
      const parseIds = [generateMessageId(), generateMessageId()];
      const parsedMessages = await Promise.all(
        parseIds.map((messageId) =>
          parseRawMessage(raw, { messageId, storage }),
        ),
      );
      const first = openTestDbConnection();
      const second = openTestDbConnection();

      try {
        await first.db.insert(mailIngestMailbox).values({
          id: ingestMailboxId,
          email: `sink-${runId}@example.invalid`,
          description: 'Synthetic concurrent replay mailbox',
          isActive: true,
        });
        await first.db.insert(mailboxTransport).values({
          id: transportId,
          email: transportEmail,
          ownerHeaderValue: transportEmail,
          displayName: 'Synthetic concurrent transport',
          isActive: true,
          sendFromConfig: { aliases: [] },
        });
        await first.db.insert(mailThread).values({
          id: threadId,
          transportId,
          threadRootId: `root-${runId}`,
          subject: 'Local unbranded subject',
          snippet: 'Local unbranded body',
          isArchived: false,
          isStarred: false,
          isRead: true,
          labelIds: [],
          latestMessageAt: new Date('2026-07-28T12:00:00.000Z'),
        });
        await first.db.insert(message).values({
          id: outboundId,
          transportId,
          threadId,
          direction: 'outbound',
          fromAddress: transportEmail,
          toAddresses: ['guest@example.invalid'],
          ccAddresses: [],
          bccAddresses: [transportEmail],
          subject: 'Local unbranded subject',
          textBody: 'Local unbranded body',
          htmlBody: '<p>Local unbranded body</p>',
          rawMimeS3Key: 'raw-mime/local-concurrent-original.eml',
          messageIdHeader: `smtp-${runId}@example.invalid`,
          references: [],
          isRead: true,
          isStarred: false,
          receivedAt: new Date('2026-07-28T12:00:00.000Z'),
          sentAt: new Date('2026-07-28T12:00:00.000Z'),
        });
        await first.db.insert(outboundSendQueue).values({
          id: `queue-rocketseed-${runId}`,
          transportId,
          messageId: outboundId,
          sendAt: new Date('2026-07-28T12:00:00.000Z'),
          status: 'sent',
          smtpPayload: { synthetic: true },
        });
        await first.db.insert(attachment).values({
          id: `attachment-rocketseed-${runId}`,
          messageId: outboundId,
          filename: 'local-original.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 8,
          s3Key: `attachments/local-${runId}/original.pdf`,
          contentId: null,
          isInline: false,
        });

        const calls = [
          persistInboundMessage(
            parsedMessages[0]!,
            raw,
            {
              ingestMailboxId,
              pop3Uidl: pop3Uidls[0]!,
              messageId: parseIds[0]!,
            },
            { db: first.db, storage },
          ),
          persistInboundMessage(
            parsedMessages[1]!,
            raw,
            {
              ingestMailboxId,
              pop3Uidl: pop3Uidls[1]!,
              messageId: parseIds[1]!,
            },
            { db: second.db, storage },
          ),
        ];
        const settled = await Promise.allSettled(calls);
        const rejected = settled.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        );
        if (rejected) throw rejected.reason;
        const results = settled.map(
          (result) =>
            (result as PromiseFulfilledResult<Awaited<(typeof calls)[number]>>)
              .value,
        );

        const finalMessages = await first.db
          .select()
          .from(message)
          .where(eq(message.transportId, transportId));
        const finalThreads = await first.db
          .select()
          .from(mailThread)
          .where(eq(mailThread.transportId, transportId));
        const finalAttachments = await first.db
          .select()
          .from(attachment)
          .where(eq(attachment.messageId, outboundId));
        const winnerIndex = results.findIndex(
          (result) => result.kind === 'stored',
        );

        expect(results.map((result) => result.kind).sort()).toEqual([
          'duplicate',
          'stored',
        ]);
        expect(results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'stored',
              messageId: outboundId,
              threadId,
              attachmentCount: 3,
            }),
            expect.objectContaining({
              kind: 'duplicate',
              messageId: outboundId,
            }),
          ]),
        );
        expect(finalMessages).toHaveLength(1);
        expect(finalMessages[0]).toMatchObject({
          id: outboundId,
          threadId,
          ingestMailboxId,
        });
        expect(pop3Uidls).toContain(finalMessages[0]?.pop3Uidl);
        expect(finalThreads).toHaveLength(1);
        expect(finalAttachments).toHaveLength(3);
        expect(
          finalAttachments.map((row) => row.filename).sort(),
        ).toEqual([
          'synthetic-banner.png',
          'synthetic-footer.jpg',
          'synthetic-itinerary.pdf',
        ]);
        expect(winnerIndex).toBeGreaterThanOrEqual(0);
        expect(
          finalAttachments.every((row) =>
            row.s3Key.startsWith(`attachments/${parseIds[winnerIndex]}/`),
          ),
        ).toBe(true);
      } finally {
        await first.db
          .delete(mailboxTransport)
          .where(eq(mailboxTransport.id, transportId));
        await first.db
          .delete(mailIngestMailbox)
          .where(eq(mailIngestMailbox.id, ingestMailboxId));
        await Promise.all([first.close(), second.close()]);
      }
    }, 60000);

    it('falls back to exact Message-ID only when correlation header is absent', async () => {
      const storage = withFakeS3();
      let raw = replaceHeader(
        brandedFixture(),
        'X-Zero-Outbound-Id',
        null,
      );
      raw = replaceHeader(raw, 'Message-ID', `<${SMTP_MESSAGE_ID}>`);
      const incomingParseId = generateMessageId();
      const parsed = await parseRawMessage(raw, {
        messageId: incomingParseId,
        storage,
      });

      const state = await withSeededTestDb(async (db) => {
        await configureSyntheticTransport(db);
        await seedOriginalMessage(db);
        const result = await persistInboundMessage(
          parsed,
          raw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-rocketseed-message-id-fallback',
            messageId: incomingParseId,
          },
          { db, storage },
        );
        const [stored] = await db
          .select()
          .from(message)
          .where(eq(message.id, OUTBOUND_ID))
          .limit(1);
        return { result, stored };
      });

      expect(parsed.outboundMessageId).toBeNull();
      expect(state.result).toMatchObject({
        kind: 'stored',
        messageId: OUTBOUND_ID,
        threadId: THREAD_ID,
      });
      expect(state.stored?.htmlBody).toContain('Delivered branded body.');
    }, 30000);

    it.each([
      ['malformed', 'not-a-uuid'],
      ['unknown', UNKNOWN_OUTBOUND_ID],
    ])(
      'does not overwrite via %s correlation or fall back to Message-ID',
      async (_label, outboundHeader) => {
        const storage = withFakeS3();
        let raw = replaceHeader(
          brandedFixture(),
          'X-Zero-Outbound-Id',
          outboundHeader,
        );
        raw = replaceHeader(raw, 'Message-ID', `<${SMTP_MESSAGE_ID}>`);
        const incomingParseId = generateMessageId();
        const parsed = await parseRawMessage(raw, {
          messageId: incomingParseId,
          storage,
        });

        const state = await withSeededTestDb(async (db) => {
          await configureSyntheticTransport(db);
          await seedOriginalMessage(db);
          const result = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: `uidl-rocketseed-${_label}`,
              messageId: incomingParseId,
            },
            { db, storage },
          );
          const [original] = await db
            .select()
            .from(message)
            .where(eq(message.id, OUTBOUND_ID))
            .limit(1);
          return { result, original };
        });

        expect(state.result).toMatchObject({
          kind: 'stored',
          messageId: incomingParseId,
        });
        expect(state.original?.htmlBody).toBe(
          '<p>Local unbranded body</p>',
        );
        expect(state.original?.pop3Uidl).toBeNull();
      },
      30000,
    );

    it('does not overwrite matching correlation on another transport', async () => {
      const storage = withFakeS3();
      const raw = brandedFixture();
      const incomingParseId = generateMessageId();
      const parsed = await parseRawMessage(raw, {
        messageId: incomingParseId,
        storage,
      });

      const state = await withSeededTestDb(async (db) => {
        await configureSyntheticTransport(db);
        await seedOriginalMessage(db, {
          transportId: 'transport-nava',
          threadId: 'thread-rocketseed-other-transport',
        });
        const result = await persistInboundMessage(
          parsed,
          raw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-rocketseed-cross-transport',
            messageId: incomingParseId,
          },
          { db, storage },
        );
        const [otherTransport] = await db
          .select()
          .from(message)
          .where(
            and(
              eq(message.id, OUTBOUND_ID),
              eq(message.transportId, 'transport-nava'),
            ),
          )
          .limit(1);
        return { result, otherTransport };
      });

      expect(state.result).toMatchObject({
        kind: 'stored',
        transportId: TRANSPORT_ID,
        messageId: incomingParseId,
      });
      expect(state.otherTransport?.htmlBody).toBe(
        '<p>Local unbranded body</p>',
      );
      expect(state.otherTransport?.pop3Uidl).toBeNull();
    }, 30000);

    it('does not overwrite matching correlation on an inbound row', async () => {
      const storage = withFakeS3();
      const raw = brandedFixture();
      const incomingParseId = generateMessageId();
      const parsed = await parseRawMessage(raw, {
        messageId: incomingParseId,
        storage,
      });

      const state = await withSeededTestDb(async (db) => {
        await configureSyntheticTransport(db);
        await seedOriginalMessage(db, { direction: 'inbound' });
        const result = await persistInboundMessage(
          parsed,
          raw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-rocketseed-wrong-direction',
            messageId: incomingParseId,
          },
          { db, storage },
        );
        const [original] = await db
          .select()
          .from(message)
          .where(eq(message.id, OUTBOUND_ID))
          .limit(1);
        return { result, original };
      });

      expect(state.result).toMatchObject({
        kind: 'stored',
        messageId: incomingParseId,
      });
      expect(state.original?.direction).toBe('inbound');
      expect(state.original?.htmlBody).toBe(
        '<p>Local unbranded body</p>',
      );
    }, 30000);

    it('does not trust matching correlation from a non-transport sender', async () => {
      const storage = withFakeS3();
      const raw = Buffer.from(
        brandedFixture()
          .toString('utf8')
          .replace(
            'From: Synthetic Front Desk <sender@hotel.example.invalid>',
            'From: Synthetic Outsider <outsider@example.invalid>',
          ),
        'utf8',
      );
      const incomingParseId = generateMessageId();
      const parsed = await parseRawMessage(raw, {
        messageId: incomingParseId,
        storage,
      });

      const state = await withSeededTestDb(async (db) => {
        await configureSyntheticTransport(db);
        await seedOriginalMessage(db);
        const result = await persistInboundMessage(
          parsed,
          raw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-rocketseed-sender-mismatch',
            messageId: incomingParseId,
          },
          { db, storage },
        );
        const [original] = await db
          .select()
          .from(message)
          .where(eq(message.id, OUTBOUND_ID))
          .limit(1);
        return { result, original };
      });

      expect(state.result).toMatchObject({
        kind: 'stored',
        messageId: incomingParseId,
      });
      expect(state.original?.htmlBody).toBe(
        '<p>Local unbranded body</p>',
      );
      expect(state.original?.pop3Uidl).toBeNull();
    }, 30000);
  },
);
