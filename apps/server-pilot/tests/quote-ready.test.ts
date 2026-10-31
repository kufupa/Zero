import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPreparedStaffQuotePlan,
  confidentPartyFromV2Result,
  quotePrepareKindReason,
  quoteShopJobsForPlan,
  staffQuotePriceKey,
  staffQuoteInputsPriceEquivalent,
} from '../src/ai/quote-ready.js';
import { replaceLearnedSenderMapForTests } from '../src/ai/party-sender-map.js';
import {
  quoteSalesStrategiesFromRegistry,
  type QuoteSalesStrategy,
} from '../src/hms/rate-catalogue.js';

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

  it('keeps an explicit dinner B&B ask on dinner board without defaulting Government', () => {
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
    expect(plan.inputs[0]?.salesStrategy).toBe('BAR');
    expect(plan.inputs[0]).not.toHaveProperty('dinnerAllowanceMinor');
  });

  it('keeps a mixed Dinner B&B + B&B mail on BAR, one strategy per mail like the pane', () => {
    const baseStay = payload().stays[0]!;
    const plan = build({
      stays: [
        {
          ...baseStay,
          id: 'stay-dinner',
          rows: baseStay.rows.map((row) => ({ ...row, id: 'row-dinner', board: 'dbb' })),
        },
        {
          ...baseStay,
          id: 'stay-bb',
          requested: { arrival: '2026-10-24', departure: '2026-10-27' },
          rows: baseStay.rows.map((row) => ({ ...row, id: 'row-bb', board: 'bb' })),
        },
      ],
    });

    expect(plan.inputs.map((input) => input.salesStrategy)).toEqual(['BAR', 'BAR']);
    expect(plan.inputs.map((input) => input.groups[0]?.board)).toEqual(['dinner_bb', 'bb']);
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
    '1 x standard',
    '1 x deluxe',
  ])('falls back to any room type for ambiguous phrase %s', (roomType) => {
    const plan = buildWithRoomType(roomType);

    expect(plan.inputs).toHaveLength(1);
    expect(plan.inputs[0]?.groups[0]?.roomCodes).toBeUndefined();
    expect(plan.stays[0]?.reason).toBeUndefined();
  });

  it.each(['1 x twin', 'twin', 'Twin room', '2 beds', 'two beds'])(
    'prices an unpicked twin request %s as Standard Twin',
    (roomType) => {
      const plan = buildWithRoomType(roomType);

      expect(plan.inputs).toHaveLength(1);
      expect(plan.inputs[0]?.groups[0]?.roomCodes).toEqual(['STWN']);
    },
  );

  it('maps HRDAV room labels onto that profile and leaves STD SGL unmatched', () => {
    const stay = payload().stays[0]!;
    const plan = buildPreparedStaffQuotePlan({
      messageId,
      sourceHash,
      payload: payload({
        stays: [
          {
            ...stay,
            rows: [
              { ...stay.rows[0]!, id: 'row-twn', roomType: 'STD TWN' },
              { ...stay.rows[0]!, id: 'row-sgl', roomType: 'STD SGL', rooms: 1, adultsPerRoom: 1 },
              { ...stay.rows[0]!, id: 'row-pat', roomType: 'Deluxe Patio', rooms: 1 },
              { ...stay.rows[0]!, id: 'row-dlxtwn', roomType: 'Deluxe Twin', rooms: 1 },
              { ...stay.rows[0]!, id: 'row-kng', roomType: 'Standard King', rooms: 1 },
            ],
          },
        ],
      }),
      now: new Date('2026-10-14T12:00:00.000Z'),
      propertyCode: 'HRDAV',
    });

    const codes = Object.fromEntries(
      (plan.inputs[0]?.groups ?? []).map((group) => [group.id, group.roomCodes]),
    );
    expect(codes).toEqual({
      'row-twn': ['STWN'],
      'row-sgl': undefined,
      'row-pat': ['DLXPAT'],
      'row-dlxtwn': undefined,
      'row-kng': ['STKNG'],
    });
  });

  it('does not shop abbreviated Deluxe Twin as Standard Twin on HRDAV', () => {
    const stay = payload().stays[0]!;
    const plan = buildPreparedStaffQuotePlan({
      messageId,
      sourceHash,
      payload: payload({
        stays: [{ ...stay, rows: [{ ...stay.rows[0]!, roomType: 'DLX Twin' }] }],
      }),
      now: new Date('2026-10-14T12:00:00.000Z'),
      propertyCode: 'HRDAV',
    });
    expect(plan.inputs[0]?.groups[0]?.roomCodes).toBeUndefined();
  });

  it('still prices an unpicked twin as Standard Twin on HRCEN', () => {
    const stay = payload().stays[0]!;
    const plan = buildPreparedStaffQuotePlan({
      messageId,
      sourceHash,
      payload: payload({
        stays: [{ ...stay, rows: [{ ...stay.rows[0]!, roomType: 'twin' }] }],
      }),
      now: new Date('2026-10-14T12:00:00.000Z'),
      propertyCode: 'HRCEN',
    });
    expect(plan.inputs[0]?.groups[0]?.roomCodes).toEqual(['STWN']);
  });

  it('defaults missing occupancy to two adults per room', () => {
    const stay = payload().stays[0]!;
    const plan = build({
      stays: [{ ...stay, rows: [{ ...stay.rows[0]!, adultsPerRoom: null }] }],
    });

    expect(plan.inputs[0]?.groups[0]).toMatchObject({ quantity: 2, adults: 2 });
    expect(plan.reason).toBeNull();
  });

  it('blocks only a stay whose known child count has no matching ages', () => {
    const base = payload().stays[0]!;
    const plan = build({
      stays: [
        {
          ...base,
          id: 'stay-children-unknown-ages',
          totalRooms: 1,
          totalChildren: 1,
          rows: [{ ...base.rows[0]!, id: 'row-children-unknown-ages', rooms: 1, childCount: 1, childAges: [] }],
        },
        {
          ...base,
          id: 'stay-no-children',
          totalRooms: 1,
          requested: { arrival: '2026-10-24', departure: '2026-10-25' },
          rows: [{ ...base.rows[0]!, id: 'row-no-children', rooms: 1, childCount: 0, childAges: [] }],
        },
      ],
    });

    expect(plan.stays.map(({ stayId, reason }) => [stayId, reason])).toEqual([
      ['stay-children-unknown-ages', 'missing_occupancy'],
      ['stay-no-children', undefined],
    ]);
    expect(plan.inputs).toHaveLength(1);
    expect(plan.inputs[0]?.groups[0]).toMatchObject({ id: 'row-no-children', childrenAges: [] });
  });

  it('does not prepare a quote when known room allocations contradict the stay total', () => {
    const base = payload().stays[0]!;
    const plan = build({
      stays: [
        {
          ...base,
          id: 'stay-total-conflict',
          totalRooms: 2,
          totalChildren: 3,
          rows: [
            {
              ...base.rows[0]!,
              id: 'row-total-conflict',
              rooms: 2,
              childCount: 1,
              childAges: [6],
            },
          ],
        },
      ],
    });

    expect(plan.stays.map(({ stayId, reason }) => [stayId, reason])).toEqual([
      ['stay-total-conflict', 'missing_occupancy'],
    ]);
    expect(plan.inputs).toHaveLength(0);
  });

  it('does not divide a stay-wide adult total across multiple rooms', () => {
    const stay = payload().stays[0]!;
    const plan = build({
      stays: [
        {
          ...stay,
          totalRooms: 2,
          totalAdults: 5,
          rows: [{ ...stay.rows[0]!, rooms: 2, adultsPerRoom: null }],
        },
      ],
    });

    expect(plan.inputs).toEqual([]);
    expect(plan.stays[0]?.reason).toBe('missing_occupancy');
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

  it('defaults a stored arrival with no checkout to one night', () => {
    const stay = payload().stays[0]!;
    const plan = build({
      stays: [{ ...stay, requested: { arrival: '2026-10-20', departure: null } }],
    });

    expect(plan.inputs[0]?.groups[0]).toMatchObject({
      arrivalDate: '2026-10-20',
      departureDate: '2026-10-21',
    });
    expect(plan.reason).toBeNull();
  });

  it('does not default a reversed checkout dropped as stayDates to one night', () => {
    const stay = payload().stays[0]!;
    const plan = build({
      stays: [{ ...stay, requested: { arrival: '2026-10-20', departure: null } }],
      missing: [{
        field: 'stayDates',
        question: 'Departure date must be after arrival; confirm the requested stay dates.',
      }],
    });

    expect(plan.inputs).toEqual([]);
    expect(plan.reason).toBe('invalid_dates');
  });

  it('preserves an extraction checkout derived from stated nights', () => {
    const stay = payload().stays[0]!;
    const plan = build({
      stays: [{
        ...stay,
        requested: { arrival: '2026-10-20', departure: '2026-10-23' },
        requestedDateEvidence: '20 Oct for three nights',
      }],
    });

    expect(plan.inputs[0]?.groups[0]).toMatchObject({
      arrivalDate: '2026-10-20',
      departureDate: '2026-10-23',
    });
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

describe('quote prepare kind gate', () => {
  it('builds a prepared plan for a single-stay booking with no confirmation number', () => {
    expect(quotePrepareKindReason({ kind: 'booking', payload: payload(), subject: 'New booking 12 Nov' })).toBeNull();
    expect(build().reason).toBeNull();
    expect(build().inputs).toHaveLength(1);
  });

  it('rejects a booking that already has a confirmation number', () => {
    expect(
      quotePrepareKindReason({
        kind: 'booking',
        payload: payload({ confirmationNumbers: ['57291630-1'] }),
        subject: 'Booking confirmed',
      }),
    ).toBe('not_quote');
  });

  it.each(['DAT-2291', 'BK12345'])('admits agent reference %s instead of treating it as an HMS confirmation', (reference) => {
    expect(quotePrepareKindReason({ kind: 'booking', payload: payload({ confirmationNumbers: [reference] }) })).toBeNull();
  });

  it('rejects a booking whose subject carries a confirmation number', () => {
    expect(
      quotePrepareKindReason({
        kind: 'booking',
        payload: payload(),
        subject: 'Please honour 57291630-1',
      }),
    ).toBe('not_quote');
  });

  it('admits a multi-stay booking without a confirmation number', () => {
    const first = payload().stays[0]!;
    expect(
      quotePrepareKindReason({
        kind: 'booking',
        payload: payload({
          stays: [first, { ...first, id: 'stay-2', requested: { arrival: '2026-11-01', departure: '2026-11-03' } }],
        }),
        subject: 'Two stays',
      }),
    ).toBeNull();
  });

  it('rejects a booking with no stays', () => {
    expect(
      quotePrepareKindReason({
        kind: 'booking',
        payload: payload({ stays: [] }),
        subject: 'New booking',
      }),
    ).toBe('not_quote');
  });

  it('rejects a booking whose stay guests carry a confirmation number', () => {
    const first = payload().stays[0]!;
    expect(
      quotePrepareKindReason({
        kind: 'booking',
        payload: payload({
          stays: [{ ...first, guests: [{ name: 'Ada Example', confirmationNumber: '57291630-1' }] }],
        }),
        subject: 'New booking',
      }),
    ).toBe('not_quote');
  });

  it('still admits ordinary quote extractions', () => {
    expect(quotePrepareKindReason({ kind: 'quote', payload: payload(), subject: 'Quote 57291630-1' })).toBeNull();
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

  it('revalidates learned sender history only when the caller allows it', () => {
    vi.stubEnv('PARTY_HISTORY_BIND', 'on');
    replaceLearnedSenderMapForTests([
      {
        host: 'acme.example.test',
        kind: 'agency',
        name: 'Historical Agency',
        nativeId: 'agency-22',
        support: 2,
      },
    ]);
    const input = {
      payload: { ...payload(), agency: null },
      fromAddress: 'agent@acme.example.test',
      subject: 'Quote request',
      body: 'Please quote our guest.',
      result: {
        matchVersion: 2,
        matchStatus: 'bound',
        boundParty: { kind: 'agency', nativeId: 'agency-22', name: 'Historical Agency' },
        results: [{ kind: 'agency', nativeId: 'agency-22', name: 'Historical Agency' }],
        confidence: 'high',
        pickSource: 'fallback',
        truncated: false,
      },
    };

    try {
      expect(confidentPartyFromV2Result(input)).toBeUndefined();
      expect(confidentPartyFromV2Result({ ...input, allowLearnedSenderHistory: true })).toEqual({
        agency: { kind: 'agency', nativeId: 'agency-22', name: 'Historical Agency' },
      });
    } finally {
      vi.unstubAllEnvs();
      replaceLearnedSenderMapForTests(null);
    }
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

  it('gives duplicate mailbox copies one price identity while preserving priced-input differences', () => {
    const base = build().inputs[0]!;
    const otherCopy = {
      ...base,
      messageId: 'quote-message-copy',
      sourceHash: 'b'.repeat(64),
      selectionEpoch: 12,
      inputRevision: 18,
    };
    expect(staffQuotePriceKey(base)).toBe(staffQuotePriceKey(otherCopy));
    expect(staffQuotePriceKey(base)).not.toBe(
      staffQuotePriceKey({ ...otherCopy, salesStrategy: 'Government' }),
    );
  });

  it('permits strategy differences only for a prepared run with exactly matching bound parties', () => {
    const agency = { kind: 'agency' as const, nativeId: 'agency-17', name: 'Acme Lodging Holdings' };
    const contract = { ...base, salesStrategy: 'WS' as const, parties: { agency } };
    const pane = { ...base, salesStrategy: 'BAR' as const, parties: { agency } };
    const preparedEquivalent = staffQuoteInputsPriceEquivalent as (
      a: typeof base, b: typeof base, allowPreparedParty: boolean,
    ) => boolean;
    expect(preparedEquivalent(contract, pane, true)).toBe(true);
    expect(preparedEquivalent(contract, pane, false)).toBe(false);
    expect(preparedEquivalent({ ...contract, parties: undefined }, { ...pane, parties: undefined }, true)).toBe(false);
    expect(preparedEquivalent(contract, { ...pane, parties: { agency: { ...agency, nativeId: 'other' } } }, true)).toBe(false);
    expect(preparedEquivalent(contract, { ...pane, groups: [{ ...pane.groups[0]!, quantity: 3 }] }, true)).toBe(false);
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
    ['sales strategy', { salesStrategy: 'Government' as const }],
  ])('requires the same %s for reuse', (_label, changes) => {
    expect(staffQuoteInputsPriceEquivalent(base, { ...base, ...changes })).toBe(false);
  });
});

const HRCEN_STRATEGIES = quoteSalesStrategiesFromRegistry('HRCEN', null);
const SIX_STRATEGIES: QuoteSalesStrategy[] = [
  { code: 'BAR', label: 'BAR', requestValue: 'BAR' },
  { code: 'PROMO', label: 'Promotions', requestValue: 'PROMO' },
  { code: 'PRESET', label: 'Preset', requestValue: 'PRESET' },
  { code: 'WS', label: 'Wholesale', requestValue: 'WS' },
  { code: 'NC', label: 'Negoticated Contracted', requestValue: 'NC' },
  { code: 'GOV', label: 'Government', requestValue: 'Government' },
];

function twoStayPlan() {
  const second = payload().stays[0]!;
  return build({
    stays: [
      payload().stays[0]!,
      {
        ...second,
        id: 'stay-2',
        requested: { arrival: '2026-10-24', departure: '2026-10-27' },
        rows: second.rows.map((row) => ({ ...row, id: 'row-2' })),
      },
    ],
  });
}

describe('quote shop jobs per registry strategy', () => {
  it('builds one shop per configured strategy for the same stay', () => {
    const jobs = quoteShopJobsForPlan(build(), SIX_STRATEGIES);
    expect(jobs).toHaveLength(6);
    expect(jobs.map((job) => job.input.salesStrategy)).toEqual([
      'BAR',
      'PROMO',
      'PRESET',
      'WS',
      'NC',
      'Government',
    ]);
    expect(jobs.every((job) => job.input.groups[0]?.id === 'row-1')).toBe(true);
  });

  it('never shops a strategy missing from the registry', () => {
    const jobs = quoteShopJobsForPlan(
      build(),
      quoteSalesStrategiesFromRegistry('HRDAV', [
        { value: 'BAR', display: 'BAR' },
        { value: 'WS', display: 'Wholesale' },
        { value: 'UNREGISTERED', display: 'Unregistered strategy' },
      ]),
    );
    expect(jobs.map((job) => job.input.salesStrategy)).toEqual(['BAR', 'WS']);
  });

  it('keeps HRCEN BAR then Government for two stays', () => {
    const jobs = quoteShopJobsForPlan(twoStayPlan(), HRCEN_STRATEGIES);
    expect(jobs.map((job) => job.input.salesStrategy)).toEqual([
      'BAR',
      'BAR',
      'Government',
      'Government',
    ]);
    expect(jobs.map((job) => job.input.groups[0]?.id)).toEqual(['row-1', 'row-2', 'row-1', 'row-2']);
  });

  it('shops BAR then Government for an all-dbb HRCEN stay', () => {
    const stay = payload().stays[0]!;
    const plan = build({
      stays: [{ ...stay, rows: stay.rows.map((row) => ({ ...row, board: 'dbb' })) }],
    });
    expect(plan.inputs[0]?.salesStrategy).toBe('BAR');
    expect(quoteShopJobsForPlan(plan, HRCEN_STRATEGIES).map((job) => job.input.salesStrategy)).toEqual([
      'BAR',
      'Government',
    ]);
  });

  it('shops two stays times N strategies', () => {
    const jobs = quoteShopJobsForPlan(twoStayPlan(), SIX_STRATEGIES);
    expect(jobs).toHaveLength(12);
    expect(jobs.filter((job) => job.input.groups[0]?.id === 'row-1')).toHaveLength(6);
    expect(jobs.filter((job) => job.input.groups[0]?.id === 'row-2')).toHaveLength(6);
  });

  it('queues every stay primary before extra strategies', () => {
    const jobs = quoteShopJobsForPlan(twoStayPlan(), SIX_STRATEGIES);
    expect(jobs.slice(0, 2).map((job) => job.input.salesStrategy)).toEqual(['BAR', 'BAR']);
    expect(jobs.slice(0, 2).map((job) => job.input.groups[0]?.id)).toEqual(['row-1', 'row-2']);
  });

  it('pins BAR first even when the registry list does not', () => {
    const jobs = quoteShopJobsForPlan(build(), [
      { code: 'WS', label: 'Wholesale', requestValue: 'WS' },
      { code: 'BAR', label: 'BAR', requestValue: 'BAR' },
    ]);
    expect(jobs.map((job) => job.input.salesStrategy)).toEqual(['BAR', 'WS']);
  });

  it('omits an unconfigured Government primary and still shops allowed extras', () => {
    const stay = payload().stays[0]!;
    const plan = build({
      stays: [{ ...stay, rows: stay.rows.map((row) => ({ ...row, board: 'dbb' })) }],
    });
    expect(plan.inputs[0]?.salesStrategy).toBe('BAR');
    const jobs = quoteShopJobsForPlan(plan, [
      { code: 'WS', label: 'Wholesale', requestValue: 'WS' },
      { code: 'BAR', label: 'BAR', requestValue: 'BAR' },
      { code: 'PROMO', label: 'Promotions', requestValue: 'PROMO' },
    ]);
    expect(jobs.map((job) => job.input.salesStrategy)).toEqual(['BAR', 'WS', 'PROMO']);
    expect(jobs.some((job) => job.input.salesStrategy === 'Government')).toBe(false);
  });
});
