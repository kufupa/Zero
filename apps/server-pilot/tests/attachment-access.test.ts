/**
 * Attachment access tests (negative).
 *
 * Strategy:
 *   - Seed inside the test transaction: a centurion message + attachment on
 *     `transport-centurion`, and a frontdesk message + attachment on
 *     `transport-frontdesk`.
 *   - user-frontdesk (active transport = frontdesk) must NOT be able to fetch
 *     the centurion attachment via `mail.getAttachment` — the route verifies
 *     the message's transportId == ctx.activeTransportId and throws NOT_FOUND.
 *   - user-frontdesk must NOT be able to list attachments for a centurion
 *     message via `mail.getMessageAttachments` / `mail.listAttachments`.
 *   - Sanity: user-manager (centurion owner) CAN fetch the centurion
 *     attachment (and gets a URL — synthetic in the test/fake path).
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  mailboxTransport,
  mailboxAccess,
  mailThread,
  message,
  attachment,
} from '../src/db/schema/mail.js';
import { user as userAuthTable } from '../src/db/schema/auth.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';

const reachable = await probeTestDb();

async function seedAttachmentFixture(db: import('../src/db/client.js').DB) {
  await db.insert(userAuthTable).values({
    id: 'user-frontdesk',
    name: 'Frontdesk',
    email: 'frontdesk@legacyhotel.com',
    emailVerified: true,
  }).onConflictDoNothing({ target: userAuthTable.email });

  await db.insert(mailboxTransport).values({
    id: 'transport-frontdesk',
    email: 'frontdesk@legacyhotel.com',
    ownerHeaderValue: 'frontdesk@legacyhotel.com',
    mailboxType: 'personal',
    displayName: 'Frontdesk Transport',
    isActive: true,
  }).onConflictDoNothing({ target: mailboxTransport.id });

  await db.insert(mailboxAccess).values({
    id: 'access-frontdesk-frontdesk',
    userId: 'user-frontdesk',
    transportId: 'transport-frontdesk',
    role: 'owner',
  }).onConflictDoNothing({ target: mailboxAccess.id });

  // Centurion thread + message + attachment.
  await db.insert(mailThread).values({
    id: 'thread-centurion-att',
    transportId: 'transport-centurion',
    threadRootId: 'centurion-att-root',
    subject: 'Centurion invoice',
    snippet: 'invoice attached',
    isArchived: false,
    isStarred: false,
    isRead: false,
    labelIds: [],
    latestMessageAt: new Date(),
  }).onConflictDoNothing({ target: mailThread.id });

  const centurionMessageId = 'msg-centurion-att';
  await db.insert(message).values({
    id: centurionMessageId,
    transportId: 'transport-centurion',
    threadId: 'thread-centurion-att',
    direction: 'inbound',
    fromAddress: 'guest@example.com',
    toAddresses: ['centurion@legacyhotel.com'],
    subject: 'Centurion invoice',
    textBody: 'see attached',
    receivedAt: new Date(),
  }).onConflictDoNothing({ target: message.id });

  const centurionAttachmentId = 'att-centurion-1';
  await db.insert(attachment).values({
    id: centurionAttachmentId,
    messageId: centurionMessageId,
    filename: 'centurion-invoice.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    s3Key: `attachments/${centurionMessageId}/000-centurion-invoice.pdf`,
  }).onConflictDoNothing({ target: attachment.id });

  // Frontdesk thread + message + attachment.
  await db.insert(mailThread).values({
    id: 'thread-frontdesk-att',
    transportId: 'transport-frontdesk',
    threadRootId: 'frontdesk-att-root',
    subject: 'Frontdesk memo',
    snippet: 'memo attached',
    isArchived: false,
    isStarred: false,
    isRead: true,
    labelIds: [],
    latestMessageAt: new Date(),
  }).onConflictDoNothing({ target: mailThread.id });

  const frontdeskMessageId = 'msg-frontdesk-att';
  await db.insert(message).values({
    id: frontdeskMessageId,
    transportId: 'transport-frontdesk',
    threadId: 'thread-frontdesk-att',
    direction: 'inbound',
    fromAddress: 'peer@legacyhotel.com',
    toAddresses: ['frontdesk@legacyhotel.com'],
    subject: 'Frontdesk memo',
    textBody: 'see memo',
    receivedAt: new Date(),
  }).onConflictDoNothing({ target: message.id });

  const frontdeskAttachmentId = 'att-frontdesk-1';
  await db.insert(attachment).values({
    id: frontdeskAttachmentId,
    messageId: frontdeskMessageId,
    filename: 'frontdesk-memo.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 512,
    s3Key: `attachments/${frontdeskMessageId}/000-frontdesk-memo.pdf`,
  }).onConflictDoNothing({ target: attachment.id });

  return {
    centurionMessageId,
    centurionAttachmentId,
    frontdeskMessageId,
    frontdeskAttachmentId,
  };
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'attachment access (seeded, transaction-rollback)',
  () => {
    it(
      'user without Centurion access cannot fetch a Centurion attachment',
      async () => {
        await withSeededTestDb(async (db) => {
          const ids = await seedAttachmentFixture(db);
          const caller = await callerFor('user-frontdesk', { db });
          await expect(
            caller.mail.getAttachment({
              messageId: ids.centurionMessageId,
              attachmentId: ids.centurionAttachmentId,
            }),
          ).rejects.toThrow(/NOT_FOUND/);
        });
      },
      30000,
    );

    it(
      'user without Centurion access cannot list attachments on a Centurion message',
      async () => {
        await withSeededTestDb(async (db) => {
          const ids = await seedAttachmentFixture(db);
          const caller = await callerFor('user-frontdesk', { db });
          await expect(
            caller.mail.getMessageAttachments({
              messageId: ids.centurionMessageId,
            }),
          ).rejects.toThrow(/NOT_FOUND/);
          await expect(
            caller.mail.listAttachments({
              messageId: ids.centurionMessageId,
            }),
          ).rejects.toThrow(/NOT_FOUND/);
        });
      },
      30000,
    );

    it(
      'Centurion owner can fetch their own Centurion attachment (returns a URL)',
      async () => {
        await withSeededTestDb(async (db) => {
          const ids = await seedAttachmentFixture(db);
          const caller = await callerFor('user-manager', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const result = await caller.mail.getAttachment({
            messageId: ids.centurionMessageId,
            attachmentId: ids.centurionAttachmentId,
          });
          expect(result.attachmentId).toBe(ids.centurionAttachmentId);
          expect(result.filename).toBe('centurion-invoice.pdf');
          expect(result.url).toBeTruthy();
        });
      },
      30000,
    );

    it(
      'user can list attachments on their own mailbox message',
      async () => {
        await withSeededTestDb(async (db) => {
          const ids = await seedAttachmentFixture(db);
          const caller = await callerFor('user-frontdesk', { db });
          const result = await caller.mail.getMessageAttachments({
            messageId: ids.frontdeskMessageId,
          });
          expect(result.attachments.length).toBe(1);
          expect(result.attachments[0]!.filename).toBe('frontdesk-memo.pdf');
        });
      },
      30000,
    );

    it(
      'user cannot fetch their own attachment via a foreign message id',
      async () => {
        // Even with a valid attachmentId on their own mailbox, passing a
        // foreign messageId must fail (the route checks the message belongs
        // to the caller's mailbox BEFORE looking up the attachment).
        await withSeededTestDb(async (db) => {
          const ids = await seedAttachmentFixture(db);
          const caller = await callerFor('user-frontdesk', { db });
          await expect(
            caller.mail.getAttachment({
              messageId: ids.centurionMessageId,
              attachmentId: ids.frontdeskAttachmentId,
            }),
          ).rejects.toThrow(/NOT_FOUND/);
        });
      },
      30000,
    );
  },
);

// Suppress unused import warning.
void randomUUID;
