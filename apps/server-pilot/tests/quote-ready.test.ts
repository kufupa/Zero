import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPreparedStaffQuotePlan,
  confidentPartyFromV2Result,
  staffQuoteInputsPriceEquivalent,
} from '../src/ai/quote-ready.js';

const messageId = 'quote-message-1';
const sourceHash = 'a'.repeat(64);

function payload(overrides: Record<string, unknown> = {}) {
  return {
    origin: 'person',
    agency: 'Acme Lodging Holdings',
    endClient: null,
    contact: { name: 'Alex Guest', email: 'alex@example.test', phone: null },
    confirmationNumbers: [],
    stays: [
      {
        id: 'stay-1',
        hotel: 'Centurion',
        requested: { arrival: '2026-10-20', departure: '2026-10-23' },
        booked: null,
        totalRooms: 2,
        rows: [
          {
            id: 'row-1',
            roomType: 'Standard King',
            rooms: null,
            adultsPerRoom: 2,
            childAges: [],
            board: null,
          },
        ],
      },
    ],
    missing: [],
    ...overrides,
  };
}

function build(overrides: Parameters<typeof payload>[0] = {}, now = new Date('2026-10-14T12:00:00.000Z')) {
  return buildPreparedStaffQuotePlan({
    messageId,
    sourceHash,
    payload: payload(overrides),
    now,
  });
}

function buildWithRoomType(roomType: string) {
  const stay = payload().stays[0]!;
  return build({
    stays: [{ ...stay, rows: [{ ...stay.rows[0]!, roomType }] }],
  });
}

describe('prepared quote input from stored extraction', () => {
  it('defaults unspecified board to B&B and uses the single-row total without inventing occupancy', () => {
    const plan = build();

    expect(plan).toMatchObject({ partyBound: false, inputs: [{ groups: [
      {
        id: 'row-1',
        arrivalDate: '2026-10-20',
        departureDate: '2026-10-23',
        quantity: 2,
        adults: 2,
        board: 'bb',
        roomCodes: ['SKNG'],
      },
    ] }] });
    expect(plan.inputs[0]?.parties).toBeUndefined();
    expect(plan.inputs[0]?.salesStrategy).toBe('BAR');
  });

  it('keeps dinner as an add-on request only when extraction explicitly asks for dinner', () => {
    const plan = build({
      stays: [
        {
          id: 'stay-1',
          hotel: null,
          requested: { arrival: '2026-10-20', departure: '2026-10-23' },
          booked: null,
          totalRooms: 1,
          rows: [{
            id: 'row-1', roomType: 'SKNG', rooms: 1, adultsPerRoom: 2, childAges: [], board: 'dbb',
          }],
        },
      ],
    });

    expect(plan.inputs[0]?.groups[0]?.board).toBe('dinner_bb');
    expect(plan.inputs[0]).not.toHaveProperty('dinnerAllowanceMinor');
  });

  it.each([
    ['1 x Standard Queen', 'STQN'],
    ['2x Deluxe-Twins!', 'DLXTWN'],
    ['3 rooms: Executive Kings', 'EXKNG'],
    ['StandardKing', 'SKNG'],
  ])('resolves normalized room phrase %s to its unique configured code', (roomType, code) => {
    const plan = buildWithRoomType(roomType);

    expect(plan.inputs).toHaveLength(1);
    expect(plan.inputs[0]?.groups[0]?.roomCodes).toEqual([code]);
  });

  it.each([
    '1 x double',
    '1 x single',
    '1 x queen',
    '1 x king',
    '1 x twin',
    '1 x standard',
    '1 x deluxe',
  ])('falls back to any room type for ambiguous phrase %s', (roomType) => {
    const plan = buildWithRoomType(roomType);

    expect(plan.inputs).toHaveLength(1);
    expect(plan.inputs[0]?.groups[0]?.roomCodes).toBeUndefined();
    expect(plan.stays[0]?.reason).toBeUndefined();
  });

  it('defaults missing occupancy to two adults per room', () => {
    const stay = payload().stays[0]!;
    const plan = build({
      stays: [{ ...stay, rows: [{ ...stay.rows[0]!, adultsPerRoom: null }] }],
    });

    expect(plan.inputs[0]?.groups[0]).toMatchObject({ quantity: 2, adults: 2 });
    expect(plan.reason).toBeNull();
  });

  it('defaults a missing room count to one when dates and a guest row exist', () => {
    const stay = payload().stays[0]!;
    const plan = build({
      stays: [{ ...stay, totalRooms: null, rows: [{ ...stay.rows[0]!, rooms: null }] }],
    });

    expect(plan.inputs[0]?.groups[0]).toMatchObject({ quantity: 1, adults: 2 });
    expect(plan.reason).toBeNull();
  });

  it('does not default a room count when no guest evidence exists', () => {
    const stay = payload().stays[0]!;
    const plan = build({
      stays: [{
        ...stay,
        totalRooms: null,
        rows: [{ ...stay.rows[0]!, rooms: null, adultsPerRoom: null, childAges: [] }],
      }],
    });

    expect(plan.inputs).toEqual([]);
    expect(plan.reason).toBe('missing_rooms');
  });

  it('keeps missing dates as a hard block', () => {
    const stay = payload().stays[0]!;
    const plan = build({
      stays: [{ ...stay, requested: { arrival: null, departure: null } }],
    });

    expect(plan.inputs).toEqual([]);
    expect(plan.reason).toBe('missing_dates');
  });

  it.each([
    ['past dates', { stays: [{ ...payload().stays[0], requested: { arrival: '2026-10-13', departure: '2026-10-15' } }] }, 'past_dates'],
    ['zero room count', { stays: [{ ...payload().stays[0], rows: [{ ...payload().stays[0]!.rows[0], rooms: 0 }] }] }, 'missing_rooms'],
    ['out-of-range occupancy', { stays: [{ ...payload().stays[0], rows: [{ ...payload().stays[0]!.rows[0], adultsPerRoom: 7 }] }] }, 'missing_occupancy'],
  ])('does not prepare a stay with %s', (_label, overrides, reason) => {
    const plan = build(overrides as Record<string, unknown>);

    expect(plan.inputs).toEqual([]);
    expect(plan.reason).toBe(reason);
  });

  it('splits distinct date ranges into independent staff quotes', () => {
    const first = payload().stays[0]!;
    const plan = build({
      stays: [
        first,
        {
          ...first,
          id: 'stay-2',
          requested: { arrival: '2026-11-01', departure: '2026-11-03' },
          rows: [{ ...first.rows[0]!, id: 'row-2', rooms: 1 }],
        },
      ],
    });

    expect(plan.inputs).toHaveLength(2);
    expect(plan.inputs.map((input) => input.groups[0]?.arrivalDate)).toEqual(['2026-10-20', '2026-11-01']);
  });
});

type Eval47StaySummary = {
  hasInput: 'y' | 'n';
  reason?: string;
  dates?: Array<{ arrival: string; departure: string }>;
  rooms?: Array<{
    roomCodes: string[];
    count: number;
    adultsPerRoom: number;
    childCountPerRoom: number;
  }>;
  board?: string[];
};

type Eval47SummaryRow = {
  hasInput: 'y' | 'n';
  reason?: string;
  stays?: Eval47StaySummary[];
};

type Eval47SummaryFixture = {
  totalRows: number;
  shapes: Array<{ hasInput: 'y' | 'n'; reason?: string; count: number }>;
};

const eval47SummaryUrl = new URL('./fixtures/quote-ready-eval-47-summary.json', import.meta.url);

/** The eval stores gate summaries, not mail text or extraction payloads. Rehydrate blocker-shaped test inputs only. */
function payloadForEval47Shape(row: Eval47SummaryRow): Record<string, unknown> | null {
  const baseStay = payload().stays[0]!;
  if (row.reason === 'spam' || row.reason === 'system_notice') return null;
  if (row.reason === 'missing_dates') {
    return { stays: [{ ...baseStay, requested: { arrival: null, departure: null } }] };
  }
  if (row.reason === 'missing_occupancy') {
    return {
      stays: [{ ...baseStay, rows: [{ ...baseStay.rows[0]!, adultsPerRoom: null }] }],
    };
  }
  if (row.reason === 'missing_rooms') {
    return {
      stays: [{ ...baseStay, totalRooms: null, rows: [{ ...baseStay.rows[0]!, rooms: null }] }],
    };
  }
  if (row.reason === 'room_type_unresolved') {
    return {
      stays: [{ ...baseStay, rows: [{ ...baseStay.rows[0]!, roomType: 'Twin' }] }],
    };
  }
  if (row.hasInput !== 'y') return null;

  const stays = (row.stays ?? []).map((stay, stayIndex) => {
    const date = stay.dates?.[0];
    const rows = (stay.rooms ?? []).map((room, rowIndex) => {
      const board = stay.board?.[rowIndex];
      return {
        id: `eval-${stayIndex}-${rowIndex}`,
        roomType: room.roomCodes[0] ?? null,
        rooms: room.count,
        adultsPerRoom: room.adultsPerRoom,
        childAges: Array.from({ length: room.childCountPerRoom }, () => 0),
        board: board === 'room_only' ? 'room_only' : board === 'dinner_bb' ? 'dbb' : 'bb',
      };
    });
    return {
      ...baseStay,
      id: `eval-stay-${stayIndex}`,
      requested: {
        arrival: date?.arrival ?? baseStay.requested.arrival,
        departure: date?.departure ?? baseStay.requested.departure,
      },
      totalRooms: rows.length === 1 ? rows[0]?.rooms ?? null : null,
      rows: rows.length ? rows : baseStay.rows,
    };
  });
  return { stays: stays.length ? stays : [baseStay] };
}

describe('quote-ready eval-47 summary replay', () => {
  it('counts prefillable shapes from the checked-in sanitized summary', () => {
    const summary = JSON.parse(readFileSync(eval47SummaryUrl, 'utf8')) as Eval47SummaryFixture;
    const rows: Eval47SummaryRow[] = summary.shapes.flatMap(({ count, ...row }) =>
      Array.from({ length: count }, () => row),
    );
    const prefillable = rows.filter((row) => {
      const fixture = payloadForEval47Shape(row);
      return fixture ? build(fixture).inputs.length > 0 : false;
    }).length;

    expect(rows).toHaveLength(summary.totalRows);
    expect(summary.totalRows).toBe(47);
    expect(prefillable).toBe(40);
    expect(prefillable).toBeGreaterThanOrEqual(30);
    expect(prefillable).toBeLessThanOrEqual(44);
    console.log(`prefillable ${prefillable}/${summary.totalRows}`);
  });
});

describe('confident party bind for prepared quotes', () => {
  const matchInput = {
    payload: payload(),
    fromAddress: 'agent@acme.example.test',
    subject: 'Quote request',
    body: 'Please quote our guest.',
  };
  const matchedRow = { kind: 'agency', nativeId: 'agency-17', name: 'Acme Lodging Holdings' };

  it('passes only a V2 match that re-applies the high-confidence bind rule', () => {
    const parties = confidentPartyFromV2Result({
      ...matchInput,
      result: {
        matchVersion: 2,
        matchStatus: 'bound',
        boundParty: matchedRow,
        results: [matchedRow],
        confidence: 'high',
        pickSource: 'fallback',
        truncated: false,
      },
    });

    expect(parties).toEqual({ agency: matchedRow });
  });

  it.each([
    ['unbound', { matchStatus: 'needs_pick', boundParty: null, confidence: 'low' }],
    ['ambiguous', { matchStatus: 'bound', boundParty: matchedRow, confidence: 'high', truncated: true }],
  ])('does not pass an %s V2 result into the quote', (_label, overrides) => {
    expect(
      confidentPartyFromV2Result({
        ...matchInput,
        result: {
          matchVersion: 2,
          matchStatus: 'needs_pick',
          boundParty: null,
          results: [matchedRow],
          confidence: 'low',
          pickSource: 'fallback',
          truncated: false,
          ...overrides,
        },
      }),
    ).toBeUndefined();
  });

  it('does not bind when two returned HMS rows claim the same party name', () => {
    expect(
      confidentPartyFromV2Result({
        ...matchInput,
        result: {
          matchVersion: 2,
          matchStatus: 'bound',
          boundParty: matchedRow,
          results: [matchedRow, { ...matchedRow, nativeId: 'agency-18' }],
          confidence: 'high',
          pickSource: 'llm',
          truncated: false,
        },
      }),
    ).toBeUndefined();
  });
});

describe('prepared quote reuse price fields', () => {
  const base = build().inputs[0]!;

  it('ignores staff headers and pane selection counters', () => {
    expect(
      staffQuoteInputsPriceEquivalent(base, {
        ...base,
        selectionEpoch: 44,
        inputRevision: 99,
        company: 'Changed display name',
        agency: 'Changed header',
      }),
    ).toBe(true);
  });

  it('requires the same pane row identity for reuse', () => {
    expect(
      staffQuoteInputsPriceEquivalent(base, {
        ...base,
        groups: [{ ...base.groups[0]!, id: 'row-copied' }],
      }),
    ).toBe(false);
  });

  it.each([
    ['dates', { groups: [{ ...base.groups[0]!, arrivalDate: '2026-10-21' }] }],
    ['room count', { groups: [{ ...base.groups[0]!, quantity: 3 }] }],
    ['occupancy', { groups: [{ ...base.groups[0]!, adults: 1 }] }],
    ['board', { groups: [{ ...base.groups[0]!, board: 'room_only' as const }] }],
  ])('requires the same %s for reuse', (_label, changes) => {
    expect(staffQuoteInputsPriceEquivalent(base, { ...base, ...changes })).toBe(false);
  });
});
