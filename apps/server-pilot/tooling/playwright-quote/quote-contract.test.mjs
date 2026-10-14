import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  normalizeQuoteRequest,
  assessConstraints,
  sumDisplayedRates,
  evaluateAllocation,
  composeAllocation,
  orderOptions,
  aggregateOutcome,
  profileHolds,
  restrictedNightsOf,
  shortfallsOf,
  availableRoomAlternatives,
} from './quote-contract.mjs';
import { profileFor } from './property-profile.mjs';

const adultFixtureUrl = new URL('./examples/adult.json', import.meta.url);
const childFixtureUrl = new URL('./examples/child.json', import.meta.url);
const unavailableFixtureUrl = new URL('./examples/unavailable.json', import.meta.url);
const schemaUrl = new URL('./quote-tool.schema.json', import.meta.url);

const stay = {
  propertyCode: 'HRCEN',
  arrivalDate: '2026-09-24',
  departureDate: '2026-09-27',
};

function v2(rooms, extra = {}) {
  return { schemaVersion: 2, ...stay, rooms, ...extra };
}

function issuePaths(result) {
  assert.equal(result.ok, false);
  return result.issues.map((issue) => issue.path);
}

function assertIssueShape(issue) {
  assert.equal(typeof issue.code, 'string');
  assert.equal(typeof issue.path, 'string');
  assert.equal(typeof issue.reason, 'string');
  assert.equal(typeof issue.action, 'string');
  assert.ok(issue.code.length);
  assert.ok(issue.path.length);
  assert.ok(issue.reason.length);
  assert.ok(issue.action.length);
}

test('AE1: two adults sharing one room with no room code normalize to an unconstrained v2 group', () => {
  const result = normalizeQuoteRequest(v2([{
    id: 'share',
    quantity: 1,
    adults: 2,
    children: 0,
    childAges: [],
  }]));
  assert.equal(result.ok, true);
  assert.equal(result.request.schemaVersion, 2);
  assert.equal(result.request.details, 'summary');
  assert.equal(result.request.maxOptionsPerGroup, 50);
  assert.equal(result.request.normalizedFrom, 'v2');
  assert.equal(result.request.rooms.length, 1);
  assert.equal(result.request.rooms[0].id, 'share');
  assert.equal(result.request.rooms[0].adults, 2);
  assert.equal(result.request.rooms[0].quantity, 1);
  assert.deepEqual(result.request.rooms[0].required, undefined);
  const assessed = assessConstraints(result.request.rooms[0], {
    roomCode: 'STQN',
    rateCode: 'BAR',
    roomDescription: 'Standard Queen',
  });
  assert.equal(assessed.matchStatus, 'match');
});

test('AE2: required twin vs queen is alternative; unknown bed stays unresolved; preference miss still matches', () => {
  const group = {
    id: 'group-1',
    quantity: 1,
    adults: 2,
    children: 0,
    childAges: [],
    required: { bedTypes: ['twin'] },
    preferred: { boardBases: ['breakfast'] },
  };
  const queen = assessConstraints(group, {
    roomCode: 'STQN',
    rateCode: 'BAR',
    bedType: 'queen',
    boardBase: 'breakfast',
    boardLabel: 'Bed & Breakfast R',
  });
  assert.equal(queen.matchStatus, 'alternative');
  assert.equal(queen.conditions.find((c) => c.field === 'bedTypes' && c.kind === 'required').status, 'unsatisfied');
  assert.equal(queen.conditions.find((c) => c.field === 'boardBases' && c.kind === 'preferred').status, 'satisfied');

  const unknownBed = assessConstraints(group, {
    roomCode: 'STQN',
    rateCode: 'BAR',
    bedType: null,
    boardBase: 'breakfast',
  });
  assert.equal(unknownBed.matchStatus, 'unresolved');
  assert.equal(unknownBed.conditions.find((c) => c.field === 'bedTypes' && c.kind === 'required').status, 'unknown');

  const twinRoomOnly = assessConstraints(group, {
    roomCode: 'STWN',
    rateCode: 'BAR',
    bedType: 'twin',
    boardBase: 'room_only',
  });
  assert.equal(twinRoomOnly.matchStatus, 'match');
  assert.equal(twinRoomOnly.conditions.find((c) => c.field === 'boardBases').status, 'unsatisfied');
});

test('AE4: displayed-nightly sums use exact decimals and the full stay, not the first night', () => {
  const high = sumDisplayedRates([
    { date: '2026-09-24', amount: '100.00', currency: 'ZAR' },
    { date: '2026-09-25', amount: '500.00', currency: 'ZAR' },
    { date: '2026-09-26', amount: '500.00', currency: 'ZAR' },
  ], 1);
  const low = sumDisplayedRates([
    { date: '2026-09-24', amount: '200.00', currency: 'ZAR' },
    { date: '2026-09-25', amount: '200.00', currency: 'ZAR' },
    { date: '2026-09-26', amount: '200.00', currency: 'ZAR' },
  ], 1);
  assert.equal(high.ok, true);
  assert.equal(low.ok, true);
  assert.equal(high.perRoom.amount, '1100.00');
  assert.equal(low.perRoom.amount, '600.00');
  assert.equal(high.perRoom.label, 'sum_of_displayed_nightly_rates');
  assert.equal(high.perRoom.official, false);
  assert.equal(high.forQuantity.official, false);
  assert.equal(high.perRoom.currency, 'ZAR');
  assert.ok(!('payable' in high));
  assert.ok(!('payable' in high.perRoom));
  assert.ok(Number(high.perRoom.amount) > Number(low.perRoom.amount));
});

test('ambiguous legacy and v2 fields are input gaps, not silent winners', () => {
  const mixed = normalizeQuoteRequest({
    schemaVersion: 2,
    ...stay,
    roomCode: 'STQN',
    rooms: [{ id: 'group-1', quantity: 1, adults: 2, children: 0, childAges: [] }],
  });
  assert.equal(mixed.ok, false);
  mixed.issues.forEach(assertIssueShape);
  assert.ok(issuePaths(mixed).some((path) => path.includes('roomCode') || path.includes('schemaVersion')));

  const legacyWithRequired = normalizeQuoteRequest({
    ...stay,
    rooms: [{
      quantity: 1,
      adults: 2,
      children: 0,
      childAges: [],
      required: { roomCodes: ['STQN'] },
    }],
  });
  assert.equal(legacyWithRequired.ok, false);
  assert.ok(issuePaths(legacyWithRequired).some((path) => path.includes('required')));
});

test('legacy adult and child fixtures normalize with assigned group ids, aliases and full details', async () => {
  const adult = normalizeQuoteRequest(JSON.parse(await readFile(adultFixtureUrl, 'utf8')));
  assert.equal(adult.ok, true, adult.ok ? '' : JSON.stringify(adult.issues));
  assert.equal(adult.request.normalizedFrom, 'legacy');
  assert.equal(adult.request.details, 'full');
  assert.equal(adult.request.rooms[0].id, 'group-1');
  assert.equal(adult.request.rooms[0].quantity, 2);
  assert.equal(adult.request.rooms[0].adults, 1);
  assert.deepEqual(adult.request.rooms[0].preferred.bedTypes, ['double']);
  assert.deepEqual(adult.request.rooms[0].preferred.boardBases, ['breakfast']);
  assert.ok(adult.request.rooms[0].preferred.features.some((f) => f.name === 'room_description' && f.value === 'Standard'));
  assert.ok(adult.request.rooms[0].preferred.features.some((f) => f.name === 'refundability'));
  assert.ok(adult.request.rooms[0].preferred.features.some((f) => f.name === 'payment_method'));
  assert.equal(adult.request.notes, 'Two rooms for two adults, interpreted as one adult per room.');

  const child = normalizeQuoteRequest(JSON.parse(await readFile(childFixtureUrl, 'utf8')));
  assert.equal(child.ok, true, child.ok ? '' : JSON.stringify(child.issues));
  assert.equal(child.request.rooms[0].id, 'group-1');
  assert.deepEqual(child.request.rooms[0].childAges, [12]);
  assert.deepEqual(child.request.rooms[0].preferred.boardBases, ['breakfast']);
});

test('legacy roomCode and rateCode become required singleton lists on every group', async () => {
  const result = normalizeQuoteRequest(JSON.parse(await readFile(unavailableFixtureUrl, 'utf8')));
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues));
  assert.deepEqual(result.request.rooms[0].required.roomCodes, ['STQN']);
  assert.deepEqual(result.request.rooms[0].required.rateCodes, ['BAR']);
});

test('reversed, impossible and overlong dates are input gaps', () => {
  for (const arrivalDate of ['2026-02-30', 'not a date', null, '2026-09-28']) {
    const result = normalizeQuoteRequest(v2([{ id: 'group-1', quantity: 1, adults: 1, children: 0, childAges: [] }], { arrivalDate }));
    assert.equal(result.ok, false);
  }
  const longStay = normalizeQuoteRequest(v2(
    [{ id: 'group-1', quantity: 1, adults: 1, children: 0, childAges: [] }],
    { arrivalDate: '2026-09-24', departureDate: '2026-10-25' },
  ));
  assert.equal(longStay.ok, false);
  assert.ok(issuePaths(longStay).some((path) => /departureDate|stay/.test(path)));
});

test('zero or missing rooms and adults cannot normalize', () => {
  assert.equal(normalizeQuoteRequest(v2([])).ok, false);
  assert.equal(normalizeQuoteRequest({ schemaVersion: 2, ...stay }).ok, false);
  assert.equal(normalizeQuoteRequest(v2([{ id: 'group-1', quantity: 0, adults: 1, children: 0, childAges: [] }])).ok, false);
  assert.equal(normalizeQuoteRequest(v2([{ id: 'group-1', quantity: 1, adults: 0, children: 0, childAges: [] }])).ok, false);
});

test('missing and stale child ages are input gaps', () => {
  const missing = normalizeQuoteRequest(v2([{ id: 'group-1', quantity: 1, adults: 1, children: 1, childAges: [] }]));
  assert.equal(missing.ok, false);
  assert.ok(issuePaths(missing).some((path) => path.endsWith('childAges')));
  const stale = normalizeQuoteRequest(v2([{ id: 'group-1', quantity: 1, adults: 1, children: 0, childAges: [12] }]));
  assert.equal(stale.ok, false);
});

test('duplicate group ids are input gaps; absent legacy ids become group-1 then group-2', () => {
  const duplicate = normalizeQuoteRequest(v2([
    { id: 'same', quantity: 1, adults: 1, children: 0, childAges: [] },
    { id: 'same', quantity: 1, adults: 1, children: 0, childAges: [] },
  ]));
  assert.equal(duplicate.ok, false);
  assert.ok(issuePaths(duplicate).some((path) => path.includes('id')));

  const legacy = normalizeQuoteRequest({
    ...stay,
    rooms: [
      { quantity: 1, adults: 1, children: 0, childAges: [] },
      { quantity: 1, adults: 2, children: 0, childAges: [] },
    ],
  });
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.request.rooms.map((room) => room.id), ['group-1', 'group-2']);
});

test('required lists are OR within a field and AND across fields; empty lists are invalid', () => {
  const empty = normalizeQuoteRequest(v2([{
    id: 'group-1',
    quantity: 1,
    adults: 1,
    children: 0,
    childAges: [],
    required: { roomCodes: [] },
  }]));
  assert.equal(empty.ok, false);

  const group = {
    id: 'group-1',
    quantity: 1,
    adults: 1,
    children: 0,
    childAges: [],
    required: { bedTypes: ['twin', 'double'], boardBases: ['breakfast'] },
  };
  const eitherBed = assessConstraints(group, { bedType: 'double', boardBase: 'breakfast' });
  assert.equal(eitherBed.matchStatus, 'match');
  const queenBreakfast = assessConstraints(group, { bedType: 'queen', boardBase: 'breakfast' });
  assert.equal(queenBreakfast.matchStatus, 'alternative');
  const twinRoomOnly = assessConstraints(group, { bedType: 'twin', boardBase: 'room_only' });
  assert.equal(twinRoomOnly.matchStatus, 'alternative');
});

test('unrecognized required feature stays unknown, never a substring match', () => {
  const group = {
    id: 'group-1',
    quantity: 1,
    adults: 1,
    children: 0,
    childAges: [],
    required: { features: [{ name: 'ocean_view', value: 'yes' }] },
  };
  const assessed = assessConstraints(group, {
    roomDescription: 'Ocean View Suite',
    features: [{ name: 'ocean_view', value: 'yes' }],
  });
  assert.equal(assessed.matchStatus, 'unresolved');
  assert.equal(assessed.conditions[0].status, 'unknown');
});

test('optional requested currency is retained; invalid codes gap', () => {
  const ok = normalizeQuoteRequest(v2(
    [{ id: 'group-1', quantity: 1, adults: 1, children: 0, childAges: [] }],
    { requestedCurrency: 'USD' },
  ));
  assert.equal(ok.ok, true);
  assert.equal(ok.request.requestedCurrency, 'USD');
  const bad = normalizeQuoteRequest(v2(
    [{ id: 'group-1', quantity: 1, adults: 1, children: 0, childAges: [] }],
    { requestedCurrency: 'zar' },
  ));
  assert.equal(bad.ok, false);
});

test('quantity multiplies exact cents; mixed currency or missing night yields no subtotal', () => {
  const scaled = sumDisplayedRates([
    { date: '2026-09-24', amount: '1780.50', currency: 'ZAR' },
    { date: '2026-09-25', amount: '1780.50', currency: 'ZAR' },
  ], 2);
  assert.equal(scaled.ok, true);
  assert.equal(scaled.perRoom.amount, '3561.00');
  assert.equal(scaled.forQuantity.amount, '7122.00');

  const mixed = sumDisplayedRates([
    { date: '2026-09-24', amount: '100.00', currency: 'ZAR' },
    { date: '2026-09-25', amount: '100.00', currency: 'USD' },
  ], 1);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.reason, 'mixed_currency');
  assert.equal(mixed.perRoom, undefined);

  const missing = sumDisplayedRates([
    { date: '2026-09-24', amount: '100.00', currency: 'ZAR' },
    { date: '2026-09-25', amount: null, currency: 'ZAR' },
  ], 1);
  assert.equal(missing.ok, false);
  assert.ok(['missing_amount', 'incomplete_dates', 'unsupported_amount_format'].includes(missing.reason));
});

test('available room alternatives keep only observed, usable rooms on the requested board', () => {
  const request = {
    propertyCode: 'HRCEN',
    arrivalDate: stay.arrivalDate,
    departureDate: stay.departureDate,
    requestedCurrency: 'ZAR',
    rooms: [{
      id: 'requested',
      quantity: 2,
      adults: 2,
      children: 0,
      childAges: [],
      required: { roomCodes: ['STQN'], boardBases: ['breakfast'] },
    }],
  };
  const nights = (inventory) => ['2026-09-24', '2026-09-25', '2026-09-26'].map((date) => ({
    date,
    inventory,
    price: { amount: '100.00', currency: 'ZAR' },
  }));
  const groups = [{
    id: 'requested',
    request: request.rooms[0],
    options: [
      {
        room: { code: 'STQN', label: 'Standard Queen' }, rate: { code: 'BAR', label: 'Bed & Breakfast' },
        board: 'Bed & Breakfast', matchStatus: 'match', eligibility: 'verified', availability: 'available', held: false,
        nightly: nights(1),
      },
      {
        room: { code: 'DLXTWN', label: 'Deluxe Twin' }, rate: { code: 'BAR', label: 'Bed & Breakfast' },
        board: 'Bed & Breakfast', matchStatus: 'alternative', eligibility: 'verified', availability: 'available', held: false,
        nightly: nights(1),
      },
      {
        room: { code: 'SKNG', label: 'Standard King' }, rate: { code: 'BAR', label: 'Bed & Breakfast' },
        board: 'Bed & Breakfast', matchStatus: 'alternative', eligibility: 'verified', availability: 'unavailable', held: false,
        nightly: nights(1),
      },
      {
        room: { code: 'DLXTWN', label: 'Deluxe Twin' }, rate: { code: 'BARRO', label: 'Bed & Breakfast' },
        board: 'B&B', matchStatus: 'alternative', eligibility: 'verified', availability: 'available', held: false,
        nightly: nights(2),
      },
      {
        room: { code: 'EXKNG', label: 'Executive King' }, rate: { code: 'DBB', label: 'Dinner B&B' },
        board: 'Dinner, bed & breakfast', matchStatus: 'alternative', eligibility: 'verified', availability: 'available', held: false,
        nightly: nights(2),
      },
      {
        room: { code: 'DLXQN', label: 'Deluxe Queen' }, rate: { code: 'BAR', label: 'Bed & Breakfast' },
        board: 'Bed & Breakfast', matchStatus: 'alternative', eligibility: 'conditional', availability: 'available', held: false,
        nightly: nights(2),
      },
      {
        room: { code: 'LUXKNG', label: 'Luxury King' }, rate: { code: 'BAR', label: 'Bed & Breakfast' },
        board: 'Bed & Breakfast', matchStatus: 'alternative', eligibility: 'verified', availability: 'available', held: true,
        nightly: nights(2),
      },
    ],
  }];

  assert.deepEqual(availableRoomAlternatives(groups, request), [
    { groupId: 'requested', roomCode: 'DLXTWN', roomLabel: 'Deluxe Twin', quantity: 2 },
    { groupId: 'requested', roomCode: 'SKNG', roomLabel: 'Standard King', quantity: 1 },
  ]);
});

test('available room alternatives recognize native HMS board labels', () => {
  const request = {
    propertyCode: 'HRCEN',
    arrivalDate: '2026-09-24',
    departureDate: '2026-09-25',
    requestedCurrency: 'ZAR',
    rooms: [{
      id: 'requested',
      quantity: 1,
      adults: 1,
      children: 0,
      childAges: [],
      required: { roomCodes: ['STQN'], boardBases: ['breakfast'] },
    }],
  };
  const groups = [{
    id: 'requested',
    options: [{
      room: { code: 'DLXTWN', label: 'Deluxe Twin' },
      rate: { code: 'BAR' },
      board: 'Bed & Breakfast R',
      matchStatus: 'alternative',
      eligibility: 'verified',
      availability: 'available',
      held: false,
      nightly: [{ date: '2026-09-24', inventory: 1 }],
    }],
  }];

  assert.deepEqual(availableRoomAlternatives(groups, request), [
    { groupId: 'requested', roomCode: 'DLXTWN', roomLabel: 'Deluxe Twin', quantity: 1 },
  ]);
});

test('available room alternatives keep a checked party\'s public rows and drop unverified-context rows', () => {
  const request = {
    propertyCode: 'HRCEN',
    arrivalDate: '2026-09-24',
    departureDate: '2026-09-25',
    requestedCurrency: 'ZAR',
    rateContext: { organization: { nativeId: '1842' } },
    rooms: [{ id: 'requested', quantity: 1, adults: 1, children: 0, childAges: [], required: { roomCodes: ['STQN'] } }],
  };
  const option = (code, condition) => ({
    room: { code, label: `Room ${code}` },
    rate: { code: 'BAR' },
    board: 'Bed & Breakfast R',
    rateScope: 'public',
    matchStatus: 'alternative',
    eligibility: 'verified',
    availability: 'available',
    held: false,
    conditions: [condition],
    nightly: [{ date: '2026-09-24', inventory: 1 }],
  });
  const groups = [{
    id: 'requested',
    options: [
      option('DLXTWN', { kind: 'preferred', field: 'rateContext', status: 'unsatisfied' }),
      option('SKNG', { kind: 'required', field: 'rateContext', status: 'unknown' }),
    ],
  }];

  assert.deepEqual(availableRoomAlternatives(groups, request), [
    { groupId: 'requested', roomCode: 'DLXTWN', roomLabel: 'Room DLXTWN', quantity: 1 },
  ]);
});

test('v2 rooms require ids; rate context accepts exactly one of code, name or nativeId', () => {
  const noId = normalizeQuoteRequest(v2([{ quantity: 1, adults: 1, children: 0, childAges: [] }]));
  assert.equal(noId.ok, false);
  assert.ok(issuePaths(noId).some((path) => path.includes('id')));

  const both = normalizeQuoteRequest(v2(
    [{ id: 'group-1', quantity: 1, adults: 1, children: 0, childAges: [] }],
    { rateContext: { organization: { code: 'ACME', name: 'Acme' } } },
  ));
  assert.equal(both.ok, false);

  const named = normalizeQuoteRequest(v2(
    [{ id: 'group-1', quantity: 1, adults: 1, children: 0, childAges: [] }],
    { rateContext: { organization: { name: 'Acme Hotels' } } },
  ));
  assert.equal(named.ok, true);
  assert.deepEqual(named.request.rateContext.organization, { name: 'Acme Hotels' });

  const lookedUp = normalizeQuoteRequest(v2(
    [{ id: 'group-1', quantity: 1, adults: 1, children: 0, childAges: [] }],
    { rateContext: { organization: { nativeId: '1842' }, agency: { nativeId: '91', name: ' CWT JNB ' } } },
  ));
  assert.equal(lookedUp.ok, true, lookedUp.ok ? '' : JSON.stringify(lookedUp.issues));
  assert.deepEqual(lookedUp.request.rateContext.organization, { nativeId: '1842' });
  assert.deepEqual(lookedUp.request.rateContext.agency, { nativeId: '91', name: 'CWT JNB' });

  const agencyIdOnly = normalizeQuoteRequest(v2(
    [{ id: 'group-1', quantity: 1, adults: 1, children: 0, childAges: [] }],
    { rateContext: { agency: { nativeId: '91' } } },
  ));
  assert.equal(agencyIdOnly.ok, false);
  assert.ok(issuePaths(agencyIdOnly).includes('rateContext.agency.name'));

  const groupNativeId = normalizeQuoteRequest(v2(
    [{ id: 'group-1', quantity: 1, adults: 1, children: 0, childAges: [] }],
    { rateContext: { group: { nativeId: '5' } } },
  ));
  assert.equal(groupNativeId.ok, false);
  assert.ok(issuePaths(groupNativeId).includes('rateContext.group.nativeId'));
});

test('published schema documents request and result contracts without selectors or authority digests', async () => {
  const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
  assert.equal(schema.$defs.request.type, 'object');
  assert.equal(schema.$defs.result.type, 'object');
  const schemaText = JSON.stringify(schema);
  assert.equal(schemaText.includes('authoritySha256'), false);
  assert.equal(schemaText.includes('bookingSessionID'), false);
  assert.equal(/selector|xpath|digest/i.test(schemaText), false);
  assert.ok(schema.$defs.result.properties.outcome.enum.includes('quote'));
  assert.ok(schema.$defs.result.properties.outcome.enum.includes('no_match'));
  assert.ok(schema.$defs.result.properties.outcome.enum.includes('unavailable'));
  assert.ok(schema.$defs.result.properties.outcome.enum.includes('input_gap'));
  assert.ok(schema.$defs.result.properties.outcome.enum.includes('partial'));
  assert.ok(schema.$defs.result.properties.outcome.enum.includes('execution_failure'));
  assert.deepEqual(schema.$defs.request.properties.search.properties.salesStrategy.enum, ['Preset', 'BAR', 'Promotions', 'Wholesale', 'Negotiated Contracted', 'Group & Convention', 'Government', 'Comp / House Use', 'Other']);
  const optionProps = schema.$defs.result.properties.groups.items.properties.options.items.properties;
  assert.deepEqual(optionProps.room.required, ['code', 'label']);
  assert.deepEqual(optionProps.rate.required, ['code', 'label']);
  assert.ok(optionProps.availability);
  assert.ok(optionProps.displayedSum);
  assert.equal(schema.$defs.nativeCode.enum, undefined);
  assert.equal(schema.$defs.constraints.properties.roomCodes.items.enum, undefined);
  assert.equal(schema.$defs.constraints.properties.rateCodes.items.enum, undefined);
  assert.ok(schema.$defs.result.description.includes('screenshots/group-N-availability-results.png'));
  assert.ok(schema.$defs.result.description.includes('screenshots/group-N-criteria-applied.png'));
  assert.equal(schema.$defs.request.properties.details.default, 'summary');
  assert.equal(schema.$defs.request.properties.maxOptionsPerGroup.default, 50);
  assert.equal(schema.$defs.request.properties.maxOptionsPerGroup.maximum, 200);
  assert.ok(schema.$defs.request.description.includes('schemaVersion'));
  assert.ok(schema.$defs.result.properties.groups.items.properties.options.items.properties.calculated.description.includes('sum_of_displayed_nightly_rates'));
  assert.equal(schema.$defs.result.properties.requested.$ref, undefined);
  assert.ok(schema.$defs.result.properties.requested.description.includes('input_gap'));
  const adult = normalizeQuoteRequest(JSON.parse(await readFile(adultFixtureUrl, 'utf8')));
  for (const key of Object.keys(adult.request)) {
    assert.ok(Object.hasOwn(schema.$defs.request.properties, key), `schema missing request property ${key}`);
  }
});

function selectedGroup(id, quantity, roomCode, rateCode, poolId) {
  return {
    id,
    quantity,
    required: { roomCodes: [roomCode], rateCodes: [rateCode] },
    poolId,
  };
}

test('AE5: two selected groups cannot quote four rooms from a three-room pool', () => {
  const nights = [
    { date: '2026-09-24', supply: 3 },
    { date: '2026-09-25', supply: 3 },
    { date: '2026-09-26', supply: 3 },
  ];
  const result = evaluateAllocation([
    selectedGroup('a', 2, 'STQN', 'BAR', 'HRCEN:STQN'),
    selectedGroup('b', 2, 'STQN', 'BARRO', 'HRCEN:STQN'),
  ], [{ id: 'HRCEN:STQN', nights }]);
  assert.equal(result.status, 'insufficient');
  assert.equal(result.pools[0].nights[0].demand, 4);
  assert.equal(result.pools[0].nights[0].supply, 3);
  assert.ok(!result.scenarioSum);
});

test('two rates sharing one proven pool combine demand; different allotments do not merge', () => {
  const nights = [{ date: '2026-09-24', supply: 4 }];
  const shared = evaluateAllocation([
    selectedGroup('a', 1, 'STQN', 'BAR', 'HRCEN:STQN'),
    selectedGroup('b', 1, 'STQN', 'BARRO', 'HRCEN:STQN'),
  ], [{ id: 'HRCEN:STQN', nights }]);
  assert.equal(shared.status, 'verified_at_observation');
  assert.equal(shared.pools[0].nights[0].demand, 2);

  const split = evaluateAllocation([
    selectedGroup('a', 2, 'STQN', 'BAR', 'HRCEN:STQN:BAR'),
    selectedGroup('b', 2, 'STQN', 'CORP', 'HRCEN:STQN:CORP'),
  ], [
    { id: 'HRCEN:STQN:BAR', nights: [{ date: '2026-09-24', supply: 2 }] },
    { id: 'HRCEN:STQN:CORP', nights: [{ date: '2026-09-24', supply: 2 }] },
  ]);
  assert.equal(split.status, 'verified_at_observation');
  assert.equal(split.pools.length, 2);
  assert.equal(split.pools[0].nights[0].demand, 2);
  assert.equal(split.pools[1].nights[0].demand, 2);
});

test('broad multi-group search is not_selected; missing pool identity stays unknown', () => {
  const broad = evaluateAllocation([
    { id: 'a', quantity: 1, required: { bedTypes: ['twin'] } },
    { id: 'b', quantity: 1, required: { bedTypes: ['twin'] } },
  ], [{ id: 'HRCEN:STQN', nights: [{ date: '2026-09-24', supply: 5 }] }]);
  assert.equal(broad.status, 'not_selected');

  const unknownPool = evaluateAllocation([
    selectedGroup('a', 1, 'STQN', 'BAR', undefined),
  ], []);
  assert.equal(unknownPool.status, 'unknown');
  const invented = evaluateAllocation([
    selectedGroup('a', 1, 'STQN', 'BAR', 'HRCEN:STQN'),
  ], []);
  assert.equal(invented.status, 'unknown');
});

test('orderOptions uses match class then full displayed-nightly sum with stable ties', () => {
  const options = [
    { roomCode: 'STQN', rateCode: 'BAR', matchStatus: 'match', displayedSum: '600.00', eligibility: 'verified', availability: 'available' },
    { roomCode: 'DLXQN', rateCode: 'BAR', matchStatus: 'alternative', displayedSum: '1100.00', eligibility: 'verified', availability: 'available' },
    { roomCode: 'STWN', rateCode: 'BAR', matchStatus: 'match', displayedSum: '1100.00', eligibility: 'verified', availability: 'available' },
    { roomCode: 'STWN', rateCode: 'BARRO', matchStatus: 'match', displayedSum: '1100.00', eligibility: 'verified', availability: 'available' },
  ];
  const ordered = orderOptions(options);
  assert.deepEqual(ordered.map((option) => `${option.roomCode}:${option.rateCode}`), [
    'STWN:BAR',
    'STWN:BARRO',
    'STQN:BAR',
    'DLXQN:BAR',
  ]);
});

test('salesStrategy accepts the dumped Hotel Availability labels', () => {
  const room = [{ id: 'group-1', quantity: 1, adults: 1, children: 0, childAges: [] }];
  const search = { includeRestricted: false, includeAlternatives: true };
  for (const salesStrategy of ['Preset', 'BAR', 'Promotions', 'Wholesale', 'Negotiated Contracted', 'Group & Convention', 'Government', 'Comp / House Use', 'Other']) {
    const result = normalizeQuoteRequest(v2(room, { search: { ...search, salesStrategy } }));
    assert.equal(result.ok, true);
    assert.equal(result.request.search.salesStrategy, salesStrategy);
  }
  const other = normalizeQuoteRequest(v2(room, { search: { ...search, salesStrategy: 'Corporate' } }));
  assert.equal(other.ok, false);
  assert.ok(issuePaths(other).includes('search.salesStrategy'));
  const openCodes = normalizeQuoteRequest(v2([{
    id: 'group-1',
    quantity: 1,
    adults: 1,
    children: 0,
    childAges: [],
    required: { roomCodes: ['STQN'], rateCodes: ['BARRO'] },
  }]));
  assert.equal(openCodes.ok, true);
});

test('aggregateOutcome follows input-gap, fatal, partial, no-match, unavailable, then quote', () => {
  assert.equal(aggregateOutcome({ inputIssues: [{ path: 'rooms[0].childAges' }] }).outcome, 'input_gap');
  assert.equal(aggregateOutcome({ fatal: { phase: 'search' }, groups: [{ outcome: 'quote', options: [{}] }] }).outcome, 'execution_failure');
  assert.equal(aggregateOutcome({
    groups: [{ outcome: 'quote', options: [{ matchStatus: 'match' }], completeness: { requiredFacts: 'incomplete' } }],
    allocation: { status: 'verified_at_observation' },
  }).outcome, 'partial');
  assert.equal(aggregateOutcome({
    groups: [{ outcome: 'no_match', options: [{ matchStatus: 'alternative' }], completeness: { requiredFacts: 'complete', search: 'complete' } }],
    allocation: { status: 'not_selected' },
  }).outcome, 'no_match');
  assert.equal(aggregateOutcome({
    groups: [{
      outcome: 'unavailable',
      options: [{ matchStatus: 'match', availability: 'unavailable' }],
      completeness: { requiredFacts: 'complete', search: 'complete' },
    }],
    allocation: { status: 'verified_at_observation' },
  }).outcome, 'unavailable');
  assert.equal(aggregateOutcome({
    groups: [
      { outcome: 'quote', options: [{ matchStatus: 'match' }], completeness: { requiredFacts: 'complete', search: 'complete' } },
      { outcome: 'quote', options: [{ matchStatus: 'match' }], completeness: { requiredFacts: 'complete', search: 'complete' } },
    ],
    allocation: { status: 'not_selected' },
  }).outcome, 'partial');
  assert.equal(aggregateOutcome({
    groups: [{ outcome: 'quote', options: [{ matchStatus: 'match' }], completeness: { requiredFacts: 'complete', search: 'complete' } }],
    allocation: { status: 'verified_at_observation' },
  }).outcome, 'quote');
});

test('orderOptions ranks preferred hits inside a match class before displayed-nightly sum', () => {
  const options = [
    { roomCode: 'STQN', rateCode: 'BAR', matchStatus: 'match', displayedSum: '1100.00', eligibility: 'verified', availability: 'available', conditions: [{ kind: 'preferred', status: 'unsatisfied' }] },
    { roomCode: 'STWN', rateCode: 'BAR', matchStatus: 'match', displayedSum: '600.00', eligibility: 'verified', availability: 'available', conditions: [{ kind: 'preferred', status: 'satisfied' }] },
  ];
  assert.deepEqual(orderOptions(options).map((option) => option.roomCode), ['STWN', 'STQN']);
});

test('composeAllocation uses proven building/room pools and invents none without a verified profile', () => {
  const night = (inventory) => [{ date: '2026-09-24', inventory }];
  const group = (id, quantity, roomCode, rateCode, buildingCode, inventory, matchStatus = 'match', eligibility = 'verified', availability = 'available') => ({
    id,
    request: { quantity, required: { roomCodes: [roomCode], rateCodes: [rateCode] } },
    options: [{ room: { code: roomCode, buildingCode }, rate: { code: rateCode }, matchStatus, eligibility, availability, nightly: night(inventory) }],
  });
  const over = composeAllocation([
    group('a', 2, 'STQN', 'BAR', 'H1', 3),
    group('b', 2, 'STQN', 'BARRO', 'H1', 3),
  ], 'HRCEN');
  assert.equal(over.status, 'insufficient');
  assert.equal(over.pools[0].id, 'HRCEN:H1:STQN');
  const ok = composeAllocation([
    group('a', 1, 'STQN', 'BAR', 'H1', 2),
    group('b', 1, 'STQN', 'BARRO', 'H1', 2),
  ], 'HRCEN');
  assert.equal(ok.status, 'verified_at_observation');
  const split = composeAllocation([
    group('a', 2, 'STQN', 'BAR', 'H1', 2),
    group('b', 2, 'DLXQN', 'BAR', 'H2', 2),
  ], 'HRCEN');
  assert.equal(split.status, 'verified_at_observation');
  assert.equal(split.pools.length, 2);
  assert.equal(composeAllocation([
    group('a', 1, 'STQN', 'BAR', null, 5),
    group('b', 1, 'STQN', 'BARRO', null, 5),
  ], 'OTHER').status, 'unknown');
  assert.equal(composeAllocation([
    group('a', 1, 'STQN', 'BAR', 'H1', 5),
    group('b', 1, 'STQN', 'BARRO', 'H1', 4),
  ], 'HRCEN').status, 'unknown');
  assert.equal(composeAllocation([
    { id: 'a', request: { quantity: 1 }, options: [] },
    { id: 'b', request: { quantity: 1 }, options: [] },
  ], 'HRCEN').status, 'not_selected');
  assert.equal(composeAllocation([
    group('a', 2, 'STQN', 'BAR', 'H1', 1, 'match', 'conditional', 'restricted'),
    group('b', 2, 'STQN', 'BAR', 'H1', 1, 'match', 'conditional', 'restricted'),
  ], 'HRCEN').status, 'unknown');
});

// Rows as fetch-quote leaves them: one room/rate option per group, nightly inventory per date.
const nights = (...inventories) => inventories.map((inventory, i) => ({ date: `2026-09-${24 + i}`, inventory }));
const roomGroup = (id, quantity, roomCode, rateCode, buildingCode, nightly, option = {}) => ({
  id,
  request: { quantity, required: { roomCodes: [roomCode], rateCodes: [rateCode] } },
  options: [{
    room: { code: roomCode, buildingCode },
    rate: { code: rateCode },
    matchStatus: 'match',
    eligibility: 'verified',
    availability: 'available',
    nightly,
    ...option,
  }],
});

test('AE1a: 30 STQN + 30 STWN on HRCEN with supply 34 and 69 on both nights is verified on two profile pools', () => {
  const allocation = composeAllocation([
    roomGroup('a', 30, 'STQN', 'BAR', null, nights(34, 34)),
    roomGroup('b', 30, 'STWN', 'BAR', null, nights(69, 69)),
  ], 'HRCEN');
  assert.equal(allocation.status, 'verified_at_observation');
  assert.deepEqual(allocation.pools.map((pool) => pool.id), ['HRCEN:profile:STQN', 'HRCEN:profile:STWN']);
  assert.deepEqual(allocation.pools[0].nights.map((night) => [night.demand, night.supply]), [[30, 34], [30, 34]]);
  assert.equal(allocation.poolBasis, 'property_profile');
  assert.equal(allocation.profileDigest, profileFor('HRCEN').digest);
  assert.equal(allocation.diagnostic, undefined);
});

test('AE1b: 40 STQN against 34 is insufficient on the STQN pool for every short night', () => {
  const allocation = composeAllocation([
    roomGroup('a', 25, 'STQN', 'BAR', null, nights(34, 34)),
    roomGroup('b', 15, 'STQN', 'BARRO', null, nights(34, 34)),
  ], 'HRCEN');
  assert.equal(allocation.status, 'insufficient');
  assert.equal(allocation.poolBasis, 'property_profile');
  assert.deepEqual(allocation.pools.map((pool) => pool.id), ['HRCEN:profile:STQN']);
  assert.deepEqual(allocation.pools[0].nights.map((night) => [night.date, night.demand, night.supply]), [
    ['2026-09-24', 40, 34],
    ['2026-09-25', 40, 34],
  ]);
});

test('same room type across two rows sums against one profile pool: 20 + 20 STQN is short of 34, 17 + 17 fits', () => {
  const short = composeAllocation([
    roomGroup('a', 20, 'STQN', 'BAR', null, nights(34)),
    roomGroup('b', 20, 'STQN', 'BARRO', null, nights(34)),
  ], 'HRCEN');
  assert.equal(short.status, 'insufficient');
  assert.equal(short.pools[0].nights[0].demand, 40);
  const fits = composeAllocation([
    roomGroup('a', 17, 'STQN', 'BAR', null, nights(34)),
    roomGroup('b', 17, 'STQN', 'BARRO', null, nights(34)),
  ], 'HRCEN');
  assert.equal(fits.status, 'verified_at_observation');
  assert.equal(fits.pools[0].nights[0].demand, 34);
});

test('AE1c: HRCEN with STWN reporting 70, above its capacity of 69, is out of date and unknown', () => {
  const allocation = composeAllocation([
    roomGroup('a', 1, 'STQN', 'BAR', null, nights(34)),
    roomGroup('b', 1, 'STWN', 'BAR', null, nights(70)),
  ], 'HRCEN');
  assert.equal(allocation.status, 'unknown');
  assert.equal(allocation.diagnostic, 'room_profile_mismatch');
  assert.match(allocation.reason, /^Room profile out of date/);
  assert.deepEqual(allocation.pools, []);
  assert.equal(allocation.poolBasis, undefined);
});

test('AE1d: a property without a verified profile keeps unknown for rows that HMS gave no building', () => {
  const allocation = composeAllocation([
    roomGroup('a', 1, 'STQN', 'BAR', null, nights(5)),
    roomGroup('b', 1, 'STWN', 'BAR', null, nights(5)),
  ], 'OTHER');
  assert.equal(allocation.status, 'unknown');
  assert.equal(allocation.reason, 'Source did not prove a shared inventory-pool identity.');
  assert.equal(allocation.diagnostic, undefined);
});

test('a building on one row and none on another keeps the building pool, and the profile is not used', () => {
  const allocation = composeAllocation([
    roomGroup('a', 1, 'STQN', 'BAR', 'H1', nights(5)),
    roomGroup('b', 1, 'STWN', 'BAR', null, nights(5)),
  ], 'HRCEN');
  assert.equal(allocation.status, 'unknown');
  assert.equal(allocation.diagnostic, 'room_profile_mismatch');
  assert.equal(allocation.poolBasis, undefined);
});

test('a room type outside the profile, or a malformed building, means the profile is not used and no pool is invented', () => {
  const unknownRoom = composeAllocation([
    roomGroup('a', 1, 'STQN', 'BAR', null, nights(5)),
    roomGroup('b', 1, 'PENT', 'BAR', null, nights(5)),
  ], 'HRCEN');
  assert.equal(unknownRoom.status, 'unknown');
  assert.equal(unknownRoom.diagnostic, 'room_profile_mismatch');
  for (const malformed of ['', 7, {}, undefined]) {
    const result = composeAllocation([
      roomGroup('a', 1, 'STQN', 'BAR', malformed, nights(5)),
      roomGroup('b', 1, 'STWN', 'BAR', null, nights(5)),
    ], 'HRCEN');
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.pools, []);
    assert.equal(result.poolBasis, undefined);
  }
});

test('profileHolds checks every observed option, not only the selected ones', () => {
  const selected = [roomGroup('a', 1, 'STQN', 'BAR', null, nights(34)), roomGroup('b', 1, 'STWN', 'BAR', null, nights(69))];
  assert.equal(profileHolds('HRCEN', selected), true);
  assert.equal(profileHolds('OTHER', selected), false);
  const withAlternative = (room, nightly) => {
    const group = roomGroup('a', 1, 'STQN', 'BAR', null, nights(34));
    group.options.push({
      room: { code: room, buildingCode: null }, rate: { code: 'BAR' }, matchStatus: 'alternative',
      eligibility: 'verified', availability: 'available', nightly,
    });
    return group;
  };
  assert.equal(profileHolds('HRCEN', [withAlternative('SUITE', nights(2, 2)), selected[1]]), true);
  // SUITE holds 2 rooms, so 3 observed is out of date even though the selected STQN row is fine.
  assert.equal(profileHolds('HRCEN', [withAlternative('SUITE', nights(3, 2)), selected[1]]), false);
  assert.equal(profileHolds('HRCEN', [withAlternative('PENT', nights(1)), selected[1]]), false);
});

test('R4: an unavailable group is insufficient on its pool, for a building or for the profile, never unknown', () => {
  const built = composeAllocation([
    roomGroup('a', 2, 'STQN', 'BAR', 'H1', nights(1, 1), { availability: 'unavailable' }),
    roomGroup('b', 1, 'STWN', 'BAR', 'H1', nights(5, 5)),
  ], 'HRCEN');
  assert.equal(built.status, 'insufficient');
  assert.deepEqual(built.pools.map((pool) => pool.id), ['HRCEN:H1:STQN', 'HRCEN:H1:STWN']);
  const profiled = composeAllocation([
    roomGroup('a', 2, 'STQN', 'BAR', null, nights(1, 1), { availability: 'unavailable' }),
    roomGroup('b', 1, 'STWN', 'BAR', null, nights(5, 5)),
  ], 'HRCEN');
  assert.equal(profiled.status, 'insufficient');
  assert.equal(profiled.pools[0].id, 'HRCEN:profile:STQN');
  assert.equal(profiled.pools[0].nights[0].supply, 1);
  assert.equal(profiled.diagnostic, undefined);
});

test('a profile allocation recomputes to the same result, and a tampered pool id does not match it', () => {
  const groups = [
    roomGroup('a', 30, 'STQN', 'BAR', null, nights(34)),
    roomGroup('b', 30, 'STWN', 'BAR', null, nights(69)),
  ];
  const allocation = composeAllocation(groups, 'HRCEN');
  assert.deepEqual(composeAllocation(groups, 'HRCEN'), allocation);
  const tampered = structuredClone(allocation);
  tampered.pools[1].id = 'HRCEN:profile:STQN';
  assert.notDeepEqual(tampered, composeAllocation(groups, 'HRCEN'));
});

test('legacy sourceReference is retained as notes when no other caller context exists', () => {
  const result = normalizeQuoteRequest({
    ...stay,
    rooms: [{ quantity: 1, adults: 1, children: 0, childAges: [] }],
    sourceReference: 'internal-case-33',
  });
  assert.equal(result.ok, true);
  assert.equal(result.request.notes, 'internal-case-33');
});

test('a required match beyond the return limit is partial, not no_match; alternatives are never summed', () => {
  assert.equal(aggregateOutcome({
    groups: [{
      outcome: 'no_match',
      options: [],
      completeness: { requiredFacts: 'complete', search: 'truncated', matchingRowsUnseen: true },
    }],
    allocation: { status: 'not_selected' },
  }).outcome, 'partial');
  const allocation = evaluateAllocation([
    { id: 'a', quantity: 1, required: { roomCodes: ['STQN'], rateCodes: ['BAR'] }, poolId: 'HRCEN:STQN', matchStatus: 'match' },
    { id: 'b', quantity: 1, required: { roomCodes: ['DLXQN'], rateCodes: ['BAR'] }, poolId: 'HRCEN:DLXQN', matchStatus: 'alternative' },
  ], [
    { id: 'HRCEN:STQN', nights: [{ date: '2026-09-24', supply: 5 }] },
    { id: 'HRCEN:DLXQN', nights: [{ date: '2026-09-24', supply: 5 }] },
  ]);
  assert.equal(allocation.status, 'not_selected');
});

test('import has no CLI, browser or credential side effects', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('./quote-contract.mjs', import.meta.url).href)}); console.log('import only');`],
  { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'import only');
  assert.equal(child.stderr, '');
});

test('shortfallsOf names the room type, each short night, the demand and the supply for a row below its quantity', () => {
  const short = roomGroup('a', 40, 'STQN', 'BAR', null, nights(34, 34), {
    availability: 'unavailable',
    room: { code: 'STQN', label: 'Standard Queen', buildingCode: null },
  });
  assert.deepEqual(shortfallsOf([short], 'OTHER'), [
    { roomCode: 'STQN', roomLabel: 'Standard Queen', date: '2026-09-24', demand: 40, supply: 34 },
    { roomCode: 'STQN', roomLabel: 'Standard Queen', date: '2026-09-25', demand: 40, supply: 34 },
  ]);
});

test('shortfallsOf names a shared profile pool whose combined demand is above supply, and not a row that fits', () => {
  const groups = [
    roomGroup('a', 20, 'STQN', 'BAR', null, nights(34)),
    roomGroup('b', 20, 'STQN', 'BARRO', null, nights(34)),
  ];
  assert.deepEqual(shortfallsOf(groups, 'HRCEN'), [
    { roomCode: 'STQN', roomLabel: 'STQN', date: '2026-09-24', demand: 40, supply: 34 },
  ]);
  const mixed = [
    roomGroup('a', 40, 'STQN', 'BAR', null, nights(34), {
      availability: 'unavailable',
      room: { code: 'STQN', label: 'Standard Queen', buildingCode: null },
    }),
    roomGroup('b', 30, 'STWN', 'BAR', null, nights(69), { room: { code: 'STWN', label: 'Standard Twin', buildingCode: null } }),
  ];
  assert.deepEqual(shortfallsOf(mixed, 'HRCEN').map((short) => short.roomCode), ['STQN']);
});

test('shortfallsOf finds nothing when every row and every shared pool fits', () => {
  assert.deepEqual(shortfallsOf([
    roomGroup('a', 17, 'STQN', 'BAR', null, nights(34)),
    roomGroup('b', 17, 'STQN', 'BARRO', null, nights(34)),
  ], 'HRCEN'), []);
  assert.deepEqual(shortfallsOf([
    roomGroup('a', 30, 'STQN', 'BAR', null, nights(34, 34)),
    roomGroup('b', 30, 'STWN', 'BAR', null, nights(69, 69)),
  ], 'HRCEN'), []);
});

test('shortfallsOf names only the short group when another group has a usable room type (Greptile example)', () => {
  // Group A accepts STQN or SKNG and SKNG fits; group B requires SUITE and is short. No pools are selected.
  const acceptsEither = {
    id: 'a',
    request: { quantity: 2, required: { roomCodes: ['STQN', 'SKNG'], rateCodes: ['BAR'] } },
    options: [
      { room: { code: 'STQN', label: 'Standard Queen', buildingCode: null }, rate: { code: 'BAR' }, matchStatus: 'match', eligibility: 'verified', availability: 'unavailable', nightly: nights(1, 1) },
      { room: { code: 'SKNG', label: 'Standard King', buildingCode: null }, rate: { code: 'BAR' }, matchStatus: 'match', eligibility: 'verified', availability: 'available', nightly: nights(5, 5) },
    ],
  };
  const suite = roomGroup('b', 2, 'SUITE', 'BAR', null, nights(1, 1), {
    availability: 'unavailable',
    room: { code: 'SUITE', label: 'Suite', buildingCode: null },
  });
  assert.deepEqual(composeAllocation([acceptsEither, suite], 'HRCEN').pools, []);
  assert.deepEqual(shortfallsOf([acceptsEither, suite], 'HRCEN'), [
    { roomCode: 'SUITE', roomLabel: 'Suite', date: '2026-09-24', demand: 2, supply: 1 },
    { roomCode: 'SUITE', roomLabel: 'Suite', date: '2026-09-25', demand: 2, supply: 1 },
  ]);
});

test('shortfallsOf does not count a fitting alternative as a usable option for its group', () => {
  const acceptsEither = {
    id: 'a',
    request: { quantity: 2, required: { roomCodes: ['STQN', 'SKNG'], rateCodes: ['BAR'] } },
    options: [
      { room: { code: 'STQN', label: 'Standard Queen', buildingCode: null }, rate: { code: 'BAR' }, matchStatus: 'match', eligibility: 'verified', availability: 'unavailable', nightly: nights(1) },
      { room: { code: 'SKNG', label: 'Standard King', buildingCode: null }, rate: { code: 'BAR' }, matchStatus: 'alternative', eligibility: 'verified', availability: 'available', nightly: nights(5) },
    ],
  };
  assert.deepEqual(shortfallsOf([acceptsEither], 'HRCEN').map((short) => short.roomCode), ['STQN']);
});

test('restrictedNightsOf names a night only when every matching row of the room type is closed to sale on it', () => {
  const night = (date, closed) => ({ date, inventory: 34, restricted: closed, rateAvailable: true, restrictions: { combClosed: false } });
  const stay = [night('2027-11-17', false), night('2027-11-18', true)];
  const row = (code, label, nightly, extra = {}) => ({
    room: { code, label, buildingCode: null }, rate: { code: 'BAR' }, matchStatus: 'match', eligibility: 'conditional', availability: 'restricted', nightly, ...extra,
  });
  const named = [
    { roomCode: 'STQN', roomLabel: 'Standard Queen', date: '2027-11-18' },
    { roomCode: 'STWN', roomLabel: 'Standard Twin', date: '2027-11-18' },
  ];
  assert.deepEqual(restrictedNightsOf([row('STQN', 'Standard Queen', stay), row('STWN', 'Standard Twin', stay)]), named);
  // Any matching row that is open or unrestricted means the group is not closed on that night: nothing is named.
  const open = row('STQN', 'Standard Queen', [night('2027-11-17', false), night('2027-11-18', false)], { rate: { code: 'BARRO' }, availability: 'available', eligibility: 'verified' });
  assert.deepEqual(restrictedNightsOf([row('STQN', 'Standard Queen', stay), open, row('STWN', 'Standard Twin', stay)]), []);
  // A length-of-stay restriction closes no night, and one row of a room type that is only length-restricted keeps its night unnamed.
  const losOnly = [night('2027-11-17', false), night('2027-11-18', false)];
  assert.deepEqual(restrictedNightsOf([row('STQN', 'Standard Queen', losOnly)]), []);
  assert.deepEqual(restrictedNightsOf([row('STQN', 'Standard Queen', stay), row('STQN', 'Standard Queen', losOnly, { rate: { code: 'BARRO' } })]), []);
  // An alternative row is not a matching row, so it cannot stop a closed matching night from being named.
  const alternative = row('SKNG', 'Standard King', losOnly, { matchStatus: 'alternative', availability: 'available', eligibility: 'verified' });
  assert.deepEqual(restrictedNightsOf([row('STQN', 'Standard Queen', stay), alternative]), [named[0]]);
});
