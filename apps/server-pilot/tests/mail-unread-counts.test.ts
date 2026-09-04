import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  mailCategory,
  mailDraft,
  mailLabel,
  mailThread,
  mailThreadCategory,
  mailboxAccess,
  mailboxTransport,
  message,
} from '../src/db/schema/mail.js';
import { TRANSPORT_ID, NAVA_USER_ID } from '../src/db/seed.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';
import { callerFor } from './helpers/trpc-caller.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('mail.unreadCounts route contract', () => {
  it('computes direct-folder unread counts, enforces transport isolation, and handles mutations', async () => {
    await withSeededTestDb(async (db) => {
      const primaryTransportId = TRANSPORT_ID;
      const secondTransportId = 'transport-other-box';

      // Seed second transport and grant access to user
      await db.insert(mailboxTransport).values({
        id: secondTransportId,
        email: 'other@example.com',
        ownerHeaderValue: 'other@example.com',
        mailboxType: 'personal',
        displayName: 'Other Mailbox',
        isActive: true,
      }).onConflictDoNothing({ target: mailboxTransport.id });

      await db.insert(mailboxAccess).values({
        id: `access-${NAVA_USER_ID}-${secondTransportId}`,
        userId: NAVA_USER_ID,
        transportId: secondTransportId,
        role: 'owner',
        isDefault: false,
      }).onConflictDoNothing({ target: [mailboxAccess.userId, mailboxAccess.transportId] });

      // Opaque IDs (not purely standard UUIDs)
      const catAId = `cat-active-alpha-${Date.now()}`;
      const catBId = `cat-active-beta-${Date.now()}`;
      const catInactiveId = `cat-inactive-${Date.now()}`;

      const labelWorkId = `lbl-work-${Date.now()}`;
      const labelBillsId = `lbl-bills-${Date.now()}`;
      const labelQuarantineId = `lbl-quarantine-${Date.now()}`;
      const labelSpamSystemId = `lbl-spam-${Date.now()}`;

      // Insert categories for primary transport
      await db.insert(mailCategory).values([
        { id: catAId, transportId: primaryTransportId, slug: 'cat-alpha', name: 'Alpha', isActive: true, sortOrder: 1 },
        { id: catBId, transportId: primaryTransportId, slug: 'cat-beta', name: 'Beta', isActive: true, sortOrder: 2 },
        { id: catInactiveId, transportId: primaryTransportId, slug: 'cat-inactive', name: 'Inactive', isActive: false, sortOrder: 3 },
      ]);

      // Insert user labels for primary transport
      await db.insert(mailLabel).values([
        { id: labelWorkId, transportId: primaryTransportId, name: 'Work', color: '#111' },
        { id: labelBillsId, transportId: primaryTransportId, name: 'Bills', color: '#222' },
        { id: labelQuarantineId, transportId: primaryTransportId, name: 'Quarantine', color: '#333' },
      ]);

      // Seed threads on primary transport:
      // 1. Two unread Inbox threads (one will be linked to both catA and catB)
      const unreadInbox1 = `th-inbox-unread-1-${Date.now()}`;
      const unreadInbox2 = `th-inbox-unread-2-${Date.now()}`;
      await seedInboxThread(db, {
        threadId: unreadInbox1,
        transportId: primaryTransportId,
        transportEmail: 'centurion@legacyhotels.co.za',
        isRead: false,
      });
      await seedInboxThread(db, {
        threadId: unreadInbox2,
        transportId: primaryTransportId,
        transportEmail: 'centurion@legacyhotels.co.za',
        isRead: false,
      });

      // Link unreadInbox1 to two categories (catA and catB)
      await db.insert(mailThreadCategory).values([
        { threadId: unreadInbox1, categoryId: catAId, transportId: primaryTransportId },
        { threadId: unreadInbox1, categoryId: catBId, transportId: primaryTransportId },
      ]);

      // 2. One read Inbox thread
      const readInbox1 = `th-inbox-read-1-${Date.now()}`;
      await seedInboxThread(db, {
        threadId: readInbox1,
        transportId: primaryTransportId,
        transportEmail: 'centurion@legacyhotels.co.za',
        isRead: true,
      });

      // 3. One outbound-only thread (lives in sent, unread)
      const unreadSent1 = `th-sent-unread-1-${Date.now()}`;
      await db.insert(mailThread).values({
        id: unreadSent1,
        transportId: primaryTransportId,
        threadRootId: `<sent-root-1@example.com>`,
        subject: 'Outbound proposal',
        isRead: false,
        isArchived: false,
        latestMessageAt: new Date(),
      });
      await db.insert(message).values({
        id: `msg-sent-1-${Date.now()}`,
        transportId: primaryTransportId,
        threadId: unreadSent1,
        direction: 'outbound',
        fromAddress: 'centurion@legacyhotels.co.za',
        toAddresses: ['client@example.com'],
        subject: 'Outbound proposal',
        receivedAt: new Date(),
      });

      // 4. Archived threads:
      // - unread archived thread attached to labelWorkId and labelBillsId (both labels incremented once)
      const unreadArchived1 = `th-arch-unread-1-${Date.now()}`;
      await db.insert(mailThread).values({
        id: unreadArchived1,
        transportId: primaryTransportId,
        threadRootId: `<arch-root-1@example.com>`,
        subject: 'Filed work bill',
        isRead: false,
        isArchived: true,
        labelIds: [labelWorkId, labelBillsId, labelWorkId], // duplicate labelId test
        latestMessageAt: new Date(),
      });
      // - read archived thread
      const readArchived1 = `th-arch-read-1-${Date.now()}`;
      await db.insert(mailThread).values({
        id: readArchived1,
        transportId: primaryTransportId,
        threadRootId: `<arch-read-1@example.com>`,
        subject: 'Old archived',
        isRead: true,
        isArchived: true,
        labelIds: [labelWorkId],
        latestMessageAt: new Date(),
      });

      // 5. Active and expired snoozes:
      // - active snooze (future wakeAt), unread
      const unreadActiveSnooze = `th-snooze-active-${Date.now()}`;
      await db.insert(mailThread).values({
        id: unreadActiveSnooze,
        transportId: primaryTransportId,
        threadRootId: `<snooze-act-1@example.com>`,
        subject: 'Active snooze',
        isRead: false,
        isArchived: false,
        snoozedUntil: new Date(Date.now() + 3600_000),
        latestMessageAt: new Date(),
      });
      // - expired snooze (past wakeAt) with inbound message; lazy-clear should return it to inbox
      const unreadExpiredSnooze = `th-snooze-exp-${Date.now()}`;
      await seedInboxThread(db, {
        threadId: unreadExpiredSnooze,
        transportId: primaryTransportId,
        transportEmail: 'centurion@legacyhotels.co.za',
        isRead: false,
        snoozedUntil: new Date(Date.now() - 3600_000),
      });

      // 6. Spam and Bin threads:
      // - one unread spam thread (also tagged with labelQuarantineId)
      const unreadSpam1 = `th-spam-unread-1-${Date.now()}`;
      await db.insert(mailThread).values({
        id: unreadSpam1,
        transportId: primaryTransportId,
        threadRootId: `<spam-1@example.com>`,
        subject: 'Lottery win spam',
        isRead: false,
        isArchived: false,
        spamAt: new Date(),
        labelIds: [labelQuarantineId],
        latestMessageAt: new Date(),
      });
      // - one unread bin thread
      const unreadBin1 = `th-bin-unread-1-${Date.now()}`;
      await db.insert(mailThread).values({
        id: unreadBin1,
        transportId: primaryTransportId,
        threadRootId: `<bin-1@example.com>`,
        subject: 'Trash mail',
        isRead: false,
        isArchived: false,
        trashedAt: new Date(),
        latestMessageAt: new Date(),
      });

      // 7. Second transport matching unread rows to verify isolation
      const secondInbox = `th-second-inbox-${Date.now()}`;
      await seedInboxThread(db, {
        threadId: secondInbox,
        transportId: secondTransportId,
        transportEmail: 'other@example.com',
        isRead: false,
      });

      // 8. Drafts on primary and second transport
      await db.insert(mailDraft).values([
        {
          id: `draft-act-1-${Date.now()}`,
          transportId: primaryTransportId,
          createdByUserId: NAVA_USER_ID,
          status: 'active',
          isSent: false,
        },
        {
          id: `draft-cand-2-${Date.now()}`,
          transportId: primaryTransportId,
          createdByUserId: NAVA_USER_ID,
          status: 'candidate',
          isSent: false,
        },
        {
          id: `draft-sent-3-${Date.now()}`,
          transportId: primaryTransportId,
          createdByUserId: NAVA_USER_ID,
          status: 'sent',
          isSent: true,
        },
        {
          id: `draft-other-box-${Date.now()}`,
          transportId: secondTransportId,
          createdByUserId: NAVA_USER_ID,
          status: 'active',
          isSent: false,
        },
      ]);

      // Create caller for primary transport
      const callerPrimary = await callerFor(NAVA_USER_ID, {
        db,
        requestedTransportId: primaryTransportId,
      });

      // Query unreadCounts
      // @ts-expect-error unreadCounts is being implemented
      const counts = await callerPrimary.mail.unreadCounts();

      // Folders contract: fixed 6 items in exact order
      expect(counts.folders.map((f: { id: string }) => f.id)).toEqual([
        'inbox',
        'sent',
        'archive',
        'snoozed',
        'bin',
        'spam',
      ]);

      for (const item of counts.folders) {
        expect(typeof item.unreadCount).toBe('number');
        expect(item.unreadCount).toBeGreaterThanOrEqual(0);
        expect(typeof item.totalCount).toBe('number');
        expect(item.totalCount).toBeGreaterThanOrEqual(item.unreadCount);
      }

      // Drafts count contract: active + candidate on primary transport = 2
      expect(counts.draftsCount).toBe(2);

      // Expected folder counts:
      // Inbox: unreadInbox1 + unreadInbox2 + unreadExpiredSnooze (lazy cleared) = 3 unread, 4 total (incl readInbox1)
      const inboxFolder = counts.folders.find((f: { id: string }) => f.id === 'inbox');
      expect(inboxFolder?.unreadCount).toBe(3);
      expect(inboxFolder?.totalCount).toBe(4);

      // Sent: unreadSent1 = 1 unread, 1 total
      const sentFolder = counts.folders.find((f: { id: string }) => f.id === 'sent');
      expect(sentFolder?.unreadCount).toBe(1);
      expect(sentFolder?.totalCount).toBe(1);

      // Archive: unreadArchived1 (1) + readArchived1 (1) = 1 unread, 2 total
      const archiveFolder = counts.folders.find((f: { id: string }) => f.id === 'archive');
      expect(archiveFolder?.unreadCount).toBe(1);
      expect(archiveFolder?.totalCount).toBe(2);

      // Snoozed: unreadActiveSnooze = 1
      const snoozedCount = counts.folders.find((f: { id: string }) => f.id === 'snoozed')?.unreadCount;
      expect(snoozedCount).toBe(1);

      // Bin: unreadBin1 = 1
      const binCount = counts.folders.find((f: { id: string }) => f.id === 'bin')?.unreadCount;
      expect(binCount).toBe(1);

      // Spam: unreadSpam1 = 1
      const spamCount = counts.folders.find((f: { id: string }) => f.id === 'spam')?.unreadCount;
      expect(spamCount).toBe(1);

      // Categories contract:
      // Only active categories returned (catA, catB). catInactiveId omitted.
      const returnedCatIds = counts.categories.map((c: { categoryId: string }) => c.categoryId);
      expect(returnedCatIds).toContain(catAId);
      expect(returnedCatIds).toContain(catBId);
      expect(returnedCatIds).not.toContain(catInactiveId);

      // CatA and CatB both link to unreadInbox1 (Inbox unread) -> both have 1
      const catACount = counts.categories.find((c: { categoryId: string }) => c.categoryId === catAId)?.unreadCount;
      const catBCount = counts.categories.find((c: { categoryId: string }) => c.categoryId === catBId)?.unreadCount;
      expect(catACount).toBe(1);
      expect(catBCount).toBe(1);
      expect(typeof catACount).toBe('number');

      // Labels contract:
      // Visible user labels returned: Work, Bills, Quarantine. Case-insensitive SPAM excluded.
      const returnedLabelIds = counts.labels.map((l: { labelId: string }) => l.labelId);
      expect(returnedLabelIds).toContain(labelWorkId);
      expect(returnedLabelIds).toContain(labelBillsId);
      expect(returnedLabelIds).toContain(labelQuarantineId);
      expect(returnedLabelIds).not.toContain(labelSpamSystemId);

      // Work has 1 (unreadArchived1), Bills has 1 (unreadArchived1)
      const workCount = counts.labels.find((l: { labelId: string }) => l.labelId === labelWorkId)?.unreadCount;
      const billsCount = counts.labels.find((l: { labelId: string }) => l.labelId === labelBillsId)?.unreadCount;
      expect(workCount).toBe(1);
      expect(billsCount).toBe(1);

      // Quarantine has 1 (unreadSpam1 under Spam predicates, not Archive)
      const quarantineCount = counts.labels.find((l: { labelId: string }) => l.labelId === labelQuarantineId)?.unreadCount;
      expect(quarantineCount).toBe(1);

      // Transport isolation:
      const callerSecond = await callerFor(NAVA_USER_ID, {
        db,
        requestedTransportId: secondTransportId,
      });
      // @ts-expect-error unreadCounts is being implemented
      const secondCounts = await callerSecond.mail.unreadCounts();
      expect(secondCounts.folders.find((f: { id: string }) => f.id === 'inbox')?.unreadCount).toBe(1);
      expect(secondCounts.folders.find((f: { id: string }) => f.id === 'archive')?.unreadCount).toBe(0);

      // --- Transition behavior ---
      // 1. Mark as read
      await callerPrimary.mail.markAsRead({ ids: [unreadInbox2] });
      // @ts-expect-error unreadCounts
      const countsAfterRead = await callerPrimary.mail.unreadCounts();
      expect(countsAfterRead.folders.find((f: { id: string }) => f.id === 'inbox')?.unreadCount).toBe(2);

      // 2. Mark as unread
      await callerPrimary.mail.markAsUnread({ ids: [unreadInbox2] });
      // @ts-expect-error unreadCounts
      const countsAfterUnread = await callerPrimary.mail.unreadCounts();
      expect(countsAfterUnread.folders.find((f: { id: string }) => f.id === 'inbox')?.unreadCount).toBe(3);

      // 3. Move thread to archive
      await callerPrimary.mail.moveThreads({ threadIds: [unreadInbox2], destination: 'archive' });
      // @ts-expect-error unreadCounts
      const countsAfterArchive = await callerPrimary.mail.unreadCounts();
      expect(countsAfterArchive.folders.find((f: { id: string }) => f.id === 'inbox')?.unreadCount).toBe(2);
      expect(countsAfterArchive.folders.find((f: { id: string }) => f.id === 'archive')?.unreadCount).toBe(2);

      // 4. Move thread from archive to bin
      await callerPrimary.mail.moveThreads({ threadIds: [unreadInbox2], destination: 'bin' });
      // @ts-expect-error unreadCounts
      const countsAfterBin = await callerPrimary.mail.unreadCounts();
      expect(countsAfterBin.folders.find((f: { id: string }) => f.id === 'archive')?.unreadCount).toBe(1);
      expect(countsAfterBin.folders.find((f: { id: string }) => f.id === 'bin')?.unreadCount).toBe(2);

      // 5. Spam -> Bin and Spam -> Archive transitions
      // Move unreadSpam1 to bin
      await callerPrimary.mail.moveThreads({ threadIds: [unreadSpam1], destination: 'bin' });
      // @ts-expect-error unreadCounts
      const countsAfterSpamToBin = await callerPrimary.mail.unreadCounts();
      expect(countsAfterSpamToBin.folders.find((f: { id: string }) => f.id === 'spam')?.unreadCount).toBe(0);
      expect(countsAfterSpamToBin.folders.find((f: { id: string }) => f.id === 'bin')?.unreadCount).toBe(3);
      // Quarantine count drops to 0 because unreadSpam1 is now in bin
      expect(countsAfterSpamToBin.labels.find((l: { labelId: string }) => l.labelId === labelQuarantineId)?.unreadCount).toBe(0);

      // Move back to spam
      await callerPrimary.mail.moveThreads({ threadIds: [unreadSpam1], destination: 'spam' });
      // @ts-expect-error unreadCounts
      const countsAfterBackToSpam = await callerPrimary.mail.unreadCounts();
      expect(countsAfterBackToSpam.folders.find((f: { id: string }) => f.id === 'spam')?.unreadCount).toBe(1);
      expect(countsAfterBackToSpam.labels.find((l: { labelId: string }) => l.labelId === labelQuarantineId)?.unreadCount).toBe(1);

      // 6. Label filing & category updates
      // File unreadArchived1 with only labelBillsId
      await callerPrimary.mail.fileThreads({ threadIds: [unreadArchived1], labelId: labelBillsId });
      // @ts-expect-error unreadCounts
      const countsAfterFiling = await callerPrimary.mail.unreadCounts();
      expect(countsAfterFiling.labels.find((l: { labelId: string }) => l.labelId === labelBillsId)?.unreadCount).toBe(1);
      expect(countsAfterFiling.labels.find((l: { labelId: string }) => l.labelId === labelWorkId)?.unreadCount).toBe(0);

      // Renaming Quarantine label changes its predicate on next query
      await db.update(mailLabel)
        .set({ name: 'Quarantine-Archived' })
        .where(eq(mailLabel.id, labelQuarantineId));

      // @ts-expect-error unreadCounts
      const countsAfterRename = await callerPrimary.mail.unreadCounts();
      // Since it's no longer named Quarantine, it uses Archive predicate, but thread unreadSpam1 is in Spam!
      // So unreadCount should now be 0!
      expect(countsAfterRename.labels.find((l: { labelId: string }) => l.labelId === labelQuarantineId)?.unreadCount).toBe(0);
    });
  }, 60000);

  it('markFolderAsRead bulk marks folder/category/label threads as read', async () => {
    await withSeededTestDb(async (db) => {
      const primaryTransportId = TRANSPORT_ID;
      const unreadInboxA = `th-mfr-inbox-a-${Date.now()}`;
      const unreadInboxB = `th-mfr-inbox-b-${Date.now()}`;
      await seedInboxThread(db, {
        threadId: unreadInboxA,
        transportId: primaryTransportId,
        transportEmail: 'centurion@legacyhotels.co.za',
        isRead: false,
      });
      await seedInboxThread(db, {
        threadId: unreadInboxB,
        transportId: primaryTransportId,
        transportEmail: 'centurion@legacyhotels.co.za',
        isRead: false,
      });

      const callerPrimary = await callerFor(NAVA_USER_ID, {
        db,
        requestedTransportId: primaryTransportId,
      });

      // @ts-expect-error markFolderAsRead being tested
      const result = await callerPrimary.mail.markFolderAsRead({ folder: 'inbox' });
      expect(result.updated).toBeGreaterThanOrEqual(2);

      // @ts-expect-error unreadCounts
      const counts = await callerPrimary.mail.unreadCounts();
      const inboxFolder = counts.folders.find((f: { id: string }) => f.id === 'inbox');
      expect(inboxFolder?.unreadCount).toBe(0);
      expect(inboxFolder?.totalCount).toBeGreaterThanOrEqual(2);
    });
  }, 60000);
});

