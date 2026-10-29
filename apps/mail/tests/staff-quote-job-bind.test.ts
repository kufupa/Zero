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
import {
  emptyStaffQuoteHeader,
  HRCEN_PROPERTY_CODE,
  HRDAV_PROPERTY_CODE,
  type StayGroupRequirement,
} from '../lib/quote-workflow/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'a'.repeat(64) };
const groups: StayGroupRequirement[] = [
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

function view(status: 'running' | 'done' | 'failed', result: unknown = null, asOf?: string, prefetch = false) {
  return {
    runId: 'staff-job-1',
    request: null,
    prefetch,
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
      propertyCode: HRCEN_PROPERTY_CODE,
      queue: staff.workstation.queueStaffQuote?.mutate,
      staffQuoteJob: staff.workstation.staffQuoteJob?.query,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: { ...emptyStaffQuoteHeader(), notes: '  Breakfast only on day two.  ' },
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
      propertyCode: HRCEN_PROPERTY_CODE,
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
    expect(staffQuoteJob.mock.calls[0]?.[0]).toEqual({
      input: expect.objectContaining({ messageId: source.messageId, sourceHash: source.sourceHash }),
    });
    expect(staffQuoteJob.mock.calls[0]?.[1]).toEqual({ context: { activeTransportId: 'transport-a' } });
    expect(staffQuoteJob.mock.calls[1]?.[1]).toMatchObject({
      context: { activeTransportId: 'transport-a' },
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects a shared prepared quote read-back from another mailbox copy', async () => {
    const selectedSource = {
      messageId: 'mail-copy-2',
      threadId: 'thread-copy-2',
      sourceHash: 'c'.repeat(64),
    };
    const staffQuoteJob = vi.fn(async (_input: unknown) => view('done', READY, undefined, true));

    const result = await bindReadBackStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
      query: staffQuoteJob,
      source: selectedSource,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'The quote does not match the selected email. Select the email again, then run it again.',
    });
    expect(staffQuoteJob.mock.calls[0]?.[0]).toMatchObject({
      input: { messageId: selectedSource.messageId, sourceHash: selectedSource.sourceHash },
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
      propertyCode: HRCEN_PROPERTY_CODE,
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
      { runId: 'staff-job-1', messageId: source.messageId },
      { runId: 'staff-job-1', messageId: source.messageId },
    ]);
    expect(mutate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'ok', staffQuote: { workflowRunId: 'workflow-1' } });
  });

  it.each(['Dinner buffet', 'Dinner buffet (Children < 12)'])('labels a server-priced dinner fallback as B&B and carries the verified add-on: %s', async (label) => {
    const dinnerGroups = groups.map((group) => ({ ...group, board: 'dinner_bb' as const }));
    const dinnerAddOn = {
      label,
      amountMinor: 25_000,
      unit: 'per_person_per_night' as const,
      totalMinor: 50_000,
    };
    const result = await bindExecuteStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
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

  it('preserves an unpriced dinner requirement without fallback group ids', async () => {
    const result = await bindExecuteStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
      queue: vi.fn(async () => ({ runId: 'staff-job-1' })),
      staffQuoteJob: vi.fn(async () => view('done', {
        ...READY,
        dinnerAddOnRequired: true,
      })),
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups: groups.map((group) => ({ ...group, board: 'bb' as const })),
      header: { ...emptyStaffQuoteHeader(), dinnerAllowanceMinor: 25_000 },
    });

    expect(result).toMatchObject({
      status: 'ok',
      staffQuote: { dinnerAddOnRequired: true },
    });
    if (result.status === 'ok') expect(result.staffQuote.dinnerFallbackGroupIds).toBeUndefined();
  });

  it('holds Government quotes without verified guest eligibility, including a BAR fallback', async () => {
    const run = async (reported: Record<string, unknown>) => bindExecuteStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
      queue: vi.fn(async () => ({ runId: 'staff-job-1' })),
      staffQuoteJob: vi.fn(async () => view('done', { ...READY, dinnerFallbackGroupIds: ['single'], ...reported })),
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups: groups.map((group) => ({ ...group, board: 'dinner_bb' as const })),
      header: { ...emptyStaffQuoteHeader(), salesStrategy: 'Government' },
    });
    expect(await run({ requestedSalesStrategy: 'Government', effectiveSalesStrategy: 'BAR' })).toMatchObject({
      status: 'unavailable', reason: expect.stringMatching(/Government rates need confirmed guest eligibility/i),
    });
    expect(await run({})).toMatchObject({
      status: 'unavailable', reason: expect.stringMatching(/Government rates need confirmed guest eligibility/i),
    });
  });

  it('refuses a returned HRCEN rate when HMS priced a different strategy', async () => {
    const result = await bindExecuteStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
      queue: vi.fn(async () => ({ runId: 'staff-job-1' })),
      staffQuoteJob: vi.fn(async () => view('done', {
        ...READY, requestedSalesStrategy: 'BAR', effectiveSalesStrategy: 'WS',
      })),
      source, selectionEpoch: 3, inputRevision: 4, groups, header: emptyStaffQuoteHeader(),
    });
    expect(result).toMatchObject({ status: 'unavailable', noMatchingRate: true });
  });

  it('surfaces the exact business refusal stored by the worker', async () => {
    const refusal = 'HMS has no rate for this meal plan under BAR. Try another meal plan.';
    const queue = vi.fn(async () => ({ runId: 'staff-job-1' }));
    const staffQuoteJob = vi.fn(async () =>
      view('done', { ok: false, code: 'PRECONDITION_FAILED', message: refusal }),
    );
    const mutate = vi.fn();

    const result = await bindExecuteStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
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
      propertyCode: HRCEN_PROPERTY_CODE,
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
      propertyCode: HRCEN_PROPERTY_CODE,
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
      propertyCode: HRCEN_PROPERTY_CODE,
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
      propertyCode: HRCEN_PROPERTY_CODE,
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
      propertyCode: HRCEN_PROPERTY_CODE,
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
      propertyCode: HRCEN_PROPERTY_CODE,
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
      propertyCode: HRCEN_PROPERTY_CODE,
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
      propertyCode: HRCEN_PROPERTY_CODE,
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
    expect(staffQuoteJob).toHaveBeenCalledWith({ runId: 'staff-job-1', messageId: source.messageId });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('rebases reused auto-start result counters when its stored request matches', async () => {
    const queue = vi.fn(async (_input: ExecuteStaffQuoteInput) => ({ runId: 'staff-job-reused' }));
    const staffQuoteJob = vi.fn(async () => ({
      ...view('done', { ...READY, selectionEpoch: 1, inputRevision: 2 }),
      request: storedStaffQuoteRequest(queue.mock.calls[0]![0]),
    }));

    const result = await bindAutoStartStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
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

  it('rebases a prepared auto-start result when its saved header differs but the price terms matched', async () => {
    const asOf = '2026-10-14T10:35:00.000Z';
    const queue = vi.fn(async (_input: ExecuteStaffQuoteInput) => ({ runId: 'prepared-job' }));
    const staffQuoteJob = vi.fn(async () => ({
      ...view('done', { ...READY, selectionEpoch: 0, inputRevision: 0 }, asOf, true),
      request: storedStaffQuoteRequest(queue.mock.calls[0]![0], { company: 'Example Client' }),
    }));

    const result = await bindAutoStartStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
      queue,
      staffQuoteJob,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: { ...emptyStaffQuoteHeader(), notes: '  Breakfast only on day two.  ' },
    });

    expect(result).toMatchObject({
      status: 'ok',
      staffQuote: {
        selectionEpoch: 3,
        inputRevision: 4,
        preparedByNava: true,
        preparedAt: asOf,
        approvedHeader: { notes: 'Breakfast only on day two.' },
      },
    });
  });

  it('does not rebase a prepared auto-start result from a different source message version', async () => {
    const queue = vi.fn(async (_input: ExecuteStaffQuoteInput) => ({ runId: 'prepared-job' }));
    const staffQuoteJob = vi.fn(async () => ({
      ...view('done', { ...READY, selectionEpoch: 0, inputRevision: 0 }, undefined, true),
      request: storedStaffQuoteRequest(queue.mock.calls[0]![0], { sourceHash: 'c'.repeat(64) }),
    }));

    const result = await bindAutoStartStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
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

  it('rejects a prepared quote whose child occupancy differs even when pane counters match', async () => {
    const queue = vi.fn(async (_input: ExecuteStaffQuoteInput) => ({ runId: 'prepared-job' }));
    const staffQuoteJob = vi.fn(async () => ({
      ...view('done', READY, undefined, true),
      request: storedStaffQuoteRequest(queue.mock.calls[0]![0], {
        groups: [{ ...queue.mock.calls[0]![0].groups[0]!, childrenPerRoom: 1, childrenAges: [4] }],
      }),
    }));

    const result = await bindAutoStartStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
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

  it('rejects a prepared price from a different saved party source', async () => {
    const queue = vi.fn(async (_input: ExecuteStaffQuoteInput) => ({ runId: 'prepared-job' }));
    const staffQuoteJob = vi.fn(async () => ({
      ...view('done', READY, undefined, true),
      request: storedStaffQuoteRequest(queue.mock.calls[0]![0], { sourcePartyDigest: 'c'.repeat(64) }),
    }));
    const result = await bindAutoStartStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE, queue, staffQuoteJob, source,
      sourcePartyDigest: 'b'.repeat(64), sourceExtractionId: 'read-1',
      selectionEpoch: 3, inputRevision: 4, groups, header: emptyStaffQuoteHeader(),
    });
    expect(result).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('out of date') });
  });

  it('does not relabel a prepared contract price as the selected Centurion strategy', async () => {
    const header = {
      ...emptyStaffQuoteHeader(),
      salesStrategy: 'Government' as const,
      agency: 'Example Agency',
      parties: { agency: { kind: 'agency' as const, nativeId: 'A123', name: 'Example Agency' } },
    };
    const queue = vi.fn(async (_input: ExecuteStaffQuoteInput) => ({ runId: 'prepared-contract' }));
    const prepared = vi.fn(async () => ({
      ...view('done', READY, undefined, true),
      request: storedStaffQuoteRequest(queue.mock.calls[0]![0], { salesStrategy: 'WS' }),
    }));
    const auto = await bindAutoStartStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE, queue, staffQuoteJob: prepared, source,
      selectionEpoch: 3, inputRevision: 4, groups, header,
    });
    expect(auto).toMatchObject({ status: 'unavailable' });

    const query = vi.fn(async (lookup: { input: ExecuteStaffQuoteInput } | { runId: string; messageId: string }) => {
      if (!('input' in lookup)) throw new Error('unexpected poll');
      return {
        ...view('done', READY, undefined, true),
        request: storedStaffQuoteRequest(lookup.input, { salesStrategy: 'WS' }),
      };
    });
    expect(await bindReadBackStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE, query, source,
      selectionEpoch: 3, inputRevision: 4, groups, header,
    })).toBeNull();
  });

  it('preserves the existing Da Vinci prepared-contract preference', async () => {
    const header = {
      ...emptyStaffQuoteHeader(),
      agency: 'Example Agency',
      parties: { agency: { kind: 'agency' as const, nativeId: 'A123', name: 'Example Agency' } },
    };
    const queue = vi.fn(async (_input: ExecuteStaffQuoteInput) => ({ runId: 'prepared-contract' }));
    const prepared = vi.fn(async () => ({
      ...view('done', READY, undefined, true),
      request: storedStaffQuoteRequest(queue.mock.calls[0]![0], { salesStrategy: 'WS' }),
    }));
    const result = await bindAutoStartStaffQuote({
      propertyCode: HRDAV_PROPERTY_CODE, queue, staffQuoteJob: prepared, source,
      selectionEpoch: 3, inputRevision: 4, groups: [{ ...groups[0]!, roomCodes: ['STKNG'] }], header,
    });
    expect(result).toMatchObject({ status: 'ok' });
  });

  it('does not rebase a reused auto-start result for a different stored request', async () => {
    const queue = vi.fn(async (_input: ExecuteStaffQuoteInput) => ({ runId: 'staff-job-reused' }));
    const staffQuoteJob = vi.fn(async () => ({
      ...view('done', { ...READY, selectionEpoch: 1, inputRevision: 2 }),
      request: storedStaffQuoteRequest(queue.mock.calls[0]![0], { company: 'Different Company' }),
    }));

    const result = await bindAutoStartStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
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
      propertyCode: HRCEN_PROPERTY_CODE,
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
      propertyCode: HRCEN_PROPERTY_CODE,
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
      { input: expect.objectContaining({ messageId: source.messageId }) },
      { runId: 'staff-job-1', messageId: source.messageId },
    ]);
    expect(result).toMatchObject({
      status: 'ok',
      staffQuote: { selectionEpoch: 3, inputRevision: 4, workflowRunId: 'workflow-1' },
    });
  });

  it('does not restore rates when the saved job is for a different occupancy', async () => {
    const query = vi.fn(async () => ({
      ...view('done', READY),
      request: {
        kind: 'staff_quote' as const,
        input: {
          messageId: source.messageId,
          sourceHash: source.sourceHash,
          selectionEpoch: 1,
          inputRevision: 1,
          groups: [
            {
              id: 'single',
              arrivalDate: '2026-11-12',
              departureDate: '2026-11-14',
              quantity: 1,
              adults: 9,
              childrenPerRoom: 0,
              childrenAges: [],
              board: 'room_only',
              roomCodes: ['SKNG'],
            },
          ],
          salesStrategy: 'BAR' as const,
          company: '',
          agency: '',
          attention: '',
          clientEmail: '',
          clientTelephone: '',
        },
      },
    }));
    const result = await bindReadBackStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
      query: query as never,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });
    expect(result).toBeNull();
  });

  it('restores rates when only the quote header changed', async () => {
    const query = vi.fn(async () => ({
      ...view('done', READY),
      request: storedStaffQuoteRequest(
        {
          messageId: source.messageId,
          sourceHash: source.sourceHash,
          selectionEpoch: 1,
          inputRevision: 1,
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
          salesStrategy: 'BAR' as const,
          company: '',
          agency: '',
          attention: 'Earlier name',
          clientEmail: '',
          clientTelephone: '',
        },
      ),
    }));
    const result = await bindReadBackStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
      query: query as never,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: { ...emptyStaffQuoteHeader(), attention: 'New attention' },
    });
    expect(result).toMatchObject({ status: 'ok' });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ attention: 'New attention' }) }),
    );
  });

  it('looks up each stay by its own terms instead of sharing one run', async () => {
    const later: StayGroupRequirement = {
      ...groups[0]!,
      id: 'later',
      arrivalDate: '2026-12-01',
      departureDate: '2026-12-03',
    };
    const query = vi.fn(async (lookup: { input?: ExecuteStaffQuoteInput; runId?: string }) => {
      const arrival = lookup.input?.groups[0]?.arrivalDate;
      if (arrival === '2026-11-12') {
        return {
          ...view('done', READY),
          runId: 'staff-job-first',
          request: storedStaffQuoteRequest({
            messageId: source.messageId,
            sourceHash: source.sourceHash,
            selectionEpoch: 1,
            inputRevision: 1,
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
          }),
        };
      }
      if (arrival === '2026-12-01') {
        return {
          ...view('done', { ...READY, arrivalDate: '2026-12-01', departureDate: '2026-12-03' }),
          runId: 'staff-job-later',
          request: storedStaffQuoteRequest({
            messageId: source.messageId,
            sourceHash: source.sourceHash,
            selectionEpoch: 1,
            inputRevision: 1,
            groups: [
              {
                id: 'later',
                arrivalDate: '2026-12-01',
                departureDate: '2026-12-03',
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
          }),
        };
      }
      return null;
    });
    const first = await bindReadBackStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
      query: query as never,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
      stayKey: '2026-11-12:2026-11-14',
    });
    const second = await bindReadBackStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
      query: query as never,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups: [later],
      header: emptyStaffQuoteHeader(),
      stayKey: '2026-12-01:2026-12-03',
    });
    expect(first).toMatchObject({ status: 'ok', staffQuote: { quoteRequestKey: '2026-11-12:2026-11-14' } });
    expect(second).toMatchObject({ status: 'ok', staffQuote: { quoteRequestKey: '2026-12-01:2026-12-03' } });
  });

  it('labels a prepared result for staff with its saved as-of time', async () => {
    const asOf = new Date().toISOString();
    const query = vi.fn(async () => view('done', READY, asOf, true));

    const result = await bindReadBackStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
      query,
      source,
      selectionEpoch: 3,
      inputRevision: 4,
      groups,
      header: emptyStaffQuoteHeader(),
    });

    expect(result).toMatchObject({
      status: 'ok',
      staffQuote: { preparedByNava: true, preparedAt: asOf },
    });
  });

  it('does not restore a finished quote older than six hours after remount', async () => {
    const expiredAsOf = new Date(Date.now() - 6 * 60 * 60_000 - 1).toISOString();
    const query = vi.fn(async () => view('done', READY, expiredAsOf));

    const result = await bindReadBackStaffQuote({
      propertyCode: HRCEN_PROPERTY_CODE,
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
      propertyCode: HRCEN_PROPERTY_CODE,
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
      propertyCode: HRCEN_PROPERTY_CODE,
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
        propertyCode: HRCEN_PROPERTY_CODE,
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
