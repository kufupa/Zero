import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fulfillGuestLookupRequest, guestLookupMayRequest, installGuestLookupGuard, searchGuestInCloud } from './pane-guest-search.mjs';

const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const request = (path, data, method = 'POST') => ({ method, url: `${origin}${path}`,
  postData: data, contentType: 'application/x-www-form-urlencoded; charset=UTF-8' });
const empty = (keys) => keys.map((key) => `${key}=`).join('&');
const hdr = 'SYSTEM_FUNCTION_NAME=OSRESV&USER_FUNCTION_NAME=OSRESV&CURRENT_TAB_NAME=HDR&' + empty([
  'account', 'bookingdotcomid', 'confirmationnumber', 'facebookid', 'firstname', 'guestfullname', 'guestid', 'hoteldate',
  'lastname', 'menu_module_key', 'propertycode', 'removescreenflows', 'reservationstayid', 'room', 'tripadvisorid', 'twitterid',
]);

test('lookup guard admits only the observed login and read request shapes', () => {
  for (const input of [
    request('/web/base/login', 'SYSTEM_FUNCTION_NAME=LOGIN&USER_FUNCTION_NAME=LOGIN&userid=x&password=x&csrftckt=x&resetpassword=&tenant=THECENTURION_PRD'),
    request('/web/base/OSRESV?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESV',
      'SYSTEM_FUNCTION_NAME=OSRESV&USER_FUNCTION_NAME=OSRESV&CURRENT_TAB_NAME=&function_class=WEBL&menu_module_key=&removescreenflows='),
    request('/web/base/OSRESS?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESS',
      'SYSTEM_FUNCTION_NAME=OSRESS&USER_FUNCTION_NAME=OSRESS&CURRENT_TAB_NAME=&function_class=WEBL&menu_module_key=&removescreenflows='),
    request('/web/base/OSRESV.HDR', hdr),
    request('/web/base/OSRESS.search', 'SYSTEM_FUNCTION_NAME=OSRESS&USER_FUNCTION_NAME=OSRESV&CURRENT_TAB_NAME=LST&' +
      'maddon_filter_value_1=x&component_info_type=&dataspy_id=&externalconfirmation=&grid_id=&grid_name='),
    { method: 'GET', url: `${origin}/web/base/logindisp?tenant=THECENTURION_PRD`, postData: null },
    { method: 'GET', url: `${origin}/web/resources/inforhms/images/toolbar/save.svg` },
    { method: 'GET', url: `${origin}/web/base/COMMON?req_key=observed` },
  ]) assert.equal(guestLookupMayRequest(input), true);
});

test('lookup guard denies unknown POSTs, upload, altered shapes and mutation actions', () => {
  for (const input of [
    request('/web/base/unknown', hdr),
    request('/web/base/BSUPLD.upload', hdr),
    request('/web/base/OSRESV.HDR?pageaction=SAVE', hdr),
    request('/web/base/OSRESV.HDR', `${hdr}&pageaction=SAVE`),
    request('/web/base/OSRESV.HDR', `${hdr}&operation=write`),
    request('/web/base/OSRESV.HDR', `${hdr}&CURRENT_TAB_NAME=HDR`),
    request('/web/base/OSRESV.HDR', hdr.replace('&account=', '')),
    request('/web/base/OSRESV.HDR', hdr.replace('CURRENT_TAB_NAME=HDR', 'CURRENT_TAB_NAME=LST')),
    request('/web/base/OSRESV?FUNCTION_CLASS=MAIN&USER_FUNCTION_NAME=OSRESV',
      'SYSTEM_FUNCTION_NAME=OSRESV&USER_FUNCTION_NAME=OSRESV&CURRENT_TAB_NAME=&function_class=WEBL&menu_module_key=&removescreenflows='),
    request('/web/base/OSRESS?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESS',
      'SYSTEM_FUNCTION_NAME=OSRESS&USER_FUNCTION_NAME=OSRESS&CURRENT_TAB_NAME=&function_class=MAIN&menu_module_key=&removescreenflows='),
    request('/web/base/login', 'SYSTEM_FUNCTION_NAME=LOGIN&USER_FUNCTION_NAME=LOGIN&userid=x&password=x&csrftckt=x&resetpassword=&tenant=OTHER'),
    request('/web/base/login', 'SYSTEM_FUNCTION_NAME=LOGIN&USER_FUNCTION_NAME=LOGIN&userid=x&password=x&csrftckt=x&resetpassword=true&tenant=THECENTURION_PRD'),
    { ...request('/web/base/OSRESV.HDR', hdr), contentType: 'application/json' },
    { ...request('/web/base/OSRESV.HDR', hdr), url: 'https://other.invalid/web/base/OSRESV.HDR' },
    request('/web/base/OSRESV.HDR', hdr, 'DELETE'),
    { method: 'GET', url: 'https://other.invalid/web/resources/shared/script.js' },
    { method: 'GET', url: `${origin}/web/base/unreviewed` },
    { method: 'GET', url: `${origin}/web/base/logindisp?tenant=OTHER` },
    { method: 'HEAD', url: `${origin}/web/base/logindisp?tenant=THECENTURION_PRD` },
    { method: 'OPTIONS', url: `${origin}/web/base/logindisp?tenant=THECENTURION_PRD` },
    { method: 'GET', url: `${origin}/web/base/OSRESV.HDR?pageaction=SAVE` },
    { method: 'GET', url: `${origin}/web/base/BSUPLD.upload` },
    { method: 'GET', url: `${origin}/web/base/BSUPLD.%75pload` },
  ]) assert.equal(guestLookupMayRequest(input), false);
});

test('read fence never follows a redirect to a second endpoint', { timeout: 30000 }, async () => {
  let targetHits = 0;
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/target' }); res.end(); return; }
    if (req.url === '/target') targetHits++;
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const require = createRequire(new URL('../stagehand/package.json', import.meta.url));
  const browser = await require('playwright').chromium.launch({ headless: true,
    executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined });
  try {
    const context = await browser.newContext();
    await context.route('**/*', fulfillGuestLookupRequest);
    const page = await context.newPage();
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await page.goto(`${base}/ok`)).status(), 200);
    await assert.rejects(page.goto(`${base}/redirect`));
    assert.equal(targetHits, 0);
    await context.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('lookup guard blocks sockets and routes requests through the allowlist', async () => {
  let onSocket, onRequest;
  await installGuestLookupGuard({ routeWebSocket: async (_pattern, handler) => { onSocket = handler; },
    route: async (_pattern, handler) => { onRequest = handler; } });
  let closed = false, continued = false, aborted = false;
  onSocket({ close: () => { closed = true; } });
  await onRequest({ request: () => ({ method: () => 'POST', url: () => `${origin}/web/base/BSUPLD.upload`,
    postData: () => 'ignored', headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }) }),
  continue: async () => { continued = true; }, abort: async () => { aborted = true; } });
  assert.equal(closed, true); assert.equal(aborted, true); assert.equal(continued, false);
});

function fakePage({ expanded = true, property = true } = {}) {
  const calls = [];
  const guest = { isVisible: async () => expanded, waitFor: async () => {}, count: async () => 1,
    click: async () => { calls.push('guest'); } };
  const front = { waitFor: async () => {}, count: async () => 1,
    locator: () => ({ getAttribute: async () => `x-grid-row${expanded ? ' x-grid-tree-node-expanded' : ''}` }),
    click: async () => { calls.push('front'); expanded = true; } };
  const menu = { count: async () => 1, click: async () => { calls.push('menu'); } };
  const page = { context: () => ({}), evaluate: async () => property,
    locator: (selector) => selector.startsWith('a.app-menu') ? menu : {
      filter: ({ hasText }) => hasText.test('Guest Stay') ? guest : front,
    }, getByPlaceholder: () => ({ first: () => ({ waitFor: async () => {} }) }) };
  return { page, calls };
}

test('owned Cloud search keeps the expanded menu and returns the existing parser result', async () => {
  const { page, calls } = fakePage();
  let options, request, guarded = false;
  const result = await searchGuestInCloud({ lastName: 'Labtest', arrival: '2027-09-14', dir: '/tmp/private' }, {
    openSession: async (fn, opts) => { options = opts; await opts.prepareContext(page.context()); return fn(page); },
    guard: async () => { guarded = true; },
    search: async (ctx) => { request = ctx.args; return { outcome: 'ok', rows: [{ confirmation: '123-1' }] }; },
  });
  assert.equal(guarded, true);
  assert.deepEqual(calls, ['menu', 'guest']);
  assert.equal(options.headless, true); assert.equal(options.blockServiceWorkers, true);
  assert.equal(request.lastName, 'Labtest'); assert.equal(request.arrival, '2027-09-14');
  assert.deepEqual(result, { outcome: 'ok', rows: [{ confirmation: '123-1' }] });
});

test('opens a collapsed menu and preserves capped-search refusal', async () => {
  const { page, calls } = fakePage({ expanded: false });
  const result = await searchGuestInCloud({ lastName: 'Labtest', arrival: '2027-09-14', dir: '/tmp/private' }, {
    openSession: async (fn, opts) => { await opts.prepareContext(page.context()); return fn(page); }, guard: async () => {},
    search: async () => ({ outcome: 'ambiguous_capped', rows: [] }),
  });
  assert.deepEqual(calls, ['menu', 'front', 'guest']);
  assert.equal(result.outcome, 'ambiguous_capped');
});

test('refuses a property mismatch before searching', async () => {
  const { page } = fakePage({ property: false });
  let searched = false;
  await assert.rejects(searchGuestInCloud({ lastName: 'Labtest', arrival: '2027-09-14', dir: '/tmp/private' }, {
    openSession: async (fn, opts) => { await opts.prepareContext(page.context()); return fn(page); },
    guard: async () => {}, search: async () => { searched = true; },
  }), /GUEST_STAY_PROPERTY_UNVERIFIED/);
  assert.equal(searched, false);
});
