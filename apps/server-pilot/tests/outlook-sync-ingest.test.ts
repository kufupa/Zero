import {
  aiWorkflowRun,
  attachment,
  mailCategory,
  mailLabel,
  mailLiveAdmission,
  mailThread,
  mailThreadCategory,
  message,
} from '../src/db/schema/mail.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

const input = (id = 'source-one') => ({
  transportId: 'transport-centurion',
  sourceObservationId: id,
  semanticVersion: 'v1',
  direction: 'inbound' as const,
  internetMessageId: `${id}@example.test`,
  fromAddress: 'guest@example.test',
  toAddresses: ['centurion@legacyhotels.co.za'],
  ccAddresses: [],
  bccAddresses: [],
  subject: 'Historical reservation',
  textBody: 'Historical searchable body',
  htmlBody: '<p>History</p>',
  authoredAt: new Date('2026-09-08T10:00:00Z'),
  sentAt: null,
  inReplyTo: null as string | null,
  references: [] as string[],
  originalMsgKey: `outlook-sync-originals/v1/source/${id}.msg`,
  attachments: [
    {
      sourceAttachmentId: '0',
      filename: 'same.txt',
      mimeType: 'text/plain',
      sizeBytes: 3,
      sha256: 'a'.repeat(64),
      s3Key: `outlook-sync-originals/v1/source/${id}/0`,
      contentId: 'image',
      isInline: true,
    },
  ],
  sourceProvenance: { read: false, categories: ['Outlook only'] },
});

describe('side-effect-free Outlook history on PostgreSQL', () => {
  it('retains history and attachments as searchable context without operational work', async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const result = await persistOutlookHistory(db, input());
      const [saved] = await db.select().from(message).where(eq(message.id, result.messageId));
      const [thread] = await db.select().from(mailThread).where(eq(mailThread.id, result.threadId));
      expect(saved).toMatchObject({
        isRead: true,
        historyOnly: true,
        rawMimeS3Key: null,
        receivedAt: input().authoredAt,
      });
      expect(thread).toMatchObject({ isRead: true, historyOnly: true, labelIds: [], spamAt: null });
      expect(thread?.createdAt.getTime()).toBeGreaterThan(input().authoredAt.getTime());
      expect(await db.select().from(aiWorkflowRun)).toHaveLength(0);
      expect(await db.select().from(attachment)).toMatchObject([
        { filename: 'same.txt', contentId: 'image', isInline: true },
      ]);
      const retried = await persistOutlookHistory(db, input());
      expect(retried.messageId).toBe(result.messageId);
      expect(await db.select().from(attachment)).toHaveLength(1);
    }));
  it('never changes read, labels, spam, workflow or original MIME when enriching active mail', async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const first = await persistOutlookHistory(db, input());
      await db
        .update(mailThread)
        .set({
          historyOnly: false,
          isRead: false,
          labelIds: ['staff'],
          spamAt: new Date('2026-10-01T00:00:00Z'),
        })
        .where(eq(mailThread.id, first.threadId));
      await db
        .update(message)
        .set({ historyOnly: false, isRead: false, rawMimeS3Key: 'raw-mime/original.eml' })
        .where(eq(message.id, first.messageId));
      const before = await db.select().from(mailThread);
      const richer = await persistOutlookHistory(db, {
        ...input('twin'),
        internetMessageId: input().internetMessageId,
        attachments: [
          ...input('twin').attachments,
          {
            ...input('twin').attachments[0]!,
            sourceAttachmentId: '1',
            s3Key: 'outlook-sync-originals/v1/source/twin/1',
            contentId: 'richer-inline-variant',
          },
        ],
      });
      expect(richer.messageId).toBe(first.messageId);
      expect(await db.select().from(mailThread)).toEqual(before);
      expect((await db.select().from(message))[0]).toMatchObject({
        isRead: false,
        rawMimeS3Key: 'raw-mime/original.eml',
      });
      expect(await db.select().from(aiWorkflowRun)).toHaveLength(0);
      const retained = await db.select().from(attachment);
      expect(retained).toHaveLength(2);
      expect(retained.map((item) => item.contentId).sort()).toEqual([
        'image',
        'richer-inline-variant',
      ]);
    }));
  it('repairs child-before-parent reference links only among history-only threads', async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const child = await persistOutlookHistory(db, {
        ...input('child'),
        inReplyTo: 'parent@example.test',
        references: ['parent@example.test'],
      });
      const parent = await persistOutlookHistory(db, input('parent'));
      const [saved] = await db.select().from(message).where(eq(message.id, child.messageId));
      expect(saved?.threadId).toBe(parent.threadId);
    }));
  it('excludes historical-only threads from active work while preserving search access', async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { buildMailFolderConditions } = await import('../src/mail/folder-semantics.js');
      const { and } = await import('drizzle-orm');
      await persistOutlookHistory(db, input());
      expect(
        await db
          .select()
          .from(mailThread)
          .where(and(...buildMailFolderConditions(db, 'transport-centurion', 'inbox'))),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(mailThread)
          .where(and(...buildMailFolderConditions(db, 'transport-centurion', 'all'))),
      ).toHaveLength(1);
    }));
  it('retains distinct attachments sharing a filename and accepts safe bigint sizes', async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      await persistOutlookHistory(db, {
        ...input(),
        attachments: [
          input().attachments[0]!,
          {
            ...input().attachments[0]!,
            sourceAttachmentId: '1',
            sizeBytes: 2 ** 32,
            s3Key: 'outlook-sync-originals/v1/source/1',
            sha256: 'b'.repeat(64),
          },
        ],
      });
      expect(
        (await db.select().from(attachment)).map((x) => x.sizeBytes).sort((a, b) => a - b),
      ).toEqual([3, 2 ** 32]);
    }));
});

it('retries missing-ID source observations without merging distinct template messages', async () =>
  withIngestionDb(async ({ db }) => {
    const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
    const first = await persistOutlookHistory(db, { ...input('one'), internetMessageId: null });
    const repeat = await persistOutlookHistory(db, { ...input('one'), internetMessageId: null });
    const different = await persistOutlookHistory(db, { ...input('two'), internetMessageId: null });
    expect(repeat.messageId).toBe(first.messageId);
    expect(different.messageId).not.toBe(first.messageId);
    expect(await db.select().from(message)).toHaveLength(2);
  }));

it(
  'a newer same-source historical content version updates searchable projections without old work replay',
  async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const first = await persistOutlookHistory(db, {
        ...input('edited'),
        sourceId: 'source-one',
        semanticVersion: '1',
      });
      const before = (await db.select().from(message).where(eq(message.id, first.messageId)))[0]!;
      const updated = await persistOutlookHistory(db, {
        ...input('edited'),
        sourceId: 'source-one',
        semanticVersion: '2',
        textBody: 'UPDATED HISTORICAL CONTENT',
        htmlBody: '<p>Updated</p>',
        originalMsgKey: 'outlook-sync-originals/v1/source/edited-v2.msg',
      });
      expect(updated.messageId).toBe(first.messageId);
      const saved = (await db.select().from(message).where(eq(message.id, first.messageId)))[0]!;
      expect(saved.textBody).toBe('UPDATED HISTORICAL CONTENT');
      expect(saved).toMatchObject({
        isRead: before.isRead,
        historyOnly: true,
        receivedAt: before.receivedAt,
        sentAt: before.sentAt,
        originalMsgS3Key: before.originalMsgS3Key,
      });
      await persistOutlookHistory(db, {
        ...input('edited'),
        sourceId: 'source-one',
        semanticVersion: '1',
        textBody: 'OLDER RETRY',
      });
      expect(
        (await db.select().from(message).where(eq(message.id, first.messageId)))[0]!.textBody,
      ).toBe('UPDATED HISTORICAL CONTENT');
      expect(await db.select().from(aiWorkflowRun)).toHaveLength(0);
    }),
  20000,
);

it.each(['inbound', 'outbound'] as const)(
  'historical %s references preserve operational opposite-direction folder membership and counts',
  async (historicalDirection) =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { buildMailFolderConditions } = await import('../src/mail/folder-semantics.js');
      const { loadUnreadCounts } = await import('../src/mail/folder-unread-counts.js');
      const operationalDirection = historicalDirection === 'inbound' ? 'outbound' : 'inbound';
      const originalFolder = operationalDirection === 'inbound' ? 'inbox' : 'sent';
      const historicalFolder = historicalDirection === 'inbound' ? 'inbox' : 'sent';
      const threadId = `operational-${operationalDirection}`;
      const parentId = `parent-${operationalDirection}@example.test`;
      await db.insert(mailThread).values({
        id: threadId,
        transportId: 'transport-centurion',
        threadRootId: parentId,
        historyOnly: false,
        isRead: false,
        isArchived: false,
        latestMessageAt: new Date('2026-10-04T10:00:00Z'),
      });
      await db.insert(message).values({
        id: `operational-${operationalDirection}`,
        transportId: 'transport-centurion',
        threadId,
        direction: operationalDirection,
        historyOnly: false,
        isRead: false,
        messageIdHeader: parentId,
        fromAddress:
          operationalDirection === 'inbound'
            ? 'guest@example.test'
            : 'centurion@legacyhotels.co.za',
        toAddresses:
          operationalDirection === 'inbound'
            ? ['centurion@legacyhotels.co.za']
            : ['guest@example.test'],
        subject: 'Existing operational thread',
        textBody: 'Operational parent',
        receivedAt: new Date('2026-10-04T10:00:00Z'),
        sentAt: operationalDirection === 'outbound' ? new Date('2026-10-04T10:00:00Z') : null,
      });
      const list = (folder: 'inbox' | 'sent' | 'all') =>
        db
          .select({ id: mailThread.id })
          .from(mailThread)
          .where(and(...buildMailFolderConditions(db, 'transport-centurion', folder)));
      await db.insert(mailCategory).values({
        id: 'existing-category',
        transportId: 'transport-centurion',
        name: 'Existing category',
        slug: 'existing-category',
      });
      await db.insert(mailThreadCategory).values({
        threadId,
        categoryId: 'existing-category',
        transportId: 'transport-centurion',
      });
      const beforeThread = await db.select().from(mailThread).where(eq(mailThread.id, threadId));
      const beforeCounts = await loadUnreadCounts(db, 'transport-centurion');
      expect(await list(originalFolder)).toEqual([{ id: threadId }]);
      expect(await list(historicalFolder)).toEqual([]);
      const saved = await persistOutlookHistory(db, {
        ...input(`history-${historicalDirection}`),
        direction: historicalDirection,
        fromAddress:
          historicalDirection === 'inbound' ? 'guest@example.test' : 'centurion@legacyhotels.co.za',
        toAddresses:
          historicalDirection === 'inbound'
            ? ['centurion@legacyhotels.co.za']
            : ['guest@example.test'],
        sentAt: historicalDirection === 'outbound' ? input().authoredAt : null,
        inReplyTo: parentId,
        references: [parentId],
      });
      expect(saved.threadId).toBe(threadId);
      expect(
        (await db.select().from(message).where(eq(message.id, saved.messageId)))[0],
      ).toMatchObject({
        threadId,
        direction: historicalDirection,
        historyOnly: true,
        isRead: true,
        textBody: 'Historical searchable body',
      });
      expect(await list(originalFolder)).toEqual([{ id: threadId }]);
      expect.soft(await list(historicalFolder)).toEqual([]);
      expect(await list('all')).toEqual([{ id: threadId }]);
      const afterCounts = await loadUnreadCounts(db, 'transport-centurion');
      expect(afterCounts.folders).toEqual(beforeCounts.folders);
      expect(afterCounts.categories).toEqual(beforeCounts.categories);
      expect(afterCounts.folders.find((f) => f.id === originalFolder)).toMatchObject({
        unreadCount: 1,
        totalCount: 1,
      });
      expect(afterCounts.folders.find((f) => f.id === historicalFolder)).toMatchObject({
        unreadCount: 0,
        totalCount: 0,
      });
      const afterThread = (
        await db.select().from(mailThread).where(eq(mailThread.id, threadId))
      )[0]!;
      expect(afterThread).toMatchObject({
        isRead: beforeThread[0]!.isRead,
        historyOnly: false,
        latestMessageAt: beforeThread[0]!.latestMessageAt,
        labelIds: beforeThread[0]!.labelIds,
        spamAt: beforeThread[0]!.spamAt,
      });
      expect(await db.select().from(mailLiveAdmission)).toHaveLength(0);
      expect(await db.select().from(aiWorkflowRun)).toHaveLength(0);
    }),
  20_000,
);

it('counts staff-archived historical threads consistently without unread or active work', async () =>
  withIngestionDb(async ({ db }) => {
    const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
    const { buildMailFolderConditions } = await import('../src/mail/folder-semantics.js');
    const { loadUnreadCounts } = await import('../src/mail/folder-unread-counts.js');
    const saved = await persistOutlookHistory(db, input('staff-archived-history'));
    await db.insert(mailCategory).values({
      id: 'historical-category',
      transportId: 'transport-centurion',
      name: 'Historical category',
      slug: 'historical-category',
    });
    await db.insert(mailThreadCategory).values({
      threadId: saved.threadId,
      categoryId: 'historical-category',
      transportId: 'transport-centurion',
    });
    expect((await loadUnreadCounts(db, 'transport-centurion')).categories).toEqual([
      { categoryId: 'historical-category', unreadCount: 0, totalCount: 0 },
    ]);
    await db.update(mailThread).set({ isArchived: true }).where(eq(mailThread.id, saved.threadId));
    const archived = await db
      .select({ id: mailThread.id })
      .from(mailThread)
      .where(and(...buildMailFolderConditions(db, 'transport-centurion', 'archive')));
    expect(archived).toEqual([{ id: saved.threadId }]);
    const counts = await loadUnreadCounts(db, 'transport-centurion');
    expect(counts.folders.find((folder) => folder.id === 'archive')).toMatchObject({
      totalCount: archived.length,
      unreadCount: 0,
    });
    expect(counts.folders.find((folder) => folder.id === 'inbox')).toMatchObject({
      totalCount: 0,
      unreadCount: 0,
    });
    expect(await db.select().from(mailLiveAdmission)).toHaveLength(0);
    expect(await db.select().from(aiWorkflowRun)).toHaveLength(0);
  }));

it('keeps staff-moved historical mail out of Bin, Spam and Quarantine list totals', async () =>
  withIngestionDb(async ({ db }) => {
    const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
    const { buildMailFolderConditions } = await import('../src/mail/folder-semantics.js');
    const { loadUnreadCounts } = await import('../src/mail/folder-unread-counts.js');
    await db.insert(mailLabel).values({
      id: 'quarantine-label',
      transportId: 'transport-centurion',
      name: 'Quarantine',
    });
    for (const folder of ['bin', 'spam'] as const) {
      const saved = await persistOutlookHistory(db, input(`staff-moved-history-${folder}`));
      await db
        .update(mailThread)
        .set({
          trashedAt: folder === 'bin' ? new Date() : null,
          spamAt: folder === 'spam' ? new Date() : null,
          labelIds: folder === 'spam' ? ['quarantine-label'] : [],
        })
        .where(eq(mailThread.id, saved.threadId));
      const visible = await db
        .select({ id: mailThread.id })
        .from(mailThread)
        .where(and(...buildMailFolderConditions(db, 'transport-centurion', folder)));
      expect(visible).toEqual([]);
      const counts = await loadUnreadCounts(db, 'transport-centurion');
      expect.soft(counts.folders.find((item) => item.id === folder)).toMatchObject({
        totalCount: visible.length,
        unreadCount: 0,
      });
      expect.soft(counts.labels.find((item) => item.labelId === 'quarantine-label')).toMatchObject({
        totalCount: 0,
        unreadCount: 0,
      });
    }
  }));
