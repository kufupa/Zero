// Small actions on a caller-owned, guarded, blank Guest Stay page.
import { randomUUID } from 'node:crypto';
import { installPageRequestFence } from './page-request-fence.mjs';
import { isVerifiedArSelectionCurrent, verifiedArSelectionToken } from './lookup.mjs';
import { isVerifiedLabtestProfile, isVerifiedLabtestProfileCurrent, verifiedLabtestProfileToken } from './guest-profile.mjs';

const CLOUD_ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const TEXT_FIELDS = {
  firstName: 'firstname', lastName: 'lastname', bookerName: 'caller', bookerContact: 'udfchar06',
  reservationNote: 'reservationnote', guestEmail: 'emailaddress', cmsRecipient: 'udfchar13',
};
const DATE_FIELDS = { arrivalDate: 'arrivaldate', departureDate: 'departuredate' };
const COMBOS = { adults: 'adults', reasonForStay: 'reasonforstay', guaranteeType: 'guaranteetype' };
const DANGEROUS_PATH = /save|delete|cancel|duplicate|checkin|checkout|send|crs/i;
const CHILD_AGE_VALIDATE = '/web/base/OSRESV.HDR.validateChildAgeDetails';
const GUARANTEE_CHANGE = '/web/base/OSRESV.HDR.changeguaranteemethod';
const GUARANTEE_BLANK_IDS = ['reservationshareid', 'guestid', 'reservationstayid', 'guaranteecardprofileid', 'arprofileid',
  'guestnameinfoid', 'externalprofileid', 'guestfoliocomptempresstayid', 'gueststaycouponids', 'additionalprofileids',
  'reservationid', 'addlplayerprofileid', 'sourceprofileid', 'recordid'];
const busyPages = new WeakSet();
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
    return [...root.querySelectorAll('input,textarea,select')].filter((el) => visible(el) && !['hidden', 'password'].includes(el.type)).map((el) => {
      const cmp = el.id && globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      const checkbox = cmp?.getXType?.() === 'checkboxfield' || el.type === 'checkbox';
      return {
        id: el.id || null, name: el.name || null,
        label: el.closest('.x-form-item,.x-field')?.querySelector('label')?.innerText?.trim() || cmp?.getFieldLabel?.() || cmp?.boxLabel || null,
        type: el.type || el.tagName.toLowerCase(), value: checkbox ? (cmp?.getValue?.() ?? el.checked) : el.value,
        disabled: el.disabled, readOnly: Boolean(el.readOnly),
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
    ({ cmsSend: 'udfchkbox04', cmsMessageId: 'udfchar09' })[result.field];
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
  if (kind !== 'ages' || !['/web/base/OSRESV.HDR.getChildAges', '/web/base/OSRESV.HDR.validateChildAgeDetails'].includes(url.pathname)) return false;
  try {
    if (body.getAll('params').length !== 1 || body.getAll('ONLY_DATA_REQUIRED').length !== 1 || body.get('ONLY_DATA_REQUIRED') !== 'true' ||
        [...body.keys()].some((key) => !['params', 'ONLY_DATA_REQUIRED'].includes(key))) return false;
    const params = JSON.parse(body.get('params'));
    const isRead = url.pathname.endsWith('.getChildAges');
    const keys = isRead ? ['propertyCode', 'reservationStayId', 'childAges'] : [
      'propertyCode', 'reservationStayId', 'childAges', 'adultCount', 'childCount', 'updateChildCategories',
      'activeChildCategories', 'confirmChildCategory', 'childCategoryCounts',
    ];
    if (Object.keys(params).length !== keys.length || keys.some((key) => !Object.hasOwn(params, key))) return false;
    if (params.propertyCode !== propertyCode || params.reservationStayId !== '' || !Array.isArray(params.childAges) ||
        !params.childAges.every((age) => Number.isInteger(age) && age >= 0 && age <= 17)) return false;
    return isRead || (JSON.stringify(params.childAges) === JSON.stringify(expectedAges) &&
      /^\d+$/.test(String(params.childCount)) && Number(params.childCount) === expectedAges.length && params.updateChildCategories === true);
  } catch { return false; }
}

function wireDate(value) {
  const match = /^(\d{2})-([A-Z]{3})-(\d{4})$/i.exec(clean(value));
  if (!match) return null;
  const day = Number(match[1]), month = MONTHS.indexOf(match[2].toUpperCase()) + 1, year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2027 || !month || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { iso: `${year}-${String(month).padStart(2, '0')}-${match[1]}`,
    wire: `${String(month).padStart(2, '0')}/${match[1]}/${year}` };
}

// The current form's record holds the session ID even though it is not a form input.
async function guaranteeDraft(page, propertyCode) {
  if (propertyCode !== 'HRCEN') return null;
  const state = await page.evaluate(({ origin, blankIds }) => {
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
    if (!data || !exact('propertycode', 'HRCEN') || !exact('PKID', '@[EMPTY]#@[EMPTY]#HRCEN#') || !exact('status', 'New') ||
        !blankIds.filter((key) => key !== 'arprofileid' && key !== 'guestid').every((key) => exact(key, '')) ||
        !unique('arprofileid') || !unique('guestid') ||
        keys.filter((key) => key.toLowerCase() === 'araccountid').length > 1 ||
        !unique('bookingsessionid') || !String(data.bookingsessionid ?? '').trim() ||
        typeof guest?.getValue !== 'function' || String(guest.getValue() ?? '').trim() !== String(data.guestid ?? '').trim() ||
        fields.guestid[0].value.trim() !== String(data.guestid ?? '').trim() ||
        fields.confirmationnumber[0].value.trim() || fields.firstname[0].value !== 'Proof' || fields.lastname[0].value !== 'Labtest') return null;
    const profileId = String(data.arprofileid ?? '').trim();
    const accountId = unique('araccountid') ? String(data.araccountid ?? '').trim() : '';
    const guestId = String(data.guestid ?? '').trim();
    if (Boolean(profileId) !== Boolean(accountId) || (guestId && profileId)) return null;
    return { session: String(data.bookingsessionid), arrival: fields.arrivaldate[0].value, departure: fields.departuredate[0].value,
      guestId, ar: profileId ? { accountId, profileId } : null };
  }, { origin: CLOUD_ORIGIN, blankIds: GUARANTEE_BLANK_IDS });
  if (!state) return null;
  const arrival = wireDate(state.arrival), departure = wireDate(state.departure);
  if (!arrival || !departure || arrival.iso >= departure.iso) return null;
  const identity = state.ar && { session: state.session, ...state.ar };
  const token = identity && await verifiedArSelectionToken(page, identity);
  if (identity && !token) return null;
  let guest = null;
  if (state.guestId) {
    if (!isVerifiedLabtestProfile(page, state.guestId)) return null;
    const guestToken = await verifiedLabtestProfileToken(page, { nativeId: state.guestId, session: state.session });
    if (!guestToken) return null;
    guest = { nativeId: state.guestId, token: guestToken };
  }
  return { session: state.session, arrival, departure, ar: identity ? { ...state.ar, token } : null, guest };
}

function guaranteeRequest(page, request, expected) {
  try {
    const ar = expected.draft.ar;
    const guest = expected.draft.guest;
    if (ar && !isVerifiedArSelectionCurrent(page, { session: expected.draft.session, ...ar })) return false;
    if (guest && !isVerifiedLabtestProfileCurrent(page, { session: expected.draft.session, ...guest })) return false;
    const url = new URL(request.url());
    if (request.method() !== 'POST' || url.origin !== CLOUD_ORIGIN || url.pathname !== GUARANTEE_CHANGE || url.search || url.hash ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '')) return false;
    const body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
    const fields = {
      propertycode: 'HRCEN', PKID: '@[EMPTY]#@[EMPTY]#HRCEN#', status: 'New', firstname: 'Proof', lastname: 'Labtest',
      arrivaldate: expected.draft.arrival.wire, departuredate: expected.draft.departure.wire, guaranteetype: expected.value,
      ONLY_DATA_REQUIRED: 'true', bookingsessionid: expected.draft.session,
      confirmationnumber: '', guaranteecreditcardid: '', leaseguaranteecreditcardid: '',
      newprofileclick: '', linkprofileflag: '', savecctoprofile: '0', createinactiveprofileflag: '0', reqguestprofilelookup: '',
      pagemode: 'display', isafterreservationsave: '', savesettlementcctoprofile: '0', linkedprofileflag: '0',
      ...Object.fromEntries(GUARANTEE_BLANK_IDS.map((key) => [key, ''])),
      ...(ar ? { araccountid: ar.accountId, arprofileid: ar.profileId } : {}),
      ...(guest ? { guestid: guest.nativeId } : {}),
    };
    return new Set(keys).size === keys.length && Object.entries(fields).every(([key, value]) => body.getAll(key).length === 1 &&
      body.get(key) === value && keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1) &&
      !keys.some((key) => /(?:guest|profile|reservation|record|stay).*id/i.test(key) && !/^is/i.test(key) &&
        !(ar && key === 'arprofileid') && !(guest && key === 'guestid') && clean(body.get(key))) &&
      !(!ar && keys.some((key) => key.toLowerCase() === 'araccountid' && clean(body.get(key))));
  } catch { return false; }
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
  const fields = { propertycode: 'HRCEN', status: 'New', firstname: 'Proof', lastname: 'Labtest',
    arrivaldate: expected.draft.arrival.wire, departuredate: expected.draft.departure.wire,
    guaranteetype: expected.value, bookingsessionid: expected.draft.session, confirmationnumber: '',
    guaranteecreditcardid: '', leaseguaranteecreditcardid: '', ...Object.fromEntries(GUARANTEE_BLANK_IDS.map((key) => [key, ''])),
    ...(ar ? { araccountid: ar.accountId, arprofileid: ar.profileId } : {}),
    ...(guest ? { guestid: guest.nativeId } : {}) };
  if (!values || !Object.entries(fields).every(([key, value]) => Object.hasOwn(values, key) && clean(values[key]) === value &&
      Object.keys(values).filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1) ||
      Object.keys(values || {}).some((key) => /(?:guest|profile|reservation|record|stay).*id/i.test(key) && !/^is/i.test(key) &&
        !(ar && key === 'arprofileid') && !(guest && key === 'guestid') && clean(values[key])) ||
      (!ar && Object.keys(values || {}).some((key) => key.toLowerCase() === 'araccountid' && clean(values[key])))) {
    throw new Error('GUARANTEE_RESPONSE_UNVERIFIED');
  }
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

async function run(page, propertyCode, { allowed = null, post = null, expectedAges = null, guaranteeFence = false } = {}, operation) {
  if (typeof propertyCode !== 'string' || !/^[A-Z0-9]+$/.test(propertyCode)) return inputGap('PROPERTY_CODE_REQUIRED');
  if (!page || typeof page.route !== 'function' || typeof page.evaluate !== 'function') return inputGap('PAGE_REQUIRED');
  if (busyPages.has(page)) return { outcome: 'execution_failure', issue: 'ACTION_IN_PROGRESS' };
  busyPages.add(page);
  let attempted = false, nativeDialog = false, before = null, blocked = [], active = true;
  let fence = null, approval = null, ageValidationReady = false, ageValidationCount = 0;
  let guaranteeExpected = null, guaranteeApproved = null, rejectDialog;
  const guaranteeResponses = [];
  const dialogPromise = new Promise((_, reject) => { rejectDialog = reject; });
  const onDialog = () => { nativeDialog = true; if (post === 'guarantee') rejectDialog(new Error('UNEXPECTED_DIALOG')); };
  const onResponse = (response) => { if (response.request() === guaranteeApproved) guaranteeResponses.push(response); };
  const ensureActive = () => { if (!active) throw new Error('ACTION_EXPIRED'); };
  const guard = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const safeRead = ['GET', 'HEAD', 'OPTIONS'].includes(method) && !DANGEROUS_PATH.test(url.pathname);
    let allowed = method === 'POST' && post && allowedPost(request, CLOUD_ORIGIN, propertyCode, post, expectedAges);
    if (post === 'guarantee' && method === 'POST' && url.pathname === GUARANTEE_CHANGE && guaranteeExpected &&
        guaranteeRequest(page, request, guaranteeExpected)) {
      const { guest, session } = guaranteeExpected.draft;
      let current = true;
      if (guest) {
        try {
          const token = await bounded(verifiedLabtestProfileToken(page, { nativeId: guest.nativeId, session }), 2000, 'GUEST_PROOF_TIMEOUT');
          current = token === guest.token && isVerifiedLabtestProfileCurrent(page, { session, ...guest });
        } catch { current = false; }
      }
      if (active && current && !guaranteeApproved && approval?.allow(request)) { guaranteeApproved = request; allowed = true; }
      else if (active) fence?.quarantine();
    }
    const ageValidation = method === 'POST' && url.pathname === CHILD_AGE_VALIDATE;
    if ((!safeRead && !allowed) || (ageValidation &&
        (!ageValidationReady || ageValidationCount !== 0 || !approval?.allow(request)))) {
      if (post === 'guarantee' && attempted) fence?.quarantine();
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
  if (post === 'guarantee') page.on('response', onResponse);
  try {
    const execute = async () => {
      await check();
      before = await readFields(page); ensureActive();
      const paths = [...(post === 'ages' ? [CHILD_AGE_VALIDATE] : []),
        ...(post === 'guarantee' || guaranteeFence ? [GUARANTEE_CHANGE] : [])];
      if (paths.length) {
        fence = await installPageRequestFence(page, paths); ensureActive();
        if (post === 'ages' || post === 'guarantee') approval = fence.open();
      }
      await page.route('**/*', guard);
      if (!active) { await page.unroute('**/*', guard).catch(() => {}); throw new Error('ACTION_EXPIRED'); }
      const result = await operation({ check, mark: () => { ensureActive(); attempted = true; },
        allowAgeValidation: () => { ensureActive(); ageValidationReady = true; },
        allowGuarantee: (expected) => { ensureActive(); guaranteeExpected = expected; } });
      ensureActive();
      if (post === 'guarantee' && result.outcome === 'updated_unsaved') {
        const deadline = Date.now() + 10000;
        while (!guaranteeResponses.length && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100)); ensureActive();
        }
        if (!guaranteeApproved || guaranteeResponses.length !== 1) throw new Error('GUARANTEE_RESPONSE_UNVERIFIED');
        await page.waitForFunction(() => !Ext.Ajax.isLoading(), null, { timeout: 10000 }); ensureActive();
      }
      await page.waitForTimeout(1000);
      await check();
      const after = await readFields(page); ensureActive();
      await verifySettled(page, result, after); ensureActive();
      if (post === 'guarantee' && result.outcome === 'updated_unsaved') {
        const current = await guaranteeDraft(page, propertyCode); ensureActive();
        if (JSON.stringify(current) !== JSON.stringify(guaranteeExpected?.draft)) throw new Error('GUARANTEE_DRAFT_CHANGED');
        await verifyGuaranteeResponse(guaranteeResponses[0], guaranteeExpected); ensureActive();
        await check();
      }
      const changedFields = changes(before, after);
      if (result.outcome === 'closed_unsaved' && changedFields.length) throw new Error('CMS_CANCEL_FORM_CHANGED');
      return { ...result, changedFields };
    };
    return post === 'guarantee' ? await bounded(Promise.race([execute(), dialogPromise]), 30000, 'GUARANTEE_ACTION_TIMEOUT') : await execute();
  } catch (error) {
    active = false;
    if (attempted && fence) fence.quarantine();
    let observed;
    if (!nativeDialog) {
      try {
        const readback = async () => { await assertForm(page, propertyCode); return readFields(page); };
        observed = post === 'guarantee' ? await bounded(readback(), 5000, 'GUARANTEE_READBACK_TIMEOUT') : await readback();
      } catch { /* No safe readback. */ }
    }
    return { outcome: attempted ? 'action_uncertain' : 'execution_failure',
      issue: blocked.length ? 'UNEXPECTED_REQUEST_BLOCKED' : nativeDialog ? 'UNEXPECTED_DIALOG' : safeIssue(error),
      ...(blocked.length ? { blockedRequests: blocked } : {}), ...(observed && before ? { changedFields: changes(before, observed) } : {}) };
  } finally {
    active = false;
    approval?.close();
    await page.unroute('**/*', guard).catch(() => {});
    page.off('dialog', onDialog);
    if (post === 'guarantee') page.off('response', onResponse);
    busyPages.delete(page);
  }
}

async function uniqueInput(page, name) {
  const field = page.locator(`input[name="${name}"]:visible, textarea[name="${name}"]:visible`);
  if (await field.count() !== 1) throw new Error('FIELD_NOT_UNIQUE');
  return field;
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
    await page.waitForTimeout(500); await check();
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
    await page.waitForTimeout(500); await check();
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
  return run(page, propertyCode, { guaranteeFence: field === 'guaranteeType' }, async ({ check, mark }) => {
    const input = await uniqueInput(page, COMBOS[field]);
    await check(); mark();
    await openCombo(page, input);
    const options = await comboOptions(input);
    await page.keyboard.press('Escape');
    await check();
    return { outcome: 'ok', field, options, coverage: { loaded: options.length, total: null, complete: null } };
  });
}

export async function selectGuestStayDropdown(page, { propertyCode, field, value } = {}) {
  if (!Object.hasOwn(COMBOS, field || '')) return inputGap('DROPDOWN_FIELD_UNSUPPORTED');
  if (!['string', 'number'].includes(typeof value) || clean(value) === '') return inputGap('DROPDOWN_VALUE_REQUIRED');
  if (field === 'adults' && (!Number.isInteger(value) || value < 0)) return inputGap('ADULT_COUNT_INVALID');
  const guarantee = field === 'guaranteeType';
  return run(page, propertyCode, { post: guarantee ? 'guarantee' : null }, async ({ check, mark, allowGuarantee }) => {
    const draft = guarantee ? await guaranteeDraft(page, propertyCode) : null;
    if (guarantee && !draft) return { outcome: 'unsupported', issue: 'GUARANTEE_DRAFT_UNSUPPORTED', field, requested: value };
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
      const ready = await guaranteeDraft(page, propertyCode);
      if (!ready || JSON.stringify(ready) !== JSON.stringify(draft)) throw new Error('GUARANTEE_DRAFT_CHANGED');
      if (clean(existing.value) === clean(value)) {
        if (clean(existing.display) !== clean(matches[0].label) || clean(existing.submitted) !== clean(value)) {
          throw new Error('DROPDOWN_READBACK_MISMATCH');
        }
        await check(); await page.keyboard.press('Escape'); await check();
        return { outcome: 'unchanged_unsaved', field, requested: value, actual: existing };
      }
      allowGuarantee({ draft: ready, value: clean(value) });
    } else await check();
    await items.nth(indexes[0]).click({ timeout: 5000 });
    await page.waitForTimeout(500); await check();
    const actual = await input.evaluate((el, includeSubmitted) => {
      const cmp = Ext.getCmp(el.id.replace(/-inputEl$/, ''));
      return { value: cmp?.getValue?.(), display: el.value, ...(includeSubmitted ? { submitted: cmp?.getSubmitData?.()?.guaranteetype } : {}) };
    }, guarantee);
    if (clean(actual.value) !== clean(value)) throw new Error('DROPDOWN_READBACK_MISMATCH');
    if (guarantee && (clean(actual.display) !== clean(matches[0].label) || clean(actual.submitted) !== clean(value))) {
      throw new Error('DROPDOWN_READBACK_MISMATCH');
    }
    return { outcome: 'updated_unsaved', field, requested: value, actual };
  });
}

export async function setCmsSendCheckbox(page, { propertyCode, checked } = {}) {
  if (typeof checked !== 'boolean') return inputGap('CMS_SEND_BOOLEAN_REQUIRED');
  return run(page, propertyCode, {}, async ({ check, mark }) => {
    const input = await uniqueInput(page, 'udfchkbox04');
    const read = () => input.evaluate((el) => Ext.getCmp(el.id.replace(/-inputEl$/, ''))?.getValue?.());
    const before = await read();
    if (typeof before !== 'boolean') throw new Error('CHECKBOX_UNAVAILABLE');
    if (before !== checked) { await check(); mark(); await input.click({ timeout: 5000 }); }
    await page.waitForTimeout(500); await check();
    const actual = await read();
    if (actual !== checked) throw new Error('CHECKBOX_READBACK_MISMATCH');
    return { outcome: 'updated_unsaved', field: 'cmsSend', requested: checked, actual };
  });
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
        await page.waitForTimeout(100);
        if (clean(await count.inputValue()) !== String(expected)) throw new Error('CHILD_COUNT_READBACK_MISMATCH');
      }
    }
    while (current !== requested.length) {
      const change = current < requested.length ? 1 : -1;
      const button = count.locator('xpath=ancestor::tr[1]').locator(`.x-spinbox-control.${change === 1 ? 'up' : 'down'}`);
      await check(); await button.click({ timeout: 5000 });
      await page.waitForTimeout(100);
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
        JSON.stringify(native.childAges) !== JSON.stringify(requested) || Number(native.childCount) !== requested.length) {
      throw new Error('AGE_VALIDATION_MISMATCH');
    }
    await popup.waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForTimeout(500); await check();
    const counts = {};
    for (const name of ['children', 'child1', 'child2', 'child3']) counts[name] = clean(await (await uniqueInput(page, name)).inputValue());
    const names = ['child1', 'child2', 'child3'];
    const nativeCounts = native.childCategoryCounts;
    const ageBandCounts = Object.fromEntries(names.map((name) => [name, /^\d+$/.test(counts[name]) ? Number(counts[name]) : null]));
    const emptyNativeCounts = nativeCounts == null && requested.length === 0;
    if ((!emptyNativeCounts && (!nativeCounts || typeof nativeCounts !== 'object')) || counts.children !== String(requested.length) ||
        names.some((name) => {
          const reported = nativeCounts?.[name] ?? nativeCounts?.[name.toUpperCase()];
          return ageBandCounts[name] === null || (reported === undefined ? ageBandCounts[name] !== 0 : reported !== ageBandCounts[name]);
        }) || names.reduce((sum, name) => sum + ageBandCounts[name], 0) !== requested.length) {
      throw new Error('CHILD_COUNT_READBACK_MISMATCH');
    }
    return { outcome: 'updated_unsaved', requestedChildAges: requested, actualChildAges: native.childAges,
      previousChildAges: initial.childAges, ageBandCounts, nativeAgeBandCounts: nativeCounts ?? null,
      nativeAgeBandCountsPresent: Object.hasOwn(native, 'childCategoryCounts') };
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

export async function listCmsMessageIds(page, { propertyCode } = {}) {
  return run(page, propertyCode, { allowed: 'cms', post: 'cms' }, async ({ check, mark }) => {
    cmsSearches.delete(page);
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
      win = page.locator('.x-window:visible:not(.x-menu)').filter({ hasText: 'CMS Message Id' });
      await win.waitFor({ timeout: 10000 });
    }
    await check();
    if (await win.count() !== 1) throw new Error('CMS_LOOKUP_NOT_UNIQUE');
    const records = await cmsGrid(win);
    const rows = win.locator('.x-grid-view .x-grid-row:visible, .x-grid-view .x-grid-data-row:visible');
    if (!records.length || await rows.count() !== records.length) throw new Error('CMS_GRID_INCOMPLETE');
    const searchId = randomUUID();
    cmsSearches.set(page, { propertyCode, searchId, windowId: await win.getAttribute('id'), records: JSON.stringify(records) });
    return { outcome: 'ok', searchId, candidates: records.map((record) => ({
      code: record.userdefinedfieldvalue ?? null, description: record.description ?? null, nativeData: record,
    })), coverage: { loaded: records.length, total: null, complete: null } };
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
    await page.waitForTimeout(500); await check();
    const actual = await (await uniqueInput(page, 'udfchar09')).inputValue();
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
