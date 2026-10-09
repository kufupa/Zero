import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyObservation, loopbackCdpUrl, probePlan, runDeeplinkProbe, scrubNavError, shapeOf,
} from './hms-deeplink-probe.mjs';

const ORIGIN = 'https://hms.example.test';

test('loopbackCdpUrl accepts only loopback http or ws without credentials, query or fragment', () => {
  assert.equal(loopbackCdpUrl('http://127.0.0.1:9222'), 'http://127.0.0.1:9222/');
  assert.equal(loopbackCdpUrl('ws://localhost:9333'), 'ws://localhost:9333/');
  assert.equal(loopbackCdpUrl('http://[::1]:9222'), 'http://[::1]:9222/');
  assert.equal(loopbackCdpUrl('http://10.0.0.5:9222'), null);
  assert.equal(loopbackCdpUrl('https://127.0.0.1:9222'), null);
  assert.equal(loopbackCdpUrl('http://user:pw@127.0.0.1:9222'), null);
  assert.equal(loopbackCdpUrl('http://127.0.0.1:9222/?token=1'), null);
  assert.equal(loopbackCdpUrl('not a url'), null);
  assert.equal(loopbackCdpUrl(''), null);
});

test('probePlan sends every probe as a GET under the HMS origin, with the stay id probe only when one is given', () => {
  const plan = probePlan({ origin: ORIGIN, conf: '61143613-1' });
  const ids = plan.map(([id]) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes('P4_osresv_get_stayid'));
  assert.ok(!ids.some((id) => id.startsWith('P7')), 'no fresh-login probe: the probe never fills a login form');
  for (const [, url] of plan) {
    assert.ok(url.startsWith(`${ORIGIN}/web/base/`), url);
  }
  const p3 = plan.find(([id]) => id === 'P3_osresv_get_confirmation')[1];
  assert.match(p3, /confirmationnumber=61143613-1$/);
  const withStay = probePlan({ origin: ORIGIN, conf: '61143613-1', stayId: '987' });
  assert.ok(withStay.some(([id, url]) => id === 'P4_osresv_get_stayid' && url.endsWith('reservationstayid=987')));
  assert.deepEqual(withStay.map(([id]) => id).slice(-3), ['P4_osresv_get_stayid', 'P5_osress_get_prefill_param', 'P6_osresv_hdr_get_xhr_shape']);
});

test('shapeOf shows the two function names and hides every other query value and path digit run', () => {
  const shape = shapeOf(`${ORIGIN}/web/base/OSRESV/61143613-1?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESV&confirmationnumber=61143613-1&token=abc`);
  assert.equal(shape, '/web/base/OSRESV/<n>?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESV&confirmationnumber=<v>&token=<v>');
  assert.equal(shapeOf(`${ORIGIN}/web/base/COMMON`), '/web/base/COMMON');
  assert.equal(shapeOf(`${ORIGIN}/x?FUNCTION_CLASS=a%20b%26c`), '/x?FUNCTION_CLASS=<v>');
});

test('scrubNavError drops URLs and long digit runs, keeps one line, and returns null for empty text', () => {
  assert.equal(
    scrubNavError(`page.goto: net::ERR_ABORTED at ${ORIGIN}/web/base/OSRESV?confirmationnumber=61143613-1\nCall log`),
    'page.goto: net::ERR_ABORTED at <url>',
  );
  assert.equal(scrubNavError('timeout after 45000 ms'), 'timeout after <n> ms');
  assert.equal(scrubNavError(''), null);
  assert.equal(scrubNavError(undefined), null);
  assert.ok(scrubNavError('x'.repeat(500)).length <= 120);
});

test('classifyObservation: a visible record wins over login or error text; the match compares the conf only', () => {
  assert.equal(classifyObservation({ confVisible: true, confMatches: true }), 'RECORD_OPEN_MATCH');
  assert.equal(classifyObservation({ confVisible: true, confMatches: false, confEmpty: false }), 'RECORD_OPEN_OTHER_CONF');
  assert.equal(classifyObservation({ confVisible: true, confMatches: false, confEmpty: true }), 'RECORD_OPEN_CONF_UNREAD');
  assert.equal(classifyObservation({ confVisible: true, loginVisible: true, errorish: true }), 'RECORD_OPEN_OTHER_CONF');
  assert.equal(classifyObservation({ loginVisible: true, searchVisible: true }), 'LOGIN_BOUNCE');
  assert.equal(classifyObservation({ onLoginPath: true }), 'LOGIN_BOUNCE');
  assert.equal(classifyObservation({ contentType: 'application/json; charset=utf-8' }), 'RAW_NON_UI');
  assert.equal(classifyObservation({ searchVisible: true, errorish: true }), 'SEARCH_ONLY_NO_RECORD');
  assert.equal(classifyObservation({ errorish: true }), 'ERROR_TEXT');
  assert.equal(classifyObservation({}), 'SHELL_OR_BLANK');
});

test('runDeeplinkProbe refuses bad input before it creates a directory, reads a secret or opens the browser', async () => {
  const good = { HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:9222', HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed' };
  await assert.rejects(runDeeplinkProbe({ env: { ...good, HMS_STAGEHAND_CDP_URL: 'http://203.0.113.9:9222' }, conf: '1-1' }), /LOOPBACK_CDP_REQUIRED/);
  await assert.rejects(runDeeplinkProbe({ env: { ...good, HMS_STAGEHAND_BROWSER_OWNERSHIP: 'owned' }, conf: '1-1' }), /BORROWED_OWNERSHIP_REQUIRED/);
  await assert.rejects(runDeeplinkProbe({ env: good, conf: '' }), /CONFIRMATION_REQUIRED/);
  await assert.rejects(runDeeplinkProbe({ env: good, conf: 'ABC' }), /CONFIRMATION_REQUIRED/);
  await assert.rejects(runDeeplinkProbe({ env: good, conf: '1-1', stayId: 'x1' }), /STAY_ID_INVALID/);
  await assert.rejects(
    runDeeplinkProbe({ env: good, conf: '1-1', runRoot: '/tmp/not-private' }),
    /OUTPUT_MUST_BE_PRIVATE_PLAYWRIGHT_QUOTE_DIRECTORY/,
  );
});
