#!/usr/bin/env node
// Adds one more room to an existing Guest Stay booking: open --parent, Associated Reservations > Add Record, set room
// type, rate plan, adults and child bands, check every value, then Submit. HMS gives the new room its own confirmation
// number and lists it with the parent under Associated Reservations; that list is HMS's one-booking-many-rooms link.
// Agency, track, market segment, guarantee, CMS fields and reservation note come from the parent: the Add Record form
// has no fields for them. --stop-before save fills and checks, then discards. --pane-commit submits.
// Usage: node add-room-stay.mjs --property CODE --request <create request json> --parent 73165771-1 --out <dir>
//   [--stop-before save | --pane-commit]
// Last stdout line: <outcome> [confirmation]. Outcomes: previewed, committed, committed_unverified, save_unconfirmed,
// refused_*, unknown_message_box, execution_failure.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openGuestStayScreen } from './open-guest-stay.mjs';
import { displayDate, newBorrowedContext, playwright, readSecret } from './fetch-quote.mjs';
import { loadCreateRequest, parseOutDir, parseStopBefore } from './create-request.mjs';
import { bandChildAges, createLabtestRefusal, extMessageBoxAction, normalizeRoomTypeCode, waitHmsMaskCleared } from './create-lab-stay.mjs';
import { parseStayProperty, propertySecretRefusal } from './property-profile.mjs';
import { findOnOpenGuestStay } from './stay-lookup.mjs';
import { withWriteCliPage } from './write-cli-lease.mjs';

const CONFIRMATION = /^\d{6,10}-\d{1,2}$/;
const MESSAGE_BOX = '[data-testid="message-box"], .x-message-box';

export function parseParent(argv) {
  const index = argv.indexOf('--parent');
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value || !CONFIRMATION.test(value)) return { ok: false, exitCode: 2, error: 'Required: --parent <confirmation>' };
  return { ok: true, parent: value };
}

// What the Add Record form must show before Submit. HMS has no 13-17 band on this form, so such a child refuses.
export function addRoomFormWant(stay) {
  const bands = bandChildAges(stay.childAges ?? []);
  if (bands.child3 > 0) return { ok: false, reason: 'refused_child_band_unsupported' };
  return {
    ok: true,
    want: {
      quantity: '1',
      arrivaldate: displayDate(stay.arrival),
      departuredate: displayDate(stay.departure),
      adults: String(stay.adults),
      child1: String(bands.child1),
      child2: String(bands.child2),
      children: String(bands.child1 + bands.child2),
      roomtype: normalizeRoomTypeCode(stay.roomType),
      rateplan: String(stay.ratePlan).trim().toUpperCase(),
      lastname: stay.lastName.trim(),
      firstname: stay.firstName.trim(),
    },
  };
}

export function formMismatches(want, values) {
  const norm = (value) => String(value ?? '').trim().toUpperCase();
  return Object.entries(want)
    .filter(([name, value]) => norm(values[name]) !== norm(value))
    .map(([name, value]) => ({ field: name, expected: value, actual: values[name] ?? null }));
}

// The parent must be the same guest on the same dates and still active, or the new room would join the wrong booking.
export function parentRefusal(parent, stay) {
  if (String(parent.lastname ?? '').trim().toLowerCase() !== stay.lastName.trim().toLowerCase()) return 'refused_parent_guest';
  if (parent.arrivaldate !== displayDate(stay.arrival) || parent.departuredate !== displayDate(stay.departure)) {
    return 'refused_parent_dates';
  }
  if (!/^(reserved|confirmed)$/i.test(String(parent.status ?? '').trim())) return 'refused_parent_status';
  return null;
}

// Confirmations in the Associated Reservations grid after Submit that were not there before.
export function newConfirmations(before, after) {
  const seen = new Set(before);
  return after.filter((conf) => !seen.has(conf));
}

async function shot(page, dir, name) {
  await page.screenshot({ path: join(dir, name), fullPage: true }).catch(() => {});
}

async function readValues(page, names) {
  return page.evaluate((list) => Object.fromEntries(list.map((name) => {
    const els = [...document.querySelectorAll(`input[name="${name}"], textarea[name="${name}"]`)]
      .filter((el) => el.getClientRects().length);
    const el = els.at(-1);
    return [name, el ? el.value : null];
  })), names);
}

async function associatedConfirmations(page) {
  return page.locator('.x-grid-row:visible').evaluateAll((rows, source) => {
    const re = new RegExp(source);
    return rows.flatMap((row) => [...row.querySelectorAll('.x-grid-cell')]
      .map((cell) => (cell.innerText || '').trim())
      .filter((text) => re.test(text)));
  }, CONFIRMATION.source);
}

async function fillText(page, name, value) {
  const input = page.locator(`input[name="${name}"]:visible`).last();
  await input.click();
  await input.fill(value);
  await input.press('Tab');
  await waitHmsMaskCleared(page);
}

// Adults and the child bands are combos: typed text does not update the Children total, a list pick does.
async function pickCombo(page, name, value) {
  const input = page.locator(`input[name="${name}"]:visible`).last();
  if ((await input.inputValue()) === value) return;
  const wrap = input.locator('xpath=ancestor::*[contains(@class,"x-form-trigger-wrap") or contains(@class,"x-form-item-body")][1]');
  await wrap.locator('.x-form-trigger, .x-form-arrow-trigger').first().click();
  await page.locator('.x-boundlist:visible li').filter({ hasText: new RegExp(`^${value}$`) }).first().click();
  await waitHmsMaskCleared(page);
}

async function discardForm(page) {
  await page.locator('[data-qtip="Reset Screen (Ctrl+R)"]:visible').first().click().catch(() => {});
  const no = page.locator(`${MESSAGE_BOX}`).filter({ visible: true }).locator('a.x-btn').filter({ hasText: /^(No|Discard)$/ });
  if (await no.count().catch(() => 0)) await no.first().click().catch(() => {});
}

async function openAssociated(page) {
  await page.locator('.x-tab:visible').filter({ hasText: /Associated Reservations/ }).first().click();
  for (let i = 0; i < 15 && !(await associatedConfirmations(page)).length; i += 1) await page.waitForTimeout(1000);
  return associatedConfirmations(page);
}

async function findStay(page, stay, confirmation, dir) {
  const found = await findOnOpenGuestStay({
    page,
    args: { mode: 'find', confirmation, arrival: stay.arrival, departure: stay.departure, lastName: stay.lastName, debugHtml: false },
    dir,
    started: Date.now(),
  }, { captureScreenshots: false });
  return found.outcome === 'found';
}

// Submit, then OK only the informational boxes the create runner allows for Labtest. Any other box stops the run.
async function submitAndWait(page, stay, before, result) {
  const bar = page.locator('[data-qtip="Add Record"]:visible').last()
    .locator('xpath=ancestor::div[contains(@class,"x-toolbar")][1]');
  const submit = bar.locator('[data-qtip="Submit"]');
  if ((await submit.count()) !== 1) return 'refused_submit_not_unique';
  await submit.click();
  result.clickedSave = true;
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(1000);
    const box = page.locator(MESSAGE_BOX).filter({ visible: true }).last();
    if (await box.count()) {
      const text = (await box.innerText()).replace(/\s+/g, ' ').replace(/\s*OK\s*$/i, '').trim();
      result.messageBoxes.push(text);
      if (extMessageBoxAction(text, stay) !== 'ok') return /charge|penalt|deposit/i.test(text) ? 'refused_message_box' : 'unknown_message_box';
      await box.locator('a.x-btn').filter({ hasText: /^OK$/ }).first().click();
      continue;
    }
    const added = newConfirmations(before, await associatedConfirmations(page));
    if (added.length === 1) {
      result.confirmationNumber = added[0];
      return 'saved';
    }
    if (added.length > 1) return 'save_unconfirmed';
  }
  return 'save_unconfirmed';
}

export async function main(argv = process.argv.slice(2)) {
  const stop = parseStopBefore(argv);
  const out = parseOutDir(argv);
  const parentArg = parseParent(argv);
  const property = parseStayProperty(argv);
  for (const parsed of [stop, out, parentArg, property]) {
    if (!parsed.ok) {
      process.stderr.write(`${parsed.error}\n`);
      process.exitCode = parsed.exitCode ?? 2;
      return;
    }
  }
  if (!stop.paneCommit && stop.stopBefore !== 'save') {
    process.stderr.write('Required: --stop-before save or --pane-commit\n');
    process.exitCode = 2;
    return;
  }
  const loaded = await loadCreateRequest(argv);
  if (!loaded.ok) {
    process.stderr.write(`${loaded.error}\n`);
    process.exitCode = loaded.exitCode;
    return;
  }
  const stay = loaded.request;
  const refusal = createLabtestRefusal(property.propertyCode, stay, process.env);
  const form = addRoomFormWant(stay);
  if (refusal || !form.ok) {
    process.stdout.write(`${refusal ?? form.reason}\n`);
    process.exitCode = 2;
    return;
  }
  const dir = out.outDir;
  if (!dir) throw new Error('OUT_DIR_REQUIRED');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const url = new URL(process.env.HMS_STAGEHAND_CDP_URL);
  if (!['http:', 'ws:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('PRIVATE_CDP_REQUIRED');
  }
  if (process.env.HMS_STAGEHAND_BROWSER_OWNERSHIP !== 'borrowed') throw new Error('BORROWED_REQUIRED');
  const secret = await readSecret();
  const hotelMismatch = propertySecretRefusal(secret, property.propertyCode);
  if (hotelMismatch) throw new Error(hotelMismatch);
  const browser = await playwright().chromium.connectOverCDP(url.href, { timeout: 20000 });
  const context = await newBorrowedContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const result = { parent: parentArg.parent, clickedSave: false, messageBoxes: [], confirmationNumber: null };
  try {
    await withWriteCliPage({
      propertyCode: property.propertyCode, secret, context, browser, env: process.env,
    }, async ({ page }) => {
      page.on?.('dialog', (dialog) => dialog.dismiss().catch(() => {}));
      page.setDefaultTimeout?.(20000);
      await openGuestStayScreen(page);
      await waitHmsMaskCleared(page);
      if (!(await findStay(page, stay, parentArg.parent, dir))) {
        result.outcome = 'refused_parent_not_found';
        return;
      }
      result.parentFields = await readValues(page, ['confirmationnumber', 'status', 'lastname', 'arrivaldate', 'departuredate']);
      result.outcome = result.parentFields.confirmationnumber === parentArg.parent
        ? parentRefusal(result.parentFields, stay) : 'refused_parent_identity';
      if (result.outcome) return;
      const before = await openAssociated(page);
      if (!before.includes(parentArg.parent)) {
        result.outcome = 'refused_parent_not_listed';
        return;
      }
      await shot(page, dir, 'before.png');
      await page.locator('[data-qtip="Add Record"]:visible').last().click();
      await page.locator('input[name="quantity"]:visible').last().waitFor();
      await fillText(page, 'roomtype', form.want.roomtype);
      await fillText(page, 'rateplan', form.want.rateplan);
      await pickCombo(page, 'adults', form.want.adults);
      await pickCombo(page, 'child1', form.want.child1);
      await pickCombo(page, 'child2', form.want.child2);
      result.form = await readValues(page, Object.keys(form.want));
      result.mismatches = formMismatches(form.want, result.form);
      await shot(page, dir, 'filled.png');
      if (result.mismatches.length) {
        result.outcome = 'refused_form_mismatch';
        await discardForm(page);
        return;
      }
      if (!stop.paneCommit) {
        result.outcome = 'previewed';
        await discardForm(page);
        return;
      }
      const submitted = await submitAndWait(page, stay, before, result);
      await shot(page, dir, 'saved.png');
      if (submitted !== 'saved') {
        result.outcome = submitted;
        return;
      }
      await page.locator('.x-tab:visible').filter({ hasText: /^Record View/ }).first().click().catch(() => {});
      await discardForm(page);
      const reread = await findStay(page, stay, result.confirmationNumber, dir);
      result.readback = reread
        ? await readValues(page, ['confirmationnumber', 'status', 'roomtype', 'rateplan', 'adults', 'children', 'arrivaldate', 'departuredate', 'lastname'])
        : null;
      const check = { confirmationnumber: result.confirmationNumber, roomtype: form.want.roomtype, adults: form.want.adults, children: form.want.children, arrivaldate: form.want.arrivaldate, departuredate: form.want.departuredate, lastname: form.want.lastname };
      result.readbackMismatches = result.readback ? formMismatches(check, result.readback) : [{ field: 'confirmationnumber', expected: result.confirmationNumber, actual: null }];
      result.outcome = result.readbackMismatches.length ? 'committed_unverified' : 'committed';
    });
  } catch (error) {
    result.error = String(error.message || error).slice(0, 300);
    result.outcome = result.clickedSave ? 'save_unconfirmed' : 'execution_failure';
  } finally {
    await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    await context.close().catch(() => {});
    if (typeof browser.disconnect === 'function') browser.disconnect();
  }
  process.stdout.write(`${result.outcome}${result.confirmationNumber ? ` ${result.confirmationNumber}` : ''}\n`);
  if (!['previewed', 'committed', 'committed_unverified'].includes(result.outcome)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (error) => {
      process.stderr.write(`${error.message || error}\n`);
      process.exit(2);
    },
  );
}
