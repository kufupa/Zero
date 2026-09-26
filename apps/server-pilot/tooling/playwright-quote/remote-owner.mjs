#!/usr/bin/env node
/*
 * Private EC2 browser owner for fetch-quote.mjs. It deliberately does not
 * authenticate or run the quote: the controller performs deterministic login
 * with Playwright, then attaches Stagehand over CDP to the same browser.
 */
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const root = '/opt/nava/stagehand-trial-20260917/quote-mvp-owner';
const sdkRoot = '/opt/nava/stagehand-trial-20260917/sdk';
const extensionDir = join(sdkRoot, 'node_modules/@browserbasehq/stagehand/dist/extension');
const executablePath = '/opt/nava/stagehand-trial-20260917/browsers/chromium-1243/chrome-linux64/chrome';
const extensionId = 'kdhkkapeikhmkkieigajeilnfbhehgdl';
const cdpPort = 19223;
const runId = process.env.HMS_QUOTE_OWNER_RUN ?? randomUUID().slice(0, 8);
const out = join(root, runId);
const profile = join(out, 'profile');
const ownerPath = join(out, 'owner.json');
const require = createRequire(import.meta.url);
const { chromium } = require(join(sdkRoot, 'node_modules/playwright'));

process.umask(0o077);
await mkdir(out, { recursive: true, mode: 0o700 });
await chmod(out, 0o700);
const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  channel: 'chromium',
  headless: true,
  // HMS's existing private endpoint uses its known self-signed certificate.
  // This is a browser transport setting, not an outbound-request allowlist.
  ignoreHTTPSErrors: true,
  acceptDownloads: false,
  serviceWorkers: 'block',
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--enable-unsafe-extension-debugging',
    '--enable-features=WebMCPTesting,DevToolsWebMCPSupport',
    `--remote-allow-origins=chrome-extension://${extensionId}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${cdpPort}`,
  ],
});
const marker = `stagehand-quote-owner-${randomUUID()}`;
const page = await context.newPage();
await page.evaluate((value) => { document.documentElement.dataset.stagehandQuoteOwner = value; }, marker);
await writeFile(ownerPath, JSON.stringify({
  phase: 'ready', pid: process.pid, runId, marker, extensionId, cdpPort,
  pageUrl: await page.url(), startedAt: new Date().toISOString(),
}, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ phase: 'ready', runId, pid: process.pid }));

let closing;
const close = async (signal) => {
  if (closing) return closing;
  closing = (async () => {
    await writeFile(ownerPath, JSON.stringify({ phase: 'closing', pid: process.pid, runId,
      signal, closedAt: new Date().toISOString() }, null, 2), { mode: 0o600 }).catch(() => {});
    await context.close().catch(() => {});
  })();
  await closing;
  process.exit(0);
};
process.once('SIGTERM', () => void close('SIGTERM'));
process.once('SIGINT', () => void close('SIGINT'));
await new Promise(() => {});
