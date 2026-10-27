import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  confirmationRecipientFills,
  confirmationRecipientRefusal,
  loadCreateToolSchema,
  optionalPartyAndNoteFills,
  validateCreateRequest,
} from './create-request.mjs';
import { compareReadbackStay } from './create-lab-stay.mjs';

const RECIPIENT = { mode: 'self', address: 'staff@example.invalid' };
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

test('offline create request test does not opt into pilot RDS', () => {
  assert.notEqual(process.env.VITEST_ALLOW_PILOT_RDS, '1');
  assert.equal(/nava-zero-mail-pilot/i.test(process.env.DATABASE_URL || ''), false);
});

test('writes the per-booking recipient into emailaddress, verifies readback, and never sends mail', async () => {
  assert.deepEqual(
    confirmationRecipientFills({
      confirmationRecipient: RECIPIENT,
      bookerEmail: 'booker@example.invalid',
    }),
    { emailaddress: 'staff@example.invalid' },
  );
  assert.equal(optionalPartyAndNoteFills({ bookerEmail: 'booker@example.invalid' }).udfchar06, 'booker@example.invalid');
  assert.deepEqual(confirmationRecipientFills({}), {});
  assert.equal(confirmationRecipientRefusal({}), null);
  assert.equal(
    confirmationRecipientRefusal({ confirmationRecipient: { mode: 'self', address: 'not-an-email' } }),
    'confirmation_recipient_not_set_up',
  );
  assert.equal(
    confirmationRecipientRefusal({ confirmationRecipient: { mode: 'other', address: 'a@b.co' } }),
    'confirmation_recipient_not_set_up',
  );

  const schema = await loadCreateToolSchema();
  assert.equal(validateCreateRequest({ ...STAY, confirmationRecipient: RECIPIENT }, schema).ok, true);

  const expected = { ...STAY, confirmationRecipient: RECIPIENT };
  assert.deepEqual(
    compareReadbackStay(expected, { ...expected, emailaddress: 'staff@example.invalid' }),
    { readbackMatch: true, mismatches: [], unknownOutcome: null },
  );
  const mismatch = compareReadbackStay(expected, { ...expected, emailaddress: 'other@example.invalid' });
  assert.equal(mismatch.readbackMatch, false);
  assert.equal(mismatch.mismatches[0].field, 'emailaddress');

  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  assert.match(source, /confirmationRecipientFills/);
  assert.match(source, /confirmationRecipientRefusal/);
  assert.equal(/clickTip\([^)]*(Email confirmation|Send confirmation|CMS Send Mail)/i.test(source), false);
  assert.equal(source.includes("fillNamed(page, 'udfchkbox04'"), false);
});
