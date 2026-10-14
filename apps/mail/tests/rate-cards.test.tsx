/**
 * @vitest-environment happy-dom
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
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
  return within(screen.getByRole('group', { name: GROUP_LABEL })).getAllByRole('button') as HTMLButtonElement[];
}

/** draftMoney uses a non-breaking space; the text matcher folds it to a plain space, so the expected text does too. */
function rand(minor: number): string {
  return draftMoney(minor).replace(/\s/g, ' ');
}

describe('rate cards in the quote panel', () => {
  it('renders the options in the order HMS sent, with the quoted one marked selected', async () => {
    render(<QuoteWorkflowPanel session={await quotedSession([NCOR, BAR, BARRO])} />);
    const cards = rateCards();
    expect(cards.map((card) => card.textContent?.split(':')[0])).toEqual(['NCOR', 'BAR', 'BARRO']);
    expect(cards.map((card) => card.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(within(cards[0]!).getByText('Selected')).toBeDefined();
    // The offer card stays under the cards. It holds the select toggle and the HMS restrictions.
    expect(screen.getByText(/Counted in the total/)).toBeDefined();
  });

  it('shows the price per night and the total, and "from" on an unselected summary price', async () => {
    render(<QuoteWorkflowPanel session={await quotedSession([NCOR, BAR, BARRO])} />);
    const cards = rateCards();
    expect(within(cards[0]!).getByText(`${rand(215000)} a night`)).toBeDefined();
    expect(within(cards[0]!).getByText(`Total ${rand(860000)}`)).toBeDefined();
    expect(within(cards[2]!).getByText(`from ${rand(243000)} a night`)).toBeDefined();
    expect(within(cards[2]!).getByText(`Total from ${rand(972000)}`)).toBeDefined();
  });

  it('shows the contract badge only on contract rows, named after the picked party', async () => {
    const header = { parties: { company: { kind: 'company' as const, nativeId: 'C1', name: 'Provincial Treasury' } } };
    const contractNcor = { ...NCOR, contract: true, onlyContract: true };
    render(<QuoteWorkflowPanel session={await quotedSession([contractNcor, BAR, BARRO], header)} />);
    const cards = rateCards();
    expect(within(cards[0]!).getByText('Provincial Treasury contract')).toBeDefined();
    expect(within(cards[0]!).getByText('only contract rate')).toBeDefined();
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

  it('shows no choice UI for a single option', async () => {
    render(<QuoteWorkflowPanel session={await quotedSession([NCOR])} />);
    expect(screen.queryByRole('group', { name: GROUP_LABEL })).toBeNull();
    expect(screen.getByText(/Counted in the total/)).toBeDefined();
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
    expect(within(cards[1]!).getByText('Getting rates from HMS…')).toBeDefined();
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
    });
    expect(result.status).toBe('ok');
    expect(mutate.mock.calls[0]?.[0].groups[0]).not.toHaveProperty('rateCode');
    if (result.status === 'ok') expect(result.staffQuote).not.toHaveProperty('rateOptions');
  });

  it('keeps well-formed rate rows and drops the rest', () => {
    expect(readRateOptions([NCOR, { id: 'x' }, { ...BAR, board: 'brunch' }, 'nope'])).toEqual([NCOR]);
  });
});
