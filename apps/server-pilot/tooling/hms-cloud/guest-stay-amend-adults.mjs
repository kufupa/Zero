// Stage one saved-Labtest adult-count change; do not Save until native re-rate is verified.
import { createHash } from 'node:crypto';
import {
  cleanLabtestRecord,
  currentLabtestRecord,
  snapshotLabtestRecord,
  unchangedLabtestBusinessParties,
  unchangedLabtestRecord,
} from './labtest-record.mjs';
import { runLabtestAmendSave } from './labtest-amend-save.mjs';

const MAX_ADULTS = 16;
const EFFECT_KIND = Object.freeze({
  averagenightly: 'pricing', averagerate: 'pricing', enhancedexptotal: 'pricing', grandtotal: 'pricing',
  guesttax: 'tax', guesttotal: 'pricing', guesttotalresortfee: 'pricing', guesttotalwithtax: 'pricing',
  ratetax: 'tax', tax: 'tax', total: 'pricing', totalcomptaxamount: 'tax', totalguestcomptaxamount: 'tax',
  totalrate: 'pricing', totalratewithtax: 'pricing', totalresortfee: 'pricing',
  nightsvalue: 'lifetime', revenuevalue: 'lifetime', enablecheckavailability: 'availability',
});
const FORM_AMOUNT_FIELDS = new Set([
  'averagenightly', 'averagerate', 'enhancedexptotal', 'grandtotal', 'guesttax', 'guesttotal',
  'guesttotalwithtax', 'tax', 'total', 'totalrate', 'totalratewithtax', 'totalresortfee',
]);
const TRANSIENT_FIELDS = new Set(['bookingsessionid', 'sessionid', 'extid']);
const isAdultCount = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_ADULTS;

function field(snapshot, part, name) {
  const source = snapshot?.[part];
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const keys = Object.keys(source).filter((key) => key.toLowerCase() === name.toLowerCase());
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== name)) return null;
  return keys.length ? { present: true, value: source[name] } : { present: false };
}

function adultValue(snapshot) {
  const form = field(snapshot, 'values', 'adults');
  const model = field(snapshot, 'data', 'adults');
  if (form?.present !== true || model?.present !== true || String(form.value ?? '') !== String(model.value ?? '')) {
    return null;
  }
  return String(form.value ?? '');
}

function same(left, right) {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
  } catch { return false; }
}

// Reject representations that JSON would silently change or omit. These digests
// identify diagnostic snapshots only; they are not human approval or save authority.
function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('UNSUPPORTED_SNAPSHOT');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error('UNSUPPORTED_SNAPSHOT');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length || value.some((_, i) => !Object.hasOwn(value, i))) {
        throw new Error('UNSUPPORTED_SNAPSHOT');
      }
      return value.map((item) => canonical(item, ancestors));
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], ancestors)]));
  } finally { ancestors.delete(value); }
}

function snapshotDigest(snapshot) {
  if (!snapshot?.data || typeof snapshot.data !== 'object' || Array.isArray(snapshot.data) ||
      !snapshot.values || typeof snapshot.values !== 'object' || Array.isArray(snapshot.values) ||
      !Array.isArray(snapshot.partyControls) || !snapshot.partyControls.every((item) => typeof item?.name === 'string')) {
    return null;
  }
  const stable = (source) => Object.fromEntries(Object.keys(source)
    .filter((key) => !TRANSIENT_FIELDS.has(key.toLowerCase()))
    .sort()
    .map((key) => [key, source[key]]));
  const partyControls = snapshot.partyControls.slice().sort((a, b) => a.name.localeCompare(b.name));
  const state = { data: stable(snapshot.data), values: stable(snapshot.values), partyControls };
  try { return createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex'); }
  catch { return null; }
}

function normalizedAmount(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    value = String(value);
  }
  if (typeof value !== 'string' || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) return null;
  const [whole = '', fraction = ''] = value.replaceAll(',', '').split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const decimals = fraction.replace(/0+$/, '');
  return decimals ? integer + '.' + decimals : integer;
}

function matchesObservedEffect(before, after, name) {
  const kind = Object.hasOwn(EFFECT_KIND, name) ? EFFECT_KIND[name] : null;
  const oldModel = field(before, 'data', name), newModel = field(after, 'data', name);
  const oldForm = field(before, 'values', name), newForm = field(after, 'values', name);
  if (kind === 'lifetime') {
    const formStart = name === 'nightsvalue' ? '0' : '0.00';
    return oldModel?.present === true && newModel?.present === true && oldModel.value === '0' &&
      (same(oldModel.value, newModel.value) || newModel.value === '') &&
      oldForm?.present === true && newForm?.present === true && oldForm.value === formStart && newForm.value === '';
  }
  if (kind === 'availability') {
    return oldModel?.present === true && newModel?.present === true && oldModel.value === '0' &&
      newModel.value === '-1' && oldForm?.present === false && newForm?.present === false;
  }
  if ((kind !== 'pricing' && kind !== 'tax') || oldModel?.present !== true || newModel?.present !== true) return false;
  if (!FORM_AMOUNT_FIELDS.has(name)) {
    return oldForm?.present === false && newForm?.present === false && oldModel.value === '0' && newModel.value === '';
  }
  // The saved-stay form can clear its model as well as its displayed amounts.
  return oldForm?.present === true && newForm?.present === true &&
    (same(oldModel.value, newModel.value) || newModel.value === '') &&
    newForm.value === '' && normalizedAmount(oldForm.value) !== null &&
    normalizedAmount(oldForm.value) === normalizedAmount(oldModel.value);
}

function summarizeEffect(before, after, name) {
  const oldModel = field(before, 'data', name), newModel = field(after, 'data', name);
  const oldForm = field(before, 'values', name), newForm = field(after, 'values', name);
  return {
    field: name,
    kind: EFFECT_KIND[name],
    ...(oldModel?.present && newModel?.present ? { beforeModel: oldModel.value, afterModel: newModel.value } : {}),
    ...(oldForm?.present && newForm?.present ? { beforeForm: oldForm.value, afterForm: newForm.value } : {}),
  };
}

function wireDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const [year, month, day] = value.split('-');
  return month + '/' + day + '/' + year;
}

function previewTargetMatches(expected, snapshot) {
  const required = {
    propertycode: 'HRCEN', status: 'Reserved', firstname: 'Proof', lastname: 'Labtest',
    confirmationnumber: expected?.confirmation, guestid: expected?.guestId,
    arrivaldate: wireDate(expected?.arrival), departuredate: wireDate(expected?.departure),
    roomtype: expected?.roomType, rateplan: expected?.ratePlan, reservationnote: expected?.note,
  };
  return Object.values(required).every((value) => typeof value === 'string') &&
    Object.entries(required).every(([name, value]) => {
      const actual = field(snapshot, 'data', name);
      return actual?.present === true && actual.value != null && String(actual.value) === value;
    });
}

/** Classify the prior unsaved probe's 19-field delta; recheck it after the combo-aware adult update. */
export function labtestAdultAmendDraftDelta(before, after, adults) {
  const invalid = (changedFields = ['snapshot']) => ({
    ok: false, requiresAvailabilityCheck: true, changedFields, unapprovedFields: ['snapshot'],
    bodyChanges: {}, nativeSideEffects: [],
  });
  if (!isAdultCount(adults) || !before || !after || !before.values || !before.data || !after.values || !after.data ||
      before.formDirty !== false || before.recordDirty !== false || !Array.isArray(before.dirtyFields) ||
      before.dirtyFields.length || !Array.isArray(before.modifiedFields) || before.modifiedFields.length ||
      after.formDirty !== true || after.recordDirty !== true || !Array.isArray(after.dirtyFields) ||
      !after.dirtyFields.length || !Array.isArray(after.modifiedFields) || !after.modifiedFields.length) return invalid();

  const oldAdults = adultValue(before), newAdults = adultValue(after);
  if (!isAdultCount(Number(oldAdults)) || String(Number(oldAdults)) !== oldAdults || oldAdults === String(adults) ||
      newAdults !== String(adults) || !after.dirtyFields.includes('adults') || !after.modifiedFields.includes('adults')) {
    return { ...invalid(['adults']), unapprovedFields: ['adults'] };
  }

  const changed = new Set();
  for (const part of ['values', 'data']) {
    const oldPart = before[part], newPart = after[part];
    for (const key of new Set([...Object.keys(oldPart), ...Object.keys(newPart)])) {
      if (!Object.hasOwn(oldPart, key) || !Object.hasOwn(newPart, key) || !same(oldPart[key], newPart[key])) changed.add(key);
    }
  }
  for (const name of [...after.dirtyFields, ...after.modifiedFields]) {
    if (typeof name !== 'string' || !name) return invalid();
    changed.add(name);
  }
  const changedFields = [...changed].sort();
  const approved = changedFields.filter((name) => name === 'adults' || matchesObservedEffect(before, after, name));
  const unapprovedFields = changedFields.filter((name) => !approved.includes(name));
  const formChanges = approved.filter((name) => {
    const oldForm = field(before, 'values', name), newForm = field(after, 'values', name);
    return newForm?.present === true && (oldForm?.present !== true || !same(oldForm.value, newForm.value));
  });
  const bodyChanges = Object.fromEntries(formChanges.map((name) => [name, String(after.values[name] ?? '')]));
  const allowedChanges = Object.fromEntries(approved.map((name) => [name,
    String(formChanges.includes(name) ? after.values[name] ?? '' : after.data[name] ?? ''),
  ]));
  if (!unchangedLabtestRecord(before, after, allowedChanges)) unapprovedFields.push('snapshot');
  unapprovedFields.sort();
  const nativeSideEffects = approved.filter((name) => name !== 'adults').map((name) => summarizeEffect(before, after, name));
  return {
    ok: unapprovedFields.length === 0,
    requiresAvailabilityCheck: true,
    changedFields,
    unapprovedFields,
    bodyChanges,
    nativeSideEffects,
  };
}

/** Bind the review preview to the fake stay, whole preimage, staged state and native effects. */
export function labtestAdultAmendPreview(expected, adults, before, after, delta) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || !isAdultCount(adults) ||
      !isAdultCount(expected.adults) || adults === expected.adults || adultValue(before) !== String(expected.adults) ||
      !delta?.ok || delta.requiresAvailabilityCheck !== true ||
      !Array.isArray(delta.changedFields) || !delta.bodyChanges || !Array.isArray(delta.nativeSideEffects) ||
      !previewTargetMatches(expected, before) || !same(delta, labtestAdultAmendDraftDelta(before, after, adults))) return null;
  const baselineDigest = snapshotDigest(before), stagedDigest = snapshotDigest(after);
  if (!baselineDigest || !stagedDigest) return null;
  return {
    field: 'adults',
    target: {
      propertyCode: 'HRCEN', status: 'Reserved', confirmation: expected.confirmation, guestId: expected.guestId,
      arrival: expected.arrival, departure: expected.departure, roomType: expected.roomType,
      ratePlan: expected.ratePlan, note: expected.note,
    },
    from: expected.adults,
    to: adults,
    baselineDigest,
    stagedDigest,
    changedFields: delta.changedFields,
    bodyChanges: delta.bodyChanges,
    nativeSideEffects: delta.nativeSideEffects,
    // Raw native fields remain absent, null, blank or valued; none implies a child count.
    childOccupancy: Object.fromEntries(['children', 'childages', 'child1', 'child2', 'child3'].map((name) => [name, {
      model: field(before, 'data', name), form: field(before, 'values', name),
    }])),
    pricing: { state: 'not_repriced', inventory: 'not_verified', tax: 'not_repriced' },
    approval: { ready: false, trustedHumanApproval: 'not_established' },
    nextStep: 'availability_reprice_not_verified',
    saveEligible: false,
  };
}

export function matchesLabtestAdultAmendPreview(preview, expected, adults, before, after, delta) {
  const current = labtestAdultAmendPreview(expected, adults, before, after, delta);
  return Boolean(current && same(preview, current));
}

async function selectAdultOption(frame, baseline, requested, commit, assertActive, deadlineAt) {
  assertActive();
  const input = frame.locator('input[name="adults"]:visible');
  if (await input.count() !== 1) throw new Error('AMEND_CONTROL_NOT_UNIQUE');
  // The shared lifecycle can time out while the locator count is pending.
  assertActive();
  const outcome = await input.evaluate((element, { beforeAdult, adults, commitChange, preimage, deadline }) => {
    const component = globalThis.Ext?.getCmp?.(element.id?.replace(/-inputEl$/, ''));
    const guestInputs = [...document.querySelectorAll('input[name="guestid"]')].filter((item) =>
      Boolean((item.offsetWidth || item.offsetHeight) && getComputedStyle(item).visibility !== 'hidden'));
    const form = guestInputs.length === 1 && guestInputs[0].id
      ? globalThis.Ext?.getCmp?.(guestInputs[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
    const store = component?.store, valueField = component?.valueField || 'value';
    const displayField = component?.displayField || 'display';
    if (!form?.el?.dom || form !== component?.up?.('form') || !form.el.dom.contains(element) ||
        !component?.setValue || !component?.getValue || !component?.fireEvent) return 'ADULT_PREIMAGE_UNVERIFIED';
    const disabled = typeof component?.isDisabled === 'function' ? component.isDisabled() : component?.disabled === true;
    if (element.disabled || element.readOnly || disabled || component?.readOnly === true) return 'ADULT_FIELD_UNSUPPORTED';
    if (!store || typeof store.getCount !== 'function' || typeof store.getAt !== 'function' || !store.getCount()) {
      return 'ADULT_OPTIONS_NOT_LOADED';
    }
    const read = (record, key) => typeof record?.get === 'function'
      ? record.get(key) : record?.data?.[key] ?? record?.[key];
    const options = Array.from({ length: store.getCount() }, (_, index) => {
      const record = store.getAt(index);
      return { record, value: String(read(record, valueField) ?? ''), label: String(read(record, displayField) ?? '') };
    });
    const raw = component.getValue();
    const selected = raw && typeof raw === 'object' ? read(raw, valueField) : raw;
    const previous = options.filter((option) => option.value === String(beforeAdult));
    if (String(selected ?? '') !== String(beforeAdult) || previous.length !== 1 || previous[0].label !== element.value) {
      return 'ADULT_PREIMAGE_UNVERIFIED';
    }
    const targets = options.filter((option) => option.value === String(adults));
    if (!targets.length) return 'ADULT_OPTION_UNAVAILABLE';
    if (targets.length !== 1 || !targets[0].label) return 'ADULT_OPTION_NOT_UNIQUE';
    const target = targets[0];
    const record = form.getRecord?.();
    if (!record || typeof form.updateRecord !== 'function' || typeof record.set !== 'function') return 'ADULT_EDIT_UNVERIFIED';
    // updateRecord copies the form into the native model. Recheck both complete
    // preimages in this same browser turn, immediately before any mutation.
    const equal = (a, b, ancestors = new Set()) => {
      if (Object.is(a, b)) return true;
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object' ||
          Array.isArray(a) !== Array.isArray(b) || ancestors.has(a)) return false;
      const tag = Object.prototype.toString.call(a);
      if (tag !== Object.prototype.toString.call(b) || !['[object Object]', '[object Array]'].includes(tag) ||
          (Array.isArray(a) && a.length !== b.length)) return false;
      const keys = Object.keys(a), otherKeys = Object.keys(b);
      if (keys.length !== otherKeys.length || keys.some((key) => !Object.hasOwn(b, key))) return false;
      ancestors.add(a);
      try { return keys.every((key) => equal(a[key], b[key], ancestors)); }
      finally { ancestors.delete(a); }
    };
    const nativeForm = form.getForm?.();
    if (record.dirty !== false || Object.keys(record.modified || {}).length ||
        typeof nativeForm?.isDirty !== 'function' || nativeForm.isDirty() ||
        !equal(record.data, preimage.data) || !equal(nativeForm.getValues?.(), preimage.values)) {
      return 'ADULT_PREIMAGE_UNVERIFIED';
    }
    if (!commitChange) return true;
    // A queued browser evaluation may run after the caller's timeout.
    if (Date.now() >= deadline) return 'AMEND_TIMEOUT';
    component.setValue(target.record);
    component.fireEvent('select', component, target.record);
    form.updateRecord(record);
    record.set('adults', read(target.record, valueField));
    component.fireEvent('blur', component);
    element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    const value = component.getValue();
    const actual = value && typeof value === 'object' ? read(value, valueField) : value;
    return String(actual ?? '') === String(adults) && element.value === target.label ? true : 'ADULT_EDIT_UNVERIFIED';
  }, { beforeAdult: adultValue(baseline), adults: requested, commitChange: commit,
    preimage: { data: baseline.data, values: baseline.values }, deadline: deadlineAt });
  if (outcome !== true) throw new Error(typeof outcome === 'string' ? outcome : 'ADULT_EDIT_UNVERIFIED');
  return input;
}

/**
 * Stage and report the observed adult-count invalidation only. Check Availability must re-rate
 * this saved stay before Save; until its guarded request and readback are verified, this call never Saves.
 */
export async function stageLabtestAdultAmendment(page, expected = {}, options = {}) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
      Object.keys(expected).some((key) => !['confirmation', 'guestId', 'arrival', 'departure', 'roomType', 'ratePlan', 'note', 'adults'].includes(key))) {
    return { outcome: 'input_gap', issue: 'UNSUPPORTED_EXPECTED_FIELD' };
  }
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['adults', 'timeoutMs'].includes(key))) {
    return { outcome: 'input_gap', issue: 'UNSUPPORTED_AMEND_OPTION' };
  }
  const { adults, timeoutMs = 20_000 } = options;
  if (!isAdultCount(expected?.adults)) return { outcome: 'input_gap', issue: 'ADULT_PREIMAGE_REQUIRED' };
  if (!isAdultCount(adults)) return { outcome: 'input_gap', issue: 'ADULT_COUNT_INVALID' };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return { outcome: 'input_gap', issue: 'INVALID_TIMEOUT' };
  let active = true;
  const deadlineAt = Date.now() + timeoutMs;
  const assertActive = () => {
    if (!active || Date.now() >= deadlineAt) throw new Error('AMEND_TIMEOUT');
  };
  const onDialog = () => { active = false; };
  if (typeof page?.on === 'function') page.on('dialog', onDialog);
  try {
    return await runLabtestAmendSave(page, {
    timeoutMs,
    resultFields: { field: 'adults', adults },
    reportBlockedTargets: true,
    prepareOnly: true,
    prepare: async (bounded) => {
      const state = await bounded(currentLabtestRecord(page, expected, {
        allowBlankNote: true, allowUnchangedBusinessParties: true,
      }));
      const baseline = await bounded(snapshotLabtestRecord(state.frame));
      if (!cleanLabtestRecord(baseline)) throw new Error('RECORD_HAS_DIRTY_FIELDS');
      if (!unchangedLabtestBusinessParties(state.partyPreimage, baseline)) throw new Error('LABTEST_LINKED_PARTY_UNVERIFIED');
      if (adultValue(baseline) !== String(expected.adults) || !previewTargetMatches(expected, baseline) ||
          !snapshotDigest(baseline)) throw new Error('ADULT_PREIMAGE_UNVERIFIED');
      if (adults === expected.adults) return { unchanged: true };
      if (await bounded(page.locator('.x-window:visible:not(.x-menu)').count()) !== 1 ||
          await bounded(state.frame.locator('.x-window:visible:not(.x-menu)').count())) throw new Error('UNEXPECTED_DIALOG');
      const control = await bounded(selectAdultOption(state.frame, baseline, adults, false, assertActive, deadlineAt));
      const save = state.frame.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
      if (await bounded(save.count()) !== 1) throw new Error('AMEND_CONTROL_NOT_UNIQUE');
      return { state, frame: state.frame, baseline, control, save };
    },
    // No Save request is authorized until the native availability recalculation is verified.
    matches: () => false,
    stage: async (bounded, prepared) => {
      await bounded(prepared.control.scrollIntoViewIfNeeded().catch(() => {}));
      await bounded(selectAdultOption(prepared.frame, prepared.baseline, adults, true, assertActive, deadlineAt));
      const current = await bounded(currentLabtestRecord(page, expected, {
        allowBlankNote: true, allowUnchangedBusinessParties: true,
      }));
      const snapshot = await bounded(snapshotLabtestRecord(prepared.frame));
      const delta = labtestAdultAmendDraftDelta(prepared.baseline, snapshot, adults);
      const candidatePreview = labtestAdultAmendPreview(expected, adults, prepared.baseline, snapshot, delta);
      return { current, snapshot, delta, candidatePreview, preview: null };
    },
    validate: async (bounded, prepared, staged) => {
      const stableRecord = same(prepared.state.native, staged.current.native) &&
        prepared.state.track === staged.current.track &&
        same(prepared.state.partyPreimage, staged.current.partyPreimage) &&
        unchangedLabtestBusinessParties(prepared.state.partyPreimage, staged.snapshot) &&
        staged.delta.ok && await bounded(prepared.frame.locator('.x-window:visible:not(.x-menu)').count()) === 0;
      if (stableRecord) staged.preview = staged.candidatePreview;
      return { ok: false, issue: staged.preview ? 'OCCUPANCY_REPRICE_REQUIRED' : 'AMEND_DRAFT_CHANGED' };
    },
    stageDetails: (staged) => staged?.delta ? {
      changedFields: staged.delta.changedFields,
      unapprovedFields: staged.delta.unapprovedFields,
      nativeSideEffects: staged.delta.nativeSideEffects,
      availabilityRepriceRequired: true,
      saveEligible: false,
      preview: staged.preview,
    } : {},
    });
  } finally {
    active = false;
    if (typeof page?.off === 'function') page.off('dialog', onDialog);
  }
}
