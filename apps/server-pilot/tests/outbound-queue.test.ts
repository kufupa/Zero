/**
 * Outbound undo/schedule queue — unit + optional integration.
 */
import {
  RECLAIM_SENDING_AFTER_MS,
  __forceSendAtPastForTests,
  flushDue,
  getUndoSendSeconds,
  hasPersistedSmtpDelivery,
  isOutboundClaimable,
  serializeSmtpPayload,
  deserializeSmtpPayload,
} from '../src/mail/send/outbound-queue.js';
import { FakeSmtpTransport, __setSmtpTransportForTests } from '../src/mail/send/smtp.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { mailBaselineProjection } from '../src/db/schema/mail-baseline-projection.js';
import { message, outboundSendQueue } from '../src/db/schema/mail.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDraftApproval } from '../src/ai/draft-approval.js';
import { callerFor } from './helpers/trpc-caller.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';

const SIGNING_SECRET = 'u6-test-signing-secret';

const reachable = await probeTestDb();

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

  it('sending stale with started SMTP and no outcome → not reclaimable', () => {
    expect(
      isOutboundClaimable(
        {
          status: 'sending',
          sendAt: new Date(now.getTime() - 60_000),
          claimedAt: new Date(now.getTime() - RECLAIM_SENDING_AFTER_MS - 1),
          smtpAttemptedAt: new Date(now.getTime() - RECLAIM_SENDING_AFTER_MS - 2),
          smtpOutcomePersistedAt: null,
        },
        now,
      ),
    ).toBe(false);
  });

  it('sending stale with persisted outcome → reclaimable', () => {
    expect(
      isOutboundClaimable(
        {
          status: 'sending',
          sendAt: new Date(now.getTime() - 60_000),
          claimedAt: new Date(now.getTime() - RECLAIM_SENDING_AFTER_MS - 1),
          smtpAttemptedAt: new Date(now.getTime() - RECLAIM_SENDING_AFTER_MS - 2),
          smtpOutcomePersistedAt: new Date(now.getTime() - RECLAIM_SENDING_AFTER_MS - 2),
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
    expect(isOutboundClaimable({ status: 'sent', sendAt: new Date(0), claimedAt: null }, now)).toBe(
      false,
    );
    expect(
      isOutboundClaimable({ status: 'cancelled', sendAt: new Date(0), claimedAt: null }, now),
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

  it('preserves the server-derived filing BCC in delayed SMTP payloads', () => {
    const queued = serializeSmtpPayload({
      from: 'nava@example.test',
      to: ['guest@example.test'],
      cc: [],
      bcc: ['nava@example.test'],
      subject: 'x',
      html: '<p>x</p>',
      text: 'x',
    });
    expect(queued.bcc).toEqual(['nava@example.test']);
    expect(deserializeSmtpPayload(queued).bcc).toEqual(['nava@example.test']);
  });

  it('persists an AI draft approval alongside the exact SMTP payload', () => {
    const approval = buildDraftApproval(
      {
        draftId: 'draft-1',
        generationId: 'generation-1',
        transportId: 'transport-1',
        threadId: 'thread-1',
        revisionId: 'revision-1',
        threadStateVersion: 'state-1',
        evidence: [{ kind: 'hms', id: 'evidence-1', sourceHash: 'source-1' }],
        policyVersion: 'u6-draft-policy-v1',
        approvedByUserId: 'user-1',
        approvedAt: '2026-09-09T10:00:00.000Z',
        origin: 'ai',
        subject: 'approved',
        html: '<p>approved</p>',
        text: 'approved',
        to: ['guest@example.test'],
        cc: [],
        bcc: [],
        attachments: [],
      },
      SIGNING_SECRET,
    );
    const queued = serializeSmtpPayload(
      {
        from: 'nava@example.test',
        to: ['guest@example.test'],
        cc: [],
        bcc: [],
        subject: 'approved',
        html: '<p>approved</p>',
        text: 'approved',
      },
      approval,
    );
    expect(queued.draftApproval).toEqual(approval);
    expect(deserializeSmtpPayload(queued).html).toBe('<p>approved</p>');
  });
});

describe('hasPersistedSmtpDelivery', () => {
  it('true when messageIdHeader set → skip SMTP on reclaim', () => {
    expect(hasPersistedSmtpDelivery('<smtp@id>')).toBe(true);
    expect(hasPersistedSmtpDelivery('id')).toBe(true);
  });

  it('false when null/empty → must SMTP', () => {
    expect(hasPersistedSmtpDelivery(null)).toBe(false);
    expect(hasPersistedSmtpDelivery(undefined)).toBe(false);
    expect(hasPersistedSmtpDelivery('')).toBe(false);
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('outbound SMTP fence migration', () => {
  it('fences ambiguous legacy sending rows while preserving known recovery evidence', async () => {
    await withSeededTestDb(async (db) => {
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: 'transport-nava',
      });
      const [ambiguous, outcome, legacy] = await Promise.all(
        ['ambiguous', 'outcome', 'legacy'].map((subject) =>
          caller.mail.send({
            to: [`${subject}@zero.test`],
            subject,
            html: `<p>${subject}</p>`,
            text: subject,
          }),
        ),
      );
      const queueMessageIds = [ambiguous.messageId, outcome.messageId, legacy.messageId];
      const stale = new Date(Date.now() - RECLAIM_SENDING_AFTER_MS - 1);
      const [outcomeQueue] = await db
        .select({ smtpPayload: outboundSendQueue.smtpPayload })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, outcome.messageId))
        .limit(1);
      if (!outcomeQueue) throw new Error('missing outcome queue row');

      await db
        .update(outboundSendQueue)
        .set({
          status: 'sending',
          claimedAt: stale,
          smtpAttemptedAt: null,
          smtpOutcomePersistedAt: null,
        })
        .where(inArray(outboundSendQueue.messageId, queueMessageIds));
      await db
        .update(outboundSendQueue)
        .set({
          smtpPayload: {
            ...outcomeQueue.smtpPayload,
            deliveryOutcome: {
              messageId: 'outcome@zero.test',
              accepted: ['outcome@zero.test'],
              rejected: [],
            },
          },
        })
        .where(eq(outboundSendQueue.messageId, outcome.messageId));
      await db
        .update(message)
        .set({ messageIdHeader: 'legacy@zero.test' })
        .where(eq(message.id, legacy.messageId));

      const migration = await readFile(
        new URL('../drizzle/0019_outbound_smtp_attempt_fence.sql', import.meta.url),
        'utf8',
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await db.execute(sql.raw(statement));
      }

      const queues = await db
        .select({
          messageId: outboundSendQueue.messageId,
          smtpAttemptedAt: outboundSendQueue.smtpAttemptedAt,
          smtpOutcomePersistedAt: outboundSendQueue.smtpOutcomePersistedAt,
        })
        .from(outboundSendQueue)
        .where(inArray(outboundSendQueue.messageId, queueMessageIds));
      const byMessageId = new Map(queues.map((queue) => [queue.messageId, queue]));

      expect(byMessageId.get(ambiguous.messageId)).toMatchObject({
        smtpAttemptedAt: expect.any(Date),
        smtpOutcomePersistedAt: null,
      });
      expect(byMessageId.get(outcome.messageId)).toMatchObject({
        smtpAttemptedAt: expect.any(Date),
        smtpOutcomePersistedAt: expect.any(Date),
      });
      expect(byMessageId.get(legacy.messageId)).toMatchObject({
        smtpAttemptedAt: expect.any(Date),
        smtpOutcomePersistedAt: expect.any(Date),
      });
    });
  }, 30000);
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
      const baselineRows = await db
        .select({
          sourceMessageId: mailBaselineProjection.sourceMessageId,
          direction: mailBaselineProjection.direction,
          evidence: mailBaselineProjection.evidence,
        })
        .from(mailBaselineProjection)
        .where(eq(mailBaselineProjection.sourceMessageId, messageId));
      expect(baselineRows).toHaveLength(1);
      expect(baselineRows[0]).toMatchObject({ direction: 'outbound', sourceMessageId: messageId });
      const evidence = baselineRows[0]?.evidence as
        | {
            answerState?: string;
            unknownReason?: string;
            delivery?: { status?: string };
          }
        | undefined;
      expect(evidence?.delivery?.status).toBe('accepted');
      expect(evidence?.answerState).toBe('unknown');
      expect(evidence?.unknownReason).toBe('semantic_route_unavailable');
      const [queueReceipt] = await db
        .select({ smtpOutcomePersistedAt: outboundSendQueue.smtpOutcomePersistedAt })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, messageId));
      expect(queueReceipt?.smtpOutcomePersistedAt?.toISOString()).toBe(
        (evidence?.delivery as { acceptedAt?: string } | undefined)?.acceptedAt,
      );
    });
  }, 30000);

  it('reclaim sending with existing messageIdHeader → skip SMTP', async () => {
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

      const [accepted] = await db
        .select({ smtpOutcomePersistedAt: outboundSendQueue.smtpOutcomePersistedAt })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, messageId));
      expect(accepted?.smtpOutcomePersistedAt).toBeTruthy();

      // Simulate crash after SMTP persist, before queue marked sent: stale sending + header.
      const stale = new Date(Date.now() - RECLAIM_SENDING_AFTER_MS - 1000);
      await db
        .update(outboundSendQueue)
        .set({ status: 'sending', claimedAt: stale, updatedAt: new Date() })
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

      await flushDue({ db });
      expect(fake.sent).toHaveLength(1);

      const [q] = await db
        .select({
          status: outboundSendQueue.status,
          smtpOutcomePersistedAt: outboundSendQueue.smtpOutcomePersistedAt,
        })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, messageId))
        .limit(1);
      expect(q?.status).toBe('sent');
      expect(q?.smtpOutcomePersistedAt?.toISOString()).toBe(
        accepted?.smtpOutcomePersistedAt?.toISOString(),
      );
      const [projection] = await db
        .select({ evidence: mailBaselineProjection.evidence })
        .from(mailBaselineProjection)
        .where(eq(mailBaselineProjection.sourceMessageId, messageId))
        .limit(1);
      expect(
        (projection?.evidence as { delivery?: { acceptedAt?: string } } | undefined)?.delivery
          ?.acceptedAt,
      ).toBe(accepted?.smtpOutcomePersistedAt?.toISOString());
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
