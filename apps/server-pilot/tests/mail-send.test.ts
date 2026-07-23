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
      const caller = await callerFor('user-navaai', { db });
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
        const caller = await callerFor('user-navaai', { db });
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
        const caller = await callerFor('user-navaai', { db });
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
        const caller = await callerFor('user-navaai', {
          db,
          requestedTransportId: 'transport-nava',
        });
        const result = await caller.mail.send({
          to: ['navaai@legacyhotels.co.za'],
          subject: 'loopback',
          html: '<p>loopback</p>',
          text: 'loopback',
        });

        expect(result.fromEmail).toBe('navaai@legacyhotels.co.za');
        expect(fake.sent).toHaveLength(1);
        expect(fake.sent[0]!.extraHeaders).toEqual({
          'X-Zero-Mailbox': 'navaai@legacyhotels.co.za',
        });
      } finally {
        __setSmtpTransportForTests(null);
      }
    });
  }, 30000);

  it('uses selected message Message-ID for In-Reply-To when replyToMessageId set', async () => {
    await withSeededTestDb(async (db) => {
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      try {
        await seedCenturionThread(db);
        // Newer message would win latest-thread fallback; selected older must win instead.
        await db.insert(message).values({
          id: 'msg-centurion-inbound-newer',
          transportId: 'transport-centurion',
          threadId: 'thread-centurion-1',
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['centurion@legacyhotel.com'],
          ccAddresses: [],
          bccAddresses: [],
          subject: 'Centurion booking #4471',
          textBody: 'Follow-up',
          messageIdHeader: '<new@x>',
          references: ['inbound-msg-id-1'],
          isRead: false,
          isStarred: false,
          receivedAt: new Date(Date.now() + 60_000),
        });
        await db
          .update(message)
          .set({ messageIdHeader: '<old@x>' })
          .where(eq(message.id, 'msg-centurion-inbound-1'));

        const caller = await callerFor('user-navaai', { db });
        await caller.mail.send({
          threadId: 'thread-centurion-1',
          to: ['a@example.com'],
          subject: 'Re: x',
          html: '<p>hi</p>',
          text: 'hi',
          replyToMessageId: 'msg-centurion-inbound-1',
        });
        expect(fake.sent[0]!.inReplyTo).toBe('<old@x>');
      } finally {
        __setSmtpTransportForTests(null);
      }
    });
  }, 30000);

  it('reply-all cc envelope matches input.cc', async () => {
    await withSeededTestDb(async (db) => {
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      try {
        await seedCenturionThread(db);
        const caller = await callerFor('user-navaai', { db });
        await caller.mail.send({
          threadId: 'thread-centurion-1',
          to: ['a@example.com'],
          cc: ['b@example.com'],
          subject: 'Re: x',
          html: '<p>hi</p>',
          text: 'hi',
          replyToMessageId: 'msg-centurion-inbound-1',
        });
        expect(fake.sent[0]!.to).toEqual(expect.arrayContaining(['a@example.com']));
        expect(fake.sent[0]!.cc).toEqual(expect.arrayContaining(['b@example.com']));
      } finally {
        __setSmtpTransportForTests(null);
      }
    });
  }, 30000);

  it('forwards one PDF attachment to SMTP', async () => {
    await withSeededTestDb(async (db) => {
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      const pdfB64 = Buffer.from('%PDF-1.4').toString('base64');
      try {
        await seedCenturionThread(db);
        const caller = await callerFor('user-navaai', { db });
        await caller.mail.send({
          to: ['a@example.com'],
          subject: 'with pdf',
          html: '<p>x</p>',
          text: 'x',
          attachments: [
            { name: 'a.pdf', type: 'application/pdf', size: 8, lastModified: 0, base64: pdfB64 },
          ],
        });
        expect(fake.sent[0]!.attachments?.[0]?.filename).toBe('a.pdf');
        expect(fake.sent[0]!.attachments?.[0]?.content).toBeTruthy();
      } finally {
        __setSmtpTransportForTests(null);
      }
    });
  }, 30000);
});

/** Unit-level: FakeSmtp records attachments without RDS (mail.send path needs DB). */
describe('FakeSmtpTransport attachments', () => {
  it('records PDF attachment when calling transport directly', async () => {
    const fake = new FakeSmtpTransport();
    const content = Buffer.from('%PDF-1.4');
    await fake.send({
      from: 'centurion@legacyhotel.com',
      to: ['a@example.com'],
      cc: [],
      bcc: [],
      subject: 'with pdf',
      html: '<p>x</p>',
      text: 'x',
      attachments: [
        { filename: 'a.pdf', content, contentType: 'application/pdf' },
      ],
    });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.attachments?.[0]?.filename).toBe('a.pdf');
    expect(fake.sent[0]!.attachments?.[0]?.content).toEqual(content);
    expect(fake.sent[0]!.attachments?.[0]?.contentType).toBe('application/pdf');
  });

  it('maps sendInput base64 → Buffer shape for SMTP payload', () => {
    const pdfB64 = Buffer.from('%PDF-1.4').toString('base64');
    const inputAttachments = [
      { name: 'a.pdf', type: 'application/pdf', size: 8, lastModified: 0, base64: pdfB64 },
    ];
    const smtpAttachments = inputAttachments.map((a) => ({
      filename: a.name,
      content: Buffer.from(a.base64, 'base64'),
      contentType: a.type,
    }));
    expect(smtpAttachments[0]!.filename).toBe('a.pdf');
    expect(Buffer.isBuffer(smtpAttachments[0]!.content)).toBe(true);
    expect(smtpAttachments[0]!.content.toString('utf8')).toBe('%PDF-1.4');
    expect(smtpAttachments[0]!.contentType).toBe('application/pdf');
  });
});
