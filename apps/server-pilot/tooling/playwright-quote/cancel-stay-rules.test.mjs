import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  chooseStaySource, checkCdpEnv, exitCodeFor, findReasonIndex, formLabelKey, formPairsFromSnapshot, hmsDateToIso,
  identityCheck, isCancelledStatus, labGuard, lookupExitCode, normalizeReasons, parseBalanceValue, parseCancelArgs,
  parseDateWindowLabel, parseIsoDate, parseLookupArgs, parsePanelRows, parsePanelSnapshot, parsePenalty,
  parseQuickSearchRow, parseRecordsFooter, pickerMonthSteps, preflight, resolveOutcome, sameStayRows,
  searchGuestOutcome, stayFromFormPairs, stayIdentityVerdict, windowCovers,
} from './cancel-stay-rules.mjs';

function argv(overrides = {}) {
  const map = {
    '--confirmation': '57291630-1',
    '--arrival': '2027-09-14',
    '--mode': 'preview',
    '--out': '/tmp/cancel-stay-proof',
    ...overrides,
  };
  return Object.entries(map).filter(([, value]) => value !== undefined).flat();
}

test('parseCancelArgs accepts the documented usage and defaults the reason', () => {
  const parsed = parseCancelArgs(argv());
  assert.equal(parsed.ok, true, parsed.error);
  assert.deepEqual(parsed.args, {
    confirmation: '57291630-1',
    arrival: '2027-09-14',
    mode: 'preview',
    reason: 'Test Reservations',
    out: '/tmp/cancel-stay-proof',
    lastName: null,
  });
});

test('parseCancelArgs takes an optional --last-name surname and refuses anything that is not one', () => {
  assert.equal(parseCancelArgs(argv({ '--last-name': ' Labtest ' })).args.lastName, 'Labtest');
  assert.equal(parseCancelArgs(argv()).args.lastName, null);
  assert.match(parseCancelArgs(argv({ '--last-name': 'Labtest, Proof' })).error, /--last-name must be a surname/);
  assert.match(parseCancelArgs(argv({ '--last-name': '--mode' })).error, /Missing value for --last-name/);
});

test('parseCancelArgs accepts commit mode and an explicit reason', () => {
  const parsed = parseCancelArgs(argv({ '--mode': 'commit', '--reason': '  Duplicate Booking ' }));
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.args.mode, 'commit');
  assert.equal(parsed.args.reason, 'Duplicate Booking');
});

test('parseCancelArgs refuses each missing required flag with exit 2', () => {
  for (const flag of ['--confirmation', '--arrival', '--mode', '--out']) {
    const parsed = parseCancelArgs(argv({ [flag]: undefined }));
    assert.equal(parsed.ok, false, flag);
    assert.equal(parsed.exitCode, 2);
    assert.match(parsed.error, new RegExp(flag));
  }
});

test('parseCancelArgs rejects bad values, unknown, dangling and repeated flags', () => {
  assert.match(parseCancelArgs(argv({ '--mode': 'cancel' })).error, /--mode/);
  assert.match(parseCancelArgs(argv({ '--confirmation': 'ABC' })).error, /--confirmation/);
  assert.match(parseCancelArgs(argv({ '--arrival': '2027-02-30' })).error, /--arrival/);
  assert.match(parseCancelArgs(argv({ '--arrival': '14-SEP-2027' })).error, /--arrival/);
  assert.match(parseCancelArgs(argv({ '--reason': '   ' })).error, /--reason/);
  assert.match(parseCancelArgs([...argv(), '--force', 'yes']).error, /Unknown argument: --force/);
  assert.match(parseCancelArgs([...argv({ '--reason': undefined }), '--reason']).error, /Missing value for --reason/);
  assert.match(parseCancelArgs([...argv(), '--mode', 'commit']).error, /Repeated argument: --mode/);
});

test('preflight refuses arrivals before 2027-01-01 before any browser work', () => {
  const refused = preflight({ arrival: '2026-12-31' });
  assert.equal(refused.ok, false);
  assert.equal(refused.outcome, 'refused_not_lab');
  assert.equal(preflight({ arrival: '2027-01-01' }).ok, true);
});

test('hmsDateToIso reads HMS display dates and passes ISO through', () => {
  assert.equal(hmsDateToIso('14-SEP-2027'), '2027-09-14');
  assert.equal(hmsDateToIso('1-jan-2027'), '2027-01-01');
  assert.equal(hmsDateToIso('2027-09-14'), '2027-09-14');
  assert.equal(hmsDateToIso('30-FEB-2027'), null);
  assert.equal(hmsDateToIso('14-XYZ-2027'), null);
  assert.equal(hmsDateToIso(''), null);
  assert.equal(parseIsoDate('2027-9-14'), null);
});

test('labGuard needs last name Labtest and arrival on or after 2027-01-01', () => {
  assert.deepEqual(labGuard({ lastName: 'Labtest', arrival: '14-SEP-2027' }), { ok: true, reason: null, arrivalIso: '2027-09-14' });
  assert.equal(labGuard({ lastName: ' labtest ', arrival: '01-JAN-2027' }).ok, true);
  assert.equal(labGuard({ lastName: 'Smith', arrival: '14-SEP-2027' }).reason, 'last_name_not_labtest');
  assert.equal(labGuard({ lastName: 'Labtest Smith', arrival: '14-SEP-2027' }).ok, false);
  assert.equal(labGuard({ lastName: 'Labtest', arrival: '31-DEC-2026' }).reason, 'arrival_before_2027');
  assert.equal(labGuard({ lastName: 'Labtest', arrival: 'garbage' }).reason, 'arrival_unparsed');
});

test('identityCheck refuses real guests first and mismatched records next', () => {
  const args = { confirmation: '57291630-1', arrival: '2027-09-14' };
  const lab = { confirmation: '57291630-1', lastName: 'Labtest', arrival: '14-SEP-2027', status: 'Reserved' };
  assert.deepEqual(identityCheck(args, lab), { ok: true, outcome: null, reason: null });
  assert.equal(identityCheck(args, { ...lab, lastName: 'Smith' }).outcome, 'refused_not_lab');
  assert.equal(identityCheck(args, { ...lab, lastName: 'Smith', confirmation: '46184891-1' }).outcome, 'refused_not_lab');
  assert.equal(identityCheck(args, { ...lab, confirmation: '11110906-1' }).outcome, 'refused_identity_mismatch');
  assert.equal(identityCheck(args, { ...lab, arrival: '08-JUN-2027' }).outcome, 'refused_identity_mismatch');
});

test('isCancelledStatus reads Cancelled and Canceled only', () => {
  assert.equal(isCancelledStatus('Cancelled'), true);
  assert.equal(isCancelledStatus(' canceled '), true);
  assert.equal(isCancelledStatus('Reserved'), false);
  assert.equal(isCancelledStatus(''), false);
  assert.equal(isCancelledStatus(null), false);
});

test('normalizeReasons trims, collapses whitespace, drops blanks and duplicates', () => {
  assert.deepEqual(
    normalizeReasons(['  Test   Reservations ', '', 'Test Reservations', 'Duplicate Booking']),
    ['Test Reservations', 'Duplicate Booking'],
  );
});

test('findReasonIndex matches one option case-insensitively and refuses ambiguity', () => {
  assert.equal(findReasonIndex(['Duplicate Booking', 'Test  Reservations'], 'test reservations'), 1);
  assert.equal(findReasonIndex(['Test Reservations'], 'Rate Dispute'), -1);
  assert.equal(findReasonIndex(['Test Reservations', 'test reservations'], 'Test Reservations'), -1);
  assert.equal(findReasonIndex(['Test Reservations'], ''), -1);
});

test('parsePenalty captures the penalty sentence and amount, or null', () => {
  const seen = parsePenalty(['Reservation Cancellation  Cancellation Penalty of 2060.00 may be added to account. OK Cancel']);
  assert.equal(seen.amount, '2060.00');
  assert.match(seen.text, /Cancellation Penalty of 2060\.00 may be added to account\./);
  assert.equal(parsePenalty(['Cancellation Reason Test Reservations OK Cancel']), null);
  assert.equal(parsePenalty(['Cancellation Penalty may be added to account.']).amount, null);
  assert.equal(parsePenalty(['Cancellation Penalty of R2,060.00 may be added']).amount, 'R2,060.00');
});

test('resolveOutcome: preview must leave status unchanged; commit needs Cancelled on readback', () => {
  assert.equal(resolveOutcome({ mode: 'preview', statusBefore: 'Reserved', statusAfter: 'Reserved' }), 'preview_ok');
  assert.equal(resolveOutcome({ mode: 'preview', statusBefore: 'Reserved', statusAfter: 'Cancelled' }), 'execution_failure');
  assert.equal(resolveOutcome({ mode: 'preview', statusBefore: '', statusAfter: '' }), 'execution_failure');
  assert.equal(resolveOutcome({ mode: 'commit', statusBefore: 'Reserved', statusAfter: 'Cancelled' }), 'cancelled');
  assert.equal(resolveOutcome({ mode: 'commit', statusBefore: 'Reserved', statusAfter: 'Reserved' }), 'cancel_unconfirmed');
  assert.equal(resolveOutcome({ mode: 'commit', statusBefore: 'Reserved', statusAfter: null }), 'cancel_unconfirmed');
  assert.equal(resolveOutcome({ mode: 'commit', statusBefore: 'Cancelled', statusAfter: 'Cancelled' }), 'already_cancelled');
  assert.equal(resolveOutcome({ mode: 'preview', statusBefore: 'Cancelled', statusAfter: 'Cancelled' }), 'already_cancelled');
});

test('exitCodeFor maps ok to 0, refused to 2, everything else to 1', () => {
  for (const outcome of ['preview_ok', 'cancelled', 'already_cancelled']) assert.equal(exitCodeFor(outcome), 0, outcome);
  for (const outcome of ['refused_not_lab', 'refused_identity_mismatch', 'refused_reason_missing']) assert.equal(exitCodeFor(outcome), 2, outcome);
  for (const outcome of ['execution_failure', 'not_found', 'cancel_unconfirmed']) assert.equal(exitCodeFor(outcome), 1, outcome);
});

test('pickerMonthSteps counts month clicks from the picker title to the arrival month', () => {
  assert.equal(pickerMonthSteps('September 2026', '2027-09-14'), 12);
  assert.equal(pickerMonthSteps('November 2027', '2027-09-14'), -2);
  assert.equal(pickerMonthSteps('Sep 2027', '2027-09-14'), 0);
  assert.equal(pickerMonthSteps('Sept 2027', '2027-09-14'), 0);
  assert.equal(pickerMonthSteps('Sep 07, 2026 - Nov 06, 2026', '2027-09-14'), null);
});

test('parseDateWindowLabel reads the quick-search window and rejects reversed or invalid ranges', () => {
  assert.deepEqual(parseDateWindowLabel('Sep 14, 2027 - Nov 13, 2027'), { from: '2027-09-14', to: '2027-11-13' });
  assert.deepEqual(parseDateWindowLabel('Sept 1, 2026 - Oct 2, 2026'), { from: '2026-09-01', to: '2026-10-02' });
  assert.equal(parseDateWindowLabel('Nov 13, 2027 - Sep 14, 2027'), null);
  assert.equal(parseDateWindowLabel('Sep 31, 2027 - Nov 13, 2027'), null);
  assert.equal(parseDateWindowLabel('Sep 14, 2027'), null);
  assert.equal(parseDateWindowLabel(''), null);
});

test('windowCovers includes both window ends and refuses unknown windows', () => {
  const window = { from: '2027-09-14', to: '2027-11-13' };
  assert.equal(windowCovers(window, '2027-09-14'), true);
  assert.equal(windowCovers(window, '2027-11-13'), true);
  assert.equal(windowCovers(window, '2027-09-13'), false);
  assert.equal(windowCovers(window, '2027-11-14'), false);
  assert.equal(windowCovers(window, 'garbage'), false);
  assert.equal(windowCovers(null, '2027-09-14'), false);
});

test('parseQuickSearchRow reads conf, Last, First, status and arrival/departure from the dropdown row', () => {
  const row = parseQuickSearchRow(['57291630-1', 'Labtest, Nava', 'Cancelled', '14-SEP-2027', '15-SEP-2027'], '57291630-1');
  assert.deepEqual(row, {
    confirmation: '57291630-1',
    lastName: 'Labtest',
    firstName: 'Nava',
    status: 'Cancelled',
    arrival: '14-SEP-2027',
    departure: '15-SEP-2027',
  });
  assert.deepEqual(
    parseQuickSearchRow(['Sep 14, 2027 - Nov 13, 2027', 'All', 'In-House', '57291630-1', 'Labtest, Nava', 'Reserved', '14-SEP-2027', '15-SEP-2027', 'Records: 1 of 1'], '57291630-1'),
    { confirmation: '57291630-1', lastName: 'Labtest', firstName: 'Nava', status: 'Reserved', arrival: '14-SEP-2027', departure: '15-SEP-2027' },
  );
});

test('parseQuickSearchRow splits multi-line cells and keeps hyphen, apostrophe and multi-word names', () => {
  const row = parseQuickSearchRow(['  57291630-1 ', " Labtest,   Nava-Jo ", 'Checked In', '14-SEP-2027\n15-SEP-2027'], '57291630-1');
  assert.equal(row.firstName, 'Nava-Jo');
  assert.equal(row.status, 'Checked In');
  assert.equal(row.departure, '15-SEP-2027');
  assert.equal(parseQuickSearchRow(['57291630-1', "O'Neil, Anne", 'Reserved', '14-SEP-2027'], '57291630-1').lastName, "O'Neil");
});

test('parseQuickSearchRow returns null for any row it cannot read exactly', () => {
  const full = ['57291630-1', 'Labtest, Nava', 'Cancelled', '14-SEP-2027', '15-SEP-2027'];
  assert.equal(parseQuickSearchRow(full, '11110906-1'), null, 'other confirmation');
  assert.equal(parseQuickSearchRow(['57291630-1', '46184891-1', ...full.slice(1)], '57291630-1'), null, 'two confirmations');
  assert.equal(parseQuickSearchRow(['57291630-1', 'Labtest, Nava', 'Labtest, Ana', 'Cancelled', '14-SEP-2027'], '57291630-1'), null, 'two guests');
  assert.equal(parseQuickSearchRow(['57291630-1', 'Labtest, Nava', '14-SEP-2027', '15-SEP-2027'], '57291630-1'), null, 'no status');
  assert.equal(parseQuickSearchRow(['57291630-1', 'Labtest, Nava', 'Cancelled', 'Records: 1 of 1'], '57291630-1'), null, 'no date');
  assert.equal(parseQuickSearchRow(['57291630-1', 'Labtest, Nava', 'Cancelled', '31-FEB-2027'], '57291630-1'), null, 'impossible date');
  assert.equal(parseQuickSearchRow(['57291630-1', 'Labtest', 'Cancelled', '14-SEP-2027'], '57291630-1'), null, 'no first name separator');
  assert.equal(parseQuickSearchRow(null, '57291630-1'), null);
});

test('a parsed quick-search row feeds the identity guard: lab row passes, real guest is refused', () => {
  const args = { confirmation: '57291630-1', arrival: '2027-09-14' };
  const lab = parseQuickSearchRow(['57291630-1', 'Labtest, Nava', 'Reserved', '14-SEP-2027', '15-SEP-2027'], '57291630-1');
  assert.deepEqual(identityCheck(args, lab), { ok: true, outcome: null, reason: null });
  const guest = parseQuickSearchRow(['57291630-1', 'Smith, Jo', 'Reserved', '14-SEP-2027', '15-SEP-2027'], '57291630-1');
  assert.equal(identityCheck(args, guest).outcome, 'refused_not_lab');
  const otherArrival = parseQuickSearchRow(['57291630-1', 'Labtest, Nava', 'Reserved', '08-JUN-2027', '09-JUN-2027'], '57291630-1');
  assert.equal(identityCheck(args, otherArrival).outcome, 'refused_identity_mismatch');
});

test('parseBalanceValue reads the record balance with or without currency and thousands separators', () => {
  assert.equal(parseBalanceValue('0.00'), '0.00');
  assert.equal(parseBalanceValue('0.00 ZAR'), '0.00');
  assert.equal(parseBalanceValue('R2,060.00'), '2060.00');
  assert.equal(parseBalanceValue('ZAR 12.5'), '12.5');
  assert.equal(parseBalanceValue('-12.50'), '-12.50');
  assert.equal(parseBalanceValue(''), null);
  assert.equal(parseBalanceValue('n/a'), null);
  assert.equal(parseBalanceValue(null), null);
});

test('chooseStaySource prefers an open form for the same confirmation and falls back to the dropdown row', () => {
  const open = { confirmation: '57291630-1', lastName: 'Labtest', arrival: '14-SEP-2027', status: 'Cancelled' };
  const row = { locator: 'row-locator', row: { confirmation: '57291630-1' } };
  assert.equal(chooseStaySource({ confirmation: '57291630-1', open, row }), 'open_record');
  assert.equal(chooseStaySource({ confirmation: '57291630-1', open: { ...open, confirmation: '11110906-1' }, row }), 'row');
  assert.equal(chooseStaySource({ confirmation: '57291630-1', open: null, row }), 'row');
  assert.equal(chooseStaySource({ confirmation: '57291630-1', open, row, allowOpen: false }), 'row');
  assert.equal(chooseStaySource({ confirmation: '57291630-1', open, row: null, allowOpen: false }), null);
  assert.equal(chooseStaySource({ confirmation: '57291630-1', open: null, row: null }), null);
});

test('checkCdpEnv allows only a local borrowed browser with no credentials', () => {
  const ok = checkCdpEnv({ HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19223', HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed' });
  assert.deepEqual(ok, { ok: true, error: null, href: 'http://127.0.0.1:19223/' });
  assert.equal(checkCdpEnv({ HMS_STAGEHAND_CDP_URL: 'http://10.0.0.5:19223', HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed' }).error, 'PRIVATE_CDP_REQUIRED');
  assert.equal(checkCdpEnv({ HMS_STAGEHAND_CDP_URL: 'http://u:p@127.0.0.1:19223', HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed' }).error, 'PRIVATE_CDP_REQUIRED');
  assert.equal(checkCdpEnv({ HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19223', HMS_STAGEHAND_BROWSER_OWNERSHIP: 'owned' }).error, 'BORROWED_REQUIRED');
  assert.equal(checkCdpEnv({}).error, 'CDP_URL_REQUIRED');
});

test('cancel-stay.mjs never closes the browser, clicks OK only in the reason window, and guards main()', async () => {
  const source = await readFile(new URL('./cancel-stay.mjs', import.meta.url), 'utf8');
  assert.equal(/browser\.close\s*\(/.test(source), false);
  assert.match(source, /typeof browser\.disconnect === 'function'/);
  assert.match(source, /import \{[^}]*identityCheck[^}]*\} from '\.\/cancel-stay-rules\.mjs'/s);
  assert.match(source, /process\.argv\[1\] && resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)/);
  for (const name of ['window.png', 'found.png', 'opened.png', 'cancel-dialog.png', 'penalty.png', 'readback.png', 'failure.png']) {
    assert.ok(source.includes(name), name);
  }
  assert.equal((source.match(/=== 'OK'/g) || []).length, 1);
  const penaltyClicks = source.split('\n').filter((line) => /penalty/i.test(line) && /\.click\(/.test(line));
  assert.deepEqual(penaltyClicks, []);
});

test('cancel-stay.mjs never presses Enter in the header search and scopes the row lookup to the quick panel', async () => {
  const source = await readFile(new URL('./cancel-stay.mjs', import.meta.url), 'utf8');
  assert.equal(/press\('Enter'\)/.test(source), false);
  assert.match(source, /ancestor::\*\[contains\(\., "Records:"\)\]\[1\]/);
  assert.match(source, /In\.\?House/);
  assert.match(source, /readBalance\(page\)/);
});

// ---- Read-only lookups (stay-lookup.mjs) ----

const FIND = ['--mode', 'find', '--out', '/tmp/stay-lookup'];
const GUEST = ['--mode', 'search-guest', '--out', '/tmp/stay-lookup'];

test('parseLookupArgs accepts find by confirmation with an optional arrival', () => {
  assert.deepEqual(parseLookupArgs([...FIND, '--confirmation', '57291630-1']).args, {
    mode: 'find', confirmation: '57291630-1', arrival: null, lastName: null, departure: null, out: '/tmp/stay-lookup', debugHtml: false,
  });
  assert.deepEqual(parseLookupArgs([...FIND, '--confirmation', ' 57291630-1 ', '--arrival', '2027-09-14']).args, {
    mode: 'find', confirmation: '57291630-1', arrival: '2027-09-14', lastName: null, departure: null, out: '/tmp/stay-lookup', debugHtml: false,
  });
});

test('parseLookupArgs accepts search-guest with surname, arrival and an optional departure', () => {
  assert.deepEqual(parseLookupArgs([...GUEST, '--last-name', "  O'Neil-Jones ", '--arrival', '2027-09-14', '--departure', '2027-09-15']).args, {
    mode: 'search-guest', confirmation: null, arrival: '2027-09-14', lastName: "O'Neil-Jones", departure: '2027-09-15', out: '/tmp/stay-lookup', debugHtml: false,
  });
  assert.equal(parseLookupArgs([...GUEST, '--last-name', 'Labtest', '--arrival', '2027-09-14']).ok, true);
});

test('parseLookupArgs takes --debug-html as a switch in either mode, once, and never as a value', () => {
  assert.equal(parseLookupArgs([...FIND, '--confirmation', '57291630-1', '--debug-html']).args.debugHtml, true);
  assert.equal(parseLookupArgs([...GUEST, '--debug-html', '--last-name', 'Labtest', '--arrival', '2027-09-14']).args.debugHtml, true);
  assert.match(parseLookupArgs([...FIND, '--confirmation', '57291630-1', '--debug-html', '--debug-html']).error, /Repeated argument: --debug-html/);
  assert.match(parseLookupArgs([...FIND, '--out', '--debug-html', '--confirmation', '57291630-1']).error, /Missing value for --out/);
});

test('parseLookupArgs refuses flags that do not belong to the mode, and missing or repeated values', () => {
  assert.equal(parseLookupArgs([...FIND, '--confirmation', '57291630-1', '--last-name', 'Labtest']).args.lastName, 'Labtest', 'find takes an optional surname');
  assert.match(parseLookupArgs([...FIND, '--confirmation', '57291630-1', '--last-name', 'Labtest, Nava']).error, /--last-name must be a surname/);
  assert.match(parseLookupArgs([...FIND, '--confirmation', '57291630-1', '--departure', '2027-09-15']).error, /--departure is not valid/);
  assert.match(parseLookupArgs([...GUEST, '--last-name', 'Labtest', '--arrival', '2027-09-14', '--confirmation', '57291630-1']).error, /--confirmation is not valid with --mode search-guest/);
  assert.match(parseLookupArgs([...FIND]).error, /Required: --confirmation/);
  assert.match(parseLookupArgs(['--mode', 'find', '--confirmation', '57291630-1']).error, /Required: --out/);
  assert.match(parseLookupArgs(['--mode', 'cancel', '--out', '/tmp/x']).error, /--mode must be find or search-guest/);
  assert.match(parseLookupArgs([...FIND, '--confirmation', '57291630-1', '--confirmation', '11110906-1']).error, /Repeated argument/);
  assert.match(parseLookupArgs([...FIND, '--confirmation']).error, /Missing value for --confirmation/);
  assert.match(parseLookupArgs([...FIND, '--confirmation', '57291630-1', '--preview']).error, /Unknown argument/);
});

test('parseLookupArgs validates confirmation, dates and surname before any browser work', () => {
  assert.match(parseLookupArgs([...FIND, '--confirmation', 'ABC']).error, /must look like 57291630-1/);
  assert.match(parseLookupArgs([...FIND, '--confirmation', '57291630-1', '--arrival', '2027-02-30']).error, /--arrival must be a real calendar date/);
  assert.match(parseLookupArgs([...GUEST, '--last-name', 'Labtest', '--arrival', '14-SEP-2027']).error, /--arrival must be a real calendar date/);
  assert.match(parseLookupArgs([...GUEST, '--last-name', 'Labtest']).error, /Required: --arrival/);
  assert.match(parseLookupArgs([...GUEST, '--arrival', '2027-09-14']).error, /Required: --last-name/);
  assert.match(parseLookupArgs([...GUEST, '--last-name', 'Labtest, Nava', '--arrival', '2027-09-14']).error, /must be a surname/);
  assert.match(parseLookupArgs([...GUEST, '--last-name', 'Lab3', '--arrival', '2027-09-14']).error, /must be a surname/);
  assert.match(parseLookupArgs([...GUEST, '--last-name', 'Labtest', '--arrival', '2027-09-14', '--departure', '2027-09-14']).error, /after --arrival/);
  assert.match(parseLookupArgs([...GUEST, '--last-name', 'Labtest', '--arrival', '2027-09-14', '--departure', '2027-09-13']).error, /after --arrival/);
});

test('lookupExitCode is 0 for found, not_found and ok; every other outcome is 1', () => {
  for (const outcome of ['found', 'not_found', 'ok']) assert.equal(lookupExitCode(outcome), 0, outcome);
  for (const outcome of ['ambiguous', 'ambiguous_capped', 'execution_failure', null]) assert.equal(lookupExitCode(outcome), 1, String(outcome));
});

test('formLabelKey maps on-screen record labels and ignores the required-field dot and unmapped labels', () => {
  assert.equal(formLabelKey('Confirmation Number:•'), 'confirmation');
  assert.equal(formLabelKey('Source Of Business:'), 'sourceOfBusiness');
  assert.equal(formLabelKey('Primary Booking Agency:•'), 'bookingAgency');
  assert.equal(formLabelKey('Organization:'), 'organization');
  assert.equal(formLabelKey('Room Type:'), 'roomType');
  assert.equal(formLabelKey('Room Type for Charge:'), null);
  assert.equal(formLabelKey('Child 0 - 02:'), null);
  assert.equal(formLabelKey(''), null);
});

const FORM_FROM_FAILURE_PNG = [
  { label: 'Status:', value: 'Cancelled' },
  { label: 'Confirmation Number:•', value: '57291630-1' },
  { label: 'Last Name:', value: 'Labtest' },
  { label: 'First Name:', value: 'Nava' },
  { label: 'Arrival Date:', value: '14-SEP-2027' },
  { label: 'Departure Date:', value: '15-SEP-2027' },
  { label: 'Nights:', value: '1' },
  { label: 'Adults:', value: '1' },
  { label: 'Children:', value: '0' },
  { label: 'Child 0 - 02:', value: '0' },
  { label: 'Room Type:', value: 'STQN' },
  { label: 'Room Type for Charge:', value: '' },
  { label: 'Rate Plan:', value: 'BAR' },
  { label: 'Meal Plan:', value: 'Bed & Breakfast R' },
  { label: 'Guarantee Type:', value: 'Non-Guaranteed Indi...' },
  { label: 'Source Of Business:', value: 'Walk in' },
  { label: 'Primary Booking Agency:•', value: '' },
  { label: 'Organization:•', value: '' },
  { label: 'Average Rate:', value: '2,060.00' },
  { label: 'Grand Total:', value: '2,060.00' },
  { label: 'Balance:', value: '0.00' },
];

test('stayFromFormPairs maps the record form labels to typed fields', () => {
  const { stay, conflicts } = stayFromFormPairs(FORM_FROM_FAILURE_PNG);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(stay, {
    status: 'Cancelled',
    confirmation: '57291630-1',
    lastName: 'Labtest',
    firstName: 'Nava',
    arrival: '2027-09-14',
    departure: '2027-09-15',
    nights: 1,
    adults: 1,
    children: 0,
    roomType: 'STQN',
    ratePlan: 'BAR',
    mealPlan: 'Bed & Breakfast R',
    averageRate: '2060.00',
    grandTotal: '2060.00',
    balance: '0.00',
    sourceOfBusiness: 'Walk in',
    guaranteeType: 'Non-Guaranteed Indi...',
    bookingAgency: null,
    organization: null,
  });
});

test('stayFromFormPairs leaves a field null when two different values conflict, and ignores blanks', () => {
  const { stay, conflicts } = stayFromFormPairs([
    { label: 'Status:', value: 'Reserved' },
    { label: 'Status:', value: 'Cancelled' },
    { label: 'Status:', value: '  ' },
    { label: 'Nights:', value: 'one' },
    { label: 'Balance:', value: '' },
    { label: 'Adults:', value: '2' },
    { label: 'Adults:', value: '2' },
  ]);
  assert.deepEqual(conflicts, ['status']);
  assert.equal(stay.status, null);
  assert.equal(stay.nights, null, 'a non-numeric count is not guessed');
  assert.equal(stay.balance, null);
  assert.equal(stay.adults, 2, 'the same value twice is not a conflict');
});

test('stayIdentityVerdict finds the requested confirmation and arrival, and never guesses otherwise', () => {
  const stay = { confirmation: '57291630-1', arrival: '2027-09-14' };
  assert.deepEqual(stayIdentityVerdict({ confirmation: '57291630-1', arrival: null }, stay), { outcome: 'found', reason: null });
  assert.deepEqual(stayIdentityVerdict({ confirmation: '57291630-1', arrival: '2027-09-14' }, stay), { outcome: 'found', reason: null });
  assert.deepEqual(stayIdentityVerdict({ confirmation: '57291630-1', arrival: '2027-09-15' }, stay), { outcome: 'ambiguous', reason: 'arrival_mismatch' });
  assert.deepEqual(stayIdentityVerdict({ confirmation: '11110906-1', arrival: null }, stay), { outcome: 'ambiguous', reason: 'confirmation_mismatch' });
  assert.deepEqual(stayIdentityVerdict({ confirmation: '57291630-1', arrival: null }, { confirmation: null }), { outcome: 'execution_failure', reason: 'form_unreadable' });
  assert.deepEqual(stayIdentityVerdict({ confirmation: '57291630-1', arrival: null }, null), { outcome: 'execution_failure', reason: 'form_unreadable' });
});

test('parseRecordsFooter reads the shown and matched counts and rejects anything else', () => {
  assert.deepEqual(parseRecordsFooter('Records: 1 of 1'), { shown: 1, total: 1 });
  assert.deepEqual(parseRecordsFooter('Sep 14, 2027 - Nov 13, 2027\nRecords:  10 of 25'), { shown: 10, total: 25 });
  assert.equal(parseRecordsFooter('Records: 3 of 2'), null, 'shown above total is impossible');
  assert.equal(parseRecordsFooter('no footer here'), null);
  assert.equal(parseRecordsFooter(''), null);
});

test('parsePanelRows reads every dropdown row and counts the rows it cannot read exactly', () => {
  const parsed = parsePanelRows([
    ['57291630-1', 'Labtest, Nava', 'Cancelled', '14-SEP-2027', '15-SEP-2027'],
    ['46184891-1', 'Labtest, Ana', 'Reserved', '14-SEP-2027'],
    ['57291630-1', '46184891-1', 'Labtest, Nava', 'Reserved', '14-SEP-2027'],
    ['11110906-1', 'Labtest', 'Reserved', '14-SEP-2027'],
  ]);
  assert.deepEqual(parsed, {
    rows: [
      { confirmation: '57291630-1', lastName: 'Labtest', firstName: 'Nava', status: 'Cancelled', arrival: '2027-09-14', departure: '2027-09-15' },
      { confirmation: '46184891-1', lastName: 'Labtest', firstName: 'Ana', status: 'Reserved', arrival: '2027-09-14', departure: null },
    ],
    unreadable: 2,
  });
  assert.deepEqual(parsePanelRows([]), { rows: [], unreadable: 0 });
});

test('searchGuestOutcome is ok only when the footer accounts for every row read', () => {
  assert.deepEqual(searchGuestOutcome({ records: { shown: 0, total: 0 }, rows: [], unreadable: 0 }), { outcome: 'ok', reason: null });
  assert.deepEqual(searchGuestOutcome({ records: { shown: 1, total: 1 }, rows: [{}], unreadable: 0 }), { outcome: 'ok', reason: null });
  assert.deepEqual(searchGuestOutcome({ records: { shown: 10, total: 25 }, rows: Array(10).fill({}), unreadable: 0 }), { outcome: 'ambiguous_capped', reason: 'records_capped' });
  assert.deepEqual(searchGuestOutcome({ records: null, rows: [], unreadable: 0 }), { outcome: 'execution_failure', reason: 'records_footer_missing' });
  assert.deepEqual(searchGuestOutcome({ records: { shown: 2, total: 2 }, rows: [{}], unreadable: 1 }), { outcome: 'execution_failure', reason: 'rows_unreadable' });
  assert.deepEqual(searchGuestOutcome({ records: { shown: 2, total: 2 }, rows: [{}], unreadable: 0 }), { outcome: 'execution_failure', reason: 'row_count_mismatch' });
});

test('sameStayRows matches surname without case, arrival, and departure when given', () => {
  const rows = [
    { lastName: 'Labtest', arrival: '2027-09-14', departure: '2027-09-15', status: 'Reserved' },
    { lastName: 'LABTEST', arrival: '2027-09-14', departure: '2027-09-16', status: 'Reserved' },
    { lastName: 'Labtest', arrival: '2027-09-15', departure: '2027-09-16', status: 'Reserved' },
    { lastName: 'Labtests', arrival: '2027-09-14', departure: '2027-09-15', status: 'Reserved' },
  ];
  assert.deepEqual(sameStayRows(rows, { lastName: 'labtest', arrival: '2027-09-14', departure: '2027-09-15' }), [rows[0]]);
  assert.deepEqual(sameStayRows(rows, { lastName: 'Labtest', arrival: '2027-09-14', departure: null }), [rows[0], rows[1]]);
});

test('stay-lookup.mjs is read-only: no Enter, no Save, Actions, Cancel or OK clicks, no browser.close', async () => {
  const source = await readFile(new URL('./stay-lookup.mjs', import.meta.url), 'utf8');
  assert.equal(/press\('Enter'\)/.test(source), false);
  assert.equal(/browser\.close\s*\(/.test(source), false);
  assert.equal(/=== 'OK'/.test(source), false);
  const clicks = source.split('\n').filter((line) => /\.click\(/.test(line));
  assert.deepEqual(clicks.filter((line) => /Save|Actions|Cancel|OK|Reservation|delete|Remove/i.test(line)), []);
  assert.match(source, /from '\.\/cancel-stay\.mjs'/);
  assert.match(source, /from '\.\/cancel-stay-rules\.mjs'/);
  assert.match(source, /process\.argv\[1\] && resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)/);
  for (const name of ['record.png', 'panel.png', 'failure.png', 'result.json']) assert.ok(source.includes(name), name);
});

test('cancel-stay.mjs exports the helpers stay-lookup.mjs imports, and its cancel flow is unchanged', async () => {
  const source = await readFile(new URL('./cancel-stay.mjs', import.meta.url), 'utf8');
  for (const name of ['shot', 'readRecord', 'readBalance', 'openGuestStay', 'searchConfirmation', 'typeHeaderSearch', 'clickHeaderRun', 'pressArrowDown', 'clickInsideSearch', 'quickActions', 'readWindow', 'setQuickWindow', 'quickPanel', 'openRecord', 'findStay']) {
    assert.match(source, new RegExp(`export (async )?function ${name}\\(`), name);
  }
  assert.match(source, /runConfirmationSearch\(io, \{/);
  assert.match(source, /driveQuickSearch\(quickActions\(page, term\)/);
  assert.match(source, /moveWindow: \(\) => setQuickWindow\(page, args\.arrival\)/);
  assert.match(source, /if \(!args\.arrival\) return null;/);
});

// ---- Snapshot pairing and panel parsing (pure: the DOM is covered by stay-lookup-dom.test.mjs) ----

const label = (text, rows, forId = '') => ({ kind: 'label', text, forId, rows });
const field = (value, rows, id = '', name = '') => ({ kind: 'field', id, name, value, rows });

test('formPairsFromSnapshot pairs an input by its for attribute, then by the nearest earlier label in a shared row', () => {
  const entries = [
    label('Status:', [1], 'f-status'),
    field('Cancelled', [1], 'f-status', 'status'),
    label('Nights:', [2]),
    field('1', [3, 2], '', 'nights'),
    label('Room Type:', [4]),
    label('Room Type for Charge:', [5]),
    field('STQN', [6, 4], '', 'roomtype'),
    field('', [5], '', 'roomtypecharge'),
  ];
  assert.deepEqual(formPairsFromSnapshot(entries), [
    { label: 'Status:', value: 'Cancelled', name: 'status' },
    { label: 'Nights:', value: '1', name: 'nights' },
    { label: 'Room Type:', value: 'STQN', name: 'roomtype' },
  ]);
});

test('formPairsFromSnapshot never pairs across rows, never lets an unknown label claim an input, and claims a label once', () => {
  const entries = [
    label('Adults:', [1]),
    label('Walk In:', [1]),
    field('2', [1], '', 'adults'),
    label('Arrival Date:', [2]),
    field('14-SEP-2027', [3], '', 'arrivaldate'),
    label('Balance:', [4]),
    field('0.00', [4], '', 'balance'),
    field('9.99', [4], '', 'stray'),
  ];
  const pairs = formPairsFromSnapshot(entries);
  assert.deepEqual(pairs.map((pair) => pair.label), ['Adults:', 'Balance:']);
  assert.equal(pairs[0].value, '2');
  assert.equal(pairs.some((pair) => pair.name === 'arrivaldate'), false, 'the label is in another row');
});

test('parsePanelSnapshot reads a cell-split row, falls back to its lines, and returns the cells of an unreadable row', () => {
  const cellRow = {
    cells: ['57291630-1', 'Labtest, Nava', 'Cancelled', '14-SEP-2027\n15-SEP-2027'],
    lines: ['57291630-1', 'Labtest, Nava', 'Cancelled', '14-SEP-2027', '15-SEP-2027'],
  };
  const linesOnly = { cells: [], lines: ['46184891-1', 'Labtest, Ana', 'Reserved', '14-SEP-2027', '15-SEP-2027'] };
  const broken = { cells: ['57291630-1', 'Labtest, Nava'], lines: ['57291630-1', 'Labtest, Nava'] };
  const header = { cells: ['Conf', 'Guest', 'Status'], lines: ['Conf', 'Guest', 'Status'] };
  const parsed = parsePanelSnapshot({ rows: [cellRow, linesOnly, broken, header], unresolved: 0, footer: 'Records: 2 of 3' });
  assert.deepEqual(parsed.rows.map((row) => row.confirmation), ['57291630-1', '46184891-1']);
  assert.equal(parsed.unreadable, 1, 'the header has no confirmation and is not a data row');
  assert.deepEqual(parsed.unreadableRows, [broken]);
  assert.equal(parsePanelSnapshot({ rows: [], unresolved: 2 }).unreadable, 2);
});
