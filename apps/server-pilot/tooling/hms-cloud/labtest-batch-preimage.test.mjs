import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { consumeLabtestPreimage, searchLabtestPreimage } from './labtest-preimage.mjs';

function pageFixture() {
  const page = new EventEmitter();
  const arrival = '2027-08-01', departure = '2027-08-02';
  const from = '2027-07-18', to = '2027-08-15';
  const now = new Date(), today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const offset = (day) => String((Date.parse(`${day}T00:00:00Z`) - today) / 86_400_000);
  const body = new URLSearchParams({ MADDON_FILTER_ALIAS_NAME_1: 'departuredate', MADDON_FILTER_OPERATOR_1: '>=',
    MADDON_FILTER_VALUE_1: offset(from), MADDON_FILTER_ALIAS_NAME_2: 'arrivaldate', MADDON_FILTER_OPERATOR_2: '<=',
    MADDON_FILTER_VALUE_2: offset(to), MADDON_FILTER_ALIAS_NAME_5: 'lastname_filter', MADDON_FILTER_OPERATOR_5: 'BEGINS',
    MADDON_FILTER_VALUE_5: 'Labtest', GRID_NAME: 'OSRESS' }).toString();
  const request = { method: () => 'POST', url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESS.search',
    postData: () => body };
  const response = { request: () => request, status: () => 200, text: async () => JSON.stringify({ pageData: {
    grid: { GRIDRESULT: { GRID: { METADATA: { GRIDNAME: 'OSRESS', RECORDS: '1', MORERECORDPRESENT: '-' }, DATA: [
      { confirmationnumber: '123456-1', firstname: 'Proof', lastname: 'Labtest', arrivaldate: '01-Aug-2027',
        departuredate: '02-Aug-2027', status: 'Reserved' },
    ] } } },
  } }) };
  const rows = { count: async () => 1, evaluateAll: async () => [[['123456-1'], [], [], ['01-Aug-2027', '02-Aug-2027']]] };
  const popup = { boundingBox: async () => ({ x: 10, y: 30, width: 200, height: 100 }),
    evaluate: async () => ({ displayed: 1, total: 1, history: false, loading: false }),
    locator: (selector) => selector === '.x-grid-row:visible' ? rows
      : { count: async () => 1, innerText: async () => 'Jul 18, 2027 - Aug 15, 2027' } };
  const search = { first: () => search, waitFor: async () => {}, count: async () => 1,
    boundingBox: async () => ({ x: 10, y: 10, width: 200, height: 20 }), fill: async () => {} };
  const run = { boundingBox: async () => ({ x: 215, y: 10, width: 50, height: 20 }), click: async () => {} };
  const runs = { filter: () => runs, count: async () => 1, nth: () => run };
  const windows = { count: async () => 1, nth: () => popup };
  Object.assign(page, { url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESS',
    title: async () => 'Infor HMS - HRCEN', context: () => ({ route: async () => {} }),
    locator: (selector) => selector.startsWith('input') ? search : selector.startsWith('a.x-btn') ? runs : windows,
    waitForResponse: async (predicate) => { assert.equal(predicate(response), true); return response; },
    waitForTimeout: async () => {} });
  return { page, arrival, departure };
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
