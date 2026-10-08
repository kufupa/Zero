#!/usr/bin/env node
// Read-only Guest Stay lookups in the borrowed Chrome. Never saves, cancels, opens Actions or presses Enter.
// find: header search by confirmation. One matching row is opened and its record form read; no row is not_found.
// search-guest: header search by surname, with the panel window moved to cover --arrival first. Every panel row is
// read and none is opened. A capped panel (Records: N of M with N < M) is ambiguous_capped.
// Usage: node stay-lookup.mjs --mode find --confirmation 57291630-1 [--arrival 2027-09-14] --out <dir> [--debug-html]
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
  checkCdpEnv, formPairsFromSnapshot, hmsDateToIso, lookupExitCode, parseLookupArgs, parsePanelSnapshot,
  parseRecordsFooter, sameStayRows, searchGuestOutcome, squash, stayFromFormPairs, stayIdentityVerdict, windowCovers,
} from './cancel-stay-rules.mjs';
import {
  clickRunIfShown, findStay, openGuestStay, openRecord, quickPanel, readBalance, readRecord, readWindow,
  searchConfirmation, setQuickWindow, shot,
} from './cancel-stay.mjs';
import { snapshotPanel, snapshotRecordForm } from './stay-lookup-dom.mjs';

const QUICK_WAIT_MS = 8000;
const PANEL_FOOTER = /Records:\s*\d+\s+of\s+\d+/i;

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
    stay: null,
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

// The labelled fields first (see formPairsFromSnapshot). The named inputs that readRecord already trusts fill any field
// the labels did not give, and the balance comes from readBalance. A field with conflicting labelled values is never
// filled. Debug mode writes the form region to record-form.html.
async function readStayFields(ctx) {
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

// The quick panel is ready once its footer shows the Records count.
async function waitForPanel(page) {
  const deadline = Date.now() + QUICK_WAIT_MS;
  for (;;) {
    const panel = await quickPanel(page);
    if (panel && PANEL_FOOTER.test(await panel.innerText({ timeout: 2000 }).catch(() => ''))) return panel;
    if (Date.now() >= deadline) return null;
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

async function runFind(ctx) {
  const { page, args, result } = ctx;
  await login(page, ctx.secret);
  mark(ctx, 'login');
  await openGuestStay(page);
  await page.waitForTimeout(1500);
  const found = await findStay(ctx);
  mark(ctx, 'search');
  if (!found) {
    await shot(ctx, 'panel.png').catch(() => {});
    setOutcome(result, 'not_found');
    return;
  }
  result.findMethod = found.method;
  if (found.row) {
    // The dropdown row is checked before any record opens: a different arrival is reported, not opened.
    const rowVerdict = stayIdentityVerdict(args, {
      confirmation: found.row.confirmation,
      arrival: hmsDateToIso(found.row.arrival),
    });
    if (rowVerdict.outcome !== 'found') {
      await shot(ctx, 'panel.png').catch(() => {});
      setOutcome(result, rowVerdict.outcome, rowVerdict.reason);
      return;
    }
  }
  if (found.locator) await openRecord(page, found.locator);
  result.stay = await readStayFields(ctx);
  await shot(ctx, 'record.png');
  mark(ctx, 'opened');
  const verdict = stayIdentityVerdict(args, result.stay);
  setOutcome(result, verdict.outcome, verdict.reason);
}

async function runSearchGuest(ctx) {
  const { page, args, result } = ctx;
  await login(page, ctx.secret);
  mark(ctx, 'login');
  await openGuestStay(page);
  await page.waitForTimeout(1500);
  // The header search takes a surname as well as a confirmation. Enter is never pressed: it would open a record.
  await searchConfirmation(page, args.lastName);
  let panel = await waitForPanel(page);
  if (!panel && (await clickRunIfShown(page))) panel = await waitForPanel(page);
  if (!panel) return failPanel(ctx, 'panel_not_shown');
  let dateWindow = await readWindow(page);
  if (!dateWindow) return failPanel(ctx, 'window_unreadable');
  if (!windowCovers(dateWindow, args.arrival)) {
    await setQuickWindow(page, args.arrival);
    await searchConfirmation(page, args.lastName);
    panel = await waitForPanel(page);
    dateWindow = panel ? await readWindow(page) : null;
    if (!panel || !dateWindow || !windowCovers(dateWindow, args.arrival)) {
      return failPanel(ctx, 'window_not_covering_arrival');
    }
  }
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
