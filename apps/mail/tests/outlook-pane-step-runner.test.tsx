/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
import { confirmPublicRate, findReadStayArrival } from './helpers/prepare-reviewed-quote';
import { expiredPriorQuoteToastMessage } from '../lib/quote-workflow/booking-draft-bind';
import { resetPartyAutoLookupForTests } from '../components/quote-workflow/party-picker';

const { sendCommandMock, executeStaffQuoteMutateMock, panePartyFindMock, getPriorQueryMock, analysisLuna } = vi.hoisted(
  () => ({
    sendCommandMock: vi.fn(),
    executeStaffQuoteMutateMock: vi.fn(),
    panePartyFindMock: vi.fn(),
    getPriorQueryMock: vi.fn(),
    // A Re-quote test opts in to a create_booking read-out. Null keeps the default quote analysis.
    analysisLuna: { current: null as Record<string, unknown> | null },
  }),
);

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../lib/workstation/use-outlook-bridge', () => ({
  useOutlookBridge: () => ({
    isConnected: true,
    workstationInfo: {
      addinVersion: '1.0.12',
      bridgeProtocolVersion: 4,
      paired: true,
      outlookVersion: '16.0',
    },
    capabilities: {
      bridgeProtocolVersion: 4,
      supportedActions: ['CREATE_REPLY_DRAFT', 'ADD_ATTACHMENT_TO_DRAFT', 'GET_ACTIVE_EMAIL'],
    },
    supportsAction: (action: string) =>
      action === 'CREATE_REPLY_DRAFT' || action === 'ADD_ATTACHMENT_TO_DRAFT',
    activeEmail: {
      entryId: '001',
      storeId: 'store-1',
      folderEntryId: 'folder-inbox',
      subject: 'Suite Availability Request',
      internetMessageId: '<suite-availability@example.invalid>',
      senderEmail: 'guest@example.com',
      senderName: 'David Miller',
      receivedTime: '2026-09-17T12:00:00Z',
      bodyText: 'Need 3 rooms 12-14 November 2026.',
      bodyHtml: '<p>Need 3 rooms 12-14 November 2026.</p>',
    },
    sendCommand: sendCommandMock,
    pairDevice: vi.fn(),
  }),
}));

vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({
    data: { id: 'transport-shared', email: 'centurion@legacyhotels.co.za' },
    isLoading: false,
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

// The amend panel reads the pilot capabilities hook; the pane default is paneSave off.
vi.mock('@/hooks/use-pilot-capabilities', () => ({
  usePilotCapabilities: () => ({ paneSave: false }),
}));

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    panePartyLookup: {
      findParty: { mutate: (...args: unknown[]) => panePartyFindMock(...args) },
    },
    workstation: {
      ping: { mutate: vi.fn().mockResolvedValue({ status: 'ok' }) },
      staffQuoteSource: {
        query: async () => ({
          status: 'ready' as const,
          messageId: 'mail-1',
          threadId: 'thread-1',
          sourceHash: 'ab'.repeat(32),
        }),
      },
      executeStaffQuote: {
        mutate: (...args: unknown[]) => executeStaffQuoteMutateMock(...args),
      },
      // An earlier quote on the thread that has expired, so the pane offers Re-quote this stay.
      listThreadQuoteRevisions: {
        query: async () => ({ revisions: [{ workflowRunId: 'run-prior', revisionRef: 'rev-prior' }] }),
      },
      usePriorQuoteForBooking: {
        mutate: async () => ({ status: 'unavailable' as const, reason: 'expired' }),
      },
      getPriorStaffQuoteRequote: {
        query: (...args: unknown[]) => getPriorQueryMock(...args),
      },
    },
    quoteWorkflow: {
      analyseSelection: {
        mutate: async () => ({
          status: 'ready' as const,
          intent: 'quote' as const,
          groups: [
            {
              id: 'g1',
              childrenAges: [],
              board: 'bb' as const,
              quantity: 1,
              specialRequests: [],
              fields: { arrivalDate: 'missing' as const, departureDate: 'missing' as const, adults: 'missing' as const },
            },
          ],
          secondaryAsks: [],
          alternatives: [],
          sourceRevision: 1,
          ...(analysisLuna.current ? { luna: analysisLuna.current } : {}),
        }),
      },
    },
  },
}));

type StaffQuoteRequest = {
  selectionEpoch: number;
  inputRevision: number;
  groups: Array<{ arrivalDate: string; departureDate: string }>;
};

/** A ready executeStaffQuote answer that echoes the request it answers. */
function readyStaffQuote(request: StaffQuoteRequest) {
  return {
    status: 'ready' as const,
    workflowRunId: 'run-1',
    revisionRef: 'rev-1',
    messageId: 'mail-1',
    threadId: 'thread-1',
    factRefs: [],
    selectionEpoch: request.selectionEpoch,
    inputRevision: request.inputRevision,
    inputDigest: 'digest',
    totalMinor: 272000,
    currency: 'ZAR',
    arrivalDate: request.groups[0]?.arrivalDate,
    departureDate: request.groups[0]?.departureDate,
    description: 'Standard King',
  };
}

// The kept result reads 'Standard King · bb'. The room dropdown also lists a bare 'Standard King', which must not count.
const ROOM_LABEL = /Standard King ·/;

/** The stay facts executeStaffQuote needs: dates, a known board, quantity and adults. */
async function fillStayFacts(arrival: string, departure: string) {
  fireEvent.change(await findReadStayArrival(), { target: { value: arrival } });
  fireEvent.change(screen.getByLabelText('Departure'), { target: { value: departure } });
  fireEvent.change(screen.getByLabelText('Meal plan'), { target: { value: 'bb' } });
  // Rooms has a visible stepper and a hidden number input with the same label. The input is the one to change.
  fireEvent.change(screen.getByLabelText('Rooms', { selector: 'input' }), { target: { value: '1' } });
  // Adults per room sits behind an edit button as a stepper. The read leaves it unset, so + sets it to 1.
  fireEvent.click(screen.getByRole('button', { name: 'Edit adults per room for stay 1, room 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'More: Adult guests per room for stay 1, room 1' }));
}

describe('mounted pane step runner and current inputs', () => {
  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    sendCommandMock.mockReset();
    executeStaffQuoteMutateMock.mockReset();
    panePartyFindMock.mockReset();
    executeStaffQuoteMutateMock.mockImplementation(async (request: StaffQuoteRequest) => readyStaffQuote(request));
  });

  afterEach(() => {
    localStorage.clear();
    cleanup();
  });

  it('runs the explicit step control with the current stay facts and revision', async () => {
    render(<OutlookPanePage />);
    await fillStayFacts('2026-11-12', '2026-11-14');
    confirmPublicRate();
    const perStep = await screen.findByRole('button', { name: /^Run Search availability 2026-11-12 → 2026-11-14/i });
    expect((perStep as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(perStep);
    await waitFor(() => expect(executeStaffQuoteMutateMock).toHaveBeenCalledTimes(1));
    expect(executeStaffQuoteMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'mail-1',
        sourceHash: 'ab'.repeat(32),
        salesStrategy: 'BAR',
        inputRevision: expect.any(Number),
        groups: [
          expect.objectContaining({
            id: 'g1',
            arrivalDate: '2026-11-12',
            departureDate: '2026-11-14',
            quantity: 1,
            adults: 1,
            childrenAges: [],
            board: 'bb',
          }),
        ],
      }),
    );
  });

  it('replans the stay search after staff edit dates then sends the new stay', async () => {
    render(<OutlookPanePage />);
    await fillStayFacts('2026-11-12', '2026-11-14');
    confirmPublicRate();
    fireEvent.change(screen.getByLabelText('Arrival'), { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByLabelText('Departure'), { target: { value: '2026-12-03' } });
    const perStep = await screen.findByRole('button', { name: /Run Search availability 2026-12-01 → 2026-12-03/i });
    fireEvent.click(perStep);
    await waitFor(() => expect(executeStaffQuoteMutateMock).toHaveBeenCalledTimes(1));
    const request = executeStaffQuoteMutateMock.mock.calls[0]?.[0] as {
      inputRevision: number;
      groups: Array<{ arrivalDate?: string; departureDate?: string; quantity?: number }>;
    };
    // No run was in flight, so the date edit kept the revision: the PDF gate needs evidence and results on one revision.
    expect(request.inputRevision).toBe(1);
    expect(request.groups).toEqual([
      expect.objectContaining({ id: 'g1', arrivalDate: '2026-12-01', departureDate: '2026-12-03', quantity: 1 }),
    ]);
  });

  it('has no separate party lookup: the stay search runs from the stay facts alone', async () => {
    render(<OutlookPanePage />);
    await fillStayFacts('2026-11-12', '2026-11-14');
    confirmPublicRate();
    const stay = await screen.findByRole('button', { name: /^Run Search availability/i });
    expect((stay as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /Look up organisation/i })).toBeNull();
    fireEvent.click(stay);
    await waitFor(() => expect(executeStaffQuoteMutateMock).toHaveBeenCalledTimes(1));
  });

  it('holds Get rates while the company search still decides the pick, then releases it', async () => {
    let answer!: (found: unknown) => void;
    panePartyFindMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    render(<OutlookPanePage />);
    await fillStayFacts('2026-11-12', '2026-11-14');
    fireEvent.change(screen.getByLabelText('Company (end client)'), { target: { value: 'Acme Travel' } });
    expect((await screen.findAllByText('Finding the company in HMS…')).length).toBeGreaterThan(0);
    const run = await screen.findByRole('button', { name: /^Run Search availability/i });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(panePartyFindMock).toHaveBeenCalledTimes(1));
    answer({ outcome: 'resolved', results: [], truncated: false, best: null, searchedFor: null });
    await waitFor(() => expect(screen.queryAllByText('Finding the company in HMS…')).toHaveLength(0));
    confirmPublicRate();
    const released = await screen.findByRole('button', { name: /^Run Search availability/i });
    expect((released as HTMLButtonElement).disabled).toBe(false);
  });

  it('says so when a stay changes while HMS searches, and keeps no result for the old inputs', async () => {
    vi.mocked(toast.warning).mockClear();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    executeStaffQuoteMutateMock.mockImplementationOnce(async (request: StaffQuoteRequest) => {
      await held;
      return readyStaffQuote(request);
    });
    render(<OutlookPanePage />);
    await fillStayFacts('2026-11-12', '2026-11-14');
    confirmPublicRate();
    fireEvent.click(await screen.findByRole('button', { name: /^Run Search availability/i }));
    await waitFor(() => expect(executeStaffQuoteMutateMock).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Departure'), { target: { value: '2026-11-15' } });
    finish();
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Details changed while HMS was searching — search availability again.'),
    );
    // The dropped result is not kept: no room result from the old inputs reaches the pane.
    expect(screen.queryAllByText(ROOM_LABEL)).toHaveLength(0);
  });

  it('releases a running step when executeStaffQuote rejects so retry works', async () => {
    executeStaffQuoteMutateMock.mockRejectedValueOnce(new Error('executeStaffQuote network down'));
    render(<OutlookPanePage />);
    await fillStayFacts('2026-11-12', '2026-11-14');
    confirmPublicRate();
    fireEvent.click(await screen.findByRole('button', { name: /^Run Search availability/i }));
    await waitFor(() => expect(executeStaffQuoteMutateMock).toHaveBeenCalledTimes(1));
    const retry = await screen.findByRole('button', { name: /^Run Search availability/i });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(executeStaffQuoteMutateMock).toHaveBeenCalledTimes(2));
  });
});

/** The Re-quote action of the expired-prior toast, once the pane has found the earlier quote. */
function requoteAction(): () => void {
  const call = vi.mocked(toast.warning).mock.calls.find(([message]) => message === expiredPriorQuoteToastMessage());
  const options = call?.[1] as { action?: { onClick?: () => void } } | undefined;
  if (!options?.action?.onClick) throw new Error('the expired-prior toast has no Re-quote action yet');
  return options.action.onClick;
}

describe('Re-quote after an expired prior quote', () => {
  // A create_booking read-out: the pane offers Re-quote only for a booking.
  const bookingLuna = {
    workflow: 'create_booking',
    flags: [],
    groups: [],
    // No party here: a named party would start its own automatic lookup and hold the run before the test begins.
    party: { kind: null, name: null, reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [],
  };
  const priorPayload = {
    groups: [
      {
        id: 'g1',
        arrivalDate: '2026-11-12',
        departureDate: '2026-11-14',
        quantity: 1,
        adults: 1,
        childrenAges: [],
        board: 'bb',
        specialRequests: [],
        fields: {},
      },
    ],
    salesStrategy: 'BAR',
    company: '',
    agency: '',
  };

  beforeEach(() => {
    localStorage.setItem('nava_onboarding_completed', 'true');
    sendCommandMock.mockReset();
    executeStaffQuoteMutateMock.mockReset();
    executeStaffQuoteMutateMock.mockImplementation(async (request: StaffQuoteRequest) => readyStaffQuote(request));
    panePartyFindMock.mockReset();
    getPriorQueryMock.mockReset();
    getPriorQueryMock.mockImplementation(async () => ({ status: 'ready', payload: priorPayload }));
    analysisLuna.current = bookingLuna;
    vi.mocked(toast.warning).mockClear();
    // The automatic lookup memo is module-level. A name an earlier test searched would not search again here.
    resetPartyAutoLookupForTests();
  });

  afterEach(() => {
    analysisLuna.current = null;
    localStorage.clear();
    cleanup();
  });

  it('holds Re-quote with the lookup copy while the company search still decides the pick', async () => {
    panePartyFindMock.mockImplementationOnce(() => new Promise(() => {}));
    render(<OutlookPanePage />);
    await fillStayFacts('2026-11-12', '2026-11-14');
    fireEvent.change(screen.getByLabelText('Company (end client)'), { target: { value: 'Acme Travel' } });
    expect((await screen.findAllByText('Finding the company in HMS…')).length).toBeGreaterThan(0);
    const requote = await waitFor(() => requoteAction());
    requote();
    expect(toast.warning).toHaveBeenCalledWith('Finding the company in HMS…');
    expect(executeStaffQuoteMutateMock).not.toHaveBeenCalled();
  });

  it('does not start the re-quote run under a lookup that began while the earlier quote loaded', async () => {
    let loaded!: () => void;
    getPriorQueryMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        loaded = resolve;
      });
      return { status: 'ready', payload: priorPayload };
    });
    panePartyFindMock.mockImplementationOnce(() => new Promise(() => {}));
    render(<OutlookPanePage />);
    await fillStayFacts('2026-11-12', '2026-11-14');
    const requote = await waitFor(() => requoteAction());
    requote();
    await waitFor(() => expect(getPriorQueryMock).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Company (end client)'), { target: { value: 'Acme Travel' } });
    await waitFor(() => expect(panePartyFindMock).toHaveBeenCalledTimes(1), { timeout: 3000 });
    loaded();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Finding the company in HMS…'));
    expect(executeStaffQuoteMutateMock).not.toHaveBeenCalled();
  });

  it('warns and keeps no result when a stay changes while the re-quote searches', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    executeStaffQuoteMutateMock.mockImplementationOnce(async (request: StaffQuoteRequest) => {
      await held;
      return readyStaffQuote(request);
    });
    render(<OutlookPanePage />);
    await fillStayFacts('2026-11-12', '2026-11-14');
    const requote = await waitFor(() => requoteAction());
    requote();
    await waitFor(() => expect(executeStaffQuoteMutateMock).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Departure'), { target: { value: '2026-11-15' } });
    finish();
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Details changed while HMS was searching — search availability again.'),
    );
    expect(screen.queryAllByText(ROOM_LABEL)).toHaveLength(0);
  });

  it('keeps the re-quoted result when nothing moved on while HMS searched', async () => {
    render(<OutlookPanePage />);
    await fillStayFacts('2026-11-12', '2026-11-14');
    const requote = await waitFor(() => requoteAction());
    requote();
    expect((await screen.findAllByText(ROOM_LABEL)).length).toBeGreaterThan(0);
    expect(toast.warning).not.toHaveBeenCalledWith('Details changed while HMS was searching — search availability again.');
  });
});
