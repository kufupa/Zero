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
import { seedInboxThread } from './helpers/seed-inbox-thread';

const reachable = await probeTestDb();

const THREAD_ID = 'thread-actions-fixture-1';
const MSG_ID = 'msg-actions-fixture-1';

async function seedActionThread(
  db: import('../src/db/client.js').DB,
  opts: { snoozedUntil?: Date | null } = {},
) {
  await seedInboxThread(db, {
    threadId: THREAD_ID,
    transportId: 'transport-centurion',
    transportEmail: 'centurion@legacyhotel.com',
    threadRootId: 'actions-root-1',
    subject: 'Actions fixture',
    snippet: 'thread actions test',
    isRead: true,
    isMessageRead: true,
    messageId: MSG_ID,
    textBody: 'body',
    messageIdHeader: 'actions-msg-1',
    references: [],
    snoozedUntil: opts.snoozedUntil ?? null,
  });
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'mail thread actions (seeded, transaction-rollback)',
  () => {
    it('markAsUnread sets thread and message is_read=false', async () => {
      await withSeededTestDb(async (db) => {
        await seedActionThread(db);
        const caller = await callerFor('user-navaai', { db });

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
        const caller = await callerFor('user-navaai', { db });

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
        const caller = await callerFor('user-navaai', { db });

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
    it('toggleStar bulk sets uniform starred state', async () => {
      await withSeededTestDb(async (db) => {
        const starredId = 'thread-actions-star-1';
        const unstarredId = 'thread-actions-star-2';
        for (const id of [starredId, unstarredId]) {
          await db.insert(mailThread).values({
            id,
            transportId: 'transport-centurion',
            threadRootId: `root-${id}`,
            subject: 'Star bulk',
            snippet: 'star test',
            isArchived: false,
            isStarred: id === starredId,
            isRead: true,
            labelIds: [],
            latestMessageAt: new Date(),
          });
        }
        const caller = await callerFor('user-navaai', { db });

        const result = await caller.mail.toggleStar({
          ids: [starredId, unstarredId, 'foreign-thread-id'],
        });
        expect(result.updated).toBe(2);

        for (const id of [starredId, unstarredId]) {
          const row = await db
            .select({ isStarred: mailThread.isStarred })
            .from(mailThread)
            .where(eq(mailThread.id, id))
            .limit(1);
          expect(row[0]?.isStarred).toBe(true);
        }
      });
    });

    it('markAsRead bulk skips foreign ids without partial failure', async () => {
      await withSeededTestDb(async (db) => {
        await seedActionThread(db);
        const caller = await callerFor('user-navaai', { db });
        const result = await caller.mail.markAsRead({
          ids: [THREAD_ID, 'foreign-thread-id'],
        });
        expect(result.updated).toBe(1);
      });
    });

    it('moves threads between system states without label emulation', async () => {
      await withSeededTestDb(async (db) => {
        await seedActionThread(db);
        const caller = await callerFor('user-navaai', { db });

        await caller.mail.moveThreads({ threadIds: [THREAD_ID], destination: 'spam' });
        const spam = await caller.mail.listThreads({ folder: 'spam', limit: 20 });
        expect(spam.threads.map((t) => t.id)).toContain(THREAD_ID);

        await caller.mail.moveThreads({ threadIds: [THREAD_ID], destination: 'inbox' });
        const inbox = await caller.mail.listThreads({ folder: 'inbox', limit: 20 });
        expect(inbox.threads.map((t) => t.id)).toContain(THREAD_ID);

        const rows = await db
          .select({ spamAt: mailThread.spamAt, labelIds: mailThread.labelIds })
          .from(mailThread)
          .where(eq(mailThread.id, THREAD_ID));
        expect(rows[0]?.spamAt).toBeNull();
        expect(rows[0]?.labelIds ?? []).not.toContain('SPAM');
      });
    });

    it('unsend last message deletes empty thread', async () => {
      await withSeededTestDb(async (db) => {
        const threadId = 'thread-unsend-only-1';
        const outboundId = 'msg-unsend-only-1';
        await db.insert(mailThread).values({
          id: threadId,
          transportId: 'transport-centurion',
          threadRootId: 'unsend-root',
          subject: 'Unsend only',
          snippet: 'outbound only',
          isArchived: false,
          isStarred: false,
          isRead: true,
          labelIds: [],
          latestMessageAt: new Date(),
        });
        await db.insert(message).values({
          id: outboundId,
          transportId: 'transport-centurion',
          threadId,
          direction: 'outbound',
          fromAddress: 'centurion@legacyhotel.com',
          toAddresses: ['guest@example.com'],
          ccAddresses: [],
          bccAddresses: [],
          subject: 'Unsend only',
          textBody: 'bye',
          messageIdHeader: 'unsend-only-1',
          references: [],
          isRead: true,
          isStarred: false,
          sentAt: new Date(),
          receivedAt: new Date(),
        });
        const caller = await callerFor('user-navaai', { db });

        await caller.mail.unsend({ messageId: outboundId });

        const rows = await db
          .select({ id: mailThread.id })
          .from(mailThread)
          .where(eq(mailThread.id, threadId));
        expect(rows).toHaveLength(0);
      });
    });
  },
);
