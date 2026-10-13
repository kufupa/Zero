/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { observable } from '@trpc/server/observable';
import { countMutationsLink } from '../lib/workstation/mutations-in-flight';
import { reloadPane } from '../lib/workstation/pane-release-watch';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { toast } from 'sonner';
import { NavaPane } from '../components/nava-pane/nava-pane';
import type { PaneBridge } from '../lib/workstation/pane-bridge-types';
import { AUTHORISED_QUOTE_OFFERS, AUTHORISED_QUOTE_PDF, AUTHORISED_REPLY_HTML } from './helpers/authorised-quote-evidence';
import { fillStayFactsMatchingAuthorisedOffer, prepareReviewedQuote } from './helpers/prepare-reviewed-quote';
import { VOUCHER_COPY } from '../lib/quote-workflow/voucher-find';
import { quoteWrapperHtml } from '../lib/quote-proposal/copy';
import { HmsJobNoticeProvider } from '../components/quote-workflow/hms-job-notices';
import { setMailCacheScope } from '../lib/mail/mail-cache-scope';

// The pane reloads only through reloadPane(). Tests observe it; the real reload is never called.
vi.mock('../lib/workstation/pane-release-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workstation/pane-release-watch')>()),
  reloadPane: vi.fn(),
}));

// State the mocks below read. Defaults match outlook-pane-render.test.tsx.
const { quotePdfMutate, sendCommandMock, bridgeMockState, pingMutate, voucherFindQuery, saveReplyMutate } = vi.hoisted(() => ({
  pingMutate: vi.fn().mockResolvedValue({ status: 'ok', serverTime: '2026-10-09T12:00:00Z' }),
  voucherFindQuery: vi.fn().mockResolvedValue({ status: 'not_voucher' }),
  saveReplyMutate: vi.fn().mockResolvedValue({ id: 'draft-1', replaced: false }),
  quotePdfMutate: vi.fn().mockResolvedValue({
    fileName: 'Quote - CIDB 15-17 Sep.pdf',
    pdfBase64: 'JVBERw==',
  }),
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
    holdStaffQuote: false,
    releaseStaffQuote: null as null | (() => void),
    hmsQueueStatus: null as null | Record<string, unknown>,
    hmsQueueReads: 0,
    staffQuoteRunId: null as null | string,
    staffQuoteJobCalls: [] as Array<{ input: unknown; activeTransportId: string | null }>,
    lastStaffQuoteInput: null as null | Record<string, unknown>,
    staffQuoteScreenshots: [] as string[],
    screenshotReads: [] as string[],
    // Replaces the default quote analysis for one test (an amendment email, for example).
    analysisOverride: null as null | Record<string, unknown>,
    analyseCalls: 0,
    // While true, the live read rejects, as a model or network failure does.
    analyseFails: false,
    // A stored read for the mail. Null leaves the workItems route out, so the pane reads live as before.
    storedWork: null as null | Record<string, unknown>,
    // While set, the stored-read lookup waits for it, as a slow lookup does.
    storedLookupGate: null as null | Promise<void>,
    staffQuoteJobQuery: vi.fn().mockResolvedValue(null),
    queueStaffQuoteMutation: vi.fn().mockResolvedValue({ runId: null }),
    staffQuoteSources: {} as Record<string, { messageId: string; threadId: string; sourceHash: string }>,
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
    data: { id: bridgeMockState.transportId, email: 'ropperman@legacyhotels.co.za' },
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
      staffQuoteSource: {
        query: async ({ internetMessageId }: { internetMessageId: string }) => ({
          status: 'ready',
          ...(bridgeMockState.staffQuoteSources[internetMessageId] ?? {
            messageId: 'mail-1',
            threadId: 'thread-1',
            sourceHash: 'ab'.repeat(32),
          }),
        }),
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
      executeStaffQuote: {
        mutate: async (input: { selectionEpoch: number; inputRevision: number; groups: Array<{ arrivalDate: string; departureDate: string }> }) => {
          if (bridgeMockState.holdStaffQuote) {
            await new Promise<void>((resolve) => {
              bridgeMockState.releaseStaffQuote = resolve;
            });
          }
          return {
            status: 'ready', workflowRunId: 'run-1', revisionRef: 'rev-auth', messageId: 'mail-1', threadId: 'thread-1', factRefs: [],
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
      qualifiedQuoteProposalPdf: { mutate: async () => AUTHORISED_QUOTE_PDF },
    },
    // The amendment panel's HMS job routes. These tests queue no job, so jobStatus has nothing to report.
    paneStayLookup: {
      jobQueueEnabled: { query: () => bridgeMockState.jobQueueEnabledQuery() },
      queueFind: { mutate: async () => ({ runId: 'job-find-1' }) },
      queueSearchGuest: { mutate: async () => ({ runId: 'job-search-1' }) },
      jobStatus: { query: async () => null },
      screenshot: { query: async () => null },
    },
    panePartyLookup: {
      findParty: { mutate: (input: { name: string; kind?: 'company' | 'agency' }) => bridgeMockState.findPartyMutation(input) },
    },
    get workItems() {
      const stored = bridgeMockState.storedWork;
      if (!stored) return undefined;
      return {
        getByMessage: {
          query: async () => {
            await bridgeMockState.storedLookupGate;
            return stored;
          },
        },
        recordEvent: { mutate: (input: unknown) => bridgeMockState.recordEvent(input) },
        retryTranslation: { mutate: (input: unknown) => bridgeMockState.retryTranslation(input) },
      };
    },
    quoteWorkflow: {
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

/** Opens the ⋯ menu from the keyboard (Radix opens on Enter) and returns its item by name. */
function openPaneMenuItem(name: string): HTMLElement {
  const trigger = screen.getByRole('button', { name: 'More' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.getByRole('menuitem', { name });
}

function openContactCorrections() {
  fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
}

const LOADED_BUILD = 'build-loaded-0001';
const NEWER_BUILD = 'build-newer-0002';

/** The meta the served index.html carries (root.tsx). The page reads it at load. */
function mountBuildMeta(content: string) {
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'nava-pane-build');
  meta.setAttribute('content', content);
  document.head.appendChild(meta);
}

describe('NavaPane', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    bridgeMockState.holdStaffQuote = false;
    bridgeMockState.releaseStaffQuote = null;
    bridgeMockState.lastStaffQuoteInput = null;
    bridgeMockState.staffQuoteJobCalls.length = 0;
    bridgeMockState.queueStaffQuoteMutation.mockReset().mockResolvedValue({ runId: null });
    bridgeMockState.staffQuoteSources = {};
    bridgeMockState.findPartyMutation.mockReset().mockResolvedValue({
      outcome: 'no_match',
      results: [],
      truncated: false,
      best: null,
      searchedFor: null,
    });
    bridgeMockState.jobQueueEnabledQuery.mockReset().mockResolvedValue(false);
    voucherFindQuery.mockReset();
    voucherFindQuery.mockResolvedValue({ status: 'not_voucher' });
    saveReplyMutate.mockReset();
    saveReplyMutate.mockResolvedValue({ id: 'draft-1', replaced: false });
    bridgeMockState.staffQuoteJobQuery.mockReset().mockResolvedValue(null);
    bridgeMockState.listThreadQuoteRevisionsQuery.mockReset().mockResolvedValue([]);
    bridgeMockState.usePriorQuoteForBookingMutation
      .mockReset()
      .mockResolvedValue({ status: 'unavailable', reason: 'No prior quote.' });
    bridgeMockState.prepareBookingDraftMutation
      .mockReset()
      .mockResolvedValue({ status: 'unavailable', reason: 'No draft.' });
    vi.mocked(toast.warning).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    setMailCacheScope({ userId: null, activeTransportId: null });
    vi.mocked(reloadPane).mockClear();
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    document.head.querySelectorAll('meta[name="nava-pane-build"]').forEach((meta) => meta.remove());
    cleanup();
  });

  it('renders the header, main body and footer landmarks from a bridge prop alone', () => {
    const { container } = render(<NavaPane bridge={fakeBridge} />);
    expect(container.querySelector('header')?.textContent).toContain('Nava Reservationist');
    expect(container.querySelector('main')).not.toBeNull();
    expect(container.querySelector('footer')?.textContent).not.toContain('Pilot feedback');
    expect(screen.getByRole('button', { name: 'More' })).toBeDefined();
  });

  it('keeps the feedback and tour actions in the ⋯ menu, not the footer', () => {
    render(<NavaPane bridge={fakeBridge} />);
    openPaneMenuItem('Replay tour');
    expect(screen.getByRole('menuitem', { name: 'Check connection' })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Replay tour' })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Feedback by email' }).getAttribute('href')).toBe(
      'mailto:aroransh17@gmail.com',
    );
    expect(screen.getByRole('menuitem', { name: 'Feedback on WhatsApp' })).toBeDefined();
  });

  it('replays the tour from the ⋯ menu', () => {
    render(<NavaPane bridge={fakeBridge} />);
    fireEvent.keyDown(openPaneMenuItem('Replay tour'), { key: 'Enter' });
    expect(screen.getByRole('button', { name: /Next: 60-Second Feature Tour|Next/i })).toBeDefined();
    expect(screen.getByText('1. Automatic Email Sync')).toBeDefined();
  });

  it('shows the build this page was served, from its own meta, under About in the ⋯ menu', () => {
    mountBuildMeta(LOADED_BUILD);
    render(<NavaPane bridge={fakeBridge} />);
    openPaneMenuItem('Replay tour');
    expect(screen.getByText(/About Nava Reservationist · Build build-l/)).toBeDefined();
  });

  it('mounts and renders when reading sessionStorage throws', () => {
    vi.stubEnv('PROD', true);
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access is denied', 'SecurityError');
      },
    });
    try {
      const { container } = render(<NavaPane bridge={fakeBridge} />);
      expect(container.querySelector('header')?.textContent).toContain('Nava Reservationist');
    } finally {
      if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    }
  });
  it('runs the connection check again after a successful one', async () => {
    pingMutate.mockClear();
    render(<NavaPane bridge={fakeBridge} />);
    fireEvent.keyDown(openPaneMenuItem('Check connection'), { key: 'Enter' });
    await waitFor(() => expect(pingMutate).toHaveBeenCalledTimes(1));
    await screen.findByText(/Workstation API ping verified/);

    fireEvent.keyDown(openPaneMenuItem('Check connection'), { key: 'Enter' });
    await waitFor(() => expect(pingMutate).toHaveBeenCalledTimes(2));
  });

  /** Policy tests run on fake timers: the pane's clock is the thing under test. */
  const flush = (ms = 0) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  /** Production build, the served index carries LOADED_BUILD, and the server reports NEWER_BUILD. */
  function servePendingBuild() {
    vi.stubEnv('PROD', true);
    mountBuildMeta(LOADED_BUILD);
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ release: 'a'.repeat(64), build: NEWER_BUILD })),
    );
  }

  /** The same bridge with another email selected: a switch the pane must act on. */
  const otherEmailBridge = {
    ...fakeBridge,
    activeEmail: { ...fakeBridge.activeEmail, entryId: '002', subject: 'Different Guest Request' },
  } as unknown as PaneBridge;

  it('shows the pending build in the status line and never reloads on its own', async () => {
    vi.useFakeTimers();
    servePendingBuild();
    render(<NavaPane bridge={fakeBridge} />);
    await flush(0);
    expect(screen.getByText('New version available — it will load when you open the next email.')).toBeDefined();

    window.dispatchEvent(new Event('focus'));
    await flush(6 * 60_000);
    expect(vi.mocked(reloadPane)).not.toHaveBeenCalled();
  });

  it('typing in the pane restarts the 15-minute idle clock', async () => {
    vi.useFakeTimers();
    servePendingBuild();
    render(<NavaPane bridge={fakeBridge} />);
    await flush(0);
    const arrival = screen.getByLabelText('Arrival');

    await flush(10 * 60_000);
    fireEvent.keyDown(arrival, { key: '1' });
    await flush(10 * 60_000);
    expect(vi.mocked(reloadPane)).not.toHaveBeenCalled();

    await flush(6 * 60_000);
    expect(vi.mocked(reloadPane)).toHaveBeenCalled();
  });

  it('reloads once after 15 idle minutes with a pending build', async () => {
    vi.useFakeTimers();
    servePendingBuild();
    render(<NavaPane bridge={fakeBridge} />);
    await flush(0);

    await flush(14 * 60_000);
    expect(vi.mocked(reloadPane)).not.toHaveBeenCalled();
    await flush(60_000);
    expect(vi.mocked(reloadPane)).toHaveBeenCalledTimes(1);
  });

  it('an email switch reloads before the new email renders', async () => {
    vi.useFakeTimers();
    servePendingBuild();
    const { rerender } = render(<NavaPane bridge={fakeBridge} />);
    await flush(0);

    rerender(<NavaPane bridge={otherEmailBridge} />);
    await flush(0);
    expect(vi.mocked(reloadPane)).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Loading the latest Nava pane…')).toBeDefined();
    expect(screen.queryByText('Different Guest Request')).toBeNull();
  });

  it('an in-flight mutation blocks both the email-switch reload and the idle reload', async () => {
    vi.useFakeTimers();
    servePendingBuild();
    const { rerender } = render(<NavaPane bridge={fakeBridge} />);
    await flush(0);

    const pendingMutation = countMutationsLink({} as never)({
      op: { id: 3, type: 'mutation', path: 'workstation.x', input: undefined, context: {} },
      next: () => observable(() => () => {}),
    } as never).subscribe({});

    rerender(<NavaPane bridge={otherEmailBridge} />);
    await flush(0);
    expect(vi.mocked(reloadPane)).not.toHaveBeenCalled();
    expect(screen.getByText('Different Guest Request')).toBeDefined();

    await flush(20 * 60_000);
    expect(vi.mocked(reloadPane)).not.toHaveBeenCalled();

    pendingMutation.unsubscribe();
    await flush(60_000);
    expect(vi.mocked(reloadPane)).toHaveBeenCalledTimes(1);
  });

  it('shows the Find the booking card for a voucher email, with the guest the voucher names', async () => {
    voucherFindQuery.mockResolvedValue({
      status: 'voucher',
      messageId: 'mail-1',
      guest: { lastName: 'Smith', arrival: '2026-11-12' },
      file: null,
    });
    render(<NavaPane bridge={fakeBridge} />);
    expect(await screen.findByRole('region', { name: 'Find the booking' })).toBeDefined();
    expect(screen.getByText(/Guest Smith/)).toBeDefined();
    expect(voucherFindQuery).toHaveBeenCalledWith({ internetMessageId: '<quote-request@example.invalid>' });
  });

  it('keeps the Find the booking card hidden for an email that is not a voucher', async () => {
    render(<NavaPane bridge={fakeBridge} />);
    await waitFor(() =>
      expect(voucherFindQuery).toHaveBeenCalledWith({ internetMessageId: '<quote-request@example.invalid>' }),
    );
    expect(screen.queryByRole('region', { name: 'Find the booking' })).toBeNull();
  });

  /**
   * Each element's own text nodes, one per line so words never run together, plus the labelled
   * attributes that screen readers and tooltips read. (happy-dom's TreeWalker finds no text, so the
   * walk goes through childNodes instead.)
   */
  function staffVisibleText(): string {
    const elements = [document.body, ...Array.from(document.body.querySelectorAll('*'))];
    const texts = elements.flatMap((element) =>
      Array.from(element.childNodes)
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent ?? ''),
    );
    const labelled = elements.flatMap((element) =>
      ['aria-label', 'alt', 'title', 'placeholder'].map((name) => element.getAttribute(name) ?? ''),
    );
    return [...texts, ...labelled].join('\n');
  }

  it('shows no retired assistant name on any screen, including the voucher card', async () => {
    localStorage.removeItem('nava_onboarding_completed');
    // A voucher whose guest surname could not be read, with its PDF unread: the card adds no surname note of its own.
    voucherFindQuery.mockResolvedValue({
      status: 'voucher',
      messageId: 'mail-1',
      guest: { lastName: null, arrival: '2026-11-12' },
      file: null,
      unreadPdfs: 1,
    });
    render(<NavaPane bridge={fakeBridge} />);
    expect(staffVisibleText()).not.toMatch(/luna/i);

    fireEvent.click(screen.getByRole('button', { name: /2\. Connection/i }));
    await screen.findByText(/Workstation API ping verified/);
    expect(staffVisibleText()).not.toMatch(/luna/i);

    fireEvent.click(screen.getByRole('button', { name: /3\. Tour/i }));
    expect(staffVisibleText()).not.toMatch(/luna/i);

    fireEvent.click(screen.getByRole('button', { name: /4\. Quote Tool/i }));
    expect(await screen.findByRole('region', { name: 'Find the booking' })).toBeDefined();
    expect(screen.queryByText(/Tell Nava/i)).toBeNull();
    expect(staffVisibleText()).not.toMatch(/luna/i);
  });
});

/**
 * Characterisation for the block split: each first-run and tool state, asserted on what staff see and kept as a
 * DOM snapshot. The split must leave every snapshot unchanged.
 */
describe('NavaPane screen states', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    bridgeMockState.holdStaffQuote = false;
    bridgeMockState.releaseStaffQuote = null;
    bridgeMockState.lastStaffQuoteInput = null;
    bridgeMockState.staffQuoteJobCalls.length = 0;
    bridgeMockState.queueStaffQuoteMutation.mockReset().mockResolvedValue({ runId: null });
    bridgeMockState.jobQueueEnabledQuery.mockReset().mockResolvedValue(false);
    voucherFindQuery.mockReset();
    voucherFindQuery.mockResolvedValue({ status: 'not_voucher' });
    bridgeMockState.staffQuoteJobQuery.mockReset().mockResolvedValue(null);
    bridgeMockState.listThreadQuoteRevisionsQuery.mockReset().mockResolvedValue([]);
    bridgeMockState.usePriorQuoteForBookingMutation
      .mockReset()
      .mockResolvedValue({ status: 'unavailable', reason: 'No prior quote.' });
    bridgeMockState.prepareBookingDraftMutation
      .mockReset()
      .mockResolvedValue({ status: 'unavailable', reason: 'No draft.' });
    vi.mocked(toast.warning).mockClear();
  });

  afterEach(() => {
    bridgeMockState.analysisOverride = null;
    bridgeMockState.analyseCalls = 0;
    bridgeMockState.analyseFails = false;
    bridgeMockState.storedWork = null;
    bridgeMockState.storedLookupGate = null;
    bridgeMockState.staffQuoteJobCalls.length = 0;
    setMailCacheScope({ userId: null, activeTransportId: null });
    bridgeMockState.recordEvent.mockReset();
    bridgeMockState.recordEvent.mockResolvedValue({ aiValue: null, value: null });
    localStorage.clear();
    sessionStorage.clear();
    cleanup();
  });

  /** Lets the analysis, source and voucher reads that follow the first render land before the DOM is read. */
  const settle = () =>
    act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

  it('welcome: a first run shows the account step and the four-step bar', () => {
    localStorage.removeItem('nava_onboarding_completed');
    const { container } = render(<NavaPane bridge={fakeBridge} />);
    expect(screen.getByRole('heading', { name: 'Welcome to Nava' })).toBeDefined();
    expect(screen.getByText('ropperman@legacyhotels.co.za')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Confirm Account & Connect' })).toBeDefined();
    expect(screen.getByRole('button', { name: '4. Quote Tool' })).toBeDefined();
    expect(screen.queryByRole('main')).toBeNull();
    expect(container.querySelector('header')?.querySelector('button[aria-label^="Needs you"]')).toBeNull();
    expect(container).toMatchSnapshot();
  });

  it('tool: a finished first run opens the quote tool on the selected email', async () => {
    const { container } = render(<NavaPane bridge={fakeBridge} />);
    expect(screen.queryByRole('button', { name: '4. Quote Tool' })).toBeNull();
    expect(container.querySelector('#quote-selected-message')?.textContent).toContain('Suite Availability Request');
    expect(
      await screen.findByText('Nava filled these in from the email. Check them before getting rates.'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Draft quotation into email reply' })).toBeDefined();
    await settle();
    expect(container).toMatchSnapshot();
  });

  it.each([320, 380])('keeps the compact Needs you link between the title and connection status at %ipx', async (width) => {
    const { container } = render(
      <div style={{ width: `${width}px`, maxWidth: `${width}px` }}>
        <NavaPane bridge={fakeBridge} />
      </div>,
    );
    const header = container.querySelector('header');
    expect(header).not.toBeNull();
    const title = header!.querySelector('h1');
    const needsYou = within(header as HTMLElement).getByRole('button', { name: /Needs you/ });
    const centurion = within(header as HTMLElement).getByText('Centurion');
    const elements = [...header!.querySelectorAll('h1, button, span')];
    expect(elements.indexOf(title!)).toBeLessThan(elements.indexOf(needsYou));
    expect(elements.indexOf(needsYou)).toBeLessThan(elements.indexOf(centurion));
    expect(title!.className).toMatch(/truncate|whitespace-nowrap/);
    expect(needsYou.className).toMatch(/truncate|whitespace-nowrap/);
    expect(title!.parentElement?.className).toMatch(/min-w-0/);
    expect(header!.children[0]?.className).toMatch(/shrink-0/);
    expect(header!.children[1]?.className).toMatch(/min-w-0/);
    expect(header!.children[1]?.className).toMatch(/\bshrink\b/);
    expect(header!.textContent).toContain('Nava Reservationist');
    expect(container.firstElementChild?.getAttribute('style')).toContain(`width: ${width}px`);
  });

  it('booking: an amendment email shows the change card with the guest request and the confirmation number', async () => {
    bridgeMockState.analysisOverride = {
      status: 'ready',
      intent: 'other',
      groups: [],
      secondaryAsks: [],
      alternatives: [],
      sourceRevision: 1,
      amendment: {
        kind: 'amend',
        confirmationNumber: '57291630-1',
        guestLastName: 'Smith',
        arrival: '2026-10-31',
        departure: '2026-11-07',
        requestedChange: 'Add the night of 31 Oct',
      },
    };
    const { container } = render(<NavaPane bridge={fakeBridge} />);
    const card = await screen.findByRole('region', { name: 'Change to an existing booking' });
    expect(card.textContent).toContain('Add the night of 31 Oct');
    expect(card.textContent).toContain('57291630-1');
    await settle();
    expect(container).toMatchSnapshot();
  });

  const STORED_READY = {
    status: 'ready',
    workItemId: 'wi-1',
    workItemStatus: 'needs_you',
    extractionId: 'ex-1',
    refs: { r_1: { stayId: 's_1', rowId: 'r_1' } },
    analysis: {
      intent: 'quote',
      groups: [
        {
          id: 'r_1',
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

  const BOOKING_LUNA = {
    workflow: 'create_booking' as const,
    flags: [],
    groups: [],
    party: { kind: null, name: null, reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [],
  };
  const STAFF_QUOTE_READY = {
    status: 'ready',
    workflowRunId: 'workflow-restored',
    revisionRef: 'revision-restored',
    messageId: 'mail-1',
    threadId: 'thread-1',
    factRefs: [],
    selectionEpoch: 1,
    inputRevision: 1,
    inputDigest: 'restored-digest',
    totalMinor: 245_000,
    currency: 'ZAR',
    arrivalDate: '2026-11-03',
    departureDate: '2026-11-05',
    description: 'Restored HMS allocation',
  };

  function bookingStoredWork() {
    return {
      ...STORED_READY,
      analysis: { ...STORED_READY.analysis, luna: BOOKING_LUNA },
    };
  }

  function completedStaffQuoteJob(result: Record<string, unknown>) {
    return {
      runId: 'staff-job-restored',
      status: 'done' as const,
      result,
      failureClass: null,
      asOf: new Date().toISOString(),
    };
  }

  // The stored API shape produced for this human-written extraction carries the extracted booking and guest details
  // into analysis.amendment; the pane must use that stored result rather than re-reading it live.
  const STORED_AMENDMENT_EXTRACTION = {
    kind: 'amendment',
    payload: {
      origin: 'person',
      contact: { name: 'Lerato Mokoena', email: 'lerato@example.invalid', phone: null },
      confirmationNumbers: ['57291630-1'],
      stays: [
        {
          requested: { arrival: '2026-10-31', departure: '2026-11-07' },
          booked: { arrival: '2026-11-01', departure: '2026-11-06' },
        },
      ],
    },
  };
  const STORED_AMENDMENT_KIND =
    STORED_AMENDMENT_EXTRACTION.kind === 'amendment' ? ('amend' as const) : ('cancel' as const);
  const STORED_AMENDMENT = {
    status: 'ready',
    workItemId: 'wi-amendment',
    workItemStatus: 'needs_you',
    extractionId: 'ex-amendment',
    refs: {},
    contact: {
      name: STORED_AMENDMENT_EXTRACTION.payload.contact.name,
      email: STORED_AMENDMENT_EXTRACTION.payload.contact.email,
      phone: null,
      company: null,
      endClient: null,
    },
    language: 'en',
    translation: null,
    analysis: {
      intent: 'other',
      groups: [],
      secondaryAsks: [],
      alternatives: [],
      source: 'luna',
      aiUnavailable: false,
      luna: {
        workflow: STORED_AMENDMENT_KIND,
        flags: ['amendment_or_cancel'],
        groups: [],
        confirmationNumber: STORED_AMENDMENT_EXTRACTION.payload.confirmationNumbers[0],
        guestLastName: null,
        arrival: '2026-11-01',
        departure: '2026-11-06',
        requestedArrival: '2026-10-31',
        requestedDeparture: '2026-11-07',
        requestedChange: null,
      },
      amendment: {
        kind: STORED_AMENDMENT_KIND,
        confirmationNumber: STORED_AMENDMENT_EXTRACTION.payload.confirmationNumbers[0],
        guestLastName: null,
        arrival: STORED_AMENDMENT_EXTRACTION.payload.stays[0]!.booked.arrival,
        departure: STORED_AMENDMENT_EXTRACTION.payload.stays[0]!.booked.departure,
        requestedArrival: STORED_AMENDMENT_EXTRACTION.payload.stays[0]!.requested.arrival,
        requestedDeparture: STORED_AMENDMENT_EXTRACTION.payload.stays[0]!.requested.departure,
        requestedChange: null,
      },
    },
  };

  /**
   * The stored read fills the first stay. Since U16 added the contact block and translation, the full pane render can
   * pass the 1 s default on a loaded box, and a miss here shifts the useId values in every later snapshot.
   */
  const storedReadLands = () =>
    waitFor(() => expect((screen.getAllByLabelText(/Arrival/i)[0] as HTMLInputElement).value).toBe('2026-11-03'), {
      timeout: 4000,
    });

  it('stored: a mail with a stored read opens from it and makes no live read', async () => {
    bridgeMockState.storedWork = STORED_READY;
    render(<NavaPane bridge={fakeBridge} />);
    await storedReadLands();
    await settle();
    expect(bridgeMockState.analyseCalls).toBe(0);
  });

  it('stored: a human-written amendment extraction renders Find booking without a live read or ApproveCard', async () => {
    bridgeMockState.storedWork = STORED_AMENDMENT;
    render(<NavaPane bridge={fakeBridge} />);

    const panel = await screen.findByRole(
      'region',
      { name: 'Change to an existing booking' },
      { timeout: 4000 },
    );
    expect(panel.textContent).toContain('57291630-1');
    expect(panel.textContent).toContain('Find this booking in HMS');
    expect(panel.textContent).toContain('31 Oct 2026');
    expect(panel.textContent).toContain('7 Nov 2026');
    expect(screen.getByText('Lerato Mokoena')).toBeDefined();
    await settle();
    expect(bridgeMockState.analyseCalls).toBe(0);
    expect(screen.queryByText(/Saving to HMS from this pane is off for now/)).toBeNull();
    expect(screen.queryByRole('button', { name: /approve|re.?read/i })).toBeNull();
  });

  it('stored: a change that cannot be saved shows a quiet retry, and the retry sends it again', async () => {
    bridgeMockState.storedWork = STORED_READY;
    bridgeMockState.recordEvent.mockRejectedValue(new Error('offline'));
    render(<NavaPane bridge={fakeBridge} />);
    await storedReadLands();
    fireEvent.click(screen.getByRole('button', { name: 'Edit adults per room for stay 1, room 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'More: Adult guests per room for stay 1, room 1' }));
    expect(await screen.findByText(/Couldn.t save change/, {}, { timeout: 6000 })).toBeDefined();
    expect(bridgeMockState.recordEvent).toHaveBeenCalledTimes(2);
    bridgeMockState.recordEvent.mockResolvedValue({ aiValue: 2, value: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Couldn.t save change/)).toBeNull());
    expect(bridgeMockState.recordEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ workItemId: 'wi-1', fieldPath: 'stays[s_1].rows[r_1].adults', value: 3 }),
    );
  }, 15_000);

  it('stored: a stay she adds is logged under its own id, so it is there on reopen', async () => {
    bridgeMockState.storedWork = STORED_READY;
    render(<NavaPane bridge={fakeBridge} />);
    await storedReadLands();
    fireEvent.click(screen.getByRole('button', { name: '+ Add another date range' }));
    await waitFor(() =>
      expect(bridgeMockState.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ workItemId: 'wi-1', fieldPath: expect.stringMatching(/^stays\[s_\w+\]\.removed$/), value: null }),
      ),
    );
  });

  it('voucher: a voucher email shows the Find the booking card with the guest it names', async () => {
    voucherFindQuery.mockResolvedValue({
      status: 'voucher',
      messageId: 'mail-1',
      guest: { lastName: 'Smith', arrival: '2026-11-12' },
      file: null,
    });
    const { container } = render(<NavaPane bridge={fakeBridge} />);
    const card = await screen.findByRole('region', { name: VOUCHER_COPY.heading });
    expect(card.textContent).toContain('Guest Smith');
    await settle();
    expect(container).toMatchSnapshot();
  });

  it('voucher: an unreadable PDF keeps the card without a missing-guest or partial-read note of its own', async () => {
    voucherFindQuery.mockResolvedValue({
      status: 'voucher',
      messageId: 'mail-1',
      guest: { lastName: null, arrival: '2026-11-12' },
      file: null,
      unreadPdfs: 1,
    });
    const { container } = render(<NavaPane bridge={fakeBridge} />);
    const card = await screen.findByRole('region', { name: VOUCHER_COPY.heading });
    expect(card.textContent).not.toContain(VOUCHER_COPY.missingGuest);
    // No warning list: the quote panel names the unreadable file once.
    expect(card.querySelector('ul')).toBeNull();
    await settle();
    expect(container).toMatchSnapshot();
  });

  it('review: the system check results sit at the foot of the tool once the check ends', async () => {
    const { container } = render(<NavaPane bridge={fakeBridge} />);
    fireEvent.keyDown(openPaneMenuItem('Run system check'), { key: 'Enter' });
    expect(await screen.findByText('System check results')).toBeDefined();
    expect(screen.getByText('4. Nava server reachable')).toBeDefined();
    await settle();
    expect(container).toMatchSnapshot();
  });

  it('diagnostics: the connection step after a successful server ping', async () => {
    localStorage.removeItem('nava_onboarding_completed');
    const { container } = render(<NavaPane bridge={fakeBridge} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Account & Connect' }));
    expect(await screen.findByText(/API server pinged at/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /Needs you/ })).toBeNull();
    await settle();
    expect(container).toMatchSnapshot();
  });

  it('tour: the first slide of the feature tour, opened once the server ping succeeds', async () => {
    localStorage.removeItem('nava_onboarding_completed');
    const { container } = render(<NavaPane bridge={fakeBridge} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Account & Connect' }));
    await screen.findByText(/API server pinged at/);
    fireEvent.click(screen.getByRole('button', { name: 'Next: 60-Second Feature Tour' }));
    expect(screen.getByRole('heading', { name: '1. Automatic Email Sync' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Needs you/ })).toBeNull();
    await settle();
    expect(container).toMatchSnapshot();
  });

  it('reply: an automated sender gets no Insert draft button (AE3)', async () => {
    bridgeMockState.analysisOverride = {
      status: 'ready',
      intent: 'quote',
      groups: [
        {
          id: 'g1',
          childrenAges: [],
          board: 'unknown',
          quantity: 1,
          specialRequests: [],
          fields: { arrivalDate: 'missing', departureDate: 'missing', adults: 'missing' },
        },
      ],
      secondaryAsks: [],
      alternatives: [],
      sourceRevision: 1,
      noReplySender: true,
    };
    render(<NavaPane bridge={fakeBridge} />);
    expect(
      await screen.findByText(
        'Nava filled these in from the email. Check them before getting rates.',
      ),
    ).toBeDefined();
    await settle();
    expect(screen.queryByRole('button', { name: 'Draft quotation into email reply' })).toBeNull();
  });

  it('reply: keeps reply actions visible while quote analysis is unsynced', async () => {
    bridgeMockState.analysisOverride = { status: 'unsynced' };
    render(<NavaPane bridge={fakeBridge} />);
    expect(await screen.findByText(/not finished syncing/i)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Insert draft in Outlook' })).toBeDefined();
  });

  it('preview: the webmail reply saves to the thread, not that the add-in is too old', async () => {
    render(<NavaPane bridge={fakeBridge} preview />);
    // The webmail reply saves the thread's draft (U22), so it waits for sync rather than pointing at Outlook.
    expect(
      await screen.findByText('Wait for this email to sync, then select it again'),
    ).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Draft quotation into email reply' })).toBeDefined();
    expect(screen.queryByText(/add-in is too old/)).toBeNull();
  });

  it('preview: uses Guest for a nameless sender and saves the reviewed PDF through webmail', async () => {
    bridgeMockState.analysisOverride = {
      status: 'ready',
      intent: 'quote',
      groups: [
        {
          id: 'g1',
          childrenAges: [],
          board: 'bb',
          quantity: 1,
          specialRequests: [],
          fields: { arrivalDate: 'missing', departureDate: 'missing', adults: 'missing' },
        },
      ],
      secondaryAsks: [],
      alternatives: [],
      sourceRevision: 1,
    };
    const namelessBridge = {
      ...fakeBridge,
      activeEmail: {
        ...fakeBridge.activeEmail!,
        senderName: fakeBridge.activeEmail!.senderEmail,
      },
    } as PaneBridge;
    render(<NavaPane bridge={namelessBridge} preview />);
    await prepareReviewedQuote(null);

    const expectedHtml = quoteWrapperHtml('', 'R Opperman');
    expect((screen.getByLabelText('Reviewed reply') as HTMLTextAreaElement).value).toBe(expectedHtml);
    fireEvent.click(screen.getByRole('button', { name: 'Draft quotation into email reply' }));

    await waitFor(() => {
      expect(saveReplyMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expectedHtml.trim(),
          attachments: [
            expect.objectContaining({
              name: AUTHORISED_QUOTE_PDF.fileName,
              type: 'application/pdf',
              base64: AUTHORISED_QUOTE_PDF.pdfBase64,
            }),
          ],
        }),
      );
    });
    expect(sendCommandMock).not.toHaveBeenCalledWith('CREATE_REPLY_DRAFT', expect.anything());
  }, 15_000);

  // These render the pane after the snapshots above, so the useId values in those snapshots do not shift.
  it('retry read runs the read again after a failed live read', async () => {
    bridgeMockState.analyseFails = true;
    render(<NavaPane bridge={fakeBridge} />);
    const retry = await screen.findByRole('button', { name: 'Retry reading this email' }, { timeout: 3000 });
    const calls = bridgeMockState.analyseCalls;
    bridgeMockState.analyseFails = false;
    fireEvent.click(retry);
    await waitFor(() => expect(bridgeMockState.analyseCalls).toBe(calls + 1));
  });

  it('stored: what she types while the stored read loads is laid over it and logged, so it is there on reopen', async () => {
    bridgeMockState.storedWork = STORED_READY;
    let release = () => {};
    bridgeMockState.storedLookupGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(<NavaPane bridge={fakeBridge} />);
    const arrival = await screen.findByLabelText(/Arrival/i);
    fireEvent.change(arrival, { target: { value: '2026-11-04' } });
    release();
    await waitFor(
      () =>
        expect(bridgeMockState.recordEvent).toHaveBeenCalledWith(
          expect.objectContaining({ workItemId: 'wi-1', fieldPath: 'stays[s_1].requested.arrival', value: '2026-11-04' }),
        ),
      { timeout: 3000 },
    );
    expect(bridgeMockState.recordEvent).toHaveBeenCalledTimes(1);
    expect((screen.getAllByLabelText(/Arrival/i)[0] as HTMLInputElement).value).toBe('2026-11-04');
    expect((screen.getAllByLabelText(/Departure/i)[0] as HTMLInputElement).value).toBe('2026-11-05');
  });

  it('stored: shows a multi-row room total on the stay as an unset split', async () => {
    const group = STORED_READY.analysis.groups[0]!;
    bridgeMockState.storedWork = {
      ...STORED_READY,
      refs: {
        r_1: { stayId: 's_1', rowId: 'r_1' },
        r_2: { stayId: 's_1', rowId: 'r_2' },
      },
      analysis: {
        ...STORED_READY.analysis,
        groups: [
          { ...group, stayId: 's_1', quantity: undefined },
          { ...group, id: 'r_2', stayId: 's_1', quantity: undefined },
        ],
        requestedRoomsByStay: { s_1: 30 },
      },
    };
    render(<NavaPane bridge={fakeBridge} />);
    await storedReadLands();

    expect(await screen.findByText(/30 rooms requested · split not set/)).toBeDefined();
    expect(screen.queryByText(/Email requested 30 rooms in total/)).toBeNull();
  });

  it('stored: moves a single-row total to the stay when a second room row is added', async () => {
    const group = STORED_READY.analysis.groups[0]!;
    bridgeMockState.storedWork = {
      ...STORED_READY,
      analysis: {
        ...STORED_READY.analysis,
        groups: [{ ...group, stayId: 's_1', quantity: 6, fields: { ...group.fields, quantity: 'defaulted' } }],
        requestedRoomsByStay: { s_1: 6 },
      },
    };
    render(<NavaPane bridge={fakeBridge} />);
    await storedReadLands();

    expect(screen.queryByText(/Email requested 6 rooms in total/)).toBeNull();
    expect(screen.getByRole('group', { name: 'Rooms for stay 1, room 1' }).textContent).toContain('6');

    fireEvent.click(screen.getByRole('button', { name: '+ Add room type' }));

    await waitFor(() => expect(screen.getByText(/6 rooms requested · split not set/)).toBeDefined());
    const roomCounts = screen.getAllByRole('group', { name: /Rooms for/ });
    expect(roomCounts).toHaveLength(2);
    expect(roomCounts.every((group) => group.textContent?.includes('–'))).toBe(true);
  });

  it('stored: does not use sender fallback after extraction is ready, even when contact values are empty', async () => {
    bridgeMockState.storedWork = {
      ...STORED_READY,
      contact: { name: null, company: null, endClient: null, email: null, phone: null },
    };
    render(<NavaPane bridge={fakeBridge} />);
    await storedReadLands();

    openContactCorrections();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('');
  });

  it('restores a finished staff rate from the persisted job after pane mount', async () => {
    bridgeMockState.storedWork = bookingStoredWork();
    bridgeMockState.jobQueueEnabledQuery.mockResolvedValue(true);
    bridgeMockState.staffQuoteJobQuery.mockResolvedValue(completedStaffQuoteJob(STAFF_QUOTE_READY));

    render(<NavaPane bridge={fakeBridge} />);
    await storedReadLands();

    expect(await screen.findByText('Available')).toBeDefined();
    expect(screen.getByRole('button', { name: /Restored HMS allocation/ })).toBeDefined();
    expect(bridgeMockState.staffQuoteJobQuery).toHaveBeenCalledWith({
      input: expect.objectContaining({ messageId: 'mail-1', selectionEpoch: expect.any(Number) }),
    });
    await waitFor(() =>
      expect(bridgeMockState.prepareBookingDraftMutation).toHaveBeenCalledWith(
        expect.objectContaining({ workflowRunId: 'workflow-restored', revisionRef: 'revision-restored' }),
      ),
    );
  });

  it('keeps a persisted staff-quote refusal instead of falling back to an older quote', async () => {
    const refusal = 'HMS has no rate for this meal plan under BAR. Try another meal plan.';
    bridgeMockState.storedWork = bookingStoredWork();
    bridgeMockState.jobQueueEnabledQuery.mockResolvedValue(true);
    bridgeMockState.staffQuoteJobQuery.mockResolvedValue(
      completedStaffQuoteJob({ ok: false, code: 'PRECONDITION_FAILED', message: refusal }),
    );
    bridgeMockState.listThreadQuoteRevisionsQuery.mockResolvedValue([
      { workflowRunId: 'older-workflow', revisionRef: 'older-revision' },
    ]);

    render(<NavaPane bridge={fakeBridge} />);
    await storedReadLands();

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(refusal));
    expect(bridgeMockState.listThreadQuoteRevisionsQuery).not.toHaveBeenCalled();
    expect(bridgeMockState.usePriorQuoteForBookingMutation).not.toHaveBeenCalled();
    expect(screen.queryByText('Available')).toBeNull();
  });

  it('drops a restored rate when the stay changes while its persisted job is being read', async () => {
    let resolveReadback!: (view: ReturnType<typeof completedStaffQuoteJob>) => void;
    let readbackCalls = 0;
    bridgeMockState.storedWork = bookingStoredWork();
    bridgeMockState.jobQueueEnabledQuery.mockResolvedValue(true);
    bridgeMockState.staffQuoteJobQuery.mockImplementation(
      () => {
        if (readbackCalls++ > 0) return Promise.resolve(null);
        return new Promise((resolve) => { resolveReadback = resolve; });
      },
    );

    render(<NavaPane bridge={fakeBridge} />);
    await waitFor(() => expect(bridgeMockState.staffQuoteJobQuery).toHaveBeenCalled());
    const roomType = await screen.findByLabelText('Room type');
    fireEvent.change(roomType, { target: { value: 'SKNG' } });

    await act(async () => resolveReadback(completedStaffQuoteJob(STAFF_QUOTE_READY)));
    await settle();

    expect(screen.queryByText('Available')).toBeNull();
    expect(bridgeMockState.prepareBookingDraftMutation).not.toHaveBeenCalled();
  });

  it('auto-queues a complete stay and reports the rate run in the pane notice system', async () => {
    let staffQuotePolls = 0;
    sessionStorage.removeItem('nava.staff-quote-auto-suppressed:<quote-request@example.invalid>');
    bridgeMockState.storedWork = {
      ...STORED_READY,
      contact: {
        name: 'Guest Example',
        company: 'Example Agency',
        endClient: 'Example Company',
        email: null,
        phone: null,
      },
    };
    bridgeMockState.jobQueueEnabledQuery.mockResolvedValue(true);
    bridgeMockState.queueStaffQuoteMutation.mockImplementation((input: Record<string, unknown>) => {
      bridgeMockState.lastStaffQuoteInput = input;
      return Promise.resolve({ runId: 'staff-job-1' });
    });
    bridgeMockState.staffQuoteJobQuery.mockImplementation(async (input: { input?: unknown; runId?: string }) => {
      if (!input.runId) return null;
      if (staffQuotePolls++ === 0) {
        return {
          runId: input.runId ?? 'staff-job-1',
          status: 'running',
          result: null,
          failureClass: null,
          asOf: new Date().toISOString(),
        };
      }
      const request = bridgeMockState.lastStaffQuoteInput!;
      const groups = request.groups as Array<{ arrivalDate: string; departureDate: string }>;
      return completedStaffQuoteJob({
        ...STAFF_QUOTE_READY,
        selectionEpoch: request.selectionEpoch,
        inputRevision: request.inputRevision,
        arrivalDate: groups[0]!.arrivalDate,
        departureDate: groups[0]!.departureDate,
      });
    });

    render(
      <HmsJobNoticeProvider emailKey="mail-1" emailSubject="Quote request">
        <NavaPane bridge={fakeBridge} hmsNoticesManagedByParent />
      </HmsJobNoticeProvider>,
    );
    await storedReadLands();
    expect(await screen.findByText('Nava is getting rates from HMS — you can keep working')).toBeDefined();
    await waitFor(() => expect(bridgeMockState.queueStaffQuoteMutation).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('hms-running-count').textContent).toBe('HMS: 1 pending');
    expect(bridgeMockState.lastStaffQuoteInput).toMatchObject({
      messageId: 'mail-1',
      autoStart: true,
      salesStrategy: 'BAR',
      agency: 'Example Agency',
      company: 'Example Company',
      groups: [expect.objectContaining({ arrivalDate: '2026-11-03', departureDate: '2026-11-05' })],
    });
    expect(bridgeMockState.lastStaffQuoteInput).not.toHaveProperty('parties');

    const notice = await screen.findByTestId('hms-job-notice-banner', {}, { timeout: 5_000 });
    expect(notice.textContent).toContain('Rates ready');
    expect(within(notice).getByRole('button', { name: 'Show' }).getAttribute('aria-controls')).toBe('quote-rates');
  });

  it('auto-queues each complete date option once', async () => {
    const firstGroup = STORED_READY.analysis.groups[0]!;
    bridgeMockState.storedWork = {
      ...STORED_READY,
      refs: {
        r_1: { stayId: 's_1', rowId: 'r_1' },
        r_2: { stayId: 's_2', rowId: 'r_2' },
      },
      analysis: {
        ...STORED_READY.analysis,
        groups: [
          { ...firstGroup, id: 'r_1' },
          { ...firstGroup, id: 'r_2', arrivalDate: '2026-11-05', departureDate: '2026-11-07' },
        ],
      },
    };
    bridgeMockState.jobQueueEnabledQuery.mockResolvedValue(true);
    const queued = new Map<string, Record<string, unknown>>();
    bridgeMockState.queueStaffQuoteMutation.mockImplementation(async (input: Record<string, unknown>) => {
      const runId = `staff-job-${queued.size + 1}`;
      queued.set(runId, input);
      return { runId };
    });
    bridgeMockState.staffQuoteJobQuery.mockImplementation(async (input: { runId?: string }) => {
      if (!input.runId) return null;
      const request = queued.get(input.runId);
      if (!request) return null;
      const groups = request.groups as Array<{ arrivalDate: string; departureDate: string }>;
      return {
        runId: input.runId,
        status: 'done',
        result: {
          ...STAFF_QUOTE_READY,
          selectionEpoch: request.selectionEpoch,
          inputRevision: request.inputRevision,
          arrivalDate: groups[0]!.arrivalDate,
          departureDate: groups[0]!.departureDate,
        },
        failureClass: null,
        asOf: new Date().toISOString(),
      };
    });

    render(<NavaPane bridge={fakeBridge} />);
    await storedReadLands();

    await waitFor(() => expect(bridgeMockState.queueStaffQuoteMutation).toHaveBeenCalledTimes(2));
    await settle();
    expect([...queued.values()].map((input) => (input.groups as Array<{ arrivalDate: string }>)[0]!.arrivalDate)).toEqual([
      '2026-11-03',
      '2026-11-05',
    ]);
    expect([...queued.values()].every((input) => input.autoStart === true)).toBe(true);
    expect(bridgeMockState.queueStaffQuoteMutation).toHaveBeenCalledTimes(2);
  });

  it('reads back the first email’s fresh quote when returning from another email', async () => {
    sessionStorage.removeItem('nava.staff-quote-auto-suppressed:<quote-request@example.invalid>');
    sessionStorage.removeItem('nava.staff-quote-auto-suppressed:<other-quote@example.invalid>');
    bridgeMockState.storedWork = STORED_READY;
    bridgeMockState.staffQuoteSources['<other-quote@example.invalid>'] = {
      messageId: 'mail-2',
      threadId: 'thread-2',
      sourceHash: 'cd'.repeat(32),
    };
    bridgeMockState.jobQueueEnabledQuery.mockResolvedValue(true);
    const queued = new Map<string, Record<string, unknown>>();
    bridgeMockState.queueStaffQuoteMutation.mockImplementation(async (input: Record<string, unknown>) => {
      const runId = `staff-job-${queued.size + 1}`;
      queued.set(runId, input);
      return { runId };
    });
    const completed = (runId: string, request: Record<string, unknown>) => {
      const groups = request.groups as Array<{ arrivalDate: string; departureDate: string }>;
      return {
        runId,
        status: 'done' as const,
        result: {
          ...STAFF_QUOTE_READY,
          workflowRunId: `workflow-${request.messageId}`,
          revisionRef: `revision-${request.messageId}`,
          messageId: request.messageId,
          threadId: request.messageId === 'mail-2' ? 'thread-2' : 'thread-1',
          selectionEpoch: request.selectionEpoch,
          inputRevision: request.inputRevision,
          arrivalDate: groups[0]!.arrivalDate,
          departureDate: groups[0]!.departureDate,
          description: `Allocation for ${request.messageId}`,
        },
        failureClass: null,
        asOf: new Date().toISOString(),
      };
    };
    bridgeMockState.staffQuoteJobQuery.mockImplementation(
      async (input: { runId?: string; input?: Record<string, unknown> }) => {
        if (input.runId) {
          const request = queued.get(input.runId);
          return request ? completed(input.runId, request) : null;
        }
        const match = [...queued.entries()].find(([, request]) => request.messageId === input.input?.messageId);
        return match ? completed(match[0], match[1]) : null;
      },
    );
    const bridgeFor = (entryId: string, internetMessageId: string, subject: string) =>
      ({
        ...fakeBridge,
        activeEmail: { ...fakeBridge.activeEmail!, entryId, internetMessageId, subject },
      }) as unknown as PaneBridge;

    const { rerender } = render(<NavaPane bridge={bridgeFor('001', '<quote-request@example.invalid>', 'Quote A')} />);
    await storedReadLands();
    await waitFor(() => expect(bridgeMockState.queueStaffQuoteMutation).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: /Allocation for mail-1/ })).toBeDefined();

    rerender(<NavaPane bridge={bridgeFor('002', '<other-quote@example.invalid>', 'Quote B')} />);
    await waitFor(() => expect(bridgeMockState.queueStaffQuoteMutation).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: /Allocation for mail-2/ })).toBeDefined();

    rerender(<NavaPane bridge={bridgeFor('001', '<quote-request@example.invalid>', 'Quote A')} />);
    await waitFor(() =>
      expect(bridgeMockState.staffQuoteJobQuery).toHaveBeenCalledWith({
        input: expect.objectContaining({ messageId: 'mail-1' }),
      }),
    );
    expect(await screen.findByRole('button', { name: /Allocation for mail-1/ })).toBeDefined();
    expect(bridgeMockState.queueStaffQuoteMutation).toHaveBeenCalledTimes(2);
  });

  // Banner Retry removed (Greptile P1, 2026-10-13): a failed lookup is retried from its own card.
  it.skip('does not auto-run again after a failed background quote; Get rates remains a manual retry', async () => {
    bridgeMockState.storedWork = STORED_READY;
    bridgeMockState.jobQueueEnabledQuery.mockResolvedValue(true);
    bridgeMockState.queueStaffQuoteMutation.mockResolvedValue({ runId: 'staff-job-failed' });
    bridgeMockState.staffQuoteJobQuery.mockResolvedValue({
      runId: 'staff-job-failed',
      status: 'done',
      result: { ok: false, code: 'rate_missing', message: 'HMS could not find a rate for this request.' },
      failureClass: null,
    });

    render(<NavaPane bridge={fakeBridge} />);
    await storedReadLands();

    const notice = await screen.findByTestId('hms-job-notice-banner');
    expect(notice.textContent).toContain('Rates failed: HMS could not find a rate for this request.');
    await settle();
    expect(bridgeMockState.queueStaffQuoteMutation).toHaveBeenCalledTimes(1);

    fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(bridgeMockState.queueStaffQuoteMutation).toHaveBeenCalledTimes(2));
    expect(bridgeMockState.queueStaffQuoteMutation.mock.calls[0]?.[0]).toHaveProperty('autoStart', true);
    expect(bridgeMockState.queueStaffQuoteMutation.mock.calls[1]?.[0]).not.toHaveProperty('autoStart');
  });

  // Banner Retry removed (Greptile P1, 2026-10-13): a failed lookup is retried from its own card.
  it.skip('Retry resumes the same POLL_LOST quote through its original mailbox route', async () => {
    let resolveInitialStatus!: (view: {
      runId: string;
      status: 'running';
      result: null;
      failureClass: null;
    }) => void;
    let retryReady = false;
    let runIdReads = 0;
    sessionStorage.setItem('nava.staff-quote-auto-suppressed:<quote-request@example.invalid>', '1');
    bridgeMockState.storedWork = STORED_READY;
    bridgeMockState.jobQueueEnabledQuery.mockResolvedValue(true);
    bridgeMockState.queueStaffQuoteMutation.mockImplementation(async (input: Record<string, unknown>) => {
      bridgeMockState.lastStaffQuoteInput = input;
      return { runId: 'staff-job-poll-lost' };
    });
    bridgeMockState.staffQuoteJobQuery.mockImplementation(async (value: unknown) => {
      const input = value as { runId?: string };
      if (retryReady) {
        const request = bridgeMockState.lastStaffQuoteInput!;
        const group = (request.groups as Array<{ arrivalDate: string; departureDate: string }>)[0]!;
        return {
          ...completedStaffQuoteJob({
            ...STAFF_QUOTE_READY,
            selectionEpoch: request.selectionEpoch,
            inputRevision: request.inputRevision,
            arrivalDate: group.arrivalDate,
            departureDate: group.departureDate,
          }),
          runId: input.runId ?? 'staff-job-poll-lost',
        };
      }
      runIdReads += 1;
      if (runIdReads === 1) {
        return new Promise((resolve) => { resolveInitialStatus = resolve; });
      }
      return null;
    });
    setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-a' });

    render(<NavaPane bridge={fakeBridge} />);
    await storedReadLands();
    await fillStayFactsMatchingAuthorisedOffer();
    fireEvent.click(screen.getByRole('button', { name: /^Search availability$/i }));
    await waitFor(() => expect(resolveInitialStatus).toBeTypeOf('function'));

    vi.useFakeTimers();
    await act(async () =>
      resolveInitialStatus({
        runId: 'staff-job-poll-lost',
        status: 'running',
        result: null,
        failureClass: null,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(bridgeMockState.queueStaffQuoteMutation).toHaveBeenCalledTimes(1);
    const notice = screen.getByTestId('hms-job-notice-banner');
    expect(notice.textContent).toContain('Rates failed: The queued quote is still running');
    expect(runIdReads).toBe(21);
    expect(bridgeMockState.queueStaffQuoteMutation).toHaveBeenCalledTimes(1);

    const readsBeforeRetry = bridgeMockState.staffQuoteJobCalls.length;
    act(() => setMailCacheScope({ userId: 'staff-1', activeTransportId: 'transport-b' }));
    retryReady = true;
    vi.useRealTimers();
    fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(bridgeMockState.staffQuoteJobCalls).toHaveLength(readsBeforeRetry + 1));
    expect(bridgeMockState.staffQuoteJobCalls[readsBeforeRetry]).toEqual({
      input: { runId: 'staff-job-poll-lost' },
      activeTransportId: 'transport-a',
    });
    expect(bridgeMockState.queueStaffQuoteMutation).toHaveBeenCalledTimes(1);
    expect((await screen.findByTestId('hms-job-notice-banner')).textContent).toContain('Rates ready');
    expect(await screen.findByText('Available')).toBeDefined();
    expect(screen.getByRole('button', { name: /Restored HMS allocation/ })).toBeDefined();
  });

  it('keeps the rates progress line while an overlapping prior-quote read settles', async () => {
    const finishPriorReads: Array<(view: null) => void> = [];
    bridgeMockState.storedWork = {
      ...STORED_READY,
      analysis: {
        ...STORED_READY.analysis,
        luna: BOOKING_LUNA,
        groups: STORED_READY.analysis.groups.map((group) => ({ ...group, roomCodes: ['SKNG'] })),
      },
    };
    bridgeMockState.jobQueueEnabledQuery.mockResolvedValue(false);
    bridgeMockState.staffQuoteJobQuery.mockImplementation(async (value: unknown) => {
      if ('input' in (value as object)) {
        return new Promise<null>((resolve) => { finishPriorReads.push(resolve); });
      }
      return null;
    });

    render(<NavaPane bridge={fakeBridge} />);
    await storedReadLands();
    await waitFor(() => expect(finishPriorReads).toHaveLength(1));
    const arrival = screen.getAllByLabelText(/Arrival/i)[0] as HTMLInputElement;
    fireEvent.change(arrival, { target: { value: '2026-11-04' } });
    await waitFor(() => expect(finishPriorReads).toHaveLength(2));

    await act(async () => {
      finishPriorReads[0]!(null);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.queryAllByRole('status').some((element) =>
        element.textContent?.includes('Nava is getting rates from HMS') && element.textContent.includes('elapsed'),
      ),
    ).toBe(true);

    await act(async () => finishPriorReads[1]!(null));
    await waitFor(() =>
      expect(
        screen.queryAllByRole('status').some((element) =>
          element.textContent?.includes('Nava is getting rates from HMS') && element.textContent.includes('elapsed'),
        ),
      ).toBe(false),
    );
  });

  it('waits for staff to run rates after they edit the stay while the queue flag is loading', async () => {
    let enableQueueMode!: (enabled: boolean) => void;
    sessionStorage.removeItem('nava.staff-quote-auto-suppressed:<quote-request@example.invalid>');
    bridgeMockState.storedWork = STORED_READY;
    bridgeMockState.jobQueueEnabledQuery.mockImplementation(
      () => new Promise((resolve) => { enableQueueMode = resolve; }),
    );
    bridgeMockState.queueStaffQuoteMutation.mockImplementation((input: Record<string, unknown>) => {
      bridgeMockState.lastStaffQuoteInput = input;
      return Promise.resolve({ runId: 'staff-job-manual' });
    });
    bridgeMockState.staffQuoteJobQuery.mockImplementation(async (input: { input?: unknown; runId?: string }) =>
      input.runId ? completedStaffQuoteJob({ ok: false, code: 'rate_missing', message: 'No matching rate.' }) : null,
    );

    render(<NavaPane bridge={fakeBridge} />);
    await storedReadLands();
    await fillStayFactsMatchingAuthorisedOffer();
    await waitFor(() => expect(enableQueueMode).toBeTypeOf('function'));
    await act(async () => enableQueueMode(true));
    await settle();

    expect(bridgeMockState.queueStaffQuoteMutation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Search availability$/i }));
    await waitFor(() => expect(bridgeMockState.queueStaffQuoteMutation).toHaveBeenCalledTimes(1));
    expect(bridgeMockState.lastStaffQuoteInput).not.toHaveProperty('autoStart');
  });

  it('suppresses auto-start after staff quote edits and uses the edited header, party, and rate plan for Get rates', async () => {
    const queueModeResolvers: Array<(enabled: boolean) => void> = [];
    sessionStorage.removeItem('nava.staff-quote-auto-suppressed:<quote-request@example.invalid>');
    bridgeMockState.storedWork = {
      ...STORED_READY,
      analysis: {
        ...STORED_READY.analysis,
        groups: STORED_READY.analysis.groups.map((group) => ({ ...group, roomCodes: ['SKNG'] })),
      },
    };
    bridgeMockState.jobQueueEnabledQuery.mockImplementation(
      () => new Promise((resolve) => queueModeResolvers.push(resolve)),
    );
    bridgeMockState.queueStaffQuoteMutation.mockImplementation((input: Record<string, unknown>) => {
      bridgeMockState.lastStaffQuoteInput = input;
      return Promise.resolve({ runId: 'staff-job-manual' });
    });
    bridgeMockState.staffQuoteJobQuery.mockImplementation(async (input: { runId?: string }) =>
      input.runId
        ? {
            runId: input.runId,
            status: 'done',
            result: { ok: false, code: 'rate_missing', message: 'No matching rate.' },
            failureClass: null,
            asOf: new Date().toISOString(),
          }
        : null,
    );

    render(<NavaPane bridge={fakeBridge} />);
    await storedReadLands();
    fireEvent.change(screen.getByLabelText('Agency (travel agent)'), { target: { value: 'Edited Agency' } });
    fireEvent.change(screen.getByLabelText('Company (end client)'), { target: { value: 'Edited Company' } });
    fireEvent.change(screen.getByLabelText('Rate plan'), { target: { value: 'government' } });
    await waitFor(() => expect(queueModeResolvers.length).toBeGreaterThan(0));
    await act(async () => queueModeResolvers.forEach((resolve) => resolve(true)));
    await settle();

    expect(bridgeMockState.queueStaffQuoteMutation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Search availability$/i }));
    await waitFor(() => expect(bridgeMockState.queueStaffQuoteMutation).toHaveBeenCalledTimes(1));
    expect(bridgeMockState.lastStaffQuoteInput).toMatchObject({
      agency: 'Edited Agency',
      company: 'Edited Company',
      salesStrategy: 'Government',
    });
    expect(bridgeMockState.lastStaffQuoteInput).not.toHaveProperty('autoStart');
  });

  it('reports the inline Get rates run and keeps its running chip until the read settles', async () => {
    bridgeMockState.storedWork = STORED_READY;
    bridgeMockState.holdStaffQuote = true;
    bridgeMockState.jobQueueEnabledQuery.mockResolvedValue(false);

    render(<NavaPane bridge={fakeBridge} />);
    await storedReadLands();
    await settle();
    expect(bridgeMockState.queueStaffQuoteMutation).not.toHaveBeenCalled();
    await fillStayFactsMatchingAuthorisedOffer();
    fireEvent.click(screen.getByRole('button', { name: /^Search availability/i }));

    expect(await screen.findByText('Nava is getting rates from HMS — you can keep working')).toBeDefined();
    expect(screen.getByTestId('hms-running-count').textContent).toBe('HMS: 1 pending');
    await waitFor(() => expect(bridgeMockState.releaseStaffQuote).toBeTypeOf('function'));
    await act(async () => bridgeMockState.releaseStaffQuote?.());

    const notice = await screen.findByTestId('hms-job-notice-banner');
    expect(notice.textContent).toContain('Rates ready');
    expect(screen.queryByTestId('hms-running-count')).toBeNull();
    expect(bridgeMockState.queueStaffQuoteMutation).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'mail-1' }),
    );
  });
});

describe('NavaPane contact and translation on both surfaces', () => {
  const FRENCH_TRANSLATION = {
    status: 'succeeded',
    truncated: false,
    segments: [
      { clean: 'Good evening, we need three rooms.', literal: 'Good evening, we have need of three rooms.' },
    ],
  };
  const STORED_FRENCH = {
    status: 'ready',
    workItemId: 'wi-fr',
    workItemStatus: 'needs_you',
    extractionId: 'ex-fr',
    refs: { r_1: { stayId: 's_1', rowId: 'r_1' } },
    analysis: {
      intent: 'quote',
      groups: [
        {
          id: 'r_1',
          arrivalDate: '2026-10-31',
          departureDate: '2026-11-07',
          quantity: 3,
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
    contact: { name: 'Marie Dupont', company: null, endClient: null, email: 'marie.dupont@example.fr', phone: null },
    language: 'fr',
    translation: FRENCH_TRANSLATION,
  };

  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
  });

  afterEach(() => {
    bridgeMockState.storedWork = null;
    bridgeMockState.retryTranslation.mockClear();
    localStorage.clear();
    sessionStorage.clear();
    cleanup();
  });

  for (const [surface, preview] of [
    ['the Outlook pane', false],
    ['the webmail panel', true],
  ] as const) {
    it(`${surface}: keeps the five quote steps in guided order`, async () => {
      bridgeMockState.storedWork = STORED_FRENCH;
      const { container } = render(<NavaPane bridge={fakeBridge} preview={preview} />);
      await waitFor(() => expect(container.querySelector('#quote-quote')).not.toBeNull(), { timeout: 5000 });
      const steps = ['quote-contact', 'quote-stay', 'quote-party', 'quote-rates', 'quote-quote'].map((id) =>
        container.querySelector(`#${id}`),
      );
      expect(steps.every(Boolean)).toBe(true);
      for (let index = 1; index < steps.length; index += 1) {
        expect(steps[index - 1]!.compareDocumentPosition(steps[index]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      expect(within(steps[4] as HTMLElement).getByText('Reply text · PDF · Excel')).toBeDefined();
    });

    it(`${surface}: the contact block sits above the translation, which is open on Clean`, async () => {
      bridgeMockState.storedWork = STORED_FRENCH;
      const { container } = render(<NavaPane bridge={fakeBridge} preview={preview} />);
      const translation = await screen.findByRole('region', { name: 'Translation' });
      expect(screen.getByRole('tab', { name: 'Clean' }).getAttribute('aria-selected')).toBe('true');
      openContactCorrections();
      expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('marie.dupont@example.fr');
      const contact = screen.getByRole('region', { name: 'Guest & contact' });
      const selectedEmail = container.querySelector('#quote-selected-message');
      expect(selectedEmail).not.toBeNull();
      expect(contact.compareDocumentPosition(selectedEmail!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(contact.compareDocumentPosition(translation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it(surface + ': uses the external sender as a name and email fallback while the read is unavailable', async () => {
      bridgeMockState.storedWork = null;
      render(<NavaPane bridge={fakeBridge} preview={preview} />);
      await waitFor(() => expect(screen.getByText('David Miller')).toBeDefined());
      openContactCorrections();
      await waitFor(() => {
        expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('David Miller');
        expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('guest@example.com');
      });
    });

    it(surface + ': does not use an own-domain forward as the contact fallback', async () => {
      const forwardedBridge = {
        ...fakeBridge,
        activeEmail: {
          ...fakeBridge.activeEmail,
          senderName: 'Hotel Staff',
          senderEmail: 'staff@legacyhotels.co.za',
        },
      } as unknown as PaneBridge;
      bridgeMockState.storedWork = null;
      render(<NavaPane bridge={forwardedBridge} preview={preview} />);
      await waitFor(() => expect(bridgeMockState.analyseCalls).toBeGreaterThan(0));
      openContactCorrections();
      await waitFor(() => {
        expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
        expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('');
      });
    });

    it(`${surface}: refreshes sender fallback when a selected message lacks a Message-ID`, async () => {
      bridgeMockState.storedWork = null;
      const bridgeFor = (entryId: string, senderName: string, senderEmail: string) =>
        ({
          ...fakeBridge,
          activeEmail: {
            ...fakeBridge.activeEmail,
            entryId,
            internetMessageId: undefined,
            senderName,
            senderEmail,
          },
        }) as unknown as PaneBridge;
      const { rerender } = render(
        <NavaPane bridge={bridgeFor('001', 'Alice Adams', 'alice@example.com')} preview={preview} />,
      );
      await waitFor(() => expect(screen.getByText('Alice Adams')).toBeDefined());
      openContactCorrections();
      await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Alice Adams'));

      rerender(<NavaPane bridge={bridgeFor('002', 'Barbara Jones', 'barbara@example.net')} preview={preview} />);
      await waitFor(() => expect(screen.getByText('Barbara Jones')).toBeDefined());
      openContactCorrections();
      await waitFor(() => {
        expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Barbara Jones');
        expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('barbara@example.net');
      });
    });

    it(`${surface}: an English mail shows the contact block and no translation`, async () => {
      bridgeMockState.storedWork = { ...STORED_FRENCH, language: 'en', translation: null };
      render(<NavaPane bridge={fakeBridge} preview={preview} />);
      await waitFor(() => expect(screen.getByText('marie.dupont@example.fr')).toBeDefined());
      openContactCorrections();
      await waitFor(() => expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('marie.dupont@example.fr'));
      expect(screen.queryByRole('region', { name: 'Translation' })).toBeNull();
    });

    it(`${surface}: a read whose work item could not be opened still fills the contact`, async () => {
      bridgeMockState.storedWork = { ...STORED_FRENCH, workItemId: null, workItemStatus: null };
      render(<NavaPane bridge={fakeBridge} preview={preview} />);
      await waitFor(() => expect(screen.getByText('marie.dupont@example.fr')).toBeDefined());
      openContactCorrections();
      await waitFor(() => expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('marie.dupont@example.fr'));
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Marie Dupont');
    });

    it(`${surface}: a failed translation says so and retries from the pane`, async () => {
      bridgeMockState.storedWork = { ...STORED_FRENCH, translation: { status: 'failed' } };
      bridgeMockState.retryTranslation.mockResolvedValueOnce({ status: 'done', translation: FRENCH_TRANSLATION });
      render(<NavaPane bridge={fakeBridge} preview={preview} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Retry translation' }));
      await waitFor(() => expect(screen.getByRole('tablist', { name: 'Translation view' })).toBeDefined());
      expect(bridgeMockState.retryTranslation).toHaveBeenCalledWith({ workItemId: 'wi-fr' });
    });
  }
});
