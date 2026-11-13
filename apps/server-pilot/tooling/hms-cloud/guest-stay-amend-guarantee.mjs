import { isLabtestAmendStageContext } from './labtest-amend-save.mjs';
import { cleanLabtestRecord, snapshotLabtestRecord } from './labtest-record.mjs';
import { parseSavedStayNativeResponse } from './saved-stay-native-response.mjs';
import { isSavedGuaranteeRequestGate, matchesSavedGuaranteeBefore,
  sameSavedGuaranteePreimage } from './saved-stay-guarantee-request-gate.mjs';

const codeValid = value => typeof value === 'string' && /^[A-Z0-9]{1,20}$/.test(value);
const displayValid = value => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
  value === value.trim() && !/[\p{Cc}]/u.test(value);
const usable = context => isLabtestAmendStageContext(context) && context.isActive() &&
  context.page && context.frame && context.baseline && context.remainingMs() > 0;

async function controlObservation(frame) {
  return frame.evaluate(() => {
    const visible = el => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const fields = name => [...document.querySelectorAll(`input[name="${name}"]`)].filter(visible);
    const guarantees = fields('guaranteetype'), guests = fields('guestid');
    if (guarantees.length !== 1 || guests.length !== 1) return null;
    const el = guarantees[0], component = globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
    const guest = globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''));
    const form = guest?.up?.('form'), data = form?.getRecord?.()?.data, store = component?.getStore?.();
    if (!form?.el?.dom?.contains(el) || component?.up?.('form') !== form || !data || !store ||
        !component.valueField || !component.displayField || typeof store.getRange !== 'function') return null;
    const proxy = store.getProxy?.();
    return { before: { code: component.getValue?.(), display: el.value }, submitted: component.getSubmitData?.()?.guaranteetype,
      model: data.guaranteetype, enabled: !el.disabled && !el.readOnly && component.readOnly !== true &&
        !(typeof component.isDisabled === 'function' ? component.isDisabled() : component.disabled === true),
      options: store.getRange().map(row => ({ code: row.data?.[component.valueField], label: row.data?.[component.displayField] })),
      total: store.getTotalCount?.(), count: store.getCount?.(), local: proxy?.type === 'memory' || proxy?.getType?.() === 'memory',
      loading: Boolean(store.isLoading?.()), filtered: Boolean(store.isFiltered?.()) };
  });
}

function validObservation(observation, { allowFiltered = false } = {}) {
  if (!observation || !codeValid(observation.before?.code) || !displayValid(observation.before?.display) ||
      observation.submitted !== observation.before.code || observation.model !== observation.before.code ||
      !observation.local || observation.loading || (!allowFiltered && observation.filtered) || !Array.isArray(observation.options) ||
      observation.options.length === 0 || observation.count !== observation.options.length ||
      observation.total !== observation.options.length ||
      observation.options.some(item => !codeValid(item.code) || !displayValid(item.label))) return false;
  const codes = observation.options.map(item => item.code), labels = observation.options.map(item => item.label);
  return new Set(codes).size === codes.length && new Set(labels).size === labels.length &&
    observation.options.some(item => item.code === observation.before.code && item.label === observation.before.display);
}

/** Read the saved form's already-loaded guarantee catalogue without selecting anything. */
export async function inspectSavedGuaranteeForComposition(context) {
  if (!usable(context)) throw new Error('GUARANTEE_CONTEXT_INVALID');
  const snapshot = await snapshotLabtestRecord(context.frame);
  if (!usable(context) || !Array.isArray(snapshot?.dirtyFields) || !Array.isArray(snapshot?.modifiedFields) ||
      !cleanLabtestRecord(snapshot) || !sameSavedGuaranteePreimage(context.baseline, snapshot)) {
    throw new Error('GUARANTEE_PREIMAGE_UNVERIFIED');
  }
  const observation = await controlObservation(context.frame);
  const after = await snapshotLabtestRecord(context.frame);
  if (!usable(context) || !validObservation(observation) || !cleanLabtestRecord(after) ||
      !sameSavedGuaranteePreimage(snapshot, after) || after.data?.guaranteetype !== observation.before.code) {
    throw new Error('GUARANTEE_CATALOGUE_UNVERIFIED');
  }
  return { before: observation.before, candidates: observation.options, snapshot: after, enabled: observation.enabled,
    coverage: { loaded: observation.count, total: observation.total, complete: true, possiblyTruncated: false } };
}

function responseMatches(raw, baseline, desired) {
  try {
    const values = parseSavedStayNativeResponse(raw)?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
    const required = ['propertycode', 'confirmationnumber', 'guestid', 'reservationid', 'reservationstayid',
      'recordid', 'bookingsessionid', 'status', 'firstname', 'lastname', 'arrivaldate', 'departuredate'];
    const unique = key => Object.hasOwn(values, key) &&
      Object.keys(values).filter(name => name.toLowerCase() === key.toLowerCase()).length === 1;
    if (!required.every(key => unique(key) && String(values[key] ?? '') === String(baseline.data[key] ?? '')) ||
        !unique('guaranteetype') || String(values.guaranteetype) !== desired) return false;
    // The native client applies all returned fields to the form; check any returned
    // business or pricing value against its clean preimage before trusting it.
    return sameSavedGuaranteePreimage(baseline, { data: { ...baseline.data, ...values }, values: baseline.values },
      { allowGuaranteeChange: true });
  } catch { return false; }
}

async function boundedText(response, context) {
  const delay = Math.min(5_000, context.remainingMs());
  if (delay <= 0) throw new Error('GUARANTEE_TIMEOUT');
  let timer;
  try {
    return await Promise.race([response.text(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('GUARANTEE_TIMEOUT')), delay);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitForDispatch(gate, context) {
  const delay = context.remainingMs();
  if (delay <= 0) throw new Error('GUARANTEE_TIMEOUT');
  let timer;
  try {
    await Promise.race([gate.waitForDispatch(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('GUARANTEE_TIMEOUT')), delay);
    })]);
  } finally { clearTimeout(timer); }
}

async function clickVerifiedChoice(frame, item, snapshot, before, desired, candidates, timeout) {
  const names = ['propertycode', 'confirmationnumber', 'guestid', 'PKID', 'reservationid', 'reservationstayid',
    'recordid', 'bookingsessionid', 'status', 'firstname', 'lastname', 'arrivaldate', 'departuredate'];
  const identity = Object.fromEntries(names.map(name => [name, snapshot.data[name]]));
  const installed = await frame.evaluate(({ identity, before, desired, candidates }) => {
    const key = '__navaSavedGuaranteeClickGuard';
    if (Object.hasOwn(window, key)) return false;
    const state = { result: 'pending', pointerDown: false, mouseDown: false, handler: null };
    state.handler = event => {
      let allowed = false;
      try {
        if (!['pointerdown', 'mousedown'].includes(event.type)) {
          allowed = state.result === 'allowed' && state.pointerDown && state.mouseDown && event.isTrusted;
        } else {
          const visible = el => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
          const inputs = name => [...document.querySelectorAll(`input[name="${name}"]`)].filter(visible);
          const guarantees = inputs('guaranteetype'), guests = inputs('guestid');
          const el = guarantees.length === 1 ? guarantees[0] : null;
          const cmp = el && globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
          const guest = guests.length === 1 && globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''));
          const form = guest?.up?.('form'), data = form?.getRecord?.()?.data, store = cmp?.getStore?.();
          const picker = cmp?.getPicker?.(), target = event.target instanceof Element && event.target.closest('.x-boundlist-item');
          const rows = store?.getRange?.() || [], valueField = cmp?.valueField, displayField = cmp?.displayField;
          const codes = rows.filter(row => row.data?.[valueField] === desired.code);
          const labels = rows.filter(row => row.data?.[displayField] === desired.display);
          const keys = data ? Object.keys(data) : [];
          const sameIdentity = data && Object.entries(identity).every(([name, value]) => Object.hasOwn(data, name) &&
            keys.filter(keyName => keyName.toLowerCase() === name.toLowerCase()).length === 1 && data[name] === value);
          allowed = Boolean(state.result !== 'blocked' && event.isTrusted &&
            (event.type !== 'mousedown' || state.pointerDown) && el && form?.el?.dom?.contains(el) && cmp?.up?.('form') === form &&
            !el.disabled && !el.readOnly && cmp.readOnly !== true && !cmp.isDisabled?.() && sameIdentity &&
            keys.filter(keyName => keyName.toLowerCase() === 'guaranteetype').length === 1 &&
            data.guaranteetype === before.code && cmp.getValue?.() === before.code &&
            cmp.getSubmitData?.()?.guaranteetype === before.code && el.value === before.display &&
            store && !store.isLoading?.() && rows.length === candidates.length &&
            rows.every((row, index) => row.data?.[valueField] === candidates[index].code &&
              row.data?.[displayField] === candidates[index].label) &&
            (store.getProxy?.()?.type === 'memory' || store.getProxy?.()?.getType?.() === 'memory') &&
            store.getCount?.() === rows.length && store.getTotalCount?.() === rows.length &&
            codes.length === 1 && labels.length === 1 && codes[0] === labels[0] &&
            target && picker?.el?.dom?.contains(target) && target.textContent.trim() === desired.display);
          if (allowed && event.type === 'pointerdown') state.pointerDown = true;
          if (allowed && event.type === 'mousedown') state.mouseDown = true;
        }
      } catch { /* An unreadable click is denied. */ }
      state.result = allowed ? 'allowed' : 'blocked';
      if (!allowed) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window[key] = state;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      window.addEventListener(type, state.handler, true);
    }
    return true;
  }, { identity, before, desired, candidates });
  if (!installed) throw new Error('GUARANTEE_CLICK_GUARD_UNAVAILABLE');
  try {
    await item.click({ timeout });
    if (await frame.evaluate(() => window.__navaSavedGuaranteeClickGuard?.result) !== 'allowed') {
      throw new Error('GUARANTEE_CLICK_UNVERIFIED');
    }
  } finally {
    await frame.evaluate(() => {
      const key = '__navaSavedGuaranteeClickGuard', state = window[key];
      if (state) {
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          window.removeEventListener(type, state.handler, true);
        }
        delete window[key];
      }
    });
  }
}

/** Only the caller's Go route can authorize and dispatch the saved guarantee callback. */
export async function applySavedGuaranteeOnGo(context, { expected, code, display } = {}, callbacks = {}) {
  const gate = context?.guaranteeStageGate;
  if (!usable(context) || !isSavedGuaranteeRequestGate(gate) || !codeValid(code) || !displayValid(display) ||
      typeof callbacks.authorizeCandidate !== 'function' || typeof callbacks.dispatchCandidate !== 'function') {
    return { outcome: 'not_dispatched', issue: 'GUARANTEE_INPUT_INVALID', partialEffect: 'none' };
  }
  try {
    const initial = await inspectSavedGuaranteeForComposition(context);
    if (!matchesSavedGuaranteeBefore(initial.snapshot, context.baseline, expected, initial.before) || !initial.enabled ||
        initial.candidates.filter(item => item.code === code && item.label === display).length !== 1 ||
        initial.candidates.filter(item => item.code === code || item.label === display).length !== 1) {
      throw new Error('GUARANTEE_PREIMAGE_UNVERIFIED');
    }
    if (initial.before.code === code) {
      if (initial.before.display !== display) throw new Error('GUARANTEE_CHOICE_UNVERIFIED');
      return { outcome: 'unchanged', snapshot: initial.snapshot, before: initial.before, partialEffect: 'none' };
    }
    if (!gate.arm(initial.snapshot, context.baseline, expected, initial.before, { code, display }, callbacks)) {
      throw new Error('GUARANTEE_GATE_UNVERIFIED');
    }
    const input = context.frame.locator('input[name="guaranteetype"]:visible');
    const trigger = input.locator('xpath=ancestor::table[1]').locator('.x-form-trigger:visible').first();
    if (await input.count() !== 1 || await trigger.count() !== 1 || !usable(context)) throw new Error('GUARANTEE_CONTROL_UNVERIFIED');
    await trigger.click({ timeout: Math.min(5_000, context.remainingMs()) });
    const list = context.frame.locator('.x-boundlist:visible').last();
    await list.waitFor({ timeout: Math.min(5_000, context.remainingMs()) });
    const again = await controlObservation(context.frame), current = await snapshotLabtestRecord(context.frame);
    if (!validObservation(again, { allowFiltered: true }) ||
        !matchesSavedGuaranteeBefore(current, context.baseline, expected, again.before) ||
        again.before.code !== initial.before.code || again.before.display !== initial.before.display ||
        JSON.stringify(again.options) !== JSON.stringify(initial.candidates) || !usable(context)) {
      throw new Error('GUARANTEE_CHOICE_UNVERIFIED');
    }
    const items = list.locator('.x-boundlist-item:visible');
    const indexes = await items.evaluateAll((nodes, label) => nodes.flatMap((node, index) =>
      node.textContent.trim() === label ? [index] : []), display);
    if (indexes.length !== 1 || !usable(context)) throw new Error('GUARANTEE_CHOICE_UNVERIFIED');
    const responsePromise = context.page.waitForResponse(response => gate.isRequest(response.request()),
      { timeout: Math.min(15_000, context.remainingMs()) });
    // Drain a rejected listener if the click itself fails.
    void responsePromise.catch(() => {});
    await clickVerifiedChoice(context.frame, items.nth(indexes[0]), initial.snapshot, initial.before,
      { code, display }, initial.candidates, Math.min(15_000, context.remainingMs()));
    const response = await responsePromise;
    await waitForDispatch(gate, context);
    if (gate.status().phase !== 'dispatched' || !gate.status().possiblyDispatched || !gate.status().continued || !response || response.status() !== 200 ||
        !responseMatches(await boundedText(response, context), initial.snapshot, code) || !usable(context)) {
      throw new Error('GUARANTEE_RESPONSE_UNVERIFIED');
    }
    await context.frame.waitForFunction(() => globalThis.Ext?.Ajax && !globalThis.Ext.Ajax.isLoading(), null,
      { timeout: Math.min(10_000, context.remainingMs()) });
    const after = await snapshotLabtestRecord(context.frame), observation = await controlObservation(context.frame);
    if (!usable(context) || !validObservation(observation, { allowFiltered: true }) ||
        JSON.stringify(observation.options) !== JSON.stringify(initial.candidates) || observation.before.code !== code ||
        observation.before.display !== display || !sameSavedGuaranteePreimage(initial.snapshot, after, { allowGuaranteeChange: true }) ||
        after.data?.guaranteetype !== code || await context.frame.locator('.x-window:visible:not(.x-menu)').count() !== 0) {
      throw new Error('GUARANTEE_RESULT_UNVERIFIED');
    }
    return { outcome: 'applied', snapshot: after, before: initial.before, actual: { code, display },
      partialEffect: 'possible', requiresReconciliation: true };
  } catch (error) {
    const possiblyDispatched = gate.status().possiblyDispatched;
    context.stop?.('GUARANTEE_UNCERTAIN');
    const issue = /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'GUARANTEE_UNVERIFIED';
    return { outcome: possiblyDispatched ? 'uncertain' : 'not_dispatched', issue,
      partialEffect: possiblyDispatched ? 'possible' : 'none', requiresReconciliation: possiblyDispatched };
  } finally { gate.close(); }
}
