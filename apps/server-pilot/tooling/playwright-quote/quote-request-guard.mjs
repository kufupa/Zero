// Fail-closed request policy for the native Hotel Availability reader.
// This uses only existing reviewed login/shell rules. Hotel Availability's
// inquiry bodies have not yet been reviewed by the canonical policy.
import { attachBorrowedSession, newBorrowedContext } from './session-reuse.mjs';

const SHELL_RULES = new Set([
  'live-login-get',
  'live-common-get',
  'live-login-post',
  'live-bsstrt',
  'live-bsstrt-hdr',
]);

async function loadCanonicalPolicy() {
  try {
    const [manifest, policy, origins] = await Promise.all([
      import('../../dist/hms/live-read-manifest.js'),
      import('../../dist/hms/request-policy.js'),
      import('../../dist/hms/browser-artifacts.js'),
    ]);
    return { ...manifest, ...policy, ...origins };
  } catch {
    // A source checkout must be built before the CLI can use the canonical
    // policy. Never fall back to the permissive legacy availability guard.
    throw new Error('HMS_QUOTE_CANONICAL_POLICY_UNAVAILABLE');
  }
}

/** Bind the reviewed subset to the configured property, tenant and HMS origin. */
export async function prepareQuoteRequestPolicy({ secret, property, modules }) {
  const canonical = modules ?? await loadCanonicalPolicy();
  if (!property?.active || secret?.expectedPropertyCode !== property.propertyCode ||
      secret.expectedTenant !== property.expectedTenant ||
      secret.expectedPropertyName !== property.expectedPropertyName ||
      secret.username !== property.username) {
    throw new Error('HMS_QUOTE_POLICY_PROPERTY_MISMATCH');
  }
  let loginUrl;
  try { loginUrl = new URL(secret.loginUrl); } catch { throw new Error('HMS_QUOTE_POLICY_ORIGIN_MISMATCH'); }
  const origin = canonical.hmsProductionOriginForSlot(property.browserSlot);
  if (!origin || loginUrl.protocol !== 'https:' || loginUrl.username || loginUrl.password || loginUrl.origin !== origin) {
    throw new Error('HMS_QUOTE_POLICY_ORIGIN_MISMATCH');
  }
  const full = canonical.buildLiveGuestStayReadManifest(origin);
  const chromeIds = new Set(canonical.buildLiveGuestStayChromeGetRules(origin).map((rule) => rule.id));
  const rules = full.rules.filter((rule) => chromeIds.has(rule.id) || SHELL_RULES.has(rule.id));
  const login = rules.find((rule) => rule.id === 'live-login-post');
  if (!login || login.fixedBody.tenant !== secret.expectedTenant || rules.some((rule) => rule.origin !== origin)) {
    throw new Error('HMS_QUOTE_POLICY_TENANT_UNREVIEWED');
  }
  if (typeof canonical.enforceRequestPolicy !== 'function') throw new Error('HMS_QUOTE_CANONICAL_POLICY_UNAVAILABLE');
  return { manifest: { rules }, enforce: canonical.enforceRequestPolicy };
}

/** Install before any page exists. A block terminates this owned context. */
export async function installQuoteRequestGuard(context, policy) {
  let failure = null;
  let closing = null;
  let pageAllowance = 1; // attachBorrowedSession creates an inert blank page.
  const mark = (reason) => { if (!failure) failure = typeof reason === 'string' && /^[a-z_]+$/.test(reason) ? reason : 'guard_error'; };
  const close = () => {
    if (!closing) closing = Promise.resolve().then(() => context.close()).catch(() => {});
    return closing;
  };
  const abort = async (route) => { try { await route.abort('blockedbyclient'); } catch {} };
  const stop = (reason) => { mark(reason); void close(); };

  if (typeof context.route !== 'function' || typeof context.routeWebSocket !== 'function' || typeof context.on !== 'function') {
    throw new Error('HMS_QUOTE_POLICY_CONTEXT_UNSUPPORTED');
  }
  await context.routeWebSocket('**/*', (socket) => {
    mark('websocket');
    try { Promise.resolve(socket.close()).catch(() => {}); } catch {}
    void close();
  });
  context.on('page', (page) => {
    page.on('download', (download) => {
      mark('download');
      try { Promise.resolve(download.cancel()).catch(() => {}); } catch {}
      void close();
    });
    if (pageAllowance > 0 && !failure) { pageAllowance -= 1; return; }
    try { Promise.resolve(page.close()).catch(() => {}); } catch {}
    stop('popup');
  });

  await context.route('**/*', async (route) => {
    if (failure) return abort(route);
    // Playwright invokes route handlers only for the first URL in a redirect
    // chain. Fetch a canonical-approved request with redirects disabled and
    // abort every 3xx response before the browser can follow it.
    const guardedRoute = {
      request: () => route.request(),
      abort: (code) => route.abort(code),
      continue: async () => {
        if (failure) return abort(route);
        let response;
        try { response = await route.fetch({ maxRedirects: 0, maxRetries: 0 }); }
        catch { mark('transport_error'); await abort(route); await close(); return; }
        if (failure) return abort(route);
        if (response.status() >= 300 && response.status() < 400) {
          mark('unreviewed_redirect');
          await abort(route);
          await close();
          return;
        }
        await route.fulfill({ response });
      },
    };
    try {
      const decision = await policy.enforce(guardedRoute, policy.manifest, {
        onDecision: (value) => { if (value?.action !== 'allow') mark(value?.code); },
      });
      if (decision.action !== 'allow') { mark(decision.code); await close(); }
    } catch {
      mark('guard_error');
      await abort(route);
      await close();
    }
  });

  return {
    permitLeasePage() {
      if (failure || pageAllowance !== 0) throw new Error('HMS_QUOTE_POLICY_PAGE_STATE');
      pageAllowance = 1;
    },
    failureError() { return failure ? new Error(`HMS_QUOTE_POLICY_BLOCKED_${failure}`) : null; },
    assertActive() { const error = this.failureError(); if (error) throw error; },
  };
}

/** Guard the freshly created context before the attach helper creates any page. */
export async function attachGuardedQuoteSession({ href, env, connectOverCDP, policy,
  attach = attachBorrowedSession, createContext = newBorrowedContext }) {
  let guard, attached, createdContext;
  try {
    attached = await attach({
      href, env, connectOverCDP,
      newContext: async (browser, options, nextEnv) => {
        if (options?.serviceWorkers !== 'block' || options.acceptDownloads !== false) {
          throw new Error('HMS_QUOTE_POLICY_CONTEXT_UNSAFE');
        }
        if (createdContext) {
          try { await createdContext.close(); }
          catch { throw new Error('HMS_QUOTE_CONTEXT_CLEANUP_UNPROVEN'); }
          createdContext = null;
        }
        const context = await createContext(browser, options, nextEnv);
        createdContext = context;
        try { guard = await installQuoteRequestGuard(context, policy); return context; }
        catch (error) { await context.close().catch(() => {}); throw error; }
      },
    });
    guard.assertActive();
    await attached.page.close();
    guard.permitLeasePage();
    return { ...attached, guard };
  } catch (error) {
    let cleanupFailed = false;
    if (attached?.context ?? createdContext) {
      try { await (attached?.context ?? createdContext).close(); } catch { cleanupFailed = true; }
    }
    if (attached?.browser) {
      try { await attached.browser.close(); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw new Error('HMS_QUOTE_CONTEXT_CLEANUP_UNPROVEN');
    throw error;
  }
}
