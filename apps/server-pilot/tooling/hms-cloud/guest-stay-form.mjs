// Small actions on a caller-owned, guarded, blank Guest Stay page.
import { randomUUID } from 'node:crypto';
import { installPageRequestFence } from './page-request-fence.mjs';
import { isVerifiedArSelectionCurrent, verifiedArSelectionToken } from './lookup.mjs';
import { currentVerifiedLabtestProfileToken, isVerifiedLabtestProfile, isVerifiedLabtestProfileCurrent, verifiedLabtestProfileToken } from './guest-profile.mjs';
import { isLabtestGuest, validCreateDates, validCreateGuest } from './cloud-create-policy.mjs';
import { parseResponse as parsePickerResponse } from './guest-stay-room-rate.mjs';
import { getPropertyRegistration } from './property-registry.mjs';
import { cloudSessionIdentity } from './cloud-session.mjs';

const CLOUD_ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const TEXT_FIELDS = {
  firstName: 'firstname', lastName: 'lastname', bookerName: 'caller', bookerContact: 'udfchar06',
  reservationNote: 'reservationnote', guestEmail: 'emailaddress', cmsRecipient: 'udfchar13',
};
const DATE_FIELDS = { arrivalDate: 'arrivaldate', departureDate: 'departuredate' };
const COMBOS = { adults: 'adults', reasonForStay: 'reasonforstay', guaranteeType: 'guaranteetype', marketSegment: 'marketsegment' };
const DANGEROUS_PATH = /save|delete|cancel|duplicate|checkin|checkout|send|crs/i;
const CHILD_AGE_VALIDATE = '/web/base/OSRESV.HDR.validateChildAgeDetails';
const GUARANTEE_CHANGE = '/web/base/OSRESV.HDR.changeguaranteemethod';
const FIELD_VALIDATE = '/web/base/fieldvalidate';
const MARKET_CHANGE = '/web/base/OSRESV.HDR.changemarketsegment';
const GUARANTEE_BLANK_IDS = ['reservationstayid', 'reservationid', 'recordid'];
const busyPages = new WeakSet();
const pendingFieldValidation = new WeakMap();
const cmsSearches = new WeakMap();
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const clean = (value) => String(value ?? '').trim();
const safeIssue = (error) => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'ACTION_FAILED';
const inputGap = (issue) => ({ outcome: 'input_gap', issue });

function displayDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(day).padStart(2, '0')}-${MONTHS[month - 1]}-${year}`;
}

async function assertForm(page, propertyCode) {
  const issue = await page.evaluate(({ expected, origin }) => {
    if (location.origin !== origin) return 'HMS_ORIGIN_MISMATCH';
    const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const named = (name) => [...document.querySelectorAll(`input[name="${name}"]`)].filter(visible);
    const confirmation = named('confirmationnumber');
    const property = document.documentElement.dataset.propertyCode ?? /Infor HMS\s*-\s*([A-Z0-9]+)/i.exec(document.title)?.[1];
    return property === expected && confirmation.length === 1 && !confirmation[0].value.trim() && named('ta1').length === 1
      ? null : 'PROPERTY_OR_BLANK_STAY_MISMATCH';
  }, { expected: propertyCode, origin: CLOUD_ORIGIN });
  if (issue) throw new Error(issue);
}

async function readFields(page) {
  return page.evaluate(() => {
    const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const find = (name) => [...document.querySelectorAll(`input[name="${name}"]`)].find(visible);
    const agency = find('ta1');
    const confirmation = find('confirmationnumber');
    let root = agency;
    while (root && !root.contains(confirmation)) root = root.parentElement;
    if (!root) throw new Error('GUEST_STAY_FORM_UNAVAILABLE');
    const form = agency?.id && globalThis.Ext?.getCmp?.(agency.id.replace(/-inputEl$/, ''))?.up?.('form');
    return [...root.querySelectorAll('input,textarea,select')].filter((el) => {
      const child = /^child\d+$/.test(el.name || '') && !el.closest('.x-window') &&
        globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''))?.up?.('form') === form;
      return (visible(el) && !['hidden', 'password'].includes(el.type)) || child;
    }).map((el) => {
      const cmp = el.id && globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      const checkbox = cmp?.getXType?.() === 'checkboxfield' || el.type === 'checkbox';
      return {
        id: el.id || null, name: el.name || null,
        label: el.closest('.x-form-item,.x-field')?.querySelector('label')?.innerText?.trim() || cmp?.getFieldLabel?.() || cmp?.boxLabel || null,
        type: el.type || el.tagName.toLowerCase(), value: checkbox ? (cmp?.getValue?.() ?? el.checked) :
          !visible(el) && /^child\d+$/.test(el.name || '') ? (cmp?.getValue?.() ?? el.value) : el.value,
        disabled: el.disabled, readOnly: Boolean(el.readOnly), required: cmp?.allowBlank === false,
      };
    });
  });
}

function changes(before, after) {
  const key = (field, index) => field.id || `${field.name || ''}:${index}`;
  const old = new Map(before.map((field, index) => [key(field, index), field]));
  const next = new Map(after.map((field, index) => [key(field, index), field]));
  return [...new Set([...old.keys(), ...next.keys()])].flatMap((id) => {
    const previous = old.get(id) ?? null, current = next.get(id) ?? null;
    return JSON.stringify(previous) === JSON.stringify(current) ? [] : [{ before: previous, after: current }];
  });
}

async function verifySettled(page, result, fields) {
  if (!['updated_unsaved', 'unchanged_unsaved'].includes(result.outcome)) return;
  const name = TEXT_FIELDS[result.field] || DATE_FIELDS[result.field] || COMBOS[result.field] ||
    ({ cmsSend: 'udfchkbox04', guestOptIn: 'guestoptin4', cmsMessageId: 'udfchar09' })[result.field];
  if (name) {
    const matching = fields.filter((field) => field.name === name);
    const expected = Object.hasOwn(DATE_FIELDS, result.field) ? result.displayed :
      Object.hasOwn(COMBOS, result.field) ? result.actual.display : result.actual;
    if (matching.length !== 1 || matching[0].value !== expected) throw new Error('SETTLED_READBACK_MISMATCH');
    if (Object.hasOwn(COMBOS, result.field)) {
      const value = await (await uniqueInput(page, name)).evaluate((el) => Ext.getCmp(el.id.replace(/-inputEl$/, ''))?.getValue?.());
      if (clean(value) !== clean(result.requested)) throw new Error('SETTLED_READBACK_MISMATCH');
    }
  } else if (Array.isArray(result.actualChildAges)) {
    const expected = { children: result.actualChildAges.length, ...result.ageBandCounts };
    for (const [fieldName, value] of Object.entries(expected)) {
      const matching = fields.filter((field) => field.name === fieldName);
      if (matching.length !== 1 || clean(matching[0].value) !== String(value)) throw new Error('SETTLED_READBACK_MISMATCH');
    }
  }
}

function allowedPost(request, origin, propertyCode, kind, expectedAges) {
  const url = new URL(request.url());
  if (url.origin !== origin || url.href.includes('?')) return false;
  const body = new URLSearchParams(request.postData() || '');
  if (kind === 'cms' && url.pathname === '/web/base/LOVPOP') {
    return Object.entries({ GRID_NAME: 'LVUDFCD', GRID_TYPE: 'LOV', LOV_TAGNAME: 'udfchar09',
      USER_FUNCTION_NAME: 'OSRESV', REQUEST_TYPE: 'LOV.HEAD_DATA.STORED' })
      .every(([key, value]) => body.getAll(key).length === 1 && body.get(key) === value);
  }
  if (kind === 'cms' && url.pathname === '/web/base/GETCACHE') {
    return body.getAll('GRID_NAME').length === 1 && body.get('GRID_NAME') === 'LVUDFCD';
  }
  if (kind !== 'ages' || !['/web/base/OSRESV.HDR.getChildAges', '/web/base/OSRESV.HDR.validateChildAgeDetails'].includes(url.pathname)) return false;
  try {
    if (body.getAll('params').length !== 1 || body.getAll('ONLY_DATA_REQUIRED').length !== 1 || body.get('ONLY_DATA_REQUIRED') !== 'true') return false;
    const params = JSON.parse(body.get('params'));
    const isRead = url.pathname.endsWith('.getChildAges');
    const keys = isRead ? ['propertyCode', 'reservationStayId', 'childAges'] : [
      'propertyCode', 'reservationStayId', 'childAges', 'adultCount', 'childCount', 'updateChildCategories',
      'activeChildCategories', 'confirmChildCategory', 'childCategoryCounts',
    ];
    if (!params || typeof params !== 'object' || Array.isArray(params) || keys.some((key) => !Object.hasOwn(params, key))) return false;
    if (params.propertyCode !== propertyCode || params.reservationStayId !== '' || !Array.isArray(params.childAges) ||
        !params.childAges.every((age) => Number.isInteger(age) && age >= 0 && age <= 17)) return false;
    return isRead || (JSON.stringify(params.childAges) === JSON.stringify(expectedAges) &&
      /^\d+$/.test(String(params.childCount)) && Number(params.childCount) === expectedAges.length && params.updateChildCategories === true);
  } catch { return false; }
}

function fieldValidationRequest(request) {
  try {
    const url = new URL(request.url());
    return request.method() === 'POST' && url.origin === CLOUD_ORIGIN && url.pathname === FIELD_VALIDATE &&
      !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

function wireDate(value) {
  const match = /^(\d{2})-([A-Z]{3})-(\d{4})$/i.exec(clean(value));
  if (!match) return null;
  const day = Number(match[1]), month = MONTHS.indexOf(match[2].toUpperCase()) + 1, year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!month || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { iso: `${year}-${String(month).padStart(2, '0')}-${match[1]}`,
    wire: `${String(month).padStart(2, '0')}/${match[1]}/${year}` };
}

// The current form's record holds the session ID even though it is not a form input.
async function guaranteeDraft(page, propertyCode, { allowRealGuest = false, expectedGuest } = {}) {
  if (!getPropertyRegistration(propertyCode)?.active) return null;
  const identity = allowRealGuest ? expectedGuest : { firstName: 'Proof', lastName: 'Labtest' };
  if (!validCreateGuest(identity) || (!allowRealGuest && !isLabtestGuest(identity))) return null;
  const state = await page.evaluate(({ origin, blankIds, identity, allowRealGuest, propertyCode }) => {
    if (location.origin !== origin) return null;
    const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const names = ['guaranteetype', 'ta1', 'confirmationnumber', 'guestid', 'firstname', 'lastname', 'arrivaldate', 'departuredate'];
    const fields = Object.fromEntries(names.map((name) => [name, [...document.querySelectorAll(`input[name="${name}"]`)].filter(visible)]));
    if (names.some((name) => fields[name].length !== 1)) return null;
    const component = (name) => globalThis.Ext?.getCmp?.(fields[name][0].id.replace(/-inputEl$/, ''));
    const form = component('guaranteetype')?.up?.('form');
    if (!form?.el?.dom || names.some((name) => !form.el.dom.contains(fields[name][0]) || component(name)?.up?.('form') !== form)) return null;
    const data = form.getRecord?.()?.data, keys = data && Object.keys(data);
    const unique = (key) => keys && Object.hasOwn(data, key) && keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1;
    const exact = (key, value) => unique(key) && String(data[key] ?? '').trim() === value;
    const guest = component('guestid');
    if (!data || !exact('propertycode', propertyCode) || !exact('PKID', `@[EMPTY]#@[EMPTY]#${propertyCode}#`) || !exact('status', 'New') ||
        !exact('confirmationnumber', '') || !blankIds.every((key) => exact(key, '')) || !unique('guestid') ||
        ['arprofileid', 'araccountid'].some((key) => keys.filter((name) => name.toLowerCase() === key).length > 1) ||
        !unique('bookingsessionid') || !String(data.bookingsessionid ?? '').trim() ||
        typeof guest?.getValue !== 'function' || String(guest.getValue() ?? '').trim() !== String(data.guestid ?? '').trim() ||
        fields.guestid[0].value.trim() !== String(data.guestid ?? '').trim() ||
        fields.confirmationnumber[0].value.trim() || fields.firstname[0].value !== identity.firstName ||
        fields.lastname[0].value !== identity.lastName) return null;
    const hasProfileId = unique('arprofileid'), hasAccountId = unique('araccountid');
    const profileId = hasProfileId ? String(data.arprofileid ?? '').trim() : '';
    const accountId = hasAccountId ? String(data.araccountid ?? '').trim() : '';
    const guestId = String(data.guestid ?? '').trim();
    if (!allowRealGuest && Boolean(profileId) !== Boolean(accountId)) return null;
    return { session: String(data.bookingsessionid), arrival: fields.arrivaldate[0].value, departure: fields.departuredate[0].value,
      guestId, ar: profileId || accountId ? { accountId, profileId, hasAccountId, hasProfileId } : null };
  }, { origin: CLOUD_ORIGIN, blankIds: GUARANTEE_BLANK_IDS, identity, allowRealGuest, propertyCode });
  if (!state) return null;
  const arrival = wireDate(state.arrival), departure = wireDate(state.departure);
  if (!arrival || !departure || !validCreateDates(arrival.iso, departure.iso, allowRealGuest) ||
      (allowRealGuest && !state.guestId)) return null;
  const arIdentity = state.ar && { session: state.session, ...state.ar };
  const token = arIdentity?.accountId && arIdentity?.profileId ? await verifiedArSelectionToken(page, arIdentity) : null;
  if (arIdentity && !token && !allowRealGuest) return null;
  let guest = null;
  if (state.guestId) {
    if (!isVerifiedLabtestProfile(page, state.guestId)) return null;
    const guestToken = await verifiedLabtestProfileToken(page, { nativeId: state.guestId, session: state.session });
    if (!guestToken) return null;
    guest = { nativeId: state.guestId, token: guestToken };
  }
  return { propertyCode, session: state.session, arrival, departure, firstName: identity.firstName, lastName: identity.lastName,
    ar: arIdentity ? { ...state.ar, token: token || null } : null, guest };
}

function guaranteeRequest(page, request, expected) {
  try {
    const ar = expected.draft.ar;
    const guest = expected.draft.guest;
    if (ar?.token && !isVerifiedArSelectionCurrent(page, { session: expected.draft.session, ...ar })) return false;
    if (guest && !isVerifiedLabtestProfileCurrent(page, { session: expected.draft.session, ...guest })) return false;
    const url = new URL(request.url());
    if (request.method() !== 'POST' || url.origin !== CLOUD_ORIGIN || url.pathname !== GUARANTEE_CHANGE || url.search || url.hash ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '')) return false;
    const body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
    const fields = {
      propertycode: expected.draft.propertyCode, PKID: `@[EMPTY]#@[EMPTY]#${expected.draft.propertyCode}#`, status: 'New',
      firstname: expected.draft.firstName, lastname: expected.draft.lastName,
      arrivaldate: expected.draft.arrival.wire, departuredate: expected.draft.departure.wire, guaranteetype: expected.value,
      ONLY_DATA_REQUIRED: 'true', bookingsessionid: expected.draft.session,
      confirmationnumber: '', guestid: guest?.nativeId || '',
      newprofileclick: '', linkprofileflag: '', savecctoprofile: '0', createinactiveprofileflag: '0', reqguestprofilelookup: '',
      pagemode: 'display', isafterreservationsave: '', savesettlementcctoprofile: '0', linkedprofileflag: '0',
      ...Object.fromEntries(GUARANTEE_BLANK_IDS.map((key) => [key, ''])),
      ...(ar?.hasAccountId ? { araccountid: ar.accountId } : {}),
      ...(ar?.hasProfileId ? { arprofileid: ar.profileId } : {}),
    };
    return Object.entries(fields).every(([key, value]) => body.getAll(key).length === 1 &&
      body.get(key) === value && keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1);
  } catch { return false; }
}

// Keep the actual Ext record handle: an equivalent-looking replacement form is
// not the draft on which the operator selected the market segment.
async function marketDraft(page, propertyCode, record = null) {
  if (!getPropertyRegistration(propertyCode)?.active || cloudSessionIdentity(page)?.propertyCode !== propertyCode) return null;
  const owned = !record;
  if (owned) record = await page.evaluateHandle(() => {
    const visible = el => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const inputs = [...document.querySelectorAll('input[name="marketsegment"]')].filter(visible);
    return inputs.length === 1 ? globalThis.Ext?.getCmp?.(inputs[0].id.replace(/-inputEl$/, ''))?.up?.('form')?.getRecord?.() ?? null : null;
  });
  try {
    const state = await page.evaluate(({ record, origin, propertyCode, blankIds }) => {
      if (location.origin !== origin || !record) return null;
      const visible = el => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
      const names = ['marketsegment', 'ta1', 'confirmationnumber', 'guestid', 'firstname', 'lastname', 'arrivaldate', 'departuredate'];
      const fields = Object.fromEntries(names.map(name => [name, [...document.querySelectorAll(`input[name="${name}"]`)].filter(visible)]));
      if (names.some(name => fields[name].length !== 1)) return null;
      const component = name => globalThis.Ext?.getCmp?.(fields[name][0].id.replace(/-inputEl$/, ''));
      const form = component('marketsegment')?.up?.('form');
      if (!form?.el?.dom || form.getRecord?.() !== record || names.some(name => !form.el.dom.contains(fields[name][0]) || component(name)?.up?.('form') !== form)) return null;
      const data = record.data, keys = data && Object.keys(data);
      const unique = key => keys && Object.hasOwn(data, key) && keys.filter(name => name.toLowerCase() === key.toLowerCase()).length === 1;
      const exact = (key, value) => unique(key) && String(data[key] ?? '').trim() === value;
      if (!data || !exact('propertycode', propertyCode) || !exact('PKID', `@[EMPTY]#@[EMPTY]#${propertyCode}#`) || !exact('status', 'New') ||
          !exact('confirmationnumber', '') || !blankIds.every(key => exact(key, '')) || !unique('guestid') || !unique('bookingsessionid') ||
          !String(data.bookingsessionid ?? '').trim() || fields.confirmationnumber[0].value.trim() ||
          typeof component('guestid')?.getValue !== 'function' ||
          String(component('guestid').getValue() ?? '').trim() !== String(data.guestid ?? '').trim() ||
          fields.guestid[0].value.trim() !== String(data.guestid ?? '').trim() ||
          ['arprofileid', 'araccountid'].some(key => keys.filter(name => name.toLowerCase() === key).length > 1)) return null;
      const hasProfileId = unique('arprofileid'), hasAccountId = unique('araccountid');
      const profileId = hasProfileId ? String(data.arprofileid ?? '').trim() : '';
      const accountId = hasAccountId ? String(data.araccountid ?? '').trim() : '';
      if (Boolean(profileId) !== Boolean(accountId)) return null;
      const protectedModelFields = new Set(['roomtypecharge', 'sourceofbusinessdesc', 'sourceofbus', 'childages', 'activechildcategories']);
      const businessKeys = keys.filter(key => protectedModelFields.has(key.toLowerCase()) || /^child[1-9]\d*(?:_display|status)?$/i.test(key)).sort();
      if (businessKeys.some(key => businessKeys.filter(other => other.toLowerCase() === key.toLowerCase()).length !== 1)) return null;
      const business = businessKeys.map(key => [key, typeof data[key], JSON.stringify(data[key]) ?? null]);
      return { session: String(data.bookingsessionid), guestId: String(data.guestid ?? '').trim(),
        firstName: fields.firstname[0].value, lastName: fields.lastname[0].value,
        arrival: fields.arrivaldate[0].value, departure: fields.departuredate[0].value,
        business, ar: profileId ? { profileId, accountId, hasProfileId, hasAccountId } : null };
    }, { record, origin: CLOUD_ORIGIN, propertyCode, blankIds: GUARANTEE_BLANK_IDS });
    if (!state) return null;
    let guest = null;
    if (state.guestId) {
      if (!isVerifiedLabtestProfile(page, state.guestId)) return null;
      const token = await verifiedLabtestProfileToken(page, { nativeId: state.guestId, session: state.session });
      if (!token) return null;
      guest = { nativeId: state.guestId, token };
    }
    let ar = null;
    if (state.ar) {
      const token = await verifiedArSelectionToken(page, { ...state.ar, session: state.session });
      if (!token) return null;
      ar = { ...state.ar, token };
    }
    if ((state.arrival && !wireDate(state.arrival)) || (state.departure && !wireDate(state.departure))) return null;
    const result = { record, propertyCode, ...state, guest, ar };
    record = null;
    return result;
  } finally { if (owned && record) await record.dispose(); }
}

function sameMarketDraft(a, b) {
  if (!a || !b) return false;
  const { record: _a, ...left } = a, { record: _b, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
}

// Diagnostics contain only fixed field names and booleans; values, including
// the booking session and profile identifiers, never leave runtime memory.
export function marketChangeRequest(page, request, expected) {
  const diagnostics = { transport: false, proof: false, fieldsPresent: {}, fields: {}, safeIntent: {} };
  try {
    const draft = expected.draft, ar = draft.ar, guest = draft.guest;
    diagnostics.proof = (!guest || isVerifiedLabtestProfileCurrent(page, { session: draft.session, ...guest })) &&
      (!ar || isVerifiedArSelectionCurrent(page, { session: draft.session, ...ar }));
    const url = new URL(request.url()), frame = request.frame();
    diagnostics.transport = request.method() === 'POST' && url.origin === CLOUD_ORIGIN && url.pathname === MARKET_CHANGE &&
      !url.search && !url.hash && !url.username && !url.password && frame === page.mainFrame() && frame.page() === page &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '');
    const raw = request.postData() || '';
    if (raw.length > 262144) return { allowed: false, diagnostics };
    const body = new URLSearchParams(raw), keys = [...body.keys()];
    const match = (key, value) => body.getAll(key).length === 1 && body.get(key) === value &&
      keys.filter(name => name.toLowerCase() === key.toLowerCase()).length === 1;
    const fields = { SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR',
      propertycode: draft.propertyCode, PKID: `@[EMPTY]#@[EMPTY]#${draft.propertyCode}#`, status: 'New',
      marketsegment: expected.value, bookingsessionid: draft.session, confirmationnumber: '', guestid: guest?.nativeId || '',
      firstname: draft.firstName, lastname: draft.lastName, ONLY_DATA_REQUIRED: 'true', pagemode: 'display',
      ...Object.fromEntries(GUARANTEE_BLANK_IDS.map(key => [key, ''])),
      ...(draft.arrival ? { arrivaldate: wireDate(draft.arrival).wire } : {}),
      ...(draft.departure ? { departuredate: wireDate(draft.departure).wire } : {}),
      ...(ar ? { araccountid: ar.accountId, arprofileid: ar.profileId } : {}) };
    for (const [key, value] of Object.entries(fields)) {
      diagnostics.fieldsPresent[key] = body.getAll(key).length === 1 && keys.filter(name => name.toLowerCase() === key.toLowerCase()).length === 1;
      diagnostics.fields[key] = match(key, value);
    }
    const safe = ['action', 'pageaction', 'operation', 'autosave', 'newprofileclick', 'linkprofileflag', 'linkedprofileflag',
      'savecctoprofile', 'savesettlementcctoprofile', 'createinactiveprofileflag', 'reqguestprofilelookup',
      'isafterreservationsave', 'confirmnewguestprofile', 'confirminactiveguestprofile', 'cardnumber', 'cardnumber1',
      'cardtypecode', 'cardtypecode1', 'cardhdname', 'cardhdname1', 'cardtrans', 'reservationshareid',
      'additionalprofileids', 'addlplayerprofileid', 'sendemail', 'udfchkbox04'];
    for (const name of safe) {
      const entries = [...body].filter(([key]) => key.toLowerCase() === name);
      // Native data-only field calls include the installation's autosave setting.
      // YES is admitted only by this New-draft market endpoint and its response proof.
      const nativeSetting = name === 'autosave' && entries.length === 1 && entries[0][1] === 'YES';
      diagnostics.safeIntent[name] = entries.length <= 1 && (!entries.length || nativeSetting ||
        ['', '0', 'false', 'null'].includes(entries[0][1].trim().toLowerCase()));
    }
    for (const name of ['araccountid', 'arprofileid']) {
      if (!ar) {
        const entries = [...body].filter(([key]) => key.toLowerCase() === name);
        diagnostics.safeIntent[name] = entries.length <= 1 && (!entries.length || !entries[0][1].trim());
      }
    }
    return { allowed: diagnostics.transport && diagnostics.proof && Object.values(diagnostics.fields).every(Boolean) &&
      Object.values(diagnostics.safeIntent).every(Boolean), diagnostics };
  } catch { return { allowed: false, diagnostics }; }
}

function parseGuaranteeResponse(text) {
  if (typeof text !== 'string' || !text.trim() || /^\s*</.test(text)) throw new Error('GUARANTEE_RESPONSE_UNVERIFIED');
  let badEscape = false;
  const strings = text.replace(/("(?:\\.|[^"\\])*")|'((?:\\.|[^'\\])*)'/gs, (all, double, single) => {
    if (double) return double;
    const value = single.replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)/gs, (match, escape) => {
      const values = { "'": "'", '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
      if (Object.hasOwn(values, escape)) return values[escape];
      if (escape[0] === 'u' || escape[0] === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16));
      badEscape = true; return '';
    });
    return JSON.stringify(value);
  });
  if (badEscape) throw new Error('GUARANTEE_RESPONSE_UNVERIFIED');
  const json = strings.replace(/("(?:\\.|[^"\\])*")|([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    (match, quoted, prefix, key) => quoted || `${prefix}"${key}":`);
  let payload; try { payload = JSON.parse(json); } catch { throw new Error('GUARANTEE_RESPONSE_UNVERIFIED'); }
  const data = payload?.pageData;
  const content = (value) => Array.isArray(value) ? value.length > 0 : value != null && value !== false && value !== '';
  if (!data || [payload, data].some((part) => part && ((Object.hasOwn(part, 'success') && part.success !== true) ||
      content(part.error) || content(part.errors))) || content(data.messages)) throw new Error('GUARANTEE_RESPONSE_UNVERIFIED');
  return data.values;
}

function bounded(promise, ms, issue) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(issue)), ms); })])
    .finally(() => clearTimeout(timer));
}

async function verifyGuaranteeResponse(response, expected) {
  if (!response || response.status() !== 200) throw new Error('GUARANTEE_RESPONSE_UNVERIFIED');
  const values = parseGuaranteeResponse(await bounded(response.text(), 5000, 'GUARANTEE_RESPONSE_TIMEOUT'));
  const ar = expected.draft.ar;
  const guest = expected.draft.guest;
  const fields = { propertycode: expected.draft.propertyCode, status: 'New',
    firstname: expected.draft.firstName, lastname: expected.draft.lastName,
    arrivaldate: expected.draft.arrival.wire, departuredate: expected.draft.departure.wire,
    guaranteetype: expected.value, bookingsessionid: expected.draft.session, confirmationnumber: '', guestid: guest?.nativeId || '',
    ...Object.fromEntries(GUARANTEE_BLANK_IDS.map((key) => [key, ''])),
    ...(ar?.hasAccountId ? { araccountid: ar.accountId } : {}),
    ...(ar?.hasProfileId ? { arprofileid: ar.profileId } : {}) };
  if (!values || !Object.entries(fields).every(([key, value]) => Object.hasOwn(values, key) && clean(values[key]) === value &&
      Object.keys(values).filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1)) {
    throw new Error('GUARANTEE_RESPONSE_UNVERIFIED');
  }
}

function marketDiagnosticPayload(text) {
  let badEscape = false;
  const strings = text.replace(/("(?:\\.|[^"\\])*")|'((?:\\.|[^'\\])*)'/gs, (all, double, single) => {
    if (double) return double;
    const value = single.replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)/gs, (match, escape) => {
      const values = { "'": "'", '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
      if (Object.hasOwn(values, escape)) return values[escape];
      if (escape[0] === 'u' || escape[0] === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16));
      badEscape = true; return '';
    });
    return JSON.stringify(value);
  });
  if (badEscape) throw new Error('MARKET_RESPONSE_INVALID');
  return JSON.parse(strings.replace(/("(?:\\.|[^"\\])*")|([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    (match, quoted, prefix, key) => quoted || `${prefix}"${key}":`));
}

export async function observeMarketResponse(response, expected) {
  const diagnostic = { status: null, parsed: false, accepted: false, valuesPresent: false, pkidCompatible: false, fieldsPresent: {}, fields: {} };
  try {
    diagnostic.status = response.status();
    const text = await bounded(response.text(), 5000, 'MARKET_RESPONSE_TIMEOUT');
    if (text.length > 2097152) throw new Error('MARKET_RESPONSE_TOO_LARGE');
    const payload = marketDiagnosticPayload(text), data = payload?.pageData;
    const content = value => Array.isArray(value) ? value.length > 0 : value != null && value !== false && value !== '';
    diagnostic.parsed = true;
    diagnostic.pageDataPresent = Boolean(data && typeof data === 'object');
    diagnostic.success = typeof payload?.success === 'boolean' ? payload.success : null;
    diagnostic.pageDataSuccess = typeof data?.success === 'boolean' ? data.success : null;
    diagnostic.errorsPresent = [payload, data].some(part => content(part?.error) || content(part?.errors));
    diagnostic.messagesPresent = content(data?.messages);
    const values = parsePickerResponse(text)?.values;
    diagnostic.accepted = true;
    diagnostic.valuesPresent = Boolean(values && typeof values === 'object' && !Array.isArray(values));
    if (diagnostic.valuesPresent) {
      const draft = expected.draft, ar = draft.ar, guest = draft.guest;
      const fields = { propertycode: draft.propertyCode, status: 'New',
        marketsegment: expected.value, bookingsessionid: draft.session, confirmationnumber: '', guestid: guest?.nativeId || '',
        firstname: draft.firstName, lastname: draft.lastName,
        ...Object.fromEntries(GUARANTEE_BLANK_IDS.map(key => [key, ''])),
        ...(draft.arrival ? { arrivaldate: wireDate(draft.arrival).wire } : {}),
        ...(draft.departure ? { departuredate: wireDate(draft.departure).wire } : {}),
        ...(ar ? { araccountid: ar.accountId, arprofileid: ar.profileId } : {}) };
      const keys = Object.keys(values);
      const pkidKeys = keys.filter(key => key.toLowerCase() === 'pkid');
      diagnostic.pkidCompatible = pkidKeys.length === 0 || (pkidKeys.length === 1 &&
        clean(values[pkidKeys[0]]) === `@[EMPTY]#@[EMPTY]#${draft.propertyCode}#`);
      for (const [key, value] of Object.entries(fields)) {
        diagnostic.fieldsPresent[key] = Object.hasOwn(values, key) && keys.filter(name => name.toLowerCase() === key.toLowerCase()).length === 1;
        diagnostic.fields[key] = diagnostic.fieldsPresent[key] && clean(values[key]) === value;
      }
    }
  } catch { diagnostic.readOrParseFailed = true; }
  return diagnostic;
}

function marketBusinessFieldsUnchanged(before, after) {
  const names = new Set(['confirmationnumber', 'guestid', 'firstname', 'lastname', 'arrivaldate', 'departuredate',
    'adults', 'children', 'ta1', 'company', 'araccountname', 'reservationnote', 'emailaddress', 'guaranteetype',
    'roomtype', 'roomtypecharge', 'rateplan', 'sourceofbusiness', 'sourceofbusinessdesc', 'sourceofbus', 'reasonforstay', 'caller', 'udfchar06', 'guestoptin4',
    'udfchkbox04', 'udfchar09', 'udfchar13', 'track', 'tracksubsegment']);
  const protectedFields = fields => fields.filter(field => names.has(field.name) || /^child[1-9]\d*(?:_display)?$/i.test(field.name || ''))
    .map(({ id, name, value }) => ({ id, name, value }));
  return JSON.stringify(protectedFields(before)) === JSON.stringify(protectedFields(after));
}

async function dialogs(page, nativeDialog, allowed) {
  if (nativeDialog()) throw new Error('UNEXPECTED_DIALOG');
  const windows = page.locator('.x-window:visible:not(.x-menu)');
  const count = await windows.count();
  if (count) {
    if (allowed !== 'cms' || count !== 1 || clean(await windows.first().locator('.x-window-header-text').first().textContent()) !== 'CMS Message Id') {
      throw new Error('UNEXPECTED_DIALOG');
    }
  }
  if (allowed !== 'ages' && await page.locator('.x-window[id^="childagespopup"]:visible').count()) throw new Error('UNEXPECTED_DIALOG');
}

async function run(page, propertyCode, { allowed = null, post = null, expectedAges = null, guaranteeFence = false, marketFence = false,
  createAuthority } = {}, operation) {
  if (typeof propertyCode !== 'string' || !/^[A-Z0-9]+$/.test(propertyCode)) return inputGap('PROPERTY_CODE_REQUIRED');
  if (!page || typeof page.route !== 'function' || typeof page.evaluate !== 'function') return inputGap('PAGE_REQUIRED');
  if (busyPages.has(page)) return { outcome: 'execution_failure', issue: 'ACTION_IN_PROGRESS' };
  busyPages.add(page);
  let attempted = false, nativeDialog = false, before = null, blocked = [], active = true;
  let fence = null, approval = null, ageValidationReady = false, ageValidationCount = 0;
  let guaranteeExpected = null, guaranteeApproved = null, rejectDialog;
  const guaranteeResponses = [], validationRequests = [], validationResponses = [];
  let marketExpected = null, marketApproved = null, marketRecord = null, marketResponseTask = null, marketFinished = false;
  const marketResponses = [], marketDiagnostic = {};
  const dialogPromise = new Promise((_, reject) => { rejectDialog = reject; });
  const onDialog = dialog => { nativeDialog = true; fence?.quarantine();
    void dialog.dismiss().catch(() => {}); if (post === 'guarantee' || post === 'market') rejectDialog(new Error('UNEXPECTED_DIALOG')); };
  const onResponse = (response) => {
    if (response.request() === guaranteeApproved) guaranteeResponses.push(response);
    if (validationRequests.includes(response.request())) validationResponses.push(response);
    if (response.request() === marketApproved) {
      marketResponses.push(response);
      marketResponseTask = observeMarketResponse(response, marketExpected).then(diagnostic => { marketDiagnostic.response = diagnostic; });
    }
  };
  const onFinished = request => { if (request === marketApproved) marketFinished = true; };
  const onFailed = request => { if (request === marketApproved) { marketDiagnostic.requestFailed = true; fence?.quarantine(); } };
  const ensureActive = () => { if (!active) throw new Error('ACTION_EXPIRED'); };
  const guard = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const safeRead = ['GET', 'HEAD', 'OPTIONS'].includes(method) && !DANGEROUS_PATH.test(url.pathname) &&
      !(post === 'market' && marketExpected);
    let allowed = method === 'POST' && post && allowedPost(request, CLOUD_ORIGIN, propertyCode, post, expectedAges);
    if (post === 'guarantee' && method === 'POST' && url.pathname === GUARANTEE_CHANGE && guaranteeExpected &&
        guaranteeRequest(page, request, guaranteeExpected)) {
      if (active && !guaranteeApproved && approval?.allow(request)) { guaranteeApproved = request; allowed = true; }
      else if (active) fence?.quarantine();
    }
    if (method === 'POST' && url.pathname === FIELD_VALIDATE && fieldValidationRequest(request)) {
      const pending = pendingFieldValidation.get(page) === true || post === 'guarantee' && guaranteeExpected;
      if (active && pending) {
        validationRequests.push(request);
        allowed = true;
      } else if (active) fence?.quarantine();
    }
    if (post === 'market' && method === 'POST' && url.pathname === MARKET_CHANGE && marketExpected) {
      const match = marketChangeRequest(page, request, marketExpected);
      match.diagnostics.identity = cloudSessionIdentity(page)?.propertyCode === propertyCode;
      marketDiagnostic.request = match.diagnostics;
      if (match.allowed && match.diagnostics.identity && active && !marketApproved && approval?.allow(request)) { marketApproved = request; allowed = true; }
      else if (active) fence?.quarantine();
    }
    const ageValidation = method === 'POST' && url.pathname === CHILD_AGE_VALIDATE;
    if ((!safeRead && !allowed) || (ageValidation &&
        (!ageValidationReady || ageValidationCount !== 0 || !approval?.allow(request)))) {
      if ((post === 'guarantee' || post === 'market') && attempted) fence?.quarantine();
      blocked.push({ method, path: url.pathname });
      await route.abort();
    } else {
      if (ageValidation) ageValidationCount += 1;
      await route.fallback();
    }
  };
  const check = async (which = allowed) => {
    ensureActive();
    await dialogs(page, () => nativeDialog, which);
    ensureActive();
    if (blocked.length) throw new Error('UNEXPECTED_REQUEST_BLOCKED');
    await assertForm(page, propertyCode);
    ensureActive();
  };
  page.on('dialog', onDialog);
  page.on('response', onResponse);
  if (post === 'market') { page.on('requestfinished', onFinished); page.on('requestfailed', onFailed); }
  try {
    const execute = async () => {
      await check();
      before = await readFields(page); ensureActive();
      const paths = [...(post === 'ages' ? [CHILD_AGE_VALIDATE] : []),
        ...(post === 'guarantee' || guaranteeFence ? [GUARANTEE_CHANGE] : []),
        ...(post === 'market' || marketFence ? [MARKET_CHANGE] : [])];
      if (paths.length) {
        fence = await installPageRequestFence(page, paths); ensureActive();
        if (post === 'ages' || post === 'guarantee' || post === 'market') approval = fence.open();
      }
      await page.route('**/*', guard);
      if (!active) { await page.unroute('**/*', guard).catch(() => {}); throw new Error('ACTION_EXPIRED'); }
      const result = await operation({ check, mark: () => { ensureActive(); attempted = true; },
        allowAgeValidation: () => { ensureActive(); ageValidationReady = true; },
        allowGuarantee: (expected) => { ensureActive(); guaranteeExpected = expected; },
        ownMarketRecord: record => { ensureActive(); marketRecord = record; },
        allowMarket: expected => { ensureActive(); marketExpected = expected; } });
      ensureActive();
      if (post === 'guarantee' && result.outcome === 'updated_unsaved') {
        const deadline = Date.now() + 10000;
        while (!guaranteeResponses.length && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100)); ensureActive();
        }
        if (!guaranteeApproved || guaranteeResponses.length !== 1) throw new Error('GUARANTEE_RESPONSE_UNVERIFIED');
        await page.waitForFunction(() => !Ext.Ajax.isLoading(), null, { timeout: 10000 }); ensureActive();
      }
      if (post === 'market' && result.outcome === 'updated_unsaved') {
        const deadline = Date.now() + 10000;
        while ((!marketResponses.length || !marketFinished) && Date.now() < deadline && !marketDiagnostic.requestFailed) {
          await new Promise(resolve => setTimeout(resolve, 100)); ensureActive();
        }
        if (marketResponseTask) await marketResponseTask;
        if (!marketApproved || marketResponses.length !== 1 || !marketFinished || marketDiagnostic.requestFailed ||
            marketDiagnostic.response?.status !== 200 || !marketDiagnostic.response?.accepted || !marketDiagnostic.response?.valuesPresent ||
            marketDiagnostic.response?.pkidCompatible !== true ||
            !Object.values(marketDiagnostic.response.fields).every(Boolean)) throw new Error('MARKET_RESPONSE_UNVERIFIED');
        await page.waitForFunction(() => !Ext.Ajax.isLoading(), null, { timeout: 10000 }); ensureActive();
        await page.waitForTimeout(1000); ensureActive();
        if (fence?.isQuarantined()) throw new Error('MARKET_REQUEST_UNCERTAIN');
      }
      if (validationRequests.length) {
        const responseDeadline = Date.now() + 8000;
        while (validationResponses.length < validationRequests.length && Date.now() < responseDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 100)); ensureActive();
        }
        if (validationResponses.length !== validationRequests.length ||
            validationResponses.some((response) => response.status() !== 200)) throw new Error('FIELD_VALIDATE_RESPONSE_UNVERIFIED');
        for (const response of validationResponses) await bounded(response.text(), 5000, 'FIELD_VALIDATE_RESPONSE_TIMEOUT');
        await page.waitForFunction(() => !Ext.Ajax.isLoading(), null, { timeout: 10000 }); ensureActive();
      }
      // Child Apply has a validated response and response-derived parent counts;
      // guarantee has its matched response and draft checks. Other controls still
      // need the guarded observation window for uncorrelated blur effects.
      const correlatedUpdate = result.outcome === 'updated_unsaved' && ['ages', 'guarantee', 'market'].includes(post);
      if (!correlatedUpdate) await page.waitForTimeout(1000);
      await check();
      const after = await readFields(page); ensureActive();
      await verifySettled(page, result, after); ensureActive();
      if (post === 'guarantee' && result.outcome === 'updated_unsaved') {
        const current = await guaranteeDraft(page, propertyCode, createAuthority); ensureActive();
        if (JSON.stringify(current) !== JSON.stringify(guaranteeExpected?.draft)) throw new Error('GUARANTEE_DRAFT_CHANGED');
        await verifyGuaranteeResponse(guaranteeResponses[0], guaranteeExpected); ensureActive();
        await check();
        pendingFieldValidation.set(page, true);
      }
      if (post === 'market' && result.outcome === 'updated_unsaved') {
        const current = await marketDraft(page, propertyCode, marketRecord); ensureActive();
        if (!sameMarketDraft(current, marketExpected?.draft) || !marketBusinessFieldsUnchanged(before, after)) throw new Error('MARKET_DRAFT_CHANGED');
        const submitted = await (await uniqueInput(page, 'marketsegment')).evaluate(el => Ext.getCmp(el.id.replace(/-inputEl$/, ''))?.getSubmitData?.()?.marketsegment);
        if (clean(submitted) !== clean(result.requested)) throw new Error('SETTLED_READBACK_MISMATCH');
        await check();
      }
      const changedFields = changes(before, after);
      if (result.outcome === 'closed_unsaved' && changedFields.length) throw new Error('CMS_CANCEL_FORM_CHANGED');
      return { ...result, changedFields, ...(post === 'market' && marketDiagnostic.response ? { marketDiagnostic } : {}) };
    };
    return post === 'guarantee' || post === 'market'
      ? await bounded(Promise.race([execute(), dialogPromise]), 30000, post === 'market' ? 'MARKET_ACTION_TIMEOUT' : 'GUARANTEE_ACTION_TIMEOUT') : await execute();
  } catch (error) {
    active = false;
    if (attempted && fence) fence.quarantine();
    if (post === 'market' && marketApproved && !marketResponseTask && !marketDiagnostic.requestFailed) {
      const deadline = Date.now() + 5000;
      while (!marketResponseTask && !marketDiagnostic.requestFailed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (marketResponseTask) await bounded(marketResponseTask, 6000, 'MARKET_RESPONSE_TIMEOUT').catch(() => {});
    let observed;
    if (!nativeDialog) {
      try {
        const readback = async () => { await assertForm(page, propertyCode); return readFields(page); };
        observed = post === 'guarantee' || post === 'market' ? await bounded(readback(), 5000, 'READBACK_TIMEOUT') : await readback();
      } catch { /* No safe readback. */ }
    }
    return { outcome: attempted ? 'action_uncertain' : 'execution_failure',
      issue: blocked.length ? 'UNEXPECTED_REQUEST_BLOCKED' : nativeDialog ? 'UNEXPECTED_DIALOG' : safeIssue(error),
      ...(blocked.length ? { blockedRequests: blocked } : {}), ...(observed && before ? { changedFields: changes(before, observed) } : {}),
      ...(post === 'market' ? { marketDiagnostic } : {}) };
  } finally {
    active = false;
    approval?.close();
    await page.unroute('**/*', guard).catch(() => {});
    page.off('dialog', onDialog);
    page.off('response', onResponse);
    if (post === 'market') { page.off('requestfinished', onFinished); page.off('requestfailed', onFailed); }
    if (marketRecord) await marketRecord.dispose().catch(() => {});
    busyPages.delete(page);
  }
}

async function uniqueInput(page, name) {
  const field = page.locator(`input[name="${name}"]:visible, textarea[name="${name}"]:visible`);
  if (await field.count() !== 1) throw new Error('FIELD_NOT_UNIQUE');
  return field;
}

// This proves a control's requested state; run() still observes late side effects.
async function waitForInputState(page, input, expected) {
  const element = await input.elementHandle();
  try {
    await page.waitForFunction(({ element, expected }) => {
      const component = globalThis.Ext?.getCmp?.(element?.id.replace(/-inputEl$/, ''));
      if (!element?.isConnected || !component) return false;
      const same = (actual, value) => expected.caseInsensitive
        ? String(actual ?? '').toUpperCase() === String(value ?? '').toUpperCase() : expected.trim
          ? String(actual ?? '').trim() === String(value ?? '').trim() : actual === value;
      return (!Object.hasOwn(expected, 'display') || same(element.value, expected.display)) &&
        (!Object.hasOwn(expected, 'value') || same(component.getValue?.(), expected.value)) &&
        (!expected.blurred || component.hasFocus !== true) &&
        (!expected.submitted || same(component.getSubmitData?.()?.[element.name], expected.value));
    }, { element, expected }, { timeout: 5000 });
  } finally { await element?.dispose(); }
}

export async function readGuestStayForm(page, { propertyCode } = {}) {
  return run(page, propertyCode, {}, async () => ({ outcome: 'ok', fields: await readFields(page) }));
}

export async function setGuestStayText(page, { propertyCode, field, value } = {}) {
  if (!Object.hasOwn(TEXT_FIELDS, field || '')) return inputGap('TEXT_FIELD_UNSUPPORTED');
  if (typeof value !== 'string' || value.length > 4000 || /[\r\n]/.test(value) && field !== 'reservationNote') return inputGap('TEXT_VALUE_INVALID');
  return run(page, propertyCode, {}, async ({ check, mark }) => {
    const input = await uniqueInput(page, TEXT_FIELDS[field]);
    if (!await input.isEditable()) throw new Error('FIELD_NOT_EDITABLE');
    await check(); mark();
    await input.fill(value, { timeout: 5000 });
    await input.press('Tab', { timeout: 5000 });
    await waitForInputState(page, input, { display: value, blurred: true }); await check();
    const actual = await input.inputValue();
    if (actual !== value) throw new Error('TEXT_READBACK_MISMATCH');
    return { outcome: 'updated_unsaved', field, requested: value, actual };
  });
}

export async function setGuestStayDate(page, { propertyCode, field, date } = {}) {
  if (!Object.hasOwn(DATE_FIELDS, field || '')) return inputGap('DATE_FIELD_UNSUPPORTED');
  const display = displayDate(date);
  if (!display) return inputGap('DATE_INVALID');
  return run(page, propertyCode, {}, async ({ check, mark }) => {
    const input = await uniqueInput(page, DATE_FIELDS[field]);
    if (!await input.isEditable()) throw new Error('FIELD_NOT_EDITABLE');
    await check(); mark();
    await input.fill(display, { timeout: 5000 });
    await input.press('Tab', { timeout: 5000 });
    await waitForInputState(page, input, { display, blurred: true, caseInsensitive: true }); await check();
    const actual = await input.inputValue();
    if (actual.toUpperCase() !== display) throw new Error('DATE_READBACK_MISMATCH');
    return { outcome: 'updated_unsaved', field, requested: date, actual: date, displayed: actual };
  });
}

async function comboOptions(input) {
  return input.evaluate((el) => {
    const cmp = Ext.getCmp(el.id.replace(/-inputEl$/, ''));
    const store = cmp?.getStore?.();
    if (!store || !cmp.valueField || !cmp.displayField) throw new Error('DROPDOWN_UNAVAILABLE');
    return store.getRange().map((record) => ({ value: record.data[cmp.valueField], label: record.data[cmp.displayField] }));
  });
}

async function openCombo(page, input) {
  const trigger = input.locator('xpath=ancestor::table[1]').locator('.x-form-trigger:visible').first();
  if (await trigger.count() !== 1) throw new Error('DROPDOWN_UNAVAILABLE');
  await trigger.click({ timeout: 5000 });
  const list = page.locator('.x-boundlist:visible').last();
  await list.waitFor({ timeout: 5000 });
  return list;
}

export async function listGuestStayDropdown(page, { propertyCode, field } = {}) {
  if (!Object.hasOwn(COMBOS, field || '')) return inputGap('DROPDOWN_FIELD_UNSUPPORTED');
  return run(page, propertyCode, { guaranteeFence: field === 'guaranteeType', marketFence: field === 'marketSegment' }, async ({ check, mark }) => {
    const input = await uniqueInput(page, COMBOS[field]);
    await check(); mark();
    await openCombo(page, input);
    const options = await comboOptions(input);
    const info = await input.evaluate(el => {
      const store = Ext.getCmp(el.id.replace(/-inputEl$/, ''))?.getStore?.();
      const proxy = store?.getProxy?.();
      const total = store?.getTotalCount?.();
      return { total: Number.isInteger(total) && total >= 0 ? total : null,
        local: proxy?.type === 'memory' || proxy?.getType?.() === 'memory', loading: Boolean(store?.isLoading?.()) };
    });
    await page.keyboard.press('Escape');
    await check();
    const complete = !info.loading && info.local && info.total === options.length ? true : null;
    return { outcome: 'ok', field, options, criteria: { propertyCode, scope: 'unfiltered' },
      coverage: { loaded: options.length, total: info.total, complete, possiblyTruncated: complete !== true } };
  });
}

export async function selectGuestStayDropdown(page, { propertyCode, field, value } = {}, createAuthority = {}) {
  if (!Object.hasOwn(COMBOS, field || '')) return inputGap('DROPDOWN_FIELD_UNSUPPORTED');
  if (!['string', 'number'].includes(typeof value) || clean(value) === '') return inputGap('DROPDOWN_VALUE_REQUIRED');
  if (field === 'adults' && (!Number.isInteger(value) || value < 0)) return inputGap('ADULT_COUNT_INVALID');
  const guarantee = field === 'guaranteeType';
  const market = field === 'marketSegment';
  return run(page, propertyCode, { post: guarantee ? 'guarantee' : market ? 'market' : null, createAuthority }, async ({ check, mark, allowGuarantee, allowMarket, ownMarketRecord }) => {
    const draft = guarantee ? await guaranteeDraft(page, propertyCode, createAuthority) : market ? await marketDraft(page, propertyCode) : null;
    if (guarantee && !draft) return { outcome: 'unsupported', issue: 'GUARANTEE_DRAFT_UNSUPPORTED', field, requested: value };
    if (market && !draft) return { outcome: 'unsupported', issue: 'MARKET_DRAFT_UNSUPPORTED', field, requested: value };
    if (market) {
      try { ownMarketRecord(draft.record); } catch (error) { await draft.record.dispose(); throw error; }
    }
    const input = await uniqueInput(page, COMBOS[field]);
    await check(); mark();
    const list = await openCombo(page, input);
    const options = await comboOptions(input);
    const matches = options.filter((option) => clean(option.value) === clean(value));
    if (matches.length === 0) {
      await check(); await page.keyboard.press('Escape'); await check();
      return { outcome: 'unsupported', issue: 'DROPDOWN_VALUE_UNAVAILABLE', field, requested: value };
    }
    if (matches.length !== 1 || typeof matches[0].label !== 'string') throw new Error('DROPDOWN_VALUE_NOT_UNIQUE');
    const items = list.locator('.x-boundlist-item:visible');
    const indexes = await items.evaluateAll((nodes, label) => nodes.flatMap((node, index) => node.textContent.trim() === label.trim() ? [index] : []), matches[0].label);
    if (indexes.length !== 1) throw new Error('DROPDOWN_OPTION_NOT_UNIQUE');
    if (guarantee) {
      const existing = await input.evaluate((el) => {
        const cmp = Ext.getCmp(el.id.replace(/-inputEl$/, ''));
        return { value: cmp?.getValue?.(), display: el.value, submitted: cmp?.getSubmitData?.()?.guaranteetype };
      });
      await check();
      const ready = await guaranteeDraft(page, propertyCode, createAuthority);
      if (!ready || JSON.stringify(ready) !== JSON.stringify(draft)) throw new Error('GUARANTEE_DRAFT_CHANGED');
      if (clean(existing.value) === clean(value)) {
        if (clean(existing.display) !== clean(matches[0].label) || clean(existing.submitted) !== clean(value)) {
          throw new Error('DROPDOWN_READBACK_MISMATCH');
        }
        await check(); await page.keyboard.press('Escape'); await check();
        return { outcome: 'unchanged_unsaved', field, requested: value, actual: existing };
      }
      allowGuarantee({ draft: ready, value: clean(value) });
    } else if (market) {
      const existing = await input.evaluate(el => {
        const cmp = Ext.getCmp(el.id.replace(/-inputEl$/, ''));
        return { value: cmp?.getValue?.(), display: el.value, submitted: cmp?.getSubmitData?.()?.marketsegment };
      });
      await check();
      const ready = await marketDraft(page, propertyCode, draft.record);
      if (!sameMarketDraft(ready, draft)) throw new Error('MARKET_DRAFT_CHANGED');
      if (clean(existing.value) === clean(value)) {
        if (clean(existing.display) !== clean(matches[0].label) || clean(existing.submitted) !== clean(value)) throw new Error('DROPDOWN_READBACK_MISMATCH');
        await page.keyboard.press('Escape'); await check();
        return { outcome: 'unchanged_unsaved', field, requested: value, actual: existing };
      }
      allowMarket({ draft: ready, value: clean(value) });
    } else await check();
    await items.nth(indexes[0]).click({ timeout: 5000 });
    const checkSubmitted = guarantee || field === 'marketSegment';
    await waitForInputState(page, input, { value, display: matches[0].label, trim: true,
      submitted: checkSubmitted }); await check();
    const actual = await input.evaluate((el, includeSubmitted) => {
      const cmp = Ext.getCmp(el.id.replace(/-inputEl$/, ''));
      return { value: cmp?.getValue?.(), display: el.value, ...(includeSubmitted ? { submitted: cmp?.getSubmitData?.()?.[el.name] } : {}) };
    }, checkSubmitted);
    if (clean(actual.value) !== clean(value)) throw new Error('DROPDOWN_READBACK_MISMATCH');
    if (checkSubmitted && (clean(actual.display) !== clean(matches[0].label) || clean(actual.submitted) !== clean(value))) {
      throw new Error('DROPDOWN_READBACK_MISMATCH');
    }
    const profileProofToken = field === 'adults' ? await currentVerifiedLabtestProfileToken(page) : null;
    return { outcome: 'updated_unsaved', field, requested: value, actual,
      ...(profileProofToken ? { profileProofToken } : {}) };
  });
}

async function setCheckbox(page, propertyCode, checked, name, field) {
  if (typeof checked !== 'boolean') return inputGap('CHECKBOX_BOOLEAN_REQUIRED');
  return run(page, propertyCode, {}, async ({ check, mark }) => {
    const input = await uniqueInput(page, name);
    const read = () => input.evaluate((el) => Ext.getCmp(el.id.replace(/-inputEl$/, ''))?.getValue?.());
    const before = await read();
    if (typeof before !== 'boolean') throw new Error('CHECKBOX_UNAVAILABLE');
    if (before !== checked) { await check(); mark(); await input.click({ timeout: 5000 }); }
    await waitForInputState(page, input, { value: checked }); await check();
    const actual = await read();
    if (actual !== checked) throw new Error('CHECKBOX_READBACK_MISMATCH');
    return { outcome: 'updated_unsaved', field, requested: checked, actual };
  });
}

export async function setCmsSendCheckbox(page, { propertyCode, checked } = {}) {
  return setCheckbox(page, propertyCode, checked, 'udfchkbox04', 'cmsSend');
}

export async function setGuestOptInCheckbox(page, { propertyCode, checked } = {}) {
  return setCheckbox(page, propertyCode, checked, 'guestoptin4', 'guestOptIn');
}

export async function setGuestStayChildAges(page, { propertyCode, childAges } = {}) {
  if (!Array.isArray(childAges) || !Array.from(childAges).every((age) => Number.isInteger(age) && age >= 0 && age <= 17)) {
    return inputGap('CHILD_AGES_REQUIRED_OR_INVALID');
  }
  const requested = [...childAges];
  return run(page, propertyCode, { allowed: 'ages', post: 'ages', expectedAges: requested }, async ({ check, mark, allowAgeValidation }) => {
    const countOptions = await comboOptions(await uniqueInput(page, 'children'));
    if (!countOptions.some((option) => clean(option.value) === String(requested.length))) {
      return { outcome: 'unsupported', issue: 'CHILD_COUNT_UNAVAILABLE', requestedChildAges: requested };
    }
    if (await page.locator('.x-window[id^="childagespopup"]:visible').count()) throw new Error('AGE_EDITOR_ALREADY_OPEN');
    const trigger = page.locator('[data-qtip="Enter Child Ages"]:visible');
    if (await trigger.count() !== 1) throw new Error('AGE_EDITOR_UNAVAILABLE');
    await check();
    const opening = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/web/base/OSRESV.HDR.getChildAges', { timeout: 12000 });
    mark();
    const [openResponse] = await Promise.all([opening, trigger.click({ timeout: 5000 })]);
    if (!openResponse.ok()) throw new Error('AGE_READ_FAILED');
    const initial = await openResponse.json();
    if (initial.propertyCode !== propertyCode || initial.reservationStayId !== '' || !Array.isArray(initial.childAges)) {
      throw new Error('AGE_READBACK_INVALID');
    }
    const popup = page.locator('.x-window[id^="childagespopup"]:visible');
    await popup.waitFor({ timeout: 10000 });
    if (await popup.count() !== 1) throw new Error('AGE_EDITOR_NOT_UNIQUE');
    await check();
    const toggle = popup.locator('input[name="updatechildcategories"]');
    if (await toggle.count() !== 1) throw new Error('AGE_EDITOR_UNAVAILABLE');
    const readToggle = () => toggle.evaluate((el) => Ext.getCmp(el.id.replace(/-inputEl$/, ''))?.getValue?.());
    const enabled = await readToggle();
    if (typeof enabled !== 'boolean') throw new Error('AGE_EDITOR_UNAVAILABLE');
    if (!enabled) { await check(); await toggle.click({ timeout: 5000 }); }
    if (await readToggle() !== true) throw new Error('AGE_EDITOR_UNAVAILABLE');
    const count = popup.locator('input[name="children"]');
    if (await count.count() !== 1) throw new Error('CHILD_COUNT_UNAVAILABLE');
    const parseCount = async () => {
      const value = clean(await count.inputValue());
      // A new editor displays a blank spinner for the server's explicit empty age list.
      if (!value && initial.childAges.length === 0) return 0;
      if (!/^\d+$/.test(value)) throw new Error('CHILD_COUNT_UNAVAILABLE');
      return Number(value);
    };
    let current = await parseCount();
    if (requested.length === 0 && current === 0 && initial.childAges.length === 0 && !clean(await count.inputValue())) {
      // A blank spinner does not submit numeric zero; establish it with the native controls.
      for (const [direction, expected] of [['up', 1], ['down', 0]]) {
        const button = count.locator('xpath=ancestor::tr[1]').locator(`.x-spinbox-control.${direction}`);
        await check(); await button.click({ timeout: 5000 });
        await waitForInputState(page, count, { display: String(expected) });
        if (clean(await count.inputValue()) !== String(expected)) throw new Error('CHILD_COUNT_READBACK_MISMATCH');
      }
    }
    while (current !== requested.length) {
      const change = current < requested.length ? 1 : -1;
      const button = count.locator('xpath=ancestor::tr[1]').locator(`.x-spinbox-control.${change === 1 ? 'up' : 'down'}`);
      await check(); await button.click({ timeout: 5000 });
      await waitForInputState(page, count, { display: String(current + change) });
      const updated = await parseCount();
      if (updated !== current + change) throw new Error('CHILD_COUNT_READBACK_MISMATCH');
      current = updated;
    }
    for (let index = 0; index < requested.length; index += 1) {
      const label = popup.getByText(`Age of Child ${index + 1}`, { exact: true });
      await label.waitFor({ timeout: 5000 });
      const row = label.locator('xpath=ancestor::table[contains(@class,"x-form-item")][1]');
      await check(); await row.locator('.x-form-arrow-trigger:visible').click({ timeout: 5000 });
      const items = page.locator('.x-boundlist:visible').last().locator('.x-boundlist-item:visible');
      await items.first().waitFor({ timeout: 5000 });
      const indexes = await items.evaluateAll((nodes, age) => nodes.flatMap((node, i) => node.textContent.trim() === String(age) ? [i] : []), requested[index]);
      if (indexes.length !== 1) throw new Error('AGE_OPTION_NOT_UNIQUE');
      await check(); await items.nth(indexes[0]).click({ timeout: 5000 });
      if (clean(await row.locator('input:visible').inputValue()) !== String(requested[index])) throw new Error('AGE_READBACK_MISMATCH');
    }
    await check();
    allowAgeValidation();
    const validating = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === CHILD_AGE_VALIDATE, { timeout: 12000 });
    const [response] = await Promise.all([validating, popup.locator('a.x-btn:visible').filter({ hasText: /^\s*Apply\s*$/ }).click({ timeout: 5000 })]);
    if (!response.ok()) throw new Error('AGE_VALIDATION_FAILED');
    const native = await response.json();
    if (native.propertyCode !== propertyCode || native.reservationStayId !== '' || native.confirmChildCategory ||
        !Array.isArray(native.childAges) || JSON.stringify([...native.childAges].sort((a, b) => a - b)) !== JSON.stringify([...requested].sort((a, b) => a - b)) ||
        Number(native.childCount) !== requested.length) {
      throw new Error('AGE_VALIDATION_MISMATCH');
    }
    await popup.waitFor({ state: 'hidden', timeout: 10000 });
    const observed = await page.waitForFunction(({ childCount, nativeCounts, activeCount }) => {
      const guest = [...document.querySelectorAll('input[name="guestid"]')].filter(el =>
        (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
      const form = guest.length === 1 ? globalThis.Ext?.getCmp?.(guest[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
      const model = form?.getRecord?.()?.data;
      if (!form?.el?.dom || !model || (activeCount !== null && (!Number.isInteger(activeCount) || activeCount < 0))) return false;
      const statuses = Object.keys(model).filter(key => /^child\d+status$/.test(key));
      if (!statuses.length) return false;
      const names = statuses.filter(key => model[key] === 'ACTIVE').map(key => key.slice(0, -6));
      if (activeCount !== null && names.length !== activeCount) return false;
      const counts = {};
      for (const name of ['children', ...names]) {
        const fields = [...form.el.dom.querySelectorAll('input')].filter(el => el.name === name && !el.closest('.x-window'));
        if (fields.length !== 1 || !Object.hasOwn(model, name)) return false;
        const field = fields[0], cmp = globalThis.Ext?.getCmp?.(field.id.replace(/-inputEl$/, ''));
        const value = cmp?.getValue?.();
        if (cmp?.up?.('form') !== form || !/^\d+$/.test(String(value)) || String(field.value).trim() !== String(value)) return false;
        counts[name] = Number(value);
        if (name !== 'children') {
          const keys = Object.keys(nativeCounts || {}).filter(key => key.toLowerCase() === name);
          if (keys.length > 1 || (keys.length === 1 ? Number(nativeCounts[keys[0]]) !== counts[name] : Number(model[name]) !== counts[name])) return false;
        }
      }
      return counts.children === childCount && names.reduce((sum, name) => sum + counts[name], 0) === childCount
        ? Object.fromEntries(names.map(name => [name, counts[name]])) : false;
    }, { childCount: requested.length, nativeCounts: native.childCategoryCounts,
      activeCount: native.activeChildCategories == null || native.activeChildCategories === '' ? null : Number(native.activeChildCategories) }, { timeout: 5000 });
    const ageBandCounts = await observed.jsonValue();
    await observed.dispose();
    await check();
    const nativeCounts = native.childCategoryCounts;
    const profileProofToken = await currentVerifiedLabtestProfileToken(page);
    return { outcome: 'updated_unsaved', requestedChildAges: requested, actualChildAges: native.childAges,
      previousChildAges: initial.childAges, ageBandCounts, nativeAgeBandCounts: nativeCounts ?? null,
      nativeAgeBandCountsPresent: Object.hasOwn(native, 'childCategoryCounts'),
      ...(profileProofToken ? { profileProofToken } : {}) };
  });
}

async function cmsGrid(win) {
  return win.evaluate((el) => {
    const grid = Ext.getCmp(el.id)?.query('grid,readonlygrid')?.[0];
    const store = grid?.getStore?.();
    if (!store) throw new Error('CMS_GRID_UNAVAILABLE');
    return store.getRange().map((record) => ({ ...record.data }));
  });
}

function cmsResponse(text) {
  const data = parsePickerResponse(text);
  const grid = data.grid?.GRIDRESULT?.GRID;
  if (!Array.isArray(grid?.DATA) || grid.METADATA?.GRIDNAME !== 'LVUDFCD' ||
      grid.DATA.some(row => !Object.hasOwn(row, 'userdefinedfieldvalue') || !Object.hasOwn(row, 'description'))) {
    throw new Error('CMS_RESPONSE_INVALID');
  }
  return grid;
}

function cmsCoverage(metadata, loaded) {
  const marker = String(metadata?.MORERECORDPRESENT ?? '').trim();
  const serverMoreRecords = marker === '+' ? true : marker === '-' ? false : null;
  const reportedTotal = metadata?.RECORDS ?? null;
  const count = /^\d+$/.test(String(reportedTotal)) ? Number(reportedTotal) : null;
  const pageSize = /^\d+$/.test(String(metadata?.CLIENTROWS)) ? Number(metadata.CLIENTROWS) : null;
  const total = count != null && count >= loaded && !(serverMoreRecords && count === loaded) ? count : null;
  const complete = count != null && count < loaded ? null : serverMoreRecords === false &&
    ((total != null && total === loaded) || (pageSize != null && loaded < pageSize)) ? true :
      serverMoreRecords === true || (total != null && total > loaded) ? false : null;
  return { loaded, total, reportedTotal, pageSize, serverMoreRecords, complete, possiblyTruncated: complete !== true };
}

async function waitForCmsRows(page, windowId, expected) {
  const handle = await page.waitForFunction(({ id, expected }) => {
    const records = Ext.getCmp(id)?.query('grid,readonlygrid')?.[0]?.getStore?.()?.getRange?.().map(({ data }) => data);
    const key = row => JSON.stringify(['userdefinedfieldvalue', 'description'].map(name => String(row[name] ?? '').trim()));
    return records && JSON.stringify(records.map(key).sort()) === JSON.stringify(expected.map(key).sort());
  }, { id: windowId, expected }, { timeout: 10000 });
  await handle.dispose();
}

export async function listCmsMessageIds(page, { propertyCode } = {}) {
  return run(page, propertyCode, { allowed: 'cms', post: 'cms' }, async ({ check, mark }) => {
    cmsSearches.delete(page);
    let native = null, unfilteredRequest = false;
    let win = page.locator('.x-window:visible:not(.x-menu)').filter({ hasText: 'CMS Message Id' });
    if (!await win.count()) {
      const input = await uniqueInput(page, 'udfchar09');
      const trigger = input.locator('xpath=ancestor::table[1]').locator('.x-form-trigger:visible').first();
      if (await trigger.count() !== 1) throw new Error('CMS_LOOKUP_UNAVAILABLE');
      await check();
      const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/web/base/LOVPOP', { timeout: 12000 });
      mark();
      const [reply] = await Promise.all([response, trigger.click({ timeout: 5000 })]);
      if (!reply.ok()) throw new Error('CMS_LOOKUP_FAILED');
      const params = new URLSearchParams(reply.request().postData() || '');
      unfilteredRequest = ![...params].some(([key, value]) => key.startsWith('MADDON_FILTER_') && value.trim());
      try { native = cmsResponse(await bounded(reply.text(), 10000, 'CMS_RESPONSE_TIMEOUT')); } catch { /* Coverage remains unknown. */ }
      win = page.locator('.x-window:visible:not(.x-menu)').filter({ hasText: 'CMS Message Id' });
      await win.waitFor({ timeout: 10000 });
    }
    await check();
    if (await win.count() !== 1) throw new Error('CMS_LOOKUP_NOT_UNIQUE');
    const windowId = await win.getAttribute('id');
    if (!windowId) throw new Error('CMS_LOOKUP_NOT_UNIQUE');
    const firstMetadata = native?.METADATA;
    const nativeRows = native?.DATA;
    if (nativeRows) {
      await waitForCmsRows(page, windowId, nativeRows);
      for (let pageNumber = 1; pageNumber < 200 && cmsCoverage(native.METADATA, nativeRows.length).serverMoreRecords === true; pageNumber += 1) {
        const pending = page.waitForResponse(response => {
          const request = response.request(), params = new URLSearchParams(request.postData() || '');
          const target = new URL(request.url());
          return request.method() === 'POST' && target.origin === CLOUD_ORIGIN && target.pathname === '/web/base/GETCACHE' &&
            params.get('GRID_NAME') === 'LVUDFCD';
        }, { timeout: 8000 }).catch(() => null);
        await win.locator('.x-grid-view:visible').last().evaluate(element => { element.scrollTop = element.scrollHeight; });
        const reply = await pending;
        if (!reply) break;
        if (!reply.ok()) throw new Error('CMS_PAGE_UNVERIFIED');
        const next = cmsResponse(await bounded(reply.text(), 10000, 'CMS_RESPONSE_TIMEOUT'));
        if (!next.DATA.length || ['GRIDID', 'GRIDNAME', 'DATASPYID'].some(key =>
          String(next.METADATA[key] ?? '') !== String(firstMetadata[key] ?? ''))) throw new Error('CMS_PAGE_UNVERIFIED');
        nativeRows.push(...next.DATA);
        native = next;
        await waitForCmsRows(page, windowId, nativeRows);
        await check();
      }
    }
    const records = await cmsGrid(win);
    const info = await win.evaluate(el => {
      const footer = el.innerText.match(/Records:\s*(\d+)\s+of\s+(\d+)/i);
      const controls = [...el.querySelectorAll('input')].filter(input =>
        input.name === 'selfiltervaluectrl' || input.name.startsWith('ff_'));
      return { footer: footer ? { loaded: Number(footer[1]), total: Number(footer[2]) } : null,
        filtersClear: controls.length > 0 && controls.every(input => !input.value.trim()),
        filterValuesClear: controls.every(input => !input.value.trim()) };
    });
    const rows = win.locator('.x-grid-view .x-grid-row:visible, .x-grid-view .x-grid-data-row:visible');
    if (!records.length || (!nativeRows && await rows.count() !== records.length)) throw new Error('CMS_GRID_INCOMPLETE');
    const searchId = randomUUID();
    cmsSearches.set(page, { propertyCode, searchId, windowId, records: JSON.stringify(records) });
    const unfiltered = unfilteredRequest && info.filterValuesClear;
    const coverage = nativeRows ? cmsCoverage(native.METADATA, records.length) : {
      loaded: records.length, total: info.footer?.total ?? null,
      complete: info.filtersClear && info.footer?.loaded === records.length && info.footer.total === records.length ? true
        : info.footer && info.footer.total > records.length ? false : null,
      possiblyTruncated: !(info.filtersClear && info.footer?.loaded === records.length && info.footer.total === records.length),
    };
    return { outcome: 'ok', searchId, criteria: { propertyCode, scope: unfiltered || info.filtersClear ? 'unfiltered' : 'filtered_or_unknown' }, candidates: records.map((record) => ({
      code: record.userdefinedfieldvalue ?? null, description: record.description ?? null, nativeData: record,
    })), coverage };
  });
}

export async function selectCmsMessageId(page, { propertyCode, searchId, code } = {}) {
  if (typeof searchId !== 'string' || !searchId || typeof code !== 'string' || !code.trim()) return inputGap('CMS_SELECTION_REQUIRED');
  return run(page, propertyCode, { allowed: 'cms' }, async ({ check, mark }) => {
    const previous = cmsSearches.get(page);
    if (!previous || previous.searchId !== searchId || previous.propertyCode !== propertyCode) throw new Error('CMS_LOOKUP_STALE');
    const win = page.locator('.x-window:visible:not(.x-menu)').filter({ hasText: 'CMS Message Id' });
    if (await win.count() !== 1 || await win.getAttribute('id') !== previous.windowId) throw new Error('CMS_LOOKUP_STALE');
    const records = await cmsGrid(win);
    if (JSON.stringify(records) !== previous.records) throw new Error('CMS_LOOKUP_STALE');
    const indexes = records.flatMap((record, index) => clean(record.userdefinedfieldvalue) === code.trim() ? [index] : []);
    if (indexes.length !== 1) throw new Error('CMS_CODE_NOT_UNIQUE');
    const rows = win.locator('.x-grid-view .x-grid-row:visible, .x-grid-view .x-grid-data-row:visible');
    if (await rows.count() !== records.length) throw new Error('CMS_GRID_INCOMPLETE');
    await check(); cmsSearches.delete(page); mark(); await rows.nth(indexes[0]).click({ timeout: 5000 });
    const selected = await win.evaluate((el) => Ext.getCmp(el.id)?.query('grid,readonlygrid')?.[0]?.getSelectionModel?.()?.getSelection?.().map((record) => record.data.userdefinedfieldvalue));
    if (selected?.length !== 1 || clean(selected[0]) !== code.trim() || JSON.stringify(await cmsGrid(win)) !== previous.records) throw new Error('CMS_SELECTION_CHANGED');
    await check();
    await win.locator('a.x-btn:visible').filter({ hasText: /^\s*OK\s*$/ }).last().click({ timeout: 5000 });
    await win.waitFor({ state: 'hidden', timeout: 10000 });
    const input = await uniqueInput(page, 'udfchar09');
    await waitForInputState(page, input, { display: code.trim(), trim: true }); await check();
    const actual = await input.inputValue();
    if (clean(actual) !== code.trim()) throw new Error('CMS_READBACK_MISMATCH');
    cmsSearches.delete(page);
    return { outcome: 'updated_unsaved', field: 'cmsMessageId', requested: code, actual };
  });
}

/** Close the CMS code picker without selecting a code or changing the draft. */
export async function closeCmsMessageIdPicker(page, { propertyCode } = {}) {
  return run(page, propertyCode, { allowed: 'cms' }, async ({ check, mark }) => {
    const win = page.locator('.x-window:visible:not(.x-menu)').filter({ hasText: 'CMS Message Id' });
    if (!await win.count()) { cmsSearches.delete(page); return { outcome: 'not_open' }; }
    if (await win.count() !== 1) throw new Error('CMS_LOOKUP_NOT_UNIQUE');
    const windowId = await win.getAttribute('id'), previous = cmsSearches.get(page);
    if (!windowId || (previous && (previous.windowId !== windowId || previous.propertyCode !== propertyCode)) ||
        !await win.evaluate((el) => Boolean(Ext.getCmp(el.id)?.query('grid,readonlygrid')?.length))) {
      throw new Error('CMS_LOOKUP_STALE');
    }
    const cancel = win.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ });
    if (await cancel.count() !== 1) throw new Error('CMS_CANCEL_NOT_UNIQUE');
    await check();
    cmsSearches.delete(page);
    mark();
    await cancel.click({ timeout: 5000 });
    await page.waitForFunction((id) => !Ext.getCmp(id)?.isVisible(), windowId, { timeout: 10000 });
    await win.waitFor({ state: 'hidden', timeout: 10000 });
    await check();
    if (await page.locator('.x-window:visible:not(.x-menu)').count()) throw new Error('UNEXPECTED_DIALOG');
    return { outcome: 'closed_unsaved', draftUnchanged: true };
  });
}
