import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';
import { installLabtestSaveRouteChain } from './saved-stay-save-route-chain.mjs';

const require = createRequire(new URL('../stagehand/package.json', import.meta.url));
const { chromium } = require('playwright');
const savePath = '/web/base/OSRESV.HDR';
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const bounded = (promise) => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error('ROUTE_TEST_TIMEOUT')), 8000); timer.unref();
})]);

test('the page fence survives action-route removal and passes only one approved save', { timeout: 30000 }, async () => {
  const received = [];
  const server = createServer((request, response) => {
    received.push({ method: request.method, url: request.url });
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined });
    const context = await browser.newContext();
    await installReadOnlyGuard(context);
    const page = await context.newPage();
    await page.goto(`${origin}/ready`);
    const fence = await installPageRequestFence(page, [savePath]);
    const send = (body, path = savePath) => page.evaluate(async ({ path, body }) => {
      try { return (await fetch(`${path}?pageaction=SAVE`, { method: 'POST', body })).status; }
      catch { return 'blocked'; }
    }, { path, body });
    // The header path is denied by the fence; another write path must still
    // reach and be denied by the shared context guard after route removal.
    for (const path of [savePath, '/delete']) {
      const entered = deferred(), release = deferred();
      const temporary = async (route) => {
        if (route.request().url().includes('pageaction=SAVE')) { entered.resolve(); await release.promise; }
        await route.fallback();
      };
      await page.route('**/*', temporary);
      const pending = send('pageaction=SAVE', path);
      await bounded(entered.promise);
      await bounded(page.unroute('**/*', temporary));
      release.resolve();
      assert.equal(await bounded(pending), 'blocked');
    }
    assert.equal(received.filter(({ url }) => url.includes('pageaction=SAVE')).length, 0);
    assert.equal(await page.evaluate(async () => (await fetch('/ordinary-read')).status), 200);

    const scope = fence.open(), dispatched = [];
    const chain = await installLabtestSaveRouteChain(page, {
      frame: page.mainFrame(), fence, scope, isArmed: () => true,
      matches: (request) => request.method() === 'POST' && request.url() === `${origin}${savePath}?pageaction=SAVE` &&
        request.postData() === 'proof=allowed',
      onDispatch: (request) => dispatched.push(request),
    });
    assert.equal(await bounded(send('proof=wrong')), 'blocked');
    assert.equal(await bounded(send('proof=allowed')), 200);
    assert.equal(await bounded(send('proof=allowed')), 'blocked');
    assert.equal(dispatched.length, 1);
    assert.equal(received.filter(({ url }) => url.includes('pageaction=SAVE')).length, 1);
    scope.close(); await chain.close();
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
