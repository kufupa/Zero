/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { NavaPane } from '../components/nava-pane/nava-pane';
import type { PaneBridge } from '../lib/workstation/pane-bridge-types';
import { AUTHORISED_QUOTE_OFFERS, AUTHORISED_QUOTE_PDF, AUTHORISED_REPLY_HTML } from './helpers/authorised-quote-evidence';
import { setMailCacheScope } from '../lib/mail/mail-cache-scope';
import { resetPaneEditsForTests } from '../lib/quote-workflow/pane-edits';

vi.mock('../lib/workstation/pane-release-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workstation/pane-release-watch')>()),
  reloadPane: vi.fn(),
}));

const WORK_ITEM_ID = '11111111-1111-1111-1111-111111111111';
const HISTORY_CURSOR = { revision: 2, revisionHead: 2, seq: 5 };

const {
  quotePdfMutate,
  qualifiedQuotePdfMutate,
  sendCommandMock,
  bridgeMockState,
  pingMutate,
  voucherFindQuery,
  syncStatusQuery,
  saveReplyMutate,
} = vi.hoisted(() => ({
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
    analysisOverride: null as null | Record<string, unknown>,
    analyseCalls: 0,
    staffQuoteSourceCalls: 0,
    storedWorkLookups: 0,
    storedWorkLookupReject: false,
    analyseFails: false,
    storedWork: null as null | Record<string, unknown>,
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
    revisionCursor: vi.fn(async (_input?: unknown) => ({ revision: 2, revisionHead: 2, seq: 5 })),
    undoRevision: vi.fn(async (_input?: unknown) => ({ revision: 1, revisionHead: 2, seq: 6 })),
    redoRevision: vi.fn(async (_input?: unknown) => ({ revision: 2, revisionHead: 2, seq: 7 })),
    resetSection: vi.fn(async (_input?: unknown) => ({ reset: 1 })),
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
        mutate: async (input: {
          selectionEpoch: number;
          inputRevision: number;
          groups: Array<{ arrivalDate: string; departureDate: string }>;
        }) => {
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
            status: 'ready',
            workflowRunId: 'run-1',
            revisionRef: 'rev-auth',
            messageId: 'mail-1',
            threadId: 'thread-1',
            factRefs: [],
            selectionEpoch: input.selectionEpoch,
            inputRevision: input.inputRevision,
            inputDigest: 'digest',
            totalMinor: 272000,
            currency: 'ZAR',
            arrivalDate: input.groups[0]?.arrivalDate,
            departureDate: input.groups[0]?.departureDate,
            description: 'Selected allocation',
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
    paneStayLookup: {
      jobQueueEnabled: { query: () => bridgeMockState.jobQueueEnabledQuery() },
      queueFind: { mutate: async () => ({ runId: 'job-find-1' }) },
      queueSearchGuest: { mutate: async () => ({ runId: 'job-search-1' }) },
      jobStatus: { query: async () => bridgeMockState.hmsQueueStatus as never },
      screenshot: { query: async () => null },
    },
    panePartyLookup: {
      findParty: {
        mutate: (input: { name: string; kind?: 'company' | 'agency' }) => bridgeMockState.findPartyMutation(input),
      },
    },
    get workItems() {
      const stored = bridgeMockState.storedWork;
      const listRoutes = {
        list: { query: async () => [] },
        dismiss: { mutate: async () => ({ status: 'ok' }) },
      };
      if (!stored) return listRoutes;
      return {
        ...listRoutes,
        getByMessage: {
          query: async () => {
            bridgeMockState.storedWorkLookups += 1;
            await bridgeMockState.storedLookupGate;
            if (bridgeMockState.storedWorkLookupReject) throw new Error('lookup failed');
            return stored;
          },
        },
        recordEvent: { mutate: (input: unknown) => bridgeMockState.recordEvent(input) },
        retryTranslation: { mutate: (input: unknown) => bridgeMockState.retryTranslation(input) },
        revisionCursor: { query: () => bridgeMockState.revisionCursor() },
        undoRevision: { mutate: (input: unknown) => bridgeMockState.undoRevision(input as never) },
        redoRevision: { mutate: (input: unknown) => bridgeMockState.redoRevision(input as never) },
        resetSection: { mutate: (input: unknown) => bridgeMockState.resetSection(input as never) },
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
          return (
            bridgeMockState.analysisOverride ?? {
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
            }
          );
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

const READY_WORK = {
  status: 'ready',
  kind: 'quote',
  workItemId: WORK_ITEM_ID,
  workItemStatus: 'needs_you',
  extractionId: 'ex-1',
  refs: { r_1: { stayId: 's_1', rowId: 'r_1' } },
  contact: {
    name: 'Ada Lovelace',
    company: null,
    endClient: null,
    email: 'ada@example.invalid',
    phone: null,
  },
  language: 'en',
  translation: null,
  fieldProvenance: {
    'contact.name': { source: 'staff', value: 'Ada Lovelace' },
    'contact.email': { source: 'ai', value: 'ada@example.invalid' },
    'stays[s_1].requested.arrival': { source: 'ai', value: '2026-11-03' },
  },
  analysis: {
    intent: 'quote',
    groups: [
      {
        id: 'r_1',
        stayId: 's_1',
        arrivalDate: '2026-11-03',
        departureDate: '2026-11-05',
        quantity: 2,
        adults: 2,
        childrenAges: [],
        board: 'bb',
        specialRequests: [],
        fields: {},
      },
    ],
    secondaryAsks: [],
    alternatives: [],
    source: 'luna',
    aiUnavailable: false,
  },
};

async function renderReadyPane() {
  bridgeMockState.storedWork = READY_WORK;
  render(<NavaPane bridge={fakeBridge} />);
  await screen.findByText('Ada Lovelace', {}, { timeout: 4000 });
  await screen.findByRole('button', { name: 'Undo' }, { timeout: 4000 });
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe('Nava pane work-item controls', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    bridgeMockState.transportId = 'transport-1';
    bridgeMockState.transportEmail = 'ropperman@legacyhotels.co.za';
    bridgeMockState.storedWork = null;
    bridgeMockState.storedLookupGate = null;
    bridgeMockState.storedWorkLookups = 0;
    bridgeMockState.storedWorkLookupReject = false;
    bridgeMockState.analyseCalls = 0;
    bridgeMockState.analyseFails = false;
    bridgeMockState.analysisOverride = null;
    bridgeMockState.revisionCursor.mockClear().mockResolvedValue(HISTORY_CURSOR);
    bridgeMockState.undoRevision.mockClear().mockResolvedValue({ revision: 1, revisionHead: 2, seq: 6 });
    bridgeMockState.redoRevision.mockClear().mockResolvedValue({ revision: 2, revisionHead: 2, seq: 7 });
    bridgeMockState.resetSection.mockClear().mockResolvedValue({ reset: 1 });
    bridgeMockState.recordEvent.mockReset().mockResolvedValue({ aiValue: null, value: null });
    voucherFindQuery.mockReset().mockResolvedValue({ status: 'not_voucher' });
    syncStatusQuery.mockReset().mockResolvedValue(null);
    bridgeMockState.jobQueueEnabledQuery.mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    setMailCacheScope({ userId: null, activeTransportId: null });
    localStorage.clear();
    sessionStorage.clear();
    resetPaneEditsForTests();
    cleanup();
  });

  it('marks a staff-edited field Edited and an AI field AI', async () => {
    await renderReadyPane();
    expect(screen.getByText('Edited')).toBeDefined();
    expect(screen.getAllByText('AI').length).toBeGreaterThanOrEqual(1);
  });

  it('clicking Undo calls undoRevision with the expected revision then refetches', async () => {
    await renderReadyPane();
    const lookupsBefore = bridgeMockState.storedWorkLookups;
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(bridgeMockState.undoRevision).toHaveBeenCalledWith({
        workItemId: WORK_ITEM_ID,
        expectedSeq: HISTORY_CURSOR.seq,
      });
    });
    await waitFor(() => expect(bridgeMockState.storedWorkLookups).toBeGreaterThan(lookupsBefore));
  });

  it('shows Reset to AI only on a staff-edited section and calls resetSection for that section', async () => {
    await renderReadyPane();
    const resets = screen.getAllByRole('button', { name: 'Reset to AI' });
    expect(resets).toHaveLength(1);
    fireEvent.click(resets[0]!);
    await waitFor(() => {
      expect(bridgeMockState.resetSection).toHaveBeenCalledWith({
        workItemId: WORK_ITEM_ID,
        section: { type: 'contact' },
      });
    });
  });

  it('failed refresh after Undo keeps controls disabled and Reload only refetches', async () => {
    await renderReadyPane();
    bridgeMockState.storedWorkLookupReject = true;
    const undoCallsBefore = bridgeMockState.undoRevision.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(screen.getByText(/Saved, but couldn't refresh/)).toBeDefined();
    });
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
    const lookupsAfterFail = bridgeMockState.storedWorkLookups;
    const undoCallsAfterFail = bridgeMockState.undoRevision.mock.calls.length;
    expect(undoCallsAfterFail).toBeGreaterThan(undoCallsBefore);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(bridgeMockState.storedWorkLookups).toBeGreaterThan(lookupsAfterFail));
    expect(bridgeMockState.undoRevision.mock.calls.length).toBe(undoCallsAfterFail);
    expect(bridgeMockState.resetSection).not.toHaveBeenCalled();
    expect(bridgeMockState.redoRevision).not.toHaveBeenCalled();
  });
});
