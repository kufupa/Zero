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
