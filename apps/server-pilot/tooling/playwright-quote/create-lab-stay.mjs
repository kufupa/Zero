#!/usr/bin/env node
// Guest Stay New Record from --request <path>. Validates
// create-tool.schema.json $defs.request before any browser work.
// Refuses Save while a required asterisk is blank.
import { openGuestStayScreen } from './open-guest-stay.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayDate, login, newBorrowedContext, playwright, readSecret } from './fetch-quote.mjs';
import { assertTrackReadyForGuarantee, bookFieldFills, confirmationRecipientFills, confirmationRecipientRefusal, confirmationSendMail, loadCreateRequest, matchTrackRow, optionalPartyAndNoteFills, parseOutDir, parseShop, parseStopBefore, parseTrackLookupText, refuseRateRowClick, shopResult, stayActions, TRACK_LABELS } from './create-request.mjs';
import { readSaveSnapshot, readSettledStatus, waitForSaveConfirmation } from './save-wait.mjs';
import { installReadOnlyGuard } from './hms-read-only-guard.mjs';
import { paneCommitOutcome, proofModeRefusal, proofPreSaveSearchRefusal, reconcileCreateSave, saveClickMayHaveFired } from './create-proof-rules.mjs';
import { parseStayProperty, profileFor, propertySecretRefusal, stayBookFieldRefusal } from './property-profile.mjs';
import { withWriteCliPage } from './write-cli-lease.mjs';
import { cellsToRow, matchKey, searchKind, windowTitleRe } from './party-lookup.mjs';

export { withWriteCliPage as withLeasedWritePage };

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
// HRDAV shows this after Save when the booking agency has a negotiated rate; it carries no choice.
export const INFORMATIONAL_AGENCY_RATES_MESSAGE = 'Negotiated Rates are Available for Booking Agency.';
const MONEY_MESSAGE = /penalty|charge|cancel|deposit|no-show|payment/i;

export function classifyExtMessageBox(text) {
  const trimmed = String(text ?? '').trim();
  if (MONEY_MESSAGE.test(trimmed)) return 'refuse';
  if (trimmed === INFORMATIONAL_NO_ROOMS_MESSAGE || trimmed === INFORMATIONAL_AGENCY_RATES_MESSAGE) return 'allow';
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

export function parseCreateProperty(argv) {
  const parsed = parseStayProperty(argv);
  if (!parsed.ok) return { ok: false, exitCode: parsed.exitCode, error: parsed.error };
  return { ok: true, propertyCode: parsed.propertyCode };
}

export function createRoomTypeMismatch(profile, roomType) {
  const roomCodes = new Set(Object.keys(profile?.rooms ?? profile?.roomCapacity ?? {}));
  return roomCodes.has(roomType) ? null : 'ROOM_TYPE_PROPERTY_MISMATCH';
}

export function createRequiredFieldNames(profile) {
  return [...REQUIRED, ...(profile?.requiredCreateFields ?? [])];
}

/** Static blank-check: missing or whitespace-only named fields. Used before Save; tests call it without a page. */
export function blankRequiredCreateFields(profile, values) {
  return createRequiredFieldNames(profile).filter((name) => !String(values?.[name] ?? '').trim());
}

export function createLabtestRefusal(propertyCode, stay, env = process.env) {
  if (propertyCode !== 'HRDAV' || env.HMS_DAVINCI_CREATE !== 'lab') return null;
  if (!/^labtest$/i.test(String(stay?.lastName ?? '').trim())) return 'pane_save_labtest_required';
  if (String(stay?.arrival ?? '') < '2027-01-01') return 'pane_save_arrival_2027_required';
  return null;
}

// A create must use the reconciled pane-commit path; preview and rate shop never save.
export function createModeRefusal({ paneCommit, stopBefore, shopMode }) {
  return paneCommit || shopMode || stopBefore === 'availability' || stopBefore === 'save'
    ? null : 'explicit_create_mode_required';
}

// --- create-readback-rules ---
export const READBACK_WAIT_MS = 60_000;
export const READBACK_POLL_MS = 5_000;

const HMS_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function squashText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function isoStayDate(value) {
  const text = squashText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null;
  }
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text);
  if (!match) return null;
  const month = HMS_MONTHS.indexOf(match[2].toUpperCase());
  if (month === -1) return null;
  const iso = `${match[3]}-${String(month + 1).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

export function bandChildAges(ages = []) {
  const counts = { child1: 0, child2: 0, child3: 0 };
  for (const age of ages) {
    if (!Number.isInteger(age) || age < 0 || age > 17) throw new Error('child_age_invalid');
    counts[age <= 2 ? 'child1' : age <= 12 ? 'child2' : 'child3'] += 1;
  }
  return counts;
}

export function compareCmsReadback(expected, actual) {
  const mismatches = [];
  for (const field of ['udfchar09', 'udfchar13', 'send']) {
    if (!Object.hasOwn(expected ?? {}, field)) continue;
    const norm = (value) => field === 'send' ? value : String(value ?? '').trim().toLocaleLowerCase();
    if (norm(expected?.[field]) !== norm(actual?.[field])) mismatches.push({ field, expected: expected?.[field] ?? null, actual: actual?.[field] ?? null });
  }
  return { reason: mismatches.length ? 'saved_cms_mismatch' : null, mismatches };
}

export function expectedCmsFields(stay) {
  const code = String(stay?.cmsMessageId ?? '').trim();
  const send = confirmationSendMail(stay);
  return { ...(code ? { udfchar09: code } : {}), ...(send ? { udfchar13: confirmationRecipientFills(stay).udfchar13 } : {}), send };
}

export function matchAgencyGridRow(row, selected, party) {
  if (!row || !selected) return false;
  if (selected.matchedOn?.includes('store')) return String(row.nativeId ?? '') === String(selected.nativeId);
  if (party?.id || party?.nativeId) return false; // DOM fallback has no verified internal ID.
  return String(row.nativeId ?? '') === String(selected.nativeId) && matchKey(row.displayName) === matchKey(selected.displayName);
}

export function matchAgencyCandidate(rows, party) {
  const id = String(party?.id ?? party?.nativeId ?? '').trim();
  if (party?.id && party?.nativeId && party.id !== party.nativeId) return null;
  const name = matchKey(party?.name);
  const matches = rows.filter((row) => id ? String(row.nativeId ?? '').trim() === id : Boolean(name) && matchKey(row.displayName) === name);
  return matches.length === 1 ? matches[0] : null;
}

export function normalizeLastName(value) {
  return squashText(value).toLocaleLowerCase();
}

export function normalizeRoomTypeCode(value) {
  const match = /^[A-Za-z0-9]+/.exec(squashText(value));
  return match ? match[0].toUpperCase() : '';
}

export function normalizeAdults(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  const text = squashText(value);
  if (!/^\d+$/.test(text)) return null;
  return Number(text);
}

export function knownConfirmation(save) {
  return squashText(save?.confirmationNumber);
}

export function readbackSearchPlan(save) {
  const confirmation = knownConfirmation(save);
  if (save?.confirmed === true && confirmation) return { by: 'confirmation', confirmation };
  return { by: 'guest' };
}

/** Guest Stay find args. Arrival is the 60-day window hint; confirmation is the match. */
export function confirmationFindLookupArgs(stay, confirmation) {
  return {
    mode: 'find',
    confirmation,
    arrival: stay?.arrival ?? null,
    departure: stay?.departure ?? null,
    lastName: stay?.lastName ?? null,
    debugHtml: false,
  };
}

export function reconcileSaveInput(save) {
  const confirmation = knownConfirmation(save);
  if (save?.confirmed === true && confirmation) {
    return { confirmed: true, confirmationNumber: confirmation };
  }
  return {
    confirmed: false,
    confirmationNumber: confirmation || null,
    reason: save?.reason ?? null,
    status: save?.status ?? null,
  };
}

export function saveStillProcessingDecision({
  reason,
  maskVisible,
  confirmationNumber,
  elapsedMs,
  timeoutMs = READBACK_WAIT_MS,
}) {
  const masked = maskVisible === true || (maskVisible == null && reason === 'still_processing');
  if (masked) return elapsedMs >= timeoutMs ? 'stop' : 'poll';
  if (knownConfirmation({ confirmationNumber })) return 'stop';
  return elapsedMs >= timeoutMs ? 'stop' : 'poll';
}

export function compareReadbackStay(expected, actual) {
  if (!actual || typeof actual !== 'object') {
    return { readbackMatch: null, mismatches: [], unknownOutcome: 'unresolved' };
  }
  const rows = [
    {
      field: 'firstName',
      expectedNorm: normalizeLastName(expected?.firstName),
      actualNorm: normalizeLastName(actual?.firstName),
      expected: expected?.firstName ?? null,
      actual: actual?.firstName ?? null,
      missing: (value) => !value,
    },
    {
      field: 'lastName',
      expectedNorm: normalizeLastName(expected?.lastName),
      actualNorm: normalizeLastName(actual?.lastName),
      expected: expected?.lastName ?? null,
      actual: actual?.lastName ?? null,
      missing: (value) => !value,
    },
    {
      field: 'arrival',
      expectedNorm: isoStayDate(expected?.arrival),
      actualNorm: isoStayDate(actual?.arrival),
      expected: expected?.arrival ?? null,
      actual: actual?.arrival ?? null,
      missing: (value) => !value,
    },
    {
      field: 'departure',
      expectedNorm: isoStayDate(expected?.departure),
      actualNorm: isoStayDate(actual?.departure),
      expected: expected?.departure ?? null,
      actual: actual?.departure ?? null,
      missing: (value) => !value,
    },
    {
      field: 'roomType',
      expectedNorm: normalizeRoomTypeCode(expected?.roomType),
      actualNorm: normalizeRoomTypeCode(actual?.roomType),
      expected: expected?.roomType ?? null,
      actual: actual?.roomType ?? null,
      missing: (value) => !value,
    },
    {
      field: 'adults',
      expectedNorm: normalizeAdults(expected?.adults),
      actualNorm: normalizeAdults(actual?.adults),
      expected: expected?.adults ?? null,
      actual: actual?.adults ?? null,
      missing: (value) => value == null,
    },
  ];
  const expectedEmail = typeof expected?.confirmationRecipient?.address === 'string'
    ? expected.confirmationRecipient.address.trim()
    : (typeof expected?.emailaddress === 'string' ? expected.emailaddress.trim() : '');
  if (expectedEmail) {
    rows.push({
      field: 'emailaddress',
      expectedNorm: expectedEmail.toLocaleLowerCase(),
      actualNorm: String(actual?.emailaddress ?? '').trim().toLocaleLowerCase(),
      expected: expectedEmail,
      actual: actual?.emailaddress ?? null,
      missing: (value) => !value,
    });
  }
  if (Array.isArray(expected?.childAges)) {
    const counts = bandChildAges(expected.childAges);
    for (const field of ['child1', 'child2', 'child3']) rows.push({
      field, expectedNorm: counts[field], actualNorm: normalizeAdults(actual?.[field]),
      expected: counts[field], actual: actual?.[field] ?? null, missing: (value) => value == null,
    });
  }
  const mismatches = [];
  for (const row of rows) {
    if (row.missing(row.expectedNorm) || row.missing(row.actualNorm)) {
      return { readbackMatch: null, mismatches, unknownOutcome: 'unresolved' };
    }
    if (row.expectedNorm !== row.actualNorm) {
      mismatches.push({ field: row.field, expected: row.expected, actual: row.actual });
    }
  }
  return { readbackMatch: mismatches.length === 0, mismatches, unknownOutcome: null };
}

export async function waitWhileStillProcessing({
  reason,
  confirmationNumber: priorConfirmation = '',
  timeoutMs = READBACK_WAIT_MS,
  pollMs = READBACK_POLL_MS,
  now = Date.now,
  sleep,
  read,
}) {
  const start = now();
  let observedConfirmation = knownConfirmation({ confirmationNumber: priorConfirmation });
  for (;;) {
    const snapshot = await read();
    const confirmationNumber = knownConfirmation(snapshot);
    if (confirmationNumber && observedConfirmation && confirmationNumber !== observedConfirmation) {
      return {
        confirmed: false,
        confirmationNumber: null,
        conflictingConfirmationNumbers: [observedConfirmation, confirmationNumber],
        status: snapshot?.status ?? null,
        reason: 'conflicting_confirmation_numbers',
      };
    }
    if (confirmationNumber) observedConfirmation = confirmationNumber;
    const maskVisible = snapshot?.maskVisible === true;
    const currentReason = maskVisible ? 'still_processing' : (confirmationNumber ? null : 'no_confirmation');
    if (!maskVisible && confirmationNumber) {
      return {
        confirmed: true,
        confirmationNumber: squashText(confirmationNumber),
        status: snapshot?.status ?? null,
        reason: null,
      };
    }
    const elapsedMs = now() - start;
    if (saveStillProcessingDecision({
      reason: currentReason ?? reason,
      maskVisible,
      confirmationNumber,
      elapsedMs,
      timeoutMs,
    }) === 'stop') {
      return {
        confirmed: false,
        confirmationNumber: observedConfirmation || null,
        status: snapshot?.status ?? null,
        reason: currentReason ?? reason,
      };
    }
    await sleep(Math.min(pollMs, Math.max(0, timeoutMs - elapsedMs)));
  }
}

export async function pollReadbackLookup(lookup, {
  timeoutMs = READBACK_WAIT_MS,
  pollMs = READBACK_POLL_MS,
  now = Date.now,
  sleep,
  isReady,
} = {}) {
  const deadline = now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      last = await lookup();
    } catch {
      last = { outcome: 'error' };
    }
    if (isReady(last)) return last;
    const remaining = deadline - now();
    if (remaining <= 0) return last;
    await sleep(Math.min(pollMs, remaining));
  }
}

export function confirmationLookupReady(result, searchedConfirmation) {
  if (result?.outcome !== 'found' || result.stay == null) return false;
  const wanted = squashText(searchedConfirmation);
  const got = squashText(result.stay.confirmation);
  return Boolean(wanted) && wanted === got;
}

export function dropUnsearchedStay(found, searchedConfirmation) {
  if (confirmationLookupReady(found, searchedConfirmation)) return found;
  return {
    outcome: found?.outcome === 'found' ? 'not_found' : (found?.outcome ?? 'not_found'),
    stay: null,
    screenshot: found?.screenshot ?? null,
  };
}

export function guestLookupReady(result) {
  return result?.outcome === 'ok' && Array.isArray(result.rows) && result.rows.length > 0;
}

export function newGuestRowReady(result, existingRows) {
  if (!guestLookupReady(result)) return false;
  const existing = new Set(
    (Array.isArray(existingRows) ? existingRows : [])
      .map((row) => squashText(row?.confirmation))
      .filter(Boolean),
  );
  return result.rows.some((row) => {
    const confirmation = squashText(row?.confirmation);
    return confirmation && !existing.has(confirmation);
  });
}

export function activeStayStatus(status) {
  return ['reserved', 'confirmed'].includes(squashText(status).toLocaleLowerCase());
}

function unresolvedReadback(proof) {
  return {
    ...proof,
    readbackMatch: null,
    unknownOutcome: 'unresolved',
  };
}

export function mergeReadbackCompare(proof, expected, lastStay) {
  if (!lastStay || !activeStayStatus(lastStay.status)) return unresolvedReadback(proof);
  const expectedConf = squashText(proof?.confNo);
  const actualConf = squashText(lastStay.confirmation);
  if (!actualConf || (expectedConf && expectedConf !== actualConf)) return unresolvedReadback(proof);
  const compared = compareReadbackStay(expected, lastStay);
  if (compared.readbackMatch !== true) {
    return {
      ...proof,
      readbackMatch: compared.readbackMatch,
      mismatches: compared.mismatches,
      unknownOutcome: compared.unknownOutcome ?? 'unresolved',
    };
  }
  return {
    ...proof,
    readbackMatch: true,
    mismatches: [],
    unknownOutcome: null,
  };
}
// --- end-create-readback-rules ---

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

/** Explicit opt-in only. Never checks the box unless stay.guestoptin4 === true. LIVE-UNVERIFIED Ext checkbox. */
async function fillGuestOptIn(page) {
  const box = page.locator('input[name="guestoptin4"]:visible').first();
  const type = await box.getAttribute('type');
  if (type === 'checkbox') {
    await box.setChecked(true);
    return;
  }
  await box.click();
}

/** CMS Send Mail (udfchkbox04): HMS sends its own confirmation letter on Save. Only when staff set a recipient. */
async function setCmsSendMail(page, desired) {
  const box = page.locator('input[name="udfchkbox04"]:visible').first();
  if ((await box.getAttribute('type')) === 'checkbox') {
    await box.setChecked(desired);
    return;
  }
  const checked = await box.evaluate((el) => el.closest('.x-form-cb-checked, .x-form-checkbox-checked') !== null);
  if (checked !== desired) await box.click();
}

async function tickCmsSendMail(page) { await setCmsSendMail(page, true); }

// Infor lookup windows render OK as an unroled `a.x-btn`; getByRole('button') never matches it.
async function clickLookupOk(win) {
  await win.locator('a.x-btn:visible').filter({ hasText: /^OK$/ }).first().click();
}

async function pickCmsMessageId(page, code) {
  const input = page.locator('input[name="udfchar09"]:visible').first();
  const trigger = input.locator('xpath=ancestor::table[1]').locator('.x-form-lov-trigger:visible, .x-form-search-trigger:visible, .x-form-trigger:visible').first();
  if (!(await trigger.count())) throw new Error('cms_message_lookup_unavailable');
  await trigger.click();
  const win = page.locator('.x-window:visible').last();
  const rows = win.locator('.x-grid-row:visible, .x-grid-data-row:visible');
  await rows.first().waitFor({ timeout: 5000 });
  // The grid fills in after its first row appears (HRDAV 03 is the 4th of 6), so re-read until the code shows.
  let exact = [];
  const deadline = Date.now() + 8000;
  for (;;) {
    exact = [];
    for (let i = 0; i < await rows.count(); i += 1) {
      const cells = await rows.nth(i).locator('td, .x-grid-cell').allTextContents();
      if (cells.some((cell) => cell.trim() === code)) exact.push(i);
    }
    if (exact.length > 0 || Date.now() >= deadline) break;
    await page.waitForTimeout(250);
  }
  if (exact.length !== 1) throw new Error('cms_message_id_not_unique');
  await rows.nth(exact[0]).click();
  await clickLookupOk(win);
}

async function pickBookingAgency(page, party) {
  const found = await searchKind(page, { kind: 'bookingAgency', query: { bookingAgencyName: party.name } });
  if (found.truncated || !['resolved', 'ambiguous'].includes(found.outcome)) return false;
  const selected = matchAgencyCandidate(found.candidates, party);
  if (!selected) return false;
  const win = page.locator('.x-window:visible').filter({ hasText: windowTitleRe('bookingAgency') }).last();
  let rows = win.locator('.x-grid-view .x-grid-row:visible, .x-grid-view .x-grid-data-row:visible');
  if (!(await rows.count())) rows = win.locator('.x-grid-item:visible');
  const matching = [];
  for (let i = 0; i < await rows.count(); i += 1) {
    const row = rows.nth(i);
    const record = await row.evaluate((el) => {
      if (typeof Ext === 'undefined') return null;
      const grids = (Ext.ComponentQuery.query('grid, readonlygrid') || [])
        .filter((grid) => grid.getEl?.()?.dom?.contains(el));
      if (grids.length !== 1) return null;
      const data = grids[0].getView?.()?.getRecord?.(el)?.data;
      return data?.travelagencyid == null ? null : { nativeId: String(data.travelagencyid), displayName: String(data.travelagencyname ?? '') };
    }).catch(() => null);
    const identity = record ?? (selected.matchedOn?.includes('store') ? null : cellsToRow(await row.locator('td, .x-grid-cell').allTextContents(), { kind: 'bookingAgency' }));
    if (matchAgencyGridRow(identity, selected, party)) matching.push(i);
  }
  if (matching.length !== 1) return false;
  await rows.nth(matching[0]).click();
  await clickLookupOk(win);
  return true;
}

async function readSavedCreateFields(page) {
  return page.evaluate(() => {
    const visibleInput = (name) => {
      const inputs = [...document.querySelectorAll(`input[name="${name}"]`)]
        .filter((input) => input.getClientRects().length && getComputedStyle(input).visibility !== 'hidden');
      return inputs.length === 1 ? inputs[0] : null;
    };
    const read = (name) => visibleInput(name)?.value ?? null;
    const box = visibleInput('udfchkbox04');
    const send = !box ? null : box.type === 'checkbox' ? box.checked : Boolean(box.closest('.x-form-cb-checked, .x-form-checkbox-checked'));
    return { emailaddress: read('emailaddress'), udfchar09: read('udfchar09'), udfchar13: read('udfchar13'), send, child1: read('child1'), child2: read('child2'), child3: read('child3') };
  });
}

async function blankRequired(page, names) {
  return page.evaluate((fieldNames) => {
    const blank = [];
    for (const name of fieldNames) {
      const input = document.querySelector(`input[name="${name}"], textarea[name="${name}"]`);
      if (!input) {
        blank.push(name);
        continue;
      }
      const value = (input.value || '').trim();
      if (!value) blank.push(name);
    }
    return blank;
  }, names);
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
    const bound = [...document.querySelectorAll('.x-boundlist')].findLast(visible);
    if (bound) {
      return [...bound.querySelectorAll('.x-boundlist-item')]
        .filter(visible)
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    }
    const grid = [...document.querySelectorAll('.x-window .x-grid-view, .x-window .x-grid')].findLast(visible);
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
    const bound = [...document.querySelectorAll('.x-boundlist')].findLast(visible);
    if (bound) {
      const item = [...bound.querySelectorAll('.x-boundlist-item')].filter(visible).find((el) => matches(el.textContent));
      if (!item) return false;
      item.click();
      return true;
    }
    const grid = [...document.querySelectorAll('.x-window .x-grid-view, .x-window .x-grid')].findLast(visible);
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
    // Ext marks a rejected lookup value on the input itself as x-form-invalid-field (HRDAV track, 2026-10-28).
    || /(^|\s)x-form-invalid(-field)?(\s|$)/.test(String(input.className || ''))
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
    const maskVisible = [...document.querySelectorAll('.x-mask, .x-mask-msg, .x-loadmask')].some(visible);
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

async function observeBlankForm(page, dir, profile) {
  const labels = profile?.createForm?.options?.guaranteetype?.choices?.map((choice) => choice.display) ?? [];
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

async function readExistingGuestRows(browser, secret, stay, dir, result) {
  try {
    const search = await searchGuestByDates(browser, secret, dir, stay);
    return search?.outcome === 'ok' && Array.isArray(search.rows) ? search.rows : null;
  } catch (error) {
    const message = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300);
    process.stderr.write(`pre_save_search_error ${message}\n`);
    if (result && typeof result === 'object') result.preSaveSearchError = message;
    return null;
  }
}

async function findStayByConfirmation(browser, secret, stay, dir, confirmation) {
  const { findOnOpenGuestStay } = await import('./stay-lookup.mjs');
  return withReadOnlyGuestStay(browser, secret, dir, confirmationFindLookupArgs(stay, confirmation), async (ctx) => {
    const found = await findOnOpenGuestStay(ctx, { captureScreenshots: false });
    let record = found.stay;
    if (record) {
      record = { ...record, ...await readSavedCreateFields(ctx.page) };
    }
    return dropUnsearchedStay({
      outcome: found.outcome,
      stay: record,
      screenshot: await shot(ctx.page, dir, 'readback.png').catch(() => null),
    }, confirmation);
  });
}

async function runProofReadback(browser, secret, stay, dir, save, savedScreenshot, existingRows) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let lastStay = null;
  const proof = await reconcileCreateSave({
    save: reconcileSaveInput(save),
    expected: stay,
    existingRows,
    readByConfirmation: async (confirmation) => {
      const found = await pollReadbackLookup(
        () => findStayByConfirmation(browser, secret, stay, dir, confirmation),
        { sleep, isReady: (result) => confirmationLookupReady(result, confirmation) },
      );
      const searched = dropUnsearchedStay(found, confirmation);
      lastStay = searched.stay;
      return searched;
    },
    searchByGuestDates: (expected) => pollReadbackLookup(
      () => searchGuestByDates(browser, secret, dir, expected),
      { sleep, isReady: (result) => newGuestRowReady(result, existingRows) },
    ),
  });
  const merged = mergeReadbackCompare(proof, stay, lastStay);
  const cms = lastStay
    ? compareCmsReadback(expectedCmsFields(stay), lastStay)
    : { reason: null, mismatches: [] };
  if (cms.reason) {
    merged.readbackMatch = false;
    merged.mismatches = [...(merged.mismatches ?? []), ...cms.mismatches];
    merged.unknownOutcome = 'unresolved';
  }
  return {
    cmsReason: cms.reason,
    confNo: merged.confNo,
    readbackMatch: merged.readbackMatch,
    mismatches: merged.mismatches,
    screenshot: merged.screenshot ?? savedScreenshot,
    unknownOutcome: merged.unknownOutcome,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const proofMode = argv.includes('--proof');
  const stop = parseStopBefore(argv);
  if (!stop.ok) {
    process.stderr.write(`${stop.error}\n`);
    process.exitCode = stop.exitCode;
    return;
  }
  const property = parseCreateProperty(argv);
  if (!property.ok) {
    process.stderr.write(`${property.error}\n`);
    process.exitCode = property.exitCode;
    return property.exitCode;
  }
  const propertyCode = property.propertyCode;
  const shopMode = parseShop(argv);
  const modeRefusal = createModeRefusal({ ...stop, shopMode });
  if (modeRefusal) {
    process.stderr.write(`${modeRefusal}\n`);
    process.exitCode = 2;
    return 2;
  }
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
  const profile = profileFor(propertyCode);
  if (!profile) {
    process.stderr.write('PROPERTY_PROFILE_REQUIRED\n');
    process.exitCode = 2;
    return;
  }
  const roomMismatch = createRoomTypeMismatch(profile, stay.roomType);
  if (roomMismatch) {
    process.stderr.write(`${roomMismatch}\n`);
    process.exitCode = 2;
    return;
  }
  if (!shopMode) {
    const bookRefusal = stayBookFieldRefusal(stay, profile);
    if (bookRefusal) {
      process.stderr.write(`${bookRefusal}\n`);
      process.exitCode = 2;
      return;
    }
  }
  const labRefusal = createLabtestRefusal(propertyCode, stay, process.env);
  if (labRefusal) {
    process.stderr.write(`${labRefusal}\n`);
    process.exitCode = 2;
    return;
  }
  const recipientRefusal = confirmationRecipientRefusal(stay);
  if (recipientRefusal) {
    process.stderr.write(`${recipientRefusal}\n`);
    process.exitCode = 2;
    return;
  }
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
  const hotelMismatch = propertySecretRefusal(secret, propertyCode);
  if (hotelMismatch) throw new Error(hotelMismatch);
  const browser = await playwright().chromium.connectOverCDP(url.href, { timeout: 20000 });
  const context = await newBorrowedContext(browser, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
  });
  const result = { guest: stay, held: false, saved: false, cancelled: false };
  let page = null;
  try {
    await withWriteCliPage({
      propertyCode, secret, context, browser, env: process.env,
    }, async ({ page: leased }) => {
      page = leased;
      page.on?.('dialog', (dialog) => {
        dialog.dismiss().catch(() => {});
      });
      page.setDefaultTimeout?.(20000);
    await openGuestStayScreen(page);
    await waitHmsMaskCleared(page);
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
        result.observe = await observeBlankForm(page, dir, profile);
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
      // A lookup result must identify exactly one agency before any save.
      const agency = stay.bookingAgency ?? (stay.agency ? { name: stay.agency } : null);
      if (agency && !(await pickBookingAgency(page, agency))) {
        result.outcome = 'refused_agency_not_unique';
        result.clickedSave = false;
        process.stdout.write(`${result.outcome}\n`);
        return;
      }
      // Other optional fields are typed; empty values are skipped.
      for (const [name, value] of Object.entries({
        ...optionalPartyAndNoteFills(stay),
        ...confirmationRecipientFills(stay),
      })) {
        if (value) await fillNamed(page, name, value);
      }
      if (confirmationSendMail(stay) && !String(stay.cmsMessageId ?? '').trim()) throw new Error('cms_message_id_required');
      if (stay.cmsMessageId) await pickCmsMessageId(page, stay.cmsMessageId.trim());
      if (confirmationSendMail(stay)) await tickCmsSendMail(page);
      else await setCmsSendMail(page, false);
      result.cmsSendMail = confirmationSendMail(stay);
      const cms = compareCmsReadback(expectedCmsFields(stay), await readSavedCreateFields(page));
      if (cms.reason) {
        result.outcome = 'refused_cms_fields_unverified';
        result.cmsMismatches = cms.mismatches;
        result.clickedSave = false;
        process.stdout.write(`${result.outcome}\n`);
        return;
      }
      const book = bookFieldFills(stay);
      if (book.marketsegment) await fillNamed(page, 'marketsegment', book.marketsegment);
      if (book.guestoptin4 === true) await fillGuestOptIn(page);
      if (stay.arAccount) await fillNamed(page, 'araccountname', stay.arAccount);
      if (stay.billingReference) await fillNamed(page, 'billingreference', stay.billingReference);
      if (Object.hasOwn(stay, 'profileId')) await fillNamed(page, 'guestid', String(stay.profileId));
    }
    await fillTrackBeforeGuarantee(page, stay.track);
    await chooseCombo(page, 'guaranteetype', stay.guaranteeType);
    await page.waitForTimeout(1000);
    const blank = await blankRequired(page, createRequiredFieldNames(profile));
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
    const filledRecipient = confirmationRecipientFills(stay).emailaddress;
    if (filledRecipient) {
      const typed = await page.locator('input[name="emailaddress"]:visible').first().inputValue().catch(() => '');
      result.confirmationRecipientReadback = {
        expected: filledRecipient,
        actual: typed,
        match: typed.trim().toLocaleLowerCase() === filledRecipient.toLocaleLowerCase(),
      };
      if (result.confirmationRecipientReadback.match !== true) {
        result.outcome = 'readback_mismatch';
        await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
        process.stdout.write(`${result.outcome}\n`);
        process.exitCode = 1;
        return;
      }
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
    if (!verifySave) throw new Error('explicit_create_mode_required');
    const existingRows = verifySave
      ? await readExistingGuestRows(browser, secret, stay, dir, result)
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
    // Availability and other form fields can alter CMS controls. Recheck immediately before Save.
    const cmsBeforeSave = compareCmsReadback(expectedCmsFields(stay), await readSavedCreateFields(page));
    if (cmsBeforeSave.reason) {
      result.outcome = 'refused_cms_fields_unverified';
      result.cmsMismatches = cmsBeforeSave.mismatches;
      result.clickedSave = false;
      process.stdout.write(`${result.outcome}\n`);
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
    // HMS masks the record while it saves. Read the number only once the mask is gone. A missing number is
    // save_unconfirmed, never a failed save: HMS may already have booked the stay.
    // Allowlisted no-rooms Ext box: click OK and keep waiting. Money/unknown abort.
    let save;
    if (saveClickUnknown) {
      if (await handleVisibleExtMessageBox(page, dir, result, stay) === 'abort') {
        process.exitCode = 2;
        return;
      }
      save = { confirmed: false, confirmationNumber: null, reason: 'save_click_unconfirmed' };
    } else {
      try {
        save = await waitForSaveConfirmation(page, {
          read: async (p) => {
            if (await handleVisibleExtMessageBox(p, dir, result, stay) === 'abort') {
              const error = new Error(result.outcome || 'unknown_message_box');
              error.messageBoxAbort = true;
              throw error;
            }
            return readSaveSnapshot(p);
          },
        });
      } catch (error) {
        if (error?.messageBoxAbort) {
          process.exitCode = 2;
          return;
        }
        if (!verifySave) throw error;
        result.saveError = String(error.message || error);
        save = { confirmed: false, confirmationNumber: null, reason: 'save_observation_error' };
      }
    }
    if (!save.confirmed) {
      try {
        save = await waitWhileStillProcessing({
          reason: save.reason,
          confirmationNumber: save.confirmationNumber,
          read: async () => {
            if (await handleVisibleExtMessageBox(page, dir, result, stay) === 'abort') {
              const error = new Error(result.outcome || 'unknown_message_box');
              error.messageBoxAbort = true;
              throw error;
            }
            return readSaveSnapshot(page);
          },
          sleep: (ms) => page.waitForTimeout(ms),
        });
      } catch (error) {
        if (error?.messageBoxAbort) {
          process.exitCode = 2;
          return;
        }
        if (!verifySave) throw error;
        result.saveError = String(error.message || error);
      }
    }
    result.confirmationNumber = save.confirmationNumber;
    if (save.conflictingConfirmationNumbers) result.conflictingConfirmationNumbers = save.conflictingConfirmationNumbers;
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
      result.emailaddressAfterSave = await page.locator('input[name="emailaddress"]:visible').first().inputValue().catch(() => '');
      const proof = await runProofReadback(
        browser, secret, stay, dir, save, savedScreenshot, existingRows,
      );
      result.confirmationNumber = proof.confNo ?? save.confirmationNumber;
      result.saved = proof.confNo ? true : null;
      result.proof = proof;
      result.cmsReason = proof.cmsReason;
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
    });
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
