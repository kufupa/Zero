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
function savedPage({ code = 'GTDAGT', display = 'Guaranteed By Agent', recipient = '', recipientModel = recipient,
  recipientForm = recipient, agency = null, companyId = organization.nativeId, companyName = organization.name,
  agencyId = agency?.nativeId, agencyName = agency?.name, send = false, guestEmail = '',
  noteCount = 1, modelChanges = {}, visibleChanges = {} } = {}) {
  const values = { confirmationnumber: expected.confirmation, status: 'Reserved', guestid: expected.guestId,
    firstname: 'Proof', lastname: 'Labtest', arrivaldate: '12-NOV-2027', departuredate: '14-NOV-2027',
    roomtype: expected.roomType, rateplan: expected.ratePlan, track: 'BAR', guaranteetype: display,
    reservationnote: expected.note, udfchkbox04: '', udfchar13: recipient, emailaddress: guestEmail, ...visibleChanges };
  const inputs = Object.entries(values).filter(([name]) => name !== 'reservationnote' || noteCount > 0)
    .map(([name, value]) => ({ name, value, id: `${name}-inputEl`,
    offsetWidth: 1, offsetHeight: 1, closest: () => null }));
  if (noteCount > 1) inputs.push({ ...inputs.find((input) => input.name === 'reservationnote') });
  const company = { name: 'company', value: companyName, offsetWidth: 1, offsetHeight: 1, closest: () => null };
  const agencyInput = agency ? { name: 'ta1', value: agency.name, offsetWidth: 1, offsetHeight: 1, closest: () => null } : null;
  const party = Object.fromEntries(blankSavedPartyFields.map((key) => [key, '']));
  party.companyid = companyId; party.company = companyName;
  if (agency) { party.taid1 = agencyId; party.ta1 = agencyName; }
  const data = { ...party, propertycode: 'HRCEN', confirmationnumber: expected.confirmation, guestid: expected.guestId,
    status: 'Reserved', firstname: 'Proof', lastname: 'Labtest', arrivaldate: '11/12/2027', departuredate: '11/14/2027',
    PKID: 'pk', bookingsessionid: 'session', reservationid: '41', reservationstayid: '42', recordid: 'record',
    udfchar13: recipientModel, ...modelChanges };
  const form = { el: { dom: { contains: () => true, querySelectorAll: () => [company, ...(agencyInput ? [agencyInput] : [])] } },
    getRecord: () => ({ data }), getForm: () => ({ getValues: () => ({ company: companyName, udfchar13: recipientForm,
      ...(agency ? { ta1: agencyName } : {}) }) }) };
  const ext = { getCmp: (id) => ({ up: () => form,
    getValue: () => id === 'guaranteetype' ? code : id === 'udfchkbox04' ? send : null }) };
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

test('document-only guard permits unrelated stay details but binds fake identity and no-send', async () => {
  const agency = { nativeId: '99', name: 'Example Agency' };
  const context = { cmsSend: false };
  const options = { code: 'GTDAGT', display: 'Guaranteed By Agent', recipient: 'booker@example.invalid', agency };
  const record = await records.currentLabtestDocumentRecord(savedPage(options), expected, context);
  assert.equal(record.native.reservationstayid, '42');
  // The ordinary amend/cancel guard still refuses the same nonblank recipient.
  await assert.rejects(records.currentLabtestRecord(savedPage(options), expected, recordOptions), /LABTEST_RECORD_UNVERIFIED/);
  for (const changed of [{ recipient: 'other@example.invalid' }, { recipientModel: 'other@example.invalid' },
    { recipientForm: 'other@example.invalid' }, { guestEmail: 'guest@example.invalid' }, { noteCount: 0 }, { noteCount: 2 },
    { companyId: '42' }, { companyName: 'Other Company' }, { agencyId: '100' }, { agencyName: 'Other Agency' },
    { code: 'NGI', display: 'Non-Guaranteed Individual' },
    { modelChanges: { roomtype: 'OTHER', rateplan: 'OTHER' }, visibleChanges: { roomtype: 'DIFFERENT', rateplan: 'DIFFERENT' } }]) {
    assert.ok(await records.currentLabtestDocumentRecord(savedPage({ ...options, ...changed }), expected, context));
  }
  for (const changed of [{ send: true }, { modelChanges: { propertycode: 'HRDAV' } },
    { modelChanges: { guestid: '124' } }, { visibleChanges: { guestid: '124' } },
    { modelChanges: { status: 'Cancelled' } }, { modelChanges: { firstname: 'Other' } },
    { visibleChanges: { lastname: 'Other' } }, { visibleChanges: { arrivaldate: '13-NOV-2027' } },
    { modelChanges: { departuredate: '11/15/2027' } }]) {
    await assert.rejects(records.currentLabtestDocumentRecord(savedPage({ ...options, ...changed }), expected, context),
      /LABTEST_RECORD_UNVERIFIED/);
  }
  for (const bad of [{ cmsSend: true }, {}, { ...context, extra: true }]) {
    await assert.rejects(records.currentLabtestDocumentRecord(savedPage(options), expected, bad), /LABTEST_RECORD_INPUT_INVALID/);
  }
});

test('create reconciliation rejects unsupported or malformed guarantee expectations', async () => {
  for (const bad of [{ code: 'GTDCC', display: 'Card' }, { code: 'GTDAGT', display: '' },
    { code: 'NGI', display: 'Guaranteed By Agent' }, { code: 'GTDAGT', display: 'Guaranteed By Agent', extra: true }]) {
    await assert.rejects(records.readCreatedLabtestRecord(savedPage(), expected,
      { ...recordOptions, expectedGuarantee: bad }), /LABTEST_RECORD_INPUT_INVALID/);
  }
});
