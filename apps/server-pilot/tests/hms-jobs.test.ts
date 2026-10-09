import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  canClaimReadToolRun,
  claimNextAiRun,
  HMS_JOB_PROMPT_VERSION,
  markAiRunRunning,
  type AiWorkflowRun,
} from '../src/ai/run-ledger.js';
import {
  enqueueHmsJob,
  executeHmsJob,
  extractHmsConfirmations,
  hmsJobRequestSchema,
  HMS_JOB_PRIORITY_PREFETCH,
  HMS_JOB_PRIORITY_USER,
  prefetchHmsConfirmations,
  queueUserHmsJob,
  readHmsJobView,
  requeueHmsReadsAfterRestart,
} from '../src/ai/hms-jobs.js';
import { paneStayLookupLoaders, type PaneStayLookupSpawnResult } from '../src/ai/pane-stay-lookup.js';
import type { PaneStayLock } from '../src/ai/pane-stay-save.js';
import { aiDraftGeneration, aiWorkflowRun, message, mailThread } from '../src/db/schema/mail.js';
import type { DB } from '../src/db/client.js';
import { parseEnv } from '../src/env.js';
import { createPropertyReadLock, PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';
import { CENTURION_USER_ID, TRANSPORT_ID } from '../src/db/seed.js';
import { probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';

const reachable = await probeTestDb();
const TENANT = 'tenant-centurion';
const CONFIRMATION = '1234567-1';
const LANE_OWNER = 'hms-ai-worker-111';

afterEach(() => {
  paneStayLookupLoaders.lock = null;
  paneStayLookupLoaders.spawn = null;
  vi.unstubAllEnvs();
});

function lockWith(acquired: boolean): PaneStayLock {
  const lock = createPropertyReadLock({
    tenantId: TENANT,
    propertyCode: 'HRCEN',
    connectionFactory: async () => ({
      query: async <T = unknown>(statement: string) =>
        (statement.includes('pg_try_advisory_lock')
          ? [{ pg_try_advisory_lock: acquired }]
          : [{ pg_advisory_unlock: true }]) as unknown as T,
      close: async () => undefined,
    }),
  });
  return lock as unknown as PaneStayLock;
}

const FOUND: PaneStayLookupSpawnResult = {
  outcome: 'found',
  reason: null,
  stay: {
    status: 'Reserved',
    confirmation: CONFIRMATION,
    lastName: 'Dlamini',
    firstName: 'Thandi',
    arrival: '2026-10-12',
    departure: '2026-10-14',
    nights: 2,
    adults: 2,
    children: 0,
    roomType: 'DBL',
    ratePlan: 'BAR',
    mealPlan: 'BB',
    averageRate: '1200.00',
    grandTotal: '2400.00',
    balance: '0.00',
    sourceOfBusiness: null,
    guaranteeType: null,
    bookingAgency: null,
    organization: null,
  },
  rows: [],
  screenshots: ['stay.png'],
  runId: randomUUID(),
  runDir: `/tmp/pane-lookup-${randomUUID()}`,
};

/** A thread with one inbound message, so a job has trigger mail to anchor to. */
async function seedThread(db: DB, subject = 'Amend booking'): Promise<{ threadId: string; messageId: string }> {
  const threadId = `thread-${randomUUID()}`;
  const messageId = `msg-${randomUUID()}`;
  await db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID, threadRootId: threadId });
  await db.insert(message).values({
    id: messageId,
    transportId: TRANSPORT_ID,
    threadId,
    direction: 'inbound',
    fromAddress: 'guest@example.test',
    subject,
    textBody: `Please amend ${CONFIRMATION}.`,
    receivedAt: new Date(),
  });
  return { threadId, messageId };
}

async function claimJob(db: DB, ownerId = LANE_OWNER): Promise<AiWorkflowRun> {
  const claimed = await claimNextAiRun({
    ownerId,
    lane: 'hms',
    runKind: 'read_tool',
    promptVersion: HMS_JOB_PROMPT_VERSION,
    db,
  });
  if (!claimed) throw new Error('expected a claimable HMS job');
  return claimed;
}

async function runClaimedJob(db: DB, run: AiWorkflowRun) {
  const running = await markAiRunRunning(
    { runId: run.id, claimOwner: run.claimOwner!, claimToken: run.claimToken!, deadlineAt: run.deadlineAt! },
    db,
  );
  if (!running) throw new Error('markAiRunRunning fenced out');
  return executeHmsJob({
    run,
    fence: {
      runId: run.id,
      claimOwner: run.claimOwner!,
      claimToken: run.claimToken!,
      deadlineAt: run.deadlineAt!,
    },
    db,
  });
}

describe('U23 HMS job queue (pure)', () => {
  it('takes validated confirmation numbers from mail text and ignores dates and short numbers', () => {
    expect(
      extractHmsConfirmations('Amend 1234567-1 on 2026-10-09, ref 99-1, phone 10-09-2026'),
    ).toEqual(['1234567-1']);
    expect(extractHmsConfirmations('1234567-1 and 7654321-2 and 1111111-1 and 2222222-1 and 3333333-1')).toHaveLength(
      3,
    );
  });

  it('accepts only closed find and guest-search requests', () => {
    expect(hmsJobRequestSchema.safeParse({ kind: 'find', confirmation: CONFIRMATION }).success).toBe(true);
    expect(
      hmsJobRequestSchema.safeParse({ kind: 'find', confirmation: CONFIRMATION, propertyCode: 'X' }).success,
    ).toBe(false);
    expect(
      hmsJobRequestSchema.safeParse({
        kind: 'search_guest',
        lastName: 'D',
        arrival: '2026-10-12',
      }).success,
    ).toBe(false);
  });

  it('lets pane jobs claim without the read service, and nothing else on a read-only lane', () => {
    expect(
      canClaimReadToolRun({
        runKind: 'read_tool',
        lane: 'hms',
        readServiceEnabled: false,
        promptVersion: HMS_JOB_PROMPT_VERSION,
      }),
    ).toBe(true);
    expect(
      canClaimReadToolRun({ runKind: 'read_tool', lane: 'hms', readServiceEnabled: false, promptVersion: 'hms-read/1' }),
    ).toBe(false);
    expect(
      canClaimReadToolRun({ runKind: 'read_tool', lane: 'default', readServiceEnabled: true, promptVersion: HMS_JOB_PROMPT_VERSION }),
    ).toBe(false);
  });
});

// Each case seeds a fresh rolled-back database; the shared lane box is slow under load.
describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('U23 HMS job queue (lane DB)', { timeout: 60_000 }, () => {
  beforeEach(() => {
    // parseEnv needs the server's required keys; the rest of the lane config stays unset.
    vi.stubEnv('PORT', '3000');
    vi.stubEnv('BETTER_AUTH_URL', 'https://nava.legacy.local');
    vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(32));
    vi.stubEnv('AWS_REGION', 'synthetic-region-1');
    vi.stubEnv('S3_BUCKET', 'u23-synthetic-bucket');
  });

  it('AE5: a queued find completes and its status and result come back from the database after remount', () =>
    withSeededTestDb(async (db) => {
      paneStayLookupLoaders.lock = lockWith(true);
      paneStayLookupLoaders.spawn = vi.fn(async () => FOUND);
      const { threadId } = await seedThread(db);
      const queued = await queueUserHmsJob(
        { transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, threadId, request: { kind: 'find', confirmation: CONFIRMATION } },
        db,
      );
      expect(queued).not.toBeNull();
      const before = await readHmsJobView({ transportId: TRANSPORT_ID, runId: queued!.id }, db);
      expect(before).toMatchObject({ status: 'queued', position: 1, prefetch: false });

      // The pane is unmounted here. Only the database holds state from now on.
      const claimed = await claimJob(db);
      expect(await runClaimedJob(db, claimed)).toBe('succeeded');

      const remounted = await readHmsJobView(
        { transportId: TRANSPORT_ID, threadId, kind: 'find', confirmation: CONFIRMATION },
        db,
      );
      expect(remounted).toMatchObject({ runId: queued!.id, status: 'done', position: null });
      expect(remounted?.result).toMatchObject({ outcome: 'found', screenshots: ['stay.png'] });
      expect(remounted?.asOf).toEqual(expect.any(String));
    }));

  it('queued user jobs report their position in the lane', () =>
    withSeededTestDb(async (db) => {
      const { threadId } = await seedThread(db);
      const first = await queueUserHmsJob(
        { transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, threadId, request: { kind: 'find', confirmation: CONFIRMATION } },
        db,
      );
      const second = await queueUserHmsJob(
        {
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          threadId,
          request: { kind: 'search_guest', lastName: 'Dlamini', arrival: '2026-10-12' },
        },
        db,
      );
      expect((await readHmsJobView({ transportId: TRANSPORT_ID, runId: first!.id }, db))?.position).toBe(1);
      expect((await readHmsJobView({ transportId: TRANSPORT_ID, runId: second!.id }, db))?.position).toBe(2);
    }));

  it('a restart moves a read run that the previous process held to retry_wait', () =>
    withSeededTestDb(async (db) => {
      const { threadId } = await seedThread(db);
      const job = await queueUserHmsJob(
        { transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, threadId, request: { kind: 'find', confirmation: CONFIRMATION } },
        db,
      );
      const claimed = await claimJob(db, 'hms-ai-worker-111');
      await markAiRunRunning(
        { runId: claimed.id, claimOwner: claimed.claimOwner!, claimToken: claimed.claimToken!, deadlineAt: claimed.deadlineAt! },
        db,
      );
      expect(await requeueHmsReadsAfterRestart({ ownerId: 'hms-ai-worker-222' }, db)).toBe(1);
      const view = await readHmsJobView({ transportId: TRANSPORT_ID, runId: job!.id }, db);
      expect(view).toMatchObject({ status: 'retrying', failureClass: 'LEASE_LOST' });
    }));

  it('prefetch never takes the lock while a staff quote is in flight', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      await db.insert(aiDraftGeneration).values({
        id: randomUUID(),
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: CENTURION_USER_ID,
        model: 'staff-approved-native',
        promptVersion: 'quote-v1',
        status: 'running',
      });
      const takeLock = vi.fn(async () => FOUND);
      paneStayLookupLoaders.lock = { withLock: takeLock } as unknown as PaneStayLock;
      paneStayLookupLoaders.spawn = vi.fn(async () => FOUND);
      const { run } = await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          workItemId: null,
          userId: null,
          request: { kind: 'find', confirmation: CONFIRMATION },
          priority: HMS_JOB_PRIORITY_PREFETCH,
          idempotencyKey: `hms-job:prefetch:${TRANSPORT_ID}:${CONFIRMATION}:yield`,
        },
        db,
      );
      const claimed = await claimJob(db);
      expect(await runClaimedJob(db, claimed)).toBe('retry_wait');
      expect(takeLock).not.toHaveBeenCalled();
      const view = await readHmsJobView({ transportId: TRANSPORT_ID, runId: run.id }, db);
      expect(view).toMatchObject({ status: 'retrying', failureClass: 'STAFF_QUOTE_ACTIVE', attempts: 0 });
    }));

  it('a background run that finds the property lock busy requeues without using an attempt', () =>
    withSeededTestDb(async (db) => {
      paneStayLookupLoaders.lock = lockWith(false);
      const spawn = vi.fn(async () => FOUND);
      paneStayLookupLoaders.spawn = spawn;
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          workItemId: null,
          userId: null,
          request: { kind: 'find', confirmation: CONFIRMATION },
          priority: HMS_JOB_PRIORITY_PREFETCH,
          idempotencyKey: `hms-job:prefetch:${TRANSPORT_ID}:${CONFIRMATION}:busy`,
        },
        db,
      );
      const claimed = await claimJob(db);
      expect(await runClaimedJob(db, claimed)).toBe('retry_wait');
      expect(spawn).not.toHaveBeenCalled();
      expect(await readHmsJobView({ transportId: TRANSPORT_ID, runId: run.id }, db)).toMatchObject({
        status: 'retrying',
        failureClass: 'HMS_LOCK_BUSY',
        attempts: 0,
      });
    }));

  it('a user run that waits out a busy property lock is retried, not dropped', () =>
    withSeededTestDb(async (db) => {
      paneStayLookupLoaders.lock = {
        withLock: async () => {
          throw new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE);
        },
      } as unknown as PaneStayLock;
      const { threadId } = await seedThread(db);
      const job = await queueUserHmsJob(
        { transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, threadId, request: { kind: 'find', confirmation: CONFIRMATION } },
        db,
      );
      const claimed = await claimJob(db);
      expect(await runClaimedJob(db, claimed)).toBe('retry_wait');
      expect(await readHmsJobView({ transportId: TRANSPORT_ID, runId: job!.id }, db)).toMatchObject({
        status: 'retrying',
        failureClass: 'HMS_LOCK_BUSY',
        attempts: 1,
      });
    }));

  it('a user job is claimed before an older prefetch', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      const { run: prefetch } = await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          workItemId: null,
          userId: null,
          request: { kind: 'find', confirmation: CONFIRMATION },
          priority: HMS_JOB_PRIORITY_PREFETCH,
          idempotencyKey: `hms-job:prefetch:${TRANSPORT_ID}:${CONFIRMATION}:order`,
        },
        db,
      );
      const user = await queueUserHmsJob(
        { transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, threadId, request: { kind: 'find', confirmation: '7654321-2' } },
        db,
      );
      expect(prefetch.createdAt.getTime()).toBeLessThanOrEqual(user!.createdAt.getTime());
      const claimed = await claimJob(db);
      expect(claimed.id).toBe(user!.id);
      expect(claimed.priority).toBe(HMS_JOB_PRIORITY_USER);
    }));

  it('with HMS_LANE_PAUSED=1 the hms lane claims nothing, and resumes when unset', () =>
    withSeededTestDb(async (db) => {
      const { threadId } = await seedThread(db);
      await queueUserHmsJob(
        { transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, threadId, request: { kind: 'find', confirmation: CONFIRMATION } },
        db,
      );
      vi.stubEnv('HMS_LANE_PAUSED', '1');
      expect(parseEnv(process.env as Record<string, string | undefined>).HMS_LANE_PAUSED).toBe(true);
      expect(
        await claimNextAiRun({ ownerId: LANE_OWNER, lane: 'hms', runKind: 'read_tool', promptVersion: HMS_JOB_PROMPT_VERSION, db }),
      ).toBeNull();
      vi.stubEnv('HMS_LANE_PAUSED', '');
      expect(await claimJob(db)).toMatchObject({ promptVersion: HMS_JOB_PROMPT_VERSION });
    }));

  it('a prefetch snapshot records when it was taken, so the pane can show its age', () =>
    withSeededTestDb(async (db) => {
      paneStayLookupLoaders.lock = lockWith(true);
      paneStayLookupLoaders.spawn = vi.fn(async () => FOUND);
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          workItemId: null,
          userId: null,
          request: { kind: 'find', confirmation: CONFIRMATION },
          priority: HMS_JOB_PRIORITY_PREFETCH,
          idempotencyKey: `hms-job:prefetch:${TRANSPORT_ID}:${CONFIRMATION}:age`,
        },
        db,
      );
      const before = Date.now();
      await runClaimedJob(db, await claimJob(db));
      const view = await readHmsJobView({ transportId: TRANSPORT_ID, runId: run.id }, db);
      expect(view).toMatchObject({ status: 'done', prefetch: true });
      const asOf = Date.parse(view!.asOf!);
      expect(asOf).toBeGreaterThanOrEqual(before - 1000);
      expect(asOf).toBeLessThanOrEqual(Date.now() + 1000);
    }));

  it('a duplicate prefetch is a no-op, and the hourly cap holds per transport', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db, 'Booking 1234567-1 and 7654321-2');
      const inbound = await insertInboundTriage(db, threadId, messageId);
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true, HMS_PREFETCH_PER_HOUR: 1 };
      expect(await prefetchHmsConfirmations(inbound, db, env)).toBe(1);
      expect(await prefetchHmsConfirmations(inbound, db, env)).toBe(0);
      const rows = await db
        .select({ id: aiWorkflowRun.id })
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
            eq(aiWorkflowRun.priority, HMS_JOB_PRIORITY_PREFETCH),
          ),
        );
      expect(rows).toHaveLength(1);
    }));

  it('prefetch stays off unless HMS_PREFETCH_ENABLED is set, and never runs for backfill', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db, 'Booking 1234567-1');
      const inbound = await insertInboundTriage(db, threadId, messageId);
      const base = parseEnv(process.env as Record<string, string | undefined>);
      expect(await prefetchHmsConfirmations(inbound, db, { ...base, HMS_PREFETCH_ENABLED: false })).toBe(0);
      const backfill = { ...inbound, admissionSnapshotId: null };
      expect(await prefetchHmsConfirmations(backfill, db, { ...base, HMS_PREFETCH_ENABLED: true })).toBe(0);
    }));

  it('stale reclaim never takes an hms_write run, but still reclaims a stale read job', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      const stale = new Date(Date.now() - 3 * 60 * 60_000);
      const writeId = randomUUID();
      await db.insert(aiWorkflowRun).values({
        id: writeId,
        transportId: TRANSPORT_ID,
        threadId,
        triggerMessageId: messageId,
        runKind: 'hms_write',
        idempotencyKey: `hms-write-${writeId}`,
        modelId: 'not_applicable',
        promptVersion: 'hms-write/1',
        executorLane: 'hms',
        state: 'running',
        claimOwner: 'hms-ai-worker-9',
        claimToken: randomUUID(),
        priority: 0,
        createdAt: stale,
        updatedAt: stale,
      });
      const job = await queueUserHmsJob(
        { transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, threadId, request: { kind: 'find', confirmation: CONFIRMATION } },
        db,
      );
      await db.update(aiWorkflowRun).set({ state: 'running', updatedAt: stale }).where(eq(aiWorkflowRun.id, job!.id));
      const reclaimed = await claimNextAiRun({ ownerId: LANE_OWNER, lane: 'hms', db });
      expect(reclaimed?.id).toBe(job!.id);
      const next = await claimNextAiRun({ ownerId: LANE_OWNER, lane: 'hms', db });
      expect(next?.id).not.toBe(writeId);
    }));
});

async function insertInboundTriage(db: DB, threadId: string, messageId: string): Promise<AiWorkflowRun> {
  const [row] = await db
    .insert(aiWorkflowRun)
    .values({
      id: randomUUID(),
      transportId: TRANSPORT_ID,
      threadId,
      triggerMessageId: messageId,
      runKind: 'inbound_triage',
      idempotencyKey: `inbound-triage:${messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v6',
      admissionSnapshotId: `snapshot-${randomUUID()}`,
      state: 'succeeded',
      executorLane: 'default',
      priority: 0,
    })
    .returning();
  if (!row) throw new Error('inbound triage seed failed');
  return row;
}

