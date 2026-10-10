/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { observable } from '@trpc/server/observable';
import { countMutationsLink } from '../lib/workstation/mutations-in-flight';
import { reloadPane } from '../lib/workstation/pane-release-watch';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { NavaPane } from '../components/nava-pane/nava-pane';
import type { PaneBridge } from '../lib/workstation/pane-bridge-types';
import { AUTHORISED_QUOTE_OFFERS, AUTHORISED_QUOTE_PDF, AUTHORISED_REPLY_HTML } from './helpers/authorised-quote-evidence';
import { VOUCHER_COPY } from '../lib/quote-workflow/voucher-find';

// The pane reloads only through reloadPane(). Tests observe it; the real reload is never called.
vi.mock('../lib/workstation/pane-release-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workstation/pane-release-watch')>()),
  reloadPane: vi.fn(),
}));

// State the mocks below read. Defaults match outlook-pane-render.test.tsx.
const { quotePdfMutate, sendCommandMock, bridgeMockState, pingMutate, voucherFindQuery } = vi.hoisted(() => ({
  pingMutate: vi.fn().mockResolvedValue({ status: 'ok', serverTime: '2026-10-09T12:00:00Z' }),
  voucherFindQuery: vi.fn().mockResolvedValue({ status: 'not_voucher' }),
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
    staffQuoteScreenshots: [] as string[],
    screenshotReads: [] as string[],
    // Replaces the default quote analysis for one test (an amendment email, for example).
    analysisOverride: null as null | Record<string, unknown>,
    analyseCalls: 0,
    // A stored read for the mail. Null leaves the workItems route out, so the pane reads live as before.
    storedWork: null as null | Record<string, unknown>,
    recordEvent: vi.fn(async (_input: unknown): Promise<unknown> => ({ aiValue: null, value: null })),
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
        query: async () => ({ status: 'ready', messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) }),
      },
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
      queueFind: { mutate: async () => ({ runId: 'job-find-1' }) },
      queueSearchGuest: { mutate: async () => ({ runId: 'job-search-1' }) },
      jobStatus: { query: async () => null },
      screenshot: { query: async () => null },
    },
    get workItems() {
      const stored = bridgeMockState.storedWork;
      if (!stored) return undefined;
      return {
        getByMessage: { query: async () => stored },
        recordEvent: { mutate: (input: unknown) => bridgeMockState.recordEvent(input) },
      };
    },
    quoteWorkflow: {
      voucherFind: { query: voucherFindQuery },
      analyseSelection: {
        mutate: async () => {
          bridgeMockState.analyseCalls += 1;
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
  },
}));

/** Opens the ⋯ menu from the keyboard (Radix opens on Enter) and returns its item by name. */
function openPaneMenuItem(name: string): HTMLElement {
  const trigger = screen.getByRole('button', { name: 'More' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.getByRole('menuitem', { name });
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
    voucherFindQuery.mockReset();
    voucherFindQuery.mockResolvedValue({ status: 'not_voucher' });
  });

  afterEach(() => {
    vi.useRealTimers();
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

  /** The Tell Nava note opens from its link once the selected email's analysis lands. */
  async function tellNavaBox(): Promise<HTMLTextAreaElement> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const box = screen.queryByLabelText("Tell Nava what's wrong");
      if (box) return box as HTMLTextAreaElement;
      const link = screen.queryByRole('button', { name: 'Something wrong? Tell Nava' });
      if (link) fireEvent.click(link);
      await flush(0);
    }
    throw new Error('the Tell Nava box did not appear');
  }

  /** Opens the Tell Nava note from its link, unless it is already open. */
  async function openTellNava(): Promise<HTMLTextAreaElement> {
    if (!screen.queryByLabelText("Tell Nava what's wrong")) {
      fireEvent.click(await screen.findByRole('button', { name: 'Something wrong? Tell Nava' }));
    }
    return (await screen.findByLabelText("Tell Nava what's wrong")) as HTMLTextAreaElement;
  }

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
    const note = await tellNavaBox();

    await flush(10 * 60_000);
    fireEvent.input(note, { target: { value: 'x' } });
    fireEvent.input(note, { target: { value: '' } });
    await flush(10 * 60_000);
    expect(vi.mocked(reloadPane)).not.toHaveBeenCalled();

    await flush(6 * 60_000);
    expect(vi.mocked(reloadPane)).toHaveBeenCalled();
  });

  it('an unsent Tell Nava note holds the idle reload until it is cleared or sent', async () => {
    vi.useFakeTimers();
    servePendingBuild();
    render(<NavaPane bridge={fakeBridge} />);
    const note = await tellNavaBox();
    fireEvent.input(note, { target: { value: 'Three nights from 12 Nov' } });

    await flush(20 * 60_000);
    expect(vi.mocked(reloadPane)).not.toHaveBeenCalled();

    // Clearing the note is input, so the idle clock starts again from here.
    fireEvent.input(note, { target: { value: '' } });
    await flush(14 * 60_000);
    expect(vi.mocked(reloadPane)).not.toHaveBeenCalled();
    await flush(60_000);
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

  it('keeps an unsent Tell Nava note through a trip off the tool screen', async () => {
    render(<NavaPane bridge={fakeBridge} />);
    const note = await openTellNava();
    fireEvent.input(note, { target: { value: 'Three nights from 12 Nov' } });

    fireEvent.keyDown(openPaneMenuItem('Check connection'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: /4\. Quote Tool/i }));
    expect(((await openTellNava()) as HTMLTextAreaElement).value).toBe(
      'Three nights from 12 Nov',
    );
  });

  it('a bridge that drops and restores the selected email neither reloads nor clears the Tell Nava note', async () => {
    vi.useFakeTimers();
    servePendingBuild();
    const noEmailBridge = { ...fakeBridge, activeEmail: null } as unknown as PaneBridge;
    const { rerender } = render(<NavaPane bridge={fakeBridge} />);
    const note = await tellNavaBox();
    fireEvent.input(note, { target: { value: 'Three nights from 12 Nov' } });

    rerender(<NavaPane bridge={noEmailBridge} />);
    await flush(0);
    expect(screen.queryByText('Loading the latest Nava pane…')).toBeNull();
    rerender(<NavaPane bridge={fakeBridge} />);
    await flush(0);

    expect(vi.mocked(reloadPane)).not.toHaveBeenCalled();
    expect(((await tellNavaBox()) as HTMLTextAreaElement).value).toBe('Three nights from 12 Nov');
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
    await openTellNava();
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
    voucherFindQuery.mockReset();
    voucherFindQuery.mockResolvedValue({ status: 'not_voucher' });
  });

  afterEach(() => {
    bridgeMockState.analysisOverride = null;
    bridgeMockState.analyseCalls = 0;
    bridgeMockState.storedWork = null;
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
    expect(container).toMatchSnapshot();
  });

  it('tool: a finished first run opens the quote tool on the selected email', async () => {
    const { container } = render(<NavaPane bridge={fakeBridge} />);
    expect(screen.queryByRole('button', { name: '4. Quote Tool' })).toBeNull();
    expect(container.querySelector('#quote-selected-message')?.textContent).toContain('Suite Availability Request');
    expect(
      await screen.findByText('Nava filled these in from the email. Check them before getting rates.'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Insert draft in Outlook' })).toBeDefined();
    await settle();
    expect(container).toMatchSnapshot();
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

  it('stored: a mail with a stored read opens from it and makes no live read', async () => {
    bridgeMockState.storedWork = STORED_READY;
    render(<NavaPane bridge={fakeBridge} />);
    await waitFor(() => expect((screen.getAllByLabelText(/Arrival/i)[0] as HTMLInputElement).value).toBe('2026-11-03'));
    await settle();
    expect(bridgeMockState.analyseCalls).toBe(0);
  });

  it('stored: a change that cannot be saved shows a quiet retry, and the retry sends it again', async () => {
    bridgeMockState.storedWork = STORED_READY;
    bridgeMockState.recordEvent.mockRejectedValue(new Error('offline'));
    render(<NavaPane bridge={fakeBridge} />);
    await waitFor(() => expect((screen.getAllByLabelText(/Arrival/i)[0] as HTMLInputElement).value).toBe('2026-11-03'));
    fireEvent.change(screen.getAllByLabelText(/Adults/i)[0]!, { target: { value: '3' } });
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
    await waitFor(() => expect((screen.getAllByLabelText(/Arrival/i)[0] as HTMLInputElement).value).toBe('2026-11-03'));
    fireEvent.click(screen.getByRole('button', { name: 'Add stay' }));
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
    expect(screen.queryByRole('button', { name: 'Insert draft in Outlook' })).toBeNull();
  });

  it('preview: the webmail reply says it is preview only, not that the add-in is too old', async () => {
    render(<NavaPane bridge={fakeBridge} preview />);
    expect(
      await screen.findByText('Preview only: copy the reply or download the PDF.'),
    ).toBeDefined();
    expect(screen.queryByText(/add-in is too old/)).toBeNull();
  });
});
