import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReservationistBusinessServices } from '../src/ai/reservationist-business-services.js';
import { staffQuoteInput, staffQuoteSourceHash, type StaffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import { aiDraftGeneration, aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import type { AiWorkflowRun } from '../src/ai/run-ledger.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { TRPCError } from '@trpc/server';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { CENTURION_USER_ID, TRANSPORT_ID } from '../src/db/seed.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';
import { probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';
import { mailboxHmsOriginBindLoaders } from '../src/hms/mailbox-hms-origin-bind.js';

const jobMocks = vi.hoisted(() => ({
  runStaffQuote: vi.fn(),
  markSucceeded: vi.fn(),
  markRetry: vi.fn(),
  markDeadLetter: vi.fn(),
}));

const originMocks = vi.hoisted(() => ({ guard: vi.fn() }));

const quoteRunMocks = vi.hoisted(() => ({
  readConfiguration: vi.fn(),
  getServices: vi.fn(),
  snapshotRowPrices: vi.fn(),
  createPropertyReadLock: vi.fn(),
}));

const workflowMocks = vi.hoisted(() => ({ executeStaffQuote: vi.fn() }));
const quoteQueueMocks = vi.hoisted(() => ({ staffQuoteInFlight: vi.fn() }));
const quoteOutcomeMocks = vi.hoisted(() => ({
  ensureQuoteOutcomeWorkItem: vi.fn(),
  recordPreparedQuoteOutcome: vi.fn(),
}));
const quoteLineMocks = vi.hoisted(() => ({
  deriveQuoteLines: vi.fn(),
  pricedRoomTotal: vi.fn(),
  rowRatesFor: vi.fn(),
}));

vi.mock('../src/ai/staff-quote-run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ai/staff-quote-run.js')>();
  return {
    staffQuoteRoomAlternatives: actual.staffQuoteRoomAlternatives,
    staffQuoteFailurePhase: actual.staffQuoteFailurePhase,
    runStaffQuote: jobMocks.runStaffQuote,
    staffQuoteFailureCode: (error: unknown) => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const candidate = typeof code === 'string' ? code : error instanceof Error ? error.message : '';
      return /^[A-Za-z0-9_.:-]{1,120}$/.test(candidate) ? candidate : 'unknown';
    },
    staffQuoteFailureMessage: () => 'Staff quote could not be completed.',
  };
});

vi.mock('../src/hms/property-queue-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hms/property-queue-state.js')>()),
  staffQuoteInFlight: quoteQueueMocks.staffQuoteInFlight,
}));

vi.mock('../src/ai/staff-quote-installation.js', () => ({
  readInstalledStaffQuoteConfiguration: quoteRunMocks.readConfiguration,
  getInstalledStaffQuoteServices: quoteRunMocks.getServices,
}));

vi.mock('../src/ai/staff-quote-workflow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/staff-quote-workflow.js')>()),
  executeStaffQuote: workflowMocks.executeStaffQuote,
}));

vi.mock('../src/ai/quote-outcomes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/quote-outcomes.js')>()),
  ensureQuoteOutcomeWorkItem: quoteOutcomeMocks.ensureQuoteOutcomeWorkItem,
  recordPreparedQuoteOutcome: quoteOutcomeMocks.recordPreparedQuoteOutcome,
}));

vi.mock('../src/quote-proposal/quote-lines.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/quote-proposal/quote-lines.js')>()),
  deriveQuoteLines: quoteLineMocks.deriveQuoteLines,
  pricedRoomTotal: quoteLineMocks.pricedRoomTotal,
  rowRatesFor: quoteLineMocks.rowRatesFor,
}));

vi.mock('../src/trpc/routes/rates.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/trpc/routes/rates.js')>()),
  snapshotRowPrices: quoteRunMocks.snapshotRowPrices,
}));

vi.mock('../src/hms/property-read-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hms/property-read-lock.js')>()),
  createPostgresPropertyReadLock: quoteRunMocks.createPropertyReadLock,
}));

vi.mock('../src/ai/run-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/run-ledger.js')>()),
  markAiRunSucceeded: jobMocks.markSucceeded,
  markAiRunRetry: jobMocks.markRetry,
  markAiRunDeadLetter: jobMocks.markDeadLetter,
}));

vi.mock('../src/hms/mailbox-hms-origin-bind.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hms/mailbox-hms-origin-bind.js')>()),
  guardCenturionHmsMailboxOrigin: originMocks.guard,
}));

import { executeHmsJob, hmsJobRequestSchema, HMS_JOB_PRIORITY_USER, readHmsJobView } from '../src/ai/hms-jobs.js';
import { PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';
import { HMS_JOB_PROMPT_VERSION } from '../src/ai/run-ledger.js';

const STAFF_QUOTE_INPUT = {
  messageId: 'message-1',
  sourceHash: 'a'.repeat(64),
  selectionEpoch: 3,
  inputRevision: 5,
  groups: [
    {
      id: 'single',
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-14',
      quantity: 1,
      adults: 2,
      childrenPerRoom: 0,
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

const user = { id: 'staff-1', name: 'Synthetic Staff', email: 'staff@example.test' };
const db = {} as DB;
const reachable = await probeTestDb();

function fixture(metrics: Record<string, unknown> = { userId: user.id, staffQuoteUser: user }) {
  const request = { kind: 'staff_quote', input: STAFF_QUOTE_INPUT };
  const run = {
    id: 'job-1',
    transportId: TRANSPORT_ID,
    threadId: 'thread-1',
    runKind: 'read_tool',
    promptVersion: HMS_JOB_PROMPT_VERSION,
    priority: HMS_JOB_PRIORITY_USER,
    attempts: 0,
    state: 'running',
    readRequest: request,
    metrics,
  } as unknown as AiWorkflowRun;
  const fence = {
    runId: run.id,
    claimOwner: 'worker-1',
    claimToken: 'claim-1',
    deadlineAt: new Date(Date.now() + 7 * 60_000),
  };
  return { run, fence, request };
}

function preparedFixture() {
  vi.stubEnv('HMS_JOB_QUEUE', 'on');
  vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
  const prepared = fixture({ userId: null, quotePrepared: true });
  prepared.run.priority = 0;
  return prepared;
}

beforeEach(async () => {
  vi.stubEnv('RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV', 'synthetic');
  originMocks.guard.mockReset().mockResolvedValue({ ok: true });
  jobMocks.markSucceeded.mockReset().mockResolvedValue({ id: 'job-1' });
  jobMocks.markRetry.mockReset().mockResolvedValue({ id: 'job-1' });
  jobMocks.markDeadLetter.mockReset().mockResolvedValue({ id: 'job-1' });
  const workflow = await vi.importActual<typeof import('../src/ai/staff-quote-workflow.js')>(
    '../src/ai/staff-quote-workflow.js',
  );
  workflowMocks.executeStaffQuote.mockReset().mockImplementation(workflow.executeStaffQuote);
  quoteQueueMocks.staffQuoteInFlight.mockReset().mockResolvedValue(false);
  quoteLineMocks.deriveQuoteLines.mockReset().mockReturnValue([{ description: 'Synthetic room' }]);
  quoteLineMocks.pricedRoomTotal
    .mockReset()
    .mockImplementation((revision: { totalMinor: number }) => revision.totalMinor);
  quoteLineMocks.rowRatesFor.mockReset().mockReturnValue([]);
  quoteOutcomeMocks.ensureQuoteOutcomeWorkItem.mockReset().mockResolvedValue('quote-work-item');
  quoteOutcomeMocks.recordPreparedQuoteOutcome.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  __setDbForTests(null);
  mailboxHmsOriginBindLoaders.loadThreadOriginScan = null;
  jobMocks.runStaffQuote.mockReset();
  quoteRunMocks.readConfiguration.mockReset();
  quoteRunMocks.getServices.mockReset();
  quoteRunMocks.snapshotRowPrices.mockReset();
  quoteRunMocks.createPropertyReadLock.mockReset();
  quoteLineMocks.deriveQuoteLines.mockReset();
  quoteLineMocks.pricedRoomTotal.mockReset();
  quoteLineMocks.rowRatesFor.mockReset();
  vi.unstubAllEnvs();
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('staff quote auto-start route (disposable DB, no HMS)', () => {
  async function setupRoute(db: DB) {
    __setDbForTests({ db, conn: null as never });
    const threadId = randomUUID(), messageId = randomUUID();
    await db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID, threadRootId: threadId });
    await db.insert(message).values({
      id: messageId, transportId: TRANSPORT_ID, threadId, direction: 'inbound', fromAddress: 'guest@example.test',
    });
    const input = staffQuoteInput.parse({ ...STAFF_QUOTE_INPUT, messageId });
    const { workstationRouter } = await import('../src/trpc/routes/workstation.js');
    const api = workstationRouter.createCaller({
      auth: null as never,
      reqHeaders: new Headers({ 'x-zero-active-transport': TRANSPORT_ID }),
      sessionUser: { id: CENTURION_USER_ID, name: user.name, email: user.email },
    } as never);
    return { api, input, messageId };
  }

  it('accepts autoStart, strips it from persisted input, and reuses the same semantic request', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { api, input, messageId } = await setupRoute(db);
      const first = await api.queueStaffQuote({ ...input, autoStart: true });
      const second = await api.queueStaffQuote({ ...input, autoStart: true, selectionEpoch: 90, inputRevision: 100 });

      expect(first.runId).toEqual(expect.any(String));
      expect(second.runId).toBe(first.runId);
      const rows = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.triggerMessageId, messageId));
      expect(rows).toHaveLength(1);
      expect(rows[0].readRequest).toEqual({ kind: 'staff_quote', input });
      expect(rows[0].metrics).toMatchObject({
        userId: CENTURION_USER_ID,
        staffQuoteUser: { id: CENTURION_USER_ID },
        autoStart: true,
      });
      expect(jobMocks.runStaffQuote).not.toHaveBeenCalled();
      expect(quoteRunMocks.readConfiguration).not.toHaveBeenCalled();
    }));

  it('manual queueing creates a fresh run after an auto-start', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      const { api, input, messageId } = await setupRoute(db);
      const auto = await api.queueStaffQuote({ ...input, autoStart: true });
      const manual = await api.queueStaffQuote(input);
      const manualAgain = await api.queueStaffQuote(input);

      expect(new Set([auto.runId, manual.runId, manualAgain.runId]).size).toBe(3);
      const rows = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.triggerMessageId, messageId));
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((run) => run.idempotencyKey)).size).toBe(3);
      expect(jobMocks.runStaffQuote).not.toHaveBeenCalled();
    }));

  it('queue-off auto-start returns a null run id without invoking inline execution', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('HMS_JOB_QUEUE', 'off');
      const { api, input, messageId } = await setupRoute(db);

      await expect(api.queueStaffQuote({ ...input, autoStart: true })).resolves.toEqual({ runId: null });
      const rows = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.triggerMessageId, messageId));
      expect(rows).toHaveLength(0);
      expect(jobMocks.runStaffQuote).not.toHaveBeenCalled();
      expect(quoteRunMocks.readConfiguration).not.toHaveBeenCalled();
    }));
});

function staffQuoteRunDb(
  mail: Record<string, unknown>,
  groups: StaffQuoteInput['groups'] = staffQuoteInput.parse(STAFF_QUOTE_INPUT).groups,
) {
  let latestGenerationId: string | undefined;
  const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const updated: unknown[] = [];
  const occupancyState: Record<string, unknown> = {};
  const payload = {
    contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
    confirmationNumbers: [], missing: [], stays: [{
      id: 's_test', hotel: null,
      requested: { arrival: '2026-11-12', departure: '2026-11-14' }, booked: null, totalRooms: null,
      rows: groups.map((group) => ({
        id: group.id, roomType: null, rooms: group.quantity, adultsPerRoom: group.adults,
        childrenPerRoom: group.childrenPerRoom ?? group.childrenAges.length,
        childAges: [...group.childrenAges], board: null,
      })),
    }],
  };
  const rowsFor = (table: unknown) => {
    if (table === message) return [mail];
    if (table === mailExtraction) return [{ id: 'extraction-1', kind: 'quote', payload }];
    if (table === workItem) return [{ extractionId: 'extraction-1', state: occupancyState }];
    if (table === aiDraftGeneration && latestGenerationId) return [{ id: latestGenerationId }];
    return [];
  };
  let db: Record<string, unknown>;
  db = {
    select() {
      let table: unknown;
      const query = {
        from(value: unknown) {
          table = value;
          return query;
        },
        where() {
          return query;
        },
        orderBy() {
          return query;
        },
        for() {
          return query;
        },
        limit() {
          return Promise.resolve(rowsFor(table));
        },
      };
      return query;
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          if (table === aiDraftGeneration) latestGenerationId = values.id as string;
          inserted.push({ table, values });
          return Promise.resolve();
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              updated.push({ table, values });
              return Promise.resolve();
            },
          };
        },
      };
    },
    transaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
      const insertedLength = inserted.length;
      const updatedLength = updated.length;
      try {
        return await callback(db);
      } catch (error) {
        inserted.length = insertedLength;
        updated.length = updatedLength;
        throw error;
      }
    },
  };
  return { db: db as unknown as DB, inserted, updated, payload, occupancyState };
}

async function provisionalWorkerQuote(
  finished: Promise<void>,
  onError?: (error: unknown) => void,
  inputOverrides: Partial<StaffQuoteInput> = {},
  prepared = false,
  transportId = TRANSPORT_ID,
) {
  const actualRun = await vi.importActual<typeof import('../src/ai/staff-quote-run.js')>(
    '../src/ai/staff-quote-run.js',
  );
  jobMocks.runStaffQuote.mockImplementation(async (...args: Parameters<typeof actualRun.runStaffQuote>) => {
    try {
      return await actualRun.runStaffQuote(...args);
    } catch (error) {
      onError?.(error);
      throw error;
    }
  });
  const mail = {
    id: STAFF_QUOTE_INPUT.messageId,
    transportId,
    threadId: 'thread-1',
    direction: 'inbound',
    subject: 'Accommodation enquiry',
    textBody: 'Please quote accommodation for the selected dates.',
    htmlBody: null,
    receivedAt: new Date('2026-10-12T08:00:00.000Z'),
    sentAt: null,
    createdAt: new Date('2026-10-12T08:00:00.000Z'),
  };
  const input = staffQuoteInput.parse({
    ...STAFF_QUOTE_INPUT,
    ...inputOverrides,
    sourceHash: staffQuoteSourceHash(mail),
  });
  const { run, fence } = prepared ? preparedFixture() : fixture();
  run.transportId = transportId;
  run.readRequest = { kind: 'staff_quote', input } as unknown as AiWorkflowRun['readRequest'];
  const quoteDb = staffQuoteRunDb(mail, input.groups);
  quoteRunMocks.readConfiguration.mockReturnValue({
    tenantId: 'synthetic-hotel',
    owner: { propertyCode: 'HRCEN' },
    outputDir: '/tmp/synthetic-staff-quote',
  });
  quoteRunMocks.snapshotRowPrices.mockResolvedValue([]);
  quoteRunMocks.createPropertyReadLock.mockReturnValue({
    withLock: (callback: () => Promise<unknown>) => callback(),
  });
  quoteRunMocks.getServices.mockImplementation((options: Record<string, any>) => {
    options.onTraceFinish?.(finished);
    return {};
  });
  workflowMocks.executeStaffQuote.mockImplementation(async (prepared: { authorizationId: string }) => ({
    id: 'revision-1',
    authorizationId: prepared.authorizationId,
    totalMinor: 240_000,
    currency: 'ZAR',
    groups: [
      {
        arrivalDate: input.groups[0]!.arrivalDate,
        departureDate: input.groups[0]!.departureDate,
        context: {},
      },
    ],
  }));
  vi.stubEnv('DATABASE_URL', 'postgres://127.0.0.1/synthetic');
  vi.stubEnv('QUOTE_TRACE_ASYNC', 'on');
  return { run, fence, db: quoteDb.db, inserted: quoteDb.inserted, occupancyState: quoteDb.occupancyState };
}

describe('runStaffQuote child occupancy', () => {
  it('refuses a forged zero when the extraction mentions a child without an age', async () => {
    const actual = await vi.importActual<typeof import('../src/ai/staff-quote-run.js')>(
      '../src/ai/staff-quote-run.js',
    );
    const mail = {
      id: STAFF_QUOTE_INPUT.messageId, transportId: TRANSPORT_ID, threadId: 'thread-1', direction: 'inbound',
      subject: 'Accommodation enquiry', textBody: 'Please quote accommodation.', htmlBody: null,
      receivedAt: new Date('2026-10-12T08:00:00Z'), sentAt: null, createdAt: new Date('2026-10-12T08:00:00Z'),
    };
    const input = staffQuoteInput.parse({
      ...STAFF_QUOTE_INPUT, sourceHash: staffQuoteSourceHash(mail),
      groups: [{ ...STAFF_QUOTE_INPUT.groups[0], childrenPerRoom: 0 }],
    });
    const quoteDb = staffQuoteRunDb(mail, input.groups);
    quoteDb.payload.stays[0]!.rows[0]!.childrenPerRoom = 1;
    await expect(actual.runStaffQuote(input, { transportId: TRANSPORT_ID, user }, quoteDb.db)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('number of children'),
      cause: expect.objectContaining({ reason: 'inputs_incomplete' }),
    });
    expect(quoteRunMocks.readConfiguration).not.toHaveBeenCalled();
  });

  it('rechecks saved occupancy after pricing before returning a result', async () => {
    const { run, fence, db: quoteDb, occupancyState } = await provisionalWorkerQuote(
      Promise.resolve(), undefined, {}, false, TRANSPORT_ID,
    );
    workflowMocks.executeStaffQuote.mockImplementationOnce((prepared: { authorizationId: string }) => {
      occupancyState['stays[s_test].rows[single].childAges'] = null;
      return syntheticRevision(
        ['600.00', '600.00'], 'Room Only R', 'SKNG', undefined, '2026-11-12', prepared.authorizationId,
      );
    });
    await expect(executeHmsJob({ run, fence, db: quoteDb })).resolves.toBe('succeeded');
    expect(jobMocks.markSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ readResult: expect.objectContaining({ ok: false }) }), quoteDb,
    );
  });
});

describe('staff_quote HMS job execution', () => {
  it('does not publish a price if the thread hotel changes while the job is pricing', async () => {
    const { run, fence, db: quoteDb } = await provisionalWorkerQuote(Promise.resolve());
    run.triggerMessageId = STAFF_QUOTE_INPUT.messageId;
    workflowMocks.executeStaffQuote.mockImplementationOnce((prepared: { authorizationId: string }) => {
      originMocks.guard.mockResolvedValue({
        ok: false, code: 'READ_DAVINCI_ORIGIN_REFUSED', message: 'Da Vinci origin',
      });
      return syntheticRevision(
        ['600.00', '600.00'], 'Room Only R', 'SKNG', undefined, '2026-11-12', prepared.authorizationId,
      );
    });
    await expect(executeHmsJob({ run, fence, db: quoteDb })).resolves.toBe('succeeded');
    expect(jobMocks.markSucceeded.mock.calls.at(-1)?.[0]).toMatchObject({
      readResult: { ok: false },
    });
  });

  it('refuses without persisting a price when the hotel changes at the final transaction fence', async () => {
    const { run, fence, db: quoteDb, inserted } = await provisionalWorkerQuote(Promise.resolve());
    run.triggerMessageId = STAFF_QUOTE_INPUT.messageId;
    originMocks.guard.mockImplementation(async (input: { lock?: boolean }) => input.lock
      ? { ok: false, code: 'READ_DAVINCI_ORIGIN_REFUSED', message: 'Da Vinci origin' }
      : { ok: true });
    await expect(executeHmsJob({ run, fence, db: quoteDb })).resolves.toBe('succeeded');
    expect(inserted.some((entry) => entry.table === aiWorkflowRun)).toBe(false);
    expect(jobMocks.markSucceeded.mock.calls.at(-1)?.[0]).toMatchObject({
      readResult: { ok: false, message: expect.stringMatching(/hotel.*changed/i) },
    });
    expect(jobMocks.markRetry).not.toHaveBeenCalled();
  });

  it.each(['message', 'later write'])('holds a quote when its %s source lock is busy', async (busyAt) => {
    const { run, fence, db: quoteDb } = await provisionalWorkerQuote(Promise.resolve());
    run.triggerMessageId = STAFF_QUOTE_INPUT.messageId;
    const lockUnavailable = Object.assign(new Error('lock unavailable'), { code: '55P03' });
    if (busyAt === 'message') {
      originMocks.guard.mockImplementation(async (input: { lock?: boolean }) => {
        if (input.lock) throw lockUnavailable;
        return { ok: true };
      });
    } else {
      quoteOutcomeMocks.ensureQuoteOutcomeWorkItem.mockRejectedValueOnce(lockUnavailable);
    }
    await expect(executeHmsJob({ run, fence, db: quoteDb })).resolves.toBe('succeeded');
    expect(jobMocks.markSucceeded.mock.calls.at(-1)?.[0]).toMatchObject({
      readResult: { ok: false, message: 'The email is being updated. Wait a moment, then try again.' },
    });
    expect(jobMocks.markRetry).not.toHaveBeenCalled();
  });

  it('persists the hotel that priced when the mailbox origin changes after the worker check', async () => {
    vi.stubEnv('HMS_DAVINCI_MAKE_QUOTE', 'on');
    const { run, fence, db: quoteDb } = await provisionalWorkerQuote(Promise.resolve());
    run.triggerMessageId = STAFF_QUOTE_INPUT.messageId;
    // The queue/worker initially sees Centurion; the quote runner's later recheck sees Da Vinci.
    originMocks.guard.mockResolvedValueOnce({ ok: true }).mockResolvedValue({
      ok: false, code: 'READ_DAVINCI_ORIGIN_REFUSED', message: 'Da Vinci origin',
    });
    mailboxHmsOriginBindLoaders.loadThreadOriginScan = async () => ({
      selectedFound: true, selected: { toAddresses: ['davinci@legacyhotels.co.za'] }, inbounds: [],
    });
    quoteRunMocks.readConfiguration.mockReturnValue({
      tenantId: 'synthetic-hotel', owner: { propertyCode: 'HRDAV' }, outputDir: '/tmp/synthetic-staff-quote',
    });
    workflowMocks.executeStaffQuote.mockImplementationOnce((prepared: { authorizationId: string }) =>
      syntheticRevision(
        ['600.00', '600.00'], 'Room Only R', 'SKNG', undefined, '2026-11-12', prepared.authorizationId,
        { id: 'single', quantity: 1, adults: 2, children: 0, childAges: [] }, 'HRDAV',
      ),
    );

    await expect(executeHmsJob({ run, fence, db: quoteDb })).resolves.toBe('succeeded');
    const result = jobMocks.markSucceeded.mock.calls.at(-1)?.[0].readResult as Record<string, unknown>;
    expect(result).toMatchObject({ status: 'ready', propertyCode: 'HRDAV' });
    expect(quoteRunMocks.getServices).toHaveBeenCalledWith(expect.objectContaining({ propertyCode: 'HRDAV' }), expect.anything());

    const readView = async (readResult: Record<string, unknown>) => {
      const stored = { ...run, state: 'succeeded', createdAt: new Date(), readResult };
      const readDb = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [stored] }) }) }) } as unknown as DB;
      return readHmsJobView({ transportId: run.transportId, runId: run.id, staffQuoteOwnerId: user.id }, readDb);
    };
    expect((await readView(result))?.result).toMatchObject({ status: 'ready', propertyCode: 'HRDAV' });
    const { propertyCode: _unknownProperty, ...legacyResult } = result;
    expect(await readView(legacyResult)).toMatchObject({ status: 'failed', result: { ok: false } });
  });

  it.each([false, true])('holds incomplete Centurion child occupancy before manual or prepared HMS work (prepared=%s)', async (prepared) => {
    const { run, fence, db: quoteDb } = await provisionalWorkerQuote(Promise.resolve(), undefined, {
      groups: [{ ...STAFF_QUOTE_INPUT.groups[0], childrenPerRoom: 2, childrenAges: [] }],
    }, prepared);

    await expect(executeHmsJob({ run, fence, db: quoteDb })).resolves.toBe('succeeded');
    expect(quoteRunMocks.snapshotRowPrices).not.toHaveBeenCalled();
    expect(quoteRunMocks.getServices).not.toHaveBeenCalled();
    expect(workflowMocks.executeStaffQuote).not.toHaveBeenCalled();
    expect(jobMocks.markSucceeded.mock.calls.at(-1)?.[0]).toMatchObject({
      readResult: { ok: false, message: expect.stringContaining('number of children') },
    });
  });

  it('records rate-pick history only for manual staff quotes', async () => {
    for (const autoStart of [false, true]) {
      jobMocks.runStaffQuote.mockClear();
      quoteOutcomeMocks.recordPreparedQuoteOutcome.mockClear();
      const { run, fence, db: quoteDb } = await provisionalWorkerQuote(
        Promise.resolve(),
        undefined,
        {},
        false,
        TRANSPORT_ID,
      );
      if (autoStart) (run as unknown as { metrics: Record<string, unknown> }).metrics.autoStart = true;
      workflowMocks.executeStaffQuote.mockImplementationOnce((prepared: { authorizationId: string }) =>
        syntheticRevision(
          ['600.00', '600.00'],
          'Room Only R',
          'SKNG',
          undefined,
          '2026-11-12',
          prepared.authorizationId,
        ),
      );

      await expect(executeHmsJob({ run, fence, db: quoteDb })).resolves.toBe('succeeded');

      const options = jobMocks.runStaffQuote.mock.calls.at(-1)?.[3] as { autoStart?: boolean } | undefined;
      expect(options?.autoStart).toBe(autoStart ? true : undefined);
      const outcome = quoteOutcomeMocks.recordPreparedQuoteOutcome.mock.calls.at(-1)?.[1];
      if (autoStart) {
        expect(outcome?.ratePick).toBeNull();
      } else {
        expect(outcome?.ratePick).toMatchObject({ strategy: 'BAR', actorUserId: user.id, mailKind: 'quote' });
      }
    }
  });

  it('includes a staff-entered dinner allowance on an ordinary B&B quote', async () => {
    const groups: StaffQuoteInput['groups'] = [
      {
        id: 'g1',
        arrivalDate: '2026-11-12',
        departureDate: '2026-11-14',
        quantity: 2,
        adults: 1,
        childrenPerRoom: 0,
        childrenAges: [],
        board: 'bb',
        roomCodes: ['SKNG'],
      },
    ];
    const { run, fence, db: quoteDb } = await provisionalWorkerQuote(Promise.resolve(), undefined, {
      groups,
      dinnerAllowanceMinor: 12_500,
      dinnerAllowanceUnit: 'per_person_per_night',
    });
    workflowMocks.executeStaffQuote.mockImplementationOnce((prepared: { authorizationId: string }) =>
      syntheticRevision(
        ['600.00', '600.00'],
        'Bed & Breakfast R',
        'SKNG',
        undefined,
        '2026-11-12',
        prepared.authorizationId,
      ),
    );

    await expect(executeHmsJob({ run, fence, db: quoteDb })).resolves.toBe('succeeded');

    expect(jobMocks.markSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        readResult: expect.objectContaining({
          factRefs: ['extras'],
          dinnerAddOn: expect.objectContaining({
            amountMinor: 12_500,
            unit: 'per_person_per_night',
            totalMinor: 50_000,
          }),
          dinnerAddOnRequired: false,
          totalMinor: 290_000,
        }),
      }),
      quoteDb,
    );
  });

  it('keeps a successful Government Dinner B&B quote and shows its rate note', async () => {
    const groups: StaffQuoteInput['groups'] = [
      {
        id: 'single',
        arrivalDate: '2026-11-12',
        departureDate: '2026-11-14',
        quantity: 1,
        adults: 2,
        childrenPerRoom: 0,
        childrenAges: [],
        board: 'dinner_bb',
        roomCodes: ['SKNG'],
      },
    ];
    const { run, fence, db: quoteDb } = await provisionalWorkerQuote(Promise.resolve(), undefined, {
      groups,
      salesStrategy: 'Government',
    });
    quoteRunMocks.readConfiguration.mockReturnValue({
      tenantId: 'synthetic-hotel',
      owner: { propertyCode: 'HRCEN' },
      outputDir: '/tmp/synthetic-staff-quote',
      dinnerAddOn: {
        amountMinor: 35_000,
        unit: 'per_person_per_night',
        label: 'Dinner Allowance',
      },
    });
    const requests: Array<{ salesStrategy: string; boardBases: string[] }> = [];
    workflowMocks.executeStaffQuote.mockImplementationOnce((prepared: {
      authorizationId: string;
      request: {
        search: { salesStrategy: string };
        rooms: Array<{ required: { boardBases: string[] } }>;
      };
    }) => {
      requests.push({
        salesStrategy: prepared.request.search.salesStrategy,
        boardBases: prepared.request.rooms[0]!.required.boardBases,
      });
      return syntheticRevision(
        ['600.00', '600.00'],
        'Dinner, Bed & Breakfast R',
        'SKNG',
        undefined,
        '2026-11-12',
        prepared.authorizationId,
        { id: 'single', quantity: 1, adults: 2, children: 0, childAges: [] },
      );
    });

    await expect(executeHmsJob({ run, fence, db: quoteDb })).resolves.toBe('succeeded');

    expect(workflowMocks.executeStaffQuote).toHaveBeenCalledOnce();
    expect(requests).toEqual([{ salesStrategy: 'Government', boardBases: ['dinner_bed_breakfast'] }]);
    const readResult = jobMocks.markSucceeded.mock.calls[0]?.[0].readResult;
    expect(readResult.extrasReviewItems).toContain(
      'Priced on the Government Dinner B&B rate because the guest asked for dinner. ' +
        'Choose All public rates (BAR) if the guest is not entitled.',
    );
    expect(readResult.dinnerAddOnRequired).toBe(false);
  });

  it('keeps BAR Dinner B&B on the existing B&B-plus-dinner retry path', async () => {
    const groups: StaffQuoteInput['groups'] = [
      {
        id: 'single',
        arrivalDate: '2026-11-12',
        departureDate: '2026-11-14',
        quantity: 1,
        adults: 2,
        childrenPerRoom: 0,
        childrenAges: [],
        board: 'dinner_bb',
        roomCodes: ['SKNG'],
      },
    ];
    const { run, fence, db: quoteDb, inserted } = await provisionalWorkerQuote(Promise.resolve(), undefined, {
      groups,
      salesStrategy: 'BAR',
    });
    quoteRunMocks.readConfiguration.mockReturnValue({
      tenantId: 'synthetic-hotel',
      owner: { propertyCode: 'HRCEN' },
      outputDir: '/tmp/synthetic-staff-quote',
      dinnerAddOn: {
        amountMinor: 35_000,
        unit: 'per_person_per_night',
        label: 'Dinner Allowance',
      },
    });
    const requests: Array<{ salesStrategy: string; boardBases: string[] }> = [];
    workflowMocks.executeStaffQuote.mockImplementation(async (prepared: {
      authorizationId: string;
      request: {
        search: { salesStrategy: string };
        rooms: Array<{ required: { boardBases: string[] } }>;
      };
    }) => {
      requests.push({
        salesStrategy: prepared.request.search.salesStrategy,
        boardBases: prepared.request.rooms[0]!.required.boardBases,
      });
      return syntheticRevision(
        ['600.00', '600.00'],
        requests.length === 1 ? 'Dinner, Bed & Breakfast R' : 'Bed & Breakfast R',
        'SKNG',
        undefined,
        '2026-11-12',
        prepared.authorizationId,
        { id: 'single', quantity: 1, adults: 2, children: 0, childAges: [] },
      );
    });

    await expect(executeHmsJob({ run, fence, db: quoteDb })).resolves.toBe('succeeded');

    expect(requests).toEqual([
      { salesStrategy: 'BAR', boardBases: ['dinner_bed_breakfast'] },
      { salesStrategy: 'BAR', boardBases: ['breakfast'] },
    ]);
    const readResult = jobMocks.markSucceeded.mock.calls[0]?.[0].readResult;
    expect(readResult).toMatchObject({
      dinnerAddOn: { amountMinor: 35_000, unit: 'per_person_per_night' },
      dinnerFallbackGroupIds: ['single'],
    });
    expect(readResult.extrasReviewItems).not.toContain(
      'No Government Dinner B&B rate in HMS for these dates — priced on B&B with dinner separately.',
    );
    expect(inserted.find(({ table }) => table === aiWorkflowRun)?.values).toMatchObject({
      metrics: { staffQuoteAttestation: { salesStrategy: 'BAR' } },
    });
  });

  it('retries Government no-match on BAR B&B with dinner separately and explains the fallback', async () => {
    const groups: StaffQuoteInput['groups'] = [
      {
        id: 'single',
        arrivalDate: '2026-11-12',
        departureDate: '2026-11-14',
        quantity: 1,
        adults: 2,
        childrenPerRoom: 0,
        childrenAges: [],
        board: 'dinner_bb',
        roomCodes: ['SKNG'],
      },
    ];
    const { run, fence, db: quoteDb, inserted } = await provisionalWorkerQuote(Promise.resolve(), undefined, {
      groups,
      salesStrategy: 'Government',
    });
    quoteRunMocks.readConfiguration.mockReturnValue({
      tenantId: 'synthetic-hotel',
      owner: { propertyCode: 'HRCEN' },
      outputDir: '/tmp/synthetic-staff-quote',
      dinnerAddOn: {
        amountMinor: 35_000,
        unit: 'per_person_per_night',
        label: 'Dinner Allowance',
      },
    });
    const requests: Array<{ salesStrategy: string; boardBases: string[] }> = [];
    workflowMocks.executeStaffQuote.mockImplementation(async (prepared: {
      authorizationId: string;
      request: {
        search: { salesStrategy: string };
        rooms: Array<{ required: { boardBases: string[] } }>;
      };
    }) => {
      requests.push({
        salesStrategy: prepared.request.search.salesStrategy,
        boardBases: prepared.request.rooms[0]!.required.boardBases,
      });
      if (requests.length === 1) throw new Error('native_quote_no_matching_rate');
      return syntheticRevision(
        ['600.00', '600.00'],
        'Bed & Breakfast R',
        'SKNG',
        undefined,
        '2026-11-12',
        prepared.authorizationId,
        { id: 'single', quantity: 1, adults: 2, children: 0, childAges: [] },
      );
    });

    await expect(executeHmsJob({ run, fence, db: quoteDb })).resolves.toBe('succeeded');

    expect(workflowMocks.executeStaffQuote).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([
      { salesStrategy: 'Government', boardBases: ['dinner_bed_breakfast'] },
      { salesStrategy: 'BAR', boardBases: ['breakfast'] },
    ]);
    const readResult = jobMocks.markSucceeded.mock.calls[0]?.[0].readResult;
    expect(readResult.extrasReviewItems).toContain(
      'No Government Dinner B&B rate in HMS for these dates — priced on B&B with dinner separately.',
    );
    expect(readResult).toMatchObject({
      dinnerAddOn: { amountMinor: 35_000, unit: 'per_person_per_night' },
      dinnerAddOnRequired: false,
      dinnerFallbackGroupIds: ['single'],
    });
    expect(inserted.find(({ table }) => table === aiWorkflowRun)?.values).toMatchObject({
      metrics: { staffQuoteAttestation: { salesStrategy: 'BAR' } },
    });
  });

  it('does not report a separate dinner charge as a B&B fallback for room-only accommodation', async () => {
    const groups: StaffQuoteInput['groups'] = [
      {
        id: 'g1',
        arrivalDate: '2026-11-12',
        departureDate: '2026-11-14',
        quantity: 2,
        adults: 1,
        childrenPerRoom: 0,
        childrenAges: [],
        board: 'room_only',
        roomCodes: ['SKNG'],
      },
    ];
    const { run, fence, db: quoteDb } = await provisionalWorkerQuote(Promise.resolve(), undefined, {
      groups,
      dinnerAllowanceMinor: 12_500,
      dinnerAllowanceUnit: 'per_person_per_night',
      dinnerAllowanceLabel: 'Set menu',
      dinnerAllowanceGroupIds: ['g1'],
    });
    workflowMocks.executeStaffQuote.mockImplementationOnce((prepared: { authorizationId: string }) =>
      syntheticRevision(
        ['600.00', '600.00'],
        'Room Only R',
        'SKNG',
        undefined,
        '2026-11-12',
        prepared.authorizationId,
      ),
    );

    await expect(executeHmsJob({ run, fence, db: quoteDb })).resolves.toBe('succeeded');

    const readResult = jobMocks.markSucceeded.mock.calls[0]?.[0].readResult;
    expect(readResult).toMatchObject({
      dinnerAddOn: {
        label: 'Dinner add-on (Set menu)',
        amountMinor: 12_500,
        unit: 'per_person_per_night',
        totalMinor: 50_000,
      },
      totalMinor: 290_000,
    });
    expect(readResult).not.toHaveProperty('dinnerFallbackGroupIds');
  });

  it.each([
    ['missing staffQuoteUser', { userId: user.id }],
    ['missing userId', { staffQuoteUser: user }],
    ['mismatched userId', { userId: 'staff-2', staffQuoteUser: user }],
    ['mismatched staffQuoteUser id', { userId: user.id, staffQuoteUser: { ...user, id: 'staff-2' } }],
  ])('%s dead-letters the run without invoking the quote runner', async (_label, metrics) => {
    const { run, fence } = fixture(metrics);

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('dead_letter');

    expect(jobMocks.runStaffQuote).not.toHaveBeenCalled();
    expect(jobMocks.markDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: 'SCHEMA_DRIFT',
        lastError: 'staff_quote_identity_unavailable',
      }),
      db,
    );
    expect(jobMocks.markRetry).not.toHaveBeenCalled();
    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
  });

  it('validates the job request and persists the complete read result under the trusted actor', async () => {
    const { run, fence, request } = fixture();
    const result = {
      status: 'ready',
      workflowRunId: 'workflow-1',
      revisionRef: 'revision-1',
      messageId: STAFF_QUOTE_INPUT.messageId,
      threadId: 'thread-1',
      factRefs: [],
      selectionEpoch: STAFF_QUOTE_INPUT.selectionEpoch,
      inputRevision: STAFF_QUOTE_INPUT.inputRevision,
      inputDigest: 'b'.repeat(64),
      totalMinor: 240_000,
      currency: 'ZAR',
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-14',
      description: 'Standard King; Room Only',
      rateOptions: [{ id: 'rate-1' }],
      rowRates: [{ groupId: 'single' }],
    };
    expect(hmsJobRequestSchema.safeParse(request).success).toBe(true);
    jobMocks.runStaffQuote.mockImplementation(async (...args: unknown[]) => {
      const transaction = args[2] as DB;
      const options = args[3] as {
        commitQueuedResult?: (value: Record<string, unknown>, transaction: DB) => Promise<boolean>;
      };
      await options.commitQueuedResult?.(result, transaction);
      return result;
    });

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('succeeded');

    expect(jobMocks.runStaffQuote).toHaveBeenCalledWith(
      STAFF_QUOTE_INPUT,
      { transportId: run.transportId, user },
      db,
      expect.objectContaining({
        signal: undefined,
        deadlineAt: fence.deadlineAt.getTime(),
        commitQueuedResult: expect.any(Function),
      }),
    );
    expect(jobMocks.markSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        readResult: expect.objectContaining({
          ...result,
          kind: 'staff_quote',
          asOf: expect.any(String),
        }),
      }),
      db,
    );
    expect(jobMocks.markRetry).not.toHaveBeenCalled();
  });

  it('retries a prepared quote after a transient reader failure', async () => {
    const { run, fence } = preparedFixture();
    jobMocks.runStaffQuote.mockRejectedValue(new Error('Target page, context or browser has been closed'));

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('retry_wait');

    expect(jobMocks.runStaffQuote).toHaveBeenCalledOnce();
    expect(jobMocks.markRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 1,
        failureClass: 'TRANSIENT_NETWORK',
        lastError: 'staff quote execution failed',
      }),
      db,
    );
    expect(jobMocks.markDeadLetter).not.toHaveBeenCalled();
  });

  it('does not execute a prepared quote after the transient retry budget is spent', async () => {
    const { run, fence } = preparedFixture();
    run.attempts = 3;

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('dead_letter');

    expect(jobMocks.runStaffQuote).not.toHaveBeenCalled();
    expect(jobMocks.markDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: 'prepared_quote_attempt_exhausted' }),
      db,
    );
    expect(jobMocks.markRetry).not.toHaveBeenCalled();
  });

  it('tries the property lock once for a prepared quote and requeues a busy lock uncharged', async () => {
    const { run, fence, db: quoteDb } = await provisionalWorkerQuote(Promise.resolve(), undefined, {}, true);
    const withLock = vi.fn(async (_callback: () => Promise<unknown>, _options: unknown) => {
      throw new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE);
    });
    quoteRunMocks.createPropertyReadLock.mockReturnValue({ withLock });

    await expect(executeHmsJob({ run: { ...run, createdAt: new Date() }, fence, db: quoteDb })).resolves.toBe('retry_wait');

    expect(withLock).toHaveBeenCalledOnce();
    expect(withLock).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ tryOnce: true, deadlineAt: fence.deadlineAt.getTime() }),
    );
    expect(jobMocks.markRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 0, failureClass: 'HMS_LOCK_BUSY', resetDeadline: true }),
      quoteDb,
    );
    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
  });

  it.each([
    ['before the quote read', [false, true], 0],
    ['after resolving a quote task', [false, false, true], 1],
  ])('aborts a prepared quote when a user quote queues %s', async (_boundary, activeChecks, quoteCalls) => {
    const { run, fence, db: quoteDb, inserted } = await provisionalWorkerQuote(
      Promise.resolve(),
      undefined,
      {},
      true,
    );
    for (const active of activeChecks) quoteQueueMocks.staffQuoteInFlight.mockResolvedValueOnce(active);
    quoteRunMocks.createPropertyReadLock.mockReturnValue({
      withLock: (callback: () => Promise<unknown>) => callback(),
    });
    quoteRunMocks.getServices.mockReturnValue({ resolveQuoteTask: async () => ({}) });
    workflowMocks.executeStaffQuote.mockImplementation(async (
      prepared: { authorizationId: string; context: unknown },
      services: { resolveQuoteTask?: (context: unknown) => Promise<unknown> },
    ) => {
      await services.resolveQuoteTask?.(prepared.context);
      return {
        id: 'revision-1',
        authorizationId: prepared.authorizationId,
        totalMinor: 240_000,
        currency: 'ZAR',
        groups: [{ arrivalDate: '2026-11-12', departureDate: '2026-11-14', context: {} }],
      };
    });

    await expect(executeHmsJob({ run, fence, db: quoteDb })).resolves.toBe('dead_letter');

    expect(quoteQueueMocks.staffQuoteInFlight).toHaveBeenCalledTimes(activeChecks.length);
    expect(workflowMocks.executeStaffQuote).toHaveBeenCalledTimes(quoteCalls);
    expect(jobMocks.markDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: 'STAFF_QUOTE_ACTIVE',
        lastError: 'prepared_quote_yielded_to_staff_quote',
      }),
      quoteDb,
    );
    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
    expect(inserted.filter((entry) => entry.table === aiWorkflowRun)).toHaveLength(0);
  });

  it('keeps the worker deadline-bounded approval context and retries an unknown reader failure', async () => {
    const mail = {
      id: STAFF_QUOTE_INPUT.messageId,
      transportId: TRANSPORT_ID,
      threadId: 'thread-1',
      direction: 'inbound',
      subject: 'Accommodation enquiry',
      textBody: 'Please quote accommodation for the selected dates.',
      htmlBody: null,
      receivedAt: new Date('2026-10-12T08:00:00.000Z'),
      sentAt: null,
      createdAt: new Date('2026-10-12T08:00:00.000Z'),
    };
    const input = { ...STAFF_QUOTE_INPUT, sourceHash: staffQuoteSourceHash(mail) };
    const { run, fence } = fixture();
    run.readRequest = { kind: 'staff_quote', input } as unknown as AiWorkflowRun['readRequest'];
    const { db } = staffQuoteRunDb(mail);
    const authorizeContext = vi.fn();
    let approvalContext: unknown;
    let thrown: unknown;
    const readQuote = vi.fn(async () => {
      throw new Error('synthetic_native_reader_reached');
    });
    const actualRun = await vi.importActual<typeof import('../src/ai/staff-quote-run.js')>(
      '../src/ai/staff-quote-run.js',
    );
    jobMocks.runStaffQuote.mockImplementation(async (...args: Parameters<typeof actualRun.runStaffQuote>) => {
      try {
        return await actualRun.runStaffQuote(...args);
      } catch (error) {
        thrown = error;
        throw error;
      }
    });
    quoteRunMocks.readConfiguration.mockReturnValue({
      tenantId: 'synthetic-hotel',
      owner: { propertyCode: 'HRCEN' },
      outputDir: '/tmp/synthetic-staff-quote',
    });
    quoteRunMocks.snapshotRowPrices.mockResolvedValue([]);
    quoteRunMocks.createPropertyReadLock.mockReturnValue({
      withLock: (callback: () => Promise<unknown>) => callback(),
    });
    quoteRunMocks.getServices.mockImplementation((options: Record<string, any>, approval: any) => {
      approvalContext = approval.context;
      return createReservationistBusinessServices(
        {
          authorizationId: options.authorizationId,
          authorizeContext: async (context) => {
            authorizeContext(context);
            return options.authorizeContext(context);
          },
          readQuote,
          resolvePolicy: async () => null,
          signer: options.signer,
        },
        approval,
      );
    });
    vi.stubEnv('DATABASE_URL', 'postgres://127.0.0.1/synthetic');
    vi.stubEnv('QUOTE_TRACE_ASYNC', 'off');

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('retry_wait');

    expect(jobMocks.runStaffQuote).toHaveBeenCalledWith(
      input,
      { transportId: run.transportId, user },
      db,
      expect.objectContaining({
        signal: undefined,
        deadlineAt: fence.deadlineAt.getTime(),
        commitQueuedResult: expect.any(Function),
      }),
    );
    expect(authorizeContext).toHaveBeenCalledOnce();
    expect(authorizeContext.mock.calls[0]?.[0]).toBe(approvalContext);
    expect(readQuote).toHaveBeenCalledOnce();
    expect(thrown).toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: {
        name: 'Error',
        code: 'synthetic_native_reader_reached',
        message: 'Staff quote execution failed.',
        reason: 'synthetic_native_reader_reached',
      },
    });
    expect(Object.keys((thrown as Error & { cause: Record<string, unknown> }).cause)).toEqual([
      'name',
      'code',
      'message',
      'reason',
    ]);
    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
    expect(jobMocks.markRetry).toHaveBeenCalledWith(
      expect.objectContaining({ failureClass: 'TRANSIENT_NETWORK' }),
      db,
    );
  });

  it('waits for provisional trace persistence before marking the queued quote ready', async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const { run, fence, db: quoteDb, inserted } = await provisionalWorkerQuote(finished);
    jobMocks.markSucceeded.mockImplementation(async () => {
      expect(inserted.some((entry) => entry.table === aiWorkflowRun)).toBe(true);
      return { id: run.id };
    });

    const job = executeHmsJob({ run, fence, db: quoteDb });
    await delay(15);

    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
    expect(inserted.some((entry) => entry.table === aiWorkflowRun)).toBe(false);
    finish();
    await expect(job).resolves.toBe('succeeded');
    expect(inserted.some((entry) => entry.table === aiWorkflowRun)).toBe(true);
    expect(jobMocks.markSucceeded).toHaveBeenCalledOnce();
  });

  it('retries a provisional trace failure instead of marking a ready result', async () => {
    let fail!: (error: Error) => void;
    let thrown: unknown;
    const finished = new Promise<void>((_resolve, reject) => (fail = reject));
    const { run, fence, db: quoteDb, inserted } = await provisionalWorkerQuote(finished, (error) => {
      thrown = error;
    });

    const job = executeHmsJob({ run, fence, db: quoteDb });
    await delay(15);
    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
    fail(new Error('staff_quote_trace_finish_failed'));

    await expect(job).resolves.toBe('retry_wait');
    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
    expect(inserted.some((entry) => entry.table === aiWorkflowRun)).toBe(false);
    expect(thrown).toMatchObject({
      code: 'staff_quote_native_unavailable',
      cause: {
        name: 'Error',
        code: 'staff_quote_trace_finish_failed',
        message: 'Staff quote execution failed.',
      },
    });
    expect(Object.keys((thrown as Error & { cause: Record<string, unknown> }).cause)).toEqual([
      'name',
      'code',
      'message',
    ]);
    expect(jobMocks.markRetry).toHaveBeenCalledWith(
      expect.objectContaining({ failureClass: 'TRANSIENT_NETWORK' }),
      quoteDb,
    );
  });

  it('does not persist quote artifacts after the read-tool claim is fenced out', async () => {
    const { run, fence, db: quoteDb, inserted } = await provisionalWorkerQuote(Promise.resolve());
    jobMocks.markSucceeded.mockResolvedValueOnce(null);

    await expect(executeHmsJob({ run, fence, db: quoteDb })).resolves.toBe('retry_wait');

    expect(inserted.filter((entry) => entry.table === aiWorkflowRun)).toHaveLength(0);
    expect(jobMocks.markSucceeded).toHaveBeenCalledOnce();
    expect(jobMocks.markSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        claimOwner: fence.claimOwner,
        claimToken: fence.claimToken,
        expectedStates: ['running'],
        readResult: expect.objectContaining({ kind: 'staff_quote', status: 'ready' }),
      }),
      quoteDb,
    );
    expect(jobMocks.markRetry).toHaveBeenCalledWith(
      expect.objectContaining({ failureClass: 'TRANSIENT_NETWORK' }),
      quoteDb,
    );
  });

  it('stores a business refusal as a successful job without retrying', async () => {
    const { run, fence } = fixture();
    const refusal = new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'HMS has no rate for this meal plan under BAR.',
    });
    jobMocks.runStaffQuote.mockRejectedValue(refusal);

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('succeeded');

    expect(jobMocks.markSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        readResult: expect.objectContaining({
          ok: false,
          code: 'PRECONDITION_FAILED',
          message: 'HMS has no rate for this meal plan under BAR.',
        }),
      }),
      db,
    );
    expect(jobMocks.markRetry).not.toHaveBeenCalled();
  });

  it.each([
    [
      'missing party',
      new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'HMS did not confirm the picked company or agency. Search again and pick it.',
        cause: { reason: 'not_found' },
      }),
    ],
    [
      'invalid extras',
      new TRPCError({
        code: 'BAD_REQUEST',
        message: 'The extras on this quote are not valid. Check the amounts and counts, then run the quote again.',
        cause: { reason: 'invalid_extras' },
      }),
    ],
  ])('stores a catalog refusal with a wrapped cause as a successful job: %s', async (_label, error) => {
    const { run, fence } = fixture();
    jobMocks.runStaffQuote.mockRejectedValue(error);

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('succeeded');

    expect(jobMocks.markSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        readResult: expect.objectContaining({ ok: false, code: error.code }),
      }),
      db,
    );
    expect(jobMocks.markRetry).not.toHaveBeenCalled();
  });

  it('retries an unavailable party verification instead of caching it as a refusal', async () => {
    const { run, fence } = fixture();
    jobMocks.runStaffQuote.mockRejectedValue(
      new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: "Nava couldn't check the picked company or agency in HMS. Try again.",
        cause: { reason: 'unverified' },
      }),
    );

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('retry_wait');

    expect(jobMocks.markRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, failureClass: 'TRANSIENT_NETWORK' }),
      db,
    );
    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
  });

  it('retries a wrapped property-lock deadline instead of persisting a refusal', async () => {
    const { run, fence } = fixture();
    const error = Object.assign(new Error('staff quote failed'), {
      code: 'PRECONDITION_FAILED',
      cause: {
        name: 'Error',
        code: 'HMS_LOCK_BUSY',
        message: PROPERTY_READ_LOCK_DEADLINE_MESSAGE,
      },
    });
    jobMocks.runStaffQuote.mockRejectedValue(error);

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('retry_wait');

    expect(jobMocks.markRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, failureClass: 'HMS_LOCK_BUSY' }),
      db,
    );
    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
  });

  it('retries party-verification lock busy instead of persisting it as a business refusal', async () => {
    const { run, fence } = fixture();
    const error = new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'HMS is busy with another run. Try again in a minute.',
      cause: { name: 'Error', code: 'HMS_LOCK_BUSY', message: 'HMS party lookup lock busy' },
    });
    jobMocks.runStaffQuote.mockRejectedValue(error);

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('retry_wait');

    expect(jobMocks.markRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, failureClass: 'HMS_LOCK_BUSY' }),
      db,
    );
    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
  });

  it.each([
    ['closed Playwright target', new Error('Target page, context or browser has been closed')],
    ['socket hang up', new Error('socket hang up')],
    ['ECONNREFUSED', Object.assign(new Error('native connection failed'), { code: 'ECONNREFUSED' })],
    ['EPIPE', Object.assign(new Error('native pipe failed'), { code: 'EPIPE' })],
    ['Postgres serialization failure', { code: '40001' }],
    ['Postgres deadlock', { code: '40P01' }],
    ['sanitized closed target cause', new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Staff quote failed.',
      cause: { name: 'Error', code: 'TARGET_CLOSED', message: 'Staff quote execution failed.' },
    })],
    ['sanitized timeout cause', new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Staff quote failed.',
      cause: { name: 'Error', code: 'TIMEOUT', message: 'Staff quote execution failed.' },
    })],
    ['sanitized transient cause', new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Staff quote failed.',
      cause: { name: 'Error', code: 'EPIPE', message: 'Staff quote execution failed.' },
    })],
    ['unknown error', new Error('unexpected_native_quote_error')],
    ['internal tRPC error', new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal failure.' })],
    ['unexpected EIO copied onto reason', new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Staff quote execution failed.',
      cause: { name: 'Error', code: 'EIO', reason: 'EIO', message: 'Staff quote execution failed.' },
    })],
  ])('retries transient staff quote failures: %s', async (_label, error) => {
    const { run, fence } = fixture();
    jobMocks.runStaffQuote.mockRejectedValue(error);

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('retry_wait');

    expect(jobMocks.markRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, failureClass: 'TRANSIENT_NETWORK' }),
      db,
    );
    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
  });

  it('does not spend the staff quote retry budget on an aborted worker shutdown', async () => {
    const { run, fence } = fixture();
    run.attempts = 2;
    const shutdown = new AbortController();
    shutdown.abort();
    jobMocks.runStaffQuote.mockRejectedValue(
      new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Staff quote execution failed.',
        cause: { name: 'AbortError', code: 'ABORT_ERR', message: 'Staff quote execution failed.' },
      }),
    );

    await expect(executeHmsJob({ run, fence, signal: shutdown.signal, db })).resolves.toBe(
      'retry_wait',
    );

    expect(jobMocks.markRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 2,
        failureClass: 'WORKER_SHUTDOWN',
        lastError: 'worker shutdown',
        resetDeadline: true,
      }),
      db,
    );
    expect(jobMocks.markDeadLetter).not.toHaveBeenCalled();
    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
  });

  it.each([
    ['staff_quote_failed', new Error('staff_quote_failed')],
    ['native no-match', new Error('native_quote_no_matching_rate')],
  ])('stores a recognized staff quote business code as a refusal: %s', async (_label, error) => {
    const { run, fence } = fixture();
    jobMocks.runStaffQuote.mockRejectedValue(error);
    const code = error.message;

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('succeeded');

    expect(jobMocks.markSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        readResult: expect.objectContaining({ ok: false, code }),
      }),
      db,
    );
    expect(jobMocks.markRetry).not.toHaveBeenCalled();
  });
});

describe('runStaffQuote property installation', () => {
  function mailFor(transportId: string) {
    return {
      id: STAFF_QUOTE_INPUT.messageId,
      transportId,
      threadId: 'thread-1',
      direction: 'inbound',
      subject: 'Accommodation enquiry',
      textBody: 'Please quote accommodation for the selected dates.',
      htmlBody: null,
      receivedAt: new Date('2026-10-12T08:00:00.000Z'),
      sentAt: null,
      createdAt: new Date('2026-10-12T08:00:00.000Z'),
      fromAddress: 'guest@example.invalid',
      toAddresses:
        transportId === 'transport-davinci'
          ? ['davinci@legacyhotels.co.za']
          : ['centurion@legacyhotels.co.za'],
    };
  }

  async function runOn(transportId: string) {
    const actual = await vi.importActual<typeof import('../src/ai/staff-quote-run.js')>(
      '../src/ai/staff-quote-run.js',
    );
    const mail = mailFor(transportId);
    const input = staffQuoteInput.parse({
      ...STAFF_QUOTE_INPUT,
      sourceHash: staffQuoteSourceHash(mail),
    });
    return actual.runStaffQuote(input, { transportId, user }, staffQuoteRunDb(mail).db);
  }

  it('uses the HRDAV installation for a Da Vinci transport when the quote flag is on', async () => {
    vi.stubEnv('HMS_DAVINCI_MAKE_QUOTE', 'on');
    vi.stubEnv('DATABASE_URL', '');
    quoteRunMocks.readConfiguration.mockReturnValue({
      tenantId: 'synthetic-hotel',
      owner: { propertyCode: 'HRDAV' },
    });
    await expect(runOn('transport-davinci')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Staff quotation database unavailable',
    });
    expect(quoteRunMocks.readConfiguration.mock.calls).toEqual([['HRDAV']]);
  });

  it('allows an HRDAV quote to reach and recheck the reader without saved child evidence', async () => {
    vi.stubEnv('HMS_DAVINCI_MAKE_QUOTE', 'on');
    vi.stubEnv('DATABASE_URL', 'postgres://127.0.0.1/synthetic');
    const actual = await vi.importActual<typeof import('../src/ai/staff-quote-run.js')>('../src/ai/staff-quote-run.js');
    const mail = mailFor('transport-davinci');
    const input = staffQuoteInput.parse({ ...STAFF_QUOTE_INPUT, sourceHash: staffQuoteSourceHash(mail),
      groups: [{ ...STAFF_QUOTE_INPUT.groups[0], childrenPerRoom: null }] });
    const quoteDb = staffQuoteRunDb(mail, input.groups);
    quoteDb.occupancyState['stays[s_test].rows[single].childrenPerRoom'] = null;
    quoteRunMocks.readConfiguration.mockReturnValue({ tenantId: 'synthetic-hotel', owner: { propertyCode: 'HRDAV' } });
    quoteRunMocks.snapshotRowPrices.mockResolvedValue([]);
    quoteRunMocks.createPropertyReadLock.mockReturnValue({ withLock: (callback: () => Promise<unknown>) => callback() });
    quoteRunMocks.getServices.mockReturnValue({});
    let stillCurrent = false;
    workflowMocks.executeStaffQuote.mockImplementation(async (_prepared, _services, isCurrent) => {
      stillCurrent = await isCurrent();
      throw new Error('synthetic_reader_stop');
    });
    await expect(actual.runStaffQuote(input, { transportId: 'transport-davinci', user }, quoteDb.db))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(workflowMocks.executeStaffQuote).toHaveBeenCalledOnce();
    expect(stillCurrent).toBe(true);
  });

  it('refuses a Da Vinci quote when the HRDAV install is missing and does not read Centurion', async () => {
    vi.stubEnv('HMS_DAVINCI_MAKE_QUOTE', 'on');
    quoteRunMocks.readConfiguration.mockImplementation((propertyCode?: string) => {
      if (propertyCode === 'HRDAV') throw new Error('staff_quote_installation_unavailable');
      return { tenantId: 'synthetic-hotel', owner: { propertyCode: 'HRCEN' } };
    });
    await expect(runOn('transport-davinci')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Staff quotation installation unavailable',
    });
    expect(quoteRunMocks.readConfiguration.mock.calls).toEqual([['HRDAV']]);
  });

  it('leaves Centurion quotes on the Centurion installation', async () => {
    vi.stubEnv('DATABASE_URL', '');
    quoteRunMocks.readConfiguration.mockReturnValue({
      tenantId: 'synthetic-hotel',
      owner: { propertyCode: 'HRCEN' },
    });
    await expect(runOn('transport-centurion')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Staff quotation database unavailable',
    });
    expect(quoteRunMocks.readConfiguration.mock.calls).toEqual([['HRCEN']]);
  });

  it('refuses when the loaded installation owner.propertyCode does not match the quote target', async () => {
    vi.stubEnv('HMS_DAVINCI_MAKE_QUOTE', 'on');
    quoteRunMocks.readConfiguration.mockReturnValue({
      tenantId: 'synthetic-hotel',
      owner: { propertyCode: 'HRCEN' },
    });
    await expect(runOn('transport-davinci')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Staff quotation installation unavailable',
    });
    expect(quoteRunMocks.readConfiguration.mock.calls).toEqual([['HRDAV']]);
  });

  it('reaches HRDAV staff quote services for a Da Vinci transport when the quote flag is on', async () => {
    vi.stubEnv('HMS_DAVINCI_MAKE_QUOTE', 'on');
    vi.stubEnv('DATABASE_URL', 'postgres://127.0.0.1/synthetic');
    const actual = await vi.importActual<typeof import('../src/ai/staff-quote-run.js')>(
      '../src/ai/staff-quote-run.js',
    );
    const mail = mailFor('transport-davinci');
    const input = staffQuoteInput.parse({
      ...STAFF_QUOTE_INPUT,
      sourceHash: staffQuoteSourceHash(mail),
    });
    quoteRunMocks.readConfiguration.mockReturnValue({
      tenantId: 'synthetic-hotel',
      owner: { propertyCode: 'HRDAV' },
      outputDir: '/tmp/synthetic-staff-quote',
    });
    quoteRunMocks.snapshotRowPrices.mockResolvedValue([]);
    quoteRunMocks.createPropertyReadLock.mockReturnValue({
      withLock: (callback: () => Promise<unknown>) => callback(),
    });
    quoteRunMocks.getServices.mockReturnValue({});
    workflowMocks.executeStaffQuote.mockResolvedValue({
      id: 'revision-1',
      authorizationId: 'auth-1',
      totalMinor: 240_000,
      currency: 'ZAR',
      groups: [
        {
          arrivalDate: input.groups[0]!.arrivalDate,
          departureDate: input.groups[0]!.departureDate,
          context: {},
        },
      ],
    });
    await actual
      .runStaffQuote(input, { transportId: 'transport-davinci', user }, staffQuoteRunDb(mail).db)
      .catch(() => undefined);
    expect(quoteRunMocks.readConfiguration.mock.calls).toEqual([['HRDAV']]);
    expect(quoteRunMocks.getServices).toHaveBeenCalledWith(
      expect.objectContaining({ propertyCode: 'HRDAV' }),
      expect.anything(),
    );
  });
});
