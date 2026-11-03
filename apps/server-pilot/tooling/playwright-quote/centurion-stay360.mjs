// Centurion-only browser bootstrap for UI tools that start at Stay 360.
// One Chromium context is owned for the full callback; callers must not retain its page.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
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
const ownedPages = new WeakMap();

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
export function centurionBrowserIdentity(pid) {
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
  if (Number(fields[2]) !== pid || Number(fields[3]) !== pid || !/^\d+$/.test(fields[19] ?? '')) {
    throw new Error('HMS_BROWSER_GROUP_UNVERIFIED');
  }
  return { pid, started: fields[19] };
}

export function centurionBrowserGroup(pid) { return centurionBrowserIdentity(pid).pid; }

// PID values are meaningful only on the same host, boot and PID namespace.
// Store a host fingerprint, never a credential or the machine-id itself.
function currentHostIdentity() {
  const machine = readFileSync('/etc/machine-id', 'utf8').trim();
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const pidNamespace = readlinkSync('/proc/self/ns/pid');
  if (!/^[a-f0-9]{32}$/i.test(machine) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(bootId) ||
      !/^pid:\[\d+\]$/.test(pidNamespace) || !hostname()) throw new Error('HMS_WRITER_IDENTITY_UNAVAILABLE');
  return { host: createHash('sha256').update(machine).update('\0').update(hostname()).digest('hex'), bootId, pidNamespace };
}

function processStart(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('HMS_WRITER_IDENTITY_UNAVAILABLE');
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(')');
  const fields = end < 0 ? [] : stat.slice(end + 1).trim().split(/\s+/);
  if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('HMS_WRITER_IDENTITY_UNAVAILABLE');
  return fields[19];
}

/** Capture only a browser group owned by this live session, before its native dispatch. */
export function centurionWriterIdentity(page) {
  const browser = ownedPages.get(page);
  if (!browser) return null;
  const current = centurionBrowserIdentity(browser.pid);
  if (current.started !== browser.started) throw new Error('HMS_WRITER_IDENTITY_UNAVAILABLE');
  return { ...currentHostIdentity(), node: { pid: process.pid, started: processStart(process.pid) }, browser: current };
}

/** A stale, foreign, unreadable or still-live process identity cannot authorize recovery. */
export function centurionWriterQuiesced(identity) {
  try {
    if (!identity || typeof identity !== 'object' || !/^[a-f0-9]{64}$/.test(identity.host || '') ||
        !identity.node || !identity.browser || !Number.isSafeInteger(identity.node.pid) || identity.node.pid < 2 ||
        !Number.isSafeInteger(identity.browser.pid) || identity.browser.pid < 2 ||
        identity.node.pid === identity.browser.pid || !/^\d+$/.test(identity.node.started || '') ||
        !/^\d+$/.test(identity.browser.started || '')) return false;
    const current = currentHostIdentity();
    if (identity.host !== current.host || identity.bootId !== current.bootId ||
        identity.pidNamespace !== current.pidNamespace) return false;
    try {
      if (processStart(identity.node.pid) === identity.node.started) return false;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') return false;
    }
    try { process.kill(-identity.browser.pid, 0); return false; }
    catch (error) { return error?.code === 'ESRCH'; }
  } catch { return false; }
}

/** Revalidate an identity emitted by this Node and its still-owned browser. */
export function centurionWriterCurrent(identity) {
  try {
    const current = currentHostIdentity();
    const browser = centurionBrowserIdentity(identity?.browser?.pid);
    return identity.host === current.host && identity.bootId === current.bootId &&
      identity.pidNamespace === current.pidNamespace && identity.node?.pid === process.pid &&
      identity.node.started === processStart(process.pid) && identity.browser.started === browser.started;
  } catch { return false; }
}

/** Keep the hold in a private, owner-controlled directory, not shared /tmp. */
export function centurionBrowserHoldPath(home = homedir()) {
  const uid = process.getuid();
  const validDirectory = (path, privateMode) => {
    const stat = lstatSync(path);
    return stat.isDirectory() && stat.uid === uid && !(stat.mode & privateMode);
  };
  try {
    if (!validDirectory(home, 0o022)) throw new Error('unsafe home');
    const dir = join(home, '.nava-hms-runtime');
    try { mkdirSync(dir, { mode: 0o700 }); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (!validDirectory(dir, 0o077)) throw new Error('unsafe hold directory');
    return join(dir, 'hrcen-browser-hold');
  } catch { throw new Error('HMS_BROWSER_HOLD_UNAVAILABLE'); }
}

/** Only server-derived canonical dispatch keys may select a narrower cleanup hold. */
export function centurionCloudBrowserHoldPath(key, home = homedir()) {
  let parts;
  try { parts = JSON.parse(key); } catch { throw new Error('HMS_BROWSER_TARGET_INVALID'); }
  const nameKey = (value) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  const validName = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4_608 &&
    !/[\p{Cc}]/u.test(value) && value === nameKey(value);
  const validDate = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  const valid = Array.isArray(parts) && parts[0] === propertyCode && (
    (parts.length === 5 && parts[1] === 'create' && validName(parts[2]) && validName(parts[3]) && validDate(parts[4])) ||
    (parts.length === 3 && parts[1] === 'saved' && typeof parts[2] === 'string' &&
      /^(?:0|[1-9]\d{0,29})-(?:0|[1-9]\d{0,9})$/.test(parts[2])) ||
    (parts.length === 3 && parts[1] === 'saved_native' && typeof parts[2] === 'string' &&
      /^(?:0|[1-9]\d{0,99})$/.test(parts[2]))
  );
  if (!valid || JSON.stringify(parts) !== key) throw new Error('HMS_BROWSER_TARGET_INVALID');
  return `${centurionBrowserHoldPath(home)}-${createHash('sha256').update(key).digest('hex')}`;
}

/** A legacy hotel-wide hold always blocks a Cloud session as well. */
export function assertNoCenturionCloudBrowserHold(key, home = homedir()) {
  assertNoCenturionBrowserHold(centurionBrowserHoldPath(home));
  assertNoCenturionBrowserHold(centurionCloudBrowserHoldPath(key, home));
}

/** An unconfirmed browser blocks later launches in every process for this user. */
export function assertNoCenturionBrowserHold(path = centurionBrowserHoldPath()) {
  try { lstatSync(path); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error('HMS_BROWSER_HOLD_UNAVAILABLE');
  }
  throw new Error('HMS_BROWSER_HOLD');
}

export function holdCenturionBrowser(identity, path = centurionBrowserHoldPath()) {
  try {
    writeFileSync(path, JSON.stringify({ property: 'HRCEN', pid: identity?.pid ?? null,
      started: identity?.started ?? null }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw new Error('HMS_BROWSER_HOLD_UNAVAILABLE');
  }
}

/** Kill only the exact group launched here, never a reused process id. */
function stopOwnedGroup(identity) {
  if (!identity) return;
  try {
    const current = centurionBrowserIdentity(identity.pid);
    if (current.started === identity.started) process.kill(-identity.pid, 'SIGKILL');
  } catch { /* Recheck whether the group is gone before deciding on a hold. */ }
}

async function groupGone(group) {
  try { process.kill(-group, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

async function waitForGroupGone(group, isGroupGone, waitMs) {
  const deadline = Date.now() + waitMs;
  do {
    try { if (await isGroupGone(group)) return true; } catch { /* Unconfirmed. */ }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return false;
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
export async function closeCenturionResources({ context, browser, server, processGroup, processIdentity },
  { isGroupGone = groupGone, stopGroup = stopOwnedGroup, onUnconfirmed = holdCenturionBrowser,
    timeoutMs = 5_000, groupWaitMs = 2_000 } = {}) {
  let clean = true;
  let held = false;
  const hold = () => {
    if (!held) { onUnconfirmed(processIdentity); held = true; }
  };
  let serverClosed = !server;
  for (const resource of [context, browser, server]) {
    const closed = await closeBounded(resource, timeoutMs);
    if (resource === server) serverClosed = closed;
    if (!closed) clean = false;
  }
  // Without a verified group identity, observing an empty numeric group cannot prove
  // that a server whose close failed has exited: it may never have owned that group.
  if (server && !serverClosed && (!processGroup || processIdentity?.pid !== processGroup)) hold();
  if (processGroup) {
    let gone = await waitForGroupGone(processGroup, isGroupGone, groupWaitMs);
    if (!gone) {
      clean = false;
      try {
        if (processIdentity?.pid === processGroup) await stopGroup(processIdentity);
      } catch { /* A hold is required if it still lives. */ }
      gone = await waitForGroupGone(processGroup, isGroupGone, groupWaitMs);
      if (!gone) hold();
    }
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

/** A queued launch must see a hold made while its beforeLaunch hook waited. */
export async function prepareCenturionLaunch(beforeLaunch, signal, check = assertNoCenturionBrowserHold) {
  check();
  await beforeLaunch?.();
  signal?.throwIfAborted();
  check();
}

export async function withCenturionStay360Page(operation, { headless = true, beforeLaunch, signal,
  blockServiceWorkers = false, prepareContext, cloudTargetKey } = {}) {
  const contextOptions = centurionContextOptions(blockServiceWorkers);
  const cloudHoldPath = cloudTargetKey === undefined ? undefined : centurionCloudBrowserHoldPath(cloudTargetKey);
  const checkHold = cloudHoldPath === undefined ? assertNoCenturionBrowserHold : () => {
    assertNoCenturionBrowserHold();
    assertNoCenturionBrowserHold(cloudHoldPath);
  };
  let browser;
  let server;
  let processGroup;
  let processIdentity;
  let context;
  let page;
  let phase = 'credentials';
  let abortClose;
  let closeError;
  let operationResult;
  let operationError;
  let operationFailed = false;

  const closeResources = async () => {
    const owned = { context, browser, server, processGroup, processIdentity };
    context = undefined;
    browser = undefined;
    server = undefined;
    processGroup = undefined;
    processIdentity = undefined;
    try { await closeCenturionResources(owned, cloudHoldPath === undefined ? undefined : {
      onUnconfirmed: (identity) => holdCenturionBrowser(identity, cloudHoldPath),
    }); }
    catch (error) { closeError ??= error; }
  };
  const onAbort = () => { abortClose ??= closeResources(); };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    signal?.throwIfAborted();
    const secret = await readCenturionSecret();
    signal?.throwIfAborted();

    phase = 'browser_launch';
    await prepareCenturionLaunch(beforeLaunch, signal, checkHold);
    const chromium = centurionChromium();
    server = await chromium.launchServer({
      headless, host: '127.0.0.1',
      executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined,
    });
    const pid = server.process()?.pid;
    if (Number.isSafeInteger(pid) && pid >= 2 && pid !== process.pid) processGroup = pid;
    try { processIdentity = centurionBrowserIdentity(pid); }
    catch (error) {
      // Cloud owns this server even when /proc cannot prove the identity for PID-safe killing.
      if (cloudHoldPath === undefined) throw error;
    }
    signal?.throwIfAborted();
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 30_000 });
    signal?.throwIfAborted();

    phase = 'browser_context';
    context = await browser.newContext(contextOptions);
    signal?.throwIfAborted();

    page = await newPreparedCenturionPage(context, prepareContext);
    ownedPages.set(page, processIdentity);
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
    if (page) ownedPages.delete(page);
  }
  if (closeError) {
    closeError.phase = 'cleanup';
    if (operationFailed && closeError.cause === undefined) closeError.cause = operationError;
    throw closeError;
  }
  if (operationFailed) throw operationError;
  return operationResult;
}
