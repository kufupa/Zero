import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLiveGuestStayChromeGetRules,
  buildLiveGuestStayReadManifest,
} from '../../src/hms/live-read-manifest.ts';
import { enforceRequestPolicy, rejectDuplicateJsonBodyKeys } from '../../src/hms/request-policy.ts';
import { hmsProductionOriginForSlot } from '../../src/hms/browser-artifacts.ts';
import { getPropertyRegistration } from './property-registry.mjs';
import { createReadCliLease } from './read-cli-lease.mjs';
import { attachGuardedQuoteSession, installQuoteRequestGuard, prepareQuoteRequestPolicy } from './quote-request-guard.mjs';

const modules = { buildLiveGuestStayChromeGetRules, buildLiveGuestStayReadManifest,
  enforceRequestPolicy, rejectDuplicateJsonBodyKeys, hmsProductionOriginForSlot };
const property = getPropertyRegistration('HRCEN');
const origin = hmsProductionOriginForSlot(property.browserSlot);
const secret = { loginUrl: `${origin}/web/base/logindisp?tenant=${property.expectedTenant}`,
  expectedTenant: property.expectedTenant, expectedPropertyCode: property.propertyCode,
  expectedPropertyName: property.expectedPropertyName, username: property.username, password: 'fixture-only' };
const policy = () => prepareQuoteRequestPolicy({ secret, property, modules });
const script = `${origin}/web/resources/shared/scripts/jquery-3.6.0.min.js`;

function fakeContext() {
  const events = [], listeners = new Map();
  let requestHandler, socketHandler, closed = 0;
  return {
    events,
    get closed() { return closed; },
    async route(pattern, handler) { assert.equal(pattern, '**/*'); events.push('route'); requestHandler = handler; },
    async routeWebSocket(pattern, handler) { assert.equal(pattern, '**/*'); events.push('websocket'); socketHandler = handler; },
    on(name, handler) { listeners.set(name, handler); },
    async newPage() {
      events.push('newPage');
      const handlers = new Map();
      const page = { on: (name, fn) => handlers.set(name, fn), setDefaultTimeout() {},
        async close() { events.push('pageClosed'); }, emit: (name, value) => handlers.get(name)?.(value) };
      listeners.get('page')?.(page);
      return page;
    },
    async close() { closed += 1; events.push('contextClosed'); },
    async request(route) { return requestHandler(route); },
    socket(socket) { socketHandler(socket); },
  };
}

function fakeRoute({ url = script, method = 'GET', resourceType = 'script', body = null,
  headers = {}, status = 200, failFetch = false, waitAbort } = {}) {
  const calls = [];
  const response = { status: () => status };
  return {
    calls,
    request: () => ({ url: () => url, method: () => method, resourceType: () => resourceType,
      headers: () => headers, postData: () => body, redirectedFrom: () => null }),
    async abort(code) { calls.push(['abort', code]); if (waitAbort) await waitAbort(); },
    async continue() { calls.push(['continue']); },
    async fetch(options) { calls.push(['fetch', options]); if (failFetch) throw new Error('fixture transport'); return response; },
    async fulfill(options) { assert.equal(options.response, response); calls.push(['fulfill']); },
  };
}

async function routed(input) {
  const context = fakeContext();
  const guard = await installQuoteRequestGuard(context, await policy());
  const route = fakeRoute(input);
  await context.request(route);
  return { context, guard, route };
}

test('only the reviewed Centurion property, tenant, credential identity and origin can create a quote policy', async () => {
  const allowed = await policy();
  assert.ok(allowed.manifest.rules.length > 0);
  assert.ok(allowed.manifest.rules.every((rule) => rule.origin === origin));
  assert.equal(allowed.manifest.rules.some((rule) => /OSRESV|inquiryForGrid/.test(rule.path)), false);
  assert.equal(allowed.manifest.rules.some((rule) => rule.path === '/web/base/OSMPAV'), true);
  for (const change of [
    { expectedPropertyCode: 'HRDAV' }, { expectedTenant: 'OTHER' },
    { expectedPropertyName: 'Other Hotel' }, { username: 'other' },
    { loginUrl: 'https://unreviewed.example.test/web/base/logindisp' },
    { loginUrl: 'http://hmsweb.hms.eu1.inforcloudsuite.com/web/base/logindisp' },
    { loginUrl: `https://user:password@${new URL(origin).host}/web/base/logindisp` },
  ]) await assert.rejects(prepareQuoteRequestPolicy({ secret: { ...secret, ...change }, property, modules }), /HMS_QUOTE_POLICY_/);
  const other = getPropertyRegistration('HRDAV');
  await assert.rejects(prepareQuoteRequestPolicy({ property: other, modules, secret: {
    ...secret, loginUrl: `${hmsProductionOriginForSlot(other.browserSlot)}/web/base/logindisp`,
    expectedTenant: other.expectedTenant, expectedPropertyCode: other.propertyCode,
    expectedPropertyName: other.expectedPropertyName, username: other.username,
  } }), /HMS_QUOTE_POLICY_TENANT_UNREVIEWED/);
});

test('a reviewed request uses no-follow fetch and is fulfilled only after a non-redirect response', async () => {
  const { route, guard, context } = await routed();
  assert.deepEqual(route.calls, [['fetch', { maxRedirects: 0, maxRetries: 0 }], ['fulfill']]);
  assert.equal(context.closed, 0);
  assert.equal(guard.failureError(), null);
});

test('the optional ServiceNow script is blocked without fetching or ending the HMS session', async () => {
  const url = 'https://inforsaas.service-now.com/optional.js';
  const { route, guard, context } = await routed({ url });
  assert.deepEqual(route.calls, [['abort', 'blockedbyclient']]);
  assert.equal(context.closed, 0);
  assert.equal(guard.failureError(), null);
  for (const input of [
    { url, method: 'POST' },
    { url, resourceType: 'document' },
    { url: 'https://inforsaas.service-now.com.evil.example/optional.js' },
  ]) {
    const denied = await routed(input);
    assert.deepEqual(denied.route.calls, [['abort', 'blockedbyclient']]);
    assert.match(denied.guard.failureError()?.message ?? '', /^HMS_QUOTE_POLICY_BLOCKED_/);
    assert.equal(denied.context.closed, 1);
  }
});

test('only the reviewed Hotel Availability screen forms are fetched', async () => {
  const valid = {
    url: `${origin}/web/base/OSMPAV?USER_FUNCTION_NAME=OSMPAV&FUNCTION_CLASS=WEBL`,
    method: 'POST', resourceType: 'xhr', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: 'USER_FUNCTION_NAME=OSMPAV&FUNCTION_CLASS=WEBL&SYSTEM_FUNCTION_NAME=OSMPAV&CURRENT_TAB_NAME=&MENU_MODULE_KEY=0&removescreenflows=yes',
  };
  const allowed = await routed(valid);
  assert.deepEqual(allowed.route.calls, [['fetch', { maxRedirects: 0, maxRetries: 0 }], ['fulfill']]);
  for (const bad of [
    { ...valid, body: `${valid.body}&pageaction=SAVE` },
    { ...valid, body: `${valid.body}&USER_FUNCTION_NAME=OSRESV` },
    { ...valid, url: `${valid.url}&pageaction=SAVE` },
  ]) {
    const denied = await routed(bad);
    assert.deepEqual(denied.route.calls, [['abort', 'blockedbyclient']]);
    assert.equal(denied.context.closed, 1);
  }
});

test('the company picker permits only its reviewed lookup form, not a write or another grid', async () => {
  const input = {
    url: `${origin}/web/base/GRIDDATA`, method: 'POST', resourceType: 'xhr',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'GRID_ID=1134&GRID_NAME=LVCOMPANIES2&DATASPY_ID=1224&MADDON_FILTER_ALIAS_NAME_1=companyname' +
      '&MADDON_FILTER_OPERATOR_1=CONTAINS&MADDON_FILTER_JOINER_1=AND&MADDON_FILTER_SEQNUM_1=1' +
      '&MADDON_FILTER_VALUE_1=Example+Hotels&USER_FUNCTION_NAME=OSMPAV&CURRENT_TAB_NAME=HDR' +
      '&GRID_TYPE=LOV&REQUEST_TYPE=LOV.DATA_ONLY.STORED&LOV_TAGNAME=organization',
  };
  const allowed = await routed(input);
  assert.deepEqual(allowed.route.calls, [['fetch', { maxRedirects: 0, maxRetries: 0 }], ['fulfill']]);
  for (const bad of [
    { ...input, body: input.body.replace('GRID_ID=1134', 'GRID_ID=9999') },
    { ...input, body: `${input.body}&pageaction=SAVE` },
    { ...input, body: `${input.body}&MADDON_FILTER_VALUE_1=Another` },
    { ...input, body: input.body.replace('companyname', 'guestname') },
    { ...input, url: `${input.url}?action=SAVE` },
  ]) {
    const denied = await routed(bad);
    assert.deepEqual(denied.route.calls, [['abort', 'blockedbyclient']]);
    assert.equal(denied.context.closed, 1);
  }
});

test('only the typed, duplicate-free, Centurion availability inquiry is fetched', async () => {
  const body = { propertyCodes: 'HRCEN', startDate: '2027-03-15T00:00:00', numberOfDays: '14',
    lengthOfStay: 'DY', adultCount: 2, childCount: 0, salesStrategy: 'BAR', roomTypeCodes: 'STQN',
    ratePlanCodes: 'BAR', currency: null, convertFromPropertyCurrency: false, shopByDay: false,
    showCollapsedByProperty: false, showCollapsedByRoomType: false, excludeOverbookingLimits: false,
    showRestrictedSellOptions: true, showExclusiveRates: false, launchedFrom: 'hotelavailability',
    showCollapsedByBuilding: false, buildingCodes: [''], showArrivalDepartureCount: false,
    showSubGroupView: false, groupID: '', organizationID: '', travelAgencyID: '', bookingSessionID: 'opaque/token+value==' };
  const valid = { url: `${origin}/api/internalBooking/rateshop/inquiryForGrid?houseAvailabilityOnly=false`,
    method: 'POST', resourceType: 'xhr', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const allowed = await routed(valid);
  assert.deepEqual(allowed.route.calls, [['fetch', { maxRedirects: 0, maxRetries: 0 }], ['fulfill']]);
  assert.equal(allowed.guard.failureError(), null);
  for (const bad of [
    { ...valid, body: JSON.stringify({ ...body, propertyCodes: 'OTHER' }) },
    { ...valid, body: valid.body.replace('{', '{"propertyCodes":"OTHER",') },
    { ...valid, body: JSON.stringify({ ...body, pageaction: 'SAVE' }) },
    { ...valid, body: JSON.stringify({ ...body, excludeOverbookingLimits: true }) },
    { ...valid, body: JSON.stringify({ ...body, childCount: 1, childAges: [99] }) },
    { ...valid, body: JSON.stringify({ ...body, startDate: '2027-02-30T00:00:00' }) },
    { ...valid, url: `${valid.url}&pageaction=SAVE` },
    { ...valid, url: `${origin}/web/base/OSRESV.HDR?pageaction=SAVE` },
    { ...valid, url: valid.url.replace(origin, 'https://other.example.test') },
    { ...valid, method: 'PUT' },
  ]) {
    const denied = await routed(bad);
    assert.deepEqual(denied.route.calls, [['abort', 'blockedbyclient']]);
    assert.match(denied.guard.failureError()?.message ?? '', /^HMS_QUOTE_POLICY_BLOCKED_/);
    assert.equal(denied.context.closed, 1);
  }
});

test('an unreviewed HMS image is skipped without fetching, but other requests still fail closed', async () => {
  const image = `${origin}/web/resources/inforhms/images/tree/plusminus-folder-open.svg`;
  const skipped = await routed({ url: image, resourceType: 'image' });
  assert.deepEqual(skipped.route.calls, [['abort', 'blockedbyclient']]);
  assert.equal(skipped.context.closed, 0);
  for (const input of [
    { url: `${image}?action=save`, resourceType: 'image' },
    { url: image, method: 'POST', resourceType: 'image' },
    { url: image, resourceType: 'script' },
  ]) {
    const denied = await routed(input);
    assert.deepEqual(denied.route.calls, [['abort', 'blockedbyclient']]);
    assert.equal(denied.context.closed, 1);
  }
});

test('canonical policy aborts external, unreviewed, altered and mutation-shaped requests before fetching', async () => {
  const cases = [
    { url: 'https://other.example.test/web/resources/shared/scripts/jquery-3.6.0.min.js' },
    { url: `${origin}.evil.example.test/web/resources/shared/scripts/jquery-3.6.0.min.js` },
    { url: `${origin}/web/base/save`, resourceType: 'document' },
    { url: `${script}?action=save` },
    { url: script, resourceType: 'xhr' },
    { url: script, method: 'DELETE' },
    { url: `${origin}/web/base/login`, method: 'POST', resourceType: 'xhr',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'tenant=OTHER&userid=x&password=y' },
    ...['hotelAvail', 'rateshop'].map((part) => ({
      url: `${origin}/api/internalBooking/${part}/inquiryForGrid`, method: 'POST', resourceType: 'xhr',
      headers: { 'content-type': 'application/json' }, body: '{"adultCount":2,"childCount":0}',
    })),
  ];
  for (const input of cases) {
    const { route, guard, context } = await routed(input);
    assert.deepEqual(route.calls, [['abort', 'blockedbyclient']], input.url);
    assert.match(guard.failureError()?.message ?? '', /^HMS_QUOTE_POLICY_BLOCKED_/);
    assert.equal(context.closed, 1);
  }
});

test('same-origin and external redirects both stop before a response can reach the browser', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { route, guard, context } = await routed({ status });
    assert.deepEqual(route.calls, [['fetch', { maxRedirects: 0, maxRetries: 0 }], ['abort', 'blockedbyclient']]);
    assert.match(guard.failureError().message, /unreviewed_redirect/);
    assert.equal(context.closed, 1);
  }
  const { route, guard } = await routed({ failFetch: true });
  assert.deepEqual(route.calls, [['fetch', { maxRedirects: 0, maxRetries: 0 }], ['abort', 'blockedbyclient']]);
  assert.match(guard.failureError().message, /transport_error/);
});

test('a denial closes the gate before its abort resolves, so concurrent later requests cannot be fetched', async () => {
  const context = fakeContext(), guard = await installQuoteRequestGuard(context, await policy());
  let release, started;
  const abortStarted = new Promise((resolve) => { started = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  const denied = fakeRoute({ url: 'https://other.example.test/x', waitAbort: async () => { started(); await wait; } });
  const pending = context.request(denied);
  await abortStarted;
  const later = fakeRoute();
  await context.request(later);
  assert.deepEqual(later.calls, [['abort', 'blockedbyclient']]);
  release();
  await pending;
  assert.match(guard.failureError().message, /unknown_origin/);
  assert.equal(context.closed, 1);
});

test('websockets, downloads and unexpected extra pages terminate the owned context', async () => {
  {
    const context = fakeContext(), guard = await installQuoteRequestGuard(context, await policy());
    let socketClosed = 0;
    context.socket({ close: () => { socketClosed += 1; } });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(socketClosed, 1);
    assert.match(guard.failureError().message, /websocket/);
    assert.equal(context.closed, 1);
  }
  {
    const context = fakeContext(), guard = await installQuoteRequestGuard(context, await policy());
    const blank = await context.newPage(); await blank.close(); guard.permitLeasePage();
    const page = await context.newPage();
    let cancelled = 0;
    page.emit('download', { cancel: () => { cancelled += 1; } });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(cancelled, 1);
    assert.match(guard.failureError().message, /download/);
    assert.equal(context.closed, 1);
  }
  {
    const context = fakeContext(), guard = await installQuoteRequestGuard(context, await policy());
    const blank = await context.newPage(); await blank.close(); guard.permitLeasePage();
    await context.newPage(); await context.newPage();
    await Promise.resolve(); await Promise.resolve();
    assert.match(guard.failureError().message, /popup/);
    assert.equal(context.closed, 1);
  }
});

test('the real attach and lease sequence installs the guard before any page or login request', async () => {
  const context = fakeContext();
  const browser = { newContext: async () => context, close: async () => {} };
  const attached = await attachGuardedQuoteSession({ href: 'http://127.0.0.1:1', env: {},
    connectOverCDP: async () => browser, policy: await policy() });
  assert.ok(context.events.indexOf('route') < context.events.indexOf('newPage'));
  assert.ok(context.events.indexOf('websocket') < context.events.indexOf('newPage'));
  let loginRoute;
  const lease = createReadCliLease({ lookupProperty: () => property, findPage: async () => null,
    assertLockHeld: () => {}, lockKeyFor: () => 'fixture',
    loginPage: async () => { loginRoute = fakeRoute({ url: 'https://other.example.test/login', resourceType: 'document' });
      await context.request(loginRoute); } });
  let navigationStarted = false;
  await assert.rejects(lease.withPage({ propertyCode: property.propertyCode, tenantId: property.expectedTenant, secret,
    session: { phase: 'ready', generation: 1 }, lockConnection: {}, lockKey: 'fixture', context }, async () => {
    attached.guard.assertActive(); navigationStarted = true;
  }), /unknown_origin/);
  assert.deepEqual(loginRoute.calls, [['abort', 'blockedbyclient']]);
  assert.equal(navigationStarted, false);
  assert.equal(context.closed, 1);
});

test('unsafe context settings and missing event interception fail before page creation', async () => {
  let created = 0;
  await assert.rejects(attachGuardedQuoteSession({ href: 'fixture', env: {}, policy: await policy(),
    connectOverCDP: async () => ({}), createContext: async () => { created += 1; return fakeContext(); },
    attach: async ({ newContext }) => newContext({}, { serviceWorkers: 'allow', acceptDownloads: false }, {}) }),
  /HMS_QUOTE_POLICY_CONTEXT_UNSAFE/);
  assert.equal(created, 0);
  await assert.rejects(installQuoteRequestGuard({ route: async () => {}, on() {}, close: async () => {} }, await policy()),
    /HMS_QUOTE_POLICY_CONTEXT_UNSUPPORTED/);
});
