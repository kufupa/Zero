/**
 * @vitest-environment happy-dom
 */
import type {
  QuoteAnalysis,
  QuoteSession,
  StayGroupRequirement,
  LunaAnalysisWire,
} from '../lib/quote-workflow/types';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterEach(() => cleanup());

const g1: StayGroupRequirement = {
  id: 'g1',
  arrivalDate: '2026-11-12',
  departureDate: '2026-11-14',
  quantity: 1,
  adults: 2,
  childrenAges: [],
  board: 'bb',
  specialRequests: [],
  fields: { arrivalDate: 'extracted', departureDate: 'extracted', adults: 'extracted' },
};

function lunaWire(over: Partial<LunaAnalysisWire> = {}): LunaAnalysisWire {
  return {
    workflow: 'quote',
    flags: [],
    groups: [],
    party: { kind: null, name: null, reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [],
    ...over,
  };
}

function sessionWithAnalysis(analysis: QuoteAnalysis): QuoteSession {
  let session = reduceQuoteSession(initialQuoteSession(), {
    type: 'selection',
    binding: {
      transportId: 't1',
      mailboxEmail: 'centurion@legacyhotels.co.za',
      storeId: 'store',
      folderEntryId: 'inbox',
      entryId: 'e1',
      selectionEpoch: 1,
      scopeEpoch: 1,
    },
  });
  return reduceQuoteSession(session, { type: 'analysis_ready', analysis });
}

describe('QuoteWorkflowPanel Luna extras', () => {
  it('labels a defaulted board as usual and still shows the stay as editable', () => {
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [
        {
          ...g1,
          fields: { ...g1.fields, board: 'defaulted' },
        },
      ],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({ workflow: 'quote' }),
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByLabelText('Board')).toHaveProperty('value', 'bb');
    expect(screen.getByText('usual')).toBeDefined();
  });

  it('shows Booking badge and stay groups for create_booking workflow', () => {
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [g1],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({ workflow: 'create_booking' }),
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByText('Booking')).toBeDefined();
    expect(screen.getByLabelText('Arrival')).toBeDefined();
  });

  it('shows AI unavailable and still renders regex groups', () => {
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [g1],
      secondaryAsks: [],
      alternatives: [],
      aiUnavailable: true,
      source: 'regex_fallback',
      luna: null,
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByText('AI unavailable')).toBeDefined();
    expect(screen.getByLabelText('Arrival')).toBeDefined();
  });

  it('shows not-supported copy and missing questions on a non_quote Other workflow', () => {
    const session = sessionWithAnalysis({
      intent: 'other',
      groups: [],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({
        workflow: 'other',
        flags: ['amendment_or_cancel'],
        missing: [{ field: 'reference', question: 'Reservation number?' }],
      }),
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByText('Other')).toBeDefined();
    expect(screen.getByText('Amendment/cancellation: not supported yet')).toBeDefined();
    expect(screen.getByText('Reservation number?')).toBeDefined();
    expect(screen.getByText(/not a quoting request/i)).toBeDefined();
  });

  it('keeps unread-attachment warnings on a non_quote fallback', () => {
    const session = sessionWithAnalysis({
      intent: 'other',
      groups: [],
      secondaryAsks: [],
      alternatives: [],
      source: 'regex_fallback',
      aiUnavailable: true,
      luna: null,
      reviewItems: [
        {
          id: 'unread:scan',
          kind: 'document_failure',
          rank: 'unread_source',
          text: 'Attachment scan.pdf could not be read (no extractable text). Review it manually.',
          sourceLabel: 'scan.pdf',
          blocking: true,
        },
      ],
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(
      screen.getByText(
        'Attachment scan.pdf could not be read (no extractable text). Review it manually.',
      ),
    ).toBeDefined();
  });

  it('lists conference and unread-attachment flag copy', () => {
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [g1],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({ flags: ['conference_or_group', 'attachment_unread'] }),
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByText('Venue / DDR / delegates / packages: handle manually')).toBeDefined();
    expect(screen.getByText("An attachment couldn't be read: open it")).toBeDefined();
  });

  it('lists rooms-only group as an info chip, not handle-manually', () => {
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [{ ...g1, quantity: 15 }],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({ flags: ['rooms_only_group'] }),
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByText('Rooms-only group: quoting with stated quantity')).toBeDefined();
    expect(screen.queryByText('Venue / DDR / delegates / packages: handle manually')).toBeNull();
  });

  it('lists needs-your-answer questions from luna.missing', () => {
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [g1],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({
        missing: [{ field: 'guestNames', question: 'Guest names for room 2?' }],
      }),
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByText('Guest names for room 2?')).toBeDefined();
  });

  it('renders evidence quotes as literal text, never HTML', () => {
    const xss = '<img src=x onerror=alert(1)>';
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [g1],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({ evidence: [{ field: 'adults', quote: xss }] }),
    });
    const { container } = render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByText(xss)).toBeDefined();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
  });

  it('patches Adults on g1', () => {
    const onPatchGroup = vi.fn();
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [g1],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({ workflow: 'quote' }),
    });
    render(<QuoteWorkflowPanel session={session} onPatchGroup={onPatchGroup} />);
    fireEvent.change(screen.getByLabelText(/Adults/i), { target: { value: '3' } });
    expect(onPatchGroup).toHaveBeenCalledWith('g1', expect.objectContaining({ adults: 3 }));
  });

  it('shows a multi-task line for three steps and no buttons', () => {
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [g1],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({
        tasks: [
          { kind: 'quote', groupIndexes: [0], note: '' },
          { kind: 'quote', groupIndexes: [1], note: '' },
          { kind: 'create_booking', groupIndexes: [0], note: '' },
        ],
      }),
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(
      screen.getByText(
        'This email needs 3 steps: quote, quote, create booking. The pane handles the first; do the rest manually.',
      ),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: /do the rest/i })).toBeNull();
  });

  it('hides the tasks line when luna has a single task', () => {
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [g1],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({
        tasks: [{ kind: 'quote', groupIndexes: [0], note: '' }],
      }),
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.queryByText(/This email needs/i)).toBeNull();
  });
});

const { analyseMutate, paneState } = vi.hoisted(() => ({
  analyseMutate: vi.fn(),
  paneState: { entryId: '001' },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../lib/workstation/use-outlook-bridge', () => ({
  useOutlookBridge: () => ({
    isConnected: true,
    workstationInfo: { addinVersion: '1.0.12', bridgeProtocolVersion: 4, paired: true },
    capabilities: {
      bridgeProtocolVersion: 4,
      supportedActions: ['CREATE_REPLY_DRAFT', 'ADD_ATTACHMENT_TO_DRAFT', 'GET_ACTIVE_EMAIL'],
    },
    supportsAction: () => true,
    activeEmail: {
      entryId: paneState.entryId,
      storeId: 'store-1',
      folderEntryId: 'folder-inbox',
      subject: 'Suite Availability Request',
      senderEmail: 'guest@example.com',
      senderName: 'David Miller',
      receivedTime: '2026-09-17T12:00:00Z',
      internetMessageId: `<${paneState.entryId}@example.invalid>`,
      bodyText: 'CIDB needs 3 rooms for 4 nights.',
      bodyHtml: '<p>CIDB needs 3 rooms for 4 nights.</p>',
    },
    sendCommand: vi.fn(),
    pairDevice: vi.fn(),
  }),
}));

vi.mock('../lib/auth-client', () => ({
  useSession: () => ({
    data: {
      user: { id: 'staff-1', email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' },
      session: { id: 'session-1' },
    },
    isLoading: false,
  }),
  signIn: { email: vi.fn() },
}));

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: { id: 'transport-1', email: 'ropperman@legacyhotels.co.za' },
    isLoading: false,
  }),
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    workstation: {
      ping: { mutate: vi.fn().mockResolvedValue({ status: 'ok' }) },
      quoteProposalPdf: { mutate: vi.fn() },
      staffQuoteSource: {
        query: async () => ({
          status: 'ready',
          messageId: 'mail-1',
          threadId: 'thread-1',
          sourceHash: 'ab'.repeat(32),
        }),
      },
    },
    quoteWorkflow: {
      analyseSelection: { mutate: (...args: unknown[]) => analyseMutate(...args) },
    },
  },
}));

describe('Outlook pane Luna analysis bind', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    paneState.entryId = '001';
    analyseMutate.mockReset();
  });

  it('leaves analysing when analyseSelection is unavailable and does not keep a local regex group', async () => {
    analyseMutate.mockRejectedValue(new Error('analyseSelection network down'));
    const OutlookPanePage = (await import('../app/(routes)/outlook-pane/page')).default;
    render(<OutlookPanePage />);
    await waitFor(() => {
      expect(screen.queryByText(/Analysing selected email/i)).toBeNull();
    });
    expect(screen.getAllByText(/analyseSelection network down/i).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Arrival')).toBeNull();
  }, 15_000);

  it('ignores a stale analyseSelection result after the selection changes', async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise((settle) => {
      resolveFirst = settle;
    });
    analyseMutate.mockImplementation(async (input: { entryId: string }) => {
      if (input.entryId === '001') return first;
      return {
        status: 'ready',
        intent: 'quote',
        groups: [
          {
            id: 'g1',
            organisation: 'Fresh',
            childrenAges: [],
            board: 'unknown',
            quantity: 1,
            specialRequests: [],
            fields: { arrivalDate: 'missing', organisation: 'extracted' },
          },
        ],
        secondaryAsks: [],
        alternatives: [],
        sourceRevision: 2,
      };
    });
    const OutlookPanePage = (await import('../app/(routes)/outlook-pane/page')).default;
    const view = render(<OutlookPanePage />);
    await waitFor(() => expect(analyseMutate).toHaveBeenCalled());
    paneState.entryId = '002';
    view.rerender(<OutlookPanePage />);
    await waitFor(() => expect(screen.getAllByDisplayValue('Fresh').length).toBeGreaterThan(0));
    await act(async () => {
      resolveFirst({
        status: 'ready',
        intent: 'quote',
        groups: [
          {
            id: 'g1',
            organisation: 'Stale',
            childrenAges: [],
            board: 'unknown',
            quantity: 1,
            specialRequests: [],
            fields: { arrivalDate: 'missing', organisation: 'extracted' },
          },
        ],
        secondaryAsks: [],
        alternatives: [],
        sourceRevision: 1,
      });
    });
    expect(screen.getAllByDisplayValue('Fresh').length).toBeGreaterThan(0);
    expect(screen.queryByDisplayValue('Stale')).toBeNull();
  }, 15_000);
});
