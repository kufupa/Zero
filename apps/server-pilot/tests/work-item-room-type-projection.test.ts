import { describe, expect, it } from 'vitest';
import type { MailExtractionPayload } from '../src/ai/extraction/schema.js';
import { storedAnalysis } from '../src/ai/work-items.js';

describe('stored-read room type projection', () => {
  it('projects exact room types and ranked suggestions on their requirement rows', () => {
    const payload = {
      contact: { name: null, email: null, phone: null },
      agency: null,
      endClient: null,
      confirmationNumbers: [],
      stays: [
        {
          id: 'stay-1',
          hotel: null,
          requested: { arrival: '2026-11-12', departure: '2026-11-14' },
          booked: null,
          totalRooms: 2,
          rows: [
            {
              id: 'row-1',
              roomType: 'Standard Queen',
              rooms: 1,
              adultsPerRoom: 2,
              childAges: [],
              board: null,
            },
            {
              id: 'row-2',
              roomType: 'Single',
              rooms: 1,
              adultsPerRoom: 1,
              childAges: [],
              board: null,
            },
          ],
        },
      ],
      missing: [],
    } satisfies MailExtractionPayload;

    const result = storedAnalysis({ kind: 'quote', payload, attachments: [] }, {});
    expect(result.analysis.groups[0]).toMatchObject({
      id: 'row-1',
      roomPreference: 'Standard Queen',
      roomTypeCode: 'STQN',
      roomTypeSuggestions: [],
    });
    expect(result.analysis.groups[1]).toMatchObject({
      id: 'row-2',
      roomPreference: 'Single',
      roomTypeSuggestions: ['STWN', 'SKNG'],
    });
  });
});
