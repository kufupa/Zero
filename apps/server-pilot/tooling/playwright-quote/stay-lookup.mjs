#!/usr/bin/env node
// Read-only Guest Stay lookups in the borrowed Chrome. Never saves, cancels, opens Actions or presses Enter.
// find: header search by confirmation (quick-search.mjs nudges and, with --last-name, a surname retry). One matching row is
// opened and its record form read; no row is not_found.
// search-guest: header search by surname, with the panel window moved to cover --arrival first. Every panel row is
// read and none is opened. A capped panel (Records: N of M with N < M) is ambiguous_capped.
// Usage: node stay-lookup.mjs --mode find --confirmation 57291630-1 [--arrival 2027-09-14] [--last-name Labtest] --out <dir> [--debug-html]
//        node stay-lookup.mjs --mode search-guest --last-name Labtest --arrival 2027-09-14 [--departure 2027-09-15] --out <dir> [--debug-html]
// Exit: 0 found|not_found|ok; 1 ambiguous|ambiguous_capped|execution_failure (also writes failure.png); 2 usage.
// Writes result.json and screenshots (record.png, panel.png, failure.png) into --out. An unreadable panel is dumped to
// panel.html; --debug-html also writes record-form.html (find) and panel.html (search) on every run.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { login, playwright, readSecret } from './fetch-quote.mjs';
import {
  arrivalReport, checkCdpEnv, hmsDateToIso, lookupExitCode, parseLookupArgs, parsePanelSnapshot,
  parseRecordsFooter, sameStayRows, searchGuestOutcome, squash, stayIdentityVerdict, windowCovers,
} from './cancel-stay-rules.mjs';
import {
  findStay, openGuestStay, openRecord, quickActions, quickPanel, readStayFields, readWindow, setQuickWindow, shot,
} from './cancel-stay.mjs';
import { driveQuickSearch, windowAction } from './quick-search.mjs';
import { snapshotPanel, snapshotRecordForm } from './stay-lookup-dom.mjs';
import { commercialFieldsFromFormEntries, parseCommercialFields } from './commercial-fields.mjs';
import { installReadOnlyGuard } from './hms-read-only-guard.mjs';

const QUICK_WAIT_MS = 8000;
const PANEL_FOOTER = /Records:\s*\d+\s+of\s+\d+/i;
const PANEL_HISTORY = /No previous searches/i;

function newLookupResult(args) {
  return {
    mode: args.mode,
    outcome: null,
    reason: null,
    confirmation: args.confirmation,
    arrival: args.arrival,
    departure: args.departure,
    lastName: args.lastName,
    findMethod: null,
    quickStages: [],
    arrivalMismatch: false,
    requestedArrival: args.arrival ?? null,
    hmsArrival: null,
    stay: null,
    commercial: null,
    conflicts: [],
    records: null,
    rows: [],
    matches: [],
    unreadable: 0,
    unreadableRows: [],
    screenshots: [],
    error: null,
    timings: {},
  };
}

function mark(ctx, name) {
  ctx.result.timings[name] = Date.now() - ctx.started;
}

function setOutcome(result, outcome, reason = null) {
  result.outcome = outcome;
  result.reason = reason;
}

// The quick panel is ready once its footer shows the Records count and its search ran: before that it shows the
// history list ("No previous searches.", Records: 0 of 0). Returns {panel, executed}; panel is null when none shows.
async function waitForPanel(page) {
  const deadline = Date.now() + QUICK_WAIT_MS;
  for (;;) {
    const panel = await quickPanel(page);
    const text = panel ? await panel.innerText({ timeout: 2000 }).catch(() => '') : '';
    const executed = PANEL_FOOTER.test(text) && !PANEL_HISTORY.test(text);
    if (executed || Date.now() >= deadline) return { panel: PANEL_FOOTER.test(text) ? panel : null, executed };
    await page.waitForTimeout(500);
  }
}

async function failPanel(ctx, reason) {
  await shot(ctx, 'panel.png').catch(() => {});
  setOutcome(ctx.result, 'execution_failure', reason);
}

// The panel's outer HTML, for an offline re-test of the row parser. Written on failure, or on every run with --debug-html.
async function dumpPanelHtml(ctx, panel) {
  const html = await panel.evaluate((root) => root.outerHTML).catch(() => '');
  if (html) await writeFile(join(ctx.dir, 'panel.html'), html);
}

// Reads one confirmation from the already-open Guest Stay screen. Batch callers reuse this after one login; the normal
// CLI also calls it after navigating to Guest Stay. Commercial capture is isolated so an optional control cannot turn
// a successful reservation find into a failed lookup.
export async function findOnOpenGuestStay(ctx, { captureScreenshots = true } = {}) {
  ctx.result = newLookupResult(ctx.args);
  const { page, args, result } = ctx;
  const found = await findStay(ctx);
  mark(ctx, 'search');
  if (!found) {
    if (captureScreenshots) await shot(ctx, 'panel.png').catch(() => {});
    setOutcome(result, 'not_found');
    return result;
  }
  result.findMethod = found.method;
  if (found.row) {
    // The dropdown row is checked before any record opens: a different arrival is reported, not opened.
    const rowVerdict = stayIdentityVerdict(args, {
      confirmation: found.row.confirmation,
      arrival: hmsDateToIso(found.row.arrival),
    });
    if (rowVerdict.outcome !== 'found') {
      if (captureScreenshots) await shot(ctx, 'panel.png').catch(() => {});
      setOutcome(result, rowVerdict.outcome, rowVerdict.reason);
      return result;
    }
  }
  if (found.locator) await openRecord(page, found.locator);
  result.stay = await readStayFields(ctx);
  try {
    // The live ExtJS record exposes named fields through the same form snapshot readStayFields uses.
    const form = await page.evaluate(snapshotRecordForm, false);
    result.commercial = parseCommercialFields(commercialFieldsFromFormEntries(form.entries), result.stay);
  } catch {
    result.commercial = null;
  }
  if (captureScreenshots) await shot(ctx, 'record.png');
  mark(ctx, 'opened');
  const verdict = stayIdentityVerdict(args, result.stay);
  setOutcome(result, verdict.outcome, verdict.reason);
  // The arrival is a hint: a different arrival in HMS is reported with both dates, never treated as a mismatch to refuse.
  Object.assign(result, arrivalReport(args, result.stay?.arrival ?? null));
  return result;
}

async function runFind(ctx) {
  await login(ctx.page, ctx.secret);
  mark(ctx, 'login');
  await openGuestStay(ctx.page);
  await ctx.page.waitForTimeout(1500);
  await findOnOpenGuestStay(ctx);
}

async function searchGuest(ctx) {
  const { page, args, result } = ctx;
  // The surname goes into the header search; quick-search.mjs nudges the panel open. Enter is never pressed.
  // A panel still showing the history list is enough to read and move its window: the move runs the search.
  const executedPanel = (state) => state.executed;
  const quick = await driveQuickSearch(quickActions(page, args.lastName), {
    ready: () => waitForPanel(page),
    done: executedPanel,
  });
  result.quickStages = quick.stages;
  let state = quick.result;
  if (!state.panel) return failPanel(ctx, 'panel_not_shown');
  let dateWindow = await readWindow(page);
  if (!dateWindow) return failPanel(ctx, 'window_unreadable');
  if (windowAction({ window: dateWindow, arrival: args.arrival, panelShown: true }) === 'move') {
    await setQuickWindow(page, args.arrival);
    const moved = await driveQuickSearch(quickActions(page, args.lastName), {
      ready: () => waitForPanel(page),
      done: executedPanel,
    });
    result.quickStages.push(...moved.stages.map((stage) => `window.${stage}`));
    state = moved.result;
    dateWindow = state.panel ? await readWindow(page) : null;
    if (!state.panel || !dateWindow || !windowCovers(dateWindow, args.arrival)) {
      return failPanel(ctx, 'window_not_covering_arrival');
    }
  }
  if (!state.executed) return failPanel(ctx, 'search_not_executed');
  const { panel } = state;
  mark(ctx, 'window');
  await shot(ctx, 'panel.png');
  const snapshot = await panel.evaluate(snapshotPanel);
  const parsed = parsePanelSnapshot(snapshot);
  const records = parseRecordsFooter(snapshot.footer);
  result.records = records;
  result.rows = parsed.rows;
  result.unreadable = parsed.unreadable;
  result.unreadableRows = parsed.unreadableRows;
  result.matches = sameStayRows(parsed.rows, args);
  const verdict = searchGuestOutcome({ records, rows: parsed.rows, unreadable: parsed.unreadable });
  setOutcome(result, verdict.outcome, verdict.reason);
  if (args.debugHtml || verdict.outcome !== 'ok') await dumpPanelHtml(ctx, panel);
  mark(ctx, 'read');
}

export async function searchGuestOnOpenGuestStay(ctx) {
  if (!ctx.result) ctx.result = newLookupResult(ctx.args);
  await searchGuest(ctx);
  return ctx.result;
}

async function runSearchGuest(ctx) {
  await login(ctx.page, ctx.secret);
  mark(ctx, 'login');
  await openGuestStay(ctx.page);
  await ctx.page.waitForTimeout(1500);
  await searchGuestOnOpenGuestStay(ctx);
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
    await installReadOnlyGuard(context);
    ctx.page = await context.newPage();
    ctx.page.setDefaultTimeout(20000);
    if (ctx.args.mode === 'find') await runFind(ctx);
    else await runSearchGuest(ctx);
  } catch (error) {
    const message = squash(error?.message || error);
    ctx.result.error = message.slice(0, 300);
    if (message.startsWith('AMBIGUOUS_')) setOutcome(ctx.result, 'ambiguous', message.toLowerCase());
  }
  if (!ctx.result.outcome) ctx.result.outcome = 'execution_failure';
  if (lookupExitCode(ctx.result.outcome) === 1 && ctx.page) {
    await shot(ctx, 'failure.png').catch(() => {});
  }
  ctx.result.timings.totalMs = Date.now() - ctx.started;
  if (context) await Promise.race([context.close().catch(() => {}), delay(4000)]);
  // Pinned Playwright 1.63 Browser has no disconnect(); call it only if present. Never close() the borrowed browser.
  if (browser && typeof browser.disconnect === 'function') browser.disconnect();
}

async function main() {
  const parsed = parseLookupArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return parsed.exitCode;
  }
  const { args } = parsed;
  const ctx = {
    args,
    dir: resolve(args.out),
    result: newLookupResult(args),
    started: Date.now(),
    page: null,
    secret: null,
  };
  await mkdir(ctx.dir, { recursive: true, mode: 0o700 });
  await drive(ctx);
  const resultJson = join(ctx.dir, 'result.json');
  await writeFile(resultJson, `${JSON.stringify(ctx.result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    outcome: ctx.result.outcome,
    reason: ctx.result.reason,
    resultJson,
  })}\n`);
  return lookupExitCode(ctx.result.outcome);
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
