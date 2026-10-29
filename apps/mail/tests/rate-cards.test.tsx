/**
 * @vitest-environment happy-dom
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { CRICKET_RATE_HINT, projectBarGrid } from '../components/quote-workflow/rate-cards';
import { draftMoney } from '../lib/quote-workflow/multi-option-draft';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import {
  bindExecuteStaffQuote,
  readRateOptions,
  staffQuoteGroupsFromStay,
  type ExecuteStaffQuoteInput,
  type ExecuteStaffQuoteResult,
} from '../lib/quote-workflow/staff-quote-bind';
import {
  emptyStaffQuoteHeader,
  HRCEN_PROPERTY_CODE,
  type AvailabilityBoardRow,
  type QuoteSession,
  type RateOption,
  type StaffQuoteHeader,
  type StayGroupRequirement,
} from '../lib/quote-workflow/types';

afterEach(() => cleanup());

const STAY_KEY = '2026-11-12:2026-11-14';
const STEP_ID = `quote-stay-${STAY_KEY}`;
const GROUP_LABEL = 'Room rates from HMS';

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
  quantity: 2,
  adults: 2,
  childrenPerRoom: 0,
  childrenAges: [],
  roomPreference: 'STWN',
  sourcePreference: { roomType: 'STWN', board: 'bb' },
  board: 'bb',
  specialRequests: [],
  fields: {},
};
const READY: ExecuteStaffQuoteResult = {
  status: 'ready',
  propertyCode: HRCEN_PROPERTY_CODE,
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

function rate(overrides: Partial<RateOption> & Pick<RateOption, 'id' | 'rateCode'>): RateOption {
  return {
    groupId: 'g1',
    board: 'bb',
    boardLabel: 'Bed & breakfast',
    rateLabel: 'Best available rate',
    roomCode: 'STWN',
    roomLabel: 'Standard Twin',
    contract: false,
    onlyContract: false,
    matchesRequest: true,
    perNightMinor: 270000,
    totalMinor: 1080000,
    currency: 'ZAR',
    priced: 'full',
    selected: false,
    ...overrides,
  };
}

/** Server order is not price order: the quoted rate comes first, as HMS returned it. */
const NCOR = rate({
  id: 'o-ncor',
  rateCode: 'NCOR',
  rateLabel: 'Corporate negotiated',
  selected: true,
  perNightMinor: 215000,
  totalMinor: 860000,
});
const BAR = rate({ id: 'o-bar', rateCode: 'BAR', rateLabel: 'Best available rate' });
const BARRO = rate({
  id: 'o-barro',
  rateCode: 'BARRO',
  rateLabel: 'Best available, room only',
  board: 'room_only',
  boardLabel: 'Room only',
  matchesRequest: false,
  priced: 'summary',
  perNightMinor: 243000,
  totalMinor: 972000,
});

/** A quote run through the real reducers and bind, so the cards come from the path the pane uses. */
async function quotedSession(
  options: RateOption[] | undefined,
  header: Partial<StaffQuoteHeader> = {},
): Promise<QuoteSession> {
  let session = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding });
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: { intent: 'quote', groups: [stay], secondaryAsks: [], alternatives: [] },
  });
  session = reduceQuoteSession(session, { type: 'staff_source_ready', source });
  if (Object.keys(header).length) session = reduceQuoteSession(session, { type: 'patch_staff_header', header });
  const run = await bindExecuteStaffQuote({
    mutate: async (input) => ({
      ...READY,
      selectionEpoch: input.selectionEpoch,
      inputRevision: input.inputRevision,
      ...(options ? { rateOptions: options } : {}),
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

/** The panel with the reducer behind it, so a pin reaches the session before the run that reads it. */
function PinnedPanel({
  initial,
  onRunStep,
  seen,
}: {
  initial: QuoteSession;
  onRunStep: (stepId: string) => void;
  seen: { session: QuoteSession | null };
}) {
  const [session, setSession] = useState(initial);
  seen.session = session;
  return (
    <QuoteWorkflowPanel
      session={session}
      onPatchGroup={(groupId, patch) =>
        setSession((current) => reduceQuoteSession(current, { type: 'patch_group', groupId, patch }))
      }
      onRunStep={(stepId) => {
        setSession((current) => reduceQuoteSession(current, { type: 'step_running', stepId }));
        onRunStep(stepId);
      }}
    />
  );
}

function rateCards(): HTMLButtonElement[] {
  const group = screen.getByRole('group', { name: GROUP_LABEL });
  return (within(group).getAllByRole('button') as HTMLButtonElement[]).filter((button) =>
    button.hasAttribute('aria-pressed'),
  );
}

function rateCodeLabel(card: HTMLButtonElement, code: string): HTMLSpanElement | undefined {
  return [...card.querySelectorAll('span')].find((span) => span.textContent?.trim() === code);
}

/** draftMoney uses a non-breaking space; the text matcher folds it to a plain space, so the expected text does too. */
function rand(minor: number): string {
  return draftMoney(minor).replace(/\s/g, ' ');
}

describe('rate cards in the quote panel', () => {
  it('renders the options in the order HMS sent, with the quoted one marked selected', async () => {
    render(<QuoteWorkflowPanel session={await quotedSession([NCOR, BAR, BARRO])} />);
    const cards = rateCards();
    expect(cards.map((card, index) => rateCodeLabel(card, ['NCOR', 'BAR', 'BARRO'][index]!)?.textContent?.trim())).toEqual([
      'NCOR',
      'BAR',
      'BARRO',
    ]);
    expect(cards.map((card) => card.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(within(cards[0]!).getByText('Selected')).toBeDefined();
    // The offer card stays under the cards. It holds the select toggle and the HMS restrictions.
    expect(screen.getByText(/Counted in the total/)).toBeDefined();
  });

  it('keeps the nightly price on one line and marks summary pricing as "from"', async () => {
    render(<QuoteWorkflowPanel session={await quotedSession([NCOR, BAR, BARRO])} />);
    const cards = rateCards();
    expect(within(cards[0]!).getByText(`${rand(215000)} avg / room / night`)).toBeDefined();
    expect(within(cards[2]!).getByText(`from ${rand(243000)} avg / room / night`)).toBeDefined();
    expect(within(cards[2]!).queryByText(/Total/)).toBeNull();
  });

  it('shows rooms left beside the price without hiding options', async () => {
    render(
      <QuoteWorkflowPanel
        session={await quotedSession([
          rate({ ...NCOR, roomsLeft: 5 }),
          rate({ ...BAR, roomsLeft: 2 }),
          BARRO,
        ])}
      />,
    );
    const cards = rateCards();
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).getByText('5 left').className).toMatch(/text-\[#64748b\]/);
    expect(within(cards[1]!).getByText('Only 2 left').className).toMatch(/text-amber/);
    expect(within(cards[2]!).queryByText(/left/)).toBeNull();
  });

  it('shows two room types on the same rate in the BAR grid, including an unpriced row as not checked', async () => {
    const board: AvailabilityBoardRow[] = [
      {
        groupId: 'g1',
        roomCode: 'STWN',
        roomLabel: 'Standard Twin',
        rateCode: 'BAR',
        rateLabel: 'Best available rate',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: BAR.perNightMinor,
        roomsLeft: 3,
      },
      {
        groupId: 'g1',
        roomCode: 'STQN',
        roomLabel: 'Standard Queen',
        rateCode: 'BAR',
        rateLabel: 'Best available rate',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: null,
        roomsLeft: null,
      },
    ];
    expect(projectBarGrid(board).map((cell) => cell.roomCode)).toEqual(['STWN', 'STQN']);
    const oneAdult = { ...board[0]!, groupId: 'g-1ad', nightlyPriceMinor: 100_000 };
    const twoAdult = { ...board[0]!, groupId: 'g-2ad', nightlyPriceMinor: 150_000 };
    expect(projectBarGrid([oneAdult, twoAdult]).map((cell) => cell.nightlyPriceMinor)).toEqual([100_000, 150_000]);
    const session = await quotedSession([BAR]);
    const quoted = session.staffQuote ?? session.staffQuotes[STAY_KEY];
    const withBoard: QuoteSession = {
      ...session,
      staffQuote: quoted ? { ...quoted, availabilityBoard: board } : quoted,
      staffQuotes: quoted
        ? { ...session.staffQuotes, [STAY_KEY]: { ...quoted, availabilityBoard: board } }
        : session.staffQuotes,
    };
    render(<QuoteWorkflowPanel session={withBoard} />);
    const grid = screen.getByRole('group', { name: 'Room, rate and board choices' });
    expect(within(grid).getByText('Standard Twin (STWN)')).toBeDefined();
    expect(within(grid).getByText('Standard Queen (STQN)')).toBeDefined();
    expect(within(grid).getAllByText(/Not checked/).length).toBeGreaterThan(0);
    expect(screen.getByText('Public rates — contract not checked')).toBeDefined();
    expect(within(grid).getAllByText('Public').length).toBe(2);
    expect(within(grid).queryByText('Contract')).toBeNull();
    expect(rateCards()).toHaveLength(1);
  });

  it('tags contract and government from the existing read, and never invents a contract tag from a public code', async () => {
    const board: AvailabilityBoardRow[] = [
      {
        groupId: 'g1',
        roomCode: 'STWN',
        roomLabel: 'Standard Twin',
        rateCode: 'NCOR',
        rateLabel: 'Corporate negotiated',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: NCOR.perNightMinor,
        roomsLeft: 3,
        rateScope: 'contextual',
      },
      {
        groupId: 'g1',
        roomCode: 'STWN',
        roomLabel: 'Standard Twin',
        rateCode: 'BAR',
        rateLabel: 'Best available rate',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: BAR.perNightMinor,
        roomsLeft: 4,
        rateScope: 'public',
      },
      {
        groupId: 'g1',
        roomCode: 'STWN',
        roomLabel: 'Standard Twin',
        rateCode: 'NGOVB',
        rateLabel: 'Local Government Rate Breakfast',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: 190000,
        roomsLeft: 2,
      },
    ];
    const header = { parties: { company: { kind: 'company' as const, nativeId: 'C1', name: 'Provincial Treasury' } } };
    const session = await quotedSession(
      [{ ...NCOR, contract: true, onlyContract: true }, BAR],
      header,
    );
    const quoted = session.staffQuote ?? session.staffQuotes[STAY_KEY];
    const withBoard: QuoteSession = {
      ...session,
      staffQuote: quoted ? { ...quoted, availabilityBoard: board } : quoted,
      staffQuotes: quoted
        ? { ...session.staffQuotes, [STAY_KEY]: { ...quoted, availabilityBoard: board } }
        : session.staffQuotes,
    };
    render(
      <QuoteWorkflowPanel
        session={withBoard}
        rateCatalogue={[
          { code: 'NGOVB', name: 'Local Government Rate Breakfast', board: 'bed_breakfast', government: true },
        ]}
      />,
    );
    const grid = screen.getByRole('group', { name: 'Room, rate and board choices' });
    expect(screen.queryByText('Public rates — contract not checked')).toBeNull();
    expect(within(grid).getByText('Contract')).toBeDefined();
    expect(within(grid).getByText('Public')).toBeDefined();
    expect(within(grid).getByText('Government')).toBeDefined();
  });

  it('does not invent a contract tag from a public rate code when the party read did not run', async () => {
    const board: AvailabilityBoardRow[] = [
      {
        groupId: 'g1',
        roomCode: 'STWN',
        roomLabel: 'Standard Twin',
        rateCode: 'NCOR',
        rateLabel: 'Corporate negotiated',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: NCOR.perNightMinor,
        roomsLeft: 3,
      },
    ];
    const session = await quotedSession([NCOR]);
    const quoted = session.staffQuote ?? session.staffQuotes[STAY_KEY];
    const withBoard: QuoteSession = {
      ...session,
      staffQuote: quoted ? { ...quoted, availabilityBoard: board } : quoted,
      staffQuotes: quoted
        ? { ...session.staffQuotes, [STAY_KEY]: { ...quoted, availabilityBoard: board } }
        : session.staffQuotes,
    };
    render(
      <QuoteWorkflowPanel
        session={withBoard}
        rateCatalogue={[{ code: 'NCOR', name: 'Corporate negotiated', board: 'bed_breakfast', contract: true }]}
      />,
    );
    const grid = screen.getByRole('group', { name: 'Room, rate and board choices' });
    expect(screen.getByText('Public rates — contract not checked')).toBeDefined();
    expect(within(grid).queryByText('Contract')).toBeNull();
  });

  it('tags a contextual board row with no matching rate card, and not when the party read did not run', async () => {
    const board: AvailabilityBoardRow[] = [
      {
        groupId: 'g1',
        roomCode: 'STWN',
        roomLabel: 'Standard Twin',
        rateCode: 'BCO1B',
        rateLabel: 'Negotiated',
        board: 'bb',
        boardLabel: 'Bed & breakfast',
        nightlyPriceMinor: null,
        roomsLeft: null,
        rateScope: 'contextual',
      },
    ];
    expect(projectBarGrid(board).map((cell) => cell.rateScope)).toEqual(['contextual']);

    const header = { parties: { company: { kind: 'company' as const, nativeId: 'C1', name: 'Provincial Treasury' } } };
    const withParty = await quotedSession([BAR], header);
    const quoted = withParty.staffQuote ?? withParty.staffQuotes[STAY_KEY];
    const partySession: QuoteSession = {
      ...withParty,
      staffQuote: quoted ? { ...quoted, availabilityBoard: board } : quoted,
      staffQuotes: quoted
        ? { ...withParty.staffQuotes, [STAY_KEY]: { ...quoted, availabilityBoard: board } }
        : withParty.staffQuotes,
    };
    const { unmount } = render(<QuoteWorkflowPanel session={partySession} />);
    const grid = screen.getByRole('group', { name: 'Room, rate and board choices' });
    expect(screen.queryByText('Public rates — contract not checked')).toBeNull();
    expect(within(grid).getByText('Contract')).toBeDefined();
    expect(within(grid).getByRole('button', { name: /Negotiated \(BCO1B\)/ })).toBeDefined();
    expect(rateCards().some((card) => card.textContent?.includes('BCO1B'))).toBe(false);
    unmount();

    const noParty = await quotedSession([BAR]);
    const noPartyQuoted = noParty.staffQuote ?? noParty.staffQuotes[STAY_KEY];
    const noPartySession: QuoteSession = {
      ...noParty,
      staffQuote: noPartyQuoted ? { ...noPartyQuoted, availabilityBoard: board } : noPartyQuoted,
      staffQuotes: noPartyQuoted
        ? { ...noParty.staffQuotes, [STAY_KEY]: { ...noPartyQuoted, availabilityBoard: board } }
        : noParty.staffQuotes,
    };
    render(<QuoteWorkflowPanel session={noPartySession} />);
    const publicGrid = screen.getByRole('group', { name: 'Room, rate and board choices' });
    expect(screen.getByText('Public rates — contract not checked')).toBeDefined();
    expect(within(publicGrid).queryByText('Contract')).toBeNull();
  });

  it('keeps board rateScope through the staff quote bind', async () => {
    const run = await bindExecuteStaffQuote({
      mutate: async (input) => ({
        ...READY,
        selectionEpoch: input.selectionEpoch,
        inputRevision: input.inputRevision,
        rateOptions: [BAR],
        availabilityBoard: [
          {
            groupId: 'g1',
            roomCode: 'STWN',
            roomLabel: 'Standard Twin',
            rateCode: 'BCO1B',
            rateLabel: 'Negotiated',
            board: 'bb',
            boardLabel: 'Bed & breakfast',
            nightlyPriceMinor: null,
            roomsLeft: null,
            rateScope: 'contextual',
          },
        ],
      }),
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [stay],
      header: emptyStaffQuoteHeader(),
      propertyCode: HRCEN_PROPERTY_CODE,
    });
    expect(run.status).toBe('ok');
    if (run.status !== 'ok') return;
    expect(run.staffQuote.availabilityBoard?.[0]?.rateScope).toBe('contextual');
  });

  it('omits roomCodes when no room preference is set and still refuses garbage codes', async () => {
    const blank: StayGroupRequirement = {
      ...stay,
      roomPreference: '',
      roomCodes: [],
      roomTypeCode: 'STQN',
    };
    const empty = staffQuoteGroupsFromStay([blank]);
    expect(empty).toEqual({
      ok: [expect.objectContaining({ id: 'g1', arrivalDate: stay.arrivalDate, departureDate: stay.departureDate })],
    });
    if (empty && 'ok' in empty) expect(empty.ok[0]).not.toHaveProperty('roomCodes');

    const mutate = vi.fn(async (input: ExecuteStaffQuoteInput) => ({
      ...READY,
      selectionEpoch: input.selectionEpoch,
      inputRevision: input.inputRevision,
    }));
    const run = await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [blank],
      header: emptyStaffQuoteHeader(),
      propertyCode: HRCEN_PROPERTY_CODE,
    });
    expect(run.status).toBe('ok');
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ maxOptionsPerGroup: 200 }));
    expect(mutate.mock.calls[0]?.[0].groups[0]).not.toHaveProperty('roomCodes');

    const garbage = staffQuoteGroupsFromStay([{ ...stay, roomPreference: 'PENTHOUSE', roomCodes: undefined, fields: {} }]);
    expect(garbage).toEqual({
      error: expect.stringMatching(/Not in this hotel's room list/),
    });
  });

  it('uses two compact card rows so the title can wrap without squeezing the price at narrow widths', async () => {
    render(<QuoteWorkflowPanel session={await quotedSession([NCOR, BAR])} />);
    const card = rateCards()[0]!;
    const title = card.querySelector('.line-clamp-2');
    const titleText = title?.textContent ?? '';
    const code = rateCodeLabel(card, 'NCOR');
    const price = within(card).getByText(`${rand(215000)} avg / room / night`);
    expect(titleText.indexOf('Corporate negotiated')).toBeLessThan(titleText.indexOf('NCOR'));
    expect(code).toBeDefined();
    expect(code?.className).toMatch(/text-\[11px\]/);
    expect(title?.className).toMatch(/line-clamp-2/);
    expect(price.className).toMatch(/whitespace-nowrap/);
    expect(within(card).getByText('Bed & breakfast · Standard Twin')).toBeDefined();
    expect(within(card).getByText('Selected')).toBeDefined();
  });

  it('shows plain labels and omits the separator when the room label is empty', async () => {
    const encoded = rate({
      id: 'o-encoded-label',
      rateCode: 'bb',
      rateLabel: 'Bed &amp; Breakfast',
      boardLabel: 'Bed &amp; Breakfast',
      roomLabel: '',
    });
    render(<QuoteWorkflowPanel session={await quotedSession([encoded])} />);

    const card = rateCards()[0]!;
    const title = card.querySelector('.line-clamp-2');
    const code = rateCodeLabel(card, 'bb');
    expect(title?.textContent).toBe('Bed & Breakfast bb');
    expect(code?.className).toMatch(/text-\[11px\]/);
    expect(card.textContent).not.toContain('&amp;');
    expect(card.textContent).not.toMatch(/Bed & Breakfast\s*·/);
    expect(card.textContent).not.toMatch(/·\s*·/);
  });

  it('keeps a restricted rate price struck through and gives its reason', async () => {
    render(<QuoteWorkflowPanel session={await quotedSession([{ ...NCOR, contract: true, onlyContract: true }])} />);
    const card = rateCards()[0]!;
    const price = within(card).getByText(`${rand(215000)} avg / room / night`);
    expect(price.className).toMatch(/line-through/);
    expect(within(card).getByText('Restricted — find a company or agency in HMS first')).toBeDefined();
  });

  it('shows Special price on the selected rate and saves its Authorised by note', async () => {
    const onPatchGroup = vi.fn();
    render(
      <QuoteWorkflowPanel
        session={await quotedSession([NCOR])}
        onPatchGroup={onPatchGroup}
      />,
    );
    expect(rateCards()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Special price' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discount / override' }));
    fireEvent.change(screen.getByLabelText('HMS rate code'), { target: { value: 'NCOR1B' } });
    fireEvent.change(screen.getByLabelText('Override rate per night (R)'), { target: { value: '1,250.50' } });
    fireEvent.change(screen.getByLabelText(/Authorised by/), {
      target: { value: 'A. Patel approved the seasonal rate' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save override' }));
    expect(onPatchGroup).toHaveBeenCalledWith('g1', {
      rowPrice: {
        source: 'override',
        rateCode: 'NCOR1B',
        amountMinor: 125_050,
        note: 'A. Patel approved the seasonal rate',
      },
    });
  });

  it('strikes through a contract-only rate when no HMS party is picked and gives the reason', async () => {
    render(<QuoteWorkflowPanel session={await quotedSession([{ ...NCOR, contract: true, onlyContract: true }])} />);
    const restricted = screen.getByText(/Restricted — find a company or agency in HMS first/);
    expect(restricted).toBeDefined();
    expect(rateCards()[0]?.disabled).toBe(true);
  });

  it('shows the contract badge only on contract rows, named after the picked party', async () => {
    const header = { parties: { company: { kind: 'company' as const, nativeId: 'C1', name: 'Provincial Treasury' } } };
    const contractNcor = { ...NCOR, contract: true, onlyContract: true };
    render(<QuoteWorkflowPanel session={await quotedSession([contractNcor, BAR, BARRO], header)} />);
    const cards = rateCards();
    expect(within(cards[0]!).getByText('Provincial Treasury contract')).toBeDefined();
    expect(within(cards[0]!).getByText('Selected')).toBeDefined();
    expect(within(cards[1]!).queryByText(/contract/)).toBeNull();
    expect(within(cards[2]!).queryByText(/contract/)).toBeNull();
  });

  it('does not say "only contract rate" when more than one row is a contract', async () => {
    const contractBar = { ...BAR, contract: true };
    render(<QuoteWorkflowPanel session={await quotedSession([{ ...NCOR, contract: true, onlyContract: false }, contractBar])} />);
    const cards = rateCards();
    expect(within(cards[0]!).getByText('Contract')).toBeDefined();
    expect(within(cards[1]!).getByText('Contract')).toBeDefined();
    expect(screen.queryByText('only contract rate')).toBeNull();
  });

  it('says "Not what they asked" only on a row that does not match the request', async () => {
    render(<QuoteWorkflowPanel session={await quotedSession([NCOR, BAR, BARRO])} />);
    const cards = rateCards();
    expect(within(cards[2]!).getByText('Not what they asked: Room only')).toBeDefined();
    expect(within(cards[0]!).queryByText(/Not what they asked/)).toBeNull();
    expect(within(cards[1]!).queryByText(/Not what they asked/)).toBeNull();
  });

  it('shows a single returned rate card and its specific-price control', async () => {
    render(<QuoteWorkflowPanel session={await quotedSession([NCOR])} />);
    expect(screen.getByRole('group', { name: GROUP_LABEL })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Special price' })).toBeDefined();
    expect(screen.getByText(/Counted in the total/)).toBeDefined();
  });

  it('keeps every rate code visible while the stay meal plan only highlights matching cards', async () => {
    render(<QuoteWorkflowPanel session={await quotedSession([NCOR, BAR, BARRO])} />);
    const mealPlan = screen.getByLabelText('Meal plan') as unknown as HTMLSelectElement;
    expect(mealPlan.value).toBe('bb');
    expect(rateCards()).toHaveLength(3);
    expect(screen.getAllByText('Meal plan match')).toHaveLength(2);

    fireEvent.change(mealPlan, { target: { value: 'room_only' } });

    expect((screen.getByLabelText('Meal plan') as unknown as HTMLSelectElement).value).toBe('room_only');
    expect(rateCards()).toHaveLength(3);
    expect(screen.getAllByText('Meal plan match')).toHaveLength(1);
    expect(within(rateCards()[2]!).getByText('Meal plan match')).toBeDefined();
  });

  it('does not crash when the server sends no rate options', async () => {
    const session = await quotedSession(undefined);
    expect(readRateOptions(undefined)).toEqual([]);
    const legacy: Partial<QuoteSession> = { ...session };
    delete legacy.rateOptions;
    render(<QuoteWorkflowPanel session={legacy as QuoteSession} />);
    expect(screen.queryByRole('group', { name: GROUP_LABEL })).toBeNull();
    expect(screen.getByText(/Counted in the total/)).toBeDefined();
  });

  it('keeps unknown HMS rate codes visible under All rates and uses the code when no label is supplied', async () => {
    const unknown = rate({ id: 'o-unseen', rateCode: 'UNSEEN9', rateLabel: '' });
    render(
      <QuoteWorkflowPanel
        session={await quotedSession([BAR, unknown])}
        rateCatalogue={[{ code: 'BAR', name: 'Best Available Rate', board: 'bed_breakfast' }] as never}
      />,
    );

    const select = screen.getByLabelText('Rate plan') as unknown as HTMLSelectElement;
    expect(select.value).toBe('all');
    expect([...select.options].map((option) => option.value)).toContain('UNSEEN9');
    const cards = rateCards();
    expect(cards.map((card, index) => rateCodeLabel(card, ['BAR', 'UNSEEN9'][index]!)?.textContent?.trim())).toEqual([
      'BAR',
      'UNSEEN9',
    ]);
    expect(cards[1]?.querySelector('.line-clamp-2')?.textContent).toBe('UNSEEN9 UNSEEN9');
  });

  it('tapping another option pins it and re-runs that date option with its board, room and rate', async () => {
    const onRunStep = vi.fn();
    const seen = { session: null as QuoteSession | null };
    const initial = await quotedSession([NCOR, BAR, BARRO]);
    render(<PinnedPanel initial={initial} onRunStep={onRunStep} seen={seen} />);
    fireEvent.click(rateCards()[2]!);
    await waitFor(() => expect(onRunStep).toHaveBeenCalledWith(STEP_ID));
    expect(seen.session?.groups[0]).toMatchObject({ board: 'room_only', roomCodes: ['STWN'], rateCode: 'BARRO' });
    expect(staffQuoteGroupsFromStay(seen.session?.groups ?? [])).toEqual({
      ok: [expect.objectContaining({ board: 'room_only', roomCodes: ['STWN'], rateCode: 'BARRO' })],
    });
  });

  it('while the pinned re-run is pending, the picked card loads and every card is disabled', async () => {
    const onRunStep = vi.fn();
    const initial = await quotedSession([NCOR, BAR, BARRO]);
    render(<PinnedPanel initial={initial} onRunStep={onRunStep} seen={{ session: null }} />);
    fireEvent.click(rateCards()[1]!);
    await waitFor(() => expect(onRunStep).toHaveBeenCalledWith(STEP_ID));
    const cards = rateCards();
    expect(cards.map((card) => card.disabled)).toEqual([true, true, true]);
    expect(cards[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Looking up in HMS — you can keep working').closest('[role="status"]')).not.toBeNull();
    expect(within(cards[1]!).queryByText('Getting rates from HMS…')).toBeNull();
  });
});

describe('rate pins in the session', () => {
  it('keeps the cards through a pick, and clears the pin when staff change the board, dates or room type', async () => {
    const session = await quotedSession([NCOR, BAR, BARRO]);
    const picked = reduceQuoteSession(session, {
      type: 'patch_group',
      groupId: 'g1',
      patch: { board: 'room_only', roomCodes: ['STWN'], rateCode: 'BARRO' },
    });
    expect(picked.groups[0]?.rateCode).toBe('BARRO');
    expect(picked.rateOptions).toHaveLength(3);
    const boardByHand = reduceQuoteSession(picked, { type: 'patch_group', groupId: 'g1', patch: { board: 'bb' } });
    expect(boardByHand.groups[0]?.rateCode).toBeUndefined();
    expect(boardByHand.rateOptions).toEqual([]);
    const datesByHand = reduceQuoteSession(picked, {
      type: 'patch_group',
      groupId: 'g1',
      patch: { departureDate: '2026-11-15' },
    });
    expect(datesByHand.groups[0]?.rateCode).toBeUndefined();
    const roomByHand = reduceQuoteSession(picked, {
      type: 'patch_group',
      groupId: 'g1',
      patch: { roomPreference: 'DLXTWN' },
    });
    expect(roomByHand.groups[0]?.rateCode).toBeUndefined();
  });

  it('keeps a pin through an edit that does not change what HMS prices', async () => {
    const session = await quotedSession([NCOR, BAR, BARRO]);
    const picked = reduceQuoteSession(session, {
      type: 'patch_group',
      groupId: 'g1',
      patch: { board: 'room_only', roomCodes: ['STWN'], rateCode: 'BARRO' },
    });
    const adults = reduceQuoteSession(picked, { type: 'patch_group', groupId: 'g1', patch: { adults: 1 } });
    expect(adults.groups[0]?.rateCode).toBe('BARRO');
  });
});

describe('the pinned rate on the execute request', () => {
  it('sends the pinned rate code with the board and room the pick set', async () => {
    const mutate = vi.fn(async (input: ExecuteStaffQuoteInput) => ({
      ...READY,
      selectionEpoch: input.selectionEpoch,
      inputRevision: input.inputRevision,
      rateOptions: [NCOR, BARRO],
    }));
    const result = await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [{ ...stay, board: 'room_only', rateCode: 'BARRO' }],
      header: emptyStaffQuoteHeader(),
      propertyCode: HRCEN_PROPERTY_CODE,
    });
    expect(result.status).toBe('ok');
    expect(mutate.mock.calls[0]?.[0].groups).toEqual([
      expect.objectContaining({ board: 'room_only', roomCodes: ['STWN'], rateCode: 'BARRO' }),
    ]);
    if (result.status === 'ok') expect(result.staffQuote.rateOptions).toHaveLength(2);
  });

  it('sends no rate code when nothing is pinned', async () => {
    const mutate = vi.fn(async (input: ExecuteStaffQuoteInput) => ({
      ...READY,
      selectionEpoch: input.selectionEpoch,
      inputRevision: input.inputRevision,
    }));
    const result = await bindExecuteStaffQuote({
      mutate,
      source,
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [stay],
      header: emptyStaffQuoteHeader(),
      propertyCode: HRCEN_PROPERTY_CODE,
    });
    expect(result.status).toBe('ok');
    expect(mutate.mock.calls[0]?.[0].groups[0]).not.toHaveProperty('rateCode');
    if (result.status === 'ok') expect(result.staffQuote).not.toHaveProperty('rateOptions');
  });

  it('keeps valid rooms-left values and omits invalid or legacy values', () => {
    const [withRooms, zero, legacy, negative, fractional, infinite, text] = readRateOptions([
      { ...NCOR, roomsLeft: 5 },
      { ...BAR, id: 'zero', roomsLeft: 0 },
      BAR,
      { ...BAR, id: 'negative', roomsLeft: -1 },
      { ...BAR, id: 'fractional', roomsLeft: 1.5 },
      { ...BAR, id: 'infinite', roomsLeft: Number.POSITIVE_INFINITY },
      { ...BAR, id: 'text', roomsLeft: '5' },
    ]);

    expect(withRooms).toMatchObject({ roomsLeft: 5 });
    expect(zero).toMatchObject({ roomsLeft: 0 });
    expect(legacy).not.toHaveProperty('roomsLeft');
    for (const option of [negative, fractional, infinite, text]) {
      expect(option).not.toHaveProperty('roomsLeft');
    }
  });

  it('keeps well-formed rate rows and drops the rest', () => {
    expect(readRateOptions([NCOR, { id: 'x' }, { ...BAR, board: 'brunch' }, 'nope'])).toEqual([NCOR]);
  });
});

describe('cricket event rates', () => {
  it('shows the cricket hint on GNC3B and GNC4B only, where HMS rate options list', async () => {
    const gnc3 = rate({ id: 'o-gnc3b', rateCode: 'GNC3B', rateLabel: 'Cricket event 3', hint: 'event_rate' });
    const gnc4 = rate({ id: 'o-gnc4b', rateCode: 'GNC4B', rateLabel: 'Cricket event 4', hint: 'event_rate' });
    render(<QuoteWorkflowPanel session={await quotedSession([NCOR, gnc3, gnc4])} />);
    const cards = rateCards();
    expect(within(cards[0]!).queryByText(CRICKET_RATE_HINT)).toBeNull();
    expect(within(cards[1]!).getByText(CRICKET_RATE_HINT)).toBeDefined();
    expect(within(cards[2]!).getByText(CRICKET_RATE_HINT)).toBeDefined();
  });

  it('keeps the event hint when the server rate options are read', () => {
    const [read] = readRateOptions([{ ...BAR, rateCode: 'GNC3B', hint: 'event_rate' }]);
    expect(read?.hint).toBe('event_rate');
    expect(readRateOptions([BAR])[0]?.hint).toBeUndefined();
  });
});

describe('HRDAV BAR grid labels', () => {
  it('keeps observed Da Vinci board labels and does not invent BB or DBB for a blank BARRO row', () => {
    const board: AvailabilityBoardRow[] = [
      {
        groupId: 'g1',
        roomCode: 'JNRSUI',
        roomLabel: 'Junior Suite',
        rateCode: 'BAR',
        rateLabel: 'Best Available Rate',
        board: 'bb',
        boardLabel: 'Bed & Breakfast NR',
        nightlyPriceMinor: 630_000,
        roomsLeft: 5,
      },
      {
        groupId: 'g1',
        roomCode: 'STWN',
        roomLabel: 'Standard Twin',
        rateCode: 'BARRO',
        rateLabel: 'Room Only BAR',
        board: '',
        boardLabel: '',
        nightlyPriceMinor: 528_000,
        roomsLeft: 28,
      },
    ];
    const cells = projectBarGrid(board);
    expect(cells[0]).toMatchObject({
      roomCode: 'JNRSUI',
      roomLabel: 'Junior Suite',
      boardLabel: 'Bed & Breakfast NR',
    });
    expect(cells[1]).toMatchObject({
      roomCode: 'STWN',
      rateCode: 'BARRO',
      board: '',
      boardLabel: '',
    });
    expect(cells[1]?.board).not.toBe('room_only');
    expect(cells[1]?.boardLabel).not.toMatch(/room only/i);
    expect(cells.map((cell) => cell.boardLabel).join(' ')).not.toMatch(/\b(?:DBB|BB)\b/);
  });
});
