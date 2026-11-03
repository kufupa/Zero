// Centurion-only browser bootstrap for UI tools that start at Stay 360.
// One Chromium context is owned for the full callback; callers must not retain its page.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { login } from './session-reuse.mjs';
import { installStay360NotesHandler, notesHandlerFailure } from './stay360-notes.mjs';

const execFileAsync = promisify(execFile);
const secretId = 'nava-zero/server-pilot/infor-hms-read';
const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const tenant = 'THECENTURION_PRD';
const propertyCode = 'HRCEN';
const viewport = { width: 1440, height: 1000 };
const playwrightVersion = '1.63.0';
const require = createRequire(new URL('../stagehand/package.json', import.meta.url));

function validateCenturionSecret(secret) {
  for (const key of [
    'loginUrl',
    'username',
    'password',
    'expectedTenant',
    'expectedPropertyCode',
    'expectedPropertyName',
  ]) {
    if (typeof secret?.[key] !== 'string' || !secret[key]) {
      throw new Error('HMS_CREDENTIALS_INVALID');
    }
  }

  let target;
  try {
    target = new URL(secret.loginUrl);
  } catch {
    throw new Error('HMS_TARGET_MISMATCH');
  }

  if (
    target.origin !== origin ||
    target.pathname !== '/web/base/logindisp' ||
    target.searchParams.get('tenant') !== tenant ||
    secret.expectedTenant !== tenant ||
    secret.expectedPropertyCode !== propertyCode
  ) {
    throw new Error('HMS_TARGET_MISMATCH');
  }

  return secret;
}

async function readCenturionSecret() {
  let secret;
  try {
    const { stdout } = await execFileAsync('aws', [
      'secretsmanager', 'get-secret-value', '--secret-id', secretId,
      '--region', process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'af-south-1',
      '--query', 'SecretString', '--output', 'text',
    ], {
      encoding: 'utf8',
      timeout: 9_000,
      maxBuffer: 1_000_000,
    });
    secret = JSON.parse(stdout.trim());
  } catch {
    throw new Error('HMS_CREDENTIALS_UNAVAILABLE');
  }
  return validateCenturionSecret(secret);
}

function centurionChromium() {
  if (require('playwright/package.json').version !== playwrightVersion) {
    throw new Error('PLAYWRIGHT_VERSION_MISMATCH');
  }
  return require('playwright').chromium;
}

/** The server owns a detached Chromium group; never infer that an arbitrary PID is ours. */
export function centurionBrowserGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) throw new Error('HMS_BROWSER_GROUP_UNVERIFIED');
  let fields;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) throw new Error('invalid stat');
    fields = stat.slice(end + 1).trim().split(/\s+/);
  } catch {
    throw new Error('HMS_BROWSER_GROUP_UNVERIFIED');
  }
  // /proc stat after the command: state, parent PID, process group, session.
  if (Number(fields[2]) !== pid || Number(fields[3]) !== pid) throw new Error('HMS_BROWSER_GROUP_UNVERIFIED');
  return pid;
}

async function groupGone(group) {
  try { process.kill(-group, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

async function closeBounded(resource, timeoutMs) {
  if (!resource) return true;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => resource.close()).then(() => true, () => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Close every owned layer and prove the browser group is gone; a timeout is uncertain. */
export async function closeCenturionResources({ context, browser, server, processGroup },
  { isGroupGone = groupGone, timeoutMs = 5_000, groupWaitMs = 2_000 } = {}) {
  let clean = true;
  for (const resource of [context, browser, server]) {
    if (!await closeBounded(resource, timeoutMs)) clean = false;
  }
  if (server && !processGroup) clean = false;
  if (processGroup) {
    const deadline = Date.now() + groupWaitMs;
    let gone = false;
    do {
      try { gone = await isGroupGone(processGroup); } catch { gone = false; }
      if (gone || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (!gone && Date.now() < deadline);
    if (!gone) clean = false;
  }
  if (!clean) throw new Error('HMS_BROWSER_CLOSE_UNCONFIRMED');
}

async function openCenturionStay360(page) {
  const treeNode = (label) => page.locator('span.x-tree-node-text:visible')
    .filter({ hasText: new RegExp(`^${label}$`) });

  await page.locator('a.app-menu-trigger:visible').click();
  const frontDesk = treeNode('Front Desk');
  await frontDesk.waitFor({ state: 'visible' });
  await frontDesk.scrollIntoViewIfNeeded({ timeout: 900 }).catch(() => {});
  await frontDesk.click();
  await page.waitForTimeout(800);

  const stay360 = treeNode('Stay 360');
  await stay360.waitFor({ state: 'visible' });
  await stay360.scrollIntoViewIfNeeded({ timeout: 900 }).catch(() => {});
  await stay360.click();
}

// Callers relying on request routing can opt out of service workers before any page exists.
export function centurionContextOptions(blockServiceWorkers = false) {
  if (typeof blockServiceWorkers !== 'boolean') throw new Error('SERVICE_WORKER_OPTION_INVALID');
  return blockServiceWorkers ? { viewport: { ...viewport }, serviceWorkers: 'block' } : { viewport: { ...viewport } };
}

/** Let a caller install context routes before the first page or network request. */
export async function newPreparedCenturionPage(context, prepareContext) {
  await prepareContext?.(context);
  return context.newPage();
}

export async function withCenturionStay360Page(operation, { headless = true, beforeLaunch, signal,
  blockServiceWorkers = false, prepareContext } = {}) {
  const contextOptions = centurionContextOptions(blockServiceWorkers);
  let browser;
  let server;
  let processGroup;
  let context;
  let page;
  let phase = 'credentials';
  let abortClose;
  let closeError;
  let operationResult;
  let operationError;
  let operationFailed = false;

  const closeResources = async () => {
    const owned = { context, browser, server, processGroup };
    context = undefined;
    browser = undefined;
    server = undefined;
    processGroup = undefined;
    try { await closeCenturionResources(owned); }
    catch (error) { closeError ??= error; }
  };
  const onAbort = () => { abortClose ??= closeResources(); };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    signal?.throwIfAborted();
    const secret = await readCenturionSecret();
    signal?.throwIfAborted();

    phase = 'browser_launch';
    await beforeLaunch?.();
    signal?.throwIfAborted();
    const chromium = centurionChromium();
    server = await chromium.launchServer({
      headless, host: '127.0.0.1',
      executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined,
    });
    processGroup = centurionBrowserGroup(server.process()?.pid);
    signal?.throwIfAborted();
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 30_000 });
    signal?.throwIfAborted();

    phase = 'browser_context';
    context = await browser.newContext(contextOptions);
    signal?.throwIfAborted();

    page = await newPreparedCenturionPage(context, prepareContext);
    signal?.throwIfAborted();

    phase = 'login';
    await login(page, secret, {});
    signal?.throwIfAborted();

    phase = 'stay_360';
    await openCenturionStay360(page);
    signal?.throwIfAborted();

    phase = 'operation';
    await installStay360NotesHandler(page);
    signal?.throwIfAborted();
    operationResult = await operation(page);
  } catch (error) {
    const failure = (page && notesHandlerFailure(page)) || error;
    if (failure && typeof failure === 'object' && !failure.phase) {
      try { failure.phase = phase; } catch { /* Preserve the original failure. */ }
    }
    operationFailed = true;
    operationError = failure;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await abortClose;
    await closeResources();
  }
  if (closeError) throw closeError;
  if (operationFailed) throw operationError;
  return operationResult;
}
