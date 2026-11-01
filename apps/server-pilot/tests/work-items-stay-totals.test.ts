import { describe, expect, it } from 'vitest';
import type { MailExtractionPayload } from '../src/ai/extraction/schema.js';
import { aiValueAt, parseFieldPath, storedAnalysis, validFieldValue } from '../src/ai/work-items.js';

const STAY = 'stay_1';
const ROW = 'row_1';

function payload(): MailExtractionPayload {
  return {
    contact: { name: null, email: null, phone: null },
    agency: null,
    endClient: null,
    confirmationNumbers: [],
    stays: [
      {
        id: STAY,
        hotel: null,
        requested: { arrival: '2027-10-26', departure: '2027-10-28' },
        booked: null,
        totalRooms: 2,
        totalAdults: 5,
        totalChildren: 0,
        rows: [
          {
            id: ROW,
            roomType: 'Double/Twin',
            rooms: 2,
            adultsPerRoom: 3,
            childAges: [],
            board: null,
          },
        ],
      },
    ],
    missing: [],
  };
}

describe('staff stay-total correction projection', () => {
  it('keeps explicit zero distinct from unknown and corrects totals without changing room occupancy', () => {
    const source = payload();
    const adultPath = `stays[${STAY}].totalAdults`;
    const childPath = `stays[${STAY}].totalChildren`;

    expect(parseFieldPath(adultPath)).toEqual({ stayId: STAY, rowId: null, field: 'totalAdults' });
    expect(validFieldValue('totalAdults', 6)).toBe(true);
    expect(aiValueAt(source, adultPath)).toBe(5);
    expect(aiValueAt(source, childPath)).toBe(0);

    const corrected = storedAnalysis(
      { kind: 'quote', payload: source, attachments: [] },
      { [adultPath]: 6, [childPath]: null },
    ).analysis.groups[0]!;
    expect(corrected).toMatchObject({
      adultsTotal: 6,
      adults: 3,
      quantity: 2,
      childrenTotal: null,
      fields: { adultsTotal: 'staff_corrected', childrenTotal: 'staff_corrected' },
    });
  });

  it('allows staff to correct a multi-room adult allocation until it matches the stay total', () => {
    const source = payload();
    source.missing = [{ field: 'adultsPerRoom', question: 'Confirm the number of adults per room.' }];
    source.stays[0]!.rows = [
      { id: 'row_1', roomType: 'Double/Twin', rooms: 1, adultsPerRoom: 2, childAges: [], board: null },
      { id: 'row_2', roomType: 'Double/Twin', rooms: 1, adultsPerRoom: 2, childAges: [], board: null },
    ];
    const corrected = storedAnalysis(
      { kind: 'quote', payload: source, attachments: [] },
      {
        [`stays[${STAY}].rows[row_1].adults`]: 2,
        [`stays[${STAY}].rows[row_2].adults`]: 3,
      },
    ).analysis;

    expect(corrected.groups.map(({ adults, adultsTotal, fields }) => ({ adults, adultsTotal, field: fields.adults }))).toEqual([
      { adults: 2, adultsTotal: 5, field: 'staff_corrected' },
      { adults: 3, adultsTotal: 5, field: 'staff_corrected' },
    ]);
    expect(corrected.missingQuoteReplyFields).toEqual([]);
  });

  it('retains a stay-scoped occupancy warning even when its row has an extracted value', () => {
    const source = payload();
    const first = source.stays[0]!;
    first.totalRooms = 1;
    first.totalAdults = 2;
    first.totalChildren = 0;
    first.rows = [{ id: 'row_1', roomType: 'Double', rooms: 1, adultsPerRoom: 2, childAges: [], board: null }];
    source.stays.push({
      ...first,
      id: 'stay_2',
      requested: { arrival: '2027-11-26', departure: '2027-11-28' },
      totalAdults: 1,
      rows: [{ ...first.rows[0]!, id: 'row_2', adultsPerRoom: 1 }],
    });
    source.missing = [{ field: 'adultsPerRoom', question: 'Confirm this stay’s occupancy.', stayId: 'stay_2' }];

    const analysis = storedAnalysis({ kind: 'quote', payload: source, attachments: [] }, {}).analysis;
    expect(analysis.groups.map(({ stayId, adults, fields }) => ({ stayId, adults, field: fields.adults }))).toEqual([
      { stayId: STAY, adults: 2, field: 'extracted' },
      { stayId: 'stay_2', adults: 1, field: 'missing' },
    ]);
    expect(analysis.missingQuoteReplyFields).toContain('Number of guests per room for stay 2');
  });

  it('keeps unknown room counts unset across multiple rows when no total is stated', () => {
    const source = payload();
    source.stays[0]!.totalRooms = null;
    source.stays[0]!.rows = [
      { id: 'row_1', roomType: 'Standard King', rooms: null, adultsPerRoom: 2, childAges: [], board: null },
      { id: 'row_2', roomType: 'Standard Twin', rooms: null, adultsPerRoom: 2, childAges: [], board: null },
    ];

    const projected = storedAnalysis({ kind: 'quote', payload: source, attachments: [] }, {}).analysis.groups;
    expect(projected.map((group) => group.quantity)).toEqual([undefined, undefined]);
    expect(projected.map((group) => group.fields.quantity)).toEqual(['missing', 'missing']);
  });

  it('uses staff-entered row counts to correct a conflicting stay total only when every row is grounded', () => {
    const source = payload();
    source.stays[0]!.totalRooms = 30;
    source.stays[0]!.totalAdults = null;
    source.stays[0]!.rows = [
      { id: 'row_1', roomType: 'Single', rooms: null, adultsPerRoom: 1, childAges: [], board: null },
      { id: 'row_2', roomType: 'Double', rooms: 20, adultsPerRoom: 2, childAges: [], board: null },
    ];
    const countPath = `stays[${STAY}].rows[row_1].count`;
    const corrected = storedAnalysis(
      { kind: 'quote', payload: source, attachments: [] },
      { [countPath]: 5 },
    ).analysis;
    expect(corrected.groups.map(({ quantity, roomsTotal, fields }) => ({ quantity, roomsTotal, field: fields.quantity }))).toEqual([
      { quantity: 5, roomsTotal: 25, field: 'staff_corrected' },
      { quantity: 20, roomsTotal: 25, field: 'extracted' },
    ]);
    expect(corrected.missingQuoteReplyFields).toEqual([]);

    const unresolved = storedAnalysis(
      { kind: 'quote', payload: source, attachments: [] },
      { [countPath]: null },
    ).analysis;
    expect(unresolved.groups.map(({ quantity, fields }) => ({ quantity, field: fields.quantity }))).toEqual([
      { quantity: undefined, field: 'missing' },
      { quantity: 20, field: 'missing' },
    ]);
    expect(unresolved.missingQuoteReplyFields).toContain('Number of rooms for stay 1');
  });

  it('rechecks the mismatch marker after staff corrects the stay-wide adult total', () => {
    const source = payload();
    source.stays[0]!.rows = [
      { id: ROW, roomType: 'Double/Twin', rooms: 2, adultsPerRoom: 2, childAges: [], board: null },
    ];
    const totalAdultsPath = `stays[${STAY}].totalAdults`;

    const unresolved = storedAnalysis({ kind: 'quote', payload: source, attachments: [] }, {}).analysis;
    expect(unresolved.groups[0]?.fields.adults).toBe('missing');

    const corrected = storedAnalysis(
      { kind: 'quote', payload: source, attachments: [] },
      { [totalAdultsPath]: 4 },
    ).analysis;
    expect(corrected.groups[0]).toMatchObject({
      adultsTotal: 4,
      adults: 2,
      quantity: 2,
      fields: { adultsTotal: 'staff_corrected' },
    });
    expect(corrected.groups[0]?.fields.adults).not.toBe('missing');
    expect(corrected.missingQuoteReplyFields).not.toContain('Number of guests per room for stay 1');
  });

  it('keeps a rejected checkout warning on its identified stay', () => {
    const source = payload();
    const base = source.stays[0]!;
    source.stays = [
      {
        ...base,
        id: 'stay-valid',
        requested: { arrival: '2027-10-26', departure: null },
      },
      {
        ...base,
        id: 'stay-rejected',
        requested: { arrival: '2027-11-17', departure: null },
      },
    ];
    source.missing = [{
      field: 'stayDates',
      question: 'Departure date must be after arrival; confirm the requested stay dates.',
      stayId: 'stay-rejected',
    }] as typeof source.missing;

    const analysis = storedAnalysis({ kind: 'quote', payload: source, attachments: [] }, {}).analysis;

    expect(analysis.groups[0]).toMatchObject({
      stayId: 'stay-valid',
      departureDate: '2027-10-27',
      fields: { departureDate: 'defaulted' },
    });
    expect(analysis.groups[1]).toMatchObject({
      stayId: 'stay-rejected',
      fields: { departureDate: 'missing' },
    });
    expect(analysis.missingQuoteReplyFields).toContain('Departure date for stay 2');
  });

  it('lets one corrected row complete an allocation when the other row was already known', () => {
    const source = payload();
    source.missing = [{ field: 'adultsPerRoom', question: 'Confirm adults per room.' }];
    source.stays[0]!.rows = [
      { id: 'row_1', roomType: 'Standard King', rooms: 1, adultsPerRoom: 2, childAges: [], board: null },
      { id: 'row_2', roomType: 'Standard King', rooms: 1, adultsPerRoom: null, childAges: [], board: null },
    ];

    const corrected = storedAnalysis(
      { kind: 'quote', payload: source, attachments: [] },
      { [`stays[${STAY}].rows[row_2].adults`]: 3 },
    ).analysis;

    expect(corrected.groups.map(({ adults, fields }) => ({ adults, field: fields.adults }))).toEqual([
      { adults: 2, field: 'extracted' },
      { adults: 3, field: 'staff_corrected' },
    ]);
    expect(corrected.missingQuoteReplyFields).toEqual([]);
  });

  it('keeps an empty-age warning when the child total is unstated', () => {
    const source = payload();
    source.stays[0]!.totalChildren = null;
    source.stays[0]!.totalAdults = 6;
    source.missing = [{ field: 'childAges', question: 'Confirm the children’s ages.' }];

    const unresolved = storedAnalysis({ kind: 'quote', payload: source, attachments: [] }, {}).analysis;
    expect(unresolved.groups[0]).toMatchObject({ childrenAges: [], fields: { childAges: 'missing' } });
    expect(unresolved.missingQuoteReplyFields).toContain('Child ages for stay 1');

    const corrected = storedAnalysis(
      { kind: 'quote', payload: source, attachments: [] },
      { [`stays[${STAY}].rows[${ROW}].childAges`]: [7] },
    ).analysis;
    expect(corrected.groups[0]).toMatchObject({ childrenAges: [7], fields: { childAges: 'staff_corrected' } });
    expect(corrected.missingQuoteReplyFields).not.toContain('Child ages for stay 1');
  });

  it('scopes a legacy empty-age warning to other stays after staff confirms none for one stay', () => {
    const source = payload();
    delete source.stays[0]!.totalChildren;
    const secondStay = {
      ...source.stays[0]!,
      id: 'stay_2',
      requested: { arrival: '2027-11-26', departure: '2027-11-28' },
      rows: source.stays[0]!.rows.map((row) => ({ ...row, id: 'row_2' })),
    };
    source.stays.push(secondStay);
    source.missing = [{ field: 'childAges', question: 'Confirm the children’s ages.' }];

    const analysis = storedAnalysis(
      { kind: 'quote', payload: source, attachments: [] },
      { [`stays[${STAY}].rows[${ROW}].childAges`]: [] },
    ).analysis;

    expect(analysis.groups[0]?.fields.childAges).toBe('staff_corrected');
    expect(analysis.groups[1]?.fields.childAges).toBe('missing');
    expect(analysis.missingQuoteReplyFields).not.toContain('Child ages for stay 1');
    expect(analysis.missingQuoteReplyFields).toContain('Child ages for stay 2');
  });
});
