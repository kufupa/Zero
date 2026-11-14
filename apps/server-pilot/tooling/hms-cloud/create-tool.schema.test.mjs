import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validate } from './create-request.mjs';

const schemaUrl = new URL('./create-tool.schema.json', import.meta.url);
function requiredRequest(extra = {}) {
  return {
    arrival: '2026-09-22',
    departure: '2026-09-23',
    adults: 1,
    sourceOfBusiness: 'Walk in',
    roomType: 'STQN',
    ratePlan: 'OPEN-CODE',
    track: 'BAR',
    firstName: 'Pat',
    lastName: 'Lee',
    guaranteeType: 'Awaiting Voucher',
    ...extra,
  };
}

function fact(value, provenance) {
  return { value, provenance };
}

function validResult() {
  return {
    confirmationNumber: fact('H100', 'observed'),
    status: fact('New', 'observed'),
    mealPlan: fact(null, 'unknown'),
    marketSegment: fact('Best Available Rate', 'observed'),
    totals: fact(null, 'unknown'),
    depositDue: fact(null, 'unknown'),
    depositAmount: fact(null, 'unknown'),
    screenshots: {
      filled: 'filled.png',
      availability: 'availability.png',
      saved: 'saved.png',
    },
  };
}

const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));

function requestResult(data) {
  return validate(schema.$defs.request, data, schema);
}

function resultResult(data) {
  return validate(schema.$defs.result, data, schema);
}

test('offline schema test does not opt into pilot RDS', () => {
  assert.notEqual(process.env.VITEST_ALLOW_PILOT_RDS, '1');
  assert.equal(/nava-zero-mail-pilot/i.test(process.env.DATABASE_URL || ''), false);
});

test('valid request with required fields passes', () => {
  const result = requestResult(requiredRequest());
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(schema.$defs.request.required, [
    'arrival',
    'departure',
    'adults',
    'sourceOfBusiness',
    'roomType',
    'ratePlan',
    'track',
    'firstName',
    'lastName',
    'guaranteeType',
  ]);
});

test('optional agency, organization, arAccount, billingReference, profileId accepted and not required', () => {
  const withOptional = requestResult(requiredRequest({
    agency: 'ACME',
    organization: 'ACME Hotels',
    arAccount: 'AR1',
    billingReference: 'PO-1',
    profileId: 42,
  }));
  assert.equal(withOptional.ok, true, withOptional.errors.join('; '));
  const withoutOptional = requestResult(requiredRequest());
  assert.equal(withoutOptional.ok, true, withoutOptional.errors.join('; '));
  for (const key of ['agency', 'organization', 'arAccount', 'billingReference', 'profileId']) {
    assert.equal(schema.$defs.request.required.includes(key), false);
    assert.equal(Object.hasOwn(schema.$defs.request.properties, key), true);
  }
});

test('create request accepts party-lookup nativeId only where the form takes an id', () => {
  const lookedUp = requestResult(requiredRequest({ profileId: { nativeId: '55', kind: 'guest' } }));
  assert.equal(lookedUp.ok, true, lookedUp.errors.join('; '));
  for (const field of ['agency', 'organization', 'arAccount']) {
    const nameLookup = requestResult(requiredRequest({ [field]: { nativeId: '91' } }));
    assert.equal(nameLookup.ok, false, `${field} lookup field takes a name, not a nativeId`);
  }
  const emptyNative = requestResult(requiredRequest({ profileId: { nativeId: '' } }));
  assert.equal(emptyNative.ok, false);
  const nonNumeric = requestResult(requiredRequest({ profileId: { nativeId: 'Lee, Pat' } }));
  assert.equal(nonNumeric.ok, false, 'guestid takes a numeric profile id');
  const wrongKind = requestResult(requiredRequest({ profileId: { nativeId: '49', kind: 'organization' } }));
  assert.equal(wrongKind.ok, false, 'profileId takes guest candidates only');
});

test('adults 0 is refused', () => {
  const result = requestResult(requiredRequest({ adults: 0 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('adults')));
  assert.equal(requestResult(requiredRequest({ adults: 1 })).ok, true);
});

test('missing guaranteeType fails', () => {
  const request = requiredRequest();
  delete request.guaranteeType;
  const result = requestResult(request);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('guaranteeType')));
});

test('boardBasis fails', () => {
  const result = requestResult(requiredRequest({ boardBasis: 'breakfast' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('boardBasis')));
});

test('guestName fails', () => {
  const result = requestResult(requiredRequest({ guestName: 'Pat Lee' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('guestName')));
});

test('language or settlement key fails', () => {
  const language = requestResult(requiredRequest({ language: 'English' }));
  assert.equal(language.ok, false);
  assert.ok(language.errors.some((error) => error.includes('language')));
  const settlement = requestResult(requiredRequest({ settlement: '9000' }));
  assert.equal(settlement.ok, false);
  assert.ok(settlement.errors.some((error) => error.includes('settlement')));
  const title = requestResult(requiredRequest({ title: 'Mr' }));
  assert.equal(title.ok, false);
  const vip = requestResult(requiredRequest({ vip: 'VIP1' }));
  assert.equal(vip.ok, false);
});

test('meal plan and totals are not request fields', () => {
  const mealPlan = requestResult(requiredRequest({ mealPlan: 'BB' }));
  assert.equal(mealPlan.ok, false);
  assert.ok(mealPlan.errors.some((error) => error.includes('mealPlan')));
  const totals = requestResult(requiredRequest({ totals: '0.00' }));
  assert.equal(totals.ok, false);
  assert.ok(totals.errors.some((error) => error.includes('totals')));
});

test('childAges is optional and the gray category boxes are not request keys', () => {
  const withAges = requestResult(requiredRequest({ childAges: [5] }));
  assert.equal(withAges.ok, true, withAges.errors.join('; '));
  const tooOld = requestResult(requiredRequest({ childAges: [18] }));
  assert.equal(tooOld.ok, false);
  assert.ok(tooOld.errors.some((error) => error.includes('childAges')));
  const category = requestResult(requiredRequest({ child1: 1 }));
  assert.equal(category.ok, false);
  assert.ok(category.errors.some((error) => error.includes('child1')));
  assert.equal(schema.$defs.request.required.includes('childAges'), false);
  assert.equal(schema.$defs.request.properties.ratePlan.enum, undefined);
});

test('shop output requires BAR rows and refuses a clicked row', () => {
  const shop = {
    salesStrategy: 'BAR',
    rowClicked: false,
    rows: [{ roomType: 'STQN', code: 'BAR', name: 'Best Available Rate' }],
  };
  const ok = validate(schema.$defs.shop, shop, schema);
  assert.equal(ok.ok, true, ok.errors.join('; '));
  const clicked = validate(schema.$defs.shop, { ...shop, rowClicked: true }, schema);
  assert.equal(clicked.ok, false);
  assert.equal(Object.hasOwn(schema.$defs.request.properties, 'cardnumber'), false);
  assert.equal(schema.$defs.result.properties.depositDue.$ref, '#/$defs/explicitUnknown');
});

test('result shape accepts named fields and requires deposit fields unknown', () => {
  const ok = resultResult(validResult());
  assert.equal(ok.ok, true, ok.errors.join('; '));
  for (const key of ['confirmationNumber', 'status', 'mealPlan', 'marketSegment', 'totals', 'depositDue', 'depositAmount']) {
    assert.equal(schema.$defs.result.required.includes(key), true);
  }
  assert.equal(schema.$defs.result.properties.screenshots.properties.before.const, 'before.png');
  assert.equal(schema.$defs.result.properties.screenshots.properties.filled.const, 'filled.png');
  assert.equal(schema.$defs.result.properties.screenshots.properties.availability.const, 'availability.png');
  assert.equal(schema.$defs.result.properties.screenshots.properties.saved.const, 'saved.png');

  const missingDeposit = validResult();
  delete missingDeposit.depositDue;
  const missing = resultResult(missingDeposit);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.includes('depositDue')));

  const observedDeposit = validResult();
  observedDeposit.depositAmount = fact(null, 'observed');
  const observed = resultResult(observedDeposit);
  assert.equal(observed.ok, false);

  const valuedDeposit = validResult();
  valuedDeposit.depositDue = fact('10.00', 'unknown');
  const valued = resultResult(valuedDeposit);
  assert.equal(valued.ok, false);
});
