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
    ['missing dates', { stays: [{ ...payload().stays[0], requested: { arrival: null, departure: null } }] }, 'missing_dates'],
    ['past dates', { stays: [{ ...payload().stays[0], requested: { arrival: '2026-10-13', departure: '2026-10-15' } }] }, 'past_dates'],
    ['missing room count', { stays: [{ ...payload().stays[0], totalRooms: null, rows: [{ ...payload().stays[0]!.rows[0], rooms: null }] }] }, 'missing_rooms'],
    ['missing occupancy', { stays: [{ ...payload().stays[0], rows: [{ ...payload().stays[0]!.rows[0], adultsPerRoom: null }] }] }, 'missing_occupancy'],
    ['ambiguous room type', { stays: [{ ...payload().stays[0], rows: [{ ...payload().stays[0]!.rows[0], roomType: 'Twin' }] }] }, 'room_type_unresolved'],
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

  it.each([
    ['dates', { groups: [{ ...base.groups[0]!, arrivalDate: '2026-10-21' }] }],
    ['room count', { groups: [{ ...base.groups[0]!, quantity: 3 }] }],
    ['occupancy', { groups: [{ ...base.groups[0]!, adults: 1 }] }],
    ['board', { groups: [{ ...base.groups[0]!, board: 'room_only' as const }] }],
  ])('requires the same %s for reuse', (_label, changes) => {
    expect(staffQuoteInputsPriceEquivalent(base, { ...base, ...changes })).toBe(false);
  });
});
