import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  confirmationRecipientFills,
  confirmationRecipientRefusal,
  loadCreateToolSchema,
  optionalPartyAndNoteFills,
  validateCreateRequest,
} from '../tooling/playwright-quote/create-request.mjs';

const RECIPIENT = { mode: 'self' as const, address: 'staff@example.invalid' };

const STAY = {
  firstName: 'Proof',
  lastName: 'Labtest',
  arrival: '2027-07-22',
  departure: '2027-07-23',
  roomType: 'STKNG',
  adults: 1,
  sourceOfBusiness: 'Walk in',
  ratePlan: 'BAR',
  track: 'BAR',
  guaranteeType: 'Non-Guaranteed Individual',
};

describe('create confirmation recipient', () => {
  it('writes the per-booking recipient into emailaddress, verifies readback, and never sends mail', async () => {
    expect(
      confirmationRecipientFills({
        confirmationRecipient: RECIPIENT,
        bookerEmail: 'booker@example.invalid',
      }),
    ).toEqual({ emailaddress: 'staff@example.invalid' });
    expect(optionalPartyAndNoteFills({ bookerEmail: 'booker@example.invalid' }).udfchar06).toBe(
      'booker@example.invalid',
    );
    expect(confirmationRecipientFills({})).toEqual({});
    expect(confirmationRecipientRefusal({})).toBeNull();
    expect(
      confirmationRecipientRefusal({ confirmationRecipient: { mode: 'self', address: 'not-an-email' } }),
    ).toBe('confirmation_recipient_not_set_up');
    expect(
      confirmationRecipientRefusal({ confirmationRecipient: { mode: 'other', address: 'a@b.co' } }),
    ).toBe('confirmation_recipient_not_set_up');

    const schema = await loadCreateToolSchema();
    expect(validateCreateRequest({ ...STAY, confirmationRecipient: RECIPIENT }, schema).ok).toBe(true);

    const source = await readFile(new URL('../tooling/playwright-quote/create-lab-stay.mjs', import.meta.url), 'utf8');
    expect(source).toContain('confirmationRecipientFills');
    expect(source).toContain('confirmationRecipientRefusal');
    expect(source).toContain("field: 'emailaddress'");
    expect(source).not.toMatch(/clickTip\([^)]*(Email confirmation|Send confirmation|CMS Send Mail)/i);
    expect(source).not.toMatch(/fillNamed\(page, 'udfchkbox04'/);
  });
});
