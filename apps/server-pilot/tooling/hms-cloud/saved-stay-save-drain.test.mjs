import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeNeverDispatchedCreateProof, installLabtestSaveRouteChain } from './saved-stay-save-route-chain.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function setup({ authorizeCandidate, dispatchCandidate, continueRequest } = {}) {
  let pageHandler, contextHandler;
  const frame = {}, events = [];
  const request = { url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR?pageaction=SAVE',
    method: () => 'POST', frame: () => frame };
  const context = { route: async (_pattern, handler) => { contextHandler = handler; }, unroute: async () => {} };
  const page = { context: () => context, route: async (_pattern, handler) => { pageHandler = handler; }, unroute: async () => {} };
  const fence = { isQuarantined: () => false }, scope = { allow: () => true };
  const chain = await installLabtestSaveRouteChain(page, { frame, fence, scope, isArmed: () => true,
    matches: () => true, authorizeCandidate, dispatchCandidate });
  const visit = () => pageHandler({ request: () => request, fallback: () => contextHandler({
    request: () => request, abort: async () => { events.push('abort'); },
    fallback: async () => { events.push('fallback'); },
    continue: async () => { events.push('continue'); await continueRequest?.(); },
  }), abort: async () => { events.push('page-abort'); } });
  return { chain, visit, events, request };
}

test('a late page authorization is drained and cannot dispatch after disarm', async () => {
  const entered = deferred(), release = deferred();
  const fake = await setup({ authorizeCandidate: async () => { entered.resolve(); await release.promise; return true; } });
  const visit = fake.visit();
  await entered.promise;
  assert.equal(await fake.chain.drain({ timeoutMs: 5 }), false);
  release.resolve();
  await visit;
  assert.equal(await fake.chain.drain({ timeoutMs: 5 }), true);
  assert.deepEqual(fake.events, ['abort']);
});

test('a late committed wrapper cannot continue the paused request after disarm', async () => {
  const entered = deferred(), release = deferred();
  const fake = await setup({ dispatchCandidate: async (_request, proceed) => {
    entered.resolve(); await release.promise; await proceed();
  } });
  const visit = fake.visit();
  await entered.promise;
  assert.equal(await fake.chain.drain({ timeoutMs: 5 }), false);
  release.resolve();
  await visit;
  assert.equal(await fake.chain.drain({ timeoutMs: 5 }), true);
  assert.deepEqual(fake.events, ['abort']);
});

test('late claim after drain timeout can prove the exact Save never continued', async () => {
  const entered = deferred(), release = deferred();
  let receipt, continuation;
  const fake = await setup({ dispatchCandidate: async (_request, proceed) => {
    entered.resolve(); await release.promise;
    try { await proceed(); } catch { receipt = proceed.proveNeverDispatched(); continuation = proceed; }
  } });
  const visit = fake.visit();
  await entered.promise;
  assert.equal(await fake.chain.drain({ timeoutMs: 5 }), false);
  release.resolve(); await visit;
  assert.equal(await fake.chain.drain({ timeoutMs: 20 }), true);
  assert.deepEqual(fake.events, ['abort']);
  assert.ok(receipt);
  assert.equal(consumeNeverDispatchedCreateProof({}, fake.request), false);
  assert.equal(consumeNeverDispatchedCreateProof(receipt, {}), false);
  assert.equal(consumeNeverDispatchedCreateProof(receipt, fake.request), true);
  assert.equal(consumeNeverDispatchedCreateProof(receipt, fake.request), false);
  await assert.rejects(continuation(), /SAVE_DISPATCH_NOT_AUTHORIZED/);
});

test('a route cannot prove no dispatch after continuation was attempted', async () => {
  let receipt = 'unset';
  const fake = await setup({ dispatchCandidate: async (_request, proceed) => {
    await proceed(); receipt = proceed.proveNeverDispatched();
  } });
  await fake.visit();
  assert.equal(receipt, null);
  assert.deepEqual(fake.events, ['continue']);
});

test('drain tracks an unawaited native continuation after its wrapper fails', async () => {
  const entered = deferred(), release = deferred();
  const fake = await setup({
    dispatchCandidate: async (_request, proceed) => { void proceed(); },
    continueRequest: async () => { entered.resolve(); await release.promise; },
  });
  const visit = fake.visit().catch(() => {});
  await entered.promise;
  await visit;
  assert.equal(await fake.chain.drain({ timeoutMs: 5 }), false);
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await fake.chain.drain({ timeoutMs: 5 }), true);
  assert.deepEqual(fake.events, ['continue']);
});

test('disarm before a queued authorization starts never invokes it', async () => {
  let authorizations = 0;
  const fake = await setup({ authorizeCandidate: async () => { authorizations += 1; return true; } });
  const visit = fake.visit();
  assert.equal(await fake.chain.drain({ timeoutMs: 50 }), true);
  await visit;
  assert.equal(authorizations, 0);
  assert.deepEqual(fake.events, ['abort']);
});

test('drain observes a late continuation added by a pending wrapper', async () => {
  const entered = deferred(), release = deferred();
  const fake = await setup({
    dispatchCandidate: async (_request, proceed) => { entered.resolve(); await release.promise; void proceed(); },
  });
  const visit = fake.visit();
  await entered.promise;
  const drained = fake.chain.drain({ timeoutMs: 50 });
  release.resolve();
  await visit;
  assert.equal(await drained, true);
  assert.deepEqual(fake.events, ['abort']);
});

test('invalid drain deadline disarms and refuses to claim quiescence', async () => {
  const fake = await setup();
  assert.equal(await fake.chain.drain({ timeoutMs: Number.POSITIVE_INFINITY }), false);
  await fake.visit();
  assert.deepEqual(fake.events, ['abort']);
});
