import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => {
  const confirmation = '12345678-1';
  const shallow = {
    ok: true, confirmation,
    searchResults: { displayed: 1, total: 1, complete: true },
    details: { confirmationInHeader: confirmation, cards: [
      { title: 'Stay', fields: [{ name: 'status', value: 'Reserved' }] },
      { title: 'Folio', fields: [] },
    ], visibleFormFields: [] },
  };
  const record = { details: { confirmationInRecord: confirmation, activeTab: 'Record View',
    fields: [{ name: 'status', value: 'Reserved' }] } };
  return {
    confirmation, shallow, record,
    readShallow: vi.fn(async () => structuredClone(shallow)),
    readRecord: vi.fn(async () => structuredClone(record)),
    openCancel: vi.fn(), confirmCancel: vi.fn(),
    pageOptions: undefined as { signal?: AbortSignal; blockServiceWorkers?: boolean } | undefined,
  };
});

vi.mock('../tooling/hms-cloud/cloud-session.mjs', () => ({
  withCloudReadSession: async (operation: (page: unknown, identity: unknown) => Promise<unknown>, options?: typeof fixtures.pageOptions & { prepareContext?: (context: unknown) => Promise<void> }) => {
    fixtures.pageOptions = options;
    await options?.prepareContext?.({});
    return operation({ on: () => {}, off: () => {} }, { propertyCode: 'HRCEN', tenantId: 'THECENTURION_PRD',
      landingPropertyCode: 'HRCEN', origin: 'https://hmsweb.hms.eu1.inforcloudsuite.com' });
  },
}));
vi.mock('../tooling/hms-cloud/saved-stay-read-guard.mjs', () => ({ installSavedStayReadGuard: vi.fn() }));
vi.mock('../tooling/hms-cloud/hms-readers.mjs', () => ({ readShallow: fixtures.readShallow, readRecord: fixtures.readRecord }));
import { withCancellationPreflightSession } from '../tooling/hms-cloud/cancellation-preflight-session.mjs';

const withTestPreflight = (operation: Parameters<typeof withCancellationPreflightSession>[0], options: Record<string, unknown> = {}) =>
  withCancellationPreflightSession(operation, { confirmation: fixtures.confirmation, propertyCode: 'HRCEN', ...options });

beforeEach(() => { vi.clearAllMocks(); fixtures.pageOptions = undefined; });

describe('cancellation preflight session', () => {
  it('passes allowed calls to the saved-stay session and requires a full read', async () => {
    const controller = new AbortController();
    const value = await withTestPreflight(async ({ runTool }) => {
      expect(await runTool({ tool: 'prepareCancellation' })).toMatchObject({ outcome: 'refused', issue: 'CURRENT_RECORD_REQUIRED' });
      const read = await runTool({ id: 'read-1', tool: 'read', confirmation: fixtures.confirmation });
      expect(read).toMatchObject({ id: 'read-1', tool: 'read', outcome: 'ok' });
      const result = await runTool({ id: 'prepare-1', tool: 'prepareCancellation', requestedScope: 'specific_room' });
      expect(result).toMatchObject({ id: 'prepare-1', tool: 'prepareCancellation', outcome: 'prepared_for_human_review',
        target: { confirmation: fixtures.confirmation, verified: true },
        roomScope: { requested: 'specific_room', complete: false },
        action: { actor: 'human', cancellationStarted: false, commitAvailable: false } });
      return 'callback-result';
    }, { signal: controller.signal });
    expect(value).toBe('callback-result');
    expect(fixtures.pageOptions).toMatchObject({ propertyCode: 'HRCEN', startScreen: 'OSRESS', signal: controller.signal });
    expect(fixtures.readShallow).toHaveBeenCalledOnce();
    expect(fixtures.readRecord).toHaveBeenCalledOnce();
    expect(fixtures.openCancel).not.toHaveBeenCalled();
    expect(fixtures.confirmCancel).not.toHaveBeenCalled();
  });

  it('refuses every non-allowlisted tool without dispatching to the raw session', async () => {
    await withTestPreflight(async ({ runTool }) => {
      for (const tool of ['openCancel', 'confirmCancel', 'amendNote', 'amendContact', 'prepareFinance',
        'readAmendmentAvailability', 'searchHotelAvailabilityParty', 'selectHotelAvailabilityParty',
        'cancelHotelAvailabilityParty', 'unknownFutureTool', 'toString', '__proto__', 'quit']) {
        expect(await runTool({ id: 'denied', tool })).toEqual({ id: 'denied', tool,
          outcome: 'refused', issue: 'PREFLIGHT_TOOL_NOT_ALLOWED' });
      }
      expect(fixtures.openCancel).not.toHaveBeenCalled();
      expect(fixtures.confirmCancel).not.toHaveBeenCalled();
      expect(fixtures.readShallow).not.toHaveBeenCalled();
    });
  });

  it('snapshots the tool before checking it, preventing a changing getter from reaching a write', async () => {
    await withTestPreflight(async ({ runTool }) => {
      let reads = 0;
      const request = { confirmation: fixtures.confirmation, get tool() { return ++reads === 1 ? 'read' : 'openCancel'; } };
      expect(await runTool(request)).toMatchObject({ tool: 'read', outcome: 'ok' });
      expect(reads).toBe(1);
      expect(fixtures.openCancel).not.toHaveBeenCalled();
    });
  });

  it('rejects malformed and uncloneable requests without calling the raw session', async () => {
    await withTestPreflight(async ({ runTool }) => {
      for (const request of [null, 1, [], () => undefined, { tool: 'read', value: () => undefined }]) {
        expect(await runTool(request)).toEqual({ id: null, tool: null, outcome: 'input_gap', issue: 'INVALID_REQUEST' });
      }
      expect(fixtures.readShallow).not.toHaveBeenCalled();
      expect(fixtures.openCancel).not.toHaveBeenCalled();
    });
  });

  it('does not expose the raw tool and does not revive an allowed call after closure', async () => {
    let retained: ((request: unknown) => Promise<unknown>) | undefined;
    await withTestPreflight(async (session) => {
      expect(Object.keys(session)).toEqual(['runTool']);
      retained = session.runTool;
    });
    expect(await retained!({ tool: 'read', confirmation: fixtures.confirmation })).toMatchObject({ outcome: 'refused', issue: 'SESSION_CLOSED' });
    expect(await retained!({ tool: 'openCancel' })).toMatchObject({ outcome: 'refused', issue: 'PREFLIGHT_TOOL_NOT_ALLOWED' });
    expect(fixtures.openCancel).not.toHaveBeenCalled();
  });

});
