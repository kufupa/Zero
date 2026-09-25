#!/usr/bin/env node
// Cancel one lab Guest Stay. Aborts unless confirmation, name, and arrival match.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, playwright, readSecret } from './fetch-quote.mjs';

const TARGET = {
  confirmation: '11110906-1',
  lastName: 'Labcancel',
  firstName: 'Nava',
  arrival: '08-JUN-2027',
};

function outDir() {
  return fileURLToPath(new URL('../../../../.private/create-screen/proof/', import.meta.url));
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

async function readIdentity(page) {
  return page.evaluate(() => {
    const value = (name) => (document.querySelector(`input[name="${name}"]`)?.value || '').trim();
    return {
      confirmation: value('confirmationnumber'),
      lastName: value('lastname'),
      firstName: value('firstname'),
      arrival: value('arrivaldate'),
      status: value('status'),
    };
  });
}

function sameStay(identity) {
  return identity.confirmation === TARGET.confirmation
    && identity.lastName.toLowerCase() === TARGET.lastName.toLowerCase()
    && identity.firstName.toLowerCase() === TARGET.firstName.toLowerCase()
    && identity.arrival.toUpperCase() === TARGET.arrival;
}

async function openTarget(page) {
  const search = page.getByPlaceholder(/Search by Name, Confirmation/i).first();
  await search.click();
  await search.fill(TARGET.confirmation);
  await page.waitForTimeout(800);
  const clicked = await page.evaluate(() => {
    const Ext = window.Ext;
    const cmp = Ext?.getCmp?.('displayfield-1135');
    const owner = cmp?.up?.('container');
    const items = (owner?.items?.items || []).map((item) => ({
      id: item.id,
      xtype: item.xtype,
      text: String(item.text || item.fieldLabel || item.name || '').slice(0, 40),
    }));
    const button = Ext.getCmp('button-1136') || (owner?.query?.('button') || []).find((item) => /calendar/i.test(`${item.itemId || ''} ${item.name || ''} ${item.text || ''}`));
    button?.getEl?.()?.dom?.click?.();
    return JSON.stringify({ items, button: button?.id || null });
  });
  await page.locator('.x-datepicker-next, .x-datepicker-next a').first().waitFor({ timeout: 5000 });
  let title = '';
  for (let i = 0; i < 18; i += 1) {
    title = (await page.locator('.x-datepicker-month, .x-datepicker-month .x-btn-inner').first().innerText()).trim();
    if (/June 2027/i.test(title)) break;
    await page.locator('.x-datepicker-next, .x-datepicker-next a').first().click();
    await page.waitForTimeout(150);
  }
  const day = page.locator('.x-datepicker-cell:not(.x-datepicker-prevday):not(.x-datepicker-nextday) a, .x-datepicker-date').filter({ hasText: /^1$/ }).first();
  if (await day.count()) await day.click();
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  if (await apply.count()) await apply.click();
  await page.waitForTimeout(1500);
  const row = page.getByText('Labcancel, Nava', { exact: true });
  if ((await row.count()) !== 1) return `not-found ${clicked} month=${title} rows=${await row.count()}`;
  await row.click();
  return `search-hit ${clicked} month=${title}`;
}

async function cancelOpenRecord(page) {
  const direct = page.locator('[data-qtip="Cancel Reservation"]');
  if (await direct.count()) {
    if ((await direct.count()) !== 1) throw new Error('ABORT_MULTIPLE_CANCEL_BUTTONS');
    await direct.click();
  } else {
    const actions = page.getByText(/^Actions:?$/).first().locator('xpath=following::*[contains(@class,"x-form-arrow-trigger")][1]');
    await actions.click();
    await page.waitForTimeout(400);
    const item = page.locator('.x-menu-item-text:visible, .x-boundlist-item:visible').filter({ hasText: /^Cancel Reservation$/ });
    if ((await item.count()) !== 1) {
      const labels = await page.evaluate(() => [...document.querySelectorAll('[data-qtip]')].map((node) => node.getAttribute('data-qtip')).filter((tip) => /cancel|reserv/i.test(tip || '')));
      throw new Error(`ABORT_CANCEL_MENU:${JSON.stringify(labels)}`);
    }
    await item.click();
  }
  const dialog = page.locator('.x-window:visible').filter({ hasText: 'Cancellation Reason' });
  await dialog.waitFor();
  await dialog.locator('textarea:visible').fill('Lab proof cancel');
  await dialog.locator('.x-form-arrow-trigger').click();
  const option = page.locator('.x-boundlist-item:visible').first();
  await option.click();
  await page.waitForTimeout(300);
  const clicked = await page.evaluate(() => {
    const windows = [...document.querySelectorAll('.x-window')].filter((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && /Cancellation Reason/.test(node.innerText || '');
    });
    if (windows.length !== 1) return { ok: false, reason: 'windows', count: windows.length };
    const buttons = [...windows[0].querySelectorAll('.x-btn')].filter((button) => {
      const box = button.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && (button.innerText || '').trim() === 'OK';
    });
    const paired = buttons.filter((button) => {
      const parent = button.parentElement;
      if (!parent) return false;
      return [...parent.querySelectorAll('.x-btn')].some((sibling) => (sibling.innerText || '').trim() === 'Cancel');
    });
    if (paired.length !== 1) return { ok: false, reason: 'ok-buttons', ids: buttons.map((button) => button.id) };
    paired[0].click();
    return { ok: true, id: paired[0].id };
  });
  if (!clicked.ok) throw new Error(`ABORT_OK:${JSON.stringify(clicked)}`);
  await page.waitForTimeout(1500);
  const followUp = await page.evaluate(() => {
    const windows = [...document.querySelectorAll('.x-window')].filter((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && !/Cancellation Reason/.test(node.innerText || '');
    });
    return windows.map((node) => (node.innerText || '').replace(/\s+/g, ' ').slice(0, 240));
  });
  const extra = followUp.find((text) => /11110906-1/.test(text));
  if (extra) {
    const confirmed = await page.evaluate(() => {
      const windows = [...document.querySelectorAll('.x-window')].filter((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && /11110906-1/.test(node.innerText || '') && !/Cancellation Reason/.test(node.innerText || '');
      });
      if (windows.length !== 1) return false;
      const ok = [...windows[0].querySelectorAll('.x-btn')].filter((button) => {
        const box = button.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && (button.innerText || '').trim() === 'OK';
      });
      if (ok.length !== 1) return false;
      ok[0].click();
      return true;
    });
    if (!confirmed) throw new Error(`ABORT_FOLLOWUP:${JSON.stringify(followUp)}`);
  } else if (followUp.length) {
    throw new Error(`ABORT_UNKNOWN_DIALOG:${JSON.stringify(followUp)}`);
  }
  await page.waitForTimeout(2000);
}

async function main() {
  const dir = outDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const url = new URL(process.env.HMS_STAGEHAND_CDP_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('PRIVATE_CDP_REQUIRED');
  if (process.env.HMS_STAGEHAND_BROWSER_OWNERSHIP !== 'borrowed') throw new Error('BORROWED_REQUIRED');
  const secret = await readSecret();
  const browser = await playwright().chromium.connectOverCDP(url.href, { timeout: 20000 });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const result = { target: TARGET, cancelled: false };
  try {
    await login(page, secret);
    await menu(page, ['Front Desk', 'Guest Stay']);
    await page.waitForTimeout(1500);
    await shot(page, dir, 'cancel-list.png');
    const opened = await openTarget(page);
    result.opened = opened;
    if (String(opened).startsWith('not-found')) {
      result.outcome = 'not_found';
      await shot(page, dir, 'cancel-failure.png');
      return;
    }
    await page.locator('input[name="confirmationnumber"]').waitFor({ timeout: 20000 });
    await page.waitForTimeout(1000);
    const before = await readIdentity(page);
    result.before = before;
    await shot(page, dir, 'cancel-before.png');
    if (!sameStay(before)) {
      result.outcome = 'aborted_identity';
      return;
    }
    if (/cancel/i.test(before.status)) {
      result.outcome = 'already_cancelled';
      result.cancelled = true;
      return;
    }
    await cancelOpenRecord(page);
    const after = await readIdentity(page);
    result.after = after;
    result.cancelled = sameStay({ ...after, status: before.status }) && /cancel/i.test(after.status);
    result.outcome = result.cancelled ? 'cancelled' : 'cancel_failed';
    await shot(page, dir, 'cancel-after.png');
  } catch (error) {
    result.outcome = 'execution_failure';
    result.error = String(error.message || error);
    await shot(page, dir, 'cancel-failure.png').catch(() => {});
  } finally {
    await writeFile(join(dir, 'cancel-result.json'), JSON.stringify(result, null, 2));
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  process.stdout.write(`${result.outcome}\n`);
  if (result.outcome !== 'cancelled' && result.outcome !== 'already_cancelled') process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 2;
});
