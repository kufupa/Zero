#!/usr/bin/env node
// Read-only folio probe for one confirmation. No Save. No Cancel.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, playwright, readSecret } from './fetch-quote.mjs';

function outDir() {
  return fileURLToPath(new URL('../../../../.private/luna-mvp/h7/', import.meta.url));
}

function parseConfirmation(argv) {
  const i = argv.indexOf('--confirmation');
  const value = i >= 0 ? argv[i + 1] : '';
  if (!value || !/^\d+-\d+$/.test(value)) {
    return { ok: false, error: 'need --confirmation N-N', exitCode: 2 };
  }
  return { ok: true, confirmation: value };
}

async function shot(page, dir, name) {
  const path = join(dir, name);
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function menu(page, names) {
  await page.locator('a.app-menu-trigger:visible').click();
  for (const name of names) {
    await page.locator('span.x-tree-node-text:visible').filter({ hasText: new RegExp(`^${name}$`) }).click();
  }
}

async function main() {
  const parsed = parseConfirmation(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = parsed.exitCode;
    return;
  }
  const dir = outDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const url = new URL(process.env.HMS_STAGEHAND_CDP_URL);
  if (!['http:', 'ws:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('PRIVATE_CDP_REQUIRED');
  }
  if (process.env.HMS_STAGEHAND_BROWSER_OWNERSHIP !== 'borrowed') throw new Error('BORROWED_REQUIRED');
  const secret = await readSecret();
  const browser = await playwright().chromium.connectOverCDP(url.href, { timeout: 20000 });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const result = { confirmation: parsed.confirmation, outcome: 'unknown' };
  try {
    await login(page, secret);
    await menu(page, ['Front Desk', 'Guest Stay']);
    const search = page.getByPlaceholder(/Search by Name, Confirmation/i).first();
    await search.click();
    await search.fill(parsed.confirmation);
    await page.waitForTimeout(500);
    const include = page.locator('label:visible, .x-form-cb-label:visible').filter({ hasText: /include cancel/i }).first();
    if (await include.count()) {
      await include.click({ force: true });
      result.includeCancelledClicked = true;
    }
    await page.evaluate(() => {
      const cmp = window.Ext?.getCmp?.('displayfield-1135');
      const owner = cmp?.up?.('container');
      const button = window.Ext?.getCmp?.('button-1136') || (owner?.query?.('button') || []).find((item) => /calendar/i.test(`${item.itemId || ''} ${item.name || ''} ${item.text || ''}`));
      button?.getEl?.()?.dom?.click?.();
    });
    await page.locator('.x-datepicker-next:visible').first().waitFor();
    for (let i = 0; i < 18; i += 1) {
      const title = await page.locator('.x-datepicker-month:visible').first().innerText();
      if (title.includes('June 2027')) break;
      await page.locator('.x-datepicker-next:visible').first().click();
      await page.waitForTimeout(100);
    }
    await page.locator('.x-datepicker-cell:not(.x-datepicker-prevday):not(.x-datepicker-nextday) a:visible')
      .filter({ hasText: /^1$/ }).first().click();
    const apply = page.locator('a.x-btn:visible').filter({ hasText: /^Apply$/ }).last();
    if (await apply.count()) await apply.click();
    await page.waitForTimeout(1000);
    await shot(page, dir, 'folio-search.png');
    await page.locator('#button-1123').click();
    await page.waitForTimeout(2000);
    const hit = page.getByText(parsed.confirmation, { exact: true }).first();
    if (!(await hit.count())) {
      result.outcome = 'not_found';
      await shot(page, dir, 'folio-list.png');
      process.stdout.write(`${JSON.stringify({ outcome: result.outcome, confirmation: parsed.confirmation })}\n`);
      return;
    }
    await hit.click();
    await page.locator('input[name="confirmationnumber"]').waitFor();
    await page.waitForTimeout(1500);
    result.status = await page.locator('input[name="status"]').inputValue().catch(() => '');
    result.createdBy = await page.locator('input[name="createdby"]').inputValue().catch(() => '');
    const folioTab = page.getByText(/^Folio$/).first();
    if (await folioTab.count()) await folioTab.click({ force: true });
    else await page.getByRole('tab', { name: /folio/i }).first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(2000);
    await shot(page, dir, 'folio.png');
    const body = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' '));
    const penalty = /2[\s,]?060(?:\.00)?|cancellation penalty|cancel(?:lation)? fee/i.test(body);
    const amount = body.match(/2[\s,]?060(?:\.\d{2})?/);
    result.penaltyPosted = penalty;
    result.penaltyAmountToken = amount ? amount[0].replace(/\s/g, '') : null;
    result.outcome = 'read';
    process.stdout.write(`${JSON.stringify({
      outcome: result.outcome,
      confirmation: parsed.confirmation,
      status: result.status ? 'observed' : 'unknown',
      createdByPresent: Boolean(result.createdBy),
      penaltyPosted: result.penaltyPosted,
      penaltyAmountToken: result.penaltyAmountToken,
    })}\n`);
  } catch (error) {
    result.outcome = 'execution_failure';
    result.error = String(error.message || error);
    await shot(page, dir, 'folio-failure.png').catch(() => {});
    process.stdout.write(`${JSON.stringify({ outcome: result.outcome, error: result.error })}\n`);
    process.exitCode = 2;
  } finally {
    await writeFile(join(dir, 'folio-46184891.json'), JSON.stringify(result, null, 2));
    await Promise.race([context.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    if (typeof browser.disconnect === 'function') browser.disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(process.exitCode || 0)).catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(2);
  });
}
