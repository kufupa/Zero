import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  appendQuotePrepareDecision,
  quotePrepareDecisionsFromMetrics,
  recordQuotePrepareDecision,
  sanitizeQuotePrepareDecision,
} from '../src/ai/quote-prepare-ledger.js';
import {
  prefetchQuoteReadyAfterPartyMatch,
  prefetchQuoteReadyForExtraction,
} from '../src/ai/hms-jobs.js';
import { aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction } from '../src/db/schema/work.js';
import type { DB } from '../src/db/client.js';
import { DAVINCI_TRANSPORT_ID, NAVA_TRANSPORT_ID } from '../src/db/seed.js';
import { probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';

const reachable = await probeTestDb();

const QUOTE_ON = {
  HMS_JOB_QUEUE: 'on',
  HMS_QUOTE_PREPARE: 'true',
  HMS_QUOTE_PREPARE_PER_HOUR: '6',
  HMS_DAVINCI_MAKE_QUOTE: 'on',
  RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV: '/tmp/hrdav-quote.json',
};

function quotePayload(arrival = '2099-11-12', departure = '2099-11-14') {
  return {
    origin: 'person',
    contact: { name: 'Alex Guest', email: 'alex@example.test', phone: '+27000000000' },
    agency: 'Acme Lodging Holdings',
    endClient: 'Example Client',
    confirmationNumbers: [],
    stays: [
      {
        id: 's_12345678',
        requested: { arrival, departure },
        booked: null,
        totalRooms: 1,
        rows: [
          {
            id: 'r_12345678',
            roomType: 'Standard King',
            rooms: 1,
            adultsPerRoom: 2,
            childAges: [],
            board: null,
          },
        ],
      },
    ],
    missing: [],
  };
}

async function seedExtraction(
  db: DB,
  input: {
    transportId?: string;
    spam?: boolean;
    admissionSnapshotId?: string | null;
    payload?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
  } = {},
) {
  const transportId = input.transportId ?? DAVINCI_TRANSPORT_ID;
  const threadId = `thread-${randomUUID()}`;
  const messageId = `msg-${randomUUID()}`;
  await db.insert(mailThread).values({
    id: threadId,
    transportId,
    threadRootId: threadId,
    ...(input.spam ? { spamAt: new Date() } : {}),
  });
  await db.insert(message).values({
    id: messageId,
    transportId,
    threadId,
    direction: 'inbound',
    fromAddress: 'agent@example.test',
    toAddresses: [],
    subject: 'Quote request',
    textBody: 'Please quote a future stay for Alex Guest at alex@example.test.',
    receivedAt: new Date(),
  });
  await db.insert(mailExtraction).values({
    id: randomUUID(),
    messageId,
    extractorVersion: `quote-prepare-ledger-${randomUUID()}`,
    status: 'succeeded',
    kind: 'quote',
    payload: input.payload ?? quotePayload(),
  });
  const [run] = await db
    .insert(aiWorkflowRun)
    .values({
      id: randomUUID(),
      transportId,
      threadId,
      triggerMessageId: messageId,
      runKind: 'inbound_extraction',
      idempotencyKey: `inbound-extraction:${messageId}`,
      modelId: 'not_applicable',
      promptVersion: 'triage-v6',
      admissionSnapshotId:
        input.admissionSnapshotId === undefined ? `snapshot-${randomUUID()}` : input.admissionSnapshotId,
      state: 'succeeded',
      executorLane: 'default',
      priority: 0,
      metrics: input.metrics ?? { keep: true },
    })
    .returning();
  if (!run) throw new Error('inbound extraction seed failed');
  return {
    threadId,
    messageId,
    run,
    prefetchRun: {
      id: run.id,
      runKind: 'inbound_extraction' as const,
      transportId,
      triggerMessageId: messageId,
      admissionSnapshotId: run.admissionSnapshotId,
    },
  };
}

function preparedQuoteRows(db: DB, messageId: string) {
  return db
    .select({ id: aiWorkflowRun.id })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.triggerMessageId, messageId),
        sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`,
      ),
    );
}

function assertNoPii(metrics: unknown) {
  const blob = JSON.stringify(metrics);
  expect(blob).not.toMatch(/alex@example\.test/i);
  expect(blob).not.toMatch(/Alex Guest/);
  expect(blob).not.toMatch(/\+27000000000/);
  expect(blob).not.toMatch(/Please quote a future stay/i);
}

describe('quote prepare ledger (pure)', () => {
  it('keeps only closed tokens and drops PII-shaped fields', () => {
    const decision = sanitizeQuotePrepareDecision({
      outcome: 'skipped',
      reason: 'spam from alex@example.test please quote Alex Guest',
      queued: 3,
      errorClass: 'POLICY_BLOCK',
      at: new Date('2026-10-26T00:00:00.000Z'),
    });
    expect(decision).toEqual({
      at: '2026-10-26T00:00:00.000Z',
      outcome: 'skipped',
      reason: 'unknown',
    });
    expect(JSON.stringify(decision)).not.toMatch(/@/);
  });

  it('appends under existing metrics and refuses a non-array ledger', () => {
    const first = appendQuotePrepareDecision({ keep: 1, quotePrepared: false }, {
      at: '2026-10-26T00:00:00.000Z',
      outcome: 'skipped',
      reason: 'disabled',
    });
    expect(first).toMatchObject({ keep: 1, quotePrepared: false });
    expect(quotePrepareDecisionsFromMetrics(first)).toHaveLength(1);
    expect(
      appendQuotePrepareDecision({ quotePrepareDecisions: { bad: true } }, {
        at: '2026-10-26T00:00:00.000Z',
        outcome: 'skipped',
        reason: 'spam',
      }),
    ).toBeNull();
  });
});

const FANOUT = [
  {
    name: 'flag off',
    flag: false,
    admission: true,
    cap: 6,
    spam: false,
    reason: 'disabled',
    queued: 0,
  },
  {
    name: 'no live admission',
    flag: true,
    admission: false,
    cap: 6,
    spam: false,
    reason: 'no_live_admission',
    queued: 0,
  },
  {
    name: 'cap exhausted',
    flag: true,
    admission: true,
    cap: 0,
    spam: false,
    reason: 'cap_exhausted',
    queued: 0,
  },
  {
    name: 'evaluator skip',
    flag: true,
    admission: true,
    cap: 6,
    spam: true,
    reason: 'spam',
    queued: 0,
  },
  {
    name: 'live admitted under cap',
    flag: true,
    admission: true,
    cap: 6,
    spam: false,
    reason: 'queued',
    queued: 1,
  },
] as const;

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('quote prepare ledger (lane DB)', { timeout: 60_000 }, () => {
  it.each(FANOUT)(
    'flag × live-admission × cap: $name',
    (row) =>
      withSeededTestDb(async (db) => {
        const seeded = await seedExtraction(db, {
          spam: row.spam,
          admissionSnapshotId: row.admission ? `snapshot-${randomUUID()}` : null,
        });
        const env = {
          ...QUOTE_ON,
          HMS_QUOTE_PREPARE: row.flag ? 'true' : 'false',
          HMS_QUOTE_PREPARE_PER_HOUR: String(row.cap),
        };
        const created = row.admission
          ? await prefetchQuoteReadyForExtraction(seeded.prefetchRun, db, env)
          : await prefetchQuoteReadyAfterPartyMatch(seeded.prefetchRun, db, env);
        const [source] = await db
          .select({ metrics: aiWorkflowRun.metrics })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, seeded.run.id));
        const decisions = quotePrepareDecisionsFromMetrics(source?.metrics);
        expect(created >= row.queued).toBe(true);
        if (row.queued === 0) expect(created).toBe(0);
        expect(decisions).toEqual([
          expect.objectContaining({
            outcome: row.reason === 'queued' ? 'queued' : 'skipped',
            reason: row.reason,
          }),
        ]);
        if (row.reason === 'queued') {
          expect(decisions[0]?.queued).toBeGreaterThanOrEqual(1);
        }
        expect(source?.metrics).toMatchObject({ keep: true });
        assertNoPii(source?.metrics);
        const prepared = await preparedQuoteRows(db, seeded.messageId);
        if (row.queued === 0) expect(prepared).toEqual([]);
        else expect(prepared.length).toBeGreaterThanOrEqual(1);
      }),
  );

  it('keeps concurrent skip reasons under the source-row lock', () =>
    withSeededTestDb(async (db) => {
      const seeded = await seedExtraction(db, { metrics: { keep: 'sibling' } });
      expect(
        await recordQuotePrepareDecision(db, seeded.prefetchRun, { outcome: 'skipped', reason: 'disabled' }),
      ).toBe(true);
      expect(
        await recordQuotePrepareDecision(db, seeded.prefetchRun, { outcome: 'skipped', reason: 'spam' }),
      ).toBe(true);
      const [source] = await db
        .select({ metrics: aiWorkflowRun.metrics })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.id, seeded.run.id));
      const reasons = quotePrepareDecisionsFromMetrics(source?.metrics)
        .map((decision) => decision.reason)
        .sort();
      expect(reasons).toEqual(['disabled', 'spam']);
      expect(source?.metrics).toMatchObject({ keep: 'sibling' });
      assertNoPii(source?.metrics);
    }));

  it('records target refusal, empty plan, and a safe error class', () =>
    withSeededTestDb(async (db) => {
      const refused = await seedExtraction(db);
      expect(
        await prefetchQuoteReadyForExtraction(refused.prefetchRun, db, {
          HMS_JOB_QUEUE: 'on',
          HMS_QUOTE_PREPARE: 'true',
          HMS_QUOTE_PREPARE_PER_HOUR: '6',
        }),
      ).toBe(0);
      const empty = await seedExtraction(db, { payload: quotePayload('2020-11-12', '2020-11-14') });
      expect(await prefetchQuoteReadyForExtraction(empty.prefetchRun, db, QUOTE_ON)).toBe(0);
      const unknownProperty = await seedExtraction(db, { transportId: NAVA_TRANSPORT_ID });
      await expect(
        prefetchQuoteReadyForExtraction(unknownProperty.prefetchRun, db, QUOTE_ON),
      ).rejects.toBeTruthy();

      const rows = await db
        .select({
          id: aiWorkflowRun.id,
          triggerMessageId: aiWorkflowRun.triggerMessageId,
          metrics: aiWorkflowRun.metrics,
        })
        .from(aiWorkflowRun)
        .where(
          eq(aiWorkflowRun.runKind, 'inbound_extraction'),
        );
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      expect(quotePrepareDecisionsFromMetrics(byId[refused.run.id]?.metrics)).toEqual([
        expect.objectContaining({ outcome: 'skipped', reason: 'target_refused' }),
      ]);
      expect(quotePrepareDecisionsFromMetrics(byId[empty.run.id]?.metrics)).toEqual([
        expect.objectContaining({ outcome: 'skipped', reason: 'past_dates' }),
      ]);
      expect(quotePrepareDecisionsFromMetrics(byId[unknownProperty.run.id]?.metrics)).toEqual([
        expect.objectContaining({ outcome: 'error', reason: 'error', errorClass: 'POLICY_BLOCK' }),
      ]);
      for (const row of rows) assertNoPii(row.metrics);
      expect(await preparedQuoteRows(db, refused.messageId)).toEqual([]);
      expect(await preparedQuoteRows(db, empty.messageId)).toEqual([]);
      expect(await preparedQuoteRows(db, unknownProperty.messageId)).toEqual([]);
    }));
});
