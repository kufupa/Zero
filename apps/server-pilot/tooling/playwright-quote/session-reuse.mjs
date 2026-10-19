// Shared HMS login reuse for borrowed-CDP tools. storageState lives next to the
// slot profile (0600), never in git or logs. Importing this module has no side effects.
import { chmod, mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const DESTROYED_CONTEXT = /Execution context was destroyed|navigation|Cannot find context/i;

export function slotStorageStatePath(env = process.env) {
  const explicit = env.HMS_SLOT_STORAGE_STATE;
  if (typeof explicit === 'string' && explicit) {
    return isAbsolute(explicit) ? explicit : null;
  }
  const profileDir = env.HMS_SLOT_PROFILE_DIR;
  if (typeof profileDir !== 'string' || !profileDir) return null;
  return resolve(profileDir, '..', 'storageState.json');
}

export async function readableSlotStorageStatePath(env = process.env) {
  const path = slotStorageStatePath(env);
  if (!path) return undefined;
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    if ((info.mode & 0o077) !== 0) return undefined;
    return path;
  } catch {
    return undefined;
  }
}

export async function newBorrowedContext(browser, options = {}, env = process.env) {
  const storageState = await readableSlotStorageStatePath(env);
  if (!storageState) return browser.newContext(options);
  try {
    return await browser.newContext({ ...options, storageState });
  } catch {
    return browser.newContext(options);
  }
}

export async function saveSlotStorageState(context, env = process.env) {
  const path = slotStorageStatePath(env);
  if (!path || typeof context?.storageState !== 'function') return false;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await context.storageState({ path });
  await chmod(path, 0o600);
  return true;
}

export async function authenticatedShellReady(page, secret) {
  return page.evaluate(({ expectedTenant, expectedPropertyCode, expectedPropertyName }) => {
    const html = document.documentElement.outerHTML;
    const tenant = document.documentElement.dataset.tenant ??
      /"tenantid"\s*:\s*"([^"]+)"/i.exec(html)?.[1] ?? new URL(location.href).searchParams.get('tenant');
    const property = document.documentElement.dataset.propertyCode ?? /Infor HMS\s*-\s*([A-Z0-9]+)/i.exec(document.title)?.[1];
    const visible = (el) => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    return ![...document.querySelectorAll('input[type="password"], .x-mask, .x-mask-msg, .x-loadmask, [aria-busy="true"]')].some(visible) &&
      tenant === expectedTenant && property === expectedPropertyCode && (document.body?.innerText ?? '').includes(expectedPropertyName);
  }, {
    expectedTenant: secret.expectedTenant,
    expectedPropertyCode: secret.expectedPropertyCode,
    expectedPropertyName: secret.expectedPropertyName,
  });
}

async function shellReadyOrFalse(page, secret) {
  try {
    return await authenticatedShellReady(page, secret);
  } catch (error) {
    if (!DESTROYED_CONTEXT.test(error.message)) throw error;
    return false;
  }
}

async function loginFormVisible(page) {
  try {
    return (await page.locator('input[type="password"]:visible').count()) > 0;
  } catch {
    return false;
  }
}

export async function waitForShellOrLoginForm(page, secret, deadline = Date.now() + 120000) {
  while (Date.now() < deadline) {
    if (await shellReadyOrFalse(page, secret)) return { ready: true, loginForm: false };
    if (await loginFormVisible(page)) return { ready: false, loginForm: true };
    await delay(250);
  }
  if (await shellReadyOrFalse(page, secret)) return { ready: true, loginForm: false };
  return { ready: false, loginForm: await loginFormVisible(page) };
}

export function sessionReuseProbeResult({
  portable = false,
  firstContextReused = false,
  loginVisible = false,
  saved = false,
  firstLoginMs = null,
  reuseCheckMs = null,
  stateMode = null,
} = {}) {
  return {
    portable: Boolean(portable),
    firstContextReused: Boolean(firstContextReused),
    loginVisible: Boolean(loginVisible),
    saved: Boolean(saved),
    fallback: portable ? 'storageState' : 'default_context',
    firstLoginMs: Number.isFinite(firstLoginMs) ? firstLoginMs : null,
    reuseCheckMs: Number.isFinite(reuseCheckMs) ? reuseCheckMs : null,
    stateMode: Number.isInteger(stateMode) ? stateMode : null,
  };
}

export async function login(page, secret, env = process.env) {
  const deadline = Date.now() + 120000;
  const budget = () => Math.max(1, deadline - Date.now());
  await page.goto(secret.loginUrl, { waitUntil: 'domcontentloaded', timeout: budget() });
  const first = await waitForShellOrLoginForm(page, secret, deadline);
  if (first.ready) return { reused: true };
  if (!first.loginForm) throw new Error('AUTHENTICATED_SHELL_TIMEOUT');
  await page.locator('input[name="userid"], input[name="username"]').fill(secret.username, { timeout: budget() });
  const password = page.locator('input[name="password"]');
  await password.fill(secret.password, { timeout: budget() });
  const submit = page.getByRole('button', { name: 'Sign in', exact: true });
  if (await submit.count()) await submit.click({ timeout: budget() });
  else await password.press('Enter', { timeout: budget() });
  while (Date.now() < deadline) {
    if (await shellReadyOrFalse(page, secret)) {
      const context = typeof page.context === 'function' ? page.context() : null;
      try { await saveSlotStorageState(context, env); } catch { /* cache is optional */ }
      return { reused: false };
    }
    await delay(250);
  }
  throw new Error('AUTHENTICATED_SHELL_TIMEOUT');
}
