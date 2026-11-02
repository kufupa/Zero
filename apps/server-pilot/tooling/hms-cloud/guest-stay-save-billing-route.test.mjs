import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';
import { installLabtestSaveRouteChain } from './saved-stay-save-route-chain.mjs';
import { matchesFullCreateBody } from './guest-stay-save.mjs';

const require = createRequire(new URL('../stagehand/package.json', import.meta.url));
const { chromium } = require('playwright');
const path = '/web/base/OSRESV.HDR';

test('unarmed billing staging permits no POST; quarantine blocks delayed and exact saves', { timeout: 30000 }, async () => {
  const received = [];
  const server = createServer((req, res) => { received.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<input name="billingreference">'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await installReadOnlyGuard(context);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/ready`);
    const fence = await installPageRequestFence(page, [path]), scope = fence.open();
    let armed = false, blocked = 0, dispatched = 0, chain;
    const expected = { billingreference: ' PO 123 ', roomtype: 'STQN' };
    chain = await installLabtestSaveRouteChain(page, { frame: page.mainFrame(), fence, scope,
      isArmed: () => armed, matches: (request) => matchesFullCreateBody(new URLSearchParams(request.postData()), expected),
      onDispatch: () => { dispatched += 1; }, onBlocked: () => { blocked += 1; armed = false; fence.quarantine(); chain.disarm(); },
    });
    await page.locator('input[name="billingreference"]').fill(' PO 123 ');
    assert.equal(await page.locator('input[name="billingreference"]').inputValue(), ' PO 123 ');
    const body = new URLSearchParams({ ...expected, SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR' }).toString();
    const send = (target) => page.evaluate(async ({ target, body }) => {
      try { return (await fetch(target, { method: 'POST', body })).status; } catch { return 'blocked'; }
    }, { target, body });
    assert.equal(await send('/field-change'), 'blocked');
    assert.equal(blocked, 1);
    armed = true;
    assert.equal(await send(`${path}?pageaction=SAVE`), 'blocked');
    assert.equal(dispatched, 0);
    assert.equal(received.filter((item) => item.method === 'POST').length, 0);
    scope.close(); await chain.close(); await context.close();
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('after staging only one exact native-body save passes the retained fence', { timeout: 30000 }, async () => {
  const received = [];
  const server = createServer((req, res) => { received.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<input name="billingreference">'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await installReadOnlyGuard(context);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/ready`);
    const fence = await installPageRequestFence(page, [path]), scope = fence.open();
    let armed = false, dispatched = 0;
    const expected = { billingreference: ' PO 123 ', roomtype: 'STQN' };
    const chain = await installLabtestSaveRouteChain(page, { frame: page.mainFrame(), fence, scope,
      isArmed: () => armed, matches: (request) => matchesFullCreateBody(new URLSearchParams(request.postData()), expected),
      onDispatch: () => { dispatched += 1; armed = false; },
    });
    await page.locator('input[name="billingreference"]').fill(expected.billingreference);
    armed = true;
    const send = (reference) => page.evaluate(async ({ path, reference }) => {
      const body = new URLSearchParams({ billingreference: reference, roomtype: 'STQN', SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR' });
      try { return (await fetch(`${path}?pageaction=SAVE`, { method: 'POST', body })).status; } catch { return 'blocked'; }
    }, { path, reference });
    assert.equal(await send('PO 123'), 'blocked');
    assert.equal(await send(expected.billingreference), 200);
    armed = true;
    assert.equal(await send(expected.billingreference), 'blocked');
    assert.equal(dispatched, 1);
    assert.equal(received.filter((item) => item.method === 'POST').length, 1);
    scope.close(); await chain.close(); await context.close();
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
