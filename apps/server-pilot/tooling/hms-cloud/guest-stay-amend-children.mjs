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

// Reject ambiguous duplicate JSON keys without fixing the native field set.
function parseUniqueJson(raw) {
  const value = JSON.parse(raw), stack = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i], top = stack.at(-1);
    if (ch === '"') {
      let end = i + 1, escaped = false;
      for (; end < raw.length; end++) {
        if (escaped) { escaped = false; continue; }
        if (raw[end] === '\\') { escaped = true; continue; }
        if (raw[end] === '"') break;
      }
      if (top?.kind === 'object' && top.key) {
        const key = JSON.parse(raw.slice(i, end + 1)).toLowerCase();
        if (top.keys.has(key)) throw new Error('DUPLICATE_FIELD');
        top.keys.add(key); top.key = false;
      }
      i = end;
    } else if (ch === '{') stack.push({ kind: 'object', key: true, keys: new Set() });
    else if (ch === '[') stack.push({ kind: 'array' });
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',' && top?.kind === 'object') top.key = true;
  }
  return value;
}

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
  const bands = { child1: counts.child1, child2: counts.child2, child3: counts.child3 };
  const ages = modelAges(fields.childages.model);
  if (ages !== null) {
    if (ages.length !== counts.children || !currentChildCategories(snapshot, ages, bands)) return { valid: false, fields, ageState: 'conflicting' };
  }
  return { valid: true, fields, count: counts.children, bands,
    ages, ageState: ages === null ? 'unknown' : 'native_model' };
}

/** Match the selected stay and child values, allowing HMS to add unrelated fields. */
export function matchesSavedChildAgeRead(request, frame, stayId, ages) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || '');
    if (request.method() !== 'POST' || request.frame() !== frame || url.origin !== ORIGIN || url.pathname !== READ ||
        url.search || url.hash || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') ||
        body.getAll('params').length !== 1 || typeof stayId !== 'string' || !stayId) return false;
    const params = parseUniqueJson(body.get('params'));
    return params?.propertyCode === 'HRCEN' && params.reservationStayId === stayId && agesValid(params.childAges) &&
      (ages === null || same(params.childAges, ages));
  } catch { return false; }
}

/** Check native validation against the selected stay and the requested ages. */
export function matchesSavedChildAgeValidation(request, frame, { stayId, adults, priorBands, ages } = {}) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || '');
    if (request.method() !== 'POST' || request.frame() !== frame || url.origin !== ORIGIN || url.pathname !== VALIDATE ||
        url.search || url.hash || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') ||
        body.getAll('params').length !== 1 || typeof stayId !== 'string' || !stayId || !Number.isInteger(adults) ||
        adults < 1 || adults > 16 || !agesValid(ages) || !priorBands ||
        NAMES.slice(1).some((name) => !countValid(priorBands[name]))) return false;
    const params = parseUniqueJson(body.get('params'));
    return params?.propertyCode === 'HRCEN' && params.reservationStayId === stayId &&
      numeric(params.adultCount) === adults && numeric(params.childCount) === ages.length &&
      same(params.childAges, ages) && params.updateChildCategories === true &&
      params.activeChildCategories === 3 && params.confirmChildCategory === false &&
      NAMES.slice(1).every((name) => Object.hasOwn(params.childCategoryCounts ?? {}, name) &&
        numeric(params.childCategoryCounts[name]) === priorBands[name]);
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

const PRESERVED_CHILD_BUSINESS_FIELDS = [
  'propertycode', 'confirmationnumber', 'reservationstayid', 'reservationid', 'recordid', 'PKID', 'bookingsessionid',
  'guestid', 'status', 'firstname', 'lastname', 'arrivaldate', 'departuredate', 'roomtype', 'roomtypecharge',
  'rateplan', 'track', 'mealplan', 'sourceofbusiness', 'sourceofbusinessdesc', 'guaranteetype',
  'ta1', 'taid1', 'bookingagencycontractid', 'bacontract', 'bookingagency1iatanumber', 'company', 'companyname',
  'companyid', 'araccountname', 'arprofileid', 'araccountid', 'billingreference', 'guaranteecreditcardid',
  'leaseguaranteecreditcardid', 'reservationnote', 'emailaddress', 'caller', 'udfchar06', 'udfchkbox04',
  'udfchar09', 'udfchar13', 'adults', 'child1label', 'child2label', 'child3label',
  'child1status', 'child2status', 'child3status',
];
const READ_CHILD_BUSINESS_FIELDS = [...PRESERVED_CHILD_BUSINESS_FIELDS, ...NAMES, 'childages',
  'balance', 'averagerate', 'totalrate', 'grandtotal', 'totalratewithtax', 'averagenightly', 'total', 'tax',
  'guesttotal', 'guesttax', 'guesttotalwithtax', 'totalresortfee'];

function preservedChildBusinessFields(before, after, names) {
  if (!before?.values || !before?.data || !after?.values || !after?.data ||
      !same(before.partyControls, after.partyControls)) return false;
  return ['values', 'data'].every((part) => names.every((name) => {
    const a = Object.keys(before[part]).filter((key) => key.toLowerCase() === name.toLowerCase());
    const b = Object.keys(after[part]).filter((key) => key.toLowerCase() === name.toLowerCase());
    return a.length <= 1 && b.length <= 1 && same(a, b) && (!a.length || same(before[part][a[0]], after[part][b[0]]));
  }));
}

function readChildEditorSnapshot(before, opened, native) {
  return preservedChildBusinessFields(before, opened, READ_CHILD_BUSINESS_FIELDS) &&
    opened.formDirty === false && opened.recordDirty === true && Array.isArray(opened.dirtyFields) &&
    opened.dirtyFields.length === 0 && Array.isArray(opened.modifiedFields) && opened.modifiedFields.length === 0 &&
    exactField(opened.data, 'successmessages').value === true &&
    exactField(opened.data, 'activechildcategories').value === native.activeChildCategories;
}

// Category ranges come from this stay's current HMS model, not hotel defaults.
function currentChildCategories(snapshot, ages, bands) {
  const ranges = [];
  for (const name of NAMES.slice(1)) {
    const label = exactField(snapshot?.data, `${name}label`), status = exactField(snapshot?.data, `${name}status`);
    const match = label.present && typeof label.value === 'string' && /^Child\s+(\d{1,2})\s*-\s*(\d{1,2})$/i.exec(label.value.trim());
    if (!match || !status.present || status.value !== 'ACTIVE') return false;
    const from = Number(match[1]), to = Number(match[2]);
    if (from > to || to > 99) return false;
    ranges.push({ name, from, to });
  }
  // Every supported age must identify one current category, without overlaps.
  for (let age = 0; age <= 17; age++) if (ranges.filter(({ from, to }) => age >= from && age <= to).length !== 1) return false;
  return ranges.every(({ name, from, to }) => ages.filter((age) => age >= from && age <= to).length === bands[name]);
}

/** Read the current saved ages through one fenced native response; never Apply. */
export async function readSavedChildAgesForComposition(context, expected) {
  const { page, frame, childStageGate: gate } = context ?? {};
  const active = () => {
    if (!page || !frame || !gate || typeof context.isActive !== 'function' || typeof context.remainingMs !== 'function' ||
        !context.isActive() || context.remainingMs() <= 0) throw new Error('CHILD_STAGE_GUARD_STOPPED');
  };
  active();
  if (typeof gate.isReadOnly !== 'function' || !gate.isReadOnly() || typeof gate.matchesPreimage !== 'function' ||
      !expected || !countValid(expected.childCount) || !Number.isInteger(expected.adults) ||
      expected.adults < 1 || expected.adults > 16 || !/^\d+$/.test(expected.reservationStayId || '')) {
    throw new Error('CHILD_READ_INPUT_INVALID');
  }
  const recordOptions = { allowBlankNote: true, allowUnchangedBusinessParties: true,
    allowModelOnlyPrimaryPartyIds: true, preserveUnsentRecipient: true,
    ...(context.allowRealGuest === true ? { allowRealGuest: true, expectedGuarantee: expected.expectedGuarantee } : {}) };
  const state = await currentLabtestRecord(page, expected, recordOptions);
  active();
  const before = await snapshotLabtestRecord(frame), occupancy = savedChildOccupancy(before);
  if (state.frame !== frame || state.native.reservationstayid !== expected.reservationStayId ||
      !cleanLabtestRecord(before) || !unchangedLabtestBusinessParties(state.partyPreimage, before, recordOptions) ||
      (context.baseline && !preservedChildBusinessFields(context.baseline, before, READ_CHILD_BUSINESS_FIELDS)) ||
      !occupancy.valid || occupancy.count !== expected.childCount ||
      numeric(exactField(before.values, 'adults').value) !== expected.adults ||
      numeric(exactField(before.data, 'adults').value) !== expected.adults) throw new Error('CHILD_PREIMAGE_UNVERIFIED');
  const raw = occupancy.fields.childages.model;
  // Blank model data is only the outgoing editor argument; it is not a saved age list.
  if (!raw.present || (occupancy.ages === null && raw.value !== '')) throw new Error('CHILD_READ_ARGUMENT_UNVERIFIED');
  const readAges = occupancy.ages === null ? [] : occupancy.ages;
  if (!gate.matchesPreimage({ frame, stayId: expected.reservationStayId, adults: expected.adults,
    priorAges: occupancy.ages, priorBands: occupancy.bands, readAges })) throw new Error('CHILD_READ_GATE_MISMATCH');
  const visible = await visibleChildFields(frame);
  if (!visibleMatches(visible, occupancy) || await frame.locator('.x-window:visible').count() !== 0) {
    throw new Error('CHILD_VISIBLE_PREIMAGE_UNVERIFIED');
  }
  const trigger = frame.locator('[data-qtip="Enter Child Ages"]:visible');
  if (await trigger.count() !== 1 || !gate.armRead()) throw new Error('AGE_EDITOR_UNAVAILABLE');
  const pending = page.waitForResponse((response) => gate.isReadRequest(response.request()),
    { timeout: Math.min(context.remainingMs(), 20000) }).catch(() => null);
  let popup = null, closed = false, completed = false;
  try {
    await trigger.click({ timeout: 5000, noWaitAfter: true });
    const response = await pending;
    if (!response?.ok()) throw new Error('AGE_READ_FAILED');
    const native = await response.json();
    active();
    if (native?.propertyCode !== 'HRCEN' || native?.reservationStayId !== expected.reservationStayId ||
        native.activeChildCategories !== 3 || native.updateChildCategories !== false || native.confirmChildCategory !== false ||
        !agesValid(native.childAges) || native.childAges.length !== occupancy.count ||
        (occupancy.ages !== null && !sameChildAgeMultiset(native.childAges, occupancy.ages)) ||
        !currentChildCategories(before, native.childAges, occupancy.bands)) throw new Error('SAVED_AGE_READBACK_UNVERIFIED');
    popup = frame.locator('.x-window[id^="childagespopup"]:visible');
    await popup.waitFor({ timeout: Math.min(context.remainingMs(), 20000) });
    if (await popup.count() !== 1 || await frame.locator('.x-window:visible').count() !== 1) throw new Error('AGE_EDITOR_NOT_UNIQUE');
    const inputValue = (input) => input.evaluate((el) => ({ visible: el.value,
      native: globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''))?.getValue?.() }));
    const count = popup.locator('input[name="children"]'), adults = popup.locator('input[name="adults"]');
    const toggle = popup.locator('input[name="updatechildcategories"]');
    if (await count.count() !== 1 || await adults.count() !== 1 || await toggle.count() !== 1) throw new Error('AGE_EDITOR_UNAVAILABLE');
    const countValue = await inputValue(count), adultValue = await inputValue(adults);
    const blankZero = occupancy.count === 0 && native.childAges.length === 0 && countValue.visible === '' &&
      (countValue.native === '' || countValue.native == null);
    if ((!blankZero && (numeric(countValue.visible) !== occupancy.count || numeric(countValue.native) !== occupancy.count)) ||
        numeric(adultValue.visible) !== expected.adults || numeric(adultValue.native) !== expected.adults ||
        await toggle.evaluate((el) => globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''))?.getValue?.()) !== false ||
        await popup.getByText(/^Age of Child \d+$/, { exact: true }).count() !== occupancy.count) {
      throw new Error('AGE_EDITOR_PREIMAGE_UNVERIFIED');
    }
    const popupAges = [];
    for (let i = 0; i < occupancy.count; i++) {
      const row = popup.getByText(`Age of Child ${i + 1}`, { exact: true })
        .locator('xpath=ancestor::table[contains(@class,"x-form-item")][1]').locator('input:visible');
      if (await row.count() !== 1) throw new Error('AGE_EDITOR_PREIMAGE_UNVERIFIED');
      const value = await inputValue(row), age = numeric(value.visible);
      if (age === null || numeric(value.native) !== age) throw new Error('AGE_EDITOR_PREIMAGE_UNVERIFIED');
      popupAges.push(age);
    }
    const opened = await snapshotLabtestRecord(frame);
    if (!sameChildAgeMultiset(popupAges, native.childAges) || !readChildEditorSnapshot(before, opened, native) ||
        !gate.markReadVerified()) throw new Error('AGE_EDITOR_PREIMAGE_UNVERIFIED');
    gate.close();
    const cancel = popup.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ });
    if (await cancel.count() !== 1) throw new Error('AGE_EDITOR_CANCEL_UNAVAILABLE');
    active();
    await cancel.click({ timeout: 5000, noWaitAfter: true });
    await popup.waitFor({ state: 'hidden', timeout: Math.min(context.remainingMs(), 20000) });
    closed = true;
    const after = await snapshotLabtestRecord(frame), current = await currentLabtestRecord(page, expected, recordOptions);
    active();
    if (current.frame !== frame || !same(current.native, state.native) || !same(current.partyPreimage, state.partyPreimage) ||
        !readChildEditorSnapshot(before, after, native) ||
        !unchangedLabtestBusinessParties(state.partyPreimage, after, recordOptions)) {
      throw new Error('CHILD_READ_SIDE_EFFECT_UNVERIFIED');
    }
    completed = true;
    return { ages: [...native.childAges], bands: { ...occupancy.bands } };
  } finally {
    gate.close();
    if (!closed && context.isActive() && context.remainingMs() > 0) {
      try {
        popup ??= frame.locator('.x-window[id^="childagespopup"]:visible');
        const cancel = popup.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ });
        if (await popup.count() === 1 && await cancel.count() === 1) {
          await cancel.click({ timeout: Math.min(5000, context.remainingMs()), noWaitAfter: true });
          await popup.waitFor({ state: 'hidden', timeout: Math.min(5000, context.remainingMs()) });
        }
      } catch { /* The owning context is stopped below. */ }
    }
    if (!completed) context.stop?.('CHILD_READ_INCOMPLETE');
  }
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

/** Apply child ages to the already guarded, unsaved saved-stay draft. */
export async function stageSavedChildrenForComposition(context, expected, childAges) {
  return runSavedChildEditor(context, expected, childAges, false);
}

/** Verify the requested editor values and cancel without applying them. */
export async function previewSavedChildrenForComposition(context, expected, childAges) {
  return runSavedChildEditor(context, expected, childAges, true);
}

async function runSavedChildEditor(context, expected, childAges, preview) {
  const { page, frame, childStageGate: gate } = context ?? {};
  const requested = planSavedChildOccupancy({ childCount: childAges?.length, childAges });
  let popup = null, closed = false, completed = false;
  const active = () => {
    if (!page || !frame || !gate || !context.isActive() || context.remainingMs() <= 0) throw new Error('CHILD_STAGE_GUARD_STOPPED');
  };
  try {
  active();
  if (requested.outcome !== 'planned' || requested.childAges === null ||
      typeof gate.isReadOnly !== 'function' || gate.isReadOnly() !== preview) throw new Error('CHILD_AGES_INVALID');
  const before = await snapshotLabtestRecord(frame), occupancy = savedChildOccupancy(before);
  if (!occupancy.valid || occupancy.count !== expected.childCount || !agesValid(expected.childAges) ||
      expected.childAges.length !== occupancy.count || !currentChildCategories(before, expected.childAges, occupancy.bands) ||
      exactField(before.data, 'propertycode').value !== 'HRCEN' ||
      String(exactField(before.data, 'guestid').value ?? '') !== expected.guestId ||
      String(before.data.reservationstayid ?? '') !== expected.reservationStayId ||
      String(before.data.confirmationnumber ?? '') !== expected.confirmation) throw new Error('CHILD_PREIMAGE_UNVERIFIED');
  const raw = occupancy.fields.childages.model;
  if (!raw.present || (occupancy.ages === null && raw.value !== '') ||
      (occupancy.ages !== null && !sameChildAgeMultiset(occupancy.ages, expected.childAges)) ||
      !gate.matchesPreimage?.({ frame, stayId: expected.reservationStayId, adults: expected.adults,
        priorAges: expected.childAges, priorBands: occupancy.bands, readAges: occupancy.ages ?? [] })) {
    throw new Error('CHILD_PREIMAGE_UNVERIFIED');
  }
  const trigger = frame.locator('[data-qtip="Enter Child Ages"]:visible');
  if (await trigger.count() !== 1 || !gate.armRead()) throw new Error('AGE_EDITOR_UNAVAILABLE');
  const read = page.waitForResponse((response) => gate.isReadRequest(response.request()),
    { timeout: Math.min(context.remainingMs(), 20000) }).catch(() => null);
  active();
  await trigger.click({ timeout: 5000, noWaitAfter: true });
  const readResponse = await read;
  if (!readResponse?.ok()) throw new Error('AGE_READ_FAILED');
  const native = await readResponse.json();
  active();
  if (native?.propertyCode !== 'HRCEN' || native?.reservationStayId !== expected.reservationStayId ||
      !agesValid(native.childAges) || native.childAges.length !== occupancy.count ||
      !sameChildAgeMultiset(native.childAges, expected.childAges) || native.activeChildCategories !== 3 ||
      native.updateChildCategories !== false || native.confirmChildCategory !== false) {
    throw new Error('SAVED_AGE_READBACK_UNVERIFIED');
  }
  popup = frame.locator('.x-window[id^="childagespopup"]:visible');
  await popup.waitFor({ timeout: Math.min(context.remainingMs(), 20000) });
  if (await popup.count() !== 1) throw new Error('AGE_EDITOR_NOT_UNIQUE');
  const count = popup.locator('input[name="children"]');
  if (await count.count() !== 1) throw new Error('CHILD_COUNT_UNAVAILABLE');
  const valueOf = (input) => input.evaluate((el) => ({ visible: el.value,
    native: globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''))?.getValue?.() }));
  const exact = async (input, value, { initialEmpty = false } = {}) => {
    const observed = await valueOf(input);
    // HMS shows a blank spinner for the verified empty age list when the editor opens.
    const blankZero = initialEmpty && value === 0 && observed.visible === '' &&
      (observed.native === '' || observed.native == null);
    if (!blankZero && (numeric(observed.visible) !== value || numeric(observed.native) !== value)) {
      throw new Error('AGE_EDITOR_READBACK_MISMATCH');
    }
  };
  await exact(count, occupancy.count, { initialEmpty: native.childAges.length === 0 });
  const popupBefore = await snapshotLabtestRecord(frame);
  const popupAge = (index) => popup.getByText(`Age of Child ${index + 1}`, { exact: true })
    .locator('xpath=ancestor::table[contains(@class,"x-form-item")][1]').locator('input:visible');
  const adults = popup.locator('input[name="adults"]');
  const popupAges = [];
  if (await adults.count() !== 1 || await popup.getByText(/^Age of Child \d+$/, { exact: true }).count() !== occupancy.count ||
      !preservedChildBusinessFields(before, popupBefore, READ_CHILD_BUSINESS_FIELDS)) throw new Error('AGE_EDITOR_PREIMAGE_UNVERIFIED');
  await exact(adults, expected.adults);
  for (let i = 0; i < occupancy.count; i++) {
    const input = popupAge(i);
    if (await input.count() !== 1) throw new Error('AGE_EDITOR_PREIMAGE_UNVERIFIED');
    const value = await valueOf(input), age = numeric(value.visible);
    if (age === null || numeric(value.native) !== age) throw new Error('AGE_EDITOR_PREIMAGE_UNVERIFIED');
    popupAges.push(age);
  }
  active();
  if (!sameChildAgeMultiset(popupAges, native.childAges) || !gate.markReadVerified()) {
    throw new Error('AGE_EDITOR_PREIMAGE_UNVERIFIED');
  }
  const toggle = popup.locator('input[name="updatechildcategories"]');
  if (await toggle.count() !== 1) throw new Error('AGE_EDITOR_UNAVAILABLE');
  const checked = await toggle.evaluate((el) => globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''))?.getValue?.());
  if (checked !== false) throw new Error('AGE_EDITOR_TOGGLE_UNVERIFIED');
  active();
  await toggle.click({ timeout: 5000, noWaitAfter: true });
  if (await toggle.evaluate((el) => globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''))?.getValue?.()) !== true) {
    throw new Error('AGE_EDITOR_TOGGLE_UNVERIFIED');
  }
  let countNow = occupancy.count;
  if (countNow === 0 && requested.childCount === 0 && (await valueOf(count)).visible === '') {
    for (const [direction, value] of [['up', 1], ['down', 0]]) {
      active();
      const spinner = count.locator('xpath=ancestor::tr[1]').locator(`.x-spinbox-control.${direction}`);
      if (await spinner.count() !== 1) throw new Error('CHILD_COUNT_UNAVAILABLE');
      await spinner.click({ timeout: 5000, noWaitAfter: true });
      await exact(count, value);
    }
  }
  while (countNow !== requested.childCount) {
    active();
    const direction = countNow < requested.childCount ? 1 : -1;
    const spinner = count.locator('xpath=ancestor::tr[1]').locator(`.x-spinbox-control.${direction > 0 ? 'up' : 'down'}`);
    if (await spinner.count() !== 1) throw new Error('CHILD_COUNT_UNAVAILABLE');
    await spinner.click({ timeout: 5000, noWaitAfter: true });
    countNow += direction;
    await exact(count, countNow);
  }
  for (let index = 0; index < requested.childAges.length; index++) {
    active();
    const label = popup.getByText(`Age of Child ${index + 1}`, { exact: true });
    await label.waitFor({ timeout: Math.min(context.remainingMs(), 20000) });
    const row = label.locator('xpath=ancestor::table[contains(@class,"x-form-item")][1]');
    const input = row.locator('input:visible');
    if (await input.count() !== 1) throw new Error('AGE_EDITOR_UNAVAILABLE');
    active();
    await row.locator('.x-form-arrow-trigger:visible').click({ timeout: 5000, noWaitAfter: true });
    const items = frame.locator('.x-boundlist:visible').last().locator('.x-boundlist-item:visible');
    await items.first().waitFor({ timeout: Math.min(context.remainingMs(), 20000) });
    const matches = await items.evaluateAll((nodes, age) => nodes.flatMap((node, i) =>
      node.textContent.trim() === String(age) ? [i] : []), requested.childAges[index]);
    if (matches.length !== 1) throw new Error('AGE_OPTION_NOT_UNIQUE');
    active();
    await items.nth(matches[0]).click({ timeout: 5000, noWaitAfter: true });
    await exact(input, requested.childAges[index]);
  }
  await exact(count, requested.childCount);
  for (let i = 0; i < requested.childAges.length; i++) await exact(popupAge(i), requested.childAges[i]);
  if (await popup.getByText(/^Age of Child \d+$/, { exact: true }).count() !== requested.childCount ||
      await toggle.evaluate((el) => globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''))?.getValue?.()) !== true ||
      !preservedChildBusinessFields(popupBefore, await snapshotLabtestRecord(frame), READ_CHILD_BUSINESS_FIELDS)) {
    throw new Error('AGE_EDITOR_READBACK_MISMATCH');
  }
  active();
  if (preview) {
    gate.close();
    const cancel = popup.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ });
    if (await cancel.count() !== 1) throw new Error('AGE_EDITOR_CANCEL_UNAVAILABLE');
    active();
    await cancel.click({ timeout: Math.min(context.remainingMs(), 5000), noWaitAfter: true });
    await popup.waitFor({ state: 'hidden', timeout: Math.min(context.remainingMs(), 20000) });
    closed = true;
    const after = await snapshotLabtestRecord(frame);
    active();
    const sorted = (values) => Array.isArray(values) ? [...values].sort() : null;
    const modified = (values) => Array.isArray(values) ? values.filter((name) =>
      !['successmessages', 'activechildcategories'].includes(name)).sort() : null;
    if (!preservedChildBusinessFields(before, after, READ_CHILD_BUSINESS_FIELDS) ||
        before.formDirty !== after.formDirty || !same(sorted(before.dirtyFields), sorted(after.dirtyFields)) ||
        !same(modified(before.modifiedFields), modified(after.modifiedFields)) ||
        !visibleMatches(await visibleChildFields(frame), occupancy)) throw new Error('CHILD_PREVIEW_SIDE_EFFECT_UNVERIFIED');
    active();
    completed = true;
    return { requested: { childCount: requested.childCount, childAges: [...requested.childAges] },
      before: { ages: [...native.childAges], bands: { ...occupancy.bands } } };
  }
  const apply = popup.locator('a.x-btn:visible').filter({ hasText: /^\s*Apply\s*$/ });
  if (await apply.count() !== 1 || !gate.armValidation()) throw new Error('AGE_APPLY_UNVERIFIED');
  const validated = page.waitForResponse((response) => gate.isValidationRequest(response.request()),
    { timeout: Math.min(context.remainingMs(), 20000) });
  active();
  await apply.click({ timeout: 5000, noWaitAfter: true });
  const response = await validated, result = await response.json();
  active();
  if (!response.ok() || result?.propertyCode !== 'HRCEN' || result?.reservationStayId !== expected.reservationStayId ||
      numeric(result.adultCount) !== expected.adults || numeric(result.childCount) !== requested.childCount ||
      result.activeChildCategories !== 3 || result.updateChildCategories !== true || result.confirmChildCategory !== false ||
      !sameChildAgeMultiset(result.childAges, requested.childAges)) throw new Error('AGE_VALIDATION_RESPONSE_UNVERIFIED');
  await popup.waitFor({ state: 'hidden', timeout: Math.min(context.remainingMs(), 20000) });
  const synced = await frame.evaluate(() => {
    const nodes = [...document.querySelectorAll('input[name="guestid"]')].filter((el) =>
      (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const panel = nodes.length === 1 ? globalThis.Ext?.getCmp?.(nodes[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
    const record = panel?.getRecord?.();
    if (!record || typeof panel.updateRecord !== 'function') return false;
    panel.updateRecord(record);
    return true;
  });
  active();
  if (!synced) throw new Error('CHILD_DRAFT_UNVERIFIED');
  const after = await snapshotLabtestRecord(frame), observed = savedChildOccupancy(after);
  // A blank model is only accepted for zero when the correlated validation
  // response itself supplied the explicit empty age list.
  const validatedEmpty = requested.childCount === 0 && same(result.childAges, []) &&
    observed.fields?.childages?.model?.present && observed.fields.childages.model.value === '';
  if (!observed.valid || observed.count !== requested.childCount ||
      !(sameChildAgeMultiset(observed.ages, requested.childAges) || (observed.ages === null && validatedEmpty)) ||
      !currentChildCategories(after, requested.childAges, observed.bands)) {
    throw new Error('CHILD_DRAFT_UNVERIFIED');
  }
  const nativeCounts = result.childCategoryCounts ?? (validatedEmpty ? {} : null);
  if (!nativeCounts || typeof nativeCounts !== 'object' || Array.isArray(nativeCounts) ||
      NAMES.slice(1).some((name) => {
        const keys = Object.keys(nativeCounts).filter((key) => key.toLowerCase() === name);
        return keys.length > 1 || numeric(keys.length ? nativeCounts[keys[0]] : 0) !== observed.bands[name];
      })) throw new Error('CHILD_DRAFT_UNVERIFIED');
  if (!preservedChildBusinessFields(popupBefore, after, PRESERVED_CHILD_BUSINESS_FIELDS)) {
    throw new Error('CHILD_DRAFT_SIDE_EFFECT_UNVERIFIED');
  }
  return after;
  } finally {
    if (preview) {
      gate?.close();
      if (!closed && context?.isActive?.() && context.remainingMs() > 0) {
        try {
          popup ??= frame.locator('.x-window[id^="childagespopup"]:visible');
          const cancel = popup.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ });
          if (await popup.count() === 1 && await cancel.count() === 1 && context.isActive() && context.remainingMs() > 0) {
            await cancel.click({ timeout: Math.min(context.remainingMs(), 5000), noWaitAfter: true });
            await popup.waitFor({ state: 'hidden', timeout: Math.min(context.remainingMs(), 5000) });
          }
        } catch { /* The owning context is stopped below. */ }
      }
      if (!completed) context?.stop?.('CHILD_PREVIEW_INCOMPLETE');
    }
  }
}
