import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'node:crypto';
import * as hmsJobs from '../src/ai/hms-jobs.js';
import { staffQuoteInput, type StaffQuoteInput } from '../src/ai/staff-quote-workflow.js';
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
  enqueueHmsBatch,
  confirmationPrefetchIdempotencyKey,
  executeHmsJob,
  extractHmsConfirmations,
  extractUniqueArrivalForHmsPrefetch,
  guestSearchPrefetchIdempotencyKey,
  hmsJobQueueEnabled,
  hmsJobRequestSchema,
  HMS_JOB_PRIORITY_DEV,
  HMS_JOB_PRIORITY_PREFETCH,
  HMS_JOB_PRIORITY_REFRESH,
  HMS_JOB_PRIORITY_USER,
  prefetchHmsConfirmations,
  prefetchQuoteReadyForExtraction,
  selectHmsBatchRequest,
  queueUserPartyHmsJob,
  queueUserHmsJob,
  readHmsJobView,
  requeueHmsReadsAfterRestart,
  partyHistoryPropertyCode,
  senderHostForPartyHistory,
  staffQuoteCanTeachSenderHistory,
} from '../src/ai/hms-jobs.js';
import { CENTURION_HMS_READ_TARGET, DAVINCI_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';
import { quotePaneConfigForProperty } from '../src/hms/rate-catalogue.js';
import { mailboxHmsOriginBindLoaders } from '../src/hms/mailbox-hms-origin-bind.js';
import { paneStayLookupLoaders, type PaneStayLookupSpawnResult } from '../src/ai/pane-stay-lookup.js';
import type { PaneStayLock } from '../src/ai/pane-stay-save.js';
import {
  aiDraftGeneration,
  aiWorkflowRun,
  mailCategory,
  mailThreadCategory,
  mailboxTransport,
  message,
  mailThread,
} from '../src/db/schema/mail.js';
import { partySenderMap } from '../src/db/schema/party-sender-map.js';
import { hitlToolRun } from '../src/db/schema/hitl.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import { runHmsJobOnce } from '../src/ai/worker.js';
import { ensureWorkItemForMessage } from '../src/ai/work-items.js';
import { admitLiveMessage } from '../src/mail/ingest/live-admission.js';
import type { DB } from '../src/db/client.js';
import { parseEnv } from '../src/env.js';
import { createPropertyReadLock, PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';
import {
  CENTURION_USER_ID,
  DAVINCI_TRANSPORT_EMAIL,
  DAVINCI_TRANSPORT_ID,
  FAITH_TRANSPORT_ID,
  AYANDA_TRANSPORT_ID,
  NAVA_TRANSPORT_ID,
  TRANSPORT_EMAIL,
  TRANSPORT_ID,
} from '../src/db/seed.js';
import { openTestDbSession, probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';

const staffQuoteRunner = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/ai/staff-quote-run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/staff-quote-run.js')>()),
  runStaffQuote: staffQuoteRunner.run,
}));

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
  mailboxHmsOriginBindLoaders.loadThreadOrigin = null;
  mailboxHmsOriginBindLoaders.loadThreadOriginScan = null;
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
async function seedThread(
  db: DB,
  subject = 'Amend booking',
  transportId = TRANSPORT_ID,
  messageIdHeader: string | null = null,
): Promise<{ threadId: string; messageId: string }> {
  const threadId = `thread-${randomUUID()}`;
  const messageId = `msg-${randomUUID()}`;
  await db.insert(mailThread).values({ id: threadId, transportId, threadRootId: threadId });
  await db.insert(message).values({
    id: messageId,
    transportId,
    threadId,
    direction: 'inbound',
    fromAddress: 'guest@example.test',
    toAddresses: transportId === DAVINCI_TRANSPORT_ID ? [DAVINCI_TRANSPORT_EMAIL] : [],
    subject,
    textBody: `Please amend ${CONFIRMATION}.`,
    receivedAt: new Date(),
    messageIdHeader,
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

async function enqueuePriorityJob(
  db: DB,
  threadId: string,
  messageId: string,
  prefix: string,
  priority: number,
  createdAt: Date,
) {
  return enqueueHmsJob({
    transportId: TRANSPORT_ID,
    threadId,
    triggerMessageId: messageId,
    workItemId: null,
    userId: priority === HMS_JOB_PRIORITY_USER ? CENTURION_USER_ID : null,
    request: { kind: 'find', confirmation: CONFIRMATION, arrival: '2099-11-12' },
    priority,
    idempotencyKey: `${prefix}:${randomUUID()}`,
    createdAt,
    nextRunAt: createdAt,
  }, db);
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

function preparedInputFromRun(run: AiWorkflowRun | undefined): StaffQuoteInput {
  if (!run) throw new Error('expected a staff quote run');
  const request = run.readRequest as { input?: unknown } | null;
  return staffQuoteInput.parse(request?.input);
}

const HRCEN_PREPARED_SHOPS = 2;

function shopSalesStrategy(row: { readRequest: unknown }): string | undefined {
  return (row.readRequest as { input?: { salesStrategy?: string } } | null)?.input?.salesStrategy;
}

function barPreparedRun<T extends { readRequest: unknown }>(rows: T[]): T | undefined {
  return rows.find((row) => shopSalesStrategy(row) === 'BAR');
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

function quoteExtractionPayload(overrides: { arrival?: string | null; departure?: string | null } = {}) {
  return {
    origin: 'person',
    contact: { name: 'Alex Guest', email: 'alex@example.test', phone: null },
    agency: 'Acme Lodging Holdings',
    endClient: 'Example Client',
    confirmationNumbers: [],
    stays: [{
      id: 's_12345678',
      hotel: 'Centurion',
      requested: {
        arrival: overrides.arrival === undefined ? '2099-11-12' : overrides.arrival,
        departure: overrides.departure === undefined ? '2099-11-14' : overrides.departure,
      },
      booked: null,
      totalRooms: 2,
      rows: [{
        id: 'r_12345678',
        roomType: 'Standard King',
        rooms: 2,
        adultsPerRoom: 2,
        childAges: [],
        board: null,
      }],
    }],
    missing: [],
  };
}

const QUOTE_PREPARE_ENV = {
  HMS_JOB_QUEUE: 'on',
  HMS_QUOTE_PREPARE: 'true',
  HMS_QUOTE_PREPARE_PER_HOUR: '6',
};

async function seedQuoteExtraction(
  db: DB,
  input: { payload?: Record<string, unknown>; fromAddress?: string; spam?: boolean; channel?: boolean } = {},
) {
  const { threadId, messageId } = await seedThread(db, 'Quote request');
  if (input.fromAddress || input.channel) {
    await db.update(message).set({
      fromAddress: input.channel ? 'reservations@booking.com' : input.fromAddress!,
    }).where(eq(message.id, messageId));
  }
  if (input.spam) {
    await db.update(mailThread).set({ spamAt: new Date() }).where(eq(mailThread.id, threadId));
  }
  await insertStoredExtraction(db, messageId, 'quote', input.payload ?? quoteExtractionPayload());
  return { threadId, messageId, run: { runKind: 'inbound_extraction' as const, transportId: TRANSPORT_ID, triggerMessageId: messageId } };
}

async function seedPartyMatchV2(
  db: DB,
  input: { threadId: string; messageId: string; readResult: Record<string, unknown> },
) {
  await db.insert(aiWorkflowRun).values({
    id: randomUUID(),
    transportId: TRANSPORT_ID,
    threadId: input.threadId,
    triggerMessageId: input.messageId,
    runKind: 'read_tool',
    idempotencyKey: `hms-job:party-v2:${randomUUID()}`,
    modelId: 'not_applicable',
    promptVersion: HMS_JOB_PROMPT_VERSION,
    readRequest: { kind: 'party', name: 'Acme Lodging Holdings', matchVersion: 2 },
    readResult: input.readResult,
    executorLane: 'hms',
    priority: HMS_JOB_PRIORITY_PREFETCH,
    state: 'succeeded',
    metrics: { hmsJob: true, userId: null },
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
        input: STAFF_QUOTE_INPUT,
        shopStrategy: 'Wholesale',
      }).success,
    ).toBe(false);
    expect(
      hmsJobRequestSchema.safeParse({
        kind: 'staff_quote',
        input: { ...STAFF_QUOTE_INPUT, customerOverride: true },
      }).success,
    ).toBe(false);
  });

  it('prefetches one find for the first guest confirmation and leaves later confs on the payload', () => {
    const payload = {
      confirmationNumbers: ['2222222-2'],
      stays: [
        {
          guests: [{ name: 'Ada Example', confirmationNumber: '1111111-1' }],
          booked: { arrival: '2026-11-12' },
        },
        {
          guests: [{ name: 'Bea Example', confirmationNumber: '3333333-3' }],
          booked: { arrival: '2026-12-01' },
        },
      ],
    };
    expect(
      selectHmsBatchRequest({
        kind: 'amendment',
        payload,
        subject: 'Two stays',
        textBody: null,
      }),
    ).toEqual({ request: { kind: 'find', confirmation: '1111111-1' } });
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
    expect(
      extractUniqueArrivalForHmsPrefetch('amendment', {
        stays: [{ requested: { arrival: '2026-12-01' }, booked: null }],
      }),
    ).toBeNull();
    expect(
      extractUniqueArrivalForHmsPrefetch('cancellation', {
        stays: [{ requested: { arrival: '2026-12-01' }, booked: { arrival: null } }],
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
    expect(
      confirmationPrefetchIdempotencyKey(TRANSPORT_ID, CONFIRMATION, '2026-10-13', 'HRCEN'),
    ).not.toBe(
      confirmationPrefetchIdempotencyKey(TRANSPORT_ID, CONFIRMATION, '2026-10-13', 'HRDAV'),
    );
  });

  it('turns the job queue on only for HMS_JOB_QUEUE=on', () => {
    expect(hmsJobQueueEnabled({})).toBe(false);
    expect(hmsJobQueueEnabled({ HMS_JOB_QUEUE: '1' })).toBe(false);
    expect(hmsJobQueueEnabled({ HMS_JOB_QUEUE: 'off' })).toBe(false);
    expect(hmsJobQueueEnabled({ HMS_JOB_QUEUE: 'on' })).toBe(true);
  });

  it('keeps quote preparation disabled unless both queue and feature flag are enabled', async () => {
    expect(hmsJobs.quotePreparationEnabled({ HMS_JOB_QUEUE: 'on' })).toBe(false);
    expect(hmsJobs.quotePreparationEnabled({ HMS_JOB_QUEUE: 'off', HMS_QUOTE_PREPARE: 'true' })).toBe(false);
    expect(hmsJobs.quotePreparationEnabled({ HMS_JOB_QUEUE: 'on', HMS_QUOTE_PREPARE: 'true' })).toBe(true);
    await expect(
      prefetchQuoteReadyForExtraction(
        { runKind: 'inbound_extraction', transportId: TRANSPORT_ID, triggerMessageId: 'msg-off' },
        {} as DB,
        { HMS_JOB_QUEUE: 'on', HMS_QUOTE_PREPARE: 'false' },
      ),
    ).resolves.toBe(0);
  });

  it.each(['true', '1', 'on'])('enables quote preparation for HMS_QUOTE_PREPARE=%s', (value) => {
    expect(
      hmsJobs.quotePreparationEnabled({ HMS_JOB_QUEUE: 'on', HMS_QUOTE_PREPARE: value }),
    ).toBe(true);
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

describe('party sender history policy', () => {
  const triggerMail = {
    direction: 'inbound' as const,
    fromAddress: 'agent@trigger.example.test',
    subject: 'Quote request',
    textBody: 'Please send a quote for these dates.',
    htmlBody: null,
  };

  it('uses direct external trigger sender, not an earlier sender in its thread', () => {
    expect(
      senderHostForPartyHistory({
        trigger: triggerMail,
        inbound: [{ ...triggerMail, fromAddress: 'agent@earlier.example.test' }],
      }),
    ).toBe('trigger.example.test');
  });

  it('falls back to earliest direct inbound only when trigger is not inbound', () => {
    expect(
      senderHostForPartyHistory({
        trigger: { ...triggerMail, direction: 'outbound' },
        inbound: [
          { ...triggerMail, fromAddress: 'agent@earlier.example.test' },
          { ...triggerMail, fromAddress: 'agent@later.example.test' },
        ],
      }),
    ).toBe('earlier.example.test');
  });

  it('does not fall back when inbound trigger is internal or non-direct', () => {
    expect(
      senderHostForPartyHistory({
        trigger: { ...triggerMail, fromAddress: 'staff@legacyhotel.com' },
        inbound: [triggerMail],
      }),
    ).toBeNull();
  });

  it('scopes sender history to the resolved hotel', () => {
    expect(partyHistoryPropertyCode(CENTURION_HMS_READ_TARGET)).toBe('HRCEN');
    expect(partyHistoryPropertyCode(DAVINCI_HMS_READ_TARGET)).toBe('HRDAV');
    expect(partyHistoryPropertyCode(null)).toBeNull();
    expect(partyHistoryPropertyCode(null, TRANSPORT_ID)).toBe('HRCEN');
    expect(partyHistoryPropertyCode(null, DAVINCI_TRANSPORT_ID)).toBe('HRDAV');
    expect(partyHistoryPropertyCode(null, 'transport-1')).toBeNull();
  });

  it('learns from staff-initiated quotes only', () => {
    expect(staffQuoteCanTeachSenderHistory(true, false)).toBe(true);
    expect(staffQuoteCanTeachSenderHistory(false, false)).toBe(false);
    expect(staffQuoteCanTeachSenderHistory(true, true)).toBe(false);
  });

  type SenderObservation = {
    kind: 'company' | 'agency';
    name: string;
    nativeId: string;
    iata: string | null;
  };
  const selectSenderPartyForHost = (hmsJobs as unknown as {
    selectSenderPartyForHost?: (host: string, parties: SenderObservation[]) => SenderObservation | null;
  }).selectSenderPartyForHost;
  const agency = {
    kind: 'agency' as const,
    name: 'XL Nexus',
    nativeId: 'agency-1',
    iata: null,
  };
  const company = {
    kind: 'company' as const,
    name: 'Momentum Metropolitan Holdings',
    nativeId: 'company-1',
    iata: null,
  };

  it.each([
    { host: 'nexustravel.example', expected: agency },
    { host: 'momentum.example', expected: company },
    { host: 'guest.example', expected: null },
  ])('selects only party matching sender-host tokens: $host', ({ host, expected }) => {
    expect(selectSenderPartyForHost).toBeTypeOf('function');
    if (!selectSenderPartyForHost) return;
    expect(selectSenderPartyForHost(host, [agency, company])).toEqual(expected);
  });

  it('ignores generic tokens and rejects hosts matching both parties', () => {
    expect(selectSenderPartyForHost).toBeTypeOf('function');
    if (!selectSenderPartyForHost) return;
    expect(selectSenderPartyForHost('guest.example', [agency])).toEqual(agency);
    expect(
      selectSenderPartyForHost('travel.example', [
        { ...agency, name: 'Travel Guides' },
        { ...company, name: 'Momentum Holdings' },
      ]),
    ).toBeNull();
    expect(
      selectSenderPartyForHost('travelgroup.example', [
        { ...agency, name: 'Travel Group' },
        { ...company, name: 'Group Holdings' },
      ]),
    ).toBeNull();
    expect(
      selectSenderPartyForHost('sharedtravel.example', [
        { ...agency, name: 'Shared Travel' },
        { ...company, name: 'Shared Holdings' },
      ]),
    ).toBeNull();
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
    const davinciIds = new Set([DAVINCI_TRANSPORT_ID, FAITH_TRANSPORT_ID, AYANDA_TRANSPORT_ID]);
    mailboxHmsOriginBindLoaders.loadThreadOriginScan = async (input) => {
      const toAddresses = davinciIds.has(input.transportId)
        ? [DAVINCI_TRANSPORT_EMAIL]
        : [TRANSPORT_EMAIL];
      return {
        selected: { toAddresses },
        selectedFound: true,
        inbounds: [{ toAddresses }],
      };
    };
  });

  it.each([
    ['prefetch', HMS_JOB_PRIORITY_PREFETCH],
    ['dev', HMS_JOB_PRIORITY_DEV],
  ] as const)('prepares and reuses one future quote at %s priority', (_tier, priority) =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      const { threadId, messageId, run } = await seedQuoteExtraction(db);

      expect(await prefetchQuoteReadyForExtraction(run, db, QUOTE_PREPARE_ENV, undefined, priority)).toBe(
        HRCEN_PREPARED_SHOPS,
      );
      expect(await prefetchQuoteReadyForExtraction(run, db, QUOTE_PREPARE_ENV)).toBe(0);
      const preparedRows = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.triggerMessageId, messageId));
      expect(preparedRows).toHaveLength(HRCEN_PREPARED_SHOPS);
      expect(preparedRows.map(shopSalesStrategy).sort()).toEqual(['BAR', 'Government']);
      const prepared = barPreparedRun(preparedRows);
      expect(prepared).toMatchObject({
        runKind: 'read_tool',
        state: 'queued',
        priority,
        readRequest: {
          kind: 'staff_quote',
          input: {
            messageId,
            salesStrategy: 'BAR',
            groups: [{ arrivalDate: '2099-11-12', departureDate: '2099-11-14', quantity: 2, adults: 2, board: 'bb' }],
          },
        },
        metrics: { userId: null, quotePrepared: true },
      });
      expect(prepared?.idempotencyKey).toMatch(new RegExp(`^hms-job:staff-quote-prepared:${TRANSPORT_ID}:${messageId}:[a-f0-9]{64}$`));

      const paneInput = staffQuoteInput.parse({
        ...preparedInputFromRun(prepared),
        selectionEpoch: 51,
        inputRevision: 90,
      });
      const reused = await hmsJobs.queueAutoStaffQuoteHmsJob({
        ...autoStaffQuoteRequest(threadId, messageId),
        request: { kind: 'staff_quote', input: paneInput },
      }, db);
      if (priority === HMS_JOB_PRIORITY_PREFETCH) {
        expect(reused).toMatchObject({ created: false, run: { id: prepared?.id } });
        expect(reused.run.priority).toBe(priority);
      } else {
        // A queued dev price is not adopted; staff get their own read at staff priority.
        expect(reused.created).toBe(true);
        expect(reused.run.id).not.toBe(prepared?.id);
        expect(reused.run.priority).toBe(HMS_JOB_PRIORITY_USER);
      }
    }));

  it('keeps a shared prepared quote read-back bound to its original message', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      const messageIdHeader = 'u5-shared-readback@example.test';
      const source = await seedThread(db, 'Quote request', DAVINCI_TRANSPORT_ID, messageIdHeader);
      const copy = await seedThread(db, 'Quote request', FAITH_TRANSPORT_ID, messageIdHeader);
      const input = staffQuoteInput.parse({ ...STAFF_QUOTE_INPUT, messageId: source.messageId });
      const { run } = await enqueueHmsJob({
        transportId: DAVINCI_TRANSPORT_ID,
        threadId: source.threadId,
        triggerMessageId: source.messageId,
        workItemId: null,
        userId: null,
        request: { kind: 'staff_quote', input },
        priority: HMS_JOB_PRIORITY_PREFETCH,
        idempotencyKey: `hms-job:test-prepared-readback:${randomUUID()}`,
        extraMetrics: { quotePrepared: true },
      }, db);
      const asOf = new Date();
      await db.update(aiWorkflowRun).set({
        state: 'succeeded',
        readResult: {
          kind: 'staff_quote',
          status: 'ready',
          messageId: source.messageId,
          asOf: asOf.toISOString(),
        },
        finishedAt: asOf,
        readResultExpiresAt: new Date(asOf.getTime() + 15 * 60_000),
      }).where(eq(aiWorkflowRun.id, run.id));

      const view = await readHmsJobView({
        transportId: FAITH_TRANSPORT_ID,
        userId: CENTURION_USER_ID,
        messageId: copy.messageId,
        kind: 'staff_quote',
        input: staffQuoteInput.parse({ ...input, messageId: copy.messageId }),
      }, db);

      expect(view).toMatchObject({
        runId: run.id,
        sourceMessageId: source.messageId,
        result: { messageId: source.messageId },
      });
    }));

  it('enqueues one primary shop per stay under the default hour cap', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      const first = quoteExtractionPayload();
      const stay = first.stays[0]!;
      const { messageId, run } = await seedQuoteExtraction(db, {
        payload: {
          ...first,
          stays: [
            stay,
            {
              ...stay,
              id: 's_87654321',
              requested: { arrival: '2099-12-12', departure: '2099-12-14' },
              rows: [{ ...stay.rows[0]!, id: 'r_87654321' }],
            },
          ],
        },
      });

      expect(await prefetchQuoteReadyForExtraction(run, db, QUOTE_PREPARE_ENV)).toBe(4);
      const rows = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.triggerMessageId, messageId));
      expect(rows).toHaveLength(4);
      expect(rows.filter((row) => shopSalesStrategy(row) === 'BAR')).toHaveLength(2);
      expect(rows.filter((row) => shopSalesStrategy(row) === 'Government')).toHaveLength(2);
      expect(
        new Set(
          rows.map(
            (row) =>
              (row.readRequest as { input?: { groups?: Array<{ arrivalDate?: string }> } }).input
                ?.groups?.[0]?.arrivalDate,
          ),
        ),
      ).toEqual(new Set(['2099-11-12', '2099-12-12']));
    }));

  it('shops HRCEN BAR and Government per stay', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      const bar = await seedQuoteExtraction(db);
      expect(await prefetchQuoteReadyForExtraction(bar.run, db, QUOTE_PREPARE_ENV)).toBe(HRCEN_PREPARED_SHOPS);
      const barJobs = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.triggerMessageId, bar.messageId));
      expect(barJobs.map(shopSalesStrategy).sort()).toEqual(['BAR', 'Government']);

      const barPayload = quoteExtractionPayload();
      const government = await seedQuoteExtraction(db, {
        payload: {
          ...barPayload,
          stays: barPayload.stays.map((stay) => ({
            ...stay,
            rows: stay.rows.map((row) => ({ ...row, board: 'dbb' })),
          })),
        },
      });
      expect(await prefetchQuoteReadyForExtraction(government.run, db, QUOTE_PREPARE_ENV)).toBe(
        HRCEN_PREPARED_SHOPS,
      );
      const govJobs = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.triggerMessageId, government.messageId));
      expect(govJobs.map(shopSalesStrategy).sort()).toEqual(['BAR', 'Government']);
    }));

  it('keeps each stay primary under the default hour cap before extra strategies', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      const quoteEnv = {
        ...QUOTE_PREPARE_ENV,
        HMS_DAVINCI_MAKE_QUOTE: 'on',
        RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV: '/tmp/hrdav-quote.json',
      };
      const first = quoteExtractionPayload();
      const stay = first.stays[0]!;
      const source = await seedThread(db, 'Quote request', DAVINCI_TRANSPORT_ID);
      await insertStoredExtraction(db, source.messageId, 'quote', {
        ...first,
        stays: [
          stay,
          {
            ...stay,
            id: 's_87654321',
            requested: { arrival: '2099-12-12', departure: '2099-12-14' },
            rows: [{ ...stay.rows[0]!, id: 'r_87654321' }],
          },
        ],
      });
      const run = {
        runKind: 'inbound_extraction' as const,
        transportId: DAVINCI_TRANSPORT_ID,
        triggerMessageId: source.messageId,
      };
      expect(await prefetchQuoteReadyForExtraction(run, db, quoteEnv)).toBe(6);
      const rows = await db
        .select()
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.triggerMessageId, source.messageId),
            sql`${aiWorkflowRun.readRequest}->>'kind' = 'staff_quote'`,
          ),
        );
      expect(rows).toHaveLength(6);
      expect(
        new Set(
          rows
            .filter((row) => shopSalesStrategy(row) === 'BAR')
            .map(
              (row) =>
                (row.readRequest as { input?: { groups?: Array<{ arrivalDate?: string }> } }).input
                  ?.groups?.[0]?.arrivalDate,
            ),
        ),
      ).toEqual(new Set(['2099-11-12', '2099-12-12']));
    }));

  it('does not reuse a queued dev-eval quote for a later staff quote', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      const { threadId, messageId } = await seedThread(db);
      const request = autoStaffQuoteRequest(threadId, messageId);
      const dev = await hmsJobs.queueAutoStaffQuoteHmsJob({
        ...request,
        priority: HMS_JOB_PRIORITY_DEV,
        extraMetrics: { ...request.extraMetrics, devEval: true },
      }, db);
      const staff = await hmsJobs.queueAutoStaffQuoteHmsJob(request, db);

      expect(dev.run.priority).toBe(HMS_JOB_PRIORITY_DEV);
      expect(staff).toMatchObject({ created: true, run: { priority: HMS_JOB_PRIORITY_USER } });
      expect(staff.run.id).not.toBe(dev.run.id);
    }));

  it('claims staff, prefill, dev, and refresh tiers in descending priority order', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_DEV_GATE', 'off');
      const { threadId, messageId } = await seedThread(db);
      const now = new Date('2099-05-10T10:00:00Z');
      const createdAt = new Date('2099-05-10T09:59:00Z');
      for (const [tier, priority] of [
        ['staff', HMS_JOB_PRIORITY_USER],
        ['prefill', HMS_JOB_PRIORITY_PREFETCH],
        ['dev', HMS_JOB_PRIORITY_DEV],
        ['refresh', HMS_JOB_PRIORITY_REFRESH],
      ] as const) {
        await enqueuePriorityJob(db, threadId, messageId, `priority-${tier}`, priority, createdAt);
      }
      const claimed: number[] = [];
      for (let index = 0; index < 4; index++) {
        const run = await claimNextAiRun({
          ownerId: LANE_OWNER,
          lane: 'hms',
          runKind: 'read_tool',
          promptVersion: HMS_JOB_PROMPT_VERSION,
          db,
          now,
        });
        if (run) claimed.push(run.priority);
      }
      expect(claimed).toEqual([
        HMS_JOB_PRIORITY_USER,
        HMS_JOB_PRIORITY_PREFETCH,
        HMS_JOB_PRIORITY_DEV,
        HMS_JOB_PRIORITY_REFRESH,
      ]);
    }));

  it.each([
    ['prefill queued during staff hours', new Date('2099-05-10T10:00:00Z'), true, 'on', false],
    ['no higher tier queued during staff hours', new Date('2099-05-10T10:00:00Z'), false, 'on', true],
    ['outside staff hours', new Date('2099-05-10T16:00:00Z'), true, 'on', true],
    ['gate disabled', new Date('2099-05-10T10:00:00Z'), true, 'off', true],
  ] as const)('dev gate: %s', async (_case, now, queuePrefill, gate, shouldClaim) =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_DEV_GATE', gate);
      vi.stubEnv('HMS_DEV_GATE_START_HOUR_UTC', '5');
      vi.stubEnv('HMS_DEV_GATE_END_HOUR_UTC', '16');
      const { threadId, messageId } = await seedThread(db);
      const prefix = `dev-gate-${randomUUID()}`;
      const createdAt = new Date(now.getTime() - 60_000);
      if (queuePrefill) {
        await enqueuePriorityJob(
          db,
          threadId,
          messageId,
          `${prefix}:prefill`,
          HMS_JOB_PRIORITY_PREFETCH,
          createdAt,
        );
      }
      await enqueuePriorityJob(db, threadId, messageId, `${prefix}:dev`, HMS_JOB_PRIORITY_DEV, createdAt);
      const claimed = await claimNextAiRun({
        ownerId: LANE_OWNER,
        lane: 'hms',
        runKind: 'read_tool',
        promptVersion: HMS_JOB_PROMPT_VERSION,
        idempotencyPrefix: `${prefix}:dev`,
        db,
        now,
      });
      expect(Boolean(claimed)).toBe(shouldClaim);
      if (claimed) expect(claimed.priority).toBe(HMS_JOB_PRIORITY_DEV);
    }));

  it('claims a prepared quote with the staff quote read budget', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_RUN_DEADLINE_MS', '150000');
      const { run } = await seedQuoteExtraction(db);
      expect(await prefetchQuoteReadyForExtraction(run, db, QUOTE_PREPARE_ENV)).toBe(HRCEN_PREPARED_SHOPS);
      const now = new Date();

      const claimed = await claimNextAiRun({
        ownerId: LANE_OWNER,
        lane: 'hms',
        runKind: 'read_tool',
        promptVersion: HMS_JOB_PROMPT_VERSION,
        db,
        now,
      });

      expect(claimed?.deadlineAt?.getTime()).toBe(now.getTime() + 7 * 60_000);
    }));

  it('retries a dead-lettered shared prepared quote from its stored identity', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const messageIdHeader = 'u5-quote-retry@example.test';
      const quoteEnv = {
        ...QUOTE_PREPARE_ENV,
        HMS_DAVINCI_MAKE_QUOTE: 'on',
        HMS_QUOTE_PREPARE_PER_HOUR: '20',
        RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV: '/tmp/hrdav-quote.json',
      };
      const hrdavShops = (await quotePaneConfigForProperty('HRDAV', DAVINCI_TRANSPORT_ID))?.salesStrategies.length ?? 0;
      const firstCopy = await seedThread(db, 'Quote request', DAVINCI_TRANSPORT_ID, messageIdHeader);
      const secondCopy = await seedThread(db, 'Quote request', FAITH_TRANSPORT_ID, messageIdHeader);
      await insertStoredExtraction(db, firstCopy.messageId, 'quote', quoteExtractionPayload());
      await insertStoredExtraction(db, secondCopy.messageId, 'quote', quoteExtractionPayload());
      const firstExtraction = {
        runKind: 'inbound_extraction' as const,
        transportId: DAVINCI_TRANSPORT_ID,
        triggerMessageId: firstCopy.messageId,
      };
      const secondExtraction = {
        runKind: 'inbound_extraction' as const,
        transportId: FAITH_TRANSPORT_ID,
        triggerMessageId: secondCopy.messageId,
      };

      expect(await prefetchQuoteReadyForExtraction(firstExtraction, db, quoteEnv)).toBe(hrdavShops);
      const firstJobs = await db
        .select()
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.triggerMessageId, firstCopy.messageId),
            sql`${aiWorkflowRun.readRequest}->>'kind' = 'staff_quote'`,
          ),
        );
      const first = barPreparedRun(firstJobs) ?? firstJobs[0];
      expect(first?.idempotencyKey).toMatch(/^hms-job:mail:HRDAV:/);
      await db
        .update(aiWorkflowRun)
        .set({ state: 'dead_letter', finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(aiWorkflowRun.id, first!.id));

      expect(await prefetchQuoteReadyForExtraction(secondExtraction, db, quoteEnv)).toBe(1);
      const retries = await db
        .select({ triggerMessageId: aiWorkflowRun.triggerMessageId, idempotencyKey: aiWorkflowRun.idempotencyKey })
        .from(aiWorkflowRun)
        .where(
          and(
            inArray(aiWorkflowRun.triggerMessageId, [firstCopy.messageId, secondCopy.messageId]),
            sql`${aiWorkflowRun.readRequest}->>'kind' = 'staff_quote'`,
          ),
        );
      expect(retries).toHaveLength(hrdavShops + 1);
      expect(
        retries.find((retry) => retry.triggerMessageId === secondCopy.messageId)?.idempotencyKey,
      ).toMatch(new RegExp(`^${first!.idempotencyKey}:retry:`));
    }));

  it('yields a prepared quote without charging it while a user quote is queued', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      const { threadId, messageId, run } = await seedQuoteExtraction(db);
      expect(await prefetchQuoteReadyForExtraction(run, db, QUOTE_PREPARE_ENV)).toBe(HRCEN_PREPARED_SHOPS);
      const prepared = await claimJob(db);
      await enqueueStaffQuoteJob(db, threadId, messageId);

      await expect(runClaimedJob(db, prepared)).resolves.toBe('retry_wait');

      const [yielded] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, prepared.id));
      expect(yielded).toMatchObject({
        state: 'retry_wait',
        attempts: 0,
        failureClass: 'STAFF_QUOTE_ACTIVE',
        lastError: 'staff quote in flight',
      });
      expect(staffQuoteRunner.run).not.toHaveBeenCalled();
    }));

  it.each(['dead_letter', 'superseded'] as const)(
    'starts a user quote instead of reusing a prepared %s run',
    (state) => withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      const { threadId, messageId, run } = await seedQuoteExtraction(db);
      expect(await prefetchQuoteReadyForExtraction(run, db, QUOTE_PREPARE_ENV)).toBe(HRCEN_PREPARED_SHOPS);
      const [prepared] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.triggerMessageId, messageId));
      await db.update(aiWorkflowRun).set({ state, finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(aiWorkflowRun.id, prepared!.id));

      const input = staffQuoteInput.parse({
        ...preparedInputFromRun(prepared),
        selectionEpoch: 99,
        inputRevision: 100,
      });
      const started = await hmsJobs.queueAutoStaffQuoteHmsJob({
        ...autoStaffQuoteRequest(threadId, messageId),
        request: { kind: 'staff_quote', input },
      }, db);

      expect(started).toMatchObject({ created: true, run: { priority: HMS_JOB_PRIORITY_USER } });
      expect(started.run.id).not.toBe(prepared!.id);
    }),
  );

  it('starts a user quote instead of reusing a prepared run when quote preparation is disabled', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      const { threadId, messageId, run } = await seedQuoteExtraction(db);
      expect(await prefetchQuoteReadyForExtraction(run, db, QUOTE_PREPARE_ENV)).toBe(HRCEN_PREPARED_SHOPS);
      const [prepared] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.triggerMessageId, messageId));
      const input = staffQuoteInput.parse({
        ...preparedInputFromRun(prepared),
        selectionEpoch: 99,
        inputRevision: 100,
      });
      vi.stubEnv('HMS_QUOTE_PREPARE', 'false');

      const started = await hmsJobs.queueAutoStaffQuoteHmsJob({
        ...autoStaffQuoteRequest(threadId, messageId),
        request: { kind: 'staff_quote', input },
      }, db);

      expect(started).toMatchObject({ created: true, run: { priority: HMS_JOB_PRIORITY_USER } });
      expect(started.run.id).not.toBe(prepared!.id);
    }));

  it('starts a user quote when the pane changes a prepared price field', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      const { threadId, messageId, run } = await seedQuoteExtraction(db);
      expect(await prefetchQuoteReadyForExtraction(run, db, QUOTE_PREPARE_ENV)).toBe(HRCEN_PREPARED_SHOPS);
      const [prepared] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.triggerMessageId, messageId));
      const input = preparedInputFromRun(prepared);
      const differentPrice = staffQuoteInput.parse({
        ...input,
        groups: input.groups.map((group) => ({ ...group, quantity: group.quantity + 1 })),
      });

      const queued = await hmsJobs.queueAutoStaffQuoteHmsJob({
        ...autoStaffQuoteRequest(threadId, messageId),
        request: { kind: 'staff_quote', input: differentPrice },
      }, db);

      expect(queued.created).toBe(true);
      expect(queued.run.id).not.toBe(prepared?.id);
      expect(queued.run.priority).toBe(HMS_JOB_PRIORITY_USER);
      expect(queued.run.metrics).toMatchObject({ userId: CENTURION_USER_ID });
    }));

  it('starts a user quote when a newer staff approval makes the prepared price unexportable', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      const { threadId, messageId, run } = await seedQuoteExtraction(db);
      expect(await prefetchQuoteReadyForExtraction(run, db, QUOTE_PREPARE_ENV)).toBe(HRCEN_PREPARED_SHOPS);
      const [prepared] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.triggerMessageId, messageId));
      await db.insert(aiDraftGeneration).values({
        id: randomUUID(),
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: CENTURION_USER_ID,
        contextMessageIds: [messageId],
        model: 'staff-approved-native',
        promptVersion: 'staff-quote-v1',
        createdAt: new Date(prepared!.createdAt.getTime() + 1_000),
      });

      const started = await hmsJobs.queueAutoStaffQuoteHmsJob({
        ...autoStaffQuoteRequest(threadId, messageId),
        request: { kind: 'staff_quote', input: preparedInputFromRun(prepared) },
      }, db);

      expect(started).toMatchObject({ created: true, run: { priority: HMS_JOB_PRIORITY_USER } });
      expect(started.run.id).not.toBe(prepared!.id);
    }));

  it('does not reuse a prepared result from a changed source message', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      const { threadId, messageId, run } = await seedQuoteExtraction(db);
      expect(await prefetchQuoteReadyForExtraction(run, db, QUOTE_PREPARE_ENV)).toBe(HRCEN_PREPARED_SHOPS);
      const [prepared] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.triggerMessageId, messageId));
      const input = preparedInputFromRun(prepared);
      const changedSource = staffQuoteInput.parse({ ...input, sourceHash: 'e'.repeat(64) });

      const queued = await hmsJobs.queueAutoStaffQuoteHmsJob({
        ...autoStaffQuoteRequest(threadId, messageId),
        request: { kind: 'staff_quote', input: changedSource },
      }, db);

      expect(queued.created).toBe(true);
      expect(queued.run.id).not.toBe(prepared?.id);
      expect(queued.run.priority).toBe(HMS_JOB_PRIORITY_USER);
    }));

  it.each([
    ['past dates', { payload: quoteExtractionPayload({ arrival: '2020-11-12', departure: '2020-11-14' }) }],
    ['missing dates', { payload: quoteExtractionPayload({ arrival: null, departure: null }) }],
    ['spam', { spam: true }],
    ['channel sender', { channel: true }],
    ['no_action', { payload: { ...quoteExtractionPayload(), action: 'no_action', needsAction: false } }],
  ] as const)('does not prepare quote extraction with %s', (_reason, fixture) =>
    withSeededTestDb(async (db) => {
      const { messageId, run } = await seedQuoteExtraction(db, fixture);

      expect(await prefetchQuoteReadyForExtraction(run, db, QUOTE_PREPARE_ENV)).toBe(0);
      const rows = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.triggerMessageId, messageId));
      expect(rows).toEqual([]);
    }));

  it('records an early quote-prepare skip under lock without PII', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId, run } = await seedQuoteExtraction(db, { spam: true });
      const extraction = await insertInboundExtraction(db, threadId, messageId);
      expect(
        await prefetchQuoteReadyForExtraction({ ...run, id: extraction.id }, db, QUOTE_PREPARE_ENV),
      ).toBe(0);
      const [source] = await db
        .select({ metrics: aiWorkflowRun.metrics })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.id, extraction.id));
      const decisions = (source?.metrics as { quotePrepareDecisions?: unknown } | null)?.quotePrepareDecisions;
      expect(decisions).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'spam' })]);
      const blob = JSON.stringify(source?.metrics);
      expect(blob).not.toMatch(/Alex Guest/);
      expect(blob).not.toMatch(/alex@example\.test/i);
      expect(blob).not.toMatch(/guest@example\.test/i);
      const prepared = await db
        .select({ id: aiWorkflowRun.id })
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.triggerMessageId, messageId),
            sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`,
          ),
        );
      expect(prepared).toEqual([]);
    }));

  it('does not prepare when the quote request is missing required room occupancy', () =>
    withSeededTestDb(async (db) => {
      const payload = quoteExtractionPayload() as ReturnType<typeof quoteExtractionPayload>;
      payload.stays[0]!.rows[0]!.adultsPerRoom = null as unknown as number;
      const { messageId, run } = await seedQuoteExtraction(db, { payload });

      expect(await prefetchQuoteReadyForExtraction(run, db, QUOTE_PREPARE_ENV)).toBe(0);
      expect(await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.triggerMessageId, messageId))).toEqual([]);
    }));

  it('carries a party only for a confident V2 bound result; unbound and ambiguous results stay public BAR', () =>
    withSeededTestDb(async (db) => {
      const party = { kind: 'agency', nativeId: 'agency-43', name: 'Acme Lodging Holdings' };
      const cases = [
        {
          name: 'bound',
          result: {
            matchVersion: 2,
            matchStatus: 'bound',
            boundParty: party,
            results: [party],
            confidence: 'high',
            pickSource: 'fallback',
            truncated: false,
          },
          partyBound: true,
        },
        {
          name: 'unbound',
          result: {
            matchVersion: 2,
            matchStatus: 'needs_pick',
            boundParty: null,
            results: [],
            confidence: 'low',
            pickSource: 'fallback',
            truncated: false,
          },
          partyBound: false,
        },
        {
          name: 'ambiguous',
          result: {
            matchVersion: 2,
            matchStatus: 'needs_pick',
            boundParty: null,
            results: [party, { ...party, nativeId: 'agency-44' }],
            confidence: 'medium',
            pickSource: 'llm',
            truncated: false,
          },
          partyBound: false,
        },
      ];

      for (const fixture of cases) {
        const { threadId, messageId, run } = await seedQuoteExtraction(db);
        await seedPartyMatchV2(db, { threadId, messageId, readResult: fixture.result });
        expect(await prefetchQuoteReadyForExtraction(run, db, QUOTE_PREPARE_ENV)).toBe(HRCEN_PREPARED_SHOPS);
        const preparedRows = await db
          .select()
          .from(aiWorkflowRun)
          .where(
            and(
              eq(aiWorkflowRun.triggerMessageId, messageId),
              sql`${aiWorkflowRun.readRequest}->>'kind' = 'staff_quote'`,
            ),
          );
        expect(preparedRows).toHaveLength(HRCEN_PREPARED_SHOPS);
        for (const prepared of preparedRows) {
          expect(prepared.readRequest).toMatchObject({ kind: 'staff_quote' });
          const request = prepared.readRequest as { input?: StaffQuoteInput } | undefined;
          expect(request?.input).toBeDefined();
          expect(Boolean(request?.input?.parties)).toBe(fixture.partyBound);
          if (fixture.partyBound) expect(request?.input?.parties).toEqual({ agency: party });
          else expect(request?.input?.parties).toBeUndefined();
        }
      }
    }));

  it('defers cap overflow with nextRunAt and later runs once without duplicate enqueue', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      vi.stubEnv('HMS_QUOTE_PREPARE_PER_HOUR', '1');
      const env = { ...QUOTE_PREPARE_ENV, HMS_QUOTE_PREPARE_PER_HOUR: '1' };
      const first = await seedQuoteExtraction(db);
      const second = await seedQuoteExtraction(db);
      const seedInbound = async (seeded: typeof second) => {
        const [run] = await db
          .insert(aiWorkflowRun)
          .values({
            id: randomUUID(),
            transportId: TRANSPORT_ID,
            threadId: seeded.threadId,
            triggerMessageId: seeded.messageId,
            runKind: 'inbound_extraction',
            idempotencyKey: `inbound-extraction:${seeded.messageId}`,
            modelId: 'not_applicable',
            promptVersion: 'triage-v6',
            admissionSnapshotId: `snapshot-${randomUUID()}`,
            state: 'succeeded',
            executorLane: 'default',
            priority: 0,
            metrics: { keep: true },
          })
          .returning();
        if (!run) throw new Error('inbound extraction seed failed');
        return run;
      };
      await seedInbound(first);
      await seedInbound(second);

      expect(await prefetchQuoteReadyForExtraction(first.run, db, env)).toBeGreaterThanOrEqual(1);
      const overflowed = await prefetchQuoteReadyForExtraction(second.run, db, env);
      expect(overflowed).toBeGreaterThanOrEqual(1);
      const secondRows = await db
        .select()
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.triggerMessageId, second.messageId),
            sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`,
          ),
        );
      expect(secondRows.some((row) => row.nextRunAt && row.nextRunAt.getTime() > Date.now())).toBe(true);
      expect(await prefetchQuoteReadyForExtraction(second.run, db, env)).toBe(0);
      expect(
        await db
          .select({ id: aiWorkflowRun.id })
          .from(aiWorkflowRun)
          .where(
            and(
              eq(aiWorkflowRun.triggerMessageId, second.messageId),
              sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`,
            ),
          ),
      ).toHaveLength(secondRows.length);

      const aged = new Date(Date.now() - 2 * 60 * 60_000);
      await db
        .update(aiWorkflowRun)
        .set({ state: 'succeeded', createdAt: aged, finishedAt: aged, nextRunAt: null, updatedAt: aged })
        .where(
          and(
            eq(aiWorkflowRun.triggerMessageId, first.messageId),
            sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`,
          ),
        );
      const deferred = secondRows.filter(
        (row) => (row.metrics as { prefetchDeferred?: boolean } | null)?.prefetchDeferred === true,
      );
      expect(deferred.length).toBeGreaterThanOrEqual(1);
      const [target, ...siblings] = deferred;
      const later = new Date(Date.now() + 60 * 60_000);
      for (const job of siblings) {
        await db.update(aiWorkflowRun).set({ createdAt: aged, nextRunAt: later, updatedAt: aged }).where(eq(aiWorkflowRun.id, job.id));
      }
      await db.update(aiWorkflowRun).set({ nextRunAt: new Date(), updatedAt: new Date() }).where(eq(aiWorkflowRun.id, target!.id));

      vi.stubEnv('HITL_LEDGER', 'on');
      staffQuoteRunner.run.mockImplementation(async (...args: unknown[]) => {
        const transaction = args[2] as DB;
        const options = args[3] as {
          commitQueuedResult?: (result: Record<string, unknown>, transaction: DB) => Promise<boolean>;
        };
        const quoteResult = {
          status: 'ready',
          workflowRunId: target!.id,
          revisionRef: 'overflow-1',
          messageId: second.messageId,
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
      const claimed = await claimJob(db);
      expect(claimed.id).toBe(target!.id);
      expect(await runClaimedJob(db, claimed)).toBe('succeeded');
      expect(staffQuoteRunner.run).toHaveBeenCalledTimes(1);
      expect(await prefetchQuoteReadyForExtraction(second.run, db, env)).toBe(0);
    }));

  it.each(['dead_letter', 'superseded'] as const)(
    'does not retry a prepared %s run while the hourly cap is full',
    (state) => withSeededTestDb(async (db) => {
      const env = { ...QUOTE_PREPARE_ENV, HMS_QUOTE_PREPARE_PER_HOUR: '1' };
      const { messageId, run } = await seedQuoteExtraction(db);
      expect(await prefetchQuoteReadyForExtraction(run, db, env)).toBeGreaterThanOrEqual(1);
      const prepared = await db
        .select()
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.triggerMessageId, messageId),
            sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`,
          ),
        );
      expect(prepared.length).toBeGreaterThanOrEqual(1);
      await db
        .update(aiWorkflowRun)
        .set({ state, finishedAt: new Date(), updatedAt: new Date() })
        .where(
          inArray(
            aiWorkflowRun.id,
            prepared.map((row) => row.id),
          ),
        );

      expect(await prefetchQuoteReadyForExtraction(run, db, env)).toBe(0);
      const after = await db
        .select()
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.triggerMessageId, messageId),
            sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`,
          ),
        );
      expect(after).toHaveLength(prepared.length);
      expect(after.map((row) => row.id).sort()).toEqual(prepared.map((row) => row.id).sort());
    }),
  );

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

  it('auto-start reuses a 3 h-old priced result and enqueues after 25 h', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000);
      await db.update(aiWorkflowRun).set({
        state: 'succeeded',
        readResult: {
          kind: 'staff_quote',
          status: 'ready',
          asOf: threeHoursAgo.toISOString(),
        },
        readResultExpiresAt: new Date(threeHoursAgo.getTime() + 15 * 60_000),
      }).where(eq(aiWorkflowRun.id, run.id));

      const reused = await hmsJobs.queueAutoStaffQuoteHmsJob(autoStaffQuoteRequest(threadId, messageId), db);
      expect(reused).toMatchObject({ created: false, run: { id: run.id } });

      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60_000);
      await db.update(aiWorkflowRun).set({
        readResult: {
          kind: 'staff_quote',
          status: 'ready',
          asOf: twentyFiveHoursAgo.toISOString(),
        },
        readResultExpiresAt: new Date(twentyFiveHoursAgo.getTime() + 15 * 60_000),
      }).where(eq(aiWorkflowRun.id, run.id));

      const queued = await hmsJobs.queueAutoStaffQuoteHmsJob(autoStaffQuoteRequest(threadId, messageId), db);
      expect(queued.created).toBe(true);
      expect(queued.run.id).not.toBe(run.id);
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
      expect(stored?.readResultExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 24 * 60 * 60_000 - 1_000);
      expect(stored?.readResultExpiresAt?.getTime()).toBeLessThan(Date.now() + 24 * 60 * 60_000 + 1_000);
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

  it.each([
    [1, 'retry_wait'],
    [20, 'dead_letter'],
  ] as const)('a prepared quote %i minutes old that meets a busy property lock ends %s', (ageMinutes, outcome) =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      const { threadId, messageId } = await seedThread(db, 'Quote request');
      const preparedInput = staffQuoteInput.parse({ ...STAFF_QUOTE_INPUT, messageId, selectionEpoch: 0, inputRevision: 0 });
      const { run } = await enqueueHmsJob({
        transportId: TRANSPORT_ID,
        threadId,
        triggerMessageId: messageId,
        workItemId: null,
        userId: null,
        request: { kind: 'staff_quote', input: preparedInput },
        priority: HMS_JOB_PRIORITY_PREFETCH,
        idempotencyKey: `hms-job:staff-quote-prepared:test:${randomUUID()}`,
        extraMetrics: { quotePrepared: true },
      }, db);
      const claimed = await claimJob(db);
      staffQuoteRunner.run.mockRejectedValueOnce(new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE));

      // An earlier lock wait left it claimable again; only its age decides whether it waits once more.
      const createdAt = new Date(Date.now() - ageMinutes * 60_000);
      expect(await runClaimedJob(db, { ...claimed, createdAt })).toBe(outcome);
      const [stored] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
      expect(stored).toMatchObject({ state: outcome, attempts: 0, failureClass: 'HMS_LOCK_BUSY' });
    }));

  it('runs a prepared quote without a staff identity and keeps only the userless priced snapshot', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      vi.stubEnv('HITL_LEDGER', 'on');
      const { threadId, messageId } = await seedThread(db, 'Quote request');
      const preparedInput = staffQuoteInput.parse({ ...STAFF_QUOTE_INPUT, messageId, selectionEpoch: 0, inputRevision: 0 });
      const { run } = await enqueueHmsJob({
        transportId: TRANSPORT_ID,
        threadId,
        triggerMessageId: messageId,
        workItemId: null,
        userId: null,
        request: { kind: 'staff_quote', input: preparedInput },
        priority: HMS_JOB_PRIORITY_PREFETCH,
        idempotencyKey: `hms-job:staff-quote-prepared:test:${randomUUID()}`,
        extraMetrics: { quotePrepared: true },
      }, db);
      const quoteResult = {
        status: 'ready',
        workflowRunId: run.id,
        revisionRef: 'prepared-revision-1',
        messageId,
        threadId,
        factRefs: [],
        selectionEpoch: 0,
        inputRevision: 0,
        inputDigest: 'd'.repeat(64),
        totalMinor: 240_000,
        currency: 'ZAR',
        arrivalDate: '2026-10-12',
        departureDate: '2026-10-14',
        description: 'Standard King; Room Only',
        freshUntil: new Date(Date.now() + 60_000).toISOString(),
        preparedProposal: {
          version: 1,
          inputDigest: 'd'.repeat(64),
          authorizationId: 'prepared-auth-1',
          sourceHash: preparedInput.sourceHash,
          revision: { id: 'prepared-revision-1', authorizationId: 'prepared-auth-1' },
          rowPrices: [],
        },
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
      const result = await runClaimedJob(db, claimed);
      const [stored] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
      expect(stored?.lastError).toBeNull();
      expect(result).toBe('succeeded');
      expect(staffQuoteRunner.run).toHaveBeenCalledWith(
        preparedInput,
        { transportId: TRANSPORT_ID },
        db,
        expect.objectContaining({ preparedRunId: run.id, commitQueuedResult: expect.any(Function) }),
      );
      expect(await db.select().from(aiDraftGeneration).where(eq(aiDraftGeneration.transportId, TRANSPORT_ID))).toEqual([]);
      expect(stored?.metrics).toMatchObject({ quotePrepared: true, userId: null });
      expect(stored?.readResult).toMatchObject({
        ...quoteResult,
        kind: 'staff_quote',
        asOf: expect.any(String),
      });
      const [toolRun] = await db
        .select()
        .from(hitlToolRun)
        .where(and(eq(hitlToolRun.transportId, TRANSPORT_ID), eq(hitlToolRun.messageId, messageId), eq(hitlToolRun.kind, 'quote')));
      expect(toolRun?.userId).toBeNull();
    }));

  it('ends a queued prepared quote superseded while quote preparation is disabled', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'false');
      const { threadId, messageId } = await seedThread(db, 'Quote request');
      const { run } = await enqueueHmsJob({
        transportId: TRANSPORT_ID,
        threadId,
        triggerMessageId: messageId,
        workItemId: null,
        userId: null,
        request: {
          kind: 'staff_quote',
          input: staffQuoteInput.parse({ ...STAFF_QUOTE_INPUT, messageId, selectionEpoch: 0, inputRevision: 0 }),
        },
        priority: HMS_JOB_PRIORITY_PREFETCH,
        idempotencyKey: `hms-job:staff-quote-prepared:disabled:${randomUUID()}`,
        extraMetrics: { quotePrepared: true },
      }, db);

      const claimed = await claimJob(db);
      expect(claimed.id).toBe(run.id);
      await expect(runClaimedJob(db, claimed)).resolves.toBe('dead_letter');

      const [stopped] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
      expect(stopped).toMatchObject({
        state: 'superseded',
        lastError: 'quote_preparation_disabled',
        failureClass: 'POLICY_BLOCK',
      });
      expect(staffQuoteRunner.run).not.toHaveBeenCalled();
    }));

  it('dead-letters an already-attempted prepared quote as exhausted', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      const { threadId, messageId } = await seedThread(db, 'Quote request');
      const { run } = await enqueueHmsJob({
        transportId: TRANSPORT_ID,
        threadId,
        triggerMessageId: messageId,
        workItemId: null,
        userId: null,
        request: {
          kind: 'staff_quote',
          input: staffQuoteInput.parse({ ...STAFF_QUOTE_INPUT, messageId, selectionEpoch: 0, inputRevision: 0 }),
        },
        priority: HMS_JOB_PRIORITY_PREFETCH,
        idempotencyKey: `hms-job:staff-quote-prepared:exhausted:${randomUUID()}`,
        extraMetrics: { quotePrepared: true },
      }, db);
      await db.update(aiWorkflowRun).set({ attempts: 1 }).where(eq(aiWorkflowRun.id, run.id));

      const claimed = await claimJob(db);
      await expect(runClaimedJob(db, { ...claimed, attempts: 1 })).resolves.toBe('dead_letter');

      const [stopped] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
      expect(stopped).toMatchObject({
        state: 'dead_letter',
        lastError: 'prepared_quote_attempt_exhausted',
        failureClass: 'TRANSIENT_NETWORK',
      });
      expect(staffQuoteRunner.run).not.toHaveBeenCalled();
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

  it('does not let an older refusal answer once a newer price has expired', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      const { run: refused } = await enqueueStaffQuoteJob(db, threadId, messageId);
      const { run: priced } = await enqueueStaffQuoteJob(db, threadId, messageId);
      const now = Date.now();
      await db
        .update(aiWorkflowRun)
        .set({
          state: 'succeeded',
          readResult: { kind: 'staff_quote', status: 'unavailable', reason: 'No rate' },
          readResultExpiresAt: new Date(now + 6 * 60 * 60_000),
          createdAt: new Date(now - 30 * 60_000),
        })
        .where(eq(aiWorkflowRun.id, refused.id));
      await db
        .update(aiWorkflowRun)
        .set({
          state: 'succeeded',
          readResult: { kind: 'staff_quote', status: 'ready', freshUntil: new Date(now - 60_000).toISOString() },
          readResultExpiresAt: new Date(now - 60_000),
          createdAt: new Date(now - 20 * 60_000),
        })
        .where(eq(aiWorkflowRun.id, priced.id));

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
        .set({ createdAt, nextRunAt: createdAt, updatedAt: createdAt })
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

  it('does not expire a deferred prepared quote before nextRunAt', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      const { threadId, messageId } = await seedThread(db, 'Quote request');
      const now = new Date();
      const createdAt = new Date(now.getTime() - 15 * 60_000);
      const nextRunAt = new Date(now.getTime() + 45 * 60_000);
      const preparedInput = staffQuoteInput.parse({
        ...STAFF_QUOTE_INPUT,
        messageId,
        selectionEpoch: 0,
        inputRevision: 0,
      });
      const { run } = await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          workItemId: null,
          userId: null,
          request: { kind: 'staff_quote', input: preparedInput },
          priority: HMS_JOB_PRIORITY_PREFETCH,
          idempotencyKey: `hms-job:staff-quote-prepared:deferred-ttl:${randomUUID()}`,
          extraMetrics: { quotePrepared: true, prefetchDeferred: true },
          nextRunAt,
        },
        db,
      );
      await db
        .update(aiWorkflowRun)
        .set({ createdAt, nextRunAt, updatedAt: createdAt })
        .where(eq(aiWorkflowRun.id, run.id));

      const claimedEarly = await claimNextAiRun({
        ownerId: LANE_OWNER,
        lane: 'hms',
        runKind: 'read_tool',
        promptVersion: HMS_JOB_PROMPT_VERSION,
        now,
        db,
      });
      const [stored] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
      expect(claimedEarly?.id).not.toBe(run.id);
      expect(stored).toMatchObject({ state: 'queued', lastError: null });

      const claimedDue = await claimNextAiRun({
        ownerId: LANE_OWNER,
        lane: 'hms',
        runKind: 'read_tool',
        promptVersion: HMS_JOB_PROMPT_VERSION,
        now: nextRunAt,
        db,
      });
      expect(claimedDue?.id).toBe(run.id);
      expect(claimedDue?.state).not.toBe('superseded');
    }));

  it('stores a staff quote business refusal as a successful job with its real message', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      const { run } = await enqueueStaffQuoteJob(db, threadId, messageId);
      const alternatives = [
        { groupId: 'single', roomCode: 'DLXTWN', roomLabel: 'Deluxe Twin', quantity: 1 },
      ];
      staffQuoteRunner.run.mockRejectedValue(
        new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'HMS has no rate for this meal plan under BAR.',
          cause: { alternatives },
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
          alternatives,
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

  it('a party search shared by dedupe stays readable by run id for another staff member', () =>
    withSeededTestDb(async (db) => {
      const { threadId } = await seedThread(db);
      const shared = await queueUserPartyHmsJob(
        {
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          threadId,
          request: { kind: 'party', name: 'Horizon Trail Tours', partyKind: 'company' },
        },
        db,
      );
      const view = await readHmsJobView(
        { transportId: TRANSPORT_ID, runId: shared!.id, staffQuoteOwnerId: 'another-staff-user' },
        db,
      );
      expect(view?.runId).toBe(shared?.id);
    }));

  it('does not dedupe or supersede a staff party request with a dev-eval read', () =>
    withSeededTestDb(async (db) => {
      const { threadId } = await seedThread(db);
      const request = { kind: 'party' as const, name: 'Horizon Trail Tours', partyKind: 'company' as const };
      const dev = await queueUserPartyHmsJob({
        transportId: TRANSPORT_ID,
        userId: CENTURION_USER_ID,
        threadId,
        request,
        devEval: true,
      }, db);
      const staff = await queueUserPartyHmsJob({
        transportId: TRANSPORT_ID,
        userId: CENTURION_USER_ID,
        threadId,
        request,
      }, db);

      expect(dev).toMatchObject({ priority: HMS_JOB_PRIORITY_DEV, state: 'queued', metrics: { devEval: true } });
      expect(staff).toMatchObject({ priority: HMS_JOB_PRIORITY_USER, state: 'queued' });
      expect(staff?.id).not.toBe(dev?.id);
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

  it('a Da Vinci party search without propertyCode uses the HRDAV slot, not HRCEN', () =>
    withSeededTestDb(async (db) => {
      const { threadId } = await seedThread(db, 'Quote request', DAVINCI_TRANSPORT_ID);
      const run = await queueUserPartyHmsJob(
        {
          transportId: DAVINCI_TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          threadId,
          request: { kind: 'party', name: 'Horizon Trail Tours', partyKind: 'company' },
        },
        db,
      );
      expect(run?.metrics).toMatchObject({
        propertyCode: 'HRDAV',
        slotId: 'davinci',
        hmsReadTarget: DAVINCI_HMS_READ_TARGET,
      });
      expect(run?.metrics).not.toMatchObject({ propertyCode: 'HRCEN' });
    }));

  it('a Centurion party search without propertyCode stays on the HRCEN slot', () =>
    withSeededTestDb(async (db) => {
      const { threadId } = await seedThread(db);
      const run = await queueUserPartyHmsJob(
        {
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          threadId,
          request: { kind: 'party', name: 'Horizon Trail Tours', partyKind: 'company' },
        },
        db,
      );
      expect(run?.metrics).toMatchObject({ propertyCode: 'HRCEN', slotId: 'centurion' });
      expect(run?.metrics).not.toHaveProperty('hmsReadTarget');
    }));

  it('refuses an unknown propertyCode with cause class property_unknown before HMS', () =>
    withSeededTestDb(async (db) => {
      const { threadId } = await seedThread(db);
      await expect(
        queueUserPartyHmsJob(
          {
            transportId: TRANSPORT_ID,
            userId: CENTURION_USER_ID,
            threadId,
            request: { kind: 'party', name: 'Horizon Trail Tours', partyKind: 'company' },
            propertyCode: 'HRFAKE',
          },
          db,
        ),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        cause: expect.objectContaining({ name: 'PropertyRefusalCause', code: 'property_unknown' }),
      });
    }));

  it('a Da Vinci user find without an explicit target uses the HRDAV slot', () =>
    withSeededTestDb(async (db) => {
      const { threadId } = await seedThread(db, 'Amend booking', DAVINCI_TRANSPORT_ID);
      const run = await queueUserHmsJob(
        {
          transportId: DAVINCI_TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          threadId,
          request: { kind: 'find', confirmation: CONFIRMATION },
        },
        db,
      );
      expect(run?.metrics).toMatchObject({
        propertyCode: 'HRDAV',
        slotId: 'davinci',
        hmsReadTarget: DAVINCI_HMS_READ_TARGET,
      });
    }));

  it('prefetches a Da Vinci confirmation onto the HRDAV slot when HMS_DAVINCI_READS is on', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_DAVINCI_READS', 'on');
      const { threadId, messageId } = await seedThread(db, 'Booking 1234567-1', DAVINCI_TRANSPORT_ID);
      const inbound = await insertInboundExtraction(
        db,
        threadId,
        messageId,
        'inbound_extraction',
        `snapshot-${randomUUID()}`,
        DAVINCI_TRANSPORT_ID,
      );
      await insertStoredExtraction(db, messageId, 'booking', {
        confirmationNumbers: ['1234567-1'],
      });
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };
      expect(await prefetchHmsConfirmations(inbound, db, env)).toBe(1);
      const [job] = await db
        .select({ metrics: aiWorkflowRun.metrics })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION));
      expect(job?.metrics).toMatchObject({
        propertyCode: 'HRDAV',
        slotId: 'davinci',
        hmsReadTarget: DAVINCI_HMS_READ_TARGET,
      });
    }));

  it('does not prefetch a Da Vinci confirmation when HMS_DAVINCI_READS is off', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_DAVINCI_READS', 'off');
      const { threadId, messageId } = await seedThread(db, 'Booking 1234567-1', DAVINCI_TRANSPORT_ID);
      const inbound = await insertInboundExtraction(
        db,
        threadId,
        messageId,
        'inbound_extraction',
        `snapshot-${randomUUID()}`,
        DAVINCI_TRANSPORT_ID,
      );
      await insertStoredExtraction(db, messageId, 'booking', {
        confirmationNumbers: ['1234567-1'],
      });
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };
      expect(await prefetchHmsConfirmations(inbound, db, env)).toBe(0);
    }));

  it('queues a Da Vinci batch item even when queueBatch marked it origin-refused', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_DAVINCI_READS', 'on');
      const { threadId, messageId } = await seedThread(db, 'Booking 1234567-1', DAVINCI_TRANSPORT_ID);
      await insertStoredExtraction(db, messageId, 'booking', {
        confirmationNumbers: [CONFIRMATION],
      });
      const workItemId = randomUUID();
      await db.insert(workItem).values({
        id: workItemId,
        transportId: DAVINCI_TRANSPORT_ID,
        threadId,
        sourceMessageId: messageId,
        kind: 'booking',
        status: 'needs_you',
      });
      const view = await enqueueHmsBatch(
        {
          batchId: randomUUID(),
          transportId: DAVINCI_TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: [workItemId],
          originRefusedWorkItemIds: [workItemId],
        },
        db,
      );
      expect(view).toMatchObject({
        status: 'queued',
        items: [{ workItemId, status: 'queued', reason: null }],
      });
    }));

  it('reuses a property-prefixed confirmation prefetch instead of a fresh batch read', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      mailboxHmsOriginBindLoaders.loadThreadOriginScan = async () => ({
        selected: { toAddresses: ['centurion@legacyhotels.co.za'] },
        selectedFound: true,
        inbounds: [{ toAddresses: ['centurion@legacyhotels.co.za'] }],
      });
      const day = new Date().toISOString().slice(0, 10);
      const prefetched = await seedThread(db, `Booking ${CONFIRMATION}`);
      const { run: prefetchJob } = await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId: prefetched.threadId,
          triggerMessageId: prefetched.messageId,
          workItemId: null,
          userId: null,
          request: { kind: 'find', confirmation: CONFIRMATION },
          priority: HMS_JOB_PRIORITY_PREFETCH,
          idempotencyKey: confirmationPrefetchIdempotencyKey(
            TRANSPORT_ID,
            CONFIRMATION,
            day,
            'HRCEN',
          ),
          extraMetrics: { propertyCode: 'HRCEN' },
        },
        db,
      );

      const batched = await seedThread(db, `Also ${CONFIRMATION}`);
      await insertStoredExtraction(db, batched.messageId, 'booking', {
        confirmationNumbers: [CONFIRMATION],
      });
      const workItemId = randomUUID();
      await db.insert(workItem).values({
        id: workItemId,
        transportId: TRANSPORT_ID,
        threadId: batched.threadId,
        sourceMessageId: batched.messageId,
        kind: 'booking',
        status: 'needs_you',
      });
      const view = await enqueueHmsBatch(
        {
          batchId: randomUUID(),
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: [workItemId],
        },
        db,
      );
      expect(view).toMatchObject({
        items: [{ workItemId, status: 'reused', runId: prefetchJob.id }],
      });
    }));

  it('reuses a batch read across same-property Message-ID copies and records mailbox batch membership', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_DAVINCI_READS', 'on');
      const copies: Array<{ transportId: string; workItemId: string; messageId: string }> = [];
      for (const transportId of [DAVINCI_TRANSPORT_ID, FAITH_TRANSPORT_ID]) {
        const { threadId, messageId } = await seedThread(
          db,
          `Booking ${CONFIRMATION}`,
          transportId,
          'u5-batch-copy@example.test',
        );
        await insertStoredExtraction(db, messageId, 'booking', {
          confirmationNumbers: [CONFIRMATION],
        });
        const workItemId = randomUUID();
        await db.insert(workItem).values({
          id: workItemId,
          transportId,
          threadId,
          sourceMessageId: messageId,
          kind: 'booking',
          status: 'needs_you',
        });
        copies.push({ transportId, workItemId, messageId });
      }

      const first = await enqueueHmsBatch(
        {
          batchId: randomUUID(),
          transportId: copies[0]!.transportId,
          userId: CENTURION_USER_ID,
          workItemIds: [copies[0]!.workItemId],
        },
        db,
      );
      const second = await enqueueHmsBatch(
        {
          batchId: randomUUID(),
          transportId: copies[1]!.transportId,
          userId: CENTURION_USER_ID,
          workItemIds: [copies[1]!.workItemId],
        },
        db,
      );

      expect(first?.items[0]).toMatchObject({ status: 'queued' });
      expect(second?.items[0]).toMatchObject({
        status: 'reused',
        runId: first?.items[0]?.runId,
        workItemId: copies[1]!.workItemId,
      });
      const runs = await db
        .select({ id: aiWorkflowRun.id })
        .from(aiWorkflowRun)
        .where(
          and(
            inArray(aiWorkflowRun.triggerMessageId, copies.map((copy) => copy.messageId)),
            eq(aiWorkflowRun.runKind, 'read_tool'),
          ),
        );
      expect(runs).toHaveLength(1);
    }));

  it('does not share one HMS job across hotels for the same confirmation in one batch', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_DAVINCI_READS', 'on');
      const origins = new Map<string, string[]>();
      mailboxHmsOriginBindLoaders.loadThreadOriginScan = async (input) => {
        const toAddresses = origins.get(input.threadId) ?? ['centurion@legacyhotels.co.za'];
        return {
          selected: { toAddresses },
          selectedFound: true,
          inbounds: [{ toAddresses }],
        };
      };
      const items = await Promise.all(
        [
          { to: ['centurion@legacyhotels.co.za'] },
          { to: ['davinci@legacyhotels.co.za'] },
        ].map(async ({ to }) => {
          const seeded = await seedThread(db, `Booking ${CONFIRMATION}`);
          origins.set(seeded.threadId, to);
          await insertStoredExtraction(db, seeded.messageId, 'booking', {
            confirmationNumbers: [CONFIRMATION],
          });
          const workItemId = randomUUID();
          await db.insert(workItem).values({
            id: workItemId,
            transportId: TRANSPORT_ID,
            threadId: seeded.threadId,
            sourceMessageId: seeded.messageId,
            kind: 'booking',
            status: 'needs_you',
          });
          return workItemId;
        }),
      );
      const view = await enqueueHmsBatch(
        {
          batchId: randomUUID(),
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: items,
        },
        db,
      );
      expect(view?.items).toHaveLength(2);
      expect(view?.items.every((item) => item.status === 'queued')).toBe(true);
      expect(view?.items[0]?.runId).not.toBe(view?.items[1]?.runId);
      const runs = await db
        .select({ id: aiWorkflowRun.id, metrics: aiWorkflowRun.metrics })
        .from(aiWorkflowRun)
        .where(inArray(aiWorkflowRun.id, [view!.items[0]!.runId!, view!.items[1]!.runId!]));
      const properties = new Set(
        runs.map((run) => (run.metrics as { propertyCode?: string }).propertyCode),
      );
      expect(properties).toEqual(new Set(['HRCEN', 'HRDAV']));
    }));

  it('a Da Vinci staff quote without installation refuses not_set_up before HMS', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_DAVINCI_MAKE_QUOTE', 'on');
      vi.stubEnv('RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV', '');
      const { threadId, messageId } = await seedThread(db, 'Quote request', DAVINCI_TRANSPORT_ID);
      const queued = await enqueueHmsJob(
        {
          transportId: DAVINCI_TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          workItemId: null,
          userId: CENTURION_USER_ID,
          request: { kind: 'staff_quote', input: { ...STAFF_QUOTE_INPUT, messageId } },
          priority: HMS_JOB_PRIORITY_USER,
          idempotencyKey: `hms-job:staff-quote:${randomUUID()}`,
          extraMetrics: {
            staffQuoteUser: { id: CENTURION_USER_ID, name: 'Synthetic Staff', email: 'staff@example.test' },
          },
        },
        db,
      );
      const claimed = await claimJob(db);
      expect(claimed.id).toBe(queued.run.id);
      expect(await runClaimedJob(db, claimed)).toBe('dead_letter');
      const [row] = await db
        .select({ lastError: aiWorkflowRun.lastError })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.id, queued.run.id));
      expect(row?.lastError).toBe('not_set_up');
      expect(staffQuoteRunner.run).not.toHaveBeenCalled();
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

  it('claims a later staff_quote before earlier party and find user jobs at the same priority', () =>
    withSeededTestDb(async (db) => {
      const { threadId, messageId } = await seedThread(db);
      const { run: party } = await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          workItemId: null,
          userId: CENTURION_USER_ID,
          request: { kind: 'party', name: 'Horizon Trail Tours', partyKind: 'company' },
          priority: HMS_JOB_PRIORITY_USER,
          idempotencyKey: `hms-job:user-party:${randomUUID()}`,
        },
        db,
      );
      const { run: find } = await enqueueHmsJob(
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
      const { run: quote } = await enqueueStaffQuoteJob(db, threadId, messageId);
      expect([party.priority, find.priority, quote.priority]).toEqual([
        HMS_JOB_PRIORITY_USER,
        HMS_JOB_PRIORITY_USER,
        HMS_JOB_PRIORITY_USER,
      ]);
      await db
        .update(aiWorkflowRun)
        .set({ createdAt: new Date(Date.now() - 60_000) })
        .where(eq(aiWorkflowRun.id, party.id));
      await db
        .update(aiWorkflowRun)
        .set({ createdAt: new Date(Date.now() - 30_000) })
        .where(eq(aiWorkflowRun.id, find.id));

      const claimed = await claimJob(db);
      expect(claimed.id).toBe(quote.id);
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

  it('prefetches a party for a system notice from a direct agent sender', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { run } = await seedQuoteExtraction(db, {
        fromAddress: 'agent@agency.example.test',
        payload: { ...quoteExtractionPayload(), origin: 'system_notice' },
      });
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };

      expect(await hmsJobs.prefetchPartyForExtraction(run, db, env)).toBe(1);
    }));

  it('prefetches a party for a direct agent quote', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { messageId, run } = await seedQuoteExtraction(db, { fromAddress: 'agent@agency.example.test' });
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };

      expect(await hmsJobs.prefetchPartyForExtraction(run, db, env)).toBe(1);
      const [job] = await db
        .select({ readRequest: aiWorkflowRun.readRequest })
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.triggerMessageId, messageId),
            eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
          ),
        );
      expect(job?.readRequest).toMatchObject({ kind: 'party', name: 'Acme Lodging Holdings' });
    }));

  it('shares one same-property prefetch result across three mailbox copies without merging their to-dos', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_DAVINCI_READS', 'on');
      vi.stubEnv('PARTY_MATCH_V2', 'true');
      vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
      vi.stubEnv('HMS_DAVINCI_MAKE_QUOTE', 'on');
      vi.stubEnv('RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV', '/tmp/hrdav-quote.json');
      const env = {
        ...parseEnv(process.env as Record<string, string | undefined>),
        HMS_PREFETCH_ENABLED: true,
      };
      const transports = [DAVINCI_TRANSPORT_ID, FAITH_TRANSPORT_ID, AYANDA_TRANSPORT_ID];
      const copies: Array<{ transportId: string; threadId: string; messageId: string; workItemId: string }> = [];
      for (const transportId of transports) {
        const { threadId, messageId } = await seedThread(
          db,
          'Quote request',
          transportId,
          'fanout-u5@example.test',
        );
        await insertStoredExtraction(db, messageId, 'quote', quoteExtractionPayload());
        const item = await ensureWorkItemForMessage(db, { transportId, messageId });
        expect(item).not.toBeNull();
        copies.push({ transportId, threadId, messageId, workItemId: item!.id });
      }

      const queued = [];
      for (const copy of copies) {
        queued.push(
          await hmsJobs.prefetchPartyForExtraction(
            { runKind: 'inbound_extraction', transportId: copy.transportId, triggerMessageId: copy.messageId },
            db,
            env,
          ),
        );
      }
      expect(queued).toEqual([1, 0, 0]);

      const readRuns = await db
        .select()
        .from(aiWorkflowRun)
        .where(and(inArray(aiWorkflowRun.triggerMessageId, copies.map((copy) => copy.messageId)), eq(aiWorkflowRun.runKind, 'read_tool')));
      expect(readRuns).toHaveLength(1);
      const sharedResult = { matchVersion: 2, matchStatus: 'needs_pick', results: [], asOf: new Date().toISOString() };
      await db
        .update(aiWorkflowRun)
        .set({
          state: 'succeeded',
          readResult: sharedResult,
          readResultExpiresAt: new Date(Date.now() + 60 * 60_000),
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(aiWorkflowRun.id, readRuns[0]!.id));

      for (const copy of copies) {
        const view = await readHmsJobView(
          { transportId: copy.transportId, threadId: copy.threadId, kind: 'party', name: 'Acme Lodging Holdings' },
          db,
        );
        expect(view).toMatchObject({ runId: readRuns[0]!.id, status: 'done', result: sharedResult });
      }

      const quoteEnv = {
        ...QUOTE_PREPARE_ENV,
        HMS_DAVINCI_MAKE_QUOTE: 'on',
        HMS_QUOTE_PREPARE_PER_HOUR: '20',
        RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV: '/tmp/hrdav-quote.json',
      };
      const hrdavShops = (await quotePaneConfigForProperty('HRDAV', DAVINCI_TRANSPORT_ID))?.salesStrategies.length ?? 0;
      const preparedCounts: number[] = [];
      for (const copy of copies) {
        preparedCounts.push(
          await prefetchQuoteReadyForExtraction(
            { runKind: 'inbound_extraction', transportId: copy.transportId, triggerMessageId: copy.messageId },
            db,
            quoteEnv,
          ),
        );
      }
      const [preparedQuote] = await db
        .select()
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.triggerMessageId, copies[0]!.messageId),
            eq(aiWorkflowRun.runKind, 'read_tool'),
            sql`${aiWorkflowRun.readRequest}->>'kind' = 'staff_quote'`,
          ),
        );
      expect(preparedCounts).toEqual([hrdavShops, 0, 0]);
      expect(preparedQuote).toBeDefined();
      const preparedInput = preparedInputFromRun(preparedQuote);
      const asOf = new Date();
      const preparedResult = {
        status: 'ready',
        workflowRunId: randomUUID(),
        revisionRef: 'prepared-revision',
        messageId: copies[0]!.messageId,
        threadId: copies[0]!.threadId,
        factRefs: [],
        selectionEpoch: preparedInput.selectionEpoch,
        inputRevision: preparedInput.inputRevision,
        inputDigest: 'prepared-digest',
        totalMinor: 10_000,
        currency: 'ZAR',
        arrivalDate: preparedInput.groups[0]!.arrivalDate,
        departureDate: preparedInput.groups[0]!.departureDate,
        description: 'Prepared quote',
        asOf: asOf.toISOString(),
        freshUntil: new Date(asOf.getTime() + 60 * 60_000).toISOString(),
      };
      await db
        .update(aiWorkflowRun)
        .set({
          state: 'succeeded',
          readResult: preparedResult,
          readResultExpiresAt: new Date(asOf.getTime() + 60 * 60_000),
          finishedAt: asOf,
          updatedAt: asOf,
        })
        .where(eq(aiWorkflowRun.id, preparedQuote!.id));
      for (const copy of copies) {
        const quoteInput = staffQuoteInput.parse({
          ...preparedInput,
          messageId: copy.messageId,
          ...(copy.messageId === copies[0]!.messageId ? {} : { sourceHash: 'b'.repeat(64) }),
        });
        const quoteView = await readHmsJobView(
          {
            transportId: copy.transportId,
            userId: CENTURION_USER_ID,
            messageId: copy.messageId,
            kind: 'staff_quote',
            input: quoteInput,
          },
          db,
        );
        expect(quoteView).toMatchObject({
          runId: preparedQuote!.id,
          request: { kind: 'staff_quote', input: { messageId: copies[0]!.messageId } },
          result: { status: 'ready', messageId: copies[0]!.messageId },
        });
        expect(quoteView?.sourceMessageId).toBe(copies[0]!.messageId);
      }
      const polledQuote = await readHmsJobView(
        {
          transportId: copies[1]!.transportId,
          runId: preparedQuote!.id,
          staffQuoteOwnerId: CENTURION_USER_ID,
        },
        db,
      );
      expect(polledQuote?.result).toMatchObject({ messageId: copies[0]!.messageId });
      expect(
        await db.select({ id: workItem.id }).from(workItem).where(inArray(workItem.id, copies.map((copy) => copy.workItemId))),
      ).toHaveLength(3);
      const [shared] = await db.select({ metrics: aiWorkflowRun.metrics }).from(aiWorkflowRun).where(eq(aiWorkflowRun.id, readRuns[0]!.id));
      expect(shared?.metrics).toMatchObject({
        sharedTransportIds: expect.arrayContaining([FAITH_TRANSPORT_ID, AYANDA_TRANSPORT_ID]),
        sharedWorkItemIds: expect.arrayContaining(copies.slice(1).map((copy) => copy.workItemId)),
      });
    }));

  it('keeps null-Message-ID reads per copy and the same Message-ID distinct across properties', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      vi.stubEnv('HMS_DAVINCI_READS', 'on');
      const env = {
        ...parseEnv(process.env as Record<string, string | undefined>),
        HMS_PREFETCH_ENABLED: true,
      };
      const copies: Array<{ transportId: string; messageId: string }> = [];
      for (const transportId of [DAVINCI_TRANSPORT_ID, FAITH_TRANSPORT_ID]) {
        const { messageId } = await seedThread(db, 'Quote request', transportId, null);
        await insertStoredExtraction(db, messageId, 'quote', quoteExtractionPayload());
        copies.push({ transportId, messageId });
      }
      for (const [transportId, messageId] of [
        [TRANSPORT_ID, 'msg-centurion-u5'],
        [DAVINCI_TRANSPORT_ID, 'msg-davinci-u5'],
      ] as const) {
        const threadId = `thread-${messageId}`;
        await db.insert(mailThread).values({ id: threadId, transportId, threadRootId: threadId });
        await db.insert(message).values({
          id: messageId,
          transportId,
          threadId,
          direction: 'inbound',
          fromAddress: 'agent@agency.example.test',
          subject: 'Quote request',
          textBody: `Please amend ${CONFIRMATION}.`,
          messageIdHeader: 'one-id-two-hotels@example.test',
          receivedAt: new Date(),
        });
        await insertStoredExtraction(db, messageId, 'quote', quoteExtractionPayload());
        copies.push({ transportId, messageId });
      }

      for (const copy of copies) {
        expect(
          await hmsJobs.prefetchPartyForExtraction(
            { runKind: 'inbound_extraction', transportId: copy.transportId, triggerMessageId: copy.messageId },
            db,
            env,
          ),
        ).toBe(1);
      }
      const runs = await db
        .select({ id: aiWorkflowRun.id })
        .from(aiWorkflowRun)
        .where(and(inArray(aiWorkflowRun.triggerMessageId, copies.map((copy) => copy.messageId)), eq(aiWorkflowRun.runKind, 'read_tool')));
      expect(runs).toHaveLength(4);
    }));

  it('collector live admission persists mail without creating a to-do, extraction, or AI/HMS run', () =>
    withSeededTestDb(async (db) => {
      const { messageId } = await seedThread(db, 'Collector request', NAVA_TRANSPORT_ID);
      await admitLiveMessage(db, {
        transportId: NAVA_TRANSPORT_ID,
        canonicalMessageId: messageId,
        newlyPersisted: true,
        evidence: { kind: 'verified-pop3', sourceReceiptId: 'u5-collector-test' },
      });

      expect(await db.select({ id: mailExtraction.id }).from(mailExtraction).where(eq(mailExtraction.messageId, messageId))).toHaveLength(0);
      expect(await db.select({ id: workItem.id }).from(workItem).where(eq(workItem.sourceMessageId, messageId))).toHaveLength(0);
      expect(await db.select({ id: aiWorkflowRun.id }).from(aiWorkflowRun).where(eq(aiWorkflowRun.triggerMessageId, messageId))).toHaveLength(0);
    }));

  it('skips party prefetch for a known channel sender', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { messageId, run } = await seedQuoteExtraction(db, { channel: true });
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };

      expect(await hmsJobs.prefetchPartyForExtraction(run, db, env)).toBe(0);
      const jobs = await db
        .select({ id: aiWorkflowRun.id })
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.triggerMessageId, messageId),
            eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
          ),
        );
      expect(jobs).toHaveLength(0);
    }));

  it('prefetches for a direct sender in an automated-channel thread', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, run } = await seedQuoteExtraction(db, { fromAddress: 'agent@agency.example.test' });
      const [existingCategory] = await db
        .select({ id: mailCategory.id })
        .from(mailCategory)
        .where(and(eq(mailCategory.transportId, TRANSPORT_ID), eq(mailCategory.slug, 'automated-channel')))
        .limit(1);
      const categoryId = existingCategory?.id ?? randomUUID();
      if (!existingCategory) {
        await db.insert(mailCategory).values({
          id: categoryId,
          transportId: TRANSPORT_ID,
          slug: 'automated-channel',
          name: 'Automated channel',
        });
      }
      await db.insert(mailThreadCategory).values({ threadId, categoryId, transportId: TRANSPORT_ID });
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };

      expect(await hmsJobs.prefetchPartyForExtraction(run, db, env)).toBe(1);
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
      expect(job?.idempotencyKey).toMatch(
        new RegExp(`^hms-job:prefetch-guest:${CENTURION_HMS_READ_TARGET.propertyCode}:${TRANSPORT_ID}:${threadId}:`),
      );
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

  it('does not guess a guest surname from an agency booker contact or conflicting guest labels', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };
      const cases = [
        {
          textBody: 'Please arrange the stay.',
          payload: {
            agency: 'Northwind Travel',
            contact: { name: 'Riley Quinn' },
            confirmationNumbers: [],
            stays: [{ requested: { arrival: '2026-11-12' } }],
          },
        },
        {
          textBody: 'Guest: Jordan Hale\nGuest: Riley Quinn',
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

  it('queues guest search from endClient person and booked arrival when mail has no confirmation or guest label', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, messageId } = await seedThread(db, 'Please amend the stay');
      await db
        .update(message)
        .set({ textBody: 'Please change the dates for our client.' })
        .where(eq(message.id, messageId));
      const run = await insertInboundExtraction(db, threadId, messageId);
      await insertStoredExtraction(db, messageId, 'amendment', {
        confirmationNumbers: [],
        endClient: 'Jordan Hale',
        agency: 'Northwind Travel',
        contact: { name: 'Riley Quinn' },
        stays: [
          {
            requested: { arrival: '2026-12-01', departure: '2026-12-03' },
            booked: { arrival: '2026-11-12', departure: '2026-11-14' },
          },
        ],
      });
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };

      expect(await prefetchHmsConfirmations(run, db, env)).toBe(1);
      const [job] = await db
        .select({ readRequest: aiWorkflowRun.readRequest })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION));
      expect(job?.readRequest).toMatchObject({ kind: 'search_guest', lastName: 'Hale', arrival: '2026-11-12' });
    }));

  it('queues guest search from a private-sender contact name when endClient is absent', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { threadId, messageId } = await seedThread(db, 'Please cancel my stay');
      await db.update(message).set({ textBody: 'Please cancel this booking.' }).where(eq(message.id, messageId));
      const run = await insertInboundExtraction(db, threadId, messageId);
      await insertStoredExtraction(db, messageId, 'cancellation', {
        confirmationNumbers: [],
        endClient: null,
        agency: null,
        contact: { name: 'Riley Quinn' },
        stays: [{ booked: { arrival: '2026-11-12' } }],
      });
      const env = { ...parseEnv(process.env as Record<string, string | undefined>), HMS_PREFETCH_ENABLED: true };

      expect(await prefetchHmsConfirmations(run, db, env)).toBe(1);
      const [job] = await db
        .select({ readRequest: aiWorkflowRun.readRequest })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION));
      expect(job?.readRequest).toMatchObject({ kind: 'search_guest', lastName: 'Quinn', arrival: '2026-11-12' });
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
    const transportId = TRANSPORT_ID;
    const threadIds: string[] = [];
    const messageIds: string[] = [];
    try {
      await setup.db
        .insert(mailboxTransport)
        .values({
          id: TRANSPORT_ID,
          email: TRANSPORT_EMAIL,
          ownerHeaderValue: TRANSPORT_EMAIL,
          isActive: true,
        })
        .onConflictDoNothing();
      const makeRequest = async (lastName: string): Promise<AiWorkflowRun> => {
        const threadId = `guest-cap-thread-${randomUUID()}`;
        const messageId = `guest-cap-msg-${randomUUID()}`;
        threadIds.push(threadId);
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
        const first = prefetchHmsConfirmations(firstRun, left.db, env).then(
          (count) => {
            settledWhileHeld += 1;
            return count;
          },
          (error) => {
            settledWhileHeld += 1;
            throw error;
          },
        );
        const second = prefetchHmsConfirmations(secondRun, right.db, env).then(
          (count) => {
            settledWhileHeld += 1;
            return count;
          },
          (error) => {
            settledWhileHeld += 1;
            throw error;
          },
        );
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
        if (messageIds.length > 0) {
          await setup.db.delete(aiWorkflowRun).where(inArray(aiWorkflowRun.triggerMessageId, messageIds));
          await setup.db.delete(mailExtraction).where(inArray(mailExtraction.messageId, messageIds));
          await setup.db.delete(message).where(inArray(message.id, messageIds));
        }
        if (threadIds.length > 0) {
          await setup.db.delete(mailThread).where(inArray(mailThread.id, threadIds));
        }
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
      paneStayLookupLoaders.spawn = vi.fn(async () => ({
        ...FOUND,
        commercial: {
          company: { name: 'Northstar Conference Group', nativeId: 'COMP-42' },
          agency: { name: 'Harbor Travel', nativeId: 'AG-9' },
        },
      }));
      const { threadId, messageId } = await seedThread(db);
      const senderHost = `harbortravel-${randomUUID()}.example.test`;
      await db
        .update(message)
        .set({ fromAddress: `guest@${senderHost}` })
        .where(eq(message.id, messageId));
      vi.stubEnv('PARTY_HISTORY_BIND', 'on');
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
      expect(remounted?.result).toMatchObject({
        outcome: 'found',
        commercial: {
          company: { name: 'Northstar Conference Group', nativeId: 'COMP-42' },
          agency: { name: 'Harbor Travel', nativeId: 'AG-9' },
        },
      });
      const [learned] = await db
        .select()
        .from(partySenderMap)
        .where(eq(partySenderMap.host, senderHost));
      expect(learned).toMatchObject({
        propertyCode: 'HRCEN',
        kind: 'agency',
        name: 'Harbor Travel',
        nativeId: 'AG-9',
        support: 1,
      });
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
  transportId = TRANSPORT_ID,
): Promise<AiWorkflowRun> {
  const [row] = await db
    .insert(aiWorkflowRun)
    .values({
      id: randomUUID(),
      transportId,
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

