import test from 'node:test';
import assert from 'node:assert/strict';
import { digestCloudCreateRequest } from './create-request-binding.mjs';
import { provePositiveCreateRecovery } from './create-positive-recovery.mjs';

const request = {
  propertyCode: 'HRCEN', guest: { nativeId: '123', firstName: 'Proof', lastName: 'Labtest' },
  stay: { arrival: '2027-03-15', departure: '2027-03-17', adults: 2, childAges: [2, 8, 15] },
  room: { roomType: 'DLXKNG', ratePlan: 'BAR' }, guaranteeType: 'NGI',
  sourceOfBusiness: { nativeCode: 'EMA', description: 'Email' },
  parties: { agency: { nativeId: '55', name: 'Agency' }, organization: { nativeId: '41', name: 'Company' } },
  note: 'Stay: 15 Mar to 17 Mar\nRoom: Deluxe', cmsMessageId: '03', cmsRecipient: 'test@example.invalid',
  booker: { name: 'Reservationist', contact: 'desk@example.invalid' }, track: { lookupCode: 'BAR', display: 'Best Available' },
  guestOptIn: false, sendHmsConfirmation: { kind: 'never' },
};
const normalized = digestCloudCreateRequest(request);
const intent = { operation: 'create', propertyCode: 'HRCEN', firstName: 'Proof', lastName: 'Labtest',
  nativeGuestId: '123', approvedDigest: normalized.normalizedRequestDigest, recovery: {
    request: normalized.request, writer: {}, guaranteeDisplay: 'Non-Guaranteed Individual',
    preimage: { arrival: request.stay.arrival, departure: request.stay.departure, sameArrival: [],
      searchedDateRange: { from: '2027-03-01', to: '2027-03-30' }, coverage: { displayed: 0, total: 0, complete: true } },
  } };
const candidate = { confirmation: '1234567-1', firstName: 'Proof', lastName: 'Labtest',
  arrival: request.stay.arrival, departure: request.stay.departure, status: 'Reserved' };
const fieldValues = { arrivaldate: '15-MAR-2027', departuredate: '17-MAR-2027', adults: '2', children: '3',
  child1: '1', child2: '1', child3: '1', roomtype: 'DLXKNG', rateplan: 'BAR', reservationnote: request.note,
  guestid: '123', status: 'Reserved', firstname: 'Proof', lastname: 'Labtest', sourceofbusinessdesc: 'Email',
  company: 'Company', guaranteetype: 'Non-Guaranteed Individual', udfchkbox04: false, udfchar13: request.cmsRecipient,
  emailaddress: '', caller: request.booker.name, udfchar06: request.booker.contact, track: request.track.display,
  guestoptin4: false, udfchar09: '03' };

function fixture({ listing, values = fieldValues, nativeChanges = {}, party = { outcome: 'verified' }, screenshot = true } = {}) {
  const calls = [];
  const fields = Object.entries(values).map(([name, value]) => ({ name, value,
    ...(name === 'reservationnote' ? { rawValue: value } : {}) }));
  const nativePreimage = { source: 'record_view_ext_model', propertyCode: 'HRCEN', confirmation: candidate.confirmation,
    guestId: '123', status: 'Reserved', firstName: 'Proof', lastName: 'Labtest', arrival: candidate.arrival,
    departure: candidate.departure, roomType: 'DLXKNG', ratePlan: 'BAR', adults: 2, children: 3,
    guaranteeCode: 'NGI', ...nativeChanges };
  return { calls, options: {
    census: async () => { calls.push('census'); return listing ?? { outcome: 'existing_matches',
      arrival: candidate.arrival, departure: candidate.departure,
      searchedDateRange: { from: '2027-03-01', to: '2027-03-30' },
      coverage: { displayed: 1, total: 1, complete: true }, sameArrival: [candidate] }; },
    withSavedSession: async (operation, options) => {
      calls.push(['fresh-read', options]);
      return operation({ runTool: async () => ({ outcome: 'ok', record: { nativePreimage, details: { fields } } }),
        screenshotRecord: async () => screenshot ? Buffer.from('synthetic screenshot') : null });
    },
    partyReadback: async (value) => { calls.push(['party', value]); return party; },
  } };
}

test('a unique positive fresh read verifies all approved fields, parties, and a record screenshot', async () => {
  const f = fixture(), result = await provePositiveCreateRecovery(intent, f.options);
  assert.equal(result.outcome, 'verified', JSON.stringify({ result, calls: f.calls }));
  assert.equal(result.confirmation, candidate.confirmation);
  assert.deepEqual(result.readback.mismatches, []);
  assert.ok(Buffer.isBuffer(result.screenshot));
  assert.equal(f.calls[0], 'census');
  assert.deepEqual(f.calls[1], ['fresh-read', { readOnly: true, readOnlyConfirmation: candidate.confirmation,
    cloudTargetKey: '["HRCEN","create","proof","labtest","2027-03-15"]' }]);
  assert.deepEqual(f.calls[2][1].agency, request.parties.agency);
  assert.deepEqual(f.calls[2][1].organization, request.parties.organization);
});

test('changed authorization, incomplete census and ambiguity never reach fresh read', async () => {
  const f = fixture();
  assert.equal((await provePositiveCreateRecovery({ ...intent, approvedDigest: '0'.repeat(64) }, f.options)).outcome, 'unconfirmed');
  assert.equal((await provePositiveCreateRecovery({ ...intent, recovery: { ...intent.recovery,
    preimage: { ...intent.recovery.preimage, sameArrival: [candidate, candidate] } } }, f.options)).outcome, 'unconfirmed');
  const listing = { outcome: 'existing_matches', arrival: candidate.arrival, departure: candidate.departure,
    searchedDateRange: { from: '2027-03-01', to: '2027-03-30' }, coverage: { displayed: 2, total: 2, complete: true },
    sameArrival: [candidate, { ...candidate, confirmation: '1234568-1' }] };
  assert.equal((await provePositiveCreateRecovery(intent, fixture({ listing }).options)).outcome, 'unconfirmed');
  listing.sameArrival = [candidate]; listing.coverage.complete = false;
  assert.equal((await provePositiveCreateRecovery(intent, fixture({ listing }).options)).outcome, 'unconfirmed');
  assert.deepEqual(f.calls, []);
});

test('recovery excludes sealed earlier rooms and requires one uniquely new matching stay', async () => {
  const prior = { ...candidate, confirmation: '1234560-1', departure: '2027-03-16' };
  const batchIntent = structuredClone(intent);
  batchIntent.recovery.preimage.sameArrival = [prior];
  batchIntent.recovery.preimage.coverage = { displayed: 1, total: 1, complete: true };
  const listing = { outcome: 'existing_matches', arrival: candidate.arrival, departure: candidate.departure,
    searchedDateRange: { from: '2027-03-01', to: '2027-03-30' },
    coverage: { displayed: 2, total: 2, complete: true }, sameArrival: [prior, candidate] };
  const result = await provePositiveCreateRecovery(batchIntent, fixture({ listing }).options);
  assert.equal(result.outcome, 'verified');
  assert.equal(result.confirmation, candidate.confirmation);
  for (const sameArrival of [[candidate], [prior, prior], [{ ...prior, status: 'Cancelled' }, candidate],
    [prior, candidate, { ...candidate, confirmation: '1234568-1' }]]) {
    assert.equal((await provePositiveCreateRecovery(batchIntent, fixture({ listing: { ...listing, sameArrival } }).options)).outcome,
      'unconfirmed');
  }
});

test('changed saved data, native guarantee, party or missing screenshot keep the hold unresolved', async () => {
  for (const options of [
    { values: { ...fieldValues, reservationnote: 'changed' } },
    { values: { ...fieldValues, udfchkbox04: true } },
    { values: { ...fieldValues, udfchar09: '04' } },
    { nativeChanges: { guaranteeCode: 'GTDAGT' } },
    { party: { outcome: 'unverified' } },
    { screenshot: false },
  ]) {
    assert.equal((await provePositiveCreateRecovery(intent, fixture(options).options)).outcome, 'unconfirmed');
  }
});

test('real-guest recovery binds the approved name, native credit-card guarantee and party readback', async () => {
  const realRequest = { ...request, guest: { nativeId: '123', firstName: 'Ada', lastName: 'Moyo' }, guaranteeType: 'GTDCC' };
  const binding = digestCloudCreateRequest(realRequest);
  const realIntent = { ...intent, firstName: 'Ada', lastName: 'Moyo', approvedDigest: binding.normalizedRequestDigest,
    recovery: { ...intent.recovery, request: binding.request, guaranteeDisplay: 'Guaranteed By Credit Card' } };
  const row = { ...candidate, firstName: 'Ada', lastName: 'Moyo' };
  const listing = { outcome: 'existing_matches', arrival: row.arrival, departure: row.departure,
    searchedDateRange: { from: '2027-03-01', to: '2027-03-30' },
    coverage: { displayed: 1, total: 1, complete: true }, sameArrival: [row] };
  const f = fixture({ listing, values: { ...fieldValues, firstname: 'Ada', lastname: 'Moyo',
    guaranteetype: 'Guaranteed By Credit Card' }, nativeChanges: { firstName: 'Ada', lastName: 'Moyo', guaranteeCode: 'GTDCC' } });
  assert.equal((await provePositiveCreateRecovery(realIntent, f.options)).outcome, 'verified');
  assert.equal(f.calls[1][1].cloudTargetKey, '["HRCEN","create","ada","moyo","2027-03-15"]');
  assert.equal(f.calls[2][1].firstName, 'Ada');
  assert.equal((await provePositiveCreateRecovery({ ...realIntent, lastName: 'Other' }, f.options)).outcome, 'unconfirmed');
});
