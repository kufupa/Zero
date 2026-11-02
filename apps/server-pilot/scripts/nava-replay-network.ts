/** Browser-context network fence for fake-Outlook replay. */
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { installWriteGuard, type BlockedWrite, type ReplayPreparePolicy } from './nava-preview-run';

export type BlockedReplayNetwork = { path: string; reason: 'origin' | 'method' | 'native' | 'auth' | 'other_page' | 'websocket' | 'endpoint' | 'redirect' | 'upstream' };

const protectedPages = new WeakMap<BrowserContext, { page: Page; origin: string }>();

/** Only the designated page in a newly fenced context may host the fake bridge. */
export function isProtectedReplayPage(page: Page, origin: string): boolean {
  const protectedPage = protectedPages.get(page.context());
  return protectedPage?.page === page && protectedPage.origin === origin;
}

/** Create a fresh isolated context before any page or socket can make a request. */
export async function createReplayPage(
  browser: Browser,
  origin: string,
  blocked: BlockedReplayNetwork[],
  blockedTrpc: BlockedWrite[],
  options: { allowHmsReads?: boolean; preparePolicy?: ReplayPreparePolicy; contextOptions?: Omit<BrowserContextOptions, 'serviceWorkers'>; syntheticLoopback?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ...options.contextOptions, serviceWorkers: 'block', acceptDownloads: false });
  let page: Page | undefined;
  try {
    // Page-specific routes run first. Other pages and requests with unknown ownership fail closed.
    await context.route('**/*', async (route) => {
      let owner: Page | null = null;
      try { owner = route.request().frame().page(); } catch { /* service worker or unknown frame */ }
      if (!page || owner !== page) {
        let path = '(unknown)';
        try { path = new URL(route.request().url()).pathname; } catch { /* invalid URL */ }
        blocked.push({ path, reason: 'other_page' });
        await route.abort('blockedbyclient');
        return;
      }
      // Playwright routes only the first URL in a redirect chain. Fetch the
      // already-guarded request without following redirects, then never expose
      // a redirect response to Chromium, including same-origin 307/308 writes.
      try {
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30_000 });
        try {
          if (response.status() >= 300 && response.status() < 400) {
            blocked.push({ path: new URL(route.request().url()).pathname, reason: 'redirect' });
            await route.abort('blockedbyclient');
          } else {
            await route.fulfill({ response });
          }
        } finally {
          await response.dispose();
        }
      } catch {
        let path = '(unknown)';
        try { path = new URL(route.request().url()).pathname; } catch { /* invalid URL */ }
        blocked.push({ path, reason: 'upstream' });
        await route.abort('blockedbyclient').catch(() => {});
      }
    });
    await context.routeWebSocket('**/*', async (socket) => {
      let path = '(unknown)';
      try { path = new URL(socket.url()).pathname; } catch { /* invalid URL */ }
      blocked.push({ path, reason: 'websocket' });
      await socket.close();
    });
    page = await context.newPage();
    protectedPages.set(context, { page, origin });
    await installReplayNetworkFence(page, origin, blocked, blockedTrpc, options);
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function installReplayNetworkFence(
  page: Page,
  origin: string,
  blocked: BlockedReplayNetwork[],
  blockedTrpc: BlockedWrite[],
  options: { allowHmsReads?: boolean; preparePolicy?: ReplayPreparePolicy; syntheticLoopback?: boolean } = {},
): Promise<void> {
  if (!isProtectedReplayPage(page, origin)) throw new Error('Replay requires a newly created protected browser context');
  const parsed = new URL(origin);
  if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error('Replay requires an exact http(s) origin');
  if (options.syntheticLoopback && (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'))
    throw new Error('Synthetic replay assets require a loopback origin');
  // Playwright calls newer routes first: origin fence, then the installed tRPC guard.
  // Install the synthetic bridge last so its bootstrap/ticket intercepts both.
  await installWriteGuard(page, blockedTrpc, options.allowHmsReads, options.preparePolicy);
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let reason: BlockedReplayNetwork['reason'] | null = null;
    if (url.origin !== origin) reason = 'origin';
    else if (url.pathname.startsWith('/api/outlook/native/')) reason = 'native';
    else if (url.pathname === '/api/auth/get-session' && request.method() === 'GET') {
      await route.fallback();
      return;
    } else if (url.pathname.startsWith('/api/auth/')) reason = 'auth';
    else if (url.pathname.startsWith('/api/trpc/')) {
      await route.fallback();
      return;
    } else if (request.method() !== 'GET' && request.method() !== 'HEAD') reason = 'method';
    else if (url.pathname === '/api' || url.pathname.startsWith('/api/')) reason = 'endpoint';
    else if (!options.syntheticLoopback && url.pathname !== '/outlook-pane' &&
      url.pathname !== '/favicon.ico' && !url.pathname.startsWith('/_next/static/')) reason = 'endpoint';
    if (reason) {
      blocked.push({ path: url.pathname, reason });
      await route.abort('blockedbyclient');
      return;
    }
    await route.fallback();
  });
}
