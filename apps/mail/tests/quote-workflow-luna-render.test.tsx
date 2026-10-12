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

  it('drops the "not a quote or booking" notice when the change card carries the amendment (AE2)', () => {
    const session = sessionWithAnalysis({
      intent: 'other',
      groups: [],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({ workflow: 'other', flags: ['amendment_or_cancel'] }),
      amendment: {
        kind: 'amend',
        confirmationNumber: '57291630-1',
        guestLastName: 'Example',
        arrival: '2026-11-01',
        departure: '2026-11-06',
        requestedArrival: '2026-10-31',
        requestedDeparture: '2026-11-07',
        requestedChange: 'Add the night of 31 Oct and check out on 7 Nov',
      },
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.queryByText(/Not a quote or booking/)).toBeNull();
    expect(screen.getByText('Nava can find the booking; make the change in HMS yourself.')).toBeDefined();
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

  it('shows one notice per unread file, and drops the generic unread-attachment line beside it', () => {
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [g1],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({ flags: ['attachment_unread'] }),
      reviewItems: [
        {
          id: 'unread:scan',
          kind: 'document_failure',
          rank: 'unread_source',
          text: "Nava can't read scan.pdf (password-protected) — open it if it has booking details.",
          sourceLabel: 'scan.pdf',
          filename: 'scan.pdf',
          blocking: false,
        },
      ],
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(
      screen.getAllByText("Nava can't read scan.pdf (password-protected) — open it if it has booking details."),
    ).toHaveLength(1);
    expect(screen.queryByText('An attachment could not be read. Open it in Outlook and check it.')).toBeNull();
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

  it('does not render the disabled Tell Nava correction note', () => {
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [g1],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({ workflow: 'quote' }),
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.queryByText(/Tell Nava/i)).toBeNull();
    expect(screen.queryByLabelText(/what's wrong/i)).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit adults per room for stay 1, room 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'More: Adult guests per room for stay 1, room 1' }));
    expect(onPatchGroup).toHaveBeenCalledWith('g1', expect.objectContaining({ adults: 3 }));
  });

  it('shows a multi-task line for distinct kinds of work and no buttons', () => {
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
        // One quote per stay is one combined quote (U20), so the two quote tasks count once.
        'This email asks for 2 things: a quote, a booking. This pane handles the first. Do the rest by hand.',
      ),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: /do the rest/i })).toBeNull();
  });

  it('treats one quote task per stay as one multi-stay quote, not work to do by hand', () => {
    const g2: StayGroupRequirement = { ...g1, id: 'g2', arrivalDate: '2026-12-01', departureDate: '2026-12-03' };
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [g1, g2],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({
        flags: ['rooms_only_group', 'multi_date'],
        tasks: [
          { kind: 'quote', groupIndexes: [0], note: '' },
          { kind: 'quote', groupIndexes: [1], note: '' },
        ],
      }),
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(screen.queryByText(/This email asks for \d+ things/i)).toBeNull();
    expect(screen.queryByText(/Do the rest by hand/i)).toBeNull();
    expect(screen.queryByText(/PDF before running the next/i)).toBeNull();
    expect(
      screen.getByText('Several stays: get rates for each one. Prepare quote puts every stay in one proposal.'),
    ).toBeDefined();
  });

  it('still counts each cancellation, since the pane handles one booking at a time', () => {
    const session = sessionWithAnalysis({
      intent: 'quote',
      groups: [g1],
      secondaryAsks: [],
      alternatives: [],
      luna: lunaWire({
        tasks: [
          { kind: 'cancel', groupIndexes: [], note: '' },
          { kind: 'cancel', groupIndexes: [], note: '' },
        ],
      }),
    });
    render(<QuoteWorkflowPanel session={session} />);
    expect(
      screen.getByText(
        'This email asks for 2 things: a cancellation, a cancellation. This pane handles the first. Do the rest by hand.',
      ),
    ).toBeDefined();
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
    expect(screen.queryByText(/This email asks for \d+ things/i)).toBeNull();
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
    // A failed read leaves a blank stay to type into, never a group guessed on the client.
    expect(screen.getAllByLabelText('Arrival').map((input) => (input as HTMLInputElement).value)).toEqual(['']);
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
            adults: 3,
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
    await waitFor(() => expect(screen.getByText('3 adults per room')).toBeDefined());
    await act(async () => {
      resolveFirst({
        status: 'ready',
        intent: 'quote',
        groups: [
          {
            id: 'g1',
            adults: 1,
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
    expect(screen.getByText('3 adults per room')).toBeDefined();
    expect(screen.queryByText('1 adult per room')).toBeNull();
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

  it('keeps Tell Nava correction controls absent from the Outlook pane', async () => {
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
    await waitFor(() => expect(screen.getByLabelText('Nava reads this as')).toBeDefined());
    expect(screen.queryByText(/Tell Nava/i)).toBeNull();
    expect(screen.queryByLabelText(/what's wrong/i)).toBeNull();
  }, 15_000);
});
