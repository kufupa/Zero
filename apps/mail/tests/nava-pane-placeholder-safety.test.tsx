/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NavaPane } from '../components/nava-pane/nava-pane';
import type { PaneBridge } from '../lib/workstation/pane-bridge-types';
import { setMailCacheScope } from '../lib/mail/mail-cache-scope';
import { resetPaneEditsForTests } from '../lib/quote-workflow/pane-edits';
import { AUTHORISED_QUOTE_OFFERS, AUTHORISED_QUOTE_PDF, AUTHORISED_REPLY_HTML } from './helpers/authorised-quote-evidence';

// The pane reloads only through reloadPane(). Tests observe it; the real reload is never called.
vi.mock('../lib/workstation/pane-release-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workstation/pane-release-watch')>()),
  reloadPane: vi.fn(),
}));

// State the mocks below read. Defaults match outlook-pane-render.test.tsx.
const { quotePdfMutate, qualifiedQuotePdfMutate, sendCommandMock, bridgeMockState, pingMutate, voucherFindQuery, syncStatusQuery, saveReplyMutate } = vi.hoisted(() => ({
  pingMutate: vi.fn().mockResolvedValue({ status: 'ok', serverTime: '2026-10-09T12:00:00Z' }),
  voucherFindQuery: vi.fn().mockResolvedValue({ status: 'not_voucher' }),
  syncStatusQuery: vi.fn().mockResolvedValue(null),
  saveReplyMutate: vi.fn().mockResolvedValue({ id: 'draft-1', replaced: false }),
  quotePdfMutate: vi.fn().mockResolvedValue({
    fileName: 'Quote - CIDB 15-17 Sep.pdf',
    pdfBase64: 'JVBERw==',
  }),
  qualifiedQuotePdfMutate: vi.fn(),
  sendCommandMock: vi.fn(async (action: string): Promise<unknown> => {
    if (action === 'GET_ACTIVE_EMAIL') return { entryId: '001', storeId: 'store-1', folderEntryId: 'folder-inbox' };
    if (action === 'ADD_ATTACHMENT_TO_DRAFT') return { attached: true };
    return {
      entryId: 'draft-default',
      storeId: 'store-1',
      folderEntryId: 'folder-drafts',
      folderName: 'Drafts',
      displayed: true,
    };
  }),
  bridgeMockState: {
    userId: 'staff-1',
    sessionId: 'session-1',
    transportId: 'transport-1',
    transportEmail: 'ropperman@legacyhotels.co.za',
    holdStaffQuote: false,
    releaseStaffQuote: null as null | (() => void),
    hmsQueueStatus: null as null | Record<string, unknown>,
    hmsQueueReads: 0,
    staffQuoteRunId: null as null | string,
    staffQuoteFailure: null as null | { message: string; data?: { code?: string; alternatives?: unknown } },
    staffQuoteJobCalls: [] as Array<{ input: unknown; activeTransportId: string | null }>,
    lastStaffQuoteInput: null as null | Record<string, unknown>,
    staffQuoteScreenshots: [] as string[],
    screenshotReads: [] as string[],
    // Replaces the default quote analysis for one test (an amendment email, for example).
    analysisOverride: null as null | Record<string, unknown>,
    analyseCalls: 0,
    staffQuoteSourceCalls: 0,
    storedWorkLookups: 0,
    // While true, the live read rejects, as a model or network failure does.
    analyseFails: false,
    // A stored read for the mail. Null leaves the workItems route out, so the pane reads live as before.
    storedWork: null as null | Record<string, unknown>,
    // While set, the stored-read lookup waits for it, as a slow lookup does.
    storedLookupGate: null as null | Promise<void>,
    staffQuoteJobQuery: vi.fn().mockResolvedValue(null),
    queueStaffQuoteMutation: vi.fn().mockResolvedValue({ runId: null }),
    staffQuoteSources: {} as Record<string, { messageId: string; threadId: string; sourceHash: string }>,
    quotePaneConfig: null as null | Record<string, unknown>,
    findPartyMutation: vi.fn().mockResolvedValue({
      outcome: 'no_match',
      results: [],
      truncated: false,
      best: null,
      searchedFor: null,
    }),
    jobQueueEnabledQuery: vi.fn().mockResolvedValue(true),
    listThreadQuoteRevisionsQuery: vi.fn().mockResolvedValue([]),
    usePriorQuoteForBookingMutation: vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'No prior quote.' }),
    prepareBookingDraftMutation: vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'No draft.' }),
    prepareUnquotedBookingDraftMutation: vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'No draft.' }),
    recordEvent: vi.fn(async (_input: unknown): Promise<unknown> => ({ aiValue: null, value: null })),
    retryTranslation: vi.fn(async (_input: unknown): Promise<unknown> => ({ status: 'capped', translation: null })),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const v4Capabilities = {
  bridgeProtocolVersion: 4,
  addinVersion: '1.0.12',
  outlookVersion: '16.0',
  runtime: 'Classic Outlook for Windows',
  newOutlookSupported: false,
  interactiveProfileRequired: true,
  maxPageSize: 200,
  maxFolderDepth: 64,
  maxFolderCount: 5000,
  maxFolderSnapshotItems: 5000,
  supportedActions: [
    'GET_CAPABILITIES',
    'GET_ACTIVE_EMAIL',
    'CREATE_REPLY_DRAFT',
    'ADD_ATTACHMENT_TO_DRAFT',
  ],
};

// Same bridge values as the useOutlookBridge mock in outlook-pane-render.test.tsx.
const fakeBridge = {
  isConnected: true,
  workstationInfo: { addinVersion: '1.0.12', bridgeProtocolVersion: 4, paired: true },
  capabilities: v4Capabilities,
  supportsAction: (action: string) => v4Capabilities.supportedActions.includes(action),
  activeEmail: {
    entryId: '001',
    storeId: 'store-1',
    folderEntryId: 'folder-inbox',
    subject: 'Suite Availability Request',
    senderEmail: 'guest@example.com',
    senderName: 'David Miller',
    receivedTime: '2026-09-17T12:00:00Z',
    internetMessageId: '<quote-request@example.invalid>',
    bodyText: 'CIDB needs 3 rooms for 4 nights.',
    bodyHtml: '<p>We need 3 rooms for 4 nights.</p>',
  },
  sendCommand: sendCommandMock,
  pairDevice: vi.fn(async () => {}),
} as unknown as PaneBridge;

vi.mock('../lib/auth-client', () => ({
  useSession: () => ({
    data: {
      user: { id: bridgeMockState.userId, email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' },
      session: { id: bridgeMockState.sessionId },
    },
    isLoading: false,
  }),
  signIn: { email: vi.fn() },
}));

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: { id: bridgeMockState.transportId, email: bridgeMockState.transportEmail },
    isLoading: false,
  }),
}));

// The amend panel reads the pilot capabilities hook; the pane default is paneSave off.
vi.mock('@/hooks/use-pilot-capabilities', () => ({
  usePilotCapabilities: () => ({ paneSave: false }),
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    workstation: {
      ping: { mutate: pingMutate },
      quoteProposalPdf: { mutate: quotePdfMutate },
      outlookSync: { statusForActiveMailbox: { query: syncStatusQuery } },
      staffQuoteSource: {
        query: async ({ internetMessageId }: { internetMessageId: string }) => {
          bridgeMockState.staffQuoteSourceCalls += 1;
          return {
            status: 'ready',
            ...(bridgeMockState.staffQuoteSources[internetMessageId] ?? {
              messageId: 'mail-1',
              threadId: 'thread-1',
              sourceHash: 'ab'.repeat(32),
            }),
          };
        },
      },
      jobQueueEnabled: { query: () => bridgeMockState.jobQueueEnabledQuery() },
      queueStaffQuote: { mutate: (input: unknown) => bridgeMockState.queueStaffQuoteMutation(input) },
      staffQuoteJob: {
        query: (input: unknown, options?: { context?: { activeTransportId?: string } }) => {
          bridgeMockState.staffQuoteJobCalls.push({
            input,
            activeTransportId: options?.context?.activeTransportId ?? null,
          });
          return bridgeMockState.staffQuoteJobQuery(input);
        },
      },
      listThreadQuoteRevisions: { query: (input: unknown) => bridgeMockState.listThreadQuoteRevisionsQuery(input) },
      usePriorQuoteForBooking: { mutate: (input: unknown) => bridgeMockState.usePriorQuoteForBookingMutation(input) },
      prepareBookingDraft: { mutate: (input: unknown) => bridgeMockState.prepareBookingDraftMutation(input) },
      prepareUnquotedBookingDraft: {
        mutate: (input: unknown) => bridgeMockState.prepareUnquotedBookingDraftMutation(input),
      },
      executeStaffQuote: {
        mutate: async (input: { selectionEpoch: number; inputRevision: number; groups: Array<{ arrivalDate: string; departureDate: string }> }) => {
          if (bridgeMockState.staffQuoteFailure) {
            const failure = bridgeMockState.staffQuoteFailure;
            bridgeMockState.staffQuoteFailure = null;
            throw Object.assign(new Error(failure.message), { data: failure.data });
          }
          if (bridgeMockState.holdStaffQuote) {
            await new Promise<void>((resolve) => {
              bridgeMockState.releaseStaffQuote = resolve;
            });
          }
          return {
            status: 'ready', workflowRunId: 'run-1', revisionRef: 'rev-auth', messageId: 'mail-1', threadId: 'thread-1', factRefs: [],
            propertyCode: bridgeMockState.quotePaneConfig?.propertyCode,
            selectionEpoch: input.selectionEpoch, inputRevision: input.inputRevision, inputDigest: 'digest', totalMinor: 272000, currency: 'ZAR',
            arrivalDate: input.groups[0]?.arrivalDate, departureDate: input.groups[0]?.departureDate, description: 'Selected allocation',
            runId: bridgeMockState.staffQuoteRunId,
            screenshots: [...bridgeMockState.staffQuoteScreenshots],
          };
        },
      },
      hmsQueueStatus: {
        query: async () => {
          bridgeMockState.hmsQueueReads += 1;
          return bridgeMockState.hmsQueueStatus ?? { state: 'idle', message: '' };
        },
      },
      quoteRunScreenshot: {
        query: async ({ name }: { runId: string; name: string }) => {
          bridgeMockState.screenshotReads.push(name);
          return {
            status: 'ready',
            name,
            mimeType: 'image/png',
            sizeBytes: 16,
            dataUrl: `data:image/png;base64,SHOT-${name}`,
          };
        },
      },
      qualifiedQuoteProposalPdf: { mutate: qualifiedQuotePdfMutate },
    },
    // The amendment panel's HMS job routes. These tests queue no job, so jobStatus has nothing to report.
    paneStayLookup: {
      jobQueueEnabled: { query: () => bridgeMockState.jobQueueEnabledQuery() },
      queueFind: { mutate: async () => ({ runId: 'job-find-1' }) },
      queueSearchGuest: { mutate: async () => ({ runId: 'job-search-1' }) },
      jobStatus: { query: async () => bridgeMockState.hmsQueueStatus as never },
      screenshot: { query: async () => null },
    },
    panePartyLookup: {
      findParty: { mutate: (input: { name: string; kind?: 'company' | 'agency' }) => bridgeMockState.findPartyMutation(input) },
    },
    get workItems() {
      const stored = bridgeMockState.storedWork;
      const listRoutes = {
        list: { query: async () => [] },
        dismiss: { mutate: async () => ({ status: 'ok' }) },
      };
      if (!stored) return listRoutes;
      // Centurion's current server returns both the original extraction and the saved projection.
      const currentStored = () => bridgeMockState.quotePaneConfig?.propertyCode === 'HRCEN' && stored.status === 'ready'
        ? {
            contact: { name: null, company: null, endClient: null, email: null, phone: null },
            fieldProvenance: {}, revisionSeq: 0, stateDigest: 'a'.repeat(64), ...stored,
            sourceRead: Object.hasOwn(stored, 'sourceRead') ? stored.sourceRead : {
              extractionId: stored.extractionId, kind: stored.kind, analysis: stored.analysis, refs: stored.refs,
            },
          }
        : stored;
      return {
        ...listRoutes,
        getByMessage: {
          query: async () => {
            bridgeMockState.storedWorkLookups += 1;
            await bridgeMockState.storedLookupGate;
            return currentStored();
          },
        },
        ...(bridgeMockState.quotePaneConfig?.propertyCode === 'HRCEN'
          ? { open: { mutate: async () => currentStored() } } : {}),
        recordEvent: { mutate: (input: unknown) => bridgeMockState.recordEvent(input) },
        retryTranslation: { mutate: (input: unknown) => bridgeMockState.retryTranslation(input) },
      };
    },
    quoteWorkflow: {
      rateCatalogue: {
        query: async () => bridgeMockState.quotePaneConfig,
      },
      voucherFind: { query: voucherFindQuery },
      analyseSelection: {
        mutate: async () => {
          bridgeMockState.analyseCalls += 1;
          if (bridgeMockState.analyseFails) throw new Error('Nava could not read this email.');
          return bridgeMockState.analysisOverride ?? ({
            status: 'ready' as const,
            intent: 'quote' as const,
            groups: [
              {
                id: 'g1',
                childrenAges: [],
                board: 'unknown' as const,
                quantity: 1,
                specialRequests: [],
                fields: { arrivalDate: 'missing' as const, departureDate: 'missing' as const, adults: 'missing' as const },
              },
            ],
            secondaryAsks: [],
            alternatives: [],
            sourceRevision: 1,
          });
        },
      },
      runStep: {
        mutate: async () => ({
          status: 'ok',
          offers: AUTHORISED_QUOTE_OFFERS,
          reviewedReplyHtml: AUTHORISED_REPLY_HTML,
        }),
      },
      qualifiedProposalPdf: {
        mutate: async () => AUTHORISED_QUOTE_PDF,
      },
    },
    drafts: { saveReply: { mutate: saveReplyMutate } },
  },
}));


const FIRST = {
  id: 'r_1', stayId: 's_1', arrivalDate: '2027-10-20', departureDate: '2027-10-21', quantity: 1, adults: 2,
  childrenPerRoom: 0, childrenAges: [], board: 'bb', specialRequests: [], fields: {},
};
const SECOND = { ...FIRST, id: 'r_2', stayId: 's_2', arrivalDate: '2027-11-20', departureDate: '2027-11-21' };
const ANALYSIS = { intent: 'quote', groups: [FIRST, SECOND], secondaryAsks: [], alternatives: [] };
const REFS = { r_1: { stayId: 's_1', rowId: 'r_1' }, r_2: { stayId: 's_2', rowId: 'r_2' } };
const READY = {
  status: 'ready', kind: 'quote', workItemId: 'wi-1', workItemStatus: 'needs_you', extractionId: 'ex-1',
  refs: REFS, analysis: ANALYSIS,
  sourceRead: { extractionId: 'ex-1', kind: 'quote', analysis: ANALYSIS, refs: REFS, payloadDigest: 'a'.repeat(64) },
  contact: { name: null, company: null, endClient: null, email: null, phone: null },
  sourcePartyDigest: 'b'.repeat(64), sourcePartyFields: { company: ['missing'], endClient: ['missing'] },
  revisionSeq: 0, stateDigest: 'c'.repeat(64), language: null, translation: null,
};

beforeEach(() => {
  localStorage.setItem('nava_onboarding_completed', 'true');
  sessionStorage.clear();
  resetPaneEditsForTests();
  bridgeMockState.transportId = 'transport-centurion';
  bridgeMockState.transportEmail = 'centurion@example.invalid';
  bridgeMockState.quotePaneConfig = {
    transportId: 'transport-centurion', propertyCode: 'HRCEN', roomTypes: [], ratePlans: [], boards: ['bb'],
    salesStrategies: [], overrideRateCodes: [], eventRateCodes: [],
  };
  bridgeMockState.storedWork = READY;
  bridgeMockState.recordEvent.mockReset().mockResolvedValue({ aiValue: null, value: null });
  bridgeMockState.queueStaffQuoteMutation.mockReset().mockResolvedValue({ runId: null });
  bridgeMockState.jobQueueEnabledQuery.mockResolvedValue(false);
  setMailCacheScope({ userId: bridgeMockState.userId, activeTransportId: bridgeMockState.transportId });
});

afterEach(() => {
  cleanup();
  bridgeMockState.storedLookupGate = null;
  resetPaneEditsForTests();
  sessionStorage.clear();
  localStorage.clear();
  setMailCacheScope({ userId: null, activeTransportId: null });
});

it('holds an early edit across a two-case read and remount until staff discard it', async () => {
  let releaseLookup = () => {};
  bridgeMockState.storedLookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  const pane = render(<NavaPane bridge={fakeBridge} />);
  fireEvent.change(await screen.findByLabelText(/Arrival/i), { target: { value: '2027-10-25' } });
  await act(async () => releaseLookup());
  expect(await screen.findByText(/early edits are not assigned to a stay/i)).toBeDefined();
  expect((screen.getByLabelText(/Arrival/i) as HTMLInputElement).value).toBe('2027-10-25');
  expect(bridgeMockState.recordEvent).not.toHaveBeenCalled();
  expect(bridgeMockState.queueStaffQuoteMutation).not.toHaveBeenCalled();

  pane.unmount();
  render(<NavaPane bridge={fakeBridge} />);
  expect(await screen.findByText(/early edits are not assigned to a stay/i)).toBeDefined();
  expect((screen.getByLabelText(/Arrival/i) as HTMLInputElement).value).toBe('2027-10-25');
  expect(bridgeMockState.recordEvent).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved changes and reload' }));
  await waitFor(() => expect(screen.queryByText(/early edits are not assigned to a stay/i)).toBeNull(), { timeout: 5000 });
  await waitFor(() => expect(screen.getAllByLabelText(/Arrival/i)).toHaveLength(2), { timeout: 5000 });
  expect((screen.getAllByLabelText(/Arrival/i) as HTMLInputElement[]).map((input) => input.value))
    .toEqual(['2027-10-20', '2027-11-20']);
  expect(bridgeMockState.recordEvent).not.toHaveBeenCalled();
}, 15000);
