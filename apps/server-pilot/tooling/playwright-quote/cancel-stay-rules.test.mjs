import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  cancelNoteFor, penaltyRefusal, runCancelDialog, unpaidCommitRefusal,
  chooseStaySource, checkCdpEnv, exitCodeFor, findReasonIndex, formLabelKey, formPairsFromSnapshot, hmsDateToIso,
  arrivalReport, identityCheck, isCancelledStatus, isStaleScreenError, labGuard, lookupExitCode, normalizeReasons, parseBalanceValue, parseCancelArgs,
  parseDateWindowLabel, parseIsoDate, parseLookupArgs, parsePanelRows, parsePanelSnapshot, parsePenalty, penaltyHasWaive,
  outcomeAfterFailure, pollUntil, SETTLE_BUDGET_MS, SETTLE_INTERVAL_MS, settleCancel, withStaleRecovery,
  parseQuickSearchRow, parseRecordsFooter, pickerMonthSteps, preflight, resolveOutcome, sameStayRows,
  searchGuestOutcome, stayChanges, stayFromFormPairs, stayIdentityVerdict, windowCovers,
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
    allowRealGuest: false,
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
  for (const outcome of ['refused_not_lab', 'refused_identity_mismatch', 'refused_reason_missing', 'refused_not_unpaid']) {
    assert.equal(exitCodeFor(outcome), 2, outcome);
  }
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

const UNPAID_FOLIO = {
  status: 'Reserved',
  guaranteeType: 'Non-Guaranteed Individual',
  depositReceived: '0',
};

test('commit refuses a paid or unknown folio and lets unpaid through; preview never refuses', () => {
  assert.equal(unpaidCommitRefusal('preview', { ...UNPAID_FOLIO, depositReceived: '250.00' }), null);
  assert.equal(unpaidCommitRefusal('preview', null), null);
  assert.equal(unpaidCommitRefusal('commit', UNPAID_FOLIO), null);
  assert.equal(unpaidCommitRefusal('commit', { ...UNPAID_FOLIO, depositReceived: '0.00' }), null);
  assert.equal(unpaidCommitRefusal('commit', { ...UNPAID_FOLIO, depositReceived: '' }), null);
  assert.equal(unpaidCommitRefusal('commit', { ...UNPAID_FOLIO, depositReceived: '250.00' }), 'refused_not_unpaid');
  assert.equal(
    unpaidCommitRefusal('commit', { ...UNPAID_FOLIO, guaranteeType: 'Guaranteed By Agent' }),
    'refused_not_unpaid',
  );
  assert.equal(unpaidCommitRefusal('commit', { ...UNPAID_FOLIO, depositReceived: null }), 'refused_not_unpaid');
  assert.equal(unpaidCommitRefusal('commit', { ...UNPAID_FOLIO, status: 'Confirmed' }), 'refused_not_unpaid');
  assert.equal(unpaidCommitRefusal('commit', null), 'refused_not_unpaid');
});

test('dismissLeftoverCancelWindows Escapes leftover windows and never clicks OK or Waive', async () => {
  const { dismissLeftoverCancelWindows } = await import('./cancel-stay.mjs');
  const actions = [];
  let leftover = 1;
  const leftoverLocator = {
    count: async () => leftover,
    locator: (sel) => ({
      count: async () => leftover,
      first: () => ({
        click: async () => {
          actions.push(`click:${sel}`);
          leftover = 0;
        },
      }),
    }),
  };
  const page = {
    locator: () => ({ filter: () => leftoverLocator }),
    keyboard: {
      press: async (key) => {
        actions.push(`press:${key}`);
        leftover = 0;
      },
    },
    waitForTimeout: async () => {},
  };
  await dismissLeftoverCancelWindows(page);
  assert.ok(actions.includes('press:Escape'));
  assert.equal(/ok|waive/i.test(actions.join(' ')), false);
  leftover = 0;
  actions.length = 0;
  await dismissLeftoverCancelWindows(page);
  assert.deepEqual(actions, []);
});

test('cancel-stay.mjs run() closes leftover cancel dialog before findStay', async () => {
  const source = await readFile(new URL('./cancel-stay.mjs', import.meta.url), 'utf8');
  const run = source.slice(source.indexOf('async function run(ctx)'), source.indexOf('async function drive(ctx)'));
  const openAt = run.indexOf('await openGuestStay(');
  const findAt = run.indexOf('findStay');
  const closeAt = run.search(/dismissLeftoverCancelWindows|closeCancelDialog/);
  assert.ok(openAt >= 0 && findAt > openAt, 'run() opens Guest Stay then finds');
  assert.ok(closeAt > openAt && closeAt < findAt, 'leftover cancel dialog must close before findStay');
  assert.equal(/clickReasonOk|clickPenaltyButton/.test(run.slice(openAt, findAt)), false);
});

test('cancel-stay.mjs checks unpaid only on commit, before the cancel dialog', async () => {
  const source = await readFile(new URL('./cancel-stay.mjs', import.meta.url), 'utf8');
  assert.match(source, /unpaidCommitRefusal/);
  const unpaidAt = source.indexOf('unpaidCommitRefusal');
  const dialogAt = source.indexOf('openCancelDialog');
  assert.ok(unpaidAt > 0 && dialogAt > unpaidAt, 'unpaid check must run before the cancel dialog');
  assert.match(source, /mode === 'commit'[\s\S]{0,400}unpaidCommitRefusal/s);
});

test('cancel-stay.mjs never closes the browser, clicks OK only in the reason window, and guards main()', async () => {
  const source = await readFile(new URL('./cancel-stay.mjs', import.meta.url), 'utf8');
  // The dialog decisions and their screenshots moved to cancel-stay-rules.mjs (runCancelDialog).
  const flow = `${source}\n${await readFile(new URL('./cancel-stay-rules.mjs', import.meta.url), 'utf8')}`;
  assert.equal(/browser\.close\s*\(/.test(source), false);
  assert.match(source, /typeof browser\.disconnect === 'function'/);
  assert.match(source, /import \{[^}]*identityCheck[^}]*\} from '\.\/cancel-stay-rules\.mjs'/s);
  assert.match(source, /process\.argv\[1\] && resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)/);
  for (const name of ['window.png', 'found.png', 'opened.png', 'cancel-dialog.png', 'penalty.png', 'readback.png', 'failure.png']) {
    assert.ok(flow.includes(name), name);
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
  assert.equal(formLabelKey('Reservation Note / Billing Instructions:'), 'reservationNote');
  assert.equal(formLabelKey('Cancellation Note:'), null);
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
    reservationNote: null,
  });
});

test('stayFromFormPairs reads the reservation note textarea as text, and null when it is empty', () => {
  const filled = stayFromFormPairs([{ label: 'Reservation Note / Billing Instructions:', value: 'Quiet room requested' }]);
  assert.equal(filled.stay.reservationNote, 'Quiet room requested');
  const empty = stayFromFormPairs([{ label: 'Reservation Note / Billing Instructions:', value: '   ' }]);
  assert.equal(empty.stay.reservationNote, null);
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

test('stayIdentityVerdict matches the confirmation only: a different arrival is a hint, never a rejection', () => {
  const stay = { confirmation: '57291630-1', arrival: '2027-09-14' };
  assert.deepEqual(stayIdentityVerdict({ confirmation: '57291630-1', arrival: null }, stay), { outcome: 'found', reason: null });
  assert.deepEqual(stayIdentityVerdict({ confirmation: '57291630-1', arrival: '2027-09-14' }, stay), { outcome: 'found', reason: null });
  assert.deepEqual(stayIdentityVerdict({ confirmation: '57291630-1', arrival: '2027-09-15' }, stay), { outcome: 'found', reason: null });
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
  assert.match(source, /moveWindow: \(startIso\) => setQuickWindow\(page, startIso\)/);
  assert.match(source, /if \(!args\.arrival\) return null;/);
});

test('openRecord opens the ExtJS grid row with dblclick, matching stay-lookup/read-reservation-codes', async () => {
  const source = await readFile(new URL('./cancel-stay.mjs', import.meta.url), 'utf8');
  const fn = source.match(/export async function openRecord[\s\S]*?(?=\n(?:export |async function |function ))/);
  assert.ok(fn, 'openRecord function');
  const body = fn[0];
  assert.match(body, /x-grid-row/);
  assert.match(body, /gridRow\.first\(\)\.dblclick\(/);
  assert.match(body, /else await row\.dblclick\(/);
  assert.equal(/click\(\s*\{\s*force:\s*true/.test(body), false);
  assert.match(body, /a\.app-menu-trigger:visible/);
  assert.match(body, /lastname/);
  assert.match(body, /undefined,\s*\{\s*timeout:\s*20000\s*\}/);
  assert.equal(/timeout:\s*8000/.test(body), false);
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

// ---- Post-commit settle: pollUntil and settleCancel on a fake clock (no real sleeping) ----

function fakeClock() {
  const clock = { t: 0 };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => {
    clock.t += ms;
  };
  return clock;
}

test('pollUntil reads at once, then every interval, and returns the first read that satisfies until', async () => {
  const clock = fakeClock();
  const answers = [false, false, false, true];
  let reads = 0;
  const result = await pollUntil({
    read: async () => answers[reads++],
    until: (value) => value === true,
    budgetMs: 60000,
    intervalMs: 3000,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.deepEqual(result, { value: true, timedOut: false, polls: 4, elapsedMs: 9000 });
  assert.equal(clock.t, 9000);
});

test('pollUntil with a satisfied first read never sleeps', async () => {
  const clock = fakeClock();
  const result = await pollUntil({ read: async () => 'Cancelled', until: (v) => v === 'Cancelled', budgetMs: 60000, intervalMs: 3000, now: clock.now, sleep: clock.sleep });
  assert.deepEqual(result, { value: 'Cancelled', timedOut: false, polls: 1, elapsedMs: 0 });
  assert.equal(clock.t, 0);
});

test('pollUntil gives up at the budget: reads at 0, 3, ... 60 s, the last one at 60 s, then timedOut', async () => {
  const clock = fakeClock();
  let reads = 0;
  const result = await pollUntil({
    read: async () => {
      reads += 1;
      return 'Reserved';
    },
    until: (value) => value === 'Cancelled',
    budgetMs: 60000,
    intervalMs: 3000,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.deepEqual(result, { value: 'Reserved', timedOut: true, polls: 21, elapsedMs: 60000 });
  assert.equal(reads, 21);
  assert.equal(clock.t, 60000);
});

test('pollUntil counts a slow read against the budget: the last read starts before 60 s and ends after it', async () => {
  const clock = fakeClock();
  const result = await pollUntil({
    read: async () => {
      clock.t += 2000;
      return 'Reserved';
    },
    until: (value) => value === 'Cancelled',
    budgetMs: 60000,
    intervalMs: 3000,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.polls, 13, 'reads start at 0, 5, ..., 60 s');
  assert.equal(result.elapsedMs, 62000);
});

test('settleCancel waits for the processing mask to clear, then polls the status until it reads Cancelled', async () => {
  const clock = fakeClock();
  const masks = [true, true, false];
  const statuses = ['Reserved', 'Cancelled'];
  const settled = await settleCancel(
    { maskVisible: async () => masks.shift(), readStatus: async () => statuses.shift() },
    { now: clock.now, sleep: clock.sleep },
  );
  assert.deepEqual(settled, {
    statusAfter: 'Cancelled',
    cancelled: true,
    maskCleared: true,
    maskMs: 6000,
    statusPolls: 2,
    statusMs: 3000,
  });
  assert.equal(clock.t, 9000);
});

test('settleCancel reports unconfirmed after 60 s of an unchanged status', async () => {
  const clock = fakeClock();
  const settled = await settleCancel(
    { maskVisible: async () => false, readStatus: async () => 'Reserved' },
    { now: clock.now, sleep: clock.sleep },
  );
  assert.equal(settled.cancelled, false);
  assert.equal(settled.statusAfter, 'Reserved');
  assert.equal(settled.statusPolls, 21);
  assert.equal(settled.statusMs, 60000);
  assert.equal(clock.t, 60000);
});

test('settleCancel keeps polling the status when the mask never clears, so a cancel HMS applied is still seen', async () => {
  const clock = fakeClock();
  const settled = await settleCancel(
    { maskVisible: async () => true, readStatus: async () => 'Cancelled' },
    { now: clock.now, sleep: clock.sleep },
  );
  assert.equal(settled.maskCleared, false);
  assert.equal(settled.maskMs, 60000);
  assert.equal(settled.cancelled, true);
  assert.equal(settled.statusAfter, 'Cancelled');
});

test('the settle budget is 60 s and the interval 3 s', () => {
  assert.equal(SETTLE_BUDGET_MS, 60000);
  assert.equal(SETTLE_INTERVAL_MS, 3000);
});

test('cancel-stay.mjs settles a commit through settleCancel, waits for the processing mask, and has no one-shot readback', async () => {
  const source = await readFile(new URL('./cancel-stay.mjs', import.meta.url), 'utf8');
  assert.match(source, /settleCancel\(settleIo\(ctx\)/);
  assert.match(source, /Processing request/);
  assert.equal(/readBack\(/.test(source), false);
});

// ---- Arrival is a hint: identityCheck (write guard) and arrivalReport ----

test('identityCheck keeps the arrival match for a write, and takes it as a hint when arrivalHint is set', () => {
  const args = { confirmation: '61143613-1', arrival: '2027-10-12' };
  const record = { confirmation: '61143613-1', lastName: 'Labtest', arrival: '13-OCT-2027' };
  assert.deepEqual(identityCheck(args, record), { ok: false, outcome: 'refused_identity_mismatch', reason: 'arrival' });
  assert.deepEqual(identityCheck(args, record, { arrivalHint: true }), { ok: true, outcome: null, reason: null });
  const wrongConf = { ...record, confirmation: '57291630-1' };
  assert.equal(identityCheck(args, wrongConf, { arrivalHint: true }).outcome, 'refused_identity_mismatch', 'the confirmation always matches');
  const realGuest = { ...record, lastName: 'Smith' };
  assert.equal(identityCheck(args, realGuest, { arrivalHint: true }).outcome, 'refused_not_lab', 'the lab rules always apply');
});

test('arrivalReport says when the booking arrives on another day than the one asked about, with both dates', () => {
  assert.deepEqual(arrivalReport({ arrival: '2027-10-12' }, '2027-10-13'), {
    arrivalMismatch: true,
    requestedArrival: '2027-10-12',
    hmsArrival: '2027-10-13',
  });
  assert.deepEqual(arrivalReport({ arrival: '2027-10-12' }, '2027-10-12'), {
    arrivalMismatch: false,
    requestedArrival: '2027-10-12',
    hmsArrival: '2027-10-12',
  });
  assert.equal(arrivalReport({ arrival: '2027-10-12' }, null).arrivalMismatch, false, 'an unreadable HMS arrival is not a mismatch');
  assert.equal(arrivalReport({ arrival: null }, '2027-10-13').arrivalMismatch, false, 'no requested arrival, no mismatch');
});

test('an error after the OK click stays uncertain unless a read confirmed the cancel', () => {
  assert.equal(outcomeAfterFailure({ clickedOk: true, statusAfter: null }), 'cancel_unconfirmed');
  assert.equal(outcomeAfterFailure({ clickedOk: true, statusAfter: 'Reserved' }), 'cancel_unconfirmed');
  assert.equal(outcomeAfterFailure({ clickedOk: true, statusAfter: 'Cancelled' }), 'cancelled');
  assert.equal(outcomeAfterFailure({ clickedOk: false, statusAfter: 'Cancelled' }), 'execution_failure');
  assert.equal(outcomeAfterFailure({ clickedOk: false, statusAfter: null }), 'execution_failure');
});

// ---- Modes: --allow-real-guest, the lab guard, the cancel note and the penalty refusal ----

test('--allow-real-guest is a switch: off by default, given once, and never taken as a value', () => {
  assert.equal(parseCancelArgs(argv()).args.allowRealGuest, false);
  const on = parseCancelArgs([...argv(), '--allow-real-guest']);
  assert.equal(on.ok, true, on.error);
  assert.equal(on.args.allowRealGuest, true);
  assert.equal(parseCancelArgs([...argv(), '--allow-real-guest', '--allow-real-guest']).ok, false);
  assert.equal(parseCancelArgs(['--reason', '--allow-real-guest', ...argv()]).ok, false);
});

test('without --allow-real-guest the CLI keeps the Labtest guard before any browser work', () => {
  const before2027 = parseCancelArgs(argv({ '--arrival': '2026-11-12' })).args;
  assert.equal(preflight(before2027).outcome, 'refused_not_lab');
  const guest = { confirmation: '57291630-1', lastName: 'Smith', arrival: '12-NOV-2026', status: 'Reserved' };
  assert.equal(identityCheck(before2027, guest).outcome, 'refused_not_lab');
});

test('--allow-real-guest lifts the lab guard for that run only, and the confirmation and arrival still match', () => {
  const on = parseCancelArgs([
    ...argv({ '--arrival': '2026-11-12', '--mode': 'commit', '--reason': 'Guest request' }),
    '--allow-real-guest',
  ]).args;
  assert.equal(preflight(on).ok, true);
  const guest = { confirmation: '57291630-1', lastName: 'Smith', arrival: '12-NOV-2026', status: 'Reserved' };
  assert.deepEqual(identityCheck(on, guest), { ok: true, outcome: null, reason: null });
  assert.equal(identityCheck(on, { ...guest, confirmation: '11110906-1' }).outcome, 'refused_identity_mismatch');
  assert.equal(identityCheck(on, { ...guest, arrival: '13-NOV-2026' }).outcome, 'refused_identity_mismatch');
  assert.equal(identityCheck(on, { ...guest, arrival: '13-NOV-2026' }, { arrivalHint: true }).ok, true);
  assert.equal(identityCheck(on, { ...guest, arrival: 'garbage' }).reason, 'arrival_unparsed');
});

test('the cancel note is the lab text for lab runs and the staff reason for on-mode runs', () => {
  assert.equal(cancelNoteFor(parseCancelArgs(argv({ '--mode': 'commit' })).args), 'Lab proof cancel');
  const on = parseCancelArgs([
    ...argv({ '--arrival': '2026-11-12', '--mode': 'commit', '--reason': 'Guest request' }),
    '--allow-real-guest',
  ]).args;
  assert.equal(cancelNoteFor(on), 'Guest request');
});

test('a penalty dialog refuses the run as refused_penalty, exit 2, and nothing else does', () => {
  const penalty = parsePenalty(['Cancellation Penalty of 2060.00 may be added to account.']);
  assert.equal(penaltyRefusal(penalty), 'refused_penalty');
  assert.equal(penaltyRefusal(parsePenalty(['Cancel Reservation', 'Test Reservations'])), null);
  assert.equal(exitCodeFor('refused_penalty'), 2);
});

// ---- The cancel dialog run through a scripted dialog: the charge refusal, the single OK and the done line ----
// Each test runs the real runCancelDialog. The scripted dialog answers the windows read and records every action, so a
// test can prove what was and was not clicked. Nothing here touches a browser or HMS.
const CHARGE = 'Cancellation Penalty of 2060.00 may be added to account.';
const WAIVE_CHARGE = `${CHARGE} Waive OK Cancel`;
const REASON_WINDOW = 'Cancellation Reason Test Reservations Duplicate Booking OK Cancel';
const PREVIEW_ARGS = { confirmation: '57291630-1', arrival: '2027-09-14', mode: 'preview', reason: 'Test Reservations', allowRealGuest: false };
const COMMIT_ARGS = { ...PREVIEW_ARGS, mode: 'commit', reason: 'Duplicate Booking' };
const ON_COMMIT_ARGS = { ...COMMIT_ARGS, allowRealGuest: true };
const RECORD = { confirmation: '57291630-1', lastName: 'Labtest', arrival: '14-SEP-2027', status: 'Reserved' };
const REAL_GUEST = { confirmation: '57291630-1', lastName: 'Smith', arrival: '14-SEP-2027', status: 'Reserved' };
const SETTLED = { statusAfter: 'Cancelled', cancelled: true, maskCleared: true, maskMs: 0, statusPolls: 1, statusMs: 0 };

// windows[n] is what the n-th read of the open windows sees; the last snapshot repeats.
function scriptedDialog({
  windows,
  reasons = ['Test Reservations', 'Duplicate Booking'],
  record = RECORD,
  clickPenalty = true,
  balance = '0.00',
}) {
  const calls = [];
  let reads = 0;
  const io = {
    mark: (name) => calls.push(`mark:${name}`),
    shot: async (name) => {
      calls.push(`shot:${name}`);
    },
    windowTexts: async () => {
      calls.push('windows');
      const snapshot = windows[Math.min(reads, windows.length - 1)];
      reads += 1;
      return snapshot;
    },
    fillNote: async (text) => {
      calls.push(`fillNote:${text}`);
    },
    readReasons: async () => {
      calls.push('readReasons');
      return { items: null, texts: reasons, reasons: normalizeReasons(reasons) };
    },
    pickReason: async (_list, index) => {
      calls.push(`pick:${index}`);
    },
    readRecord: async () => {
      calls.push('readRecord');
      return record;
    },
    close: async () => {
      calls.push('close');
    },
    clickOk: async () => {
      calls.push('clickOk');
      return true;
    },
    clickPenalty: async (label) => {
      calls.push(`clickPenalty:${label}`);
      return clickPenalty;
    },
    waitAfterOk: async () => {
      calls.push('waitAfterOk');
    },
    settle: async () => {
      calls.push('settle');
      return SETTLED;
    },
    readBalance: async () => {
      calls.push('readBalance');
      return balance;
    },
  };
  return { io, calls };
}

async function runDialog(args, windows, options = {}) {
  const dialog = scriptedDialog({ windows, ...options });
  const result = { outcome: null, reasons: [], clickedOk: false, penaltyText: null, penaltyAmount: null, penaltyPending: false, refusal: null };
  await runCancelDialog({ args, record: RECORD, result, io: dialog.io });
  return { result, calls: dialog.calls };
}

test('penaltyHasWaive is the Waive button, not the word penalty', () => {
  assert.equal(penaltyHasWaive([WAIVE_CHARGE]), true);
  assert.equal(penaltyHasWaive([CHARGE, 'OK Cancel']), false);
  assert.equal(penaltyHasWaive(['Cancellation Penalty of 2060.00 may be added to account.']), false);
});

test('a charge on the dialog at preview refuses the run: nothing is read, picked, closed or clicked', async () => {
  const { result, calls } = await runDialog(PREVIEW_ARGS, [[REASON_WINDOW, CHARGE]]);
  assert.equal(result.outcome, 'refused_penalty');
  assert.equal(result.refusal, 'penalty_dialog_open');
  assert.equal(result.penaltyText, CHARGE);
  assert.equal(result.penaltyAmount, '2060.00');
  assert.deepEqual(calls, ['windows', 'shot:penalty.png']);
});

test('a real guest with a charge already open refuses the commit: dialog left, nothing clicked', async () => {
  const { result, calls } = await runDialog(COMMIT_ARGS, [[REASON_WINDOW, CHARGE]], { record: REAL_GUEST });
  assert.equal(result.outcome, 'refused_penalty');
  assert.equal(result.penaltyText, CHARGE);
  assert.deepEqual(calls, ['windows', 'shot:penalty.png', 'readRecord']);
  assert.equal(calls.some((call) => call.startsWith('clickPenalty')), false);
  assert.equal(calls.includes('clickOk'), false);
});

test('a real guest charge between the reason pick and the OK refuses it, and no OK is clicked', async () => {
  const { result, calls } = await runDialog(ON_COMMIT_ARGS, [[REASON_WINDOW], [REASON_WINDOW, CHARGE]], { record: REAL_GUEST });
  assert.equal(result.outcome, 'refused_penalty');
  assert.equal(result.penaltyText, CHARGE);
  assert.ok(calls.includes('pick:1'));
  assert.equal(calls.includes('clickOk'), false);
  assert.equal(calls.includes('settle'), false);
  assert.equal(calls.some((call) => call.startsWith('clickPenalty')), false);
  assert.deepEqual(calls.filter((call) => call.startsWith('fillNote')), ['fillNote:Duplicate Booking']);
});

test('a real guest charge after the OK is pending: dialog left, nothing clicked after the OK', async () => {
  const { result, calls } = await runDialog(ON_COMMIT_ARGS, [[REASON_WINDOW], [REASON_WINDOW], [CHARGE]], { record: REAL_GUEST });
  assert.equal(result.outcome, 'cancel_penalty_pending');
  assert.equal(exitCodeFor(result.outcome), 1);
  assert.equal(result.clickedOk, true);
  assert.equal(result.penaltyPending, true);
  assert.equal(result.penaltyText, CHARGE);
  const afterOk = calls.slice(calls.indexOf('clickOk') + 1);
  assert.equal(afterOk.some((call) => call.startsWith('clickPenalty')), false);
  assert.deepEqual(afterOk.filter((call) => /^(pick|clickOk|fillNote|close)/.test(call)), []);
});

test('Labtest + penalty with Waive clicks Waive, status Cancelled, balance 0', async () => {
  const { result, calls } = await runDialog(COMMIT_ARGS, [[REASON_WINDOW, WAIVE_CHARGE], [REASON_WINDOW]]);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.statusAfter, 'Cancelled');
  assert.equal(result.balance, '0.00');
  assert.equal(result.penaltyPending, false);
  assert.ok(calls.includes('clickPenalty:waive'));
  assert.equal(calls.includes('clickPenalty:ok'), false);
  assert.equal(calls.filter((call) => call === 'clickOk').length, 1);
  assert.ok(calls.includes('readBalance'));
});

test('Labtest + penalty with no Waive clicks OK on the charge', async () => {
  const { result, calls } = await runDialog(COMMIT_ARGS, [[REASON_WINDOW, `${CHARGE} OK Cancel`], [REASON_WINDOW]]);
  assert.equal(result.outcome, 'cancelled');
  assert.ok(calls.includes('clickPenalty:ok'));
  assert.equal(calls.includes('clickPenalty:waive'), false);
  assert.equal(calls.filter((call) => call === 'clickOk').length, 1);
});

test('penalty Labtest identity is the open HMS record, not the args record', async () => {
  const liveGuest = await runDialog(COMMIT_ARGS, [[REASON_WINDOW, WAIVE_CHARGE]], { record: REAL_GUEST });
  assert.equal(liveGuest.result.outcome, 'refused_penalty');
  assert.equal(liveGuest.calls.some((call) => call.startsWith('clickPenalty')), false);
  const liveLab = await runDialog(COMMIT_ARGS, [[REASON_WINDOW, WAIVE_CHARGE], [REASON_WINDOW]], { record: RECORD });
  assert.equal(liveLab.result.outcome, 'cancelled');
  assert.ok(liveLab.calls.includes('clickPenalty:waive'));
});

test('an unpaid Labtest with no penalty dialog never invents a Waive click', async () => {
  const { result, calls } = await runDialog(COMMIT_ARGS, [[REASON_WINDOW]]);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.penaltyText, null);
  assert.equal(calls.some((call) => call.startsWith('clickPenalty')), false);
});

test('a commit with no charge types the lab note, picks the reason, clicks one OK and settles to cancelled', async () => {
  const { result, calls } = await runDialog(COMMIT_ARGS, [[REASON_WINDOW]]);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.penaltyText, null);
  assert.equal(calls.filter((call) => call === 'clickOk').length, 1);
  assert.deepEqual(calls.filter((call) => call.startsWith('fillNote')), ['fillNote:Lab proof cancel']);
});

test('isStaleScreenError is a Playwright timeout, not an identity miss', () => {
  assert.equal(isStaleScreenError(new Error('locator.waitFor: Timeout 20000ms exceeded.')), true);
  assert.equal(isStaleScreenError({ name: 'TimeoutError', message: 'Timeout' }), true);
  assert.equal(isStaleScreenError(new Error('IDENTITY_CHANGED_BEFORE_OK')), false);
  assert.equal(isStaleScreenError(new Error('AMBIGUOUS_CONFIRMATION_ROW')), false);
});

test('stale screen recovers once then fails with STALE_SCREEN, not a timeout', async () => {
  const calls = [];
  let attempts = 0;
  const result = { outcome: null, error: null, recovered: false, refusal: null };
  const found = await withStaleRecovery({
    attempt: async () => {
      attempts += 1;
      calls.push(`attempt:${attempts}`);
      throw new Error('locator.waitFor: Timeout 20000ms exceeded.');
    },
    recover: async () => {
      calls.push('recover');
    },
  }, result);
  assert.equal(found, null);
  assert.equal(attempts, 2);
  assert.deepEqual(calls, ['attempt:1', 'recover', 'attempt:2']);
  assert.equal(result.outcome, 'execution_failure');
  assert.equal(result.error, 'STALE_SCREEN');
  assert.equal(result.refusal, 'stale_screen');
  assert.equal(result.recovered, true);
});

test('stale recovery rethrows a non-timeout on the second attempt', async () => {
  const result = { outcome: null, error: null, recovered: false };
  await assert.rejects(
    () => withStaleRecovery({
      attempt: async () => {
        if (!result.recovered) throw new Error('locator.waitFor: Timeout 20000ms exceeded.');
        throw new Error('AMBIGUOUS_CONFIRMATION_ROW');
      },
      recover: async () => {},
    }, result),
    /AMBIGUOUS_CONFIRMATION_ROW/,
  );
  assert.equal(result.recovered, true);
  assert.equal(result.error, null);
});

test('stale screen that recovers then finds does not fail', async () => {
  let attempts = 0;
  const result = { outcome: null, error: null, recovered: false };
  const found = await withStaleRecovery({
    attempt: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('page.waitForSelector: Timeout 20000ms exceeded.');
      return { method: 'row' };
    },
    recover: async () => {},
  }, result);
  assert.deepEqual(found, { method: 'row' });
  assert.equal(result.outcome, null);
  assert.equal(result.error, null);
  assert.equal(result.recovered, true);
});

test('stayChanges names each approved field the reopened record shows differently, and nothing else', () => {
  const approved = { confirmation: '57291630-1', departure: '2027-09-16', adults: 1, balance: '0.00', bookingAgency: null };
  assert.deepEqual(stayChanges(approved, { ...approved, reservationNote: 'not in the approval' }), []);
  assert.deepEqual(stayChanges(approved, { ...approved, bookingAgency: '  ' }), []);
  assert.deepEqual(
    stayChanges(approved, { ...approved, departure: '2027-09-17', balance: '150.00', adults: 2 }),
    ['departure', 'adults', 'balance'],
  );
  assert.deepEqual(stayChanges(approved, { confirmation: '57291630-1' }), ['departure', 'adults', 'balance']);
});

test('parseCancelArgs takes --expect-stay on a commit only', () => {
  const commit = parseCancelArgs(argv({ '--mode': 'commit', '--expect-stay': '/tmp/run/expect-stay.json' }));
  assert.equal(commit.ok, true, commit.error);
  assert.equal(commit.args.expectStay, '/tmp/run/expect-stay.json');
  assert.equal(parseCancelArgs(argv({ '--expect-stay': '/tmp/run/expect-stay.json' })).ok, false);
  assert.equal(exitCodeFor('refused_stay_changed'), 2);
});

test('an OK click whose reply is lost counts as clicked, so the run ends unconfirmed, never as a clean failure', async () => {
  const dialog = scriptedDialog({ windows: [[REASON_WINDOW]] });
  dialog.io.clickOk = async () => {
    dialog.calls.push('clickOk');
    throw new Error('Target page, context or browser has been closed');
  };
  const result = { outcome: null, reasons: [], clickedOk: false, penaltyText: null, penaltyAmount: null, penaltyPending: false, refusal: null };
  await assert.rejects(runCancelDialog({ args: COMMIT_ARGS, record: RECORD, result, io: dialog.io }), /browser has been closed/);
  assert.equal(result.clickedOk, true);
  assert.equal(outcomeAfterFailure(result), 'cancel_unconfirmed');
});

test('an on-mode commit types the staff reason as the note', async () => {
  const onArgs = { ...COMMIT_ARGS, reason: 'Guest request', allowRealGuest: true };
  const { result, calls } = await runDialog(onArgs, [[REASON_WINDOW]], { reasons: ['Guest request'] });
  assert.equal(result.outcome, 'cancelled');
  assert.deepEqual(calls.filter((call) => call.startsWith('fillNote')), ['fillNote:Guest request']);
});

test('a preview with no charge reads the reasons, closes the dialog and clicks nothing', async () => {
  const { result, calls } = await runDialog(PREVIEW_ARGS, [[REASON_WINDOW]]);
  assert.equal(result.outcome, 'preview_ok');
  assert.deepEqual(result.reasons, ['Test Reservations', 'Duplicate Booking']);
  assert.ok(calls.includes('close'));
  assert.equal(calls.some((call) => call === 'clickOk' || call.startsWith('pick') || call.startsWith('fillNote')), false);
});

test('a reason HMS does not list closes the dialog and clicks no OK', async () => {
  const { result, calls } = await runDialog({ ...COMMIT_ARGS, reason: 'Not on the list' }, [[REASON_WINDOW]]);
  assert.equal(result.outcome, 'refused_reason_missing');
  assert.equal(result.refusal, 'reason_not_in_list');
  assert.ok(calls.includes('close'));
  assert.equal(calls.includes('clickOk'), false);
});
