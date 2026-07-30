/**
 * Outbound undo/schedule queue — unit + optional integration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeSmtpTransport,
  __setSmtpTransportForTests,
  createSmtpTransport,
  type SmtpTransport,
} from '../src/mail/send/smtp.js';
import {
  RECLAIM_SENDING_AFTER_MS,
  __setAfterSmtpOutcomePersistForTests,
  __forceSendAtPastForTests,
  attachSmtpDeliveryOutcome,
  flushDue,
  flushOne,
  getUndoSendSeconds,
  isOutboundClaimable,
  readSmtpDeliveryOutcome,
  serializeSmtpPayload,
  deserializeSmtpPayload,
} from '../src/mail/send/outbound-queue.js';
import { and, eq } from 'drizzle-orm';
import { message, outboundSendQueue } from '../src/db/schema/mail.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';
import { callerFor } from './helpers/trpc-caller.js';

const { createTransportMock, sendMailMock } = vi.hoisted(() => ({
  createTransportMock: vi.fn(),
  sendMailMock: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: createTransportMock,
  },
}));

const reachable = await probeTestDb();

const smtpPayload = {
  from: 'sender@example.com',
  to: ['accepted@example.com'],
  cc: [],
  bcc: ['rejected@example.com'],
  subject: 'outcome',
  html: '<p>outcome</p>',
  text: 'outcome',
};

function smtpWith(
  send: SmtpTransport['send'],
): SmtpTransport {
  return { kind: 'fake', send };
}

describe('SMTP send outcomes', () => {
  beforeEach(() => {
    createTransportMock.mockReset();
    sendMailMock.mockReset();
    createTransportMock.mockReturnValue({ sendMail: sendMailMock });
  });

  it('never synthesizes acceptance when Nodemailer accepts nobody', async () => {
    sendMailMock.mockResolvedValue({
      messageId: '<none@example.com>',
      accepted: [],
      rejected: ['rejected@example.com'],
    });
    const transport = createSmtpTransport({
      mode: 'wire',
      host: '127.0.0.1',
      port: 11025,
      secure: false,
    });

    await expect(transport.send(smtpPayload)).resolves.toEqual({
      messageId: 'none@example.com',
      accepted: [],
      rejected: ['rejected@example.com'],
    });
  });

  it('returns partial accepted and rejected recipients unchanged', async () => {
    sendMailMock.mockResolvedValue({
      messageId: '<partial@example.com>',
      accepted: ['accepted@example.com'],
      rejected: ['rejected@example.com'],
    });
    const transport = createSmtpTransport({
      mode: 'wire',
      host: '127.0.0.1',
      port: 11025,
      secure: false,
    });

    await expect(transport.send(smtpPayload)).resolves.toEqual({
      messageId: 'partial@example.com',
      accepted: ['accepted@example.com'],
      rejected: ['rejected@example.com'],
    });
  });

  it('fake transport reports full acceptance and no rejection', async () => {
    const fake = new FakeSmtpTransport();

    await expect(fake.send(smtpPayload)).resolves.toMatchObject({
      accepted: ['accepted@example.com', 'rejected@example.com'],
      rejected: [],
    });
  });

  it('real SMTP transmits its fallback Message-ID before send', async () => {
    sendMailMock.mockResolvedValue({
      accepted: ['accepted@example.com', 'rejected@example.com'],
      rejected: [],
    });
    const transport = createSmtpTransport({
      mode: 'real',
      host: 'smtp.example.com',
      port: 587,
      user: 'relay@example.com',
      password: 'test-password',
      requireTls: true,
      tlsServername: 'smtp.example.com',
    });

    const result = await transport.send(smtpPayload);
    const transmitted = sendMailMock.mock.calls[0]?.[0] as {
      messageId?: string;
    };

    expect(transmitted.messageId).toMatch(/^[0-9a-f-]+@zero-smtp\.local$/);
    expect(result.messageId).toBe(transmitted.messageId);
  });

  it('wire SMTP keeps its existing post-send fallback semantics', async () => {
    sendMailMock.mockResolvedValue({
      accepted: ['accepted@example.com', 'rejected@example.com'],
      rejected: [],
    });
    const transport = createSmtpTransport({
      mode: 'wire',
      host: '127.0.0.1',
      port: 11025,
      secure: false,
    });

    const result = await transport.send(smtpPayload);
    const transmitted = sendMailMock.mock.calls[0]?.[0] as {
      messageId?: string;
    };

    expect(transmitted.messageId).toBeUndefined();
    expect(result.messageId).toMatch(/^[0-9a-f-]+@zero-smtp\.local$/);
  });
});

describe('getUndoSendSeconds', () => {
  const prev = process.env.UNDO_SEND_SECONDS;

  afterEach(() => {
    if (prev === undefined) delete process.env.UNDO_SEND_SECONDS;
    else process.env.UNDO_SEND_SECONDS = prev;
  });

  it('defaults to 20', () => {
    delete process.env.UNDO_SEND_SECONDS;
    expect(getUndoSendSeconds()).toBe(20);
  });

  it('parses 0', () => {
    process.env.UNDO_SEND_SECONDS = '0';
    expect(getUndoSendSeconds()).toBe(0);
  });

  it('parses positive', () => {
    process.env.UNDO_SEND_SECONDS = '15';
    expect(getUndoSendSeconds()).toBe(15);
  });
});

describe('isOutboundClaimable', () => {
  const now = new Date('2026-07-23T12:00:00.000Z');

  it('pending + sendAt past → claimable', () => {
    expect(
      isOutboundClaimable(
        { status: 'pending', sendAt: new Date(now.getTime() - 1000), claimedAt: null },
        now,
      ),
    ).toBe(true);
  });

  it('pending + sendAt future → not claimable', () => {
    expect(
      isOutboundClaimable(
        { status: 'pending', sendAt: new Date(now.getTime() + 30_000), claimedAt: null },
        now,
      ),
    ).toBe(false);
  });

  it('sending stale after 5 min → reclaimable', () => {
    expect(
      isOutboundClaimable(
        {
          status: 'sending',
          sendAt: new Date(now.getTime() - 60_000),
          claimedAt: new Date(now.getTime() - RECLAIM_SENDING_AFTER_MS - 1),
        },
        now,
      ),
    ).toBe(true);
  });

  it('sending fresh → not reclaimable', () => {
    expect(
      isOutboundClaimable(
        {
          status: 'sending',
          sendAt: new Date(now.getTime() - 60_000),
          claimedAt: new Date(now.getTime() - 1000),
        },
        now,
      ),
    ).toBe(false);
  });

  it('sent/cancelled → not claimable', () => {
    expect(
      isOutboundClaimable(
        { status: 'sent', sendAt: new Date(0), claimedAt: null },
        now,
      ),
    ).toBe(false);
    expect(
      isOutboundClaimable(
        { status: 'cancelled', sendAt: new Date(0), claimedAt: null },
        now,
      ),
    ).toBe(false);
  });
});

describe('smtp payload serialize round-trip', () => {
  it('preserves attachment bytes as base64', () => {
    const content = Buffer.from('%PDF-1.4');
    const queued = serializeSmtpPayload({
      from: 'a@b.com',
      to: ['c@d.com'],
      cc: [],
      bcc: [],
      subject: 'x',
      html: '<p>x</p>',
      text: 'x',
      attachments: [{ filename: 'a.pdf', content, contentType: 'application/pdf' }],
    });
    expect(queued.attachments?.[0]?.contentBase64).toBe(content.toString('base64'));
    const back = deserializeSmtpPayload(queued);
    expect(back.attachments?.[0]?.content).toEqual(content);
  });

  it('stores and reconstructs exact SMTP delivery outcome', () => {
    const queued = serializeSmtpPayload(smtpPayload);
    const outcome = {
      messageId: 'persisted@example.com',
      accepted: ['accepted@example.com'],
      rejected: ['rejected@example.com'],
    };

    const persisted = attachSmtpDeliveryOutcome(queued, outcome);

    expect(readSmtpDeliveryOutcome(persisted)).toEqual(outcome);
    expect(readSmtpDeliveryOutcome(queued)).toBeNull();
    expect(deserializeSmtpPayload(persisted)).toEqual(smtpPayload);
  });

  it('rejects malformed persisted SMTP delivery outcome', () => {
    const queued = serializeSmtpPayload(smtpPayload);

    expect(() =>
      readSmtpDeliveryOutcome({
        ...queued,
        deliveryOutcome: {
          messageId: 'broken@example.com',
          accepted: 'not-an-array',
          rejected: [],
        },
      }),
    ).toThrow('SMTP_DELIVERY_OUTCOME_INVALID');
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('outbound queue (integration)', () => {
  const prevUndo = process.env.UNDO_SEND_SECONDS;

  beforeEach(() => {
    process.env.UNDO_SEND_SECONDS = '30';
  });

  afterEach(() => {
    __setSmtpTransportForTests(null);
    __setAfterSmtpOutcomePersistForTests(undefined);
    if (prevUndo === undefined) delete process.env.UNDO_SEND_SECONDS;
    else process.env.UNDO_SEND_SECONDS = prevUndo;
  });

  it('undo before sendAt → no SMTP', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '30';
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      const caller = await callerFor('user-navaai', { db });
      const r = await caller.mail.send({
        to: ['a@example.com'],
        subject: 'u',
        html: '<p>x</p>',
        text: 'x',
      });
      expect(r).toMatchObject({ queued: true });
      await caller.mail.unsend({ messageId: (r as { messageId: string }).messageId });
      expect(fake.sent).toHaveLength(0);
    });
  }, 30000);

  it('after sendAt flush → SMTP once (idempotent)', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '30';
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: 'transport-nava',
      });
      const r = await caller.mail.send({
        to: ['a@example.com'],
        subject: 'flush',
        html: '<p>x</p>',
        text: 'x',
      });
      expect(r).toMatchObject({ queued: true });
      const messageId = (r as { messageId: string }).messageId;
      await __forceSendAtPastForTests(messageId, 'transport-nava', db);
      await flushDue({ db });
      expect(fake.sent).toHaveLength(1);
      await flushDue({ db });
      expect(fake.sent).toHaveLength(1);
    });
  }, 30000);

  it('legacy delivered row without persisted outcome fails explicitly', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '30';
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: 'transport-nava',
      });
      const r = await caller.mail.send({
        to: ['a@example.com'],
        subject: 'reclaim-skip',
        html: '<p>x</p>',
        text: 'x',
      });
      const messageId = (r as { messageId: string }).messageId;
      await __forceSendAtPastForTests(messageId, 'transport-nava', db);
      await flushDue({ db });
      expect(fake.sent).toHaveLength(1);

      const [delivered] = await db
        .select({ smtpPayload: outboundSendQueue.smtpPayload })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, messageId))
        .limit(1);
      const {
        deliveryOutcome: _deliveryOutcome,
        ...legacyPayload
      } = delivered!.smtpPayload as Record<string, unknown>;

      // Legacy crash state: Message-ID exists, but exact recipient outcome was never persisted.
      const stale = new Date(Date.now() - RECLAIM_SENDING_AFTER_MS - 1000);
      await db
        .update(outboundSendQueue)
        .set({
          status: 'sending',
          claimedAt: stale,
          smtpPayload: legacyPayload,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(outboundSendQueue.messageId, messageId),
            eq(outboundSendQueue.transportId, 'transport-nava'),
          ),
        );
      const [msg] = await db
        .select({ messageIdHeader: message.messageIdHeader })
        .from(message)
        .where(eq(message.id, messageId))
        .limit(1);
      expect(msg?.messageIdHeader).toBeTruthy();

      expect(await flushDue({ db })).toEqual({ flushed: 0 });
      expect(fake.sent).toHaveLength(1);

      const [q] = await db
        .select({
          status: outboundSendQueue.status,
          lastError: outboundSendQueue.lastError,
        })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, messageId))
        .limit(1);
      expect(q).toMatchObject({
        status: 'sending',
        lastError: 'SMTP_DELIVERY_OUTCOME_MISSING',
      });

      await db
        .update(outboundSendQueue)
        .set({ status: 'sent' })
        .where(eq(outboundSendQueue.messageId, messageId));
      await expect(flushOne(messageId, 'transport-nava', db)).rejects.toThrow(
        'SMTP_DELIVERY_OUTCOME_MISSING',
      );
    });
  }, 30000);

  it('UNDO_SEND_SECONDS=0 → sync flush → sent:true', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '0';
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      const caller = await callerFor('user-navaai', { db });
      const r = await caller.mail.send({
        to: ['a@example.com'],
        subject: 'now',
        html: '<p>x</p>',
        text: 'x',
      });
      expect(r).toMatchObject({ sent: true });
      expect(fake.sent).toHaveLength(1);
    });
  }, 30000);

  it('zero accepted recipients fails before sent state', async () => {
    await withSeededTestDb(async (db) => {
      const send = vi.fn<SmtpTransport['send']>().mockResolvedValue({
        messageId: 'none@example.com',
        accepted: [],
        rejected: ['a@example.com'],
      });
      __setSmtpTransportForTests(smtpWith(send));
      const caller = await callerFor('user-navaai', { db });
      const r = await caller.mail.send({
        to: ['a@example.com'],
        subject: 'none accepted',
        html: '<p>x</p>',
        text: 'x',
      });
      const messageId = (r as { messageId: string }).messageId;
      await __forceSendAtPastForTests(messageId, 'transport-nava', db);

      expect(await flushDue({ db })).toEqual({ flushed: 0 });

      const [queued] = await db
        .select({
          status: outboundSendQueue.status,
          lastError: outboundSendQueue.lastError,
        })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, messageId))
        .limit(1);
      const [stored] = await db
        .select({ messageIdHeader: message.messageIdHeader })
        .from(message)
        .where(eq(message.id, messageId))
        .limit(1);
      expect(queued?.status).toBe('sending');
      expect(queued?.lastError).toContain('SMTP_ZERO_ACCEPTED');
      expect(stored?.messageIdHeader).toBeNull();
    });
  }, 30000);

  it('full acceptance marks sent and clears prior error', async () => {
    await withSeededTestDb(async (db) => {
      const send = vi.fn<SmtpTransport['send']>().mockResolvedValue({
        messageId: 'full@example.com',
        accepted: ['a@example.com', 'navaai@legacyhotels.co.za'],
        rejected: [],
      });
      __setSmtpTransportForTests(smtpWith(send));
      const caller = await callerFor('user-navaai', { db });
      const r = await caller.mail.send({
        to: ['a@example.com'],
        subject: 'full accepted',
        html: '<p>x</p>',
        text: 'x',
      });
      const messageId = (r as { messageId: string }).messageId;
      await __forceSendAtPastForTests(messageId, 'transport-nava', db);
      await db
        .update(outboundSendQueue)
        .set({ lastError: 'prior transient error' })
        .where(eq(outboundSendQueue.messageId, messageId));

      expect(await flushDue({ db })).toEqual({ flushed: 1 });

      const [queued] = await db
        .select({
          status: outboundSendQueue.status,
          lastError: outboundSendQueue.lastError,
        })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, messageId))
        .limit(1);
      expect(queued).toMatchObject({ status: 'sent', lastError: null });

      await db
        .update(outboundSendQueue)
        .set({ lastError: 'stale terminal warning' })
        .where(eq(outboundSendQueue.messageId, messageId));
      await expect(flushOne(messageId, 'transport-nava', db)).resolves.toEqual({
        messageId: 'full@example.com',
        accepted: ['a@example.com', 'navaai@legacyhotels.co.za'],
        rejected: [],
      });
      const [idempotent] = await db
        .select({ lastError: outboundSendQueue.lastError })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, messageId))
        .limit(1);
      expect(idempotent?.lastError).toBeNull();
    });
  }, 30000);

  it('partial acceptance is terminal and preserves structured warning', async () => {
    await withSeededTestDb(async (db) => {
      const send = vi.fn<SmtpTransport['send']>().mockResolvedValue({
        messageId: 'partial@example.com',
        accepted: ['a@example.com'],
        rejected: ['navaai@legacyhotels.co.za'],
      });
      __setSmtpTransportForTests(smtpWith(send));
      const caller = await callerFor('user-navaai', { db });
      const r = await caller.mail.send({
        to: ['a@example.com'],
        subject: 'partial accepted',
        html: '<p>x</p>',
        text: 'x',
      });
      const messageId = (r as { messageId: string }).messageId;
      await __forceSendAtPastForTests(messageId, 'transport-nava', db);

      expect(await flushDue({ db })).toEqual({ flushed: 1 });
      expect(await flushDue({ db })).toEqual({ flushed: 0 });

      const [queued] = await db
        .select({
          status: outboundSendQueue.status,
          lastError: outboundSendQueue.lastError,
        })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, messageId))
        .limit(1);
      const [stored] = await db
        .select({ messageIdHeader: message.messageIdHeader })
        .from(message)
        .where(eq(message.id, messageId))
        .limit(1);
      expect(queued?.status).toBe('sent');
      expect(JSON.parse(queued?.lastError ?? '{}')).toEqual({
        code: 'PARTIAL_REJECTION',
        messageId: 'partial@example.com',
        accepted: ['a@example.com'],
        rejected: ['navaai@legacyhotels.co.za'],
      });
      expect(stored?.messageIdHeader).toBe('partial@example.com');
      expect(send).toHaveBeenCalledTimes(1);
    });
  }, 30000);

  it('recovers exact partial outcome after crash without resending', async () => {
    await withSeededTestDb(async (db) => {
      const outcome = {
        messageId: 'partial-crash@example.com',
        accepted: ['a@example.com'],
        rejected: ['navaai@legacyhotels.co.za'],
      };
      const send = vi.fn<SmtpTransport['send']>().mockResolvedValue(outcome);
      __setSmtpTransportForTests(smtpWith(send));
      __setAfterSmtpOutcomePersistForTests(
        vi.fn().mockRejectedValueOnce(new Error('simulated crash after outcome persistence')),
      );
      const caller = await callerFor('user-navaai', { db });
      const r = await caller.mail.send({
        to: ['a@example.com'],
        subject: 'partial crash',
        html: '<p>x</p>',
        text: 'x',
      });
      const messageId = (r as { messageId: string }).messageId;
      await __forceSendAtPastForTests(messageId, 'transport-nava', db);

      expect(await flushDue({ db })).toEqual({ flushed: 0 });
      expect(send).toHaveBeenCalledOnce();

      const [crashedQueue] = await db
        .select({ smtpPayload: outboundSendQueue.smtpPayload })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, messageId))
        .limit(1);
      const [crashedMessage] = await db
        .select({ messageIdHeader: message.messageIdHeader })
        .from(message)
        .where(eq(message.id, messageId))
        .limit(1);
      expect(
        readSmtpDeliveryOutcome(
          crashedQueue!.smtpPayload as ReturnType<typeof serializeSmtpPayload>,
        ),
      ).toEqual(outcome);
      expect(crashedMessage?.messageIdHeader).toBeNull();

      __setAfterSmtpOutcomePersistForTests(undefined);
      await db
        .update(outboundSendQueue)
        .set({
          status: 'sending',
          claimedAt: new Date(Date.now() - RECLAIM_SENDING_AFTER_MS - 1000),
        })
        .where(eq(outboundSendQueue.messageId, messageId));

      expect(await flushDue({ db })).toEqual({ flushed: 1 });
      expect(send).toHaveBeenCalledOnce();
      await db
        .update(outboundSendQueue)
        .set({ lastError: null })
        .where(eq(outboundSendQueue.messageId, messageId));
      await expect(flushOne(messageId, 'transport-nava', db)).resolves.toEqual(outcome);

      const [recoveredQueue] = await db
        .select({
          status: outboundSendQueue.status,
          lastError: outboundSendQueue.lastError,
        })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, messageId))
        .limit(1);
      expect(recoveredQueue?.status).toBe('sent');
      expect(JSON.parse(recoveredQueue?.lastError ?? '{}')).toEqual({
        code: 'PARTIAL_REJECTION',
        ...outcome,
      });
    });
  }, 30000);

  it('immediate send returns honest accepted and rejected recipients', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '0';
      const send = vi.fn<SmtpTransport['send']>().mockResolvedValue({
        messageId: 'immediate@example.com',
        accepted: ['a@example.com'],
        rejected: ['navaai@legacyhotels.co.za'],
      });
      __setSmtpTransportForTests(smtpWith(send));
      const caller = await callerFor('user-navaai', { db });

      const r = await caller.mail.send({
        to: ['a@example.com'],
        subject: 'immediate partial',
        html: '<p>x</p>',
        text: 'x',
      });

      expect(r).toMatchObject({
        sent: true,
        smtpMessageId: 'immediate@example.com',
        accepted: ['a@example.com'],
        rejected: ['navaai@legacyhotels.co.za'],
      });
    });
  }, 30000);

  it('pre-accept SMTP error remains retryable', async () => {
    await withSeededTestDb(async (db) => {
      const send = vi
        .fn<SmtpTransport['send']>()
        .mockRejectedValueOnce(new Error('connection reset before DATA acceptance'))
        .mockResolvedValueOnce({
          messageId: 'retry@example.com',
          accepted: ['a@example.com', 'navaai@legacyhotels.co.za'],
          rejected: [],
        });
      __setSmtpTransportForTests(smtpWith(send));
      const caller = await callerFor('user-navaai', { db });
      const r = await caller.mail.send({
        to: ['a@example.com'],
        subject: 'retry pre-accept',
        html: '<p>x</p>',
        text: 'x',
      });
      const messageId = (r as { messageId: string }).messageId;
      await __forceSendAtPastForTests(messageId, 'transport-nava', db);

      expect(await flushDue({ db })).toEqual({ flushed: 0 });
      await db
        .update(outboundSendQueue)
        .set({
          status: 'sending',
          claimedAt: new Date(Date.now() - RECLAIM_SENDING_AFTER_MS - 1000),
        })
        .where(eq(outboundSendQueue.messageId, messageId));
      expect(await flushDue({ db })).toEqual({ flushed: 1 });

      const [queued] = await db
        .select({
          status: outboundSendQueue.status,
          lastError: outboundSendQueue.lastError,
        })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, messageId))
        .limit(1);
      expect(queued).toMatchObject({ status: 'sent', lastError: null });
      expect(send).toHaveBeenCalledTimes(2);
    });
  }, 30000);

  it('scheduleAt → scheduled:true', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '0';
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      const caller = await callerFor('user-navaai', { db });
      const sendAtIso = new Date(Date.now() + 3600_000).toISOString();
      const r = await caller.mail.send({
        to: ['a@example.com'],
        subject: 'later',
        html: '<p>x</p>',
        text: 'x',
        scheduleAt: sendAtIso,
      });
      expect(r).toMatchObject({ scheduled: true });
      expect(fake.sent).toHaveLength(0);
    });
  }, 30000);
});
