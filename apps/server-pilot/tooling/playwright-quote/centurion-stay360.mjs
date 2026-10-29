// Centurion-only browser bootstrap for UI tools that start at Stay 360.
// One Chromium context is owned for the full callback; callers must not retain its page.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { login } from './session-reuse.mjs';

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

function readCenturionSecret() {
  let secret;
  try {
    secret = JSON.parse(execFileSync('aws', [
      'secretsmanager', 'get-secret-value', '--secret-id', secretId,
      '--region', process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'af-south-1',
      '--query', 'SecretString', '--output', 'text',
    ], {
      encoding: 'utf8',
      timeout: 9_000,
      maxBuffer: 1_000_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch {
    throw new Error('HMS_CREDENTIALS_UNAVAILABLE');
  }
  return validateCenturionSecret(secret);
}

function launchCenturionChromium(headless) {
  if (require('playwright/package.json').version !== playwrightVersion) {
    throw new Error('PLAYWRIGHT_VERSION_MISMATCH');
  }
  return require('playwright').chromium.launch({ headless });
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

export async function withCenturionStay360Page(operation, { headless = true, beforeLaunch } = {}) {
  let browser;
  let context;
  let phase = 'credentials';

  const closeResources = async () => {
    const ownedContext = context;
    context = undefined;
    if (ownedContext) await ownedContext.close().catch(() => {});

    const ownedBrowser = browser;
    browser = undefined;
    if (ownedBrowser) await ownedBrowser.close().catch(() => {});
  };

  try {
    const secret = readCenturionSecret();

    phase = 'browser_launch';
    await beforeLaunch?.();
    browser = await launchCenturionChromium(headless);

    phase = 'browser_context';
    context = await browser.newContext({ viewport });

    const page = await context.newPage();

    phase = 'login';
    await login(page, secret, {});

    phase = 'stay_360';
    await openCenturionStay360(page);

    phase = 'operation';
    return await operation(page);
  } catch (error) {
    if (error && typeof error === 'object' && !error.phase) {
      try { error.phase = phase; } catch { /* Preserve the original failure. */ }
    }
    throw error;
  } finally {
    await closeResources();
  }
}
