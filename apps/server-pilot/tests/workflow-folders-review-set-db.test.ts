import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { __setDbForTests, type DB } from '../src/db/client.js';
import {
  mailActionLabel,
  mailboxTransport,
  mailThread,
  message,
} from '../src/db/schema/mail.js';
import { mailExtraction } from '../src/db/schema/work.js';
import type { MailAction } from '../src/mail/action-labels.js';
import {
  getWorkflowFolderSummary,
  getWorkflowFolderThread,
  listWorkflowFolderRows,
} from '../src/mail/workflow-folders.js';
import { appRouter } from '../src/trpc/router.js';
import { TEST_DB_AVAILABLE, withTestDb } from './helpers/test-db.js';

const TRANSPORT_ID = 'workflow-review-set-transport';
const OTHER_TRANSPORT_ID = 'workflow-review-set-other-transport';
const OWNER_ID = 'workflow-review-set-owner';

type AccessRole = 'owner' | 'admin' | 'member';

function caller(transportId = TRANSPORT_ID, accessRole: AccessRole = 'owner') {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: OWNER_ID, email: 'owner@example.invalid', name: 'Owner' },
    activeTransportId: transportId,
    transportEmail: 'fixture@example.invalid',
    accessRole,
  } as never);
}

async function withRouteDb<T>(db: DB, run: () => Promise<T>): Promise<T> {
  __setDbForTests({ db, conn: {} as never });
  try {
    return await run();
  } finally {
    __setDbForTests(null);
  }
}

async function seedTransport(db: DB, transportId = TRANSPORT_ID) {
  await db.insert(mailboxTransport).values({
    id: transportId,
    email: `${transportId}@example.invalid`,
    ownerHeaderValue: transportId,
    mailboxType: 'personal',
  });
}

async function seedThread(db: DB, threadId: string, transportId = TRANSPORT_ID, trashedAt?: Date) {
  await db.insert(mailThread).values({
    id: threadId,
    transportId,
    threadRootId: threadId,
    ...(trashedAt ? { trashedAt } : {}),
  });
}

async function seedMessage(
  db: DB,
  options: { messageId: string; threadId: string; transportId?: string; receivedAt?: Date },
) {
  await db.insert(message).values({
    id: options.messageId,
    transportId: options.transportId ?? TRANSPORT_ID,
    threadId: options.threadId,
    direction: 'inbound',
    fromAddress: 'fixture@example.invalid',
    ...(options.receivedAt ? { receivedAt: options.receivedAt } : {}),
  });
}

async function seedModelLabel(
  db: DB,
  options: {
    messageId: string;
    action: MailAction;
    version?: string;
    createdAt?: Date;
    transportId?: string;
  },
) {
  await db.insert(mailActionLabel).values({
    transportId: options.transportId ?? TRANSPORT_ID,
    messageId: options.messageId,
    source: 'model',
    action: options.action,
    needsAction: options.action !== 'no_action',
    version: options.version ?? 'model-v1',
    ...(options.createdAt ? { createdAt: options.createdAt, updatedAt: options.createdAt } : {}),
  });
}

describe.skipIf(!TEST_DB_AVAILABLE)('workflow folder review set (disposable PostgreSQL)', () => {
  it('lists model labels under their predicted action folders', async () => {
    await withTestDb(async (db) => {
      await seedTransport(db);
      await seedTransport(db, OTHER_TRANSPORT_ID);
      await seedThread(db, 'review-set-quote-thread');
      await seedMessage(db, { messageId: 'review-set-quote-message', threadId: 'review-set-quote-thread' });
      await seedModelLabel(db, {
        messageId: 'review-set-quote-message',
        action: 'quote_availability',
      });
      await seedThread(db, 'review-set-cancel-thread');
      await seedMessage(db, { messageId: 'review-set-cancel-message', threadId: 'review-set-cancel-thread' });
      await seedModelLabel(db, { messageId: 'review-set-cancel-message', action: 'cancel' });
      await seedThread(db, 'review-set-other-thread', OTHER_TRANSPORT_ID);
      await seedMessage(db, {
        messageId: 'review-set-other-message',
        threadId: 'review-set-other-thread',
        transportId: OTHER_TRANSPORT_ID,
      });
      await seedModelLabel(db, {
        messageId: 'review-set-other-message',
        action: 'quote_availability',
        transportId: OTHER_TRANSPORT_ID,
      });

      const quotes = await listWorkflowFolderRows(db, TRANSPORT_ID, 'quotes', 0, 10, {
        set: 'eval',
      });
      const cancellations = await listWorkflowFolderRows(
        db,
        TRANSPORT_ID,
        'cancellations',
        0,
        10,
        { set: 'eval' },
      );

      expect(quotes.rows).toHaveLength(1);
      expect(quotes.rows[0]).toMatchObject({
        sourceMessageId: 'review-set-quote-message',
        folder: 'quotes',
        predictedAction: 'quote_availability',
        ownerAction: null,
        markedAt: null,
      });
      expect(cancellations.rows[0]).toMatchObject({
        sourceMessageId: 'review-set-cancel-message',
        folder: 'cancellations',
        predictedAction: 'cancel',
      });
    });
  });

  it('lists and opens an eval message that is not the live thread message', async () => {
    await withTestDb(async (db) => {
      await seedTransport(db);
      const threadId = 'review-set-non-latest-thread';
      const earlierMessageId = 'review-set-earlier-message';
      const latestMessageId = 'review-set-latest-message';
      await seedThread(db, threadId);
      await seedMessage(db, {
        messageId: earlierMessageId,
        threadId,
        receivedAt: new Date('2026-10-12T10:00:00.000Z'),
      });
      await seedMessage(db, {
        messageId: latestMessageId,
        threadId,
        receivedAt: new Date('2026-10-12T11:00:00.000Z'),
      });
      await db.insert(mailExtraction).values({
        messageId: latestMessageId,
        extractorVersion: 'review-set-test-v1',
        status: 'succeeded',
        kind: 'booking',
        payload: {},
      });
      await seedModelLabel(db, { messageId: earlierMessageId, action: 'quote_availability' });

      const evalList = await listWorkflowFolderRows(db, TRANSPORT_ID, 'quotes', 0, 10, {
        set: 'eval',
      });
      const liveList = await listWorkflowFolderRows(db, TRANSPORT_ID, 'quotes', 0, 10);
      const thread = await getWorkflowFolderThread(db, {
        transportId: TRANSPORT_ID,
        folder: 'quotes',
        threadId,
        set: 'eval',
        messageId: earlierMessageId,
      });

      expect(evalList.rows.map((row) => row.sourceMessageId)).toContain(earlierMessageId);
      expect(liveList.rows).toHaveLength(0);
      expect(thread?.defaultMessageId).toBe(earlierMessageId);
    });
  });

  it('upserts owner marks without moving the row out of its predicted folder', async () => {
    await withTestDb(async (db) => {
      await seedTransport(db);
      const threadId = 'review-set-mark-thread';
      const messageId = 'review-set-mark-message';
      await seedThread(db, threadId);
      await seedMessage(db, { messageId, threadId });
      await seedModelLabel(db, { messageId, action: 'cancel' });

      await withRouteDb(db, async () => {
        await caller().workflowFolders.setActionLabel({ messageId, action: 'amend' });
      });
      const firstOwnerRows = await db
        .select()
        .from(mailActionLabel)
        .where(
          and(
            eq(mailActionLabel.messageId, messageId),
            eq(mailActionLabel.source, 'owner'),
            eq(mailActionLabel.version, 'owner'),
          ),
        );
      const firstId = firstOwnerRows[0]?.id;
      const firstList = await listWorkflowFolderRows(
        db,
        TRANSPORT_ID,
        'cancellations',
        0,
        10,
        { set: 'eval' },
      );
      expect(firstOwnerRows).toHaveLength(1);
      expect(firstOwnerRows[0]).toMatchObject({ action: 'amend', needsAction: true, labelledBy: OWNER_ID });
      expect(firstList.rows[0]).toMatchObject({
        folder: 'cancellations',
        predictedAction: 'cancel',
        ownerAction: 'amend',
      });

      await withRouteDb(db, async () => {
        await caller(TRANSPORT_ID, 'admin').workflowFolders.setActionLabel({
          messageId,
          action: 'no_action',
        });
      });
      const ownerRows = await db
        .select()
        .from(mailActionLabel)
        .where(
          and(
            eq(mailActionLabel.messageId, messageId),
            eq(mailActionLabel.source, 'owner'),
            eq(mailActionLabel.version, 'owner'),
          ),
        );
      const list = await listWorkflowFolderRows(db, TRANSPORT_ID, 'cancellations', 0, 10, {
        set: 'eval',
      });
      const summary = await getWorkflowFolderSummary(db, TRANSPORT_ID, { set: 'eval' });

      expect(ownerRows).toHaveLength(1);
      expect(ownerRows[0]).toMatchObject({
        id: firstId,
        action: 'no_action',
        needsAction: false,
        labelledBy: OWNER_ID,
      });
      expect(list.rows[0]).toMatchObject({
        folder: 'cancellations',
        predictedAction: 'cancel',
        ownerAction: 'no_action',
      });
      expect(summary.cancellations).toEqual({ total: 1, marked: 1 });
    });
  });

  it('puts unmarked rows before marked rows', async () => {
    await withTestDb(async (db) => {
      await seedTransport(db);
      const olderThreadId = 'review-set-unmarked-thread';
      const newerThreadId = 'review-set-marked-thread';
      const olderMessageId = 'review-set-unmarked-message';
      const newerMessageId = 'review-set-marked-message';
      await seedThread(db, olderThreadId);
      await seedMessage(db, {
        messageId: olderMessageId,
        threadId: olderThreadId,
        receivedAt: new Date('2026-10-12T09:00:00.000Z'),
      });
      await seedModelLabel(db, { messageId: olderMessageId, action: 'quote_availability' });
      await seedThread(db, newerThreadId);
      await seedMessage(db, {
        messageId: newerMessageId,
        threadId: newerThreadId,
        receivedAt: new Date('2026-10-12T12:00:00.000Z'),
      });
      await seedModelLabel(db, { messageId: newerMessageId, action: 'quote_availability' });
      await withRouteDb(db, async () => {
        await caller().workflowFolders.setActionLabel({ messageId: newerMessageId, action: 'amend' });
      });

      const list = await listWorkflowFolderRows(db, TRANSPORT_ID, 'quotes', 0, 10, {
        set: 'eval',
      });

      expect(list.rows.map((row) => row.sourceMessageId)).toEqual([
        olderMessageId,
        newerMessageId,
      ]);
    });
  });

  it('does not mix versions when a newer model run covers fewer messages', async () => {
    await withTestDb(async (db) => {
      await seedTransport(db);
      const threadId = 'review-set-partial-thread';
      await seedThread(db, threadId);
      await seedMessage(db, { messageId: 'review-set-partial-both', threadId });
      await seedMessage(db, { messageId: 'review-set-partial-v1-only', threadId });
      await seedModelLabel(db, {
        messageId: 'review-set-partial-both',
        action: 'cancel',
        version: 'v1',
        createdAt: new Date('2026-10-12T09:00:00.000Z'),
      });
      await seedModelLabel(db, {
        messageId: 'review-set-partial-v1-only',
        action: 'cancel',
        version: 'v1',
        createdAt: new Date('2026-10-12T09:00:00.000Z'),
      });
      await seedModelLabel(db, {
        messageId: 'review-set-partial-both',
        action: 'cancel',
        version: 'v2',
        createdAt: new Date('2026-10-12T10:00:00.000Z'),
      });

      const list = await listWorkflowFolderRows(db, TRANSPORT_ID, 'cancellations', 0, 10, {
        set: 'eval',
      });

      expect(list.rows.map((row) => row.sourceMessageId)).toEqual(['review-set-partial-both']);
    });
  });

  it('uses the newest model version by default and supports an explicit version', async () => {
    await withTestDb(async (db) => {
      await seedTransport(db);
      const threadId = 'review-set-versions-thread';
      const messageId = 'review-set-versions-message';
      await seedThread(db, threadId);
      await seedMessage(db, { messageId, threadId });
      await seedModelLabel(db, {
        messageId,
        action: 'quote_availability',
        version: 'v1',
        createdAt: new Date('2026-10-12T09:00:00.000Z'),
      });
      await seedModelLabel(db, {
        messageId,
        action: 'cancel',
        version: 'v2',
        createdAt: new Date('2026-10-12T10:00:00.000Z'),
      });

      const latest = await listWorkflowFolderRows(
        db,
        TRANSPORT_ID,
        'cancellations',
        0,
        10,
        { set: 'eval' },
      );
      const explicit = await listWorkflowFolderRows(db, TRANSPORT_ID, 'quotes', 0, 10, {
        set: 'eval',
        version: 'v1',
      });
      const summary = await getWorkflowFolderSummary(db, TRANSPORT_ID, { set: 'eval' });

      expect(latest.rows[0]?.predictedAction).toBe('cancel');
      expect(explicit.rows[0]?.predictedAction).toBe('quote_availability');
      expect(summary.cancellations.total).toBe(1);
      expect(summary.quotes.total).toBe(0);
    });
  });

  it('rejects member marks and hides messages from another transport', async () => {
    await withTestDb(async (db) => {
      await seedTransport(db);
      await seedTransport(db, OTHER_TRANSPORT_ID);
      const threadId = 'review-set-scope-thread';
      const otherThreadId = 'review-set-other-scope-thread';
      const messageId = 'review-set-scope-message';
      const otherMessageId = 'review-set-other-scope-message';
      await seedThread(db, threadId);
      await seedMessage(db, { messageId, threadId });
      await seedThread(db, otherThreadId, OTHER_TRANSPORT_ID);
      await seedMessage(db, {
        messageId: otherMessageId,
        threadId: otherThreadId,
        transportId: OTHER_TRANSPORT_ID,
      });

      await withRouteDb(db, async () => {
        await expect(
          caller(TRANSPORT_ID, 'member').workflowFolders.setActionLabel({
            messageId,
            action: 'amend',
          }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          caller().workflowFolders.setActionLabel({ messageId: otherMessageId, action: 'amend' }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      });
    });
  });

  it('omits model labels attached to trashed threads', async () => {
    await withTestDb(async (db) => {
      await seedTransport(db);
      const threadId = 'review-set-trashed-thread';
      const messageId = 'review-set-trashed-message';
      await seedThread(db, threadId, TRANSPORT_ID, new Date('2026-10-12T12:00:00.000Z'));
      await seedMessage(db, { messageId, threadId });
      await seedModelLabel(db, { messageId, action: 'quote_availability' });

      const list = await listWorkflowFolderRows(db, TRANSPORT_ID, 'quotes', 0, 10, {
        set: 'eval',
      });
      const summary = await getWorkflowFolderSummary(db, TRANSPORT_ID, { set: 'eval' });

      expect(list.rows).toHaveLength(0);
      expect(summary.quotes.total).toBe(0);
    });
  });
});
