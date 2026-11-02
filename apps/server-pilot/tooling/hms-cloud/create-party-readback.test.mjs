import test from 'node:test';
import assert from 'node:assert/strict';
import { readCreateParties, compareCreatePartyRecord } from './create-party-readback.mjs';

test('rejects incomplete or mismatched identity inputs before opening HMS', async () => {
  const valid = { confirmation: '123456-1', arrival: '2028-09-19', guestId: '123' };
  for (const change of [{ confirmation: 'not-a-confirmation' }, { arrival: '2026-09-19' }, { guestId: '' },
    { arAccount: { nativeId: '75', name: 'Example' } },
    { agency: { nativeId: '', name: 'Example' } }, { organization: { nativeId: '41', name: '' } }]) {
    const result = await readCreateParties({ ...valid, ...change });
    assert.equal(result.outcome, 'unverified');
    assert.equal(result.issue, 'PARTY_READBACK_INPUT_INVALID');
  }
});


test('fresh native and visible party evidence must all match the fake stay', () => {
  const expected = { confirmation: '123456-1', guestId: '123', agency: { nativeId: '99', name: 'Agency' },
    organization: { nativeId: '41', name: 'Organization' }, arAccount: { nativeId: '75', name: 'Account', profileId: '501' } };
  const model = { propertycode: 'HRCEN', confirmationnumber: '123456-1', status: 'Reserved', guestid: '123',
    firstname: 'Proof', lastname: 'Labtest', taid1: '99', ta1: 'Agency', companyid: '41', company: 'Organization',
    araccountid: '75', araccountname: 'Account', arprofileid: '501' };
  const visible = { ta1: 'Agency', company: 'Organization', araccountname: 'Account' };
  assert.equal(compareCreatePartyRecord({ model, visible }, expected).outcome, 'verified');
  for (const [field, wrong] of [['taid1', '98'], ['companyid', null], ['arprofileid', 'other'], ['guestid', '999'], ['status', 'Cancelled']]) {
    const result = compareCreatePartyRecord({ model: { ...model, [field]: wrong }, visible }, expected);
    assert.equal(result.outcome, 'unverified');
    assert.ok(result.fields.includes(field));
  }
  assert.ok(compareCreatePartyRecord({ model, visible: { ...visible, araccountname: null } }, expected).fields.includes('araccountname_visible'));
  assert.equal(compareCreatePartyRecord(null, expected).issue, 'PARTY_RECORD_UNVERIFIED');
});
