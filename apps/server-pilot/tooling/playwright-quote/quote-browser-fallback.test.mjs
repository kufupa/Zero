import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { centurionBrowserIdentity } from './centurion-stay360.mjs';
import { createQuoteBrowserConnector } from './quote-browser-fallback.mjs';
import { attachGuardedQuoteSession } from './quote-request-guard.mjs';

const refused = () => { throw new Error('connect ECONNREFUSED'); };

test('a working borrowed connection is unchanged and is never owned by the fallback', async () => {
  const browser = {};
  const connector = createQuoteBrowserConnector({ propertyCode: 'HRCEN', chromium: {
    connectOverCDP: async () => browser, launchServer: () => { throw new Error('unexpected launch'); },
  } });
  assert.equal(await connector.connect('http://127.0.0.1:1', {}), browser);
  assert.equal(await connector.close(), false);
});

test('only a refused Centurion connection starts a private browser, then closes its exact owned resources', async () => {
  const browser = {}, context = {}, server = { process: () => ({ pid: 123 }), wsEndpoint: () => 'ws://private' };
  const calls = [];
  const connector = createQuoteBrowserConnector({ propertyCode: 'HRCEN', env: { HMS_CHROMIUM_EXECUTABLE_PATH: '/chrome' },
    chromium: { connectOverCDP: refused, launchServer: async options => { calls.push(options); return server; },
      connect: async (url, options) => { assert.equal(url, 'ws://private'); assert.equal(options.timeout, 17); return browser; } },
    prepare: async () => calls.push('prepared'), identify: pid => ({ pid, started: '99' }),
    closeOwned: async resources => calls.push(resources),
  });
  assert.equal(await connector.connect('http://127.0.0.1:1', { timeout: 17 }), browser);
  assert.equal(await connector.close(context), true);
  assert.equal(await connector.close(), false);
  assert.equal(calls[0], 'prepared');
  assert.deepEqual(calls[1], { headless: true, host: '127.0.0.1', executablePath: '/chrome' });
  assert.deepEqual(calls[2], { server, browser, context, processIdentity: { pid: 123, started: '99' }, processGroup: 123 });
});

test('other properties and non-refusal errors do not trigger a fallback', async () => {
  for (const [propertyCode, error] of [['HRDAV', 'connect ECONNREFUSED'], ['HRCEN', 'policy rejected']]) {
    const connector = createQuoteBrowserConnector({ propertyCode, chromium: {
      connectOverCDP: async () => { throw new Error(error); }, launchServer: () => { throw new Error('unexpected launch'); },
    } });
    await assert.rejects(connector.connect('http://127.0.0.1:1', {}), new RegExp(error));
    assert.equal(await connector.close(), false);
  }
});

test('a partially opened server is retained for cleanup if process identity fails', async () => {
  const server = { process: () => ({ pid: 123 }) };
  let closed;
  const connector = createQuoteBrowserConnector({ propertyCode: 'HRCEN', chromium: {
    connectOverCDP: refused, launchServer: async () => server,
  }, prepare: async () => {}, identify: () => { throw new Error('identity failed'); },
  closeOwned: async resources => { closed = resources; } });
  await assert.rejects(connector.connect('http://127.0.0.1:1', {}), /identity failed/);
  assert.equal(await connector.close(), true);
  assert.equal(closed.server, server);
});

test('a real fallback browser is closed with its process group after the read', async () => {
  const require = createRequire(new URL('../stagehand/package.json', import.meta.url));
  const chromium = require('playwright').chromium;
  let identity;
  const connector = createQuoteBrowserConnector({ propertyCode: 'HRCEN', env: {},
    chromium: { connectOverCDP: refused, launchServer: options => chromium.launchServer(options),
      connect: (url, options) => chromium.connect(url, options) },
    prepare: async () => {}, identify: pid => (identity = centurionBrowserIdentity(pid)),
  });
  let context;
  try {
    const browser = await connector.connect('http://127.0.0.1:1', { timeout: 20_000 });
    context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto('data:text/html,<title>private quote</title>');
    assert.equal(await page.title(), 'private quote');
    assert.equal(await connector.close(context), true);
    context = undefined;
    assert.throws(() => process.kill(-identity.pid, 0), { code: 'ESRCH' });
  } finally {
    await connector.close(context).catch(() => {});
  }
});

test('the real fallback uses the quote request guard before a page can reach an unapproved endpoint', async () => {
  const require = createRequire(new URL('../stagehand/package.json', import.meta.url));
  const chromium = require('playwright').chromium;
  let requests = 0, identity;
  const endpoint = createServer((_request, response) => { requests += 1; response.end('unexpected'); });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  const connector = createQuoteBrowserConnector({ propertyCode: 'HRCEN', env: {},
    chromium: { connectOverCDP: refused, launchServer: options => chromium.launchServer(options),
      connect: (url, options) => chromium.connect(url, options) },
    prepare: async () => {}, identify: pid => (identity = centurionBrowserIdentity(pid)),
  });
  let context;
  try {
    const policy = { origin: 'http://127.0.0.1', manifest: { rules: [] },
      enforce: async (route, _manifest, { onDecision }) => {
        const decision = { action: 'deny', code: 'unreviewed' };
        onDecision(decision); await route.abort('blockedbyclient'); return decision;
      } };
    const attached = await attachGuardedQuoteSession({ href: 'http://127.0.0.1:1', env: {}, policy,
      connectOverCDP: connector.connect });
    context = attached.context;
    const page = await context.newPage();
    await assert.rejects(page.goto(`http://127.0.0.1:${endpoint.address().port}/save`));
    assert.equal(requests, 0);
    assert.match(attached.guard.failureError().message, /HMS_QUOTE_POLICY_BLOCKED_/);
    await connector.close(context);
    context = undefined;
    assert.throws(() => process.kill(-identity.pid, 0), { code: 'ESRCH' });
  } finally {
    await connector.close(context).catch(() => {});
    await new Promise(resolve => endpoint.close(resolve));
  }
});
