// Unsaved, fenced experiments on one verified HRCEN Proof Labtest saved stay.
import {
  cleanLabtestRecord,
  currentLabtestRecord,
  snapshotLabtestRecord,
  unchangedLabtestBusinessParties,
} from './labtest-record.mjs';
import { isLabtestAmendStageContext, runLabtestAmendSave } from './labtest-amend-save.mjs';
import { savedChildOccupancy } from './guest-stay-amend-children.mjs';
import { prepareStayAmendmentAvailability, readStayAmendmentAvailability } from './guest-stay-amend-availability.mjs';
import { parseSavedStayNativeResponse } from './saved-stay-native-response.mjs';

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

/** Check the selected stay and requested business fields after local edits. */
export function matchesComposedDateAdultDraft(before, after, expected, changes, { synced = true, previous = null, allowRealGuest = false } = {}) {
  if (!cleanLabtestRecord(before) || !ownObject(after?.data) || !ownObject(after?.values) ||
      !ownObject(expected) || !ownObject(changes) ||
      Object.keys(changes).some((key) => !['arrival', 'departure', 'adults'].includes(key))) return false;
  const arrival = changes.arrival ?? expected.arrival, departure = changes.departure ?? expected.departure;
  const adults = changes.adults ?? expected.adults;
  if (!dateParts(expected.arrival) || !dateParts(expected.departure) || !dateParts(arrival) || !dateParts(departure) ||
      expected.arrival >= expected.departure || arrival >= departure ||
      (!allowRealGuest && (expected.arrival < '2027-01-01' || arrival < '2027-01-01')) ||
      !Number.isInteger(adults) || adults < 1 || adults > 16) return false;

  // Identity and unedited stay fields must remain attached to the same record.
  // HMS may refresh taxes, rates, and other native fields while dates change.
  const identity = { propertycode: 'HRCEN', confirmationnumber: expected.confirmation,
    guestid: expected.guestId, status: 'Reserved', roomtype: expected.roomType, rateplan: expected.ratePlan };
  for (const [name, value] of Object.entries(identity)) {
    if (value == null || String(before.data?.[name] ?? '') !== String(value) ||
        String(after.data[name] ?? '') !== String(value)) return false;
  }
  for (const name of ['reservationid', 'reservationstayid', 'recordid', 'firstname', 'lastname']) {
    if (Object.hasOwn(before.data, name) && String(after.data[name] ?? '') !== String(before.data[name] ?? '')) return false;
  }
  const initial = { arrivaldate: dateParts(expected.arrival), departuredate: dateParts(expected.departure),
    adults: String(expected.adults) };
  const target = { arrivaldate: dateParts(arrival), departuredate: dateParts(departure), adults: String(adults) };
  for (const name of Object.keys(initial)) for (const part of ['data', 'values']) {
    const old = typeof initial[name] === 'object' ? initial[name][part === 'data' ? 'wire' : 'display'] : initial[name];
    const wanted = typeof target[name] === 'object' ? target[name][part === 'data' ? 'wire' : 'display'] : target[name];
    const source = before[part], next = after[part];
    const prior = part === 'data' && previous?.data && Object.hasOwn(previous.data, name) ? String(previous.data[name]) : null;
    if (!Object.hasOwn(source, name) || !Object.hasOwn(next, name) || String(source[name]) !== old ||
        (String(next[name]) !== wanted && (synced || part !== 'data' ||
          (String(next[name]) !== old && String(next[name]) !== prior)))) return false;
  }
  const nights = String((Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86400000);
  for (const part of ['data', 'values']) {
    if (Object.hasOwn(after[part], 'nights') && String(after[part].nights) !== nights && (synced || part !== 'data')) return false;
  }
  const previousChildren = savedChildOccupancy(before), currentChildren = savedChildOccupancy(after);
  return previousChildren.valid && currentChildren.valid && previousChildren.count === currentChildren.count &&
    equal(previousChildren.ages, currentChildren.ages);
}

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
    if (!modelData || !Object.hasOwn(modelData, fieldName)) return null;
    return { componentDate: day(component.getValue()), formModelDate: day(modelData[fieldName]) };
  }, name);
}

/** Compose date edits only while the shared request fence is active. */
export async function stageSavedDatesForComposition(context, expected, changes, precedingSnapshot = null) {
  const active = () => {
    if (!isLabtestAmendStageContext(context) || !context.isActive() || context.remainingMs() <= 0) {
      throw new Error('AMEND_STAGE_NOT_ACTIVE');
    }
  };
  active();
  if (!context.baseline || !context.frame || !context.page || !ownObject(changes) ||
      Object.keys(changes).some((key) => !['arrival', 'departure', 'adults'].includes(key))) {
    throw new Error('AMEND_INPUT_INVALID');
  }
  const arrival = changes.arrival ?? expected.arrival, departure = changes.departure ?? expected.departure;
  const draftOptions = { allowRealGuest: context.allowRealGuest === true };
  const minimum = expected.firstName === 'Proof' && expected.lastName === 'Labtest' ? '2027-01-01' : '0000-01-01';
  if (!dateParts(arrival) || !dateParts(departure) || arrival < minimum || arrival >= departure) {
    throw new Error('DATE_CHANGE_INVALID');
  }
  let snapshot = await snapshotLabtestRecord(context.frame);
  active();
  const applied = Object.hasOwn(changes, 'adults') ? { adults: changes.adults } : {};
  if (precedingSnapshot ? !matchesComposedDateAdultDraft(context.baseline, snapshot, expected, applied, draftOptions) :
      !cleanLabtestRecord(snapshot) || Object.keys(applied).length > 0) {
    throw new Error('AMEND_PREIMAGE_CHANGED');
  }
  const order = arrival >= expected.departure ? ['departure', 'arrival'] : ['arrival', 'departure'];
  for (const name of order) {
    const value = name === 'arrival' ? arrival : departure;
    if (value === expected[name]) continue;
    active();
    const input = await checkedControl(context.frame, snapshot, SPECS[name], dateParts(expected[name]).display);
    active();
    await input.fill(dateParts(value).display);
    await input.press('Tab');
    // Component/model equality does not establish completion of deferred blur
    // effects on the saved record. Keep the guarded observation window.
    await context.page.waitForTimeout(1500);
    active();
    const nativeDate = await nativeDateObservation(input, SPECS[name].name);
    if (nativeDate?.componentDate !== value || nativeDate?.formModelDate !== value ||
        await context.frame.locator('.x-window:visible:not(.x-menu)').count() !== 0 ||
        await context.page.locator('.x-window:visible:not(.x-menu)').count() !== 1) {
      throw new Error('AMEND_NATIVE_DATE_UNVERIFIED');
    }
    applied[name] = value;
    const draft = await snapshotLabtestRecord(context.frame);
    active();
    if (!matchesComposedDateAdultDraft(context.baseline, draft, expected, applied, { ...draftOptions, synced: false, previous: snapshot })) {
      throw new Error('AMEND_DRAFT_CHANGED');
    }
    const browserNow = await context.frame.evaluate(() => performance.now());
    active();
    if (!Number.isFinite(browserNow)) throw new Error('BROWSER_CLOCK_UNAVAILABLE');
    const synchronized = await input.evaluate((element, { before, deadline }) => {
      const guestInputs = [...document.querySelectorAll('input[name="guestid"]')].filter((item) =>
        (item.offsetWidth || item.offsetHeight) && getComputedStyle(item).visibility !== 'hidden' && !item.closest('.x-window'));
      const panel = guestInputs.length === 1 && guestInputs[0].id
        ? globalThis.Ext?.getCmp?.(guestInputs[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
      const form = panel?.getForm?.(), record = panel?.getRecord?.();
      const cmp = globalThis.Ext?.getCmp?.(element.id?.replace(/-inputEl$/, ''));
      if (!panel?.el?.dom?.contains(element) || cmp?.up?.('form') !== panel || !record?.data ||
          typeof panel.updateRecord !== 'function' || !form?.getValues || performance.now() >= deadline ||
          ['propertycode', 'confirmationnumber', 'guestid', 'reservationstayid', 'reservationid'].some((name) =>
            String(record.data[name] ?? '') !== String(before.data[name] ?? '')) ||
          ['arrivaldate', 'departuredate', 'adults'].some((name) =>
            String(form.getValues()[name] ?? '') !== String(before.values[name] ?? ''))) return false;
      panel.updateRecord(record);
      return true;
    }, { before: draft, deadline: browserNow + context.remainingMs() });
    active();
    if (!synchronized) throw new Error('AMEND_PREIMAGE_CHANGED');
    snapshot = await snapshotLabtestRecord(context.frame);
    active();
    if (!matchesComposedDateAdultDraft(context.baseline, snapshot, expected, applied, draftOptions)) {
      throw new Error('AMEND_DRAFT_CHANGED');
    }
  }
  return snapshot;
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
    // The native saved-form LOV opens a picker and can dispatch a saved-record
    // change before Save. A catalog choice alone is not an authorized stage.
    if (!store && c?.getXType?.() === 'lovfield') return 'SAVED_NATIVE_PICKER_UNVERIFIED';
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

async function stageSavedRoomPicker(context, current, target) {
  const { page, frame, roomStageGate: gate } = context;
  const before = await snapshotLabtestRecord(frame);
  if (!gate?.arm(before, current, target) || !context.isActive()) throw new Error('ROOM_STAGE_GATE_INVALID');
  const responseFor = (kind) => page.waitForResponse((response) => gate.isRequest(kind, response.request()),
    { timeout: Math.max(1, Math.min(30_000, context.remainingMs())) }).catch(() => null);
  const gridOf = async (response) => {
    if (!response || response.status() !== 200) throw new Error('ROOM_PICKER_RESPONSE_INVALID');
    const grid = parseSavedStayNativeResponse(await response.text())?.grid?.GRIDRESULT?.GRID;
    if (!Array.isArray(grid?.DATA) || !grid.METADATA) throw new Error('ROOM_PICKER_RESPONSE_INVALID');
    return { rows: grid.DATA, metadata: grid.METADATA };
  };
  const trigger = frame.locator('input[name="roomtype"]:visible').locator('xpath=ancestor::table[1]')
    .locator('.x-form-lov-trigger:visible');
  if (await trigger.count() !== 1) throw new Error('PICKER_TRIGGER_NOT_UNIQUE');
  let pending = responseFor('initial');
  await trigger.click({ timeout: 5_000, noWaitAfter: true });
  const initial = await gridOf(await pending), metadata = initial.metadata;
  if (metadata.GRIDNAME !== 'LVROOMTYPE2' || initial.rows.filter((row) => row.roomtypecode === current).length !== 1 ||
      !gate.armReset(metadata) || !context.isActive()) throw new Error('PICKER_PREIMAGE_UNVERIFIED');
  const win = frame.locator('.x-window:visible:not(.x-menu)').filter({
    has: frame.locator('.x-window-header-text').filter({ hasText: /^Room Types$/ }),
  });
  const filter = win.locator('input[name="selfiltervaluectrl"]:visible');
  const run = win.locator('a.x-btn:visible').filter({ hasText: /^\s*Run\s*$/ });
  if (await win.count() !== 1 || await filter.count() !== 1 || await run.count() !== 1 ||
      await filter.inputValue() !== current) throw new Error('PICKER_UNAVAILABLE');
  await filter.fill(''); pending = responseFor('reset');
  await run.click({ timeout: 5_000, noWaitAfter: true });
  const catalog = await gridOf(await pending);
  if (['GRIDID', 'GRIDNAME', 'DATASPYID'].some((key) => String(catalog.metadata[key]) !== String(metadata[key])) ||
      catalog.metadata.MORERECORDPRESENT !== '-' || Number(catalog.metadata.RECORDS) !== catalog.rows.length) {
    throw new Error('ROOM_CATALOG_INCOMPLETE');
  }
  const matches = catalog.rows.filter((row) => row.roomtypecode === target && /^\d+$/.test(String(row.roomtypeid ?? '')));
  if (matches.length !== 1 || catalog.rows.filter((row) => String(row.roomtypeid) === String(matches[0].roomtypeid)).length !== 1) {
    throw new Error('ROOM_OPTION_UNAVAILABLE');
  }
  const chosen = { code: target, nativeId: String(matches[0].roomtypeid) }, windowId = await win.getAttribute('id');
  await frame.waitForFunction(({ id, code }) => {
    const grids = globalThis.Ext?.getCmp?.(id)?.query?.('grid,readonlygrid') || [];
    const store = grids.length === 1 ? grids[0].getStore() : null;
    return Boolean(store && !store.isLoading() && store.getRange().some((record) => record.data?.roomtypecode === code));
  }, { id: windowId, code: target }, { timeout: Math.max(1, Math.min(10_000, context.remainingMs())) });
  const loaded = await frame.evaluate((id) => {
    const grids = globalThis.Ext?.getCmp?.(id)?.query?.('grid,readonlygrid') || [];
    if (grids.length !== 1 || grids[0].getStore().isLoading()) return null;
    return grids[0].getStore().getRange().map((record) => record.data);
  }, windowId);
  const signature = (rows) => JSON.stringify(rows.map((row) => [String(row.roomtypeid), String(row.roomtypecode)]).sort());
  if (!loaded || signature(loaded) !== signature(catalog.rows)) throw new Error('ROOM_GRID_MISMATCH');
  const rows = win.locator('.x-grid-view .x-grid-row,.x-grid-view .x-grid-data-row');
  const indexes = await rows.evaluateAll((elements, id) => elements.flatMap((element, index) => {
    const grid = (globalThis.Ext?.ComponentQuery?.query?.('grid,readonlygrid') || [])
      .find((candidate) => candidate.getEl?.()?.dom?.contains(element));
    return String(grid?.getView?.()?.getRecord?.(element)?.data?.roomtypeid ?? '') === id ? [index] : [];
  }), chosen.nativeId);
  if (indexes.length !== 1) throw new Error('ROOM_OPTION_UNAVAILABLE');
  await rows.nth(indexes[0]).click({ timeout: 5_000 });
  const selected = await frame.evaluate((id) => globalThis.Ext?.getCmp?.(id)?.query?.('grid,readonlygrid')?.[0]
    ?.getSelectionModel?.()?.getSelection?.().map((record) => record.data) || [], windowId);
  if (selected.length !== 1 || selected[0].roomtypecode !== target || String(selected[0].roomtypeid) !== chosen.nativeId ||
      !gate.armSelection(chosen) || !context.isActive()) throw new Error('PICKER_SELECTION_CHANGED');
  const ok = win.locator('a.x-btn:visible').filter({ hasText: /^\s*OK\s*$/ });
  if (await ok.count() !== 1) throw new Error('PICKER_OK_UNAVAILABLE');
  const changed = responseFor('change'), refreshed = responseFor('refresh');
  await ok.click({ timeout: 5_000, noWaitAfter: true });
  const responses = await Promise.all([changed, refreshed]);
  for (const response of responses) {
    if (!response || response.status() !== 200) throw new Error('ROOM_CHANGE_UNVERIFIED');
    parseSavedStayNativeResponse(await response.text());
  }
  const after = await snapshotLabtestRecord(frame);
  if (!context.isActive() || await frame.locator('.x-window:visible:not(.x-menu)').count() !== 0 ||
      String(after?.data?.roomtype ?? '') !== target || String(after?.data?.roomtypeid ?? '') !== chosen.nativeId ||
      String(after?.values?.roomtype ?? '') !== target) throw new Error('ROOM_CHANGE_UNVERIFIED');
  gate.close();
  return after;
}

async function stageSavedRatePicker(context, current, target) {
  const { page, frame, rateStageGate: gate } = context;
  const before = await snapshotLabtestRecord(frame);
  if (!gate?.arm(before, current, target) || !context.isActive()) throw new Error('RATE_STAGE_GATE_INVALID');
  const input = frame.locator('input[name="rateplan"]:visible');
  if (await input.count() !== 1 || !(await input.isEditable())) throw new Error('RATE_FIELD_UNAVAILABLE');
  const responseFor = (kind) => page.waitForResponse((response) => gate.isRequest(kind, response.request()),
    { timeout: Math.max(1, Math.min(30_000, context.remainingMs())) }).catch(() => null);
  const validation = responseFor('validation'), change = responseFor('change');
  await input.fill(target, { timeout: 5_000 });
  await input.press('Tab', { timeout: Math.max(1, Math.min(12_000, context.remainingMs())) });
  const responses = await Promise.all([validation, change]);
  for (const response of responses) {
    if (!response || response.status() !== 200) throw new Error('RATE_CHANGE_UNVERIFIED');
    parseSavedStayNativeResponse(await response.text());
  }
  await frame.waitForFunction(() => !globalThis.Ext?.Ajax?.isLoading?.(), null,
    { timeout: Math.max(1, Math.min(10_000, context.remainingMs())) });
  const control = await input.evaluate((element) => {
    const component = globalThis.Ext?.getCmp?.(element.id?.replace(/-inputEl$/, ''));
    return { value: String(component?.getValue?.() ?? ''), input: element.value,
      invalid: element.getAttribute('aria-invalid') === 'true', errors: component?.getActiveErrors?.() || [] };
  });
  const after = await snapshotLabtestRecord(frame);
  if (!context.isActive() || await frame.locator('.x-window:visible:not(.x-menu)').count() !== 0 ||
      control.value !== target || control.input !== target || control.invalid || control.errors.length ||
      String(after?.data?.rateplan ?? '') !== target || String(after?.values?.rateplan ?? '') !== target) {
    throw new Error('RATE_CHANGE_UNVERIFIED');
  }
  gate.close();
  return after;
}

/** Select a loaded native option only while the saved-stay request fence is active. */
export async function stageSavedRoomRateForComposition(context, fieldName, current, target) {
  const spec = SPECS[fieldName];
  if (!isLabtestAmendStageContext(context) || !context.isActive() || !spec || spec.type !== 'option' ||
      typeof current !== 'string' || typeof target !== 'string' || !target) throw new Error('AMEND_INPUT_INVALID');
  if (current === target) return snapshotLabtestRecord(context.frame);
  if (fieldName === 'roomType' && context.roomStageGate) return stageSavedRoomPicker(context, current, target);
  if (fieldName === 'ratePlan' && context.rateStageGate) return stageSavedRatePicker(context, current, target);
  const input = context.frame.locator(`input[name="${spec.name}"]:visible`);
  if (await input.count() !== 1) throw new Error('AMEND_CONTROL_NOT_UNIQUE');
  const nativeId = await input.evaluate((element, { spec, target }) => {
    const cmp = globalThis.Ext?.getCmp?.(element.id?.replace(/-inputEl$/, ''));
    const store = cmp?.store;
    if (!store?.getCount || !store?.getAt || store.isLoading?.() !== false) return null;
    const read = (record, key) => typeof record?.get === 'function' ? record.get(key) : record?.data?.[key];
    const matches = Array.from({ length: store.getCount() }, (_, index) => store.getAt(index))
      .filter((record) => String(read(record, spec.code) ?? '') === target);
    return matches.length === 1 ? String(read(matches[0], spec.id) ?? '') : null;
  }, { spec, target });
  if (!nativeId) throw new Error('SAVED_NATIVE_PICKER_UNVERIFIED');
  await selectSavedOption(input, spec, current, target, nativeId, true);
  if (!context.isActive()) throw new Error('AMEND_DRAFT_CHANGED');
  const synced = await input.evaluate((element) => {
    const cmp = globalThis.Ext?.getCmp?.(element.id?.replace(/-inputEl$/, ''));
    const panel = cmp?.up?.('form'), record = panel?.getRecord?.();
    if (!panel?.el?.dom?.contains(element) || !record || typeof panel.updateRecord !== 'function') return false;
    panel.updateRecord(record);
    return true;
  });
  const after = await snapshotLabtestRecord(context.frame);
  if (!synced || !context.isActive() || String(after.data?.[spec.name] ?? '') !== target ||
      String(after.data?.[spec.id] ?? '') !== nativeId) throw new Error('SAVED_OPTION_UNVERIFIED');
  return after;
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
      if (!store && component?.getXType?.() === 'lovfield') return { issue: 'SAVED_NATIVE_PICKER_UNVERIFIED' };
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
    if (result.issue) return { outcome: 'unavailable', issue: result.issue };
    return { outcome: 'loaded_options', field: fieldName, ...result, availability: 'not_verified', quote: 'not_produced' };
  } catch (error) {
    return { outcome: 'refused', issue: /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '')
      ? error.message : 'SAVED_OPTIONS_UNVERIFIED' };
  }
}

/** Read availability for a proposal bound to one clean saved Labtest form. */
export async function readLabtestStayAmendmentAvailability(recordPage, availabilityPage, expected = {}, options = {}) {
  if (!ownObject(expected) || Object.keys(expected).some((key) =>
    !['confirmation', 'guestId', 'arrival', 'departure', 'roomType', 'ratePlan', 'note'].includes(key)) ||
      !ownObject(options) || Object.keys(options).some((key) =>
        !['change', 'occupancy', 'partyContext', 'roomQuantity', 'snapshotPath'].includes(key))) {
    return { outcome: 'input_gap', issue: 'AMEND_INPUT_INVALID', saveEligible: false };
  }
  if (!recordPage || !availabilityPage || recordPage === availabilityPage) {
    return { outcome: 'input_gap', issue: 'SEPARATE_AVAILABILITY_PAGE_REQUIRED', saveEligible: false };
  }
  try { expected = structuredClone(expected); options = structuredClone(options); }
  catch { return { outcome: 'input_gap', issue: 'AMEND_INPUT_INVALID', saveEligible: false }; }
  const input = { existing: { propertyCode: 'HRCEN', arrival: expected.arrival, departure: expected.departure,
    roomType: expected.roomType, ratePlan: expected.ratePlan }, change: options.change,
    occupancy: options.occupancy, partyContext: options.partyContext, roomQuantity: options.roomQuantity };
  const prepared = prepareStayAmendmentAvailability(input);
  if (prepared.outcome !== 'prepared') return { ...prepared, saveEligible: false };
  try {
    const state = await currentLabtestRecord(recordPage, expected, { allowBlankNote: true, allowUnchangedBusinessParties: true });
    const baseline = await snapshotLabtestRecord(state.frame);
    if (!cleanLabtestRecord(baseline)) throw new Error('RECORD_HAS_DIRTY_FIELDS');
    if (!matchesStayPreimage(baseline, expected)) throw new Error('AMEND_PREIMAGE_UNVERIFIED');
    if (!unchangedLabtestBusinessParties(state.partyPreimage, baseline)) throw new Error('LABTEST_LINKED_PARTY_UNVERIFIED');
    const formAdult = field(baseline, 'values', 'adults'), modelAdult = field(baseline, 'data', 'adults');
    const children = savedChildOccupancy(baseline);
    const formAges = field(baseline, 'values', 'childages');
    // A verified zero count with a genuinely blank age value means there are no ages to supply.
    const blankZeroAges = children.valid && children.count === 0 && children.ages === null &&
      children.fields.childages.model.present && children.fields.childages.model.value === '' &&
      (formAges.state === 'absent' || formAges.state === 'blank') && options.occupancy.childAges.length === 0;
    const knownAgesMatch = children.ages !== null && equal(children.ages, options.occupancy.childAges) &&
      (formAges.state === 'absent' || (children.ages.length === 0 ? formAges.state === 'blank' :
        formAges.state === 'value' && typeof formAges.value === 'string' && formAges.value === children.ages.join(',')));
    if (formAdult.state !== 'value' || modelAdult.state !== 'value' ||
        String(formAdult.value) !== String(options.occupancy.adults) || String(modelAdult.value) !== String(options.occupancy.adults) ||
        !children.valid || (!blankZeroAges && !knownAgesMatch)) {
      throw new Error('AMEND_OCCUPANCY_UNVERIFIED');
    }
    const partyKeys = { group: 'groupid', organization: 'companyid', bookingAgency: 'taid1' };
    if (Object.entries(partyKeys).some(([name, key]) => typeof state.partyPreimage[key] !== 'string' ||
        state.partyPreimage[key].trim() !== (options.partyContext[name]?.trim() || ''))) {
      throw new Error('AMEND_PARTY_CONTEXT_MISMATCH');
    }
    const result = await readStayAmendmentAvailability(availabilityPage, input, { snapshotPath: options.snapshotPath });
    const after = await currentLabtestRecord(recordPage, expected, { allowBlankNote: true, allowUnchangedBusinessParties: true });
    const afterSnapshot = await snapshotLabtestRecord(after.frame);
    if (state.frame !== after.frame || !equal(state.native, after.native) || !equal(state.partyPreimage, after.partyPreimage) ||
        !equal(baseline, afterSnapshot)) {
      return { outcome: 'refused', issue: 'AMEND_PREIMAGE_CHANGED', saveEligible: false,
        ...(result.snapshotPath ? { snapshotPath: result.snapshotPath } : {}) };
    }
    return { ...result, saveEligible: false, savedPreimage: 'verified_labtest_form',
      ...(result.prepared ? { prepared: { ...result.prepared, savedPreimage: 'verified_labtest_form' } } : {}) };
  } catch (error) {
    return { outcome: 'refused', issue: /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '')
      ? error.message : 'AMEND_AVAILABILITY_UNVERIFIED', saveEligible: false };
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
