#!/usr/bin/env node
// Guest Stay New Record from --request <path>. Validates
// create-tool.schema.json $defs.request before any browser work.
// Refuses Save while a required asterisk is blank.
import { openGuestStayScreen } from './open-guest-stay.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayDate, login, playwright, readSecret } from './fetch-quote.mjs';
import { loadCreateRequest, loadCreateToolSchema, optionalPartyAndNoteFills, parseOutDir, parseShop, parseStopBefore, refuseRateRowClick, shopResult, stayActions } from './create-request.mjs';
import { readSettledStatus, waitForSaveConfirmation } from './save-wait.mjs';

const REQUIRED = [
  'arrivaldate',
  'departuredate',
  'adults',
  'sourceofbusinessdesc',
  'roomtype',
  'rateplan',
  'track',
  'firstname',
  'lastname',
  'guaranteetype',
];

// Shared proof directory for manual runs. The pane passes --out with a per-run directory instead.
function defaultOutDir() {
  const root = fileURLToPath(new URL('../../../../.private/create-screen/proof/', import.meta.url));
  return root;
}

async function shot(page, dir, name) {
  const path = join(dir, name);
  await page.screenshot({ path, fullPage: true });
  return path;
}


// Reservation Note is a textarea; every other target is an input. Both carry the native name.
async function fillNamed(page, name, value) {
  const input = page.locator(`input[name="${name}"]:visible, textarea[name="${name}"]:visible`).first();
  await input.click();
  await input.fill(value);
  await input.press('Tab');
}

async function blankRequired(page) {
  return page.evaluate((names) => {
    const blank = [];
    for (const name of names) {
      const input = document.querySelector(`input[name="${name}"]`);
      if (!input) {
        blank.push(name);
        continue;
      }
      const value = (input.value || '').trim();
      if (!value) blank.push(name);
    }
    return blank;
  }, REQUIRED);
}

async function readMessage(page) {
  return page.evaluate(() => {
    return (document.body?.innerText || '').slice(0, 500);
  });
}

async function chooseCombo(page, name, label) {
  const input = page.locator(`input[name="${name}"]:visible`).first();
  await input.click();
  await input.fill('');
  await input.press('ArrowDown');
  const option = page.getByText(label, { exact: true }).last();
  await option.click({ timeout: 5000 });
}

async function clickTip(page, pattern) {
  const clicked = await page.evaluate((source) => {
    const re = new RegExp(source, 'i');
    const nodes = [...document.querySelectorAll('[data-qtip], button, .x-btn')];
    const el = nodes.find((node) => re.test(node.getAttribute('data-qtip') || node.textContent || ''));
    if (!el) return false;
    el.click();
    return true;
  }, pattern);
  if (!clicked) throw new Error(`control_missing:${pattern}`);
}

async function applyChildAges(page, ages) {
  await page.locator('[data-qtip="Enter Child Ages"]').click();
  const popup = page.locator('.x-window:visible').filter({ hasText: 'Update Child Categories' }).last();
  await popup.waitFor();
  const toggle = popup.locator('input[name="updatechildcategories"]');
  if (!(await toggle.isChecked().catch(() => false))) await toggle.click({ force: true });
  const up = popup.locator('input[name="children"]').locator('xpath=ancestor::tr[1]').locator('.x-spinbox-control.up');
  for (let index = 0; index < ages.length; index += 1) await up.click();
  for (let index = 0; index < ages.length; index += 1) {
    const label = popup.getByText(`Age of Child ${index + 1}`, { exact: true });
    const field = label.locator('xpath=ancestor::table[contains(@class,"x-form-item")][1]');
    await field.locator('.x-form-arrow-trigger').click();
    await page.locator('.x-boundlist:visible .x-boundlist-item').getByText(String(ages[index]), { exact: true }).click();
  }
  await popup.locator('a:visible').filter({ hasText: /^Apply$/ }).click();
  await popup.waitFor({ state: 'hidden', timeout: 8000 });
}

async function shopRates(page, dir) {
  const rate = page.locator('input[name="rateplan"]:visible').first();
  await rate.locator('xpath=ancestor::table[1]').locator('.x-form-trigger:visible').click();
  const shopWindow = page.locator('.x-window:visible').filter({ hasText: 'Rate Shop' }).last();
  await shopWindow.waitFor({ timeout: 8000 });
  const strategy = shopWindow.locator('input[name="salesstrategy"]:visible').first();
  await strategy.click();
  await strategy.fill('');
  await strategy.press('ArrowDown');
  await page.locator('.x-boundlist:visible .x-boundlist-item').getByText('BAR', { exact: true }).click();
  await shopWindow.locator('a:visible').filter({ hasText: /^Search$/ }).click();
  await shopWindow.getByText('Processing request').waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
  await shot(page, dir, 'rate-shop.png');
  const read = await shopWindow.evaluate((node) => {
    const view = node.querySelector('.x-tree-view, .x-grid-view');
    const cmp = view && window.Ext && window.Ext.getCmp(view.id);
    const range = cmp && cmp.getStore ? cmp.getStore().getRange() : [];
    const records = range.map((record) => {
      const data = record.data || {};
      return {
        roomType: data.roomtype || data.roomType || data.room || '',
        code: data.rateplan || data.ratecode || data.rateplancode || data.code || '',
        name: data.ratedesc || data.description || data.rateplandescription || data.name || '',
      };
    });
    const lines = [...node.querySelectorAll('.x-grid-row, .x-grid-data-row, .x-grid-cell')].map((row) => row.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return { records, lines };
  });
  const rowClickRequested = false;
  if (rowClickRequested) refuseRateRowClick();
  const close = shopWindow.locator('.x-tool-close');
  if (await close.count()) await close.first().click();
  else await page.keyboard.press('Escape');
  return shopResult(read.records, read.lines);
}

async function observeBlankForm(page, dir) {
  const schema = await loadCreateToolSchema();
  const labels = schema.$defs.request.properties.guaranteeType.enum;
  const child = page.locator('input[name="children"]').first();
  const childState = (el) => ({ disabled: el.disabled, readOnly: el.readOnly, className: el.className });
  const notes = { children: {}, guarantee: [], rateShop: { clicked: false, rowClicked: false } };
  notes.children.before = await child.evaluate(childState);
  await fillNamed(page, 'arrivaldate', '14-SEP-2027');
  await fillNamed(page, 'departuredate', '15-SEP-2027');
  notes.children.afterDates = await child.evaluate(childState);
  notes.rateShop.rowClicked = false;
  await fillNamed(page, 'arrivaldate', '');
  await fillNamed(page, 'departuredate', '');
  for (const label of labels) {
    await chooseCombo(page, 'guaranteetype', label);
    const revealed = await page.evaluate(() => {
      const visible = (el) => !!(el.offsetParent || el.getClientRects().length);
      const inputs = [...document.querySelectorAll('input[name]')].filter(visible).map((el) => ({
        name: el.name,
        disabled: el.disabled,
        readOnly: el.readOnly,
      }));
      return inputs;
    });
    notes.guarantee.push({ label, revealed });
  }
  await writeFile(join(dir, 'observe.json'), JSON.stringify(notes, null, 2));
  return notes;
}

async function main() {
  const argv = process.argv.slice(2);
  const stop = parseStopBefore(argv);
  if (!stop.ok) {
    process.stderr.write(`${stop.error}\n`);
    process.exitCode = stop.exitCode;
    return;
  }
  const shopMode = parseShop(argv);
  const out = parseOutDir(argv);
  if (!out.ok) {
    process.stderr.write(`${out.error}\n`);
    process.exitCode = out.exitCode;
    return;
  }
  const actions = stayActions(stop.stopBefore);
  const loaded = await loadCreateRequest(argv);
  if (!loaded.ok) {
    process.stderr.write(`${loaded.error}\n`);
    process.exitCode = loaded.exitCode;
    return;
  }
  const stay = loaded.request;
  const dir = out.outDir ?? defaultOutDir();
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
  const result = { guest: stay, held: false, saved: false, cancelled: false };
  try {
    await login(page, secret);
    await openGuestStayScreen(page);
    await page.locator('[data-qtip="New Record (Ctrl+N)"]').click();
    await page.locator('input[name="lastname"]:visible').waitFor();
    if (shopMode) {
      await fillNamed(page, 'arrivaldate', displayDate(stay.arrival));
      await fillNamed(page, 'departuredate', displayDate(stay.departure));
      await fillNamed(page, 'adults', String(stay.adults));
      if (Array.isArray(stay.childAges) && stay.childAges.length) await applyChildAges(page, stay.childAges);
      result.shop = await shopRates(page, dir);
      result.outcome = 'shop';
      result.held = false;
      result.saved = false;
      result.rowClicked = false;
      await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
      process.stdout.write(`${JSON.stringify(result.shop)}\n`);
      return;
    }
    if (stop.stopBefore === 'availability') {
      try {
        result.observe = await observeBlankForm(page, dir);
      } catch (error) {
        result.observeError = String(error.message || error);
      }
    }
    await fillNamed(page, 'arrivaldate', displayDate(stay.arrival));
    await fillNamed(page, 'departuredate', displayDate(stay.departure));
    await fillNamed(page, 'adults', String(stay.adults));
    if (Array.isArray(stay.childAges) && stay.childAges.length) await applyChildAges(page, stay.childAges);
    if (actions.includes('firstName')) await fillNamed(page, 'firstname', stay.firstName);
    if (actions.includes('lastName')) await fillNamed(page, 'lastname', stay.lastName);
    await fillNamed(page, 'sourceofbusinessdesc', stay.sourceOfBusiness);
    await fillNamed(page, 'roomtype', stay.roomType);
    await fillNamed(page, 'rateplan', stay.ratePlan);
    await fillNamed(page, 'track', stay.track);
    if (stop.stopBefore !== 'availability') {
      // Party lookups, Reservation Note and booker fields. Empty values are skipped. LIVE-UNVERIFIED: see create-request.mjs.
      for (const [name, value] of Object.entries(optionalPartyAndNoteFills(stay))) {
        if (value) await fillNamed(page, name, value);
      }
      if (stay.arAccount) await fillNamed(page, 'araccountname', stay.arAccount);
      if (stay.billingReference) await fillNamed(page, 'billingreference', stay.billingReference);
      if (Object.hasOwn(stay, 'profileId')) await fillNamed(page, 'guestid', String(stay.profileId));
    }
    await chooseCombo(page, 'guaranteetype', stay.guaranteeType);
    await page.waitForTimeout(1000);
    const blank = await blankRequired(page);
    result.blankRequired = blank;
    await shot(page, dir, 'filled.png');
    if (stop.stopBefore === 'availability') {
      result.outcome = 'stopped_before_availability';
      result.guestNameTyped = false;
      result.clickedCheckAvailability = false;
      result.clickedSave = false;
      await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
      process.stdout.write(`${result.outcome}\n`);
      return;
    }
    if (blank.length) {
      result.outcome = 'refused_save_blank_required';
      await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
      process.stdout.write(`${result.outcome}\n`);
      return;
    }
    await clickTip(page, '^Check Availability$');
    await page.waitForTimeout(2500);
    result.clickedCheckAvailability = true;
    result.held = false;
    await shot(page, dir, 'availability.png');
    if (stop.stopBefore === 'save') {
      result.outcome = 'previewed';
      result.clickedSave = false;
      result.saved = false;
      await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
      process.stdout.write(`${result.outcome}\n`);
      return;
    }
    await clickTip(page, '^Save');
    // HMS masks the record while it saves. Read the number only once the mask is gone. A missing number is
    // save_unconfirmed, never a failed save: HMS may already have booked the stay.
    const save = await waitForSaveConfirmation(page);
    result.clickedSave = true;
    result.confirmationNumber = save.confirmationNumber;
    result.saved = save.confirmed;
    result.saveReason = save.reason;
    if (save.confirmed) result.statusAfterSave = await readSettledStatus(page);
    result.message = await readMessage(page);
    await shot(page, dir, 'saved.png');
    if (!result.saved) {
      result.outcome = 'save_unconfirmed';
      await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
      process.stdout.write(`${result.outcome}\n`);
      return;
    }
    if (stop.paneCommit) {
      result.cancelled = false;
      result.outcome = 'committed';
      await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
      process.stdout.write(`${result.outcome} ${result.confirmationNumber}\n`);
      return;
    }
    let cancelled = false;
    for (let attempt = 1; attempt <= 2 && !cancelled; attempt += 1) {
      try {
        await clickTip(page, 'Cancel');
        const yes = page.getByRole('button', { name: /yes|ok/i }).first();
        if (await yes.count()) await yes.click();
        await page.waitForTimeout(2000);
        const status = await page.locator('input[name="status"]').inputValue().catch(() => '');
        result.statusAfterCancel = status;
        cancelled = /cancel/i.test(status);
      } catch (error) {
        result.cancelError = String(error.message || error);
      }
    }
    result.cancelled = cancelled;
    await shot(page, dir, 'cancelled.png');
    result.outcome = cancelled ? 'saved_then_cancelled' : 'cancel_failed';
  } catch (error) {
    result.outcome = 'execution_failure';
    result.error = String(error.message || error);
    await shot(page, dir, 'failure.png').catch(() => {});
    throw error;
  } finally {
    await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  process.stdout.write(`${result.outcome}\n`);
  if (result.outcome !== 'saved_then_cancelled') process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 2;
  });
}
