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
});

test('empty query is an input gap', () => {
  assert.ok(lookup.validateRequest({ kind: 'organization', query: {} }).length);
  assert.ok(lookup.validateRequest({ kind: 'guest', query: {} }).length);
});

test('organization name request validates', () => {
  assert.deepEqual(lookup.validateRequest({ kind: 'organization', query: { organizationName: 'ACME' } }), []);
});

test('store rows map travelagencyid when IATA is blank', () => {
  const row = lookup.rowFromStoreData({ travelagencyid: 290, travelagencyname: 'CWT JNB', iatanumber: '' });
  assert.equal(row.nativeId, '290');
  assert.equal(row.displayName, 'CWT JNB');
  const mapped = lookup.storeRowsForKind('bookingAgency', [{ travelagencyid: 290, travelagencyname: 'CWT JNB' }]);
  assert.equal(mapped[0].nativeId, '290');
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

test('waitForFreshGrid: a mask still up at the timeout is busy, never settled', async () => {
  const clock = fakeClock();
  const page = { getByText: () => ({ count: async () => 1 }), waitForTimeout: async (ms) => clock.advance(ms) };
  const read = async () => ({ rows: [], loaded: 0 });
  assert.equal(await lookup.waitForFreshGrid(page, 'organization', '0\u0002', { now: () => clock.now, read }), 'busy');
  assert.ok(clock.now >= lookup.LOOKUP_IDLE_TIMEOUT_MS);
});

test('waitForFreshGrid: a mask that shows and clears settles the grid', async () => {
  const clock = fakeClock();
  const page = {
    getByText: () => ({ count: async () => (clock.now >= 1000 && clock.now < 3000 ? 1 : 0) }),
    waitForTimeout: async (ms) => clock.advance(ms),
  };
  const read = async () => ({ rows: [], loaded: 0 });
  assert.equal(await lookup.waitForFreshGrid(page, 'organization', '0\u0002', { now: () => clock.now, read }), 'settled');
});

test('waitForFreshGrid: no mask and no change inside the window is not verified, not an empty answer', async () => {
  const clock = fakeClock();
  const page = { getByText: () => ({ count: async () => 0 }), waitForTimeout: async (ms) => clock.advance(ms) };
  const read = async () => ({ rows: [{ nativeId: '207', displayName: 'Unrelated Company' }], loaded: 1 });
  const before = lookup.gridKey({ rows: [{ nativeId: '207', displayName: 'Unrelated Company' }], loaded: 1 });
  assert.equal(await lookup.waitForFreshGrid(page, 'organization', before, { now: () => clock.now, read }), 'not_verified');
  assert.ok(clock.now >= lookup.LOOKUP_CHANGE_WINDOW_MS);
});

test('waitForFreshGrid: a grid that changes from the snapshot settles without a mask', async () => {
  const clock = fakeClock();
  const page = { getByText: () => ({ count: async () => 0 }), waitForTimeout: async (ms) => clock.advance(ms) };
  const read = async () => (clock.now >= 2000
    ? { rows: [{ nativeId: '206', displayName: 'Tourvest Test Profile' }], loaded: 1 }
    : { rows: [{ nativeId: '207', displayName: 'Unrelated Company' }], loaded: 1 });
  const before = lookup.gridKey({ rows: [{ nativeId: '207', displayName: 'Unrelated Company' }], loaded: 1 });
  assert.equal(await lookup.waitForFreshGrid(page, 'organization', before, { now: () => clock.now, read }), 'settled');
});

test('waitForFreshGrid: a reload that starts late, inside the window, still settles', async () => {
  const clock = fakeClock();
  const page = {
    getByText: () => ({ count: async () => (clock.now >= 9000 && clock.now < 12000 ? 1 : 0) }),
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

/**
 * A fake page for searchKind. The lookup store, the Run control and the busy mask all follow the fake clock, so the
 * scenarios run without a browser and without waiting in real time.
 */
function searchPage({ clock, store, runButton = true, runThrows = false, mask = () => false, onRun = () => {} }) {
  const values = new Map();
  const counts = (desc) => {
    if (desc.includes('Processing request')) return mask() ? 1 : 0;
    if (desc.includes('^Run$')) return runButton ? 1 : 0;
    if (desc.includes('ff_companyname')) return 1;
    if (desc.includes('.x-window') && !desc.includes('.x-grid') && !desc.includes('input')) return 1;
    return 0;
  };
  const loc = (desc) => {
    const self = {
      locator: (s) => loc(`${desc} >> ${s}`),
      filter: () => self,
      first: () => self,
      last: () => self,
      nth: () => self,
      getByRole: (role, o) => loc(`${desc} >> role=${role}:${String(o?.name)}`),
      getByText: (re) => loc(`${desc} >> text:${String(re)}`),
      count: async () => counts(desc),
      click: async () => {
        if (desc.includes('^Run$')) {
          if (runThrows) throw new Error('click intercepted');
          onRun();
        }
      },
      fill: async (v) => values.set(desc, String(v)),
      inputValue: async () => values.get(desc) ?? '',
      press: async () => {},
      innerText: async () => '',
      evaluate: async (fn, arg) => (arg === undefined ? store() : { rows: [], loaded: 0 }),
    };
    return self;
  };
  const page = loc('page');
  page.waitForTimeout = async (ms) => clock.advance(ms);
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

test('a search with no Run control is never read as no_match', async () => {
  const clock = fakeClock();
  const page = searchPage({ clock, store: () => UNRELATED, runButton: false });
  const found = await withFakeClock(clock, () => lookup.searchKind(page, TOURVEST_REQUEST));
  assert.equal(found.outcome, 'execution_failure');
  assert.equal(found.issues[0].reason, 'filter_not_verified');
  assert.equal(found.issues[0].detail, 'run_not_clicked');
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
