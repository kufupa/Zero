/**
 * mail.send — fake SMTP transport + spoof rejection + outbound row storage.
 */
import { describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { mailThread, message } from '../src/db/schema/mail.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';
import {
  FakeSmtpTransport,
  __setSmtpTransportForTests,
} from '../src/mail/send/smtp.js';

const reachable = await probeTestDb();

const validCenturionReply = {
  threadId: 'thread-centurion-1',
  to: ['guest@example.com'],
  subject: 'Re: booking',
  html: '<p>Hello</p>',
  text: 'Hello',
};

async function seedCenturionThread(db: import('../src/db/client.js').DB) {
  await db
    .insert(mailThread)
    .values({
      id: 'thread-centurion-1',
      transportId: 'transport-centurion',
      threadRootId: 'centurion-root-1',
      subject: 'Centurion booking #4471',
      snippet: 'Original booking inquiry',
      isArchived: false,
      isStarred: false,
      isRead: false,
      labelIds: [],
      latestMessageAt: new Date(),
    })
    .onConflictDoNothing({ target: mailThread.id });

  await db
    .insert(message)
    .values({
      id: 'msg-centurion-inbound-1',
      transportId: 'transport-centurion',
      threadId: 'thread-centurion-1',
      direction: 'inbound',
      fromAddress: 'guest@example.com',
      toAddresses: ['centurion@legacyhotel.com'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'Centurion booking #4471',
      textBody: 'I need a room',
      messageIdHeader: 'inbound-msg-id-1',
      references: [],
      isRead: false,
      isStarred: false,
      receivedAt: new Date(),
    })
    .onConflictDoNothing({ target: message.id });
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('mail.send', () => {
  it('rejects spoofed from address', async () => {
    await withSeededTestDb(async (db) => {
      await seedCenturionThread(db);
      const caller = await callerFor('user-centurion-worker', { db });
      await expect(
        caller.mail.send({
          ...validCenturionReply,
          fromEmail: 'frontdesk@legacyhotel.com',
        }),
      ).rejects.toThrow(/FORBIDDEN/);
    });
  }, 30000);

  it('rejects CRLF injection in recipients before SMTP', async () => {
    await withSeededTestDb(async (db) => {
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      try {
        await seedCenturionThread(db);
        const caller = await callerFor('user-centurion-worker', { db });
        await expect(
          caller.mail.send({
            ...validCenturionReply,
            to: ['a@b.com\r\nBCC: evil@x.com'],
          }),
        ).rejects.toThrow(/BAD_REQUEST/);
        expect(fake.sent).toHaveLength(0);
        const outbound = await db
          .select()
          .from(message)
          .where(eq(message.direction, 'outbound'));
        expect(outbound).toHaveLength(0);
      } finally {
        __setSmtpTransportForTests(null);
      }
    });
  }, 30000);

  it('sends from selected mailbox and stores outbound row', async () => {
    await withSeededTestDb(async (db) => {
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      try {
        await seedCenturionThread(db);
        const caller = await callerFor('user-centurion-worker', { db });
        const result = await caller.mail.send(validCenturionReply);
        expect(result.fromEmail).toBe('centurion@legacyhotel.com');
        expect(result.messageId).toBeTruthy();
        expect(result.sent).toBe(true);

        const rows = await db
          .select()
          .from(message)
          .where(
            and(
              eq(message.id, result.messageId),
              eq(message.transportId, 'transport-centurion'),
            ),
          );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.direction).toBe('outbound');
        expect(rows[0]!.fromAddress).toBe('centurion@legacyhotel.com');
        expect(rows[0]!.messageIdHeader).toBeTruthy();
        expect(rows[0]!.inReplyTo).toBe('inbound-msg-id-1');
        expect(rows[0]!.references).toContain('inbound-msg-id-1');

        expect(fake.sent).toHaveLength(1);
        expect(fake.sent[0]!.from).toBe('centurion@legacyhotel.com');
        expect(fake.sent[0]!.inReplyTo).toBe('inbound-msg-id-1');
        expect(fake.sent[0]!.extraHeaders).toEqual({
          'X-Zero-Mailbox': 'centurion@legacyhotel.com',
        });
      } finally {
        __setSmtpTransportForTests(null);
      }
    });
  }, 30000);

  it('stamps X-Zero-Mailbox from the active Nava transport', async () => {
    await withSeededTestDb(async (db) => {
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      try {
        const caller = await callerFor('user-nava', {
          db,
          requestedTransportId: 'transport-nava',
        });
        const result = await caller.mail.send({
          to: ['nava@legacyhotel.com'],
          subject: 'loopback',
          html: '<p>loopback</p>',
          text: 'loopback',
        });

        expect(result.fromEmail).toBe('nava@legacyhotel.com');
        expect(fake.sent).toHaveLength(1);
        expect(fake.sent[0]!.extraHeaders).toEqual({
          'X-Zero-Mailbox': 'nava@legacyhotel.com',
        });
      } finally {
        __setSmtpTransportForTests(null);
      }
    });
  }, 30000);
});
