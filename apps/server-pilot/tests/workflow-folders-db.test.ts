import { describe, expect, it } from 'vitest';
import {
  mailCategory,
  mailThread,
  mailThreadCategory,
  mailboxTransport,
  message,
} from '../src/db/schema/mail.js';
import { mailExtraction } from '../src/db/schema/work.js';
import {
  getWorkflowFolderSummary,
  getWorkflowFolderThread,
  listWorkflowFolderRows,
} from '../src/mail/workflow-folders.js';
import type { DB } from '../src/db/client.js';
import { TEST_DB_AVAILABLE, withTestDb } from './helpers/test-db.js';

const TRANSPORT_ID = 'workflow-folders-db-transport';

async function seedWorkflowThread(
  db: DB,
  options: { threadId: string; messageId: string; kind: string; automatedChannel?: boolean },
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
  });
  await db.insert(mailExtraction).values({
    messageId: options.messageId,
    extractorVersion: 'workflow-folders-db-test-v1',
    status: 'succeeded',
    kind: options.kind,
    payload: { contact: { name: 'Synthetic Guest' } },
  });

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
});
