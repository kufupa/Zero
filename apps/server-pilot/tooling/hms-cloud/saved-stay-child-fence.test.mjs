import test from 'node:test';
import assert from 'node:assert/strict';
import { installReadOnlyGuard } from './hms-read-only-guard.mjs';
import { createSavedChildStageRequestGate } from './saved-stay-child-request-gate.mjs';
import { runLabtestAmendSave } from './labtest-amend-save.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';
import { installLabtestSaveRouteChain } from './saved-stay-save-route-chain.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const READ = '/web/base/OSRESV.HDR.getChildAges';
const VALIDATE = '/web/base/OSRESV.HDR.validateChildAgeDetails';
const frame = {};
const target = () => ({ propertyCode: 'HRCEN', frame, stayId: '5', adults: 2, priorAges: [8, 12],
  priorBands: { child1: 0, child2: 2, child3: 0 }, nextAges: [8, 12, 5], deadlineAt: performance.now() + 10000 });
const makeRequest = (path, params, requestFrame = frame) => ({
  url: () => `${ORIGIN}${path}`, method: () => 'POST', frame: () => requestFrame,
  headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }),
  postData: () => new URLSearchParams({ params: JSON.stringify(params), ONLY_DATA_REQUIRED: 'true' }).toString(),
});
const read = () => makeRequest(READ, { propertyCode: 'HRCEN', reservationStayId: '5', childAges: [8, 12] });
const validate = () => makeRequest(VALIDATE, { propertyCode: 'HRCEN', reservationStayId: '5', childAges: [8, 12, 5],
  adultCount: '2', childCount: '3', updateChildCategories: true, activeChildCategories: 3,
  confirmChildCategory: false, childCategoryCounts: { child1: 0, child2: 2, child3: 0 } });

function deferred() {
  let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve };
}
function mockPage({ paused = null } = {}) {
  const pageRoutes = [], contextRoutes = [], calls = [];
  const context = { route: async (_pattern, handler) => { contextRoutes.push(handler); }, unroute: async () => {} };
  const page = { context: () => context, route: async (_pattern, handler) => { pageRoutes.push(handler); },
    unroute: async () => {}, on: () => {}, off: () => {}, locator: () => ({}),
    waitForTimeout: async () => {}, waitForResponse: async () => null };
  frame.page = () => page;
  const visit = async (request) => {
    const callContext = async (index) => {
      if (index < 0) { calls.push('continue'); return; }
      await contextRoutes[index]({ request: () => request, abort: async () => calls.push('abort'),
        continue: async () => calls.push('continue'), fallback: async () => callContext(index - 1) });
    };
    const callPage = async (index) => {
      if (index < 0) return callContext(contextRoutes.length - 1);
      await pageRoutes[index]({ request: () => request, abort: async () => calls.push('abort'),
        fallback: async () => {
          if (paused && index === pageRoutes.length - 1) { paused.entered.resolve(); await paused.release.promise; }
          return callPage(index - 1);
        } });
    };
    await callPage(pageRoutes.length - 1);
  };
  return { page, context, calls, visit };
}
const config = (gate, stage, save) => ({ timeoutMs: 500, prepareOnly: true,
  prepare: async () => ({ frame, save, childStageGate: gate }), stage, matches: () => true, validate: async () => true });

test('Prepare passes the exact read but refuses validation, late requests and Save', async () => {
  const fake = mockPage(); await installReadOnlyGuard(fake.context);
  const gate = createSavedChildStageRequestGate(target());
  let clicks = 0;
  const save = { click: async () => { clicks += 1; } };
  const result = await runLabtestAmendSave(fake.page, config(gate, async () => {
    assert.equal(gate.armRead(), true); await fake.visit(read());
    assert.equal(gate.markReadVerified(), true); assert.equal(gate.armValidation(), true); await fake.visit(validate());
    return {};
  }, save));
  assert.equal(result.issue, 'AMEND_DRAFT_CHANGED'); assert.equal(result.blockedRequests, 1); assert.equal(clicks, 0);
  assert.deepEqual(fake.calls, ['continue', 'abort']);
  await fake.visit(read());
  assert.equal(fake.calls.at(-1), 'abort');
  await fake.visit(makeRequest('/web/base/OSRESV.HDR?pageaction=SAVE', {}));
  assert.equal(fake.calls.at(-1), 'abort');
});

test('mismatched child request aborts, closes gate and prevents Save', async () => {
  const fake = mockPage(); await installReadOnlyGuard(fake.context);
  const gate = createSavedChildStageRequestGate(target()); let clicks = 0;
  const result = await runLabtestAmendSave(fake.page, config(gate, async () => {
    assert.equal(gate.armRead(), true);
    await fake.visit(makeRequest(READ, { propertyCode: 'HRCEN', reservationStayId: '6', childAges: [8, 12] }));
    assert.equal(gate.consume(read()), false);
    return {};
  }, { click: async () => { clicks += 1; } }));
  assert.equal(result.issue, 'AMEND_DRAFT_CHANGED'); assert.equal(result.blockedRequests, 1);
  assert.equal(clicks, 0); assert.deepEqual(fake.calls, ['abort']);
});

test('timeout quarantines the page before a delayed child request reaches the fence', async () => {
  const paused = { entered: deferred(), release: deferred() }, fake = mockPage({ paused });
  await installReadOnlyGuard(fake.context);
  const gate = createSavedChildStageRequestGate(target());
  const work = runLabtestAmendSave(fake.page, { ...config(gate, async () => {
    gate.armRead(); await fake.visit(read()); return {};
  }, { click: async () => { throw new Error('Save must not be clicked'); } }), timeoutMs: 30 });
  await paused.entered.promise;
  const result = await work;
  assert.equal(result.issue, 'AMEND_TIMEOUT');
  paused.release.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(fake.calls, ['abort']);
});

test('drain waits for a paused child route and disarm blocks its eventual dispatch', async () => {
  const paused = { entered: deferred(), release: deferred() }, fake = mockPage({ paused });
  await installReadOnlyGuard(fake.context);
  const gate = createSavedChildStageRequestGate(target());
  const fence = await installPageRequestFence(fake.page, [READ, VALIDATE]);
  const scope = fence.open();
  const chain = await installLabtestSaveRouteChain(fake.page, {
    frame, fence, scope, childStageGate: gate, isChildStageActive: () => true,
    isArmed: () => false, matches: () => false,
  });
  assert.equal(gate.armRead(), true);
  const pending = fake.visit(read());
  await paused.entered.promise;
  assert.equal(await chain.drain({ timeoutMs: 5 }), false);
  paused.release.resolve();
  await pending;
  assert.equal(await chain.drain({ timeoutMs: 50 }), true);
  assert.deepEqual(fake.calls, ['abort']);
});

test('rejects a forged gate before installing request exceptions', async () => {
  const fake = mockPage(); let clicks = 0;
  const result = await runLabtestAmendSave(fake.page, config({ consume: () => true }, async () => ({}),
    { click: async () => { clicks += 1; } }));
  assert.equal(result.issue, 'CHILD_STAGE_GATE_INVALID'); assert.equal(clicks, 0);
});

test('child staging and upstream dispatch wrapper share one fence without widening either route', async () => {
  const fake = mockPage(); await installReadOnlyGuard(fake.context);
  const gate = createSavedChildStageRequestGate(target());
  const fence = await installPageRequestFence(fake.page, [READ, VALIDATE, '/web/base/OSRESV.HDR']);
  const scope = fence.open(), wrapper = [];
  let staging = true, armed = false, dispatched = 0;
  const chain = await installLabtestSaveRouteChain(fake.page, {
    frame, fence, scope, childStageGate:gate, isChildStageActive:() => staging,
    canDispatchChild:() => true, dispatchChildCandidate:async (_request, proceed) => { await proceed(); },
    isArmed:() => armed, matches:(request) => request.url().endsWith('/web/base/OSRESV.HDR?pageaction=SAVE'),
    dispatchCandidate:async (_request, proceed) => { wrapper.push('enter'); await proceed(); wrapper.push('exit'); },
    onDispatch:() => { dispatched += 1; },
  });
  assert.equal(gate.armRead(), true); await fake.visit(read());
  assert.equal(gate.markReadVerified(), true); assert.equal(gate.armValidation(), true); await fake.visit(validate());
  staging = false; gate.close(); armed = true;
  await fake.visit(makeRequest('/web/base/OSRESV.HDR?pageaction=SAVE', {}));
  assert.equal(dispatched, 1); assert.deepEqual(fake.calls, ['continue', 'continue', 'continue']);
  assert.equal(await chain.waitForDispatch(), true);
  assert.deepEqual(wrapper, ['enter', 'exit']);
  await fake.visit(read());
  assert.equal(fake.calls.at(-1), 'abort');
  await fake.visit(makeRequest('/web/base/OSRESV.HDR?pageaction=SAVE', {}));
  assert.equal(fake.calls.at(-1), 'abort'); assert.equal(dispatched, 1);
  scope.close(); await chain.close();
});

// Block the event loop past the lifecycle deadline without allowing its timer
// callback to run. Native routing must consult the clock independently.
function blockPastDeadline() {
  const end = performance.now() + 250;
  while (performance.now() < end) { /* Synthetic event-loop delay. */ }
}

test('child route refuses a request after the lifecycle deadline even before its timer fires', async () => {
  const fake = mockPage(); await installReadOnlyGuard(fake.context);
  const gate = createSavedChildStageRequestGate(target());
  const result = await runLabtestAmendSave(fake.page, { ...config(gate, async () => {
    assert.equal(gate.armRead(), true);
    blockPastDeadline();
    await fake.visit(read());
    return {};
  }, { click: async () => { throw new Error('Save must not be clicked'); } }), timeoutMs: 200 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.issue, 'AMEND_TIMEOUT');
  assert.deepEqual(fake.calls, ['abort']);
});

test('child context route refuses a page-approved request after the lifecycle deadline', async () => {
  const paused = { entered: deferred(), release: deferred() }, fake = mockPage({ paused });
  await installReadOnlyGuard(fake.context);
  const gate = createSavedChildStageRequestGate(target());
  const result = await runLabtestAmendSave(fake.page, { ...config(gate, async () => {
    assert.equal(gate.armRead(), true);
    const pending = fake.visit(read());
    await paused.entered.promise;
    blockPastDeadline();
    paused.release.resolve();
    await pending;
    return {};
  }, { click: async () => { throw new Error('Save must not be clicked'); } }), timeoutMs: 200 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.issue, 'AMEND_TIMEOUT');
  assert.deepEqual(fake.calls, ['abort']);
});

test('Save route refuses dispatch after the lifecycle deadline even before its timer fires', async () => {
  const fake = mockPage(); await installReadOnlyGuard(fake.context);
  const save = { click: async () => {
    blockPastDeadline();
    await fake.visit(makeRequest('/web/base/OSRESV.HDR?pageaction=SAVE', {}));
  } };
  const result = await runLabtestAmendSave(fake.page, { ...config(null, async () => ({}), save),
    prepareOnly: false, timeoutMs: 200 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.outcome, 'not_dispatched');
  assert.equal(result.issue, 'AMEND_TIMEOUT');
  assert.deepEqual(fake.calls, ['abort']);
});


test('Save context route refuses a candidate after the lifecycle deadline', async () => {
  const paused = { entered: deferred(), release: deferred() }, fake = mockPage({ paused });
  await installReadOnlyGuard(fake.context);
  const save = { click: async () => {
    const pending = fake.visit(makeRequest('/web/base/OSRESV.HDR?pageaction=SAVE', {}));
    await paused.entered.promise;
    blockPastDeadline();
    paused.release.resolve();
    await pending;
  } };
  const result = await runLabtestAmendSave(fake.page, { ...config(null, async () => ({}), save),
    prepareOnly: false, timeoutMs: 200 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.issue, 'AMEND_TIMEOUT');
  assert.deepEqual(fake.calls, ['abort']);
});
