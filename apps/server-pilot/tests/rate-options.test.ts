import { describe, expect, it } from 'vitest';
import { buildRateOptions, otherBoardContractNotes, type RateOption } from '../src/ai/rate-options.js';
import type { NativeOption, QuoteSourceRecord } from '../src/quote-proposal/quote-revision.js';

const ARRIVAL = '2026-10-11';
const DEPARTURE = '2026-10-13';
const DATES = ['2026-10-11', '2026-10-12'];
const PARTY = { organization: { id: '49', name: 'Woolworths' } };

type Row = {
  id: string;
  room?: string;
  rate: string;
  board?: string;
  scope?: 'public' | 'contextual';
  match?: 'match' | 'alternative' | 'unresolved';
  availability?: string;
  eligibility?: string;
  held?: boolean;
  amount?: string;
  inventories?: Array<number | undefined>;
};

function row(r: Row): NativeOption {
  return {
    id: r.id,
    room: { code: r.room ?? 'SKNG', label: `${r.room ?? 'SKNG'} label`, buildingCode: 'MAIN' },
    rate: { code: r.rate, label: `${r.rate} label` },
    board: r.board ?? 'Room Only R',
    appliedContext: PARTY,
    rateScope: r.scope ?? 'public',
    eligibility: r.eligibility ?? 'verified',
    availability: r.availability ?? 'available',
    matchStatus: r.match ?? 'match',
    held: r.held ?? false,
    totals: { taxInclusive: true },
    nightly: DATES.map((date, index) => ({
      date,
      inventory: r.inventories ? (r.inventories[index] as number) : 8,
      price: { amount: r.amount ?? '500.00', currency: 'ZAR' },
    })),
  } as NativeOption;
}

/** One room group asking for `quantity` rooms of the given room code and board, under the party. */
function source(options: NativeOption[], ask: { roomCodes?: string[]; boardBases?: string[]; quantity?: number } = {}): QuoteSourceRecord {
  const room = {
    id: 'single',
    quantity: ask.quantity ?? 1,
    adults: 1,
    children: 0,
    childAges: [],
    required: {
      ...(ask.roomCodes ? { roomCodes: ask.roomCodes } : {}),
      ...(ask.boardBases ? { boardBases: ask.boardBases } : {}),
    },
  };
  return {
    ref: 'source:1',
    sha256: 'a'.repeat(64),
    toolVersion: 'test',
    observedAt: '2026-10-09T10:00:00.000Z',
    request: {
      propertyCode: 'HRCEN',
      arrivalDate: ARRIVAL,
      departureDate: DEPARTURE,
      requestedCurrency: 'ZAR',
      rooms: [room],
      rateContext: { organization: { nativeId: '49', name: 'Woolworths' } },
    },
    result: {
      outcome: 'quote',
      propertyCode: 'HRCEN',
      groups: [{ id: 'single', request: room, completeness: { search: 'complete', requiredFacts: 'complete' }, options }],
    },
  };
}

const ROOM_ONLY = { roomCodes: ['SKNG'], boardBases: ['room_only'] };

describe('rate cards from one summary read', () => {
  it('(d) a sold-out requested room lists the other room that is available, marked as not the request', () => {
    const cards = buildRateOptions(
      source(
        [
          row({ id: 'SKNG:BARRO', room: 'SKNG', rate: 'BARRO', availability: 'unavailable' }),
          row({ id: 'STQN:BARRO', room: 'STQN', rate: 'BARRO', match: 'alternative' }),
        ],
        ROOM_ONLY,
      ),
      [],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ roomCode: 'STQN', matchesRequest: false, contract: false, selected: false, priced: 'summary' });
  });

  it('marks contextual rows as contract and never a public BAR code', () => {
    const cards = buildRateOptions(
      source(
        [
          row({ id: 'SKNG:BARRO', rate: 'BARRO' }),
          row({ id: 'STQN:BCO1B', room: 'STQN', rate: 'BCO1B', scope: 'contextual', match: 'alternative' }),
        ],
        ROOM_ONLY,
      ),
      [],
    );
    expect(cards.find((card) => card.rateCode === 'BARRO')).toMatchObject({ contract: false });
    expect(cards.find((card) => card.rateCode === 'BCO1B')).toMatchObject({ contract: true });
  });

  it('keeps every distinct available rate code, and never a restricted, unavailable, held, unresolved or unverified row', () => {
    const selected = row({ id: 'SKNG:BARRO', rate: 'BARRO', amount: '500.00' });
    const kept = [
      row({ id: 'STQN:BCO1B', room: 'STQN', rate: 'BCO1B', scope: 'contextual', match: 'alternative', amount: '520.00' }),
      row({ id: 'SKNG:BCO2B', rate: 'BCO2B', board: 'Bed & Breakfast R', scope: 'contextual', match: 'alternative', amount: '640.00' }),
      row({ id: 'SKNG:BCO5B', rate: 'BCO5B', board: 'Dinner, Bed & Breakfast R', scope: 'contextual', match: 'alternative', amount: '700.00' }),
      row({ id: 'SKNG:BBP', rate: 'BBP', board: 'Bed & Breakfast R', match: 'alternative', amount: '600.00' }),
      row({ id: 'SKNG:DBBP', rate: 'DBBP', board: 'Dinner, Bed & Breakfast R', match: 'alternative', amount: '650.00' }),
    ];
    const excluded = [
      row({ id: 'SKNG:BCO3B', rate: 'BCO3B', board: 'Bed & Breakfast R', scope: 'contextual', match: 'alternative', availability: 'restricted', amount: '100.00' }),
      row({ id: 'SKNG:BCO4B', rate: 'BCO4B', scope: 'contextual', match: 'alternative', availability: 'unavailable', amount: '90.00' }),
      row({ id: 'SKNG:BBX', rate: 'BBX', board: 'Bed & Breakfast R', match: 'alternative', held: true, amount: '50.00' }),
      row({ id: 'SKNG:DBBX', rate: 'DBBX', board: 'Dinner, Bed & Breakfast R', match: 'unresolved', amount: '10.00' }),
      row({ id: 'SKNG:BCO6B', rate: 'BCO6B', board: 'Bed & Breakfast R', scope: 'contextual', match: 'alternative', eligibility: 'conditional', amount: '30.00' }),
    ];
    const cards = buildRateOptions(source([selected, ...kept, ...excluded], ROOM_ONLY), [{ groupId: 'single', optionId: 'SKNG:BARRO' }]);
    expect(cards.map((card) => card.rateCode)).toEqual(['BARRO', 'BCO1B', 'BCO2B', 'BCO5B', 'BBP', 'DBBP']);
    expect(cards.find((card) => card.rateCode === 'BARRO')).toMatchObject({ selected: true, priced: 'full', matchesRequest: true });
    expect(cards.filter((card) => card.priced === 'full')).toHaveLength(1);
    expect(cards.every((card) => card.onlyContract === false)).toBe(true);
  });

  it('keeps all distinct HMS codes beyond the old five-card ceiling', () => {
    const codes = ['BARRO', 'BCO1B', 'BCO2B', 'BCO5B', 'BBP', 'DBBP', 'GNC3B'];
    const options = codes.map((rateCode, index) =>
      row({
        id: `room-rate-${index}`,
        room: index === 0 ? 'SKNG' : 'STQN',
        rate: rateCode,
        scope: index % 2 === 0 ? 'public' : 'contextual',
        match: index === 0 ? 'match' : 'alternative',
      }),
    );
    const cards = buildRateOptions(source(options, ROOM_ONLY), []);
    expect(cards.map((card) => card.rateCode).sort()).toEqual([...codes].sort());
  });

  it('sorts requested first, then contract before public, then cheapest, and prices per room and per night', () => {
    const cards = buildRateOptions(
      source(
        [
          row({ id: 'SKNG:BARRO', rate: 'BARRO', amount: '500.00' }),
          row({ id: 'STQN:BCO1B', room: 'STQN', rate: 'BCO1B', scope: 'contextual', match: 'alternative', amount: '520.00' }),
          row({ id: 'SKNG:BBP', rate: 'BBP', board: 'Bed & Breakfast R', match: 'alternative', amount: '600.00' }),
        ],
        { ...ROOM_ONLY, quantity: 2 },
      ),
      [{ groupId: 'single', optionId: 'SKNG:BARRO' }],
    );
    expect(cards.map((card) => card.rateCode)).toEqual(['BARRO', 'BCO1B', 'BBP']);
    // 500.00 a night for two nights, for two rooms: 1,000.00 per room and 2,000.00 in total, in cents.
    expect(cards[0]).toMatchObject({ perNightMinor: 50000, totalMinor: 200000, currency: 'ZAR' });
    expect(cards[1]).toMatchObject({ contract: true, onlyContract: true, matchesRequest: false });
  });

  it('reports the minimum inventory across all nights without changing rate order', () => {
    const cards = buildRateOptions(
      source(
        [
          row({ id: 'SKNG:BARRO', rate: 'BARRO', inventories: [7, 3] }),
          row({ id: 'SKNG:BBP', rate: 'BBP', board: 'Bed & Breakfast R', match: 'alternative', inventories: [5, 4] }),
        ],
        ROOM_ONLY,
      ),
      [],
    );

    expect(cards.map(({ rateCode }) => rateCode)).toEqual(['BARRO', 'BBP']);
    expect(cards.map(({ roomsLeft }) => roomsLeft)).toEqual([3, 4]);
  });

  it('does not return options with a missing night inventory', () => {
    const cards = buildRateOptions(
      source([row({ id: 'SKNG:BARRO', rate: 'BARRO', inventories: [8, undefined] })], ROOM_ONLY),
      [],
    );

    expect(cards).toEqual([]);
  });

  it('keeps the quoted option even when a cheaper room that was not requested exists', () => {
    const cards = buildRateOptions(
      source(
        [
          row({ id: 'SKNG:BARRO', rate: 'BARRO', amount: '500.00' }),
          row({ id: 'STWN:BARRO', room: 'STWN', rate: 'BARRO', match: 'alternative', amount: '100.00' }),
        ],
        ROOM_ONLY,
      ),
      [{ groupId: 'single', optionId: 'SKNG:BARRO' }],
    );
    expect(cards.map((card) => [card.roomCode, card.selected])).toEqual([
      ['SKNG', true],
      ['STWN', false],
    ]);
  });

  it('returns no cards when the group is missing, and never throws for it', () => {
    const base = source([], ROOM_ONLY);
    expect(buildRateOptions({ ...base, result: { ...base.result, groups: [] } }, [])).toEqual([]);
  });
});

describe('the note for a contract on another board', () => {
  const option = (over: Partial<RateOption>): RateOption => ({
    id: 'single:BARRO',
    groupId: 'single',
    board: 'room_only',
    boardLabel: 'Room Only R',
    rateCode: 'BARRO',
    rateLabel: 'Room Only',
    roomCode: 'SKNG',
    roomLabel: 'Standard King',
    contract: false,
    onlyContract: false,
    matchesRequest: true,
    perNightMinor: 50000,
    totalMinor: 100000,
    currency: 'ZAR',
    priced: 'full',
    selected: true,
    ...over,
  });
  const contractElsewhere = option({
    id: 'single:BCO2B',
    board: 'bb',
    boardLabel: 'Bed & Breakfast R',
    rateCode: 'BCO2B',
    contract: true,
    onlyContract: true,
    matchesRequest: false,
    selected: false,
    priced: 'summary',
  });

  it('names the contract and the board quoted, when the public rate was quoted for a contract on another board', () => {
    expect(otherBoardContractNotes(['Woolworths'], [option({}), contractElsewhere])).toEqual([
      "Woolworths's contract rate is Bed & Breakfast R only (BCO2B). Quoted room only at the public rate as asked. Pick the contract option to switch.",
    ]);
  });

  it('is silent when the contract itself was quoted, or when no contract exists elsewhere', () => {
    expect(otherBoardContractNotes(['Woolworths'], [option({ contract: true, board: 'room_only', boardLabel: 'Room Only R' }), contractElsewhere])).toEqual([]);
    expect(otherBoardContractNotes(['Woolworths'], [option({})])).toEqual([]);
  });
});

describe('HMS event rates (U13)', () => {
  it('marks GNC3B and GNC4B with a hint and leaves every other card as it was', () => {
    const cards = buildRateOptions(
      source([row({ id: 'gnc', rate: 'GNC3B', scope: 'contextual' }), row({ id: 'bar', rate: 'BAR' })], ROOM_ONLY),
      [],
    );
    expect(cards.find((card) => card.rateCode === 'GNC3B')?.hint).toBe('event_rate');
    expect(cards.find((card) => card.rateCode === 'BAR')).not.toHaveProperty('hint');
  });
});

it('does not quote a cheaper unread leftover row', () => {
  const unread = row({ id: 'SKNG:BWS1B', rate: 'BWS1B', amount: '100.00', scope: 'contextual' });
  (unread as NativeOption & { details?: { status: string } }).details = { status: 'not_read' };
  const complete = row({ id: 'SKNG:BARRO', rate: 'BARRO', amount: '500.00' });
  (complete as NativeOption & { details?: { status: string } }).details = { status: 'complete' };
  const cards = buildRateOptions(source([unread, complete], ROOM_ONLY), [{ groupId: 'single', optionId: complete.id }]);
  expect(cards.map((card) => card.rateCode)).toEqual(['BARRO']);
});
