import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesRealDateStagePreimage } from './saved-stay-real-preimage.mjs';

const expected = { confirmation: '12345678-1', guestId: '42', firstName: 'Example', lastName: 'Guest',
  arrival: '2026-11-15', departure: '2026-11-20', roomType: 'EXKNG', ratePlan: 'NCOR1B' };
const fields = { propertycode: 'HRCEN', status: 'Reserved', confirmationnumber: expected.confirmation,
  guestid: expected.guestId, firstname: expected.firstName, lastname: expected.lastName,
  arrivaldate: '11/15/2026', departuredate: '11/20/2026', roomtype: expected.roomType, rateplan: expected.ratePlan };
const baseline = () => ({ data: { ...fields }, values: { ...fields, arrivaldate: '15-NOV-2026', departuredate: '20-NOV-2026' },
  formDirty: false, recordDirty: false, dirtyFields: [], modifiedFields: [], partyControls: [], partyInputsBlank: false });

test('requires exact reserved identity and a clean, unambiguous form and model', () => {
  assert.equal(matchesRealDateStagePreimage(baseline(), expected), true);
  for (const [part, key, value] of [
    ['data', 'propertycode', 'HRDAV'], ['data', 'status', 'Checked Out'], ['data', 'guestid', '99'],
    ['data', 'confirmationnumber', '12345679-1'], ['values', 'lastname', 'Other'],
    ['values', 'departuredate', '21-NOV-2026'], ['data', 'FIRSTNAME', 'Example'],
  ]) {
    const bad = baseline(); bad[part][key] = value;
    assert.equal(matchesRealDateStagePreimage(bad, expected), false, key);
  }
  const dirty = baseline(); dirty.formDirty = true;
  assert.equal(matchesRealDateStagePreimage(dirty, expected), false);
  assert.equal(matchesRealDateStagePreimage(baseline(), { ...expected, arrival: '2026-02-30' }), false);
  assert.equal(matchesRealDateStagePreimage(baseline(), { ...expected, save: true }), false);
});
