import {
  bindAutoStartStaffQuote,
  bindExecuteStaffQuote,
  bindReadBackStaffQuote,
  EXPIRED_STAFF_QUOTE_COPY,
  qualifiedPdfFailureReason,
  type ExecuteStaffQuoteInput,
  type ExecuteStaffQuoteResult,
  staffQuoteFromTrpc,
} from '../lib/quote-workflow/staff-quote-bind';
import { HMS_JOB_POLL_MS } from '../lib/quote-workflow/amend-find';
import { setMailCacheScope } from '../lib/mail/mail-cache-scope';
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

function view(status: 'running' | 'done' | 'failed', result: unknown = null, asOf?: string) {
  return {
    runId: 'staff-job-1',
    request: null,
    prefetch: false,
    status,
    position: null,
    attempts: 0,
    failureClass: null,
    asOf: status === 'done' ? (asOf ?? new Date().toISOString()) : null,
    result: result as Record<string, unknown> | null,
  };
}

function storedStaffQuoteRequest(
  input: ExecuteStaffQuoteInput,
  overrides: Partial<ExecuteStaffQuoteInput> = {},
) {
  const storedInput = {
    ...input,
    selectionEpoch: 1,
    inputRevision: 2,
    ...overrides,
  } as ExecuteStaffQuoteInput & { autoStart?: true };
  delete storedInput.autoStart;
  return { kind: 'staff_quote' as const, input: storedInput };
}

afterEach(() => {
  vi.useRealTimers();
  setMailCacheScope({ userId: null, activeTransportId: null });
});

describe('staff quote HMS job binding', () => {
  it('keeps queued status reads on the mailbox where the quote routes were bound', async () => {
    vi.useFakeTimers();
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-a' });
    const queue = vi.fn(async (_input: unknown, _options?: unknown) => ({ runId: 'staff-job-1' }));
    const staffQuoteJob = vi
      .fn(async (_input: unknown, _options?: unknown) => view('running'))
      .mockResolvedValueOnce(view('running'))
      .mockResolvedValueOnce(view('done', READY));
    const staff = staffQuoteFromTrpc({
      workstation: {
        queueStaffQuote: { mutate: queue },
        staffQuoteJob: { query: staffQuoteJob },
      },
    });
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-b' });

    const pending = bindExecuteStaffQuote({
      queue: staff.workstation.queueStaffQuote?.mutate,
      staffQuoteJob: staff.workstation.staffQuoteJob?.query,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ status: 'ok' });
    expect(queue.mock.calls[0]?.[1]).toEqual({ context: { activeTransportId: 'transport-a' } });
    expect(staffQuoteJob.mock.calls[0]?.[1]).toEqual({ context: { activeTransportId: 'transport-a' } });
    expect(staffQuoteJob.mock.calls[1]?.[1]).toMatchObject({
      context: { activeTransportId: 'transport-a' },
      signal: expect.any(AbortSignal),
    });
  });

  it('pins read-back and later polling to the mailbox captured before a switch', async () => {
    vi.useFakeTimers();
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-a' });
    const staffQuoteJob = vi
      .fn(async (_input: unknown, _options?: unknown) => view('running'))
      .mockResolvedValueOnce(view('running'))
      .mockResolvedValueOnce(view('done', { ...READY, selectionEpoch: 1, inputRevision: 2 }));
    const staff = staffQuoteFromTrpc({ workstation: { staffQuoteJob: { query: staffQuoteJob } } });
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-b' });

    const pending = bindReadBackStaffQuote({
      query: staff.workstation.staffQuoteJob?.query,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ status: 'ok' });
    expect(staffQuoteJob.mock.calls[0]?.[0]).toMatchObject({
      input: expect.objectContaining({ messageId: source.messageId }),
    });
    expect(staffQuoteJob.mock.calls[0]?.[1]).toEqual({ context: { activeTransportId: 'transport-a' } });
    expect(staffQuoteJob.mock.calls[1]?.[1]).toMatchObject({
      context: { activeTransportId: 'transport-a' },
      signal: expect.any(AbortSignal),
    });
  });

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
    expect(staffQuoteJob.mock.calls.map(([input]) => input)).toEqual([
      { runId: 'staff-job-1' },
      { runId: 'staff-job-1' },
    ]);
    expect(mutate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'ok', staffQuote: { workflowRunId: 'workflow-1' } });
  });

  it('labels a server-priced dinner fallback as B&B and carries the verified add-on', async () => {
    const dinnerGroups = groups.map((group) => ({ ...group, board: 'dinner_bb' as const }));
    const dinnerAddOn = {
      label: 'Dinner buffet',
      amountMinor: 25_000,
      unit: 'per_person_per_night' as const,
      totalMinor: 50_000,
    };
    const result = await bindExecuteStaffQuote({
      queue: vi.fn(async () => ({ runId: 'staff-job-1' })),
      staffQuoteJob: vi.fn(async () => view('done', {
        ...READY,
        dinnerFallbackGroupIds: ['single'],
        dinnerAddOnRequired: false,
        dinnerAddOn,
      })),
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups: dinnerGroups,
      header: emptyStaffQuoteHeader(),
    });

    expect(result).toMatchObject({
      status: 'ok',
      offer: { board: 'bb' },
      staffQuote: { dinnerFallbackGroupIds: ['single'], dinnerAddOn },
    });
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

  it('preserves validated available-room alternatives from a persisted refusal', async () => {
    const alternatives = [
      { groupId: 'single', roomCode: 'DLXTWN', roomLabel: 'Deluxe Twin', quantity: 2 },
    ];
    const result = await bindExecuteStaffQuote({
      queue: vi.fn(async () => ({ runId: 'staff-job-1' })),
      staffQuoteJob: vi.fn(async () =>
        view('done', {
          ok: false,
          code: 'PRECONDITION_FAILED',
          message: 'No qualified rate covers every room-night.',
          alternatives,
        }),
      ),
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    expect(result).toMatchObject({ status: 'unavailable', alternatives });
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

  it('auto-starts only through the queue and never falls back inline on a null run id', async () => {
    const queue = vi.fn(async (input: ExecuteStaffQuoteInput & { autoStart?: true }) => {
      expect(input.autoStart).toBe(true);
      return { runId: null };
    });
    const mutate = vi.fn(async () => READY);

    const result = await bindAutoStartStaffQuote({
      queue,
      staffQuoteJob: vi.fn(),
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    expect(result).toBeNull();
    expect(queue).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('auto-starts a complete stay through a persisted staff quote job', async () => {
    const queue = vi.fn(async (input: ExecuteStaffQuoteInput & { autoStart?: true }) => {
      expect(input.autoStart).toBe(true);
      return { runId: 'staff-job-1' };
    });
    const staffQuoteJob = vi.fn(async () => view('done', READY));
    const mutate = vi.fn();

    const result = await bindAutoStartStaffQuote({
      queue,
      staffQuoteJob,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    expect(result).toMatchObject({ status: 'ok', staffQuote: { workflowRunId: 'workflow-1' } });
    expect(queue).toHaveBeenCalledTimes(1);
    expect(staffQuoteJob).toHaveBeenCalledWith({ runId: 'staff-job-1' });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('rebases reused auto-start result counters when its stored request matches', async () => {
    const queue = vi.fn(async (_input: ExecuteStaffQuoteInput) => ({ runId: 'staff-job-reused' }));
    const staffQuoteJob = vi.fn(async () => ({
      ...view('done', { ...READY, selectionEpoch: 1, inputRevision: 2 }),
      request: storedStaffQuoteRequest(queue.mock.calls[0]![0]),
    }));

    const result = await bindAutoStartStaffQuote({
      queue,
      staffQuoteJob,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    expect(result).toMatchObject({
      status: 'ok',
      staffQuote: { selectionEpoch: 3, inputRevision: 4 },
    });
  });

  it('does not rebase a reused auto-start result for a different stored request', async () => {
    const queue = vi.fn(async (_input: ExecuteStaffQuoteInput) => ({ runId: 'staff-job-reused' }));
    const staffQuoteJob = vi.fn(async () => ({
      ...view('done', { ...READY, selectionEpoch: 1, inputRevision: 2 }),
      request: storedStaffQuoteRequest(queue.mock.calls[0]![0], { company: 'Different Company' }),
    }));

    const result = await bindAutoStartStaffQuote({
      queue,
      staffQuoteJob,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'The quote is out of date because the stay details changed. Run it again.',
    });
  });

  it('does not queue an incomplete auto-start request', async () => {
    const queue = vi.fn(async () => ({ runId: 'staff-job-1' }));
    const result = await bindAutoStartStaffQuote({
      queue,
      staffQuoteJob: vi.fn(),
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups: [{ ...groups[0]!, adults: undefined }],
      header: emptyStaffQuoteHeader(),
    });

    expect(result).toBeNull();
    expect(queue).not.toHaveBeenCalled();
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

    expect(query.mock.calls.map(([input]) => input)).toEqual([
      {
        input: expect.objectContaining({
          messageId: source.messageId,
          selectionEpoch: 3,
          inputRevision: 4,
        }),
      },
      { runId: 'staff-job-1' },
    ]);
    expect(result).toMatchObject({
      status: 'ok',
      staffQuote: { selectionEpoch: 3, inputRevision: 4, workflowRunId: 'workflow-1' },
    });
  });

  it('does not restore a finished quote older than six hours after remount', async () => {
    const expiredAsOf = new Date(Date.now() - 6 * 60 * 60_000 - 1).toISOString();
    const query = vi.fn(async () => view('done', READY, expiredAsOf));

    const result = await bindReadBackStaffQuote({
      query,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    expect(result).toBeNull();
    expect(query).toHaveBeenCalledOnce();
  });

  it('stops a quote poll after nine minutes as POLL_LOST so the pane can retry', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const staffQuoteJob = vi.fn(async () =>
      Date.now() - startedAt > 9 * 60_000 ? view('done', READY) : view('running'),
    );
    const pending = bindExecuteStaffQuote({
      queue: vi.fn(async () => ({ runId: 'staff-job-1' })),
      staffQuoteJob,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const result = await pending;

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'The queued quote is still running, but Nava could not read its status. Try again in a minute.',
    });
  });

  it('aborts the prior read-back poll on cleanup before a rerun can stack another poller', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let reads = 0;
    const query = vi.fn(async () => (++reads === 1 ? view('running') : view('done', READY)));
    const pending = bindReadBackStaffQuote({
      query,
      signal: controller.signal,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(HMS_JOB_POLL_MS * 2);
    await pending;

    expect(query).toHaveBeenCalledOnce();
    const rerun = vi.fn(async () => view('done', READY));
    await expect(
      bindReadBackStaffQuote({
        query: rerun,
        source,
        selectionEpoch: 3,
        inputRevision: 4,
        groups,
        header: emptyStaffQuoteHeader(),
      }),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(rerun).toHaveBeenCalledOnce();
  });
});

describe('qualifiedPdfFailureReason', () => {
  it('asks staff to run the quote again when HMS evidence is past its 15 minutes', () => {
    expect(qualifiedPdfFailureReason(new Error('Proposal evidence is not ready'))).toBe(EXPIRED_STAFF_QUOTE_COPY);
  });
});
