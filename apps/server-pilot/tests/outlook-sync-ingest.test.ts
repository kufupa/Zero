import { aiWorkflowRun, attachment, mailThread, message } from '../src/db/schema/mail.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

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
      expect(await db.select().from(attachment)).toHaveLength(3);
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
