/**
 * Thread action completeness (Task 13): markAsUnread messages, toggleImportant
 * literal label id, snooze inbox filter + lazy clear.
 * Task 1 custom folders: mail.fileThreads atomic filing.
 */
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  mailCategory,
  mailLabel,
  mailThread,
  mailThreadCategory,
  message,
} from '../src/db/schema/mail.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';
import { seedInboxThread } from './helpers/seed-inbox-thread';
import {
  FakeSmtpTransport,
  __setSmtpTransportForTests,
} from '../src/mail/send/smtp.js';

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
    it(
      'markAsUnread sets thread and message is_read=false',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedActionThread(db);
          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });

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
      },
      30000,
    );

    it(
      'toggleImportant toggles literal IMPORTANT in labelIds',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedActionThread(db);
          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });

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
      },
      30000,
    );

    it(
      'inbox excludes active snooze; lazy-clears expired snooze',
      async () => {
        await withSeededTestDb(async (db) => {
          const future = new Date(Date.now() + 86400000);
          await seedActionThread(db, { snoozedUntil: future });
          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });

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
      },
      30000,
    );

    it(
      'toggleStar bulk sets uniform starred state',
      async () => {
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
          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });

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
      },
      30000,
    );

    it(
      'markAsRead bulk skips foreign ids without partial failure',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedActionThread(db);
          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const result = await caller.mail.markAsRead({
            ids: [THREAD_ID, 'foreign-thread-id'],
          });
          expect(result.updated).toBe(1);
        });
      },
      30000,
    );

    it(
      'modifyLabels TRASH clears spamAt so thread appears in bin',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedActionThread(db);
          await db
            .update(mailThread)
            .set({ spamAt: new Date(), trashedAt: null })
            .where(
              and(eq(mailThread.id, THREAD_ID), eq(mailThread.transportId, 'transport-centurion')),
            );

          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          await caller.mail.modifyLabels({
            threadId: [THREAD_ID],
            addLabels: ['TRASH'],
            removeLabels: [],
          });

          const rows = await db
            .select({ spamAt: mailThread.spamAt, trashedAt: mailThread.trashedAt })
            .from(mailThread)
            .where(eq(mailThread.id, THREAD_ID))
            .limit(1);
          expect(rows[0]?.spamAt).toBeNull();
          expect(rows[0]?.trashedAt).not.toBeNull();

          const bin = await caller.mail.listThreads({ folder: 'bin', limit: 20 });
          expect(bin.threads.map((t) => t.id)).toContain(THREAD_ID);

          const spam = await caller.mail.listThreads({ folder: 'spam', limit: 20 });
          expect(spam.threads.map((t) => t.id)).not.toContain(THREAD_ID);
        });
      },
      30000,
    );

    it(
      'bulkDelete clears spamAt so spam-marked thread appears in bin',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedActionThread(db);
          await db
            .update(mailThread)
            .set({ spamAt: new Date(), trashedAt: null })
            .where(
              and(eq(mailThread.id, THREAD_ID), eq(mailThread.transportId, 'transport-centurion')),
            );

          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          await caller.mail.bulkDelete({ ids: [THREAD_ID] });

          const rows = await db
            .select({ spamAt: mailThread.spamAt, trashedAt: mailThread.trashedAt })
            .from(mailThread)
            .where(eq(mailThread.id, THREAD_ID))
            .limit(1);
          expect(rows[0]?.spamAt).toBeNull();
          expect(rows[0]?.trashedAt).not.toBeNull();

          const bin = await caller.mail.listThreads({ folder: 'bin', limit: 20 });
          expect(bin.threads.map((t) => t.id)).toContain(THREAD_ID);
        });
      },
      30000,
    );

    it(
      'moveThreads to bin clears spamAt so thread appears in bin',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedActionThread(db);
          await db
            .update(mailThread)
            .set({ spamAt: new Date(), trashedAt: null })
            .where(
              and(eq(mailThread.id, THREAD_ID), eq(mailThread.transportId, 'transport-centurion')),
            );

          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          await caller.mail.moveThreads({ threadIds: [THREAD_ID], destination: 'bin' });

          const rows = await db
            .select({ spamAt: mailThread.spamAt, trashedAt: mailThread.trashedAt })
            .from(mailThread)
            .where(eq(mailThread.id, THREAD_ID))
            .limit(1);
          expect(rows[0]?.spamAt).toBeNull();
          expect(rows[0]?.trashedAt).not.toBeNull();

          const bin = await caller.mail.listThreads({ folder: 'bin', limit: 20 });
          expect(bin.threads.map((t) => t.id)).toContain(THREAD_ID);

          const spam = await caller.mail.listThreads({ folder: 'spam', limit: 20 });
          expect(spam.threads.map((t) => t.id)).not.toContain(THREAD_ID);
        });
      },
      30000,
    );

    it(
      'moves threads between system states without label emulation',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedActionThread(db);
          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });

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
      },
      30000,
    );

    it(
      'unsend last message deletes empty thread',
      async () => {
        await withSeededTestDb(async (db) => {
          const prevUndo = process.env.UNDO_SEND_SECONDS;
          process.env.UNDO_SEND_SECONDS = '30';
          try {
            const fake = new FakeSmtpTransport();
            __setSmtpTransportForTests(fake);
            const caller = await callerFor('user-navaai', { db });
            const result = await caller.mail.send({
              to: ['guest@example.com'],
              subject: 'Unsend only',
              html: '<p>bye</p>',
              text: 'bye',
            });
            expect(result).toMatchObject({ queued: true });
            const messageId = (result as { messageId: string }).messageId;
            const [msgRow] = await db
              .select({ threadId: message.threadId })
              .from(message)
              .where(eq(message.id, messageId));
            const threadId = msgRow!.threadId;

            await caller.mail.unsend({ messageId });

            const rows = await db
              .select({ id: mailThread.id })
              .from(mailThread)
              .where(eq(mailThread.id, threadId));
            expect(rows).toHaveLength(0);
            expect(fake.sent).toHaveLength(0);
          } finally {
            __setSmtpTransportForTests(null);
            if (prevUndo === undefined) delete process.env.UNDO_SEND_SECONDS;
            else process.env.UNDO_SEND_SECONDS = prevUndo;
          }
        });
      },
      30000,
    );

    it(
      'mail.get hasReplied false for inbound-only thread',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedActionThread(db);
          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const got = await caller.mail.get({ id: THREAD_ID });
          expect(got.hasReplied).toBe(false);
        });
      },
      30000,
    );

    it(
      'mail.get hasReplied true when thread has outbound message',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedActionThread(db);
          await db.insert(message).values({
            id: 'msg-actions-outbound-1',
            transportId: 'transport-centurion',
            threadId: THREAD_ID,
            direction: 'outbound',
            fromAddress: 'centurion@legacyhotel.com',
            toAddresses: ['guest@example.com'],
            ccAddresses: [],
            bccAddresses: [],
            subject: 'Re: Actions fixture',
            textBody: 'reply body',
            isRead: true,
            isStarred: false,
            receivedAt: new Date(),
          });
          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const got = await caller.mail.get({ id: THREAD_ID });
          expect(got.hasReplied).toBe(true);
        });
      },
      30000,
    );

    it(
      'fileThreads from inbox archives and keeps exclusive user label + system ids',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedActionThread(db);
          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const target = await caller.labels.create({ name: `file-inbox-${Date.now()}` });
          const other = await caller.labels.create({ name: `file-other-${Date.now()}` });
          const categoryId = `cat-file-${Date.now()}`;
          await db.insert(mailCategory).values({
            id: categoryId,
            transportId: 'transport-centurion',
            slug: `file-cat-${Date.now()}`,
            name: 'File Cat',
            sortOrder: 99,
          });
          await db.insert(mailThreadCategory).values({
            threadId: THREAD_ID,
            categoryId,
            transportId: 'transport-centurion',
          });
          await db
            .update(mailThread)
            .set({ labelIds: [other.id, 'IMPORTANT', 'STARRED'] })
            .where(
              and(eq(mailThread.id, THREAD_ID), eq(mailThread.transportId, 'transport-centurion')),
            );

          const result = await caller.mail.fileThreads({
            threadIds: [THREAD_ID],
            labelId: target.id,
          });
          expect(result.updated).toBe(1);

          const [row] = await db
            .select({
              isArchived: mailThread.isArchived,
              labelIds: mailThread.labelIds,
              spamAt: mailThread.spamAt,
              trashedAt: mailThread.trashedAt,
            })
            .from(mailThread)
            .where(eq(mailThread.id, THREAD_ID))
            .limit(1);
          expect(row?.isArchived).toBe(true);
          expect(row?.spamAt).toBeNull();
          expect(row?.trashedAt).toBeNull();
          expect(row?.labelIds).toContain(target.id);
          expect(row?.labelIds).toContain('IMPORTANT');
          expect(row?.labelIds).toContain('STARRED');
          expect(row?.labelIds).not.toContain(other.id);

          const cats = await db
            .select({ categoryId: mailThreadCategory.categoryId })
            .from(mailThreadCategory)
            .where(eq(mailThreadCategory.threadId, THREAD_ID));
          expect(cats.map((c) => c.categoryId)).toEqual([categoryId]);

          const inbox = await caller.mail.listThreads({ folder: 'inbox', limit: 50 });
          expect(inbox.threads.map((t) => t.id)).not.toContain(THREAD_ID);
        });
      },
      30000,
    );

    it(
      'fileThreads from spam clears spamAt and sets spamUserLockedAt',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedActionThread(db);
          await db
            .update(mailThread)
            .set({ spamAt: new Date(), spamUserLockedAt: null, trashedAt: null })
            .where(
              and(eq(mailThread.id, THREAD_ID), eq(mailThread.transportId, 'transport-centurion')),
            );
          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const target = await caller.labels.create({ name: `file-spam-${Date.now()}` });

          await caller.mail.fileThreads({ threadIds: [THREAD_ID], labelId: target.id });

          const [row] = await db
            .select({
              isArchived: mailThread.isArchived,
              spamAt: mailThread.spamAt,
              spamUserLockedAt: mailThread.spamUserLockedAt,
              labelIds: mailThread.labelIds,
            })
            .from(mailThread)
            .where(eq(mailThread.id, THREAD_ID))
            .limit(1);
          expect(row?.isArchived).toBe(true);
          expect(row?.spamAt).toBeNull();
          expect(row?.spamUserLockedAt).not.toBeNull();
          expect(row?.labelIds).toContain(target.id);

          const spam = await caller.mail.listThreads({ folder: 'spam', limit: 20 });
          expect(spam.threads.map((t) => t.id)).not.toContain(THREAD_ID);
        });
      },
      30000,
    );

    it(
      'fileThreads from bin clears trashedAt and archives with label',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedActionThread(db);
          await db
            .update(mailThread)
            .set({ trashedAt: new Date(), isArchived: false, spamAt: null })
            .where(
              and(eq(mailThread.id, THREAD_ID), eq(mailThread.transportId, 'transport-centurion')),
            );
          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const target = await caller.labels.create({ name: `file-bin-${Date.now()}` });

          await caller.mail.fileThreads({ threadIds: [THREAD_ID], labelId: target.id });

          const [row] = await db
            .select({
              isArchived: mailThread.isArchived,
              trashedAt: mailThread.trashedAt,
              labelIds: mailThread.labelIds,
            })
            .from(mailThread)
            .where(eq(mailThread.id, THREAD_ID))
            .limit(1);
          expect(row?.isArchived).toBe(true);
          expect(row?.trashedAt).toBeNull();
          expect(row?.labelIds).toContain(target.id);

          const bin = await caller.mail.listThreads({ folder: 'bin', limit: 20 });
          expect(bin.threads.map((t) => t.id)).not.toContain(THREAD_ID);
        });
      },
      30000,
    );

    it(
      'fileThreads foreign label NOT_FOUND; foreign threads skipped in batch',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedActionThread(db);
          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const own = await caller.labels.create({ name: `file-own-${Date.now()}` });
          const foreignId = `foreign-label-${Date.now()}`;
          await db.insert(mailLabel).values({
            id: foreignId,
            transportId: 'transport-nava',
            name: `foreign-${Date.now()}`,
          });

          await expect(
            caller.mail.fileThreads({ threadIds: [THREAD_ID], labelId: foreignId }),
          ).rejects.toMatchObject({ code: 'NOT_FOUND' });

          const batchId = 'thread-actions-file-batch-2';
          await seedInboxThread(db, {
            threadId: batchId,
            transportId: 'transport-centurion',
            transportEmail: 'centurion@legacyhotel.com',
            threadRootId: 'actions-root-batch-2',
            subject: 'Batch 2',
            snippet: 'batch',
            isRead: true,
            isMessageRead: true,
            messageId: 'msg-actions-file-batch-2',
            textBody: 'body',
            messageIdHeader: 'actions-batch-2',
            references: [],
          });

          const result = await caller.mail.fileThreads({
            threadIds: [THREAD_ID, batchId, 'foreign-thread-id'],
            labelId: own.id,
          });
          expect(result.updated).toBe(2);
        });
      },
      30000,
    );

    it(
      'labels.delete scrubs labelIds and unarchives orphan filed threads',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedActionThread(db);
          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const target = await caller.labels.create({ name: `del-scrub-${Date.now()}` });
          const keep = await caller.labels.create({ name: `del-keep-${Date.now()}` });

          await caller.mail.fileThreads({ threadIds: [THREAD_ID], labelId: target.id });
          const orphanId = 'thread-actions-del-orphan';
          await seedInboxThread(db, {
            threadId: orphanId,
            transportId: 'transport-centurion',
            transportEmail: 'centurion@legacyhotel.com',
            threadRootId: 'actions-root-del-orphan',
            subject: 'Orphan',
            snippet: 'orphan',
            isRead: true,
            isMessageRead: true,
            messageId: 'msg-actions-del-orphan',
            textBody: 'body',
            messageIdHeader: 'actions-del-orphan',
            references: [],
          });
          await caller.mail.fileThreads({ threadIds: [orphanId], labelId: target.id });

          const keepId = 'thread-actions-del-keep';
          await seedInboxThread(db, {
            threadId: keepId,
            transportId: 'transport-centurion',
            transportEmail: 'centurion@legacyhotel.com',
            threadRootId: 'actions-root-del-keep',
            subject: 'Keep',
            snippet: 'keep',
            isRead: true,
            isMessageRead: true,
            messageId: 'msg-actions-del-keep',
            textBody: 'body',
            messageIdHeader: 'actions-del-keep',
            references: [],
          });
          await db
            .update(mailThread)
            .set({
              isArchived: true,
              labelIds: [target.id, keep.id, 'IMPORTANT'],
            })
            .where(
              and(eq(mailThread.id, keepId), eq(mailThread.transportId, 'transport-centurion')),
            );

          await caller.labels.delete({ id: target.id });

          const [orphan] = await db
            .select({ isArchived: mailThread.isArchived, labelIds: mailThread.labelIds })
            .from(mailThread)
            .where(eq(mailThread.id, orphanId))
            .limit(1);
          expect(orphan?.labelIds ?? []).not.toContain(target.id);
          expect(orphan?.isArchived).toBe(false);

          const [kept] = await db
            .select({ isArchived: mailThread.isArchived, labelIds: mailThread.labelIds })
            .from(mailThread)
            .where(eq(mailThread.id, keepId))
            .limit(1);
          expect(kept?.labelIds).toContain(keep.id);
          expect(kept?.labelIds).toContain('IMPORTANT');
          expect(kept?.labelIds).not.toContain(target.id);
          expect(kept?.isArchived).toBe(true);
        });
      },
      30000,
    );
  },
);
