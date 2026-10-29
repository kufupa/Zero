import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCommercialReadback } from './commercial-readback.mjs';

const expected = {
  confirmation: '12345678-1', firstName: 'Proof', lastName: 'Labtest',
  arrival: '2027-12-20', departure: '2027-12-22', ratePlan: 'BAR',
  bookingAgency: { name: 'Example Travel', nativeId: '42', iata: '12345678' },
};
const lookup = {
  outcome: 'found', conflicts: [],
  stay: {
    confirmation: '12345678-1', firstName: 'Proof', lastName: 'Labtest',
    arrival: '2027-12-20', departure: '2027-12-22', status: 'Reserved', ratePlan: 'BAR',
    bookingAgency: 'Example Travel', averageRate: '1250.00', grandTotal: '2500.00',
  },
  commercial: { ratePlan: 'BAR', agency: { name: 'Example Travel', nativeId: '42', iata: '12345678' } },
};
const identityProof = { confNo: '12345678-1', readbackMatch: true };

test('matching text and IATA do not prove the native agency or nightly prices', () => {
  assert.deepEqual(compareCommercialReadback({ expected, lookup, identityProof }), {
    identity: 'matched', ratePlanText: 'same', agencyName: 'same', agencyIata: 'same',
    agencyNativeId: 'unknown', nightlyPrices: 'unknown', complete: false,
  });
});

test('different display text is reported without inferring a native identifier or nightly price', () => {
  const changed = {
    ...lookup,
    stay: { ...lookup.stay, ratePlan: 'CORPORATE', bookingAgency: 'Other Travel' },
    commercial: { ratePlan: 'Corporate', agency: { name: 'Other Travel', iata: '87654321' } },
  };
  assert.deepEqual(compareCommercialReadback({ expected, lookup: changed, identityProof }), {
    identity: 'matched', ratePlanText: 'different', agencyName: 'different', agencyIata: 'different',
    agencyNativeId: 'unknown', nightlyPrices: 'unknown', complete: false,
  });
});

test('missing, conflicting, or differently formatted observations remain unknown', () => {
  const changed = {
    ...lookup,
    stay: { ...lookup.stay, ratePlan: 'CORP10', bookingAgency: 'Example Travel' },
    commercial: { ratePlan: 'Corporate Saver', agency: { name: 'Another Travel' } },
  };
  const result = compareCommercialReadback({ expected, lookup: changed, identityProof });
  assert.equal(result.ratePlanText, 'unknown');
  assert.equal(result.agencyName, 'unknown');
  assert.equal(result.agencyIata, 'unknown');
  assert.equal(result.nightlyPrices, 'unknown');
});

test('the original parser conflicts keep a matching fallback label unknown', () => {
  const result = compareCommercialReadback({
    expected, lookup: { ...lookup, conflicts: ['ratePlan', 'bookingAgency'] }, identityProof,
  });
  assert.equal(result.identity, 'matched');
  assert.equal(result.ratePlanText, 'unknown');
  assert.equal(result.agencyName, 'unknown');
});

test('a missing or mismatched independent identity proof exposes no comparisons', () => {
  const notBound = [
    { expected, lookup, identityProof: null },
    { expected, lookup, identityProof: { ...identityProof, readbackMatch: null } },
    { expected, lookup, identityProof: { ...identityProof, confNo: '99999999-1' } },
    { expected, lookup: { ...lookup, outcome: 'not_found' }, identityProof },
    { expected, lookup: { ...lookup, stay: { ...lookup.stay, confirmation: '99999999-1' } }, identityProof },
    { expected, lookup: { ...lookup, stay: { ...lookup.stay, departure: '2027-12-23' } }, identityProof },
    { expected, lookup: { ...lookup, stay: { ...lookup.stay, status: 'Cancelled' } }, identityProof },
    { expected, lookup: { ...lookup, conflicts: ['firstName'] }, identityProof },
    { expected, lookup: { ...lookup, conflicts: undefined }, identityProof },
    {
      expected: { ...expected, arrival: '2027-02-30' },
      lookup: { ...lookup, stay: { ...lookup.stay, arrival: '2027-02-30' } }, identityProof,
    },
  ];
  for (const input of notBound) {
    assert.deepEqual(compareCommercialReadback(input), {
      identity: 'unknown', ratePlanText: 'unknown', agencyName: 'unknown', agencyIata: 'unknown',
      agencyNativeId: 'unknown', nightlyPrices: 'unknown', complete: false,
    });
  }
});
