/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import type { StoredWork } from '@/lib/quote-workflow/backend-bind';
import type { QuoteAnalysis } from '@/lib/quote-workflow/types';
import { NavaPane } from '@/components/nava-pane/nava-pane';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORED_LOOKUP_TIMEOUT_MS } from '@/lib/quote-workflow/use-work-item';

const mocks = vi.hoisted(() => ({
  storedQuery: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  analyseSelection: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  ping: vi.fn(async () => ({ status: 'ok', serverTime: '2026-10-26T00:00:00Z' })),
  sendCommand: vi.fn(async () => ({ success: true })),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

vi.mock('@/lib/auth-client', () => ({
  useSession: () => ({
    data: {
      user: { id: 'test-user', email: 'nava-test@example.invalid', name: 'Test Staff' },
      session: { id: 'test-session' },
    },
    isLoading: false,
  }),
  signIn: { email: vi.fn() },
}));

vi.mock('@/hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: { id: 'test-mailbox', email: 'nava-test@example.invalid' },
    isLoading: false,
  }),
}));

vi.mock('@/hooks/use-pilot-capabilities', () => ({ usePilotCapabilities: () => ({ paneSave: false }) }));

vi.mock('@/providers/query-provider', () => {
  let missingProcedure: object;
  missingProcedure = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === 'query' || key === 'mutate') return async () => null;
        if (key === 'then') return undefined;
        return missingProcedure;
      },
    },
  );
  const withFallback = (routes: Record<string, unknown>): Record<string, unknown> =>
    new Proxy(
      Object.fromEntries(
        Object.entries(routes).map(([key, value]) => [
          key,
          value && typeof value === 'object' ? withFallback(value as Record<string, unknown>) : value,
        ]),
      ),
      {
        get: (target, key) =>
          key === 'then' ? undefined : Reflect.has(target, key) ? Reflect.get(target, key) : missingProcedure,
      },
    );

  return {
    trpcClient: withFallback({
      workstation: {
        ping: { mutate: mocks.ping },
        outlookSync: { statusForActiveMailbox: { query: async () => ({ state: 'not_applicable' }) } },
      },
      quoteWorkflow: {
        rateCatalogue: { query: async () => null },
        analyseSelection: { mutate: (...args: unknown[]) => mocks.analyseSelection(...args) },
      },
      workItems: {
        getByMessage: { query: (...args: unknown[]) => mocks.storedQuery(...args) },
        list: { query: async () => [] },
        open: { mutate: async () => ({ status: 'unavailable' }) },
        recordEvent: { mutate: async () => ({}) },
        acceptFields: { mutate: async () => ({}) },
        retryTranslation: { mutate: async () => ({ status: 'capped', translation: null }) },
      },
      panePartyLookup: { suggest: { query: async () => ({ suggestions: [] }) } },
      hmsApproval: null,
      drafts: { savedReply: { query: async () => null }, saveReply: { mutate: async () => null } },
    }),
  };
});

const ANALYSIS: QuoteAnalysis = {
  intent: 'quote',
  groups: [
    {
      id: 'stay-1',
      arrivalDate: '2026-11-03',
      departureDate: '2026-11-05',
      quantity: 1,
      adults: 2,
      childrenAges: [],
      board: 'bb',
      specialRequests: [],
      fields: {},
    },
  ],
  secondaryAsks: [],
  alternatives: [],
};

const STORED_READY = {
  status: 'ready',
  kind: 'quote',
  workItemId: 'work-item-1',
  workItemStatus: 'needs_you',
  extractionId: 'extraction-1',
  refs: {},
  analysis: ANALYSIS,
  contact: { name: null, company: null, endClient: null, email: null, phone: null },
  language: null,
  translation: null,
} as unknown as Extract<StoredWork, { status: 'ready' }>;

function bridge(): PaneBridge {
  return {
    isConnected: true,
    workstationInfo: { addinVersion: '1.0.17', bridgeProtocolVersion: 4 },
    capabilities: null,
    updateRequired: false,
    requiresRelogin: false,
    authorizationUnavailable: false,
    selectionOutsideMailbox: false,
    activeEmail: {
      entryId: 'test-entry',
      storeId: 'test-store',
      folderEntryId: 'test-inbox',
      subject: 'Availability request',
      senderEmail: 'requester@example.invalid',
      senderName: 'Requester',
      receivedTime: '2026-10-26T00:00:00Z',
      internetMessageId: 'test-message',
      bodyText: 'Please check these dates.',
      bodyHtml: '<p>Please check these dates.</p>',
    },
    supportsAction: () => true,
    sendCommand: mocks.sendCommand,
    pairDevice: vi.fn(),
    refreshAuthorization: vi.fn(),
    activateMailboxSync: vi.fn(),
  } as unknown as PaneBridge;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  mocks.storedQuery.mockReset();
  mocks.analyseSelection.mockReset();
});

describe('late stored quote reads', () => {
  it('renders a late stored result without starting another live read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let resolveStored!: (stored: typeof STORED_READY) => void;
    const pendingStored = new Promise<typeof STORED_READY>((resolve) => {
      resolveStored = resolve;
    });
    let resolveLive!: (result: unknown) => void;
    const pendingLive = new Promise<unknown>((resolve) => {
      resolveLive = resolve;
    });
    mocks.storedQuery.mockReturnValue(pendingStored);
    mocks.analyseSelection.mockReturnValue(pendingLive);

    render(<NavaPane bridge={bridge()} preview />);
    expect(mocks.analyseSelection).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STORED_LOOKUP_TIMEOUT_MS);
    });
    expect(mocks.analyseSelection).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStored(STORED_READY);
      await pendingStored;
      await Promise.resolve();
    });

    expect((screen.getAllByLabelText(/Arrival/i)[0] as HTMLInputElement).value).toBe('2026-11-03');
    expect(mocks.analyseSelection).toHaveBeenCalledTimes(1);
    expect(mocks.storedQuery).toHaveBeenCalledTimes(1);

    resolveLive(null);
  });
});
