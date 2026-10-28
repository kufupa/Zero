import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confirmationRecipientFills,
  confirmationRecipientRefusal,
  loadCreateToolSchema,
  loadCreateRequest,
  optionalPartyAndNoteFills,
  validateCreateRequest,
} from './create-request.mjs';
import { bandChildAges, compareCmsReadback, compareReadbackStay, matchAgencyCandidate } from './create-lab-stay.mjs';

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

test('writes the per-booking recipient into emailaddress, verifies readback, and ticks CMS Send Mail', async () => {
  assert.deepEqual(
    confirmationRecipientFills({
      confirmationRecipient: RECIPIENT,
      bookerEmail: 'booker@example.invalid',
    }),
    { emailaddress: 'staff@example.invalid', udfchar13: 'staff@example.invalid' },
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
  assert.match(source, /findStayByConfirmation[\s\S]*emailaddress/);
  assert.equal(/emailaddress: formEmail/.test(source), false);
  assert.equal(/clickTip\([^)]*(Email confirmation|Send confirmation|CMS Send Mail)/i.test(source), false);
  assert.equal(source.includes("fillNamed(page, 'udfchkbox04'"), false);
  assert.match(source, /if \(confirmationSendMail\(stay\)\)[\s\S]*tickCmsSendMail/);
});

test('CMS and child counts are compared without mistaking a saved mismatch for no booking', () => {
  assert.deepEqual(bandChildAges([0, 2, 5, 12, 14, 17]), { child1: 2, child2: 2, child3: 2 });
  const result = compareCmsReadback({ udfchar09: '03', udfchar13: 'x@example.invalid', send: true },
    { udfchar09: '', udfchar13: 'x@example.invalid', send: true });
  assert.equal(result.reason, 'saved_cms_mismatch');
  assert.equal(result.mismatches[0].field, 'udfchar09');
  assert.equal(compareCmsReadback({ udfchar09: '03', udfchar13: 'x@example.invalid', send: true },
    { udfchar09: '03', udfchar13: 'x@example.invalid', send: true }).reason, null);
});

test('agency requires one exact id or one exact normalized name', () => {
  const rows = [{ nativeId: '1', displayName: 'Acme Travel' }, { nativeId: '2', displayName: 'Acme Travel' }];
  assert.equal(matchAgencyCandidate(rows, { nativeId: '2', name: 'Acme Travel' }).nativeId, '2');
  assert.equal(matchAgencyCandidate(rows, { id: '2', name: 'Acme Travel' }).nativeId, '2');
  assert.equal(matchAgencyCandidate(rows, { id: '2', nativeId: '1', name: 'Acme Travel' }), null);
  assert.equal(matchAgencyCandidate(rows, { name: 'Acme Travel' }), null);
  assert.equal(matchAgencyCandidate(rows, { name: 'Acme' }), null);
});

test('property-driven guarantee accepts CCIATA and rejects unknown labels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-request-test-'));
  const file = join(dir, 'request.json');
  try {
    await writeFile(file, JSON.stringify({ ...STAY, guaranteeType: 'CCIATA' }));
    const args = ['--property', 'HRDAV', '--request', file];
    const accepted = await loadCreateRequest(args);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.request.guaranteeType, 'Guaranteed By Credit Card and Agent');
    await writeFile(file, JSON.stringify({ ...STAY, guaranteeType: 'unknown' }));
    assert.equal((await loadCreateRequest(args)).error, 'guarantee_type_unknown');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('readback requires the requested child bands', () => {
  const expected = { ...STAY, childAges: [5, 14] };
  const actual = { ...STAY, child1: '0', child2: '1', child3: '1' };
  assert.equal(compareReadbackStay(expected, actual).readbackMatch, true);
  const mismatch = compareReadbackStay(expected, { ...actual, child3: '0' });
  assert.equal(mismatch.readbackMatch, false);
  assert.equal(mismatch.mismatches[0].field, 'child3');
});

test('empty child array skips popup', async () => {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  assert.match(source, /Array\.isArray\(stay\.childAges\) && stay\.childAges\.length\) await applyChildAges/);
});

test('non-pane save stops before cancellation on CMS or child mismatch', async () => {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const mismatch = source.indexOf("result.outcome = cms.reason ?? 'saved_child_mismatch'");
  const cancel = source.indexOf("await clickTip(page, 'Cancel')", mismatch);
  assert.ok(mismatch > 0 && cancel > mismatch);
  assert.match(source.slice(mismatch, cancel), /result\.cancelled = false;[\s\S]*return;/);
});

test('CMS controls are checked again after availability and before Save', async () => {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const availability = source.indexOf('result.clickedCheckAvailability = true');
  const save = source.indexOf("await clickTip(page, '^Save')", availability);
  assert.ok(availability >= 0 && save > availability);
  assert.match(source.slice(availability, save), /compareCmsReadback\([\s\S]*refused_cms_fields_unverified/);
});
