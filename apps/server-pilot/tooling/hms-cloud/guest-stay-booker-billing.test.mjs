import assert from 'node:assert/strict';
import test from 'node:test';
import { allowsBookerBillingRequest, assessBookerBillingReadback, planBookerBilling,
  stageGuestStayBookerBilling } from './guest-stay-booker-billing.mjs';

const identity = { session: 'synthetic-session', guestId: '', accountId: '', profileId: '',
  arrival: '01-JAN-2027', departure: '03-JAN-2027' };
const names = { bookerName: 'caller', bookerContact: 'udfchar06', billingReference: 'billingreference' };
function snapshot() {
  return { identity: { ...identity }, controls: Object.fromEntries(Object.keys(names).map((key) => [key,
    { dom: '', native: '', submit: '', disabled: false, readOnly: false, maxLength: 50, invalid: false }])),
  scalar: { caller: '', udfchar06: '', billingreference: '', unrelated: 'original' }, omitted: ['sessionID'],
  visibleFields: Object.values(names).map((name) => ({ id: `id-${name}`, name, type: 'text', value: '', disabled: false, readOnly: false })) };
}
function apply(snapshotValue, field, value, { model = true, native = true, submit = true } = {}) {
  const control = snapshotValue.controls[field], name = names[field];
  control.dom = value;
  if (native) control.native = value;
  if (submit) control.submit = value;
  snapshotValue.visibleFields.find((item) => item.name === name).value = value;
  if (model) snapshotValue.scalar[name] = value;
}

// Synthetic page exercises orchestration without a browser or HMS.
function pageStub({ blocked = false, sideEffect = false } = {}) {
  const state = snapshot(), routes = [];
  const page = {
    state, routes,
    on() {}, off() {},
    async evaluate() { return structuredClone(state); },
    async route(_pattern, route) { routes.push(route); },
    async waitForTimeout() {},
    locator() { return {
      async count() { return 1; }, async isEditable() { return true; },
      async fill(value) {
        apply(state, 'billingReference', value);
        if (sideEffect) state.scalar.unrelated = 'unexpected';
        if (blocked) await routes[0]({ request: () => ({ method: () => 'POST', url: () => 'https://example.invalid/fieldvalidate' }), abort: async () => {}, fallback: async () => {} });
      },
      async press() {},
    }; },
  };
  return page;
}

test('input distinguishes omitted, explicit clear, undefined, and unknown fields', () => {
  assert.equal(planBookerBilling({ propertyCode: 'HRCEN', serviceWorkersBlocked: true }).issue, 'STAGING_VALUE_REQUIRED');
  assert.deepEqual(planBookerBilling({ propertyCode: 'HRCEN', serviceWorkersBlocked: true, bookerContact: '' }).changes,
    { bookerContact: { nativeName: 'udfchar06', value: '' } });
  assert.equal(planBookerBilling({ propertyCode: 'HRCEN', serviceWorkersBlocked: true, bookerName: undefined }).issue, 'STAGING_VALUE_INVALID');
  assert.equal(planBookerBilling({ propertyCode: 'HRCEN', serviceWorkersBlocked: true, bookerName: null }).issue, 'STAGING_VALUE_INVALID');
  assert.equal(planBookerBilling({ propertyCode: 'HRCEN', serviceWorkersBlocked: true, bookerContact: 'a\nb' }).issue, 'STAGING_VALUE_INVALID');
  assert.equal(planBookerBilling({ propertyCode: 'HRCEN', serviceWorkersBlocked: true, bookerContact: 'a\0b' }).issue, 'STAGING_VALUE_INVALID');
  assert.equal(planBookerBilling({ propertyCode: 'HRCEN', serviceWorkersBlocked: true, bookerContact: 'a\x7fb' }).issue, 'STAGING_VALUE_INVALID');
  assert.equal(planBookerBilling({ propertyCode: 'HRCEN', serviceWorkersBlocked: true, typo: 'x' }).issue, 'STAGING_INPUT_INVALID');
  assert.equal(planBookerBilling({ propertyCode: 'OTHER', bookerName: 'x' }).issue, 'PROPERTY_UNSUPPORTED');
  assert.equal(planBookerBilling({ propertyCode: 'HRCEN', billingReference: 'x' }).issue, 'SERVICE_WORKER_BLOCK_REQUIRED');
  assert.equal(planBookerBilling({ propertyCode: 'HRCEN', serviceWorkersBlocked: true, billingReference: '  ref  ' }).changes.billingReference.value, '  ref  ');
});

test('visible, component and submit values must all match, with no unrelated effects', () => {
  const before = snapshot(), after = structuredClone(before);
  const plan = planBookerBilling({ propertyCode: 'HRCEN', serviceWorkersBlocked: true, billingReference: 'PO 123' });
  apply(after, 'billingReference', 'PO 123');
  assert.equal(assessBookerBillingReadback(before, after, plan).ok, true);
  after.controls.billingReference.submit = '';
  assert.equal(assessBookerBillingReadback(before, after, plan).issue, 'NATIVE_READBACK_MISMATCH');
  after.controls.billingReference.submit = 'PO 123';
  after.controls.billingReference.invalid = true;
  assert.equal(assessBookerBillingReadback(before, after, plan).issue, 'NATIVE_READBACK_MISMATCH');
  after.controls.billingReference.invalid = false;
  after.scalar.unrelated = 'changed';
  const sideEffect = assessBookerBillingReadback(before, after, plan);
  assert.equal(sideEffect.issue, 'UNEXPECTED_FORM_CHANGE');
  assert.deepEqual(sideEffect.changes.model.find((field) => !field.requested), { name: 'unrelated', requested: false });
  assert.equal(JSON.stringify(sideEffect).includes('changed'), false);
});

test('identity, model coverage, other Booker fields and partial native readback cannot drift silently', () => {
  const before = snapshot(), after = structuredClone(before);
  const plan = planBookerBilling({ propertyCode: 'HRCEN', serviceWorkersBlocked: true, bookerName: 'Synthetic' });
  apply(after, 'bookerName', 'Synthetic', { model: false });
  assert.equal(assessBookerBillingReadback(before, after, plan).ok, true);
  after.identity.session = 'other';
  assert.equal(assessBookerBillingReadback(before, after, plan).issue, 'DRAFT_IDENTITY_CHANGED');
  after.identity.session = before.identity.session;
  after.omitted.push('newComplexModelValue');
  assert.equal(assessBookerBillingReadback(before, after, plan).issue, 'MODEL_COVERAGE_CHANGED');
  after.omitted.pop();
  apply(after, 'bookerContact', 'unexpected');
  assert.equal(assessBookerBillingReadback(before, after, plan).issue, 'UNSPECIFIED_CONTROL_CHANGED');
  apply(after, 'bookerContact', '');
  after.controls.bookerName.native = '';
  assert.equal(assessBookerBillingReadback(before, after, plan).issue, 'NATIVE_READBACK_MISMATCH');
});

test('lifetime fence permits safe reads but blocks mutations, save queries and malformed URLs', () => {
  assert.equal(allowsBookerBillingRequest({ method: 'GET', url: 'https://example.invalid/web/base/ordinary' }), true);
  assert.equal(allowsBookerBillingRequest({ method: 'POST', url: 'https://example.invalid/web/base/ordinary' }), false);
  assert.equal(allowsBookerBillingRequest({ method: 'GET', url: 'https://example.invalid/web/base/OSRESV.HDR?pageaction=SAVE' }), false);
  assert.equal(allowsBookerBillingRequest({ method: 'GET', url: 'https://example.invalid/send' }), false);
  assert.equal(allowsBookerBillingRequest({ method: 'GET', url: 'not-a-url' }), false);
});

test('billing staging preserves exact text, verifies submit and keeps page fenced', async () => {
  const page = pageStub();
  const result = await stageGuestStayBookerBilling(page, { propertyCode: 'HRCEN', serviceWorkersBlocked: true, billingReference: '  PO 123  ' });
  assert.equal(result.outcome, 'updated_unsaved');
  assert.equal(result.fields.billingReference.submit, '  PO 123  ');
  assert.equal(result.pagePostFence, 'until_page_close');
  assert.equal(result.persistence, 'not_attempted');
  assert.equal(page.routes.length, 1);
  let aborted = false;
  await page.routes[0]({ request: () => ({ method: () => 'POST', url: () => 'https://example.invalid/other' }),
    abort: async () => { aborted = true; }, fallback: async () => {} });
  assert.equal(aborted, true);
  assert.equal((await stageGuestStayBookerBilling(page, { propertyCode: 'HRCEN', serviceWorkersBlocked: true, billingReference: 'new' })).issue, 'PAGE_ACTION_UNCERTAIN');
});

test('oversize or unsupported controls fail before staging, and clear is explicit', async () => {
  const page = pageStub();
  page.state.controls.billingReference.maxLength = 2;
  assert.equal((await stageGuestStayBookerBilling(page, { propertyCode: 'HRCEN', serviceWorkersBlocked: true, billingReference: 'long' })).issue, 'FIELD_VALUE_TOO_LONG');
  assert.equal(page.routes.length, 0);
  page.state.controls.billingReference.issue = 'NATIVE_CONTROL_UNVERIFIED';
  assert.equal((await stageGuestStayBookerBilling(page, { propertyCode: 'HRCEN', serviceWorkersBlocked: true, billingReference: '' })).outcome, 'unsupported');
  delete page.state.controls.billingReference.issue;
  apply(page.state, 'billingReference', 'x');
  const cleared = await stageGuestStayBookerBilling(page, { propertyCode: 'HRCEN', serviceWorkersBlocked: true, billingReference: '' });
  assert.equal(cleared.outcome, 'updated_unsaved');
  assert.equal(cleared.fields.billingReference.submit, '');
});

test('unexpected request or side effect quarantines the page without retry', async () => {
  for (const options of [{ blocked: true }, { sideEffect: true }]) {
    const page = pageStub(options);
    const result = await stageGuestStayBookerBilling(page, { propertyCode: 'HRCEN', serviceWorkersBlocked: true, billingReference: 'PO 123' });
    assert.equal(result.outcome, 'action_uncertain');
    assert.equal(result.issue, options.blocked ? 'UNEXPECTED_REQUEST_BLOCKED' : 'UNEXPECTED_FORM_CHANGE');
    assert.equal((await stageGuestStayBookerBilling(page, { propertyCode: 'HRCEN', serviceWorkersBlocked: true, billingReference: 'PO 123' })).issue, 'PAGE_ACTION_UNCERTAIN');
  }
});

test('fake-draft date and native preimage mismatch fail before changing fields', async () => {
  const page = pageStub();
  page.state.identity.arrival = '01-JAN-2026';
  assert.equal((await stageGuestStayBookerBilling(page, { propertyCode: 'HRCEN', serviceWorkersBlocked: true, billingReference: 'ref' })).issue, 'LABTEST_DATES_UNVERIFIED');
  page.state.identity.arrival = '01-JAN-2027';
  page.state.controls.billingReference.native = 'different';
  assert.equal((await stageGuestStayBookerBilling(page, { propertyCode: 'HRCEN', serviceWorkersBlocked: true, billingReference: 'ref' })).issue, 'FIELD_PREIMAGE_UNVERIFIED');
  assert.equal(page.routes.length, 0);
});

// Exercise the actual browser-side draft inspection with a synthetic Ext form.
function nativeFormPage() {
  const blankIds = ['reservationshareid', 'reservationstayid', 'guaranteecardprofileid',
    'guestnameinfoid', 'externalprofileid', 'guestfoliocomptempresstayid', 'gueststaycouponids',
    'additionalprofileids', 'reservationid', 'addlplayerprofileid', 'sourceprofileid', 'recordid'];
  const data = { propertycode: 'HRCEN', PKID: '@[EMPTY]#@[EMPTY]#HRCEN#', status: 'New',
    confirmationnumber: '', bookingsessionid: 'synthetic-session', guestid: '', arprofileid: '',
    firstname: 'Proof', lastname: 'Labtest', ...Object.fromEntries(blankIds.map((key) => [key, ''])) };
  const initial = { confirmationnumber: '', ta1: '', guestid: '', firstname: 'Proof', lastname: 'Labtest',
    arrivaldate: '01-JAN-2027', departuredate: '03-JAN-2027', caller: '', udfchar06: '', billingreference: '' };
  const elements = Object.entries(initial).map(([name, value]) => ({ id: `${name}-inputEl`, name, value,
    type: 'text', tagName: 'INPUT', offsetWidth: 1, offsetHeight: 1, maxLength: 50,
    readOnly: false, disabled: false, closest: () => null, getAttribute: () => null }));
  const root = { contains: (element) => elements.includes(element), querySelectorAll: () => elements };
  const form = { el: { dom: root }, getRecord: () => ({ data }) };
  const components = Object.fromEntries(elements.map((element) => [element.id.replace(/-inputEl$/, ''), {
    up: () => form, getValue: () => element.value, getRawValue: () => element.value,
    getSubmitData: () => ({ [element.name]: element.value }), isDisabled: () => false, getActiveErrors: () => [],
  }]));
  const document = { querySelectorAll(selector) {
    if (selector === '.x-window:not(.x-menu)') return [];
    const match = /\[name="([^"]+)"\]/.exec(selector);
    return match ? elements.filter((element) => element.name === match[1]) : [];
  } };
  const env = { document, location: { origin: 'https://hmsweb.hms.eu1.inforcloudsuite.com' },
    getComputedStyle: () => ({ visibility: 'visible' }), Ext: { getCmp: (id) => components[id] } };
  const routes = [];
  const page = { data, elements, components, routes, on() {}, off() {},
    async route(_pattern, route) { routes.push(route); },
    async evaluate(fn, arg) {
      const previous = Object.fromEntries(Object.keys(env).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
      try {
        for (const [key, value] of Object.entries(env)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        return await fn(arg);
      } finally {
        for (const key of Object.keys(env)) {
          if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
          else delete globalThis[key];
        }
      }
    },
    locator() { return { async count() { return 1; }, async isEditable() { return true; },
      async fill(value) { elements.find((element) => element.name === 'billingreference').value = value; },
      async press() {} }; },
    async waitForTimeout() {},
  };
  return page;
}

test('synthetic Ext draft guard binds origin, property, Labtest, blank IDs and form controls', async () => {
  const input = { propertyCode: 'HRCEN', serviceWorkersBlocked: true, billingReference: 'synthetic-ref' };
  const success = nativeFormPage();
  const result = await stageGuestStayBookerBilling(success, input);
  assert.equal(result.outcome, 'updated_unsaved');
  assert.equal(result.fields.billingReference.model, 'not_exposed_as_scalar');
  assert.equal(result.fields.billingReference.native, 'synthetic-ref');

  const wrongProperty = nativeFormPage();
  wrongProperty.data.propertycode = 'OTHER';
  assert.equal((await stageGuestStayBookerBilling(wrongProperty, input)).issue, 'DRAFT_ID_UNVERIFIED');
  assert.equal(wrongProperty.routes.length, 0);

  const realName = nativeFormPage();
  realName.elements.find((element) => element.name === 'lastname').value = 'NotLabtest';
  assert.equal((await stageGuestStayBookerBilling(realName, input)).issue, 'LABTEST_DRAFT_UNVERIFIED');
  assert.equal(realName.routes.length, 0);

  const linkedStay = nativeFormPage();
  linkedStay.data.reservationstayid = 'nonblank';
  assert.equal((await stageGuestStayBookerBilling(linkedStay, input)).issue, 'DRAFT_ID_UNVERIFIED');
  assert.equal(linkedStay.routes.length, 0);

  const unknownProfile = nativeFormPage();
  unknownProfile.data.guestid = '12345';
  unknownProfile.elements.find((element) => element.name === 'guestid').value = '12345';
  assert.equal((await stageGuestStayBookerBilling(unknownProfile, input)).issue, 'GUEST_PROFILE_UNVERIFIED');
  assert.equal(unknownProfile.routes.length, 0);

  const arWithoutProof = nativeFormPage();
  arWithoutProof.data.arprofileid = 'synthetic-profile';
  arWithoutProof.data.araccountid = 'synthetic-account';
  assert.equal((await stageGuestStayBookerBilling(arWithoutProof, input)).issue, 'AR_SELECTION_UNVERIFIED');
  assert.equal(arWithoutProof.routes.length, 0);

  const noSubmit = nativeFormPage();
  noSubmit.components.billingreference.getSubmitData = () => ({});
  assert.equal((await stageGuestStayBookerBilling(noSubmit, input)).issue, 'FIELD_PREIMAGE_UNVERIFIED');
  assert.equal(noSubmit.routes.length, 0);

  const duplicate = nativeFormPage();
  duplicate.elements.push({ ...duplicate.elements.find((element) => element.name === 'billingreference'), id: 'duplicate-inputEl' });
  const duplicateResult = await stageGuestStayBookerBilling(duplicate, input);
  assert.equal(duplicateResult.outcome, 'unsupported');
  assert.equal(duplicateResult.issue, 'FIELD_NOT_UNIQUE');
  assert.equal(duplicate.routes.length, 0);
});
