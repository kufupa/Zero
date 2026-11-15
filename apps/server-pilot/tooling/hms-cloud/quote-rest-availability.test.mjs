import test from 'node:test';
import assert from 'node:assert/strict';
import { getPropertyRegistration } from './property-registry.mjs';
import { selectionFixture } from './fetch-quote-fixtures.mjs';
import { normalizeQuoteRestAvailability, readQuoteRestAvailability,
  validateDirectAvailabilityInquiryRequest } from './quote-rest-availability.mjs';

const property = getPropertyRegistration('HRCEN');
const body = {
  propertyCodes: 'HRCEN', startDate: '2026-09-24T00:00:00', numberOfDays: '3', lengthOfStay: 'DY',
  adultCount: 1, childCount: 0, childAges: [], salesStrategy: 'BAR', roomTypeCodes: '', ratePlanCodes: '', currency: null,
  convertFromPropertyCurrency: false, shopByDay: false, showCollapsedByProperty: false, showCollapsedByRoomType: false,
  excludeOverbookingLimits: false, showRestrictedSellOptions: false, showExclusiveRates: false, launchedFrom: 'hotelavailability',
  showCollapsedByBuilding: false, buildingCodes: [], showArrivalDepartureCount: false, showSubGroupView: false,
  groupID: '', organizationID: '', travelAgencyID: '', bookingSessionID: '',
};
const url = `${property.origin}/api/internalBooking/rateshop/inquiryForGrid?houseAvailabilityOnly=false`;
const request = () => ({ method: 'POST', url, redirect: 'manual', signal: new AbortController().signal,
  headers: { 'content-type': 'application/json', accept: 'application/json', cookie: 'session=secret',
    authorization: `Bearer ${'a'.repeat(43)}=` }, body: JSON.stringify(body) });

test('REST flag is strict and checked before session or input setup', async () => {
  for (const flag of [undefined, '', 'ON', 'true', 'off']) {
    const result = await readQuoteRestAvailability({ env: { HMS_QUOTE_REST_FAST_PATH: flag } });
    assert.equal(result.outcome, 'unsupported_context');
    assert.equal(result.issue, 'REST_FAST_PATH_DISABLED');
  }
});

test('live response without an echo preserves effective cell restrictions and marks the absent departure column', () => {
  const fixture = selectionFixture();
  fixture.data.children[0].columns = Object.fromEntries([1, 2, 3].map(i => [`col${i}`, {
    restricted: false, closed: null, combClosed: null,
  }]));
  delete fixture.rate.columns.col4;
  delete fixture.data.children[0].children[0].columns.col4;
  for (const col of Object.values(fixture.rate.columns)) Object.assign(col, {
    closed: null, closedToArrival: null, closedToDeparture: null,
  });
  fixture.rate.columns.col1.restricted = null;
  delete fixture.rate.columns.col1.israteavailable;
  fixture.rate.columns.col2.israteavailable = null;
  delete fixture.rate.columns.col2.restricted;
  const result = normalizeQuoteRestAvailability({ availabilitydata: fixture.data }, body);
  assert.ok(result);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.criteriaEchoVerified, false);
  assert.equal(result.observations[0].departure.date, '2026-09-27');
  assert.equal(result.observations[0].departure.verified, false);
  assert.equal(result.observations[0].departure.departureColumnAbsent, true);
  for (const night of result.observations[0].nightly) assert.deepEqual(night.restrictions.unknownRestrictionFlags, []);
  assert.deepEqual(result.observations[0].nightly.map(night => [night.availableCount, night.rate, night.currency]),
    Array(3).fill([3, '1780', 'ZAR']));
  fixture.rate.columns.col2.israteavailable = 'Y';
  const invalid = normalizeQuoteRestAvailability({ availabilitydata: fixture.data }, body);
  assert.ok(invalid.observations[0].nightly[1].restrictions.unknownRestrictionFlags.includes('rateCell.israteavailable'));
  delete fixture.rate.columns.col1.combClosedToArrival;
  const missing = normalizeQuoteRestAvailability({ availabilitydata: fixture.data }, body);
  assert.ok(missing.observations[0].nightly[0].restrictions.unknownRestrictionFlags.includes('isclosetoarrival'));
  assert.ok(missing.observations[0].nightly[0].restrictions.unknownRestrictionFlags.includes('rateCell.israteavailable'));
  assert.ok(missing.observations[0].nightly[0].restrictions.unknownRestrictionFlags.includes('rateCell.restricted'));
  fixture.rate.columns.col1.combClosedToArrival = false;
  fixture.rate.columns.col1.newRestriction = null;
  const unknown = normalizeQuoteRestAvailability({ availabilitydata: fixture.data }, body);
  assert.ok(unknown.observations[0].nightly[0].restrictions.unknownRestrictionFlags.includes('newRestriction'));
});

test('direct guard rejects malformed, redirected, duplicate, unscoped and write-intent requests', () => {
  assert.equal(validateDirectAvailabilityInquiryRequest(request(), 'HRCEN'), true);
  const cases = [
    { method: 'GET' }, { redirect: 'follow' }, { signal: null },
    { url: `${url}&x=1` }, { url: `${url}#x` }, { url: url.replace('https://', 'https://a:b@') },
    { url: url.replace('false', 'true') }, { headers: { 'content-type': 'text/html' } },
    { headers: { ...request().headers, authorization: 'Bearer bad' } },
    { headers: { ...request().headers, 'x-extra': '1' } },
    { body: JSON.stringify({ ...body, salesStrategy: null }) },
    { body: JSON.stringify({ ...body, bookingSessionID: 'other' }) },
    { body: JSON.stringify({ ...body, extra: 'unknown' }) },
    { headers: { ...request().headers, cookie: 'a=1; a=2' } },
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
  delete fixture.rate.columns.col2.combClosed;
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

test('retains departure restrictions and marks a missing departure column unverified', () => {
  const fixture = selectionFixture();
  fixture.data.children[0].columns = Object.fromEntries([1, 2, 3, 4].map(i => [`col${i}`, { restricted: false }]));
  fixture.rate.columns.col4.combClosedToDeparture = true;
  const normalize = () => normalizeQuoteRestAvailability({ appliedCriteria: body, availabilitydata: fixture.data }, body);
  let result = normalize();
  assert.equal(result.observations[0].departure.date, '2026-09-27');
  assert.equal(result.observations[0].departure.verified, true);
  assert.equal(result.observations[0].departure.restrictions.isclosetedeparture, true);
  fixture.data.datesList.pop();
  result = normalize();
  assert.equal(result.outcome, 'partial');
  assert.equal(result.observations[0].departure.verified, false);
  assert.equal(result.observations[0].departure.departureColumnAbsent, undefined);
  assert.ok(result.observations[0].departure.restrictions.unknownRestrictionFlags.length);
  fixture.data.children[0].children = [];
  assert.equal(normalize().outcome, 'partial');
});

test('REST response validates any echo and the selected property and dates', () => {
  const fixture = selectionFixture();
  const response = { appliedCriteria: { ...body }, availabilitydata: fixture.data };
  assert.ok(normalizeQuoteRestAvailability(response, body));
  for (const change of [{ propertyCodes: 'HRDAV' }, { organizationID: 'OTHER' }, { travelAgencyID: 'OTHER' },
    { childAges: [1] }, { adultCount: 2 }, { numberOfDays: '2' }, { startDate: '2026-09-25T00:00:00' }]) {
    assert.equal(normalizeQuoteRestAvailability({ ...response, appliedCriteria: { ...body, ...change } }, body), null);
  }
  assert.equal(normalizeQuoteRestAvailability({ availabilitydata: fixture.data }, body).criteriaEchoVerified, false);
  const bad = structuredClone(response);
  bad.availabilitydata.children[0].code = 'HRDAV';
  assert.equal(normalizeQuoteRestAvailability(bad, body), null);
  bad.availabilitydata.children[0].code = 'HRCEN';
  bad.availabilitydata.datesList[1] = '09/26/2026';
  assert.equal(normalizeQuoteRestAvailability(bad, body), null);
  assert.equal(normalizeQuoteRestAvailability({ availabilitydata: fixture.data }, { ...body, roomTypeCodes: 'OTHER' }), null);
  const empty = structuredClone(response);
  empty.availabilitydata.children[0].children = [];
  assert.equal(normalizeQuoteRestAvailability({ availabilitydata: empty.availabilitydata }, { ...body, roomTypeCodes: 'STQN' }), null);
  assert.equal(normalizeQuoteRestAvailability({ availabilitydata: fixture.data }, { ...body, startDate: 'invalid' }), null);
});
