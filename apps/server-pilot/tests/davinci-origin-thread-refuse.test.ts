import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  executeHmsJob,
  HMS_JOB_PRIORITY_PREFETCH,
  prefetchAvailabilityForExtraction,
  prefetchHmsConfirmations,
  prefetchPartyForExtraction,
  prefetchQuoteReadyForExtraction,
} from '../src/ai/hms-jobs.js';
import { HMS_JOB_PROMPT_VERSION, type AiRunFence, type AiWorkflowRun } from '../src/ai/run-ledger.js';
import { panePartyLookupLoaders } from '../src/ai/pane-party-lookup.js';
import { staffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import { parseEnv } from '../src/env.js';
import {
  CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
  mailboxHmsOriginBindLoaders,
} from '../src/hms/mailbox-hms-origin-bind.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { appRouter } from '../src/trpc/router.js';

const staffQuoteRunner = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/ai/staff-quote-run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/staff-quote-run.js')>()),
  runStaffQuote: staffQuoteRunner.run,
}));

const runLedger = vi.hoisted(() => ({
  markAiRunDeadLetter: vi.fn(),
  markAiRunRetry: vi.fn(),
  markAiRunSucceeded: vi.fn(),
}));
vi.mock('../src/ai/run-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/run-ledger.js')>()),
  ...runLedger,
}));

vi.mock('../src/hms/property-queue-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hms/property-queue-state.js')>()),
  staffQuoteInFlight: vi.fn(async () => false),
}));

const DAVINCI = 'davinci@legacyhotels.co.za';
const CENTURION = 'centurion@legacyhotels.co.za';
const TRANSPORT_ID = 'transport-centurion';
const THREAD_ID = 'thread-mixed';
const TRIGGER_ID = 'msg-cen-trigger';
const RUN_ID = '00000000-0000-4000-8000-000000000099';

const STAFF_QUOTE_INPUT = staffQuoteInput.parse({
  messageId: TRIGGER_ID,
  sourceHash: 'a'.repeat(64),
  selectionEpoch: 1,
  inputRevision: 1,
  groups: [
    {
      id: 'single',
      arrivalDate: '2099-11-12',
      departureDate: '2099-11-14',
      quantity: 2,
      adults: 2,
      childrenAges: [],
      board: 'bb',
      roomCodes: ['SKNG'],
    },
  ],
  salesStrategy: 'BAR',
  company: '',
  agency: '',
  attention: '',
  clientEmail: '',
  clientTelephone: '',
});

function mixedOriginScan() {
  return {
    selected: {
      fromAddress: 'guest@example.test',
      toAddresses: [CENTURION],
    },
    selectedFound: true,
    inbounds: [
      { fromAddress: 'guest@example.test', toAddresses: [CENTURION] },
      { fromAddress: 'guest@example.test', toAddresses: [DAVINCI] },
    ],
  };
}

function thenableRows(rows: unknown[]) {
  const query: Record<string, unknown> = {};
  const self = () => query;
  query.select = self;
  query.from = self;
  query.innerJoin = self;
  query.where = self;
  query.orderBy = self;
  query.limit = self;
  query.values = () => query;
  query.onConflictDoNothing = () => query;
  query.returning = async () => {
    throw new Error('enqueue must not run for mixed-origin');
  };
  // Test double: drizzle query builders are thenable. Production code awaits the chain.
  // oxlint-disable-next-line no-thenable
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return query;
}

function sequentialDb(results: unknown[][]): DB {
  let index = 0;
  return {
    select() {
      const rows = results[index] ?? [];
      index += 1;
      return thenableRows(rows);
    },
    insert() {
      return thenableRows([]);
    },
  } as unknown as DB;
}

function caller() {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers({ 'x-zero-active-transport': TRANSPORT_ID }),
    sessionUser: { id: 'user-ropperman', email: 'staff@example.invalid', name: 'Synthetic Staff' },
  } as never);
}

const originScan = vi.fn(async (input: { threadId: string; messageId?: string }) => {
  expect(input.threadId).toBe(THREAD_ID);
  expect(input.messageId).toBe(TRIGGER_ID);
  return mixedOriginScan();
});

function stubMixedOrigin() {
  originScan.mockClear();
  mailboxHmsOriginBindLoaders.loadThreadOriginScan = originScan;
}

function paneMailDb(): DB {
  return {
    select() {
      return thenableRows([
        {
          id: TRIGGER_ID,
          threadId: THREAD_ID,
          direction: 'inbound',
          transportId: TRANSPORT_ID,
        },
      ]);
    },
  } as unknown as DB;
}

function bookingSource() {
  return {
    extractionStatus: 'succeeded',
    kind: 'booking',
    payload: { confirmationNumbers: ['1234567-1'] },
    subject: 'Booking 1234567-1',
    textBody: 'Please amend 1234567-1.',
    direction: 'inbound',
    historyOnly: false,
    fromAddress: 'guest@example.test',
    threadHistoryOnly: false,
    spamAt: null,
    mailboxEmail: CENTURION,
  };
}

function quoteSource() {
  return {
    threadId: THREAD_ID,
    extractionStatus: 'succeeded',
    extractionKind: 'quote',
    kind: 'quote',
    payload: {
      origin: 'person',
      contact: { name: 'Alex Guest', email: 'alex@example.test', phone: null },
      agency: 'Horizon Trail Tours',
      endClient: 'Example Client',
      confirmationNumbers: [],
      stays: [
        {
          id: 's_12345678',
          hotel: 'Centurion',
          requested: { arrival: '2099-11-12', departure: '2099-11-14' },
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
    },
    subject: 'Quote request',
    textBody: 'Please quote two kings.',
    htmlBody: null,
    direction: 'inbound',
    historyOnly: false,
    fromAddress: 'guest@example.test',
    ownerHeaderValue: null,
    toAddresses: [CENTURION],
    ccAddresses: [],
    threadHistoryOnly: false,
    spamAt: null,
    mailboxEmail: CENTURION,
    messageId: TRIGGER_ID,
    transportId: TRANSPORT_ID,
  };
}

function extractionRun(): AiWorkflowRun {
  return {
    id: randomUUID(),
    transportId: TRANSPORT_ID,
    threadId: THREAD_ID,
    triggerMessageId: TRIGGER_ID,
    runKind: 'inbound_extraction',
    idempotencyKey: `inbound-extraction:${TRIGGER_ID}`,
    admissionSnapshotId: 'snapshot-1',
    state: 'succeeded',
  } as AiWorkflowRun;
}

function prefetchEnv() {
  return {
    ...parseEnv({
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgres://zero:secret@127.0.0.1:5432/test',
      BETTER_AUTH_URL: 'https://nava.legacy.local',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      AWS_REGION: 'synthetic-region-1',
      S3_BUCKET: 'origin-refuse-test',
    }),
    HMS_PREFETCH_ENABLED: true,
  };
}

beforeEach(() => {
  vi.stubEnv('HMS_JOB_QUEUE', 'on');
  vi.stubEnv('PORT', '3000');
  vi.stubEnv('BETTER_AUTH_URL', 'https://nava.legacy.local');
  vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(32));
  vi.stubEnv('AWS_REGION', 'synthetic-region-1');
  vi.stubEnv('S3_BUCKET', 'origin-refuse-test');
  stubMixedOrigin();
  staffQuoteRunner.run.mockReset();
  runLedger.markAiRunDeadLetter.mockReset().mockResolvedValue({ id: RUN_ID });
  runLedger.markAiRunRetry.mockReset().mockResolvedValue({ id: RUN_ID });
  runLedger.markAiRunSucceeded.mockReset().mockResolvedValue({ id: RUN_ID });
  panePartyLookupLoaders.enabled = () => true;
  panePartyLookupLoaders.lock = { withLock: async (run) => run() } as never;
  panePartyLookupLoaders.spawn = vi.fn(async () => {
    throw new Error('HMS find must not run for mixed-origin');
  });
});

afterEach(() => {
  mailboxHmsOriginBindLoaders.loadThreadOrigin = null;
  mailboxHmsOriginBindLoaders.loadThreadOriginScan = null;
  __setDbForTests(null);
  panePartyLookupLoaders.spawn = null;
  panePartyLookupLoaders.lock = null;
  panePartyLookupLoaders.enabled = null;
  vi.unstubAllEnvs();
});

describe('Da Vinci mixed-origin thread refuse', () => {
  it('pane executeStaffQuote refuses mixed-origin before the direct read', async () => {
    __setDbForTests({ db: paneMailDb(), conn: null as never });
    await expect(caller().workstation.executeStaffQuote(STAFF_QUOTE_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
    });
    expect(staffQuoteRunner.run).not.toHaveBeenCalled();
    expect(originScan).toHaveBeenCalledTimes(1);
  });

  it('pane queueStaffQuote refuses mixed-origin and does not enqueue', async () => {
    __setDbForTests({ db: paneMailDb(), conn: null as never });
    await expect(caller().workstation.queueStaffQuote(STAFF_QUOTE_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
    });
    expect(originScan).toHaveBeenCalledTimes(1);
  });

  it('confirmation prefetch refuses mixed-origin and does not enqueue', async () => {
    const db = sequentialDb([[{ id: 'extraction-1' }], [], [bookingSource()], []]);
    await expect(prefetchHmsConfirmations(extractionRun(), db, prefetchEnv())).resolves.toBe(0);
    expect(originScan).toHaveBeenCalledTimes(1);
  });

  it('availability prefetch refuses mixed-origin and does not enqueue', async () => {
    const db = sequentialDb([
      [{ threadId: THREAD_ID, payload: quoteSource().payload, spamAt: null }],
    ]);
    await expect(
      prefetchAvailabilityForExtraction(
        { runKind: 'inbound_extraction', transportId: TRANSPORT_ID, triggerMessageId: TRIGGER_ID },
        db,
        { HMS_JOB_QUEUE: 'on', HMS_AVAILABILITY_PREFETCH: 'on' },
      ),
    ).resolves.toBe(0);
    expect(originScan).toHaveBeenCalledTimes(1);
  });

  it('quote-ready prefetch refuses mixed-origin and does not enqueue', async () => {
    const source = quoteSource();
    const db = sequentialDb([
      [source],
      [],
      [],
      [],
    ]);
    await expect(
      prefetchQuoteReadyForExtraction(
        { runKind: 'inbound_extraction', transportId: TRANSPORT_ID, triggerMessageId: TRIGGER_ID },
        db,
        { HMS_JOB_QUEUE: 'on', HMS_QUOTE_PREPARE: 'true', HMS_QUOTE_PREPARE_PER_HOUR: '6' },
      ),
    ).resolves.toBe(0);
    expect(originScan).toHaveBeenCalledTimes(1);
  });

  it('party prefetch refuses mixed-origin even when the trigger is Centurion-only', async () => {
    const db = sequentialDb([[quoteSource()]]);
    await expect(prefetchPartyForExtraction(extractionRun(), db, prefetchEnv())).resolves.toBe(0);
    expect(originScan).toHaveBeenCalledTimes(1);
  });

  it('party V2 execute refuses mixed-origin before HMS find', async () => {
    vi.stubEnv('PARTY_MATCH_V2', '1');
    const db = sequentialDb([[quoteSource()]]);
    const fence: AiRunFence = {
      runId: RUN_ID,
      claimOwner: 'hms-ai-worker-111',
      claimToken: 'claim-token',
      deadlineAt: new Date(Date.now() + 60_000),
    };
    const run = {
      id: RUN_ID,
      transportId: TRANSPORT_ID,
      threadId: THREAD_ID,
      triggerMessageId: TRIGGER_ID,
      runKind: 'read_tool',
      idempotencyKey: 'hms-job:party-v2',
      promptVersion: HMS_JOB_PROMPT_VERSION,
      readRequest: { kind: 'party', name: 'Horizon Trail Tours', matchVersion: 2 },
      executorLane: 'hms',
      priority: HMS_JOB_PRIORITY_PREFETCH,
      state: 'running',
      attempts: 0,
      metrics: { hmsJob: true, userId: null },
    } as AiWorkflowRun;
    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('dead_letter');
    expect(runLedger.markAiRunDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({
        lastError: 'refused_origin_mismatch',
        failureClass: 'POLICY_BLOCK',
      }),
      db,
    );
    expect(panePartyLookupLoaders.spawn).not.toHaveBeenCalled();
    expect(originScan).toHaveBeenCalledTimes(1);
  });
});
