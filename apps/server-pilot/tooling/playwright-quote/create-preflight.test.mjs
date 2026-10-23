import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileFor } from './property-profile.mjs';
import {
  buildPreflightResult, collectBlockers, formatBlocker, preflightExitCode, requestedAvailability, runCreatePreflight,
  sanitizeDom, shouldAbortReadOnlyRequest,
} from './create-preflight.mjs';

function clearSnapshot(extra = {}) {
  return {
    propertyCode: 'HRCEN',
    arrival: '2027-10-12',
    departure: '2027-10-13',
    profile: profileFor('HRCEN'),
    fields: [
      { name: 'lastname', value: 'Labtest', required: true, blank: false },
      { name: 'reservationnote', value: '', required: false, blank: true },
    ],
    availability: {
      searched: true, restricted: false, rateAvailable: true, inventory: 4,
      rows: [{ roomType: 'STQN', code: 'BAR', name: 'Best Available' }],
      nights: [{ date: '2027-10-12', restricted: false, rateAvailable: true, restrictions: { combClosed: false } }],
    },
    nav: ['Front Desk', 'Guest Stay', 'Hotel Availability', 'New Record'].map((name) => ({ name, visible: true, inViewport: true })),
    messages: [],
    duplicateSearch: { outcome: 'ok', rows: [] },
    dump: '<form><input name="lastname" value="Labtest"></form>',
    ...extra,
  };
}

test('offline preflight test does not opt into pilot RDS', () => {
  assert.notEqual(process.env.VITEST_ALLOW_PILOT_RDS, '1');
  assert.equal(/nava-zero-mail-pilot/i.test(process.env.DATABASE_URL || ''), false);
});

test('all-clear reports no blockers and exits 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-preflight-'));
  try {
    const result = await runCreatePreflight({
      stay: { arrival: '2027-10-12', departure: '2027-10-13', lastName: 'Labtest' },
      propertyCode: 'HRCEN',
      snapshot: clearSnapshot(),
      outDir: dir,
    });
    assert.deepEqual(result.blockers, []);
    assert.equal(preflightExitCode(result), 0);
    assert.equal(result.clickedSave, false);
    const written = JSON.parse(await readFile(join(dir, 'preflight.json'), 'utf8'));
    assert.equal(written.clickedSave, false);
    assert.match(await readFile(join(dir, 'dump.html'), 'utf8'), /<form>/);
    assert.equal(sanitizeDom('<input value="a@b.co" data-qtip="61143613-1"><script>x</script>').includes('a@b.co'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restricted date is blocker:availability', () => {
  const labels = collectBlockers(clearSnapshot({
    availability: {
      searched: true, restricted: true, rows: [],
      nights: [{ date: '2027-10-12', restricted: true, rateAvailable: false, restrictions: { combClosed: true } }],
    },
  })).map(formatBlocker);
  assert.deepEqual(labels, ['blocker:availability']);
  assert.equal(preflightExitCode({ blockers: collectBlockers(clearSnapshot({ availability: { restricted: true } })) }), 2);
  const shop = requestedAvailability([
    { roomType: 'STWN', code: 'BAR', restricted: true, inventory: 0 },
    { roomType: 'STQN', code: 'BAR', restricted: false, inventory: 4 },
  ], { roomType: 'STQN', ratePlan: 'BAR' });
  assert.equal(shop.restricted, false);
  assert.equal(shop.inventory, 4);
  assert.deepEqual(collectBlockers(clearSnapshot({ availability: { error: 'timeout', searched: false, rows: [] } })).map(formatBlocker), [
    'blocker:availability',
  ]);
  assert.equal(preflightExitCode(buildPreflightResult(clearSnapshot({ captureError: 'fields' }))), 2);
});

test('DV note blank is blocker:required_field reservationnote', () => {
  const labels = collectBlockers(clearSnapshot({
    propertyCode: 'HRDAV',
    profile: profileFor('HRDAV'),
    fields: [{ name: 'reservationnote', value: '', required: false, blank: true }],
  })).map(formatBlocker);
  assert.deepEqual(labels, ['blocker:required_field reservationnote']);
});

test('nav off-screen is blocker:nav', () => {
  const labels = collectBlockers(clearSnapshot({
    nav: [{ name: 'Guest Stay', visible: true, inViewport: false }],
  })).map(formatBlocker);
  assert.deepEqual(labels, ['blocker:nav']);
});

test('guard blocks any write request', async () => {
  assert.equal(shouldAbortReadOnlyRequest({ method: 'POST', url: 'https://hms.example.test/web/base/OSRESV/save' }), true);
  assert.equal(shouldAbortReadOnlyRequest({ method: 'DELETE', url: 'https://hms.example.test/web/base/OSRESV/list' }), true);
  assert.equal(shouldAbortReadOnlyRequest({ method: 'GET', url: 'https://hms.example.test/web/base/OSRESV/save' }), false);
  const aborted = [];
  let handler;
  const result = await runCreatePreflight({
    context: { route: async (_pattern, fn) => { handler = fn; } },
    stay: { arrival: '2027-10-12', lastName: 'Labtest' },
    propertyCode: 'HRCEN',
    snapshot: clearSnapshot(),
  });
  assert.equal(result.clickedSave, false);
  const route = (method, url) => ({
    request: () => ({ method, url }),
    abort: async () => { aborted.push(`${method} abort`); },
    continue: async () => { aborted.push(`${method} continue`); },
  });
  await handler(route('POST', 'https://hms.example.test/web/base/OSRESV/save'));
  await handler(route('PUT', 'https://hms.example.test/web/base/OSRESV/record'));
  await handler(route('POST', 'https://hms.example.test/api/internalBooking/hotelAvail/inquiryForGrid'));
  assert.deepEqual(aborted, ['POST abort', 'PUT abort', 'POST continue']);
});
