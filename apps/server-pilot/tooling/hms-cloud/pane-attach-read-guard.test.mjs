import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fulfillGuestLookupRequest } from './pane-guest-search.mjs';
import { filingDocumentsMayRequest, installPaneAttachReadGuard } from './pane-attach-read-guard.mjs';

const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const native = { propertyCode: 'HRCEN', confirmation: '123-1', firstName: 'Proof', lastName: 'Labtest',
  status: 'Reserved', guaranteeCode: 'NGI', arrival: '2027-09-14', reservationStayId: '456', reservationId: '789', guestId: '99' };
const payload = () => new URLSearchParams({ SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV',
  CURRENT_TAB_NAME: 'DOC', confirmationnumber: '123-1', reservationstayid: '456', propertycode: 'HRCEN',
  guestfullname: 'Proof Labtest', account: '99', guestid: '99', hoteldate: '2026-11-03', lastname: 'Labtest',
  firstname: 'Proof', twitterid: '-', facebookid: '-', tripadvisorid: '-', bookingdotcomid: '-', room: '',
  daeCode: '789#123-1#HRCEN', daeRentity: 'RESV', daeparentpkcolumnnames: 'CONFIRMATIONNUMBER,CODE,PROPERTYCODE',
  daeparentpkkey: 'confirmationnumber,reservationstayid,propertycode,guestfullname,account,guestid,hoteldate,lastname,firstname,twitterid,facebookid,tripadvisorid,bookingdotcomid,room',
  labelnames: 'DOC_LOV', metadata: 'DOC_LOV,RESV,P,RSL,{null},{null},{null},{null},{null},{null},{null},{null},CODE,CONFIRMATIONNUMBER,PROPERTYCODE,{null},{null},{null},{null},{null}' });
const post = (body) => ({ method: 'POST', url: `${origin}/web/base/OSRESV.DOC`, postData: body.toString(),
  contentType: 'application/x-www-form-urlencoded; charset=UTF-8' });

test('Documents POST needs the verified fake target and its exact native identity', () => {
  const body = payload(), scope = { confirmation: '123-1', native };
  assert.equal(filingDocumentsMayRequest(post(body), scope), true);
  assert.equal(filingDocumentsMayRequest(post(body), { ...scope, native: { ...native, guaranteeCode: 'GTDAGT' } }), true);
  assert.equal(filingDocumentsMayRequest(post(body), { ...scope, native: { ...native, guaranteeCode: undefined } }), true);
  assert.equal(filingDocumentsMayRequest(post(body), { confirmation: '123-1' }), false);
  assert.equal(filingDocumentsMayRequest(post(body), { ...scope, native: { ...native, lastName: 'Real' } }), false);
  for (const [key, value] of [['confirmationnumber', '999-1'], ['propertycode', 'HRDAV'], ['guestid', '999'],
    ['reservationstayid', '999'], ['daeCode', '999#123-1#HRCEN'], ['CURRENT_TAB_NAME', 'SAVE'], ['metadata', 'SAVE']]) {
    const changed = payload(); changed.set(key, value);
    assert.equal(filingDocumentsMayRequest(post(changed), scope), false);
  }
  const duplicate = payload(); duplicate.append('CONFIRMATIONNUMBER', '123-1');
  assert.equal(filingDocumentsMayRequest(post(duplicate), scope), false);
  const drift = payload(); drift.delete('twitterid'); drift.set('new_native_control', 'ignored');
  drift.set('daeparentpkkey', 'confirmationnumber,reservationstayid,another_native_key');
  drift.set('metadata', `${drift.get('metadata')},another_native_value`);
  assert.equal(filingDocumentsMayRequest(post(drift), scope), true);
  drift.set('pageaction', 'SAVE');
  assert.equal(filingDocumentsMayRequest(post(drift), scope), false);
  drift.set('pageaction', ''); drift.set('autosave', 'true');
  assert.equal(filingDocumentsMayRequest(post(drift), scope), false);
  assert.equal(filingDocumentsMayRequest({ ...post(body), url: 'https://other.invalid/web/base/OSRESV.DOC' }, scope), false);
});

test('Documents exception is installed before use and delegates all other requests to the strict guard', async () => {
  const handlers = [];
  const context = { routeWebSocket: async () => {}, route: async (_pattern, handler) => handlers.push(handler) };
  let current = null;
  await installPaneAttachReadGuard(context, { confirmation: '123-1', getNative: () => current });
  assert.equal(handlers.length, 2);
  let fetched = 0, aborted = 0, delegated = 0;
  const request = post(payload());
  const route = { request: () => ({ method: () => request.method, url: () => request.url,
    postData: () => request.postData, headers: () => ({ 'content-type': request.contentType }) }),
    abort: () => { aborted++; }, fallback: () => { delegated++; },
    fetch: async (options) => { assert.equal(options.maxRedirects, 0); assert.equal(options.maxRetries, 0);
      fetched++; return { status: () => 200 }; }, fulfill: () => {} };
  await handlers[1](route); assert.equal(aborted, 1); assert.equal(fetched, 0);
  current = native;
  await handlers[1](route); assert.equal(fetched, 1);
  request.url = `${origin}/web/base/unreviewed`;
  await handlers[1](route); assert.equal(delegated, 1);
});

test('one POST is not replayed or redirected to another endpoint', { timeout: 30000 }, async () => {
  let first = 0, target = 0, received = '';
  const server = createServer((req, res) => {
    if (req.url === '/upload') {
      first++; req.on('data', (chunk) => { received += chunk; });
      req.on('end', () => { res.writeHead(307, { location: '/target' }); res.end(); }); return;
    }
    if (req.url === '/target') target++;
    res.writeHead(200); res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const require = createRequire(new URL('../stagehand/package.json', import.meta.url));
  const browser = await require('playwright').chromium.launch({ headless: true,
    executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined });
  try {
    const context = await browser.newContext();
    await context.route('**/upload', fulfillGuestLookupRequest);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const failed = await page.evaluate(async () => {
      try { await fetch('/upload', { method: 'POST', body: 'synthetic-pdf' }); return false; } catch { return true; }
    });
    assert.equal(failed, true); assert.equal(first, 1); assert.equal(target, 0); assert.equal(received, 'synthetic-pdf');
    await context.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
