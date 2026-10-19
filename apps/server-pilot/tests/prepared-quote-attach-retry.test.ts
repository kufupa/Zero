import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { AiWorkflowRun } from '../src/ai/run-ledger.js';
import type { DB } from '../src/db/client.js';

const jobMocks = vi.hoisted(() => ({
  runStaffQuote: vi.fn(),
  markSucceeded: vi.fn(),
  markRetry: vi.fn(),
  markDeadLetter: vi.fn(),
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

vi.mock('../src/ai/run-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/run-ledger.js')>()),
  markAiRunSucceeded: jobMocks.markSucceeded,
  markAiRunRetry: jobMocks.markRetry,
  markAiRunDeadLetter: jobMocks.markDeadLetter,
}));

vi.mock('../src/hms/mailbox-hms-origin-bind.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hms/mailbox-hms-origin-bind.js')>()),
  guardCenturionHmsMailboxOrigin: async () => ({ ok: true }),
}));

import { executeHmsJob, HMS_JOB_PRIORITY_PREFETCH } from '../src/ai/hms-jobs.js';
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

const db = {} as DB;

function preparedRun(overrides: Partial<AiWorkflowRun> = {}) {
  vi.stubEnv('HMS_JOB_QUEUE', 'on');
  vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
  const request = { kind: 'staff_quote', input: STAFF_QUOTE_INPUT };
  const run = {
    id: 'job-1',
    transportId: 'transport-1',
    threadId: 'thread-1',
    runKind: 'read_tool',
    promptVersion: HMS_JOB_PROMPT_VERSION,
    priority: HMS_JOB_PRIORITY_PREFETCH,
    attempts: 0,
    state: 'running',
    readRequest: request,
    metrics: { userId: null, quotePrepared: true },
    ...overrides,
  } as unknown as AiWorkflowRun;
  const fence = {
    runId: run.id,
    claimOwner: 'worker-1',
    claimToken: 'claim-1',
    deadlineAt: new Date(Date.now() + 7 * 60_000),
  };
  return { run, fence };
}

beforeEach(() => {
  jobMocks.markSucceeded.mockReset().mockResolvedValue({ id: 'job-1' });
  jobMocks.markRetry.mockReset().mockResolvedValue({ id: 'job-1' });
  jobMocks.markDeadLetter.mockReset().mockResolvedValue({ id: 'job-1' });
});

afterEach(() => {
  jobMocks.runStaffQuote.mockReset();
  vi.unstubAllEnvs();
});

describe('prepared quote attach-phase retry', () => {
  it('does not retry a prepared quote after a non-attach transient failure', async () => {
    const { run, fence } = preparedRun();
    jobMocks.runStaffQuote.mockRejectedValue(new Error('Target page, context or browser has been closed'));

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('dead_letter');

    expect(jobMocks.runStaffQuote).toHaveBeenCalledOnce();
    expect(jobMocks.markDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ failureClass: 'TRANSIENT_NETWORK', lastError: 'staff quote execution failed' }),
      db,
    );
    expect(jobMocks.markRetry).not.toHaveBeenCalled();
  });

  it('requeues a prepared quote once when the reader fails in the attach phase', async () => {
    const { run, fence } = preparedRun();
    jobMocks.runStaffQuote.mockRejectedValue(
      new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: "HMS didn't respond as expected. Try again; if it fails twice, quote in HMS directly.",
        cause: {
          name: 'TimeoutError',
          code: 'EXECUTION_FAILURE',
          message: 'Staff quote execution failed.',
          phase: 'attach',
        },
      }),
    );

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('retry_wait');

    expect(jobMocks.runStaffQuote).toHaveBeenCalledOnce();
    expect(jobMocks.markRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 1,
        failureClass: 'TRANSIENT_NETWORK',
        lastError: 'staff quote attach failed',
      }),
      db,
    );
    expect(jobMocks.markDeadLetter).not.toHaveBeenCalled();
  });

  it('runs a prepared quote again after one attach failure', async () => {
    const { run, fence } = preparedRun({ attempts: 1, lastError: 'staff quote attach failed' });
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
    jobMocks.runStaffQuote.mockImplementation(async (...args: unknown[]) => {
      const options = args[3] as {
        commitQueuedResult?: (value: Record<string, unknown>, transaction: DB) => Promise<boolean>;
      };
      await options.commitQueuedResult?.(result, args[2] as DB);
      return result;
    });

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('succeeded');

    expect(jobMocks.runStaffQuote).toHaveBeenCalledOnce();
    expect(jobMocks.markDeadLetter).not.toHaveBeenCalled();
  });

  it('dead-letters a prepared quote after a second attach failure', async () => {
    const { run, fence } = preparedRun({ attempts: 1, lastError: 'staff quote attach failed' });
    jobMocks.runStaffQuote.mockRejectedValue(
      Object.assign(new Error('EXECUTION_FAILURE'), { code: 'EXECUTION_FAILURE', phase: 'attach' }),
    );

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('dead_letter');

    expect(jobMocks.runStaffQuote).toHaveBeenCalledOnce();
    expect(jobMocks.markDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: 'TRANSIENT_NETWORK',
        lastError: 'staff quote attach failed',
      }),
      db,
    );
    expect(jobMocks.markRetry).not.toHaveBeenCalled();
  });

  it('still exhausts a prepared quote that already used a non-attach attempt', async () => {
    const { run, fence } = preparedRun({ attempts: 1 });

    await expect(executeHmsJob({ run, fence, db })).resolves.toBe('dead_letter');

    expect(jobMocks.runStaffQuote).not.toHaveBeenCalled();
    expect(jobMocks.markDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: 'prepared_quote_attempt_exhausted' }),
      db,
    );
  });
});
