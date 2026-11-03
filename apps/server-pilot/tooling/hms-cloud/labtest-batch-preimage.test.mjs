import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { consumeLabtestPreimage, searchLabtestPreimage } from './labtest-preimage.mjs';

function pageFixture({ tamperAbsolute = false, duplicateRelative = false, arrival = '2027-08-01', departure = '2027-08-02',
  from = '2027-07-18', to = '2027-08-15' } = {}) {
  const page = new EventEmitter();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const parts = (value) => { const [year, month, day] = value.split('-'); return { year, month: months[Number(month) - 1], day }; };
  const display = (value) => { const { year, month, day } = parts(value); return `${day}-${month}-${year}`; };
  const title = (value) => { const { year, month, day } = parts(value); return `${month} ${day}, ${year}`; };
  const now = new Date(), today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const offset = (day) => String((Date.parse(`${day}T00:00:00Z`) - today) / 86_400_000);
  let body = new URLSearchParams({ MADDON_FILTER_ALIAS_NAME_1: 'departuredate', MADDON_FILTER_OPERATOR_1: '>=',
    MADDON_FILTER_VALUE_1: offset(from), MADDON_FILTER_ALIAS_NAME_2: 'arrivaldate', MADDON_FILTER_OPERATOR_2: '<=',
    MADDON_FILTER_VALUE_2: offset(to), MADDON_FILTER_ALIAS_NAME_5: 'lastname_filter', MADDON_FILTER_OPERATOR_5: 'BEGINS',
    MADDON_FILTER_VALUE_5: 'Labtest', GRID_NAME: 'OSRESS' }).toString();
  if (duplicateRelative) body += '&maddon_filter_value_1=0';
  const request = { method: () => 'POST', url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESS.search',
    postData: () => body };
  const response = { request: () => request, status: () => 200, text: async () => JSON.stringify({ pageData: {
    grid: { GRIDRESULT: { GRID: { METADATA: { GRIDNAME: 'OSRESS', RECORDS: '1', MORERECORDPRESENT: '-' }, DATA: [
      { confirmationnumber: '123456-1', firstname: 'Proof', lastname: 'Labtest', arrivaldate: display(arrival),
        departuredate: display(departure), status: 'Reserved' },
    ] } } },
  } }) };
  const rows = { count: async () => 1, evaluateAll: async () => [[['123456-1'], [], [], [display(arrival), display(departure)]]] };
  const popup = { boundingBox: async () => ({ x: 10, y: 30, width: 200, height: 100 }),
    evaluate: async () => ({ displayed: 1, total: 1, history: false, loading: false }),
    locator: (selector) => selector === '.x-grid-row:visible' ? rows
      : { count: async () => 1, innerText: async () => `${title(from)} - ${title(to)}` } };
  const search = { first: () => search, waitFor: async () => {}, count: async () => 1,
    boundingBox: async () => ({ x: 10, y: 10, width: 200, height: 20 }), fill: async () => {} };
  let routeHandler;
  const pending = [];
  const run = { boundingBox: async () => ({ x: 215, y: 10, width: 50, height: 20 }), click: async () => {
    let aborted = false;
    if (routeHandler) await routeHandler({ request: () => request, abort: async () => { aborted = true; },
      fallback: async ({ postData }) => {
        body = postData;
        if (tamperAbsolute) {
          const altered = new URLSearchParams(body);
          altered.set('MADDON_FILTER_VALUE_2', '14-AUG-2027');
          body = altered.toString();
        }
      } });
    for (const waiter of pending.splice(0)) {
      if (aborted) waiter.reject(new Error('aborted'));
      else if (waiter.predicate(response)) waiter.resolve(response);
      else waiter.reject(new Error('response mismatch'));
    }
  } };
  const runs = { filter: () => runs, count: async () => 1, nth: () => run };
  const windows = { count: async () => 1, nth: () => popup };
  Object.assign(page, { url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESS',
    title: async () => 'Infor HMS - HRCEN', context: () => ({ route: async () => {} }),
    locator: (selector) => selector.startsWith('input') ? search : selector.startsWith('a.x-btn') ? runs : windows,
    route: async (_pattern, handler) => { routeHandler = handler; },
    unroute: async (_pattern, handler) => { assert.equal(routeHandler, handler); routeHandler = undefined; },
    waitForResponse: (predicate) => new Promise((resolve, reject) => { pending.push({ predicate, resolve, reject }); }),
    waitForTimeout: async () => {} });
  return { page, arrival, departure, request };
}

test('existing matches remain blocked without a server verifier', async () => {
  const { page, arrival, departure } = pageFixture();
  const result = await searchLabtestPreimage(page, { arrival, departure });
  assert.equal(result.outcome, 'existing_matches');
  assert.equal(consumeLabtestPreimage(page, { ...result, arrival, departure }), false);
});

test('verified siblings issue one page-bound proof and cannot be consumed twice', async () => {
  const { page, arrival, departure } = pageFixture();
  const result = await searchLabtestPreimage(page, { arrival, departure }, { verifyExisting: async (census) => {
    assert.deepEqual(census.sameArrival.map((row) => row.confirmation), ['123456-1']);
    return true;
  } });
  assert.equal(result.outcome, 'clear');
  assert.equal(result.verifiedExisting, true);
  assert.equal(consumeLabtestPreimage(page, { ...result, arrival, departure }), true);
  assert.equal(consumeLabtestPreimage(page, { ...result, arrival, departure }), false);
});

test('a changed page or failed independent verification invalidates the proof', async () => {
  for (const change of ['page', 'read']) {
    const { page, arrival, departure } = pageFixture();
    const result = await searchLabtestPreimage(page, { arrival, departure }, { verifyExisting: async () => {
      if (change === 'page') page.emit('request', { method: () => 'POST',
        url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR?pageaction=SAVE' });
      return change === 'page';
    } });
    assert.equal(result.outcome, 'existing_matches');
    assert.equal(consumeLabtestPreimage(page, { ...result, arrival, departure }), false);
  }
});

test('a slow sibling read cannot extend the original five-minute census expiry', async (t) => {
  const { page, arrival, departure } = pageFixture();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const result = await searchLabtestPreimage(page, { arrival, departure }, { verifyExisting: async () => {
    now += 300_000;
    return true;
  } });
  assert.equal(result.outcome, 'existing_matches');
  assert.equal(consumeLabtestPreimage(page, { ...result, arrival, departure }), false);
});

test('a clear census still requires all earlier rooms to pass the independent verifier', async () => {
  for (const verified of [false, true]) {
    const { page, arrival, departure } = pageFixture();
    const target = { firstName: 'Ada', lastName: 'Labtest', arrival, departure };
    let called = false;
    const result = await searchLabtestPreimage(page, target, { allowRealGuest: true, verifyExisting: async (census) => {
      called = true;
      assert.deepEqual(census.sameArrival, []);
      return verified;
    } });
    assert.equal(called, true);
    assert.equal(result.outcome, verified ? 'clear' : 'incomplete');
    assert.equal(consumeLabtestPreimage(page, { ...result, ...target }), verified);
  }
});

test('absolute native dates cover the census when UTC and property dates differ', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-03T23:30:00Z') });
  const now = new Date();
  assert.notEqual(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric',
    month: '2-digit', day: '2-digit' }).format(now), now.toISOString().slice(0, 10));
  const { page, arrival, departure, request } = pageFixture();
  const result = await searchLabtestPreimage(page, { arrival, departure });
  assert.equal(result.outcome, 'existing_matches');
  const sent = new URLSearchParams(request.postData());
  assert.equal(sent.get('MADDON_FILTER_VALUE_1'), '18-JUL-2027');
  assert.equal(sent.get('MADDON_FILTER_VALUE_2'), '15-AUG-2027');

  const fresh = pageFixture({ arrival: '2026-11-04', departure: '2026-11-05', from: '2026-10-21', to: '2026-11-18' });
  const target = { firstName: 'Ada', lastName: 'Labtest', arrival: fresh.arrival, departure: fresh.departure };
  const clear = await searchLabtestPreimage(fresh.page, target, { allowRealGuest: true });
  assert.equal(clear.outcome, 'clear');
  assert.equal(consumeLabtestPreimage(fresh.page, { ...clear, ...target }), true);
});

test('changed absolute dates or ambiguous original date parameters cannot issue a census proof', async () => {
  for (const options of [{ tamperAbsolute: true }, { duplicateRelative: true }]) {
    const { page, arrival, departure } = pageFixture(options);
    const result = await searchLabtestPreimage(page, { arrival, departure }, { verifyExisting: async () => true });
    assert.equal(result.outcome, 'incomplete');
    assert.equal(result.issue, 'SEARCH_RESPONSE_UNVERIFIED');
    assert.equal(consumeLabtestPreimage(page, { ...result, arrival, departure }), false);
  }
});
