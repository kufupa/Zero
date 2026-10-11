import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mailThread, message } from '../src/db/schema/mail.js';
import {
  type ParsedInboundMessage,
  parseRawMessage,
  generateMessageId,
} from '../src/mail/ingest/parse-message.js';
import { persistInboundMessage } from '../src/mail/ingest/store.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { readFixture } from './helpers/fixtures';
import {
  NAVA_TRANSPORT_EMAIL,
  NAVA_TRANSPORT_ID,
  TRANSPORT_EMAIL,
  TRANSPORT_ID,
} from '../src/db/seed.js';

const reachable = await probeTestDb();

function withFakeS3(): FakeS3Storage {
  const fake = new FakeS3Storage('test-mail-bucket');
  resetS3Storage();
  setS3Storage(fake);
  return fake;
}

function minimalParsed(
  overrides: Partial<ParsedInboundMessage> & { messageId: string },
): ParsedInboundMessage {
  return {
    ownerHeaderValue: TRANSPORT_EMAIL,
    outboundCorrelation: { kind: 'absent' },
    messageId: overrides.messageId,
    inReplyTo: overrides.inReplyTo ?? null,
    references: overrides.references ?? [],
    fromAddress: overrides.fromAddress ?? 'guest@example.com',
    toAddresses: overrides.toAddresses ?? [TRANSPORT_EMAIL],
    ccAddresses: overrides.ccAddresses ?? [],
    bccAddresses: overrides.bccAddresses ?? [],
    subject: overrides.subject ?? 'Thread join test',
    textBody: overrides.textBody ?? 'Thread join body',
    htmlBody: overrides.htmlBody ?? null,
    receivedAt: overrides.receivedAt ?? new Date('2026-07-02T12:00:00.000Z'),
    deliveredAt: overrides.deliveredAt ?? null,
    attachments: overrides.attachments ?? [],
    rawHeaderLines: overrides.rawHeaderLines ?? [],
    ...overrides,
  };
}

async function seedThreadMessage(
  db: import('../src/db/client.js').DB,
  args: {
    threadId: string;
    messageId: string;
    messageIdHeader: string;
    transportId: string;
    transportEmail: string;
    createdAt?: Date;
  },
): Promise<void> {
  const now = args.createdAt ?? new Date('2026-07-01T10:00:00.000Z');
  await db
    .insert(mailThread)
    .values({
      id: args.threadId,
      transportId: args.transportId,
      threadRootId: `root-${args.threadId}`,
      subject: 'Seeded thread',
      snippet: 'Seeded thread',
      isArchived: false,
      isStarred: false,
      isRead: false,
      labelIds: [],
      latestMessageAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: mailThread.id });

  await db.insert(message).values({
    id: args.messageId,
    transportId: args.transportId,
    threadId: args.threadId,
    direction: 'inbound',
    fromAddress: 'guest@example.com',
    toAddresses: [args.transportEmail],
    ccAddresses: [],
    bccAddresses: [],
    subject: 'Seeded thread',
    textBody: 'Seeded body',
    ownerHeaderValue: args.transportEmail,
    messageIdHeader: args.messageIdHeader,
    references: [],
    isRead: false,
    isStarred: false,
    receivedAt: now,
    createdAt: args.createdAt ?? now,
    updatedAt: args.createdAt ?? now,
  });
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('thread join (ingest)', () => {
  it(
    'reply joins parent thread via In-Reply-To and updates thread metadata',
    async () => {
      const storage = withFakeS3();
      const parentRaw = readFixture('centurion-stamped.eml');
      const replyRaw = readFixture('reply-in-thread.eml');

      const result = await withSeededTestDb(async (db) => {
        const parentMessageId = generateMessageId();
        const parentParsed = await parseRawMessage(parentRaw, {
          messageId: parentMessageId,
          storage,
        });
        const parentResult = await persistInboundMessage(
          parentParsed,
          parentRaw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-thread-parent',
            messageId: parentMessageId,
          },
          { db, storage },
        );
        expect(parentResult.kind).toBe('stored');
        if (parentResult.kind !== 'stored') return null;

        await db
          .update(mailThread)
          .set({ isRead: true })
          .where(eq(mailThread.id, parentResult.threadId));

        const replyMessageId = generateMessageId();
        const replyParsed = await parseRawMessage(replyRaw, {
          messageId: replyMessageId,
          storage,
        });
        expect(replyParsed.inReplyTo).toBe('centurion-001@legacyhotel.com');
        expect(replyParsed.references).toEqual(['centurion-001@legacyhotel.com']);

        const replyResult = await persistInboundMessage(
          replyParsed,
          replyRaw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-thread-reply',
            messageId: replyMessageId,
          },
          { db, storage },
        );
        expect(replyResult.kind).toBe('stored');
        if (replyResult.kind !== 'stored') return null;

        const threadRows = await db
          .select()
          .from(mailThread)
          .where(eq(mailThread.id, parentResult.threadId));
        const msgRows = await db
          .select()
          .from(message)
          .where(eq(message.threadId, parentResult.threadId));

        return {
          parentResult,
          replyResult,
          thread: threadRows[0],
          messages: msgRows,
        };
      });

      expect(result).not.toBeNull();
      if (!result) return;

      expect(result.replyResult.threadId).toBe(result.parentResult.threadId);
      expect(result.messages.length).toBe(2);
      expect(result.thread).toBeDefined();
      expect(result.thread!.isRead).toBe(false);
      expect(result.thread!.snippet).toContain('Welcome amenities');
      expect(result.thread!.latestMessageAt?.toISOString()).toBe(
        '2026-07-01T10:00:00.000Z',
      );
    },
    30000,
  );

  it(
    'multi-ref chain joins newest parent thread when root and mid both exist',
    async () => {
      const storage = withFakeS3();
      const rootHeader = 'root@chain.test';
      const midHeader = 'mid@chain.test';

      const result = await withSeededTestDb(async (db) => {
        await seedThreadMessage(db, {
          threadId: 'thread-chain-root',
          messageId: 'msg-chain-root',
          messageIdHeader: rootHeader,
          transportId: TRANSPORT_ID,
          transportEmail: TRANSPORT_EMAIL,
        });
        await seedThreadMessage(db, {
          threadId: 'thread-chain-mid',
          messageId: 'msg-chain-mid',
          messageIdHeader: midHeader,
          transportId: TRANSPORT_ID,
          transportEmail: TRANSPORT_EMAIL,
        });

        const replyMessageId = generateMessageId();
        const parsed = minimalParsed({
          messageId: 'reply@chain.test',
          inReplyTo: midHeader,
          references: [rootHeader, midHeader],
        });
        const replyResult = await persistInboundMessage(
          parsed,
          Buffer.from('reply body'),
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-chain-reply',
            messageId: replyMessageId,
          },
          { db, storage },
        );
        return replyResult;
      });

      expect(result?.kind).toBe('stored');
      if (!result || result.kind !== 'stored') return;
      expect(result.threadId).toBe('thread-chain-mid');
    },
    30000,
  );

  it(
    'does not join parent on another transport with the same Message-ID',
    async () => {
      const storage = withFakeS3();
      const sharedHeader = 'shared@iso.test';

      const result = await withSeededTestDb(async (db) => {
        await seedThreadMessage(db, {
          threadId: 'thread-iso-centurion',
          messageId: 'msg-iso-centurion',
          messageIdHeader: sharedHeader,
          transportId: TRANSPORT_ID,
          transportEmail: TRANSPORT_EMAIL,
        });
        await seedThreadMessage(db, {
          threadId: 'thread-iso-nava',
          messageId: 'msg-iso-nava',
          messageIdHeader: sharedHeader,
          transportId: NAVA_TRANSPORT_ID,
          transportEmail: NAVA_TRANSPORT_EMAIL,
        });

        const replyMessageId = generateMessageId();
        const parsed = minimalParsed({
          messageId: 'reply@iso.test',
          inReplyTo: sharedHeader,
          references: [sharedHeader],
        });
        const replyResult = await persistInboundMessage(
          parsed,
          Buffer.from('iso reply'),
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-iso-reply',
            messageId: replyMessageId,
          },
          { db, storage },
        );
        return replyResult;
      });

      expect(result?.kind).toBe('stored');
      if (!result || result.kind !== 'stored') return;
      expect(result.threadId).toBe('thread-iso-centurion');
      expect(result.threadId).not.toBe('thread-iso-nava');
    },
    30000,
  );

  it(
    'duplicate Message-ID on same transport ties to oldest created message',
    async () => {
      const storage = withFakeS3();
      const dupHeader = 'dup@tie.test';
      const olderAt = new Date('2026-07-01T08:00:00.000Z');
      const newerAt = new Date('2026-07-01T09:00:00.000Z');

      const result = await withSeededTestDb(async (db) => {
        await seedThreadMessage(db, {
          threadId: 'thread-tie-old',
          messageId: 'msg-tie-old',
          messageIdHeader: dupHeader,
          transportId: TRANSPORT_ID,
          transportEmail: TRANSPORT_EMAIL,
          createdAt: olderAt,
        });
        await seedThreadMessage(db, {
          threadId: 'thread-tie-new',
          messageId: 'msg-tie-new',
          messageIdHeader: dupHeader,
          transportId: TRANSPORT_ID,
          transportEmail: TRANSPORT_EMAIL,
          createdAt: newerAt,
        });

        const replyMessageId = generateMessageId();
        const parsed = minimalParsed({
          messageId: 'reply@tie.test',
          inReplyTo: dupHeader,
          references: [dupHeader],
        });
        const replyResult = await persistInboundMessage(
          parsed,
          Buffer.from('tie reply'),
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-tie-reply',
            messageId: replyMessageId,
          },
          { db, storage },
        );
        return replyResult;
      });

      expect(result?.kind).toBe('stored');
      if (!result || result.kind !== 'stored') return;
      expect(result.threadId).toBe('thread-tie-old');
    },
    30000,
  );

  it(
    'canonicalizes messageIdHeader, inReplyTo, and references on persist',
    async () => {
      const storage = withFakeS3();
      const parentHeader = 'parent@canon.test';

      await withSeededTestDb(async (db) => {
        await seedThreadMessage(db, {
          threadId: 'thread-canon-parent',
          messageId: 'msg-canon-parent',
          messageIdHeader: parentHeader,
          transportId: TRANSPORT_ID,
          transportEmail: TRANSPORT_EMAIL,
        });

        const replyMessageId = generateMessageId();
        const parsed = minimalParsed({
          messageId: '<REPLY@Canon.TEST>',
          inReplyTo: `<${parentHeader}>`,
          references: [`<${parentHeader}>`, '<OTHER@Canon.TEST>'],
        });
        const replyResult = await persistInboundMessage(
          parsed,
          Buffer.from('canon reply'),
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-canon-reply',
            messageId: replyMessageId,
          },
          { db, storage },
        );
        expect(replyResult.kind).toBe('stored');
        if (replyResult.kind !== 'stored') return;

        const rows = await db
          .select({
            messageIdHeader: message.messageIdHeader,
            inReplyTo: message.inReplyTo,
            references: message.references,
          })
          .from(message)
          .where(eq(message.id, replyMessageId));
        expect(rows[0]).toEqual({
          messageIdHeader: 'reply@canon.test',
          inReplyTo: parentHeader,
          references: [parentHeader, 'other@canon.test'],
        });
      });
    },
    30000,
  );
});

describe('parseRawMessage date + references (no DB)', () => {
  it('receivedAt comes from Date header, not ingest time', async () => {
    const storage = withFakeS3();
    const raw = readFixture('centurion-stamped.eml');
    const before = Date.now();
    const parsed = await parseRawMessage(raw, {
      messageId: generateMessageId(),
      storage,
    });
    const after = Date.now();

    expect(parsed.receivedAt).not.toBeNull();
    expect(parsed.receivedAt!.toISOString()).toBe('2026-06-30T09:14:00.000Z');
    expect(parsed.receivedAt!.getTime()).toBeLessThan(before);
    expect(parsed.receivedAt!.getTime()).toBeLessThan(after);
  });

  it('strips angle brackets from References entries', async () => {
    const storage = withFakeS3();
    const raw = readFixture('reply-in-thread.eml');
    const parsed = await parseRawMessage(raw, {
      messageId: generateMessageId(),
      storage,
    });
    expect(parsed.references).toEqual(['centurion-001@legacyhotel.com']);
    expect(parsed.references.every((r) => !r.includes('<'))).toBe(true);
  });
});
