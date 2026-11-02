import test from 'node:test';
import assert from 'node:assert/strict';
import { installLabtestSaveRouteChain } from './saved-stay-save-route-chain.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness(dispatchCandidate) {
  const frame = {};
  const order = [];
  let pageHandler, contextHandler, armed = true, quarantined = false;
  const context = { route: async (_pattern, handler) => { contextHandler = handler; } };
  const page = { context: () => context, route: async (_pattern, handler) => { pageHandler = handler; } };
  const chain = await installLabtestSaveRouteChain(page, {
    frame, fence: { isQuarantined: () => quarantined }, scope: { allow: () => true },
    isArmed: () => armed, matches: () => true, dispatchCandidate,
    onDispatch: () => order.push('dispatch'), onBlocked: () => order.push('blocked'),
  });
  const request = { frame: () => frame, method: () => 'POST',
    url: () => 'https://example.invalid/web/base/OSRESV.HDR?pageaction=SAVE' };
  const route = { request: () => request, fallback: async () => 'fallback',
    abort: async () => { order.push('abort'); return 'abort'; },
    continue: async () => { order.push('continue'); return 'continue'; } };
  await pageHandler(route);
  return { chain, request, route, contextHandler, order,
    disarm: () => { armed = false; }, quarantine: () => { quarantined = true; } };
}

test('default route continues one exact candidate', async () => {
  const h = await harness();
  await h.contextHandler(h.route);
  assert.deepEqual(h.order, ['dispatch', 'continue']);
  assert.equal(h.chain.continued(), h.request);
  await h.contextHandler(h.route);
  assert.deepEqual(h.order, ['dispatch', 'continue', 'blocked', 'abort']);
});

test('dispatch wrapper can hold its guard through exact continuation', async () => {
  const order = [];
  const h = await harness(async (_request, proceed) => {
    order.push('lock');
    await proceed();
    order.push('unlock');
  });
  const original = h.route.continue;
  h.route.continue = async () => { order.push('continue'); return original(); };
  await h.contextHandler(h.route);
  assert.deepEqual(order, ['lock', 'continue', 'unlock']);
  assert.deepEqual(h.order, ['dispatch', 'continue']);
});

for (const mode of ['refuse', 'throw']) {
  test(`wrapper ${mode} before dispatch aborts without a continuation`, async () => {
    const h = await harness(async () => { if (mode === 'throw') throw new Error('refused'); });
    assert.equal(await h.contextHandler(h.route), 'abort');
    assert.deepEqual(h.order, ['blocked', 'abort']);
    assert.equal(h.chain.continued(), null);
  });
}

for (const mode of ['disarm', 'quarantine', 'close']) {
  test(`${mode} during wrapper wait blocks its eventual continuation`, async () => {
    const started = deferred(), ready = deferred();
    const h = await harness(async (_request, proceed) => { started.resolve(); await ready.promise; await proceed(); });
    const pending = h.contextHandler(h.route);
    await started.promise;
    if (mode === 'close') await h.chain.close();
    else h[mode]();
    ready.resolve();
    assert.equal(await pending, 'abort');
    assert.deepEqual(h.order, ['blocked', 'abort']);
    assert.equal(h.chain.continued(), null);
  });
}

test('a continuation cannot be called after its wrapper returns', async () => {
  let delayed;
  const h = await harness(async (_request, proceed) => { delayed = proceed; });
  assert.equal(await h.contextHandler(h.route), 'abort');
  await assert.rejects(delayed(), /SAVE_DISPATCH_NOT_AUTHORIZED/);
  assert.deepEqual(h.order, ['blocked', 'abort']);
});

test('a second continuation is refused and the first remains possibly dispatched', async () => {
  const h = await harness(async (_request, proceed) => { await proceed(); await proceed(); });
  await assert.rejects(h.contextHandler(h.route), /SAVE_DISPATCH_NOT_AUTHORIZED/);
  assert.deepEqual(h.order, ['dispatch', 'continue']);
  assert.equal(h.chain.continued(), h.request);
});

test('post-dispatch wrapper failure is propagated as an uncertain outcome', async () => {
  const h = await harness(async (_request, proceed) => { await proceed(); throw new Error('commit_failed'); });
  await assert.rejects(h.contextHandler(h.route), /commit_failed/);
  assert.deepEqual(h.order, ['dispatch', 'continue']);
  assert.equal(h.chain.continued(), h.request);
});

test('a wrapper that fails to await continuation reports an uncertain outcome', async () => {
  const h = await harness(async (_request, proceed) => { void proceed(); });
  const pending = deferred();
  h.route.continue = async () => { h.order.push('continue'); await pending.promise; };
  await assert.rejects(h.contextHandler(h.route), /SAVE_DISPATCH_NOT_AWAITED/);
  assert.equal(h.chain.continued(), h.request);
  assert.deepEqual(h.order, ['dispatch', 'continue']);
  pending.resolve();
});

test('a concurrent invocation cannot authorize the candidate twice', async () => {
  const started = deferred(), ready = deferred();
  const h = await harness(async (_request, proceed) => { started.resolve(); await ready.promise; await proceed(); });
  const first = h.contextHandler(h.route);
  await started.promise;
  assert.equal(await h.contextHandler(h.route), 'abort');
  ready.resolve();
  await first;
  assert.deepEqual(h.order, ['blocked', 'abort', 'dispatch', 'continue']);
});

test('invalid dispatch callback is refused during installation', async () => {
  await assert.rejects(harness('not-a-function'), /AMEND_ROUTE_CHAIN_INPUT_INVALID/);
});
