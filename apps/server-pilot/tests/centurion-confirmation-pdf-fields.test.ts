import { describe, expect, it } from 'vitest';
import {
  confirmationNumberCandidates,
  extractPdfFields,
  identifierValues,
} from '../scripts/centurion-confirmation-pdf-fields.js';

describe('Centurion confirmation PDF fields', () => {
  it('extracts Markdown-emphasized fields sharing a line', () => {
    const fields = extractPdfFields([{
      page: 0,
      markdown: '| **Guest Name:** Sample Guest | **Confirmation Number:** 123456-1 | **Arrival Date:** 01 Jan 2027 | **Departure Date:** 03 Jan 2027 |',
    }]);
    expect(fields.guestName).toEqual([{ value: 'Sample Guest', pageNumber: 1, label: 'Guest Name' }]);
    expect(fields.confirmationNumber).toEqual([{ value: '123456-1', pageNumber: 1, label: 'Confirmation Number' }]);
    expect(fields.arrivalDate[0]?.value).toBe('01 Jan 2027');
    expect(fields.departureDate[0]?.value).toBe('03 Jan 2027');
  });

  it('extracts exact confirmation candidates and labeled rates', () => {
    const fields = extractPdfFields([{
      page: 2,
      markdown: '**Confirmation Number:** No. 123456-1 / 76543210\n**Average Daily Rate:** USD 149.00\n**Total Accommodation for stay:** USD 298.00 Proforma',
    }]);
    expect(confirmationNumberCandidates(fields)).toEqual([
      { value: '123456-1', pageNumber: 3 },
      { value: '76543210', pageNumber: 3 },
    ]);
    expect(fields.averageDailyRate[0]?.value).toBe('USD 149.00');
    expect(fields.totalAccommodation[0]?.value).toBe('USD 298.00');
  });

  it('does not match identifiers inside longer alphanumeric tokens', () => {
    expect([...identifierValues('A123456B 123456-123 123456-1B 123456-1 000001')]).toEqual(['123456-1', '000001']);
  });
});
