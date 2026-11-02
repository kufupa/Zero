import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import {
  isGuardedContext, isGuardedPage, prepareGuardedContext,
} from '../tooling/hms-cloud/pre-navigation-context-guard.mjs';

function fixture() {
  let pages: unknown[] = [], workers: unknown[] = [];
  const context = {
    _options: { serviceWorkers: 'block' },
    pages: () => pages,
    serviceWorkers: () => workers,
    routeWebSocket: vi.fn(async (_pattern: string, _handler: (socket: any) => Promise<void>) => {}),
  };
  const page = { context: () => context };
  return {
    context, page,
    setPages: (next: unknown[]) => { pages = next; },
    setWorkers: (next: unknown[]) => { workers = next; },
    handler: () => context.routeWebSocket.mock.calls[0]![1],
  };
}

describe('pre-navigation guarded context', () => {
  it('attests setup before the first page and checks sole-page identity', async () => {
    const f = fixture();
    expect(isGuardedContext(f.context)).toBe(false);
    await prepareGuardedContext(f.context);
    expect(f.context.routeWebSocket).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(isGuardedContext(f.context)).toBe(true);
    expect(isGuardedPage(f.page)).toBe(false);
    f.setPages([f.page]);
    expect(isGuardedPage(f.page)).toBe(true);
    f.setPages([{}]);
    expect(isGuardedPage(f.page)).toBe(false);
    f.setPages([f.page, {}]);
    expect(isGuardedPage(f.page)).toBe(false);
    f.setPages([f.page]);
    expect(isGuardedPage(f.page)).toBe(false);
  });

  it('rejects unsupported or nonempty contexts and never retries the same object', async () => {
    for (const mode of ['page', 'worker', 'config', 'no-route', 'broken-inspection']) {
      const f = fixture();
      if (mode === 'page') f.setPages([f.page]);
      if (mode === 'worker') f.setWorkers([{}]);
      if (mode === 'config') f.context._options.serviceWorkers = 'allow';
      if (mode === 'no-route') f.context.routeWebSocket = undefined as any;
      if (mode === 'broken-inspection') f.context.pages = () => { throw new Error('closed'); };
      await expect(prepareGuardedContext(f.context)).rejects.toThrow('HMS_CONTEXT_UNSAFE');
      f.setPages([]); f.setWorkers([]); f.context._options.serviceWorkers = 'block';
      await expect(prepareGuardedContext(f.context)).rejects.toThrow('HMS_CONTEXT_UNSAFE');
      expect(isGuardedContext(f.context)).toBe(false);
    }
    await expect(prepareGuardedContext(null as any)).rejects.toThrow('HMS_CONTEXT_UNSAFE');
  });

  it('does not attest after a failed or partially installed route', async () => {
    const f = fixture();
    f.context.routeWebSocket.mockRejectedValueOnce(new Error('route failed'));
    await expect(prepareGuardedContext(f.context)).rejects.toThrow('route failed');
    await expect(prepareGuardedContext(f.context)).rejects.toThrow('HMS_CONTEXT_UNSAFE');
    expect(f.context.routeWebSocket).toHaveBeenCalledOnce();
    expect(isGuardedContext(f.context)).toBe(false);
  });

  it('rejects a page, worker, configuration change or route replacement during setup', async () => {
    for (const mode of ['page', 'worker', 'config', 'route']) {
      const f = fixture();
      f.context.routeWebSocket.mockImplementationOnce(async () => {
        if (mode === 'page') f.setPages([f.page]);
        if (mode === 'worker') f.setWorkers([{}]);
        if (mode === 'config') f.context._options.serviceWorkers = 'allow';
        if (mode === 'route') f.context.routeWebSocket = vi.fn(async () => {});
      });
      await expect(prepareGuardedContext(f.context)).rejects.toThrow('HMS_CONTEXT_UNSAFE');
      expect(isGuardedContext(f.context)).toBe(false);
    }
  });

  it('closes routed sockets without connecting to the server', async () => {
    const f = fixture();
    await prepareGuardedContext(f.context);
    const close = vi.fn(async () => {}), connectToServer = vi.fn();
    await f.handler()({ close, connectToServer });
    expect(close).toHaveBeenCalledOnce();
    expect(connectToServer).not.toHaveBeenCalled();
    expect(isGuardedContext(f.context)).toBe(true);
  });

  it('holds attestation while close is pending and fails closed if closing rejects or throws', async () => {
    const pending = fixture();
    await prepareGuardedContext(pending.context);
    let finish!: () => void;
    const closing = pending.handler()({ close: () => new Promise<void>((resolve) => { finish = resolve; }) });
    expect(isGuardedContext(pending.context)).toBe(false);
    finish(); await closing;
    expect(isGuardedContext(pending.context)).toBe(true);
    for (const close of [() => { throw new Error('failed'); }, async () => { throw new Error('failed'); }]) {
      const f = fixture();
      await prepareGuardedContext(f.context);
      await f.handler()({ close });
      expect(isGuardedContext(f.context)).toBe(false);
      await f.handler()({ close: async () => {} });
      expect(isGuardedContext(f.context)).toBe(false);
    }
  });

  it('rejects observable guard changes and malformed objects without throwing', async () => {
    for (const mode of ['worker', 'config', 'route', 'inspection']) {
      const f = fixture();
      await prepareGuardedContext(f.context);
      const originalRoute = f.context.routeWebSocket, originalPages = f.context.pages;
      if (mode === 'worker') f.setWorkers([{}]);
      if (mode === 'config') f.context._options.serviceWorkers = 'allow';
      if (mode === 'route') f.context.routeWebSocket = vi.fn(async () => {});
      if (mode === 'inspection') f.context.pages = () => { throw new Error('closed'); };
      expect(isGuardedContext(f.context)).toBe(false);
      f.setWorkers([]); f.context._options.serviceWorkers = 'block';
      f.context.routeWebSocket = originalRoute; f.context.pages = originalPages;
      expect(isGuardedContext(f.context)).toBe(false);
    }
    expect(isGuardedContext(null)).toBe(false);
    expect(isGuardedPage({ context: () => { throw new Error('closed'); } })).toBe(false);
  });

  it('rejects concurrent setup instead of attesting a second attempt', async () => {
    const f = fixture();
    let finish!: () => void;
    f.context.routeWebSocket.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = prepareGuardedContext(f.context);
    await expect(prepareGuardedContext(f.context)).rejects.toThrow('HMS_CONTEXT_UNSAFE');
    finish(); await first;
    expect(f.context.routeWebSocket).toHaveBeenCalledOnce();
    expect(isGuardedContext(f.context)).toBe(true);
  });
});

// Match the server's other optional Chromium integration tests.
const chromiumBinary = [
  process.env.HMS_TEST_CHROMIUM_PATH,
  chromium.executablePath(),
  '/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  '/home/orca/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',
].find((candidate): candidate is string => typeof candidate === 'string' && existsSync(candidate));

// This uses only a loopback HTTP/WebSocket endpoint. It never contacts HMS.
it.skipIf(!chromiumBinary)('blocks an actual browser WebSocket before it reaches the server', async () => {
  let upgrades = 0;
  const server = createServer((_request, response) => response.end('synthetic guard test'));
  server.on('upgrade', (_request, socket) => { upgrades += 1; socket.destroy(); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  let browser: Browser | undefined, context: BrowserContext | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('LOCAL_TEST_SERVER_UNAVAILABLE');
    browser = await chromium.launch({ executablePath: chromiumBinary, headless: true });
    context = await browser.newContext({ serviceWorkers: 'block' });
    await prepareGuardedContext(context);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const closed = await page.evaluate((url) => new Promise<boolean>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error('WEBSOCKET_CLOSE_TIMEOUT')), 10_000);
      socket.onerror = () => {};
      socket.onclose = () => { clearTimeout(timer); resolve(true); };
    }), `ws://127.0.0.1:${address.port}/test`);
    expect(closed).toBe(true);
    expect(upgrades).toBe(0);
    await vi.waitFor(() => expect(isGuardedPage(page)).toBe(true), { timeout: 2_000 });
  } finally {
    try { await context?.close(); }
    finally {
      try { await browser?.close(); }
      finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
    }
  }
}, 20_000);
