import test from 'node:test';
import assert from 'node:assert/strict';
import { digestCloudCreateRequest } from './create-request-binding.mjs';
import { verifyBatchSiblings } from './batch-sibling-readback.mjs';

function fixture() {
  const approvedRequest = { propertyCode: 'HRCEN', guest: { nativeId: '12', firstName: 'Proof', lastName: 'Labtest' },
    stay: { arrival: '2027-08-01', departure: '2027-08-02', adults: 2, childAges: [2, 8, 15] },
    room: { roomType: 'STQN', ratePlan: 'BAR' }, guaranteeType: 'NGI',
    sourceOfBusiness: { nativeCode: 'EMA', description: 'E-Mail' }, note: 'Reviewed',
    parties: { organization: { nativeId: '89', name: 'Company' } }, cmsMessageId: '03',
    cmsRecipient: 'staff@example.test', sendHmsConfirmation: { kind: 'never' } };
  const requestDigest = digestCloudCreateRequest(approvedRequest).normalizedRequestDigest;
  const sibling = { confirmation: '123456-1', approvedRequest, requestDigest };
  const census = { outcome: 'existing_matches', arrival: '2027-08-01', coverage: { complete: true },
    sameArrival: [{ confirmation: sibling.confirmation, firstName: 'Proof', lastName: 'Labtest',
      arrival: '2027-08-01', departure: '2027-08-02', status: 'Reserved' }] };
  return { census, sibling };
}
const read = async ({ expected }) => {
  assert.deepEqual(expected.childBands, { child1: 1, child2: 1, child3: 1 });
  assert.equal(expected.guaranteeCode, 'NGI');
  assert.equal(expected.cmsRecipient, 'staff@example.test');
  return { mismatches: [], fields: [{ name: 'udfchar09', value: '03' }] };
};
const readParties = async ({ organization }) => {
  assert.deepEqual(organization, { nativeId: '89', name: 'Company' });
  return { outcome: 'verified' };
};

test('only a matching approved sibling with fresh record and party reads permits the next room', async () => {
  const { census, sibling } = fixture();
  assert.equal(await verifyBatchSiblings(census, [sibling], { read, readParties }), true);
});

test('an incomplete census, extra guest, duplicate or changed identity never permits another save', async () => {
  const { census, sibling } = fixture();
  for (const change of [
    (x) => { x.coverage.complete = false; },
    (x) => { x.sameArrival.push({ ...x.sameArrival[0], confirmation: '999999-1' }); },
    (x) => { x.sameArrival[0].status = 'Cancelled'; },
    (x) => { x.sameArrival[0].departure = '2027-08-03'; },
    (x) => { x.sameArrival[0].firstName = 'Other'; },
  ]) {
    const altered = structuredClone(census); change(altered);
    assert.equal(await verifyBatchSiblings(altered, [sibling], { read, readParties }), false);
  }
  assert.equal(await verifyBatchSiblings({ ...census, sameArrival: [census.sameArrival[0], census.sameArrival[0]] },
    [sibling, sibling], { read, readParties }), false);
});

test('changed approval, missing record, wrong CMS or unverified party stops the batch', async () => {
  const { census, sibling } = fixture();
  assert.equal(await verifyBatchSiblings(census, [{ ...sibling, requestDigest: '0'.repeat(64) }], { read, readParties }), false);
  assert.equal(await verifyBatchSiblings(census, [sibling], { read: async () => ({ issue: 'missing' }), readParties }), false);
  assert.equal(await verifyBatchSiblings(census, [sibling], { read: async () => ({ mismatches: [], fields: [] }), readParties }), false);
  assert.equal(await verifyBatchSiblings(census, [sibling], { read, readParties: async () => ({ outcome: 'unverified' }) }), false);
  const changed = structuredClone(sibling); changed.approvedRequest.sendHmsConfirmation = { kind: 'send', recipient: 'x@example.test' };
  changed.requestDigest = digestCloudCreateRequest(changed.approvedRequest).normalizedRequestDigest;
  assert.equal(await verifyBatchSiblings(census, [changed], { read, readParties }), false);
});
