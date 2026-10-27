import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  countPrefetchReservations,
  decidePrefetchCapacity,
  occupyPrefetchReservation,
  PREFETCH_CAPACITY_WINDOW_MS,
} from '../src/ai/prefetch-capacity.js';
import {
  prefetchQuoteReadyAfterPartyMatch,
  prefetchQuoteReadyForExtraction,
  executeHmsJob,
  HMS_JOB_PRIORITY_PREFETCH,
} from '../src/ai/hms-jobs.js';
import { claimNextAiRun, HMS_JOB_PROMPT_VERSION, markAiRunRunning } from '../src/ai/run-ledger.js';
import { quotePrepareDecisionsFromMetrics } from '../src/ai/quote-prepare-ledger.js';
import { aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction } from '../src/db/schema/work.js';
import type { DB } from '../src/db/client.js';
import {
  DAVINCI_TRANSPORT_EMAIL,
  DAVINCI_TRANSPORT_ID,
  NAVA_TRANSPORT_ID,
  TRANSPORT_ID,
} from '../src/db/seed.js';
import { probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';

const reachable = await probeTestDb();

const QUOTE_ON = {
  HMS_JOB_QUEUE: 'on',
  HMS_QUOTE_PREPARE: 'true',
  HMS_QUOTE_PREPARE_PER_HOUR: '6',
  HMS_DAVINCI_MAKE_QUOTE: 'on',
  RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV: '/tmp/hrdav-quote.json',
};

const staffQuoteRunner = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/ai/staff-quote-run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/staff-quote-run.js')>()),
  runStaffQuote: staffQuoteRunner.run,
}));

afterEach(() => {
  staffQuoteRunner.run.mockReset();
  vi.unstubAllEnvs();
});

function quotePayload(arrival = '2099-11-12', departure = '2099-11-14') {
  return {
    origin: 'person',
    contact: { name: 'Alex Guest', email: 'alex@example.test', phone: null },
    agency: 'Acme Lodging Holdings',
    endClient: 'Example Client',
    confirmationNumbers: [],
    stays: [
      {
        id: 's_12345678',
        hotel: null,
        requested: { arrival, departure },
        booked: null,
        totalRooms: 2,
        rows: [
          {
            id: 'r_12345678',
            roomType: 'Standard King',
            rooms: 2,
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
    fromAddress: 'guest@example.test',
    toAddresses: transportId === DAVINCI_TRANSPORT_ID ? [DAVINCI_TRANSPORT_EMAIL] : [],
    subject: 'Quote request',
    textBody: 'Please quote a future stay.',
    receivedAt: new Date(),
  });
  await db.insert(mailExtraction).values({
    id: randomUUID(),
    messageId,
    extractorVersion: `prefetch-capacity-${randomUUID()}`,
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
    .select({
      id: aiWorkflowRun.id,
      state: aiWorkflowRun.state,
      nextRunAt: aiWorkflowRun.nextRunAt,
      metrics: aiWorkflowRun.metrics,
      triggerMessageId: aiWorkflowRun.triggerMessageId,
    })
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
  expect(blob).not.toMatch(/Please quote a future stay/i);
}

describe('prefetch capacity (pure)', () => {
  const now = new Date('2026-10-26T03:00:00.000Z');

  it('disables on zero or invalid cap instead of queuing forever', () => {
    expect(decidePrefetchCapacity({ used: 0, perHour: 0, now }).action).toBe('disable');
    expect(decidePrefetchCapacity({ used: 0, perHour: -1, now }).action).toBe('disable');
    expect(decidePrefetchCapacity({ used: 0, perHour: 1.5, now }).action).toBe('disable');
  });

  it('admits while the hourly reservation is open', () => {
    const decision = decidePrefetchCapacity({ used: 0, perHour: 1, now });
    expect(decision).toEqual({ action: 'admit', used: 0, nextRunAt: now });
  });

  it('defers overflow until the oldest reservation leaves the window', () => {
    const oldest = new Date('2026-10-26T02:10:00.000Z');
    const decision = decidePrefetchCapacity({
      used: 1,
      perHour: 1,
      now,
      oldestCreatedAt: oldest,
    });
    expect(decision.action).toBe('defer');
    expect(decision.nextRunAt.getTime()).toBe(oldest.getTime() + PREFETCH_CAPACITY_WINDOW_MS);
    expect(decision.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it('admits one oversized batch only when the hourly window is empty and never splits a batch', () => {
    expect(decidePrefetchCapacity({ used: 0, perHour: 6, batchSize: 9, now }).action).toBe('admit');
    expect(decidePrefetchCapacity({ used: 1, perHour: 6, batchSize: 9, now }).action).toBe('defer');
    expect(decidePrefetchCapacity({ used: 5, perHour: 6, batchSize: 2, now }).action).toBe('defer');
  });
});

const FANOUT = [
  {
    name: 'flag off',
    flag: false,
    admission: true,
    cap: 6,
    fillCap: false,
    reason: 'disabled',
    queued: 0,
    deferred: false,
  },
  {
    name: 'no live admission',
    flag: true,
    admission: false,
    cap: 6,
    fillCap: false,
    reason: 'no_live_admission',
    queued: 0,
    deferred: false,
  },
  {
    name: 'cap disabled',
    flag: true,
    admission: true,
    cap: 0,
    fillCap: false,
    reason: 'cap_exhausted',
    queued: 0,
    deferred: false,
  },
  {
    name: 'cap overflow',
    flag: true,
    admission: true,
    cap: 1,
    fillCap: true,
    reason: 'deferred',
    queued: 1,
    deferred: true,
  },
  {
    name: 'live admitted under cap',
    flag: true,
    admission: true,
    cap: 6,
    fillCap: false,
    reason: 'queued',
    queued: 1,
    deferred: false,
  },
] as const;

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('prefetch capacity (lane DB)', { timeout: 60_000 }, () => {
  it.each(FANOUT)(
    'flag × live-admission × cap: $name',
    (row) =>
      withSeededTestDb(async (db) => {
        if (row.fillCap) {
          const filler = await seedExtraction(db);
          expect(
            await prefetchQuoteReadyForExtraction(filler.prefetchRun, db, {
              ...QUOTE_ON,
              HMS_QUOTE_PREPARE_PER_HOUR: '1',
            }),
          ).toBeGreaterThanOrEqual(1);
        }
        const seeded = await seedExtraction(db, {
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
        expect(decisions.map((decision) => decision.reason)).toEqual([row.reason]);
        if (row.queued === 0) expect(created).toBe(0);
        else expect(created).toBeGreaterThanOrEqual(row.queued);
        const prepared = await preparedQuoteRows(db, seeded.messageId);
        if (row.queued === 0) expect(prepared).toEqual([]);
        else expect(prepared.length).toBeGreaterThanOrEqual(1);
        if (row.deferred) {
          expect(prepared.some((job) => job.nextRunAt && job.nextRunAt.getTime() > Date.now())).toBe(true);
          expect(
            prepared.some(
              (job) =>
                job.metrics &&
                typeof job.metrics === 'object' &&
                (job.metrics as { prefetchDeferred?: boolean }).prefetchDeferred === true,
            ),
          ).toBe(true);
        }
        assertNoPii(source?.metrics);
      }),
  );

  it('unknown mailbox property fails closed and does not enqueue', () =>
    withSeededTestDb(async (db) => {
      const seeded = await seedExtraction(db, { transportId: NAVA_TRANSPORT_ID });
      await expect(prefetchQuoteReadyForExtraction(seeded.prefetchRun, db, QUOTE_ON)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      expect(await preparedQuoteRows(db, seeded.messageId)).toEqual([]);
    }));

  it('overflow is deferred with nextRunAt and later runs once without duplicate enqueue', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('PORT', '3000');
      vi.stubEnv('BETTER_AUTH_URL', 'https://nava.legacy.local');
      vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(32));
      vi.stubEnv('AWS_REGION', 'synthetic-region-1');
      vi.stubEnv('S3_BUCKET', 'prefetch-capacity-test');
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      vi.stubEnv('HMS_QUOTE_PREPARE_PER_HOUR', '1');
      vi.stubEnv('HMS_DAVINCI_MAKE_QUOTE', 'on');
      vi.stubEnv('RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV', '/tmp/hrdav-quote.json');
      const env = { ...QUOTE_ON, HMS_QUOTE_PREPARE_PER_HOUR: '1' };
      const first = await seedExtraction(db, { transportId: TRANSPORT_ID });
      const second = await seedExtraction(db, { transportId: TRANSPORT_ID });
      expect(await prefetchQuoteReadyForExtraction(first.prefetchRun, db, env)).toBeGreaterThanOrEqual(1);
      const firstCreated = await preparedQuoteRows(db, first.messageId);
      expect(await prefetchQuoteReadyForExtraction(second.prefetchRun, db, env)).toBeGreaterThanOrEqual(1);
      const afterFirstOverflow = await preparedQuoteRows(db, second.messageId);
      expect(afterFirstOverflow.length).toBeGreaterThanOrEqual(1);
      expect(afterFirstOverflow.some((job) => job.nextRunAt && job.nextRunAt.getTime() > Date.now())).toBe(true);

      expect(await prefetchQuoteReadyForExtraction(second.prefetchRun, db, env)).toBe(0);
      expect(await preparedQuoteRows(db, second.messageId)).toHaveLength(afterFirstOverflow.length);

      const aged = new Date(Date.now() - 2 * PREFETCH_CAPACITY_WINDOW_MS);
      for (const job of firstCreated) {
        await db
          .update(aiWorkflowRun)
          .set({
            state: 'succeeded',
            createdAt: aged,
            finishedAt: aged,
            nextRunAt: null,
            updatedAt: aged,
          })
          .where(eq(aiWorkflowRun.id, job.id));
      }
      const deferred = afterFirstOverflow.filter(
        (job) =>
          job.metrics &&
          typeof job.metrics === 'object' &&
          (job.metrics as { prefetchDeferred?: boolean }).prefetchDeferred === true,
      );
      expect(deferred.length).toBeGreaterThanOrEqual(1);
      const [target, ...siblings] = deferred;
      if (!target) throw new Error('expected a deferred prepared quote');
      const later = new Date(Date.now() + PREFETCH_CAPACITY_WINDOW_MS);
      for (const job of siblings) {
        await db
          .update(aiWorkflowRun)
          .set({ createdAt: aged, nextRunAt: later, updatedAt: aged })
          .where(eq(aiWorkflowRun.id, job.id));
      }
      await db
        .update(aiWorkflowRun)
        .set({ nextRunAt: new Date(), updatedAt: new Date() })
        .where(eq(aiWorkflowRun.id, target.id));

      vi.stubEnv('HITL_LEDGER', 'on');
      staffQuoteRunner.run.mockImplementation(async (...args: unknown[]) => {
        const quoteInput = args[0] as { messageId: string };
        const transaction = args[2] as DB;
        const options = args[3] as {
          commitQueuedResult?: (result: Record<string, unknown>, transaction: DB) => Promise<boolean>;
        };
        const quoteResult = {
          status: 'ready',
          workflowRunId: target.id,
          revisionRef: 'prepared-overflow',
          messageId: quoteInput.messageId,
          factRefs: [],
          selectionEpoch: 0,
          inputRevision: 0,
          inputDigest: 'd'.repeat(64),
          totalMinor: 1,
          currency: 'ZAR',
        };
        await options.commitQueuedResult?.(quoteResult, transaction);
        return quoteResult;
      });

      const claimed = await claimNextAiRun({
        ownerId: 'prefetch-capacity-worker',
        lane: 'hms',
        runKind: 'read_tool',
        promptVersion: HMS_JOB_PROMPT_VERSION,
        db,
      });
      if (!claimed) throw new Error('expected deferred prepared quote to be claimable');
      expect(claimed.id).toBe(target.id);
      if (
        !(await markAiRunRunning(
          {
            runId: claimed.id,
            claimOwner: claimed.claimOwner!,
            claimToken: claimed.claimToken!,
            deadlineAt: claimed.deadlineAt!,
          },
          db,
        ))
      ) {
        throw new Error('markAiRunRunning fenced out');
      }
      expect(
        await executeHmsJob({
          run: claimed,
          fence: {
            runId: claimed.id,
            claimOwner: claimed.claimOwner!,
            claimToken: claimed.claimToken!,
            deadlineAt: claimed.deadlineAt!,
          },
          db,
        }),
      ).toBe('succeeded');
      expect(staffQuoteRunner.run).toHaveBeenCalledTimes(1);

      const admittedBatch = await preparedQuoteRows(db, second.messageId);
      expect(
        admittedBatch.every(
          (row) =>
            (row.metrics as { prefetchBatchDecision?: string; prefetchDeferred?: boolean } | null)
              ?.prefetchBatchDecision === 'admitted' &&
            (row.metrics as { prefetchDeferred?: boolean } | null)?.prefetchDeferred !== true,
        ),
      ).toBe(true);
      expect(
        admittedBatch
          .filter((row) => row.state === 'queued' || row.state === 'retry_wait')
          .every((row) => row.nextRunAt !== null && row.nextRunAt.getTime() <= Date.now()),
      ).toBe(true);

      expect(await prefetchQuoteReadyForExtraction(second.prefetchRun, db, env)).toBe(0);
      expect(await preparedQuoteRows(db, second.messageId)).toHaveLength(afterFirstOverflow.length);
    }));

  it('occupying a waking job counts it against the current hour', () =>
    withSeededTestDb(async (db) => {
      const env = { ...QUOTE_ON, HMS_QUOTE_PREPARE_PER_HOUR: '1' };
      const seeded = await seedExtraction(db);
      expect(await prefetchQuoteReadyForExtraction(seeded.prefetchRun, db, env)).toBeGreaterThanOrEqual(1);
      const rows = await preparedQuoteRows(db, seeded.messageId);
      const job = rows[0];
      if (!job) throw new Error('expected a prepared quote');
      const batchSize = (job.metrics as { prefetchBatchSize?: number } | null)?.prefetchBatchSize;
      expect(batchSize).toBe(rows.length);
      const aged = new Date(Date.now() - 2 * PREFETCH_CAPACITY_WINDOW_MS);
      for (const row of rows) {
        await db.update(aiWorkflowRun).set({ createdAt: aged, updatedAt: aged }).where(eq(aiWorkflowRun.id, row.id));
      }
      const since = new Date(Date.now() - PREFETCH_CAPACITY_WINDOW_MS);
      expect(
        await countPrefetchReservations(db, {
          transportId: DAVINCI_TRANSPORT_ID,
          kind: 'staff_quote',
          since,
        }),
      ).toMatchObject({ used: 0 });
      await occupyPrefetchReservation(db, job.id);
      expect(
        await countPrefetchReservations(db, {
          transportId: DAVINCI_TRANSPORT_ID,
          kind: 'staff_quote',
          since,
        }),
      ).toMatchObject({ used: batchSize });
      const [firstStamp] = await db
        .select({ createdAt: aiWorkflowRun.createdAt })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.id, job.id));
      await occupyPrefetchReservation(db, job.id);
      const [secondStamp] = await db
        .select({ createdAt: aiWorkflowRun.createdAt, metrics: aiWorkflowRun.metrics })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.id, job.id));
      expect(secondStamp?.createdAt.getTime()).toBe(firstStamp?.createdAt.getTime());
      expect(secondStamp?.metrics).toMatchObject({ prefetchAdmittedAt: expect.any(String) });
    }));
});
