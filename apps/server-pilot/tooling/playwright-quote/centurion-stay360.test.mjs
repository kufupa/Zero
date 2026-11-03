import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import test from 'node:test';
import {
  assertNoCenturionBrowserHold, centurionBrowserGroup, centurionBrowserHoldPath, centurionBrowserIdentity, centurionContextOptions,
  centurionWriterCurrent, centurionWriterIdentity, centurionWriterQuiesced,
  closeCenturionResources, holdCenturionBrowser, newPreparedCenturionPage, prepareCenturionLaunch, withCenturionStay360Page,
} from './centurion-stay360.mjs';

const require = createRequire(new URL('../stagehand/package.json', import.meta.url));

test('recovery refuses until the original writer and the entire owned browser group have exited', async () => {
  const writer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const browser = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  try {
    await Promise.all([once(writer, 'spawn'), once(browser, 'spawn')]);
    const start = (pid) => readFileSync(`/proc/${pid}/stat`, 'utf8').split(/\)\s/)[1].trim().split(/\s+/)[19];
    const identity = {
      host: createHash('sha256').update(readFileSync('/etc/machine-id', 'utf8').trim()).update('\0').update(hostname()).digest('hex'),
      bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      pidNamespace: readlinkSync('/proc/self/ns/pid'),
      node: { pid: writer.pid, started: start(writer.pid) }, browser: centurionBrowserIdentity(browser.pid),
    };
    const current = { ...identity, node: { pid: process.pid, started: start(process.pid) } };
    assert.equal(centurionWriterCurrent(current), true);
    assert.equal(centurionWriterCurrent({ ...current, browser: { ...current.browser, started: '0' } }), false);
    assert.equal(centurionWriterIdentity({}), null);
    assert.equal(centurionWriterQuiesced(identity), false);
    writer.kill('SIGTERM');
    await once(writer, 'exit');
    assert.equal(centurionWriterQuiesced(identity), false);
    browser.kill('SIGTERM');
    await once(browser, 'exit');
    assert.equal(centurionWriterQuiesced(identity), true);
    for (const wrong of [{ host: '0'.repeat(64) }, { bootId: '00000000-0000-4000-8000-000000000000' },
      { pidNamespace: 'pid:[0]' }, { node: { pid: 1, started: '1' } }]) {
      assert.equal(centurionWriterQuiesced({ ...identity, ...wrong }), false);
    }
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL');
    if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGKILL');
  }
});

test('failed or incomplete browser cleanup remains uncertain and still closes the other layers', async () => {
  for (const failing of ['context', 'browser', 'server', 'group']) {
    const calls = [];
    const resource = (name) => ({ close: async () => { calls.push(name); if (failing === name) throw new Error('failed'); } });
    await assert.rejects(closeCenturionResources({
      context: resource('context'), browser: resource('browser'), server: resource('server'), processGroup: 123,
    }, { isGroupGone: async () => { calls.push('group'); return failing !== 'group'; },
      onUnconfirmed: () => {}, groupWaitMs: 0 }),
    /HMS_BROWSER_CLOSE_UNCONFIRMED/);
    assert.deepEqual(calls, ['context', 'browser', 'server', 'group', ...(failing === 'group' ? ['group'] : [])]);
  }
  await assert.rejects(closeCenturionResources({ server: { close: async () => {} } }, { onUnconfirmed: () => {} }),
    /HMS_BROWSER_CLOSE_UNCONFIRMED/);
});

test('a hung close is bounded and later cleanup still runs', async () => {
  const calls = [];
  await assert.rejects(closeCenturionResources({
    context: { close: () => new Promise(() => {}) },
    browser: { close: async () => { calls.push('browser'); } },
    server: { close: async () => { calls.push('server'); } }, processGroup: 123,
  }, { timeoutMs: 10, groupWaitMs: 0, isGroupGone: async () => true }), /HMS_BROWSER_CLOSE_UNCONFIRMED/);
  assert.deepEqual(calls, ['browser', 'server']);
});

test('a real owned Chromium server closes its detached process group', async () => {
  const chromium = require('playwright').chromium;
  let server, browser, context;
  try {
    server = await chromium.launchServer({ headless: true, host: '127.0.0.1',
      executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined });
    const group = centurionBrowserGroup(server.process().pid);
    browser = await chromium.connect(server.wsEndpoint());
    context = await browser.newContext(centurionContextOptions(true));
    const page = await context.newPage();
    await page.goto('data:text/html,<title>owned browser</title>');
    await closeCenturionResources({ context, browser, server, processGroup: group });
    context = browser = server = undefined;
    assert.throws(() => process.kill(-group, 0), { code: 'ESRCH' });
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
  }
});

test('a hung server is killed only when its owned group identity still matches', async () => {
  const chromium = require('playwright').chromium;
  const server = await chromium.launchServer({ headless: true, host: '127.0.0.1',
    executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined });
  const identity = centurionBrowserIdentity(server.process().pid);
  const exited = new Promise((resolve) => server.process().once('exit', resolve));
  let held = false;
  try {
    await assert.rejects(closeCenturionResources({
      server: { close: () => new Promise(() => {}) }, processGroup: identity.pid, processIdentity: identity,
    }, { timeoutMs: 10, groupWaitMs: 1_000, onUnconfirmed: () => { held = true; } }),
    /HMS_BROWSER_CLOSE_UNCONFIRMED/);
    await exited;
    assert.equal(held, false);
    assert.throws(() => process.kill(-identity.pid, 0), { code: 'ESRCH' });
  } finally {
    await server.close().catch(() => {});
  }
});

test('a mismatched group is never killed and creates a persistent hold', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hms-browser-hold-'));
  const path = join(dir, 'hold');
  const chromium = require('playwright').chromium;
  const server = await chromium.launchServer({ headless: true, host: '127.0.0.1',
    executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined });
  const identity = centurionBrowserIdentity(server.process().pid);
  try {
    const mismatch = { ...identity, started: '0' };
    await assert.rejects(closeCenturionResources({ server: { close: async () => {} },
      processGroup: identity.pid, processIdentity: mismatch },
    { groupWaitMs: 0, onUnconfirmed: (value) => holdCenturionBrowser(value, path) }),
    /HMS_BROWSER_CLOSE_UNCONFIRMED/);
    assert.doesNotThrow(() => process.kill(identity.pid, 0));
    assert.throws(() => assertNoCenturionBrowserHold(path), /HMS_BROWSER_HOLD/);
    holdCenturionBrowser(mismatch, path); // An existing hold is never overwritten.
  } finally {
    await server.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('browser holds use an owner-private directory and reject unsafe parents', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hms-private-home-'));
  try {
    const path = centurionBrowserHoldPath(home);
    assert.equal(path, join(home, '.nava-hms-runtime', 'hrcen-browser-hold'));
    assert.doesNotThrow(() => assertNoCenturionBrowserHold(path));
    holdCenturionBrowser({ pid: 1, started: '1' }, path);
    assert.throws(() => assertNoCenturionBrowserHold(path), /HMS_BROWSER_HOLD/);
    await chmod(join(home, '.nava-hms-runtime'), 0o770);
    assert.throws(() => centurionBrowserHoldPath(home), /HMS_BROWSER_HOLD_UNAVAILABLE/);
    await rm(join(home, '.nava-hms-runtime'), { recursive: true });
    await symlink(home, join(home, '.nava-hms-runtime'));
    assert.throws(() => centurionBrowserHoldPath(home), /HMS_BROWSER_HOLD_UNAVAILABLE/);
    await chmod(home, 0o777);
    assert.throws(() => centurionBrowserHoldPath(home), /HMS_BROWSER_HOLD_UNAVAILABLE/);
  } finally {
    await chmod(home, 0o700);
    await rm(home, { recursive: true, force: true });
  }
});

test('a hold created while a launch is queued prevents that launch', async () => {
  let held = false;
  let checks = 0;
  const check = () => { checks += 1; if (held) throw new Error('HMS_BROWSER_HOLD'); };
  await assert.rejects(prepareCenturionLaunch(async () => { held = true; }, undefined, check), /HMS_BROWSER_HOLD/);
  assert.equal(checks, 2);
  let called = false;
  await assert.rejects(prepareCenturionLaunch(() => { called = true; }, undefined, check), /HMS_BROWSER_HOLD/);
  assert.equal(called, false);
});

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

test('the optional context preparation finishes before page creation and failures stop the page', async () => {
  const seen = [];
  const context = { newPage: async () => { seen.push('page'); return 'page'; } };
  const page = await newPreparedCenturionPage(context, async (value) => {
    assert.equal(value, context); seen.push('guard');
  });
  assert.equal(page, 'page');
  assert.deepEqual(seen, ['guard', 'page']);
  await newPreparedCenturionPage(context);
  assert.deepEqual(seen, ['guard', 'page', 'page']);
  await assert.rejects(newPreparedCenturionPage(context, async () => { throw new Error('guard failed'); }), /guard failed/);
  assert.deepEqual(seen, ['guard', 'page', 'page']);
});

test('credential lookup does not block unrelated requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hms-secret-test-'));
  const previousPath = process.env.PATH;
  const credentials = { loginUrl: 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/logindisp?tenant=THECENTURION_PRD',
    username: 'synthetic', password: 'synthetic', expectedTenant: 'THECENTURION_PRD',
    expectedPropertyCode: 'HRCEN', expectedPropertyName: 'test' };
  await writeFile(join(dir, 'aws'), `#!/usr/bin/env node\nsetTimeout(() => console.log(${JSON.stringify(JSON.stringify(credentials))}), 150);\n`, { mode: 0o700 });
  process.env.PATH = `${dir}:${previousPath}`;
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 20);
  try {
    await assert.rejects(withCenturionStay360Page(() => {}, { beforeLaunch: () => { throw new Error('STOP_BEFORE_BROWSER'); } }), /STOP_BEFORE_BROWSER/);
    assert.equal(timerFired, true);
  } finally {
    clearTimeout(timer);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
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
          await page.evaluate(() => Promise.race([
            navigator.serviceWorker.register('/sw.js'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('WORKER_REGISTRATION_TIMEOUT')), 5000)),
          ]));
          await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 5000 });
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
