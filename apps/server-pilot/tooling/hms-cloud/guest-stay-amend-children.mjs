// Saved Proof Labtest child occupancy: guarded unsaved editor and optional native Apply; never Save.
import { isDeepStrictEqual } from 'node:util';
import { installPageRequestFence } from './page-request-fence.mjs';
import {
  cleanLabtestRecord, currentLabtestRecord, snapshotLabtestRecord, unchangedLabtestBusinessParties,
} from './labtest-record.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const READ = '/web/base/OSRESV.HDR.getChildAges';
const VALIDATE = '/web/base/OSRESV.HDR.validateChildAgeDetails';
const SAVE = '/web/base/OSRESV.HDR';
const NAMES = ['children', 'child1', 'child2', 'child3'];
const usedPages = new WeakSet();
const agesValid = (ages) => Array.isArray(ages) && Array.from(ages).every((age) => Number.isInteger(age) && age >= 0 && age <= 17);
const countValid = (count) => Number.isInteger(count) && count >= 0 && count <= 9;
const same = (a, b) => isDeepStrictEqual(a, b);
const unknowns = () => ({ pricing: 'unknown', tax: 'unknown', inventory: 'unknown', saveEligible: false });
const issue = (error) => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'CHILD_STAGE_UNVERIFIED';

/** Explicit null is unknown; [] is an explicitly supplied no-children age list. */
export function planSavedChildOccupancy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { outcome: 'input_gap', issue: 'CHILD_OCCUPANCY_REQUIRED_OR_INVALID', ...unknowns() };
  const { childCount, childAges } = input;
  if (!(childCount === null || countValid(childCount)) || !(childAges === null || agesValid(childAges))) return { outcome: 'input_gap', issue: 'CHILD_OCCUPANCY_REQUIRED_OR_INVALID', ...unknowns() };
  if (childCount !== null && childAges !== null && childCount !== childAges.length) return { outcome: 'input_gap', issue: 'CHILD_COUNT_AGES_MISMATCH', ...unknowns() };
  const bands = childAges === null ? null : {
    child1: childAges.filter((age) => age <= 2).length,
    child2: childAges.filter((age) => age >= 3 && age <= 12).length,
    child3: childAges.filter((age) => age >= 13).length,
  };
  return { outcome: 'planned', childCount, childAges: childAges === null ? null : [...childAges],
    ageState: childAges === null ? 'unknown' : 'explicit', derivedBands: bands, ...unknowns() };
}

function exactField(source, name) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { present: false };
  const matches = Object.keys(source).filter((key) => key.toLowerCase() === name.toLowerCase());
  if (matches.length !== 1 || matches[0] !== name) return { present: false };
  return { present: true, value: source[name] };
}
function numeric(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
  return Number.isSafeInteger(Number(value)) ? Number(value) : null;
}
function modelAges(field) {
  if (!field.present) return null;
  const value = field.value;
  if (Array.isArray(value)) return agesValid(value) ? [...value] : null;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d?)(?:,(?:0|[1-9]\d?))*$/.test(value)) return null;
  const result = value.split(',').map(Number);
  return agesValid(result) ? result : null;
}

/** Keep native and form presence distinct. Blank, absent or malformed ages are unknown. */
export function savedChildOccupancy(snapshot) {
  const fields = Object.fromEntries([...NAMES, 'childages'].map((name) => [name, {
    form: exactField(snapshot?.values, name), model: exactField(snapshot?.data, name),
  }]));
  const counts = {};
  for (const name of NAMES) {
    const form = fields[name].form, model = fields[name].model;
    const value = form.present ? numeric(form.value) : null;
    if (value === null || !model.present || numeric(model.value) !== value) return { valid: false, fields, ageState: 'unknown' };
    counts[name] = value;
  }
  if (!countValid(counts.children) || counts.child1 + counts.child2 + counts.child3 !== counts.children) return { valid: false, fields, ageState: 'unknown' };
  const ages = modelAges(fields.childages.model);
  if (ages !== null) {
    const plan = planSavedChildOccupancy({ childCount: counts.children, childAges: ages });
    if (plan.outcome !== 'planned' || NAMES.slice(1).some((name) => counts[name] !== plan.derivedBands[name])) return { valid: false, fields, ageState: 'conflicting' };
  }
  return { valid: true, fields, count: counts.children, bands: { child1: counts.child1, child2: counts.child2, child3: counts.child3 },
    ages, ageState: ages === null ? 'unknown' : 'native_model' };
}

/** Exact saved-stay age read shape observed on one guarded HRCEN record. */
export function matchesSavedChildAgeRead(request, frame, stayId, ages) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || '');
    if (request.method() !== 'POST' || request.frame() !== frame || url.origin !== ORIGIN || url.pathname !== READ ||
        url.search || url.hash || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') ||
        [...body.keys()].length !== 2 || body.getAll('params').length !== 1 ||
        body.getAll('ONLY_DATA_REQUIRED').length !== 1 || body.get('ONLY_DATA_REQUIRED') !== 'true' ||
        typeof stayId !== 'string' || !stayId || !agesValid(ages)) return false;
    const raw = body.get('params'), params = JSON.parse(raw);
    const keys = ['propertyCode', 'reservationStayId', 'childAges'];
    if (!params || Array.isArray(params) || typeof params !== 'object' || Object.keys(params).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(params, key) || (raw.match(new RegExp('"' + key + '"\\s*:', 'g')) || []).length !== 1)) return false;
    return params.propertyCode === 'HRCEN' && params.reservationStayId === stayId && same(params.childAges, ages);
  } catch { return false; }
}

/** Match the observed saved-stay validation without authorizing Save. */
export function matchesSavedChildAgeValidation(request, frame, { stayId, adults, priorBands, ages } = {}) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || '');
    if (request.method() !== 'POST' || request.frame() !== frame || url.origin !== ORIGIN || url.pathname !== VALIDATE ||
        url.search || url.hash || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') ||
        [...body.keys()].length !== 2 || body.getAll('params').length !== 1 ||
        body.getAll('ONLY_DATA_REQUIRED').length !== 1 || body.get('ONLY_DATA_REQUIRED') !== 'true' ||
        typeof stayId !== 'string' || !stayId || !Number.isInteger(adults) || adults < 1 || adults > 16 || !agesValid(ages) ||
        !priorBands || Object.keys(priorBands).length !== 3 ||
        NAMES.slice(1).some((name) => !Object.hasOwn(priorBands, name) || !countValid(priorBands[name]))) return false;
    const raw = body.get('params'), params = JSON.parse(raw);
    const keys = ['propertyCode', 'reservationStayId', 'childAges', 'adultCount', 'childCount', 'updateChildCategories',
      'activeChildCategories', 'confirmChildCategory', 'childCategoryCounts'];
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(params, key) || (raw.match(new RegExp('"' + key + '"\\s*:', 'g')) || []).length !== 1) ||
        NAMES.slice(1).some((key) => (raw.match(new RegExp('"' + key + '"\\s*:', 'g')) || []).length !== 1)) return false;
    return params.propertyCode === 'HRCEN' && params.reservationStayId === stayId && params.adultCount === String(adults) &&
      params.childCount === String(ages.length) && same(params.childAges, ages) && params.updateChildCategories === true &&
      params.activeChildCategories === 3 && params.confirmChildCategory === false && same(params.childCategoryCounts, priorBands);
  } catch { return false; }
}

/** Accept only the exact HRCEN model metadata observed on opening this editor. */
export function matchesSavedChildEditorOpen(before, after, native) {
  if (!cleanLabtestRecord(before) || !after || native?.activeChildCategories !== 3 ||
      native?.updateChildCategories !== false || native?.confirmChildCategory !== false ||
      exactField(before.data, 'successmessages').value !== '' ||
      exactField(before.data, 'activechildcategories').value !== '') return false;
  const expected = structuredClone(before);
  expected.data.successmessages = true;
  expected.data.activechildcategories = native.activeChildCategories;
  expected.recordDirty = true;
  return same(expected, after);
}

/** A returned age list can be sorted by HMS; preserve duplicates when comparing. */
export function sameChildAgeMultiset(left, right) {
  return agesValid(left) && agesValid(right) && same([...left].sort((a, b) => a - b), [...right].sort((a, b) => a - b));
}

const CLEARED_FORM_AMOUNTS = new Set(['revenuevalue', 'nightsvalue', 'totalresortfee', 'averagerate', 'totalrate',
  'enhancedexptotal', 'grandtotal', 'totalratewithtax', 'averagenightly', 'total', 'tax', 'guesttotal',
  'guesttax', 'guesttotalwithtax']);
const CLEARED_MODEL_ZEROES = new Set(['ratetax', 'totalcomptaxamount', 'guesttotalresortfee', 'totalguestcomptaxamount']);

/** Classify only the parent-draft transitions observed on the guarded HRCEN Apply. */
export function savedChildDraftDelta(before, after, requested) {
  const invalid = () => ({ ok: false, changedFields: [], unapprovedFields: ['snapshot'], priceClearedFields: [] });
  if (!before?.values || !before?.data || !after?.values || !after?.data ||
      before.formDirty !== false || before.recordDirty !== true || after.formDirty !== true || after.recordDirty !== true ||
      !Array.isArray(before.dirtyFields) || before.dirtyFields.length || !Array.isArray(before.modifiedFields) || before.modifiedFields.length ||
      !Array.isArray(after.dirtyFields) || !Array.isArray(after.modifiedFields) ||
      new Set(after.dirtyFields).size !== after.dirtyFields.length || new Set(after.modifiedFields).size !== after.modifiedFields.length ||
      !same(Object.keys(before).sort(), Object.keys(after).sort()) ||
      !same(before.partyControls, after.partyControls) || before.partyInputsBlank !== after.partyInputsBlank ||
      !requested || requested.outcome !== 'planned' || !agesValid(requested.childAges) ||
      requested.childCount !== requested.childAges.length) return invalid();
  const plan = planSavedChildOccupancy({ childCount: requested.childCount, childAges: requested.childAges });
  if (plan.outcome !== 'planned' || !same(plan.derivedBands, requested.derivedBands)) return invalid();
  const desired = { children: requested.childCount, ...requested.derivedBands };
  if (NAMES.some((name) => numeric(after.values[name]) !== desired[name] ||
      !same(before.data[name], after.data[name])) || after.data.childages !== requested.childAges.join(',') ||
      before.data.updatechildcategories !== '' || after.data.updatechildcategories !== true ||
      before.data.enablecheckavailability !== '0' || after.data.enablecheckavailability !== '-1') return invalid();
  const changed = new Set(), bad = new Set(), cleared = [];
  for (const part of ['values', 'data']) {
    const a = before[part], b = after[part];
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (Object.hasOwn(a, name) && Object.hasOwn(b, name) && same(a[name], b[name])) continue;
      changed.add(name);
      if (!Object.hasOwn(a, name) || !Object.hasOwn(b, name)) { bad.add(name); continue; }
      if (part === 'values' && NAMES.includes(name) && numeric(b[name]) === desired[name]) continue;
      if (part === 'data' && name === 'childages' && b[name] === requested.childAges.join(',')) continue;
      if (part === 'data' && name === 'updatechildcategories' && a[name] === '' && b[name] === true) continue;
      if (part === 'data' && name === 'enablecheckavailability' && a[name] === '0' && b[name] === '-1') continue;
      if (part === 'data' && CLEARED_MODEL_ZEROES.has(name) && a[name] === '0' && b[name] === '' &&
          !Object.hasOwn(before.values, name) && !Object.hasOwn(after.values, name)) continue;
      if (part === 'values' && CLEARED_FORM_AMOUNTS.has(name) && typeof a[name] === 'string' &&
          /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(a[name]) && b[name] === '' &&
          Object.hasOwn(before.data, name) && Object.hasOwn(after.data, name) && same(before.data[name], after.data[name])) {
        cleared.push(name); continue;
      }
      bad.add(name);
    }
  }
  for (const name of [...after.dirtyFields, ...after.modifiedFields]) if (typeof name !== 'string' || !changed.has(name)) bad.add(String(name));
  return { ok: bad.size === 0, changedFields: [...changed].sort(), unapprovedFields: [...bad].sort(),
    priceClearedFields: cleared.sort() };
}

async function visibleChildFields(frame) {
  return frame.evaluate((names) => Object.fromEntries(names.map((name) => {
    const nodes = [...document.querySelectorAll('input')].filter((el) => el.name === name &&
      (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    if (nodes.length !== 1) return [name, null];
    const el = nodes[0], cmp = globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
    const guests = [...document.querySelectorAll('input[name="guestid"]')].filter((input) =>
      (input.offsetWidth || input.offsetHeight) && getComputedStyle(input).visibility !== 'hidden' && !input.closest('.x-window'));
    const form = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
    if (!form?.el?.dom || !form.el.dom.contains(el) || cmp?.up?.('form') !== form) return [name, null];
    return [name, { visible: el.value, component: cmp?.getValue?.(), readOnly: Boolean(el.readOnly || cmp?.readOnly),
      disabled: Boolean(el.disabled || cmp?.isDisabled?.()) }];
  })), NAMES);
}
function visibleMatches(visible, occupancy) {
  return NAMES.every((name) => visible?.[name] && numeric(visible[name].visible) === numeric(occupancy.fields[name].form.value) &&
    numeric(visible[name].component) === numeric(occupancy.fields[name].form.value));
}

/**
 * The caller owns a guarded page with one saved HRCEN Proof Labtest Record View.
 * With applyToDraft, one exact native validation may update the unsaved parent.
 * The page is quarantined afterward; close it to discard. No Save is authorized.
 */
export async function stageLabtestChildAmendment(page, expected = {}, options = {}) {
  const targetKeys = new Set(['confirmation', 'guestId', 'arrival', 'departure', 'roomType', 'ratePlan', 'note', 'adults', 'childCount', 'childAges']);
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
      Object.keys(expected).some((key) => !targetKeys.has(key))) return { outcome: 'input_gap', issue: 'UNSUPPORTED_EXPECTED_FIELD', ...unknowns() };
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['childCount', 'childAges', 'timeoutMs', 'applyToDraft'].includes(key))) {
    return { outcome: 'input_gap', issue: 'UNSUPPORTED_AMEND_OPTION', ...unknowns() };
  }
  const requested = planSavedChildOccupancy(options), prior = planSavedChildOccupancy(expected);
  if (requested.outcome !== 'planned') return requested;
  if (prior.outcome !== 'planned' || !countValid(expected.childCount) ||
      !Number.isInteger(expected.adults) || expected.adults < 1 || expected.adults > 16) {
    return { outcome: 'input_gap', issue: 'OCCUPANCY_PREIMAGE_REQUIRED', ...unknowns() };
  }
  if (requested.childCount === null || requested.childAges === null) return {
    outcome: 'input_gap', issue: 'EXACT_CHILD_AGES_REQUIRED', requested, ...unknowns(),
  };
  if (prior.childAges === null) return { outcome: 'input_gap', issue: 'PREIMAGE_AGES_UNKNOWN', requested, ...unknowns() };
  if (options.applyToDraft !== undefined && typeof options.applyToDraft !== 'boolean') return { outcome: 'input_gap', issue: 'INVALID_APPLY_OPTION', ...unknowns() };
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return { outcome: 'input_gap', issue: 'INVALID_TIMEOUT', ...unknowns() };
  if (!page || typeof page.route !== 'function' || typeof page.context !== 'function' || typeof page.on !== 'function') {
    return { outcome: 'input_gap', issue: 'PAGE_REQUIRED', ...unknowns() };
  }
  try {
    const context = page.context();
    if (context?._options?.serviceWorkers !== 'block' || typeof context.serviceWorkers !== 'function' || context.serviceWorkers().length !== 0) {
      return { outcome: 'refused', issue: 'BROWSER_CONTEXT_UNSAFE', ...unknowns() };
    }
  } catch { return { outcome: 'refused', issue: 'BROWSER_CONTEXT_UNSAFE', ...unknowns() }; }
  if (usedPages.has(page)) return { outcome: 'refused', issue: 'PAGE_ALREADY_USED', ...unknowns() };
  usedPages.add(page);
  let fence, scope, readRequest = null, validationRequest = null, readArmed = false, validationArmed = false, opened = false, applyAttempted = false, active = true, nativeDialog = false, blocked = 0;
  let state, baseline, occupancy, visible, validationResult, timedOut = false;
  const deadlineAt = performance.now() + timeoutMs;
  const expire = () => { timedOut = true; active = false; scope?.close(); fence?.quarantine(); };
  const isActive = () => {
    if (!timedOut && performance.now() >= deadlineAt) expire();
    return active;
  };
  const requireActive = () => {
    if (!isActive() || blocked || nativeDialog) throw new Error(timedOut ? 'CHILD_STAGE_TIMEOUT' : 'CHILD_STAGE_GUARD_STOPPED');
  };
  const onDialog = () => { nativeDialog = true; active = false; fence?.quarantine(); };
  page.on('dialog', onDialog);
  let timeout;
  const execute = async () => {
    // Layer on the caller's existing context guard. Never bypass it with continue().
    fence = await installPageRequestFence(page, [READ, VALIDATE, SAVE]);
    // Fence installation may finish after the outer deadline returned.
    if (!isActive()) { fence.quarantine(); throw new Error('CHILD_STAGE_TIMEOUT'); }
    const contextGuard = async (route) => {
      const request = route.request();
      // Retained guards govern only their own page. Unknown ownership fails closed.
      let owner;
      try { owner = request.frame().page(); } catch { blocked++; return route.abort(); }
      if (!owner) { blocked++; return route.abort(); }
      if (owner !== page) return route.fallback();
      let url;
      try { url = new URL(request.url()); } catch { blocked++; return route.abort(); }
      const safe = ['GET', 'HEAD', 'OPTIONS'].includes(request.method().toUpperCase()) &&
        !/save|delete|cancel|duplicate|checkin|checkout|send|email|mail|crs/i.test(url.pathname) &&
        ![...url.searchParams].some(([key, value]) => key.toLowerCase() === 'pageaction' &&
          /^(save|delete|cancel|duplicate|checkin|checkout|crs|insert|update|commit|create|submit|autosave|amend|post)$/i.test(value.trim()));
      if (safe || (isActive() && (request === readRequest || request === validationRequest) && !fence.isQuarantined())) return route.fallback();
      blocked++; return route.abort();
    };
    requireActive();
    await page.context().route('**/*', contextGuard);
    requireActive();
    await page.route('**/*', async (route) => {
      const request = route.request();
      let url;
      try { url = new URL(request.url()); } catch { blocked++; return route.abort(); }
      if (isActive() && readArmed && !blocked && !nativeDialog && !readRequest && state && matchesSavedChildAgeRead(request, state.frame, state.native.reservationstayid, prior.childAges) &&
          !fence.isQuarantined() && scope?.allow(request)) {
        readRequest = request;
        return route.fallback();
      }
      if (isActive() && validationArmed && !blocked && !nativeDialog && !validationRequest && state &&
          matchesSavedChildAgeValidation(request, state.frame, { stayId: state.native.reservationstayid,
            adults: expected.adults, priorBands: occupancy.bands, ages: requested.childAges }) &&
          !fence.isQuarantined() && scope?.allow(request)) {
        validationRequest = request;
        return route.fallback();
      }
      const safe = ['GET', 'HEAD', 'OPTIONS'].includes(request.method().toUpperCase()) &&
        !/save|delete|cancel|duplicate|checkin|checkout|send|email|mail|crs/i.test(url.pathname) &&
        url.pathname.toLowerCase() !== SAVE.toLowerCase() &&
        ![...url.searchParams].some(([key, value]) => key.toLowerCase() === 'pageaction' &&
          /^(save|delete|cancel|duplicate|checkin|checkout|crs|insert|update|commit|create|submit|autosave|amend|post)$/i.test(value.trim()));
      if (safe) return route.fallback();
      blocked++;
      return route.abort();
    });
    requireActive();
    scope = fence.open();
    state = await currentLabtestRecord(page, expected, { allowBlankNote: true, allowUnchangedBusinessParties: true });
    baseline = await snapshotLabtestRecord(state.frame);
    if (!cleanLabtestRecord(baseline)) throw new Error('RECORD_HAS_DIRTY_FIELDS');
    if (!unchangedLabtestBusinessParties(state.partyPreimage, baseline)) throw new Error('LABTEST_LINKED_PARTY_UNVERIFIED');
    occupancy = savedChildOccupancy(baseline);
    const adultForm = exactField(baseline.values, 'adults'), adultModel = exactField(baseline.data, 'adults');
    if (!occupancy.valid || occupancy.count !== expected.childCount || !same(occupancy.ages, prior.childAges) ||
        !adultForm.present || !adultModel.present || numeric(adultForm.value) !== expected.adults ||
        numeric(adultModel.value) !== expected.adults) {
      throw new Error('OCCUPANCY_PREIMAGE_UNVERIFIED');
    }
    visible = await visibleChildFields(state.frame);
    if (!visibleMatches(visible, occupancy)) throw new Error('CHILD_VISIBLE_PREIMAGE_UNVERIFIED');
    if (await page.locator('.x-window:visible:not(.x-menu)').count() !== 1 ||
        await state.frame.locator('.x-window:visible:not(.x-menu)').count() !== 0) throw new Error('UNEXPECTED_DIALOG');
    requireActive();
    if (same(prior.childAges, requested.childAges)) return { outcome: 'unchanged', requested, saved: occupancy,
      savedVisible: visible, popup: null, ...unknowns() };
    const trigger = state.frame.locator('[data-qtip="Enter Child Ages"]:visible');
    if (await trigger.count() !== 1) throw new Error('AGE_EDITOR_UNAVAILABLE');
    requireActive();
    const pending = page.waitForResponse((response) => response.request() === readRequest && readRequest !== null,
      { timeout: timeoutMs }).catch(() => null);
    requireActive();
    readArmed = true;
    opened = true;
    await trigger.click({ timeout: Math.min(timeoutMs, 5000), noWaitAfter: true });
    const response = await pending;
    readArmed = false;
    if (!response?.ok()) throw new Error('AGE_READ_FAILED');
    const native = await response.json();
    if (!active || blocked || nativeDialog || native?.propertyCode !== 'HRCEN' ||
        native?.reservationStayId !== state.native.reservationstayid || !same(native?.childAges, prior.childAges)) {
      throw new Error('SAVED_AGE_READBACK_UNVERIFIED');
    }
    const popup = state.frame.locator('.x-window[id^="childagespopup"]:visible');
    await popup.waitFor({ timeout: timeoutMs });
    if (await popup.count() !== 1 || await state.frame.locator('.x-window:visible').count() !== 1) {
      throw new Error('AGE_EDITOR_NOT_UNIQUE');
    }
    const count = popup.locator('input[name="children"]');
    if (await count.count() !== 1) throw new Error('CHILD_COUNT_UNAVAILABLE');
    const readInput = async (input) => input.evaluate((el) => ({
      visible: el.value, native: globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''))?.getValue?.(),
    }));
    const exactInput = async (input, expectedValue) => {
      const value = await readInput(input);
      if (numeric(value.visible) !== expectedValue || numeric(value.native) !== expectedValue) {
        throw new Error('AGE_EDITOR_READBACK_MISMATCH');
      }
      return value;
    };
    await exactInput(count, prior.childCount);
    const popupBaseline = await snapshotLabtestRecord(state.frame);
    if (!matchesSavedChildEditorOpen(baseline, popupBaseline, native)) throw new Error('AGE_EDITOR_SIDE_EFFECT_UNVERIFIED');
    const toggle = popup.locator('input[name="updatechildcategories"]');
    if (await toggle.count() !== 1) throw new Error('AGE_EDITOR_UNAVAILABLE');
    const readToggle = () => toggle.evaluate((el) => globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''))?.getValue?.());
    if (await readToggle() !== false || !active || blocked || nativeDialog) throw new Error('AGE_EDITOR_TOGGLE_UNVERIFIED');
    requireActive();
    await toggle.click({ timeout: Math.min(timeoutMs, 5000), noWaitAfter: true });
    if (await readToggle() !== true || !active || blocked || nativeDialog ||
        !same(popupBaseline, await snapshotLabtestRecord(state.frame))) throw new Error('AGE_EDITOR_TOGGLE_UNVERIFIED');
    const ageInput = (index) => popup.getByText(`Age of Child ${index + 1}`, { exact: true })
      .locator('xpath=ancestor::table[contains(@class,"x-form-item")][1]').locator('input:visible');
    for (let i = 0; i < prior.childAges.length; i++) {
      if (await ageInput(i).count() !== 1) throw new Error('AGE_EDITOR_PREIMAGE_UNVERIFIED');
      await exactInput(ageInput(i), prior.childAges[i]);
    }
    let countNow = prior.childCount;
    while (countNow !== requested.childCount) {
      if (!active || blocked || nativeDialog) throw new Error('CHILD_STAGE_GUARD_STOPPED');
      const change = countNow < requested.childCount ? 1 : -1;
      requireActive();
      await count.locator('xpath=ancestor::tr[1]').locator(`.x-spinbox-control.${change > 0 ? 'up' : 'down'}`)
        .click({ timeout: Math.min(timeoutMs, 5000), noWaitAfter: true });
      countNow += change;
      await exactInput(count, countNow);
    }
    for (let i = 0; i < requested.childAges.length; i++) {
      if (!active || blocked || nativeDialog) throw new Error('CHILD_STAGE_GUARD_STOPPED');
      const label = popup.getByText(`Age of Child ${i + 1}`, { exact: true });
      await label.waitFor({ timeout: timeoutMs });
      const row = label.locator('xpath=ancestor::table[contains(@class,"x-form-item")][1]');
      if (await row.locator('input:visible').count() !== 1) throw new Error('AGE_EDITOR_UNAVAILABLE');
      requireActive();
      await row.locator('.x-form-arrow-trigger:visible').click({ timeout: Math.min(timeoutMs, 5000), noWaitAfter: true });
      const items = state.frame.locator('.x-boundlist:visible').last().locator('.x-boundlist-item:visible');
      await items.first().waitFor({ timeout: timeoutMs });
      const indexes = await items.evaluateAll((nodes, age) => nodes.flatMap((node, index) =>
        node.textContent.trim() === String(age) ? [index] : []), requested.childAges[i]);
      if (indexes.length !== 1) throw new Error('AGE_OPTION_NOT_UNIQUE');
      if (!active || blocked || nativeDialog) throw new Error('CHILD_STAGE_GUARD_STOPPED');
      requireActive();
      await items.nth(indexes[0]).click({ timeout: Math.min(timeoutMs, 5000), noWaitAfter: true });
      await exactInput(ageInput(i), requested.childAges[i]);
    }
    const popupCount = await exactInput(count, requested.childCount);
    const popupAges = [];
    for (let i = 0; i < requested.childAges.length; i++) popupAges.push(await exactInput(ageInput(i), requested.childAges[i]));
    const current = await currentLabtestRecord(page, expected, { allowBlankNote: true, allowUnchangedBusinessParties: true });
    const after = await snapshotLabtestRecord(state.frame);
    const afterVisible = await visibleChildFields(state.frame);
    if (!active || blocked || nativeDialog || current.frame !== state.frame || !same(current.native, state.native) ||
        current.track !== state.track || !same(current.partyPreimage, state.partyPreimage) ||
        !unchangedLabtestBusinessParties(state.partyPreimage, after) ||
        !same(popupBaseline, after) || !visibleMatches(afterVisible, occupancy)) {
      throw new Error('SAVED_FORM_CHANGED');
    }
    if (options.applyToDraft === true) {
      const apply = popup.locator('a.x-btn:visible').filter({ hasText: /^\s*Apply\s*$/ });
      if (await apply.count() !== 1 || await readToggle() !== true || !active || blocked || nativeDialog) throw new Error('AGE_APPLY_UNVERIFIED');
      // Reconfirm this exact saved page and its complete parent preimage immediately before dispatch.
      const target = await currentLabtestRecord(page, expected, { allowBlankNote: true, allowUnchangedBusinessParties: true });
      if (target.frame !== state.frame || !same(target.native, state.native) || target.track !== state.track ||
          !same(target.partyPreimage, state.partyPreimage) || !same(popupBaseline, await snapshotLabtestRecord(state.frame))) {
        throw new Error('SAVED_FORM_CHANGED');
      }
      requireActive();
      const validating = page.waitForResponse((response) => response.request() === validationRequest && validationRequest !== null,
        { timeout: timeoutMs }).catch(() => null);
      requireActive();
      validationArmed = true;
      applyAttempted = true;
      await apply.click({ timeout: Math.min(timeoutMs, 5000), noWaitAfter: true });
      const validation = await validating;
      validationArmed = false;
      if (!validation?.ok() || !active || blocked || nativeDialog) throw new Error('AGE_VALIDATION_FAILED');
      const nativeValidation = await validation.json();
      validationResult = nativeValidation;
      const responseKeys = ['reservationStayId', 'adultCount', 'childCount', 'propertyCode', 'activeChildCategories',
        'updateChildCategories', 'confirmChildCategory', 'childAges', 'childCategoryCounts', 'dirtyList', 'gUserID',
        'gFunctionName', 'gRemovePooledBean', 'gEntityName'];
      if (!nativeValidation || typeof nativeValidation !== 'object' || Array.isArray(nativeValidation) ||
          Object.keys(nativeValidation).length !== responseKeys.length || responseKeys.some((key) => !Object.hasOwn(nativeValidation, key)) ||
          nativeValidation.propertyCode !== 'HRCEN' || nativeValidation.reservationStayId !== state.native.reservationstayid ||
          !sameChildAgeMultiset(nativeValidation.childAges, requested.childAges) || numeric(nativeValidation.childCount) !== requested.childCount ||
          numeric(nativeValidation.adultCount) !== expected.adults || nativeValidation.activeChildCategories !== 3 ||
          nativeValidation.updateChildCategories !== true || nativeValidation.confirmChildCategory !== false ||
          !same(nativeValidation.dirtyList, []) || nativeValidation.gUserID !== '' || nativeValidation.gFunctionName !== '' ||
          nativeValidation.gRemovePooledBean !== false || nativeValidation.gEntityName !== '') {
        throw new Error('AGE_VALIDATION_RESPONSE_UNVERIFIED');
      }
      // One HMS response reordered the ages. Identity/order semantics remain unproved.
      if (!same(nativeValidation.childAges, requested.childAges)) throw new Error('AGE_VALIDATION_ORDER_UNVERIFIED');
      await popup.waitFor({ state: 'hidden', timeout: timeoutMs });
      const targetAfter = await currentLabtestRecord(page, expected, { allowBlankNote: true, allowUnchangedBusinessParties: true });
      const draft = await snapshotLabtestRecord(state.frame), draftVisible = await visibleChildFields(state.frame);
      if (!active || blocked || nativeDialog || targetAfter.frame !== state.frame || !same(targetAfter.native, state.native) ||
          targetAfter.track !== state.track || !same(targetAfter.partyPreimage, state.partyPreimage) ||
          !unchangedLabtestBusinessParties(state.partyPreimage, draft)) throw new Error('DRAFT_TARGET_UNVERIFIED');
      const nativeCounts = nativeValidation.childCategoryCounts;
      if (!nativeCounts || typeof nativeCounts !== 'object' || Array.isArray(nativeCounts) ||
          Object.keys(nativeCounts).some((name) => !NAMES.slice(1).includes(name.toLowerCase())) ||
          NAMES.slice(1).some((name) => Object.keys(nativeCounts).filter((key) => key.toLowerCase() === name).length > 1 ||
            numeric(nativeCounts[name] ?? nativeCounts[name.toUpperCase()] ?? 0) !== requested.derivedBands[name]) ||
          NAMES.some((name) => numeric(draftVisible[name]?.visible) !== (name === 'children' ? requested.childCount : requested.derivedBands[name]) ||
            numeric(draftVisible[name]?.component) !== (name === 'children' ? requested.childCount : requested.derivedBands[name]))) {
        throw new Error('DRAFT_CHILD_READBACK_UNVERIFIED');
      }
      const delta = savedChildDraftDelta(popupBaseline, draft, requested);
      const draftOccupancy = Object.fromEntries([...NAMES, 'childages'].map((name) => [name, {
        form: exactField(draft.values, name), model: exactField(draft.data, name),
      }]));
      requireActive();
      if (!delta.ok) return { outcome: 'apply_uncertain', issue: 'DRAFT_SIDE_EFFECTS_UNVERIFIED', requested,
        saved: occupancy, draftVisible, draftOccupancy, ...delta, nativeValidationVerified: true, ...unknowns() };
      return { outcome: 'applied_to_unsaved_draft', requested, saved: occupancy, draftVisible, draftOccupancy, ...delta,
        nativeValidationVerified: true, nativeResponseAges: nativeValidation.childAges,
        nativeEditorSideEffects: ['successmessages', 'activechildcategories', 'recordDirty'],
        requiresReprice: true, ...unknowns() };
    }
    requireActive();
    return { outcome: 'staged_in_editor', requested, saved: occupancy, savedVisible: afterVisible,
      popup: { childCount: popupCount, childAges: popupAges, applied: false },
      nativeReadVerified: true, nativeEditorSideEffects: ['successmessages', 'activechildcategories', 'recordDirty'], ...unknowns() };
  };
  try {
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => { expire(); reject(new Error('CHILD_STAGE_TIMEOUT')); }, timeoutMs);
    });
    return await Promise.race([execute(), deadline]);
  } catch (error) {
    return { outcome: applyAttempted ? 'apply_uncertain' : opened ? 'stage_uncertain' : 'not_staged', issue: nativeDialog ? 'UNEXPECTED_DIALOG' : timedOut ? 'CHILD_STAGE_TIMEOUT' : issue(error),
      blockedRequests: blocked, ...(occupancy ? { saved: occupancy } : {}),
      ...(agesValid(validationResult?.childAges) ? { nativeResponseAges: validationResult.childAges } : {}), requested, ...unknowns() };
  } finally {
    clearTimeout(timeout);
    active = false;
    scope?.close();
    // A delayed request or partial popup action cannot become authorized later.
    fence?.quarantine();
    // Leave deny routes and dialog listener installed for the page lifetime.
  }
}
