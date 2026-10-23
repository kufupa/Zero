import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  amendCommitAllowed,
  amendPreviewDigest,
  classifyAmendPayment,
  compareChangedFields,
  dangerousDialogKind,
  parseAmendArgs,
  unsupportedFieldReason,
  validateAmendCurrent,
  validateAmendRequest,
} from './amend-stay-rules.mjs';

const REQUEST = {
  confirmation: '57291630-1',
  expectedLastName: 'Labtest',
  fields: { arrival: '2027-09-15', adults: 2, roomType: 'SUITE' },
};

const CURRENT = {
  confirmation: '57291630-1',
  lastName: 'Labtest',
  status: 'Reserved',
  arrival: '2027-09-14',
  departure: '2027-09-16',
  adults: 1,
  children: 0,
  roomType: 'DBL',
  guaranteeType: 'Non-Guaranteed Individual',
  depositReceived: '0',
};

function args(mode = 'preview', digest) {
  return [
    '--request', '/tmp/amend-request.json',
    '--mode', mode,
    '--out', '/tmp/amend-proof',
    ...(digest === undefined ? [] : ['--digest', digest]),
  ];
}

test('parseAmendArgs accepts preview and digest-bound commit', () => {
  assert.deepEqual(parseAmendArgs(args()), {
    ok: true,
    exitCode: 0,
    args: { request: '/tmp/amend-request.json', mode: 'preview', out: '/tmp/amend-proof', digest: null, property: 'HRCEN' },
  });
  const digest = 'a'.repeat(64);
  assert.deepEqual(parseAmendArgs(args('commit', digest)), {
    ok: true,
    exitCode: 0,
    args: { request: '/tmp/amend-request.json', mode: 'commit', out: '/tmp/amend-proof', digest, property: 'HRCEN' },
  });
});

test('parseAmendArgs accepts --property HRDAV and refuses an unknown code', () => {
  assert.equal(parseAmendArgs([...args(), '--property', 'HRDAV']).args.property, 'HRDAV');
  assert.match(parseAmendArgs([...args(), '--property', 'OTHER']).error, /PROPERTY_UNKNOWN/);
});

test('parseAmendArgs requires a valid digest only for commit', () => {
  assert.match(parseAmendArgs(args('commit')).error, /--digest/);
  assert.match(parseAmendArgs(args('preview', 'a'.repeat(64))).error, /commit mode/);
  assert.match(parseAmendArgs(args('commit', 'short')).error, /--digest/);
});

test('parseAmendArgs refuses unknown, repeated, missing and invalid mode arguments', () => {
  assert.match(parseAmendArgs([...args(), '--force', 'yes']).error, /Unknown argument/);
  assert.match(parseAmendArgs([...args(), '--mode', 'preview']).error, /Repeated argument/);
  assert.match(parseAmendArgs(['--request', '--mode']).error, /Missing value/);
  assert.match(parseAmendArgs(args('save')).error, /preview or commit/);
});

test('validateAmendRequest accepts a real currentArrival hint and refuses a bad one', () => {
  const hinted = { ...REQUEST, currentArrival: '2027-11-23' };
  assert.deepEqual(validateAmendRequest(hinted), { ok: true, request: hinted });
  assert.deepEqual(validateAmendRequest({ ...REQUEST, currentArrival: '2027-02-30' }), { ok: false, reason: 'current_arrival_invalid' });
});

test('validateAmendRequest accepts only the exact lab identity and allowlisted fields', () => {
  assert.deepEqual(validateAmendRequest(REQUEST), { ok: true, request: REQUEST });
  assert.equal(validateAmendRequest({ ...REQUEST, expectedLastName: 'smith' }).reason, 'expected_last_name_not_labtest');
  assert.equal(validateAmendRequest({ ...REQUEST, confirmation: ' 57291630-1' }).reason, 'confirmation_invalid');
  assert.equal(validateAmendRequest({ ...REQUEST, unexpected: true }).reason, 'request_fields_invalid');
});

test('validateAmendRequest strictly validates field names, values, and date order', () => {
  assert.equal(validateAmendRequest({ ...REQUEST, fields: {} }).reason, 'fields_required');
  assert.equal(validateAmendRequest({ ...REQUEST, fields: { ...REQUEST.fields, notes: 'late arrival' } }).reason, 'unsupported_field');
  assert.equal(validateAmendRequest({ ...REQUEST, fields: { arrival: '2027-02-30' } }).reason, 'date_invalid');
  assert.equal(
    validateAmendRequest({ ...REQUEST, fields: { arrival: '2027-09-16', departure: '2027-09-15' } }).reason,
    'departure_not_after_arrival',
  );
  assert.equal(validateAmendRequest({ ...REQUEST, fields: { adults: '2' } }).reason, 'count_invalid');
  assert.equal(validateAmendRequest({ ...REQUEST, fields: { adults: 0 } }).reason, 'count_invalid');
  assert.equal(validateAmendRequest({ ...REQUEST, fields: { children: 17 } }).reason, 'count_invalid');
  assert.equal(validateAmendRequest({ ...REQUEST, fields: { roomType: 'NOT-A-ROOM' } }).reason, 'room_type_invalid');
});

test('amend room types follow the property profile: HRDAV EXKNGB, HRCEN STQN, not the other hotel', () => {
  assert.equal(validateAmendRequest({ ...REQUEST, fields: { roomType: 'EXKNGB' } }, 'HRDAV').ok, true);
  assert.equal(validateAmendRequest({ ...REQUEST, fields: { roomType: 'EXKNGB' } }, 'HRCEN').reason, 'room_type_invalid');
  assert.equal(validateAmendRequest({ ...REQUEST, fields: { roomType: 'STQN' } }, 'HRCEN').ok, true);
  assert.equal(validateAmendRequest({ ...REQUEST, fields: { roomType: 'STQN' } }, 'HRDAV').reason, 'room_type_invalid');
});

test('validateAmendCurrent guards exact confirmation, lab surname, status, and current and target dates', () => {
  assert.equal(validateAmendCurrent(REQUEST, CURRENT), null);
  assert.equal(validateAmendCurrent(REQUEST, { ...CURRENT, confirmation: '46184891-1' }), 'confirmation_mismatch');
  assert.equal(validateAmendCurrent(REQUEST, { ...CURRENT, lastName: 'Smith' }), 'current_last_name_not_labtest');
  assert.equal(validateAmendCurrent(REQUEST, { ...CURRENT, status: 'Cancelled' }), 'status_unsupported');
  assert.equal(validateAmendCurrent(REQUEST, { ...CURRENT, arrival: '2026-12-31' }), 'current_arrival_before_2027');
  assert.equal(
    validateAmendCurrent({ ...REQUEST, fields: { arrival: '2026-12-31' } }, CURRENT),
    'target_arrival_before_2027',
  );
  assert.equal(
    validateAmendCurrent({ ...REQUEST, fields: { arrival: '2027-09-17' } }, CURRENT),
    'departure_not_after_arrival',
  );
  assert.equal(
    validateAmendCurrent({ ...REQUEST, fields: { adults: 1 } }, CURRENT),
    'no_changes',
  );
});

test('amendPreviewDigest is key-order stable and binds current state and changed targets', () => {
  const fields = { adults: 2, arrival: '2027-09-15' };
  const digest = amendPreviewDigest({ confirmation: REQUEST.confirmation, expectedLastName: 'Labtest', current: CURRENT, fields });
  assert.equal(
    amendPreviewDigest({
      fields: { arrival: '2027-09-15', adults: 2 },
      current: { ...CURRENT },
      expectedLastName: 'Labtest',
      confirmation: REQUEST.confirmation,
    }),
    digest,
  );
  assert.notEqual(
    amendPreviewDigest({ confirmation: REQUEST.confirmation, expectedLastName: 'Labtest', current: { ...CURRENT, adults: 2 }, fields }),
    digest,
  );
  assert.notEqual(
    amendPreviewDigest({ confirmation: REQUEST.confirmation, expectedLastName: 'Labtest', current: CURRENT, fields: { ...fields, adults: 3 } }),
    digest,
  );
});

test('unsupported named controls return the explicit live-probe refusal', () => {
  for (const state of [
    { count: 0, disabled: false, readOnly: false },
    { count: 1, disabled: true, readOnly: false },
    { count: 1, disabled: false, readOnly: true },
    { count: 2, disabled: false, readOnly: false },
  ]) {
    assert.equal(unsupportedFieldReason(state), 'unsupported_field');
  }
  assert.equal(unsupportedFieldReason({ count: 1, disabled: false, readOnly: false }), null);
});

test('rate, penalty, or charge dialog text is a refusal signal', () => {
  assert.equal(dangerousDialogKind('Rate Shop'), 'rate');
  assert.equal(dangerousDialogKind('Cancellation Penalty of 500 may be added'), 'penalty');
  assert.equal(dangerousDialogKind('Additional Charge Confirmation'), 'charge');
  assert.equal(dangerousDialogKind('Guest Stay'), null);
});

test('compareChangedFields reports exact fresh matches and per-field mismatches', () => {
  const fields = { arrival: '2027-09-15', adults: 2 };
  assert.deepEqual(compareChangedFields(fields, { arrival: '2027-09-15', adults: 2 }), { matches: true, diff: {} });
  assert.deepEqual(compareChangedFields(fields, { arrival: '2027-09-14', adults: 1 }), {
    matches: false,
    diff: { arrival: { expected: '2027-09-15', actual: '2027-09-14' }, adults: { expected: 2, actual: 1 } },
  });
  assert.deepEqual(compareChangedFields(fields, {}), {
    matches: false,
    diff: { arrival: { expected: '2027-09-15', actual: null }, adults: { expected: 2, actual: null } },
  });
});

test('classifyAmendPayment is unpaid only for provisional + deposit 0 + non-paying guarantee', () => {
  assert.equal(classifyAmendPayment(CURRENT), 'unpaid');
  assert.equal(classifyAmendPayment({ ...CURRENT, depositReceived: '0.00' }), 'unpaid');
  assert.equal(classifyAmendPayment({ ...CURRENT, guaranteeType: 'Non-Guaranteed Indi...' }), 'unpaid');
  assert.equal(classifyAmendPayment({ ...CURRENT, depositReceived: '250.00' }), 'paid');
  assert.equal(classifyAmendPayment({ ...CURRENT, guaranteeType: 'Guaranteed By Agent' }), 'guaranteed');
  assert.equal(classifyAmendPayment({ ...CURRENT, depositReceived: '' }), 'unpaid');
  assert.equal(classifyAmendPayment({ ...CURRENT, depositReceived: null }), 'unknown');
  assert.notEqual(
    classifyAmendPayment({ ...CURRENT, depositReceived: null, guaranteeType: 'Guaranteed By Agent' }),
    'unpaid',
  );
  assert.equal(classifyAmendPayment({ ...CURRENT, guaranteeType: null }), 'unknown');
  assert.equal(classifyAmendPayment({ ...CURRENT, status: 'Confirmed' }), 'unknown');
  assert.notEqual(classifyAmendPayment({ ...CURRENT, status: 'Confirmed', depositReceived: '' }), 'unpaid');
});

test('unread null deposit is unknown; confirmed blank is unpaid for provisional non-paying', () => {
  assert.equal(classifyAmendPayment({ ...CURRENT, depositReceived: null }), 'unknown');
  assert.equal(classifyAmendPayment({ ...CURRENT, depositReceived: undefined }), 'unknown');
  assert.equal(classifyAmendPayment({ ...CURRENT, depositReceived: '' }), 'unpaid');
  assert.equal(validateAmendCurrent(REQUEST, { ...CURRENT, depositReceived: null }), 'payment_unknown');
  assert.equal(validateAmendCurrent(REQUEST, { ...CURRENT, depositReceived: '' }), null);
});

test('validateAmendCurrent refuses paid, guaranteed, and missing payment fields', () => {
  assert.equal(validateAmendCurrent(REQUEST, CURRENT), null);
  assert.equal(validateAmendCurrent(REQUEST, { ...CURRENT, depositReceived: '500.00' }), 'payment_unknown');
  assert.equal(
    validateAmendCurrent(REQUEST, { ...CURRENT, guaranteeType: 'Guaranteed By Credit Card' }),
    'payment_unknown',
  );
  assert.equal(validateAmendCurrent(REQUEST, { ...CURRENT, depositReceived: null }), 'payment_unknown');
  assert.equal(validateAmendCurrent(REQUEST, { ...CURRENT, guaranteeType: '' }), 'payment_unknown');
});

test('pane save gate allows preview but permits commit only in lab mode', () => {
  assert.equal(amendCommitAllowed('preview', {}), true);
  assert.equal(amendCommitAllowed('commit', {}), false);
  assert.equal(amendCommitAllowed('commit', { RESERVATIONIST_PANE_SAVE: 'off' }), false);
  assert.equal(amendCommitAllowed('commit', { RESERVATIONIST_PANE_SAVE: 'on' }), false);
  assert.equal(amendCommitAllowed('commit', { RESERVATIONIST_PANE_SAVE: 'lab' }), true);
});

test('checkAvailability clicks the Check Availability control after closing the drawer', async () => {
  const source = await readFile(new URL('./amend-stay.mjs', import.meta.url), 'utf8');
  const at = source.indexOf('async function checkAvailability');
  assert.ok(at > 0);
  const body = source.slice(at, source.indexOf('async function fillChangedFields'));
  assert.match(body, /closeAppDrawer\(page\)/);
  assert.match(body, /x-btn:visible/);
  assert.match(body, /Check Availability/);
  assert.match(body, /\.click\(/);
  assert.ok(body.indexOf('closeAppDrawer(page)') < body.indexOf('.click('));
  assert.equal(/el\.click\(\)/.test(body), false);
  assert.match(body, /return false;/);
});

test('amend-stay closes the app drawer before filling changed fields', async () => {
  const source = await readFile(new URL('./amend-stay.mjs', import.meta.url), 'utf8');
  const fillAt = source.indexOf('async function fillChangedFields');
  assert.ok(fillAt > 0);
  const fill = source.slice(fillAt, source.indexOf('async function waitForSaveToSettle'));
  assert.match(fill, /closeAppDrawer\(page\)/);
  assert.match(fill, /Ext\.getCmp\(id\)/);
  assert.match(fill, /setValue/);
  assert.match(fill, /got instanceof Date/);
  assert.ok(fill.indexOf('closeAppDrawer') < fill.indexOf('setValue'));
  assert.equal(/input\.click\(/.test(fill), false);
});

test('amend CLI refuses commit before HMS access when pane save gate is off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amend-gate-test-'));
  const requestPath = join(dir, 'request.json');
  const outDir = join(dir, 'proof');
  await writeFile(requestPath, JSON.stringify({
    confirmation: '57291630-1',
    expectedLastName: 'Labtest',
    fields: { adults: 2 },
  }));
  try {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./amend-stay.mjs', import.meta.url)),
      '--request', requestPath,
      '--mode', 'commit',
      '--digest', 'a'.repeat(64),
      '--out', outDir,
    ], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: dir, TMPDIR: dir, RESERVATIONIST_PANE_SAVE: 'off' },
    });
    assert.equal(result.status, 2, result.stderr || result.error?.message);
    const report = JSON.parse(await readFile(join(outDir, 'result.json'), 'utf8'));
    assert.equal(report.outcome, 'refused_flag_off');
    assert.equal(report.reason, 'refused_flag_off');
    assert.equal(report.saveAttempted, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
