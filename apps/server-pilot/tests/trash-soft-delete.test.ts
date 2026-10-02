/**
 * Soft-delete / bin folder tests (Task 5).
 *
 * Verifies bulkDelete trashes threads, bin folder lists them, inbox excludes
 * them, restore via modifyLabels clears trashedAt, and second delete hard-deletes.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mailThread } from '../src/db/schema/mail.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';
import { seedInboxThread } from './helpers/seed-inbox-thread';

const reachable = await probeTestDb();

async function insertInboxThread(db: import('../src/db/client.js').DB, id: string) {
  await seedInboxThread(db, {
    threadId: id,
    transportId: 'transport-centurion',
    transportEmail: 'centurion@legacyhotel.com',
    subject: `Trash test ${id}`,
    snippet: 'soft delete fixture',
  });
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'trash soft delete (seeded, transaction-rollback)',
  () => {
    it(
      'bulkDelete moves thread to bin; restore clears trashedAt; repeat delete stays trashed; permanent removes row',
      async () => {
        await withSeededTestDb(async (db) => {
          const threadId = 'thread-trash-soft-1';
          await insertInboxThread(db, threadId);
          const caller = await callerFor('user-navaai', { db, requestedTransportId: 'transport-centurion' });

          const inboxBefore = await caller.mail.listThreads({ folder: 'inbox' });
          expect(inboxBefore.threads.some((t) => t.id === threadId)).toBe(true);

          await caller.mail.bulkDelete({ ids: [threadId] });

          const rowTrashed = await db
            .select({ trashedAt: mailThread.trashedAt })
            .from(mailThread)
            .where(eq(mailThread.id, threadId))
            .limit(1);
          expect(rowTrashed[0]?.trashedAt).toBeTruthy();

          const inboxAfter = await caller.mail.listThreads({ folder: 'inbox' });
          expect(inboxAfter.threads.some((t) => t.id === threadId)).toBe(false);

          const binAfter = await caller.mail.listThreads({ folder: 'bin' });
          expect(binAfter.threads.some((t) => t.id === threadId)).toBe(true);

          await caller.mail.modifyLabels({
            threadId: [threadId],
            addLabels: ['INBOX'],
            removeLabels: ['TRASH'],
          });

          const rowRestored = await db
            .select({ trashedAt: mailThread.trashedAt })
            .from(mailThread)
            .where(eq(mailThread.id, threadId))
            .limit(1);
          expect(rowRestored[0]?.trashedAt).toBeNull();

          const inboxRestored = await caller.mail.listThreads({ folder: 'inbox' });
          expect(inboxRestored.threads.some((t) => t.id === threadId)).toBe(true);

          await caller.mail.bulkDelete({ ids: [threadId] });
          await caller.mail.bulkDelete({ ids: [threadId] });

          const rowStillTrashed = await db
            .select({ trashedAt: mailThread.trashedAt })
            .from(mailThread)
            .where(eq(mailThread.id, threadId))
            .limit(1);
          expect(rowStillTrashed).toHaveLength(1);
          expect(rowStillTrashed[0]?.trashedAt).toBeTruthy();

          await caller.mail.bulkDelete({ ids: [threadId], permanent: true });

          const rowGone = await db
            .select({ id: mailThread.id })
            .from(mailThread)
            .where(eq(mailThread.id, threadId))
            .limit(1);
          expect(rowGone).toHaveLength(0);
        });
      },
      30000,
    );

    it(
      'delete endpoint soft-deletes when not already trashed',
      async () => {
        await withSeededTestDb(async (db) => {
          const threadId = 'thread-trash-soft-2';
          await insertInboxThread(db, threadId);
          const caller = await callerFor('user-navaai', { db, requestedTransportId: 'transport-centurion' });

          await caller.mail.delete({ id: threadId });

          const row = await db
            .select({ trashedAt: mailThread.trashedAt })
            .from(mailThread)
            .where(eq(mailThread.id, threadId))
            .limit(1);
          expect(row[0]?.trashedAt).toBeTruthy();
        });
      },
      30000,
    );
  },
);
