import { mailboxTransport, mailThread, message } from '../src/db/schema/mail.js';
import { storedWorkFor, openStoredWork } from '../src/ai/work-items.js';
import { TEST_DB_AVAILABLE, withTestDb } from './helpers/test-db.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import type { DB } from '../src/db/client.js';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

const TRANSPORT_ID = 'work-items-existing-stay-db-transport';
const THREAD_ID = 'work-items-existing-stay-db-thread';
const MESSAGE_ID = 'work-items-existing-stay-db-message';
const INTERNET_MESSAGE_ID = '<work-items-existing-stay-db@example.invalid>';
const MAILBOX_ADDRESS = 'work-items-existing-stay-db@example.invalid';

async function seedExistingStayMail(db: DB) {
  await db.insert(mailboxTransport).values({
    id: TRANSPORT_ID,
    email: MAILBOX_ADDRESS,
    ownerHeaderValue: MAILBOX_ADDRESS,
    mailboxType: 'personal',
  });
  await db.insert(mailThread).values({
    id: THREAD_ID,
    transportId: TRANSPORT_ID,
    threadRootId: THREAD_ID,
    subject: 'Pre-arrival information for a confirmed stay',
  });
  await db.insert(message).values({
    id: MESSAGE_ID,
    transportId: TRANSPORT_ID,
    threadId: THREAD_ID,
    direction: 'inbound',
    fromAddress: MAILBOX_ADDRESS,
    toAddresses: [MAILBOX_ADDRESS],
    subject: 'Pre-arrival information for a confirmed stay',
    textBody: 'Synthetic pre-arrival information.',
    ownerHeaderValue: MAILBOX_ADDRESS,
    // Ingest stores the canonical id (no angle brackets, lower case); lookups canonicalize the header.
    messageIdHeader: 'work-items-existing-stay-db@example.invalid',
  });
  await db.insert(mailExtraction).values({
    messageId: MESSAGE_ID,
    extractorVersion: 'existing-stay-db-test-v1',
    status: 'succeeded',
    kind: 'booking',
    payload: {
      origin: 'person',
      contact: { name: null, email: null, phone: null },
      agency: null,
      endClient: null,
      confirmationNumbers: ['57291630-1'],
      stays: [],
      missing: [],
    },
  });
}

describe.skipIf(!TEST_DB_AVAILABLE)(
  'stored existing-stay information (disposable PostgreSQL)',
  () => {
    it('maps an old booking extraction to other and does not create a booking work item', async () => {
      await withTestDb(async (db) => {
        await seedExistingStayMail(db);
        const input = { transportId: TRANSPORT_ID, internetMessageId: INTERNET_MESSAGE_ID };

        const stored = await storedWorkFor(db, input);
        expect(stored).toMatchObject({
          status: 'ready',
          kind: 'other',
          existingStayInformation: true,
          confirmationNumbers: ['57291630-1'],
          workItemId: null,
        });

        const opened = await openStoredWork(db, input);
        expect(opened).toMatchObject({
          status: 'ready',
          kind: 'other',
          existingStayInformation: true,
          workItemId: null,
        });
        const items = await db
          .select({ id: workItem.id })
          .from(workItem)
          .where(
            and(eq(workItem.transportId, TRANSPORT_ID), eq(workItem.sourceMessageId, MESSAGE_ID)),
          );
        expect(items).toHaveLength(0);
      });
    });
  },
);
