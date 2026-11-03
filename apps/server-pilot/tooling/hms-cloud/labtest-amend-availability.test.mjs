import test from 'node:test';
import assert from 'node:assert/strict';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { matchesLabtestAvailability, runLabtestAmendSave } from './labtest-amend-save.mjs';

const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const checkPath = '/web/base/OSRESV.HDR.getcheckavailability';
const savePath = '/web/base/OSRESV.HDR?pageaction=SAVE';
const frame = { locator: () => ({ count: async () => 0 }) };
const snapshot = () => ({ data: {
  propertycode: 'HRCEN', firstname: 'Proof', lastname: 'Labtest', status: 'Reserved',
  confirmationnumber: '12345678-1', guestid: '12345', arrivaldate: '05/02/2027', departuredate: '05/04/2027',
  guaranteetype: 'NGI', udfchkbox04: '0', udfchar13: '', emailaddress: '', adults: '2',
  sessionID: { sessionID: 'ephemeral' }, extId: '', unrelated: 'unchanged',
} });
const encode = (data) => new URLSearchParams({ ...data, sessionID: data.sessionID.sessionID,
  ONLY_DATA_REQUIRED: 'true' }).toString();
const checkRequest = (options = {}) => {
  const data = options.data ?? snapshot().data;
  return { url: () => options.url ?? `${origin}${checkPath}`, method: () => options.method ?? 'POST',
    frame: () => options.frame ?? frame, headers: () => ({ 'content-type': options.contentType ?? 'application/x-www-form-urlencoded; charset=UTF-8' }),
    postData: () => options.body ?? encode(data) };
};

test('reprice request matches the full staged model and rejects alterations or identity drift', () => {
  const state = snapshot(), correct = checkRequest();
  assert.equal(matchesLabtestAvailability(correct, frame, state), true);
  const body = new URLSearchParams(encode(state.data));
  const variants = [
    checkRequest({ url: `https://attacker.invalid${checkPath}` }),
    checkRequest({ url: `${origin}${checkPath}?pageaction=SAVE` }),
    checkRequest({ method: 'GET' }), checkRequest({ frame: {} }), checkRequest({ contentType: 'application/json' }),
    checkRequest({ body: `${body}&adults=3` }), checkRequest({ body: `${body}&Adults=2` }),
    checkRequest({ body: `${body}&unknown=value` }),
    checkRequest({ body: encode({ ...state.data, adults: '3' }) }),
  ];
  for (const request of variants) assert.equal(matchesLabtestAvailability(request, frame, state), false);
  for (const [key, value] of [
    ['firstname', 'Real'], ['lastname', 'Guest'], ['propertycode', 'HRDAV'], ['guaranteetype', 'GTDAGT'],
    ['udfchkbox04', '1'], ['emailaddress', 'guest@example.invalid'], ['arrivaldate', '05/02/2026'],
    ['departuredate', '05/01/2027'],
  ]) {
    const changed = { data: { ...state.data, [key]: value } };
    assert.equal(matchesLabtestAvailability(checkRequest({ data: changed.data }), frame, changed), false, key);
  }
});

test('a reviewed unsent recipient must match the staged native request exactly', () => {
  const state = snapshot();
  state.data.udfchar13 = 'desk@example.invalid';
  const request = checkRequest({ data: state.data });
  assert.equal(matchesLabtestAvailability(request, frame, state), false);
  assert.equal(matchesLabtestAvailability(request, frame, state, { recipient:'desk@example.invalid' }), true);
  assert.equal(matchesLabtestAvailability(request, frame, state, { recipient:'other@example.invalid' }), false);
  assert.equal(matchesLabtestAvailability(request, frame, state, { recipient:'desk@example.invalid\n' }), false);
  const send = { data:{ ...state.data, udfchkbox04:'1' } };
  assert.equal(matchesLabtestAvailability(checkRequest({ data:send.data }), frame, send,
    { recipient:'desk@example.invalid' }), false);
});

function mockPage({ jsonFor = () => ({}) } = {}) {
  const pages = [], contexts = [], events = [], waiters = [];
  const emit = (request, status) => {
    const response = { request: () => request, status: () => status, json: async () => jsonFor(request, status) };
    for (const waiter of waiters.splice(0)) waiter.resolve(response && waiter.matches(response) ? response : null);
  };
  const context = { route: async (_p, handler) => contexts.push(handler), unroute: async () => {} };
  const page = { context: () => context, route: async (_p, handler) => pages.push(handler),
    unroute: async () => {}, on: () => {}, off: () => {}, locator: () => ({}),
    waitForTimeout: async () => {}, waitForResponse: (matches) => new Promise((resolve) => waiters.push({ matches, resolve })) };
  const visit = async (request) => {
    const contextRoute = async (i) => {
      if (i < 0) throw new Error('unfenced');
      return contexts[i]({ request: () => request, fallback: () => contextRoute(i - 1),
        abort: async () => { events.push('abort'); emit(request, 0); },
        continue: async () => { events.push('continue'); emit(request, 200); } });
    };
    const pageRoute = async (i) => {
      if (i < 0) return contextRoute(contexts.length - 1);
      return pages[i]({ request: () => request, fallback: () => pageRoute(i - 1),
        abort: async () => { events.push('abort'); emit(request, 0); } });
    };
    return pageRoute(pages.length - 1);
  };
  return { page, context, visit, events };
}

async function scenario({ check = checkRequest(), checkTwice = false, validateAvailability = true, authorize = true,
  state = snapshot(), recipient = undefined } = {}) {
  const fake = mockPage(), sequence = [], save = { click: async () => {
    sequence.push('save-click');
    await fake.visit({ url: () => `${origin}${savePath}`, method: () => 'POST', frame: () => frame });
  } };
  await installReadOnlyGuard(fake.context);
  const result = await runLabtestAmendSave(fake.page, {
    timeoutMs: 1000, prepare: async () => ({ frame, save }), stage: async () => ({}),
    validate: async () => true, matches: (request) => request.url() === `${origin}${savePath}`,
    dispatchCandidate: async (_request, proceed) => { sequence.push('save-authority'); await proceed(); },
    availability: {
      recipient,
      snapshot: async () => state,
      click: async () => { sequence.push('availability-click'); await fake.visit(check); if (checkTwice) await fake.visit(checkRequest()); },
      dispatchCandidate: async (_request, proceed) => { sequence.push('availability-authority'); if (authorize) await proceed(); },
      validate: async () => { sequence.push('availability-verified'); return validateAvailability; },
    },
  });
  return { ...fake, sequence, result };
}

test('one approved rate hold precedes the separately approved Save', async () => {
  const { result, sequence, events } = await scenario();
  assert.equal(result.outcome, 'awaiting_readback', JSON.stringify({ result, sequence, events }));
  assert.deepEqual(sequence, ['availability-click', 'availability-authority', 'availability-verified', 'save-click', 'save-authority']);
  assert.deepEqual(events, ['continue', 'continue']);
});

test('availability carries the exact reviewed unsent recipient through the fence', async () => {
  const state = snapshot();
  state.data.udfchar13 = 'desk@example.invalid';
  const check = checkRequest({ data: state.data });
  const approved = await scenario({ state, check, recipient: 'desk@example.invalid' });
  assert.equal(approved.result.outcome, 'awaiting_readback');
  const changed = await scenario({ state, check, recipient: 'other@example.invalid' });
  assert.equal(changed.result.outcome, 'not_dispatched');
  assert.deepEqual(changed.events, ['abort']);
});

test('wrong payload cannot hold a rate or reach Save', async () => {
  const { result, sequence, events } = await scenario({ check: checkRequest({ body: 'ONLY_DATA_REQUIRED=true' }) });
  assert.equal(result.outcome, 'not_dispatched');
  assert.deepEqual(sequence, ['availability-click']);
  assert.deepEqual(events, ['abort']);
});

for (const options of [{ checkTwice: true }, { validateAvailability: false }, { authorize: false }]) {
  test(`uncertain or rejected rate hold never reaches Save: ${Object.keys(options)[0]}`, async () => {
    const { result, sequence } = await scenario(options);
    assert.equal(result.outcome, 'uncertain');
    assert.equal(sequence.includes('save-click'), false);
  });
}

test('prepare-only cannot be configured with a mutating availability request', async () => {
  const fake = mockPage();
  const result = await runLabtestAmendSave(fake.page, { prepareOnly: true, prepare: async () => ({}), stage: async () => ({}),
    matches: () => true, validate: async () => true, dispatchCandidate: async () => {},
    availability: { snapshot: async () => snapshot(), click: async () => {}, validate: async () => true, dispatchCandidate: async () => {} } });
  assert.equal(result.issue, 'AMEND_AVAILABILITY_CALLBACKS_INVALID');
  assert.deepEqual(fake.events, []);
});

test('an undrained authorization remains uncertain and cannot continue after timeout', async () => {
  const fake = mockPage();
  await installReadOnlyGuard(fake.context);
  let release, entered = false;
  const delayed = new Promise((resolve) => { release = resolve; });
  const save = { click: async () => fake.visit({
    url: () => `${origin}${savePath}`, method: () => 'POST', frame: () => frame,
  }) };
  const result = await runLabtestAmendSave(fake.page, {
    timeoutMs: 300, reportDispatchDrain: true, dispatchDrainTimeoutMs: 5,
    prepare: async () => ({ frame, save }), stage: async () => ({}), validate: async () => true,
    matches: (request) => request.url() === `${origin}${savePath}`,
    dispatchCandidate: async (_request, proceed) => { entered = true; await delayed; await proceed(); },
  });
  assert.equal(entered, true);
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.issue, 'DISPATCH_CALLBACKS_UNDRAINED');
  assert.equal(result.dispatchCallbacksDrained, false);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.events, ['abort']);
});

test('an undrained availability claim cannot start a rate hold after timeout', async () => {
  const fake = mockPage();
  await installReadOnlyGuard(fake.context);
  let release, saveClicked = false;
  const delayed = new Promise((resolve) => { release = resolve; });
  const result = await runLabtestAmendSave(fake.page, {
    timeoutMs: 25, reportDispatchDrain: true, dispatchDrainTimeoutMs: 5,
    prepare: async () => ({ frame, save: { click: async () => { saveClicked = true; } } }),
    stage: async () => ({}), validate: async () => true, matches: () => true,
    dispatchCandidate: async (_request, proceed) => { await proceed(); },
    availability: { snapshot: async () => snapshot(), click: async () => fake.visit(checkRequest()),
      validate: async () => true, dispatchCandidate: async (_request, proceed) => { await delayed; await proceed(); } },
  });
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.issue, 'DISPATCH_CALLBACKS_UNDRAINED');
  assert.equal(result.dispatchCallbacksDrained, false);
  assert.equal(saveClicked, false);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.events, ['abort']);
});

test('worker abort disarms an in-flight availability claim before it can continue', async () => {
  const fake = mockPage();
  await installReadOnlyGuard(fake.context);
  const controller = new AbortController();
  let release, started, saveClicked = false;
  const delayed = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const run = runLabtestAmendSave(fake.page, {
    signal: controller.signal, timeoutMs: 5_000, reportDispatchDrain: true, dispatchDrainTimeoutMs: 5,
    prepare: async () => ({ frame, save: { click: async () => { saveClicked = true; } } }),
    stage: async () => ({}), validate: async () => true, matches: () => true,
    dispatchCandidate: async (_request, proceed) => { await proceed(); },
    availability: { snapshot: async () => snapshot(), click: async () => fake.visit(checkRequest()),
      validate: async () => true, dispatchCandidate: async (_request, proceed) => {
        started(); await delayed; await proceed();
      } },
  });
  await entered;
  controller.abort();
  const result = await run;
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.issue, 'DISPATCH_CALLBACKS_UNDRAINED');
  assert.equal(result.dispatchCallbacksDrained, false);
  assert.equal(saveClicked, false);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.events, ['abort']);
});

test('an already-aborted worker cannot begin preparing an amend', async () => {
  let prepared = false;
  const result = await runLabtestAmendSave(mockPage().page, { signal: AbortSignal.abort(),
    prepare: async () => { prepared = true; } });
  assert.deepEqual(result, { outcome: 'not_dispatched', issue: 'AMEND_ABORTED' });
  assert.equal(prepared, false);
});

test('an undrained retain-rate claim cannot continue its Save after timeout', async () => {
  const question = { pageData: { success: false, messages: [{ type: 'question', questiontype: 'YesNoCancel',
    handler: 'confirmRetainRates', msg: 'Retain the current rates?' }] } };
  const fake = mockPage({ jsonFor: () => question });
  await installReadOnlyGuard(fake.context);
  let release, evaluates = 0;
  const delayed = new Promise((resolve) => { release = resolve; });
  const amendFrame = {
    evaluate: async () => { evaluates += 1; return evaluates === 2 ? 'allowed' : true; },
    locator: (selector) => locator(selector),
    getByText: () => locator('question'),
  };
  const request = () => ({ url: () => `${origin}${savePath}`, method: () => 'POST', frame: () => amendFrame });
  const locator = (selector, filtered = false) => ({
    first() { return this; }, nth() { return this; }, waitFor: async () => {},
    count: async () => selector === 'a.x-btn:visible' && !filtered ? 3 : 1,
    isVisible: async () => true,
    getByText: () => locator('question'),
    locator: (child) => locator(child), filter: () => locator(selector, true),
    innerText: async () => selector === '.x-form-display-field:visible'
      ? 'Retain the current rates?' : 'Retain the current rates? Yes No Cancel',
    click: async () => fake.visit(request()),
  });
  const result = await runLabtestAmendSave(fake.page, {
    timeoutMs: 40, reportDispatchDrain: true, dispatchDrainTimeoutMs: 5,
    prepare: async () => ({ frame: amendFrame, save: { click: async () => fake.visit(request()) } }),
    stage: async () => ({}), validate: async () => true, matches: () => true,
    dispatchCandidate: async (_request, proceed) => { await proceed(); },
    retainRate: { choice: 'yes', snapshot: async () => ({}), matches: () => true,
      dispatchCandidate: async (_request, proceed) => { await delayed; await proceed(); } },
  });
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.issue, 'DISPATCH_CALLBACKS_UNDRAINED');
  assert.equal(result.dispatchCallbacksDrained, false);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.events, ['continue', 'abort']);
});
