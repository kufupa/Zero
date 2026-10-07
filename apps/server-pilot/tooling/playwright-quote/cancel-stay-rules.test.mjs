import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  checkCdpEnv, exitCodeFor, findReasonIndex, hmsDateToIso, identityCheck, isCancelledStatus, labGuard,
  normalizeReasons, parseCancelArgs, parseIsoDate, parsePenalty, pickerMonthSteps, preflight, resolveOutcome,
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
  });
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
