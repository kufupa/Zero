/**
 * Thread action completeness (Task 13): markAsUnread messages, toggleImportant
 * literal label id, snooze inbox filter + lazy clear.
 */
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { mailThread, message } from '../src/db/schema/mail.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';

const reachable = await probeTestDb();

const THREAD_ID = 'thread-actions-fixture-1';
const MSG_ID = 'msg-actions-fixture-1';

async function seedActionThread(
  db: import('../src/db/client.js').DB,
  opts: { snoozedUntil?: Date | null } = {},
) {
  await db
    .insert(mailThread)
    .values({
      id: THREAD_ID,
      transportId: 'transport-centurion',
      threadRootId: 'actions-root-1',
      subject: 'Actions fixture',
      snippet: 'thread actions test',
      isArchived: false,
      isStarred: false,
      isRead: true,
      labelIds: [],
      snoozedUntil: opts.snoozedUntil ?? null,
      latestMessageAt: new Date(),
    })
    .onConflictDoNothing({ target: mailThread.id });

  await db
    .insert(message)
    .values({
      id: MSG_ID,
      transportId: 'transport-centurion',
      threadId: THREAD_ID,
      direction: 'inbound',
      fromAddress: 'guest@example.com',
      toAddresses: ['centurion@legacyhotel.com'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'Actions fixture',
      textBody: 'body',
      messageIdHeader: 'actions-msg-1',
      references: [],
      isRead: true,
      isStarred: false,
      receivedAt: new Date(),
    })
    .onConflictDoNothing({ target: message.id });
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'mail thread actions (seeded, transaction-rollback)',
  () => {
    it('markAsUnread sets thread and message is_read=false', async () => {
      await withSeededTestDb(async (db) => {
        await seedActionThread(db);
        const caller = await callerFor('user-manager', { db });

        await caller.mail.markAsUnread({ ids: [THREAD_ID] });

        const threadRow = await db
          .select({ isRead: mailThread.isRead })
          .from(mailThread)
          .where(eq(mailThread.id, THREAD_ID))
          .limit(1);
        expect(threadRow[0]?.isRead).toBe(false);

        const msgRow = await db
          .select({ isRead: message.isRead })
          .from(message)
          .where(eq(message.id, MSG_ID))
          .limit(1);
        expect(msgRow[0]?.isRead).toBe(false);
      });
    });

    it('toggleImportant toggles literal IMPORTANT in labelIds', async () => {
      await withSeededTestDb(async (db) => {
        await seedActionThread(db);
        const caller = await callerFor('user-manager', { db });

        await caller.mail.toggleImportant({ ids: [THREAD_ID] });

        let row = await db
          .select({ labelIds: mailThread.labelIds })
          .from(mailThread)
          .where(eq(mailThread.id, THREAD_ID))
          .limit(1);
        expect(row[0]?.labelIds).toContain('IMPORTANT');

        await caller.mail.toggleImportant({ ids: [THREAD_ID] });

        row = await db
          .select({ labelIds: mailThread.labelIds })
          .from(mailThread)
          .where(eq(mailThread.id, THREAD_ID))
          .limit(1);
        expect(row[0]?.labelIds ?? []).not.toContain('IMPORTANT');
      });
    });

    it('inbox excludes active snooze; lazy-clears expired snooze', async () => {
      await withSeededTestDb(async (db) => {
        const future = new Date(Date.now() + 86400000);
        await seedActionThread(db, { snoozedUntil: future });
        const caller = await callerFor('user-manager', { db });

        const inboxSnoozed = await caller.mail.listThreads({ folder: 'inbox' });
        expect(inboxSnoozed.threads.some((t) => t.id === THREAD_ID)).toBe(false);

        const snoozedFolder = await caller.mail.listThreads({ folder: 'snoozed' });
        expect(snoozedFolder.threads.some((t) => t.id === THREAD_ID)).toBe(true);

        await db
          .update(mailThread)
          .set({ snoozedUntil: new Date(Date.now() - 60_000) })
          .where(
            and(eq(mailThread.id, THREAD_ID), eq(mailThread.transportId, 'transport-centurion')),
          );

        const inboxAfterExpiry = await caller.mail.listThreads({ folder: 'inbox' });
        expect(inboxAfterExpiry.threads.some((t) => t.id === THREAD_ID)).toBe(true);

        const cleared = await db
          .select({ snoozedUntil: mailThread.snoozedUntil })
          .from(mailThread)
          .where(eq(mailThread.id, THREAD_ID))
          .limit(1);
        expect(cleared[0]?.snoozedUntil).toBeNull();
      });
    });
  },
);
