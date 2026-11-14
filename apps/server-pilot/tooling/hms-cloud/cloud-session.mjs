// Each Cloud read owns its browser and starts on the authenticated landing property.
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import postgres from 'postgres';
import { login } from '../playwright-quote/session-reuse.mjs';
import { openGuestStayScreen } from '../playwright-quote/open-guest-stay.mjs';
import { assertNoCenturionBrowserHold } from '../playwright-quote/centurion-stay360.mjs';
import { getPropertyRegistration, validateHmsPropertySecret } from './property-registry.mjs';

const readPosts = new Set([
  '/web/base/BSSTRT', '/web/base/BSSTRT.HDR', '/web/base/OSRESS', '/web/base/OSRESS.search',
  '/web/base/OSRESV', '/web/base/OSRESV.LST', '/web/base/OSRESV.HDR', '/web/base/OSRESV.xmlhttp',
  '/web/base/OSRESV.GDT', '/web/base/OSRESV.GST', '/web/base/OSRESV.NOT', '/web/base/OSRESV.REM',
  '/web/base/OSRESV.FOL', '/web/base/OSRESV.FOL.xmlhttp', '/web/base/OSRESV.RAN',
  '/web/base/OSRESV.DOC', '/web/base/OSRESV.DOC.xmlhttp', '/web/base/OSRESV.NTE',
  '/web/base/OSRESV.MSG', '/web/base/OSRESV.HDR.getChildAges', '/web/base/LOVPOP',
  '/web/base/GRIDDATA', '/web/base/GETCACHE', '/web/base/BSMSLV', '/web/base/OSRASD',
  '/web/base/OSMPAV', '/web/base/OSMPAV.HDR', '/web/base/FSGSPF', '/web/base/FSGSPF.HDR',
  '/web/base/FSGSPF.LST', '/web/base/FSGSPF.xmlhttp', '/web/jsp/7iosress_getstaydata.jsp',
  '/api/internalBooking/rateshop/inquiryForGrid', '/api/internalBooking/hotelAvail/inquiryForGrid',
]);
const forbiddenPath = /(?:save|delete|update|upload|cancel|duplicate|checkin|checkout|postcharge|sendemail|rateSelection|getcheckavailability|rateplanchange|changeguaranteemethod|hmsvault|payments)/i;
const forbiddenAction = /^(?:save|delete|update|cancel|duplicate|checkin|checkout|insert|commit|create|submit|post|amend|book|confirm|upload|send|autosave)/i;
const writeFlags = /^(?:newprofileclick|confirmnewguestprofile|confirminactiveguestprofile|createinactiveprofileflag|linkprofileflag|savecctoprofile|savesettlementcctoprofile)$/i;
const actionKey = /^(?:pageaction|action|autosave)$/i;
const headerFields = new Set(['system_function_name', 'user_function_name', 'current_tab_name',
  'confirmationnumber', 'reservationstayid', 'propertycode', 'guestfullname', 'account', 'guestid',
  'hoteldate', 'lastname', 'firstname', 'twitterid', 'facebookid', 'tripadvisorid', 'bookingdotcomid',
  'room', 'menu_module_key', 'removescreenflows', 'only_data_required', 'scrollrow']);
const sessionState = new WeakMap();
const credentialLeases = new WeakMap();
const retainedLeases = new Set();

function registeredProperty(code) {
  const property = typeof code === 'string' ? getPropertyRegistration(code) : null;
  if (!property?.active) throw new Error('HMS_PROPERTY_REQUIRED');
  return property;
}

function validateSecret(property, raw, transportId) {
  const secret = raw && typeof raw === 'object' && !Array.isArray(raw) && 'secret' in raw ? raw.secret : raw;
  const landing = registeredProperty(property.landingPropertyCode);
  if (!secret || typeof secret !== 'object' || Array.isArray(secret)) throw new Error('HMS_CREDENTIALS_INVALID');
  for (const key of ['loginUrl', 'username', 'password', 'expectedTenant', 'expectedPropertyCode', 'expectedPropertyName']) {
    if (typeof secret[key] !== 'string' || !secret[key]) throw new Error('HMS_CREDENTIALS_INVALID');
  }
  validateHmsPropertySecret(transportId === undefined ? landing : { ...landing, transportId }, secret);
  let url;
  try { url = new URL(secret.loginUrl); } catch { throw new Error('HMS_TARGET_MISMATCH'); }
  if (url.origin !== property.origin || url.username || url.password || url.hash ||
      url.pathname !== '/web/base/logindisp' || url.searchParams.getAll('tenant').length !== 1 ||
      url.searchParams.get('tenant') !== property.expectedTenant || landing.group !== property.group ||
      landing.expectedTenant !== property.expectedTenant || landing.origin !== property.origin) {
    throw new Error('HMS_TARGET_MISMATCH');
  }
  return secret;
}

async function loadCloudSecret({ secretArn, signal }) {
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'af-south-1' });
  try {
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn }), { abortSignal: signal });
    if (!result.SecretString) throw new Error('empty');
    return JSON.parse(result.SecretString);
  } catch {
    signal?.throwIfAborted();
    throw new Error('HMS_CREDENTIALS_UNAVAILABLE');
  } finally { client.destroy(); }
}

function decoded(value) {
  let result = String(value ?? '');
  for (let i = 0; i < 3; i += 1) {
    try { const next = decodeURIComponent(result.replace(/\+/g, ' ')); if (next === result) break; result = next; }
    catch { break; }
  }
  return result;
}

function hasWriteIntent(value) {
  const text = decoded(value);
  if (/(?:[?&;{,\s]|^)["']?(?:pageaction|action|autosave)["']?\s*(?:=|:)\s*["']?\s*(?:save|delete|update|cancel|duplicate|checkin|checkout|insert|commit|create|submit|post|amend|book|confirm|upload|send)/i.test(text)) return true;
  const visit = (data) => data && typeof data === 'object' && Object.entries(data).some(([key, entry]) =>
    (actionKey.test(key) && forbiddenAction.test(String(entry).trim())) ||
    (writeFlags.test(key) && !['', '0', 'false', '-'].includes(String(entry).trim().toLowerCase())) || visit(entry));
  try { if (visit(JSON.parse(text))) return true; } catch { /* Form payloads are handled below. */ }
  for (const [key, entry] of new URLSearchParams(text)) {
    if ((actionKey.test(key) && forbiddenAction.test(entry.trim())) ||
        (writeFlags.test(key) && !['', '0', 'false', '-'].includes(entry.trim().toLowerCase()))) return true;
  }
  return false;
}

function safeHeaderRead(url, body, propertyCode) {
  if (url.search) return false;
  const entries = [...new URLSearchParams(body)];
  const keys = entries.map(([key]) => key.toLowerCase());
  if (new Set(keys).size !== keys.length || keys.some((key) => !headerFields.has(key))) return false;
  const fields = new Map(entries.map(([key, value]) => [key.toLowerCase(), value]));
  if (fields.get('system_function_name') !== 'OSRESV' || fields.get('user_function_name') !== 'OSRESV' ||
      fields.get('current_tab_name') !== 'HDR' ||
      (fields.get('propertycode') && fields.get('propertycode') !== propertyCode)) return false;
  const blank = ['confirmationnumber', 'reservationstayid', 'guestid', 'guestfullname', 'account', 'firstname', 'lastname']
    .every((key) => !fields.get(key));
  return blank || Boolean(fields.get('confirmationnumber') && fields.get('propertycode'));
}

async function installCloudReadGuard(context, property, state) {
  if (typeof context.routeWebSocket !== 'function') throw new Error('HMS_SOCKET_GUARD_UNAVAILABLE');
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    let url;
    try { url = new URL(request.url()); } catch { return route.abort(); }
    const body = request.postData() ?? '';
    const path = decoded(url.pathname);
    if (url.username || url.password || forbiddenPath.test(path) || hasWriteIntent(request.url()) || hasWriteIntent(body) ||
        !['GET', 'HEAD', 'OPTIONS', 'POST'].includes(method)) return route.abort();
    if (request.isNavigationRequest() && url.origin !== property.origin) return route.abort();
    if (path === '/web/base/loadmain' && url.searchParams.has('defaultproperty')) {
      const requested = url.searchParams.getAll('defaultproperty');
      if (!state.switching || requested.length !== 1 || requested[0] !== state.switching) return route.abort();
    }
    if (!state.verified && path === '/web/base/loadmain') {
      const screen = url.searchParams.get('initpath');
      if (screen && screen !== 'BSSTRT') return route.abort();
    }
    if (!state.verified && (/^\/api\//i.test(path) || /^\/web\/base\/(?:OSRESV|OSRESS|OSRRAV|OSMPAV|FSGSPF)/i.test(path) ||
        (/^\/web\/jsp\//i.test(path) && path !== '/web/jsp/interfaceStatusAlert.jsp'))) return route.abort();
    if (method === 'POST') {
      if (url.origin !== property.origin) return route.abort();
      if (!state.verified && !['/web/base/login', '/web/base/BSSTRT', '/web/base/BSSTRT.HDR',
        '/web/base/LOVPOP', '/web/base/GRIDDATA', '/web/base/GETCACHE', '/web/base/BSMSLV'].includes(path)) return route.abort();
      if (path === '/web/base/login') {
        const params = new URLSearchParams(body);
        if (state.authenticated || params.get('tenant') !== property.expectedTenant ||
            params.get('SYSTEM_FUNCTION_NAME') !== 'LOGIN' || params.get('USER_FUNCTION_NAME') !== 'LOGIN') return route.abort();
      } else if (!readPosts.has(path) || (path === '/web/base/OSRESV.HDR' && !safeHeaderRead(url, body, property.propertyCode))) {
        return route.abort();
      }
      if (path === '/api/internalBooking/rateshop/inquiryForGrid' || path === '/api/internalBooking/hotelAvail/inquiryForGrid') {
        let inquiry;
        try { inquiry = JSON.parse(body); } catch { return route.abort(); }
        if (typeof inquiry?.propertyCodes !== 'string' || inquiry.propertyCodes.trim().toUpperCase() !== property.propertyCode) return route.abort();
      }
    }
    return route.fallback();
  });
}

async function installPostRedirectGuard(context) {
  await context.route('**/*', async (route) => {
    if (route.request().method().toUpperCase() !== 'POST') return route.fallback();
    try {
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30000 });
      if (response.status() >= 300 && response.status() < 400) return await route.abort();
      return await route.fulfill({ response });
    } catch {
      try { await route.abort(); } catch { /* A closed context has already terminated the request. */ }
    }
  });
}

/** Verify the native shell, not a property inferred from the caller or a business result. */
export async function verifyCloudProperty(page, { propertyCode, tenantId } = {}) {
  const property = registeredProperty(propertyCode);
  if (tenantId !== undefined && tenantId !== property.expectedTenant) throw new Error('HMS_TENANT_MISMATCH');
  const handle = await page.waitForFunction(({ expectedProperty, expectedTenant, expectedOrigin }) => {
    const visible = (el) => Boolean(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    if (location.origin !== expectedOrigin || [...document.querySelectorAll('input[name="password"], input[type="password"], .x-mask, .x-mask-msg, .x-loadmask, [aria-busy="true"]')].some(visible)) return false;
    const app = window.EAM?.AppData?.getRawAppData?.() ?? {};
    const html = document.documentElement.outerHTML;
    const tenant = app.tenantid ?? document.documentElement.dataset.tenant ?? /"tenantid"\s*:\s*"([^"]+)"/i.exec(html)?.[1] ?? new URL(location.href).searchParams.get('tenant');
    const controls = [...document.querySelectorAll('.switchproperty, input[name="property"]')].filter(visible);
    const nativeCodes = controls.map((el) => (el.value || el.textContent || '').trim()).filter(Boolean);
    if (app.property) nativeCodes.push(String(app.property).trim());
    const titleCode = /Infor HMS\s*-\s*([A-Z0-9]+)/i.exec(document.title)?.[1];
    if (titleCode) nativeCodes.push(titleCode);
    if (tenant !== expectedTenant || !nativeCodes.length || nativeCodes.some((code) => code !== expectedProperty)) return false;
    const name = app.propertyname ?? app.propertyName ?? app.propertydescription ?? null;
    return { propertyCode: expectedProperty, tenantId: expectedTenant, origin: expectedOrigin,
      observedName: typeof name === 'string' && name.trim() ? name.trim() : null };
  }, { expectedProperty: property.propertyCode, expectedTenant: property.expectedTenant, expectedOrigin: property.origin }, { timeout: 30000 });
  try { return await handle.jsonValue(); } finally { await handle.dispose(); }
}

/** Select the native property row and wait for the shell to confirm the new code. */
export async function switchCloudProperty(page, { propertyCode, landingPropertyCode, tenantId } = {}) {
  const target = registeredProperty(propertyCode);
  const landing = registeredProperty(landingPropertyCode);
  if (target.landingPropertyCode !== landing.propertyCode || target.group !== landing.group ||
      target.expectedTenant !== landing.expectedTenant || target.origin !== landing.origin ||
      (tenantId !== undefined && tenantId !== target.expectedTenant)) throw new Error('HMS_PROPERTY_SWITCH_REFUSED');
  const before = await verifyCloudProperty(page, { propertyCode: landing.propertyCode, tenantId });
  if (target.propertyCode === landing.propertyCode) return before;
  const state = sessionState.get(page.context());
  const button = page.locator('.switchproperty:visible').first();
  await button.click();
  const popup = page.locator('.x-window[id^="gridpopup"]:visible').last();
  await popup.waitFor({ state: 'visible', timeout: 15000 });
  const rows = popup.locator('tr.x-grid-row:visible');
  await rows.first().waitFor({ state: 'visible', timeout: 15000 });
  let selected;
  let observedName = null;
  for (let i = 0; i < await rows.count(); i += 1) {
    const row = rows.nth(i);
    const cells = row.locator('td');
    if ((await cells.count()) < 2 || (await cells.nth(0).innerText()).trim() !== target.propertyCode) continue;
    if (selected) throw new Error('HMS_PROPERTY_SWITCH_AMBIGUOUS');
    selected = row;
    observedName = (await cells.nth(1).innerText()).trim() || null;
  }
  if (!selected) throw new Error('HMS_PROPERTY_SWITCH_UNAVAILABLE');
  await selected.click();
  await selected.waitFor({ state: 'visible', timeout: 5000 });
  if (!(await selected.evaluate((el) => el.classList.contains('x-grid-row-selected')))) throw new Error('HMS_PROPERTY_SWITCH_NOT_SELECTED');
  const ok = popup.locator('a.x-btn:visible, button:visible').filter({ hasText: /^\s*OK\s*$/ });
  if (await ok.count() !== 1) throw new Error('HMS_PROPERTY_SWITCH_AMBIGUOUS');
  if (state) state.switching = target.propertyCode;
  try {
    await ok.click();
    const identity = await verifyCloudProperty(page, { propertyCode: target.propertyCode, tenantId });
    return { ...identity, observedName: observedName ?? identity.observedName };
  } finally { if (state) state.switching = null; }
}

async function openStay360(page) {
  const node = (label) => page.locator('span.x-tree-node-text:visible')
    .filter({ hasText: new RegExp(`^${label}$`) });
  await page.locator('a.app-menu-trigger:visible').click();
  const frontDesk = node('Front Desk');
  await frontDesk.waitFor({ state: 'visible' });
  await frontDesk.scrollIntoViewIfNeeded({ timeout: 900 }).catch(() => {});
  await frontDesk.click();
  await page.waitForTimeout(800);
  const stay360 = node('Stay 360');
  await stay360.waitFor({ state: 'visible' });
  await stay360.scrollIntoViewIfNeeded({ timeout: 900 }).catch(() => {});
  await stay360.click();
  await page.locator('input[name="search"]:visible').first().waitFor();
}

async function runUntilAborted(operation, signal) {
  if (!signal) return operation();
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation(), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Canonical credentials shared by multiple properties use one advisory lock. */
export function cloudCredentialLeaseKey(propertyCode) {
  const property = registeredProperty(propertyCode);
  return createHash('sha256').update('zero/hms-credential-lease/v1\0')
    .update(property.credentialSecretRef).digest().readBigInt64BE(0).toString();
}

/** A dedicated connection holds one credential lock across all participating processes. */
export async function acquireCloudCredentialLease(propertyCode, { signal } = {}) {
  const property = registeredProperty(propertyCode);
  signal?.throwIfAborted();
  const loss = new AbortController();
  const acquisitionSignal = AbortSignal.any([loss.signal, AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
  const state = { ref: property.credentialSecretRef, released: false, borrowers: 0 };
  let client;
  let connection;
  let timer;
  let heartbeat;
  let acquired = false;
  let closing = false;
  const fail = () => { if (!closing && !loss.signal.aborted) loss.abort(new Error('HMS_CREDENTIAL_LEASE_LOST')); };
  const key = cloudCredentialLeaseKey(propertyCode);
  try {
    if (property.group === 'davinci') {
      if (!process.env.DATABASE_URL) throw new Error('HMS_CREDENTIAL_LEASE_DATABASE_REQUIRED');
      client = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 0, connect_timeout: 10,
        onclose: fail });
      connection = await runUntilAborted(() => client.reserve(), acquisitionSignal);
      while (!acquired) {
        const rows = await runUntilAborted(() => connection.unsafe('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [key]), acquisitionSignal);
        if (loss.signal.aborted) throw loss.signal.reason;
        acquired = rows[0]?.acquired === true;
        if (!acquired) await delay(250, undefined, { signal: acquisitionSignal });
      }
      signal?.throwIfAborted();
      const rows = await runUntilAborted(() => connection.unsafe('SELECT pg_backend_pid() AS pid'), acquisitionSignal);
      const pid = rows[0]?.pid;
      if (!Number.isInteger(pid) || loss.signal.aborted) throw new Error('HMS_CREDENTIAL_LEASE_LOST');
      timer = setInterval(() => {
        if (heartbeat || closing) return;
        heartbeat = Promise.race([
          connection.unsafe('SELECT pg_backend_pid() AS pid'),
          delay(10000, undefined, { ref: false }).then(() => { throw new Error('HMS_CREDENTIAL_LEASE_TIMEOUT'); }),
        ]).then((result) => {
          if (result[0]?.pid !== pid) fail();
        }, fail).finally(() => { heartbeat = undefined; });
      }, 5000);
      timer.unref?.();
    }
    const lease = Object.freeze({
      signal: loss.signal,
      async release() {
        if (state.released) return;
        if (state.borrowers) throw new Error('HMS_CREDENTIAL_LEASE_IN_USE');
        state.released = true;
        closing = true;
        if (timer) clearInterval(timer);
        let failed = loss.signal.aborted;
        const bounded = (work) => Promise.race([work, delay(5000, undefined, { ref: false }).then(() => {
          throw new Error('HMS_CREDENTIAL_LEASE_TIMEOUT');
        })]);
        try {
          if (heartbeat) await bounded(heartbeat);
          if (acquired && !failed) {
            const rows = await bounded(connection.unsafe('SELECT pg_advisory_unlock($1::bigint) AS released', [key]));
            if (rows[0]?.released !== true) failed = true;
          }
        } catch { failed = true; }
        try { await client?.end({ timeout: 5 }); } catch { failed = true; }
        if (failed) throw new Error('HMS_CREDENTIAL_LEASE_RELEASE_FAILED');
      },
    });
    credentialLeases.set(lease, state);
    return lease;
  } catch (error) {
    closing = true;
    if (timer) clearInterval(timer);
    try { await client?.end({ timeout: 5 }); } catch { throw new Error('HMS_CREDENTIAL_LEASE_RELEASE_FAILED'); }
    if (signal?.aborted) signal.throwIfAborted();
    if (error?.message === 'HMS_CREDENTIAL_LEASE_DATABASE_REQUIRED') throw error;
    throw new Error('HMS_CREDENTIAL_LEASE_UNAVAILABLE');
  }
}

export async function withCloudCredentialLease(propertyCode, operation, options = {}) {
  if (typeof operation !== 'function') throw new Error('HMS_CREDENTIAL_LEASE_OPTIONS_INVALID');
  const lease = await acquireCloudCredentialLease(propertyCode, options);
  try { return await operation(lease); } finally { await lease.release(); }
}

/** Fresh browser/context per operation; a caller-owned lease can span sequential sessions. */
export async function withCloudReadSession(operation, { propertyCode, transportId, signal, headless = true,
  prepareContext, startScreen = 'BSSTRT', loadSecret = loadCloudSecret, credentialLease } = {}) {
  const property = registeredProperty(propertyCode);
  if (typeof operation !== 'function' || typeof headless !== 'boolean' ||
      (transportId !== undefined && (typeof transportId !== 'string' || !property.transportIds.includes(transportId))) ||
      !['BSSTRT', 'OSRESV', 'OSRESS'].includes(startScreen) || typeof loadSecret !== 'function' ||
      (prepareContext !== undefined && typeof prepareContext !== 'function')) throw new Error('HMS_SESSION_OPTIONS_INVALID');
  let lease = credentialLease;
  let ownedLease = false;
  let leaseState;
  let borrowed = false;
  let browser;
  let context;
  let secret;
  let abortClose;
  let cleanupError;
  let result;
  let failure;
  let failed = false;
  const close = async () => {
    const currentContext = context; context = undefined;
    const currentBrowser = browser; browser = undefined;
    for (const resource of [currentContext, currentBrowser]) {
      if (resource) try { await resource.close(); } catch { cleanupError ??= new Error('HMS_SESSION_CLEANUP_FAILED'); }
    }
  };
  const onAbort = () => { abortClose = close(); };
  let sessionSignal = signal;
  try {
    signal?.throwIfAborted();
    if (property.group === 'centurion') assertNoCenturionBrowserHold();
    if (!lease && property.group === 'davinci') {
      lease = await acquireCloudCredentialLease(propertyCode, { signal });
      ownedLease = true;
    }
    if (lease) {
      leaseState = credentialLeases.get(lease);
      if (!leaseState || leaseState.released || leaseState.ref !== property.credentialSecretRef || lease.signal.aborted) {
        throw new Error('HMS_CREDENTIAL_LEASE_INVALID');
      }
      if (leaseState.borrowers) throw new Error('HMS_CREDENTIAL_LEASE_IN_USE');
      leaseState.borrowers += 1;
      borrowed = true;
      sessionSignal = signal ? AbortSignal.any([signal, lease.signal]) : lease.signal;
    }
    sessionSignal?.addEventListener('abort', onAbort, { once: true });
    sessionSignal?.throwIfAborted();
    let loaded;
    try { loaded = await runUntilAborted(() => loadSecret({ secretArn: property.credentialSecretRef, signal: sessionSignal }), sessionSignal); }
    catch {
      sessionSignal?.throwIfAborted();
      throw new Error('HMS_CREDENTIALS_UNAVAILABLE');
    }
    secret = validateSecret(property, loaded, transportId);
    sessionSignal?.throwIfAborted();
    if (property.group === 'centurion') assertNoCenturionBrowserHold();
    browser = await chromium.launch({ headless, executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined });
    sessionSignal?.throwIfAborted();
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', acceptDownloads: false });
    sessionSignal?.throwIfAborted();
    const state = { authenticated: false, switching: null, verified: false };
    sessionState.set(context, state);
    await installPostRedirectGuard(context);
    if (prepareContext) await runUntilAborted(() => prepareContext(context), sessionSignal);
    await installCloudReadGuard(context, property, state);
    const page = await context.newPage();
    page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}); });
    await login(page, secret, {});
    sessionSignal?.throwIfAborted();
    state.authenticated = true;
    let identity = await verifyCloudProperty(page, { propertyCode: property.landingPropertyCode, tenantId: property.expectedTenant });
    if (!identity.observedName) identity.observedName = secret.expectedPropertyName;
    if (property.propertyCode !== property.landingPropertyCode) {
      identity = await switchCloudProperty(page, { propertyCode: property.propertyCode,
        landingPropertyCode: property.landingPropertyCode, tenantId: property.expectedTenant });
    }
    state.verified = true;
    sessionSignal?.throwIfAborted();
    if (startScreen !== 'BSSTRT') {
      if (startScreen === 'OSRESV') await openGuestStayScreen(page);
      else await openStay360(page);
      const current = await verifyCloudProperty(page, { propertyCode: property.propertyCode, tenantId: property.expectedTenant });
      identity = { ...current, observedName: identity.observedName ?? current.observedName };
    }
    sessionSignal?.throwIfAborted();
    result = await runUntilAborted(() => operation(page, Object.freeze({ ...identity,
      landingPropertyCode: property.landingPropertyCode })), sessionSignal);
  } catch (error) {
    failed = true;
    if (sessionSignal?.aborted) failure = sessionSignal.reason;
    else {
      const message = String(error?.message ?? 'HMS_SESSION_FAILED');
      const safe = [secret?.password, secret?.username, secret?.loginUrl].filter(Boolean)
        .reduce((text, value) => text.replaceAll(value, '[withheld]'), message)
        .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1?[withheld]')
        .replace(/\b(cookie|set-cookie|authorization|requesttoken|csrftckt)\s*[:=]\s*[^\s,;]+/gi, '$1=[withheld]');
      failure = new Error(safe);
    }
  } finally {
    sessionSignal?.removeEventListener('abort', onAbort);
    await abortClose;
    await close();
    if (cleanupError) {
      if (lease) retainedLeases.add(lease);
    } else {
      if (borrowed) leaseState.borrowers -= 1;
      if (ownedLease) try { await lease.release(); } catch (error) { cleanupError = error; }
    }
  }
  if (cleanupError) throw cleanupError;
  if (failed) throw failure;
  return result;
}
