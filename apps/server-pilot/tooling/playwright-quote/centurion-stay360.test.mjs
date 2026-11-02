import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { centurionContextOptions } from './centurion-stay360.mjs';

const require = createRequire(new URL('../stagehand/package.json', import.meta.url));

test('service-worker blocking is explicit and the default context is unchanged', () => {
  assert.deepEqual(centurionContextOptions(), { viewport: { width: 1440, height: 1000 } });
  assert.deepEqual(centurionContextOptions(false), centurionContextOptions());
  const changed = centurionContextOptions(true);
  changed.viewport.width = 1;
  assert.equal(centurionContextOptions(true).viewport.width, 1440);
  assert.deepEqual(centurionContextOptions(true), {
    viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block',
  });
  for (const value of [null, 'block', 1, {}]) {
    assert.throws(() => centurionContextOptions(value), /SERVICE_WORKER_OPTION_INVALID/);
  }
});

test('blocked service workers cannot bypass context request routes', async () => {
  let workerRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/sw.js') {
      workerRequests += 1;
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end(`self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
        self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
        self.addEventListener('fetch', event => {
          if (new URL(event.request.url).pathname === '/protected') {
            event.respondWith(new Response('worker'));
          }
        });`);
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Service worker test</title>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await require('playwright').chromium.launch({
      headless: true, executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined,
    });
    for (const block of [false, true]) {
      const context = await browser.newContext(centurionContextOptions(block));
      try {
        await context.route('**/protected', (route) => route.fulfill({ status: 200, body: 'route' }));
        const page = await context.newPage();
        await page.goto(origin);
        const requestsBefore = workerRequests;
        if (block) {
          await page.evaluate(() => Promise.race([
            navigator.serviceWorker.register('/sw.js').catch(() => null),
            new Promise((resolve) => setTimeout(resolve, 1000)),
          ]));
          assert.equal(context.serviceWorkers().length, 0);
          assert.equal(workerRequests, requestsBefore);
        } else {
          await page.evaluate(() => navigator.serviceWorker.register('/sw.js'));
          await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
          assert.equal(context.serviceWorkers().length, 1);
        }
        assert.equal(await page.evaluate(() => fetch('/protected').then((response) => response.text())),
          block ? 'route' : 'worker');
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
