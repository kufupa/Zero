import test from 'node:test';
import assert from 'node:assert/strict';
import { installAvailabilityReadOnlyGuard, isAvailabilityReadRequest, shouldAbortReadOnlyRequest } from './hms-read-only-guard.mjs';

const origin = 'https://hms.example.test';
const oldPath = '/api/internalBooking/hotelAvail/inquiryForGrid';
const cloudPath = '/api/internalBooking/rateshop/inquiryForGrid';

test('read-only guard blocks the observed Cloud save action in query or form body', () => {
  const url = `${origin}/web/base/OSRESV.HDR`;
  for (const request of [
    { url: `${url}?pageaction=SAVE` },
    { url: `${url}?pageaction=LIST&PageAction=%53AVE` },
    { url, postData: 'SYSTEM_FUNCTION_NAME=OSRESV&pageaction=SAVE' },
  ]) assert.equal(shouldAbortReadOnlyRequest({ method: 'POST', ...request }), true);
  assert.equal(shouldAbortReadOnlyRequest({ method: 'GET', url: `${url}?pageaction=SAVE` }), true);
  assert.equal(shouldAbortReadOnlyRequest({ method: 'POST', url: `${url}?pageaction=LIST` }), false);
});

test('generic read-only guard blocks Guest Stay Check Availability on GET and POST', () => {
  const url = `${origin}/web/base/OSRESV.HDR.getcheckavailability`;
  for (const method of ['GET', 'POST']) {
    assert.equal(shouldAbortReadOnlyRequest({ method, url }), true);
  }
});

test('availability inquiry recognition requires POST, the exact path, and the same origin', () => {
  for (const path of [oldPath, cloudPath]) {
    assert.equal(isAvailabilityReadRequest({ method: 'POST', url: `${origin}${path}` }, origin), true);
    assert.equal(isAvailabilityReadRequest({ method: 'post', url: `${origin}${path}?page=2` }, origin), true);
    for (const url of [
      `https://other.example.test${path}`,
      `https://hms.example.test.evil.invalid${path}`,
      `https://hms.example.test:8443${path}`,
      `http://hms.example.test${path}`,
      `${origin}${path}/save`,
      `${origin}${path}Extra`,
      `${origin}${path.toLowerCase()}`,
      `${origin}${path}%2Fsave`,
      'not-a-url',
    ]) assert.equal(isAvailabilityReadRequest({ method: 'POST', url }, origin), false, url);
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'TRACE', ''])
      assert.equal(isAvailabilityReadRequest({ method, url: `${origin}${path}` }, origin), false, method);
  }
});

test('installed availability guard allows only the two same-origin inquiry POSTs', async () => {
  let handler;
  await installAvailabilityReadOnlyGuard({ route: async (pattern, fn) => {
    assert.equal(pattern, '**/*');
    handler = fn;
  } }, `${origin}/login`);
  const action = async (method, url) => {
    let result;
    await handler({
      request: () => ({ method: () => method, url: () => url }),
      abort: async () => { result = 'abort'; },
      continue: async () => { result = 'continue'; },
    });
    return result;
  };
  for (const path of [oldPath, cloudPath]) {
    assert.equal(await action('POST', `${origin}${path}`), 'continue');
    assert.equal(await action('POST', `https://other.example.test${path}`), 'abort');
    assert.equal(await action('POST', `${origin}${path}/save`), 'abort');
    for (const method of ['PUT', 'PATCH', 'DELETE'])
      assert.equal(await action(method, `${origin}${path}`), 'abort');
  }
  for (const path of ['/api/reservation/create', '/api/reservation/save', '/api/reservation/cancel', '/api/unknown'])
    assert.equal(await action('POST', `${origin}${path}`), 'abort');
  assert.equal(await action('POST', 'invalid'), 'abort');
  assert.equal(await action('TRACE', `${origin}${oldPath}`), 'abort');
  for (const method of ['GET', 'HEAD', 'OPTIONS'])
    assert.equal(await action(method, 'https://other.example.test/read'), 'continue');
});

test('availability guard rejects invalid or credential-bearing origins before installing a route', async () => {
  for (const invalid of ['not-a-url', 'file:///tmp/hms', 'https://user:password@hms.example.test']) {
    let installed = false;
    await assert.rejects(installAvailabilityReadOnlyGuard({ route: async () => { installed = true; } }, invalid),
      /hms_availability_read_origin_invalid/);
    assert.equal(installed, false);
  }
});

test('Cloud browser guard admits only the reviewed selected-property inquiry', async () => {
  const { installCloudReadGuard } = await import('./cloud-session.mjs');
  const { getPropertyRegistration } = await import('./property-registry.mjs');
  const property = getPropertyRegistration('HRDAVS');
  let handler;
  await installCloudReadGuard({ routeWebSocket: async () => {}, route: async (_pattern, fn) => { handler = fn; } }, property,
    { writer: false, verified: true, authenticated: true, switching: null, ownedPage: null });
  const body = {
    propertyCodes: 'HRDAVS', startDate: '2027-01-10T00:00:00', numberOfDays: '2', lengthOfStay: 'DY',
    adultCount: 2, childCount: 0, childAges: [], salesStrategy: null, roomTypeCodes: '', ratePlanCodes: '', currency: null,
    convertFromPropertyCurrency: false, shopByDay: false, showCollapsedByProperty: false, showCollapsedByRoomType: false,
    excludeOverbookingLimits: false, showRestrictedSellOptions: false, showExclusiveRates: false, launchedFrom: 'hotelavailability',
    showCollapsedByBuilding: false, buildingCodes: [], showArrivalDepartureCount: false, showSubGroupView: false,
    groupID: '', organizationID: '', travelAgencyID: '', bookingSessionID: 'private',
  };
  const target = `${property.origin}${cloudPath}?houseAvailabilityOnly=false`;
  const dispatch = async (url, raw, contentType = 'application/json') => {
    let action;
    await handler({ request: () => ({ method: () => 'POST', url: () => url, postData: () => raw,
      headers: () => ({ 'content-type': contentType }), resourceType: () => 'xhr', isNavigationRequest: () => false }),
    abort: async () => { action = 'abort'; }, fallback: async () => { action = 'fallback'; } });
    return action;
  };
  assert.equal(await dispatch(target, JSON.stringify(body)), 'fallback');
  for (const [url, raw, type] of [
    [target, JSON.stringify({ ...body, propertyCodes: 'HRDAV' })],
    [target, JSON.stringify({ ...body, adultCount: 0 })],
    [target, JSON.stringify(body).replace('"adultCount":2', '"adultCount":2,"adultCount":1')],
    [target, JSON.stringify({ ...body, nested: { action: 'SAVE' } })],
    [`${target}&extra=1`, JSON.stringify(body)],
    [target.replace('false', 'true'), JSON.stringify(body)],
    [target, JSON.stringify(body), 'text/plain'],
  ]) assert.equal(await dispatch(url, raw, type), 'abort');
});

test('Cloud guard preserves a page-fenced writer inquiry and rejects the same unfenced request', async () => {
  const { installCloudReadGuard } = await import('./cloud-session.mjs');
  const { getPropertyRegistration } = await import('./property-registry.mjs');
  const { installPageRequestFence } = await import('./page-request-fence.mjs');
  const property = getPropertyRegistration('HRCEN');
  let fenceHandler, cloudHandler;
  const page = { route: async (_pattern, fn) => { fenceHandler = fn; } };
  const fence = await installPageRequestFence(page, [cloudPath]);
  await installCloudReadGuard({ routeWebSocket: async () => {}, route: async (_pattern, fn) => { cloudHandler = fn; } }, property,
    { writer: true, verified: true, authenticated: true, switching: null, ownedPage: page });
  const request = { method: () => 'POST', url: () => `${property.origin}${cloudPath}?houseAvailabilityOnly=true`,
    postData: () => JSON.stringify({ propertyCodes: 'HRCEN', launchedFrom: 'gueststay' }),
    resourceType: () => 'xhr', headers: () => ({ 'content-type': 'application/json' }),
    isNavigationRequest: () => false, frame: () => ({ page: () => page }) };
  let result;
  const route = { request: () => request, abort: async () => { result = 'abort'; }, fallback: async () => { result = 'fallback'; } };
  const scope = fence.open();
  assert.equal(scope.allow(request), true);
  await fenceHandler(route);
  await cloudHandler(route);
  assert.equal(result, 'fallback');
  await cloudHandler(route);
  assert.equal(result, 'abort');
  scope.close();
});
