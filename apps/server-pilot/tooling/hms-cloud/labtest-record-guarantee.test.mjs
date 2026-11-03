import assert from 'node:assert/strict';
import test from 'node:test';
import * as records from './labtest-record.mjs';
import { blankSavedPartyFields } from './labtest-party-fields.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const expected = { confirmation: '123456-1', guestId: '123', arrival: '2027-11-12', departure: '2027-11-14',
  roomType: 'STQN', ratePlan: 'BAR', note: 'Proof Labtest test' };
const organization = { nativeId: '41', name: 'Example Company' };
const recordOptions = { allowUnchangedBusinessParties: true, expectedOrganization: organization };
const agentGuarantee = { code: 'GTDAGT', display: 'Guaranteed By Agent' };

// Execute the actual saved-record browser predicate against a synthetic Ext form.
function savedPage({ code = 'GTDAGT', display = 'Guaranteed By Agent', note = expected.note } = {}) {
  const values = { confirmationnumber: expected.confirmation, status: 'Reserved', guestid: expected.guestId,
    firstname: 'Proof', lastname: 'Labtest', arrivaldate: '12-NOV-2027', departuredate: '14-NOV-2027',
    roomtype: expected.roomType, rateplan: expected.ratePlan, track: 'BAR', guaranteetype: display,
    reservationnote: note, udfchkbox04: '', udfchar13: '', emailaddress: '' };
  const inputs = Object.entries(values).map(([name, value]) => ({ name, value, id: `${name}-inputEl`,
    offsetWidth: 1, offsetHeight: 1, closest: () => null }));
  const company = { name: 'company', value: organization.name, offsetWidth: 1, offsetHeight: 1, closest: () => null };
  const party = Object.fromEntries(blankSavedPartyFields.map((key) => [key, '']));
  party.companyid = organization.nativeId; party.company = organization.name;
  const data = { ...party, propertycode: 'HRCEN', confirmationnumber: expected.confirmation, guestid: expected.guestId,
    status: 'Reserved', firstname: 'Proof', lastname: 'Labtest', PKID: 'pk', bookingsessionid: 'session',
    reservationid: 'reservation', reservationstayid: 'stay', recordid: 'record' };
  const form = { el: { dom: { contains: () => true, querySelectorAll: () => [company] } },
    getRecord: () => ({ data }), getForm: () => ({ getValues: () => ({ company: organization.name }) }) };
  const ext = { getCmp: (id) => ({ up: () => form,
    getValue: () => id === 'guaranteetype' ? code : id === 'udfchkbox04' ? false : null }) };
  const frame = { url: () => `${ORIGIN}/record`, evaluate: async (fn, arg) => {
    const saved = new Map(['location', 'document', 'getComputedStyle', 'Ext'].map((key) =>
      [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    try {
      Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: ORIGIN } });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => inputs } });
      Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ visibility: 'visible' }) });
      Object.defineProperty(globalThis, 'Ext', { configurable: true, value: ext });
      return await fn(arg);
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  } };
  return { url: () => `${ORIGIN}/stay`, title: async () => 'Infor HMS - HRCEN',
    locator: () => ({ count: async () => 1, elementHandle: async () => ({ contentFrame: async () => frame }) }) };
}

test('read-only create reconciliation accepts the exact saved agent guarantee', async () => {
  assert.equal(typeof records.readCreatedLabtestRecord, 'function');
  const record = await records.readCreatedLabtestRecord(savedPage(), expected,
    { ...recordOptions, expectedGuarantee: agentGuarantee });
  assert.equal(record.partyPreimage.companyid, organization.nativeId);
  assert.equal(record.partyPreimage.company, organization.name);
});

test('created-record readback matches the full multiline HMS note limit', async () => {
  const note = `Line one\n${'x'.repeat(1_991)}`;
  const record = await records.readCreatedLabtestRecord(savedPage({ note }), { ...expected, note },
    { ...recordOptions, expectedGuarantee: agentGuarantee });
  assert.equal(record.partyPreimage.companyid, organization.nativeId);
  await assert.rejects(records.readCreatedLabtestRecord(savedPage({ note }), { ...expected, note: `${note}x` },
    { ...recordOptions, expectedGuarantee: agentGuarantee }), /LABTEST_RECORD_INPUT_INVALID/);
});

test('create reconciliation refuses a mismatched native value or displayed guarantee', async () => {
  for (const changed of [{ code: 'NGI' }, { display: 'Non-Guaranteed Individual' }]) {
    await assert.rejects(records.readCreatedLabtestRecord(savedPage(changed), expected,
      { ...recordOptions, expectedGuarantee: agentGuarantee }), /LABTEST_RECORD_UNVERIFIED/);
  }
});

test('the existing action guard remains NGI-only', async () => {
  await assert.rejects(records.currentLabtestRecord(savedPage(), expected, recordOptions), /LABTEST_RECORD_UNVERIFIED/);
  const record = await records.currentLabtestRecord(savedPage({ code: 'NGI', display: 'Non-Guaranteed Individual' }),
    expected, recordOptions);
  assert.equal(record.partyPreimage.companyid, organization.nativeId);
  await assert.rejects(records.currentLabtestRecord(savedPage(), expected,
    { ...recordOptions, expectedGuarantee: agentGuarantee }), /LABTEST_RECORD_INPUT_INVALID/);
});

test('create reconciliation rejects unsupported or malformed guarantee expectations', async () => {
  for (const bad of [{ code: 'GTDCC', display: 'Card' }, { code: 'GTDAGT', display: '' },
    { code: 'NGI', display: 'Guaranteed By Agent' }, { code: 'GTDAGT', display: 'Guaranteed By Agent', extra: true }]) {
    await assert.rejects(records.readCreatedLabtestRecord(savedPage(), expected,
      { ...recordOptions, expectedGuarantee: bad }), /LABTEST_RECORD_INPUT_INVALID/);
  }
});
