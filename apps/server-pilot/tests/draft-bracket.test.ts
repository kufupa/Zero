import { describe, expect, it } from 'vitest';
import {
  formatMissingBracket,
  listMissingBrackets,
} from '../src/ai/draft-evidence.js';

describe('formatMissingBracket', () => {
  it('formats confirmation missing with find tool acquisition', () => {
    expect(
      formatMissingBracket({
        need: 'confirmation number',
        acquisition: 'hms_find_reservation',
      }),
    ).toBe('[MISSING: confirmation number | how: hms_find_reservation]');
  });

  it('formats write-only / hotel-grant acquisition without inventing values', () => {
    expect(
      formatMissingBracket({
        need: 'tax invoice number',
        acquisition: 'hotel grant / PMS write not allowed',
      }),
    ).toBe(
      '[MISSING: tax invoice number | how: hotel grant / PMS write not allowed]',
    );
  });

  it('formats blocked company billing trio with blocker code', () => {
    expect(
      formatMissingBracket({
        need: 'billingMode/paymentTerms/contractStatus',
        acquisition: 'BLOCKED_COMPANY_READ_SURFACE_UNPROVEN',
      }),
    ).toBe(
      '[MISSING: billingMode/paymentTerms/contractStatus | how: BLOCKED_COMPANY_READ_SURFACE_UNPROVEN]',
    );
  });

  it('rejects empty need or acquisition', () => {
    expect(() =>
      formatMissingBracket({ need: '  ', acquisition: 'x' }),
    ).toThrow(/need/i);
    expect(() =>
      formatMissingBracket({ need: 'x', acquisition: '' }),
    ).toThrow(/acquisition/i);
  });
});

describe('listMissingBrackets', () => {
  it('maps unresolved fields to brackets with tool or blocker acquisition', () => {
    const lines = listMissingBrackets([
      {
        field: 'confirmationnumber',
        acquisition: 'hms_find_reservation',
      },
      {
        field: 'billingmode',
        acquisition: 'BLOCKED_COMPANY_READ_SURFACE_UNPROVEN',
      },
    ]);
    expect(lines).toEqual([
      '[MISSING: confirmationnumber | how: hms_find_reservation]',
      '[MISSING: billingmode | how: BLOCKED_COMPANY_READ_SURFACE_UNPROVEN]',
    ]);
  });
});
