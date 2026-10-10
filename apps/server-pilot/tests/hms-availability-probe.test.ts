import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  claimNextAiRun,
  HMS_JOB_PROMPT_VERSION,
  markAiRunRunning,
  type AiWorkflowRun,
} from '../src/ai/run-ledger.js';
import {
  availabilityPrefetchEnabled,
  enqueueHmsJob,
  executeHmsJob,
  HMS_JOB_PRIORITY_PREFETCH,
  prefetchAvailabilityForExtraction,
  readHmsJobView,
} from '../src/ai/hms-jobs.js';
import {
  availabilityProbeLoaders,
  availabilityRequestsFor,
  availabilitySnapshotOf,
  probeAvailability,
  quoteRequestFor,
  type AvailabilityRequest,
  type QuoteEnvelope,
} from '../src/ai/hms-availability.js';
import { paneStayLookupLoaders } from '../src/ai/pane-stay-lookup.js';
import type { PaneStayLock } from '../src/ai/pane-stay-save.js';
import { aiDraftGeneration, aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction } from '../src/db/schema/work.js';
import type { DB } from '../src/db/client.js';
import { parseEnv } from '../src/env.js';
import { appRouter } from '../src/trpc/router.js';
import { createPropertyReadLock, PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';
import { CENTURION_USER_ID, TRANSPORT_ID } from '../src/db/seed.js';
import { probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';

const reachable = await probeTestDb();
const TENANT = 'tenant-centurion';
const LANE_OWNER = 'hms-ai-worker-111';
const normalizer = (await import('../tooling/playwright-quote/quote-contract.mjs' as string)) as {
  normalizeQuoteRequest: (input: unknown) => { ok: boolean; issues: unknown[] };
};

afterEach(() => {
  paneStayLookupLoaders.lock = null;
  availabilityProbeLoaders.spawn = null;
  vi.unstubAllEnvs();
});

// Two complete stays and one with no room count. The incomplete stay yields no probe.
const STAY_A = {
  id: 's_aaaa1111',
  hotel: 'Centurion',
  requested: { arrival: '2026-10-26', departure: '2026-10-27' },
  booked: null,
  totalRooms: 2,
  rows: [
    { id: 'r_1', roomType: 'Single', rooms: 1, adultsPerRoom: 1, childAges: [], board: null },
    { id: 'r_2', roomType: 'Double/Twin', rooms: 1, adultsPerRoom: 2, childAges: [], board: null },
  ],
};
const STAY_B = {
  id: 's_bbbb2222',
  hotel: null,
  requested: { arrival: '2026-11-17', departure: '2026-11-18' },
  booked: null,
  totalRooms: 1,
  rows: [{ id: 'r_3', roomType: 'Family', rooms: 1, adultsPerRoom: 2, childAges: [6], board: 'bb' }],
};
const STAY_INCOMPLETE = {
  id: 's_cccc3333',
  hotel: null,
  requested: { arrival: '2026-12-01', departure: '2026-12-03' },
  booked: null,
  totalRooms: 2,
  rows: [{ id: 'r_4', roomType: 'Double', rooms: null, adultsPerRoom: 2, childAges: [], board: null }],
};
const PAYLOAD = {
  contact: { name: null, email: null, phone: null },
  agency: null,
  endClient: null,
  confirmationNumbers: [],
  stays: [STAY_A, STAY_B, STAY_INCOMPLETE],
  missing: [],
};

const QUOTE_RESULT: QuoteEnvelope = {
  schemaVersion: 2,
  outcome: 'partial',
  observedAt: '2026-10-10T00:05:00.000Z',
  groups: [
    {
      id: 'group-1',
      outcome: 'quote',
      options: [
        { room: { code: 'STQN', label: 'Standard Queen' }, rate: { code: 'BAR', label: 'Best available' }, availability: 'available' },
        { room: { code: 'STTW', label: 'Standard Twin' }, rate: { code: 'BAR', label: 'Best available' }, availability: 'unavailable' },
      ],
    },
    { id: 'group-2', outcome: 'unavailable', options: [] },
  ],
};

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

/** The process env with the probe flags set. The lane-DB suite stubs the server's required keys into it. */
function probeEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...process.env, HMS_JOB_QUEUE: 'on', HMS_AVAILABILITY_PREFETCH: 'on', ...overrides } as Record<string, string>;
}

const EXTRACTION_RUN = (messageId: string) => ({
  runKind: 'inbound_extraction' as const,
  transportId: TRANSPORT_ID,
  triggerMessageId: messageId,
});

async function seedThread(db: DB): Promise<{ threadId: string; messageId: string }> {
  const threadId = `thread-${randomUUID()}`;
  const messageId = `msg-${randomUUID()}`;
  await db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID, threadRootId: threadId });
  await db.insert(message).values({
    id: messageId,
    transportId: TRANSPORT_ID,
    threadId,
    direction: 'inbound',
    fromAddress: 'guest@example.test',
    subject: 'Quote request',
    textBody: 'Please quote two rooms.',
    receivedAt: new Date(),
  });
  return { threadId, messageId };
}

async function seedExtraction(
  db: DB,
  messageId: string,
  kind: 'quote' | 'booking',
  payload: unknown = PAYLOAD,
): Promise<void> {
  await db.insert(mailExtraction).values({
    messageId,
    extractorVersion: 'extract-u10-test',
    status: 'succeeded',
    kind,
    payload: payload as Record<string, unknown>,
  });
}

async function availabilityRuns(db: DB) {
  return db
    .select({ id: aiWorkflowRun.id, priority: aiWorkflowRun.priority, idempotencyKey: aiWorkflowRun.idempotencyKey })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
        like(aiWorkflowRun.idempotencyKey, 'hms-job:availability:%'),
      ),
    );
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

describe('U10 availability probe (pure)', () => {
  it('turns the probe on only when HMS_JOB_QUEUE=on and HMS_AVAILABILITY_PREFETCH=on', () => {
    expect(availabilityPrefetchEnabled({})).toBe(false);
    expect(availabilityPrefetchEnabled({ HMS_AVAILABILITY_PREFETCH: 'on' })).toBe(false);
    expect(availabilityPrefetchEnabled({ HMS_JOB_QUEUE: 'on' })).toBe(false);
    expect(availabilityPrefetchEnabled({ HMS_JOB_QUEUE: 'on', HMS_AVAILABILITY_PREFETCH: '1' })).toBe(false);
    expect(availabilityPrefetchEnabled({ HMS_JOB_QUEUE: 'on', HMS_AVAILABILITY_PREFETCH: 'on' })).toBe(true);
  });

  it('builds one probe per complete stay, with its dates and each room group, and skips the rest', () => {
    expect(availabilityRequestsFor(PAYLOAD)).toEqual([
      {
        kind: 'availability',
        arrival: '2026-10-26',
        departure: '2026-10-27',
        rooms: [
          { roomType: 'Single', quantity: 1, adults: 1, childAges: [] },
          { roomType: 'Double/Twin', quantity: 1, adults: 2, childAges: [] },
        ],
      },
      {
        kind: 'availability',
        arrival: '2026-11-17',
        departure: '2026-11-18',
        rooms: [{ roomType: 'Family', quantity: 1, adults: 2, childAges: [6] }],
      },
    ]);
  });

  it('gives no probe for bad dates, a stay over 30 nights, or a room with no type, and never throws on them', () => {
    const stay = (requested: { arrival: string | null; departure: string | null }, rows = STAY_A.rows) => ({
      ...STAY_A,
      requested,
      rows,
    });
    const payload = (...stays: unknown[]) => ({ stays });
    expect(availabilityRequestsFor(payload(stay({ arrival: '2026-02-30', departure: '2026-03-02' })))).toEqual([]);
    // A month past 12 is not a day, and must not throw out of the whole extraction.
    expect(availabilityRequestsFor(payload(stay({ arrival: '2026-13-01', departure: '2026-13-03' })))).toEqual([]);
    expect(availabilityRequestsFor(payload(stay({ arrival: '2026-10-01', departure: '2026-11-02' })))).toEqual([]);
    expect(availabilityRequestsFor(payload(stay({ arrival: '2026-10-05', departure: '2026-10-05' })))).toEqual([]);
    expect(availabilityRequestsFor(payload(stay({ arrival: null, departure: '2026-10-05' })))).toEqual([]);
    const untyped = [{ ...STAY_A.rows[0], roomType: null }];
    expect(availabilityRequestsFor(payload(stay({ arrival: '2026-10-26', departure: '2026-10-27' }, untyped)))).toEqual([]);
    expect(availabilityRequestsFor(payload(stay({ arrival: '2026-10-26', departure: '2026-10-27' }, [])))).toEqual([]);
    expect(availabilityRequestsFor({ stays: 'not a list' })).toEqual([]);
    expect(availabilityRequestsFor(null)).toEqual([]);
  });

  it('sends the quote tool a v2 request with the session property, dates and occupancy, and no rate or room codes', () => {
    const [request] = availabilityRequestsFor(PAYLOAD) as AvailabilityRequest[];
    const quote = quoteRequestFor(request!);
    expect(quote).toEqual({
      schemaVersion: 2,
      propertyCode: 'HRCEN',
      arrivalDate: '2026-10-26',
      departureDate: '2026-10-27',
      details: 'summary',
      rooms: [
        { id: 'group-1', quantity: 1, adults: 1, children: 0, childAges: [] },
        { id: 'group-2', quantity: 1, adults: 2, children: 0, childAges: [] },
      ],
    });
    // The quote tool's own normalizer accepts it, so a probe is never refused as input_gap.
    expect(normalizer.normalizeQuoteRequest(quote).ok).toBe(true);
    // A child's age reaches the request as a child, not as an adult.
    const withChild = quoteRequestFor(availabilityRequestsFor(PAYLOAD)[1]!);
    expect(withChild).toMatchObject({ rooms: [{ id: 'group-1', adults: 2, children: 1, childAges: [6] }] });
    expect(normalizer.normalizeQuoteRequest(withChild).ok).toBe(true);
  });

  it('snapshots each group with its options, counts the available ones, and keeps no evidence', () => {
    expect(availabilitySnapshotOf(QUOTE_RESULT)).toEqual({
      searchOutcome: 'partial',
      observedAt: '2026-10-10T00:05:00.000Z',
      availableOptions: 1,
      groups: [
        {
          id: 'group-1',
          outcome: 'quote',
          options: [
            { room: 'STQN', rate: 'BAR', availability: 'available' },
            { room: 'STTW', rate: 'BAR', availability: 'unavailable' },
          ],
        },
        { id: 'group-2', outcome: 'unavailable', options: [] },
      ],
    });
    const bare = availabilitySnapshotOf({
      outcome: 'quote',
      groups: [{ id: 'g', outcome: 'quote', options: [{ room: { code: 'X' } }] }],
    });
    expect(bare.groups[0]!.options[0]).toEqual({ room: 'X', rate: null, availability: 'unknown' });
  });

  it('reads under the property lock, and maps busy, unavailable, refused and failed reads to job outcomes', async () => {
    const [request] = availabilityRequestsFor(PAYLOAD) as AvailabilityRequest[];
    const acquisition = { tryOnce: true };
    const spawn = vi.fn(async () => QUOTE_RESULT);
    availabilityProbeLoaders.spawn = spawn;
    const passThrough = { withLock: async (fn: () => Promise<unknown>) => fn() } as unknown as PaneStayLock;
    expect(await probeAvailability(request!, { lock: () => passThrough, acquisition })).toMatchObject({
      outcome: 'read',
      searchOutcome: 'partial',
      availableOptions: 1,
    });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ propertyCode: 'HRCEN' }));

    expect(await probeAvailability(request!, { lock: () => null, acquisition })).toEqual({
      outcome: 'refused_lock_unavailable',
    });
    const busy = {
      withLock: async () => Promise.reject(new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE)),
    } as unknown as PaneStayLock;
    expect(await probeAvailability(request!, { lock: () => busy, acquisition })).toEqual({ outcome: 'refused_lock_busy' });

    availabilityProbeLoaders.spawn = async () => ({ outcome: 'input_gap' });
    expect(await probeAvailability(request!, { lock: () => passThrough, acquisition })).toEqual({
      outcome: 'refused_input_invalid',
    });
    availabilityProbeLoaders.spawn = async () => {
      throw new Error('login failed');
    };
    expect(await probeAvailability(request!, { lock: () => passThrough, acquisition })).toEqual({
      outcome: 'execution_failure',
    });
  });

  it('jobStatus takes a kind of availability with stay dates, and reads nothing with the queue off', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', '');
    const caller = appRouter.createCaller({
      auth: null as never,
      reqHeaders: new Headers(),
      sessionUser: { id: 'user-ropperman', email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' },
      activeTransportId: 'transport-1',
      transportEmail: 'centurion@legacyhotels.co.za',
      accessRole: 'owner',
    } as never);
    await expect(
      caller.paneStayLookup.jobStatus({
        threadId: 'thread-1',
        kind: 'availability',
        arrival: '2026-10-26',
        departure: '2026-10-27',
      }),
    ).resolves.toBeNull();
    await expect(
      caller.paneStayLookup.jobStatus({ threadId: 'thread-1', kind: 'availability', arrival: '26-10-2026' }),
    ).rejects.toThrow();
  });
});

// Each case seeds a fresh rolled-back database; the shared lane box is slow under load.
describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('U10 availability probe (lane DB)', { timeout: 60_000 }, () => {
  beforeEach(() => {
    // parseEnv needs the server's required keys; the rest of the lane config stays unset.
    vi.stubEnv('PORT', '3000');
    vi.stubEnv('BETTER_AUTH_URL', 'https://nava.legacy.local');
    vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(32));
    vi.stubEnv('AWS_REGION', 'synthetic-region-1');
    vi.stubEnv('S3_BUCKET', 'u10-synthetic-bucket');
  });

  it('flag off → nothing: no probe is queued unless HMS_JOB_QUEUE and HMS_AVAILABILITY_PREFETCH are both on', () =>
    withSeededTestDb(async (db) => {
      const { messageId } = await seedThread(db);
      await seedExtraction(db, messageId, 'quote');
      const run = EXTRACTION_RUN(messageId);
      expect(await prefetchAvailabilityForExtraction(run, db, probeEnv({ HMS_AVAILABILITY_PREFETCH: 'off' }))).toBe(0);
      expect(await prefetchAvailabilityForExtraction(run, db, probeEnv({ HMS_AVAILABILITY_PREFETCH: '' }))).toBe(0);
      expect(await prefetchAvailabilityForExtraction(run, db, probeEnv({ HMS_JOB_QUEUE: 'off' }))).toBe(0);
      expect(await prefetchAvailabilityForExtraction({ ...run, runKind: 'inbound_triage' }, db, probeEnv())).toBe(0);
      expect(await availabilityRuns(db)).toHaveLength(0);
    }));

  it('only a succeeded quote extraction queues probes: booking mail and spam do not', () =>
    withSeededTestDb(async (db) => {
      const booking = await seedThread(db);
      await seedExtraction(db, booking.messageId, 'booking');
      expect(await prefetchAvailabilityForExtraction(EXTRACTION_RUN(booking.messageId), db, probeEnv())).toBe(0);

      const spam = await seedThread(db);
      await seedExtraction(db, spam.messageId, 'quote');
      await db.update(mailThread).set({ spamAt: new Date() }).where(eq(mailThread.id, spam.threadId));
      expect(await prefetchAvailabilityForExtraction(EXTRACTION_RUN(spam.messageId), db, probeEnv())).toBe(0);
      expect(await availabilityRuns(db)).toHaveLength(0);
    }));

  it('queues one probe per complete stay, and a repeat of the same stays on the same day is no new job', () =>
    withSeededTestDb(async (db) => {
      const first = await seedThread(db);
      await seedExtraction(db, first.messageId, 'quote');
      expect(await prefetchAvailabilityForExtraction(EXTRACTION_RUN(first.messageId), db, probeEnv())).toBe(2);

      // The same stays from a second mail: deduplicated by the stay's digest and the day.
      const second = await seedThread(db);
      await seedExtraction(db, second.messageId, 'quote');
      expect(await prefetchAvailabilityForExtraction(EXTRACTION_RUN(second.messageId), db, probeEnv())).toBe(0);

      const rows = await availabilityRuns(db);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.priority === HMS_JOB_PRIORITY_PREFETCH)).toBe(true);
    }));

  it('the hourly cap stops the probes at HMS_PREFETCH_PER_HOUR', () =>
    withSeededTestDb(async (db) => {
      const { messageId } = await seedThread(db);
      await seedExtraction(db, messageId, 'quote');
      const capped = probeEnv({ HMS_PREFETCH_PER_HOUR: '1' });
      expect(parseEnv(capped).HMS_PREFETCH_PER_HOUR).toBe(1);
      expect(await prefetchAvailabilityForExtraction(EXTRACTION_RUN(messageId), db, capped)).toBe(1);
      expect(await availabilityRuns(db)).toHaveLength(1);
    }));

  it('a confirmation prefetch already in the hour takes the slot the probes would use', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      await seedExtraction(db, messageId, 'quote');
      await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          workItemId: null,
          userId: null,
          request: { kind: 'find', confirmation: '1234567-1' },
          priority: HMS_JOB_PRIORITY_PREFETCH,
          idempotencyKey: `hms-job:prefetch:${TRANSPORT_ID}:1234567-1:cap`,
        },
        db,
      );
      expect(
        await prefetchAvailabilityForExtraction(EXTRACTION_RUN(messageId), db, probeEnv({ HMS_PREFETCH_PER_HOUR: '1' })),
      ).toBe(0);
      expect(await availabilityRuns(db)).toHaveLength(0);
    }));

  it('a staff quote in flight holds the probe: it yields without the lock and without reading HMS', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      await seedExtraction(db, messageId, 'quote');
      await db.insert(aiDraftGeneration).values({
        id: randomUUID(),
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: CENTURION_USER_ID,
        model: 'staff-approved-native',
        promptVersion: 'quote-v1',
        status: 'running',
      });
      const takeLock = vi.fn(async (fn: () => Promise<unknown>) => fn());
      paneStayLookupLoaders.lock = { withLock: takeLock } as unknown as PaneStayLock;
      const spawn = vi.fn(async () => QUOTE_RESULT);
      availabilityProbeLoaders.spawn = spawn;
      expect(await prefetchAvailabilityForExtraction(EXTRACTION_RUN(messageId), db, probeEnv())).toBe(2);

      const claimed = await claimJob(db);
      expect(await runClaimedJob(db, claimed)).toBe('retry_wait');
      expect(takeLock).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(await readHmsJobView({ transportId: TRANSPORT_ID, runId: claimed.id }, db)).toMatchObject({
        runId: claimed.id,
        status: 'retrying',
        failureClass: 'STAFF_QUOTE_ACTIVE',
        attempts: 0,
        prefetch: true,
      });
    }));

  it('a busy property lock requeues the probe without using an attempt, and reads nothing', () =>
    withSeededTestDb(async (db) => {
      const { messageId } = await seedThread(db);
      await seedExtraction(db, messageId, 'quote');
      paneStayLookupLoaders.lock = lockWith(false);
      const spawn = vi.fn(async () => QUOTE_RESULT);
      availabilityProbeLoaders.spawn = spawn;
      expect(await prefetchAvailabilityForExtraction(EXTRACTION_RUN(messageId), db, probeEnv())).toBe(2);

      const claimed = await claimJob(db);
      expect(await runClaimedJob(db, claimed)).toBe('retry_wait');
      expect(spawn).not.toHaveBeenCalled();
      expect(await readHmsJobView({ transportId: TRANSPORT_ID, runId: claimed.id }, db)).toMatchObject({
        status: 'retrying',
        failureClass: 'HMS_LOCK_BUSY',
        attempts: 0,
      });
    }));

  it('a finished probe is a snapshot with its as-of time, and each stay reads back its own by dates', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      await seedExtraction(db, messageId, 'quote');
      paneStayLookupLoaders.lock = lockWith(true);
      availabilityProbeLoaders.spawn = vi.fn(async () => QUOTE_RESULT);
      expect(await prefetchAvailabilityForExtraction(EXTRACTION_RUN(messageId), db, probeEnv())).toBe(2);

      // Both queued probes run, in whichever order the lane claims them.
      const before = Date.now();
      expect(await runClaimedJob(db, await claimJob(db))).toBe('succeeded');
      expect(await runClaimedJob(db, await claimJob(db))).toBe('succeeded');
      const after = Date.now();

      const first = await readHmsJobView(
        {
          transportId: TRANSPORT_ID,
          threadId,
          kind: 'availability',
          arrival: '2026-10-26',
          departure: '2026-10-27',
        },
        db,
      );
      expect(first).toMatchObject({
        status: 'done',
        prefetch: true,
        request: { kind: 'availability', arrival: '2026-10-26', departure: '2026-10-27' },
        result: { outcome: 'read', searchOutcome: 'partial', availableOptions: 1, kind: 'availability' },
      });
      const asOf = Date.parse(first!.asOf!);
      expect(asOf).toBeGreaterThanOrEqual(before);
      expect(asOf).toBeLessThanOrEqual(after);

      const second = await readHmsJobView(
        {
          transportId: TRANSPORT_ID,
          threadId,
          kind: 'availability',
          arrival: '2026-11-17',
          departure: '2026-11-18',
        },
        db,
      );
      expect(second).toMatchObject({ status: 'done', request: { arrival: '2026-11-17' } });
      expect(second!.asOf).toEqual(expect.any(String));
    }));

  it('a probe whose read fails is retried, and its snapshot is not stored', () =>
    withSeededTestDb(async (db) => {
      const { messageId } = await seedThread(db);
      await seedExtraction(db, messageId, 'quote');
      paneStayLookupLoaders.lock = lockWith(true);
      availabilityProbeLoaders.spawn = vi.fn(async () => {
        throw new Error('quote tool exited');
      });
      expect(await prefetchAvailabilityForExtraction(EXTRACTION_RUN(messageId), db, probeEnv())).toBe(2);

      const claimed = await claimJob(db);
      expect(await runClaimedJob(db, claimed)).toBe('retry_wait');
      expect(await readHmsJobView({ transportId: TRANSPORT_ID, runId: claimed.id }, db)).toMatchObject({
        status: 'retrying',
        failureClass: 'TRANSIENT_NETWORK',
        attempts: 1,
        asOf: null,
        result: null,
      });
    }));
});
