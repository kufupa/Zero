#!/usr/bin/env node
// Guest Stay New Record from --request <path>. Validates
// create-tool.schema.json $defs.request before any browser work.
// Refuses Save while a required asterisk is blank.
import { openGuestStayScreen } from './open-guest-stay.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayDate, login, newBorrowedContext, playwright, readSecret } from './fetch-quote.mjs';
import { assertTrackReadyForGuarantee, loadCreateRequest, loadCreateToolSchema, matchTrackRow, optionalPartyAndNoteFills, parseOutDir, parseShop, parseStopBefore, parseTrackLookupText, refuseRateRowClick, shopResult, stayActions, TRACK_LABELS } from './create-request.mjs';
import { readSettledStatus, waitForSaveConfirmation } from './save-wait.mjs';
import { installReadOnlyGuard } from './hms-read-only-guard.mjs';
import { paneCommitOutcome, proofModeRefusal, proofPreSaveSearchRefusal, reconcileCreateSave, saveClickMayHaveFired } from './create-proof-rules.mjs';

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

// --- ext-message-box-rules ---
export const INFORMATIONAL_NO_ROOMS_MESSAGE = 'There are no rooms or openings for this process.';
const MONEY_MESSAGE = /penalty|charge|cancel|deposit|no-show|payment/i;

export function classifyExtMessageBox(text) {
  const trimmed = String(text ?? '').trim();
  if (MONEY_MESSAGE.test(trimmed)) return 'refuse';
  if (trimmed === INFORMATIONAL_NO_ROOMS_MESSAGE) return 'allow';
  return 'unknown';
}

export function labtestInformationalOkAllowed(stay) {
  return /^labtest$/i.test(String(stay?.lastName ?? '')) && String(stay?.arrival ?? '') >= '2027-01-01';
}

export function extMessageBoxAction(text, stay) {
  const kind = classifyExtMessageBox(text);
  if (kind === 'refuse') return 'refuse';
  if (kind === 'allow' && labtestInformationalOkAllowed(stay)) return 'ok';
  return 'unknown';
}
// --- end-ext-message-box-rules ---

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

// Ext combo opens on the visible arrow trigger, not ArrowDown on the input.
// page.getByText(label).last() matched hidden ARIA / the closed input and
// then option.click({ timeout: 5000 }) died with no option list logged.
async function listVisibleComboOptions(page) {
  return page.evaluate(() => {
    const visible = (el) => !!(el.offsetParent || el.getClientRects().length);
    const lists = [...document.querySelectorAll('.x-boundlist')].filter(visible);
    const list = lists.at(-1);
    if (!list) return [];
    return [...list.querySelectorAll('.x-boundlist-item')]
      .filter(visible)
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  });
}

export async function chooseCombo(page, name, label) {
  const input = page.locator(`input[name="${name}"]:visible`).first();
  const trigger = input.locator('xpath=ancestor::table[1]').locator('.x-form-arrow-trigger:visible, .x-form-trigger:visible').first();
  if (await trigger.count()) await trigger.click();
  else {
    await input.click();
    await input.press('ArrowDown');
  }
  const list = page.locator('.x-boundlist:visible').last();
  await list.locator('.x-boundlist-item:visible').first().waitFor({ timeout: 5000 }).catch(() => {});
  const options = await listVisibleComboOptions(page);
  process.stderr.write(`${JSON.stringify({ phase: name === 'guaranteetype' ? 'guarantee_options' : 'chooseCombo', name, optionCount: options.length, options })}\n`);
  if (!options.length) throw new Error(`combo_options_missing:${name}`);
  if (!options.includes(label)) throw new Error(`combo_option_missing:${name}`);
  // Click the item itself. getByText() looks for a descendant; Ext often
  // puts the label as the item's own text (no child text node).
  const clicked = await list.evaluate((root, want) => {
    const visible = (el) => !!(el.offsetParent || el.getClientRects().length);
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const match = [...root.querySelectorAll('.x-boundlist-item')]
      .filter(visible)
      .find((el) => norm(el.textContent) === want);
    if (!match) return false;
    match.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`combo_option_missing:${name}`);
}

async function listTrackLookupRows(page) {
  return page.evaluate(() => {
    const visible = (el) => !!(el.offsetParent || el.getClientRects().length);
    const bound = [...document.querySelectorAll('.x-boundlist')].filter(visible).at(-1);
    if (bound) {
      return [...bound.querySelectorAll('.x-boundlist-item')]
        .filter(visible)
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    }
    const grid = [...document.querySelectorAll('.x-window .x-grid-view, .x-window .x-grid')].filter(visible).at(-1);
    if (!grid) return [];
    return [...grid.querySelectorAll('.x-grid-row, .x-grid-data-row')]
      .filter(visible)
      .map((row) => (row.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  });
}

async function clickTrackLookupRow(page, picked) {
  return page.evaluate((want) => {
    const visible = (el) => !!(el.offsetParent || el.getClientRects().length);
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const matches = (text) => {
      const t = norm(text);
      if (!t) return false;
      if (want.text && t === want.text) return true;
      if (want.description && t.includes(want.description) && (!want.code || t.includes(want.code))) return true;
      return want.code && t === want.code;
    };
    const bound = [...document.querySelectorAll('.x-boundlist')].filter(visible).at(-1);
    if (bound) {
      const item = [...bound.querySelectorAll('.x-boundlist-item')].filter(visible).find((el) => matches(el.textContent));
      if (!item) return false;
      item.click();
      return true;
    }
    const grid = [...document.querySelectorAll('.x-window .x-grid-view, .x-window .x-grid')].filter(visible).at(-1);
    if (!grid) return false;
    const row = [...grid.querySelectorAll('.x-grid-row, .x-grid-data-row')].filter(visible).find((el) => matches(el.innerText));
    if (!row) return false;
    row.click();
    return true;
  }, picked);
}

export function inspectFieldValidation(field, document = globalThis.document) {
  const visible = (el) => {
    if (!el) return false;
    const attrStyle = typeof el.getAttribute === 'function' ? el.getAttribute('style') || '' : '';
    const cssText = el.style ? String(el.style.cssText || '') : '';
    const display = el.style && el.style.display ? String(el.style.display) : '';
    const style = `${attrStyle} ${cssText} ${display ? `display:${display}` : ''}`;
    if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) return false;
    if (typeof el.hasAttribute === 'function' && el.hasAttribute('hidden')) return false;
    const cls = String(el.className || '');
    if (/\bx-hide-display\b|\bx-hide-offsets\b|\bx-hidden\b/.test(cls)) return false;
    if (el.offsetParent) return true;
    if (typeof el.getClientRects === 'function') {
      const rects = el.getClientRects();
      if (rects && rects.length) return true;
    }
    return false;
  };
  const input = document.querySelector(`input[name="${field}"]`);
  if (!input) return { invalid: true, messages: ['missing'], value: '' };
  const wrap = input.closest('.x-form-item, .x-field, table') || input.parentElement;
  const icon = wrap?.querySelector?.('.x-form-invalid-icon');
  const iconVisible = visible(icon);
  const markedInvalid =
    input.getAttribute('aria-invalid') === 'true'
    || /(^|\s)x-form-invalid(\s|$)/.test(String(input.className || ''))
    || /(^|\s)x-form-invalid(\s|$)/.test(String(wrap?.className || ''));
  const qtip = (input.getAttribute('data-errorqtip') || '').trim();
  const messages = [
    qtip,
    iconVisible
      ? icon.getAttribute('data-errorqtip') || icon.getAttribute('data-qtip') || icon.getAttribute('qtip')
      : '',
    input.getAttribute('aria-invalid') === 'true' ? 'aria-invalid' : '',
    markedInvalid ? 'x-form-invalid' : '',
  ].filter((msg) => msg && String(msg).trim());
  return {
    invalid: Boolean(markedInvalid || iconVisible || qtip),
    messages,
    value: (input.value || '').trim(),
  };
}

export async function readFieldValidation(page, name) {
  return page.evaluate(inspectFieldValidation, name);
}

export async function readAverageRate(page) {
  return page.evaluate((field) => {
    const input = document.querySelector(`input[name="${field}"]`);
    return (input?.value || '').trim();
  }, 'averagerate');
}

export function trackFillDescription(want) {
  if (TRACK_LABELS[want]) return want;
  const found = Object.entries(TRACK_LABELS).find(([, code]) => code === want);
  return found ? found[0] : want;
}

export async function hmsProcessingVisible(page) {
  return page.evaluate(() => {
    const visible = (el) => !!(el && (el.offsetParent || (typeof el.getClientRects === 'function' && el.getClientRects().length)));
    const maskVisible = [...document.querySelectorAll('.x-mask-msg')].some(visible);
    const processingVisible = [...document.querySelectorAll('.x-mask-msg, .x-mask-msg-text')].some(
      (el) => visible(el) && /Processing request/i.test(el.textContent || ''),
    );
    return maskVisible || processingVisible;
  });
}

async function waitUntil(page, check, timeoutMs, errorName) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(200);
    else break;
  }
  if (!(await check())) throw new Error(errorName);
}

export async function waitHmsMaskCleared(page, timeoutMs = 20_000) {
  await waitUntil(page, async () => !(await hmsProcessingVisible(page)), timeoutMs, 'mask_timeout');
}

export async function waitAverageRate(page, timeoutMs = 3_000) {
  let value = await readAverageRate(page);
  const deadline = Date.now() + timeoutMs;
  while (!String(value || '').trim() && Date.now() < deadline) {
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(200);
    else break;
    value = await readAverageRate(page);
  }
  return value;
}

export async function pickTrackLookup(page, want) {
  const input = page.locator('input[name="track"]:visible').first();
  const wrap = input.locator('xpath=ancestor::*[contains(@class,"x-form-item") or contains(@class,"x-field")][1]');
  const trigger = wrap
    .locator('.x-form-lov-trigger:visible, .x-form-search-trigger:visible, .x-form-trigger:visible')
    .first();
  if (!(await trigger.count())) throw new Error('track_trigger_missing');
  await trigger.click();
  const row = page
    .locator(
      '.x-boundlist:visible .x-boundlist-item:visible, .x-window:visible .x-grid-row:visible, .x-window:visible .x-grid-data-row:visible',
    )
    .first();
  try {
    await row.waitFor({ timeout: 5000 });
  } catch (error) {
    throw new Error(`track_lookup_timeout:${error && error.message ? error.message : error}`);
  }
  const texts = await listTrackLookupRows(page);
  const rows = texts.map((text) => parseTrackLookupText(text)).filter(Boolean);
  process.stderr.write(`${JSON.stringify({ phase: 'trackLookup', rowCount: rows.length, rows })}\n`);
  const picked = matchTrackRow(rows, want);
  if (!picked) throw new Error('track_row_missing');
  const clicked = await clickTrackLookupRow(page, picked);
  if (!clicked) throw new Error('track_row_missing');
  return picked;
}

function trackValueValid(validation) {
  return Boolean(validation?.value) && !validation.invalid;
}

export async function fillTrackBeforeGuarantee(page, want) {
  const description = trackFillDescription(want);
  await fillNamed(page, 'track', description);
  process.stderr.write(`${JSON.stringify({ phase: 'track_typed', description })}\n`);
  let validation = await readFieldValidation(page, 'track');
  process.stderr.write(`${JSON.stringify({ phase: 'track_valid', valid: trackValueValid(validation), invalid: validation.invalid })}\n`);
  let picked = null;
  if (!trackValueValid(validation)) {
    picked = await pickTrackLookup(page, want);
    validation = await readFieldValidation(page, 'track');
  }
  await waitHmsMaskCleared(page);
  process.stderr.write(`${JSON.stringify({ phase: 'mask_cleared' })}\n`);
  validation = await readFieldValidation(page, 'track');
  if (!trackValueValid(validation)) {
    picked = await pickTrackLookup(page, want);
    validation = await readFieldValidation(page, 'track');
  }
  const averageRate = await waitAverageRate(page);
  process.stderr.write(`${JSON.stringify({ phase: 'average_rate', blank: !String(averageRate || '').trim() })}\n`);
  validation = await readFieldValidation(page, 'track');
  assertTrackReadyForGuarantee({ validation });
  return picked ?? { code: want === 'Best Available' ? 'BAR' : want, description };
}

const EXT_MESSAGE_BOX = '[data-testid="message-box"], .x-message-box';

async function readVisibleExtMessageBoxText(page) {
  const box = page.locator(EXT_MESSAGE_BOX).filter({ visible: true }).first();
  if (await box.count() === 0) return null;
  const body = box.locator('.x-window-body, .ext-mb-text').first();
  const node = (await body.count()) ? body : box;
  const raw = await node.innerText().catch(() => '');
  return String(raw ?? '').trim().replace(/\s*OK\s*$/i, '').trim();
}

async function handleVisibleExtMessageBox(page, dir, result, stay) {
  const text = await readVisibleExtMessageBoxText(page);
  if (text == null) return 'none';
  result.messageBoxText = text;
  const action = extMessageBoxAction(text, stay);
  if (action === 'ok') {
    const box = page.locator(EXT_MESSAGE_BOX).filter({ visible: true }).first();
    await box.locator('a.x-btn:visible, button:visible').filter({ hasText: /^OK$/ }).first().click();
    result.messageBox = 'dismissed_informational';
    return 'ok';
  }
  await shot(page, dir, 'failure.png').catch(() => {});
  result.outcome = action === 'refuse' ? 'refused_message_box' : 'unknown_message_box';
  if (result.clickedSave !== true) result.clickedSave = false;
  process.stderr.write(`${result.outcome}\n`);
  return 'abort';
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

async function withReadOnlyGuestStay(browser, secret, dir, args, read) {
  const context = await newBorrowedContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  try {
    await installReadOnlyGuard(context);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await login(page, secret);
    await openGuestStayScreen(page);
    await page.waitForTimeout(1500);
    return await read({ args, dir, page, result: null, started: Date.now() });
  } finally {
    await context.close().catch(() => {});
  }
}

async function searchGuestByDates(browser, secret, dir, expected) {
  const { searchGuestOnOpenGuestStay } = await import('./stay-lookup.mjs');
  return withReadOnlyGuestStay(browser, secret, dir, {
    mode: 'search-guest', confirmation: null, lastName: expected.lastName,
    arrival: expected.arrival, departure: expected.departure, debugHtml: false,
  }, async (ctx) => {
    const found = await searchGuestOnOpenGuestStay(ctx);
    return {
      outcome: found.outcome,
      rows: found.rows,
      screenshot: found.screenshots.at(-1) ?? null,
    };
  });
}

async function readExistingGuestRows(browser, secret, stay, dir) {
  try {
    const search = await searchGuestByDates(browser, secret, dir, stay);
    return search?.outcome === 'ok' && Array.isArray(search.rows) ? search.rows : null;
  } catch {
    return null;
  }
}

async function runProofReadback(browser, secret, stay, dir, save, savedScreenshot, existingRows) {
  const proof = await reconcileCreateSave({
    save,
    expected: stay,
    existingRows,
    readByConfirmation: async (confirmation) => {
      const { findOnOpenGuestStay } = await import('./stay-lookup.mjs');
      return withReadOnlyGuestStay(browser, secret, dir, {
        mode: 'find', confirmation, arrival: null, departure: null, lastName: stay.lastName, debugHtml: false,
      }, async (ctx) => {
        const found = await findOnOpenGuestStay(ctx, { captureScreenshots: false });
        return {
          outcome: found.outcome,
          stay: found.stay,
          screenshot: await shot(ctx.page, dir, 'readback.png').catch(() => null),
        };
      });
    },
    searchByGuestDates: (expected) => searchGuestByDates(browser, secret, dir, expected),
  });
  return {
    confNo: proof.confNo,
    readbackMatch: proof.readbackMatch,
    mismatches: proof.mismatches,
    screenshot: proof.screenshot ?? savedScreenshot,
    unknownOutcome: proof.unknownOutcome,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const proofMode = argv.includes('--proof');
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
  if (proofMode && shopMode) {
    process.stderr.write('proof_incompatible_with_shop\n');
    process.exitCode = 2;
    return;
  }
  if (proofMode) {
    const refusal = proofModeRefusal({ request: stay, paneCommit: stop.paneCommit, env: process.env });
    if (refusal) {
      process.stderr.write(`${refusal}\n`);
      process.exitCode = 2;
      return;
    }
  }
  const dir = out.outDir ?? defaultOutDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const url = new URL(process.env.HMS_STAGEHAND_CDP_URL);
  if (!['http:', 'ws:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('PRIVATE_CDP_REQUIRED');
  }
  if (process.env.HMS_STAGEHAND_BROWSER_OWNERSHIP !== 'borrowed') throw new Error('BORROWED_REQUIRED');
  const secret = await readSecret();
  if (secret.expectedPropertyCode !== 'HRCEN') throw new Error('PROPERTY_HRCEN_REQUIRED');
  const browser = await playwright().chromium.connectOverCDP(url.href, { timeout: 20000 });
  const context = await newBorrowedContext(browser, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  page.on('dialog', (dialog) => {
    dialog.dismiss().catch(() => {});
  });
  page.setDefaultTimeout(20000);
  const result = { guest: stay, held: false, saved: false, cancelled: false };
  try {
    await login(page, secret);
    await openGuestStayScreen(page);
    await page.locator('[data-qtip="New Record (Ctrl+N)"]').click();
    await page.locator('input[name="lastname"]:visible').waitFor();
    if (!shopMode) await shot(page, dir, 'before.png');
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
    if (stop.stopBefore !== 'availability') {
      // Party lookups, Reservation Note and booker fields. Empty values are skipped. LIVE-UNVERIFIED: see create-request.mjs.
      for (const [name, value] of Object.entries(optionalPartyAndNoteFills(stay))) {
        if (value) await fillNamed(page, name, value);
      }
      if (stay.arAccount) await fillNamed(page, 'araccountname', stay.arAccount);
      if (stay.billingReference) await fillNamed(page, 'billingreference', stay.billingReference);
      if (Object.hasOwn(stay, 'profileId')) await fillNamed(page, 'guestid', String(stay.profileId));
    }
    await fillTrackBeforeGuarantee(page, stay.track);
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
    if (await handleVisibleExtMessageBox(page, dir, result, stay) === 'abort') {
      process.exitCode = 2;
      return;
    }
    if (stop.stopBefore === 'save') {
      result.outcome = 'previewed';
      result.clickedSave = false;
      result.saved = false;
      await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
      process.stdout.write(`${result.outcome}\n`);
      return;
    }
    const verifySave = proofMode || stop.paneCommit;
    const existingRows = verifySave
      ? await readExistingGuestRows(browser, secret, stay, dir)
      : null;
    const preSaveRefusal = verifySave ? proofPreSaveSearchRefusal(existingRows) : null;
    if (preSaveRefusal) {
      result.outcome = 'refused_save';
      result.refusalReason = preSaveRefusal;
      result.clickedSave = false;
      process.stderr.write(`${preSaveRefusal}\n`);
      process.exitCode = 2;
      return;
    }
    if (await handleVisibleExtMessageBox(page, dir, result, stay) === 'abort') {
      result.clickedSave = false;
      process.exitCode = 2;
      return;
    }
    let saveClickUnknown = false;
    try {
      await clickTip(page, '^Save');
      result.clickedSave = true;
    } catch (error) {
      if (!verifySave || !saveClickMayHaveFired(error)) throw error;
      result.clickedSave = true;
      result.saveError = String(error.message || error);
      saveClickUnknown = true;
    }
    if (await handleVisibleExtMessageBox(page, dir, result, stay) === 'abort') {
      process.exitCode = 2;
      return;
    }
    // HMS masks the record while it saves. Read the number only once the mask is gone. A missing number is
    // save_unconfirmed, never a failed save: HMS may already have booked the stay.
    let save;
    if (saveClickUnknown) {
      save = { confirmed: false, confirmationNumber: null, reason: 'save_click_unconfirmed' };
    } else {
      try {
        save = await waitForSaveConfirmation(page);
      } catch (error) {
        if (!verifySave) throw error;
        result.saveError = String(error.message || error);
        save = { confirmed: false, confirmationNumber: null, reason: 'save_observation_error' };
      }
    }
    result.confirmationNumber = save.confirmationNumber;
    result.saved = save.confirmed;
    result.saveReason = save.reason;
    if (save.confirmed) {
      result.statusAfterSave = proofMode
        ? await readSettledStatus(page).catch(() => null)
        : await readSettledStatus(page);
    }
    result.message = proofMode ? await readMessage(page).catch(() => null) : await readMessage(page);
    const savedScreenshot = verifySave
      ? await shot(page, dir, 'saved.png').catch(() => null)
      : await shot(page, dir, 'saved.png');
    if (verifySave) {
      const proof = await runProofReadback(
        browser, secret, stay, dir, save, savedScreenshot, existingRows,
      );
      result.confirmationNumber = proof.confNo ?? save.confirmationNumber;
      result.saved = proof.confNo ? true : null;
      result.proof = proof;
      if (proofMode) {
        result.outcome = proof.readbackMatch === true ? 'readback_match'
          : proof.unknownOutcome === 'not_found' ? 'unknown_not_found'
            : proof.unknownOutcome ? `unknown_${proof.unknownOutcome}` : 'readback_mismatch';
        result.cancelled = false;
        process.stdout.write(`${JSON.stringify(proof)}\n`);
        if (proof.readbackMatch !== true) process.exitCode = 1;
        return;
      }
      result.cancelled = false;
      result.outcome = paneCommitOutcome(proof);
      await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
      process.stdout.write(`${result.outcome}${result.confirmationNumber ? ` ${result.confirmationNumber}` : ''}\n`);
      return;
    }
    if (!result.saved) {
      result.outcome = 'save_unconfirmed';
      await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
      process.stdout.write(`${result.outcome}\n`);
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
    if (typeof browser.disconnect === 'function') browser.disconnect();
  }
  process.stdout.write(`${result.outcome}\n`);
  if (result.outcome !== 'saved_then_cancelled') process.exitCode = 2;
}

async function flushOutput() {
  await Promise.all([
    new Promise((resolveOutput) => process.stdout.write('', resolveOutput)),
    new Promise((resolveError) => process.stderr.write('', resolveError)),
  ]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    async () => {
      await flushOutput();
      process.exit(process.exitCode ?? 0);
    },
    async (error) => {
      process.stderr.write(`${error.message || error}\n`);
      await flushOutput();
      process.exit(2);
    },
  );
}
