/**
 * mail.emptySpam — soft-trash all spam_at threads for active transport.
 */
import { describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { mailThread } from '../src/db/schema/mail.js';
import { mailRouter } from '../src/trpc/routes/mail.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';
import { seedInboxThread } from './helpers/seed-inbox-thread';

const reachable = await probeTestDb();

const TRANSPORT_ID = 'transport-centurion';
const TRANSPORT_EMAIL = 'centurion@legacyhotel.com';
const SPAM_THREAD_1 = 'empty-spam-thread-1';
const SPAM_THREAD_2 = 'empty-spam-thread-2';

async function seedSpamThread(
  db: import('../src/db/client.js').DB,
  threadId: string,
) {
  await seedInboxThread(db, {
    threadId,
    transportId: TRANSPORT_ID,
    transportEmail: TRANSPORT_EMAIL,
    threadRootId: `root-${threadId}`,
    subject: `Spam ${threadId}`,
    snippet: `Spam fixture ${threadId}`,
    messageId: `msg-${threadId}`,
    messageIdHeader: `${threadId}@example.com`,
  });
  await db
    .update(mailThread)
    .set({ spamAt: new Date(), trashedAt: null, isArchived: false })
    .where(and(eq(mailThread.id, threadId), eq(mailThread.transportId, TRANSPORT_ID)));
}

describe('mail.emptySpam contract', () => {
  it('registers emptySpam on mail router', () => {
    expect(mailRouter._def.procedures.emptySpam).toBeDefined();
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('mail.emptySpam (seeded)', () => {
  it('moves all spam threads to bin and clears spam list', async () => {
    await withSeededTestDb(async (db) => {
      await seedSpamThread(db, SPAM_THREAD_1);
      await seedSpamThread(db, SPAM_THREAD_2);

      const caller = await callerFor('user-navaai', { db, requestedTransportId: TRANSPORT_ID });

      const spamBefore = await caller.mail.listThreads({ folder: 'spam', limit: 50 });
      expect(spamBefore.threads.map((t) => t.id)).toEqual(
        expect.arrayContaining([SPAM_THREAD_1, SPAM_THREAD_2]),
      );

      const result = await caller.mail.emptySpam();
      expect(result.updated).toBe(2);

      const spamAfter = await caller.mail.listThreads({ folder: 'spam', limit: 50 });
      expect(spamAfter.threads.map((t) => t.id)).not.toContain(SPAM_THREAD_1);
      expect(spamAfter.threads.map((t) => t.id)).not.toContain(SPAM_THREAD_2);

      const bin = await caller.mail.listThreads({ folder: 'bin', limit: 50 });
      expect(bin.threads.map((t) => t.id)).toEqual(
        expect.arrayContaining([SPAM_THREAD_1, SPAM_THREAD_2]),
      );

      const rows = await db
        .select({
          spamAt: mailThread.spamAt,
          trashedAt: mailThread.trashedAt,
          isArchived: mailThread.isArchived,
        })
        .from(mailThread)
        .where(
          and(
            eq(mailThread.transportId, TRANSPORT_ID),
            inArray(mailThread.id, [SPAM_THREAD_1, SPAM_THREAD_2]),
          ),
        );

      for (const row of rows) {
        expect(row.spamAt).toBeNull();
        expect(row.trashedAt).not.toBeNull();
        expect(row.isArchived).toBe(false);
      }
    });
  });

  it('skips threads already in bin', async () => {
    await withSeededTestDb(async (db) => {
      await seedSpamThread(db, SPAM_THREAD_1);
      await db
        .update(mailThread)
        .set({ trashedAt: new Date() })
        .where(and(eq(mailThread.id, SPAM_THREAD_1), eq(mailThread.transportId, TRANSPORT_ID)));

      const caller = await callerFor('user-navaai', { db, requestedTransportId: TRANSPORT_ID });
      const result = await caller.mail.emptySpam();
      expect(result.updated).toBe(0);
    });
  });
});
