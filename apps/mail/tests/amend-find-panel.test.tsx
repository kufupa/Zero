/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmendLookupPanel } from '../components/quote-workflow/amend-lookup-panel';
import {
  AMEND_FIND_COPY,
  amendDiffs,
  amendFindClientFromTrpc,
  amendSearchClientFromTrpc,
  hmsNumberFor,
  noSearchMatchCopy,
  notHmsNumberNote,
  runHmsFind,
  runHmsSearch,
  type AmendFindClient,
  type AmendSearchClient,
  type FindStayReply,
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

/** The paneStayLookup routes and the capability route, as the panel reads them off the tRPC client. */
function lookupTrpc(
  findStay: ReturnType<typeof vi.fn>,
  shot: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(NO_SHOT),
  searchGuest: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ outcome: 'ok', rows: [], screenshots: [], runId: null }),
) {
  return {
    paneStayLookup: {
      findStay: { mutate: findStay },
      screenshot: { query: shot },
      searchGuest: { mutate: searchGuest },
    },
    brain: { getCapabilities: { query: async () => ({ paneSave: capabilities.paneSave }) } },
  };
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
    expect(screen.getByText('Luna only looks the booking up. Make the change in HMS yourself.')).toBeTruthy();
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
    expect(screen.getByText('Luna is looking up the booking in HMS… (about 1–2 minutes)')).toBeTruthy();
    rerender(<AmendLookupPanel session={session} trpc={lookupTrpc(findStay)} />);
    expect(findStay).toHaveBeenCalledTimes(1);
  });

  it('shows the booking HMS returns and highlights the field that differs', async () => {
    const findStay = vi.fn().mockResolvedValue(found({ departure: '2026-10-13' }));
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await waitFor(() => expect(screen.getByText('Guest wants: 14 Oct 2026')).toBeTruthy());
    expect(screen.getByText(`confirmation number ${CONFIRMATION}`)).toBeTruthy();
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
    await waitFor(() => expect(screen.getByText('Matched on')).toBeTruthy());
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
    await waitFor(() => expect(screen.getByText('Matched on')).toBeTruthy());
    expect(screen.queryByText('Rate plan')).toBeNull();
    expect(screen.queryByText('Meal plan')).toBeNull();
    expect(screen.queryByText('Grand total')).toBeNull();
  });

  it('shows the booking record screenshot as a thumbnail that opens full size', async () => {
    const findStay = vi.fn().mockResolvedValue(found());
    const shot = vi.fn().mockResolvedValue({ status: 'ok', dataUrl: SHOT_PNG });
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay, shot)} />);
    pressFind();
    fireEvent.click(await screen.findByRole('button', { name: 'See the booking in HMS' }));
    expect(shot).toHaveBeenCalledWith({ runId: RUN_ID, name: 'record.png' });
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
      screen.getByText("Luna couldn't find a booking number in the email. Find the booking by guest name below."),
    ).toBeTruthy();
    expect(screen.getByText('No HMS booking number found in the email.')).toBeTruthy();
    expect(findStay).not.toHaveBeenCalled();
  });

  it.each([
    ['refused_lock_busy', 'HMS is busy with another quote or lookup. Try again in a minute.'],
    ['refused_lock_unavailable', "Luna can't reach HMS right now. Tell the Nava team."],
    ['refused_flag_off', 'The HMS lookup is not connected in this session. Search HMS by hand.'],
    ['refused_input_invalid', AMEND_FIND_COPY.notExact],
    ['execution_failure', 'Luna could not read the HMS result. Try again in a minute.'],
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
    await waitFor(() => expect(screen.getByText("Luna couldn't look this up. Search HMS yourself.")).toBeTruthy());
    expect(screen.queryByText(/invalid_string|socket hang up/)).toBeNull();
  });

  it('runs the find again when staff press the button after a failed result', async () => {
    const findStay = vi
      .fn()
      .mockResolvedValueOnce(refusal('execution_failure'))
      .mockResolvedValueOnce(found());
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(findStay)} />);
    pressFind();
    await screen.findByText('Luna could not read the HMS result. Try again in a minute.');
    fireEvent.click(screen.getByRole('button', { name: 'Find this booking in HMS' }));
    await waitFor(() => expect(screen.getByText('Matched on')).toBeTruthy());
    expect(findStay).toHaveBeenCalledTimes(2);
  });
});

describe('AmendLookupPanel guest-name search', () => {
  const NO_NUMBER: QuoteAmendment = { ...AMEND, confirmationNumber: null };
  const SEARCH_BUTTON = 'Search HMS (about 1 minute)';
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
    await waitFor(() => expect(screen.getByText('Matched on')).toBeTruthy());
    expect(findStay).toHaveBeenCalledWith({ confirmation: '46184891-1', arrival: '2026-10-12' });
    expect(screen.getByText('confirmation number 46184891-1')).toBeTruthy();
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

  it('reads a digits-only number as its first stay, and opens the name search when HMS does not know it', async () => {
    const findStay = vi.fn().mockResolvedValue(NOT_FOUND);
    render(
      <AmendLookupPanel session={sessionWith({ ...AMEND, confirmationNumber: '57291630' })} trpc={lookupTrpc(findStay)} />,
    );
    expect((screen.getByRole('button', { name: 'Find this booking in HMS' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('amend-guest-search')).toBeNull();
    pressFind();
    await waitFor(() => expect(findStay).toHaveBeenCalledWith({ confirmation: '57291630-1', arrival: '2026-10-12' }));
    await waitFor(() => expect(screen.getByTestId('amend-guest-search')).toBeTruthy());
    expect(
      screen.getByText(
        'No booking with that number in HMS. Check the number in the email or find the booking by guest name below.',
      ),
    ).toBeTruthy();
    expect((screen.getByLabelText('Guest surname') as HTMLInputElement).value).toBe('Mokoena');
  });

  it('finds a digits-only number as its first stay, the same as a dash number, and shows that booking', async () => {
    const findStay = vi.fn().mockResolvedValue(found());
    render(
      <AmendLookupPanel session={sessionWith({ ...AMEND, confirmationNumber: '57291630' })} trpc={lookupTrpc(findStay)} />,
    );
    pressFind();
    await waitFor(() => expect(screen.getByText('Matched on')).toBeTruthy());
    expect(findStay).toHaveBeenCalledWith({ confirmation: '57291630-1', arrival: '2026-10-12' });
    expect(screen.queryByTestId('amend-guest-search')).toBeNull();
  });
});

describe('guest-name search helpers', () => {
  it('reads a digits-only email number as its first stay, and takes a dash number as written', () => {
    expect(hmsNumberFor('57291630')).toBe('57291630-1');
    expect(hmsNumberFor(' 5729163012 ')).toBe('5729163012-1');
    expect(hmsNumberFor('57291630-2')).toBe('57291630-2');
    expect(hmsNumberFor('12345')).toBeNull();
    expect(hmsNumberFor('9999SH999999')).toBeNull();
    expect(hmsNumberFor(null)).toBeNull();
  });

  it('binds searchGuest to the paneStayLookup route only', async () => {
    expect(amendSearchClientFromTrpc({ paneStayLookup: { findStay: {} } })).toBeNull();
    const search = vi.fn().mockResolvedValue({ outcome: 'ok', rows: [], screenshots: [], runId: null });
    const client = amendSearchClientFromTrpc(lookupTrpc(vi.fn(), undefined, search));
    await client?.searchGuest({ lastName: 'Mokoena', arrival: '2026-10-12' });
    expect(search).toHaveBeenCalledWith({ lastName: 'Mokoena', arrival: '2026-10-12' });
  });

  it('sends a surname of 2 to 40 letters, spaces, apostrophes or hyphens and a real arrival, and nothing else', async () => {
    const search = vi.fn().mockResolvedValue({ outcome: 'ok', rows: [], screenshots: [], runId: null });
    const client: AmendSearchClient = { searchGuest: search };
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
    const client: AmendSearchClient = { searchGuest: search };
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

describe('AmendLookupPanel cancel from the pane', () => {
  it('says cancelling is switched off and gives the HMS steps when the pane save flag is off', async () => {
    const { preview } = renderCancel({});
    await waitFor(() =>
      expect(
        screen.getByText(
          'Cancelling from here is switched off for now. Cancel it in HMS: open 57291630-1, Actions → Cancel Reservation.',
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Preview cancellation' })).toBeNull();
    expect(preview).not.toHaveBeenCalled();
  });

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
        `Luna will cancel 57291630-1 for Thabo Mokoena. HMS says: ${PENALTY} This can't be undone from here.`,
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
    fireEvent.click(await screen.findByRole('button', { name: 'See what Luna saw in HMS' }));
    const dialog = screen.getByRole('dialog', { name: 'See what Luna saw in HMS' });
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
    fireEvent.click(screen.getByRole('button', { name: 'Search HMS (about 1 minute)' }));
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
  });

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
        "Luna will cancel 57291630-1 for Thabo Mokoena. HMS showed no cancellation fee. This can't be undone from here.",
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
    ['refused_lock_unavailable', "Luna can't reach HMS right now. Tell the Nava team."],
    ['execution_failure', "Luna couldn't finish in HMS. Check HMS yourself."],
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
    expect(await screen.findByText("Luna couldn't finish in HMS. Check HMS yourself.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Preview cancellation' })).toBeTruthy();
  });

  it('says Luna can preview, not only look up, when cancel mail can be previewed', async () => {
    capabilities.paneSave = true;
    renderCancel({});
    await screen.findByRole('button', { name: 'Preview cancellation' });
    expect(
      screen.getByText(
        'Luna can preview the cancellation for you. Nothing is cancelled until you press Cancel booking in HMS.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Luna only looks the booking up. Make the change in HMS yourself.')).toBeNull();
  });

  it('keeps the look-up footer on cancel mail when the pane save flag is off', async () => {
    renderCancel({});
    await screen.findByText(
      'Cancelling from here is switched off for now. Cancel it in HMS: open 57291630-1, Actions → Cancel Reservation.',
    );
    expect(screen.getByText('Luna only looks the booking up. Make the change in HMS yourself.')).toBeTruthy();
  });

  it('keeps the look-up footer on amend mail even when the pane save flag is on', () => {
    capabilities.paneSave = true;
    render(<AmendLookupPanel session={sessionWith(AMEND)} trpc={lookupTrpc(vi.fn(NEVER_SETTLES))} />);
    expect(screen.getByText('Luna only looks the booking up. Make the change in HMS yourself.')).toBeTruthy();
    expect(screen.queryByText(/Luna can preview the cancellation/)).toBeNull();
  });
});

describe('amend find helpers', () => {
  it('binds no client when the paneStayLookup routes are missing', () => {
    expect(amendFindClientFromTrpc({ workstation: {} })).toBeNull();
  });

  it('binds findStay and screenshot to the paneStayLookup routes', async () => {
    const findStay = vi.fn().mockResolvedValue(NOT_FOUND);
    const shot = vi.fn().mockResolvedValue(NO_SHOT);
    const client = amendFindClientFromTrpc(lookupTrpc(findStay, shot));
    expect(client).not.toBeNull();
    await client?.findStay({ confirmation: CONFIRMATION });
    await client?.screenshot({ runId: RUN_ID, name: 'record.png' });
    expect(findStay).toHaveBeenCalledWith({ confirmation: CONFIRMATION });
    expect(shot).toHaveBeenCalledWith({ runId: RUN_ID, name: 'record.png' });
  });

  it('sends the confirmation number alone when the email gives no arrival', async () => {
    const findStay = vi.fn().mockResolvedValue(NOT_FOUND);
    const client: AmendFindClient = { findStay, screenshot: vi.fn() };
    await runHmsFind({ client, confirmation: CONFIRMATION });
    expect(findStay).toHaveBeenCalledWith({ confirmation: CONFIRMATION });
  });

  it('sends the email arrival with the confirmation only when it is a real ISO day', async () => {
    const findStay = vi.fn().mockResolvedValue(NOT_FOUND);
    const client: AmendFindClient = { findStay, screenshot: vi.fn() };
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
    const client: AmendFindClient = { findStay: vi.fn().mockResolvedValue(mismatch), screenshot: vi.fn() };
    const run = await runHmsFind({ client, confirmation: CONFIRMATION, arrival: '2026-10-12' });
    expect(run).toEqual({ kind: 'error', message: AMEND_FIND_COPY.arrivalDiffers });
  });

  it('never sends a number that is not an HMS booking number, and names the one it refused', async () => {
    const findStay = vi.fn().mockResolvedValue(NOT_FOUND);
    const client: AmendFindClient = { findStay, screenshot: vi.fn() };
    await expect(runHmsFind({ client, confirmation: '9999SH999999' })).resolves.toEqual({
      kind: 'error',
      message: notHmsNumberNote('9999SH999999'),
    });
    await expect(runHmsFind({ client, confirmation: 'CEN-88412' })).resolves.toMatchObject({ kind: 'error' });
    expect(findStay).not.toHaveBeenCalled();
  });

  it('turns a rejected or empty find call into the plain lookup-failed copy', async () => {
    const rejecting: AmendFindClient = { findStay: vi.fn().mockRejectedValue(new Error('boom')), screenshot: vi.fn() };
    await expect(runHmsFind({ client: rejecting, confirmation: CONFIRMATION })).resolves.toEqual({
      kind: 'error',
      message: AMEND_FIND_COPY.lookupFailed,
    });
    const empty: AmendFindClient = {
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
