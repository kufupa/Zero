#!/usr/bin/env node
// Cancel one lab Guest Stay by confirmation number. The stay must be
// Labtest with arrival on or after 2027-01-01 and match --confirmation and
// --arrival, or the run refuses before any cancel action.
// Find types the confirmation in the header search; Enter is not pressed because it opens the record. An open
// record for the confirmation is read as it stands (status, balance). Otherwise the dropdown row (conf,
// "Last, First", status, dates) is guarded before the record is opened. A Cancelled stay ends the run as
// already_cancelled. If the dropdown window does not cover arrival, its calendar icon moves it first; the grid
// window picker is the fallback.
// Preview reads the reason list and dismisses the dialog unconfirmed.
// Commit picks --reason and clicks its OK once. A cancellation penalty dialog, open before preview or commit
// clicks OK, refuses the run (refused_penalty). It is recorded and left open; nothing is clicked on it.
// --allow-real-guest lifts the Labtest guard for one run (on mode). The server passes it; it is never read from the env.
// Usage: node cancel-stay.mjs --confirmation 57291630-1 --arrival 2027-09-14 --mode preview|commit --out <dir> [--reason "Test Reservations"] [--last-name Labtest] [--allow-real-guest]
// --last-name is optional: when the confirmation does not show in the header quick search, the surname is typed and the row with the exact confirmation is used.
// Exit: 0 preview_ok|cancelled|already_cancelled; 2 refused_* or usage; 1 other outcome (also writes failure.png).
// Read-only lookups (find, search-guest) live in stay-lookup.mjs, which imports the helpers exported here.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { login, newBorrowedContext, playwright, readSecret } from './fetch-quote.mjs';
import {
  arrivalReport, chooseStaySource, checkCdpEnv, exitCodeFor, formPairsFromSnapshot, hmsDateToIso, identityCheck,
  isCancelledStatus, normalizeReasons, outcomeAfterFailure, parseBalanceValue, parseCancelArgs, parseDateWindowLabel,
  parseQuickSearchRow, pickerMonthSteps, preflight, resolveOutcome, runCancelDialog, settleCancel, squash,
  stayChanges, stayFromFormPairs,
} from './cancel-stay-rules.mjs';
import { driveQuickSearch, runConfirmationSearch } from './quick-search.mjs';
import { snapshotRecordForm } from './stay-lookup-dom.mjs';

const MAX_PICKER_CLICKS = 60;
const QUICK_WAIT_MS = 8000;
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
    lastName: args.lastName ?? null,
    allowRealGuest: args.allowRealGuest === true,
    quickStages: [],
    arrivalMismatch: false,
    requestedArrival: args.arrival ?? null,
    hmsArrival: null,
    statusBefore: null,
    statusAfter: null,
    balance: null,
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

export async function shot(ctx, name) {
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
export async function readRecord(page) {
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

// The labelled fields first (see formPairsFromSnapshot). The named inputs that readRecord already trusts fill any field
// the labels did not give, and the balance comes from readBalance. A field with conflicting labelled values is never
// filled. Debug mode writes the form region to record-form.html.
export async function readStayFields(ctx) {
  const { page, args, result } = ctx;
  const snapshot = await page.evaluate(snapshotRecordForm, args.debugHtml);
  if (snapshot.region) await writeFile(join(ctx.dir, 'record-form.html'), snapshot.region);
  const { stay, conflicts } = stayFromFormPairs(formPairsFromSnapshot(snapshot.entries));
  const named = await readRecord(page);
  const fallback = {
    confirmation: squash(named.confirmation),
    lastName: squash(named.lastName),
    status: squash(named.status),
    arrival: hmsDateToIso(named.arrival),
  };
  for (const [field, value] of Object.entries(fallback)) {
    if (stay[field] === null && value && !conflicts.includes(field)) stay[field] = value;
  }
  if (stay.balance === null && !conflicts.includes('balance')) stay.balance = await readBalance(page);
  result.conflicts = conflicts;
  return stay;
}

async function visibleWindowTexts(page) {
  return page.evaluate(() => [...document.querySelectorAll('.x-window')]
    .filter((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    })
    .map((node) => (node.innerText || '').replace(/\s+/g, ' ').trim()));
}

// On the EC2 browser (no tunnel latency) a Guest Stay click made while Front Desk is still expanding is dropped and the
// screen never opens. Wait for the header search, and click Guest Stay again if it has not appeared.
export async function openGuestStay(page, { attempts = 3, waitMs = 8000 } = {}) {
  const node = (name) => page.locator('span.x-tree-node-text:visible').filter({ hasText: new RegExp(`^${name}$`) });
  await page.locator('a.app-menu-trigger:visible').click();
  await node('Front Desk').click();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.waitForTimeout(800);
    await node('Guest Stay').click();
    const opened = await headerSearch(page).waitFor({ state: 'visible', timeout: waitMs }).then(() => true, () => false);
    if (opened) return;
  }
  throw new Error('GUEST_STAY_NOT_OPENED');
}

// The header search. Typing goes through the keyboard, so the search sees each key rather than one fill event.
function headerSearch(page) {
  return page.getByPlaceholder(/Search by Name, Confirmation/i).first();
}

export async function typeHeaderSearch(page, text) {
  const search = headerSearch(page);
  await search.click({ force: true });
  await search.fill('');
  await search.pressSequentially(text, { delay: 40 });
  await page.waitForTimeout(500);
}

export async function searchConfirmation(page, confirmation) {
  await typeHeaderSearch(page, confirmation);
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

export async function readWindow(page) {
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

// Steps the open picker by whole months inside the page: one round trip instead of one per month over the CDP tunnel.
// The arrow is pressed as mouse events (ExtJS repeats on mousedown). The loop in pickArrivalDay re-reads the title and
// corrects any miss, so this only has to get close.
async function stepPickerInPage(page, steps) {
  await page.evaluate(async ({ count, selector }) => {
    for (let index = 0; index < count; index += 1) {
      const arrow = [...document.querySelectorAll(selector)].find((node) => node.getClientRects().length > 0);
      if (!arrow) return;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        arrow.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
      }
      await new Promise((done) => setTimeout(done, 80));
    }
  }, { count: Math.abs(steps), selector: steps > 0 ? '.x-datepicker-next' : '.x-datepicker-prev' }).catch(() => {});
  await page.waitForTimeout(200);
}

// Moves the open picker to the arrival month and clicks the arrival day.
async function pickArrivalDay(page, arrival) {
  const title = page.locator(PICKER_TITLE).first();
  let steps = pickerMonthSteps(await title.innerText(), arrival);
  if (steps !== null && Math.abs(steps) > 1) {
    await stepPickerInPage(page, steps);
    steps = pickerMonthSteps(await title.innerText(), arrival);
  }
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
export async function setQuickWindow(page, arrival) {
  await openWindowPicker(page);
  await pickArrivalDay(page, arrival);
  await clickApplyIfShown(page);
  await page.waitForTimeout(600);
}

// Quick-search nudges. ArrowDown from inside the field opens the list of a search that has text; a click at the right of
// the field reopens it. Enter is never pressed: with one match it opens the record and closes the dropdown.
export async function pressArrowDown(page) {
  await headerSearch(page).press('ArrowDown');
}

export async function clickInsideSearch(page) {
  const box = await headerSearch(page).boundingBox();
  if (box) await page.mouse.click(box.x + box.width - 24, box.y + box.height / 2);
}

// The header Run only. The grid below has its own Run, which would run the grid instead of the quick search. Live HMS
// marks the header one with stay-360-search-btn; the position check is the fallback.
const HEADER_BOTTOM = 100;

export async function clickHeaderRun(page) {
  const marked = page.locator('a.stay-360-search-btn:visible');
  if ((await marked.count()) === 1) {
    await marked.click({ force: true });
    await page.waitForTimeout(1000);
    return true;
  }
  const runs = page.locator('a.x-btn:visible').filter({ hasText: /^Run$/ });
  for (const index of await visibleIndexes(runs)) {
    const box = await runs.nth(index).boundingBox();
    if (box && box.y < HEADER_BOTTOM) {
      await runs.nth(index).click({ force: true });
      await page.waitForTimeout(1000);
      return true;
    }
  }
  return false;
}

// The page actions quick-search.mjs runs for one term. Typing alone only shows the history list ("No previous
// searches."); the header Run executes the search, so the typed step always ends with it.
export function quickActions(page, term) {
  return {
    type: async () => {
      await typeHeaderSearch(page, term);
      await clickHeaderRun(page);
    },
    arrowDown: () => pressArrowDown(page),
    clickInside: () => clickInsideSearch(page),
    headerRun: () => clickHeaderRun(page),
  };
}

async function panelShown(page) {
  return Boolean(await quickPanel(page));
}

// The panel only holds search results once a search ran: until then it shows the history list ("No previous
// searches.") with "Records: 0 of 0". Executed means the footer is shown and the history line is not.
export async function quickPanelExecuted(page) {
  const panel = await quickPanel(page);
  if (!panel) return false;
  const text = await panel.innerText({ timeout: 2000 }).catch(() => '');
  return /Records:\s*\d+\s+of\s+\d+/i.test(text) && !/No previous searches/i.test(text);
}

// The quick-search dropdown: the nearest ancestor of its In-House tab that also holds the "Records:" footer.
// The record header and the grid are outside it, so the row lookup below cannot match them.
export async function quickPanel(page) {
  const tabs = page.getByText(/^In.?House$/);
  const shownTabs = await visibleIndexes(tabs);
  if (shownTabs.length === 0) return null;
  const panel = tabs.nth(shownTabs[0]).locator('xpath=ancestor::*[contains(., "Records:")][1]');
  return (await panel.count()) === 1 ? panel : null;
}

// The dropdown row's cell texts, in document order. The live panel is an ExtJS grid: tr.x-grid-row with one td per
// column, and the dates cell holds "12-OCT-2027<br>13-OCT-2027" (fixtures/stay-lookup/panel-live.html). Leaf elements
// would miss that cell (its only child is the <br>) and split the highlighted surname, so cells are read whole. The
// leaf walk below is the fallback for a panel without grid rows.
async function rowCells(locator) {
  return locator.evaluate((el) => {
    const gridRow = el.closest('tr.x-grid-row, .x-grid-row, [role="row"]');
    if (gridRow) {
      const cells = [...gridRow.querySelectorAll('td, .x-grid-cell, [role="gridcell"]')]
        .filter((cell) => cell.closest('tr.x-grid-row, .x-grid-row, [role="row"]') === gridRow);
      if (cells.length > 0) return cells.map((cell) => cell.innerText || cell.textContent || '');
    }
    const DATE = /\b\d{1,2}-[A-Za-z]{3}-\d{4}\b/;
    const shown = (node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    let row = el;
    while (row && row !== document.body && !DATE.test(row.innerText || '')) row = row.parentElement;
    if (!row || row === document.body) return null;
    const leaves = row.children.length === 0
      ? [row]
      : [...row.querySelectorAll('*')].filter((node) => node.children.length === 0 && shown(node));
    return leaves.map((node) => node.innerText || '');
  });
}

// Null when the dropdown shows no row for the confirmation. Throws when the row is ambiguous or unreadable.
async function readQuickRow(page, confirmation) {
  const panel = await quickPanel(page);
  if (!panel) return null;
  const matches = panel.getByText(confirmation, { exact: true });
  const hits = await visibleIndexes(matches);
  if (hits.length === 0) return null;
  if (hits.length > 1) throw new Error('AMBIGUOUS_QUICK_ROW');
  const locator = matches.nth(hits[0]);
  const row = parseQuickSearchRow(await rowCells(locator), confirmation);
  if (!row) throw new Error('QUICK_ROW_UNPARSED');
  return { locator, row };
}

// The open record form, when it shows this confirmation. HMS can open the record on its own after a search.
async function readOpenRecord(page, confirmation) {
  if ((await page.locator('input[name="confirmationnumber"]:visible').count()) === 0) return null;
  const record = await readRecord(page);
  return record.confirmation === confirmation ? record : null;
}

// Balance on the open record ("Balance: 0.00 ZAR"): the input beside the Balance label. Null when unreadable.
export async function readBalance(page) {
  const labels = page.getByText(/^Balance:?$/);
  for (const index of await visibleIndexes(labels)) {
    const candidates = await labels.nth(index).evaluate((label) => {
      const byFor = label.htmlFor ? document.getElementById(label.htmlFor) : null;
      const scope = label.closest('.x-form-item, tr') ?? label.parentElement;
      const inputs = scope ? [...scope.querySelectorAll('input')] : [];
      return [byFor, ...inputs].filter((el) => el && el.getClientRects().length > 0).map((el) => el.value);
    });
    for (const value of candidates) {
      const balance = parseBalanceValue(value);
      if (balance !== null) return balance;
    }
  }
  return null;
}

// Polls the open form and the dropdown row. With needRow, only the row counts: a form opened before a commit can be stale.
// A panel whose search ran without the row ends the wait early (executed): the caller moves on rather than waiting.
async function waitForStay(page, confirmation, { needRow }) {
  const deadline = Date.now() + QUICK_WAIT_MS;
  for (;;) {
    const open = needRow ? null : await readOpenRecord(page, confirmation);
    const executed = await quickPanelExecuted(page);
    const row = await readQuickRow(page, confirmation);
    if (open || row || executed) return { open, row, executed };
    if (Date.now() >= deadline) return { open, row, executed };
    await page.waitForTimeout(500);
  }
}

// The header search types the confirmation. When no panel answers, quick-search.mjs nudges it (ArrowDown, a click inside
// the field, the header Run). When the confirmation is still not in a panel and the surname is known, the surname is
// typed and the row with the exact confirmation is taken. A panel whose window does not cover arrival is moved by its
// calendar icon and searched again. An open record for the confirmation is used as it stands; a row is guarded before
// anything opens. Returns {method, locator, row, open} or null.
async function locateQuick(ctx, { allowOpenRecord }) {
  const { page, args, result } = ctx;
  const conf = args.confirmation;
  const io = {
    drive: (term, { needRow, done }) => driveQuickSearch(quickActions(page, term), {
      ready: () => waitForStay(page, conf, { needRow }),
      done,
    }),
    panelShown: () => panelShown(page),
    moveWindow: (startIso) => setQuickWindow(page, startIso),
  };
  const { probe, method, stages } = await runConfirmationSearch(io, {
    confirmation: conf,
    lastName: args.lastName ?? null,
    arrival: args.arrival ?? null,
    allowOpenRecord,
  });
  result.quickStages = stages;
  const source = chooseStaySource({ confirmation: conf, open: probe.open, row: probe.row, allowOpen: allowOpenRecord });
  if (source === 'open_record') return { method: 'open_record', locator: null, row: null, open: probe.open };
  if (source === 'row') return { method, locator: probe.row.locator, row: probe.row.row, open: null };
  return null;
}

// The quick search first. The grid window picker is the last resort, and only for lookups that have an arrival.
// Returns {method, locator, row, open}: row is the dropdown row (guarded before anything opens), open is the open
// record form, and locator is the row or grid cell to click.
export async function findStay(ctx, { evidence = false, allowOpenRecord = true } = {}) {
  const { page, args } = ctx;
  const quick = await locateQuick(ctx, { allowOpenRecord });
  if (quick) return quick;
  if (!args.arrival) return null;
  await searchConfirmation(page, args.confirmation);
  await setArrivalWindow(page, args.arrival);
  if (evidence) await shot(ctx, 'window.png');
  if (allowOpenRecord) {
    const late = await readOpenRecord(page, args.confirmation);
    if (late) return { method: 'picker', locator: null, row: null, open: late };
  }
  const row = await findRow(page, args.confirmation);
  return row ? { method: 'picker', locator: row, row: null, open: null } : null;
}

async function findRow(page, confirmation) {
  const rows = page.getByText(confirmation, { exact: true });
  const hits = await visibleIndexes(rows);
  if (hits.length > 1) throw new Error('AMBIGUOUS_CONFIRMATION_ROW');
  return hits.length === 1 ? rows.nth(hits[0]) : null;
}

export async function openRecord(page, row) {
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

// HMS fills the reason list after "Processing request…" clears, so an early look finds it empty. Look again for up to
// REASON_LIST_WAIT_MS, opening the list again only when no item is showing, before calling it empty.
const REASON_LIST_WAIT_MS = 15_000;
export async function readReasonList(page, dialog, { waitMs = REASON_LIST_WAIT_MS } = {}) {
  const items = page.locator('.x-boundlist-item:visible');
  const deadline = Date.now() + waitMs;
  for (;;) {
    if ((await items.count()) === 0) {
      await dialog.locator('.x-form-arrow-trigger').first().click({ force: true });
    }
    await page.waitForTimeout(400);
    const texts = await items.allInnerTexts();
    const reasons = normalizeReasons(texts);
    if (reasons.length > 0 || Date.now() >= deadline) return { items, texts, reasons };
    await page.waitForTimeout(800);
  }
}

// Dismisses the reason dialog without confirming: Escape collapses the open list, a second Escape closes the window,
// and the window's close tool is the last resort. No button inside the dialog is ever clicked (never OK, and not its
// Cancel either, whose label is too close to the cancel action itself). Throws when the dialog stays open.
async function closeCancelDialog(page, dialog) {
  for (let attempt = 0; attempt < 2 && (await dialog.count()) > 0; attempt += 1) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  }
  if ((await dialog.count()) > 0) {
    const close = dialog.locator('.x-tool-close:visible, .x-tool-close-default:visible');
    if ((await close.count()) === 0) throw new Error('CANCEL_DIALOG_CLOSE_MISSING');
    await close.first().click({ force: true });
    await page.waitForTimeout(600);
  }
  if ((await dialog.count()) > 0) throw new Error('CANCEL_DIALOG_STILL_OPEN');
  await page.waitForTimeout(400);
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

// The status after a commit. The open form counts only once it reads Cancelled, because HMS keeps the old status while it
// processes. Otherwise a fresh header search reads the status on the dropdown row for the confirmation.
async function readCommittedStatus(ctx) {
  const { page, args } = ctx;
  const record = await readRecord(page);
  const formStatus = record.confirmation === args.confirmation ? squash(record.status) : null;
  if (isCancelledStatus(formStatus)) return formStatus;
  await quickActions(page, args.confirmation).type();
  const probe = await waitForStay(page, args.confirmation, { needRow: true });
  return probe.row ? squash(probe.row.row.status) : formStatus;
}

// The processing mask HMS shows while a commit is applied ("Processing request.").
async function processingVisible(page) {
  return (await visibleIndexes(page.getByText(/Processing request/i))).length > 0;
}

function settleIo(ctx) {
  return {
    maskVisible: () => processingVisible(ctx.page),
    readStatus: () => readCommittedStatus(ctx),
  };
}

// The real page behind the cancel dialog. Each method makes the call the flow made before it moved into
// cancel-stay-rules.mjs (runCancelDialog), in the same order and with the same waits.
function dialogIo(ctx, dialog) {
  const { page } = ctx;
  return {
    mark: (name) => mark(ctx, name),
    shot: (name) => shot(ctx, name),
    windowTexts: () => visibleWindowTexts(page),
    fillNote: async (text) => {
      const note = dialog.locator('textarea:visible');
      if ((await note.count()) === 1) await note.fill(text);
    },
    readReasons: () => readReasonList(page, dialog),
    pickReason: async (list, index) => {
      await list.items.nth(index).click({ force: true });
      await page.waitForTimeout(300);
    },
    readRecord: () => readRecord(page),
    close: () => closeCancelDialog(page, dialog),
    clickOk: () => clickReasonOk(page),
    waitAfterOk: () => page.waitForTimeout(1500),
    settle: () => settleCancel(settleIo(ctx), { now: () => Date.now(), sleep: (ms) => delay(ms) }),
  };
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
    // The arrival is a hint here: a different arrival is reported, and the record check below decides for a write.
    Object.assign(result, arrivalReport(args, hmsDateToIso(found.row.arrival)));
    const rowVerdict = identityCheck(args, found.row, { arrivalHint: true });
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
  // An open record for this confirmation needs no click; a row or grid cell is opened here.
  if (found.locator) await openRecord(page, found.locator);
  const record = await readRecord(page);
  result.balance = await readBalance(page);
  if (!found.row) result.statusBefore = squash(record.status);
  await shot(ctx, 'opened.png');
  mark(ctx, 'opened');

  Object.assign(result, arrivalReport(args, hmsDateToIso(record.arrival)));
  // Preview is not a write, so the arrival is a hint there. Commit keeps the arrival match.
  const verdict = identityCheck(args, record, { arrivalHint: args.mode === 'preview' });
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

  // The pane write runner (U26) passes the stay its approval was checked against. This session opened the record on its
  // own, so the record is read again here and any field that moved since refuses the run before the dialog opens.
  if (args.expectStay) {
    const expected = JSON.parse(await readFile(args.expectStay, 'utf8'));
    const changed = stayChanges(expected, await readStayFields(ctx));
    if (changed.length > 0) {
      result.outcome = 'refused_stay_changed';
      result.refusal = `stay_changed:${changed.join(',')}`;
      return;
    }
  }
  result.cancelPath = await openCancelDialog(page);
  const dialog = await waitCancelDialog(page);
  await shot(ctx, 'cancel-dialog.png');
  // Write evidence for the pane's cancel run (U26): the dialog before OK, and the page after an OK click.
  await shot(ctx, 'before.png');
  await runCancelDialog({ args, record, result, io: dialogIo(ctx, dialog) });
  if (result.clickedOk) await shot(ctx, 'after.png');
}

async function drive(ctx) {
  let browser = null;
  let context = null;
  try {
    const cdp = checkCdpEnv(process.env);
    if (!cdp.ok) throw new Error(cdp.error);
    ctx.secret = await readSecret();
    browser = await playwright().chromium.connectOverCDP(cdp.href, { timeout: 20000 });
    context = await newBorrowedContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
    ctx.page = await context.newPage();
    ctx.page.setDefaultTimeout(20000);
    await run(ctx);
  } catch (error) {
    ctx.result.error = squash(error?.message || error).slice(0, 300);
  }
  if (!ctx.result.outcome) ctx.result.outcome = outcomeAfterFailure(ctx.result);
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
