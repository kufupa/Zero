import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'node:crypto';
import * as hmsJobs from '../src/ai/hms-jobs.js';
import { staffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import {
  canClaimReadToolRun,
  claimNextAiRun,
  HMS_JOB_PROMPT_VERSION,
  markAiRunRetry,
  markAiRunRunning,
  type AiWorkflowRun,
} from '../src/ai/run-ledger.js';
import {
  enqueueHmsJob,
  confirmationPrefetchIdempotencyKey,
  executeHmsJob,
  extractHmsConfirmations,
  extractUniqueArrivalForHmsPrefetch,
  guestSearchPrefetchIdempotencyKey,
  hmsJobQueueEnabled,
  hmsJobRequestSchema,
  HMS_JOB_PRIORITY_PREFETCH,
  HMS_JOB_PRIORITY_USER,
  prefetchHmsConfirmations,
  queueUserPartyHmsJob,
  queueUserHmsJob,
  readHmsJobView,
  requeueHmsReadsAfterRestart,
} from '../src/ai/hms-jobs.js';
import { paneStayLookupLoaders, type PaneStayLookupSpawnResult } from '../src/ai/pane-stay-lookup.js';
import type { PaneStayLock } from '../src/ai/pane-stay-save.js';
import { aiDraftGeneration, aiWorkflowRun, mailboxTransport, message, mailThread } from '../src/db/schema/mail.js';
import { hitlToolRun } from '../src/db/schema/hitl.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import { runHmsJobOnce } from '../src/ai/worker.js';
import type { DB } from '../src/db/client.js';
import { parseEnv } from '../src/env.js';
import { createPropertyReadLock, PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';
import { CENTURION_USER_ID, TRANSPORT_EMAIL, TRANSPORT_ID } from '../src/db/seed.js';
import { openTestDbSession, probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';

const staffQuoteRunner = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/ai/staff-quote-run.js', () => ({ runStaffQuote: staffQuoteRunner.run }));

const reachable = await probeTestDb();
const TENANT = 'tenant-centurion';
const CONFIRMATION = '1234567-1';
const LANE_OWNER = 'hms-ai-worker-111';

const STAFF_QUOTE_INPUT = {
  messageId: 'staff-quote-message',
  sourceHash: 'a'.repeat(64),
  selectionEpoch: 3,
  inputRevision: 5,
  groups: [
    {
      id: 'single',
      arrivalDate: '2026-10-12',
      departureDate: '2026-10-14',
      quantity: 1,
      adults: 2,
      childrenAges: [],
      board: 'room_only',
      roomCodes: ['SKNG'],
    },
  ],
  salesStrategy: 'BAR',
  company: '',
  agency: '',
  attention: '',
  clientEmail: '',
  clientTelephone: '',
} as const;

afterEach(() => {
  paneStayLookupLoaders.lock = null;
  paneStayLookupLoaders.spawn = null;
  staffQuoteRunner.run.mockReset();
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

async function enqueueStaffQuoteJob(
  db: DB,
  threadId: string,
  messageId: string,
  staffQuoteUser = { id: CENTURION_USER_ID, name: 'Synthetic Staff', email: 'staff@example.test' },
) {
  const input = { ...STAFF_QUOTE_INPUT, messageId };
  return enqueueHmsJob(
    {
      transportId: TRANSPORT_ID,
      threadId,
      triggerMessageId: messageId,
      workItemId: null,
      userId: staffQuoteUser.id,
      request: { kind: 'staff_quote', input },
      priority: HMS_JOB_PRIORITY_USER,
      idempotencyKey: `hms-job:staff-quote:${randomUUID()}`,
      extraMetrics: { staffQuoteUser },
    },
    db,
  );
}

function autoStaffQuoteRequest(threadId: string, messageId: string) {
  return {
    transportId: TRANSPORT_ID,
    threadId,
    triggerMessageId: messageId,
    workItemId: null,
    userId: CENTURION_USER_ID,
    request: { kind: 'staff_quote' as const, input: staffQuoteInput.parse({ ...STAFF_QUOTE_INPUT, messageId }) },
    priority: HMS_JOB_PRIORITY_USER,
    extraMetrics: {
      staffQuoteUser: { id: CENTURION_USER_ID, name: 'Synthetic Staff', email: 'staff@example.test' },
    },
  };
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

  it('accepts only closed find, guest-search, and staff-quote requests', () => {
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
    expect(hmsJobRequestSchema.safeParse({ kind: 'staff_quote', input: STAFF_QUOTE_INPUT }).success).toBe(true);
    expect(
      hmsJobRequestSchema.safeParse({
        kind: 'staff_quote',
        input: { ...STAFF_QUOTE_INPUT, customerOverride: true },
      }).success,
    ).toBe(false);
  });

  it('uses only a unique, valid arrival from the extraction for guest prefetch', () => {
    expect(
      extractUniqueArrivalForHmsPrefetch('booking', {
        stays: [{ requested: { arrival: '2026-11-12' } }],
      }),
    ).toBe('2026-11-12');
    expect(
      extractUniqueArrivalForHmsPrefetch('amendment', {
        stays: [
          {
            requested: { arrival: '2026-12-01' },
            booked: { arrival: '2026-11-12' },
          },
        ],
      }),
    ).toBe('2026-11-12');
    expect(
      extractUniqueArrivalForHmsPrefetch('booking', {
        stays: [
          { requested: { arrival: '2026-11-12' } },
          { requested: { arrival: '2026-12-01' } },
        ],
      }),
    ).toBeNull();
    expect(
      extractUniqueArrivalForHmsPrefetch('booking', {
        stays: [{ requested: { arrival: 'not-a-date' } }],
      }),
    ).toBeNull();
    expect(extractUniqueArrivalForHmsPrefetch('booking', { stays: [{ requested: { arrival: null } }] })).toBeNull();
    expect(
      extractUniqueArrivalForHmsPrefetch('booking', {
        stays: [{ requested: { arrival: '2026-11-12' } }, { requested: { arrival: null } }],
      }),
    ).toBeNull();
    expect(
      extractUniqueArrivalForHmsPrefetch('booking', {
        stays: [{ requested: { arrival: '2026-11-12' } }, { requested: { arrival: 'invalid' } }],
      }),
    ).toBeNull();
  });

  it('builds one stable guest-prefetch key from transport, thread, normalized surname and arrival', () => {
    const key = guestSearchPrefetchIdempotencyKey(TRANSPORT_ID, 'thread-1', ' Smith  Jones ', '2026-11-12');
    expect(key).toMatch(new RegExp(`^hms-job:prefetch-guest:${TRANSPORT_ID}:thread-1:`));
    expect(key).toBe(guestSearchPrefetchIdempotencyKey(TRANSPORT_ID, 'thread-1', 'smith jones', '2026-11-12'));
    expect(key).not.toBe(guestSearchPrefetchIdempotencyKey(TRANSPORT_ID, 'thread-2', 'Smith Jones', '2026-11-12'));
    expect(key).not.toBe(guestSearchPrefetchIdempotencyKey(TRANSPORT_ID, 'thread-1', 'Smith Jones', '2026-11-13'));
  });

  it('builds the confirmation key shared by prefetch and automatic pane find', () => {
    expect(confirmationPrefetchIdempotencyKey(TRANSPORT_ID, CONFIRMATION, '2026-10-13')).toBe(
      `hms-job:prefetch:${TRANSPORT_ID}:${CONFIRMATION}:2026-10-13`,
    );
  });

  it('turns the job queue on only for HMS_JOB_QUEUE=on', () => {
    expect(hmsJobQueueEnabled({})).toBe(false);
    expect(hmsJobQueueEnabled({ HMS_JOB_QUEUE: '1' })).toBe(false);
    expect(hmsJobQueueEnabled({ HMS_JOB_QUEUE: 'off' })).toBe(false);
    expect(hmsJobQueueEnabled({ HMS_JOB_QUEUE: 'on' })).toBe(true);
  });

  it('defaults the separate guest-search prefetch cap to 12 per transport per hour', () => {
    const base = {
      NODE_ENV: 'test',
      PORT: '8788',
      DATABASE_URL: 'postgres://zero:secret@127.0.0.1:5432/test',
      BETTER_AUTH_URL: 'http://localhost:8788',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      AWS_REGION: 'af-south-1',
      S3_BUCKET: 'hms-prefetch-test',
    };
    expect(parseEnv(base).HMS_GUEST_PREFETCH_PER_HOUR).toBe(12);
    expect(parseEnv({ ...base, HMS_GUEST_PREFETCH_PER_HOUR: '4' }).HMS_GUEST_PREFETCH_PER_HOUR).toBe(4);
  });

  it('returns before database access when HMS_PREFETCH_ENABLED is off', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    const env = {
      ...parseEnv({
        NODE_ENV: 'test',
        PORT: '8788',
        DATABASE_URL: 'postgres://zero:secret@127.0.0.1:5432/test',
        BETTER_AUTH_URL: 'http://localhost:8788',
        BETTER_AUTH_SECRET: 'x'.repeat(32),
        AWS_REGION: 'af-south-1',
        S3_BUCKET: 'hms-prefetch-test',
      }),
      HMS_PREFETCH_ENABLED: false,
    };

    await expect(prefetchHmsConfirmations({} as AiWorkflowRun, {} as DB, env)).resolves.toBe(0);
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

  it.each(['queued', 'claimed', 'running', 'retry_wait'] as const)(
    'auto-start reuses a matching %s staff quote regardless of age and selection counters',
    (state) => withSeededTestDb(async (db) => {
      expect(hmsJobs.queueAutoStaffQuoteHmsJob).toBeTypeOf('function');
      const { threadId, messageId } = await seedThread(db);
      const request = autoStaffQuoteRequest(threadId, messageId);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      await db.update(aiWorkflowRun).set({
        state,
        createdAt: new Date(Date.now() - 24 * 60 * 60_000),
      }).where(eq(aiWorkflowRun.id, run.id));

      const reused = await hmsJobs.queueAutoStaffQuoteHmsJob({
        ...request,
        request: { ...request.request, input: { ...request.request.input, selectionEpoch: 99, inputRevision: 100 } },
      }, db);

      expect(reused).toMatchObject({ created: false, run: { id: run.id } });
      expect(reused.run.readRequest).toEqual(run.readRequest);
      const rows = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.triggerMessageId, messageId));
      expect(rows).toHaveLength(1);
    }),
  );

  it.each([true, false])('auto-start reuses a fresh succeeded staff quote with ok=%s', (ok) =>
    withSeededTestDb(async (db) => {
      expect(hmsJobs.queueAutoStaffQuoteHmsJob).toBeTypeOf('function');
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      await db.update(aiWorkflowRun).set({
        state: 'succeeded',
        createdAt: new Date(Date.now() - 24 * 60 * 60_000),
        finishedAt: new Date(Date.now() - 60_000),
        readResult: { kind: 'staff_quote', ok, asOf: new Date().toISOString() },
        readResultExpiresAt: new Date(Date.now() + 60_000),
      }).where(eq(aiWorkflowRun.id, run.id));

      const reused = await hmsJobs.queueAutoStaffQuoteHmsJob(autoStaffQuoteRequest(threadId, messageId), db);
      expect(reused).toMatchObject({ created: false, run: { id: run.id, readResult: { ok } } });
    }));

  it.each(['dead_letter', 'superseded'] as const)(
    'auto-start reuses a %s staff quote until six hours after it finishes',
    (state) => withSeededTestDb(async (db) => {
      expect(hmsJobs.queueAutoStaffQuoteHmsJob).toBeTypeOf('function');
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      await db.update(aiWorkflowRun).set({
        state,
        createdAt: new Date(Date.now() - 24 * 60 * 60_000),
        finishedAt: new Date(Date.now() - 5 * 60 * 60_000),
        updatedAt: new Date(Date.now() - 5 * 60 * 60_000),
      }).where(eq(aiWorkflowRun.id, run.id));

      const reused = await hmsJobs.queueAutoStaffQuoteHmsJob(autoStaffQuoteRequest(threadId, messageId), db);
      expect(reused).toMatchObject({ created: false, run: { id: run.id } });
    }),
  );

  it.each(['succeeded', 'dead_letter', 'superseded'] as const)(
    'auto-start creates a new run after a %s staff quote expires',
    (state) => withSeededTestDb(async (db) => {
      expect(hmsJobs.queueAutoStaffQuoteHmsJob).toBeTypeOf('function');
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      const expiredAt = new Date(Date.now() - 7 * 60 * 60_000);
      await db.update(aiWorkflowRun).set({
        state,
        finishedAt: expiredAt,
        updatedAt: expiredAt,
        readResult: state === 'succeeded' ? { kind: 'staff_quote', ok: true } : null,
        readResultExpiresAt: new Date(Date.now() - 1),
      }).where(eq(aiWorkflowRun.id, run.id));

      await expect(readHmsJobView({
        transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, messageId, kind: 'staff_quote',
        input: staffQuoteInput.parse({ ...STAFF_QUOTE_INPUT, messageId }),
      }, db)).resolves.toBeNull();
      const queued = await hmsJobs.queueAutoStaffQuoteHmsJob(autoStaffQuoteRequest(threadId, messageId), db);
      expect(queued.created).toBe(true);
      expect(queued.run.id).not.toBe(run.id);
      const rows = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.triggerMessageId, messageId));
      expect(rows).toHaveLength(2);
    }),
  );

  it('auto-start uses updatedAt when a terminal failure has no finishedAt', () =>
    withSeededTestDb(async (db) => {
      expect(hmsJobs.queueAutoStaffQuoteHmsJob).toBeTypeOf('function');
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      await db.update(aiWorkflowRun).set({
        state: 'dead_letter', finishedAt: null,
        createdAt: new Date(Date.now() - 24 * 60 * 60_000),
        updatedAt: new Date(Date.now() - 60_000),
      }).where(eq(aiWorkflowRun.id, run.id));

      const reused = await hmsJobs.queueAutoStaffQuoteHmsJob(autoStaffQuoteRequest(threadId, messageId), db);
      expect(reused).toMatchObject({ created: false, run: { id: run.id } });
    }));

  it.each(['dead_letter', 'superseded'] as const)(
    'remount readback expires a %s staff quote after six hours',
    (state) => withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      const expiredAt = new Date(Date.now() - 7 * 60 * 60_000);
      await db.update(aiWorkflowRun).set({ state, finishedAt: expiredAt, updatedAt: expiredAt })
        .where(eq(aiWorkflowRun.id, run.id));

      await expect(readHmsJobView({
        transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, messageId, kind: 'staff_quote',
        input: staffQuoteInput.parse({ ...STAFF_QUOTE_INPUT, messageId }),
      }, db)).resolves.toBeNull();
    }),
  );

  // Superseded (Greptile P1, 2026-10-13): only the newest staff quote on a message holds the current approval.
  it.skip('auto-start matches an older fresh request even after twenty different semantic requests', () =>
    withSeededTestDb(async (db) => {
      expect(hmsJobs.queueAutoStaffQuoteHmsJob).toBeTypeOf('function');
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      await db.update(aiWorkflowRun).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(aiWorkflowRun.id, run.id));
      for (let index = 0; index < 21; index++) {
        const request = autoStaffQuoteRequest(threadId, messageId);
        await enqueueHmsJob({
          ...request, idempotencyKey: `hms-job:staff-quote:${randomUUID()}`,
          request: { ...request.request, input: { ...request.request.input, company: `Company ${index}` } },
        }, db);
      }

      const reused = await hmsJobs.queueAutoStaffQuoteHmsJob(autoStaffQuoteRequest(threadId, messageId), db);
      expect(reused).toMatchObject({ created: false, run: { id: run.id } });
    }));

  it.each(['user', 'transport', 'message', 'input'] as const)(
    'auto-start does not reuse a staff quote with different %s scope',
    (scope) => withSeededTestDb(async (db) => {
      expect(hmsJobs.queueAutoStaffQuoteHmsJob).toBeTypeOf('function');
      const { threadId, messageId } = await seedThread(db);
      const request = autoStaffQuoteRequest(threadId, messageId);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      if (scope === 'user') {
        await db.update(aiWorkflowRun).set({ metrics: { userId: 'other-staff' } }).where(eq(aiWorkflowRun.id, run.id));
      } else if (scope === 'transport') {
        await db.update(aiWorkflowRun).set({ transportId: 'transport-nava' }).where(eq(aiWorkflowRun.id, run.id));
      } else if (scope === 'message') {
        const other = await seedThread(db);
        await db.update(aiWorkflowRun).set({ triggerMessageId: other.messageId }).where(eq(aiWorkflowRun.id, run.id));
      } else {
        request.request.input = { ...request.request.input, company: 'Different Company' };
      }

      const queued = await hmsJobs.queueAutoStaffQuoteHmsJob(request, db);
      expect(queued.created).toBe(true);
      expect(queued.run.id).not.toBe(run.id);
    }),
  );

  it('two concurrent staff quote auto-starts create one run across separate DB sessions', async () => {
    expect(hmsJobs.queueAutoStaffQuoteHmsJob).toBeTypeOf('function');
    const setup = openTestDbSession(), left = openTestDbSession(), right = openTestDbSession();
    const suffix = randomUUID(), transportId = `quote-auto-${suffix}`, threadId = `thread-${suffix}`, messageId = `msg-${suffix}`;
    try {
      await setup.db.insert(mailboxTransport).values({
        id: transportId, email: `${suffix}@zero.test`, ownerHeaderValue: `${suffix}@zero.test`, isActive: true,
      });
      await setup.db.insert(mailThread).values({ id: threadId, transportId, threadRootId: threadId });
      await setup.db.insert(message).values({
        id: messageId, transportId, threadId, direction: 'inbound', fromAddress: 'guest@example.test',
      });
      const request = { ...autoStaffQuoteRequest(threadId, messageId), transportId };
      const results = await Promise.all([
        hmsJobs.queueAutoStaffQuoteHmsJob(request, left.db),
        hmsJobs.queueAutoStaffQuoteHmsJob({
          ...request,
          request: { ...request.request, input: { ...request.request.input, selectionEpoch: 40, inputRevision: 50 } },
        }, right.db),
      ]);

      expect(new Set(results.map(({ run }) => run.id)).size).toBe(1);
      expect(results.filter(({ created }) => created)).toHaveLength(1);
      const rows = await setup.db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.transportId, transportId));
      expect(rows).toHaveLength(1);
    } finally {
      try {
        await setup.db.delete(aiWorkflowRun).where(eq(aiWorkflowRun.transportId, transportId));
        await setup.db.delete(message).where(eq(message.transportId, transportId));
        await setup.db.delete(mailThread).where(eq(mailThread.transportId, transportId));
        await setup.db.delete(mailboxTransport).where(eq(mailboxTransport.id, transportId));
      } finally {
        await Promise.all([setup.close(), left.close(), right.close()]);
      }
    }
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

  it('runs a queued staff quote as a user-priority job and stores the complete quote result', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HITL_LEDGER', 'on');
      const { threadId, messageId } = await seedThread(db);
      const staffQuoteUser = {
        id: CENTURION_USER_ID,
        name: 'Trusted Staff',
        email: 'trusted@example.test',
      };
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId, staffQuoteUser);
      const quoteResult = {
        status: 'ready',
        workflowRunId: 'staff-quote-workflow-1',
        revisionRef: 'revision-1',
        messageId,
        threadId,
        factRefs: ['extras'],
        selectionEpoch: STAFF_QUOTE_INPUT.selectionEpoch,
        inputRevision: STAFF_QUOTE_INPUT.inputRevision,
        inputDigest: 'd'.repeat(64),
        totalMinor: 240_000,
        currency: 'ZAR',
        arrivalDate: '2026-10-12',
        departureDate: '2026-10-14',
        description: 'Standard King; Room Only',
        rateOptions: [{ id: 'rate-1', rateCode: 'BARRO' }],
        rowRates: [{ groupId: 'single', amountMinor: 120_000 }],
        screenshots: ['quote.png'],
      };
      staffQuoteRunner.run.mockImplementation(async (...args: unknown[]) => {
        const transaction = args[2] as DB;
        const options = args[3] as {
          commitQueuedResult?: (result: Record<string, unknown>, transaction: DB) => Promise<boolean>;
        };
        await options.commitQueuedResult?.(quoteResult, transaction);
        return quoteResult;
      });

      const claimed = await claimJob(db);
      expect(claimed.id).toBe(run.id);
      expect(claimed.priority).toBe(HMS_JOB_PRIORITY_USER);
      expect(await runClaimedJob(db, claimed)).toBe('succeeded');
      expect(staffQuoteRunner.run).toHaveBeenCalledWith(
        { ...STAFF_QUOTE_INPUT, messageId },
        { transportId: TRANSPORT_ID, user: staffQuoteUser },
        db,
        expect.objectContaining({
          signal: undefined,
          deadlineAt: claimed.deadlineAt!.getTime(),
          commitQueuedResult: expect.any(Function),
        }),
      );
      const view = await readHmsJobView({ transportId: TRANSPORT_ID, runId: run.id, staffQuoteOwnerId: CENTURION_USER_ID }, db);
      expect(view?.result).toMatchObject({
        ...quoteResult,
        kind: 'staff_quote',
        asOf: expect.any(String),
      });
      expect(view?.asOf).toEqual(expect.any(String));
      const [stored] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
      expect(stored?.readResultExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 6 * 60 * 60_000 - 1_000);
      expect(stored?.readResultExpiresAt?.getTime()).toBeLessThan(Date.now() + 6 * 60 * 60_000 + 1_000);
      const [toolRun] = await db
        .select()
        .from(hitlToolRun)
        .where(
          and(
            eq(hitlToolRun.transportId, TRANSPORT_ID),
            eq(hitlToolRun.messageId, messageId),
            eq(hitlToolRun.userId, staffQuoteUser.id),
            eq(hitlToolRun.kind, 'quote'),
          ),
        );
      expect(toolRun).toMatchObject({
        status: 'ok',
        workflowRunId: quoteResult.workflowRunId,
        result: { revisionRef: 'revision-1', totalMinor: 240_000, currency: 'ZAR' },
      });
    }));

  it('does not read back an expired staff quote result for matching inputs', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      const expiredAt = new Date(Date.now() - 1);
      await db
        .update(aiWorkflowRun)
        .set({
          state: 'succeeded',
          readResult: { kind: 'staff_quote', asOf: new Date(expiredAt.getTime() - 6 * 60 * 60_000).toISOString() },
          readResultExpiresAt: expiredAt,
          finishedAt: expiredAt,
          updatedAt: expiredAt,
        })
        .where(eq(aiWorkflowRun.id, run.id));

      await expect(
        readHmsJobView(
          {
            transportId: TRANSPORT_ID,
            userId: CENTURION_USER_ID,
            messageId,
            kind: 'staff_quote',
            input: { ...STAFF_QUOTE_INPUT, messageId },
          },
          db,
        ),
      ).resolves.toBeNull();
    }));

  it('does not read back an expired staff quote result by owner-scoped run id', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      const expiredAt = new Date(Date.now() - 1);
      await db
        .update(aiWorkflowRun)
        .set({
          state: 'succeeded',
          readResult: { kind: 'staff_quote', totalMinor: 240_000 },
          readResultExpiresAt: expiredAt,
          finishedAt: expiredAt,
          updatedAt: expiredAt,
        })
        .where(eq(aiWorkflowRun.id, run.id));

      await expect(
        readHmsJobView(
          {
            transportId: TRANSPORT_ID,
            runId: run.id,
            staffQuoteOwnerId: CENTURION_USER_ID,
          },
          db,
        ),
      ).resolves.toBeNull();
    }));

  it('anchors staff quote matching readback to the indexed trigger message', () =>
    withSeededTestDb(async (db) => {
      const wanted = await seedThread(db);
      const other = await seedThread(db);
      const input = staffQuoteInput.parse({ ...STAFF_QUOTE_INPUT, messageId: wanted.messageId });
      const { run } = await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId: other.threadId,
          triggerMessageId: other.messageId,
          workItemId: null,
          userId: CENTURION_USER_ID,
          request: { kind: 'staff_quote', input },
          priority: HMS_JOB_PRIORITY_USER,
          idempotencyKey: `hms-job:staff-quote:${randomUUID()}`,
          extraMetrics: {
            staffQuoteUser: {
              id: CENTURION_USER_ID,
              name: 'Synthetic Staff',
              email: 'staff@example.test',
            },
          },
        },
        db,
      );

      await expect(
        readHmsJobView(
          {
            transportId: TRANSPORT_ID,
            userId: CENTURION_USER_ID,
            messageId: wanted.messageId,
            kind: 'staff_quote',
            input,
          },
          db,
        ),
      ).resolves.toBeNull();
      expect(run.triggerMessageId).toBe(other.messageId);
    }));

  it('supersedes a staff quote that stayed queued for more than ten minutes without being claimed', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      const now = new Date(Date.now() + 1_000);
      const createdAt = new Date(now.getTime() - 10 * 60_000 - 1);
      await db
        .update(aiWorkflowRun)
        .set({ createdAt, updatedAt: createdAt })
        .where(eq(aiWorkflowRun.id, run.id));

      const claimed = await claimNextAiRun({
        ownerId: LANE_OWNER,
        lane: 'hms',
        runKind: 'read_tool',
        promptVersion: HMS_JOB_PROMPT_VERSION,
        now,
        db,
      });
      const [expired] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));

      expect(claimed).toBeNull();
      expect(expired).toMatchObject({ state: 'superseded', lastError: 'staff_quote_queue_expired' });
      expect(expired?.claimedAt).toBeNull();
    }));

  it('stores a staff quote business refusal as a successful job with its real message', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      staffQuoteRunner.run.mockRejectedValue(
        new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'HMS has no rate for this meal plan under BAR.',
        }),
      );

      expect(await runClaimedJob(db, await claimJob(db))).toBe('succeeded');
      expect(await readHmsJobView({ transportId: TRANSPORT_ID, runId: run.id, staffQuoteOwnerId: CENTURION_USER_ID }, db)).toMatchObject({
        status: 'done',
        failureClass: null,
        result: {
          ok: false,
          code: 'PRECONDITION_FAILED',
          message: 'HMS has no rate for this meal plan under BAR.',
        },
      });
    }));

  it('retries only a staff quote whose failure chain proves the property lock was busy', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      staffQuoteRunner.run.mockRejectedValue(
        Object.assign(new Error('staff_quote_failed'), {
          code: 'PRECONDITION_FAILED',
          cause: new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE),
        }),
      );

      expect(await runClaimedJob(db, await claimJob(db))).toBe('retry_wait');
      expect(await readHmsJobView({ transportId: TRANSPORT_ID, runId: run.id, staffQuoteOwnerId: CENTURION_USER_ID }, db)).toMatchObject({
        status: 'retrying',
        failureClass: 'HMS_LOCK_BUSY',
        attempts: 1,
      });
    }));

  it('retries transient native staff quote failures', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      staffQuoteRunner.run.mockRejectedValueOnce(new Error('native session ECONNRESET'));

      expect(await runClaimedJob(db, await claimJob(db))).toBe('retry_wait');
      expect(await readHmsJobView({ transportId: TRANSPORT_ID, runId: run.id, staffQuoteOwnerId: CENTURION_USER_ID }, db)).toMatchObject({
        status: 'retrying',
        failureClass: 'TRANSIENT_NETWORK',
        attempts: 1,
      });
    }));

  it('gives staff_quote five-minute work budget without widening ordinary HMS read deadlines', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_RUN_DEADLINE_MS', '150000');
      const { threadId, messageId } = await seedThread(db);
      const { run: staffQuoteRun } = await enqueueStaffQuoteJob(db, threadId, messageId);
      const staffQuoteClaim = await claimJob(db);
      expect(staffQuoteClaim.id).toBe(staffQuoteRun.id);
      expect(staffQuoteClaim.deadlineAt!.getTime() - Date.now()).toBeGreaterThan(6 * 60_000);

      const { run: findRun } = await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          workItemId: null,
          userId: CENTURION_USER_ID,
          request: { kind: 'find', confirmation: CONFIRMATION },
          priority: HMS_JOB_PRIORITY_USER,
          idempotencyKey: `hms-job:user:${randomUUID()}`,
        },
        db,
      );
      const findClaim = await claimNextAiRun({
        ownerId: LANE_OWNER,
        lane: 'hms',
        runKind: 'read_tool',
        promptVersion: HMS_JOB_PROMPT_VERSION,
        idempotencyPrefix: findRun.idempotencyKey,
        db,
      });
      expect(findClaim?.id).toBe(findRun.id);
      expect(findClaim!.deadlineAt!.getTime() - Date.now()).toBeLessThan(3 * 60_000);
    }));

  it('a remount on a thread with two guests reads back the search for the asked surname, whatever its case', () =>
    withSeededTestDb(async (db) => {
      const { threadId } = await seedThread(db);
      const search = (lastName: string) =>
        queueUserHmsJob(
          {
            transportId: TRANSPORT_ID,
            userId: CENTURION_USER_ID,
            threadId,
            request: { kind: 'search_guest', lastName, arrival: '2026-10-12' },
          },
          db,
        );
      const smith = await search('Smith');
      const jones = await search('Jones');
      const resume = (lastName: string) =>
        readHmsJobView({ transportId: TRANSPORT_ID, threadId, kind: 'search_guest', lastName, arrival: '2026-10-12' }, db);
      expect((await resume(' smith '))?.runId).toBe(smith!.id);
      expect((await resume('JONES'))?.runId).toBe(jones!.id);
      expect(await resume('Brown')).toBeNull();
    }));

  it('a remount reads back the party job for the asked name and field kind', () =>
    withSeededTestDb(async (db) => {
      const { threadId } = await seedThread(db);
      const queue = (partyKind: 'company' | 'agency') =>
        queueUserHmsJob(
          {
            transportId: TRANSPORT_ID,
            userId: CENTURION_USER_ID,
            threadId,
            request: { kind: 'party', name: 'Horizon Trail Tours', partyKind },
          },
          db,
        );
      const agency = await queue('agency');
      const company = await queue('company');
      const resume = (name: string, partyKind: 'company' | 'agency') =>
        readHmsJobView(
          { transportId: TRANSPORT_ID, threadId, kind: 'party', name, partyKind },
          db,
        );

      expect((await resume(' horizon   trail tours ', 'agency'))?.runId).toBe(agency!.id);
      expect((await resume('HORIZON TRAIL TOURS', 'company'))?.runId).toBe(company!.id);
      expect(await resume('Another Agency', 'agency')).toBeNull();
    }));

  it('reads a kind-less prefetched party job for either field, but not a party job older than 24 hours', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      const queued = await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          workItemId: null,
          userId: null,
          request: { kind: 'party', name: 'Horizon Trail Tours' },
          priority: HMS_JOB_PRIORITY_PREFETCH,
          idempotencyKey: `test:party-prefetch:${randomUUID()}`,
        },
        db,
      );
      const resume = (partyKind: 'company' | 'agency') =>
        readHmsJobView(
          { transportId: TRANSPORT_ID, threadId, kind: 'party', name: 'Horizon Trail Tours', partyKind },
          db,
        );

      expect((await resume('company'))?.runId).toBe(queued.run.id);
      expect((await resume('agency'))?.runId).toBe(queued.run.id);

      await db
        .update(aiWorkflowRun)
        .set({ createdAt: new Date(Date.now() - 25 * 60 * 60_000) })
        .where(eq(aiWorkflowRun.id, queued.run.id));
      expect(await resume('company')).toBeNull();
      expect((await readHmsJobView({ transportId: TRANSPORT_ID, runId: queued.run.id }, db))?.runId).toBe(
        queued.run.id,
      );
    }));

  it('deduplicates user party searches per transport, normalized name, kind and day; a new field Find preserves jobs shared with another thread', () =>
    withSeededTestDb(async (db) => {
      const firstThread = await seedThread(db);
      const secondThread = await seedThread(db);
      const queue = (threadId: string, name: string, partyKind: 'company' | 'agency', retry = false) =>
        queueUserPartyHmsJob(
          {
            transportId: TRANSPORT_ID,
            userId: CENTURION_USER_ID,
            threadId,
            request: { kind: 'party', name, partyKind },
            retry,
          },
          db,
        );

      const first = await queue(firstThread.threadId, 'Horizon Trail Tours', 'company');
      const duplicate = await queue(secondThread.threadId, ' horizon   trail tours ', 'company');
      expect(duplicate?.id).toBe(first?.id);
      expect(first?.priority).toBe(HMS_JOB_PRIORITY_USER);
      expect(
        (
          await readHmsJobView(
            {
              transportId: TRANSPORT_ID,
              threadId: secondThread.threadId,
              kind: 'party',
              name: 'Horizon Trail Tours',
              partyKind: 'company',
            },
            db,
          )
        )?.runId,
      ).toBe(first?.id);

      const next = await queue(firstThread.threadId, 'Different Agency', 'company');
      const [stillShared] = await db
        .select({ state: aiWorkflowRun.state })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.id, first!.id));
      expect(stillShared?.state).toBe('queued');
      expect(
        (
          await readHmsJobView(
            {
              transportId: TRANSPORT_ID,
              threadId: secondThread.threadId,
              kind: 'party',
              name: 'Horizon Trail Tours',
              partyKind: 'company',
            },
            db,
          )
        )?.runId,
      ).toBe(first?.id);
      expect(next?.state).toBe('queued');

      const retry = await queue(firstThread.threadId, 'Different Agency', 'company', true);
      expect(retry?.id).not.toBe(next?.id);
      const [priorRetryState] = await db
        .select({ state: aiWorkflowRun.state })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.id, next!.id));
      expect(priorRetryState?.state).toBe('superseded');
    }));

  it('caps user party jobs at twelve per transport per hour while reusing duplicate requests', () =>
    withSeededTestDb(async (db) => {
      const { threadId } = await seedThread(db);
      const queue = (name: string) =>
        queueUserPartyHmsJob(
          {
            transportId: TRANSPORT_ID,
            userId: CENTURION_USER_ID,
            threadId,
            request: { kind: 'party', name, partyKind: 'company' },
          },
          db,
        );

      const jobs = [await queue('Company 0')];
      expect((await queue(' Company 0 '))?.id).toBe(jobs[0]?.id);
      for (let index = 1; index < 12; index += 1) jobs.push(await queue(`Company ${index}`));
      await expect(queue('Company 12')).rejects.toMatchObject({ name: 'HmsPartyQueueLimitError' });
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

  it('a restart moves a read run that a dead worker held to retry_wait, and leaves a live worker alone', () =>
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
      // Fresh heartbeat: worker 111 is alive, so its run is not touched.
      expect(await requeueHmsReadsAfterRestart({ ownerId: 'hms-ai-worker-222' }, db)).toBe(0);
      // Ten minutes without a heartbeat: worker 111 is gone.
      await db
        .update(aiWorkflowRun)
        .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
        .where(eq(aiWorkflowRun.id, claimed.id));
      expect(await requeueHmsReadsAfterRestart({ ownerId: 'hms-ai-worker-222' }, db)).toBe(1);
      const view = await readHmsJobView({ transportId: TRANSPORT_ID, runId: job!.id }, db);
      expect(view).toMatchObject({ status: 'retrying', failureClass: 'LEASE_LOST' });
    }));

  it('a job requeued after a restart past its run deadline is claimed again, not dead-lettered', () =>
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
      // Worker 111 died long enough ago that the first claim's deadline has passed too.
      await db
        .update(aiWorkflowRun)
        .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000), deadlineAt: new Date(Date.now() - 60_000) })
        .where(eq(aiWorkflowRun.id, claimed.id));
      expect(await requeueHmsReadsAfterRestart({ ownerId: 'hms-ai-worker-222' }, db)).toBe(1);
      const again = await claimJob(db, 'hms-ai-worker-222');
      expect(again.id).toBe(job!.id);
      expect(again.state).toBe('claimed');
      expect(again.deadlineAt!.getTime()).toBeGreaterThan(Date.now());
    }));

  it('a requeued job gets a fresh run deadline on its next claim', () =>
    withSeededTestDb(async (db) => {
      const { threadId } = await seedThread(db);
      const job = await queueUserHmsJob(
        { transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, threadId, request: { kind: 'find', confirmation: CONFIRMATION } },
        db,
      );
      const claimed = await claimJob(db);
      // The first deadline has passed by the time the job yields, as after a long wait.
      await db
        .update(aiWorkflowRun)
        .set({ deadlineAt: new Date(Date.now() - 1_000) })
        .where(eq(aiWorkflowRun.id, claimed.id));
      const yielded = await markAiRunRetry(
        {
          runId: claimed.id,
          claimOwner: claimed.claimOwner!,
          claimToken: claimed.claimToken!,
          expectedStates: ['claimed'],
          attempts: 0,
          nextRunAt: new Date(),
          lastError: 'staff quote active',
          failureClass: 'STAFF_QUOTE_ACTIVE',
          resetDeadline: true,
        },
        db,
      );
      expect(yielded).not.toBeNull();
      const again = await claimJob(db);
      expect(again.id).toBe(job!.id);
      expect(again.state).toBe('claimed');
      expect(again.deadlineAt!.getTime()).toBeGreaterThan(Date.now());
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

  it('prefetch yields to an active staff_quote job before the staff generation row exists', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      await enqueueStaffQuoteJob(db, threadId, messageId);
      const staffClaim = await claimJob(db);
      await markAiRunRunning(
        {
          runId: staffClaim.id,
          claimOwner: staffClaim.claimOwner!,
          claimToken: staffClaim.claimToken!,
          deadlineAt: staffClaim.deadlineAt!,
        },
        db,
      );
      const { run: prefetch } = await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          workItemId: null,
          userId: null,
          request: { kind: 'find', confirmation: CONFIRMATION },
          priority: HMS_JOB_PRIORITY_PREFETCH,
          idempotencyKey: `hms-job:prefetch:${TRANSPORT_ID}:${CONFIRMATION}:active-staff-quote`,
        },
        db,
      );

      expect(await runClaimedJob(db, await claimJob(db))).toBe('retry_wait');
      expect(await readHmsJobView({ transportId: TRANSPORT_ID, runId: prefetch.id }, db)).toMatchObject({
        status: 'retrying',
        failureClass: 'STAFF_QUOTE_ACTIVE',
        attempts: 0,
      });
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

  it('prefetches from the successful extraction rather than the classifier run or a sent copy', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, messageId } = await seedThread(db, 'Booking 1234567-1');
      const triage = await insertInboundExtraction(db, threadId, messageId, 'inbound_triage');
      await insertStoredExtraction(db, messageId, 'booking', {
        confirmationNumbers: ['1234567-1'],
      });
      const extraction = await insertInboundExtraction(db, threadId, messageId);
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };
      const sentCopy = { ...triage, idempotencyKey: `external-sent-baseline:${messageId}` };
      expect(await prefetchHmsConfirmations(sentCopy, db, env)).toBe(0);
      expect(await prefetchHmsConfirmations(triage, db, env)).toBe(0);
      expect(await prefetchHmsConfirmations(extraction, db, env)).toBe(1);
    }));

  it('a duplicate prefetch is a no-op, and the hourly cap holds per transport', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, messageId } = await seedThread(db, 'Booking 1234567-1 and 7654321-2');
      const inbound = await insertInboundExtraction(db, threadId, messageId);
      await insertStoredExtraction(db, messageId, 'booking', {
        confirmationNumbers: ['1234567-1', '7654321-2'],
      });
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

  it('availability probes in the hour do not use the confirmation prefetch cap (U10)', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, messageId } = await seedThread(db, 'Booking 1234567-1');
      const inbound = await insertInboundExtraction(db, threadId, messageId);
      await insertStoredExtraction(db, messageId, 'booking', {
        confirmationNumbers: ['1234567-1'],
      });
      await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          workItemId: null,
          userId: null,
          request: {
            kind: 'availability',
            arrival: '2026-11-03',
            departure: '2026-11-04',
            rooms: [{ roomType: 'Double', quantity: 1, adults: 2, childAges: [] }],
          },
          priority: HMS_JOB_PRIORITY_PREFETCH,
          idempotencyKey: `hms-job:availability:${TRANSPORT_ID}:cap-test`,
        },
        db,
      );
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true, HMS_PREFETCH_PER_HOUR: 1 };
      expect(await prefetchHmsConfirmations(inbound, db, env)).toBe(1);
    }));

  it('prefetch stays off unless HMS_PREFETCH_ENABLED is set, and never runs for backfill', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, messageId } = await seedThread(db, 'Booking 1234567-1');
      const inbound = await insertInboundExtraction(db, threadId, messageId);
      await insertStoredExtraction(db, messageId, 'booking', {
        confirmationNumbers: ['1234567-1'],
      });
      const base = parseEnv(process.env as Record<string, string | undefined>);
      expect(await prefetchHmsConfirmations(inbound, db, { ...base, HMS_PREFETCH_ENABLED: false })).toBe(0);
      const backfill = { ...inbound, admissionSnapshotId: null };
      expect(await prefetchHmsConfirmations(backfill, db, { ...base, HMS_PREFETCH_ENABLED: true })).toBe(0);
    }));

  it('prefetch needs the job queue on, and skips mail on a spam thread', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db, 'Booking 1234567-1');
      const inbound = await insertInboundExtraction(db, threadId, messageId);
      await insertStoredExtraction(db, messageId, 'booking', {
        confirmationNumbers: ['1234567-1'],
      });
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };
      expect(await prefetchHmsConfirmations(inbound, db, env)).toBe(0);
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      await db.update(mailThread).set({ spamAt: new Date() }).where(eq(mailThread.id, threadId));
      expect(await prefetchHmsConfirmations(inbound, db, env)).toBe(0);
      await db.update(mailThread).set({ spamAt: null }).where(eq(mailThread.id, threadId));
      expect(await prefetchHmsConfirmations(inbound, db, env)).toBe(1);
    }));

  it('uses an extraction confirmation even when the number is absent from the mail body', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, messageId } = await seedThread(db, 'Booking request');
      await db.update(message).set({ textBody: 'Please confirm the booking.' }).where(eq(message.id, messageId));
      await insertStoredExtraction(db, messageId, 'booking', {
        confirmationNumbers: ['7654321-2'],
      });
      const run = await insertInboundExtraction(db, threadId, messageId);
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };

      expect(await prefetchHmsConfirmations(run, db, env)).toBe(1);
      const [job] = await db
        .select({ readRequest: aiWorkflowRun.readRequest })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION));
      expect(job?.readRequest).toMatchObject({ kind: 'find', confirmation: '7654321-2' });
    }));

  it('queues one stable guest search from explicit guest and extraction arrival when no confirmation exists', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, messageId } = await seedThread(db, 'Booking request');
      await db
        .update(message)
        .set({ textBody: 'Please book this stay.\nGuest: John Smith arriving 12 November.' })
        .where(eq(message.id, messageId));
      const run = await insertInboundExtraction(db, threadId, messageId);
      await insertStoredExtraction(db, messageId, 'amendment', {
        confirmationNumbers: [],
        stays: [
          {
            requested: { arrival: '2026-12-01', departure: '2026-12-03' },
            booked: { arrival: '2026-11-12', departure: '2026-11-14' },
          },
        ],
      });
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };

      expect(await prefetchHmsConfirmations(run, db, env)).toBe(1);
      const replay = { ...run, id: randomUUID(), idempotencyKey: `${run.idempotencyKey}:replay` };
      expect(await prefetchHmsConfirmations(replay, db, env)).toBe(0);
      const [job] = await db
        .select({ id: aiWorkflowRun.id, readRequest: aiWorkflowRun.readRequest, idempotencyKey: aiWorkflowRun.idempotencyKey })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION));
      expect(job?.readRequest).toMatchObject({ kind: 'search_guest', lastName: 'Smith', arrival: '2026-11-12' });
      expect(job?.idempotencyKey).toMatch(new RegExp(`^hms-job:prefetch-guest:${TRANSPORT_ID}:${threadId}:`));
      expect(job?.idempotencyKey).not.toContain('Smith');
      const resumed = await readHmsJobView(
        { transportId: TRANSPORT_ID, threadId, kind: 'search_guest', lastName: 'smith', arrival: '2026-11-12' },
        db,
      );
      expect(resumed).toMatchObject({ runId: job!.id, status: 'queued', prefetch: true });
    }));

  it('reuses the prefetched stable key when the pane auto-starts the same guest request', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, messageId } = await seedThread(db, 'Booking request');
      await insertStoredExtraction(db, messageId, 'booking', {
        confirmationNumbers: [],
        stays: [{ requested: { arrival: '2026-11-12' } }],
      });
      const key = guestSearchPrefetchIdempotencyKey(TRANSPORT_ID, threadId, 'Smith', '2026-11-12');
      const prefetch = await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          workItemId: null,
          userId: null,
          request: { kind: 'search_guest', lastName: 'Smith', arrival: '2026-11-12' },
          priority: HMS_JOB_PRIORITY_PREFETCH,
          idempotencyKey: key,
        },
        db,
      );
      const autoStart = await queueUserHmsJob(
        {
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          threadId,
          request: { kind: 'search_guest', lastName: 'smith', arrival: '2026-11-12' },
          idempotencyKey: guestSearchPrefetchIdempotencyKey(TRANSPORT_ID, threadId, 'smith', '2026-11-12'),
        },
        db,
      );

      expect(prefetch.run.priority).toBe(HMS_JOB_PRIORITY_PREFETCH);
      expect(autoStart?.id).toBe(prefetch.run.id);
      const rows = await db
        .select({ id: aiWorkflowRun.id })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.idempotencyKey, key));
      expect(rows).toHaveLength(1);
    }));

  it('does not guess a guest surname from the booker contact or conflicting guest labels', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };
      const cases = [
        {
          textBody: 'Please arrange the stay.',
          payload: {
            contact: { name: 'Jane Smith' },
            confirmationNumbers: [],
            stays: [{ requested: { arrival: '2026-11-12' } }],
          },
        },
        {
          textBody: 'Guest: John Smith\nGuest: Jane Jones',
          payload: { confirmationNumbers: [], stays: [{ requested: { arrival: '2026-11-12' } }] },
        },
      ];
      for (const fixture of cases) {
        const { threadId, messageId } = await seedThread(db, 'Booking request');
        await db.update(message).set({ textBody: fixture.textBody }).where(eq(message.id, messageId));
        const run = await insertInboundExtraction(db, threadId, messageId);
        await insertStoredExtraction(db, messageId, 'booking', fixture.payload);
        expect(await prefetchHmsConfirmations(run, db, env)).toBe(0);
      }
    }));

  it.each(['quote', 'spam', 'other'] as const)('does not prefetch guest or confirmation reads for extraction kind %s', (kind) =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, messageId } = await seedThread(db, 'Booking 1234567-1');
      await db.update(message).set({ textBody: 'Guest: John Smith' }).where(eq(message.id, messageId));
      const run = await insertInboundExtraction(db, threadId, messageId);
      await insertStoredExtraction(db, messageId, kind, {
        confirmationNumbers: ['1234567-1'],
        stays: [{ requested: { arrival: '2026-11-12' }, booked: { arrival: '2026-11-12' } }],
      });
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };
      expect(await prefetchHmsConfirmations(run, db, env)).toBe(0);
    }));

  it('keeps a search_guest budget separate and capped per transport per hour', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const env = {
        ...parseEnv(process.env as Record<string, string | undefined>),
        HMS_PREFETCH_ENABLED: true,
        HMS_PREFETCH_PER_HOUR: 0,
        HMS_GUEST_PREFETCH_PER_HOUR: 1,
      };
      const makeRequest = async (lastName: string) => {
        const { threadId, messageId } = await seedThread(db, 'Booking request');
        await db.update(message).set({ textBody: `Guest: ${lastName}` }).where(eq(message.id, messageId));
        const run = await insertInboundExtraction(db, threadId, messageId);
        await insertStoredExtraction(db, messageId, 'booking', {
          confirmationNumbers: [],
          stays: [{ requested: { arrival: '2026-11-12', departure: '2026-11-14' } }],
        });
        return run;
      };
      const first = await makeRequest('Smith');
      const second = await makeRequest('Jones');
      expect(await prefetchHmsConfirmations(first, db, env)).toBe(1);
      expect(await prefetchHmsConfirmations(second, db, env)).toBe(0);
    }));

  it('holds the guest hourly cap when two eligible messages prefetch concurrently', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    const env = {
      ...parseEnv(process.env as Record<string, string | undefined>),
      HMS_PREFETCH_ENABLED: true,
      HMS_PREFETCH_PER_HOUR: 0,
      HMS_GUEST_PREFETCH_PER_HOUR: 1,
    };
    // Real separate connections with committed fixtures. One shared connection would re-enter the advisory lock.
    const setup = openTestDbSession();
    const left = openTestDbSession();
    const right = openTestDbSession();
    const suffix = randomUUID();
    const transportId = `guest-cap-transport-${suffix}`;
    const mailbox = `guest-cap-${suffix}@zero.test`;
    const messageIds: string[] = [];
    try {
      await setup.db
        .insert(mailboxTransport)
        .values({ id: transportId, email: mailbox, ownerHeaderValue: mailbox, isActive: true });
      const makeRequest = async (lastName: string): Promise<AiWorkflowRun> => {
        const threadId = `guest-cap-thread-${randomUUID()}`;
        const messageId = `guest-cap-msg-${randomUUID()}`;
        messageIds.push(messageId);
        await setup.db.insert(mailThread).values({ id: threadId, transportId, threadRootId: threadId });
        await setup.db.insert(message).values({
          id: messageId,
          transportId,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.test',
          subject: 'Booking request',
          textBody: `Guest: ${lastName}`,
          receivedAt: new Date(),
        });
        const [run] = await setup.db
          .insert(aiWorkflowRun)
          .values({
            id: randomUUID(),
            transportId,
            threadId,
            triggerMessageId: messageId,
            runKind: 'inbound_extraction',
            idempotencyKey: `inbound-extraction:${messageId}`,
            modelId: 'amazon.nova-lite-v1:0',
            promptVersion: 'triage-v6',
            admissionSnapshotId: `snapshot-${randomUUID()}`,
            state: 'succeeded',
            executorLane: 'default',
            priority: 0,
          })
          .returning();
        if (!run) throw new Error('inbound extraction seed failed');
        await setup.db.insert(mailExtraction).values({
          id: randomUUID(),
          messageId,
          extractorVersion: `hms-prefetch-test-${randomUUID()}`,
          status: 'succeeded',
          kind: 'booking',
          payload: {
            confirmationNumbers: [],
            stays: [{ requested: { arrival: '2026-11-12', departure: '2026-11-14' } }],
          },
        });
        return run;
      };
      const firstRun = await makeRequest('Smith');
      const secondRun = await makeRequest('Jones');

      // Hold the transport's cap lock on a third connection. Both prefetches must wait behind it, not count past it.
      let markLocked = () => {};
      let failLocked: (error: unknown) => void = () => {};
      const locked = new Promise<void>((resolve, reject) => {
        markLocked = resolve;
        failLocked = reject;
      });
      let releaseLock = () => {};
      const released = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const holder = setup.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${'hms-prefetch:search_guest:' + transportId}, 0))`,
        );
        markLocked();
        await released;
      });
      // A holder that fails before taking the lock fails the wait, so the test reports the error instead of hanging.
      holder.catch(failLocked);
      let settledWhileHeld = 0;
      let doneWhileHeld = 0;
      let queued: number[] = [];
      try {
        await locked;
        const first = prefetchHmsConfirmations(firstRun, left.db, env).then((count) => {
          settledWhileHeld += 1;
          return count;
        });
        const second = prefetchHmsConfirmations(secondRun, right.db, env).then((count) => {
          settledWhileHeld += 1;
          return count;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        doneWhileHeld = settledWhileHeld;
        releaseLock();
        await holder;
        queued = await Promise.all([first, second]);
      } finally {
        // Release on every path, so the holder's transaction and its connection end even when a step above failed.
        releaseLock();
        await holder.catch(() => undefined);
      }
      expect(doneWhileHeld).toBe(0);
      expect(queued.reduce((sum, count) => sum + count, 0)).toBe(1);
      const rows = await setup.db
        .select({ id: aiWorkflowRun.id })
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.transportId, transportId),
            eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
            eq(aiWorkflowRun.priority, HMS_JOB_PRIORITY_PREFETCH),
          ),
        );
      expect(rows).toHaveLength(1);
    } finally {
      try {
        await setup.db.delete(aiWorkflowRun).where(eq(aiWorkflowRun.transportId, transportId));
        if (messageIds.length > 0) {
          await setup.db.delete(mailExtraction).where(inArray(mailExtraction.messageId, messageIds));
        }
        await setup.db.delete(message).where(eq(message.transportId, transportId));
        await setup.db.delete(mailThread).where(eq(mailThread.transportId, transportId));
        await setup.db.delete(mailboxTransport).where(eq(mailboxTransport.id, transportId));
      } finally {
        await Promise.all([setup.close(), left.close(), right.close()]);
      }
    }
  });

  it('uses the current message work item, not an older superseded thread item', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, messageId } = await seedThread(db, 'Current booking request');
      const oldMessageId = `old-${randomUUID()}`;
      await db.insert(message).values({
        id: oldMessageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.test',
        subject: 'Earlier booking request',
        textBody: 'Older request',
        receivedAt: new Date(Date.now() - 60_000),
        createdAt: new Date(Date.now() - 60_000),
      });
      await db.update(message).set({ textBody: 'Guest: John Smith' }).where(eq(message.id, messageId));
      const run = await insertInboundExtraction(db, threadId, messageId);
      await insertStoredExtraction(db, messageId, 'booking', {
        confirmationNumbers: [],
        stays: [{ requested: { arrival: '2026-11-12' } }],
      });
      const oldItemId = randomUUID();
      await db.insert(workItem).values({
        id: oldItemId,
        transportId: TRANSPORT_ID,
        threadId,
        sourceMessageId: oldMessageId,
        kind: 'booking',
        status: 'dismissed',
        updatedAt: new Date(Date.now() + 60_000),
      });
      const [currentItem] = await db
        .insert(workItem)
        .values({
          id: randomUUID(),
          transportId: TRANSPORT_ID,
          threadId,
          sourceMessageId: messageId,
          kind: 'booking',
          status: 'needs_you',
        })
        .returning({ id: workItem.id });
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };

      expect(await prefetchHmsConfirmations(run, db, env)).toBe(1);
      const [job] = await db
        .select({ workItemId: aiWorkflowRun.workItemId })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION));
      expect(job?.workItemId).toBe(currentItem!.id);
    }));

  it('waits for the matching triage result before queueing, and skips spam decided by triage', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, messageId } = await seedThread(db, 'Booking request');
      const snapshotId = `snapshot-${randomUUID()}`;
      const triage = await insertInboundExtraction(db, threadId, messageId, 'inbound_triage', snapshotId);
      await db.update(aiWorkflowRun).set({ state: 'running' }).where(eq(aiWorkflowRun.id, triage.id));
      const extraction = await insertInboundExtraction(db, threadId, messageId, 'inbound_extraction', snapshotId);
      await db.update(message).set({ textBody: 'Guest: John Smith' }).where(eq(message.id, messageId));
      await insertStoredExtraction(db, messageId, 'booking', {
        confirmationNumbers: [],
        stays: [{ requested: { arrival: '2026-11-12' } }],
      });
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };

      expect(await prefetchHmsConfirmations(extraction, db, env)).toBe(0);
      await db.update(mailThread).set({ spamAt: new Date() }).where(eq(mailThread.id, threadId));
      await db.update(aiWorkflowRun).set({ state: 'succeeded' }).where(eq(aiWorkflowRun.id, triage.id));
      expect(await prefetchHmsConfirmations(triage, db, env)).toBe(0);
    }));

  it('queues after extraction and triage both succeed, regardless of which succeeds last', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, messageId } = await seedThread(db, 'Booking request');
      const snapshotId = `snapshot-${randomUUID()}`;
      const triage = await insertInboundExtraction(db, threadId, messageId, 'inbound_triage', snapshotId);
      await db.update(aiWorkflowRun).set({ state: 'running' }).where(eq(aiWorkflowRun.id, triage.id));
      const extraction = await insertInboundExtraction(db, threadId, messageId, 'inbound_extraction', snapshotId);
      await db.update(message).set({ textBody: 'Guest: John Smith' }).where(eq(message.id, messageId));
      await insertStoredExtraction(db, messageId, 'booking', {
        confirmationNumbers: [],
        stays: [{ requested: { arrival: '2026-11-12' } }],
      });
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };

      expect(await prefetchHmsConfirmations(extraction, db, env)).toBe(0);
      await db.update(aiWorkflowRun).set({ state: 'succeeded' }).where(eq(aiWorkflowRun.id, triage.id));
      expect(await prefetchHmsConfirmations(triage, db, env)).toBe(1);
    }));

  it.each(['done', 'dismissed'] as const)('skips a thread whose latest work item is %s', (status) =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, messageId } = await seedThread(db, 'Booking request');
      await db.update(message).set({ textBody: 'Guest: John Smith' }).where(eq(message.id, messageId));
      const run = await insertInboundExtraction(db, threadId, messageId);
      await insertStoredExtraction(db, messageId, 'booking', {
        confirmationNumbers: [],
        stays: [{ requested: { arrival: '2026-11-12' } }],
      });
      await db.insert(workItem).values({
        id: randomUUID(),
        transportId: TRANSPORT_ID,
        threadId,
        sourceMessageId: messageId,
        kind: 'booking',
        status,
      });
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };
      expect(await prefetchHmsConfirmations(run, db, env)).toBe(0);
    }));

  it('skips staff-sent, outbound sent-copy, and history-only mail', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };
      for (const condition of ['staff', 'verified-staff-alias', 'sent', 'message-history', 'thread-history'] as const) {
        const { threadId, messageId } = await seedThread(db, 'Booking 1234567-1');
        const run = await insertInboundExtraction(db, threadId, messageId);
        await insertStoredExtraction(db, messageId, 'booking', { confirmationNumbers: ['1234567-1'] });
        if (condition === 'staff') {
          await db.update(message).set({ fromAddress: TRANSPORT_EMAIL }).where(eq(message.id, messageId));
        } else if (condition === 'verified-staff-alias') {
          const staffAlias = `reservations@${TRANSPORT_EMAIL.slice(TRANSPORT_EMAIL.lastIndexOf('@') + 1)}`;
          await db.update(message).set({ fromAddress: staffAlias }).where(eq(message.id, messageId));
          await db.insert(message).values({
            id: `sent-${randomUUID()}`,
            transportId: TRANSPORT_ID,
            threadId,
            direction: 'outbound',
            fromAddress: staffAlias,
            toAddresses: ['guest@example.test'],
            sentAt: new Date(),
          });
        } else if (condition === 'sent') {
          await db.update(message).set({ direction: 'outbound' }).where(eq(message.id, messageId));
        } else if (condition === 'message-history') {
          await db.update(message).set({ historyOnly: true }).where(eq(message.id, messageId));
        } else {
          await db.update(mailThread).set({ historyOnly: true }).where(eq(mailThread.id, threadId));
        }
        expect(await prefetchHmsConfirmations(run, db, env)).toBe(0);
      }
    }));

  it('the ai-worker claimer claims nothing while HMS_JOB_QUEUE is off', () =>
    withSeededTestDb(async (db) => {
      const { threadId } = await seedThread(db);
      await queueUserHmsJob(
        { transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, threadId, request: { kind: 'find', confirmation: CONFIRMATION } },
        db,
      );
      const execute = vi.fn(async () => undefined);
      expect(await runHmsJobOnce({ db, execute })).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    }));

  it('AE5 through the ai-worker claimer: queue, unmount, the worker runs the job, remount reads the result', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      paneStayLookupLoaders.lock = lockWith(true);
      paneStayLookupLoaders.spawn = vi.fn(async () => FOUND);
      const { threadId } = await seedThread(db);
      const queued = await queueUserHmsJob(
        { transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, threadId, request: { kind: 'find', confirmation: CONFIRMATION } },
        db,
      );
      // The pane is gone. The worker claims and runs the job on its own.
      const executed: string[] = [];
      const execute = async (runId: string) => {
        const [run] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId));
        executed.push(await runClaimedJob(db, run!));
      };
      expect(await runHmsJobOnce({ db, execute })).toBe(true);
      expect(executed).toEqual(['succeeded']);
      const remounted = await readHmsJobView(
        { transportId: TRANSPORT_ID, threadId, kind: 'find', confirmation: CONFIRMATION },
        db,
      );
      expect(remounted).toMatchObject({ runId: queued!.id, status: 'done' });
      expect(remounted?.result).toMatchObject({ outcome: 'found' });
      // A restart of that worker while a job runs puts it back to retry_wait for the next claim.
      const again = await queueUserHmsJob(
        { transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, threadId, request: { kind: 'find', confirmation: CONFIRMATION } },
        db,
      );
      const held = await claimJob(db, 'hms-ai-worker-333');
      await markAiRunRunning(
        { runId: held.id, claimOwner: held.claimOwner!, claimToken: held.claimToken!, deadlineAt: held.deadlineAt! },
        db,
      );
      await db
        .update(aiWorkflowRun)
        .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
        .where(eq(aiWorkflowRun.id, held.id));
      expect(await requeueHmsReadsAfterRestart({ ownerId: 'hms-ai-worker-444' }, db)).toBe(1);
      expect(await readHmsJobView({ transportId: TRANSPORT_ID, runId: again!.id }, db)).toMatchObject({
        status: 'retrying',
      });
    }));

  it('the ai-worker claimer takes only pane job runs on the hms lane, and nothing while the lane is paused', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, messageId } = await seedThread(db);
      const base = {
        transportId: TRANSPORT_ID,
        threadId,
        triggerMessageId: messageId,
        modelId: 'not_applicable',
        state: 'queued' as const,
        priority: 50,
        nextRunAt: new Date(Date.now() - 60_000),
        createdAt: new Date(Date.now() - 60_000),
      };
      // Other hms-lane work, older and higher priority than the pane job: a read-service read and a write.
      await db.insert(aiWorkflowRun).values([
        { ...base, id: randomUUID(), runKind: 'read_tool', idempotencyKey: `read-${randomUUID()}`, promptVersion: 'hms-read/1', executorLane: 'hms' },
        { ...base, id: randomUUID(), runKind: 'hms_write', idempotencyKey: `write-${randomUUID()}`, promptVersion: 'hms-write/1', executorLane: 'hms' },
      ]);
      const job = await queueUserHmsJob(
        { transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, threadId, request: { kind: 'find', confirmation: CONFIRMATION } },
        db,
      );
      const execute = vi.fn(async () => undefined);
      vi.stubEnv('HMS_LANE_PAUSED', '1');
      expect(await runHmsJobOnce({ db, execute })).toBe(false);
      vi.stubEnv('HMS_LANE_PAUSED', '');
      expect(await runHmsJobOnce({ db, execute })).toBe(true);
      expect(execute).toHaveBeenCalledWith(job!.id);
      expect(await runHmsJobOnce({ db, execute })).toBe(false);
      expect(execute).toHaveBeenCalledTimes(1);
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

async function insertInboundExtraction(
  db: DB,
  threadId: string,
  messageId: string,
  kind: 'inbound_extraction' | 'inbound_triage' = 'inbound_extraction',
  admissionSnapshotId = `snapshot-${randomUUID()}`,
): Promise<AiWorkflowRun> {
  const [row] = await db
    .insert(aiWorkflowRun)
    .values({
      id: randomUUID(),
      transportId: TRANSPORT_ID,
      threadId,
      triggerMessageId: messageId,
      runKind: kind,
      idempotencyKey:
        kind === 'inbound_triage' ? `inbound-triage:${messageId}` : `inbound-extraction:${messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v6',
      admissionSnapshotId,
      state: 'succeeded',
      executorLane: 'default',
      priority: 0,
    })
    .returning();
  if (!row) throw new Error('inbound extraction seed failed');
  return row;
}

async function insertStoredExtraction(
  db: DB,
  messageId: string,
  kind: 'quote' | 'booking' | 'amendment' | 'cancellation' | 'voucher_pop' | 'spam' | 'other',
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(mailExtraction).values({
    id: randomUUID(),
    messageId,
    extractorVersion: `hms-prefetch-test-${randomUUID()}`,
    status: 'succeeded',
    kind,
    payload,
  });
}

