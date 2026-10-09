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

describe('QuoteWorkflowPanel Nava extras', () => {
  it('labels a defaulted meal plan as Default and still shows the stay as editable', () => {
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
    expect(screen.getByLabelText('Meal plan')).toHaveProperty('value', 'bb');
    expect(screen.getByText('Default')).toBeDefined();
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

  it('shows Read without AI and still renders local groups', () => {
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
    expect(screen.getByText('Read without AI')).toBeDefined();
    expect(screen.getByLabelText('Arrival')).toBeDefined();
  });

  it('shows the not-supported copy and one notice on a non_quote Other workflow', () => {
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
    expect((screen.getByLabelText('Nava reads this as') as HTMLSelectElement).value).toBe('other');
    expect(screen.getByText('Changing or cancelling a booking is not supported yet. Handle it by hand in HMS.')).toBeDefined();
    expect(screen.queryByText('Reservation number?')).toBeNull();
    expect(screen.getByText(/Not a quote or booking/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'This is a quote request' })).toBeNull();
  });

  it('calls onTreatAs quote and booking from the type picker on the Other workflow', () => {
    const onTreatAs = vi.fn();
    const session = sessionWithAnalysis({
      intent: 'other',
      groups: [],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({ workflow: 'other' }),
    });
    render(<QuoteWorkflowPanel session={session} onTreatAs={onTreatAs} />);
    fireEvent.change(screen.getByLabelText('Nava reads this as'), { target: { value: 'quote' } });
    expect(onTreatAs).toHaveBeenCalledWith('quote');
    fireEvent.change(screen.getByLabelText('Nava reads this as'), { target: { value: 'create_booking' } });
    expect(onTreatAs).toHaveBeenCalledWith('create_booking');
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
    expect(screen.getByText('Conference or group request (venue, day delegates, packages): handle it by hand.')).toBeDefined();
    expect(screen.getByText('An attachment could not be read. Open it in Outlook and check it.')).toBeDefined();
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
    expect(screen.getByText('Rooms-only group: quoting the number of rooms stated.')).toBeDefined();
    expect(screen.queryByText('Conference or group request (venue, day delegates, packages): handle it by hand.')).toBeNull();
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

  it('labels staff-note evidence chips as staff note', () => {
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [g1],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({
        evidence: [{ field: 'adults', quote: '2 adults from desk', source: 'staff_note' }],
      }),
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.getByText('Your note')).toBeDefined();
    expect(screen.getByText('2 adults from desk')).toBeDefined();
  });

  it('submits Tell Nava notes through onStaffNote', () => {
    const onStaffNote = vi.fn();
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [g1],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({ workflow: 'quote' }),
    });
    render(<QuoteWorkflowPanel session={session} onStaffNote={onStaffNote} />);
    fireEvent.click(screen.getByRole('button', { name: 'Something wrong? Tell Nava' }));
    fireEvent.change(screen.getByLabelText("Tell Nava what's wrong"), {
      target: { value: '4 twins at R1800' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Re-read with my note' }));
    expect(onStaffNote).toHaveBeenCalledWith('4 twins at R1800');
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
        'This email asks for 3 things: a quote, a quote, a booking. This pane handles the first. Do the rest by hand.',
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
    expect(screen.queryByText(/This email asks for/i)).toBeNull();
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

// The amend panel reads the pilot capabilities hook; the pane default is paneSave off.
vi.mock('@/hooks/use-pilot-capabilities', () => ({
  usePilotCapabilities: () => ({ paneSave: false }),
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

describe('Outlook pane Nava analysis bind', () => {
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
      expect(screen.queryByText(/Nava is reading the email/i)).toBeNull();
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

  it('re-runs analyseSelection with treatAs quote from the Outlook pane', async () => {
    analyseMutate.mockImplementation(async (input: { treatAs?: string }) => {
      if (input.treatAs === 'quote') {
        return {
          status: 'ready',
          intent: 'quote',
          groups: [g1],
          secondaryAsks: [],
          alternatives: [],
          sourceRevision: 2,
          luna: lunaWire({ workflow: 'quote' }),
        };
      }
      return {
        status: 'ready',
        intent: 'other',
        groups: [],
        secondaryAsks: [],
        alternatives: [],
        sourceRevision: 1,
        luna: lunaWire({ workflow: 'other' }),
      };
    });
    const OutlookPanePage = (await import('../app/(routes)/outlook-pane/page')).default;
    render(<OutlookPanePage />);
    await waitFor(() => expect(screen.getByLabelText('Nava reads this as')).toBeDefined());
    fireEvent.change(screen.getByLabelText('Nava reads this as'), { target: { value: 'quote' } });
    await waitFor(() => {
      expect(
        analyseMutate.mock.calls.some((call) => (call[0] as { treatAs?: string })?.treatAs === 'quote'),
      ).toBe(true);
    });
    await waitFor(() => expect(screen.getByLabelText('Arrival')).toBeDefined());
  }, 15_000);

  it('re-runs analyseSelection with a staff note from Tell Nava', async () => {
    analyseMutate.mockResolvedValue({
      status: 'ready',
      intent: 'quote',
      groups: [g1],
      secondaryAsks: [],
      alternatives: [],
      sourceRevision: 1,
      luna: lunaWire({ workflow: 'quote' }),
    });
    const OutlookPanePage = (await import('../app/(routes)/outlook-pane/page')).default;
    render(<OutlookPanePage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Something wrong? Tell Nava' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Something wrong? Tell Nava' }));
    fireEvent.change(screen.getByLabelText("Tell Nava what's wrong"), {
      target: { value: '4 twins at R1800' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Re-read with my note' }));
    await waitFor(() => {
      expect(
        analyseMutate.mock.calls.some(
          (call) => (call[0] as { staffNote?: string })?.staffNote === '4 twins at R1800',
        ),
      ).toBe(true);
    });
  }, 15_000);
});
