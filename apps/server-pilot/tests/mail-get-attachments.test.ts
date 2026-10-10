/**
 * Regression: mail.get includes attachment metadata per message.
 */
import { describe, expect, it } from 'vitest';
import { mailThread, message, attachment } from '../src/db/schema/mail.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';

const reachable = await probeTestDb();

const THREAD_ID = 'thread-attach-regression-1';
const MSG_ID = 'msg-attach-regression-1';
const ATTACH_ID = 'attach-regression-1';

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'mail.get attachments (seeded, transaction-rollback)',
  () => {
    it(
      'returns attachment metadata on message',
      async () => {
        await withSeededTestDb(async (db) => {
          await db.insert(mailThread).values({
            id: THREAD_ID,
            transportId: 'transport-centurion',
            threadRootId: 'attach-root',
            subject: 'Attach regression',
            snippet: 'has attachment',
            isArchived: false,
            isStarred: false,
            isRead: true,
            labelIds: [],
            latestMessageAt: new Date(),
          });
          await db.insert(message).values({
            id: MSG_ID,
            transportId: 'transport-centurion',
            threadId: THREAD_ID,
            direction: 'inbound',
            fromAddress: 'guest@example.com',
            toAddresses: ['centurion@legacyhotel.com'],
            ccAddresses: [],
            bccAddresses: [],
            subject: 'Attach regression',
            textBody: 'body',
            messageIdHeader: 'attach-msg-1',
            references: [],
            isRead: true,
            isStarred: false,
            receivedAt: new Date(),
          });
          await db.insert(attachment).values({
            id: ATTACH_ID,
            messageId: MSG_ID,
            filename: 'invoice.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1234,
            s3Key: 'fixtures/invoice.pdf',
          });

          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const thread = await caller.mail.get({ id: THREAD_ID });
          const msg = thread.messages.find((m) => m.id === MSG_ID);
          expect(msg?.attachments).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                filename: 'invoice.pdf',
                mimeType: 'application/pdf',
                size: 1234,
              }),
            ]),
          );
        });
      },
      30000,
    );
  },
);
