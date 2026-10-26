#!/usr/bin/env node
// Cancel one lab Guest Stay. Aborts unless confirmation, name, and arrival match.
import { openGuestStayScreen } from './open-guest-stay.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newBorrowedContext, playwright, readSecret } from './fetch-quote.mjs';
import { labGuard, parsePenalty } from './cancel-stay-rules.mjs';
import { parseStayProperty, propertySecretRefusal } from './property-profile.mjs';
import { withWriteCliPage } from './write-cli-lease.mjs';

export { withWriteCliPage as withLeasedWritePage };

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

// Text of every visible window, so a penalty charge is seen the same way on every page.
async function visibleWindowTexts(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.x-window')]
      .filter((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      })
      .map((node) => (node.innerText || '').replace(/\s+/g, ' ').slice(0, 400)),
  );
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
  // A charge on screen refuses before a reason is picked or OK is clicked, as in cancel-stay-rules runCancelDialog.
  const penaltyBefore = parsePenalty(await visibleWindowTexts(page));
  if (penaltyBefore) return { refusedPenalty: penaltyBefore };
  await dialog.locator('textarea:visible').fill('Lab proof cancel');
  await dialog.locator('.x-form-arrow-trigger').click();
  const option = page.locator('.x-boundlist-item:visible').first();
  await option.click();
  await page.waitForTimeout(300);
  const penaltyNow = parsePenalty(await visibleWindowTexts(page));
  if (penaltyNow) return { refusedPenalty: penaltyNow };
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
  // A penalty after OK is left for a person: nothing is clicked on it, and the run reports needs check.
  const penaltyAfter = parsePenalty(followUp);
  if (penaltyAfter) return { penaltyPending: penaltyAfter };
  const extra = followUp.find((text) => /11110906-1/.test(text));
  if (extra) {
    // The full text of every visible window is read in the same call as the click, so a penalty that appeared after
    // the read above stops the click instead of being confirmed.
    const confirmed = await page.evaluate(() => {
      const visible = [...document.querySelectorAll('.x-window')].filter((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
      const penalty = visible
        .map((node) => (node.innerText || '').replace(/\s+/g, ' '))
        .find((text) => /penalt/i.test(text));
      if (penalty) return { clicked: false, penalty };
      const windows = visible.filter(
        (node) => /11110906-1/.test(node.innerText || '') && !/Cancellation Reason/.test(node.innerText || ''),
      );
      if (windows.length !== 1) return { clicked: false };
      const ok = [...windows[0].querySelectorAll('.x-btn')].filter((button) => {
        const box = button.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && (button.innerText || '').trim() === 'OK';
      });
      if (ok.length !== 1) return { clicked: false };
      ok[0].click();
      return { clicked: true };
    });
    if (confirmed.penalty) return { penaltyPending: parsePenalty([confirmed.penalty]) ?? confirmed.penalty };
    if (!confirmed.clicked) throw new Error(`ABORT_FOLLOWUP:${JSON.stringify(followUp)}`);
  } else if (followUp.length) {
    throw new Error(`ABORT_UNKNOWN_DIALOG:${JSON.stringify(followUp)}`);
  }
  await page.waitForTimeout(2000);
  return { penaltyPending: null };
}

export async function main(argv = process.argv.slice(2)) {
  const property = parseStayProperty(argv);
  if (!property.ok) {
    process.stderr.write(`${property.error}\n`);
    process.exitCode = property.exitCode ?? 2;
    return property.exitCode ?? 2;
  }
  const dir = outDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const url = new URL(process.env.HMS_STAGEHAND_CDP_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('PRIVATE_CDP_REQUIRED');
  if (process.env.HMS_STAGEHAND_BROWSER_OWNERSHIP !== 'borrowed') throw new Error('BORROWED_REQUIRED');
  const secret = await readSecret();
  const hotelMismatch = propertySecretRefusal(secret, property.propertyCode);
  if (hotelMismatch) throw new Error(hotelMismatch);
  const browser = await playwright().chromium.connectOverCDP(url.href, { timeout: 20000 });
  const context = await newBorrowedContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const result = { target: TARGET, cancelled: false };
  let page = null;
  try {
    await withWriteCliPage({
      propertyCode: property.propertyCode, secret, context, browser, env: process.env,
    }, async ({ page: leased }) => {
      page = leased;
      page.setDefaultTimeout?.(20000);
    await openGuestStayScreen(page);
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
    // The guard runs on the record HMS shows: last name Labtest and an arrival in 2027 or later.
    const lab = labGuard({ lastName: before.lastName, arrival: before.arrival });
    if (!lab.ok) {
      result.outcome = 'refused_not_lab';
      result.reason = lab.reason;
      return;
    }
    if (/cancel/i.test(before.status)) {
      result.outcome = 'already_cancelled';
      result.cancelled = true;
      return;
    }
    const cancel = await cancelOpenRecord(page);
    const penalty = cancel.refusedPenalty ?? cancel.penaltyPending;
    if (penalty) {
      result.penaltyText = penalty.text;
      result.penaltyAmount = penalty.amount;
      result.outcome = cancel.refusedPenalty ? 'refused_penalty' : 'cancel_penalty_pending';
      await shot(page, dir, 'penalty.png');
      return;
    }
    const after = await readIdentity(page);
    result.after = after;
    result.cancelled = sameStay({ ...after, status: before.status }) && /cancel/i.test(after.status);
    result.outcome = result.cancelled ? 'cancelled' : 'cancel_failed';
    await shot(page, dir, 'cancel-after.png');
    });
  } catch (error) {
    result.outcome = 'execution_failure';
    result.error = String(error.message || error);
    await shot(page, dir, 'cancel-failure.png').catch(() => {});
  } finally {
    await writeFile(join(dir, 'cancel-result.json'), JSON.stringify(result, null, 2));
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    // Every path reports here, including the early returns above, so a refusal never exits 0.
    process.stdout.write(`${result.outcome}\n`);
    if (result.outcome !== 'cancelled' && result.outcome !== 'already_cancelled') process.exitCode = 2;
  }
  return process.exitCode ?? 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 2;
  });
}
