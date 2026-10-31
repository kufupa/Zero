// Identify one rendered saved Labtest record before an action on its page.
import { blankSavedPartyFields } from './labtest-party-fields.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const unchangedBusinessPartyFields = new Set([
  'taid1', 'ta1', 'bookingagencycontractid', 'bacontract', 'bookingagency1iatanumber',
  'companyid', 'company', 'companyname',
]);

function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  return { display: `${value.slice(8, 10)}-${MONTHS[parsed.getUTCMonth()]}-${value.slice(0, 4)}`,
    wire: `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}` };
}

export async function currentLabtestRecord(page, expected, options = {}) {
  const { allowBlankNote = false, allowUnchangedBusinessParties = false } = options || {};
  const { confirmation, guestId, arrival, departure, roomType, ratePlan, note } = expected || {};
  const start = date(arrival), end = date(departure);
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['allowBlankNote', 'allowUnchangedBusinessParties'].includes(key)) ||
      typeof allowBlankNote !== 'boolean' || typeof allowUnchangedBusinessParties !== 'boolean' ||
      !/^\d{6,}-\d+$/.test(confirmation || '') || !/^\d+$/.test(guestId || '') || !start || !end ||
      arrival < '2027-01-01' || arrival >= departure || !/^[A-Z0-9]{1,12}$/.test(roomType || '') ||
      !/^[A-Z0-9]{1,12}$/.test(ratePlan || '') || typeof note !== 'string' ||
      (!allowBlankNote && !note) || note.length > 200) {
    throw new Error('LABTEST_RECORD_INPUT_INVALID');
  }
  if (new URL(page.url()).origin !== ORIGIN || !/Infor HMS\s*-\s*HRCEN/i.test(await page.title())) {
    throw new Error('PROPERTY_OR_ORIGIN_MISMATCH');
  }
  const frames = page.locator('.x-window:visible:not(.x-menu) iframe:visible');
  if (await frames.count() !== 1) throw new Error('RECORD_FRAME_NOT_UNIQUE');
  const frame = await (await frames.elementHandle())?.contentFrame();
  if (!frame || new URL(frame.url()).origin !== ORIGIN) throw new Error('RECORD_FRAME_UNAVAILABLE');
  const state = await frame.evaluate(({ expected, start, end, origin, blankSavedPartyFields,
    unchangedBusinessPartyFields, allowUnchangedBusinessParties }) => {
    if (location.origin !== origin) return null;
    const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const names = ['confirmationnumber', 'status', 'guestid', 'firstname', 'lastname', 'arrivaldate', 'departuredate',
      'roomtype', 'rateplan', 'track', 'guaranteetype', 'reservationnote', 'udfchkbox04', 'udfchar13', 'emailaddress'];
    const fields = Object.fromEntries(names.map((name) => [name, [...document.querySelectorAll('input,textarea,select')]
      .filter((el) => el.name === name && visible(el))]));
    if (names.some((name) => fields[name].length !== 1)) return null;
    const cmp = (name) => globalThis.Ext?.getCmp?.(fields[name][0].id.replace(/-inputEl$/, ''));
    const form = cmp('guestid')?.up?.('form'), data = form?.getRecord?.()?.data, keys = data && Object.keys(data);
    const formValues = form?.getForm?.()?.getValues?.();
    if (!form?.el?.dom || !data || !formValues || typeof formValues !== 'object' || Array.isArray(formValues) ||
        names.some((name) => !form.el.dom.contains(fields[name][0]))) return null;
    const unique = (key) => Object.hasOwn(data, key) && keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1;
    const exact = (key, value) => unique(key) && String(data[key] ?? '').trim() === value;
    const value = (name) => name === 'reservationnote' ? fields[name][0].value : fields[name][0].value.trim();
    if (!exact('propertycode', 'HRCEN') || !exact('confirmationnumber', expected.confirmation) ||
        !exact('guestid', expected.guestId) || !exact('status', 'Reserved') || !exact('firstname', 'Proof') ||
        !exact('lastname', 'Labtest') || value('confirmationnumber') !== expected.confirmation || value('status') !== 'Reserved' ||
        value('guestid') !== expected.guestId || value('firstname') !== 'Proof' || value('lastname') !== 'Labtest' ||
        value('arrivaldate') !== start.display || value('departuredate') !== end.display || value('roomtype') !== expected.roomType ||
        value('rateplan') !== expected.ratePlan || !value('track') || value('reservationnote') !== expected.note ||
        value('guaranteetype') !== 'Non-Guaranteed Individual' || cmp('guaranteetype')?.getValue?.() !== 'NGI' ||
        value('udfchar13') || value('emailaddress') || cmp('udfchkbox04')?.getValue?.() !== false) return null;
    const partyInputs = [...form.el.dom.querySelectorAll('input,textarea,select')].filter((el) =>
      visible(el) && blankSavedPartyFields.includes(el.name.toLowerCase()));
    const partyPreimage = {};
    for (const key of blankSavedPartyFields) {
      if (!unique(key)) return { issue: 'LABTEST_LINKED_PARTY_UNVERIFIED' };
      const value = data[key];
      const valueNames = Object.keys(formValues).filter((name) => name.toLowerCase() === key);
      const inputs = partyInputs.filter((el) => el.name.toLowerCase() === key);
      if (valueNames.length > 1 || valueNames.some((name) => name !== key) || inputs.length > 1 ||
          inputs.some((el) => el.name !== key)) return { issue: 'LABTEST_LINKED_PARTY_UNVERIFIED' };
      if (value === '') {
        if ((valueNames.length && String(formValues[key] ?? '') !== '') ||
            (inputs.length && String(inputs[0].value ?? '') !== '')) {
          return { issue: 'LABTEST_LINKED_PARTY_UNVERIFIED' };
        }
      } else {
        if (!allowUnchangedBusinessParties || !unchangedBusinessPartyFields.includes(key) ||
            !['string', 'number'].includes(typeof value) || !String(value).trim() ||
            (!valueNames.length && !inputs.length) ||
            (valueNames.length && String(formValues[key] ?? '') !== String(value)) ||
            (inputs.length && String(inputs[0].value ?? '') !== String(value))) {
          return { issue: 'LABTEST_LINKED_PARTY_UNVERIFIED' };
        }
      }
      partyPreimage[key] = String(value ?? '');
    }
    const linked = (name) => Boolean(partyPreimage[name]?.trim());
    if ((linked('taid1') !== linked('ta1')) ||
        (linked('companyid') !== (linked('company') || linked('companyname'))) ||
        ((linked('bookingagencycontractid') || linked('bacontract') || linked('bookingagency1iatanumber')) &&
          !linked('taid1'))) {
      return { issue: 'LABTEST_LINKED_PARTY_UNVERIFIED' };
    }
    const native = {};
    for (const key of ['PKID', 'bookingsessionid', 'reservationid', 'reservationstayid', 'recordid']) {
      if (!unique(key) || !String(data[key] ?? '').trim()) return null;
      native[key] = String(data[key]).trim();
    }
    return { native, track: value('track'), partyPreimage };
  }, { expected, start, end, origin: ORIGIN, blankSavedPartyFields,
    unchangedBusinessPartyFields: [...unchangedBusinessPartyFields], allowUnchangedBusinessParties });
  if (state?.issue) throw new Error(state.issue);
  if (!state) throw new Error('LABTEST_RECORD_UNVERIFIED');
  return { frame, ...state, arrivalWire: start.wire, departureWire: end.wire };
}

// The saved-record form is submitted as a whole, so preserve its entire clean baseline.
export async function snapshotLabtestRecord(frame) {
  return frame.evaluate((blankSavedPartyFields) => {
    const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const inputs = [...document.querySelectorAll('input[name="guestid"]')].filter(visible);
    if (inputs.length !== 1) return null;
    const panel = globalThis.Ext?.getCmp?.(inputs[0].id.replace(/-inputEl$/, ''))?.up?.('form');
    const form = panel?.getForm?.(), record = panel?.getRecord?.(), fields = form?.getFields?.()?.items;
    const values = form?.getValues?.();
    if (!panel?.el?.dom || !form || !record?.data || !Array.isArray(fields) || !fields.length ||
        !values || typeof values !== 'object' || Array.isArray(values) ||
        typeof form.isDirty !== 'function' || typeof record.dirty !== 'boolean' ||
        fields.some((field) => typeof field.isDirty !== 'function' || !(field.getName?.() || field.name))) return null;
    const partyInputs = [...panel.el.dom.querySelectorAll('input,textarea,select')].filter((el) =>
      visible(el) && blankSavedPartyFields.includes(el.name.toLowerCase()));
    const partyInputsBlank = blankSavedPartyFields.every((name) =>
      partyInputs.filter((el) => el.name.toLowerCase() === name).length <= 1) &&
      partyInputs.every((el) => el.name === el.name.toLowerCase() && el.value === '');
    const visibleFields = [...panel.el.dom.querySelectorAll('input,textarea,select')].filter(visible)
      .map((el) => ({ name: el.name, value: String(el.value ?? '') }));
    const partyControls = partyInputs.map((el) => ({ name: el.name, value: String(el.value ?? '') }));
    return { values, data: record.data, visibleFields, partyControls, formDirty: form.isDirty(), recordDirty: record.dirty,
      dirtyFields: fields.filter((field) => field.isDirty()).map((field) => field.getName?.() || field.name),
      modifiedFields: Object.keys(record.modified || {}), partyInputsBlank };
  }, blankSavedPartyFields);
}

export function cleanLabtestRecord(snapshot) {
  return Boolean(snapshot && snapshot.formDirty === false && snapshot.recordDirty === false &&
    snapshot.dirtyFields.length === 0 && snapshot.modifiedFields.length === 0);
}

// Recheck the full snapshot: a clean record can change after the identity check.
export function blankLabtestParties(snapshot) {
  const data = snapshot?.data, values = snapshot?.values;
  if (snapshot?.partyInputsBlank !== true || !data || typeof data !== 'object' || Array.isArray(data) ||
      !values || typeof values !== 'object' || Array.isArray(values)) return false;
  const dataKeys = Object.keys(data), valueKeys = Object.keys(values);
  return blankSavedPartyFields.every((key) => Object.hasOwn(data, key) && data[key] === '' &&
    dataKeys.filter((name) => name.toLowerCase() === key).length === 1 &&
    valueKeys.filter((name) => name.toLowerCase() === key).every((name) => name === key && values[name] === ''));
}

/** Permit only verified, unchanged primary agency/company links on an amendment. */
export function unchangedLabtestBusinessParties(expected, snapshot) {
  const data = snapshot?.data, values = snapshot?.values, controls = snapshot?.partyControls;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
      Object.keys(expected).length !== blankSavedPartyFields.length ||
      !blankSavedPartyFields.every((key) => Object.hasOwn(expected, key) && typeof expected[key] === 'string') ||
      !data || typeof data !== 'object' || Array.isArray(data) ||
      !values || typeof values !== 'object' || Array.isArray(values) || !Array.isArray(controls)) return false;
  const dataKeys = Object.keys(data), valueKeys = Object.keys(values);
  for (const key of blankSavedPartyFields) {
    if (!Object.hasOwn(data, key) || dataKeys.filter((name) => name.toLowerCase() === key).length !== 1 ||
        String(data[key] ?? '') !== expected[key]) return false;
    const forms = valueKeys.filter((name) => name.toLowerCase() === key);
    const inputs = controls.filter((field) => typeof field?.name === 'string' && field.name.toLowerCase() === key);
    if (forms.length > 1 || forms.some((name) => name !== key) || inputs.length > 1 ||
        inputs.some((field) => field.name !== key || String(field.value ?? '') !== expected[key]) ||
        (forms.length && String(values[key] ?? '') !== expected[key])) return false;
    if (expected[key] !== '' && (!unchangedBusinessPartyFields.has(key) || (!forms.length && !inputs.length))) return false;
  }
  const linked = (name) => Boolean(expected[name]?.trim());
  return linked('taid1') === linked('ta1') &&
    linked('companyid') === (linked('company') || linked('companyname')) &&
    (!(linked('bookingagencycontractid') || linked('bacontract') || linked('bookingagency1iatanumber')) || linked('taid1'));
}

function changedMap(before, after, part) {
  const oldValues = before?.[part], newValues = after?.[part];
  if (!oldValues || typeof oldValues !== 'object' || Array.isArray(oldValues) ||
      !newValues || typeof newValues !== 'object' || Array.isArray(newValues)) return null;
  const keys = new Set([...Object.keys(oldValues), ...Object.keys(newValues)]);
  return [...keys].filter((key) => !Object.hasOwn(oldValues, key) || !Object.hasOwn(newValues, key) ||
    JSON.stringify(oldValues[key]) !== JSON.stringify(newValues[key])).map((field) => ({
    field,
    before: Object.hasOwn(oldValues, field) ? oldValues[field] : null,
    after: Object.hasOwn(newValues, field) ? newValues[field] : null,
  }));
}

function changedVisibleFields(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return null;
  const group = (items) => {
    const fields = new Map();
    for (const field of items) {
      if (!field || typeof field.name !== 'string') return null;
      const name = field.name;
      const values = fields.get(name) || [];
      values.push(String(field.value ?? ''));
      fields.set(name, values);
    }
    return fields;
  };
  const oldFields = group(before), newFields = group(after);
  if (!oldFields || !newFields) return null;
  const names = new Set([...oldFields.keys(), ...newFields.keys()]);
  const changes = [];
  for (const field of names) {
    const previous = oldFields.get(field) || [], current = newFields.get(field) || [];
    if (previous.length !== current.length) return null;
    if (previous.every((value, index) => value === current[index])) continue;
    // A repeated visible name cannot be bound to one requested/model field.
    if (previous.length !== 1) return null;
    changes.push({ field, before: previous[0], after: current[0] });
  }
  return changes;
}

/** Show both rendered-control and model effects; callers must explicitly accept each before Save. */
export function labtestRecordDelta(before, after) {
  return {
    visible: changedVisibleFields(before?.visibleFields, after?.visibleFields),
    form: changedMap(before, after, 'values'),
    model: changedMap(before, after, 'data'),
  };
}

/** Verify full preimage except requested fields and explicitly reviewed surface effects. */
export function unchangedLabtestRecord(before, after, changes, acceptedSideEffects = {}) {
  if (!before || !after || !changes || typeof changes !== 'object' || Array.isArray(changes) ||
      !acceptedSideEffects || typeof acceptedSideEffects !== 'object' || Array.isArray(acceptedSideEffects) ||
      Object.keys(acceptedSideEffects).some((part) => !['form', 'model', 'visible'].includes(part)) ||
      Object.values(changes).some((value) => !['string', 'number', 'boolean'].includes(typeof value))) return false;
  const formEffects = acceptedSideEffects.form ?? {};
  const modelEffects = acceptedSideEffects.model ?? {};
  const visibleEffects = acceptedSideEffects.visible ?? {};
  for (const effects of [formEffects, modelEffects, visibleEffects]) {
    if (!effects || typeof effects !== 'object' || Array.isArray(effects) ||
        Object.values(effects).some((value) => !['string', 'number', 'boolean'].includes(typeof value))) return false;
  }
  // A requested field can have different native representations in its form,
  // loaded model and rendered control (for example, a picker label vs code).
  // Effects are explicit per surface and override the requested value only on
  // that surface.
  const formChanges = { ...changes, ...formEffects };
  const modelChanges = { ...changes, ...modelEffects };
  const visibleChanges = { ...changes, ...visibleEffects };
  const sameKeys = (before, after) => before && after && typeof before === 'object' && !Array.isArray(before) &&
    typeof after === 'object' && !Array.isArray(after) && Object.keys(before).length === Object.keys(after).length &&
    Object.keys(before).every((key) => Object.hasOwn(after, key));
  if (!sameKeys(before.values, after.values) || !sameKeys(before.data, after.data)) return false;
  const formDelta = changedMap(before, after, 'values'), modelDelta = changedMap(before, after, 'data');
  const visibleDelta = 'visibleFields' in before || 'visibleFields' in after
    ? changedVisibleFields(before.visibleFields, after.visibleFields) : [];
  if (!formDelta || !modelDelta || !visibleDelta) return false;
  const matchesDelta = (delta, expectedValues) => delta.every(({ field, after: value }) =>
    Object.hasOwn(expectedValues, field) && String(value ?? '') === String(expectedValues[field] ?? ''));
  const effectsWereObserved = (effects, delta) => Object.keys(effects).every((key) =>
    delta.some((change) => change.field === key));
  if (!matchesDelta(formDelta, formChanges) || !matchesDelta(modelDelta, modelChanges) ||
      !matchesDelta(visibleDelta, visibleChanges) ||
      !effectsWereObserved(formEffects, formDelta) || !effectsWereObserved(modelEffects, modelDelta) ||
      !effectsWereObserved(visibleEffects, visibleDelta)) return false;
  const allowedDirty = new Set([...Object.keys(changes), ...formDelta.map(({ field }) => field),
    ...modelDelta.map(({ field }) => field)]);
  const allowedModified = new Set([...Object.keys(changes), ...modelDelta.map(({ field }) => field)]);
  if (!Array.isArray(after.dirtyFields) || !Array.isArray(after.modifiedFields) ||
      after.dirtyFields.some((name) => !allowedDirty.has(name)) ||
      after.modifiedFields.some((name) => !allowedModified.has(name)) ||
      (after.recordDirty && !after.modifiedFields.length) || (after.formDirty && !after.dirtyFields.length)) return false;
  return ['values', 'data'].every((part) => {
    const a = before[part], b = after[part];
    if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return false;
    return Object.keys(a).every((key) =>
      (JSON.stringify(a[key]) === JSON.stringify(b[key]) ||
       Object.hasOwn(part === 'values' ? formChanges : modelChanges, key) &&
       String(b[key] ?? '') === String((part === 'values' ? formChanges : modelChanges)[key] ?? '')));
  });
}

export function matchesLabtestBody(body, snapshot, changes) {
  const data = snapshot?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const fields = Object.keys(data).filter((key) => key !== 'extId');
  const controls = ['SYSTEM_FUNCTION_NAME', 'USER_FUNCTION_NAME', 'CURRENT_TAB_NAME'];
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
      Object.keys(changes).some((key) => !Object.hasOwn(data, key))) return false;
  const keys = [...body.keys()], expected = new Set([...fields, ...controls]);
  if (keys.length !== expected.size || new Set(keys).size !== keys.length ||
      keys.some((key) => !expected.has(key)) || fields.some((key) => !body.has(key))) return false;
  return fields.every((key) => {
    let value = data[key];
    if (Object.hasOwn(changes, key)) value = changes[key];
    else if (key === 'sessionID' && value && typeof value === 'object' &&
      Object.keys(value).length === 1 && typeof value.sessionID === 'string') value = value.sessionID;
    else if (value != null && !['string', 'number', 'boolean'].includes(typeof value)) return false;
    return body.get(key) === String(value ?? '');
  });
}
