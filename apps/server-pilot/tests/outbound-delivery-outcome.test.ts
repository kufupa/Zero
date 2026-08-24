import {
  __setSmtpTransportForTests,
  type SmtpSendResult,
  type SmtpTransport,
} from '../src/mail/send/smtp.js';
import {
  fixtureLoopbackStore,
  resetFixtureLoopbackStoreForTests,
} from '../src/mail/fixture-loopback.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushDue, flushOne } from '../src/mail/send/outbound-queue.js';
import { message, outboundSendQueue } from '../src/db/schema/mail.js';
import { callerFor } from './helpers/trpc-caller.js';
import { INGEST_EMAIL } from '../src/db/seed.js';
import { and, eq } from 'drizzle-orm';

const reachable = await probeTestDb();

const transportId = 'transport-nava';
const previousEnv = {
  mailMode: process.env.MAIL_TRANSPORT_MODE,
  selfBcc: process.env.MAIL_SELF_BCC,
  undoSeconds: process.env.UNDO_SEND_SECONDS,
};

function scriptedTransport(outcome: SmtpSendResult) {
  const send: SmtpTransport['send'] = vi.fn().mockResolvedValue(outcome);
  return {
    send,
    transport: { kind: 'fake', send } satisfies SmtpTransport,
  };
}

async function queueForMessage(db: import('../src/db/client.js').DB, messageId: string) {
  const [queue] = await db
    .select()
    .from(outboundSendQueue)
    .where(
      and(
        eq(outboundSendQueue.messageId, messageId),
        eq(outboundSendQueue.transportId, transportId),
      ),
    )
    .limit(1);
  if (!queue) throw new Error('expected outbound queue row');
  return queue;
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('outbound SMTP delivery outcomes', () => {
  beforeEach(() => {
    process.env.MAIL_TRANSPORT_MODE = 'fixture';
    process.env.MAIL_SELF_BCC = 'false';
    process.env.UNDO_SEND_SECONDS = '0';
    resetFixtureLoopbackStoreForTests();
  });

  afterEach(() => {
    __setSmtpTransportForTests(null);
    resetFixtureLoopbackStoreForTests();
    if (previousEnv.mailMode === undefined) delete process.env.MAIL_TRANSPORT_MODE;
    else process.env.MAIL_TRANSPORT_MODE = previousEnv.mailMode;
    if (previousEnv.selfBcc === undefined) delete process.env.MAIL_SELF_BCC;
    else process.env.MAIL_SELF_BCC = previousEnv.selfBcc;
    if (previousEnv.undoSeconds === undefined) delete process.env.UNDO_SEND_SECONDS;
    else process.env.UNDO_SEND_SECONDS = previousEnv.undoSeconds;
  });

  it('persists a full SMTP outcome and returns its exact recipient arrays', async () => {
    await withSeededTestDb(async (db) => {
      const outcome: SmtpSendResult = {
        messageId: 'full-outcome@zero.test',
        accepted: ['full-recipient@zero.test'],
        rejected: [],
      };
      const scripted = scriptedTransport(outcome);
      __setSmtpTransportForTests(scripted.transport);
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: transportId,
      });

      const result = await caller.mail.send({
        to: ['full-recipient@zero.test'],
        subject: 'full delivery outcome',
        html: '<p>full delivery outcome</p>',
        text: 'full delivery outcome',
      });

      expect(result).toMatchObject({
        sent: true,
        accepted: outcome.accepted,
        rejected: outcome.rejected,
      });
      const queue = await queueForMessage(db, result.messageId);
      expect(queue.status).toBe('sent');
      expect(queue.lastError).toBeNull();
      expect(queue.smtpPayload).toMatchObject({
        deliveryOutcome: outcome,
        extraHeaders: { 'X-Zero-Outbound-Id': result.messageId },
      });
      expect(scripted.send).toHaveBeenCalledTimes(1);
    });
  }, 30000);

  it('fails zero acceptance, leaves the row reclaimable, and skips loopback', async () => {
    await withSeededTestDb(async (db) => {
      const scripted = scriptedTransport({
        messageId: 'zero-outcome@zero.test',
        accepted: [],
        rejected: [INGEST_EMAIL],
      });
      __setSmtpTransportForTests(scripted.transport);
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: transportId,
      });

      await expect(
        caller.mail.send({
          to: [INGEST_EMAIL],
          subject: 'zero delivery outcome',
          html: '<p>zero delivery outcome</p>',
          text: 'zero delivery outcome',
        }),
      ).rejects.toThrow('SMTP accepted no recipients');

      const queues = await db
        .select()
        .from(outboundSendQueue)
        .where(
          and(
            eq(outboundSendQueue.transportId, transportId),
            eq(outboundSendQueue.status, 'sending'),
          ),
        );
      expect(queues).toHaveLength(1);
      const [outbound] = await db
        .select({ messageIdHeader: message.messageIdHeader })
        .from(message)
        .where(eq(message.id, queues[0]!.messageId))
        .limit(1);
      expect(outbound?.messageIdHeader).toBeNull();
      expect(fixtureLoopbackStore.drain()).toEqual([]);
      expect(scripted.send).toHaveBeenCalledTimes(1);
    });
  }, 30000);

  it('fails closed for a persisted zero-acceptance outcome', async () => {
    await withSeededTestDb(async (db) => {
      const outcome: SmtpSendResult = {
        messageId: 'persisted-zero-outcome@zero.test',
        accepted: ['persisted-recipient@zero.test'],
        rejected: [],
      };
      const scripted = scriptedTransport(outcome);
      __setSmtpTransportForTests(scripted.transport);
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: transportId,
      });
      const result = await caller.mail.send({
        to: ['persisted-recipient@zero.test'],
        subject: 'persisted zero outcome',
        html: '<p>persisted zero outcome</p>',
        text: 'persisted zero outcome',
      });
      const queue = await queueForMessage(db, result.messageId);
      const stale = new Date(Date.now() - 5 * 60 * 1000 - 1);
      await db
        .update(outboundSendQueue)
        .set({
          status: 'sending',
          claimedAt: stale,
          smtpPayload: {
            ...(queue.smtpPayload as Record<string, unknown>),
            deliveryOutcome: {
              messageId: outcome.messageId,
              accepted: [],
              rejected: ['persisted-recipient@zero.test'],
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(outboundSendQueue.id, queue.id));

      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(flushDue({ db })).resolves.toEqual({ flushed: 0 });
      } finally {
        error.mockRestore();
      }
      const failedQueue = await queueForMessage(db, result.messageId);
      expect(failedQueue.status).toBe('sending');
      expect(scripted.send).toHaveBeenCalledTimes(1);
    });
  }, 30000);

  it('records a partial rejection as sent once and replays its exact outcome', async () => {
    await withSeededTestDb(async (db) => {
      const outcome: SmtpSendResult = {
        messageId: 'partial-outcome@zero.test',
        accepted: ['accepted-recipient@zero.test'],
        rejected: ['rejected-recipient@zero.test'],
      };
      const scripted = scriptedTransport(outcome);
      __setSmtpTransportForTests(scripted.transport);
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: transportId,
      });

      const result = await caller.mail.send({
        to: ['accepted-recipient@zero.test', 'rejected-recipient@zero.test'],
        subject: 'partial delivery outcome',
        html: '<p>partial delivery outcome</p>',
        text: 'partial delivery outcome',
      });

      expect(result).toMatchObject({
        sent: true,
        accepted: outcome.accepted,
        rejected: outcome.rejected,
      });
      const queue = await queueForMessage(db, result.messageId);
      expect(queue.status).toBe('sent');
      expect(queue.smtpPayload).toMatchObject({ deliveryOutcome: outcome });
      expect(JSON.parse(queue.lastError ?? '')).toMatchObject({
        code: 'PARTIAL_REJECTION',
      });

      await expect(flushOne(result.messageId, transportId, db)).resolves.toEqual(outcome);
      expect(scripted.send).toHaveBeenCalledTimes(1);
    });
  }, 30000);

  it('marks missing requested recipients as partial even without an explicit rejection', async () => {
    await withSeededTestDb(async (db) => {
      const outcome: SmtpSendResult = {
        messageId: 'missing-recipient-outcome@zero.test',
        accepted: ['present-recipient@zero.test'],
        rejected: [],
      };
      const scripted = scriptedTransport(outcome);
      __setSmtpTransportForTests(scripted.transport);
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: transportId,
      });

      const result = await caller.mail.send({
        to: ['present-recipient@zero.test', 'missing-recipient@zero.test'],
        subject: 'missing recipient outcome',
        html: '<p>missing recipient outcome</p>',
        text: 'missing recipient outcome',
      });

      const queue = await queueForMessage(db, result.messageId);
      expect(queue.status).toBe('sent');
      expect(JSON.parse(queue.lastError ?? '')).toMatchObject({
        code: 'PARTIAL_REJECTION',
        missingRequestedRecipientCount: 1,
      });
      expect(scripted.send).toHaveBeenCalledTimes(1);
    });
  }, 30000);

  it('reclaims a stale persisted outcome without re-sending SMTP', async () => {
    await withSeededTestDb(async (db) => {
      const outcome: SmtpSendResult = {
        messageId: 'reclaim-outcome@zero.test',
        accepted: ['reclaim-recipient@zero.test'],
        rejected: [],
      };
      const scripted = scriptedTransport(outcome);
      __setSmtpTransportForTests(scripted.transport);
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: transportId,
      });

      const result = await caller.mail.send({
        to: ['reclaim-recipient@zero.test'],
        subject: 'reclaim persisted outcome',
        html: '<p>reclaim persisted outcome</p>',
        text: 'reclaim persisted outcome',
      });
      const queue = await queueForMessage(db, result.messageId);
      expect(queue.smtpPayload).toMatchObject({ deliveryOutcome: outcome });

      const stale = new Date(Date.now() - 5 * 60 * 1000 - 1);
      await db
        .update(message)
        .set({ messageIdHeader: null })
        .where(eq(message.id, result.messageId));
      await db
        .update(outboundSendQueue)
        .set({ status: 'sending', claimedAt: stale, updatedAt: new Date() })
        .where(eq(outboundSendQueue.id, queue.id));

      await expect(flushDue({ db })).resolves.toEqual({ flushed: 1 });
      const recoveredQueue = await queueForMessage(db, result.messageId);
      const [recoveredMessage] = await db
        .select({ messageIdHeader: message.messageIdHeader })
        .from(message)
        .where(eq(message.id, result.messageId))
        .limit(1);
      expect(recoveredQueue.status).toBe('sent');
      expect(recoveredMessage?.messageIdHeader).toBe(outcome.messageId);
      expect(scripted.send).toHaveBeenCalledTimes(1);
    });
  }, 30000);

  it('fails closed when a persisted outcome disagrees with its message SMTP ID', async () => {
    await withSeededTestDb(async (db) => {
      const outcome: SmtpSendResult = {
        messageId: 'matching-outcome@zero.test',
        accepted: ['matching-recipient@zero.test'],
        rejected: [],
      };
      const scripted = scriptedTransport(outcome);
      __setSmtpTransportForTests(scripted.transport);
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: transportId,
      });
      const result = await caller.mail.send({
        to: ['matching-recipient@zero.test'],
        subject: 'mismatch protection',
        html: '<p>mismatch protection</p>',
        text: 'mismatch protection',
      });
      const queue = await queueForMessage(db, result.messageId);
      const stale = new Date(Date.now() - 5 * 60 * 1000 - 1);
      await db
        .update(outboundSendQueue)
        .set({
          status: 'sending',
          claimedAt: stale,
          smtpPayload: {
            ...(queue.smtpPayload as Record<string, unknown>),
            deliveryOutcome: { ...outcome, messageId: 'mismatched-outcome@zero.test' },
          },
          updatedAt: new Date(),
        })
        .where(eq(outboundSendQueue.id, queue.id));

      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(flushDue({ db })).resolves.toEqual({ flushed: 0 });
      } finally {
        error.mockRestore();
      }
      const failedQueue = await queueForMessage(db, result.messageId);
      expect(failedQueue.status).toBe('sending');
      expect(scripted.send).toHaveBeenCalledTimes(1);
    });
  }, 30000);

  it('fails closed for malformed persisted delivery evidence', async () => {
    await withSeededTestDb(async (db) => {
      const outcome: SmtpSendResult = {
        messageId: 'malformed-outcome@zero.test',
        accepted: ['malformed-recipient@zero.test'],
        rejected: [],
      };
      const scripted = scriptedTransport(outcome);
      __setSmtpTransportForTests(scripted.transport);
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: transportId,
      });
      const result = await caller.mail.send({
        to: ['malformed-recipient@zero.test'],
        subject: 'malformed delivery evidence',
        html: '<p>malformed delivery evidence</p>',
        text: 'malformed delivery evidence',
      });
      const queue = await queueForMessage(db, result.messageId);
      const stale = new Date(Date.now() - 5 * 60 * 1000 - 1);
      await db
        .update(outboundSendQueue)
        .set({
          status: 'sending',
          claimedAt: stale,
          smtpPayload: {
            ...(queue.smtpPayload as Record<string, unknown>),
            deliveryOutcome: {
              messageId: outcome.messageId,
              accepted: outcome.accepted,
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(outboundSendQueue.id, queue.id));

      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(flushDue({ db })).resolves.toEqual({ flushed: 0 });
      } finally {
        error.mockRestore();
      }
      const failedQueue = await queueForMessage(db, result.messageId);
      expect(failedQueue.status).toBe('sending');
      expect(scripted.send).toHaveBeenCalledTimes(1);
    });
  }, 30000);

  it('fails closed when a message SMTP ID exists without a persisted outcome', async () => {
    await withSeededTestDb(async (db) => {
      const outcome: SmtpSendResult = {
        messageId: 'header-only-outcome@zero.test',
        accepted: ['header-only-recipient@zero.test'],
        rejected: [],
      };
      const scripted = scriptedTransport(outcome);
      __setSmtpTransportForTests(scripted.transport);
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: transportId,
      });
      const result = await caller.mail.send({
        to: ['header-only-recipient@zero.test'],
        subject: 'missing delivery evidence',
        html: '<p>missing delivery evidence</p>',
        text: 'missing delivery evidence',
      });
      const queue = await queueForMessage(db, result.messageId);
      const smtpPayload = { ...(queue.smtpPayload as Record<string, unknown>) };
      delete smtpPayload.deliveryOutcome;
      const stale = new Date(Date.now() - 5 * 60 * 1000 - 1);
      await db
        .update(outboundSendQueue)
        .set({
          status: 'sending',
          claimedAt: stale,
          smtpPayload,
          updatedAt: new Date(),
        })
        .where(eq(outboundSendQueue.id, queue.id));

      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(flushDue({ db })).resolves.toEqual({ flushed: 0 });
      } finally {
        error.mockRestore();
      }
      const failedQueue = await queueForMessage(db, result.messageId);
      expect(failedQueue.status).toBe('sending');
      expect(scripted.send).toHaveBeenCalledTimes(1);
    });
  }, 30000);
});
