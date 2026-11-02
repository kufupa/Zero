// Real-stay diagnostic staging only. HTTP requests are denied; no Save route exists.
// Caller must establish a pre-navigation WebSocket fence, property lock and verified context closure.
import { isDeepStrictEqual } from 'node:util';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { snapshotLabtestRecord } from './labtest-record.mjs';
import { matchesRealDateStagePreimage } from './saved-stay-real-preimage.mjs';
import { labtestAdultAmendDraftDelta } from './guest-stay-amend-adults.mjs';
import { matchesCombinedDateDraft } from './saved-stay-combined-date-delta.mjs';
import { savedAmendDateParts, checkedSavedAmendControl, observeSavedAmendDate } from './guest-stay-amend-date-room-rate.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const usedPages = new WeakSet();
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const same = isDeepStrictEqual;
const invalid = (issue) => ({ outcome:'input_gap', issue, saveEligible:false, saveDispatched:false });

async function selectRealAdultOption(frame, baseline, requested, commit, assertActive, deadlineAt) {
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
    // Compare in the browser's own monotonic clock, not Node's wall clock.
    if (performance.now() >= deadline) return 'AMEND_TIMEOUT';
    component.setValue(target.record);
    component.fireEvent('select', component, target.record);
    form.updateRecord(record);
    record.set('adults', read(target.record, valueField));
    component.fireEvent('blur', component);
    element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    const value = component.getValue();
    const actual = value && typeof value === 'object' ? read(value, valueField) : value;
    return String(actual ?? '') === String(adults) && element.value === target.label ? true : 'ADULT_EDIT_UNVERIFIED';
  }, { beforeAdult: String(baseline.values.adults), adults: requested, commitChange: commit,
    preimage: { data: baseline.data, values: baseline.values }, deadline: deadlineAt });
  if (outcome !== true) throw new Error(typeof outcome === 'string' ? outcome : 'ADULT_EDIT_UNVERIFIED');
  return input;
}


/** Stage exact dates and adult occupancy on a fresh guarded page. Caller must close its context. */
export async function stageRealStayCombinedWithoutSave(page, expectedInput, changesInput, options = {}) {
  if (!object(expectedInput) || !object(changesInput) || !object(options) ||
      Object.keys(options).some((key) => key !== 'timeoutMs') ||
      Object.keys(changesInput).some((key) => !['arrival','departure','adults'].includes(key)) ||
      !Object.hasOwn(changesInput, 'adults') || !['arrival','departure'].some((key) => Object.hasOwn(changesInput, key)) ||
      !Number.isInteger(expectedInput.adults) || expectedInput.adults < 1 || expectedInput.adults > 16 ||
      !Number.isInteger(changesInput.adults) || changesInput.adults < 1 || changesInput.adults > 16 ||
      expectedInput.adults === changesInput.adults) return invalid('AMEND_INPUT_INVALID');
  let expected, changes;
  try { expected = structuredClone(expectedInput); changes = structuredClone(changesInput); }
  catch { return invalid('AMEND_INPUT_INVALID'); }
  const { adults, ...identity } = expected;
  const arrival = changes.arrival ?? identity.arrival, departure = changes.departure ?? identity.departure;
  if (['arrival','departure'].some((key) => Object.hasOwn(changes, key) && !savedAmendDateParts(changes[key])) ||
      !savedAmendDateParts(arrival) || !savedAmendDateParts(departure) || arrival >= departure ||
      !['arrival','departure'].some((key) => Object.hasOwn(changes, key) && changes[key] !== identity[key])) {
    return invalid('DATE_CHANGE_INVALID');
  }
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000 || !page ||
      typeof page.context !== 'function' || typeof page.route !== 'function' || typeof page.on !== 'function') {
    return invalid('PAGE_OR_TIMEOUT_INVALID');
  }
  if (usedPages.has(page)) return { outcome:'refused', issue:'PAGE_ALREADY_USED', saveEligible:false, saveDispatched:false };
  usedPages.add(page);
  let blockedRequests = 0, dialog = false, editAttempted = false;
  const deadline = performance.now() + timeoutMs;
  const active = () => {
    if (dialog || blockedRequests || performance.now() >= deadline) throw new Error('REAL_STAGE_STOPPED');
  };
  page.on('dialog', () => { dialog = true; });
  try {
    const context = page.context();
    if (context?._options?.serviceWorkers !== 'block' || typeof context.serviceWorkers !== 'function' ||
        context.serviceWorkers().length || typeof context.pages !== 'function' || context.pages().length !== 1 ||
        context.pages()[0] !== page) throw new Error('BROWSER_CONTEXT_UNSAFE');
    await installReadOnlyGuard(context);
    if (new URL(page.url()).origin !== ORIGIN || !/Infor HMS\s*-\s*HRCEN/i.test(await page.title())) {
      throw new Error('PROPERTY_OR_ORIGIN_MISMATCH');
    }
    const frames = page.locator('.x-window:visible:not(.x-menu) iframe:visible');
    if (await frames.count() !== 1) throw new Error('RECORD_FRAME_NOT_UNIQUE');
    const frame = await (await frames.elementHandle())?.contentFrame();
    if (!frame || new URL(frame.url()).origin !== ORIGIN) throw new Error('RECORD_FRAME_UNAVAILABLE');
    const before = await snapshotLabtestRecord(frame);
    if (!matchesRealDateStagePreimage(before, identity) || String(before.data.adults ?? '') !== String(adults) ||
        String(before.values.adults ?? '') !== String(adults) ||
        ['data','values'].some((part) => Object.keys(before[part]).filter((key) => key.toLowerCase() === 'adults').length !== 1)) {
      throw new Error('REAL_PREIMAGE_UNVERIFIED');
    }
    // Neither a Save exception nor any other HTTP exception is installed.
    const deny = (route) => { blockedRequests += 1; return route.abort(); };
    await context.route('**/*', deny);
    await page.route('**/*', deny);
    active();
    if (!same(before, await snapshotLabtestRecord(frame))) throw new Error('REAL_PREIMAGE_CHANGED');
    const browserNow = await frame.evaluate(() => performance.now());
    active();
    if (!Number.isFinite(browserNow)) throw new Error('BROWSER_CLOCK_UNAVAILABLE');
    const browserDeadline = browserNow + Math.max(0, deadline - performance.now());
    await selectRealAdultOption(frame, before, changes.adults, false, active, browserDeadline);
    active();
    editAttempted = true;
    await selectRealAdultOption(frame, before, changes.adults, true, active, browserDeadline);
    active();
    const occupancy = await snapshotLabtestRecord(frame);
    if (!labtestAdultAmendDraftDelta(before, occupancy, changes.adults).ok ||
        !same(before.partyControls, occupancy.partyControls) || before.partyInputsBlank !== occupancy.partyInputsBlank) {
      throw new Error('REAL_OCCUPANCY_UNVERIFIED');
    }
    const names = ['arrival','departure'].filter((key) => Object.hasOwn(changes, key) && changes[key] !== identity[key]);
    if (names.length === 2 && changes.arrival >= identity.departure) names.reverse();
    const controls = [];
    for (const name of names) {
      active();
      const field = name === 'arrival' ? 'arrivaldate' : 'departuredate';
      const input = await checkedSavedAmendControl(frame, occupancy, { name:field, type:'date' }, savedAmendDateParts(identity[name]).display);
      active();
      await input.fill(savedAmendDateParts(changes[name]).display, { timeout:Math.max(1, deadline - performance.now()) });
      active();
      await input.press('Tab', { timeout:Math.max(1, deadline - performance.now()) });
      controls.push({ name, field, input });
    }
    await page.waitForTimeout(1500);
    active();
    const after = await snapshotLabtestRecord(frame);
    if (!matchesCombinedDateDraft(occupancy, after, identity, changes)) throw new Error('REAL_DATE_DRAFT_UNVERIFIED');
    for (const { name, field, input } of controls) {
      const native = await observeSavedAmendDate(input, field);
      active();
      if (native?.componentDate !== changes[name] || native?.formModelDate !== changes[name]) throw new Error('REAL_DATE_DRAFT_UNVERIFIED');
    }
    return { outcome:'updated_unsaved', fields:[...names, 'adults'], blockedRequests, saveEligible:false,
      saveDispatched:false, pricing:'unknown', inventory:'unknown' };
  } catch (error) {
    const issue = /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'REAL_STAGE_UNVERIFIED';
    return { outcome:editAttempted ? 'stage_uncertain' : 'not_staged', issue,
      blockedRequests, saveEligible:false, saveDispatched:false };
  }
}
