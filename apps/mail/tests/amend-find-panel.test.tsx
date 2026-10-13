/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unmaskedPii } from './helpers/pii-marks';
import { AmendLookupPanel } from '../components/quote-workflow/amend-lookup-panel';
import {
  askedDates,
  AMEND_FIND_COPY,
  amendDiffs,
  amendFindClientFromTrpc,
  findRequestFor,
  findRunFromJob,
  hmsJobTransport,
  hmsNumberFor,
  isSettled,
  noSearchMatchCopy,
  notHmsNumberNote,
  pollHmsJob,
  searchRequestFor,
  searchRunFromJob,
  type FindStayInput,
  type FindStayReply,
  type GuestSearchInput,
  type HmsFindRun,
  type HmsJobRequest,
  type HmsJobTransport,
  type HmsJobView,
  type HmsSearchRun,
  type StayRecordWire,
} from '../lib/quote-workflow/amend-find';
import type { CancelRun } from '../lib/quote-workflow/amend-cancel';
import { amendmentOf, initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import type { QuoteAmendment, QuoteSession } from '../lib/quote-workflow/types';

// brain.getCapabilities answers with this flag. Tests set it before rendering.
const capabilities = vi.hoisted(() => ({ paneSave: false }));

afterEach(() => {
  cleanup();
  capabilities.paneSave = false;
  vi.unstubAllEnvs();
});

const THREAD = 'thread-7';
const CONFIRMATION = '57291630-1';
const RUN_ID = '3f2c9a1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
const DIGEST = 'ab'.repeat(32);
const NO_SHOT = { status: 'unavailable', reason: 'screenshot_unavailable' };
const SHOT_PNG = 'data:image/png;base64,iVBORw0KGgo=';
const NEVER_SETTLES = () => new Promise<never>(() => {});

const AMEND: QuoteAmendment = {
  kind: 'amend',
  confirmationNumber: CONFIRMATION,
  guestLastName: 'Mokoena',
  arrival: '2026-10-12',
  departure: '2026-10-14',
  requestedChange: 'Extend the stay by two nights',
};

const CANCEL: QuoteAmendment = {
  ...AMEND,
  kind: 'cancel',
  arrival: '2027-09-14',
  departure: '2027-09-16',
  requestedChange: null,
};

function sessionWith(amendment: QuoteAmendment | null, threadId: string | null = THREAD): QuoteSession {
  let session = reduceQuoteSession(initialQuoteSession(), {
    type: 'selection',
    binding: {
      transportId: 't1',
      mailboxEmail: 'centurion@legacyhotels.co.za',
      storeId: 'store',
      folderEntryId: 'inbox',
      entryId: 'e1',
      selectionEpoch: 7,
      scopeEpoch: 1,
    },
  });
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: { intent: 'other', groups: [], secondaryAsks: [], alternatives: [], amendment },
  });
  if (threadId) {
    session = reduceQuoteSession(session, {
      type: 'staff_source_ready',
      source: { messageId: 'msg-1', threadId, sourceHash: 'a'.repeat(64) },
    });
  }
  return session;
}

/** One Guest Stay as findStay returns it. Override any field; the defaults are a booked, rated stay. */
function stayRecord(overrides: Partial<StayRecordWire> = {}): StayRecordWire {
  return {
    status: 'Reserved',
    confirmation: CONFIRMATION,
    lastName: 'Mokoena',
    firstName: 'Thabo',
    arrival: '2026-10-12',
    departure: '2026-10-13',
    nights: 1,
    adults: 1,
    children: 0,
    roomType: 'DLXKNG',
    ratePlan: 'BAR',
    mealPlan: 'Bed & breakfast',
    averageRate: '1360.00',
    grandTotal: 'R1 360,00',
    balance: '0.00',
    sourceOfBusiness: null,
    guaranteeType: null,
    bookingAgency: null,
    organization: null,
    ...overrides,
  };
}

function found(stay: Partial<StayRecordWire> = {}, screenshots: string[] = ['record.png', 'panel.png']): FindStayReply {
  return { outcome: 'found', reason: null, stay: stayRecord(stay), screenshots, runId: RUN_ID };
}

const NOT_FOUND: FindStayReply = { outcome: 'not_found', reason: null, stay: null, screenshots: [], runId: null };
const AMBIGUOUS: FindStayReply = { outcome: 'ambiguous', reason: null, stay: null, screenshots: [], runId: null };

function refusal(outcome: string): FindStayReply {
  return { outcome, reason: null, stay: null, screenshots: [], runId: null };
}

const AS_OF = '2026-10-09T08:05:00.000Z';

type FindMock = { findStay: ReturnType<typeof vi.fn>; screenshot?: ReturnType<typeof vi.fn> };
type SearchMock = { searchGuest: ReturnType<typeof vi.fn> };

/**
 * The paneStayLookup job routes and the capability route, as the panel reads them off the tRPC client. Each queue call
 * runs its HMS mock and stores the reply as a finished job, so jobStatus returns it on the first poll. A mock that
 * rejects fails the queue call.
 */
function lookupTrpc(
  findStay: ReturnType<typeof vi.fn>,
  shot: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(NO_SHOT),
  searchGuest: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ outcome: 'ok', rows: [], screenshots: [], runId: null }),
) {
  const jobs = new Map<string, HmsJobView>();
  let issued = 0;
  const finish = (request: HmsJobRequest, reply: unknown): { runId: string } => {
    // A call that answers with nothing is a failed call, as it was before the job route.
    if (!reply) throw new Error('no reply from HMS');
    const runId = `run-${++issued}`;
    jobs.set(runId, {
      runId,
      request,
      prefetch: false,
      status: 'done',
      position: null,
      attempts: 1,
      failureClass: null,
      asOf: AS_OF,
      result: { ...(reply as Record<string, unknown>), kind: request.kind, asOf: AS_OF },
    });
    return { runId };
  };
  return {
    paneStayLookup: {
      queueFind: {
        mutate: async ({ threadId: _threadId, ...input }: FindStayInput & { threadId: string }) =>
          finish({ kind: 'find', ...input }, await findStay(input)),
      },
      queueSearchGuest: {
        mutate: async ({ threadId: _threadId, ...input }: GuestSearchInput & { threadId: string }) =>
          finish({ kind: 'search_guest', ...input }, await searchGuest(input)),
      },
      jobStatus: {
        query: async (input: { runId: string } | { threadId: string }) =>
          'runId' in input ? (jobs.get(input.runId) ?? null) : null,
      },
      screenshot: { query: shot },
    },
    brain: { getCapabilities: { query: async () => ({ paneSave: capabilities.paneSave }) } },
  };
}

/** Polls one job the way the panel does, until it settles. */
async function settle(transport: HmsJobTransport, runId: string): Promise<HmsJobView | null> {
  let last: HmsJobView | null = null;
  await pollHmsJob(transport, runId, {
    live: () => last === null || !isSettled(last),
    onView: (view) => {
      last = view;
    },
  });
  return last;
}

/** A find as the panel runs it: queued as a job on the thread, polled to settle, and mapped to the panel's run. */
async function runHmsFind(options: {
  client: FindMock | null;
  confirmation: string;
  arrival?: string | null;
}): Promise<HmsFindRun> {
  if (!options.client) return { kind: 'error', message: AMEND_FIND_COPY.unavailable };
  const next = findRequestFor(options.confirmation, options.arrival);
  if (!('request' in next)) return { kind: 'error', message: next.error };
  const bound = amendFindClientFromTrpc(lookupTrpc(options.client.findStay, options.client.screenshot));
  const transport = hmsJobTransport(bound, THREAD);
  if (!transport) return { kind: 'error', message: AMEND_FIND_COPY.unavailable };
  try {
    const started = await transport.queue(next.request);
    const view = started.view ?? (started.runId ? await settle(transport, started.runId) : null);
    return findRunFromJob(view, false) ?? { kind: 'error', message: AMEND_FIND_COPY.readFailed };
  } catch {
    return { kind: 'error', message: AMEND_FIND_COPY.lookupFailed };
  }
}

/** A guest-name search as the panel runs it: validated, queued as a job, polled to settle, and mapped to the panel's run. */
async function runHmsSearch(options: {
  client: SearchMock | null;
  lastName: string;
  arrival: string | null | undefined;
  departure?: string | null;
}): Promise<HmsSearchRun> {
  if (!options.client) return { kind: 'error', message: AMEND_FIND_COPY.unavailable };
  const next = searchRequestFor(options);
  if (!('request' in next)) return { kind: 'error', message: next.error };
  const bound = amendFindClientFromTrpc(lookupTrpc(vi.fn(), undefined, options.client.searchGuest));
  const transport = hmsJobTransport(bound, THREAD);
  if (!transport) return { kind: 'error', message: AMEND_FIND_COPY.unavailable };
  try {
    const started = await transport.queue(next.request);
    const view = started.view ?? (started.runId ? await settle(transport, started.runId) : null);
    return searchRunFromJob(view, false) ?? { kind: 'error', message: AMEND_FIND_COPY.searchFailed };
  } catch {
    return { kind: 'error', message: AMEND_FIND_COPY.searchFailed };
  }
}

const ROW_MOKOENA = {
  confirmation: '46184891-1',
  firstName: 'Thabo',
  lastName: 'Mokoena',
  status: 'Reserved',
  arrival: '2026-10-12',
  departure: '2026-10-13',
};
const ROW_CANCELLED = {
  confirmation: '46184892-1',
  firstName: 'Lerato',
  lastName: 'Mokoena',
  status: 'Cancelled',
  arrival: '2026-10-12',
  departure: null,
};

/** Staff press the find button. The panel never looks up HMS on its own. */
function pressFind() {
  fireEvent.click(screen.getByRole('button', { name: 'Find this booking in HMS' }));
}

/** The HMS column shows its Status row once HMS holds the booking. */
async function expectFoundBooking() {
  await waitFor(() => expect(document.querySelector('[data-field="status"]')).not.toBeNull());
}

function cancelRun(overrides: Partial<CancelRun> = {}): CancelRun {
  return {
    outcome: 'execution_failure',
    statusBefore: null,
    statusAfter: null,
    reasons: [],
    penaltyText: null,
    screenshots: [],
    runId: null,
    previewDigest: null,
    ...overrides,
  };
}

const PENALTY = 'Cancellation Penalty of 2060.00 may be added to account.';
const PREVIEW_OK: CancelRun = cancelRun({
  outcome: 'preview_ok',
  statusBefore: 'Reserved',
  statusAfter: 'Reserved',
  reasons: ['Test Reservations', 'Duplicate Booking'],
  penaltyText: PENALTY,
  screenshots: ['found.png', 'cancel-dialog.png'],
  runId: RUN_ID,
  previewDigest: DIGEST,
});

describe('AmendLookupPanel', () => {
  it('shows what the guest asked, each labelled from the email, with the footer note', () => {
    const findStay = vi.fn(NEVER_SETTLES);
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    expect(screen.getByText('Change to an existing booking')).toBeTruthy();
    expect(screen.getByText('What the guest asked')).toBeTruthy();
    expect(screen.getByText('Extend the stay by two nights')).toBeTruthy();
    expect(screen.getByText(CONFIRMATION)).toBeTruthy();
    expect(screen.getByText('Mokoena')).toBeTruthy();
    expect(screen.getByText('12 Oct 2026')).toBeTruthy();
    expect(screen.getByText('14 Oct 2026')).toBeTruthy();
    expect(screen.getAllByText('From the email')).toHaveLength(5);
    expect(screen.getByText('Nava only looks the booking up. Make the change in HMS yourself.')).toBeTruthy();
  });

  it('shows the requested stay as what the guest asked, and finds the booking by its booked arrival (AE2)', async () => {
    // Booked 12–14 Oct; the guest adds the night of 11 Oct and checks out on 15 Oct.
    const findStay = vi.fn().mockResolvedValue(found({ arrival: '2026-10-12', departure: '2026-10-14' }));
    const ask = { ...AMEND, requestedArrival: '2026-10-11', requestedDeparture: '2026-10-15' };
    render(<AmendLookupPanel session={sessionWith(ask)} trpc={lookupTrpc(findStay)} />);
    expect(screen.getByText('11 Oct 2026')).toBeTruthy();
    expect(screen.getByText('15 Oct 2026')).toBeTruthy();
    pressFind();
    await waitFor(() => expect(findStay).toHaveBeenCalledWith({ confirmation: CONFIRMATION, arrival: '2026-10-12' }));
    await waitFor(() => expect(screen.getByText('Guest wants: 11 Oct 2026')).toBeTruthy());
    expect(screen.getByText('Guest wants: 15 Oct 2026')).toBeTruthy();
    expect(document.querySelector('[data-field="arrival"]')?.getAttribute('data-differs')).toBe('true');
  });

  it('shows an unknown requested date as not stated, not the booked date, and finds no false match in HMS', async () => {
    // The guest moves the arrival but the read could not tell to when. The departure stays as booked.
    const findStay = vi.fn().mockResolvedValue(found({ arrival: '2026-10-12', departure: '2026-10-14' }));
    const ask = { ...AMEND, requestedArrival: null, requestedDeparture: '2026-10-14' };
    render(<AmendLookupPanel session={sessionWith(ask)} trpc={lookupTrpc(findStay)} />);
    expect(screen.getByText('Not stated')).toBeTruthy();
    expect(screen.queryByText('12 Oct 2026')).toBeNull();
    expect(askedDates(ask)).toEqual({ arrival: null, departure: '2026-10-14' });
    // An older payload without the requested pair, and a cancellation, show the booking as stated.
    expect(askedDates(AMEND)).toEqual({ arrival: '2026-10-12', departure: '2026-10-14' });
    expect(askedDates({ ...CANCEL, requestedArrival: null, requestedDeparture: null })).toEqual({
      arrival: '2027-09-14',
      departure: '2027-09-16',
    });
  });

  it('with booked dates in mail, uses them for the find and shows no booked-dates note', async () => {
    const findStay = vi.fn().mockResolvedValue(found());
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    expect(screen.queryByTestId('booked-dates-missing')).toBeNull();
    pressFind();
    await waitFor(() => expect(findStay).toHaveBeenCalledWith({ confirmation: CONFIRMATION, arrival: '2026-10-12' }));
  });

  it('with no booked dates in mail, finds by confirmation number alone and never sends the requested arrival (AE2)', async () => {
    const findStay = vi.fn().mockResolvedValue(found({ arrival: '2026-10-31', departure: '2026-11-07' }));
    const requestedOnly = {
      ...AMEND,
      arrival: null,
      departure: null,
      requestedArrival: '2026-10-31',
      requestedDeparture: '2026-11-07',
    };
    render(<AmendLookupPanel session={sessionWith(requestedOnly)} trpc={lookupTrpc(findStay)} />);
    expect(screen.getByText(AMEND_FIND_COPY.bookedMissing)).toBeTruthy();
    pressFind();
    await waitFor(() => expect(findStay).toHaveBeenCalledWith({ confirmation: CONFIRMATION }));
    expect(findStay.mock.calls[0]?.[0]).not.toHaveProperty('arrival');
    await expectFoundBooking();
    // The note stays on the result: the booking was found without booked dates.
    expect(screen.getByText(AMEND_FIND_COPY.bookedMissing)).toBeTruthy();
    expect(findStay).toHaveBeenCalledTimes(1);
  });

  it('with no booked dates in mail and no booking number, opens the name search with no arrival, not the requested one', () => {
    const requestedOnly = {
      ...AMEND,
      confirmationNumber: null,
      arrival: null,
      departure: null,
      requestedArrival: '2026-10-31',
      requestedDeparture: '2026-11-07',
    };
    render(<AmendLookupPanel session={sessionWith(requestedOnly)} trpc={lookupTrpc(vi.fn())} />);
    expect(screen.getByTestId('amend-guest-search')).toBeTruthy();
    expect((screen.getByLabelText('Guest surname') as HTMLInputElement).value).toBe('Mokoena');
    expect((screen.getByLabelText('Arrival') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Departure (optional)') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(AMEND_FIND_COPY.bookedMissing)).toBeTruthy();
  });

  it('labels a cancellation request as one', () => {
    const findStay = vi.fn(NEVER_SETTLES);
    render(
      <AmendLookupPanel
        session={sessionWith({ ...AMEND, kind: 'cancel', requestedChange: null })}
        trpc={lookupTrpc(findStay)}
      />,
    );
    expect(screen.getByText('Cancellation request')).toBeTruthy();
    expect(screen.getByText('Not stated')).toBeTruthy();
  });

  it('renders nothing when the analysis carries no amendment', () => {
    const { container } = render(<AmendLookupPanel session={sessionWith(null)} trpc={lookupTrpc(vi.fn())} />);
    expect(container.innerHTML).toBe('');
  });

  it('never looks up HMS on its own: staff press the find button, and the wait is said up front', async () => {
    const findStay = vi.fn(NEVER_SETTLES);
    const session = sessionWith(AMEND);
    const { rerender } = render(<AmendLookupPanel session={session} trpc={lookupTrpc(findStay)} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(findStay).not.toHaveBeenCalled();
    expect(screen.getByText('Takes about 1–2 minutes. Quotes wait while it runs.')).toBeTruthy();
    pressFind();
    await waitFor(() => expect(findStay).toHaveBeenCalledTimes(1));
    expect(findStay).toHaveBeenCalledWith({ confirmation: CONFIRMATION, arrival: '2026-10-12' });
    expect(screen.getByText('Nava is looking up the booking in HMS…')).toBeTruthy();
    rerender(<AmendLookupPanel session={session} trpc={lookupTrpc(findStay)} />);
    expect(findStay).toHaveBeenCalledTimes(1);
  });

  it('shows the booking HMS returns and highlights the field that differs', async () => {
    const findStay = vi.fn().mockResolvedValue(found({ departure: '2026-10-13' }));
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await waitFor(() => expect(screen.getByText('Guest wants: 14 Oct 2026')).toBeTruthy());
    expect(screen.queryByText('Matched on')).toBeNull();
    expect(screen.getAllByText(/^Guest wants:/)).toHaveLength(1);
    expect(document.querySelector('[data-field="departure"]')?.getAttribute('data-differs')).toBe('true');
    expect(document.querySelector('[data-field="arrival"]')?.getAttribute('data-differs')).toBe('false');
    expect(document.querySelector('[data-field="guest"]')?.getAttribute('data-differs')).toBe('false');
  });

  it('says what the guest mentioned and when HMS holds the booking, when the arrivals differ', async () => {
    const findStay = vi.fn().mockResolvedValue({
      ...found({ arrival: '2026-10-13', departure: '2026-10-14' }),
      arrivalMismatch: true,
      requestedArrival: '2026-10-12',
      hmsArrival: '2026-10-13',
    });
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await waitFor(() =>
      expect(
        screen.getByText('The guest mentioned 12 Oct 2026; the booking in HMS arrives 13 Oct 2026.'),
      ).toBeTruthy(),
    );
  });

  it('shows rate plan, meal plan and grand total when HMS shows them', async () => {
    const findStay = vi.fn().mockResolvedValue(found());
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await expectFoundBooking();
    expect(screen.getByText('Rate plan')).toBeTruthy();
    expect(screen.getByText('BAR')).toBeTruthy();
    expect(screen.getByText('Meal plan')).toBeTruthy();
    expect(screen.getByText('Bed & breakfast')).toBeTruthy();
    expect(screen.getByText('Grand total')).toBeTruthy();
    expect(screen.getByText('R1 360,00')).toBeTruthy();
  });

  it('hides rate plan, meal plan and grand total when HMS does not show them', async () => {
    const findStay = vi.fn().mockResolvedValue(found({ ratePlan: null, mealPlan: null, grandTotal: null }));
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await expectFoundBooking();
    expect(screen.queryByText('Rate plan')).toBeNull();
    expect(screen.queryByText('Meal plan')).toBeNull();
    expect(screen.queryByText('Grand total')).toBeNull();
  });

  it('shows the booking record screenshot as a thumbnail that opens full size', async () => {
    const findStay = vi.fn().mockResolvedValue(found());
    const shot = vi.fn().mockResolvedValue({ status: 'ok', dataUrl: SHOT_PNG });
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay, shot)} />);
    pressFind();
    await waitFor(() => expect(shot).toHaveBeenCalledWith({ runId: RUN_ID, name: 'record.png' }));
    fireEvent.click(await screen.findByRole('button', { name: 'See the booking in HMS' }));
    const dialog = screen.getByRole('dialog', { name: 'See the booking in HMS' });
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe(SHOT_PNG);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('explains a booking number HMS does not know, with the next step', async () => {
    const findStay = vi.fn().mockResolvedValue(NOT_FOUND);
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await waitFor(() =>
      expect(
        screen.getByText(
          'No booking with that number in HMS. Check the number in the email or find the booking by guest name below.',
        ),
      ).toBeTruthy(),
    );
  });

  it('says HMS matched more than one booking', async () => {
    const findStay = vi.fn().mockResolvedValue(AMBIGUOUS);
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await waitFor(() =>
      expect(screen.getByText('HMS matched more than one booking for that number. Check HMS directly.')).toBeTruthy(),
    );
  });

  it('does not look up an agent reference HMS cannot take: the number is named and the find stays disabled', () => {
    const findStay = vi.fn();
    render(
      <AmendLookupPanel
        session={sessionWith({ ...AMEND, confirmationNumber: '9999SH999999' })}
        trpc={lookupTrpc(findStay)}
      />,
    );
    expect(
      screen.getByText(
        "The number in the email (9999SH999999) looks like the agent's own reference, not an HMS booking number. Find the booking by guest name below.",
      ),
    ).toBeTruthy();
    expect(screen.getByText('No HMS booking number found in the email.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Find this booking in HMS' }) as HTMLButtonElement).disabled).toBe(true);
    pressFind();
    expect(findStay).not.toHaveBeenCalled();
  });

  it('disables the manual lookup and says why when the email has no booking number', () => {
    const findStay = vi.fn();
    render(<AmendLookupPanel session={sessionWith({ ...AMEND, confirmationNumber: null })} trpc={lookupTrpc(findStay)} />);
    const button = screen.getByRole('button', { name: 'Find this booking in HMS' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      screen.getByText("Nava couldn't find a booking number in the email. Find the booking by guest name below."),
    ).toBeTruthy();
    expect(screen.getByText('No HMS booking number found in the email.')).toBeTruthy();
    expect(findStay).not.toHaveBeenCalled();
  });

  it.each([
    ['refused_lock_busy', 'HMS is busy with another quote or lookup. Try again in a minute.'],
    ['refused_lock_unavailable', "Nava can't reach HMS right now. Tell the Nava team."],
    ['refused_flag_off', 'The HMS lookup is not connected in this session. Search HMS by hand.'],
    ['refused_input_invalid', AMEND_FIND_COPY.notExact],
    ['execution_failure', 'Nava could not read the HMS result. Try again in a minute.'],
  ])('shows the copy for a %s result', async (outcome, message) => {
    const findStay = vi.fn().mockResolvedValue(refusal(outcome));
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
  });

  it('maps a failed find call to plain copy and never shows the raw error', async () => {
    const findStay = vi
      .fn()
      .mockRejectedValue(new Error('[{"code":"invalid_string","path":["confirmation"]}] socket hang up'));
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await waitFor(() => expect(screen.getByText("Nava couldn't look this up. Search HMS yourself.")).toBeTruthy());
    expect(screen.queryByText(/invalid_string|socket hang up/)).toBeNull();
  });

  it('runs the find again when staff press the button after a failed result', async () => {
    const findStay = vi
      .fn()
      .mockResolvedValueOnce(refusal('execution_failure'))
      .mockResolvedValueOnce(found());
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await screen.findByText('Nava could not read the HMS result. Try again in a minute.');
    fireEvent.click(screen.getByRole('button', { name: 'Find this booking in HMS' }));
    await expectFoundBooking();
    expect(findStay).toHaveBeenCalledTimes(2);
  });

  it('shows a queued job as queued while its status reads fail, never as idle', async () => {
    const trpc = lookupTrpc(vi.fn().mockResolvedValue(found()));
    trpc.paneStayLookup.jobStatus.query = async () => {
      throw new Error('status read failed');
    };
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={trpc} />);
    pressFind();
    await waitFor(() =>
      expect(screen.getByTestId('hms-job-status').getAttribute('data-state')).toBe('queued'),
    );
  });
});

describe('pollHmsJob', () => {
  it('shows the job as failed when no status read ever succeeded, so Retry is offered', async () => {
    vi.useFakeTimers();
    try {
      const views: HmsJobView[] = [];
      const transport: HmsJobTransport = {
        queue: vi.fn(),
        status: vi.fn().mockRejectedValue(new Error('status read failed')),
      };
      const done = pollHmsJob(transport, RUN_ID, { live: () => true, onView: (view) => views.push(view) });
      await vi.runAllTimersAsync();
      await done;
      expect(views).toEqual([expect.objectContaining({ runId: RUN_ID, status: 'failed', failureClass: 'POLL_LOST' })]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** With jobs off, auto-start is quiet; explicit party Find stays inline. */
function syncTrpc(
  findStay: ReturnType<typeof vi.fn>,
  searchGuest: ReturnType<typeof vi.fn> = vi.fn(),
  findParty: ReturnType<typeof vi.fn> = vi
    .fn()
    .mockResolvedValue({ outcome: 'no_match', results: [], truncated: false }),
) {
  const jobStatus = vi.fn(async (_input: object) => null);
  const queueParty = vi.fn(async (_input: object) => ({ runId: null }));
  return {
    jobStatus,
    queueParty,
    trpc: {
      paneStayLookup: {
        queueFind: { mutate: async () => ({ runId: null }) },
        queueSearchGuest: { mutate: async () => ({ runId: null }) },
        queueParty: { mutate: queueParty },
        findStay: { mutate: findStay },
        searchGuest: { mutate: searchGuest },
        jobStatus: { query: jobStatus },
        screenshot: { query: vi.fn().mockResolvedValue(NO_SHOT) },
      },
      panePartyLookup: { findParty: { mutate: findParty } },
      brain: { getCapabilities: { query: async () => ({ paneSave: capabilities.paneSave }) } },
    },
  };
}

describe('AmendLookupPanel with the job queue off', () => {
  it('finds the booking synchronously through findStay, with no job polled and no as-of stamp', async () => {
    const findStay = vi.fn().mockResolvedValue(found({ departure: '2026-10-13' }));
    const { trpc, jobStatus } = syncTrpc(findStay);
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={trpc} />);
    pressFind();
    await waitFor(() => expect(screen.getByText('Guest wants: 14 Oct 2026')).toBeTruthy());
    expect(findStay).toHaveBeenCalledWith({ confirmation: CONFIRMATION, arrival: '2026-10-12' });
    expect(jobStatus.mock.calls.some(([input]) => 'runId' in input)).toBe(false);
    expect(screen.queryByTestId('hms-as-of')).toBeNull();
  });

  it('runs the guest-name search synchronously through searchGuest', async () => {
    const search = vi.fn().mockResolvedValue({ outcome: 'ok', rows: [ROW_MOKOENA], screenshots: [], runId: null });
    const { trpc } = syncTrpc(vi.fn(), search);
    render(<AmendLookupPanel session={sessionWith({ ...AMEND, confirmationNumber: null })} trpc={trpc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search HMS' }));
    await screen.findByRole('list', { name: 'Bookings found in HMS' });
    expect(search).toHaveBeenCalledWith({ lastName: 'Mokoena', arrival: '2026-10-12', departure: '2026-10-14' });
  });

  it('reads a failed synchronous call as the lookup failure, as before jobs', async () => {
    const { trpc } = syncTrpc(vi.fn().mockRejectedValue(new Error('socket hang up')));
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={trpc} />);
    pressFind();
    await waitFor(() => expect(screen.getByText("Nava couldn't look this up. Search HMS yourself.")).toBeTruthy());
  });
});

describe('party lookup transport with the job queue off', () => {
  const request = { kind: 'party' as const, name: 'ABC Travel', partyKind: 'company' as const };

  it('does not repeat a live lookup for an automatic read-back start', async () => {
    const findParty = vi
      .fn()
      .mockResolvedValue({ outcome: 'resolved', results: [], truncated: false });
    const { trpc, queueParty } = syncTrpc(vi.fn(), vi.fn(), findParty);
    const transport = hmsJobTransport(amendFindClientFromTrpc(trpc), THREAD);
    expect(transport).not.toBeNull();

    await expect(transport!.queue(request, { autoStart: true })).resolves.toEqual({ runId: null });
    expect(queueParty).toHaveBeenCalledWith({
      threadId: THREAD,
      name: request.name,
      partyKind: request.partyKind,
      autoStart: true,
    });
    expect(findParty).not.toHaveBeenCalled();
  });

  it('keeps the explicit party search on the existing synchronous path', async () => {
    const reply = { outcome: 'no_match', results: [], truncated: false };
    const findParty = vi.fn().mockResolvedValue(reply);
    const { trpc } = syncTrpc(vi.fn(), vi.fn(), findParty);
    const transport = hmsJobTransport(amendFindClientFromTrpc(trpc), THREAD);
    expect(transport).not.toBeNull();

    const started = await transport!.queue(request);
    expect(findParty).toHaveBeenCalledWith({ name: 'ABC Travel', kind: 'company' });
    expect(started).toMatchObject({
      runId: null,
      view: { status: 'done', outcome: 'no_match', result: reply },
    });
  });
});

describe('AmendLookupPanel guest-name search', () => {
  const NO_NUMBER: QuoteAmendment = { ...AMEND, confirmationNumber: null };
  const SEARCH_BUTTON = 'Search HMS';
  const NO_ROWS_OK = { outcome: 'ok', rows: [], screenshots: [], runId: null };

  it('prefills the name search from the email, and opens it when the email has no booking number', () => {
    render(<AmendLookupPanel session={sessionWith(NO_NUMBER)} trpc={lookupTrpc(vi.fn())} />);
    expect(screen.getByTestId('amend-guest-search')).toBeTruthy();
    expect((screen.getByLabelText('Guest surname') as HTMLInputElement).value).toBe('Mokoena');
    expect((screen.getByLabelText('Arrival') as HTMLInputElement).value).toBe('2026-10-12');
    expect((screen.getByLabelText('Departure (optional)') as HTMLInputElement).value).toBe('2026-10-14');
    expect((screen.getByRole('button', { name: SEARCH_BUTTON }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the name search closed while the email has a usable booking number', () => {
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(vi.fn())} />);
    expect(screen.queryByTestId('amend-guest-search')).toBeNull();
  });

  it('searches by surname and arrival, lists the bookings, and a click runs the find for that booking', async () => {
    const findStay = vi.fn().mockResolvedValue(found());
    const search = vi.fn().mockResolvedValue({
      outcome: 'ok',
      rows: [ROW_MOKOENA, ROW_CANCELLED],
      screenshots: [],
      runId: null,
    });
    render(<AmendLookupPanel session={sessionWith(NO_NUMBER)} trpc={lookupTrpc(findStay, undefined, search)} />);
    fireEvent.click(screen.getByRole('button', { name: SEARCH_BUTTON }));
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith({ lastName: 'Mokoena', arrival: '2026-10-12', departure: '2026-10-14' }),
    );
    const list = await screen.findByRole('list', { name: 'Bookings found in HMS' });
    const items = within(list).getAllByRole('button') as HTMLButtonElement[];
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('46184891-1');
    expect(items[0]?.textContent).toContain('Thabo Mokoena');
    expect(items[0]?.textContent).toContain('Reserved');
    expect(items[0]?.textContent).toContain('12 Oct 2026 to 13 Oct 2026');
    expect(items[1]?.textContent).toContain('Cancelled');
    expect(items[1]?.textContent).toContain('12 Oct 2026 to Not shown');
    fireEvent.click(items[0] as HTMLButtonElement);
    await expectFoundBooking();
    expect(findStay).toHaveBeenCalledWith({ confirmation: '46184891-1', arrival: '2026-10-12' });
    expect(screen.getByRole('button', { name: 'Copy confirmation' })).toBeTruthy();
  });

  it('says no booking matched the surname and arrival, and says what to check', async () => {
    const search = vi.fn().mockResolvedValue(NO_ROWS_OK);
    render(<AmendLookupPanel session={sessionWith(NO_NUMBER)} trpc={lookupTrpc(vi.fn(), undefined, search)} />);
    fireEvent.click(screen.getByRole('button', { name: SEARCH_BUTTON }));
    await waitFor(() =>
      expect(
        screen.getByText('No booking for Mokoena arriving 12 Oct 2026 in HMS. Check the spelling or dates.'),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole('list', { name: 'Bookings found in HMS' })).toBeNull();
  });

  it('says to add the departure date when the search is capped, and lists nothing from the partial read', async () => {
    const search = vi.fn().mockResolvedValue({ outcome: 'ambiguous_capped', rows: [], screenshots: [], runId: null });
    render(<AmendLookupPanel session={sessionWith(NO_NUMBER)} trpc={lookupTrpc(vi.fn(), undefined, search)} />);
    fireEvent.click(screen.getByRole('button', { name: SEARCH_BUTTON }));
    await waitFor(() => expect(screen.getByText('Many matches — add the departure date.')).toBeTruthy());
    expect(screen.queryByRole('list', { name: 'Bookings found in HMS' })).toBeNull();
  });

  it('maps a refused search to plain copy, and checks the dates before any call', async () => {
    const search = vi.fn().mockResolvedValue({ outcome: 'refused_lock_busy', rows: [], screenshots: [], runId: null });
    render(<AmendLookupPanel session={sessionWith(NO_NUMBER)} trpc={lookupTrpc(vi.fn(), undefined, search)} />);
    fireEvent.click(screen.getByRole('button', { name: SEARCH_BUTTON }));
    await waitFor(() =>
      expect(screen.getByText('HMS is busy with another quote or lookup. Try again in a minute.')).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText('Departure (optional)'), { target: { value: '2026-10-11' } });
    fireEvent.click(screen.getByRole('button', { name: SEARCH_BUTTON }));
    await waitFor(() => expect(screen.getByText('Check the surname and dates, then search again.')).toBeTruthy());
    expect(search).toHaveBeenCalledTimes(1);
  });

  it.each(['1879000', '57291630', '5729163012'])(
    'does not turn the bare number %s into a booking: the find stays off, no lookup runs, and the name search opens',
    (bare) => {
      const findStay = vi.fn();
      render(
        <AmendLookupPanel session={sessionWith({ ...AMEND, confirmationNumber: bare })} trpc={lookupTrpc(findStay)} />,
      );
      expect((screen.getByRole('button', { name: 'Find this booking in HMS' }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId('amend-guest-search')).toBeTruthy();
      expect(
        screen.getByText(
          `The number in the email (${bare}) looks like the agent's own reference, not an HMS booking number. Find the booking by guest name below.`,
        ),
      ).toBeTruthy();
      pressFind();
      expect(findStay).not.toHaveBeenCalled();
    },
  );

  it('looks up a dash confirmation exactly as written, and shows that booking', async () => {
    const findStay = vi.fn().mockResolvedValue(found({ confirmation: '64318608-1' }));
    render(
      <AmendLookupPanel session={sessionWith({ ...AMEND, confirmationNumber: '64318608-1' })} trpc={lookupTrpc(findStay)} />,
    );
    pressFind();
    await expectFoundBooking();
    expect(findStay).toHaveBeenCalledWith({ confirmation: '64318608-1', arrival: '2026-10-12' });
    expect(screen.queryByText('Matched on')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Copy confirmation' })).toHaveLength(1);
    expect(screen.queryByTestId('amend-guest-search')).toBeNull();
  });

  it('shows one handoff row, Copy link and Copy confirmation, with Open HMS beside them and no link target', async () => {
    const HMS_LANDING = 'https://appsrv-1.legacyhotels.co.za/web/base/logindisp?tenant=HMS_LEGACY';
    const findStay = vi.fn().mockResolvedValue(found());
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    expect(screen.queryAllByRole('link', { name: 'Open HMS' })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: 'Copy link' })).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: 'Copy confirmation' })).toHaveLength(1);
    vi.stubEnv('VITE_PUBLIC_HMS_LANDING_URL', HMS_LANDING);
    cleanup();
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    expect(screen.getAllByRole('button', { name: 'Copy link' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Open HMS' })).toHaveLength(1);
    pressFind();
    await expectFoundBooking();
    const links = screen.getAllByRole('link', { name: 'Open HMS' });
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe(HMS_LANDING);
    expect(links[0]?.hasAttribute('target')).toBe(false);
    expect(screen.getAllByRole('button', { name: 'Copy link' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Copy confirmation' })).toHaveLength(1);
  });

  it('hides the find button and its wait note once HMS shows the booking', async () => {
    const findStay = vi.fn().mockResolvedValue(found());
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    expect(screen.getByRole('button', { name: 'Find this booking in HMS' })).toBeTruthy();
    pressFind();
    await expectFoundBooking();
    expect(screen.queryByRole('button', { name: 'Find this booking in HMS' })).toBeNull();
    expect(screen.queryByText('Takes about 1–2 minutes. Quotes wait while it runs.')).toBeNull();
  });

  it('shows the requested dates from the email beside the booked dates from HMS (AE2)', async () => {
    const amend = { ...AMEND, arrival: '2026-10-31', departure: '2026-11-07' };
    const findStay = vi
      .fn()
      .mockResolvedValue(found({ arrival: '2026-11-01', departure: '2026-11-06' }));
    render(<AmendLookupPanel session={sessionWith(amend)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await expectFoundBooking();
    expect(screen.getByText('31 Oct 2026')).toBeTruthy();
    expect(screen.getByText('7 Nov 2026')).toBeTruthy();
    const arrival = document.querySelector('[data-field="arrival"]');
    const departure = document.querySelector('[data-field="departure"]');
    expect(arrival?.textContent).toContain('1 Nov 2026');
    expect(arrival?.getAttribute('data-differs')).toBe('true');
    expect(departure?.textContent).toContain('6 Nov 2026');
    expect(departure?.getAttribute('data-differs')).toBe('true');
  });
});

describe('guest-name search helpers', () => {
  it('takes a dash confirmation as written, and never turns a bare number into one', () => {
    expect(hmsNumberFor('64318608-1')).toBe('64318608-1');
    expect(hmsNumberFor(' 57291630-2 ')).toBe('57291630-2');
    expect(hmsNumberFor('1879000')).toBeNull();
    expect(hmsNumberFor('57291630')).toBeNull();
    expect(hmsNumberFor(' 5729163012 ')).toBeNull();
    expect(hmsNumberFor('12345')).toBeNull();
    expect(hmsNumberFor('57291630-123')).toBeNull();
    expect(hmsNumberFor('9999SH999999')).toBeNull();
    expect(hmsNumberFor(null)).toBeNull();
  });

  it('never queues a bare billing number to HMS, even when the caller passes one', async () => {
    const findStay = vi.fn();
    await expect(runHmsFind({ client: { findStay }, confirmation: '1879000' })).resolves.toMatchObject({
      kind: 'error',
    });
    expect(findStay).not.toHaveBeenCalled();
  });

  it('binds the search job route to the paneStayLookup routes only', async () => {
    expect(amendFindClientFromTrpc({ paneStayLookup: { queueFind: {} } })).toBeNull();
    const search = vi.fn().mockResolvedValue({ outcome: 'ok', rows: [], screenshots: [], runId: null });
    const client = amendFindClientFromTrpc(lookupTrpc(vi.fn(), undefined, search));
    await client?.queueSearchGuest({ threadId: THREAD, lastName: 'Mokoena', arrival: '2026-10-12' });
    expect(search).toHaveBeenCalledWith({ lastName: 'Mokoena', arrival: '2026-10-12' });
  });

  it('sends a surname of 2 to 40 letters, spaces, apostrophes or hyphens and a real arrival, and nothing else', async () => {
    const search = vi.fn().mockResolvedValue({ outcome: 'ok', rows: [], screenshots: [], runId: null });
    const client: SearchMock = { searchGuest: search };
    await expect(runHmsSearch({ client, lastName: 'X', arrival: '2026-10-12' })).resolves.toEqual({
      kind: 'error',
      message: AMEND_FIND_COPY.searchInvalid,
    });
    await expect(runHmsSearch({ client, lastName: "O'Brien-Jones", arrival: '2026-02-31' })).resolves.toEqual({
      kind: 'error',
      message: AMEND_FIND_COPY.searchInvalid,
    });
    await expect(runHmsSearch({ client, lastName: 'Mok0ena', arrival: '2026-10-12' })).resolves.toMatchObject({
      kind: 'error',
    });
    expect(search).not.toHaveBeenCalled();
    await runHmsSearch({ client, lastName: "  O'Brien   Jones ", arrival: '2026-10-12' });
    expect(search).toHaveBeenCalledWith({ lastName: "O'Brien Jones", arrival: '2026-10-12' });
  });

  it('turns each search outcome into rows, the no-match or capped state, or plain copy', async () => {
    const reply = (outcome: string, rows: unknown[] = []) =>
      vi.fn().mockResolvedValue({ outcome, rows, screenshots: [], runId: null });
    const base = { lastName: 'Mokoena', arrival: '2026-10-12', departure: '2026-10-14' };
    await expect(runHmsSearch({ client: { searchGuest: reply('ok', [ROW_MOKOENA]) }, ...base })).resolves.toEqual({
      kind: 'rows',
      rows: [ROW_MOKOENA],
    });
    await expect(runHmsSearch({ client: { searchGuest: reply('ok') }, ...base })).resolves.toEqual({
      kind: 'none',
      lastName: 'Mokoena',
      arrival: '2026-10-12',
    });
    await expect(runHmsSearch({ client: { searchGuest: reply('ambiguous_capped') }, ...base })).resolves.toEqual({
      kind: 'capped',
    });
    await expect(runHmsSearch({ client: { searchGuest: reply('execution_failure') }, ...base })).resolves.toEqual({
      kind: 'error',
      message: AMEND_FIND_COPY.searchFailed,
    });
    await expect(
      runHmsSearch({
        client: { searchGuest: vi.fn().mockRejectedValue(new Error('socket hang up')) },
        ...base,
      }),
    ).resolves.toEqual({ kind: 'error', message: AMEND_FIND_COPY.searchFailed });
    await expect(runHmsSearch({ client: null, ...base })).resolves.toEqual({
      kind: 'error',
      message: AMEND_FIND_COPY.unavailable,
    });
    await expect(runHmsSearch({ client: { searchGuest: reply('refused_flag_off') }, ...base })).resolves.toEqual({
      kind: 'error',
      message: AMEND_FIND_COPY.unavailable,
    });
  });

  it('names the surname and arrival in the no-match copy', () => {
    expect(noSearchMatchCopy('Mokoena', '2026-10-12')).toBe(
      'No booking for Mokoena arriving 12 Oct 2026 in HMS. Check the spelling or dates.',
    );
  });

  it('refuses a departure that is not a real day after the arrival, with no call', async () => {
    const search = vi.fn();
    const client: SearchMock = { searchGuest: search };
    await expect(
      runHmsSearch({ client, lastName: 'Mokoena', arrival: '2026-10-12', departure: '2026-10-12' }),
    ).resolves.toEqual({ kind: 'error', message: AMEND_FIND_COPY.searchInvalid });
    await expect(
      runHmsSearch({ client, lastName: 'Mokoena', arrival: '2026-10-12', departure: 'next week' }),
    ).resolves.toEqual({ kind: 'error', message: AMEND_FIND_COPY.searchInvalid });
    expect(search).not.toHaveBeenCalled();
  });
});

const CANCEL_ARRIVAL = CANCEL.arrival ?? '';

type CancelMocks = {
  preview?: ReturnType<typeof vi.fn>;
  commit?: ReturnType<typeof vi.fn>;
  shot?: ReturnType<typeof vi.fn>;
};

/** Renders a cancel email whose booking HMS finds, with the paneStayCancel routes mocked. */
function renderCancel(mocks: CancelMocks) {
  const findStay = vi.fn().mockResolvedValue(found({ arrival: CANCEL_ARRIVAL, departure: CANCEL.departure ?? '' }, []));
  const preview = mocks.preview ?? vi.fn();
  const commit = mocks.commit ?? vi.fn();
  const shot = mocks.shot ?? vi.fn().mockResolvedValue(NO_SHOT);
  const trpc = {
    ...lookupTrpc(findStay),
    paneStayCancel: {
      previewCancel: { mutate: preview },
      commitCancel: { mutate: commit },
      paneStayScreenshot: { query: shot },
    },
  };
  render(<AmendLookupPanel session={sessionWith(CANCEL)} trpc={trpc} />);
  pressFind();
  return { preview, commit, shot, findStay };
}

describe('AmendLookupPanel marks guest details for the preview gate (H6b)', () => {
  it('marks the booking number and guest names, from the email and from HMS', async () => {
    const findStay = vi.fn().mockResolvedValue(found({ lastName: 'Mokoena-Dube' }));
    const { container } = render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    expect(screen.getByText('Mokoena').hasAttribute('data-pii')).toBe(true);
    pressFind();
    await expectFoundBooking();
    expect(unmaskedPii(container, [CONFIRMATION, 'Mokoena', 'Thabo'])).toEqual([]);
  });

  it('marks the name search, its rows, a no-match line and a refused number', async () => {
    const noNumber: QuoteAmendment = { ...AMEND, confirmationNumber: null };
    const rows = vi.fn().mockResolvedValue({ outcome: 'ok', rows: [ROW_MOKOENA, ROW_CANCELLED], screenshots: [], runId: null });
    const listed = render(<AmendLookupPanel session={sessionWith(noNumber)} trpc={lookupTrpc(vi.fn(), undefined, rows)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search HMS' }));
    await screen.findByRole('list', { name: 'Bookings found in HMS' });
    expect(unmaskedPii(listed.container, ['Mokoena', 'Thabo', 'Lerato', '46184891-1', '46184892-1'])).toEqual([]);
    listed.unmount();

    const none = vi.fn().mockResolvedValue({ outcome: 'ok', rows: [], screenshots: [], runId: null });
    const empty = render(<AmendLookupPanel session={sessionWith(noNumber)} trpc={lookupTrpc(vi.fn(), undefined, none)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search HMS' }));
    await screen.findByText(noSearchMatchCopy('Mokoena', '2026-10-12'));
    expect(unmaskedPii(empty.container, ['Mokoena'])).toEqual([]);
    empty.unmount();

    const refused = render(
      <AmendLookupPanel session={sessionWith({ ...AMEND, confirmationNumber: '9999SH999999' })} trpc={lookupTrpc(vi.fn())} />,
    );
    expect(screen.getByText(notHmsNumberNote('9999SH999999')).hasAttribute('data-pii')).toBe(true);
    expect(unmaskedPii(refused.container, ['9999SH999999', 'Mokoena'])).toEqual([]);
  });

  it('marks the cancel lines and keeps the preview visibly disabled', async () => {
    renderCancel({});
    await screen.findByText(/^Cancelling from here is switched off/);
    expect(unmaskedPii(document.body, [CONFIRMATION, 'Mokoena', 'Thabo'])).toEqual([]);
    cleanup();

    capabilities.paneSave = true;
    const preview = vi.fn();
    const commit = vi.fn();
    renderCancel({ preview, commit });
    const previewButton = (await screen.findByRole('button', { name: 'Preview cancellation' })) as HTMLButtonElement;
    expect(previewButton.disabled).toBe(true);
    expect(screen.getByText('Coming soon')).toBeTruthy();
    fireEvent.click(previewButton);
    expect(preview).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(unmaskedPii(document.body, [CONFIRMATION, 'Mokoena', 'Thabo'])).toEqual([]);
  });
});

// Cancellation is disabled with "Coming soon" while writes are off (U-3). These cases assert that state.
describe('AmendLookupPanel cancel while writes are off (U-3)', () => {
  it('says cancelling is switched off, shows Coming soon and sends no preview when the pane save flag is off', async () => {
    const { preview } = renderCancel({});
    const previewButton = (await screen.findByRole('button', { name: 'Preview cancellation' })) as HTMLButtonElement;
    expect(previewButton.disabled).toBe(true);
    expect(screen.getByText('Coming soon')).toBeTruthy();
    expect(
      screen.getByText(
        'Cancelling from here is switched off for now. Cancel it in HMS: open 57291630-1, Actions → Cancel Reservation.',
      ),
    ).toBeTruthy();
    fireEvent.click(previewButton);
    expect(preview).not.toHaveBeenCalled();
  });

  it('keeps the look-up footer and a disabled preview on cancel mail even when the pane save flag is on', async () => {
    capabilities.paneSave = true;
    const preview = vi.fn();
    renderCancel({ preview });
    const previewButton = (await screen.findByRole('button', { name: 'Preview cancellation' })) as HTMLButtonElement;
    expect(previewButton.disabled).toBe(true);
    expect(screen.getByText('Nava only looks the booking up. Make the change in HMS yourself.')).toBeTruthy();
    expect(screen.queryByText(/Nava can preview the cancellation/)).toBeNull();
    fireEvent.click(previewButton);
    expect(preview).not.toHaveBeenCalled();
  });

  it('keeps the look-up footer on cancel mail when the pane save flag is off', async () => {
    renderCancel({});
    await screen.findByText(
      'Cancelling from here is switched off for now. Cancel it in HMS: open 57291630-1, Actions → Cancel Reservation.',
    );
    expect(screen.getByText('Nava only looks the booking up. Make the change in HMS yourself.')).toBeTruthy();
  });

  it('keeps the look-up footer on amend mail even when the pane save flag is on', () => {
    capabilities.paneSave = true;
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(vi.fn(NEVER_SETTLES))} />);
    expect(screen.getByText('Nava only looks the booking up. Make the change in HMS yourself.')).toBeTruthy();
    expect(screen.queryByText(/Nava can preview the cancellation/)).toBeNull();
  });
});

// ponytail: writes off (U-3); re-enable with HMS writes
describe.skip('AmendLookupPanel cancel from the pane (writes paused)', () => {

  it('previews the cancel, shows the HMS fee, then cancels with the chosen reason and the preview digest', async () => {
    capabilities.paneSave = true;
    const shot = vi.fn().mockResolvedValue({ status: 'ok', dataUrl: SHOT_PNG });
    const preview = vi.fn().mockResolvedValue(PREVIEW_OK);
    const commit = vi.fn().mockResolvedValue(
      cancelRun({ outcome: 'cancelled', statusBefore: 'Reserved', statusAfter: 'Cancelled', screenshots: ['readback.png'], runId: RUN_ID }),
    );
    renderCancel({ preview, commit, shot });

    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    expect(await screen.findByText(`HMS says: ${PENALTY}`)).toBeTruthy();
    expect(preview).toHaveBeenCalledWith({ confirmation: CONFIRMATION, arrival: CANCEL_ARRIVAL });
    expect(screen.getByText('Status in HMS: Reserved')).toBeTruthy();

    const commitButton = screen.getByRole('button', { name: 'Cancel booking in HMS' }) as HTMLButtonElement;
    expect(commitButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Cancellation reason'), { target: { value: 'Duplicate Booking' } });
    expect(commitButton.disabled).toBe(false);
    expect(
      screen.getByText(
        `Nava will cancel 57291630-1 for Thabo Mokoena. HMS says: ${PENALTY} This can't be undone from here.`,
      ),
    ).toBeTruthy();

    fireEvent.click(commitButton);
    expect(await screen.findByText('Cancelled in HMS – status now Cancelled')).toBeTruthy();
    expect(commit).toHaveBeenCalledWith({
      confirmation: CONFIRMATION,
      arrival: CANCEL_ARRIVAL,
      reason: 'Duplicate Booking',
      previewDigest: DIGEST,
    });
    await waitFor(() => expect(shot).toHaveBeenLastCalledWith({ runId: RUN_ID, name: 'readback.png' }));
    fireEvent.click(await screen.findByRole('button', { name: 'See what Nava saw in HMS' }));
    const dialog = screen.getByRole('dialog', { name: 'See what Nava saw in HMS' });
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe(SHOT_PNG);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not carry a preview over to another booking picked from the name search', async () => {
    capabilities.paneSave = true;
    const search = vi.fn().mockResolvedValue({ outcome: 'ok', rows: [ROW_MOKOENA, ROW_CANCELLED], screenshots: [], runId: null });
    const findStay = vi
      .fn()
      .mockResolvedValueOnce(found({ arrival: CANCEL_ARRIVAL, departure: CANCEL.departure ?? '' }, []))
      .mockResolvedValueOnce(found({ arrival: CANCEL_ARRIVAL, departure: CANCEL.departure ?? '' }, []));
    const preview = vi.fn().mockResolvedValue(PREVIEW_OK);
    const trpc = {
      ...lookupTrpc(findStay, undefined, search),
      paneStayCancel: {
        previewCancel: { mutate: preview },
        commitCancel: { mutate: vi.fn() },
        paneStayScreenshot: { query: vi.fn().mockResolvedValue(NO_SHOT) },
      },
    };
    render(<AmendLookupPanel session={sessionWith({ ...CANCEL, confirmationNumber: null })} trpc={trpc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search HMS' }));
    const bookings = () => within(screen.getByRole('list', { name: 'Bookings found in HMS' })).getAllByRole('button');
    await screen.findByRole('list', { name: 'Bookings found in HMS' });
    fireEvent.click(bookings()[0] as HTMLButtonElement);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    expect(await screen.findByText(`HMS says: ${PENALTY}`)).toBeTruthy();

    fireEvent.click(bookings()[1] as HTMLButtonElement);
    await waitFor(() => expect(findStay).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Preview cancellation' })).toBeTruthy();
    expect(screen.queryByText(`HMS says: ${PENALTY}`)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel booking in HMS' })).toBeNull();
  }, 15_000);

  it('says so when HMS shows no cancellation fee', async () => {
    capabilities.paneSave = true;
    const preview = vi.fn().mockResolvedValue({ ...PREVIEW_OK, penaltyText: null });
    renderCancel({ preview });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    fireEvent.change(await screen.findByLabelText('Cancellation reason'), {
      target: { value: 'Duplicate Booking' },
    });
    expect(screen.getByText('HMS showed no cancellation fee.')).toBeTruthy();
    expect(
      screen.getByText(
        "Nava will cancel 57291630-1 for Thabo Mokoena. HMS showed no cancellation fee. This can't be undone from here.",
      ),
    ).toBeTruthy();
  });

  it('says HMS may have cancelled the booking when the commit comes back cancel_unconfirmed', async () => {
    capabilities.paneSave = true;
    const preview = vi.fn().mockResolvedValue(PREVIEW_OK);
    const commit = vi.fn().mockResolvedValue(cancelRun({ outcome: 'cancel_unconfirmed' }));
    renderCancel({ preview, commit });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    fireEvent.change(await screen.findByLabelText('Cancellation reason'), {
      target: { value: 'Duplicate Booking' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking in HMS' }));
    expect(
      await screen.findByText('HMS may have cancelled this booking. Check HMS before trying again.'),
    ).toBeTruthy();
  });

  it('says the booking is already cancelled in HMS and offers no cancel', async () => {
    capabilities.paneSave = true;
    const preview = vi.fn().mockResolvedValue(
      cancelRun({ outcome: 'already_cancelled', statusBefore: 'Cancelled', statusAfter: 'Cancelled' }),
    );
    renderCancel({ preview });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    expect(await screen.findByText('This booking is already cancelled in HMS.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel booking in HMS' })).toBeNull();
  });

  it.each([
    ['refused_not_lab', 'Cancelling from here only works on test bookings right now.'],
    ['refused_lock_busy', 'HMS is busy with another quote or lookup. Try again in a minute.'],
    ['refused_lock_unavailable', "Nava can't reach HMS right now. Tell the Nava team."],
    ['execution_failure', "Nava couldn't finish in HMS. Check HMS yourself."],
    [
      'refused_flag_off',
      'Cancelling from here is switched off for now. Cancel it in HMS: open 57291630-1, Actions → Cancel Reservation.',
    ],
  ])('explains the %s preview result and keeps the preview button', async (outcome, message) => {
    capabilities.paneSave = true;
    const preview = vi.fn().mockResolvedValue(cancelRun({ outcome }));
    renderCancel({ preview });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Preview cancellation' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel booking in HMS' })).toBeNull();
  });

  it.each(['cancel_preview_required', 'cancel_digest_mismatch'])(
    'asks for a fresh preview when the commit comes back %s',
    async (outcome) => {
      capabilities.paneSave = true;
      const preview = vi.fn().mockResolvedValue(PREVIEW_OK);
      const commit = vi.fn().mockResolvedValue(cancelRun({ outcome }));
      renderCancel({ preview, commit });
      fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
      fireEvent.change(await screen.findByLabelText('Cancellation reason'), {
        target: { value: 'Duplicate Booking' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel booking in HMS' }));
      expect(await screen.findByText('Preview the cancellation again first.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Preview cancellation' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Cancel booking in HMS' })).toBeNull();
    },
  );

  it('asks for another reason when HMS does not accept the chosen one', async () => {
    capabilities.paneSave = true;
    const preview = vi.fn().mockResolvedValue(PREVIEW_OK);
    const commit = vi.fn().mockResolvedValue(cancelRun({ outcome: 'refused_reason_missing' }));
    renderCancel({ preview, commit });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    fireEvent.change(await screen.findByLabelText('Cancellation reason'), {
      target: { value: 'Duplicate Booking' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking in HMS' }));
    expect(await screen.findByText('HMS did not accept that reason. Pick another and try again.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Cancel booking in HMS' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Cancellation reason') as HTMLSelectElement).selectedIndex).toBe(0);
  });

  it('reports a failed preview call and leaves the preview button in place', async () => {
    capabilities.paneSave = true;
    const preview = vi.fn().mockRejectedValue(new Error('socket hang up'));
    renderCancel({ preview });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview cancellation' }));
    expect(await screen.findByText("Nava couldn't finish in HMS. Check HMS yourself.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Preview cancellation' })).toBeTruthy();
  });

});

describe('amend find helpers', () => {
  it('binds no client when the paneStayLookup routes are missing', () => {
    expect(amendFindClientFromTrpc({ workstation: {} })).toBeNull();
  });

  it('binds the find job route and screenshot to the paneStayLookup routes', async () => {
    const findStay = vi.fn().mockResolvedValue(NOT_FOUND);
    const shot = vi.fn().mockResolvedValue(NO_SHOT);
    const client = amendFindClientFromTrpc(lookupTrpc(findStay, shot));
    expect(client).not.toBeNull();
    const queued = await client?.queueFind({ threadId: THREAD, confirmation: CONFIRMATION });
    await client?.screenshot({ runId: RUN_ID, name: 'record.png' });
    expect(findStay).toHaveBeenCalledWith({ confirmation: CONFIRMATION });
    expect(queued?.runId).toBeTruthy();
    expect(shot).toHaveBeenCalledWith({ runId: RUN_ID, name: 'record.png' });
  });

  it('sends the confirmation number alone when the email gives no arrival', async () => {
    const findStay = vi.fn().mockResolvedValue(NOT_FOUND);
    const client: FindMock = { findStay, screenshot: vi.fn() };
    await runHmsFind({ client, confirmation: CONFIRMATION });
    expect(findStay).toHaveBeenCalledWith({ confirmation: CONFIRMATION });
  });

  it('sends the email arrival with the confirmation only when it is a real ISO day', async () => {
    const findStay = vi.fn().mockResolvedValue(NOT_FOUND);
    const client: FindMock = { findStay, screenshot: vi.fn() };
    await runHmsFind({ client, confirmation: CONFIRMATION, arrival: '2026-10-12' });
    expect(findStay).toHaveBeenLastCalledWith({ confirmation: CONFIRMATION, arrival: '2026-10-12' });
    await runHmsFind({ client, confirmation: CONFIRMATION, arrival: '2026-02-31' });
    expect(findStay).toHaveBeenLastCalledWith({ confirmation: CONFIRMATION });
  });

  it('says HMS shows another arrival when it refuses the record on arrival_mismatch', async () => {
    const mismatch: FindStayReply = {
      outcome: 'ambiguous',
      reason: 'arrival_mismatch',
      stay: null,
      screenshots: [],
      runId: null,
    };
    const client: FindMock = { findStay: vi.fn().mockResolvedValue(mismatch), screenshot: vi.fn() };
    const run = await runHmsFind({ client, confirmation: CONFIRMATION, arrival: '2026-10-12' });
    expect(run).toEqual({ kind: 'error', message: AMEND_FIND_COPY.arrivalDiffers });
  });

  it('never sends a number that is not an HMS booking number, and names the one it refused', async () => {
    const findStay = vi.fn().mockResolvedValue(NOT_FOUND);
    const client: FindMock = { findStay, screenshot: vi.fn() };
    await expect(runHmsFind({ client, confirmation: '9999SH999999' })).resolves.toEqual({
      kind: 'error',
      message: notHmsNumberNote('9999SH999999'),
    });
    await expect(runHmsFind({ client, confirmation: 'CEN-88412' })).resolves.toMatchObject({ kind: 'error' });
    expect(findStay).not.toHaveBeenCalled();
  });

  it('turns a rejected or empty find call into the plain lookup-failed copy', async () => {
    const rejecting: FindMock = { findStay: vi.fn().mockRejectedValue(new Error('boom')), screenshot: vi.fn() };
    await expect(runHmsFind({ client: rejecting, confirmation: CONFIRMATION })).resolves.toEqual({
      kind: 'error',
      message: AMEND_FIND_COPY.lookupFailed,
    });
    const empty: FindMock = {
      findStay: vi.fn().mockResolvedValue(undefined as unknown as FindStayReply),
      screenshot: vi.fn(),
    };
    await expect(runHmsFind({ client: empty, confirmation: CONFIRMATION })).resolves.toEqual({
      kind: 'error',
      message: AMEND_FIND_COPY.lookupFailed,
    });
  });

  it('reports unavailable when no client is bound', async () => {
    await expect(runHmsFind({ client: null, confirmation: CONFIRMATION })).resolves.toEqual({
      kind: 'error',
      message: AMEND_FIND_COPY.unavailable,
    });
  });

  it('names only the fields where the email and HMS disagree', () => {
    expect(amendDiffs(AMEND, stayRecord({ departure: '2026-10-13' }))).toEqual({ departure: '14 Oct 2026' });
    expect(amendDiffs(AMEND, stayRecord({ departure: '2026-10-14' }))).toEqual({});
    expect(
      amendDiffs(AMEND, stayRecord({ lastName: 'Smith', arrival: '2026-10-12', departure: '2026-10-14' })),
    ).toEqual({ guest: 'Mokoena' });
  });

  it('keeps the amendment on the session where the badge can read it', () => {
    expect(amendmentOf(sessionWith(CANCEL))?.kind).toBe('cancel');
    expect(amendmentOf(sessionWith(null))).toBeNull();
  });
});
