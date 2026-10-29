import { describe, expect, it, vi } from 'vitest';
import { paneCommitOutcome, reconcileCreateSave } from '../tooling/playwright-quote/create-proof-rules.mjs';

describe('in-job stay save reconciliation', () => {
  it('confirms only one new matching stay independently read back', async () => {
    const expected = {
      firstName: 'Proof', lastName: 'Labtest', arrival: '2027-12-08', departure: '2027-12-09', roomType: 'STQN',
    };
    const found = { ...expected, confirmation: '66865808-1', status: 'Reserved' };
    const readByConfirmation = vi.fn(async () => ({ outcome: 'found', stay: found }));
    const proof = await reconcileCreateSave({
      save: { confirmed: false, confirmationNumber: null }, expected, existingRows: [],
      searchByGuestDates: async () => ({ outcome: 'ok', rows: [found] }), readByConfirmation,
    });
    expect(proof).toMatchObject({ confNo: '66865808-1', readbackMatch: true });
    expect(readByConfirmation).toHaveBeenCalledWith('66865808-1');
    expect(paneCommitOutcome(proof)).toBe('committed');

    readByConfirmation.mockClear();
    const ambiguous = await reconcileCreateSave({
      save: { confirmed: false, confirmationNumber: null }, expected, existingRows: [],
      searchByGuestDates: async () => ({
        outcome: 'ok', rows: [found, { ...found, confirmation: '82126330-1' }],
      }),
      readByConfirmation,
    });
    expect(ambiguous.unknownOutcome).toBe('unresolved');
    expect(paneCommitOutcome(ambiguous)).toBe('committed_unverified');
    expect(readByConfirmation).not.toHaveBeenCalled();
  });
});
