import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => {
  const pages: Array<{ context: () => unknown; on: (name: string, fn: (value: unknown) => void) => void; listeners: Record<string, (value: unknown) => void>; closed: boolean }> = [];
  const options: Array<Record<string, unknown> | undefined> = [];
  const readShallow = vi.fn(async (_page: unknown, confirmation: string) => ({ confirmation }));
  const readRecord = vi.fn(async () => ({ details: { fields: [{ name: 'status', value: 'Reserved' }] } }));
  return {
    pages, options, readShallow, readRecord,
    guard: vi.fn(async () => {}),
    generic: vi.fn(async (..._args: unknown[]) => ({ outcome: 'partial', savedPreimage: 'caller_supplied_unverified', saveEligible: false })),
    labtest: vi.fn(async (..._args: unknown[]): Promise<{ outcome: string; savedPreimage?: string; saveEligible: boolean; issue?: string }> => ({ outcome: 'partial', savedPreimage: 'verified_labtest_form', saveEligible: false })),
    search: vi.fn(async (..._args: unknown[]) => ({ outcome: 'matches', searchId: 'search-1', candidates: [{ nativeId: 'party-1' }] })),
    select: vi.fn(async (..._args: unknown[]): Promise<{ outcome: string; issue?: string }> => ({ outcome: 'selected' })),
    cancel: vi.fn(async (..._args: unknown[]) => ({ outcome: 'cancelled' })),
    openCancel: vi.fn(async (..._args: unknown[]) => ({ outcome: 'reason_ready' })),
    confirmCancel: vi.fn(),
  };
});

vi.mock('../tooling/playwright-quote/centurion-stay360.mjs', () => ({
  withCenturionStay360Page: async (operation: (page: unknown) => Promise<unknown>, options?: Record<string, unknown>) => {
    fixtures.options.push(options);
    const context = { _options: { serviceWorkers: options?.blockServiceWorkers ? 'block' : 'allow' }, serviceWorkers: () => [] };
    const listeners: Record<string, (value: unknown) => void> = {};
    const page = { context: () => context, listeners, on: (name: string, fn: (value: unknown) => void) => { listeners[name] = fn; }, closed: false };
    fixtures.pages.push(page);
    try { return await operation(page); } finally { page.closed = true; }
  },
}));
vi.mock('../tooling/playwright-quote/hms-read-only-guard.mjs', () => ({ installReadOnlyGuard: fixtures.guard }));
vi.mock('../tooling/hms-cloud/hms-readers.mjs', () => ({ readShallow: fixtures.readShallow, readRecord: fixtures.readRecord }));
vi.mock('../tooling/hms-cloud/guest-stay-cancel.mjs', () => ({ openLabtestCancellation: fixtures.openCancel, confirmLabtestCancellation: fixtures.confirmCancel }));
vi.mock('../tooling/hms-cloud/guest-stay-amend-availability.mjs', () => ({ readStayAmendmentAvailability: fixtures.generic }));
vi.mock('../tooling/hms-cloud/guest-stay-amend-date-room-rate.mjs', () => ({ readLabtestStayAmendmentAvailability: fixtures.labtest }));
vi.mock('../tooling/hms-cloud/hotel-availability.mjs', () => ({
  searchHotelAvailabilityParty: fixtures.search, selectHotelAvailabilityParty: fixtures.select,
  cancelHotelAvailabilityParty: fixtures.cancel,
}));

import { withSavedStayAgentSession } from '../tooling/hms-cloud/saved-stay-agent-session.mjs';

const expected = { confirmation: '12345678-1', guestId: 'fake', arrival: '2027-01-10', departure: '2027-01-12', roomType: 'OLD', ratePlan: 'BAR', note: '' };
const input = { existing: { propertyCode: 'HRCEN', arrival: '2027-01-10', departure: '2027-01-12', roomType: 'OLD', ratePlan: 'BAR' },
  change: { roomType: 'NEW' }, occupancy: { adults: 2, childAges: [] },
  partyContext: { group: null, organization: null, bookingAgency: null }, roomQuantity: 1 };
const options = { change: input.change, occupancy: input.occupancy, partyContext: input.partyContext, roomQuantity: 1, snapshotPath: '/private/snapshot.json' };

beforeEach(() => {
  fixtures.pages.length = 0;
  fixtures.options.length = 0;
  vi.clearAllMocks();
});

describe('saved-stay amendment availability session', () => {
  it('exposes generic read without claiming a verified saved preimage', async () => {
    await withSavedStayAgentSession(async ({ runTool }) => {
      const result = await runTool({ tool: 'readAmendmentAvailability', mode: 'generic', input, options: { snapshotPath: options.snapshotPath } });
      expect(result).toMatchObject({ outcome: 'partial', savedPreimage: 'caller_supplied_unverified', saveEligible: false });
      expect(fixtures.generic).toHaveBeenCalledWith(fixtures.pages[1], input, { snapshotPath: options.snapshotPath });
      expect(fixtures.pages[0]).not.toBe(fixtures.pages[1]);
      expect(fixtures.options).toHaveLength(2);
      expect(fixtures.options.every((entry) => entry?.blockServiceWorkers === true)).toBe(true);
      expect(fixtures.guard).toHaveBeenCalledWith(fixtures.pages[0].context());
      expect(fixtures.guard).toHaveBeenCalledWith(fixtures.pages[1].context());
      expect(fixtures.labtest).not.toHaveBeenCalled();
    });
    expect(fixtures.pages.every((page) => page.closed)).toBe(true);
  });

  it('preserves the downstream read failure without upgrading its evidence', async () => {
    fixtures.generic.mockResolvedValueOnce({ outcome: 'execution_failure', savedPreimage: 'caller_supplied_unverified', saveEligible: false });
    await withSavedStayAgentSession(async ({ runTool }) => {
      const result = await runTool({ tool: 'readAmendmentAvailability', mode: 'generic', input, options: { snapshotPath: options.snapshotPath } });
      expect(result).toMatchObject({ outcome: 'execution_failure', savedPreimage: 'caller_supplied_unverified', saveEligible: false });
    });
  });

  it('requires the matching current reserved record for the Labtest-bound reader', async () => {
    await withSavedStayAgentSession(async ({ runTool }) => {
      const request = { tool: 'readAmendmentAvailability', mode: 'labtest', expected, options };
      expect(await runTool(request)).toMatchObject({ outcome: 'refused', issue: 'CURRENT_RECORD_REQUIRED' });
      await runTool({ tool: 'read', confirmation: expected.confirmation });
      expect(await runTool({ ...request, expected: { ...expected, confirmation: 'other' } })).toMatchObject({ outcome: 'refused', issue: 'CURRENT_RECORD_MISMATCH' });
      const result = await runTool(request);
      expect(result).toMatchObject({ outcome: 'partial', savedPreimage: 'verified_labtest_form', saveEligible: false });
      expect(fixtures.labtest).toHaveBeenCalledWith(fixtures.pages[0], fixtures.pages[1], expected, options);
      expect(fixtures.generic).not.toHaveBeenCalled();
    });
  });

  it('requires a fresh session if the saved preimage changes during the read', async () => {
    fixtures.labtest.mockResolvedValueOnce({ outcome: 'refused', issue: 'AMEND_PREIMAGE_CHANGED', saveEligible: false });
    await withSavedStayAgentSession(async ({ runTool }) => {
      await runTool({ tool: 'read', confirmation: expected.confirmation });
      expect(await runTool({ tool: 'readAmendmentAvailability', mode: 'labtest', expected, options }))
        .toMatchObject({ outcome: 'refused', issue: 'AMEND_PREIMAGE_CHANGED', saveEligible: false });
      expect(await runTool({ tool: 'prepareFinance' })).toMatchObject({ outcome: 'refused', issue: 'FRESH_SESSION_REQUIRED' });
    });
  });

  it.each(['LABTEST_RECORD_UNVERIFIED', 'AMEND_AVAILABILITY_UNVERIFIED'])(
    'seals the session when a saved-form recheck returns %s', async (issue) => {
      fixtures.labtest.mockResolvedValueOnce({ outcome: 'refused', issue, saveEligible: false });
      await withSavedStayAgentSession(async ({ runTool }) => {
        await runTool({ tool: 'read', confirmation: expected.confirmation });
        expect(await runTool({ tool: 'readAmendmentAvailability', mode: 'labtest', expected, options }))
          .toMatchObject({ outcome: 'refused', issue, saveEligible: false });
        expect(await runTool({ tool: 'prepareCancellation' })).toMatchObject({ outcome: 'refused', issue: 'FRESH_SESSION_REQUIRED' });
        expect(await runTool({ tool: 'prepareFinance' })).toMatchObject({ outcome: 'refused', issue: 'FRESH_SESSION_REQUIRED' });
      });
    },
  );

  it('keeps the current record when the Labtest reader only reports an input gap', async () => {
    fixtures.labtest.mockResolvedValueOnce({ outcome: 'input_gap', issue: 'AMEND_CHANGE_REQUIRED', saveEligible: false });
    await withSavedStayAgentSession(async ({ runTool }) => {
      await runTool({ tool: 'read', confirmation: expected.confirmation });
      expect(await runTool({ tool: 'readAmendmentAvailability', mode: 'labtest', expected, options }))
        .toMatchObject({ outcome: 'input_gap', issue: 'AMEND_CHANGE_REQUIRED' });
      expect(await runTool({ tool: 'prepareFinance' })).not.toMatchObject({ issue: 'FRESH_SESSION_REQUIRED' });
    });
  });

  it('refuses Labtest-bound availability for a non-reserved record', async () => {
    fixtures.readRecord.mockResolvedValueOnce({ details: { fields: [{ name: 'status', value: 'Cancelled' }] } });
    await withSavedStayAgentSession(async ({ runTool }) => {
      await runTool({ tool: 'read', confirmation: expected.confirmation });
      expect(await runTool({ tool: 'readAmendmentAvailability', mode: 'labtest', expected, options }))
        .toMatchObject({ outcome: 'refused', issue: 'RECORD_NOT_RESERVED' });
      expect(fixtures.labtest).not.toHaveBeenCalled();
      expect(fixtures.pages).toHaveLength(1);
    });
  });

  it('rejects unknown modes without starting an availability page', async () => {
    await withSavedStayAgentSession(async ({ runTool }) => {
      expect(await runTool({ tool: 'readAmendmentAvailability', mode: 'unknown', input, options }))
        .toMatchObject({ outcome: 'input_gap', issue: 'AMEND_AVAILABILITY_MODE_REQUIRED' });
      expect(fixtures.pages).toHaveLength(1);
    });
  });

  it('seals the session and closes both pages if the availability guard cannot be installed', async () => {
    await withSavedStayAgentSession(async ({ runTool }) => {
      fixtures.guard.mockRejectedValueOnce(new Error('PRIVATE_SETUP_FAILURE'));
      const result = await runTool({ tool: 'readAmendmentAvailability', mode: 'generic', input, options: { snapshotPath: options.snapshotPath } });
      expect(result).toMatchObject({ outcome: 'execution_failure', issue: 'AVAILABILITY_SESSION_FAILED' });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SETUP_FAILURE');
      expect(await runTool({ tool: 'prepareFinance' })).toMatchObject({ outcome: 'refused', issue: 'FRESH_SESSION_REQUIRED' });
      expect(fixtures.generic).not.toHaveBeenCalled();
    });
    expect(fixtures.pages.every((page) => page.closed)).toBe(true);
  });

  it('retains the same availability page for search, explicit selection, cancellation and read', async () => {
    await withSavedStayAgentSession(async ({ runTool }) => {
      const search = await runTool({ tool: 'searchHotelAvailabilityParty', kind: 'organization', propertyCode: 'HRCEN', query: 'example' });
      await runTool({ tool: 'selectHotelAvailabilityParty', kind: 'organization', searchId: search.searchId, nativeId: 'party-1' });
      await runTool({ tool: 'cancelHotelAvailabilityParty' });
      await runTool({ tool: 'readAmendmentAvailability', mode: 'generic', input, options: { snapshotPath: options.snapshotPath } });
      const page = fixtures.pages[1];
      expect(fixtures.search).toHaveBeenCalledWith(page, expect.objectContaining({ kind: 'organization', propertyCode: 'HRCEN', query: 'example' }), undefined);
      expect(fixtures.select).toHaveBeenCalledWith(page, expect.objectContaining({ kind: 'organization', searchId: 'search-1', nativeId: 'party-1' }));
      expect(fixtures.cancel).toHaveBeenCalledWith(page);
      expect(fixtures.generic.mock.calls[0][0]).toBe(page);
      expect(fixtures.pages).toHaveLength(2);
    });
  });

  it('serializes concurrent search and selection on the retained page', async () => {
    let release!: () => void;
    let announce!: () => void;
    const started = new Promise<void>((resolve) => { announce = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    fixtures.search.mockImplementationOnce(async () => {
      announce();
      await blocked;
      return { outcome: 'matches', searchId: 'search-1', candidates: [{ nativeId: 'party-1' }] };
    });
    await withSavedStayAgentSession(async ({ runTool }) => {
      const search = runTool({ tool: 'searchHotelAvailabilityParty', kind: 'organization', propertyCode: 'HRCEN', query: 'example' });
      await started;
      const select = runTool({ tool: 'selectHotelAvailabilityParty', kind: 'organization', searchId: 'search-1', nativeId: 'party-1' });
      await Promise.resolve();
      expect(fixtures.select).not.toHaveBeenCalled();
      release();
      expect((await search).outcome).toBe('matches');
      expect((await select).outcome).toBe('selected');
    });
  });

  it('interrupts availability on a native dialog without accepting it', async () => {
    let announce!: () => void;
    const started = new Promise<void>((resolve) => { announce = resolve; });
    fixtures.generic.mockImplementationOnce(async () => {
      announce();
      return new Promise(() => {});
    });
    await withSavedStayAgentSession(async ({ runTool }) => {
      const reading = runTool({ tool: 'readAmendmentAvailability', mode: 'generic', input, options: { snapshotPath: options.snapshotPath } });
      await started;
      const accept = vi.fn();
      fixtures.pages[1].listeners.dialog({ type: () => 'confirm', message: () => 'Fee', accept });
      expect(await reading).toMatchObject({ outcome: 'fee_dialog_pending', issue: 'NATIVE_DIALOG' });
      expect(accept).not.toHaveBeenCalled();
      expect(await runTool({ tool: 'read', confirmation: expected.confirmation })).toMatchObject({ outcome: 'fee_dialog_pending' });
    });
    expect(fixtures.pages.every((page) => page.closed)).toBe(true);
  });

  it('keeps availability unavailable while a cancellation dialog is pending', async () => {
    await withSavedStayAgentSession(async ({ runTool }) => {
      await runTool({ tool: 'read', confirmation: expected.confirmation });
      expect(await runTool({ tool: 'openCancel', expected })).toMatchObject({ outcome: 'reason_ready' });
      expect(await runTool({ tool: 'readAmendmentAvailability', mode: 'generic', input, options: { snapshotPath: options.snapshotPath } }))
        .toMatchObject({ outcome: 'refused', issue: 'CANCEL_REASON_OPEN' });
      expect(fixtures.generic).not.toHaveBeenCalled();
      expect(fixtures.confirmCancel).not.toHaveBeenCalled();
      expect(fixtures.pages).toHaveLength(1);
    });
  });

  it('seals the session after an uncertain native selection', async () => {
    fixtures.select.mockResolvedValueOnce({ outcome: 'selection_uncertain', issue: 'PARTY_READBACK_MISMATCH' });
    await withSavedStayAgentSession(async ({ runTool }) => {
      const result = await runTool({ tool: 'selectHotelAvailabilityParty', kind: 'organization', searchId: 'search-1', nativeId: 'party-1' });
      expect(result.outcome).toBe('selection_uncertain');
      expect(await runTool({ tool: 'readAmendmentAvailability', mode: 'generic', input, options: { snapshotPath: options.snapshotPath } })).toMatchObject({ outcome: 'refused', issue: 'FRESH_SESSION_REQUIRED' });
      expect(fixtures.generic).not.toHaveBeenCalled();
    });
  });
});
