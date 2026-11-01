// Identify one rendered saved Labtest record before an action on its page.
import { blankSavedPartyFields } from './labtest-party-fields.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const unchangedBusinessPartyFields = new Set([
  'taid1', 'ta1', 'bookingagencycontractid', 'bacontract', 'bookingagency1iatanumber',
  'companyid', 'company', 'companyname',
]);

function normalizeExpectedOrganization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'nativeId') || !Object.hasOwn(value, 'name') ||
      typeof value.nativeId !== 'string' || typeof value.name !== 'string') return null;
  const nativeId = value.nativeId.trim(), name = value.name.trim();
  return nativeId.length > 0 && nativeId.length <= 100 && name.length > 0 && name.length <= 100
    ? { nativeId, name } : null;
}

function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  return { display: `${value.slice(8, 10)}-${MONTHS[parsed.getUTCMonth()]}-${value.slice(0, 4)}`,
    wire: `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}` };
}

export async function currentLabtestRecord(page, expected, options = {}) {
  const { allowBlankNote = false, allowUnchangedBusinessParties = false } = options || {};
  const hasExpectedOrganization = Boolean(options && Object.hasOwn(options, 'expectedOrganization'));
  const expectedOrganization = hasExpectedOrganization
    ? normalizeExpectedOrganization(options.expectedOrganization) : null;
  const { confirmation, guestId, arrival, departure, roomType, ratePlan, note } = expected || {};
  const start = date(arrival), end = date(departure);
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => ![
        'allowBlankNote', 'allowUnchangedBusinessParties', 'expectedOrganization',
      ].includes(key)) ||
      typeof allowBlankNote !== 'boolean' || typeof allowUnchangedBusinessParties !== 'boolean' ||
      (hasExpectedOrganization && (!expectedOrganization || !allowUnchangedBusinessParties)) ||
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
    unchangedBusinessPartyFields, allowUnchangedBusinessParties, expectedOrganization }) => {
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
        // The selected organization ID may exist only in Ext model data on the saved form.
        const selectedCompanyId = key === 'companyid' && expectedOrganization &&
          String(value).trim() === expectedOrganization.nativeId;
        if (!allowUnchangedBusinessParties || !unchangedBusinessPartyFields.includes(key) ||
            !['string', 'number'].includes(typeof value) || !String(value).trim() ||
            (!valueNames.length && !inputs.length && !selectedCompanyId) ||
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
    if (expectedOrganization) {
      const organizationNames = ['company', 'companyname']
        .map((key) => partyPreimage[key]).filter((name) => name.trim());
      const visibleOrganizationNames = partyInputs
        .filter((el) => ['company', 'companyname'].includes(el.name.toLowerCase()))
        .map((el) => String(el.value ?? '').trim()).filter(Boolean);
      const otherLinkedParties = blankSavedPartyFields.filter((key) =>
        !['companyid', 'company', 'companyname'].includes(key));
      if (partyPreimage.companyid !== expectedOrganization.nativeId || !organizationNames.length ||
          organizationNames.some((name) => name !== expectedOrganization.name) ||
          !visibleOrganizationNames.length || visibleOrganizationNames.some((name) => name !== expectedOrganization.name) ||
          otherLinkedParties.some((key) => partyPreimage[key] !== '')) {
        return { issue: 'LABTEST_LINKED_PARTY_UNVERIFIED' };
      }
    }
    const native = {};
    for (const key of ['PKID', 'bookingsessionid', 'reservationid', 'reservationstayid', 'recordid']) {
      if (!unique(key) || !String(data[key] ?? '').trim()) return null;
      native[key] = String(data[key]).trim();
    }
    return { native, track: value('track'), partyPreimage };
  }, { expected, start, end, origin: ORIGIN, blankSavedPartyFields,
    unchangedBusinessPartyFields: [...unchangedBusinessPartyFields], allowUnchangedBusinessParties,
    expectedOrganization });
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
    const partyControls = partyInputs.map((el) => ({ name: el.name, value: String(el.value ?? '') }));
    return { values, data: record.data, partyControls, formDirty: form.isDirty(), recordDirty: record.dirty,
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

export function unchangedLabtestRecord(before, after, changes) {
  if (!before || !after) return false;
  const allowed = new Set(Object.keys(changes));
  if ([...after.dirtyFields, ...after.modifiedFields].some((name) => !allowed.has(name)) ||
      (after.recordDirty && !after.modifiedFields.length) || (after.formDirty && !after.dirtyFields.length)) return false;
  return ['values', 'data'].every((part) => {
    const a = before[part], b = after[part], keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => Object.hasOwn(a, key) && Object.hasOwn(b, key) &&
      (JSON.stringify(a[key]) === JSON.stringify(b[key]) ||
       (allowed.has(key) && String(b[key] ?? '') === changes[key])));
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
