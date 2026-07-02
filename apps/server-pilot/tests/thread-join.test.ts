import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mailThread, message } from '../src/db/schema/mail.js';
import { parseRawMessage, generateMessageId } from '../src/mail/ingest/parse-message.js';
import { persistInboundMessage } from '../src/mail/ingest/store.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { readFixture } from './helpers/fixtures';

const reachable = await probeTestDb();

function withFakeS3(): FakeS3Storage {
  const fake = new FakeS3Storage('test-mail-bucket');
  resetS3Storage();
  setS3Storage(fake);
  return fake;
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
