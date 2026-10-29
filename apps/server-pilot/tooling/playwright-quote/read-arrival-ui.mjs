#!/usr/bin/env node
// Owner-requested local HRCEN read probe: fresh Chromium, no shared CLI lease or request guard.
// All HMS navigation/selection uses browser UI clicks; no direct HMS API calls.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { login } from './session-reuse.mjs';

const secretId = 'nava-zero/server-pilot/infor-hms-read';
const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const tenant = 'THECENTURION_PRD';
const viewport = { width: 1440, height: 1000 };
const require = createRequire(new URL('../stagehand/package.json', import.meta.url));
const usage = 'Usage: node apps/server-pilot/tooling/playwright-quote/read-arrival-ui.mjs [--arrival N]\n' +
  'Reads the Nth visible Arrivals row (1-based; default 1) and prints raw visible details as JSON.';
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}
const arrivalArg = args.length === 2 && args[0] === '--arrival' ? args[1] : args.length ? null : '1';
if (!arrivalArg || !/^[1-9]\d*$/.test(arrivalArg) || !Number.isSafeInteger(Number(arrivalArg))) {
  process.stderr.write(`INVALID_ARRIVAL_NUMBER\n${usage}\n`);
  process.exit(2);
}
const arrivalNumber = Number(arrivalArg);

const started = Date.now();
let phase = 'startup';
let browser;
let context;
let timeoutHandle;
const inViewport = (box) => !!box && box.width > 0 && box.height > 0 && box.x < viewport.width &&
  box.x + box.width > 0 && box.y < viewport.height && box.y + box.height > 0;

async function run() {
  phase = 'credentials';
  let secret;
  try {
    secret = JSON.parse(execFileSync('aws', [
      'secretsmanager', 'get-secret-value', '--secret-id', secretId,
      '--region', process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'af-south-1',
      '--query', 'SecretString', '--output', 'text',
    ], { encoding: 'utf8', timeout: 9_000, maxBuffer: 1_000_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    throw new Error('HMS_CREDENTIALS_UNAVAILABLE');
  }
  for (const key of ['loginUrl', 'username', 'password', 'expectedTenant', 'expectedPropertyCode', 'expectedPropertyName']) {
    if (typeof secret?.[key] !== 'string' || !secret[key]) throw new Error('HMS_CREDENTIALS_INVALID');
  }
  let target;
  try { target = new URL(secret.loginUrl); } catch { throw new Error('HMS_TARGET_MISMATCH'); }
  if (target.origin !== origin || target.pathname !== '/web/base/logindisp' ||
      target.searchParams.get('tenant') !== tenant || secret.expectedTenant !== tenant ||
      secret.expectedPropertyCode !== 'HRCEN') throw new Error('HMS_TARGET_MISMATCH');

  phase = 'launch';
  if (require('playwright/package.json').version !== '1.63.0') throw new Error('PLAYWRIGHT_VERSION_MISMATCH');
  browser = await require('playwright').chromium.launch({ headless: true });
  context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(2_500);

  phase = 'login';
  await login(page, secret, {});
  const treeNode = (label) => page.locator('span.x-tree-node-text:visible')
    .filter({ hasText: new RegExp('^' + label + '$') });
  phase = 'front_desk';
  await page.locator('a.app-menu-trigger:visible').click({ timeout: 1_600 });
  const frontDesk = treeNode('Front Desk');
  await frontDesk.waitFor({ state: 'visible', timeout: 1_800 });
  await frontDesk.scrollIntoViewIfNeeded({ timeout: 900 }).catch(() => {});
  await frontDesk.click({ timeout: 1_600 });
  await page.waitForTimeout(800);

  phase = 'stay_360';
  const stay360 = treeNode('Stay 360');
  await stay360.waitFor({ state: 'visible', timeout: 2_000 });
  await stay360.scrollIntoViewIfNeeded({ timeout: 900 }).catch(() => {});
  await stay360.click({ timeout: 1_600 });

  phase = 'arrivals';
  const arrivals = page.getByText('Arrivals', { exact: true });
  const deadline = Date.now() + 4_500;
  let arrivalsIndex = -1;
  while (Date.now() < deadline) {
    for (let i = 0, count = await arrivals.count(); i < count; i += 1) {
      const locator = arrivals.nth(i);
      const box = await locator.boundingBox().catch(() => null);
      if (await locator.isVisible().catch(() => false) && inViewport(box)) {
        arrivalsIndex = i;
        break;
      }
    }
    if (arrivalsIndex >= 0) break;
    await page.waitForTimeout(100);
  }
  if (arrivalsIndex < 0) throw new Error('ARRIVALS_TAB_NOT_IN_VIEWPORT');
  if (!await waitNoMask(page, 2_200)) throw new Error('STAY360_PROCESSING_MASK_STILL_VISIBLE');
  await arrivals.nth(arrivalsIndex).click({ timeout: 2_200 });
  if (!await waitNoMask(page, 2_200)) throw new Error('ARRIVALS_PROCESSING_MASK_STILL_VISIBLE');

  phase = 'select_arrival';
  const rows = page.locator('.x-grid-row:visible');
  const candidates = [];
  for (let i = 0, count = await rows.count(); i < count; i += 1) {
    const row = rows.nth(i);
    const className = await row.getAttribute('class') || '';
    const box = await row.boundingBox().catch(() => null);
    if (inViewport(box) && await row.locator('td, .x-grid-cell, [role="gridcell"]').count() > 1 &&
        !/x-grid-tree-node/.test(className)) candidates.push(row);
  }
  const row = candidates[arrivalNumber - 1];
  if (!row) throw new Error('ARRIVAL_ROW_NOT_VISIBLE');
  const selectedArrivalRow = (await row.innerText()).trim();
  const arrivalGridId = await row.evaluate((el) => {
    let grid = el.closest('.x-grid');
    while (grid?.parentElement?.closest('.x-grid')) grid = grid.parentElement.closest('.x-grid');
    return grid?.id || null;
  });
  await row.scrollIntoViewIfNeeded({ timeout: 1_200 });
  await row.locator('td, .x-grid-cell, [role="gridcell"]').first().click({ timeout: 2_200 });
  if (!await waitNoMask(page, 2_200)) throw new Error('DETAIL_PROCESSING_MASK_STILL_VISIBLE');

  phase = 'extract_details';
  const details = await page.evaluate(({ selectedArrivalRow, arrivalGridId }) => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
    };
    const normalize = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
    const grids = [...document.querySelectorAll('.x-grid')].filter(visible)
      .filter((grid, _, all) => !all.some((other) => other !== grid && other.contains(grid)));
    let arrivalGrid = arrivalGridId ? document.getElementById(arrivalGridId) : null;
    arrivalGrid ??= grids.find((grid) => [...grid.querySelectorAll('.x-grid-row')]
      .some((row) => normalize(row.innerText) === normalize(selectedArrivalRow))) || null;
    if (arrivalGrid && !visible(arrivalGrid)) arrivalGrid = null;
    if (!arrivalGrid && grids.some((grid) => [...grid.querySelectorAll('.x-grid-row')].filter(visible).length > 1)) {
      throw new Error('ARRIVAL_LIST_GRID_NOT_IDENTIFIED');
    }

    const visibleFormFields = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')]
      .filter((el) => visible(el) && !['hidden', 'password'].includes(el.type) && !arrivalGrid?.contains(el))
      .map((el) => {
        const item = el.closest('.x-form-item, .x-form-fieldcontainer');
        const label = item?.querySelector('.x-form-item-label, label, .x-form-label')?.innerText?.trim() ||
          el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || el.id;
        const value = el.tagName === 'SELECT'
          ? [...el.selectedOptions].map((option) => option.textContent?.trim()).filter(Boolean).join(', ')
          : (el.value ?? el.innerText ?? '').trim();
        return label ? { label, value } : null;
      }).filter(Boolean);
    const visibleGridText = grids.filter((grid) => grid !== arrivalGrid)
      .map((grid) => grid.innerText?.trim()).filter(Boolean);
    const text = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const value = normalize(node.textContent);
      if (!value || !node.parentElement || !visible(node.parentElement) || node.parentElement.closest('.x-grid') ||
          /^(Processing request|Loading\.\.\.)$/i.test(value)) continue;
      text.push(value);
    }
    return {
      visibleFormFields,
      visibleGridText,
      visiblePageTextOutsideGrids: text.join('\n'),
      captureScope: 'Rendered visible record page; arrivals list excluded; hidden tabs not opened.',
    };
  }, { selectedArrivalRow, arrivalGridId });

  return {
    ok: true,
    elapsedMs: Date.now() - started,
    arrivalNumber,
    selectedArrivalRow,
    details,
    method: 'Playwright UI clicks only; no request interception or direct HMS API calls.',
  };
}

async function waitNoMask(page, ms) {
  const end = Date.now() + ms;
  const masks = page.locator('.x-mask:visible, .x-mask-msg:visible, .x-loadmask:visible');
  while (Date.now() < end) {
    if (!(await masks.count())) return true;
    await page.waitForTimeout(100);
  }
  return !(await masks.count());
}

const timeout = new Promise((_, reject) => {
  timeoutHandle = setTimeout(() => reject(new Error('RUN_LIMIT_27_SECONDS')), 27_000);
});
try {
  process.stdout.write(`${JSON.stringify(await Promise.race([run(), timeout]), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    phase,
    elapsedMs: Date.now() - started,
    error: String(error?.message || error).split('\n')[0].slice(0, 220),
  }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeoutHandle);
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}
