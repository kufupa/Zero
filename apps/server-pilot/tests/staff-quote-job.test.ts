import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReservationistBusinessServices } from '../src/ai/reservationist-business-services.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { aiDraftGeneration, aiWorkflowRun, message } from '../src/db/schema/mail.js';
import type { AiWorkflowRun } from '../src/ai/run-ledger.js';
import type { DB } from '../src/db/client.js';
import { TRPCError } from '@trpc/server';
import { setTimeout as delay } from 'node:timers/promises';

const jobMocks = vi.hoisted(() => ({
  runStaffQuote: vi.fn(),
  markSucceeded: vi.fn(),
  markRetry: vi.fn(),
  markDeadLetter: vi.fn(),
}));

const quoteRunMocks = vi.hoisted(() => ({
  readConfiguration: vi.fn(),
  getServices: vi.fn(),
  snapshotRowPrices: vi.fn(),
  createPropertyReadLock: vi.fn(),
}));

const workflowMocks = vi.hoisted(() => ({ executeStaffQuote: vi.fn() }));
const quoteLineMocks = vi.hoisted(() => ({
  deriveQuoteLines: vi.fn(),
  pricedRoomTotal: vi.fn(),
  rowRatesFor: vi.fn(),
}));

vi.mock('../src/ai/staff-quote-run.js', () => ({
  runStaffQuote: jobMocks.runStaffQuote,
  staffQuoteFailureCode: () => 'staff_quote_failed',
  staffQuoteFailureMessage: () => 'Staff quote could not be completed.',
}));

vi.mock('../src/ai/staff-quote-installation.js', () => ({
  readInstalledStaffQuoteConfiguration: quoteRunMocks.readConfiguration,
  getInstalledStaffQuoteServices: quoteRunMocks.getServices,
}));

vi.mock('../src/ai/staff-quote-workflow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/staff-quote-workflow.js')>()),
  executeStaffQuote: workflowMocks.executeStaffQuote,
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

import { executeHmsJob, hmsJobRequestSchema, HMS_JOB_PRIORITY_USER } from '../src/ai/hms-jobs.js';
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

function fixture(metrics: Record<string, unknown> = { userId: user.id, staffQuoteUser: user }) {
  const request = { kind: 'staff_quote', input: STAFF_QUOTE_INPUT };
  const run = {
    id: 'job-1',
    transportId: 'transport-1',
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

beforeEach(async () => {
  jobMocks.markSucceeded.mockReset().mockResolvedValue({ id: 'job-1' });
  jobMocks.markRetry.mockReset().mockResolvedValue({ id: 'job-1' });
  jobMocks.markDeadLetter.mockReset().mockResolvedValue({ id: 'job-1' });
  const workflow = await vi.importActual<typeof import('../src/ai/staff-quote-workflow.js')>(
    '../src/ai/staff-quote-workflow.js',
  );
  workflowMocks.executeStaffQuote.mockReset().mockImplementation(workflow.executeStaffQuote);
  quoteLineMocks.deriveQuoteLines.mockReset().mockReturnValue([{ description: 'Synthetic room' }]);
  quoteLineMocks.pricedRoomTotal
    .mockReset()
    .mockImplementation((revision: { totalMinor: number }) => revision.totalMinor);
  quoteLineMocks.rowRatesFor.mockReset().mockReturnValue([]);
});

afterEach(() => {
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

function staffQuoteRunDb(mail: Record<string, unknown>) {
  let latestGenerationId: string | undefined;
  const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const updated: unknown[] = [];
  const rowsFor = (table: unknown) =>
    table === message ? [mail] : table === aiDraftGeneration && latestGenerationId ? [{ id: latestGenerationId }] : [];
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
    transaction: (callback: (transaction: unknown) => Promise<unknown>) => callback(db),
  };
  return { db: db as unknown as DB, inserted, updated };
}

async function provisionalWorkerQuote(finished: Promise<void>) {
  const actualRun = await vi.importActual<typeof import('../src/ai/staff-quote-run.js')>(
    '../src/ai/staff-quote-run.js',
  );
  jobMocks.runStaffQuote.mockImplementation(actualRun.runStaffQuote);
  const mail = {
    id: STAFF_QUOTE_INPUT.messageId,
    transportId: 'transport-1',
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
  const quoteDb = staffQuoteRunDb(mail);
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
        arrivalDate: STAFF_QUOTE_INPUT.groups[0].arrivalDate,
        departureDate: STAFF_QUOTE_INPUT.groups[0].departureDate,
        context: {},
      },
    ],
  }));
  vi.stubEnv('DATABASE_URL', 'postgres://127.0.0.1/synthetic');
  vi.stubEnv('QUOTE_TRACE_ASYNC', 'on');
  return { run, fence, db: quoteDb.db, inserted: quoteDb.inserted };
}

describe('staff_quote HMS job execution', () => {
  it.each([
    ['missing staffQuoteUser', { userId: user.id }],
    ['missing userId', { staffQuoteUser: user }],
    ['mismatched userId', { userId: 'staff-2', staffQuoteUser: user }],
    ['mismatched staffQuoteUser id', { userId: user.id, staffQuoteUser: { ...user, id: 'staff-2' } }],
  ])('%s refuses the run without invoking the quote runner', async (_label, metrics) => {
    const { run, fence } = fixture(metrics);

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('succeeded');

    expect(jobMocks.runStaffQuote).not.toHaveBeenCalled();
    expect(jobMocks.markSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        readResult: expect.objectContaining({ ok: false, code: 'STAFF_QUOTE_SCOPE_INVALID' }),
      }),
      db,
    );
    expect(jobMocks.markRetry).not.toHaveBeenCalled();
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
    jobMocks.runStaffQuote.mockResolvedValue(result);

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('succeeded');

    expect(jobMocks.runStaffQuote).toHaveBeenCalledWith(
      STAFF_QUOTE_INPUT,
      { transportId: run.transportId, user },
      db,
      { signal: undefined, deadlineAt: fence.deadlineAt.getTime() },
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

  it('keeps the worker deadline-bounded approval context valid', async () => {
    const mail = {
      id: STAFF_QUOTE_INPUT.messageId,
      transportId: 'transport-1',
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
    const readQuote = vi.fn(async () => {
      throw new Error('synthetic_native_reader_reached');
    });
    const actualRun = await vi.importActual<typeof import('../src/ai/staff-quote-run.js')>(
      '../src/ai/staff-quote-run.js',
    );
    jobMocks.runStaffQuote.mockImplementation(actualRun.runStaffQuote);
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

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('succeeded');

    expect(jobMocks.runStaffQuote).toHaveBeenCalledWith(
      input,
      { transportId: run.transportId, user },
      db,
      { signal: undefined, deadlineAt: fence.deadlineAt.getTime() },
    );
    expect(authorizeContext).toHaveBeenCalledOnce();
    expect(authorizeContext.mock.calls[0]?.[0]).toBe(approvalContext);
    expect(readQuote).toHaveBeenCalledOnce();
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
    const finished = new Promise<void>((_resolve, reject) => (fail = reject));
    const { run, fence, db: quoteDb, inserted } = await provisionalWorkerQuote(finished);

    const job = executeHmsJob({ run, fence, db: quoteDb });
    await delay(15);
    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
    fail(new Error('staff_quote_trace_finish_failed'));

    await expect(job).resolves.toBe('retry_wait');
    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
    expect(inserted.some((entry) => entry.table === aiWorkflowRun)).toBe(false);
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

  it('retries a wrapped property-lock deadline instead of persisting a refusal', async () => {
    const { run, fence } = fixture();
    const error = Object.assign(new Error('staff quote failed'), {
      code: 'PRECONDITION_FAILED',
      cause: new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE),
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
      cause: Object.assign(new Error('HMS party lookup lock busy'), { code: 'HMS_LOCK_BUSY' }),
    });
    jobMocks.runStaffQuote.mockRejectedValue(error);

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('retry_wait');

    expect(jobMocks.markRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, failureClass: 'HMS_LOCK_BUSY' }),
      db,
    );
    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
  });

  it('retries known transient native read errors', async () => {
    const { run, fence } = fixture();
    jobMocks.runStaffQuote.mockRejectedValue(new Error('native browser ECONNRESET'));

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('retry_wait');

    expect(jobMocks.markRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, failureClass: 'TRANSIENT_NETWORK' }),
      db,
    );
    expect(jobMocks.markSucceeded).not.toHaveBeenCalled();
  });
});
