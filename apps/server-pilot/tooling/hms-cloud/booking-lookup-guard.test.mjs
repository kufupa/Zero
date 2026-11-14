import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { installReadOnlyGuard } from './hms-read-only-guard.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';
import { installLabtestSaveRouteChain } from './saved-stay-save-route-chain.mjs';
import { marketChangeRequest, observeMarketResponse } from './guest-stay-form.mjs';

const require = createRequire(new URL('../stagehand/package.json', import.meta.url));
const { chromium } = require('playwright');
const savePath = '/web/base/OSRESV.HDR';
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const bounded = (promise) => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error('ROUTE_TEST_TIMEOUT')), 8000); timer.unref();
})]);

test('market refresh accepts only the owning new stay and safe native intent', () => {
  const page = {}, frame = { page: () => page };
  page.mainFrame = () => frame;
  const expected = { value: 'BAR', draft: { propertyCode: 'HRDAV', session: 'private-session', guest: null, ar: null,
    firstName: '', lastName: '', arrival: '', departure: '' } };
  const fields = { SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR',
    propertycode: 'HRDAV', PKID: '@[EMPTY]#@[EMPTY]#HRDAV#', status: 'New', marketsegment: 'BAR', bookingsessionid: 'private-session',
    confirmationnumber: '', guestid: '', firstname: '', lastname: '', ONLY_DATA_REQUIRED: 'true', pagemode: 'display',
    reservationstayid: '', reservationid: '', recordid: '', action: '', autosave: '0', cardnumber: '', sendemail: 'false',
    vendorAddedField: 'allowed drift' };
  const request = ({ body = new URLSearchParams(fields), url = 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR.changemarketsegment',
    requestFrame = frame } = {}) => ({ method: () => 'POST', url: () => url, frame: () => requestFrame,
    headers: () => ({ 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }), postData: () => body.toString() });
  const allowed = marketChangeRequest(page, request(), expected);
  assert.equal(allowed.allowed, true);
  assert.equal(JSON.stringify(allowed.diagnostics).includes('private-session'), false);
  const native = new URLSearchParams(fields); native.set('autosave', 'YES');
  assert.equal(marketChangeRequest(page, request({ body: native }), expected).allowed, true);
  const nativeSave = new URLSearchParams(native); nativeSave.set('action', 'SAVE');
  assert.equal(marketChangeRequest(page, request({ body: nativeSave }), expected).allowed, false);
  const duplicateAutosave = new URLSearchParams(native); duplicateAutosave.append('AutoSave', 'YES');
  assert.equal(marketChangeRequest(page, request({ body: duplicateAutosave }), expected).allowed, false);
  for (const [name, value] of [['propertycode', 'HRCEN'], ['status', 'Existing'], ['bookingsessionid', 'other'],
    ['marketsegment', 'OTHER'], ['guestid', 'unverified'], ['autosave', '1'], ['autosave', 'true'], ['autosave', 'on'],
    ['sendemail', 'true'], ['cardnumber', '1234'], ['action', 'SAVE']]) {
    const body = new URLSearchParams(fields); body.set(name, value);
    assert.equal(marketChangeRequest(page, request({ body }), expected).allowed, false, name);
  }
  const duplicate = new URLSearchParams(fields); duplicate.append('PropertyCode', 'HRDAV');
  assert.equal(marketChangeRequest(page, request({ body: duplicate }), expected).allowed, false);
  assert.equal(marketChangeRequest(page, request({ url: 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR.changemarketsegment?save=1' }), expected).allowed, false);
  assert.equal(marketChangeRequest(page, request({ requestFrame: { page: () => page } }), expected).allowed, false);
  const unverified = { ...expected, draft: { ...expected.draft, guest: { nativeId: 'guest', token: 'forged' } } };
  const guestBody = new URLSearchParams(fields); guestBody.set('guestid', 'guest');
  assert.equal(marketChangeRequest(page, request({ body: guestBody }), unverified).diagnostics.proof, false);
  const unverifiedAr = { ...expected, draft: { ...expected.draft, ar: { profileId: 'profile', accountId: 'account', token: 'forged' } } };
  const arBody = new URLSearchParams(fields); arBody.set('arprofileid', 'profile'); arBody.set('araccountid', 'account');
  assert.equal(marketChangeRequest(page, request({ body: arBody }), unverifiedAr).diagnostics.proof, false);
});

test('native market response may omit record PKID but cannot replace the new stay identity', async () => {
  const expected = { value: 'BAR', draft: { propertyCode: 'HRDAV', session: 'private-session', guest: null, ar: null,
    firstName: '', lastName: '', arrival: '', departure: '' } };
  const values = { propertycode: 'HRDAV', status: 'New', marketsegment: 'BAR', bookingsessionid: 'private-session',
    confirmationnumber: '', guestid: '', firstname: '', lastname: '', reservationstayid: '', reservationid: '', recordid: '' };
  const observe = next => observeMarketResponse({ status: () => 200,
    text: async () => JSON.stringify({ pageData: { values: next } }) }, expected);
  const native = await observe(values);
  assert.equal(native.accepted, true);
  assert.equal(native.pkidCompatible, true);
  assert.equal(Object.values(native.fields).every(Boolean), true);
  assert.equal((await observe({ ...values, PKID: '@[EMPTY]#@[EMPTY]#HRDAV#' })).pkidCompatible, true);
  assert.equal((await observe({ ...values, PKID: 'saved-stay' })).pkidCompatible, false);
  assert.equal((await observe({ ...values, PKID: '@[EMPTY]#@[EMPTY]#HRDAV#', pkid: '@[EMPTY]#@[EMPTY]#HRDAV#' })).pkidCompatible, false);
  assert.equal((await observe({ ...values, confirmationnumber: '111-22' })).fields.confirmationnumber, false);
  assert.equal((await observe({ ...values, propertycode: 'HRCEN' })).fields.propertycode, false);
});

test('the page fence survives action-route removal and passes only one approved save', { timeout: 30000 }, async () => {
  const received = [];
  const server = createServer((request, response) => {
    received.push({ method: request.method, url: request.url });
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined });
    const context = await browser.newContext();
    await installReadOnlyGuard(context);
    const page = await context.newPage();
    await page.goto(`${origin}/ready`);
    const fence = await installPageRequestFence(page, [savePath]);
    const send = (body, path = savePath) => page.evaluate(async ({ path, body }) => {
      try { return (await fetch(`${path}?pageaction=SAVE`, { method: 'POST', body })).status; }
      catch { return 'blocked'; }
    }, { path, body });
    // The header path is denied by the fence; another write path must still
    // reach and be denied by the shared context guard after route removal.
    for (const path of [savePath, '/delete']) {
      const entered = deferred(), release = deferred();
      const temporary = async (route) => {
        if (route.request().url().includes('pageaction=SAVE')) { entered.resolve(); await release.promise; }
        await route.fallback();
      };
      await page.route('**/*', temporary);
      const pending = send('pageaction=SAVE', path);
      await bounded(entered.promise);
      await bounded(page.unroute('**/*', temporary));
      release.resolve();
      assert.equal(await bounded(pending), 'blocked');
    }
    assert.equal(received.filter(({ url }) => url.includes('pageaction=SAVE')).length, 0);
    assert.equal(await page.evaluate(async () => (await fetch('/ordinary-read')).status), 200);

    const scope = fence.open(), dispatched = [];
    const chain = await installLabtestSaveRouteChain(page, {
      frame: page.mainFrame(), fence, scope, isArmed: () => true,
      matches: (request) => request.method() === 'POST' && request.url() === `${origin}${savePath}?pageaction=SAVE` &&
        request.postData() === 'proof=allowed',
      onDispatch: (request) => dispatched.push(request),
    });
    assert.equal(await bounded(send('proof=wrong')), 'blocked');
    assert.equal(await bounded(send('proof=allowed')), 200);
    assert.equal(await bounded(send('proof=allowed')), 'blocked');
    assert.equal(dispatched.length, 1);
    assert.equal(received.filter(({ url }) => url.includes('pageaction=SAVE')).length, 1);
    scope.close(); await chain.close();
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
