import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as lookup from './party-lookup.mjs';

const schemaUrl = new URL('./party-lookup.schema.json', import.meta.url);

test('import has no CLI, browser or credential side effects', () => {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./party-lookup.mjs', import.meta.url).href)}); console.log('import only');`],
    { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH } },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'import only');
  assert.equal(child.stderr, '');
});

test('v1 kinds include A/R and exclude group', async () => {
  const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
  assert.deepEqual(schema.$defs.request.properties.kind.enum, ['organization', 'bookingAgency', 'guest', 'arAccount']);
  assert.deepEqual(lookup.validateRequest({ kind: 'arAccount', query: { arAccountName: 'x' } }), []);
  assert.ok(lookup.validateRequest({ kind: 'group', query: { lastName: 'x' } }).length);
  assert.deepEqual(schema.$defs.batchRequest.required, ['searches']);
  assert.equal(schema.$defs.batchRequest.properties.stopOnFirstHit.type, 'boolean');
  assert.equal(schema.$defs.batchRequest.properties.searches.items.$ref, '#/$defs/search');
});

test('empty query is an input gap', () => {
  assert.ok(lookup.validateRequest({ kind: 'organization', query: {} }).length);
  assert.ok(lookup.validateRequest({ kind: 'guest', query: {} }).length);
});

test('organization name request validates', () => {
  assert.deepEqual(lookup.validateRequest({ kind: 'organization', query: { organizationName: 'ACME' } }), []);
});

test('normalizePartyLookupRequest keeps a single kind+query as one search', () => {
  const got = lookup.normalizePartyLookupRequest({ kind: 'organization', query: { organizationName: 'ACME' } });
  assert.deepEqual(got.issues, []);
  assert.equal(got.single, true);
  assert.equal(got.stopOnFirstHit, false);
  assert.equal(got.searches.length, 1);
  assert.equal(got.searches[0].kind, 'organization');
  assert.deepEqual(got.searches[0].query, { organizationName: 'ACME' });
});

test('normalizePartyLookupRequest accepts a single {kind, name} and maps it to the kind query', () => {
  const org = lookup.normalizePartyLookupRequest({ kind: 'organization', name: 'ACME' });
  assert.deepEqual(org.issues, []);
  assert.equal(org.single, true);
  assert.deepEqual(org.searches[0].query, { organizationName: 'ACME' });
  const agency = lookup.normalizePartyLookupRequest({ kind: 'bookingAgency', name: 'CWT' });
  assert.deepEqual(agency.searches[0].query, { bookingAgencyName: 'CWT' });
});

test('normalizePartyLookupRequest accepts searches [{kind, name}] plus stopOnFirstHit', () => {
  const got = lookup.normalizePartyLookupRequest({
    searches: [
      { kind: 'organization', name: 'A' },
      { kind: 'bookingAgency', name: 'B' },
    ],
    stopOnFirstHit: true,
  });
  assert.deepEqual(got.issues, []);
  assert.equal(got.single, false);
  assert.equal(got.stopOnFirstHit, true);
  assert.equal(got.searches.length, 2);
  assert.equal(got.searches[0].kind, 'organization');
  assert.equal(got.searches[1].kind, 'bookingAgency');
  assert.deepEqual(got.searches[1].query, { bookingAgencyName: 'B' });
});

test('normalizePartyLookupRequest accepts a bare list of searches', () => {
  const got = lookup.normalizePartyLookupRequest([
    { kind: 'organization', name: 'A' },
    { kind: 'organization', name: 'B' },
  ]);
  assert.deepEqual(got.issues, []);
  assert.equal(got.single, false);
  assert.equal(got.searches.length, 2);
});

test('normalizePartyLookupRequest rejects an empty searches list and a bad kind', () => {
  assert.ok(lookup.normalizePartyLookupRequest({ searches: [] }).issues.length);
  assert.ok(lookup.normalizePartyLookupRequest({ searches: [{ kind: 'group', name: 'x' }] }).issues.length);
  assert.ok(lookup.normalizePartyLookupRequest(null).issues.length);
});

test('runNormalizedSearches continues after one search failure and records per-search phaseMs', async () => {
  let now = 1000;
  const calls = [];
  const results = await lookup.runNormalizedSearches(
    [
      { kind: 'organization', query: { organizationName: 'A' }, name: 'A' },
      { kind: 'bookingAgency', query: { bookingAgencyName: 'B' }, name: 'B' },
    ],
    {
      now: () => now,
      search: async (item) => {
        calls.push(item.name);
        now += item.name === 'A' ? 12 : 7;
        if (item.name === 'A') {
          return lookup.filterNotApplied();
        }
        return { outcome: 'resolved', candidates: [{ nativeId: '1', kind: 'bookingAgency', displayName: 'B' }], truncated: false };
      },
    },
  );
  assert.deepEqual(calls, ['A', 'B']);
  assert.equal(results[0].outcome, 'execution_failure');
  assert.equal(results[1].outcome, 'resolved');
  assert.equal(results[0].phaseMs.search, 12);
  assert.equal(results[1].phaseMs.search, 7);
  assert.equal(results[0].kind, 'organization');
  assert.equal(results[1].name, 'B');
});

test('runNormalizedSearches stopOnFirstHit skips later searches of the same kind after rows', async () => {
  const calls = [];
  const results = await lookup.runNormalizedSearches(
    [
      { kind: 'organization', query: { organizationName: 'Full' }, name: 'Full' },
      { kind: 'organization', query: { organizationName: 'Short' }, name: 'Short' },
      { kind: 'bookingAgency', query: { bookingAgencyName: 'Full' }, name: 'Agency' },
    ],
    {
      stopOnFirstHit: true,
      search: async (item) => {
        calls.push(item.name);
        return { outcome: 'resolved', candidates: [{ nativeId: '1', kind: item.kind, displayName: item.name }], truncated: false };
      },
    },
  );
  assert.deepEqual(calls, ['Full', 'Agency']);
  assert.equal(results[1].skipped, true);
  assert.equal(results[1].outcome, 'no_match');
  assert.equal(results[1].phaseMs.search, 0);
  assert.equal(results[2].outcome, 'resolved');
});

test('runNormalizedSearches stops remaining searches when the session is dead', async () => {
  const calls = [];
  const results = await lookup.runNormalizedSearches(
    [
      { kind: 'organization', query: { organizationName: 'A' }, name: 'A' },
      { kind: 'bookingAgency', query: { bookingAgencyName: 'B' }, name: 'B' },
    ],
    {
      search: async (item) => {
        calls.push(item.name);
        throw new Error('Target closed');
      },
    },
  );
  assert.deepEqual(calls, ['A']);
  assert.equal(results[0].outcome, 'execution_failure');
  assert.equal(results[1].outcome, 'execution_failure');
  assert.equal(results[1].issues[0].reason, 'session_dead');
  assert.equal(lookup.isSessionDeadError(new Error('Target closed')), true);
  assert.equal(lookup.isSessionDeadError(new Error('filter_not_applied')), false);
});

test('redactPartyLookupProbe keeps outcomes and phaseMs and drops names', () => {
  const redacted = lookup.redactPartyLookupProbe({
    outcome: 'resolved',
    searches: [{
      kind: 'organization',
      name: 'Secret Co',
      outcome: 'resolved',
      candidates: [{ nativeId: '9', displayName: 'Secret Co' }],
      phaseMs: { search: 12 },
    }],
    phaseMs: { connect: 1, login: 8000, navigate: 4000, search: 12 },
  });
  assert.equal(JSON.stringify(redacted).includes('Secret'), false);
  assert.equal(redacted.searches[0].outcome, 'resolved');
  assert.equal(redacted.searches[0].phaseMs.search, 12);
  assert.equal(redacted.phaseMs.login, 8000);
  assert.equal(redacted.phaseMs.navigate, 4000);
});

test('store rows map travelagencyid when IATA is blank', () => {
  const row = lookup.rowFromStoreData({ travelagencyid: 290, travelagencyname: 'CWT JNB', iatanumber: '' });
  assert.equal(row.nativeId, '290');
  assert.equal(row.displayName, 'CWT JNB');
  const mapped = lookup.storeRowsForKind('bookingAgency', [{ travelagencyid: 290, travelagencyname: 'CWT JNB' }]);
  assert.equal(mapped[0].nativeId, '290');
});

test('store row keeps optional HMS grid columns from the record', async () => {
  const row = lookup.rowFromStoreData({
    travelagencyid: 280,
    travelagencyname: 'Tourvest Travel Services',
    iatanumber: 12345,
    address: '1 Example Road',
    city: 'Cape Town',
    country: 'South Africa',
    externalid: 'EXT-9',
  });
  assert.equal(row.nativeId, '280');
  assert.equal(row.displayName, 'Tourvest Travel Services');
  assert.equal(row.iata, '12345');
  assert.equal(row.city, 'Cape Town');
  assert.equal(row.address, '1 Example Road');
  assert.equal(row.country, 'South Africa');
  assert.equal(row.externalId, 'EXT-9');
  const blank = lookup.rowFromStoreData({ travelagencyid: 290, travelagencyname: 'CWT JNB', iatanumber: '' });
  assert.equal('iata' in blank, false);
  const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
  for (const key of ['iata', 'city', 'address', 'country', 'externalId']) {
    assert.equal(schema.$defs.candidate.properties[key].type, 'string');
  }
});

test('candidate count maps to outcome', () => {
  assert.equal(lookup.classifyOutcome([]).outcome, 'no_match');
  assert.equal(lookup.classifyOutcome([{ nativeId: '1', kind: 'organization', displayName: 'A' }]).outcome, 'resolved');
  assert.equal(
    lookup.classifyOutcome([
      { nativeId: '1', kind: 'organization', displayName: 'A' },
      { nativeId: '2', kind: 'organization', displayName: 'B' },
    ]).outcome,
    'ambiguous',
  );
});

test('local agency window is Booking Agencies not external Booking Agency Search', () => {
  assert.match('Booking Agencies', lookup.windowTitleRe('bookingAgency'));
  assert.equal(lookup.windowTitleRe('bookingAgency').test('Booking Agency Search'), false);
  assert.match('Organizations', lookup.windowTitleRe('organization'));
  assert.match('Guest Search', lookup.windowTitleRe('guest'));
  assert.match('A/R Account lookup', lookup.windowTitleRe('arAccount'));
});

test('local dialog run control is Run, not page Search', () => {
  assert.equal(lookup.dialogRunNames('bookingAgency').some((re) => re.test('Run')), true);
  assert.equal(lookup.dialogRunNames('bookingAgency').some((re) => re.test('Search')), false);
  assert.equal(lookup.dialogRunNames('organization').some((re) => re.test('Run')), true);
  assert.equal(lookup.dialogRunNames('guest').some((re) => re.test('Search')), true);
});

test('toolbar query fill tries inputs from the right so a stuck last box cannot block Run', () => {
  assert.deepEqual(lookup.toolbarQueryOrder(3), [2, 1, 0]);
  assert.deepEqual(lookup.toolbarQueryOrder(0), []);
});

test('toolbar column labels are not query boxes', () => {
  assert.equal(lookup.isLookupColumnLabel('Name'), true);
  assert.equal(lookup.isLookupColumnLabel('(default)'), true);
  assert.equal(lookup.isLookupColumnLabel('Woolworths Holdings'), false);
});

test('borrowed CDP teardown never closes the owner browser', () => {
  assert.equal(lookup.BORROWED_CLOSE_OWNER, false);
  assert.equal(lookup.CONNECT_MS, 25000);
});

test('query match keeps rows whose displayName contains the needle', () => {
  const rows = [
    { nativeId: '1', displayName: '4 Travel' },
    { nativeId: '2', displayName: 'IDC TRAVEL' },
  ];
  assert.deepEqual(lookup.rowsMatchingQuery(rows, 'IDC TRAVEL').map((row) => row.nativeId), ['2']);
  assert.equal(lookup.rowsMatchingQuery(rows, '').length, 2);
});

test('agency grid keeps blank IATA and uses agency name as displayName', () => {
  const row = lookup.cellsToRow(
    ['', 'CWT JNB', '26 Girton Road Parktown', 'Johannesburg', 'South Africa', 'Mashinini'],
    { kind: 'bookingAgency' },
  );
  assert.equal(row.displayName, 'CWT JNB');
  assert.equal(row.nativeId, 'CWT JNB');
});

test('agency IATA fills nativeId when present', () => {
  const row = lookup.cellsToRow(['77218175', 'IDC TRAVEL', 'address'], { kind: 'bookingAgency' });
  assert.equal(row.nativeId, '77218175');
  assert.equal(row.displayName, 'IDC TRAVEL');
});

test('guest form labels are not candidates', () => {
  assert.equal(lookup.cellsToRow(['Last Name:', 'First Name:'], { kind: 'guest' }), null);
  assert.equal(lookup.cellsToRow(['Email Address:'], { kind: 'guest' }), null);
  assert.equal(lookup.cellsToRow(['CRM Search:'], { kind: 'guest' }), null);
});

test('grid header rows are not candidates', () => {
  assert.equal(lookup.cellsToRow(['Guest ID', 'External ID', 'Last Name'], { kind: 'guest' }), null);
  assert.equal(lookup.cellsToRow(['IATA/Reference Number', 'Booking Agency Name'], { kind: 'bookingAgency' }), null);
});

test('organization id column still wins when present', () => {
  const row = lookup.cellsToRow(['49', 'Woolworths Holdings'], { kind: 'organization' });
  assert.equal(row.nativeId, '49');
  assert.equal(row.displayName, 'Woolworths Holdings');
});

test('needle that matches none of the visible rows is no_match not the unfiltered page', () => {
  const found = lookup.classifyKindRows(
    'organization',
    [{ nativeId: '1', displayName: '10X Investments' }],
    { query: { organizationName: 'Woolworths Holdings' } },
  );
  assert.equal(found.outcome, 'no_match');
  assert.equal(found.candidates.length, 0);
});

test('resolved outcome requires criteria and results screenshots', () => {
  const missing = lookup.applyScreenshotContract({
    outcome: 'resolved',
    candidates: [{ nativeId: '1', kind: 'organization', displayName: 'A' }],
    screenshots: { criteria: 'png/c-criteria.png' },
  });
  assert.notEqual(missing.outcome, 'resolved');
  const ok = lookup.applyScreenshotContract({
    outcome: 'resolved',
    candidates: [{ nativeId: '1', kind: 'organization', displayName: 'A' }],
    screenshots: { criteria: 'png/c-criteria.png', results: 'png/c-results.png' },
  });
  assert.equal(ok.outcome, 'resolved');
});

test('a filter reads back only when the query text is in the input', () => {
  assert.equal(lookup.filterReadsBack('Tourvest', 'TOURVEST'), true);
  assert.equal(lookup.filterReadsBack('360 degrees Travel', '360  Degrees Travel'), true);
  assert.equal(lookup.filterReadsBack('Tourvest', ''), false);
  assert.equal(lookup.filterReadsBack('Tourvest', 'Tour'), false);
  assert.equal(lookup.filterReadsBack('Tourvest', 'Woolworths Holdings'), false);
  assert.equal(lookup.filterReadsBack('', ''), false);
});

test('a filter that did not apply is execution_failure with filter_not_applied, never no_match', () => {
  const failed = lookup.filterNotApplied();
  assert.equal(failed.outcome, 'execution_failure');
  assert.deepEqual(failed.candidates, []);
  assert.equal(failed.truncated, false);
  assert.equal(failed.issues[0].reason, 'filter_not_applied');
});

test('a full lookup store (50 rows) is truncated; fewer is not', () => {
  assert.equal(lookup.HMS_LOOKUP_PAGE_ROWS, 50);
  assert.equal(lookup.lookupTruncated(50), true);
  assert.equal(lookup.lookupTruncated(49), false);
  assert.equal(lookup.lookupTruncated(0), false);
  const rows = [{ nativeId: '206', displayName: 'Tourvest Test Profile', matchedOn: ['store'] }];
  const full = lookup.classifyKindRows('organization', rows, { query: { organizationName: 'Tourvest' } }, 50);
  assert.equal(full.outcome, 'resolved');
  assert.equal(full.truncated, true);
  const partial = lookup.classifyKindRows('organization', rows, { query: { organizationName: 'Tourvest' } }, 12);
  assert.equal(partial.truncated, false);
});

test('a company query keeps the matching company row and drops the rest of a filtered grid', () => {
  const found = lookup.classifyKindRows(
    'organization',
    [
      { nativeId: '206', displayName: 'Tourvest Test Profile', matchedOn: ['store'] },
      { nativeId: '207', displayName: 'Unrelated Company', matchedOn: ['store'] },
    ],
    { query: { organizationName: 'Tourvest' } },
  );
  assert.equal(found.outcome, 'resolved');
  assert.deepEqual(found.candidates.map((c) => c.nativeId), ['206']);
  assert.equal(found.candidates[0].kind, 'organization');
});

test('a result envelope is not truncated unless the lookup says so', () => {
  assert.equal(lookup.resultEnvelope().truncated, false);
  assert.equal(lookup.resultEnvelope({ outcome: 'no_match' }).truncated, false);
});

/** Fake clock for the lookup tests. Date.now and the page's waits both move it, so no test waits in real time. */
function fakeClock() {
  return { now: 0, advance(ms) { this.now += ms; } };
}

/** A "Processing request" locator whose first match is shown exactly while `shown()` is true. */
function maskLocator(shown) {
  return { count: async () => (shown() ? 1 : 0), nth: () => ({ isVisible: async () => shown() }) };
}

test('waitForFreshGrid: a mask still up at the timeout is busy, never settled', async () => {
  const clock = fakeClock();
  const page = { getByText: () => maskLocator(() => true), waitForTimeout: async (ms) => clock.advance(ms) };
  const read = async () => ({ rows: [], loaded: 0 });
  assert.equal(await lookup.waitForFreshGrid(page, 'organization', '0\u0002', { now: () => clock.now, read }), 'busy');
  assert.ok(clock.now >= lookup.LOOKUP_IDLE_TIMEOUT_MS);
});

test('waitForFreshGrid: a mask that shows and clears settles the grid', async () => {
  const clock = fakeClock();
  const page = {
    getByText: () => maskLocator(() => clock.now >= 1000 && clock.now < 3000),
    waitForTimeout: async (ms) => clock.advance(ms),
  };
  const read = async () => ({ rows: [], loaded: 0 });
  assert.equal(await lookup.waitForFreshGrid(page, 'organization', '0\u0002', { now: () => clock.now, read }), 'settled');
});

test('waitForFreshGrid: no mask and no change inside the window is not verified, not an empty answer', async () => {
  const clock = fakeClock();
  const page = { getByText: () => maskLocator(() => false), waitForTimeout: async (ms) => clock.advance(ms) };
  const read = async () => ({ rows: [{ nativeId: '207', displayName: 'Unrelated Company' }], loaded: 1 });
  const before = lookup.gridKey({ rows: [{ nativeId: '207', displayName: 'Unrelated Company' }], loaded: 1 });
  assert.equal(await lookup.waitForFreshGrid(page, 'organization', before, { now: () => clock.now, read }), 'not_verified');
  assert.ok(clock.now >= lookup.LOOKUP_CHANGE_WINDOW_MS);
});

test('waitForFreshGrid: a grid that changes from the snapshot settles without a mask', async () => {
  const clock = fakeClock();
  const page = { getByText: () => maskLocator(() => false), waitForTimeout: async (ms) => clock.advance(ms) };
  const read = async () => (clock.now >= 2000
    ? { rows: [{ nativeId: '206', displayName: 'Tourvest Test Profile' }], loaded: 1 }
    : { rows: [{ nativeId: '207', displayName: 'Unrelated Company' }], loaded: 1 });
  const before = lookup.gridKey({ rows: [{ nativeId: '207', displayName: 'Unrelated Company' }], loaded: 1 });
  assert.equal(await lookup.waitForFreshGrid(page, 'organization', before, { now: () => clock.now, read }), 'settled');
});

test('waitForFreshGrid: a reload that starts late, inside the window, still settles', async () => {
  const clock = fakeClock();
  const page = {
    getByText: () => maskLocator(() => clock.now >= 9000 && clock.now < 12000),
    waitForTimeout: async (ms) => clock.advance(ms),
  };
  const read = async () => ({ rows: [{ nativeId: '207', displayName: 'Unrelated Company' }], loaded: 1 });
  const before = lookup.gridKey({ rows: [{ nativeId: '207', displayName: 'Unrelated Company' }], loaded: 1 });
  assert.equal(await lookup.waitForFreshGrid(page, 'organization', before, { now: () => clock.now, read }), 'settled');
});

test('the failure results name the step that was not verified, and are never no_match', () => {
  const busy = lookup.lookupBusyTimeout();
  assert.equal(busy.outcome, 'execution_failure');
  assert.equal(busy.issues[0].reason, 'lookup_busy_timeout');
  const unverified = lookup.filterNotVerified('grid_not_refreshed');
  assert.equal(unverified.outcome, 'execution_failure');
  assert.deepEqual(unverified.candidates, []);
  assert.equal(unverified.issues[0].reason, 'filter_not_verified');
  assert.equal(unverified.issues[0].detail, 'grid_not_refreshed');
});

test('rows that do not answer the query make the grid unverified, row by row', () => {
  assert.equal(lookup.rowAnswersQuery({ nativeId: '206', displayName: 'Tourvest Test Profile' }, 'TOURVEST'), true);
  assert.equal(lookup.rowAnswersQuery({ nativeId: '207', displayName: 'Unrelated Company' }, 'Tourvest'), false);
  assert.equal(lookup.rowAnswersQuery({ nativeId: '49', displayName: 'Woolworths' }, '49'), true);
  assert.equal(lookup.gridAnswersQuery([{ nativeId: '206', displayName: 'Tourvest Test Profile' }], 'Tourvest'), true);
  assert.equal(
    lookup.gridAnswersQuery(
      [{ nativeId: '206', displayName: 'Tourvest Test Profile' }, { nativeId: '207', displayName: 'Unrelated Company' }],
      'Tourvest',
    ),
    false,
  );
});

/** One response line for the fake page. Its body is read by the matcher, as a real request's would be. */
function fakeResponse({ url, postData = '', status = 200 }) {
  return {
    url: () => url,
    status: () => status,
    request: () => ({ postData: () => postData, method: () => 'POST' }),
    finished: async () => null,
  };
}

/**
 * A fake page for searchKind. The lookup store, the Run control, the busy mask and the store's answer all follow the fake
 * clock, so the scenarios run without a browser and without waiting in real time. `answer` is the store's answer to the Run
 * click, { after, status, url, postData }; without it no answer comes. The clock moves in 50 ms steps, so a mask that shows
 * and clears between two polls is still seen by a watcher armed before the click.
 */
function searchPage({ clock, store, runButton = true, runThrows = false, mask = () => false, onRun = () => {}, answer = null, selectorLabel = 'Name', windowOpen = () => true, openAfterClicks = null }) {
  const values = new Map();
  // The lookup's dialog is open when windowOpen() holds, or, with openAfterClicks, once the trigger has been clicked that often.
  let triggerClicks = 0;
  const windowIsOpen = () => (openAfterClicks === null ? windowOpen() : triggerClicks >= openAfterClicks);
  // The dialog's row: a saved-search combo, the read-only field selector, and the empty filter box; the Run button follows at the right.
  const INPUTS = [
    { x: 248, y: 212, width: 248, height: 26, readonly: false, value: '360 degrees' },
    { x: 603, y: 212, width: 200, height: 26, readonly: true, value: selectorLabel },
    { x: 851, y: 212, width: 134, height: 26, readonly: false, value: '' },
  ];
  const RUN_BOX = { x: 990, y: 212, width: 40, height: 28 };
  const inputIndex = (desc) => {
    const m = /input:visible#(\d+)$/.exec(desc);
    return m ? Number(m[1]) : null;
  };
  // The Run control: found by role (/^Run$/), or by its text (/^\s*Run\s*$/) on an ExtJS a.x-btn.
  const isRunButton = (desc) => desc.includes('^Run$') || desc.includes('^\\s*Run\\s*$');
  const initialValueOf = (desc) => {
    const k = inputIndex(desc);
    return k === null ? '' : INPUTS[k].value;
  };
  const boundingBoxOf = (desc) => {
    const k = inputIndex(desc);
    if (k !== null) {
      const { x, y, width, height } = INPUTS[k];
      return { x, y, width, height };
    }
    return isRunButton(desc) ? RUN_BOX : null;
  };
  const attributeOf = (desc, name) => {
    const k = inputIndex(desc);
    if (k === null) return null;
    if (name === 'type') return 'text';
    return name === 'readonly' && INPUTS[k].readonly ? '' : null;
  };
  const enabledOf = (desc) => {
    if (!isRunButton(desc)) return true;
    const filterKey = desc.replace(/ >> role=button:.*$/, '') + ' >> input:visible#2';
    return (values.get(filterKey) ?? '').trim().length > 0;
  };
  const answerWaiters = [];
  const pendingAnswers = [];
  const maskWaiters = [];
  const emitAnswer = (response) => {
    for (const waiter of answerWaiters.splice(0)) {
      if (waiter.predicate(response)) waiter.resolve(response);
      else answerWaiters.push(waiter);
    }
  };
  const flushAnswers = () => {
    for (const item of pendingAnswers.splice(0)) {
      if (item.at <= clock.now) emitAnswer(item.response);
      else pendingAnswers.push(item);
    }
  };
  const checkMask = () => {
    if (!mask()) return;
    for (const resolve of maskWaiters.splice(0)) resolve();
  };
  const scheduleAnswer = () => {
    if (!answer) return;
    const response = fakeResponse(answer);
    if (answer.after <= 0) emitAnswer(response);
    else pendingAnswers.push({ at: clock.now + answer.after, response });
  };
  const counts = (desc) => {
    if (inputIndex(desc) !== null) return 1;
    if (desc.endsWith('input:visible')) return INPUTS.length;
    if (desc.includes('Processing request')) return mask() ? 1 : 0;
    if (isRunButton(desc)) return runButton ? 1 : 0;
    if (desc.includes('ff_companyname')) return 1;
    if (desc.includes('.x-window') && !desc.includes('.x-grid') && !desc.includes('input')) return windowIsOpen() ? 1 : 0;
    return 0;
  };
  const loc = (desc) => {
    const self = {
      locator: (s) => loc(`${desc} >> ${s}`),
      filter: (o) => loc(`${desc}${o?.hasText ? ` >> hasText:${String(o.hasText)}` : ''}`),
      first: () => self,
      last: () => self,
      nth: (i) => loc(`${desc}#${i}`),
      boundingBox: async () => boundingBoxOf(desc),
      getAttribute: async (name) => attributeOf(desc, name),
      isEnabled: async () => enabledOf(desc),
      getByRole: (role, o) => loc(`${desc} >> role=${role}:${String(o?.name)}`),
      getByText: (re) => loc(`${desc} >> text:${String(re)}`),
      count: async () => counts(desc),
      isVisible: async () => counts(desc) > 0,
      waitFor: ({ state = 'visible' } = {}) => {
        if (state !== 'visible' || !desc.includes('Processing request')) return Promise.resolve();
        return new Promise((resolve) => maskWaiters.push(resolve));
      },
      click: async () => {
        if (desc.includes('x-form-lov-trigger')) triggerClicks += 1;
        if (isRunButton(desc)) {
          if (runThrows) throw new Error('click intercepted');
          onRun();
          scheduleAnswer();
        }
      },
      fill: async (v) => values.set(desc, String(v)),
      inputValue: async () => values.get(desc) ?? initialValueOf(desc),
      press: async () => {},
      innerText: async () => '',
      evaluate: async (fn, arg) => (arg === undefined ? store() : { rows: [], loaded: 0 }),
    };
    return self;
  };
  const page = loc('page');
  page.waitForTimeout = async (ms) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      clock.advance(Math.min(50, ms - elapsed));
      checkMask();
      flushAnswers();
    }
  };
  page.waitForResponse = (predicate) => new Promise((resolve) => answerWaiters.push({ predicate, resolve }));
  page.setDefaultTimeout = () => {};
  return page;
}

async function withFakeClock(clock, run) {
  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
}

const TOURVEST_REQUEST = { kind: 'organization', query: { organizationName: 'Tourvest' } };
const TOURVEST = [{ companyid: 206, companyname: 'Tourvest Test Profile' }];
const UNRELATED = [{ companyid: 207, companyname: 'Unrelated Company' }];

test('a search whose store reloads and settles answers from the grid that matches the query', async () => {
  const clock = fakeClock();
  let busyFrom = Infinity;
  let busyUntil = Infinity;
  const page = searchPage({
    clock,
    store: () => TOURVEST,
    mask: () => clock.now >= busyFrom && clock.now < busyUntil,
    onRun: () => {
      busyFrom = clock.now;
      busyUntil = clock.now + 3000;
    },
  });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'resolved');
  assert.deepEqual(found.candidates.map((c) => c.nativeId), ['206']);
});

test('a store that never settles is lookup_busy_timeout, with no candidates', async () => {
  const clock = fakeClock();
  let busyFrom = Infinity;
  const page = searchPage({
    clock,
    store: () => [],
    mask: () => clock.now >= busyFrom,
    onRun: () => {
      busyFrom = clock.now;
    },
  });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'execution_failure');
  assert.deepEqual(found.candidates, []);
  assert.equal(found.issues[0].reason, 'lookup_busy_timeout');
});

test('a dialog that never opens is lookup_window_not_opened after the retry, and nothing is read from another window', async () => {
  const clock = fakeClock();
  const page = searchPage({ clock, store: () => TOURVEST, windowOpen: () => false });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'execution_failure');
  assert.equal(found.issues[0].reason, 'lookup_window_not_opened');
  assert.deepEqual(found.candidates, []);
});

test('a dropped trigger click is retried once after eight seconds, and the search then runs', async () => {
  const clock = fakeClock();
  let busyFrom = Infinity;
  let busyUntil = Infinity;
  const page = searchPage({
    clock,
    store: () => TOURVEST,
    openAfterClicks: 2,
    mask: () => clock.now >= busyFrom && clock.now < busyUntil,
    onRun: () => {
      busyFrom = clock.now;
      busyUntil = clock.now + 3000;
    },
  });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'resolved');
  assert.ok(clock.now >= 8000, 'the retry waits eight seconds before it clicks the trigger again');
});

test('a dialog that opens behind a Processing request mask is waited for before the query goes in', async () => {
  const clock = fakeClock();
  let busyFrom = Infinity;
  let busyUntil = Infinity;
  const page = searchPage({
    clock,
    store: () => TOURVEST,
    windowOpen: () => clock.now >= 3000,
    mask: () => clock.now < 5000 || (clock.now >= busyFrom && clock.now < busyUntil),
    onRun: () => {
      busyFrom = clock.now;
      busyUntil = clock.now + 3000;
    },
  });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'resolved');
  assert.equal(lookup.lookupWindowNotOpened().issues[0].reason, 'lookup_window_not_opened');
});

test('a search with no Run control is never read as no_match', async () => {
  const clock = fakeClock();
  const page = searchPage({ clock, store: () => UNRELATED, runButton: false });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'execution_failure');
  // The filter cannot be typed into a window with no Run button, so the failure is at the filter, with that reason.
  assert.equal(found.issues[0].reason, 'filter_not_applied');
  assert.equal(found.issues[0].detail, 'no_run_button');
});

test('a Run click that fails is execution_failure, not a read of the old grid', async () => {
  const clock = fakeClock();
  const page = searchPage({ clock, store: () => UNRELATED, runThrows: true });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'execution_failure');
  assert.equal(found.issues[0].detail, 'run_not_clicked');
});

test('a grid that never changes and never shows the mask is not verified after the window, not no_match', async () => {
  const clock = fakeClock();
  const page = searchPage({ clock, store: () => TOURVEST });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'execution_failure');
  assert.equal(found.issues[0].reason, 'filter_not_verified');
  assert.equal(found.issues[0].detail, 'grid_not_refreshed');
});

test('a late reload that starts after the Run is still read once it settles, never as the stale grid', async () => {
  const clock = fakeClock();
  let runAt = Infinity;
  const page = searchPage({
    clock,
    store: () => (clock.now >= runAt + 12000 ? TOURVEST : UNRELATED),
    mask: () => clock.now >= runAt + 9000 && clock.now < runAt + 12000,
    onRun: () => {
      runAt = clock.now;
    },
  });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.notEqual(found.outcome, 'no_match');
  assert.equal(found.outcome, 'resolved');
});

test('a grid that changed to rows the query did not filter is not verified, never the answer', async () => {
  const clock = fakeClock();
  let busyFrom = Infinity;
  let busyUntil = Infinity;
  const page = searchPage({
    clock,
    store: () => UNRELATED,
    mask: () => clock.now >= busyFrom && clock.now < busyUntil,
    onRun: () => {
      busyFrom = clock.now;
      busyUntil = clock.now + 3000;
    },
  });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'execution_failure');
  assert.equal(found.issues[0].detail, 'rows_do_not_answer_query');
});

// A synthetic path: the matcher reads the query in the request's URL or body, so the path does not matter.
const ANSWER_URL = '/lookup/search';

test('a fast answer with an empty grid is no_match, never a failure: the store answered for this query', async () => {
  const clock = fakeClock();
  const page = searchPage({
    clock,
    store: () => [],
    answer: { after: 0, url: ANSWER_URL, postData: '{"organizationName":"Tourvest"}' },
  });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'no_match');
  assert.deepEqual(found.candidates, []);
});

test('a fast answer whose unchanged rows answer the query is resolved', async () => {
  const clock = fakeClock();
  const page = searchPage({
    clock,
    store: () => TOURVEST,
    answer: { after: 0, url: ANSWER_URL, postData: 'organizationName=Tourvest' },
  });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'resolved');
  assert.deepEqual(found.candidates.map((c) => c.nativeId), ['206']);
});

test('no answer to the search, and an empty grid that never changes, is a failure after the window, never no_match', async () => {
  const clock = fakeClock();
  const page = searchPage({ clock, store: () => [] });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'execution_failure');
  assert.equal(found.issues[0].detail, 'grid_not_refreshed');
});

test('an answer that does not carry this query is not this search: an empty grid stays a failure', async () => {
  const clock = fakeClock();
  const page = searchPage({
    clock,
    store: () => [],
    answer: { after: 0, url: ANSWER_URL, postData: '{"organizationName":"Unrelated Company"}' },
  });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'execution_failure');
  assert.equal(found.issues[0].detail, 'grid_not_refreshed');
});

test('an answer that is not 200 is a failure, never a read of the grid', async () => {
  const clock = fakeClock();
  const page = searchPage({
    clock,
    store: () => TOURVEST,
    answer: { after: 0, status: 500, url: ANSWER_URL, postData: '{"organizationName":"Tourvest"}' },
  });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'execution_failure');
  assert.equal(found.issues[0].detail, 'store_answer_failed');
});

test('a slow answer that lands while the mask shows is read once the mask clears and the grid agrees', async () => {
  const clock = fakeClock();
  let runAt = Infinity;
  const page = searchPage({
    clock,
    store: () => TOURVEST,
    mask: () => clock.now >= runAt && clock.now < runAt + 2000,
    onRun: () => {
      runAt = clock.now;
    },
    answer: { after: 1000, url: ANSWER_URL, postData: '{"organizationName":"Tourvest"}' },
  });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'resolved');
  assert.deepEqual(found.candidates.map((c) => c.nativeId), ['206']);
});

test('a mask that shows and clears between two polls is still seen, so an unchanged grid is settled', async () => {
  const clock = fakeClock();
  let runAt = Infinity;
  const page = searchPage({
    clock,
    store: () => TOURVEST,
    mask: () => clock.now >= runAt + 100 && clock.now < runAt + 200,
    onRun: () => {
      runAt = clock.now;
    },
  });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'resolved');
});

test('names in any script match their own read-back: Chinese, and accents folded like Zoë and Société', () => {
  assert.equal(lookup.filterReadsBack('李明', '李明'), true);
  assert.equal(lookup.filterReadsBack('Zoë', 'Zoë'), true);
  assert.equal(lookup.filterReadsBack('Zoë', 'ZOE'), true);
  assert.equal(lookup.filterReadsBack('Société', 'Societe'), true);
  assert.equal(lookup.filterReadsBack('李明', '李'), false);
  assert.equal(lookup.filterReadsBack('Zoë', 'Zo'), false);
  assert.equal(lookup.filterReadsBack('李明', ''), false);
  assert.equal(lookup.filterReadsBack('!!!', '!!!'), false);
  assert.equal(lookup.rowAnswersQuery({ nativeId: '1', displayName: 'Société Générale' }, 'Société'), true);
  assert.equal(lookup.rowAnswersQuery({ nativeId: '2', displayName: '李明 有限公司' }, '李明'), true);
  assert.equal(lookup.rowAnswersQuery({ nativeId: '3', displayName: 'Unrelated' }, '李明'), false);
});

test('a search for a Chinese company name is answered from its grid, not filter_not_applied', async () => {
  const clock = fakeClock();
  let busyFrom = Infinity;
  let busyUntil = Infinity;
  const store = [{ companyid: 301, companyname: '李明 有限公司' }];
  const page = searchPage({
    clock,
    store: () => store,
    mask: () => clock.now >= busyFrom && clock.now < busyUntil,
    onRun: () => {
      busyFrom = clock.now;
      busyUntil = clock.now + 3000;
    },
  });
  const found = await withFakeClock(clock, () =>
    lookup.searchKind(page, { kind: 'organization', query: { organizationName: '李明' } }),
  );
  assert.equal(found.outcome, 'resolved');
  assert.deepEqual(found.candidates.map((c) => c.nativeId), ['301']);
});

test('a processing mask that is hidden does not hold the lookup busy: the grid change settles it', async () => {
  const clock = fakeClock();
  const page = {
    getByText: () => ({ count: async () => 1, nth: () => ({ isVisible: async () => false }) }),
    waitForTimeout: async (ms) => clock.advance(ms),
  };
  const before = lookup.gridKey({ rows: [{ nativeId: '207', displayName: 'Unrelated Company' }], loaded: 1 });
  const read = async () =>
    clock.now >= 2000
      ? { rows: [{ nativeId: '206', displayName: 'Tourvest Test Profile' }], loaded: 1 }
      : { rows: [{ nativeId: '207', displayName: 'Unrelated Company' }], loaded: 1 };
  assert.equal(await lookup.waitForFreshGrid(page, 'organization', before, { now: () => clock.now, read }), 'settled');
  assert.ok(clock.now < lookup.LOOKUP_IDLE_TIMEOUT_MS);
});

test('accents and punctuation do not drop a company whose name is the same text', () => {
  const societe = lookup.classifyKindRows(
    'organization',
    [{ nativeId: '7', displayName: 'Société Générale', matchedOn: ['store'] }],
    { query: { organizationName: 'Societe' } },
  );
  assert.equal(societe.outcome, 'resolved');
  assert.deepEqual(societe.candidates.map((c) => c.nativeId), ['7']);
  const pnp = lookup.classifyKindRows(
    'organization',
    [{ nativeId: '8', displayName: 'Pick ’n Pay Hypermarket', matchedOn: ['store'] }],
    { query: { organizationName: 'Pick n Pay' } },
  );
  assert.equal(pnp.outcome, 'resolved');
  assert.equal(lookup.filterReadsBack('Pick n Pay', 'Pick ’n Pay'), true);
  assert.equal(lookup.filterReadsBack('Societe', 'Société'), true);
  assert.deepEqual(lookup.rowsMatchingQuery([{ nativeId: '9', displayName: 'Zoë Travel' }], 'zoe').map((r) => r.nativeId), ['9']);
});

const GUEST_EMAIL = 'guest.lookup@example.test';
const GUEST_EMAIL_REQUEST = { kind: 'guest', query: { email: GUEST_EMAIL } };

/**
 * Guest search with the live race: a menu-bar `.x-window` is already visible (one `appmenusearch`
 * input). The named Guest Search window appears after the trigger click plus `guestDelayMs`.
 * `emailaddress` can lag the window (`fieldDelayMs`) or never appear (`neverField`).
 * `namedSearch` is the Search control inside that window; `decoySearch` is Search in another
 * visible window. `neverOpen` never shows the named window. Clicks on Search are recorded.
 */
function guestSearchPage({
  clock,
  guestDelayMs = 0,
  fieldDelayMs = 0,
  neverOpen = false,
  neverField = false,
  namedSearch = true,
  decoySearch = false,
}) {
  const typed = { emailaddress: '', appmenusearch: '' };
  const clicks = { namedSearch: 0, otherSearch: 0 };
  let clickedAt = null;
  const guestOpen = () => !neverOpen && clickedAt !== null && clock.now - clickedAt >= guestDelayMs;
  const fieldReady = () => guestOpen() && !neverField && clock.now - clickedAt >= guestDelayMs + fieldDelayMs;
  const isTrigger = (desc) => desc.includes('data-qtip') && desc.includes('Guest Search');
  const isSearchControl = (desc) =>
    (desc.includes('role=button') && desc.includes('^Search$'))
    || desc.includes('text:/^Search$/')
    || desc.includes('hasText:/^Search$/');
  const isNamedGuestWin = (desc) =>
    desc.includes('.x-window')
    && desc.includes('Guest Search')
    && !desc.includes('input')
    && !desc.includes('role=button')
    && !isSearchControl(desc);
  const isWindow = (desc) =>
    desc.includes('.x-window')
    && !desc.includes('.x-grid')
    && !desc.includes('input')
    && !desc.includes('role=button')
    && !isSearchControl(desc);
  const isEmail = (desc) => desc.includes('emailaddress');
  const isMenuSearch = (desc) => desc.includes('appmenusearch');
  const inNamedGuest = (desc) => desc.includes('Guest Search') && !isTrigger(desc);
  const counts = (desc) => {
    if (isTrigger(desc)) return 1;
    if (isEmail(desc)) return fieldReady() && inNamedGuest(desc) ? 1 : 0;
    if (isMenuSearch(desc)) return 1;
    if (isSearchControl(desc)) {
      if (inNamedGuest(desc)) return guestOpen() && namedSearch ? 1 : 0;
      return decoySearch ? 1 : 0;
    }
    if (isNamedGuestWin(desc)) return guestOpen() ? 1 : 0;
    if (isWindow(desc)) return 1;
    if (desc.includes('Processing request') || desc.includes('Cannot retrieve profile')) return 0;
    return 0;
  };
  const loc = (desc) => {
    const self = {
      locator: (s) => loc(`${desc} >> ${s}`),
      filter: (o) => loc(`${desc}${o?.hasText ? ` >> hasText:${String(o.hasText)}` : ''}`),
      first: () => self,
      last: () => self,
      nth: (i) => loc(`${desc}#${i}`),
      getByRole: (role, o) => loc(`${desc} >> role=${role}:${String(o?.name)}`),
      getByText: (re) => loc(`${desc} >> text:${String(re)}`),
      count: async () => counts(desc),
      isVisible: async () => counts(desc) > 0,
      waitFor: async () => {},
      click: async () => {
        if (isTrigger(desc) || (desc.includes('role=button') && /Guest Search/i.test(desc) && !isSearchControl(desc))) {
          clickedAt = clock.now;
        }
        if (isSearchControl(desc)) {
          if (inNamedGuest(desc)) clicks.namedSearch += 1;
          else clicks.otherSearch += 1;
        }
      },
      fill: async (v) => {
        if (isEmail(desc)) typed.emailaddress = String(v);
        if (isMenuSearch(desc)) typed.appmenusearch = String(v);
      },
      inputValue: async () => (isEmail(desc) ? typed.emailaddress : isMenuSearch(desc) ? typed.appmenusearch : ''),
      press: async () => {},
      innerText: async () => '',
      evaluate: async (fn, arg) => (arg === undefined ? [] : { rows: [], loaded: 0 }),
      getAttribute: async () => null,
      isEnabled: async () => true,
      boundingBox: async () => null,
    };
    return self;
  };
  const page = loc('page');
  page.typed = typed;
  page.clicks = clicks;
  page.waitForTimeout = async (ms) => {
    clock.advance(ms);
  };
  page.waitForResponse = () => new Promise(() => {});
  page.setDefaultTimeout = () => {};
  return page;
}

test('guest search waits for the named window so the email is typed there, not into the menu bar', async () => {
  const clock = fakeClock();
  const page = guestSearchPage({ clock, guestDelayMs: 800 });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, GUEST_EMAIL_REQUEST));
  assert.equal(page.typed.emailaddress, GUEST_EMAIL);
  assert.equal(page.typed.appmenusearch, '');
  assert.notEqual(found.issues?.[0]?.reason, 'lookup_window_not_opened');
});

test('guest search that never opens the named window is lookup_window_not_opened, and nothing is typed', async () => {
  const clock = fakeClock();
  const page = guestSearchPage({ clock, neverOpen: true });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, GUEST_EMAIL_REQUEST));
  assert.equal(found.outcome, 'execution_failure');
  assert.equal(found.issues[0].reason, 'lookup_window_not_opened');
  assert.deepEqual(found.candidates, []);
  assert.equal(page.typed.emailaddress, '');
  assert.equal(page.typed.appmenusearch, '');
});

test('guest search waits for emailaddress when the named window opens first', async () => {
  const clock = fakeClock();
  const page = guestSearchPage({ clock, guestDelayMs: 0, fieldDelayMs: 800 });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, GUEST_EMAIL_REQUEST));
  assert.equal(page.typed.emailaddress, GUEST_EMAIL);
  assert.equal(page.typed.appmenusearch, '');
  assert.notEqual(found.issues?.[0]?.reason, 'lookup_window_not_opened');
  assert.notEqual(found.issues?.[0]?.reason, 'filter_not_applied');
});

test('guest search that never shows the typed field is filter_not_applied, and Search is not clicked', async () => {
  const clock = fakeClock();
  const page = guestSearchPage({ clock, neverField: true });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, GUEST_EMAIL_REQUEST));
  assert.equal(found.outcome, 'execution_failure');
  assert.equal(found.issues[0].reason, 'filter_not_applied');
  assert.deepEqual(found.candidates, []);
  assert.equal(page.typed.emailaddress, '');
  assert.equal(page.clicks.namedSearch, 0);
  assert.equal(page.clicks.otherSearch, 0);
});

test('guest search with no Search control in the named window fails closed, and does not click Search in another window', async () => {
  const clock = fakeClock();
  const page = guestSearchPage({ clock, namedSearch: false, decoySearch: true });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, GUEST_EMAIL_REQUEST));
  assert.equal(found.outcome, 'execution_failure');
  assert.equal(found.issues[0].reason, 'filter_not_verified');
  assert.equal(found.issues[0].detail, 'search_not_found');
  assert.deepEqual(found.candidates, []);
  assert.equal(page.typed.emailaddress, GUEST_EMAIL);
  assert.equal(page.clicks.namedSearch, 0);
  assert.equal(page.clicks.otherSearch, 0);
});
