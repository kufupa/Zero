import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { installPageRequestFence } from './page-request-fence.mjs';
import { installLabtestContactSaveRouteChain, matchesLabtestContactAmendRequest } from './guest-stay-amend-contact.mjs';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';

const HMS_ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const SAVE_PATH = '/web/base/OSRESV.HDR';
const frame = {};
const expected = {
  confirmation: '20270000001-1', guestId: '77', arrival: '2027-01-15', departure: '2027-01-16',
  roomType: 'DLX', ratePlan: 'BAR', note: 'synthetic test note',
};
const state = {
  arrivalWire: '01/15/2027', departureWire: '01/16/2027', track: 'TRACK-1',
  native: { PKID: '2', bookingsessionid: '3', reservationid: '4', reservationstayid: '5', recordid: '6' },
};
const data = {
  ...state.native,
  propertycode: 'HRCEN', confirmationnumber: expected.confirmation, guestid: expected.guestId,
  status: 'Reserved', firstname: 'Proof', lastname: 'Labtest', arrivaldate: state.arrivalWire,
  departuredate: state.departureWire, roomtype: expected.roomType, rateplan: expected.ratePlan,
  track: state.track, reservationnote: expected.note, udfchkbox04: '0', udfchar13: '', emailaddress: '',
  guaranteetype: 'NGI', pagemode: 'view', savecctoprofile: '0', savesettlementcctoprofile: '0',
  caller: 'Synthetic Booker', udfchar06: 'Synthetic contact', udfchar02: 'unchanged', extId: 'ignored',
};
const baseline = { values: { ...data }, data: { ...data } };
const contactCases = [
  ['bookerName', 'caller', 'Synthetic Booker Updated'],
  ['bookerContact', 'udfchar06', 'Synthetic contact updated'],
];

function saveBody(fieldName, value) {
  const body = new URLSearchParams();
  for (const [key, item] of Object.entries(data)) {
    if (key !== 'extId') body.set(key, String(item ?? ''));
  }
  body.set(fieldName, value);
  body.set('SYSTEM_FUNCTION_NAME', 'OSRESV');
  body.set('USER_FUNCTION_NAME', 'OSRESV');
  body.set('CURRENT_TAB_NAME', 'HDR');
  return body;
}

function requestFor(body, overrides = {}) {
  return {
    url: () => overrides.url || `${HMS_ORIGIN}${SAVE_PATH}?pageaction=SAVE`,
    method: () => overrides.method || 'POST',
    frame: () => overrides.frame || frame,
    postData: () => body.toString(),
    headers: () => ({ 'content-type': overrides.contentType || 'application/x-www-form-urlencoded' }),
  };
}

test('contact save matcher accepts only the two exact, otherwise unchanged full-record payloads', () => {
  for (const [field, formName, value] of contactCases) {
    const body = saveBody(formName, value);
    assert.equal(matchesLabtestContactAmendRequest(requestFor(body), frame, expected, state, baseline, field, value), true);
  }
});

test('contact save matcher rejects collateral, duplicate, extra, wrong-frame, and wrong-target requests', () => {
  const [field, formName, value] = contactCases[0];
  const match = (body, overrides = {}) => matchesLabtestContactAmendRequest(
    requestFor(body, overrides), frame, expected, state, baseline, field, value,
  );

  const collateral = saveBody(formName, value);
  collateral.set('udfchar02', 'unexpected collateral change');
  assert.equal(match(collateral), false);

  const duplicate = saveBody(formName, value);
  duplicate.append(formName, 'second value');
  assert.equal(match(duplicate), false);

  const extra = saveBody(formName, value);
  extra.set('unexpected', 'not in the saved record');
  assert.equal(match(extra), false);

  assert.equal(match(saveBody(formName, value), { frame: {} }), false);
  assert.equal(match(saveBody(formName, value), { url: `${HMS_ORIGIN}${SAVE_PATH}?pageaction=SAVE&extra=1` }), false);
  assert.equal(match(saveBody(formName, value), { contentType: 'text/plain' }), false);
  assert.equal(matchesLabtestContactAmendRequest(requestFor(saveBody(formName, value), { method: 'GET' }),
    frame, expected, state, baseline, field, value), false);
  assert.equal(matchesLabtestContactAmendRequest(requestFor(saveBody(formName, value)),
    frame, expected, state, baseline, 'toString', value), false);
});

test('later page writer route falls back through the page fence; unapproved, late, and other-page saves stay blocked', async () => {
  const arrivals = [];
  const server = createServer((request, response) => {
    if (request.method === 'POST' && new URL(request.url, 'http://127.0.0.1').pathname === SAVE_PATH) {
      arrivals.push('POST');
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  let chain;
  let scope;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined });
    const context = await browser.newContext();
    await installReadOnlyGuard(context);
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin);
    const pageFrame = page.mainFrame();
    const fence = await installPageRequestFence(page, [SAVE_PATH]);
    scope = fence.open();
    let armed = true;
    let candidates = 0;
    let dispatches = 0;
    let blockedOnPage = 0;
    chain = await installLabtestContactSaveRouteChain(page, {
      frame: pageFrame,
      fence,
      scope,
      isArmed: () => armed,
      matches: (request, requestFrame) => {
        if (requestFrame !== pageFrame || request.method() !== 'POST') return false;
        const url = new URL(request.url());
        return url.pathname === SAVE_PATH && new URLSearchParams(request.postData() || '').get('intent') === 'approved-once';
      },
      onCandidate: () => { candidates += 1; },
      onDispatch: () => { dispatches += 1; armed = false; },
      onBlocked: () => { blockedOnPage += 1; },
    });

    const post = (targetPage) => targetPage.evaluate(async () => {
      try {
        const response = await fetch('/web/base/OSRESV.HDR?pageaction=SAVE', {
          method: 'POST', body: new URLSearchParams({ intent: 'approved-once' }),
        });
        return response.status;
      } catch {
        return 'blocked';
      }
    });
    const unapproved = await page.evaluate(async () => {
      try {
        const response = await fetch('/web/base/OSRESV.HDR?pageaction=SAVE', {
          method: 'POST', body: new URLSearchParams({ intent: 'not-approved' }),
        });
        return response.status;
      } catch {
        return 'blocked';
      }
    });
    assert.equal(unapproved, 'blocked');
    assert.equal(arrivals.length, 0);

    assert.equal(await post(page), 200);
    assert.deepEqual(arrivals, ['POST']);
    assert.equal(candidates, 1);
    assert.equal(dispatches, 1);

    chain.disarm();
    assert.equal(await post(page), 'blocked');
    const otherPage = await context.newPage();
    await otherPage.goto(origin);
    assert.equal(await post(otherPage), 'blocked');
    assert.deepEqual(arrivals, ['POST']);
    assert.ok(blockedOnPage >= 2);
  } finally {
    scope?.close();
    await chain?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
