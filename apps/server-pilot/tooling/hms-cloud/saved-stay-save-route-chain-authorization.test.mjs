import test from 'node:test';
import assert from 'node:assert/strict';
import { installLabtestSaveRouteChain } from './saved-stay-save-route-chain.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness(authorizeCandidate) {
  const frame = {};
  let pageHandler, contextHandler, armed = true, quarantined = false, allowed = 0, attempts = 0, blocked = 0;
  const context = { route: async (_pattern, handler) => { contextHandler = handler; } };
  const page = { context: () => context, route: async (_pattern, handler) => { pageHandler = handler; } };
  const chain = await installLabtestSaveRouteChain(page, {
    frame, fence: { isQuarantined: () => quarantined },
    scope: { allow: () => { allowed += 1; return true; } },
    isArmed: () => armed, matches: () => true, authorizeCandidate,
    onAuthorizationAttempt: () => { attempts += 1; }, onBlocked: () => { blocked += 1; },
  });
  const request = () => ({ frame: () => frame, method: () => 'POST',
    url: () => 'https://example.invalid/web/base/OSRESV.HDR?pageaction=SAVE' });
  const route = (req) => ({ request: () => req, fallback: async () => 'fallback', abort: async () => 'abort',
    continue: async () => 'continue' });
  return { chain, request, route, pageHandler, contextHandler,
    disarm: () => { armed = false; }, quarantine: () => { quarantined = true; },
    counts: () => ({ allowed, attempts, blocked }) };
}

test('only one candidate may await authorization at a time', async () => {
  const started = deferred(), result = deferred();
  const h = await harness(async () => { started.resolve(); return result.promise; });
  const first = h.request();
  const pending = h.pageHandler(h.route(first));
  await started.promise;
  await h.pageHandler(h.route(h.request()));
  assert.deepEqual(h.counts(), { allowed: 0, attempts: 1, blocked: 1 });
  result.resolve(true);
  await pending;
  assert.equal(h.chain.candidate(), first);
  assert.equal(h.counts().allowed, 1);
});

for (const stop of ['disarm', 'quarantine', 'close']) {
  test(`authorization cannot pass after ${stop} while awaiting proof`, async () => {
    const started = deferred(), result = deferred();
    const h = await harness(async () => { started.resolve(); return result.promise; });
    const pending = h.pageHandler(h.route(h.request()));
    await started.promise;
    if (stop === 'close') await h.chain.close();
    else h[stop]();
    result.resolve(true);
    await pending;
    assert.equal(h.chain.candidate(), null);
    assert.deepEqual(h.counts(), { allowed: 0, attempts: 1, blocked: 1 });
  });
}
