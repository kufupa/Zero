/**
 * mail.send — fake SMTP transport + spoof rejection + outbound row storage.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import {
  mailThread,
  message,
  outboundSendQueue,
  mailboxTransport,
  mailboxAccess,
} from '../src/db/schema/mail.js';
import { user as userAuthTable } from '../src/db/schema/auth.js';
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
import { withTransportSelfBcc } from '../src/trpc/routes/mail.js';

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

async function seedFrontdeskUser(db: import('../src/db/client.js').DB) {
  await db
    .insert(userAuthTable)
    .values({
      id: 'user-frontdesk',
      name: 'Frontdesk',
      email: 'frontdesk@legacyhotel.com',
      emailVerified: true,
    })
    .onConflictDoNothing({ target: userAuthTable.email });

  await db
    .insert(mailboxTransport)
    .values({
      id: 'transport-frontdesk',
      email: 'frontdesk@legacyhotel.com',
      ownerHeaderValue: 'frontdesk@legacyhotel.com',
      mailboxType: 'personal',
      displayName: 'Frontdesk Transport',
      isActive: true,
    })
    .onConflictDoNothing({ target: mailboxTransport.id });

  await db
    .insert(mailboxAccess)
    .values({
      id: 'access-frontdesk-frontdesk',
      userId: 'user-frontdesk',
      transportId: 'transport-frontdesk',
      role: 'owner',
    })
    .onConflictDoNothing({ target: mailboxAccess.id });
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('mail.send', () => {
  const prevUndo = process.env.UNDO_SEND_SECONDS;

  beforeEach(() => {
    // Sync flush so existing assertions on {sent:true} + immediate SMTP hold.
    process.env.UNDO_SEND_SECONDS = '0';
  });

  afterEach(() => {
    __setSmtpTransportForTests(null);
    if (prevUndo === undefined) delete process.env.UNDO_SEND_SECONDS;
    else process.env.UNDO_SEND_SECONDS = prevUndo;
  });

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

  it('rejects spoofed active transport before mail.send persists rows', async () => {
    await withSeededTestDb(async (db) => {
      await seedCenturionThread(db);
      await seedFrontdeskUser(db);
      const centurionMessagesBefore = await db
        .select({ id: message.id })
        .from(message)
        .where(eq(message.transportId, 'transport-centurion'));
      const centurionQueueBefore = await db
        .select({ id: outboundSendQueue.id })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.transportId, 'transport-centurion'));

      await expect(
        callerFor('user-frontdesk', {
          db,
          requestedTransportId: 'transport-centurion',
        }),
      ).rejects.toThrow(/FORBIDDEN/);

      const centurionMessagesAfter = await db
        .select({ id: message.id })
        .from(message)
        .where(eq(message.transportId, 'transport-centurion'));
      const centurionQueueAfter = await db
        .select({ id: outboundSendQueue.id })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.transportId, 'transport-centurion'));
      expect(centurionMessagesAfter).toHaveLength(centurionMessagesBefore.length);
      expect(centurionQueueAfter).toHaveLength(centurionQueueBefore.length);
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
        const caller = await callerFor('user-navaai', {
          db,
          requestedTransportId: 'transport-centurion',
        });
        const result = await caller.mail.send(validCenturionReply);
        expect(result.fromEmail).toBe('centurion@legacyhotels.co.za');
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
        expect(rows[0]!.fromAddress).toBe('centurion@legacyhotels.co.za');
        expect(rows[0]!.messageIdHeader).toBeTruthy();
        expect(rows[0]!.inReplyTo).toBe('inbound-msg-id-1');
        expect(rows[0]!.references).toContain('inbound-msg-id-1');

        expect(fake.sent).toHaveLength(1);
        expect(fake.sent[0]!.from).toBe('centurion@legacyhotels.co.za');
        expect(fake.sent[0]!.bcc).toContain('centurion@legacyhotels.co.za');
        expect(rows[0]!.bccAddresses).toContain('centurion@legacyhotels.co.za');
        expect(fake.sent[0]!.inReplyTo).toBe('inbound-msg-id-1');
        expect(fake.sent[0]!.extraHeaders).toMatchObject({
          'X-Zero-Mailbox': 'centurion@legacyhotels.co.za',
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
        expect(fake.sent[0]!.bcc).toContain('navaai@legacyhotels.co.za');
        expect(fake.sent[0]!.extraHeaders).toEqual({
          'X-Zero-Mailbox': 'navaai@legacyhotels.co.za',
          'X-Zero-Outbound-Id': result.messageId,
        });
        const queueRows = await db
          .select({ smtpPayload: outboundSendQueue.smtpPayload })
          .from(outboundSendQueue)
          .where(
            and(
              eq(outboundSendQueue.messageId, result.messageId),
              eq(outboundSendQueue.transportId, 'transport-nava'),
            ),
          );
        expect(queueRows).toHaveLength(1);
        expect(
          (
            queueRows[0]!.smtpPayload as {
              extraHeaders?: Record<string, string>;
            }
          ).extraHeaders,
        ).toEqual({
          'X-Zero-Mailbox': 'navaai@legacyhotels.co.za',
          'X-Zero-Outbound-Id': result.messageId,
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

        const caller = await callerFor('user-navaai', {
          db,
          requestedTransportId: 'transport-centurion',
        });
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
        const caller = await callerFor('user-navaai', {
          db,
          requestedTransportId: 'transport-centurion',
        });
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

  it('reply marks entire thread read and sets hasReplied', async () => {
    await withSeededTestDb(async (db) => {
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      try {
        await seedCenturionThread(db);
        const caller = await callerFor('user-navaai', {
          db,
          requestedTransportId: 'transport-centurion',
        });
        await caller.mail.send(validCenturionReply);

        const [threadRow] = await db
          .select({ isRead: mailThread.isRead })
          .from(mailThread)
          .where(eq(mailThread.id, 'thread-centurion-1'));
        expect(threadRow?.isRead).toBe(true);

        const msgs = await db
          .select({ isRead: message.isRead, direction: message.direction })
          .from(message)
          .where(eq(message.threadId, 'thread-centurion-1'));
        expect(msgs.length).toBeGreaterThanOrEqual(2);
        expect(msgs.every((m) => m.isRead)).toBe(true);
        expect(msgs.some((m) => m.direction === 'outbound')).toBe(true);

        const got = await caller.mail.get({ id: 'thread-centurion-1' });
        expect(got.hasUnread).toBe(false);
        expect(got.hasReplied).toBe(true);
      } finally {
        __setSmtpTransportForTests(null);
      }
    });
  }, 30000);
});

describe('withTransportSelfBcc', () => {
  it('appends active mailbox when missing', () => {
    expect(withTransportSelfBcc(['a@b.com'], 'centurion@legacyhotels.co.za')).toEqual([
      'a@b.com',
      'centurion@legacyhotels.co.za',
    ]);
  });

  it('dedupes case-insensitively', () => {
    expect(
      withTransportSelfBcc(['Centurion@LegacyHotels.co.za'], 'centurion@legacyhotels.co.za'),
    ).toEqual(['Centurion@LegacyHotels.co.za']);
  });

  it('omits the audit copy when MAIL_SELF_BCC is disabled', () => {
    const previous = process.env.MAIL_SELF_BCC;
    try {
      for (const value of ['false', '0', 'off', 'OFF']) {
        process.env.MAIL_SELF_BCC = value;
        expect(withTransportSelfBcc(['a@b.com'], 'centurion@legacyhotels.co.za')).toEqual([
          'a@b.com',
        ]);
      }
      process.env.MAIL_SELF_BCC = 'true';
      expect(withTransportSelfBcc(['a@b.com'], 'centurion@legacyhotels.co.za')).toEqual([
        'a@b.com',
        'centurion@legacyhotels.co.za',
      ]);
    } finally {
      if (previous === undefined) delete process.env.MAIL_SELF_BCC;
      else process.env.MAIL_SELF_BCC = previous;
    }
  });
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
