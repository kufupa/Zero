import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, parseRequest, validateApplied, inventoryAssessment, classifyResult, renderQuote, fetchQuote,
} from './fetch-quote.mjs';

const base = () => ({
  propertyCode: 'DEMO', arrivalDate: '2026-10-01', departureDate: '2026-10-04',
  rooms: [{ quantity: 2, adults: 1, children: 0, childAges: [] }],
  preferences: { board: 'Breakfast', flexibility: 'Flexible cancellation' },
});
const applied = () => ({
  screen: 'Hotel Availability', propertyCode: 'DEMO', arrivalDate: '2026-10-01',
  departureDate: '2026-10-04', nights: 3, adults: 1, children: 0, childAges: [],
  occupancyBasis: 'per_room', roomQuantity: null, shopByDay: false,
  evidence: ['Guests: 1 adult, 0 children; 3 nights'],
});

test('CLI requires explicit request and output paths and rejects ambiguous flags', () => {
  assert.deepEqual(parseArgs(['--help']), { help: true });
  const args = parseArgs(['--request', 'private-request.json', '--output-dir', 'private-results']);
  assert.equal(args.requestPath, resolve('private-request.json'));
  assert.throws(() => parseArgs(['--request', 'x']), { code: 'ARGUMENTS' });
  assert.throws(() => parseArgs(['--request', 'x', '--request', 'y']), { code: 'ARGUMENTS' });
});

test('adult-only occupancy remains one adult per room, explicitly zero children', () => {
  const raw = base();
  delete raw.rooms[0].childAges;
  const parsed = parseRequest(raw);
  assert.deepEqual(parsed.rooms, [{ quantity: 2, adults: 1, children: 0, childAges: [] }]);
});

test('children and supplied ages remain in their per-room groups', () => {
  const raw = base();
  raw.rooms = [{ quantity: 1, adults: 2, children: 2, childAges: [4, 9] },
    { quantity: 1, adults: 1, children: 0, childAges: [] }];
  assert.deepEqual(parseRequest(raw).rooms, raw.rooms);
});

test('missing, extra or stale ages are precise input gaps; never invented', () => {
  for (const room of [
    { quantity: 1, adults: 2, children: 1 },
    { quantity: 1, adults: 2, children: 2, childAges: [6] },
    { quantity: 1, adults: 2, children: 0, childAges: [6] },
  ]) {
    assert.throws(() => parseRequest({ ...base(), rooms: [room] }), (error) =>
      error.code === 'INPUT_GAP' && error.gaps.some((gap) => gap.startsWith('rooms.0.childAges:')));
  }
});

test('invalid dates and missing room allocation fail without flattening guests', () => {
  assert.throws(() => parseRequest({ ...base(), arrivalDate: '2026-02-30' }), { code: 'INPUT_GAP' });
  assert.throws(() => parseRequest({ ...base(), departureDate: '2026-09-30' }), { code: 'INPUT_GAP' });
  assert.throws(() => parseRequest({ ...base(), rooms: [] }), { code: 'INPUT_GAP' });
});

test('applied readback rejects wrong screen, stale occupancy, ages and restriction bypass', () => {
  const request = parseRequest(base());
  assert.doesNotThrow(() => validateApplied(request, request.rooms[0], applied()));
  for (const change of [{ screen: 'Room Type and Rate Availability' }, { adults: 2 },
    { children: 1 }, { childAges: [7] }, { childAges: null }, { shopByDay: true },
    { roomQuantity: 1 }, { occupancyBasis: 'unknown' }]) {
    assert.throws(() => validateApplied(request, request.rooms[0], { ...applied(), ...change }),
      { code: 'APPLIED_CRITERIA_MISMATCH' });
  }
});

test('inventory checks requested room quantity and never sums repeated search stock', () => {
  const group = { requested: base().rooms[0], options: [
    { roomType: 'Standard', ratePlan: 'Flexible', availability: 'available', availableQuantity: 1 },
  ] };
  assert.equal(inventoryAssessment([group])[0].sufficient, false);
  assert.equal(inventoryAssessment([group, group])[0].sufficient, null);
});

test('failure report never claims a quote was obtained', () => {
  const report = renderQuote({ status: 'failed', phase: 'login', code: 'AUTHENTICATED_SHELL_TIMEOUT' });
  assert.match(report, /Quote not obtained/);
  assert.match(report, /AUTHENTICATED_SHELL_TIMEOUT/);
});

test('unknown or insufficient stock cannot become a successful two-room quote', () => {
  const group = { requested: base().rooms[0], options: [
    { roomType: 'Standard', ratePlan: 'Flexible', availability: 'available', availableQuantity: null },
  ] };
  assert.equal(classifyResult([group]), 'partial');
  group.options[0].availableQuantity = 1;
  assert.equal(classifyResult([group]), 'unavailable');
  group.options[0].availableQuantity = 2;
  assert.equal(classifyResult([group]), 'quoted');
  assert.equal(classifyResult([group, group]), 'partial');
  assert.equal(classifyResult([{ ...group, noAvailability: true, noAvailabilityEvidence: 'No rooms available' }]), 'unavailable');
});

test('missing-age full entrypoint writes private input-gap result before any browser/config access', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.private/stagehand-quote-mvp');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(root, 'local-test-'));
  try {
    const requestPath = join(temporary, 'request.json');
    await writeFile(requestPath, JSON.stringify({ ...base(), rooms: [
      { quantity: 1, adults: 2, children: 1 },
    ] }), { mode: 0o600 });
    const result = await fetchQuote({ requestPath, outputDir: temporary, env: {} });
    assert.equal(result.status, 'input_gap');
    assert.equal(result.phase, 'input');
    assert.match(result.inputGaps[0], /childAges/);
    const stored = JSON.parse(await readFile(join(result.outputDir, 'result.json'), 'utf8'));
    assert.equal(stored.status, 'input_gap');
    assert.equal((await stat(result.outputDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(result.outputDir, 'result.json'))).mode & 0o777, 0o600);
    const events = JSON.parse(await readFile(join(result.outputDir, 'events.json'), 'utf8'));
    assert.equal(events.some((entry) => entry.name === 'connect_native:start'), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
