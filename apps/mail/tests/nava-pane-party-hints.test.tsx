/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavaPane } from '../components/nava-pane/nava-pane';
import type { PaneBridge } from '../lib/workstation/pane-bridge-types';
import type { PartySuggestion } from '../lib/quote-workflow/party-lookup';

const SENDER_HINT: PartySuggestion = {
  source: 'sender',
  kind: 'agency',
  name: 'Example Travel Agency',
  nativeId: null,
  idStatus: 'unverified',
};

const BODY_LIMIT = 20_000;

const { suggestQuery, findPartyMutation, lastStaffQuoteInput, sendCommandMock, sessionState } = vi.hoisted(
  () => ({
    suggestQuery: vi.fn(),
    findPartyMutation: vi.fn().mockResolvedValue({
      outcome: 'no_match',
      results: [],
      truncated: false,
      best: null,
      searchedFor: null,
    }),
    lastStaffQuoteInput: { current: null as null | Record<string, unknown> },
    sendCommandMock: vi.fn(async (action: string): Promise<unknown> => {
      if (action === 'GET_ACTIVE_EMAIL') return { entryId: '001', storeId: 'store-1', folderEntryId: 'folder-inbox' };
      return { entryId: 'draft-default', storeId: 'store-1', folderEntryId: 'folder-drafts', displayed: true };
    }),
    sessionState: {
      current: {
        user: { id: 'staff-1', email: 'staff@example.test', name: 'Staff Example' },
        session: { id: 'session-1' },
      } as null | {
        user: { id: string; email: string; name: string };
        session: { id: string };
      },
    },
  }),
);

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../lib/auth-client', () => ({
  useSession: () => ({
    data: sessionState.current,
    isLoading: false,
  }),
  signIn: { email: vi.fn() },
}));

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: { id: 'transport-1', email: 'staff@example.test' },
    isLoading: false,
  }),
}));

vi.mock('@/hooks/use-pilot-capabilities', () => ({
  usePilotCapabilities: () => ({ paneSave: false }),
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    workstation: {
      ping: { mutate: vi.fn().mockResolvedValue({ status: 'ok', serverTime: '2026-10-15T00:00:00Z' }) },
      quoteProposalPdf: { mutate: vi.fn().mockResolvedValue({ fileName: 'Quote.pdf', pdfBase64: 'JVBERw==' }) },
      outlookSync: { statusForActiveMailbox: { query: vi.fn().mockResolvedValue(null) } },
      staffQuoteSource: {
        query: async () => ({
          status: 'ready',
          messageId: 'mail-1',
          threadId: 'thread-1',
          sourceHash: 'ab'.repeat(32),
        }),
      },
      jobQueueEnabled: { query: async () => false },
      queueStaffQuote: {
        mutate: async (input: Record<string, unknown>) => {
          lastStaffQuoteInput.current = input;
          return { runId: null };
        },
      },
      staffQuoteJob: { query: async () => null },
      listThreadQuoteRevisions: { query: async () => [] },
      usePriorQuoteForBooking: {
        mutate: async () => ({ status: 'unavailable', reason: 'No prior quote.' }),
      },
      prepareBookingDraft: { mutate: async () => ({ status: 'unavailable', reason: 'No draft.' }) },
      executeStaffQuote: {
        mutate: async (input: Record<string, unknown>) => {
          lastStaffQuoteInput.current = input;
          return { status: 'unavailable', reason: 'not run' };
        },
      },
      hmsQueueStatus: { query: async () => ({ state: 'idle', message: '' }) },
      quoteRunScreenshot: { query: async () => null },
      qualifiedQuoteProposalPdf: { mutate: async () => ({ fileName: 'Quote.pdf', pdfBase64: 'JVBERw==' }) },
    },
    paneStayLookup: {
      jobQueueEnabled: { query: async () => false },
      queueFind: { mutate: async () => ({ runId: 'job-find-1' }) },
      queueSearchGuest: { mutate: async () => ({ runId: 'job-search-1' }) },
      jobStatus: { query: async () => null },
      screenshot: { query: async () => null },
    },
    panePartyLookup: {
      findParty: { mutate: (input: { name: string; kind?: 'company' | 'agency' }) => findPartyMutation(input) },
      suggest: { query: (input: { sender: string; body: string }) => suggestQuery(input) },
    },
    workItems: {
      list: { query: async () => [] },
      dismiss: { mutate: async () => ({ status: 'ok' }) },
    },
    quoteWorkflow: {
      voucherFind: { query: async () => ({ status: 'not_voucher' }) },
      analyseSelection: {
        mutate: async () => ({
          status: 'ready' as const,
          intent: 'quote' as const,
          groups: [
            {
              id: 'g1',
              childrenAges: [],
              board: 'unknown' as const,
              quantity: 1,
              specialRequests: [],
              fields: {
                arrivalDate: 'missing' as const,
                departureDate: 'missing' as const,
                adults: 'missing' as const,
              },
            },
          ],
          secondaryAsks: [],
          alternatives: [],
          sourceRevision: 1,
        }),
      },
      runStep: { mutate: async () => ({ status: 'ok', offers: [], reviewedReplyHtml: '' }) },
      qualifiedProposalPdf: { mutate: async () => ({ fileName: 'Quote.pdf', pdfBase64: 'JVBERw==' }) },
    },
    drafts: { saveReply: { mutate: async () => ({ id: 'draft-1', replaced: false }) } },
  },
}));

const fakeBridge = {
  isConnected: true,
  workstationInfo: { addinVersion: '1.0.12', bridgeProtocolVersion: 4, paired: true },
  capabilities: null,
  supportsAction: () => true,
  activeEmail: {
    entryId: '001',
    storeId: 'store-1',
    folderEntryId: 'folder-inbox',
    subject: 'Availability request',
    senderEmail: 'ops@example-agency.test',
    senderName: 'Example Sender',
    receivedTime: '2026-10-15T12:00:00Z',
    internetMessageId: '<quote-request@example.invalid>',
    bodyText: `${'nights in November. '.repeat(1200)}end`,
    bodyHtml: '<p>Availability request</p>',
  },
  sendCommand: sendCommandMock,
  pairDevice: vi.fn(async () => {}),
} as unknown as PaneBridge;

const SIGNED_IN = {
  user: { id: 'staff-1', email: 'staff@example.test', name: 'Staff Example' },
  session: { id: 'session-1' },
};

function bridgeForEmail(overrides: {
  entryId: string;
  internetMessageId: string;
  senderEmail: string;
}): PaneBridge {
  return {
    ...fakeBridge,
    activeEmail: { ...fakeBridge.activeEmail!, ...overrides },
  } as unknown as PaneBridge;
}

describe('NavaPane mail-derived party hints', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    lastStaffQuoteInput.current = null;
    sessionState.current = SIGNED_IN;
    findPartyMutation.mockClear();
    suggestQuery.mockReset();
    suggestQuery.mockResolvedValue({ suggestions: [SENDER_HINT] });
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    cleanup();
  });

  it('shows a sender hint as unverified and never binds a party or rateContext', async () => {
    render(<NavaPane bridge={fakeBridge} preview />);
    const agency = await screen.findByRole('group', { name: 'Agency lookup in HMS' });
    await waitFor(() =>
      expect(
        within(agency).getByText('Example Travel Agency (Agency), not confirmed in HMS'),
      ).toBeTruthy(),
    );
    expect(suggestQuery).toHaveBeenCalledWith({
      sender: 'ops@example-agency.test',
      body: fakeBridge.activeEmail!.bodyText.slice(0, BODY_LIMIT),
    });
    expect(suggestQuery.mock.calls[0]?.[0].body).toHaveLength(BODY_LIMIT);
    expect(screen.queryByText(/✓ /)).toBeNull();
    expect(lastStaffQuoteInput.current).toBeNull();
    expect(lastStaffQuoteInput.current).not.toMatchObject({ rateContext: expect.anything() });
    expect(findPartyMutation).not.toHaveBeenCalled();
  });

  it('swallows a failed suggest and shows no hints', async () => {
    suggestQuery.mockRejectedValue(new Error('suggest unavailable'));
    render(<NavaPane bridge={fakeBridge} preview />);
    expect(await screen.findByRole('group', { name: 'Agency lookup in HMS' })).toBeTruthy();
    await waitFor(() => expect(suggestQuery).toHaveBeenCalled());
    expect(screen.queryByText(/not confirmed in HMS/)).toBeNull();
    expect(screen.queryByText('Example Travel Agency')).toBeNull();
    expect(screen.queryByText(/✓ /)).toBeNull();
  });

  it("switching email A to B never shows A's hint under B", async () => {
    const hintA: PartySuggestion = { ...SENDER_HINT, name: 'Alpha Travel Agency' };
    const hintB: PartySuggestion = { ...SENDER_HINT, name: 'Beta Travel Agency' };
    let resolveB: (value: { suggestions: PartySuggestion[] }) => void = () => undefined;
    suggestQuery.mockImplementation(async (input: { sender: string; body: string }) => {
      if (input.sender === 'ops-a@example.test') return { suggestions: [hintA] };
      return new Promise((resolve) => {
        resolveB = resolve;
      });
    });

    const { rerender } = render(
      <NavaPane
        bridge={bridgeForEmail({
          entryId: '001',
          internetMessageId: '<mail-a@example.invalid>',
          senderEmail: 'ops-a@example.test',
        })}
        preview
      />,
    );
    await screen.findByText('Alpha Travel Agency (Agency), not confirmed in HMS');

    rerender(
      <NavaPane
        bridge={bridgeForEmail({
          entryId: '002',
          internetMessageId: '<mail-b@example.invalid>',
          senderEmail: 'ops-b@example.test',
        })}
        preview
      />,
    );
    expect(screen.queryByText(/Alpha Travel Agency/)).toBeNull();

    resolveB({ suggestions: [hintB] });
    await screen.findByText('Beta Travel Agency (Agency), not confirmed in HMS');
    expect(screen.queryByText(/Alpha Travel Agency/)).toBeNull();
  });

  it('does not request suggestions when signed out', async () => {
    sessionState.current = null;
    render(<NavaPane bridge={fakeBridge} preview />);
    expect(await screen.findByText(/Nava Assistant Sign In/i)).toBeTruthy();
    expect(suggestQuery).not.toHaveBeenCalled();
  });
});
