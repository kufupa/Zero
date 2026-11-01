// Unsaved, fenced experiments on one verified HRCEN Proof Labtest saved stay.
import {
  cleanLabtestRecord,
  currentLabtestRecord,
  snapshotLabtestRecord,
  unchangedLabtestBusinessParties,
} from './labtest-record.mjs';
import { runLabtestAmendSave } from './labtest-amend-save.mjs';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const SPECS = Object.freeze({
  arrival: { name: 'arrivaldate', type: 'date' },
  departure: { name: 'departuredate', type: 'date' },
  roomType: { name: 'roomtype', type: 'option', id: 'roomtypeid', code: 'roomtypecode' },
  ratePlan: { name: 'rateplan', type: 'option', id: 'rateplanid', code: 'rateplancode' },
});
const PRICE_FIELDS = Object.freeze({
  averagenightly: 'price', averagerate: 'price', enhancedexptotal: 'price', grandtotal: 'price',
  guesttotal: 'price', guesttotalresortfee: 'price', guesttotalwithtax: 'price', total: 'price',
  totalrate: 'price', totalratewithtax: 'price', totalresortfee: 'price',
  guesttax: 'tax', ratetax: 'tax', tax: 'tax', totalcomptaxamount: 'tax', totalguestcomptaxamount: 'tax',
});
const IDENTITY_FIELDS = ['propertycode', 'confirmationnumber', 'guestid', 'status', 'firstname', 'lastname',
  'PKID', 'bookingsessionid', 'reservationid', 'reservationstayid', 'recordid', 'guaranteetype',
  'udfchkbox04', 'udfchar13', 'emailaddress', 'reservationnote'];
const ownObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function dateParts(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  return { display: `${value.slice(8, 10)}-${MONTHS[parsed.getUTCMonth()]}-${value.slice(0, 4)}`,
    wire: `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}` };
}

function field(snapshot, part, name) {
  const source = snapshot?.[part];
  if (!ownObject(source)) return { state: 'unavailable' };
  const keys = Object.keys(source).filter((key) => key.toLowerCase() === name.toLowerCase());
  if (!keys.length) return { state: 'absent' };
  if (keys.length !== 1 || keys[0] !== name) return { state: 'ambiguous' };
  const value = source[name];
  if (value === null || value === undefined) return { state: 'null' };
  if (!['string', 'number', 'boolean'].includes(typeof value)) return { state: 'unavailable' };
  return value === '' ? { state: 'blank', value } : { state: 'value', value };
}

function changedNames(before, after) {
  const names = new Set();
  for (const part of ['values', 'data']) {
    if (!ownObject(before?.[part]) || !ownObject(after?.[part])) return null;
    const a = before[part], b = after[part];
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!Object.hasOwn(a, name) || !Object.hasOwn(b, name) || !equal(a[name], b[name])) names.add(name);
    }
  }
  return [...names].sort();
}

/** Diagnostic only: preserves missing, blank and mismatched native/form values without calculating prices. */
export function summarizeSavedStayAmendment(before, after, fieldName, requested) {
  const spec = SPECS[fieldName];
  const changedFields = changedNames(before, after);
  if (!spec || !changedFields || typeof requested !== 'string') return null;
  const prices = [];
  for (const [name, kind] of Object.entries(PRICE_FIELDS)) {
    for (const part of ['values', 'data']) {
      const previous = field(before, part, name), current = field(after, part, name);
      const changed = !equal(previous, current);
      prices.push({ field: name, source: part === 'values' ? 'form' : 'model', kind,
        before: previous, after: current,
        change: !changed ? 'unchanged' : current.state === 'blank' && previous.state === 'value' ? 'cleared' : 'changed' });
    }
  }
  const actualForm = field(after, 'values', spec.name), actualModel = field(after, 'data', spec.name);
  const display = spec.type === 'date' ? dateParts(requested)?.display : requested;
  const wire = spec.type === 'date' ? dateParts(requested)?.wire : requested;
  return {
    requested: { field: fieldName, value: requested },
    observed: { beforeForm: field(before, 'values', spec.name), beforeModel: field(before, 'data', spec.name),
      form: actualForm, model: actualModel,
      formMatchesRequested: actualForm.state === 'value' && String(actualForm.value) === display,
      modelMatchesRequested: actualModel.state === 'value' && String(actualModel.value) === wire,
      ...(spec.id ? { nativeId: field(after, 'data', spec.id) } : {}) },
    changedFields,
    dirtyState: { formDirty: after.formDirty ?? null, recordDirty: after.recordDirty ?? null,
      dirtyFields: Array.isArray(after.dirtyFields) ? [...after.dirtyFields] : null,
      modifiedFields: Array.isArray(after.modifiedFields) ? [...after.modifiedFields] : null },
    relatedFields: Object.fromEntries(['arrivaldate', 'departuredate', 'nights', 'arrivaldayofweek',
      'departuredayofweek', 'roomtype', 'roomtypeid', 'rateplan', 'rateplanid', 'mealplan',
      'marketsegment', 'track', 'enablecheckavailability'].map((name) => [name, {
      beforeForm: field(before, 'values', name), afterForm: field(after, 'values', name),
      beforeModel: field(before, 'data', name), afterModel: field(after, 'data', name),
    }])),
    pricingFields: prices,
    pricing: { repricing: 'not_verified', tax: 'not_verified', inventory: 'not_verified', quote: 'not_produced' },
    saveEligible: false,
  };
}

// Both date and room/rate preimages must agree across the saved form and model.
function matchesStayPreimage(snapshot, expected) {
  return Object.entries(SPECS).every(([name, spec]) => {
    const current = expected[name];
    const parsed = spec.type === 'date' ? dateParts(current) : null;
    if (typeof current !== 'string' || (spec.type === 'date' && !parsed)) return false;
    const form = field(snapshot, 'values', spec.name), model = field(snapshot, 'data', spec.name);
    return form.state === 'value' && model.state === 'value' &&
      String(form.value) === (parsed ? parsed.display : current) &&
      String(model.value) === (parsed ? parsed.wire : current);
  });
}

function unchangedOtherStayInputs(before, after, spec) {
  return ['arrivaldate', 'departuredate', 'roomtype', 'roomtypeid', 'rateplan', 'rateplanid']
    .filter((name) => name !== spec.name)
    .every((name) => ['values', 'data'].every((part) => equal(field(before, part, name), field(after, part, name))));
}

function stableIdentity(before, after, partyPreimage) {
  if (!ownObject(before?.values) || !ownObject(after?.values) || !ownObject(before?.data) || !ownObject(after?.data) ||
      !Array.isArray(after?.dirtyFields) || !Array.isArray(after?.modifiedFields) ||
      !unchangedLabtestBusinessParties(partyPreimage, after)) return false;
  return IDENTITY_FIELDS.every((name) => {
    const a = field(before, 'data', name), b = field(after, 'data', name);
    const x = field(before, 'values', name), y = field(after, 'values', name);
    return !['absent', 'ambiguous', 'unavailable'].includes(a.state) && equal(a, b) &&
      !['ambiguous', 'unavailable'].includes(x.state) && equal(x, y);
  });
}

async function checkedControl(frame, baseline, spec, expected) {
  const input = frame.locator(`input[name="${spec.name}"]:visible`);
  if (await input.count() !== 1) throw new Error('AMEND_CONTROL_NOT_UNIQUE');
  const result = await input.evaluate((element, { name, expectedDisplay }) => {
    const component = globalThis.Ext?.getCmp?.(element.id?.replace(/-inputEl$/, ''));
    const guests = [...document.querySelectorAll('input[name="guestid"]')].filter((item) =>
      Boolean((item.offsetWidth || item.offsetHeight) && getComputedStyle(item).visibility !== 'hidden' && !item.closest('.x-window')));
    const form = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id?.replace(/-inputEl$/, ''))?.up?.('form') : null;
    if (!form?.el?.dom || !form.el.dom.contains(element) || component?.up?.('form') !== form ||
        typeof component?.getValue !== 'function' || element.name !== name || element.value !== expectedDisplay) return 'AMEND_PREIMAGE_UNVERIFIED';
    if (element.disabled || element.readOnly || component.readOnly === true ||
        (typeof component.isDisabled === 'function' ? component.isDisabled() : component.disabled === true)) return 'AMEND_FIELD_UNSUPPORTED';
    return true;
  }, { name: spec.name, expectedDisplay: expected });
  if (result !== true) throw new Error(result);
  const formValue = field(baseline, 'values', spec.name);
  if (formValue.state !== 'value' || String(formValue.value) !== expected) throw new Error('AMEND_PREIMAGE_UNVERIFIED');
  return input;
}

// Ext's date field and its model-data contribution are independent of the
// record bound to the form, which can remain unchanged until synchronization.
async function nativeDateObservation(input, name) {
  return input.evaluate((element, fieldName) => {
    const component = globalThis.Ext?.getCmp?.(element.id?.replace(/-inputEl$/, ''));
    const guests = [...document.querySelectorAll('input[name="guestid"]')].filter((item) =>
      Boolean((item.offsetWidth || item.offsetHeight) && getComputedStyle(item).visibility !== 'hidden' && !item.closest('.x-window')));
    const form = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id?.replace(/-inputEl$/, ''))?.up?.('form') : null;
    if (!form?.el?.dom || !form.el.dom.contains(element) || component?.up?.('form') !== form ||
        element.name !== fieldName || typeof component?.getValue !== 'function' ||
        typeof component?.getModelData !== 'function') return null;
    const day = (date) => date instanceof Date && !Number.isNaN(date.getTime())
      ? `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : null;
    const modelData = component.getModelData();
    if (!modelData || Object.keys(modelData).length !== 1 || !Object.hasOwn(modelData, fieldName)) return null;
    return { componentDate: day(component.getValue()), formModelDate: day(modelData[fieldName]) };
  }, name);
}

// A saved-form combo is usable only if its own loaded records contain a unique exact ID/code.
// Neither the presence of the store nor selection on this saved form has live proof yet.
async function selectSavedOption(input, spec, current, target, nativeId, commit) {
  const result = await input.evaluate((element, { spec, current, target, nativeId, commit }) => {
    const c = globalThis.Ext?.getCmp?.(element.id?.replace(/-inputEl$/, ''));
    const guests = [...document.querySelectorAll('input[name="guestid"]')].filter((item) =>
      Boolean((item.offsetWidth || item.offsetHeight) && getComputedStyle(item).visibility !== 'hidden' && !item.closest('.x-window')));
    const form = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id?.replace(/-inputEl$/, ''))?.up?.('form') : null;
    if (!form?.el?.dom || !form.el.dom.contains(element) || c?.up?.('form') !== form) return 'AMEND_PREIMAGE_UNVERIFIED';
    const store = c?.store;
    if (!c?.setValue || !c?.getValue || !c?.fireEvent || !store?.getCount || !store?.getAt ||
        typeof store.isLoading !== 'function' || store.isLoading() !== false) return 'SAVED_OPTIONS_UNAVAILABLE';
    const read = (record, key) => typeof record?.get === 'function' ? record.get(key) : record?.data?.[key];
    const options = Array.from({ length: store.getCount() }, (_, index) => store.getAt(index));
    const raw = c.getValue();
    const selected = raw && typeof raw === 'object' ? read(raw, c.valueField || 'value') : raw;
    if (String(selected ?? '') !== current) return 'AMEND_PREIMAGE_UNVERIFIED';
    const matching = options.filter((record) => String(read(record, spec.code) ?? '') === target &&
      String(read(record, spec.id) ?? '') === nativeId);
    if (matching.length !== 1) return matching.length ? 'SAVED_OPTION_AMBIGUOUS' : 'SAVED_OPTION_UNAVAILABLE';
    if (element.value !== current || element.disabled || element.readOnly || c.readOnly === true ||
        (typeof c.isDisabled === 'function' ? c.isDisabled() : c.disabled === true)) return 'AMEND_PREIMAGE_UNVERIFIED';
    if (!commit) return true;
    c.setValue(matching[0]);
    c.fireEvent('select', c, matching[0]);
    c.fireEvent('blur', c);
    element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    return true;
  }, { spec, current, target, nativeId, commit });
  if (result !== true) throw new Error(result);
}

/** Read only the currently loaded options of this saved form's own component. */
export async function inspectLabtestSavedRoomRateOptions(page, expected = {}, options = {}) {
  if (!ownObject(expected) || Object.keys(expected).some((key) =>
    !['confirmation', 'guestId', 'arrival', 'departure', 'roomType', 'ratePlan', 'note'].includes(key)) ||
      !ownObject(options) || Object.keys(options).some((key) => !['field', 'offset', 'limit'].includes(key)) ||
      !['roomType', 'ratePlan'].includes(options.field)) return { outcome: 'input_gap', issue: 'AMEND_FIELD_UNSUPPORTED' };
  const { field: fieldName, offset = 0, limit = 50 } = options;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { outcome: 'input_gap', issue: 'OPTION_PAGE_INVALID' };
  }
  try {
    const spec = SPECS[fieldName];
    const state = await currentLabtestRecord(page, expected, { allowBlankNote: true, allowUnchangedBusinessParties: true });
    const baseline = await snapshotLabtestRecord(state.frame);
    if (!cleanLabtestRecord(baseline)) throw new Error('RECORD_HAS_DIRTY_FIELDS');
    if (!matchesStayPreimage(baseline, expected)) throw new Error('AMEND_PREIMAGE_UNVERIFIED');
    if (!unchangedLabtestBusinessParties(state.partyPreimage, baseline)) throw new Error('LABTEST_LINKED_PARTY_UNVERIFIED');
    const current = field(baseline, 'data', spec.name);
    if (current.state !== 'value' || String(current.value) !== expected[fieldName]) throw new Error('AMEND_PREIMAGE_UNVERIFIED');
    const input = await checkedControl(state.frame, baseline, spec, expected[fieldName]);
    const result = await input.evaluate((element, { spec, offset, limit }) => {
      const component = globalThis.Ext?.getCmp?.(element.id?.replace(/-inputEl$/, ''));
      const store = component?.store;
      if (!store || typeof store.getCount !== 'function' || typeof store.getAt !== 'function' ||
          typeof store.isLoading !== 'function') return null;
      const loaded = store.getCount(), loading = store.isLoading();
      if (!Number.isInteger(loaded) || loaded < 0 || typeof loading !== 'boolean') return null;
      const reportedTotal = typeof store.getTotalCount === 'function' ? store.getTotalCount() : null;
      const read = (record, key) => typeof record?.get === 'function' ? record.get(key) : record?.data?.[key];
      const text = (value) => ['string', 'number'].includes(typeof value) ? String(value) : null;
      const candidates = Array.from({ length: Math.max(0, Math.min(limit, loaded - offset)) }, (_, i) => {
        const record = store.getAt(offset + i);
        return { code: text(read(record, spec.code)), nativeId: text(read(record, spec.id)),
          display: text(read(record, component.displayField || 'display')) };
      });
      return { candidates, coverage: { loaded, offset, loading,
        reportedTotal: Number.isInteger(reportedTotal) && reportedTotal > 0 ? reportedTotal : null,
        hasMoreLoaded: offset + candidates.length < loaded,
        possiblyTruncated: loading || !Number.isInteger(reportedTotal) || reportedTotal <= 0 || loaded < reportedTotal } };
    }, { spec, offset, limit });
    if (!result) return { outcome: 'unavailable', issue: 'SAVED_OPTIONS_UNAVAILABLE' };
    return { outcome: 'loaded_options', field: fieldName, ...result, availability: 'not_verified', quote: 'not_produced' };
  } catch (error) {
    return { outcome: 'refused', issue: /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '')
      ? error.message : 'SAVED_OPTIONS_UNVERIFIED' };
  }
}

/**
 * Stage one change only. The caller must install the shared context read-only guard,
 * open the exact saved record, and use a fresh page. This function never permits Save.
 */
export async function stageLabtestStayAmendment(page, expected = {}, options = {}) {
  if (!ownObject(expected) || Object.keys(expected).some((key) =>
    !['confirmation', 'guestId', 'arrival', 'departure', 'roomType', 'ratePlan', 'note'].includes(key))) {
    return { outcome: 'input_gap', issue: 'UNSUPPORTED_EXPECTED_FIELD' };
  }
  if (!ownObject(options) || Object.keys(options).some((key) => !['field', 'value', 'nativeId', 'timeoutMs'].includes(key)) ||
      !Object.hasOwn(SPECS, options.field)) return { outcome: 'input_gap', issue: 'AMEND_FIELD_UNSUPPORTED' };
  const { field: fieldName, value, nativeId, timeoutMs = 20_000 } = options;
  const spec = SPECS[fieldName];
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { outcome: 'input_gap', issue: 'INVALID_TIMEOUT' };
  if (spec.type === 'date') {
    if (nativeId !== undefined || !dateParts(value) || value < '2027-01-01' ||
        !dateParts(expected.arrival) || !dateParts(expected.departure) ||
        (fieldName === 'arrival' ? value >= expected.departure : value <= expected.arrival)) {
      return { outcome: 'input_gap', issue: 'DATE_CHANGE_INVALID' };
    }
  } else if (typeof value !== 'string' || !/^[A-Z0-9]{1,12}$/.test(value) ||
      typeof nativeId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(nativeId)) {
    return { outcome: 'input_gap', issue: 'SAVED_OPTION_ID_AND_CODE_REQUIRED' };
  }
  const previous = expected[fieldName];
  const expectedDisplay = spec.type === 'date' ? dateParts(previous)?.display : previous;
  const result = await runLabtestAmendSave(page, {
    timeoutMs,
    resultFields: { field: fieldName },
    reportBlockedTargets: true,
    // Newer lifecycle versions enforce this independently; validate is false on every version.
    prepareOnly: true,
    matches: () => false,
    prepare: async (bounded) => {
      // Playwright routing does not intercept service-worker requests. Fail closed if
      // the pinned client's context options cannot prove workers were blocked.
      const context = page.context();
      if (context?._options?.serviceWorkers !== 'block' || typeof context.serviceWorkers !== 'function' ||
          context.serviceWorkers().length !== 0) throw new Error('BROWSER_CONTEXT_UNSAFE');
      const state = await bounded(currentLabtestRecord(page, expected, { allowBlankNote: true, allowUnchangedBusinessParties: true }));
      const baseline = await bounded(snapshotLabtestRecord(state.frame));
      if (!cleanLabtestRecord(baseline)) throw new Error('RECORD_HAS_DIRTY_FIELDS');
      if (!matchesStayPreimage(baseline, expected)) throw new Error('AMEND_PREIMAGE_UNVERIFIED');
      if (!unchangedLabtestBusinessParties(state.partyPreimage, baseline)) throw new Error('LABTEST_LINKED_PARTY_UNVERIFIED');
      const dataField = field(baseline, 'data', spec.name);
      const previousNative = spec.type === 'date' ? dateParts(previous)?.wire : previous;
      if (dataField.state !== 'value' || String(dataField.value) !== previousNative) throw new Error('AMEND_PREIMAGE_UNVERIFIED');
      if (value === previous) {
        if (spec.type === 'option') {
          const oldId = field(baseline, 'data', spec.id);
          if (oldId.state !== 'value' || String(oldId.value) !== nativeId) throw new Error('SAVED_OPTION_ID_MISMATCH');
        }
        return { unchanged: true };
      }
      if (await bounded(page.locator('.x-window:visible:not(.x-menu)').count()) !== 1 ||
          await bounded(state.frame.locator('.x-window:visible:not(.x-menu)').count()) !== 0) throw new Error('UNEXPECTED_DIALOG');
      const input = await bounded(checkedControl(state.frame, baseline, spec, expectedDisplay));
      if (spec.type === 'option') await bounded(selectSavedOption(input, spec, expectedDisplay, value, nativeId, false));
      const save = state.frame.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
      // The lifecycle requires a locator but validation is unconditionally false, so it is never clicked.
      return { state, frame: state.frame, baseline, input, save };
    },
    stage: async (bounded, prepared) => {
      if (page.context()?._options?.serviceWorkers !== 'block' || page.context().serviceWorkers().length !== 0) {
        throw new Error('BROWSER_CONTEXT_UNSAFE');
      }
      let editIssue = null, networkRequestsBlocked = 0;
      // No request, even a GET from a popup, is needed for this local form stage.
      // Keep this deny route for the context lifetime, including delayed callbacks.
      await bounded(page.context().route('**/*', (route) => { networkRequestsBlocked += 1; return route.abort(); }));
      try {
        const current = await bounded(currentLabtestRecord(page, expected, { allowBlankNote: true, allowUnchangedBusinessParties: true }));
        const stillClean = await bounded(snapshotLabtestRecord(prepared.frame));
        if (current.frame !== prepared.frame || !equal(current.native, prepared.state.native) ||
            !equal(current.partyPreimage, prepared.state.partyPreimage) || !equal(stillClean, prepared.baseline) ||
            await bounded(page.locator('.x-window:visible:not(.x-menu)').count()) !== 1 ||
            await bounded(prepared.frame.locator('.x-window:visible:not(.x-menu)').count()) !== 0) {
          throw new Error('AMEND_PREIMAGE_CHANGED');
        }
        await bounded(checkedControl(prepared.frame, prepared.baseline, spec, expectedDisplay));
        if (spec.type === 'date') {
          await bounded(prepared.input.fill(dateParts(value).display));
          await bounded(prepared.input.press('Tab'));
        } else {
          await bounded(selectSavedOption(prepared.input, spec, expectedDisplay, value, nativeId, true));
        }
        // Match the observation window of the prior saved-form probe; not a reprice wait.
        await bounded(page.waitForTimeout(1500));
      } catch (error) {
        editIssue = /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'AMEND_EDIT_UNVERIFIED';
      }
      const snapshot = await bounded(snapshotLabtestRecord(prepared.frame));
      const summary = summarizeSavedStayAmendment(prepared.baseline, snapshot, fieldName, value);
      if (summary && spec.type === 'date') {
        const nativeDate = await bounded(nativeDateObservation(prepared.input, spec.name));
        summary.observed.nativeDate = nativeDate;
        summary.observed.nativeDateMatchesRequested = nativeDate?.componentDate === value && nativeDate?.formModelDate === value;
      }
      const identityVerified = stableIdentity(prepared.baseline, snapshot, prepared.state.partyPreimage);
      const otherStayInputsUnchanged = spec.type !== 'date' || unchangedOtherStayInputs(prepared.baseline, snapshot, spec);
      const innerWindows = await bounded(prepared.frame.locator('.x-window:visible:not(.x-menu)').count());
      const outerWindows = await bounded(page.locator('.x-window:visible:not(.x-menu)').count());
      const dialogs = innerWindows + (outerWindows === 1 ? 0 : 1);
      if (summary && spec.type === 'option') {
        summary.requested.nativeId = nativeId;
        const observedId = summary.observed.nativeId;
        summary.observed.nativeIdMatchesRequested = observedId.state === 'value' && String(observedId.value) === nativeId;
      }
      return { summary, identityVerified, otherStayInputsUnchanged, editIssue, dialogs, networkRequestsBlocked };
    },
    validate: async (_bounded, _prepared, staged) => ({ ok: false,
      issue: staged.editIssue || (!staged.identityVerified || !staged.otherStayInputsUnchanged || staged.dialogs ? 'AMEND_DRAFT_CHANGED' :
        staged.networkRequestsBlocked ? 'STAGING_REQUEST_BLOCKED' :
          !staged.summary?.observed?.formMatchesRequested ? 'AMEND_FORM_VALUE_UNVERIFIED' :
          spec.type === 'date' && (!staged.summary?.observed?.nativeDateMatchesRequested ||
            (!equal(staged.summary?.observed?.model, staged.summary?.observed?.beforeModel) &&
             !staged.summary?.observed?.modelMatchesRequested)) ? 'AMEND_NATIVE_DATE_UNVERIFIED' :
          spec.type === 'option' && (!staged.summary?.observed?.modelMatchesRequested ||
            !staged.summary?.observed?.nativeIdMatchesRequested) ? 'AMEND_MODEL_NOT_SYNCHRONIZED' :
            'REPRICE_AND_INVENTORY_UNVERIFIED') }),
    stageDetails: (staged) => ({ ...staged?.summary, identityVerified: staged?.identityVerified ?? false,
      otherStayInputsUnchanged: staged?.otherStayInputsUnchanged ?? false,
      editIssue: staged?.editIssue ?? null, networkRequestsBlocked: staged?.networkRequestsBlocked ?? 0,
      saveDispatched: false }),
  });
  // A verified local form edit is a stage, not a Save and not an approved rate.
  const stagedUnsaved = result.outcome === 'not_dispatched' &&
    result.issue === 'REPRICE_AND_INVENTORY_UNVERIFIED' && !result.nativeDialog &&
    result.blockedRequests === 0 && result.networkRequestsBlocked === 0;
  return { ...result, ...(stagedUnsaved ? { outcome: 'updated_unsaved' } : {}),
    saveEligible: false, saveDispatched: false,
    pricing: result.pricing || { repricing: 'not_verified', tax: 'not_verified', inventory: 'not_verified', quote: 'not_produced' } };
}
