import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  amendRoomTypes,
  getProfileBoards,
  getProfileLetter,
  getProfileRates,
  parseStayProperty,
  profileFor,
  propertySecretRefusal,
  validateProfile,
} from './property-profile.mjs';
import { PROPERTY_REGISTRY } from './property-registry.mjs';

const hrcenUrl = new URL('./property-profiles/HRCEN.json', import.meta.url);
const hrcenRaw = async () => JSON.parse(await readFile(hrcenUrl, 'utf8'));

test('the checked-in HRCEN profile loads: nine room types summing to the published 160 rooms, no building', () => {
  const profile = profileFor('HRCEN');
  assert.equal(profile.publishedRooms, 160);
  assert.equal(profile.building, 'none');
  assert.deepEqual(profile.roomCapacity, {
    DLXKNG: 8, DLXQN: 10, DLXTWN: 22, EXKNG: 5, LUXKNG: 4, SKNG: 6, STQN: 34, STWN: 69, SUITE: 2,
  });
  assert.match(profile.digest, /^[0-9a-f]{64}$/);
  assert.equal(profileFor('HRCEN').digest, profile.digest);
});

test('every registry property points at its verified room profile', () => {
  for (const property of PROPERTY_REGISTRY.properties) {
    if (property.profileFile) assert.equal(profileFor(property.propertyCode).propertyCode, property.propertyCode);
  }
});

test('capacities summing to 161 against 160 published rooms are rejected', async () => {
  const raw = await hrcenRaw();
  raw.roomCapacity.SUITE = 3;
  assert.throws(() => validateProfile(raw, 'HRCEN'), /capacities sum to 161 but the property publishes 160 rooms/);
});

test('an unknown property has no profile', () => {
  assert.equal(profileFor('NOTAPROP'), null);
  assert.equal(profileFor(undefined), null);
});

test('HRDAV profile lists EXKNGB and requires reservationnote; HRCEN does not', () => {
  const hrdav = profileFor('HRDAV');
  const hrcen = profileFor('HRCEN');
  assert.ok(Object.hasOwn(hrdav.roomCapacity, 'EXKNGB'));
  assert.deepEqual(hrdav.requiredCreateFields, ['reservationnote']);
  assert.deepEqual(hrcen.requiredCreateFields, []);
  assert.ok(!Object.hasOwn(hrcen.roomCapacity, 'EXKNGB'));
  assert.ok(amendRoomTypes('HRDAV').includes('EXKNGB'));
  assert.ok(amendRoomTypes('HRCEN').includes('STQN'));
  assert.equal(amendRoomTypes('HRDAV').includes('STQN'), false);
});

test('propertySecretRefusal refuses a secret for the other hotel before login', () => {
  assert.equal(propertySecretRefusal({ expectedPropertyCode: 'HRDAV' }, 'HRDAV'), null);
  assert.equal(propertySecretRefusal({ expectedPropertyCode: 'HRCEN' }, 'HRDAV'), 'PROPERTY_HRDAV_REQUIRED');
  assert.equal(propertySecretRefusal({ expectedPropertyCode: 'HRDAV' }, 'HRCEN'), 'PROPERTY_HRCEN_REQUIRED');
  assert.equal(propertySecretRefusal({ expectedPropertyCode: 'HRCEN' }, 'HRFAKE'), 'PROPERTY_HRFAKE_REQUIRED');
});

test('parseStayProperty requires --property, accepts a registered code, refuses unknown', () => {
  assert.deepEqual(parseStayProperty(['--mode', 'preview']), {
    ok: false,
    exitCode: 2,
    error: 'PROPERTY_REQUIRED',
  });
  assert.deepEqual(parseStayProperty(['--property', 'HRDAV', '--mode', 'preview']), {
    ok: true,
    propertyCode: 'HRDAV',
    rest: ['--mode', 'preview'],
  });
  assert.deepEqual(parseStayProperty(['--property', 'OTHER']), {
    ok: false,
    exitCode: 2,
    error: 'PROPERTY_UNKNOWN',
  });
});

test('a profile without requiredCreateFields is rejected', async () => {
  const raw = await hrcenRaw();
  delete raw.requiredCreateFields;
  assert.throws(() => validateProfile(raw, 'HRCEN'), /requiredCreateFields must list HMS field names/);
});

test('a non-integer capacity is rejected', async () => {
  const raw = await hrcenRaw();
  raw.roomCapacity.STQN = 34.5;
  assert.throws(() => validateProfile(raw, 'HRCEN'), /capacity of STQN must be a positive integer/);
});

test('a profile that drops its evidence or claims an HMS building is rejected', async () => {
  const noEvidence = await hrcenRaw();
  delete noEvidence.evidence;
  assert.throws(() => validateProfile(noEvidence, 'HRCEN'), /evidence sources are required/);
  const withBuilding = await hrcenRaw();
  withBuilding.building = 'MAIN';
  assert.throws(() => validateProfile(withBuilding, 'HRCEN'), /only a property with no HMS building/);
});

test('both hotels load rates, boards and letter; unknown property throws', () => {
  const hrcen = profileFor('HRCEN');
  const hrdav = profileFor('HRDAV');
  assert.deepEqual(getProfileRates('HRCEN').public, ['BAR', 'BARRO', 'WAL']);
  assert.equal(hrcen.classifyRate('BAR', 'BAR', false), 'public');
  assert.equal(
    hrcen.classifyRate('NGOVB', 'GOV', false, 'Local Government Rate Breakfast'),
    'government',
  );
  assert.equal(hrcen.classifyRate('ZZZUNK', 'BAR', false), 'unknown');
  assert.equal(getProfileBoards('HRCEN')['bed & breakfast r'], 'breakfast');
  assert.match(getProfileLetter('HRCEN').hotel.source, /The Centurion Hotel/);
  assert.equal(hrcen.cancellation, undefined);

  assert.deepEqual(getProfileRates('HRDAV').public, ['BAR', 'BARRO', 'WAL']);
  const wsPlans = getProfileRates('HRDAV').strategies.WS.plans;
  assert.ok(wsPlans.includes('BWS1B'));
  assert.equal(getProfileRates('HRDAV').strategies.WS.scope, 'agency');
  assert.equal(hrdav.classifyRate('BWS1B', 'WS', false), 'contextual');
  assert.equal(getProfileBoards('HRDAV')['bed & breakfast nr'], 'breakfast');
  assert.match(getProfileLetter('HRDAV').hotel.source, /Da \?Vinci Hotel/);
  assert.equal(hrdav.cancellation.noticeHours, 48);
  assert.ok(hrdav.observedStrategyRatePlans.WS.ratePlans.some((row) => row.value === 'BWS1B'));

  assert.throws(() => getProfileRates('NOTAPROP'), /property_profile_unknown/);
  assert.throws(() => getProfileRates(undefined), /property_profile_unknown/);
});

test('a bad letter regex string is rejected', async () => {
  const raw = await hrcenRaw();
  raw.letter = { hotel: '[', confirmation: '/The Centurion Hotel/' };
  assert.throws(() => validateProfile(raw, 'HRCEN'), /not a valid regular expression/);
});
