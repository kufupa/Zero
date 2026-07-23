/**
 * Outbound undo/schedule queue — unit + optional integration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeSmtpTransport,
  __setSmtpTransportForTests,
} from '../src/mail/send/smtp.js';
import {
  RECLAIM_SENDING_AFTER_MS,
  __forceSendAtPastForTests,
  flushDue,
  getUndoSendSeconds,
  isOutboundClaimable,
  serializeSmtpPayload,
  deserializeSmtpPayload,
} from '../src/mail/send/outbound-queue.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';
import { callerFor } from './helpers/trpc-caller.js';

const reachable = await probeTestDb();

describe('getUndoSendSeconds', () => {
  const prev = process.env.UNDO_SEND_SECONDS;

  afterEach(() => {
    if (prev === undefined) delete process.env.UNDO_SEND_SECONDS;
    else process.env.UNDO_SEND_SECONDS = prev;
  });

  it('defaults to 30', () => {
    delete process.env.UNDO_SEND_SECONDS;
    expect(getUndoSendSeconds()).toBe(30);
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
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('outbound queue (integration)', () => {
  const prevUndo = process.env.UNDO_SEND_SECONDS;

  beforeEach(() => {
    process.env.UNDO_SEND_SECONDS = '30';
  });

  afterEach(() => {
    __setSmtpTransportForTests(null);
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
