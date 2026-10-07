#!/usr/bin/env node
// Cancel one lab Guest Stay by confirmation number. The stay must be
// Labtest with arrival on or after 2027-01-01 and match --confirmation and
// --arrival, or the run refuses before any cancel action.
// Find uses the header quick search: its dropdown row (conf, "Last, First", status,
// dates) is guarded before the record is opened, and a Cancelled row ends the run.
// If the quick-search window does not cover arrival, its calendar icon moves it first;
// the grid window picker is the fallback.
// Preview reads the reason list and dismisses the dialog unconfirmed.
// Commit picks --reason and clicks its OK once. A cancellation penalty dialog is
// recorded and left open; OK is never clicked on it.
// Usage: node cancel-stay.mjs --confirmation 57291630-1 --arrival 2027-09-14 --mode preview|commit --out <dir> [--reason "Test Reservations"]
// Exit: 0 preview_ok|cancelled|already_cancelled; 2 refused_* or usage; 1 other outcome (also writes failure.png).
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { login, playwright, readSecret } from './fetch-quote.mjs';
import {
  checkCdpEnv, exitCodeFor, findReasonIndex, identityCheck, isCancelledStatus, normalizeReasons,
  parseCancelArgs, parseDateWindowLabel, parsePenalty, parseQuickSearchRow, pickerMonthSteps, preflight,
  resolveOutcome, squash, windowCovers,
} from './cancel-stay-rules.mjs';

const MAX_PICKER_CLICKS = 60;
const QUICK_WAIT_MS = 8000;
const CANCEL_NOTE = 'Lab proof cancel';
const PICKER_OPEN = '.x-datepicker:visible, .x-date-picker:visible, .x-monthpicker:visible';
const PICKER_TITLE = '.x-datepicker-month .x-btn-inner, .x-datepicker-month';
const PICKER_NEXT = '.x-datepicker-next, .x-datepicker-next a';
const PICKER_PREV = '.x-datepicker-prev, .x-datepicker-prev a';
const WINDOW_LABEL_TEXT = /\w{3} \d{1,2}, \d{4} - \w{3} \d{1,2}, \d{4}/;

function newResult(args) {
  return {
    outcome: null,
    confirmation: args.confirmation,
    arrival: args.arrival,
    mode: args.mode,
    reason: args.reason,
    statusBefore: null,
    statusAfter: null,
    reasons: [],
    findMethod: null,
    cancelPath: null,
    penaltyText: null,
    penaltyAmount: null,
    penaltyPending: false,
    clickedOk: false,
    followUps: [],
    readbackMethod: null,
    refusal: null,
    error: null,
    screenshots: [],
    timings: {},
  };
}

function mark(ctx, name) {
  ctx.result.timings[name] = Date.now() - ctx.started;
}

async function shot(ctx, name) {
  const path = join(ctx.dir, name);
  await ctx.page.screenshot({ path, fullPage: true });
  ctx.result.screenshots.push(path);
}

async function visibleIndexes(locator) {
  const indexes = [];
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) indexes.push(index);
  }
  return indexes;
}

// Visible input wins over hidden duplicates of the same name.
async function readRecord(page) {
  return page.evaluate(() => {
    const value = (name) => {
      const input = [...document.querySelectorAll(`input[name="${name}"]`)].find((el) => el.getClientRects().length);
      return (input?.value || '').trim();
    };
    return {
      confirmation: value('confirmationnumber'),
      lastName: value('lastname'),
      arrival: value('arrivaldate'),
      status: value('status'),
    };
  });
}

async function visibleWindowTexts(page) {
  return page.evaluate(() => [...document.querySelectorAll('.x-window')]
    .filter((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    })
    .map((node) => (node.innerText || '').replace(/\s+/g, ' ').trim()));
}

async function openGuestStay(page) {
  await page.locator('a.app-menu-trigger:visible').click();
  for (const name of ['Front Desk', 'Guest Stay']) {
    await page.locator('span.x-tree-node-text:visible').filter({ hasText: new RegExp(`^${name}$`) }).click();
  }
}

async function searchConfirmation(page, confirmation) {
  const search = page.getByPlaceholder(/Search by Name, Confirmation/i).first();
  await search.click({ force: true });
  await search.fill(confirmation);
  await page.waitForTimeout(800);
}

async function runSearch(page) {
  await page.locator('a.x-btn:visible').filter({ hasText: /^Run$/ }).first().click({ force: true });
  await page.waitForTimeout(2000);
}

// The window picker opens on a real mouse click (cancel-now.mjs); a programmatic click does not open it.
// The window label nearest the bottom of the screen. Its calendar icon sits just to its right.
async function lowestWindowLabel(page) {
  const labels = page.getByText(WINDOW_LABEL_TEXT);
  let best = null;
  for (const index of await visibleIndexes(labels)) {
    const box = await labels.nth(index).boundingBox();
    if (box && box.width > 40 && (!best || box.y > best.box.y)) best = { locator: labels.nth(index), box };
  }
  return best;
}

async function readWindow(page) {
  const label = await lowestWindowLabel(page);
  return label ? parseDateWindowLabel(await label.locator.innerText()) : null;
}

async function openWindowPicker(page) {
  const label = await lowestWindowLabel(page);
  if (!label) throw new Error('NO_VISIBLE_DATE_WINDOW');
  const { box } = label;
  const midY = box.y + box.height / 2;
  await page.mouse.click(box.x + box.width + 22, midY);
  await page.waitForTimeout(500);
  if ((await page.locator(PICKER_OPEN).count()) === 0) {
    await page.mouse.click(box.x + 8, midY);
    await page.waitForTimeout(400);
  }
  if ((await page.locator(PICKER_OPEN).count()) === 0) throw new Error('DATE_PICKER_NOT_OPEN');
}

// Moves the open picker to the arrival month and clicks the arrival day.
async function pickArrivalDay(page, arrival) {
  const title = page.locator(PICKER_TITLE).first();
  let steps = pickerMonthSteps(await title.innerText(), arrival);
  for (let clicks = 0; steps !== 0; clicks += 1) {
    if (steps === null) throw new Error(`DATE_PICKER_TITLE_UNKNOWN:${squash(await title.innerText()).slice(0, 40)}`);
    if (clicks >= MAX_PICKER_CLICKS) throw new Error('DATE_PICKER_MONTH_UNREACHED');
    await page.locator(steps > 0 ? PICKER_NEXT : PICKER_PREV).first().click();
    await page.waitForTimeout(150);
    steps = pickerMonthSteps(await title.innerText(), arrival);
  }
  const day = new RegExp(`^${Number(arrival.slice(8, 10))}$`);
  let cells = page.locator('.x-datepicker-cell:not(.x-datepicker-prevday):not(.x-datepicker-nextday) a').filter({ hasText: day });
  let hits = await visibleIndexes(cells);
  if (hits.length === 0) {
    cells = page.locator('.x-datepicker-date, .x-datepicker-cell a').filter({ hasText: day });
    hits = await visibleIndexes(cells);
  }
  if (hits.length !== 1) throw new Error(`DATE_PICKER_DAY_AMBIGUOUS:${hits.length}`);
  await cells.nth(hits[0]).click({ force: true });
  await page.waitForTimeout(300);
}

// Some pickers apply on the day click and show no Apply, so Apply is clicked only when it is on screen.
async function clickApplyIfShown(page) {
  const apply = page.locator('a.x-btn:visible').filter({ hasText: /^Apply$/ });
  if ((await apply.count()) === 0) return false;
  await apply.first().click({ force: true });
  await page.waitForTimeout(400);
  return true;
}

// Grid fallback: picker to the arrival day, then Apply if shown, then the grid Run.
async function setArrivalWindow(page, arrival) {
  await openWindowPicker(page);
  await pickArrivalDay(page, arrival);
  await clickApplyIfShown(page);
  await runSearch(page);
}

// Quick-search window: the calendar icon opens the picker and the arrival day moves the window.
async function setQuickWindow(page, arrival) {
  await openWindowPicker(page);
  await pickArrivalDay(page, arrival);
  await clickApplyIfShown(page);
  await page.waitForTimeout(600);
}

// Header quick search: fill the confirmation and press Enter. The dropdown lists matching stays.
async function quickSearch(page, confirmation) {
  const search = page.getByPlaceholder(/Search by Name, Confirmation/i).first();
  await search.click({ force: true });
  await search.fill(confirmation);
  await search.press('Enter');
  await page.waitForTimeout(800);
}

async function clickRunIfShown(page) {
  const run = page.locator('a.x-btn:visible').filter({ hasText: /^Run$/ });
  if ((await run.count()) === 0) return false;
  await run.first().click({ force: true });
  await page.waitForTimeout(1000);
  return true;
}

// For the element holding the confirmation: the nearest ancestor showing an HMS date is the row. Cell texts are
// the row's visible leaf elements in document order. inPanel is true when an ancestor shows the quick-search
// tabs (In-House and Departures), which keeps grid rows out of the match.
async function readQuickRowCells(locator) {
  return locator.evaluate((el) => {
    const DATE = /\b\d{1,2}-[A-Za-z]{3}-\d{4}\b/;
    const shown = (node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    let row = null;
    let inPanel = false;
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const text = node.innerText || '';
      if (!row && DATE.test(text)) row = node;
      if (/In-?House/.test(text) && /Departures/.test(text)) {
        inPanel = true;
        break;
      }
    }
    if (!row) return { inPanel, cells: null };
    const leaves = row.children.length === 0
      ? [row]
      : [...row.querySelectorAll('*')].filter((node) => node.children.length === 0 && shown(node));
    return { inPanel, cells: leaves.map((node) => node.innerText || '') };
  });
}

// Null when the quick panel shows no row for the confirmation. Throws when the row is ambiguous or unreadable.
async function readQuickRow(page, confirmation) {
  const matches = page.getByText(confirmation, { exact: true });
  const candidates = [];
  for (const index of await visibleIndexes(matches)) {
    const locator = matches.nth(index);
    const { inPanel, cells } = await readQuickRowCells(locator);
    if (inPanel) candidates.push({ locator, cells });
  }
  if (candidates.length === 0) return null;
  if (candidates.length > 1) throw new Error('AMBIGUOUS_QUICK_ROW');
  const row = parseQuickSearchRow(candidates[0].cells, confirmation);
  if (!row) throw new Error('QUICK_ROW_UNPARSED');
  return { locator: candidates[0].locator, row };
}

async function waitQuickRow(page, confirmation) {
  const deadline = Date.now() + QUICK_WAIT_MS;
  for (;;) {
    const found = await readQuickRow(page, confirmation);
    if (found || Date.now() >= deadline) return found;
    await page.waitForTimeout(500);
  }
}

// Quick search first. When its window does not cover arrival, the calendar icon moves the window and the search
// runs again. The grid window picker is the last resort. Returns {method, locator, row}; row is null on the grid path.
async function findStay(ctx, { evidence = false } = {}) {
  const { page, args } = ctx;
  await quickSearch(page, args.confirmation);
  let found = await waitQuickRow(page, args.confirmation);
  if (!found && (await clickRunIfShown(page))) found = await waitQuickRow(page, args.confirmation);
  let method = found ? 'quick' : null;
  const dateWindow = await readWindow(page);
  if (dateWindow && !windowCovers(dateWindow, args.arrival)) {
    await setQuickWindow(page, args.arrival);
    await quickSearch(page, args.confirmation);
    const moved = await waitQuickRow(page, args.confirmation);
    if (moved) {
      found = moved;
      method = 'quick_calendar';
    }
  }
  if (found) return { method, locator: found.locator, row: found.row };
  await searchConfirmation(page, args.confirmation);
  await setArrivalWindow(page, args.arrival);
  if (evidence) await shot(ctx, 'window.png');
  const row = await findRow(page, args.confirmation);
  return row ? { method: 'picker', locator: row, row: null } : null;
}

async function findRow(page, confirmation) {
  const rows = page.getByText(confirmation, { exact: true });
  const hits = await visibleIndexes(rows);
  if (hits.length > 1) throw new Error('AMBIGUOUS_CONFIRMATION_ROW');
  return hits.length === 1 ? rows.nth(hits[0]) : null;
}

async function openRecord(page, row) {
  await row.click({ force: true });
  await page.locator('input[name="confirmationnumber"]:visible').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1000);
}

// The Actions arrow can sit outside the viewport: scroll it in, then mouse-click its center.
// Falls back to the toolbar control with data-qtip "Cancel Reservation".
async function openCancelDialog(page) {
  const arrow = page.getByText(/^Actions:?$/).first().locator('xpath=following::*[contains(@class,"x-form-arrow-trigger")][1]');
  if ((await arrow.count()) > 0) {
    await arrow.scrollIntoViewIfNeeded().catch(() => {});
    await arrow.hover({ force: true }).catch(() => {});
    const box = await arrow.boundingBox().catch(() => null);
    const center = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
    // Click only if the arrow is the topmost element at its center; an overlay would take the click.
    const topmost = center ? await arrow.evaluate((el, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return Boolean(hit) && (el === hit || el.contains(hit));
    }, center).catch(() => false) : false;
    if (topmost) {
      await page.mouse.click(center.x, center.y);
      await page.waitForTimeout(400);
      const item = page.locator('.x-menu-item-text:visible, .x-boundlist-item:visible').filter({ hasText: /^Cancel Reservation$/ });
      if ((await item.count()) === 1) {
        await item.first().click({ force: true });
        return 'actions-menu';
      }
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
  const direct = page.locator('[data-qtip="Cancel Reservation"]:visible');
  if ((await direct.count()) !== 1) throw new Error('CANCEL_CONTROL_MISSING');
  await direct.click({ force: true });
  return 'toolbar';
}

async function waitCancelDialog(page) {
  const dialog = page.locator('.x-window:visible').filter({ hasText: 'Cancellation Reason' });
  await dialog.first().waitFor({ timeout: 15000 });
  if ((await dialog.count()) !== 1) throw new Error('CANCEL_DIALOG_AMBIGUOUS');
  return dialog;
}

async function readReasonList(page, dialog) {
  await dialog.locator('.x-form-arrow-trigger').first().click({ force: true });
  await page.waitForTimeout(400);
  const items = page.locator('.x-boundlist-item:visible');
  const texts = await items.allInnerTexts();
  return { items, texts, reasons: normalizeReasons(texts) };
}

// Dismisses the reason dialog without confirming: Escape collapses the open list or closes the window,
// then the dialog's own Cancel button or close tool. Never OK.
async function closeCancelDialog(page, dialog) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  if ((await dialog.count()) > 0) {
    const cancel = dialog.locator('.x-btn:visible').filter({ hasText: /^Cancel$/ });
    const close = dialog.locator('.x-tool-close:visible');
    if ((await cancel.count()) === 1) await cancel.first().click({ force: true });
    else if ((await close.count()) >= 1) await close.first().click({ force: true });
    else throw new Error('CANCEL_DIALOG_CLOSE_MISSING');
  }
  await page.waitForTimeout(800);
}

// Clicks the OK paired with Cancel inside the single visible Cancellation Reason window.
async function clickReasonOk(page) {
  return page.evaluate(() => {
    const shown = (node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const windows = [...document.querySelectorAll('.x-window')]
      .filter((node) => shown(node) && /Cancellation Reason/.test(node.innerText || ''));
    if (windows.length !== 1) return false;
    const oks = [...windows[0].querySelectorAll('.x-btn')]
      .filter((node) => shown(node) && (node.innerText || '').trim() === 'OK');
    const paired = oks.filter((node) => node.parentElement
      && [...node.parentElement.querySelectorAll('.x-btn')].some((sibling) => (sibling.innerText || '').trim() === 'Cancel'));
    if (paired.length !== 1) return false;
    paired[0].click();
    return true;
  });
}

// Reads the status after an action. While a dialog is still open over the grid, read the open record only.
async function readBack(ctx, blocked) {
  const { page, args, result } = ctx;
  if (blocked) {
    result.readbackMethod = 'open-record';
    const record = await readRecord(page);
    return record.confirmation === args.confirmation ? squash(record.status) : null;
  }
  result.readbackMethod = 're-search';
  const found = await findStay(ctx);
  if (!found) return null;
  await openRecord(page, found.locator);
  const record = await readRecord(page);
  return record.confirmation === args.confirmation ? squash(record.status) : null;
}

function recordPenalty(result, penalty) {
  result.penaltyText = penalty.text;
  result.penaltyAmount = penalty.amount;
}

async function run(ctx) {
  const { page, args, result } = ctx;
  await login(page, ctx.secret);
  mark(ctx, 'login');
  await openGuestStay(page);
  await page.waitForTimeout(1500);
  const found = await findStay(ctx, { evidence: true });
  mark(ctx, 'search');
  if (!found) {
    result.outcome = 'not_found';
    return;
  }
  result.findMethod = found.method;
  await shot(ctx, 'found.png');
  if (found.row) {
    // Quick-search row: guard and status come from the dropdown, before any record is opened.
    result.statusBefore = squash(found.row.status);
    const rowVerdict = identityCheck(args, found.row);
    if (!rowVerdict.ok) {
      result.outcome = rowVerdict.outcome;
      result.refusal = rowVerdict.reason;
      return;
    }
    if (isCancelledStatus(found.row.status)) {
      result.statusAfter = result.statusBefore;
      result.outcome = resolveOutcome({ mode: args.mode, statusBefore: found.row.status, statusAfter: found.row.status });
      return;
    }
  }
  await openRecord(page, found.locator);
  const record = await readRecord(page);
  if (!found.row) result.statusBefore = squash(record.status);
  await shot(ctx, 'opened.png');
  mark(ctx, 'opened');

  const verdict = identityCheck(args, record);
  if (!verdict.ok) {
    result.outcome = verdict.outcome;
    result.refusal = verdict.reason;
    return;
  }
  if (isCancelledStatus(record.status)) {
    result.statusAfter = squash(record.status);
    result.outcome = resolveOutcome({ mode: args.mode, statusBefore: record.status, statusAfter: record.status });
    return;
  }

  result.cancelPath = await openCancelDialog(page);
  const dialog = await waitCancelDialog(page);
  await shot(ctx, 'cancel-dialog.png');
  const penaltyBefore = parsePenalty(await visibleWindowTexts(page));
  if (penaltyBefore) {
    if (args.mode === 'commit') throw new Error('PENALTY_DIALOG_OPEN_BEFORE_OK');
    recordPenalty(result, penaltyBefore);
    await shot(ctx, 'penalty.png');
  }
  if (args.mode === 'commit') {
    const note = dialog.locator('textarea:visible');
    if ((await note.count()) === 1) await note.fill(CANCEL_NOTE);
  }
  const list = await readReasonList(page, dialog);
  result.reasons = list.reasons;
  mark(ctx, 'reasons');

  if (args.mode === 'preview') {
    if (list.reasons.length === 0) throw new Error('REASON_LIST_EMPTY');
    await closeCancelDialog(page, dialog);
    const after = await readRecord(page);
    result.statusAfter = after.confirmation === args.confirmation ? squash(after.status) : null;
    result.outcome = resolveOutcome({ mode: 'preview', statusBefore: record.status, statusAfter: result.statusAfter });
    return;
  }

  const index = findReasonIndex(list.texts, args.reason);
  if (index === -1) {
    result.refusal = 'reason_not_in_list';
    await closeCancelDialog(page, dialog);
    result.outcome = 'refused_reason_missing';
    return;
  }
  const again = await readRecord(page);
  if (!identityCheck(args, again).ok) throw new Error('IDENTITY_CHANGED_BEFORE_OK');
  await list.items.nth(index).click({ force: true });
  await page.waitForTimeout(300);
  if (!(await clickReasonOk(page))) throw new Error('REASON_OK_NOT_UNIQUE');
  result.clickedOk = true;
  mark(ctx, 'committed');
  await page.waitForTimeout(1500);

  const windows = await visibleWindowTexts(page);
  const followUps = windows.filter((text) => text && !/Cancellation Reason/.test(text)).map((text) => text.slice(0, 240));
  result.followUps = followUps;
  const reasonStillOpen = windows.some((text) => /Cancellation Reason/.test(text));
  const penaltyAfter = parsePenalty(windows);
  if (penaltyAfter) {
    recordPenalty(result, penaltyAfter);
    result.penaltyPending = true;
    await shot(ctx, 'penalty.png');
  }
  result.statusAfter = await readBack(ctx, followUps.length > 0 || reasonStillOpen);
  await shot(ctx, 'readback.png');
  mark(ctx, 'readback');
  result.outcome = resolveOutcome({ mode: 'commit', statusBefore: record.status, statusAfter: result.statusAfter });
}

async function drive(ctx) {
  let browser = null;
  let context = null;
  try {
    const cdp = checkCdpEnv(process.env);
    if (!cdp.ok) throw new Error(cdp.error);
    ctx.secret = await readSecret();
    browser = await playwright().chromium.connectOverCDP(cdp.href, { timeout: 20000 });
    context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
    ctx.page = await context.newPage();
    ctx.page.setDefaultTimeout(20000);
    await run(ctx);
  } catch (error) {
    ctx.result.error = squash(error?.message || error).slice(0, 300);
  }
  if (!ctx.result.outcome) ctx.result.outcome = 'execution_failure';
  if (exitCodeFor(ctx.result.outcome) === 1 && ctx.page) {
    await shot(ctx, 'failure.png').catch(() => {});
  }
  ctx.result.timings.totalMs = Date.now() - ctx.started;
  if (context) await Promise.race([context.close().catch(() => {}), delay(4000)]);
  // Pinned Playwright 1.63 Browser has no disconnect(); call it only if present. Never close() the borrowed browser.
  if (browser && typeof browser.disconnect === 'function') browser.disconnect();
}

async function main() {
  const parsed = parseCancelArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return parsed.exitCode;
  }
  const { args } = parsed;
  const ctx = { args, dir: resolve(args.out), result: newResult(args), started: Date.now(), page: null, secret: null };
  await mkdir(ctx.dir, { recursive: true, mode: 0o700 });
  const early = preflight(args);
  if (early.ok) {
    await drive(ctx);
  } else {
    ctx.result.outcome = early.outcome;
    ctx.result.refusal = early.reason;
  }
  await writeFile(join(ctx.dir, 'result.json'), `${JSON.stringify(ctx.result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    outcome: ctx.result.outcome,
    statusBefore: ctx.result.statusBefore,
    statusAfter: ctx.result.statusAfter,
    penaltyText: ctx.result.penaltyText,
    resultJson: join(ctx.dir, 'result.json'),
  })}\n`);
  return exitCodeFor(ctx.result.outcome);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error?.message || error}\n`);
      process.exit(1);
    },
  );
}
