import { describe, expect, it } from 'vitest';
import {
  mailCategory,
  mailThread,
  mailThreadCategory,
  mailboxTransport,
  message,
} from '../src/db/schema/mail.js';
import { mailExtraction, workEvent, workItem } from '../src/db/schema/work.js';
import {
  GOLD_REVIEW_SINCE,
  GOLD_REVIEW_UNTIL,
  getWorkflowFolderSummary,
  getWorkflowFolderThread,
  listWorkflowFolderRows,
} from '../src/mail/workflow-folders.js';
import type { DB } from '../src/db/client.js';
import { TEST_DB_AVAILABLE, withTestDb } from './helpers/test-db.js';

const TRANSPORT_ID = 'workflow-folders-db-transport';

async function seedStaffOutbound(
  db: DB,
  options: { threadId: string; inboundMessageId: string },
) {
  await db.insert(message).values({
    id: `${options.inboundMessageId}-staff-out`,
    transportId: TRANSPORT_ID,
    threadId: options.threadId,
    direction: 'outbound',
    fromAddress: 'staff@example.invalid',
    subject: 'Re: handled',
    textBody: 'Booking amended as requested.',
  });
}

async function seedWorkflowThread(
  db: DB,
  options: {
    threadId: string;
    messageId: string;
    kind: string;
    automatedChannel?: boolean;
    staffEvidence?: boolean;
    receivedAt?: Date;
  },
) {
  await db.insert(mailboxTransport).values({
    id: TRANSPORT_ID,
    email: 'workflow-folders-db@example.invalid',
    ownerHeaderValue: 'workflow-folders-db@example.invalid',
    mailboxType: 'personal',
  });
  await db.insert(mailThread).values({
    id: options.threadId,
    transportId: TRANSPORT_ID,
    threadRootId: options.threadId,
    subject: 'Synthetic workflow-folder fixture',
  });
  await db.insert(message).values({
    id: options.messageId,
    transportId: TRANSPORT_ID,
    threadId: options.threadId,
    direction: 'inbound',
    fromAddress: 'workflow-folders-db@example.invalid',
    subject: 'Synthetic workflow-folder fixture',
    receivedAt: options.receivedAt ?? new Date('2026-10-05T10:00:00.000Z'),
  });
  await db.insert(mailExtraction).values({
    messageId: options.messageId,
    extractorVersion: 'workflow-folders-db-test-v1',
    status: 'succeeded',
    kind: options.kind,
    payload: { contact: { name: 'Synthetic Guest' } },
  });

  if (options.staffEvidence !== false) {
    await seedStaffOutbound(db, { threadId: options.threadId, inboundMessageId: options.messageId });
  }

  if (options.automatedChannel) {
    await db.insert(mailCategory).values({
      id: 'workflow-folders-db-automated-channel',
      transportId: TRANSPORT_ID,
      slug: 'automated-channel',
      name: 'Automated channel',
    });
    await db.insert(mailThreadCategory).values({
      threadId: options.threadId,
      categoryId: 'workflow-folders-db-automated-channel',
      transportId: TRANSPORT_ID,
    });
  }
}

describe.skipIf(!TEST_DB_AVAILABLE)('workflow folders (disposable PostgreSQL)', () => {
  it('hides an inbound with no staff outbound artefact', async () => {
    await withTestDb(async (db) => {
      await seedWorkflowThread(db, {
        threadId: 'workflow-folders-db-no-evidence-thread',
        messageId: 'workflow-folders-db-no-evidence-message',
        kind: 'quote',
        staffEvidence: false,
      });

      const result = await listWorkflowFolderRows(db, TRANSPORT_ID, 'quotes', 0, 10);
      expect(result.rows).toHaveLength(0);
    });
  });

  it('hides a handled inbound before Mon 28 Sep 08:00 SAST', async () => {
    await withTestDb(async (db) => {
      await seedWorkflowThread(db, {
        threadId: 'workflow-folders-db-before-window-thread',
        messageId: 'workflow-folders-db-before-window-message',
        kind: 'quote',
        receivedAt: new Date(GOLD_REVIEW_SINCE.getTime() - 60_000),
      });

      const result = await listWorkflowFolderRows(db, TRANSPORT_ID, 'quotes', 0, 10);
      expect(result.rows).toHaveLength(0);
    });
  });

  it('hides a handled inbound after Fri 16 Oct 16:00 SAST', async () => {
    await withTestDb(async (db) => {
      await seedWorkflowThread(db, {
        threadId: 'workflow-folders-db-after-window-thread',
        messageId: 'workflow-folders-db-after-window-message',
        kind: 'quote',
        receivedAt: new Date(GOLD_REVIEW_UNTIL.getTime() + 60_000),
      });

      const result = await listWorkflowFolderRows(db, TRANSPORT_ID, 'quotes', 0, 10);
      expect(result.rows).toHaveLength(0);
    });
  });

  it('keeps an inbound when staff only sent a text reply (amend/cancel shape)', async () => {
    await withTestDb(async (db) => {
      await seedWorkflowThread(db, {
        threadId: 'workflow-folders-db-text-out-thread',
        messageId: 'workflow-folders-db-text-out-message',
        kind: 'amendment',
        staffEvidence: false,
      });
      await seedStaffOutbound(db, {
        threadId: 'workflow-folders-db-text-out-thread',
        inboundMessageId: 'workflow-folders-db-text-out-message',
      });

      const result = await listWorkflowFolderRows(db, TRANSPORT_ID, 'amendments', 0, 10);
      expect(result.rows).toHaveLength(1);
    });
  });

  it('lists a succeeded extraction in the folder mapped from its kind', async () => {
    await withTestDb(async (db) => {
      const threadId = 'workflow-folders-db-quote-thread';
      await seedWorkflowThread(db, {
        threadId,
        messageId: 'workflow-folders-db-quote-message',
        kind: 'quote',
      });

      const result = await listWorkflowFolderRows(db, TRANSPORT_ID, 'quotes', 0, 10);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ threadId, folder: 'quotes', kind: 'quote' });
    });
  });

  it('routes a thread tagged automated-channel to Not for Nava', async () => {
    await withTestDb(async (db) => {
      const threadId = 'workflow-folders-db-channel-thread';
      await seedWorkflowThread(db, {
        threadId,
        messageId: 'workflow-folders-db-channel-message',
        kind: 'booking',
        automatedChannel: true,
      });

      const result = await listWorkflowFolderRows(db, TRANSPORT_ID, 'not-for-nava', 0, 10);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ threadId, folder: 'not-for-nava', kind: 'booking' });
    });
  });

  it('loads the summary and thread details without SQL errors', async () => {
    await withTestDb(async (db) => {
      const threadId = 'workflow-folders-db-detail-thread';
      const messageId = 'workflow-folders-db-detail-message';
      await seedWorkflowThread(db, { threadId, messageId, kind: 'quote' });

      const summary = await getWorkflowFolderSummary(db, TRANSPORT_ID);
      const thread = await getWorkflowFolderThread(db, {
        transportId: TRANSPORT_ID,
        folder: 'quotes',
        threadId,
      });

      expect(summary.quotes.threads).toBe(1);
      expect(thread?.defaultMessageId).toBe(messageId);
      expect(thread?.messages[0]?.messageId).toBe(messageId);
    });
  });

  it('counts a saved review of the shown extraction in the summary and list', async () => {
    await withTestDb(async (db) => {
      const threadId = 'workflow-folders-db-review-thread';
      const messageId = 'workflow-folders-db-review-message';
      await seedWorkflowThread(db, { threadId, messageId, kind: 'quote' });
      const [extraction] = await db.select({ id: mailExtraction.id }).from(mailExtraction);
      const [item] = await db
        .insert(workItem)
        .values({ transportId: TRANSPORT_ID, threadId, sourceMessageId: messageId, kind: 'quote' })
        .returning({ id: workItem.id });
      await db.insert(workEvent).values({
        workItemId: item!.id,
        actorKind: 'user',
        type: 'admin_review',
        value: { decision: 'wrong' },
        evidence: { sourceMessageId: messageId, extractionId: extraction!.id, kind: 'quote', action: null },
      });

      const summary = await getWorkflowFolderSummary(db, TRANSPORT_ID);
      const list = await listWorkflowFolderRows(db, TRANSPORT_ID, 'quotes', 0, 10);

      expect(summary.quotes).toMatchObject({ threads: 1, reviewedWrong: 1, reviewedRight: 0 });
      expect(list.rows[0]?.review?.decision).toBe('wrong');
    });
  });
});
