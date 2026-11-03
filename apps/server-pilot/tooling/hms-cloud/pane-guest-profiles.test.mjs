import assert from 'node:assert/strict';
import test from 'node:test';
import { guestProfileLookupMayRequest, installGuestProfileLookupGuard, searchGuestProfilesForPane } from './pane-guest-profiles.mjs';

const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const request = (path, data) => ({ method: 'POST', url: `${origin}${path}`,
  postData: new URLSearchParams(data).toString(), contentType: 'application/x-www-form-urlencoded; charset=UTF-8' });
const blank = Object.fromEntries(['account', 'bookingdotcomid', 'confirmationnumber', 'facebookid', 'firstname', 'guestfullname',
  'guestid', 'hoteldate', 'lastname', 'propertycode', 'reservationstayid', 'room', 'tripadvisorid', 'twitterid'].map((k) => [k, '']));
const header = { ...blank, system_function_name: 'OSRESV', user_function_name: 'OSRESV', current_tab_name: 'HDR',
  only_data_required: 'true', scrollrow: 'YES' };
const popup = { current_tab_name: 'HDR', grid_name: 'LVGUESTS', grid_type: 'LOV', lov_alias_name_1: 'param.propertycode',
  lov_alias_type_1: 'text', lov_alias_value_1: 'HRCEN', lov_tagname: 'lastname', request_type: 'LOV.HEAD_DATA.STORED',
  user_function_name: 'OSRESV', popup: 'true' };
const grid = { current_tab_name: 'HDR', dataspy_id: '611', grid_id: '583', grid_name: 'LVGUESTS', grid_type: 'LOV',
  lov_alias_name_1: 'param.propertycode', lov_alias_type_1: 'text', lov_alias_value_1: 'HRCEN', lov_tagname: 'lastname',
  maddon_filter_alias_name_1: 'lastname', maddon_filter_joiner_1: 'AND', maddon_filter_operator_1: 'CONTAINS',
  maddon_filter_seqnum_1: '1', maddon_filter_value_1: 'Labtest', maddon_lparen_1: 'false', maddon_rparen_1: 'false',
  request_type: 'LOV.DATA_ONLY.STORED', user_function_name: 'OSRESV' };

test('the read fence admits only the blank form and exact HRCEN surname search', () => {
  for (const input of [request('/web/base/OSRESV.HDR', header), request('/web/base/LOVPOP', popup),
    request('/web/base/GRIDDATA', grid)]) assert.equal(guestProfileLookupMayRequest(input, 'Labtest'), true);
  for (const input of [request('/web/base/OSRESV.HDR', { ...header, confirmationnumber: '123-1' }),
    request('/web/base/OSRESV.HDR', { ...header, pageaction: 'SAVE' }),
    request('/web/base/LOVPOP', { ...popup, lov_alias_value_1: 'HRDAV' }),
    request('/web/base/GRIDDATA', { ...grid, maddon_filter_value_1: 'Another' }),
    request('/web/base/GRIDDATA', { ...grid, request_type: 'SAVE' }),
    request('/web/base/BSUPLD.upload', grid),
    { ...request('/web/base/GRIDDATA', grid), postData: `${new URLSearchParams(grid)}&GRID_NAME=LVGUESTS` },
    { ...request('/web/base/GRIDDATA', grid), url: `${origin}/web/base/GRIDDATA?pageaction=SAVE` },
    { ...request('/web/base/GRIDDATA', grid), url: 'https://other.invalid/web/base/GRIDDATA' }]) {
    assert.equal(guestProfileLookupMayRequest(input, 'Labtest'), false);
  }
  for (const invalid of ['L', '*', '%', 'Sm%', 'A'.repeat(41), 'Labtest\n']) {
    assert.equal(guestProfileLookupMayRequest(request('/web/base/GRIDDATA', grid), invalid), false);
  }
});

test('guard blocks sockets and unknown native writes before login', async () => {
  let onSocket, onRequest;
  await installGuestProfileLookupGuard({ routeWebSocket: async (_pattern, handler) => { onSocket = handler; },
    route: async (_pattern, handler) => { onRequest = handler; } }, 'Labtest');
  let closed = false, aborted = false;
  onSocket({ close: () => { closed = true; } });
  await onRequest({ request: () => ({ method: () => 'POST', url: () => `${origin}/web/base/BSUPLD.upload`,
    postData: () => '', headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }) }),
  abort: async () => { aborted = true; } });
  assert.equal(closed, true); assert.equal(aborted, true);
  await assert.rejects(installGuestProfileLookupGuard({ route: async () => {} }, 'Labtest'));
});

const row = (id) => ({ nativeId: String(id), firstName: 'Proof', lastName: 'Labtest', city: 'Pretoria',
  country: 'ZA', email: 'not-returned@example.invalid' });
function harness(found, property = 'HRCEN') {
  let options, navigated = false, inspected = false, guarded = false;
  const page = { locator: () => ({ count: async () => 1, innerText: async () => property }) };
  const context = { routeWebSocket: async () => {}, route: async () => { guarded = true; } };
  const deps = { openSession: async (fn, opts) => { options = opts; await opts.prepareContext(context); return fn(page); },
    navigate: async () => { navigated = true; }, search: async () => found,
    inspect: async () => { inspected = true; return { outcome: 'current', candidates: [row(26), row(27)] }; } };
  return { deps, state: () => ({ options, navigated, inspected, guarded }) };
}
const verified = ['guestid', 'firstname', 'lastname', 'city', 'country'];

test('lookup returns correlated, bounded profile details; never raw email or response data', async () => {
  const h = harness({ outcome: 'matches', searchId: 'current', candidates: Array.from({ length: 25 }, (_, i) => row(i + 1)),
    coverage: { loaded: 27, possiblyTruncated: false }, correlation: { verifiedFields: verified } });
  const result = await searchGuestProfilesForPane('Labtest', h.deps);
  assert.equal(result.status, 'ok'); assert.equal(result.candidates.length, 27);
  assert.deepEqual(result.candidates[0], { nativeId: '1', firstName: 'Proof', lastName: 'Labtest', city: 'Pretoria', country: 'ZA' });
  assert.equal(result.moreAvailable, false);
  assert.equal(h.state().navigated, true); assert.equal(h.state().guarded, true); assert.equal(h.state().inspected, true);
  assert.equal(h.state().options.blockServiceWorkers, true);
});

test('unverified, truncated and mismatched results are never presented as a complete match', async () => {
  const empty = { outcome: 'no_match', candidates: [], coverage: { loaded: 0, serverMoreRecords: false,
    total: 0, possiblyTruncated: false }, correlation: { verifiedFields: verified } };
  assert.deepEqual(await searchGuestProfilesForPane('Labtest', harness(empty).deps),
    { status: 'ok', candidates: [], moreAvailable: false });
  const partial = { outcome: 'matches', candidates: [row(1)], coverage: { loaded: 1, possiblyTruncated: true },
    correlation: { verifiedFields: verified } };
  assert.equal((await searchGuestProfilesForPane('Labtest', harness(partial).deps)).moreAvailable, true);
  for (const found of [{ ...empty, coverage: { ...empty.coverage, serverMoreRecords: true } },
    { ...partial, correlation: { verifiedFields: ['guestid'] } }, { ...partial, candidates: [] },
    { outcome: 'execution_failure', candidates: [] }]) {
    assert.deepEqual(await searchGuestProfilesForPane('Labtest', harness(found).deps), { status: 'unavailable' });
  }
  assert.deepEqual(await searchGuestProfilesForPane('Labtest', harness(partial, 'HRDAV').deps), { status: 'unavailable' });
});
