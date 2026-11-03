import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { openPartyLookupBrowser } from './party-lookup.mjs';
import { createQuoteBrowserConnector } from './quote-browser-fallback.mjs';

test('party lookup installs its guard before returning the isolated context', async () => {
  const events = [], browser = {}, context = {};
  const session = await openPartyLookupBrowser({ href: 'http://127.0.0.1:1', env: {}, propertyCode: 'HRCEN', chromium: {},
    makeConnector: () => ({ connect: async () => { events.push('connect'); return browser; },
      close: async value => { assert.equal(value, context); events.push('close-owned'); return true; } }),
    createContext: async (value, options) => {
      assert.equal(value, browser);
      assert.equal(options.serviceWorkers, 'block');
      assert.equal(options.acceptDownloads, false);
      events.push('context'); return context;
    },
    installGuard: async value => { assert.equal(value, context); events.push('guard'); },
  });
  assert.deepEqual(events, ['connect', 'context', 'guard']);
  await session.close();
  await session.close();
  assert.deepEqual(events, ['connect', 'context', 'guard', 'close-owned']);
});

test('borrowed lookup closes its context and disconnects without closing the owner', async () => {
  const events = [], browser = { disconnect: () => events.push('disconnect'), close: () => { throw Error('owner closed'); } };
  const context = { close: async () => events.push('context-close') };
  const session = await openPartyLookupBrowser({ href: 'http://127.0.0.1:1', env: {}, propertyCode: 'HRDAV', chromium: {},
    makeConnector: () => ({ connect: async () => browser, close: async () => false }),
    createContext: async () => context, installGuard: () => { throw Error('unexpected guard'); },
  });
  await session.close();
  assert.deepEqual(events, ['context-close', 'disconnect']);
});

test('failure to install the guard closes the owned context before returning an error', async () => {
  const context = {};
  let closed = false;
  await assert.rejects(openPartyLookupBrowser({ href: 'http://127.0.0.1:1', env: {}, propertyCode: 'HRCEN', chromium: {},
    makeConnector: () => ({ connect: async () => ({}), close: async value => { assert.equal(value, context); closed = true; return true; } }),
    createContext: async () => context, installGuard: async () => { throw Error('guard failed'); },
  }), /guard failed/);
  assert.equal(closed, true);
});

test('a timed-out context is closed if the browser creates it later', async () => {
  const events = [];
  let finish;
  const delayed = new Promise(resolve => { finish = resolve; });
  const opening = openPartyLookupBrowser({ href: 'http://127.0.0.1:1', env: {}, propertyCode: 'HRCEN', chromium: {},
    contextTimeoutMs: 10,
    makeConnector: () => ({ connect: async () => ({ disconnect: () => events.push('disconnect') }),
      close: async () => false }),
    createContext: () => delayed, installGuard: () => { throw Error('unexpected guard'); },
  });
  await assert.rejects(opening, /CONTEXT_TIMEOUT/);
  finish({ close: async () => { events.push('late-context-close'); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['disconnect', 'late-context-close']);
});

test('a real fallback context blocks a native Save before it reaches the server', async () => {
  const require = createRequire(new URL('../stagehand/package.json', import.meta.url));
  const chromium = require('playwright').chromium;
  let requests = 0;
  const endpoint = createServer((_request, response) => { requests += 1; response.end('unexpected'); });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  const env = process.env.HMS_TEST_CHROMIUM_PATH
    ? { HMS_CHROMIUM_EXECUTABLE_PATH: process.env.HMS_TEST_CHROMIUM_PATH } : {};
  let session;
  try {
    session = await openPartyLookupBrowser({ href: 'http://127.0.0.1:1', env, propertyCode: 'HRCEN', chromium,
      makeConnector: options => createQuoteBrowserConnector({ ...options, prepare: async () => {},
        chromium: { connectOverCDP: async () => { throw Error('connect ECONNREFUSED'); },
          launchServer: value => chromium.launchServer(value), connect: (url, value) => chromium.connect(url, value) } }),
    });
    const page = await session.context.newPage();
    await assert.rejects(page.goto(`http://127.0.0.1:${endpoint.address().port}/web/base/OSRESV.HDR?pageaction=SAVE`));
    assert.equal(requests, 0);
  } finally {
    await session?.close();
    await new Promise(resolve => endpoint.close(resolve));
  }
});
