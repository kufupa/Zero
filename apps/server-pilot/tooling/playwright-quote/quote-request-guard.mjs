// Fail-closed request policy for the native Hotel Availability reader.
// Login/shell uses the canonical policy; Hotel Availability has its own
// narrowly reviewed read-only screen and inquiry signatures.
import { attachBorrowedSession, newBorrowedContext } from './session-reuse.mjs';
import { randomUUID } from 'node:crypto';
import { availabilityScreenRules, isReviewedAvailabilityInquiry } from './quote-availability-policy.mjs';

const SHELL_RULES = new Set([
  'live-login-get',
  'live-common-get',
  'live-login-post',
  'live-bsstrt',
  'live-bsstrt-hdr',
]);

// The HMS login page loads an optional ServiceNow helper from a third party.
// Never fetch it or let it execute; its refusal need not abort the HMS page.
function optionalExternalScript(request) {
  try {
    return request.method() === 'GET' && request.resourceType() === 'script' &&
      new URL(request.url()).origin === 'https://inforsaas.service-now.com';
  } catch { return false; }
}

async function loadCanonicalPolicy() {
  try {
    // A namespaced loader follows the checked-out TypeScript graph instead of
    // silently using a stale build in dist. The CLI still starts with plain node.
    const { register } = await import('tsx/esm/api');
    const loader = register({ namespace: `nava-quote-policy-${randomUUID()}` });
    try {
      const [manifest, policy, origins] = await Promise.all([
        loader.import('../../src/hms/live-read-manifest.ts', import.meta.url),
        loader.import('../../src/hms/request-policy.ts', import.meta.url),
        loader.import('../../src/hms/browser-artifacts.ts', import.meta.url),
      ]);
      return { ...manifest, ...policy, ...origins };
    } finally {
      await loader.unregister();
    }
  } catch {
    // No loader or source is a hold, never a permissive legacy fallback.
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
  const rules = [
    ...full.rules.filter((rule) => chromeIds.has(rule.id) || SHELL_RULES.has(rule.id)),
    ...availabilityScreenRules(origin),
  ];
  const login = rules.find((rule) => rule.id === 'live-login-post');
  if (!login || login.fixedBody.tenant !== secret.expectedTenant || rules.some((rule) => rule.origin !== origin)) {
    throw new Error('HMS_QUOTE_POLICY_TENANT_UNREVIEWED');
  }
  if (typeof canonical.enforceRequestPolicy !== 'function' || typeof canonical.rejectDuplicateJsonBodyKeys !== 'function')
    throw new Error('HMS_QUOTE_CANONICAL_POLICY_UNAVAILABLE');
  return { manifest: { rules }, enforce: canonical.enforceRequestPolicy, origin,
    propertyCode: property.propertyCode, rejectDuplicateJsonBodyKeys: canonical.rejectDuplicateJsonBodyKeys };
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
    if (optionalExternalScript(route.request())) return abort(route);
    // Unreviewed decorative images are not fetched. Their absence should not
    // terminate an otherwise valid availability read.
    try {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === 'GET' && request.resourceType() === 'image' && url.origin === policy.origin &&
          !url.search && !url.hash && /^\/web\/resources\/inforhms\/images\/[A-Za-z0-9_./-]+\.(?:svg|png|gif)$/i.test(url.pathname) &&
          !policy.manifest.rules.some((rule) => rule.method === 'GET' && rule.path === url.pathname && rule.resourceTypes.includes('image')))
        return abort(route);
    } catch { /* Canonical policy rejects malformed URLs. */ }
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
      if (isReviewedAvailabilityInquiry(route.request(), policy)) {
        await guardedRoute.continue();
        return;
      }
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
