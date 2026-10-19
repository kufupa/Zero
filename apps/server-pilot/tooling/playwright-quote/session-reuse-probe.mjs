#!/usr/bin/env node
// Read-only HMS storageState portability probe. Logs in once, saves storageState,
// opens a second isolated context from that file, and reports whether the HMS
// shell is authenticated without filling the login form. Coordinator runs this
// on EC2. No Guest Stay, no search, no writes. Credentials, cookies and URLs
// never go to stdout.
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwright, readSecret } from './fetch-quote.mjs';
import { loopbackCdpUrl, scrubNavError } from './hms-deeplink-probe.mjs';
import {
  authenticatedShellReady,
  login,
  newBorrowedContext,
  saveSlotStorageState,
  sessionReuseProbeResult,
  slotStorageStatePath,
} from './session-reuse.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const PRIVATE_STATE = join(REPO_ROOT, '.private/playwright-quote/session-reuse-probe/storageState.json');

export function probeEnv(env = process.env) {
  if (slotStorageStatePath(env)) return env;
  return { ...env, HMS_SLOT_STORAGE_STATE: PRIVATE_STATE };
}

export async function runSessionReuseProbe({ env = process.env } = {}) {
  const cdp = loopbackCdpUrl(env.HMS_STAGEHAND_CDP_URL ?? '');
  if (!cdp) throw new Error('LOOPBACK_CDP_REQUIRED');
  if (env.HMS_STAGEHAND_BROWSER_OWNERSHIP !== 'borrowed') throw new Error('BORROWED_OWNERSHIP_REQUIRED');
  process.umask(0o077);
  const slotEnv = probeEnv(env);
  const statePath = slotStorageStatePath(slotEnv);
  await mkdir(resolve(statePath, '..'), { recursive: true, mode: 0o700 });
  const secret = await readSecret(env);
  const browser = await playwright().chromium.connectOverCDP(cdp, { timeout: 20000 });
  let first;
  let second;
  try {
    first = await newBorrowedContext(browser, {
      ignoreHTTPSErrors: true,
      acceptDownloads: false,
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 720 },
    }, slotEnv);
    const seed = await first.newPage();
    seed.setDefaultTimeout(20000);
    const loginStarted = Date.now();
    const loggedIn = await login(seed, secret, slotEnv);
    const firstLoginMs = Date.now() - loginStarted;
    const saved = await saveSlotStorageState(first, slotEnv);
    await seed.close().catch(() => {});
    await first.close().catch(() => {});
    first = null;

    const reuseStarted = Date.now();
    second = await newBorrowedContext(browser, {
      ignoreHTTPSErrors: true,
      acceptDownloads: false,
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 720 },
    }, slotEnv);
    const page = await second.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(secret.loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const portable = await authenticatedShellReady(page, secret).catch(() => false);
    const loginVisible = (await page.locator('input[type="password"]:visible').count().catch(() => 1)) > 0;
    const reuseCheckMs = Date.now() - reuseStarted;
    await page.close().catch(() => {});
    const stateMode = saved ? (await stat(statePath)).mode & 0o777 : null;
    return sessionReuseProbeResult({
      portable,
      firstContextReused: loggedIn.reused,
      loginVisible,
      saved,
      firstLoginMs,
      reuseCheckMs,
      stateMode,
    });
  } finally {
    await first?.close?.().catch(() => {});
    await second?.close?.().catch(() => {});
    await browser.close().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSessionReuseProbe({ env: process.env })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = 0;
    })
    .catch((error) => {
      process.stderr.write(`session reuse probe failed: ${scrubNavError(error?.message ?? error) ?? 'unknown'}\n`);
      process.exitCode = 2;
    });
}
