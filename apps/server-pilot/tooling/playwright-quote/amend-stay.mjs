#!/usr/bin/env node
// Deterministic Labtest amend. Rate, penalty, and charge dialogs are always refused.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCdpEnv } from './cancel-stay-rules.mjs';
import { closeAppDrawer, openGuestStay, shot } from './cancel-stay.mjs';
import { login, newBorrowedContext, playwright, readSecret, displayDate } from './fetch-quote.mjs';
import { findOnOpenGuestStay } from './stay-lookup.mjs';
import { readSaveSnapshot, SAVE_POLL_MS, SAVE_WAIT_MS } from './save-wait.mjs';
import {
  amendCommitAllowed,
  amendPreviewDigest,
  comboUnsupportedFieldReason,
  commitAndVerifyFields,
  compareChangedFields,
  dangerousDialogKind,
  isComboAmendField,
  parseAmendArgs,
  unsupportedFieldReason,
  validateAmendCurrent,
  validateAmendRequest,
} from './amend-stay-rules.mjs';
import { parseStayProperty, propertySecretRefusal } from './property-profile.mjs';
import { withWriteCliPage } from './write-cli-lease.mjs';

export { withWriteCliPage as withLeasedWritePage };

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
    departure: stay.departure, adults: stay.adults, children: stay.children, roomType: stay.roomType,
    guaranteeType: stay.guaranteeType, depositReceived: stay.depositReceived };
}

async function dangerousDialog(page) {
  // The Guest Stay record and the Start Center menu are .x-windows too, and both say "Rate". A dialog has an
  // OK, Yes or No button; those two never do.
  const windows = page.locator('.x-window:visible').filter({
    hasNot: page.locator(`input[name="${SELECTOR_BY_FIELD.arrival}"]`),
    has: page.locator('.x-btn:visible', { hasText: /^\s*(OK|Yes|No)\s*$/ }),
  });
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
    let reason;
    let state = null;
    if (isComboAmendField(field)) {
      state = count === 1
        ? await locator.evaluate((input) => {
            const cmp = typeof Ext !== 'undefined' && input.id
              ? Ext.getCmp(input.id.replace(/-inputEl$/, ''))
              : null;
            if (cmp) {
              const disabled = typeof cmp.isDisabled === 'function' ? cmp.isDisabled() : !!cmp.disabled;
              return { exists: true, disabled: !!disabled, readOnly: cmp.readOnly === true };
            }
            const wrap = input.closest('.x-field');
            if (!wrap) return { exists: false, disabled: true, readOnly: true };
            return {
              exists: true,
              disabled: wrap.classList.contains('x-item-disabled'),
              readOnly: false,
            };
          }).catch(() => null)
        : null;
      reason = comboUnsupportedFieldReason({ count, ...(state || {}) });
    } else {
      state = count === 1
        ? await locator.evaluate((input) => ({ disabled: input.disabled, readOnly: input.readOnly })).catch(() => null)
        : null;
      reason = unsupportedFieldReason({
        count,
        disabled: state?.disabled !== false,
        readOnly: state?.readOnly !== false,
      });
    }
    if (reason) {
      ctx.result.fieldRefusals[field] = {
        reason: 'unsupported_field',
        note: isComboAmendField(field) ? JSON.stringify({ count, ...(state || { evaluate: 'failed' }) }) : 'TODO-LIVE-PROBE',
      };
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

// HMS keeps a changed date or occupancy only after Check Availability has re-rated the stay; Save before that is discarded.
async function checkAvailability(page) {
  await closeAppDrawer(page);
  const btn = page.locator('.x-btn:visible').filter({ hasText: /^Check Availability$/i }).first();
  const qtip = page.locator('[data-qtip="Check Availability"]:visible').first();
  const target = (await btn.count()) > 0 ? btn : qtip;
  if ((await target.count()) === 0) return false;
  try {
    await target.click({ timeout: 5000 });
  } catch {
    return false;
  }
  await page.waitForTimeout(2000);
  const deadline = Date.now() + SAVE_WAIT_MS;
  while ((await readSaveSnapshot(page)).maskVisible && Date.now() < deadline) await page.waitForTimeout(SAVE_POLL_MS);
  await page.waitForTimeout(1500);
  await closeAppDrawer(page);
  return true;
}

function fieldInput(page, field) {
  return page.locator(`input[name="${SELECTOR_BY_FIELD[field]}"]:visible`).first();
}

async function fillOneField(page, field, value) {
  const input = fieldInput(page, field);
  await input.scrollIntoViewIfNeeded().catch(() => {});
  const shown = field === 'arrival' || field === 'departure' ? displayDate(value) : String(value);
  const iso = field === 'arrival' || field === 'departure' ? value : null;
  const combo = isComboAmendField(field) ? value : null;
  // Playwright fill updates the DOM but ExtJS Guest Stay discards it on Save unless the
  // component is setValue'd and then blurred. Occupancy is a combobox (uxcombobox *-inputEl);
  // dates are uxdate. Live fixture: tooling/playwright-quote/fixtures/stay-lookup/record-form-live.html.
  // HRDAV adults store values are strings ("0","1","2"); setValue(2) leaves getValue null.
  await input.evaluate((el, payload) => {
    const id = el.id?.replace(/-inputEl$/, '');
    const cmp = typeof Ext !== 'undefined' && id ? Ext.getCmp(id) : null;
    if (cmp?.setValue) {
      if (payload.iso) {
        const [year, month, day] = payload.iso.split('-').map(Number);
        cmp.setValue(new Date(year, month - 1, day));
      } else if (payload.combo != null) {
        const vf = cmp.valueField || 'value';
        const store = cmp.store;
        let chosen = String(payload.combo);
        if (store && typeof store.getCount === 'function') {
          for (let i = 0; i < store.getCount(); i += 1) {
            const rec = store.getAt(i);
            const v = rec && typeof rec.get === 'function' ? rec.get(vf) : rec?.[vf];
            if (String(v) === String(payload.combo)) {
              chosen = rec;
              break;
            }
          }
        }
        cmp.setValue(chosen);
        if (cmp.fireEvent) cmp.fireEvent('select', cmp, chosen);
        const form = typeof cmp.up === 'function' ? (cmp.up('form') || cmp.up('recordview')) : null;
        const rec = form && typeof form.getRecord === 'function' ? form.getRecord() : null;
        if (form && typeof form.updateRecord === 'function') {
          if (rec) form.updateRecord(rec);
          else form.updateRecord();
        }
        const name = cmp.name || payload.fieldName;
        const written = chosen && typeof chosen.get === 'function' ? chosen.get(vf) : chosen;
        if (rec && name && typeof rec.set === 'function' && written != null) {
          rec.set(name, written);
        }
      } else {
        cmp.setValue(payload.shown);
      }
    } else {
      el.value = payload.shown;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, { shown, iso, combo, fieldName: SELECTOR_BY_FIELD[field] });
}

async function blurOneField(page, field) {
  const input = fieldInput(page, field);
  await input.evaluate((el) => {
    const id = el.id?.replace(/-inputEl$/, '');
    const cmp = typeof Ext !== 'undefined' && id ? Ext.getCmp(id) : null;
    if (cmp?.fireEvent) cmp.fireEvent('blur', cmp);
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  });
}

async function readOneField(page, field) {
  const input = fieldInput(page, field);
  return input.evaluate((el) => {
    const id = el.id?.replace(/-inputEl$/, '');
    const cmp = typeof Ext !== 'undefined' && id ? Ext.getCmp(id) : null;
    let got = typeof cmp?.getValue === 'function' ? cmp.getValue() : el.value;
    if (got instanceof Date && !Number.isNaN(got.getTime())) {
      const year = got.getFullYear();
      const month = String(got.getMonth() + 1).padStart(2, '0');
      const day = String(got.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    if (got && typeof got === 'object') {
      const vf = cmp.valueField || 'value';
      got = typeof got.get === 'function' ? got.get(vf) : got[vf];
    }
    return got;
  });
}

async function fillChangedFields(page, fields) {
  await closeAppDrawer(page);
  return commitAndVerifyFields({
    fill: (field, value) => fillOneField(page, field, value),
    blur: (field) => blurOneField(page, field),
    read: (field) => readOneField(page, field),
  }, fields);
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
  const args = { mode: 'find', confirmation: request.confirmation, arrival: request.currentArrival ?? null, lastName: request.expectedLastName, debugHtml: false };
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
    const hotelMismatch = propertySecretRefusal(secret, ctx.args.property);
    if (hotelMismatch) throw new Error(hotelMismatch);
    browser = await playwright().chromium.connectOverCDP(cdp.href, { timeout: 20000 });
    context = await newBorrowedContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
    await withWriteCliPage({
      propertyCode: ctx.args.property, secret, context, browser, env: process.env,
    }, async ({ page: leased }) => {
    ctx.page = leased;
    ctx.page.setDefaultTimeout?.(20000);
    await openGuestStay(ctx.page);
    await ctx.page.waitForTimeout(1500);

    // The record sometimes fails to open on the first try; one fresh page retries it.
    const lookup = await findByConfirmation(ctx, request, secret)
      .catch(() => reopenByConfirmation(ctx, context, request, secret));
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
    if (ctx.args.mode === 'preview') {
      await shot(ctx, 'diff.png');
      ctx.result.outcome = 'previewed';
      return;
    }
    if (!(await checkAvailability(ctx.page))) {
      ctx.result.outcome = 'refused_save_control_missing';
      ctx.result.reason = 'check_availability_missing';
      return;
    }
    const afterAvailabilityDialog = await dangerousDialog(ctx.page);
    if (afterAvailabilityDialog) {
      ctx.result.outcome = 'refused_dangerous_dialog';
      ctx.result.reason = 'dangerous_dialog_after_availability';
      ctx.result.refusal = afterAvailabilityDialog;
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
    });
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

export async function main(argv = process.argv.slice(2)) {
  const property = parseStayProperty(argv);
  if (!property.ok) {
    process.stderr.write(`${property.error}\n`);
    process.exitCode = property.exitCode;
    return property.exitCode;
  }
  const parsed = parseAmendArgs(property.rest);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = parsed.exitCode;
    return parsed.exitCode;
  }
  const args = { ...parsed.args, out: resolve(parsed.args.out), property: property.propertyCode };
  const result = newResult();
  const ctx = { args, dir: args.out, result, page: null };
  await mkdir(ctx.dir, { recursive: true, mode: 0o700 });
  try {
    const validated = validateAmendRequest(JSON.parse(await readFile(args.request, 'utf8')), args.property);
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
  return process.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
