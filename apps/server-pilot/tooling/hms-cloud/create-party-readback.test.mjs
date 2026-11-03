import test from 'node:test';
import assert from 'node:assert/strict';
import { readCreateParties, compareCreatePartyRecord } from './create-party-readback.mjs';

test('rejects incomplete or mismatched identity inputs before opening HMS', async () => {
  const valid = { confirmation: '123456-1', arrival: '2028-09-19', guestId: '123' };
  for (const change of [{ confirmation: 'not-a-confirmation' }, { arrival: '2026-09-19' }, { guestId: '' },
    { arAccount: { nativeId: '75', name: 'Example' } },
    { agency: { nativeId: '', name: 'Example' } }, { organization: { nativeId: '41', name: '' } }]) {
    const result = await readCreateParties({ ...valid, ...change });
    assert.equal(result.outcome, 'unverified');
    assert.equal(result.issue, 'PARTY_READBACK_INPUT_INVALID');
  }
});

test('fresh party session blocks service workers and installs the read guard before opening a page', async () => {
  const requests = [];
  const context = { route: async (_pattern, handler) => { context.handler = handler; } };
  const result = await readCreateParties({ confirmation: '123456-1', arrival: '2028-09-19', guestId: '123' }, {
    openSession: async (_operation, options) => {
      assert.equal(options.blockServiceWorkers, true);
      await options.prepareContext(context);
      for (const [method, url] of [
        ['POST', 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR?pageaction=SAVE'],
        ['POST', 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR.GetCheckAvailability'],
        ['GET', 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/logindisp'],
      ]) {
        await context.handler({ request: () => ({ method: () => method, url: () => url, postData: () => null }),
          abort: async () => requests.push('blocked'), fallback: async () => requests.push('allowed') });
      }
      return { outcome: 'verified' };
    },
  });
  assert.deepEqual(requests, ['blocked', 'blocked', 'allowed']);
  assert.deepEqual(result, { outcome: 'verified' });
});


test('fresh native and visible party evidence must all match the fake stay', () => {
  const expected = { confirmation: '123456-1', guestId: '123', agency: { nativeId: '99', name: 'Agency' },
    organization: { nativeId: '41', name: 'Organization' }, arAccount: { nativeId: '75', name: 'Account', profileId: '501' } };
  const model = { propertycode: 'HRCEN', confirmationnumber: '123456-1', status: 'Reserved', guestid: '123',
    firstname: 'Proof', lastname: 'Labtest', taid1: '99', ta1: 'Agency', companyid: '41', company: 'Organization',
    araccountid: '75', araccountname: 'Account', arprofileid: '501' };
  const visible = { ta1: 'Agency', company: 'Organization', araccountname: 'Account' };
  assert.equal(compareCreatePartyRecord({ model, visible }, expected).outcome, 'verified');
  for (const [field, wrong] of [['taid1', '98'], ['companyid', null], ['arprofileid', 'other'], ['guestid', '999'], ['status', 'Cancelled']]) {
    const result = compareCreatePartyRecord({ model: { ...model, [field]: wrong }, visible }, expected);
    assert.equal(result.outcome, 'unverified');
    assert.ok(result.fields.includes(field));
  }
  assert.ok(compareCreatePartyRecord({ model, visible: { ...visible, araccountname: null } }, expected).fields.includes('araccountname_visible'));
  assert.equal(compareCreatePartyRecord(null, expected).issue, 'PARTY_RECORD_UNVERIFIED');
});

// Exercise the same frame-side DOM/model extraction used for fresh readback.
test('saved-frame extraction verifies native IDs and rejects missing or duplicate controls', async () => {
  const { extractCreatePartySnapshot } = await import('./create-party-readback.mjs');
  const expected = { confirmation: '123456-1', guestId: '123', agency: { nativeId: '99', name: 'Agency' },
    organization: { nativeId: '41', name: 'Organization' }, arAccount: { nativeId: '75', name: 'Account', profileId: '501' } };
  const model = { propertycode: 'HRCEN', confirmationnumber: '123456-1', status: 'Reserved', guestid: '123',
    firstname: 'Proof', lastname: 'Labtest', taid1: '99', ta1: 'Agency', companyid: '41', company: 'Organization',
    araccountid: '75', araccountname: 'Account', arprofileid: '501' };
  const fields = ['guestid', 'ta1', 'company', 'araccountname'].map((name) => ({ name, id: `${name}-inputEl`,
    value: model[name], offsetWidth: 1, offsetHeight: 1, closest: () => null }));
  const form = { el: { dom: { contains: (field) => fields.includes(field) } }, getRecord: () => ({ data: model }) };
  const env = { document: { querySelectorAll: () => fields }, getComputedStyle: () => ({ visibility: 'visible' }),
    Ext: { getCmp: () => ({ up: () => form }) } };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(env)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const snapshot = () => extractCreatePartySnapshot();
    assert.equal(compareCreatePartyRecord(snapshot(), expected).outcome, 'verified');
    fields.push({ ...fields.find((field) => field.name === 'araccountname') });
    assert.ok(compareCreatePartyRecord(snapshot(), expected).fields.includes('araccountname_visible'));
    fields.pop();
    delete model.arprofileid;
    assert.ok(compareCreatePartyRecord(snapshot(), expected).fields.includes('arprofileid'));
    model.arprofileid = '501';
    fields.push({ ...fields[0] });
    assert.equal(compareCreatePartyRecord(snapshot(), expected).issue, 'PARTY_RECORD_UNVERIFIED');
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete globalThis[key];
    }
  }
});

test('billing readback requires exact visible and native values, including whitespace', () => {
  const expected = { confirmation: '123456-1', guestId: '123', arAccount: { nativeId: '75', name: 'Account', profileId: '501' }, billingReference: ' PO 123 ' };
  const model = { propertycode: 'HRCEN', confirmationnumber: '123456-1', status: 'Reserved', guestid: '123',
    firstname: 'Proof', lastname: 'Labtest', taid1: '', ta1: '', companyid: '', company: '',
    araccountid: '75', araccountname: 'Account', arprofileid: '501', billingreference: ' PO 123 ' };
  const visible = { ta1: '', company: '', araccountname: 'Account', billingreference: ' PO 123 ' };
  const proof = compareCreatePartyRecord({ model, visible }, expected);
  assert.equal(proof.outcome, 'verified');
  assert.ok(proof.verified.includes('billingReference'));
  assert.equal(compareCreatePartyRecord({ model, visible: { ...visible, billingreference: 'PO 123' } }, expected).outcome, 'unverified');
  assert.equal(compareCreatePartyRecord({ model: { ...model, billingreference: null }, visible }, expected).outcome, 'unverified');
});


test('saved-frame extraction preserves exact billing text and rejects duplicate model and visible fields', async () => {
  const { extractCreatePartySnapshot } = await import('./create-party-readback.mjs');
  const model = { guestid: '123', billingreference: ' PO 123 ' };
  const fields = ['guestid', 'billingreference'].map((name) => ({ name, id: `${name}-inputEl`, value: model[name],
    offsetWidth: 1, offsetHeight: 1, closest: () => null }));
  const form = { el: { dom: { contains: (field) => fields.includes(field) } }, getRecord: () => ({ data: model }) };
  const env = { document: { querySelectorAll: () => fields }, getComputedStyle: () => ({ visibility: 'visible' }),
    Ext: { getCmp: () => ({ up: () => form }) } };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(env)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    let snapshot = extractCreatePartySnapshot();
    assert.equal(snapshot.model.billingreference, ' PO 123 ');
    assert.equal(snapshot.visible.billingreference, ' PO 123 ');
    fields.push({ ...fields[1] });
    snapshot = extractCreatePartySnapshot(); assert.equal(snapshot.visible.billingreference, null);
    fields.pop(); model.BillingReference = 'other';
    snapshot = extractCreatePartySnapshot(); assert.equal(snapshot.model.billingreference, null);
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]); else delete globalThis[key];
    }
  }
});
