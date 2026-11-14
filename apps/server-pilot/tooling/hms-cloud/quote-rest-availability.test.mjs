import test from 'node:test';
import assert from 'node:assert/strict';
import { getPropertyRegistration } from './property-registry.mjs';
import { selectionFixture } from './fetch-quote-fixtures.mjs';
import { normalizeQuoteRestAvailability, quoteRestSessionCacheKey, readQuoteRestAvailability,
  validateDirectAvailabilityInquiryRequest } from './quote-rest-availability.mjs';

const property = getPropertyRegistration('HRCEN');
const body = {
  propertyCodes: 'HRCEN', startDate: '2026-09-24T00:00:00', numberOfDays: '3', lengthOfStay: 'DY',
  adultCount: 1, childCount: 0, childAges: [], salesStrategy: null, roomTypeCodes: '', ratePlanCodes: '', currency: null,
  convertFromPropertyCurrency: false, shopByDay: false, showCollapsedByProperty: false, showCollapsedByRoomType: false,
  excludeOverbookingLimits: false, showRestrictedSellOptions: false, showExclusiveRates: false, launchedFrom: 'hotelavailability',
  showCollapsedByBuilding: false, buildingCodes: [], showArrivalDepartureCount: false, showSubGroupView: false,
  groupID: '', organizationID: '', travelAgencyID: '', bookingSessionID: 'secret-session',
};
const url = `${property.origin}/api/internalBooking/rateshop/inquiryForGrid?houseAvailabilityOnly=false`;
const request = () => ({ method: 'POST', url, redirect: 'manual', signal: new AbortController().signal,
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('REST flag is strict and checked before session or input setup', async () => {
  for (const flag of [undefined, '', 'ON', 'true', 'off']) {
    const result = await readQuoteRestAvailability({ env: { HMS_QUOTE_REST_FAST_PATH: flag } });
    assert.equal(result.outcome, 'unsupported_context');
    assert.equal(result.issue, 'REST_FAST_PATH_DISABLED');
  }
});

test('direct guard rejects malformed, redirected, duplicate, unscoped and write-intent requests', () => {
  assert.equal(validateDirectAvailabilityInquiryRequest(request(), 'HRCEN'), true);
  const cases = [
    { method: 'GET' }, { redirect: 'follow' }, { signal: null },
    { url: `${url}&x=1` }, { url: `${url}#x` }, { url: url.replace('https://', 'https://a:b@') },
    { url: url.replace('false', 'true') }, { headers: { 'content-type': 'text/html' } },
    { body: JSON.stringify({ ...body, propertyCodes: 'HRDAV' }) },
    { body: JSON.stringify({ ...body, adultCount: 0 }) },
    { body: JSON.stringify({ ...body, childAges: [3] }) },
    { body: JSON.stringify({ ...body, extra: { pageaction: 'SAVE' } }) },
    { body: JSON.stringify(body).replace('"adultCount":1', '"adultCount":1,"adultCount":2') },
    { body: JSON.stringify(body).replace('"adultCount":1', '"adultCount":1,"adult\\u0043ount":2') },
  ];
  for (const change of cases) assert.equal(validateDirectAvailabilityInquiryRequest({ ...request(), ...change }, 'HRCEN'), false);
  assert.equal(validateDirectAvailabilityInquiryRequest(request(), 'HRDAVS'), false);
});

test('cache identity separates landing, selected property, credential version and capability', () => {
  const identity = { tenantId: 'tenant', landingPropertyCode: 'HRDAV', selectedPropertyCode: 'HRDAV',
    origin: property.origin, credentialVersionHmacSha256: 'a'.repeat(64), capabilityScope: 'read:transport-a' };
  const original = quoteRestSessionCacheKey(identity);
  assert.ok(original);
  for (const change of [{ selectedPropertyCode: 'HRDAVS' }, { tenantId: 'other' }, { landingPropertyCode: 'other' },
    { origin: 'https://other.example' }, { credentialVersionHmacSha256: 'b'.repeat(64) }, { capabilityScope: 'read:transport-b' }]) {
    assert.notEqual(quoteRestSessionCacheKey({ ...identity, ...change }), original);
  }
  assert.equal(quoteRestSessionCacheKey({ ...identity, credentialVersionHmacSha256: null }), null);
});

test('REST observations retain nightly values and restrictions without claiming DOM or Quote evidence', () => {
  const fixture = selectionFixture();
  fixture.data.children[0].columns = Object.fromEntries([1, 2, 3].map(i => [`col${i}`, { restricted: false }]));
  fixture.rate.columns.col2.isclosetoarrival = true;
  fixture.rate.columns.col3.isSomeNewRestriction = true;
  const result = normalizeQuoteRestAvailability({ appliedCriteria: body, availabilitydata: fixture.data }, body);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.evidenceKind, 'rest_availability_read');
  assert.equal(result.domCalendarVerified, false);
  assert.equal(result.screenshotsVerified, false);
  assert.equal(result.displayedRounding, 'unverified_no_dom');
  assert.equal(result.payableTotal, 'unverified');
  assert.equal(result.observations[0].nightly[0].rate, '1780');
  assert.equal(result.observations[0].nightly[0].availableCount, 3);
  assert.equal(result.observations[0].nightly[0].currency, 'ZAR');
  assert.equal(result.observations[0].nightly[1].restrictions.isclosetoarrival, true);
  assert.deepEqual(result.observations[0].nightly[2].restrictions.unknownRestrictionFlags, ['isSomeNewRestriction']);
  assert.equal(JSON.stringify(result).includes('secret-session'), false);
  assert.equal('calendar' in result, false);
});

test('property restrictions, missing native flags and invalid rate currency stay explicit', () => {
  const fixture = selectionFixture();
  fixture.data.children[0].columns = Object.fromEntries([1, 2, 3].map(i => [`col${i}`, { restricted: false }]));
  fixture.data.children[0].columns.col1.restricted = true;
  delete fixture.rate.columns.col2.israteavailable;
  fixture.rate.columns.col3.maxNights = 4;
  fixture.rate.currency = 'USD$';
  fixture.data.children[0].currency = 'ZAR';
  const result = normalizeQuoteRestAvailability({ appliedCriteria: body, availabilitydata: fixture.data }, body);
  const nights = result.observations[0].nightly;
  assert.equal(nights[0].restrictions.closedOrRestricted, true);
  assert.ok(nights[1].restrictions.unknownRestrictionFlags.includes('rateCell.israteavailable'));
  assert.ok(nights[2].restrictions.unknownRestrictionFlags.includes('maxNights'));
  assert.ok(nights.every(night => night.currency === null));
  assert.equal(result.outcome, 'partial');
});

test('REST response must echo all criteria and the selected property and dates', () => {
  const fixture = selectionFixture();
  const response = { appliedCriteria: { ...body }, availabilitydata: fixture.data };
  assert.ok(normalizeQuoteRestAvailability(response, body));
  for (const change of [{ propertyCodes: 'HRDAV' }, { organizationID: 'OTHER' }, { travelAgencyID: 'OTHER' },
    { childAges: [1] }, { adultCount: 2 }, { numberOfDays: '2' }, { startDate: '2026-09-25T00:00:00' }]) {
    assert.equal(normalizeQuoteRestAvailability({ ...response, appliedCriteria: { ...body, ...change } }, body), null);
  }
  assert.equal(normalizeQuoteRestAvailability({ availabilitydata: fixture.data }, body), null);
  const bad = structuredClone(response);
  bad.availabilitydata.children[0].code = 'HRDAV';
  assert.equal(normalizeQuoteRestAvailability(bad, body), null);
  bad.availabilitydata.children[0].code = 'HRCEN';
  bad.availabilitydata.datesList[1] = '09/26/2026';
  assert.equal(normalizeQuoteRestAvailability(bad, body), null);
});
