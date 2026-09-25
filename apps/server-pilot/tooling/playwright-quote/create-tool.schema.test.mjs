import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validate } from './create-request.mjs';

const schemaUrl = new URL('./create-tool.schema.json', import.meta.url);
const catalogUrl = new URL('./create-side-catalog.json', import.meta.url);
const recordUrl = new URL('../../../../.private/create-screen/new-record.md', import.meta.url);

function lineStarting(markdown, prefix) {
  const line = markdown.split('\n').find((entry) => entry.startsWith(prefix));
  if (!line) throw new Error(`missing line ${prefix}`);
  return line;
}

function semiList(line, prefix, suffix) {
  let body = line.slice(prefix.length);
  if (suffix) body = body.replace(suffix, '');
  body = body.replace(/\.$/, '');
  return body.split('; ').map((item) => item.trim());
}

function table(markdown, startHeading, header) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((entry) => entry.startsWith(startHeading));
  const rows = [];
  let seenHeader = false;
  for (const entry of lines.slice(start)) {
    if (entry.startsWith(header)) {
      seenHeader = true;
      continue;
    }
    if (!seenHeader) continue;
    if (entry.startsWith('|---')) continue;
    if (!entry.startsWith('|')) break;
    rows.push(entry.split('|').slice(1, -1).map((cell) => cell.trim()));
  }
  return rows;
}

function openedLists(markdown) {
  const guaranteeType = semiList(
    lineStarting(markdown, '- Guarantee Type:'),
    '- Guarantee Type: ',
    /\.\s*Evidence:.*$/,
  );
  const sourceOfBusiness = semiList(
    lineStarting(markdown, '- Source Of Business:'),
    '- Source Of Business: ',
    /\.\s*Lookup title:.*$/,
  );
  const roomType = semiList(
    lineStarting(markdown, '- Room Type and Room Type for Charge:'),
    '- Room Type and Room Type for Charge: ',
    /\.\s*Evidence:.*$/,
  ).map((item) => item.split(' — ')[0]);
  const title = semiList(
    lineStarting(markdown, '- Title (dropdown-prefix.png):'),
    '- Title (dropdown-prefix.png): ',
    '',
  );
  const vip = semiList(
    lineStarting(markdown, '- VIP Level (dropdown-viplevel.png):'),
    '- VIP Level (dropdown-viplevel.png): ',
    '',
  );
  const language = semiList(markdown.split('\n').find((entry) => entry.startsWith('Afar;')), '', '');
  const track = table(
    markdown,
    'Track / Sub Segment lookup',
    '| Code | Description | Market segment shown |',
  ).map((cells) => cells[0]);
  const settlement = table(markdown, '## Settlement', '| Code | Description | Pay Type |').map((cells) => ({
    code: cells[0],
    description: cells[1],
    payType: cells[2],
  }));
  return { guaranteeType, roomType, sourceOfBusiness, track, language, title, vip, settlement };
}

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
const catalog = JSON.parse(await readFile(catalogUrl, 'utf8'));
const lists = openedLists(await readFile(recordUrl, 'utf8'));

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

test('enums match new-record.md opened lists', () => {
  assert.equal(lists.guaranteeType.length, 10);
  assert.equal(lists.roomType.length, 9);
  assert.equal(lists.sourceOfBusiness.length, 25);
  assert.equal(lists.track.length, 21);
  assert.deepEqual(schema.$defs.request.properties.guaranteeType.enum, lists.guaranteeType);
  assert.deepEqual(schema.$defs.request.properties.roomType.enum, lists.roomType);
  assert.deepEqual(schema.$defs.request.properties.sourceOfBusiness.enum, lists.sourceOfBusiness);
  assert.deepEqual(schema.$defs.request.properties.track.enum, lists.track);
  assert.equal(schema.$defs.request.properties.ratePlan.enum, undefined);
  assert.equal(JSON.stringify(schema).includes('resolveReference'), false);
  assert.match(schema.description, /\{ value, provenance \}/);
  assert.match(schema.description, /filled\.png/);
  assert.match(schema.description, /availability\.png/);
  assert.match(schema.description, /saved\.png/);
});

test('side catalog copies language, title, VIP, and settlement and they are not request keys', () => {
  assert.equal(lists.language.length, 145);
  assert.equal(lists.title.length, 45);
  assert.equal(lists.vip.length, 10);
  assert.equal(lists.settlement.length, 19);
  assert.deepEqual(catalog.language, lists.language);
  assert.deepEqual(catalog.title, lists.title);
  assert.deepEqual(catalog.vip, lists.vip);
  assert.deepEqual(catalog.settlement, lists.settlement);
  for (const key of ['language', 'title', 'vip', 'settlement']) {
    assert.equal(Object.hasOwn(schema.$defs.request.properties, key), false);
  }
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

test('create request accepts party-lookup nativeId objects on identity fields', () => {
  const lookedUp = requestResult(requiredRequest({
    agency: { nativeId: '91', kind: 'bookingAgency' },
    organization: { nativeId: '1842', kind: 'organization' },
    arAccount: { nativeId: '7', kind: 'arAccount' },
    profileId: { nativeId: '55', kind: 'guest' },
  }));
  assert.equal(lookedUp.ok, true, lookedUp.errors.join('; '));
  const emptyNative = requestResult(requiredRequest({ agency: { nativeId: '' } }));
  assert.equal(emptyNative.ok, false);
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
  const tooOld = requestResult(requiredRequest({ childAges: [100] }));
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
