#!/usr/bin/env node
// Sequential, resumable, read-only confirmation lookup batch. It logs in once and reads commercial fields from each
// successfully opened Guest Stay record. --include-history sweeps earlier 60-day quick-search windows, up to five years.
// Usage: node find-batch.mjs --input confs.json --out finds.jsonl [--cap N] [--pause-ms 1500] [--include-history]
import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { login, playwright, readSecret } from './fetch-quote.mjs';
import { checkCdpEnv, windowCovers } from './cancel-stay-rules.mjs';
import { openGuestStay, readWindow, setQuickWindow } from './cancel-stay.mjs';
import { findOnOpenGuestStay } from './stay-lookup.mjs';
import { installReadOnlyGuard } from './hms-read-only-guard.mjs';
import {
  historySweepStarts, parseFindBatchArgs, parseFindBatchInput, remainingConfirmations,
} from './find-batch-rules.mjs';

const CONNECT_TIMEOUT_MS = 25_000;
const PAGE_TIMEOUT_MS = 20_000;
const ITEM_TIMEOUT_MS = 90_000;
const HISTORY_ITEM_TIMEOUT_MS = 360_000;
const TIMEOUT = Symbol('find_batch_timeout');

async function readOutput(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function createStayPage(context, shellUrl, { open = true } = {}) {
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  if (shellUrl) {
    await page.goto(shellUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    if (open) {
      await openGuestStay(page);
      await page.waitForTimeout(1500);
    }
  }
  return page;
}

async function returnToGuestStayList(page) {
  const search = page.getByPlaceholder(/Search by Name, Confirmation/i).first();
  if (await search.count()) {
    await search.click().catch(() => {});
    return;
  }
  await openGuestStay(page);
}

async function restoreQuickWindow(page, baselineWindow) {
  const current = await readWindow(page);
  if (!current) throw new Error('HISTORY_WINDOW_UNREADABLE');
  if (current.from === baselineWindow.from) return current;
  await setQuickWindow(page, baselineWindow.from);
  const restored = await readWindow(page);
  if (!restored || restored.from !== baselineWindow.from || !windowCovers(restored, baselineWindow.from)) {
    throw new Error('HISTORY_WINDOW_DID_NOT_RESET');
  }
  return restored;
}

async function findWithHistory(ctx, includeHistory, baselineWindow) {
  if (includeHistory) await restoreQuickWindow(ctx.page, baselineWindow);
  let result = await findOnOpenGuestStay(ctx, { captureScreenshots: false });
  if (!includeHistory || result.outcome !== 'not_found') return result;

  let current = await readWindow(ctx.page);
  if (!current) throw new Error('HISTORY_WINDOW_UNREADABLE');
  for (const start of historySweepStarts(current.from)) {
    await setQuickWindow(ctx.page, start);
    const moved = await readWindow(ctx.page);
    if (!moved || moved.from >= current.from || !windowCovers(moved, start)) {
      throw new Error('HISTORY_WINDOW_DID_NOT_ADVANCE');
    }
    current = moved;
    result = await findOnOpenGuestStay(ctx, { captureScreenshots: false });
    if (result.outcome !== 'not_found') return result;
  }
  return result;
}

async function withTimeout(task, timeoutMs) {
  let timer;
  const work = Promise.resolve().then(task).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(TIMEOUT), timeoutMs);
  });
  const winner = await Promise.race([work, timeout]);
  clearTimeout(timer);
  if (winner === TIMEOUT) return { timedOut: true, value: null };
  if (winner.error) throw winner.error;
  return { timedOut: false, value: winner.value };
}

function batchRow(conf, result) {
  const outcome = ['found', 'not_found', 'ambiguous'].includes(result?.outcome)
    ? result.outcome
    : 'execution_failure';
  const candidate = result?.commercial;
  const commercial = outcome === 'found' && candidate && typeof candidate === 'object'
    && !Array.isArray(candidate) && Object.keys(candidate).length > 0 ? candidate : null;
  return { conf, outcome, ...(commercial ? { commercial } : {}) };
}

async function appendRow(path, row) {
  await appendFile(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseFindBatchArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  process.umask(0o077);
  const inputPath = resolve(parsed.args.input);
  const outputPath = resolve(parsed.args.out);
  if (inputPath === outputPath) throw new Error('INPUT_AND_OUTPUT_MUST_DIFFER');

  const confirmations = parseFindBatchInput(await readFile(inputPath, 'utf8'), parsed.args.cap);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  let prior = await readOutput(outputPath);
  // Keep appends line-aligned after a process was interrupted during its last write.
  if (prior && !prior.endsWith('\n')) {
    await appendFile(outputPath, '\n', { mode: 0o600 });
    prior += '\n';
  }
  await appendFile(outputPath, '', { mode: 0o600 });
  await chmod(outputPath, 0o600);
  const pending = remainingConfirmations(confirmations, prior);
  if (pending.length === 0) {
    process.stdout.write(`${JSON.stringify({ outcome: 'complete', skipped: confirmations.length, processed: 0 })}\n`);
    return 0;
  }

  const cdp = checkCdpEnv(env);
  if (!cdp.ok) throw new Error(cdp.error);
  const secret = await readSecret(env);
  const browser = await playwright().chromium.connectOverCDP(cdp.href, { timeout: CONNECT_TIMEOUT_MS });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    acceptDownloads: false,
    serviceWorkers: 'block',
    viewport: { width: 1600, height: 1000 },
  });
  let page = null;
  let processed = 0;
  try {
    await installReadOnlyGuard(context);
    page = await createStayPage(context, null, { open: false });
    await login(page, secret);
    const shellUrl = page.url();
    await openGuestStay(page);
    await page.waitForTimeout(1500);
    const baselineWindow = parsed.args.includeHistory ? await readWindow(page) : null;
    if (parsed.args.includeHistory && !baselineWindow) throw new Error('HISTORY_WINDOW_UNREADABLE');

    for (let index = 0; index < pending.length; index += 1) {
      const conf = pending[index];
      const args = {
        mode: 'find', confirmation: conf, arrival: null, departure: null, lastName: null, debugHtml: false,
      };
      const ctx = { page, args, dir: dirname(outputPath), result: null, started: Date.now(), secret };
      let timedOut = false;
      let result;
      try {
        const completed = await withTimeout(
          () => findWithHistory(ctx, parsed.args.includeHistory, baselineWindow),
          parsed.args.includeHistory ? HISTORY_ITEM_TIMEOUT_MS : ITEM_TIMEOUT_MS,
        );
        timedOut = completed.timedOut;
        result = completed.value;
      } catch (error) {
        const message = String(error?.message ?? error);
        result = { outcome: message.startsWith('AMBIGUOUS_') ? 'ambiguous' : 'execution_failure' };
      }
      const row = batchRow(conf, result);
      await appendRow(outputPath, row);
      processed += 1;
      process.stdout.write(`${JSON.stringify({
        outcome: row.outcome, processed, remaining: pending.length - processed,
      })}\n`);

      // A fresh page per confirmation: returning to the Guest Stay list in place proved unreliable on the live UI.
      await page.close().catch(() => {});
      page = await createStayPage(context, shellUrl);
      if (index + 1 < pending.length && parsed.args.pauseMs > 0) await delay(parsed.args.pauseMs);
    }
  } finally {
    await Promise.race([context.close().catch(() => {}), delay(5000)]);
    try {
      browser.disconnect?.();
    } catch {
      // The borrowed browser owner remains open.
    }
  }
  process.stdout.write(`${JSON.stringify({
    outcome: 'complete', skipped: confirmations.length - pending.length, processed,
  })}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      const message = String(error?.message ?? error);
      const safeMessage = /password|secret|cookie|jsessionid/i.test(message)
        ? 'redacted_error'
        : message.slice(0, 200);
      process.stderr.write(`${safeMessage}\n`);
      process.exit(1);
    },
  );
}
