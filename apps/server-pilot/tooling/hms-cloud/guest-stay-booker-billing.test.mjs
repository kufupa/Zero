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
    context() { return { _options: { serviceWorkers: 'block' }, serviceWorkers: () => [] }; },
    on() {}, off() {}, async close() {}, async unroute() {},
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
function nativeFormPage(options = {}) {
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
    readOnly: false, disabled: false, isConnected: true,
    closest: () => null, contains: () => false, getAttribute: () => null, dispose: async () => {} }));
  const root = { contains: (element) => elements.includes(element), querySelectorAll: () => elements };
  for (const element of elements) element.parentElement = root;
  const form = { el: { dom: root }, getRecord: () => ({ data }) };
  const components = Object.fromEntries(elements.map((element) => [element.id.replace(/-inputEl$/, ''), {
    up: () => form, getValue: () => element.value, getRawValue: () => element.value,
    getSubmitData: () => ({ [element.name]: element.value }), isDisabled: () => false, getActiveErrors: () => [],
  }]));
  const document = { documentElement: { dataset: { propertyCode: 'HRCEN' } }, querySelectorAll(selector) {
    if (selector === '.x-window:not(.x-menu)') return [];
    const match = /\[name="([^"]+)"\]/.exec(selector);
    return match ? elements.filter((element) => element.name === match[1]) : [];
  } };
  const env = { document, location: { origin: 'https://hmsweb.hms.eu1.inforcloudsuite.com' },
    getComputedStyle: () => ({ visibility: 'visible' }), Ext: { getCmp: (id) => components[id] } };
  const routes = [], listeners = new Map(), actions = [];
  const browserContext = { _options: { serviceWorkers: 'block' }, serviceWorkers: () => [] };
  const page = { data, elements, components, routes, actions, browserContext, closed: false, evaluateCount: 0,
    context() { return browserContext; },
    on(event, handler) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(handler); },
    off(event, handler) { listeners.get(event)?.delete(handler); },
    emit(event) { for (const handler of listeners.get(event) || []) handler({}); },
    async close(optionsArg) { actions.push(['close', optionsArg]); page.closed = true; },
    async route(_pattern, route) { routes.push(route); },
    async unroute(_pattern, route) { const index = routes.indexOf(route); if (index !== -1) routes.splice(index, 1); },
    async request(method = 'POST') {
      const request = { method: () => method, url: () => 'https://example.invalid/fieldvalidate' };
      const dispatch = (index) => routes[index]?.({ request: () => request,
        abort: async () => { actions.push(['abort']); }, fallback: () => dispatch(index - 1) });
      await dispatch(routes.length - 1);
    },
    async evaluate(fn, arg) {
      page.evaluateCount += 1;
      if (page.evaluateCount === options.pauseEvaluateAt) {
        options.started.resolve();
        await options.release.promise;
        if (page.closed) throw new Error('PAGE_CLOSED');
      }
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
    async waitForFunction(fn, arg) {
      if (!await page.evaluate(fn, arg)) throw new Error('SYNTHETIC_WAIT_UNSATISFIED');
    },
    locator(selector) {
      const name = /\[name="([^"]+)"\]/.exec(selector)?.[1];
      const element = elements.find((item) => item.name === name);
      return { async elementHandle() { return element; },
        async count() { return element ? 1 : 0; }, async isEditable() { return Boolean(element); },
        async fill(value) {
          actions.push(['fill', name]);
          if (name === options.pauseFill) {
            options.started.resolve();
            await options.release.promise;
            if (page.closed) throw new Error('PAGE_CLOSED');
          }
          if (name === options.failFill) throw new Error('SYNTHETIC_FAILURE');
          element.value = value;
          if (name === options.unsafeAfterFill) browserContext.serviceWorkers = () => [{}];
          if (name === options.blockOnFill) await page.request();
        },
        async press() { actions.push(['press', name]); },
        async inputValue() { return element.value; },
      };
    },
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


function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const allFields = { propertyCode: 'HRCEN', serviceWorkersBlocked: true,
  bookerName: 'Synthetic Name', bookerContact: 'synthetic@example.invalid', billingReference: 'Synthetic Ref' };

test('all three fields use their actual callbacks and retain the lifetime fence', async () => {
  const page = nativeFormPage();
  const result = await stageGuestStayBookerBilling(page, allFields);
  assert.equal(result.outcome, 'updated_unsaved');
  assert.deepEqual(page.actions.filter(([action]) => action === 'fill').map(([, name]) => name),
    ['caller', 'udfchar06', 'billingreference']);
  for (const key of Object.keys(names)) assert.equal(result.fields[key].submit, allFields[key]);
  assert.equal(result.innerBlockedRequestCount, 0);
  assert.equal(result.blockedRequestCount, 0);
  assert.equal(page.routes.length, 1);
  await page.request();
  assert.equal(page.actions.at(-1)[0], 'abort');
});

test('inner fence reports its own abort and partial failure leaves later field untouched', async () => {
  const page = nativeFormPage({ blockOnFill: 'udfchar06' });
  const result = await stageGuestStayBookerBilling(page, allFields);
  assert.equal(result.outcome, 'action_uncertain');
  assert.equal(result.issue, 'UNEXPECTED_REQUEST_BLOCKED');
  assert.deepEqual(result.verifiedFields, ['bookerName']);
  assert.equal(result.attemptedField, 'bookerContact');
  assert.equal(result.innerBlockedRequestCount, 1);
  assert.equal(result.blockedRequestCount, 0);
  assert.equal(JSON.stringify(result).includes('synthetic@example.invalid'), false);
  assert.deepEqual(page.actions.filter(([action]) => action === 'fill').map(([, name]) => name), ['caller', 'udfchar06']);
  assert.equal(page.elements.find((element) => element.name === 'billingreference').value, '');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.routes.length, 1);
  await page.request();
  assert.equal(page.actions.at(-1)[0], 'abort');
  assert.equal((await stageGuestStayBookerBilling(page, allFields)).issue, 'PAGE_ACTION_UNCERTAIN');
});

test('dialog interrupts a deferred Booker setter without further actions', { timeout: 3000 }, async () => {
  const started = deferred(), release = deferred();
  const page = nativeFormPage({ pauseFill: 'caller', started, release });
  const operation = stageGuestStayBookerBilling(page, allFields);
  await started.promise;
  page.emit('dialog');
  const result = await operation;
  assert.equal(result.outcome, 'action_uncertain');
  assert.equal(result.issue, 'UNEXPECTED_DIALOG');
  assert.equal(result.pageCloseRequested, true);
  assert.deepEqual(page.actions.find(([action]) => action === 'close')[1], { runBeforeUnload: false });
  const callsAtStop = page.evaluateCount;
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.evaluateCount, callsAtStop);
  assert.deepEqual(page.actions.filter(([action]) => action === 'fill').map(([, name]) => name), ['caller']);
  assert.equal(page.actions.some(([action]) => action === 'press'), false);
  assert.equal(page.elements.find((element) => element.name === 'caller').value, '');
  assert.equal((await stageGuestStayBookerBilling(page, allFields)).issue, 'PAGE_ACTION_UNCERTAIN');
});

test('deadline interrupts deferred setter and modal-blocked draft readback', { timeout: 3000 }, async () => {
  for (const phase of ['setter', 'readback']) {
    const started = deferred(), release = deferred();
    const page = nativeFormPage(phase === 'setter'
      ? { pauseFill: 'caller', started, release } : { pauseEvaluateAt: 3, started, release });
    const input = phase === 'setter' ? allFields : { propertyCode: 'HRCEN', serviceWorkersBlocked: true, billingReference: 'ref' };
    const operation = stageGuestStayBookerBilling(page, input, { timeoutMs: 100 });
    await started.promise;
    const result = await operation;
    assert.equal(result.outcome, 'action_uncertain');
    assert.equal(result.issue, 'STAGING_TIMEOUT');
    assert.equal(result.pageCloseRequested, true);
    const callsAtStop = page.evaluateCount, actionsAtStop = page.actions.length;
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(page.evaluateCount, callsAtStop);
    assert.equal(page.actions.length, actionsAtStop);
    assert.equal((await stageGuestStayBookerBilling(page, input)).issue, 'PAGE_ACTION_UNCERTAIN');
  }
});

test('unsafe or unprovable service-worker context fails before any page action', async () => {
  for (const kind of ['allowed', 'unknown', 'active', 'throws']) {
    const page = nativeFormPage();
    if (kind === 'allowed') page.browserContext._options.serviceWorkers = 'allow';
    if (kind === 'unknown') delete page.browserContext._options;
    if (kind === 'active') page.browserContext.serviceWorkers = () => [{}];
    if (kind === 'throws') page.browserContext.serviceWorkers = () => { throw new Error('unavailable'); };
    const result = await stageGuestStayBookerBilling(page, allFields);
    assert.equal(result.outcome, 'execution_failure');
    assert.equal(result.issue, 'BROWSER_CONTEXT_UNSAFE');
    assert.equal(page.evaluateCount, 0);
    assert.equal(page.routes.length, 0);
    assert.equal(page.actions.filter(([action]) => action === 'fill').length, 0);
    assert.equal((await stageGuestStayBookerBilling(page, allFields)).issue, 'PAGE_ACTION_UNCERTAIN');
  }
});


test('native dialog interrupts deferred readback without starting another action', { timeout: 3000 }, async () => {
  const started = deferred(), release = deferred();
  const page = nativeFormPage({ pauseEvaluateAt: 3, started, release });
  const input = { propertyCode: 'HRCEN', serviceWorkersBlocked: true, billingReference: 'ref' };
  const operation = stageGuestStayBookerBilling(page, input);
  await started.promise;
  page.emit('dialog');
  const result = await operation;
  assert.equal(result.outcome, 'action_uncertain');
  assert.equal(result.issue, 'UNEXPECTED_DIALOG');
  const callsAtStop = page.evaluateCount, actionsAtStop = page.actions.length;
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.evaluateCount, callsAtStop);
  assert.equal(page.actions.length, actionsAtStop);
  assert.equal((await stageGuestStayBookerBilling(page, input)).issue, 'PAGE_ACTION_UNCERTAIN');
});

test('preflight deadline quarantines before a setter is attempted', { timeout: 3000 }, async () => {
  const started = deferred(), release = deferred();
  const page = nativeFormPage({ pauseEvaluateAt: 1, started, release });
  const operation = stageGuestStayBookerBilling(page, allFields, { timeoutMs: 100 });
  await started.promise;
  const result = await operation;
  assert.equal(result.outcome, 'execution_failure');
  assert.equal(result.issue, 'STAGING_TIMEOUT');
  assert.equal(result.pageCloseRequested, true);
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.evaluateCount, 1);
  assert.equal(page.actions.filter(([action]) => action === 'fill').length, 0);
  assert.equal((await stageGuestStayBookerBilling(page, allFields)).issue, 'PAGE_ACTION_UNCERTAIN');
});


test('service worker appearing during a setter prevents subsequent calls', async () => {
  const page = nativeFormPage({ unsafeAfterFill: 'caller' });
  const result = await stageGuestStayBookerBilling(page, allFields);
  assert.equal(result.outcome, 'action_uncertain');
  assert.equal(result.issue, 'BROWSER_CONTEXT_UNSAFE');
  assert.deepEqual(page.actions.filter(([action]) => action === 'fill').map(([, name]) => name), ['caller']);
  assert.equal(page.actions.some(([action]) => action === 'press'), false);
  assert.equal((await stageGuestStayBookerBilling(page, allFields)).issue, 'PAGE_ACTION_UNCERTAIN');
});

test('failed close cannot cancel an already-dispatched fill but gates all follow-up calls', { timeout: 3000 }, async () => {
  const started = deferred(), release = deferred();
  const page = nativeFormPage({ pauseFill: 'caller', started, release });
  page.close = async () => { throw new Error('CLOSE_FAILED'); };
  const operation = stageGuestStayBookerBilling(page, allFields);
  await started.promise;
  page.emit('dialog');
  const result = await operation;
  assert.equal(result.outcome, 'action_uncertain');
  assert.equal(result.pageCloseRequested, true);
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.elements.find((element) => element.name === 'caller').value, allFields.bookerName);
  assert.equal(page.actions.some(([action]) => action === 'press'), false);
  assert.deepEqual(page.actions.filter(([action]) => action === 'fill').map(([, name]) => name), ['caller']);
  assert.equal((await stageGuestStayBookerBilling(page, allFields)).issue, 'PAGE_ACTION_UNCERTAIN');
});
