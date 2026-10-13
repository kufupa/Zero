import {
  bindExecuteStaffQuote,
  bindReadBackStaffQuote,
  type ExecuteStaffQuoteInput,
  type ExecuteStaffQuoteResult,
} from '../lib/quote-workflow/staff-quote-bind';
import { emptyStaffQuoteHeader, type StayGroupRequirement } from '../lib/quote-workflow/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'a'.repeat(64) };
const groups: StayGroupRequirement[] = [
  {
    id: 'single',
    arrivalDate: '2026-11-12',
    departureDate: '2026-11-14',
    quantity: 1,
    adults: 2,
    childrenAges: [],
    board: 'room_only',
    roomCodes: ['SKNG'],
    specialRequests: [],
    fields: {},
  },
];
const READY: ExecuteStaffQuoteResult = {
  status: 'ready',
  workflowRunId: 'workflow-1',
  revisionRef: 'revision-1',
  messageId: source.messageId,
  threadId: source.threadId,
  factRefs: [],
  selectionEpoch: 3,
  inputRevision: 4,
  inputDigest: 'b'.repeat(64),
  totalMinor: 240_000,
  currency: 'ZAR',
  arrivalDate: '2026-11-12',
  departureDate: '2026-11-14',
  description: 'Standard King; Room Only',
};

function view(status: 'running' | 'done' | 'failed', result: unknown = null) {
  return {
    runId: 'staff-job-1',
    request: null,
    prefetch: false,
    status,
    position: null,
    attempts: 0,
    failureClass: null,
    asOf: status === 'done' ? '2026-10-12T12:00:00.000Z' : null,
    result: result as Record<string, unknown> | null,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('staff quote HMS job binding', () => {
  it('queues once, polls the persisted run, and binds the finished rate result', async () => {
    vi.useFakeTimers();
    const queue = vi.fn(async (input: ExecuteStaffQuoteInput) => {
      expect(input.messageId).toBe(source.messageId);
      return { runId: 'staff-job-1' };
    });
    const staffQuoteJob = vi
      .fn()
      .mockResolvedValueOnce(view('running'))
      .mockResolvedValueOnce(view('done', READY));
    const mutate = vi.fn();
    const pending = bindExecuteStaffQuote({
      queue,
      staffQuoteJob,
      mutate,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    await vi.runAllTimersAsync();
    const result = await pending;

    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0]?.[0]).toMatchObject({
      messageId: source.messageId,
      selectionEpoch: 3,
      inputRevision: 4,
      groups: [{ id: 'single', arrivalDate: '2026-11-12', roomCodes: ['SKNG'] }],
    });
    expect(staffQuoteJob.mock.calls).toEqual([
      [{ runId: 'staff-job-1' }],
      [{ runId: 'staff-job-1' }],
    ]);
    expect(mutate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'ok', staffQuote: { workflowRunId: 'workflow-1' } });
  });

  it('surfaces the exact business refusal stored by the worker', async () => {
    const refusal = 'HMS has no rate for this meal plan under BAR. Try another meal plan.';
    const queue = vi.fn(async () => ({ runId: 'staff-job-1' }));
    const staffQuoteJob = vi.fn(async () =>
      view('done', { ok: false, code: 'PRECONDITION_FAILED', message: refusal }),
    );
    const mutate = vi.fn();

    const result = await bindExecuteStaffQuote({
      queue,
      staffQuoteJob,
      mutate,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    expect(result).toEqual({
      status: 'unavailable',
      reason: refusal,
      detail: 'PRECONDITION_FAILED',
      noMatchingRate: true,
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('retains the dinner fallback signal for a persisted no-matching-rate refusal', async () => {
    const refusal = 'HMS has no rate for this meal plan under BAR. Try another meal plan.';
    const result = await bindExecuteStaffQuote({
      queue: vi.fn(async () => ({ runId: 'staff-job-1' })),
      staffQuoteJob: vi.fn(async () =>
        view('done', { ok: false, code: 'PRECONDITION_FAILED', message: refusal }),
      ),
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      detail: 'PRECONDITION_FAILED',
      noMatchingRate: true,
    });
  });

  it.each([
    ['threadId', { ...READY, threadId: undefined }],
    ['factRefs', { ...READY, factRefs: undefined }],
    ['inputDigest', { ...READY, inputDigest: undefined }],
    ['arrivalDate', { ...READY, arrivalDate: undefined }],
    ['departureDate', { ...READY, departureDate: undefined }],
    ['description', { ...READY, description: undefined }],
  ])('rejects persisted success payloads missing required %s', async (_field, malformed) => {
    const result = await bindExecuteStaffQuote({
      queue: vi.fn(async () => ({ runId: 'staff-job-1' })),
      staffQuoteJob: vi.fn(async () => view('done', malformed)),
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'HMS did not return a room option that can be booked. Try again.',
    });
  });

  it('stops after repeated unreadable status reads without falling back inline', async () => {
    vi.useFakeTimers();
    let reads = 0;
    let misses = 0;
    const staffQuoteJob = vi.fn(async () => {
      if (reads++ === 0) return view('running');
      misses += 1;
      return misses % 2 ? null : Promise.reject(new Error('status read failed'));
    });
    const mutate = vi.fn();
    const pending = bindExecuteStaffQuote({
      queue: vi.fn(async () => ({ runId: 'staff-job-1' })),
      staffQuoteJob,
      mutate,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    await vi.runAllTimersAsync();
    const result = await pending;

    expect(misses).toBe(20);
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('could not read its status'),
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([
    ['HMS_LOCK_BUSY', 'HMS is busy with another quote or lookup. Try again in a minute.'],
    ['TRANSIENT_NETWORK', "HMS didn't answer in time."],
    ['SCHEMA_DRIFT', 'The background quote could not be completed. Try again.'],
  ])('does not fall back inline for the %s worker failure', async (failureClass, reason) => {
    const mutate = vi.fn();
    const result = await bindExecuteStaffQuote({
      queue: vi.fn(async () => ({ runId: 'staff-job-1' })),
      staffQuoteJob: vi.fn(async () => ({ ...view('failed'), failureClass })),
      mutate,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    expect(result).toEqual({ status: 'unavailable', reason });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('keeps the inline mutation path when the server returns a null run id', async () => {
    const queue = vi.fn(async () => ({ runId: null }));
    const mutate = vi.fn(async () => READY);

    const result = await bindExecuteStaffQuote({
      queue,
      mutate,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    expect(result).toMatchObject({ status: 'ok' });
    expect(queue).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('reads back a matching finished rate run after remount and rebases only pane revisions', async () => {
    vi.useFakeTimers();
    const query = vi
      .fn()
      .mockResolvedValueOnce(view('running'))
      .mockResolvedValueOnce(view('done', { ...READY, selectionEpoch: 1, inputRevision: 2 }));
    const pending = bindReadBackStaffQuote({
      query,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    await vi.runAllTimersAsync();
    const result = await pending;

    expect(query.mock.calls).toEqual([
      [
        {
          input: expect.objectContaining({
            messageId: source.messageId,
            selectionEpoch: 3,
            inputRevision: 4,
          }),
        },
      ],
      [{ runId: 'staff-job-1' }],
    ]);
    expect(result).toMatchObject({
      status: 'ok',
      staffQuote: { selectionEpoch: 3, inputRevision: 4, workflowRunId: 'workflow-1' },
    });
  });
});
