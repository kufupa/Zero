/**
 * @vitest-environment happy-dom
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import {
  CopyHmsNotesButton,
  hmsNotesBlock,
  readOneOff,
  readOverride,
  readSavedRateDraft,
  savedPrice,
  savedRatesFromTrpc,
  type SavedRate,
  type SavedRatesClient,
} from '../components/quote-workflow/rate-controls';
import { trackPaneAction } from '../lib/quote-workflow/pane-telemetry';
import { draftMoney } from '../lib/quote-workflow/multi-option-draft';
import { buildExpiredPriorRequoteBindArgs } from '../lib/quote-workflow/booking-draft-bind';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import {
  bindExecuteStaffQuote,
  readRowRates,
  rowPricesFor,
  type ExecuteStaffQuoteInput,
  type ExecuteStaffQuoteResult,
} from '../lib/quote-workflow/staff-quote-bind';
import {
  emptyStaffQuoteHeader,
  HRCEN_PROPERTY_CODE,
  type QuotePaneConfig,
  type QuoteSession,
  type RateOption,
  type RowPriceChoice,
  type StaffRowRate,
  type StayGroupRequirement,
} from '../lib/quote-workflow/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('../lib/quote-workflow/pane-telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/quote-workflow/pane-telemetry')>()),
  trackPaneAction: vi.fn(),
}));

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
});

const binding = {
  transportId: 't1',
  mailboxEmail: 'centurion@legacyhotels.co.za',
  storeId: 'store',
  folderEntryId: 'inbox',
  entryId: 'e1',
  selectionEpoch: 1,
  scopeEpoch: 1,
};
const source = { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) };
const stay: StayGroupRequirement = {
  id: 'g1',
  arrivalDate: '2026-11-12',
  departureDate: '2026-11-14',
  quantity: 1,
  adults: 2,
  childrenAges: [],
  roomPreference: 'STWN',
  board: 'bb',
  specialRequests: [],
  fields: {},
};
const READY: ExecuteStaffQuoteResult = {
  status: 'ready',
  workflowRunId: 'run-1',
  revisionRef: 'rev-1',
  messageId: 'mail-1',
  threadId: 'thread-1',
  factRefs: [],
  selectionEpoch: 1,
  inputRevision: 1,
  inputDigest: 'digest',
  totalMinor: 860000,
  currency: 'ZAR',
  arrivalDate: '2026-11-12',
  departureDate: '2026-11-14',
  description: 'STWN NCOR',
};
/** draftMoney uses a non-breaking space; the text matcher folds it to a plain space, so the expected text does too. */
function rand(minor: number): string {
  return draftMoney(minor).replace(/\s/g, ' ');
}

/** The approval note. Staff see it in the row's price box and never in the client documents. */
const NOTE = 'Thandi approved, group contract';
const SUMMER: SavedRate = { id: '6f1e2d3c-4b5a-4968-8a7b-9c0d1e2f3a4b', name: 'Standard summer', amountMinor: 185000 };
const SELECTED_RATE: RateOption = {
  id: 'o-ncor',
  groupId: 'g1',
  rateCode: 'NCOR',
  rateLabel: 'Corporate negotiated',
  roomCode: 'STWN',
  roomLabel: 'Standard Twin',
  board: 'bb',
  boardLabel: 'Bed & breakfast',
  contract: false,
  onlyContract: false,
  matchesRequest: true,
  perNightMinor: 215000,
  totalMinor: 430000,
  currency: 'ZAR',
  priced: 'full',
  selected: true,
};

function withSelectedRate(session: QuoteSession): QuoteSession {
  return session.rateOptions?.length ? session : { ...session, rateOptions: [SELECTED_RATE] };
}

/** A quote with one room row and its stay step, ready to price, as the pane has it after analysis. */
function readySession(): QuoteSession {
  let session = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding });
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: { intent: 'quote', groups: [stay], secondaryAsks: [], alternatives: [] },
  });
  return reduceQuoteSession(session, { type: 'staff_source_ready', source });
}

/** The row's stay step. A price change re-runs it. */
function stepOf(session: QuoteSession): string {
  const step = session.steps.find((item) => item.kind === 'quote_stay');
  if (!step) throw new Error('the quote has no stay step');
  return step.id;
}

/** The quote after HMS priced it. A row price is set before the run, as the pane sets it, and the run carries it. */
async function pricedSession(
  options: {
    rowPrice?: RowPriceChoice;
    rowRates?: StaffRowRate[];
    rateOptions?: RateOption[];
    specialRequests?: string[];
  } = {},
): Promise<QuoteSession> {
  let session = readySession();
  if (options.specialRequests) {
    session = reduceQuoteSession(session, {
      type: 'patch_group',
      groupId: 'g1',
      patch: { specialRequests: options.specialRequests },
    });
  }
  if (options.rowPrice) {
    session = reduceQuoteSession(session, { type: 'patch_group', groupId: 'g1', patch: { rowPrice: options.rowPrice } });
  }
  const run = await bindExecuteStaffQuote({
    mutate: async (input: ExecuteStaffQuoteInput) => ({
      ...READY,
      selectionEpoch: input.selectionEpoch,
      inputRevision: input.inputRevision,
      ...(options.rowRates ? { rowRates: options.rowRates } : {}),
      ...(options.rateOptions ? { rateOptions: options.rateOptions } : {}),
    }),
    source,
    selectionEpoch: 1,
    inputRevision: session.inputRevision,
    groups: session.groups,
    header: session.staffHeader,
    propertyCode: HRCEN_PROPERTY_CODE,
  });
  if (run.status !== 'ok') throw new Error(run.reason);
  return reduceQuoteSession(session, {
    type: 'staff_quote_ready',
    offer: run.offer,
    staffQuote: run.staffQuote,
    selectionEpoch: 1,
    inputRevision: session.inputRevision,
    approvedHeader: session.staffHeader,
  });
}

/** The panel with its session held in state and changed by the real reducer, so a price reaches the session before the re-run reads it. */
function PinnedPanel({
  initial,
  rates,
  runs,
  seen,
  paneConfig,
}: {
  initial: QuoteSession;
  rates?: SavedRatesClient | null;
  runs: string[];
  seen: { session: QuoteSession | null };
  paneConfig?: QuotePaneConfig | null;
}) {
  const [session, setSession] = useState(withSelectedRate(initial));
  seen.session = session;
  return (
    <QuoteWorkflowPanel
      paneConfig={paneConfig}
      session={session}
      rates={rates}
      onPatchGroup={(groupId, patch) =>
        setSession((current) => reduceQuoteSession(current, { type: 'patch_group', groupId, patch }))
      }
      onRunStep={(stepId) => {
        runs.push(stepId);
        setSession((current) => reduceQuoteSession(current, { type: 'step_running', stepId }));
      }}
    />
  );
}

/** Saved rates in memory, with the server's rules: one active name, and an archived rate leaves the list. */
function fakeRates(initial: SavedRate[]): SavedRatesClient {
  let rows = [...initial];
  return {
    list: vi.fn(async () => rows),
    create: vi.fn(async ({ name, amountMinor }: { name: string; amountMinor: number }) => {
      if (rows.some((rate) => rate.name === name)) {
        throw Object.assign(new Error('A saved rate with this name already exists'), { data: { code: 'CONFLICT' } });
      }
      const row = { id: `rate-${rows.length + 1}`, name, amountMinor, currency: 'ZAR' };
      rows = [...rows, row];
      return row;
    }),
    update: vi.fn(async ({ id, name, amountMinor }: { id: string; name: string; amountMinor: number }) => {
      const row = { id, name, amountMinor, currency: 'ZAR' };
      rows = rows.map((rate) => (rate.id === id ? row : rate));
      return row;
    }),
    archive: vi.fn(async (id: string) => {
      rows = rows.filter((rate) => rate.id !== id);
    }),
  };
}

describe('row price controls in the quote panel', () => {
  it('an override cannot be saved until it has a rate code, a rate per night and a note (AE4)', () => {
    const runs: string[] = [];
    const seen = { session: null as QuoteSession | null };
    const step = stepOf(readySession());
    render(<PinnedPanel initial={readySession()} runs={runs} seen={seen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Special price' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discount / override' }));
    const save = () => screen.getByRole('button', { name: 'Save override' }) as HTMLButtonElement;

    expect(save().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('HMS rate code'), { target: { value: 'NCOR1B' } });
    expect(save().disabled).toBe(true);
    expect(screen.getByText('Enter the override rate per night.')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Override rate per night (R)'), { target: { value: '1850' } });
    expect(save().disabled).toBe(true);
    expect(screen.getByText('Say who approved it and why.')).toBeDefined();

    fireEvent.change(screen.getByLabelText(/Authorised by/), { target: { value: NOTE } });
    expect(save().disabled).toBe(false);
    fireEvent.click(save());

    expect(runs).toEqual([step]);
    expect(seen.session!.groups[0]!.rowPrice).toEqual({
      source: 'override',
      rateCode: 'NCOR1B',
      amountMinor: 185000,
      note: NOTE,
    });
    expect(screen.getByText(`NCOR1B override, ${rand(185000)} a night`)).toBeDefined();
  });

  it('uses the active hotel override codes instead of Centurion-only choices', () => {
    const runs: string[] = [];
    const seen = { session: null as QuoteSession | null };
    render(
      <PinnedPanel
        initial={readySession()}
        runs={runs}
        seen={seen}
        paneConfig={{
          propertyCode: 'HRDAV',
          transportId: 'transport-davinci',
          roomTypes: [{ code: 'JNRSUI', label: 'Junior Suite' }],
          ratePlans: [],
          boards: ['room_only', 'bb'],
          salesStrategies: [],
          overrideRateCodes: ['BAR', 'BARRO', 'BLRB', 'BARDIS', 'DEF'],
          eventRateCodes: [],
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Special price' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discount / override' }));

    const rateCode = screen.getByLabelText('HMS rate code');
    expect([...rateCode.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Choose a rate code', 'BAR', 'BARRO', 'BLRB', 'BARDIS', 'DEF', 'Other',
    ]);
    expect([...rateCode.querySelectorAll('option')].map((option) => option.textContent)).not.toContain('NCOR1B');
  });

  it('a saved rate is picked from the list, and the stay re-runs', async () => {
    const rates = fakeRates([SUMMER]);
    const runs: string[] = [];
    const seen = { session: null as QuoteSession | null };
    const session = withSelectedRate(readySession());
    render(<PinnedPanel initial={session} rates={rates} runs={runs} seen={seen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Special price' }));
    const pickerElement = screen.getByLabelText('Saved rate for Standard Twin ×1');
    const picker = pickerElement as unknown as HTMLSelectElement;
    await waitFor(() => expect(within(pickerElement).getByRole('option', { name: /Standard summer/ })).toBeDefined());

    fireEvent.change(picker, { target: { value: SUMMER.id } });

    expect(runs).toEqual([stepOf(session)]);
    expect(seen.session!.groups[0]!.rowPrice).toEqual(savedPrice(SUMMER));
    expect(screen.getByText('Saved')).toBeDefined();
  });

  it('deleting a saved rate removes it from the picker, and a row on it goes back to the HMS rate', async () => {
    const rates = fakeRates([SUMMER]);
    const runs: string[] = [];
    const seen = { session: null as QuoteSession | null };
    const session = reduceQuoteSession(readySession(), {
      type: 'patch_group',
      groupId: 'g1',
      patch: { rowPrice: savedPrice(SUMMER) },
    });
    render(<PinnedPanel initial={session} rates={rates} runs={runs} seen={seen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Special price' }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage saved rates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Standard summer' }));

    await waitFor(() => expect(rates.archive).toHaveBeenCalledWith(SUMMER.id));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('back on the HMS rate')));
    expect(seen.session!.groups[0]!.rowPrice).toBeUndefined();
    expect(runs).toEqual([stepOf(session)]);
    const after = screen.getByLabelText('Saved rate for Standard Twin ×1');
    await waitFor(() => expect(within(after).queryByRole('option', { name: /Standard summer/ })).toBeNull());
  });

  it('a saved price stays changeable when no rate card is shown, so an archived rate can be replaced or removed', () => {
    const session = reduceQuoteSession(readySession(), {
      type: 'patch_group',
      groupId: 'g1',
      patch: { rowPrice: savedPrice(SUMMER) },
    });
    // No rate card at all. PinnedPanel would add a selected one, so the panel renders directly here.
    render(<QuoteWorkflowPanel session={{ ...session, rateOptions: [] }} rates={fakeRates([])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Special price' }));
    expect(screen.getByRole('button', { name: 'Manage saved rates' })).toBeDefined();
  });

  it('a mailbox switch reloads the saved rates, and the old mailbox\'s list never comes back', async () => {
    const WINTER: SavedRate = { id: '7a1e2d3c-4b5a-4968-8a7b-9c0d1e2f3a4b', name: 'Other mailbox winter', amountMinor: 99000 };
    let mailbox = 't1';
    const rates = fakeRates([SUMMER]);
    vi.mocked(rates.list).mockImplementation(async () => (mailbox === 't1' ? [SUMMER] : [WINTER]));
    const session = withSelectedRate(readySession());
    const { rerender } = render(<QuoteWorkflowPanel session={session} rates={rates} />);
    fireEvent.click(screen.getByRole('button', { name: 'Special price' }));
    await waitFor(() =>
      expect(within(screen.getByLabelText('Saved rate for Standard Twin ×1')).getByRole('option', { name: /Standard summer/ })).toBeDefined(),
    );

    // The pane stays mounted; the binding moves to the other mailbox's transport.
    mailbox = 't2';
    rerender(<QuoteWorkflowPanel session={{ ...session, binding: { ...session.binding!, transportId: 't2' } }} rates={rates} />);
    await waitFor(() =>
      expect(within(screen.getByLabelText('Saved rate for Standard Twin ×1')).getByRole('option', { name: /Other mailbox winter/ })).toBeDefined(),
    );
    expect(within(screen.getByLabelText('Saved rate for Standard Twin ×1')).queryByRole('option', { name: /Standard summer/ })).toBeNull();
  });

  it('a duplicate saved rate name is refused with a clear message', async () => {
    const rates = fakeRates([SUMMER]);
    render(<PinnedPanel initial={readySession()} rates={rates} runs={[]} seen={{ session: null }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Special price' }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage saved rates' }));
    fireEvent.change(screen.getByLabelText('New saved rate name'), { target: { value: 'Standard summer' } });
    fireEvent.change(screen.getByLabelText('New saved rate per night (R)'), { target: { value: '1900' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add saved rate' }));

    expect(await screen.findByText('That name is already a saved rate. Use another name.')).toBeDefined();
    expect(rates.create).toHaveBeenCalledTimes(1);
  });

  it('a typed one-off rate shows the One-off chip, and the stay re-runs for the total', () => {
    const runs: string[] = [];
    const seen = { session: null as QuoteSession | null };
    const session = readySession();
    render(<PinnedPanel initial={session} runs={runs} seen={seen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Special price' }));
    fireEvent.click(screen.getByRole('button', { name: 'Type a rate' }));
    fireEvent.change(screen.getByLabelText('Rate per night (R)'), { target: { value: '1,200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this rate' }));

    expect(runs).toEqual([stepOf(session)]);
    expect(seen.session!.groups[0]!.rowPrice).toEqual({ source: 'one_off', amountMinor: 120000 });
    expect(screen.getByText('One-off')).toBeDefined();
    expect(screen.getByText('Updating the total from HMS…')).toBeDefined();
  });

  it('copies the HMS comment of an override row, with a toast', async () => {
    const hmsComment = `Rate override NCOR1B R1850.00 per night: ${NOTE}`;
    const session = await pricedSession({
      rowPrice: { source: 'override', rateCode: 'NCOR1B', amountMinor: 185000, note: NOTE },
      rowRates: [
        {
          groupId: 'g1',
          source: 'override',
          hmsNightlyMinor: [215000],
          nightlyMinor: [185000],
          rateCode: 'NCOR1B',
          note: NOTE,
          hmsComment,
        },
      ],
    });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<QuoteWorkflowPanel session={withSelectedRate(session)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy for HMS comments' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(hmsComment));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('HMS comment copied. Paste it into HMS.'));
  });

  it('the client reply and documents never show the approval note', async () => {
    const session = await pricedSession({
      rowPrice: { source: 'override', rateCode: 'NCOR1B', amountMinor: 185000, note: NOTE },
      rowRates: [
        {
          groupId: 'g1',
          source: 'override',
          hmsNightlyMinor: [215000],
          nightlyMinor: [185000],
          rateCode: 'NCOR1B',
          note: NOTE,
          hmsComment: `Rate override NCOR1B R1850.00 per night: ${NOTE}`,
        },
      ],
    });
    render(<QuoteWorkflowPanel session={withSelectedRate(session)} />);

    // Staff see the note in the row's price box.
    expect(screen.getByText(new RegExp(`Authorised by: ${NOTE}`))).toBeDefined();
    // The documents are what the client gets: the reply preview, PDF and Excel.
    const documents = screen.getByRole('region', { name: 'Documents' });
    expect(within(documents).queryByText(new RegExp(NOTE))).toBeNull();
    expect(JSON.stringify(session.staffHeader)).not.toContain(NOTE);
    expect(session.reviewedReplyHtml ?? '').not.toContain(NOTE);
  });

  it('the price controls are real buttons with aria-expanded, and focus moves into a form that opens', () => {
    render(<PinnedPanel initial={readySession()} runs={[]} seen={{ session: null }} />);
    const toggle = screen.getByRole('button', { name: 'Special price' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const typeRate = screen.getByRole('button', { name: 'Type a rate' });
    expect(typeRate.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(typeRate);
    expect(typeRate.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('Rate per night (R)'));
  });

  it('the quote request carries the override as rowPrices, with its note', async () => {
    const mutate = vi.fn(async (input: ExecuteStaffQuoteInput) => ({
      ...READY,
      selectionEpoch: input.selectionEpoch,
      inputRevision: input.inputRevision,
    }));
    await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [{ ...stay, rowPrice: { source: 'override', rateCode: 'NCOR1B', amountMinor: 185000, note: NOTE } }],
      header: emptyStaffQuoteHeader(),
      propertyCode: HRCEN_PROPERTY_CODE,
    });
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        rowPrices: [{ groupId: 'g1', source: 'override', rateCode: 'NCOR1B', overrideRate: 185000, note: NOTE }],
      }),
    );
  });
});

describe('row price changes that race or replace each other', () => {
  /** An HMS rate option for g1. */
  function option(id: string, rateCode: string, selected: boolean): RateOption {
    return {
      id,
      groupId: 'g1',
      board: 'bb',
      boardLabel: 'Bed & breakfast',
      rateCode,
      rateLabel: rateCode,
      roomCode: 'STWN',
      roomLabel: 'Standard Twin',
      contract: false,
      onlyContract: false,
      matchesRequest: true,
      perNightMinor: 215000,
      totalMinor: 430000,
      currency: 'ZAR',
      priced: 'full',
      selected,
    };
  }

  it('picking an HMS rate card returns a priced row to the HMS rate, so the run charges the card', async () => {
    const runs: string[] = [];
    const seen = { session: null as QuoteSession | null };
    const session = await pricedSession({
      rowPrice: { source: 'one_off', amountMinor: 120000 },
      rateOptions: [option('o-ncor', 'NCOR', true), option('o-bar', 'BAR', false)],
    });
    render(<PinnedPanel initial={session} runs={runs} seen={seen} />);
    const cards = within(screen.getByRole('group', { name: 'Room rates from HMS' }))
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-pressed'));
    fireEvent.click(cards[1]!);

    expect(seen.session!.groups[0]!.rateCode).toBe('BAR');
    expect(seen.session!.groups[0]!.rowPrice).toBeUndefined();
    expect(rowPricesFor(seen.session!.groups)).toEqual([]);
    expect(runs).toEqual([stepOf(session)]);
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('back on the HMS rate'));
  });

  it('a saved-rate edit that lands after the row moved to a typed rate keeps the typed rate', async () => {
    let finishUpdate: (() => void) | undefined;
    const rates = fakeRates([SUMMER]);
    const update = rates.update;
    rates.update = vi.fn(
      (input: { id: string; name: string; amountMinor: number }) =>
        new Promise<SavedRate>((resolve) => {
          finishUpdate = () => void update(input).then(resolve);
        }),
    );
    const runs: string[] = [];
    const seen = { session: null as QuoteSession | null };
    const session = reduceQuoteSession(readySession(), {
      type: 'patch_group',
      groupId: 'g1',
      patch: { rowPrice: savedPrice(SUMMER) },
    });
    render(<PinnedPanel initial={session} rates={rates} runs={runs} seen={seen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Special price' }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage saved rates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Standard summer' }));
    fireEvent.change(screen.getByLabelText('Saved rate per night (R)'), { target: { value: '1,900' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rates.update).toHaveBeenCalled());
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Type a rate' }));
    fireEvent.change(screen.getByLabelText('Rate per night (R)'), { target: { value: '1,200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this rate' }));
    expect(seen.session!.groups[0]!.rowPrice).toEqual({ source: 'one_off', amountMinor: 120000 });

    finishUpdate!();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
    expect(seen.session!.groups[0]!.rowPrice).toEqual({ source: 'one_off', amountMinor: 120000 });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('an expired re-quote asks for the row prices the stored quote was run with', () => {
    const { groups } = buildExpiredPriorRequoteBindArgs({
      stored: {
        groups: [{ id: 'stored-1', arrivalDate: stay.arrivalDate!, departureDate: stay.departureDate!, quantity: 1, adults: 2, childrenAges: [], board: 'bb' }],
        salesStrategy: 'BAR',
        company: '',
        agency: '',
        rowPrices: [{ groupId: 'stored-1', source: 'override', rateCode: 'NCOR1B', overrideRate: 185000, note: NOTE }],
      },
      sessionGroups: [stay],
      sessionHeader: emptyStaffQuoteHeader(),
      staffEdited: false,
    });
    expect(rowPricesFor(groups)).toEqual([
      { groupId: 'g1', source: 'override', rateCode: 'NCOR1B', overrideRate: 185000, note: NOTE },
    ]);
  });
});

describe('row price rules', () => {
  it('a duplicated row does not keep the price of the row it copies', () => {
    const priced = reduceQuoteSession(readySession(), {
      type: 'patch_group',
      groupId: 'g1',
      patch: { rowPrice: savedPrice(SUMMER) },
    });
    const next = reduceQuoteSession(priced, { type: 'duplicate_row', groupId: 'g1', token: 'copy1' });
    expect(next.groups).toHaveLength(2);
    expect(next.groups[0]!.rowPrice).toEqual(savedPrice(SUMMER));
    expect(next.groups[1]!.rowPrice).toBeUndefined();
  });

  it('maps each row price to its wire shape, and leaves an unpriced row out', () => {
    expect(
      rowPricesFor([
        { ...stay, id: 'a', rowPrice: savedPrice(SUMMER) },
        { ...stay, id: 'b', rowPrice: { source: 'one_off', amountMinor: 120000 } },
        { ...stay, id: 'c' },
      ]),
    ).toEqual([
      { groupId: 'a', source: 'saved', customRateId: SUMMER.id },
      { groupId: 'b', source: 'one_off', oneOffRate: 120000 },
    ]);
  });

  it('reads row rates from the server, and drops a row it cannot trust', () => {
    expect(
      readRowRates([
        {
          groupId: 'g1',
          source: 'override',
          hmsNightlyMinor: [215000],
          nightlyMinor: [185000],
          rateCode: 'NCOR1B',
          note: NOTE,
          hmsComment: 'x',
        },
        { groupId: 'g2', source: 'bogus', hmsNightlyMinor: [1], nightlyMinor: [1] },
        { groupId: 'g3', source: 'hms', hmsNightlyMinor: [1.5], nightlyMinor: [1] },
      ]),
    ).toEqual([
      {
        groupId: 'g1',
        source: 'override',
        hmsNightlyMinor: [215000],
        nightlyMinor: [185000],
        rateCode: 'NCOR1B',
        note: NOTE,
        hmsComment: 'x',
      },
    ]);
  });

  it('an override needs a rate code, a rate per night and a note', () => {
    expect(readOverride({ code: '', otherCode: '', rate: '1850', note: NOTE })).toMatchObject({ status: 'incomplete' });
    expect(readOverride({ code: 'NCOR1B', otherCode: '', rate: '', note: NOTE })).toMatchObject({
      status: 'incomplete',
    });
    expect(readOverride({ code: 'NCOR1B', otherCode: '', rate: '1850', note: '   ' })).toMatchObject({
      status: 'incomplete',
      message: 'Say who approved it and why.',
    });
    expect(readOverride({ code: 'OTHER', otherCode: 'bad code!', rate: '1850', note: NOTE })).toMatchObject({
      status: 'incomplete',
    });
    expect(readOverride({ code: 'OTHER', otherCode: 'xyz1', rate: '1,850', note: NOTE })).toEqual({
      status: 'ok',
      rateCode: 'XYZ1',
      amountMinor: 185000,
      note: NOTE,
    });
  });

  it('a one-off rate reads as rand, and says what is wrong with it', () => {
    expect(readOneOff('1,250.50')).toEqual({ status: 'ok', amountMinor: 125050 });
    expect(readOneOff('')).toMatchObject({ status: 'incomplete' });
    expect(readOneOff('0')).toMatchObject({ status: 'incomplete' });
  });

  it('a saved rate needs a name and an amount', () => {
    expect(readSavedRateDraft('  ', '100')).toMatchObject({ status: 'incomplete' });
    expect(readSavedRateDraft('Summer', '')).toMatchObject({ status: 'incomplete' });
    expect(readSavedRateDraft(' Summer ', '1,850')).toEqual({ status: 'ok', name: 'Summer', amountMinor: 185000 });
  });

  it('binds the saved-rate routes, and is null without them', () => {
    const mutate = vi.fn(async () => ({ id: 'x' }));
    const bound = savedRatesFromTrpc({
      rates: {
        list: { query: vi.fn(async () => [SUMMER]) },
        create: { mutate },
        update: { mutate },
        archive: { mutate },
      },
    });
    expect(bound).not.toBeNull();
    expect(savedRatesFromTrpc({})).toBeNull();
    expect(savedRatesFromTrpc(undefined)).toBeNull();
  });
});

describe('HMS notes block', () => {
  const CONTACT = { name: 'Jane Smith', company: 'Acme Travel', endClient: null, email: null, phone: null };

  it('writes every field once: booker and company, each room, then the confirmation number', () => {
    const block = hmsNotesBlock({
      booker: 'Jane Smith',
      company: 'Acme Travel',
      confirmations: ['57291630-1'],
      rooms: [
        {
          label: 'Room 1',
          specialRequests: ['Late check-in', 'Cot'],
          authorisedBy: NOTE,
          rate: { code: 'NCOR1B', label: 'Corporate rate', nightlyMinor: [185000], board: 'Bed & breakfast' },
        },
      ],
    });
    expect(block).toBe(
      [
        'Booker: Jane Smith',
        'Company: Acme Travel',
        'Special requests: Late check-in; Cot',
        `Discount authorised by: ${NOTE}`,
        'Rate: NCOR1B Corporate rate R1850.00 per night, Bed & breakfast',
        'Confirmation: 57291630-1',
      ].join('\n'),
    );
  });

  it('omits every line with no value, and says nothing for an empty read', () => {
    expect(
      hmsNotesBlock({
        booker: '  ',
        company: null,
        confirmations: [],
        rooms: [{ label: 'Room 1', specialRequests: ['', ' '], rate: { code: 'BAR', label: 'BAR', board: null } }],
      }),
    ).toBe('Rate: BAR');
    expect(hmsNotesBlock({ rooms: [{ label: 'Room 1' }] })).toBe('');
    expect(hmsNotesBlock({ booker: 'Jane Smith', rooms: [] })).toBe('Booker: Jane Smith');
  });

  it('heads each room of a multi-stay quote with its label, indents its lines, and skips a room with none', () => {
    const block = hmsNotesBlock({
      booker: 'Jane Smith',
      rooms: [
        { label: 'Stay 1 · Room 1', specialRequests: ['Cot'], rate: { code: 'NCOR1B', nightlyMinor: [185000], board: 'Room only' } },
        { label: 'Stay 2 · Room 1', rate: { nightlyMinor: [210000] } },
        { label: 'Stay 2 · Room 2' },
      ],
    });
    expect(block).toBe(
      [
        'Booker: Jane Smith',
        'Stay 1 · Room 1',
        '  Special requests: Cot',
        '  Rate: NCOR1B R1850.00 per night, Room only',
        'Stay 2 · Room 1',
        '  Rate: R2100.00 per night',
      ].join('\n'),
    );
  });

  it('copies the block from a quote item, with the stored read booker and company, and logs copy.hms_line', async () => {
    const session = await pricedSession({
      specialRequests: ['Late check-in'],
      rowPrice: { source: 'override', rateCode: 'NCOR1B', amountMinor: 185000, note: NOTE },
      rowRates: [
        {
          groupId: 'g1',
          source: 'override',
          hmsNightlyMinor: [215000],
          nightlyMinor: [185000],
          rateCode: 'NCOR1B',
          note: NOTE,
          hmsComment: `Rate override NCOR1B R1850.00 per night: ${NOTE}`,
        },
      ],
    });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<QuoteWorkflowPanel session={session} contact={CONTACT} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy for HMS notes' }));

    const expected = [
      'Booker: Jane Smith',
      'Company: Acme Travel',
      'Special requests: Late check-in',
      `Discount authorised by: ${NOTE}`,
      'Rate: NCOR1B R1850.00 per night, Bed & breakfast',
    ].join('\n');
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('HMS notes copied. Paste them into the HMS comments.'));
    expect(trackPaneAction).toHaveBeenCalledWith({ type: 'copy.hms_line', block: 'notes' });
  });

  it('lists the nights that differ, each with its date, and reads one amount as the rate per night', () => {
    expect(
      hmsNotesBlock({
        rooms: [
          {
            label: 'Room 1',
            rate: {
              code: 'NCOR1B',
              nightlyMinor: [10001, 50000, 50000],
              stay: { arrival: '2026-10-26', departure: '2026-10-29' },
              board: 'Room only',
            },
          },
        ],
      }),
    ).toBe('Rate: NCOR1B per night: 26 Oct R100.01; 27 Oct R500.00; 28 Oct R500.00, Room only');
    // The dates roll over the month end.
    expect(
      hmsNotesBlock({
        rooms: [{ label: 'Room 1', rate: { nightlyMinor: [10001, 20000, 30000], stay: { arrival: '2026-10-30', departure: '2026-11-02' } } }],
      }),
    ).toBe('Rate: per night: 30 Oct R100.01; 31 Oct R200.00; 1 Nov R300.00');
    expect(
      hmsNotesBlock({ rooms: [{ label: 'Room 1', rate: { code: 'BAR', nightlyMinor: [185000, 185000] } }] }),
    ).toBe('Rate: BAR R1850.00 per night');
  });

  it('gives the range and the total when the nights do not match the stay dates, or there is no stay', () => {
    expect(
      hmsNotesBlock({
        rooms: [
          {
            label: 'Room 1',
            rate: {
              code: 'NCOR1B',
              nightlyMinor: [10001, 50000, 50000],
              stay: { arrival: '2026-10-26', departure: '2026-10-28' },
            },
          },
        ],
      }),
    ).toBe('Rate: NCOR1B from R100.01 to R500.00 per night, total R1100.01');
    expect(hmsNotesBlock({ rooms: [{ label: 'Room 1', rate: { nightlyMinor: [10001, 50000] } }] })).toBe(
      'Rate: from R100.01 to R500.00 per night, total R600.01',
    );
  });

  it('the quote block lists the nights that differ, with their dates, not the first night as the rate', async () => {
    const session = await pricedSession({
      rowRates: [{ groupId: 'g1', source: 'hms', hmsNightlyMinor: [10001, 50000], nightlyMinor: [10001, 50000] }],
    });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<QuoteWorkflowPanel session={session} contact={CONTACT} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy for HMS notes' }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        ['Booker: Jane Smith', 'Company: Acme Travel', 'Rate: per night: 12 Nov R100.01; 13 Nov R500.00, Bed & breakfast'].join(
          '\n',
        ),
      ),
    );
  });

  it('shows the block in a read-only box when the copy fails, so staff can copy it by hand', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      configurable: true,
    });
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true });
    try {
      render(<CopyHmsNotesButton block={'Booker: Jane Smith\nRate: BAR'} />);
      expect(screen.queryByRole('textbox', { name: 'HMS notes' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Copy for HMS notes' }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't copy. Select the notes text and copy it."));
      const box = screen.getByRole('textbox', { name: 'HMS notes' }) as HTMLTextAreaElement;
      expect(box.value).toBe('Booker: Jane Smith\nRate: BAR');
      expect(box.readOnly).toBe(true);
      expect(trackPaneAction).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(document, 'execCommand');
    }
  });
});
