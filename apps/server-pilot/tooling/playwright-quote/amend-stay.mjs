#!/usr/bin/env node
// Deterministic Labtest amend. Rate, penalty, and charge dialogs are always refused.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCdpEnv } from './cancel-stay-rules.mjs';
import { openGuestStay, shot } from './cancel-stay.mjs';
import { login, playwright, readSecret, displayDate } from './fetch-quote.mjs';
import { findOnOpenGuestStay } from './stay-lookup.mjs';
import { readSaveSnapshot, SAVE_POLL_MS, SAVE_WAIT_MS } from './save-wait.mjs';
import {
  amendCommitAllowed,
  amendPreviewDigest,
  compareChangedFields,
  dangerousDialogKind,
  parseAmendArgs,
  unsupportedFieldReason,
  validateAmendCurrent,
  validateAmendRequest,
} from './amend-stay-rules.mjs';

// Source-backed New Record names. Existing-record writability remains TODO-LIVE-PROBE; unavailable controls refuse.
const SELECTOR_BY_FIELD = {
  arrival: 'arrivaldate', departure: 'departuredate', adults: 'adults', children: 'children', roomType: 'roomtype',
};

function newResult() {
  return { outcome: 'execution_failure', reason: null, confirmation: null, statusBefore: null, statusAfter: null,
    previewDigest: null, saveAttempted: false, changedFieldsReadback: null, fieldDiff: null, fieldRefusals: {},
    refusal: null, todoLiveProbe: ['Existing-stay edit state and Save behavior'], screenshots: [], error: null };
}

function errorText(error) {
  return String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300);
}

function currentFields(stay) {
  return { confirmation: stay.confirmation, lastName: stay.lastName, status: stay.status, arrival: stay.arrival,
    departure: stay.departure, adults: stay.adults, children: stay.children, roomType: stay.roomType };
}

async function dangerousDialog(page) {
  const windows = page.locator('.x-window:visible');
  for (let index = 0; index < await windows.count(); index += 1) {
    const text = (await windows.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const kind = dangerousDialogKind(text);
    if (kind) return { kind, text: text.slice(0, 300) };
  }
  return null;
}

async function refuseUnsupportedFields(ctx, fields) {
  for (const field of Object.keys(fields)) {
    const locator = ctx.page.locator(`input[name="${SELECTOR_BY_FIELD[field]}"]:visible`);
    const count = await locator.count();
    const state = count === 1
      ? await locator.evaluate((input) => ({ disabled: input.disabled, readOnly: input.readOnly })).catch(() => null)
      : null;
    if (unsupportedFieldReason({ count, disabled: state?.disabled !== false, readOnly: state?.readOnly !== false })) {
      ctx.result.fieldRefusals[field] = { reason: 'unsupported_field', note: 'TODO-LIVE-PROBE' };
    }
  }
  if (Object.keys(ctx.result.fieldRefusals).length === 0) return false;
  ctx.result.outcome = 'refused_unsupported_field';
  ctx.result.reason = 'unsupported_field';
  return true;
}

async function clickSave(page) {
  return page.evaluate((source) => {
    const pattern = new RegExp(source, 'i');
    const nodes = [...document.querySelectorAll('[data-qtip], button, .x-btn')];
    const matches = nodes.filter((node) => pattern.test(node.getAttribute('data-qtip') || node.textContent || ''));
    if (matches.length !== 1) return false;
    matches[0].click();
    return true;
  }, '^Save');
}

async function fillChangedFields(page, fields) {
  for (const [field, value] of Object.entries(fields)) {
    const input = page.locator(`input[name="${SELECTOR_BY_FIELD[field]}"]:visible`);
    const shown = field === 'arrival' || field === 'departure' ? displayDate(value) : String(value);
    await input.click();
    await input.fill(shown);
    await input.press('Tab');
    if (await input.inputValue() !== shown) return field;
  }
  return null;
}

async function waitForSaveToSettle(page) {
  const deadline = Date.now() + SAVE_WAIT_MS;
  let snapshot = await readSaveSnapshot(page);
  while (snapshot.maskVisible && Date.now() < deadline) {
    await page.waitForTimeout(Math.min(SAVE_POLL_MS, deadline - Date.now()));
    snapshot = await readSaveSnapshot(page);
  }
  return { settled: !snapshot.maskVisible, snapshot };
}

async function captureAfter(ctx) {
  try {
    await shot(ctx, 'after.png');
  } catch (error) {
    ctx.result.afterScreenshotError = errorText(error);
  }
}

function recordReadback(ctx, fields, stay) {
  const values = Object.fromEntries(Object.keys(fields).map((field) => [field, stay?.[field] ?? null]));
  const comparison = compareChangedFields(fields, values);
  Object.assign(ctx.result, { changedFieldsReadback: values, fieldDiff: comparison.diff, statusAfter: stay?.status ?? null });
}

async function findByConfirmation(ctx, request, secret) {
  const args = { mode: 'find', confirmation: request.confirmation, arrival: null, lastName: request.expectedLastName, debugHtml: false };
  return findOnOpenGuestStay({ args, dir: ctx.dir, result: {}, started: Date.now(), page: ctx.page, secret }, { captureScreenshots: false });
}

async function reopenByConfirmation(ctx, context, request, secret) {
  await ctx.page.close();
  ctx.page = await context.newPage();
  ctx.page.setDefaultTimeout(20000); await login(ctx.page, secret);
  await openGuestStay(ctx.page); await ctx.page.waitForTimeout(1500);
  return findByConfirmation(ctx, request, secret);
}

async function run(ctx, request) {
  let browser = null;
  let context = null;
  try {
    if (!amendCommitAllowed(ctx.args.mode, process.env)) {
      ctx.result.outcome = 'refused_flag_off';
      ctx.result.reason = 'refused_flag_off';
      return;
    }
    const cdp = checkCdpEnv(process.env);
    if (!cdp.ok) throw new Error(cdp.error);
    const secret = await readSecret();
    browser = await playwright().chromium.connectOverCDP(cdp.href, { timeout: 20000 });
    context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
    ctx.page = await context.newPage();
    ctx.page.setDefaultTimeout(20000);
    await login(ctx.page, secret);
    await openGuestStay(ctx.page);
    await ctx.page.waitForTimeout(1500);

    const lookup = await findByConfirmation(ctx, request, secret);
    ctx.result.findMethod = lookup.findMethod;
    if (lookup.outcome !== 'found' || !lookup.stay) {
      ctx.result.outcome = `refused_${lookup.outcome}`;
      ctx.result.reason = lookup.reason ?? lookup.outcome;
      return;
    }

    const stay = lookup.stay;
    ctx.result.confirmation = stay.confirmation;
    ctx.result.statusBefore = stay.status;
    ctx.result.before = currentFields(stay);
    await shot(ctx, 'before.png');
    const refusal = validateAmendCurrent(request, stay);
    if (refusal) {
      ctx.result.outcome = `refused_${refusal}`;
      ctx.result.reason = refusal;
      return;
    }
    const previewDigest = amendPreviewDigest({
      confirmation: request.confirmation, expectedLastName: request.expectedLastName,
      current: currentFields(stay), fields: request.fields,
    });
    ctx.result.previewDigest = previewDigest;
    if (ctx.args.mode === 'commit' && ctx.args.digest !== previewDigest) {
      ctx.result.outcome = 'refused_digest_mismatch';
      ctx.result.reason = 'digest_mismatch';
      return;
    }
    const dialog = await dangerousDialog(ctx.page);
    if (dialog) {
      ctx.result.outcome = 'refused_dangerous_dialog';
      ctx.result.reason = 'dangerous_dialog';
      ctx.result.refusal = dialog;
      return;
    }
    if (await refuseUnsupportedFields(ctx, request.fields)) return;
    if (ctx.args.mode === 'preview') {
      ctx.result.outcome = 'previewed';
      return;
    }

    const mismatch = await fillChangedFields(ctx.page, request.fields);
    if (mismatch) {
      ctx.result.outcome = 'refused_unsupported_field';
      ctx.result.reason = 'unsupported_field';
      ctx.result.fieldRefusals[mismatch] = { reason: 'unsupported_field', note: 'TODO-LIVE-PROBE' };
      return;
    }
    const beforeSaveDialog = await dangerousDialog(ctx.page);
    if (beforeSaveDialog) {
      ctx.result.outcome = 'refused_dangerous_dialog';
      ctx.result.reason = 'dangerous_dialog';
      ctx.result.refusal = beforeSaveDialog;
      return;
    }
    ctx.result.saveAttempted = true;
    if (!(await clickSave(ctx.page))) {
      ctx.result.saveAttempted = false;
      ctx.result.outcome = 'refused_save_control_missing';
      ctx.result.reason = 'save_control_missing';
      return;
    }

    const settled = await waitForSaveToSettle(ctx.page);
    const afterSaveDialog = await dangerousDialog(ctx.page);
    const refreshed = await reopenByConfirmation(ctx, context, request, secret);
    const freshStay = refreshed.outcome === 'found' ? refreshed.stay : null;
    ctx.result.freshLookupOutcome = refreshed.outcome;
    recordReadback(ctx, request.fields, freshStay);
    await captureAfter(ctx);
    if (afterSaveDialog) {
      ctx.result.outcome = 'refused_dangerous_dialog_after_save';
      ctx.result.reason = 'dangerous_dialog_after_save';
      ctx.result.refusal = afterSaveDialog;
    } else if (!settled.settled) {
      ctx.result.outcome = 'save_not_confirmed';
      ctx.result.reason = 'save_still_processing';
    } else if (!freshStay) {
      ctx.result.outcome = 'save_not_confirmed';
      ctx.result.reason = 'fresh_readback_unavailable';
    } else if (freshStay.status !== 'Reserved' && freshStay.status !== 'Confirmed') {
      ctx.result.outcome = 'save_not_confirmed';
      ctx.result.reason = 'status_readback_unsupported';
    } else if (Object.keys(ctx.result.fieldDiff).length > 0) {
      ctx.result.outcome = 'save_not_confirmed';
      ctx.result.reason = 'changed_field_readback_mismatch';
    } else if (ctx.result.afterScreenshotError) {
      ctx.result.outcome = 'save_not_confirmed';
      ctx.result.reason = 'after_screenshot_unavailable';
    } else {
      ctx.result.outcome = 'amended';
    }
  } catch (error) {
    ctx.result.error = errorText(error);
    ctx.result.outcome = ctx.result.saveAttempted ? 'save_not_confirmed' : 'execution_failure';
    ctx.result.reason = ctx.result.saveAttempted ? 'fresh_readback_failed' : 'execution_failure';
    if (ctx.result.saveAttempted && ctx.result.changedFieldsReadback === null) recordReadback(ctx, request.fields, null);
  } finally {
    if (ctx.page && ctx.result.screenshots.some((path) => path.endsWith('/before.png')) &&
      !ctx.result.screenshots.some((path) => path.endsWith('/after.png'))) await captureAfter(ctx);
    if (context) await context.close().catch(() => {});
    if (browser && typeof browser.disconnect === 'function') browser.disconnect();
  }
}

const exitCodeFor = (outcome) => outcome === 'previewed' || outcome === 'amended' ? 0 : outcome.startsWith('refused_') ? 2 : 1;

async function main() {
  const parsed = parseAmendArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = parsed.exitCode;
    return;
  }
  const args = { ...parsed.args, out: resolve(parsed.args.out) };
  const result = newResult();
  const ctx = { args, dir: args.out, result, page: null };
  await mkdir(ctx.dir, { recursive: true, mode: 0o700 });
  try {
    const validated = validateAmendRequest(JSON.parse(await readFile(args.request, 'utf8')));
    if (!validated.ok) {
      result.outcome = `refused_${validated.reason}`;
      result.reason = validated.reason;
    } else {
      result.confirmation = validated.request.confirmation;
      await run(ctx, validated.request);
    }
  } catch (error) {
    result.error = errorText(error);
    result.reason = 'execution_failure';
  }
  const resultJson = join(ctx.dir, 'result.json');
  await writeFile(resultJson, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ outcome: result.outcome, resultJson })}\n`);
  process.exitCode = exitCodeFor(result.outcome);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
