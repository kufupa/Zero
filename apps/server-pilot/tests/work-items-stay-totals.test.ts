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
});
