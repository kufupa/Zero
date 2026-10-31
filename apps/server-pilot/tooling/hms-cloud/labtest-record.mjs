// Identify one rendered saved Labtest record before an action on its page.
import { blankSavedPartyFields } from './labtest-party-fields.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  return { display: `${value.slice(8, 10)}-${MONTHS[parsed.getUTCMonth()]}-${value.slice(0, 4)}`,
    wire: `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}` };
}

export async function currentLabtestRecord(page, expected) {
  const { confirmation, guestId, arrival, departure, roomType, ratePlan, note } = expected || {};
  const start = date(arrival), end = date(departure);
  if (!/^\d{6,}-\d+$/.test(confirmation || '') || !/^\d+$/.test(guestId || '') || !start || !end ||
      arrival < '2027-01-01' || arrival >= departure || !/^[A-Z0-9]{1,12}$/.test(roomType || '') ||
      !/^[A-Z0-9]{1,12}$/.test(ratePlan || '') || typeof note !== 'string' || !note || note.length > 200) {
    throw new Error('LABTEST_RECORD_INPUT_INVALID');
  }
  if (new URL(page.url()).origin !== ORIGIN || !/Infor HMS\s*-\s*HRCEN/i.test(await page.title())) {
    throw new Error('PROPERTY_OR_ORIGIN_MISMATCH');
  }
  const frames = page.locator('.x-window:visible:not(.x-menu) iframe:visible');
  if (await frames.count() !== 1) throw new Error('RECORD_FRAME_NOT_UNIQUE');
  const frame = await (await frames.elementHandle())?.contentFrame();
  if (!frame || new URL(frame.url()).origin !== ORIGIN) throw new Error('RECORD_FRAME_UNAVAILABLE');
  const state = await frame.evaluate(({ expected, start, end, origin, blankSavedPartyFields }) => {
    if (location.origin !== origin) return null;
    const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const names = ['confirmationnumber', 'status', 'guestid', 'firstname', 'lastname', 'arrivaldate', 'departuredate',
      'roomtype', 'rateplan', 'track', 'guaranteetype', 'reservationnote', 'udfchkbox04', 'udfchar13', 'emailaddress'];
    const fields = Object.fromEntries(names.map((name) => [name, [...document.querySelectorAll('input,textarea,select')]
      .filter((el) => el.name === name && visible(el))]));
    if (names.some((name) => fields[name].length !== 1)) return null;
    const cmp = (name) => globalThis.Ext?.getCmp?.(fields[name][0].id.replace(/-inputEl$/, ''));
    const form = cmp('guestid')?.up?.('form'), data = form?.getRecord?.()?.data, keys = data && Object.keys(data);
    if (!form?.el?.dom || !data || names.some((name) => !form.el.dom.contains(fields[name][0]))) return null;
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
    if (blankSavedPartyFields.some((key) => !unique(key) || data[key] !== '' ||
        partyInputs.filter((el) => el.name.toLowerCase() === key).length > 1) ||
        partyInputs.some((el) => el.name !== el.name.toLowerCase() || el.value !== '')) {
      return { issue: 'LABTEST_LINKED_PARTY_UNVERIFIED' };
    }
    const native = {};
    for (const key of ['PKID', 'bookingsessionid', 'reservationid', 'reservationstayid', 'recordid']) {
      if (!unique(key) || !String(data[key] ?? '').trim()) return null;
      native[key] = String(data[key]).trim();
    }
    return { native, track: value('track') };
  }, { expected, start, end, origin: ORIGIN, blankSavedPartyFields });
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
    if (!panel?.el?.dom || !form || !record?.data || !Array.isArray(fields) || !fields.length ||
        typeof form.isDirty !== 'function' || typeof record.dirty !== 'boolean' ||
        fields.some((field) => typeof field.isDirty !== 'function' || !(field.getName?.() || field.name))) return null;
    const partyInputs = [...panel.el.dom.querySelectorAll('input,textarea,select')].filter((el) =>
      visible(el) && blankSavedPartyFields.includes(el.name.toLowerCase()));
    const partyInputsBlank = blankSavedPartyFields.every((name) =>
      partyInputs.filter((el) => el.name.toLowerCase() === name).length <= 1) &&
      partyInputs.every((el) => el.name === el.name.toLowerCase() && el.value === '');
    return { values: form.getValues(), data: record.data, formDirty: form.isDirty(), recordDirty: record.dirty,
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
  const data = snapshot.data, fields = Object.keys(data).filter((key) => key !== 'extId');
  const controls = ['SYSTEM_FUNCTION_NAME', 'USER_FUNCTION_NAME', 'CURRENT_TAB_NAME'];
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
