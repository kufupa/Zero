/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

const { suggestQuery, findPartyMutation, lastStaffQuoteInput, sendCommandMock } = vi.hoisted(() => ({
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
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../lib/auth-client', () => ({
  useSession: () => ({
    data: {
      user: { id: 'staff-1', email: 'staff@example.test', name: 'Staff Example' },
      session: { id: 'session-1' },
    },
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

describe('NavaPane mail-derived party hints', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    lastStaffQuoteInput.current = null;
    findPartyMutation.mockClear();
    suggestQuery.mockReset();
    suggestQuery.mockResolvedValue({ suggestions: [SENDER_HINT] });
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    cleanup();
  });

  it('preselects the sender party once HMS returns it', async () => {
    const agency = { kind: 'agency' as const, nativeId: '77', name: 'Example Travel Agency' };
    findPartyMutation.mockResolvedValue({
      outcome: 'resolved',
      results: [agency],
      truncated: false,
      best: agency,
      searchedFor: 'Example Travel Agency',
    });
    render(<NavaPane bridge={fakeBridge} preview />);
    await waitFor(() => expect(screen.getByText('✓ Example Travel Agency (#77)')).toBeTruthy(), {
      timeout: 4000,
    });
    expect(suggestQuery).toHaveBeenCalledWith({
      sender: 'ops@example-agency.test',
      body: fakeBridge.activeEmail!.bodyText.slice(0, BODY_LIMIT),
    });
    expect(suggestQuery.mock.calls[0]?.[0].body).toHaveLength(BODY_LIMIT);
    expect(screen.queryByText(/not confirmed in HMS/)).toBeNull();
    expect(screen.queryByText(/learned/i)).toBeNull();
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
});
