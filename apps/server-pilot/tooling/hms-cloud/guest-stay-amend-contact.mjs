// Amend only Booker contact text on one verified saved Labtest record.
import {
  cleanLabtestRecord,
  currentLabtestRecord,
  matchesLabtestBody,
  snapshotLabtestRecord,
  unchangedLabtestBusinessParties,
  unchangedLabtestRecord,
} from './labtest-record.mjs';
import { blankSavedPartyFields } from './labtest-party-fields.mjs';
import { installLabtestSaveRouteChain as installLabtestContactSaveRouteChain } from './saved-stay-save-route-chain.mjs';
import { labtestAmendOutcome as contactAmendOutcome, runLabtestAmendSave } from './labtest-amend-save.mjs';
import { isLabtestAmendStageContext } from './labtest-amend-save.mjs';
export { installLabtestContactSaveRouteChain };
export { contactAmendOutcome };

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const SAVE_PATH = '/web/base/OSRESV.HDR';
const CONTACT_FIELDS = Object.freeze({
  bookerName: Object.freeze({ name: 'caller', label: 'Booker Name' }),
  bookerContact: Object.freeze({ name: 'udfchar06', label: 'Booker Contact' }),
});
const CONTACT_FIELD_NAMES = new Set(Object.values(CONTACT_FIELDS).map(({ name }) => name));
const PRESERVED_BUSINESS_FIELDS = ['status', 'firstname', 'lastname', 'arrivaldate', 'departuredate',
  'roomtype', 'rateplan', 'adults', 'children', 'child1', 'child2', 'child3', 'childages',
  'track', 'guaranteetype', 'reservationnote', 'emailaddress', 'udfchkbox04', 'udfchar09',
  'udfchar13', 'caller', 'udfchar06', ...blankSavedPartyFields];

/** Stage requested guest, booker and CMS fields in the already fenced saved form. */
export async function stageSavedGuestFieldsForComposition(context, changes) {
  if (!isLabtestAmendStageContext(context) || !context.isActive()) throw new Error('AMEND_STAGE_NOT_ACTIVE');
  const specs = { firstName: 'firstname', lastName: 'lastname', guestEmail: 'emailaddress',
    bookerName: 'caller', bookerContact: 'udfchar06', reservationNote: 'reservationnote', billingReference: 'billingreference',
    cmsMessageId: 'udfchar09', cmsRecipient: 'udfchar13' };
  for (const [key, name] of Object.entries(specs)) {
    if (!Object.hasOwn(changes, key)) continue;
    const value = changes[key];
    if (typeof value !== 'string' || value.length > (key === 'reservationNote' ? 2000 : 1000) ||
        [...value].some((char) => (char.charCodeAt(0) < 32 && !(key === 'reservationNote' && char === '\n')) || char.charCodeAt(0) === 127)) {
      throw new Error('CONTACT_VALUE_INVALID');
    }
    const control = context.frame.locator(`input[name="${name}"]:visible,textarea[name="${name}"]:visible`);
    if (await control.count() !== 1) throw new Error('AMEND_CONTROL_NOT_UNIQUE');
    const changed = await control.evaluate((element, next) => {
      const cmp = globalThis.Ext?.getCmp?.(element.id.replace(/-inputEl$/, ''));
      const guests = [...document.querySelectorAll('input[name="guestid"]')].filter((node) =>
        (node.offsetWidth || node.offsetHeight) && getComputedStyle(node).visibility !== 'hidden' && !node.closest('.x-window'));
      const panel = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
      if (!panel?.el?.dom?.contains(element) || cmp?.up?.('form') !== panel || !cmp?.getValue) return false;
      if (String(cmp.getValue() ?? '') === next && element.value === next) return true;
      if (!cmp.setValue || element.disabled || element.readOnly || cmp.readOnly || cmp.isDisabled?.() ||
          (Number.isInteger(element.maxLength) && element.maxLength >= 0 && next.length > element.maxLength)) return false;
      cmp.setValue(next);
      cmp.fireEvent?.('blur', cmp);
      return String(cmp.getValue() ?? '') === next && element.value === next;
    }, value);
    if (!changed || !context.isActive()) throw new Error('CONTACT_EDIT_UNVERIFIED');
    await control.blur();
    if (!context.isActive()) throw new Error('CONTACT_EDIT_UNVERIFIED');
  }
  if (Object.hasOwn(changes, 'cmsSend')) {
    const control = context.frame.locator('input[name="udfchkbox04"]:visible');
    if (typeof changes.cmsSend !== 'boolean' || await control.count() !== 1) throw new Error('CMS_CONTROL_UNAVAILABLE');
    const before = await control.evaluate((element) => globalThis.Ext?.getCmp?.(element.id.replace(/-inputEl$/, ''))?.getValue?.());
    if (typeof before !== 'boolean') throw new Error('CMS_CONTROL_UNAVAILABLE');
    if (before !== changes.cmsSend) await control.click({ timeout: 5000 });
    const after = await control.evaluate((element) => globalThis.Ext?.getCmp?.(element.id.replace(/-inputEl$/, ''))?.getValue?.());
    if (after !== changes.cmsSend || !context.isActive()) throw new Error('CMS_EDIT_UNVERIFIED');
  }
  const synced = await context.frame.evaluate(() => {
    const guests = [...document.querySelectorAll('input[name="guestid"]')].filter((node) =>
      (node.offsetWidth || node.offsetHeight) && getComputedStyle(node).visibility !== 'hidden' && !node.closest('.x-window'));
    const panel = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
    const record = panel?.getRecord?.();
    if (!record || typeof panel.updateRecord !== 'function') return false;
    panel.updateRecord(record);
    return true;
  });
  if (!synced || !context.isActive()) throw new Error('CONTACT_EDIT_UNVERIFIED');
  return snapshotLabtestRecord(context.frame);
}

function uniqueSnapshotField(snapshot, name) {
  const read = (source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source) || !Object.hasOwn(source, name)) return null;
    const keys = Object.keys(source);
    if (keys.filter((key) => key.toLowerCase() === name.toLowerCase()).length !== 1) return null;
    return String(source[name] ?? '');
  };
  const value = read(snapshot?.values);
  const data = read(snapshot?.data);
  return value !== null && data !== null && value === data ? value : null;
}

function validContactChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return false;
  const entries = Object.entries(changes);
  return entries.length > 0 && entries.length <= CONTACT_FIELD_NAMES.size && entries.every(([name, value]) =>
    CONTACT_FIELD_NAMES.has(name) && typeof value === 'string' && value.length > 0 &&
    value.length <= 200 && value.trim() === value);
}

function matchesAmend(request, frame, expected, state, baseline, changes) {
  try {
    if (!validContactChanges(changes)) return false;
    const url = new URL(request.url());
    const body = new URLSearchParams(request.postData() || '');
    const keys = [...body.keys()];
    const required = {
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: 'HDR',
      propertycode: 'HRCEN',
      status: 'Reserved',
      firstname: 'Proof',
      lastname: 'Labtest',
      confirmationnumber: expected.confirmation,
      guestid: expected.guestId,
      arrivaldate: state.arrivalWire,
      departuredate: state.departureWire,
      roomtype: expected.roomType,
      rateplan: expected.ratePlan,
      track: state.track,
      reservationnote: expected.note,
      udfchkbox04: '0',
      udfchar13: '',
      emailaddress: '',
      guaranteetype: 'NGI',
      pagemode: 'view',
      savecctoprofile: '0',
      savesettlementcctoprofile: '0',
      ...state.native,
      ...changes,
    };
    return request.method() === 'POST' && request.frame() === frame && url.origin === ORIGIN &&
      url.pathname === SAVE_PATH && !url.hash && [...url.searchParams].length === 1 &&
      url.searchParams.get('pageaction') === 'SAVE' &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      Object.entries(required).every(([key, wanted]) => body.getAll(key).length === 1 && body.get(key) === wanted &&
        keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1) &&
      matchesLabtestBody(body, baseline, changes);
  } catch {
    return false;
  }
}

/** Exact saved-record contact request matcher, exported for the offline guard tests. */
export function matchesLabtestContactAmendRequest(request, frame, expected, state, baseline, field, value) {
  if (!Object.hasOwn(CONTACT_FIELDS, field) || typeof value !== 'string') return false;
  return matchesAmend(request, frame, expected, state, baseline, {
    [CONTACT_FIELDS[field].name]: value,
  });
}

/** Exact one-save request matcher for a paired Booker name/contact update. */
export function matchesLabtestBookerContactAmendRequest(request, frame, expected, state, baseline, changes) {
  return validContactChanges(changes) && matchesAmend(request, frame, expected, state, baseline, changes);
}

/** Accept the staged form value before Ext synchronizes the loaded record model. */
export function matchesLabtestContactAmendDraft(before, after, field, value) {
  if (!Object.hasOwn(CONTACT_FIELDS, field) || typeof value !== 'string') return false;
  const fieldName = CONTACT_FIELDS[field].name;
  return matchesLabtestBookerContactDraft(before, after, { [fieldName]: value });
}

/** Ext may stage both Booker controls before synchronizing either record.data field. */
export function matchesLabtestBookerContactDraft(before, after, changes) {
  return validContactChanges(changes) &&
    Object.entries(changes).every(([name, value]) => after?.values?.[name] === value) &&
    unchangedLabtestRecord(before, after, changes) &&
    ['values', 'data'].every((part) => PRESERVED_BUSINESS_FIELDS.every((name) => {
      if (Object.hasOwn(changes, name)) return true;
      const previous = before?.[part], current = after?.[part];
      if (!previous || !current) return false;
      const matches = Object.keys(current).filter((key) => key.toLowerCase() === name.toLowerCase());
      if (matches.length > 1 || (matches.length === 1 && matches[0] !== name)) return false;
      return Object.hasOwn(previous, name) === Object.hasOwn(current, name) &&
        JSON.stringify(previous[name]) === JSON.stringify(current[name]);
    }));
}

async function editableContactField(frame, snapshot, spec, value) {
  const field = frame.locator(`input[name="${spec.name}"]:visible,textarea[name="${spec.name}"]:visible`);
  if (await field.count() !== 1) throw new Error('AMEND_CONTROL_NOT_UNIQUE');
  const state = await field.evaluate((element) => {
    const component = globalThis.Ext?.getCmp?.(element.id.replace(/-inputEl$/, ''));
    const guestInput = document.querySelector('input[name="guestid"]');
    const guestComponent = guestInput?.id
      ? globalThis.Ext?.getCmp?.(guestInput.id.replace(/-inputEl$/, ''))
      : null;
    const form = guestComponent?.up?.('form');
    const componentForm = component?.up?.('form');
    const disabled = element.disabled || (typeof component?.isDisabled === 'function'
      ? component.isDisabled()
      : component?.disabled === true);
    const readOnly = element.readOnly || component?.readOnly === true;
    return {
      inSavedForm: Boolean(form?.el?.dom && form === componentForm && form.el.dom.contains(element)),
      hasComponent: Boolean(component && typeof component.setValue === 'function' && typeof component.getValue === 'function'),
      disabled: Boolean(disabled),
      readOnly: Boolean(readOnly),
      domValue: String(element.value ?? ''),
      componentValue: component && typeof component.getValue === 'function'
        ? String(component.getValue() ?? '')
        : null,
      maxLength: Number(element.maxLength),
    };
  });
  const original = uniqueSnapshotField(snapshot, spec.name);
  if (!state.inSavedForm || !state.hasComponent || original === null ||
      state.domValue !== original || state.componentValue !== original) {
    throw new Error('CONTACT_FIELD_PREIMAGE_UNVERIFIED');
  }
  if (state.disabled || state.readOnly) throw new Error('CONTACT_FIELD_UNSUPPORTED');
  if (Number.isInteger(state.maxLength) && state.maxLength >= 0 && value.length > state.maxLength) {
    throw new Error('CONTACT_VALUE_TOO_LONG');
  }
  return { field, original };
}

function changedContactKeys(changes) {
  return Object.entries(CONTACT_FIELDS).filter(([, spec]) => Object.hasOwn(changes, spec.name))
    .map(([key]) => key);
}

function contactResultFields(changes, singleField) {
  return singleField ? { field: singleField } : { fields: changedContactKeys(changes) };
}

async function amendLabtestContactChanges(page, expected, changes, { timeoutMs, singleField = null }) {
  if (!validContactChanges(changes)) return { outcome: 'input_gap', issue: 'CONTACT_CHANGES_INVALID' };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { outcome: 'input_gap', issue: 'INVALID_TIMEOUT' };
  const resultFields = contactResultFields(changes, singleField);
  return runLabtestAmendSave(page, {
    timeoutMs,
    resultFields,
    prepare: async (bounded) => {
      const recordOptions = { allowBlankNote: true, allowUnchangedBusinessParties: true };
      const state = await bounded(currentLabtestRecord(page, expected, recordOptions));
      const frame = state.frame;
      const baseline = await bounded(snapshotLabtestRecord(frame));
      if (!cleanLabtestRecord(baseline)) throw new Error('RECORD_HAS_DIRTY_FIELDS');
      if (!unchangedLabtestBusinessParties(state.partyPreimage, baseline)) {
        throw new Error('LABTEST_LINKED_PARTY_UNVERIFIED');
      }
      if (await bounded(page.locator('.x-window:visible:not(.x-menu)').count()) !== 1 ||
          await bounded(frame.locator('.x-window:visible:not(.x-menu)').count())) {
        throw new Error('UNEXPECTED_DIALOG');
      }

      const controls = [];
      for (const [key, spec] of Object.entries(CONTACT_FIELDS)) {
        if (!Object.hasOwn(changes, spec.name)) continue;
        const { field, original } = await bounded(editableContactField(frame, baseline, spec, changes[spec.name]));
        if (original !== changes[spec.name]) controls.push({ key, spec, field, value: changes[spec.name] });
      }
      if (!controls.length) return { unchanged: true };
      const save = frame.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
      if (await bounded(save.count()) !== 1) throw new Error('AMEND_CONTROL_NOT_UNIQUE');
      return { state, frame, baseline, controls, save };
    },
    matches: (request, requestFrame, prepared) => matchesLabtestBookerContactAmendRequest(
      request, requestFrame, expected, prepared.state, prepared.baseline, changes,
    ),
    stage: async (bounded, prepared) => {
      for (const { field: control, value: nextValue } of prepared.controls) {
        const changed = await bounded(control.evaluate((element, newValue) => {
          const component = globalThis.Ext?.getCmp?.(element.id.replace(/-inputEl$/, ''));
          if (!component?.setValue || element.readOnly || element.disabled) return false;
          component.setValue(newValue);
          component.fireEvent?.('blur', component);
          return element.value === newValue && String(component.getValue() ?? '') === newValue;
        }, nextValue));
        if (!changed) throw new Error('CONTACT_EDIT_UNVERIFIED');
        await bounded(control.blur());
      }
      const after = await bounded(currentLabtestRecord(page, expected, {
        allowBlankNote: true, allowUnchangedBusinessParties: true,
      }));
      const changedForm = await bounded(snapshotLabtestRecord(prepared.frame));
      return { after, changedForm };
    },
    validate: async (bounded, prepared, staged) => ({
      ok: JSON.stringify(prepared.state.native) === JSON.stringify(staged.after.native) &&
        prepared.state.track === staged.after.track &&
        JSON.stringify(prepared.state.partyPreimage) === JSON.stringify(staged.after.partyPreimage) &&
        unchangedLabtestBusinessParties(prepared.state.partyPreimage, staged.changedForm) &&
        matchesLabtestBookerContactDraft(prepared.baseline, staged.changedForm, changes) &&
        await bounded(prepared.frame.locator('.x-window:visible:not(.x-menu)').count()) === 0,
      issue: 'AMEND_DRAFT_CHANGED',
    }),
  });
}

/** Requires a fresh Record View. A successful response still requires a fresh-session readback. */
export async function amendLabtestContact(page, expected = {}, {
  field: fieldKey,
  value,
  timeoutMs = 20_000,
} = {}) {
  if (!Object.hasOwn(CONTACT_FIELDS, fieldKey)) return { outcome: 'input_gap', issue: 'CONTACT_FIELD_UNSUPPORTED' };
  const nextValue = typeof value === 'string' ? value.trim() : '';
  if (!nextValue || nextValue.length > 200) return { outcome: 'input_gap', issue: 'CONTACT_VALUE_INVALID' };
  return amendLabtestContactChanges(page, expected, {
    [CONTACT_FIELDS[fieldKey].name]: nextValue,
  }, { timeoutMs, singleField: fieldKey });
}

/** Amend one or both saved Booker text controls in one exact fenced save. */
export async function amendLabtestBookerContact(page, expected = {}, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return { outcome: 'input_gap', issue: 'CONTACT_CHANGES_INVALID' };
  }
  if (Object.keys(options).some((key) => !['bookerName', 'bookerContact', 'timeoutMs'].includes(key))) {
    return { outcome: 'input_gap', issue: 'CONTACT_CHANGES_INVALID' };
  }
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { outcome: 'input_gap', issue: 'INVALID_TIMEOUT' };
  const changes = {};
  for (const [key, spec] of Object.entries(CONTACT_FIELDS)) {
    const value = options[key];
    if (value === undefined) continue;
    const nextValue = typeof value === 'string' ? value.trim() : '';
    if (!nextValue || nextValue.length > 200) return { outcome: 'input_gap', issue: 'CONTACT_VALUE_INVALID' };
    changes[spec.name] = nextValue;
  }
  if (!Object.keys(changes).length) return { outcome: 'input_gap', issue: 'CONTACT_CHANGE_REQUIRED' };
  return amendLabtestContactChanges(page, expected, changes, { timeoutMs });
}
