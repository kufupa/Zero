// Select a current rate code on a verified new HRCEN Guest Stay.
import { createHash } from 'node:crypto';
import { searchRatePlans, closeRoomRatePicker } from './guest-stay-room-rate.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';
import { isVerifiedLabtestProfileCurrent, verifiedLabtestProfileToken } from './guest-profile.mjs';
import { isVerifiedArSelectionCurrent, verifiedArSelectionToken } from './lookup.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const PROPERTY = 'HRCEN';
const VALIDATE = '/web/base/fieldvalidate';
const CHANGE = '/web/base/OSRESV.HDR.rateplanchange';
const ASSET = '/web/resources/inforhms/images/toolbar/add-ons.svg';
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const busy = new WeakSet();
const selectedOnPage = new WeakMap();
const BLANK_DRAFT_IDS = ['reservationshareid','reservationstayid','guaranteecardprofileid','arprofileid',
  'guestnameinfoid','externalprofileid','guestfoliocomptempresstayid','gueststaycouponids','additionalprofileids',
  'reservationid','addlplayerprofileid','sourceprofileid','recordid'];
const fingerprint = fields => createHash('sha256').update(JSON.stringify(fields)).digest('hex');
const clean = value => String(value ?? '').trim();
const safeIssue = error => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'RATE_SELECTION_FAILED';

function dateParts(value) {
  const match = /^(\d{2})-([A-Z]{3})-(\d{4})$/i.exec(clean(value));
  if (!match) return null;
  const day = Number(match[1]), month = MONTHS.indexOf(match[2].toUpperCase()) + 1, year = Number(match[3]);
  const actual = new Date(Date.UTC(year,month - 1,day));
  if (!month || actual.getUTCFullYear() !== year || actual.getUTCMonth() !== month - 1 || actual.getUTCDate() !== day) return null;
  return {iso:`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,
    wire:`${String(month).padStart(2,'0')}/${String(day).padStart(2,'0')}/${year}`};
}

async function readDraft(page) {
  return page.evaluate(({ expectedOrigin, blankIds }) => {
    if (location.origin !== expectedOrigin) throw new Error('HMS_ORIGIN_MISMATCH');
    const visible = element => Boolean((element.offsetWidth || element.offsetHeight) &&
      getComputedStyle(element).visibility !== 'hidden' && !element.closest('.x-window'));
    const named = name => [...document.querySelectorAll(`input[name="${name}"]`)].filter(visible);
    const one = name => { const elements=named(name); if (elements.length !== 1) throw new Error('DRAFT_FIELD_UNAVAILABLE'); return elements[0]; };
    const props = [...document.querySelectorAll('[data-qtip="Property"]')].filter(visible);
    const confirmation = one('confirmationnumber'), agency = one('ta1'), rate = one('rateplan');
    const arAccount = one('araccountname'), guarantee = one('guaranteetype');
    const first = one('firstname'), last = one('lastname'), arrival = one('arrivaldate'), departure = one('departuredate');
    const guestIds = named('guestid');
    if (guestIds.length !== 1) throw new Error('GUEST_PROFILE_ID_UNSUPPORTED');
    const guestId = guestIds[0], guestCmp = guestId.id && globalThis.Ext?.getCmp?.(guestId.id.replace(/-inputEl$/, ''));
    if (!guestCmp || typeof guestCmp.getValue !== 'function') throw new Error('GUEST_PROFILE_ID_UNSUPPORTED');
    let root = agency;
    while (root && !root.contains(confirmation)) root = root.parentElement;
    if (!root) throw new Error('DRAFT_UNAVAILABLE');
    if (!root.contains(guestId)) throw new Error('GUEST_PROFILE_ID_UNSUPPORTED');
    const cmp = rate.id && globalThis.Ext?.getCmp?.(rate.id.replace(/-inputEl$/, ''));
    const component = element => element.id && globalThis.Ext?.getCmp?.(element.id.replace(/-inputEl$/, ''));
    const arCmp = component(arAccount), form = component(guarantee)?.up?.('form');
    const bound = form?.el?.dom && [confirmation,agency,rate,arAccount,guarantee,first,last,arrival,departure,guestId]
      .every(element => form.el.dom.contains(element) && component(element)?.up?.('form') === form);
    const data = bound && form.getRecord?.()?.data, keys = data && Object.keys(data);
    const unique = key => keys && Object.hasOwn(data,key) && keys.filter(name => name.toLowerCase() === key.toLowerCase()).length === 1;
    const value = key => unique(key) ? String(data[key] ?? '').trim() : null;
    const exact = (key,expected) => unique(key) && value(key) === expected;
    const accountKeys = keys?.filter(key => key.toLowerCase() === 'araccountid') || [];
    const identity = data ? {
      valid:exact('propertycode','HRCEN') && exact('PKID','@[EMPTY]#@[EMPTY]#HRCEN#') && exact('status','New') &&
        exact('confirmationnumber','') && unique('guestid') && unique('arprofileid') && accountKeys.length <= 1 &&
        unique('bookingsessionid') && Boolean(value('bookingsessionid')) &&
        blankIds.filter(key => key !== 'arprofileid').every(key => exact(key,'')) &&
        !keys.some(key => /(?:guest|profile|reservation|record|stay).*id/i.test(key) && !/^is/i.test(key) &&
          !['guestid','arprofileid'].includes(key) && String(data[key] ?? '').trim()),
      session:value('bookingsessionid'),guestId:value('guestid'),arAccountId:value('araccountid') || '',
      arProfileId:value('arprofileid'),arAccountName:value('araccountname'),
    } : null;
    let submit = null;
    try { submit = cmp?.getSubmitData?.() || null; } catch { /* Fail the readback if unavailable. */ }
    const windows = [...document.querySelectorAll('.x-window:not(.x-menu)')].filter(element =>
      Boolean((element.offsetWidth || element.offsetHeight) && getComputedStyle(element).visibility !== 'hidden'));
    return {property:props.length === 1 ? props[0].textContent.trim() : null, confirmation:confirmation.value,
      first:first.value,last:last.value,guestId:guestId.value,guestNativeId:guestCmp.getValue(),arrival:arrival.value,departure:departure.value,rate:rate.value,
      arAccountName:arAccount.value,arAccountNativeName:arCmp?.getValue?.() ?? null,identity,
      rateValue:cmp?.getValue?.() ?? null,rateSubmit:submit?.rateplan ?? null,rateErrors:cmp?.getActiveErrors?.() || [],
      rateInvalid:rate.getAttribute('aria-invalid'),windows:windows.length,
      fields:[...root.querySelectorAll('input,textarea,select')].filter(element => visible(element) && !['hidden','password'].includes(element.type))
        .map(element => ({id:element.id || null,name:element.name || null,
          label:element.closest('.x-form-item,.x-field')?.querySelector('label')?.innerText?.trim() || null,
          type:element.type || element.tagName.toLowerCase(),
          value:['checkbox','radio'].includes(element.type) ? element.checked : element.value,
          disabled:element.disabled,readOnly:Boolean(element.readOnly)}))};
  },{expectedOrigin:ORIGIN,blankIds:BLANK_DRAFT_IDS});
}

async function checkedDraft(draft, guestId, page) {
  if (clean(draft.guestId) !== guestId || clean(draft.guestNativeId) !== guestId) throw new Error('GUEST_PROFILE_ID_UNSUPPORTED');
  const arrival = dateParts(draft.arrival), departure = dateParts(draft.departure);
  if (draft.property !== PROPERTY || clean(draft.confirmation) || draft.windows || !arrival || !departure || arrival.iso >= departure.iso) {
    throw new Error('NEW_DRAFT_UNVERIFIED');
  }
  const identity = draft.identity;
  const hasAr = Boolean(clean(draft.arAccountName) || identity?.arAccountId || identity?.arProfileId);
  const issue = hasAr ? 'AR_SELECTION_UNVERIFIED' : 'GUEST_PROFILE_ID_UNSUPPORTED';
  if ((hasAr || guestId) && (!identity?.valid || identity.guestId !== guestId ||
      clean(draft.first) !== 'Proof' || clean(draft.last) !== 'Labtest' || arrival.iso < '2027-01-01')) throw new Error(issue);
  let guest = null, ar = null;
  if (guestId) {
    const token = await verifiedLabtestProfileToken(page,{nativeId:guestId,session:identity.session});
    if (!token) throw new Error('GUEST_PROFILE_ID_UNSUPPORTED');
    guest = {nativeId:guestId,token};
  }
  if (hasAr) {
    const {session,arAccountId:accountId,arProfileId:profileId,arAccountName} = identity;
    const sameName = name => clean(name).toLocaleLowerCase() === clean(draft.arAccountName).toLocaleLowerCase();
    if (!accountId || !profileId || !clean(draft.arAccountName) || !sameName(draft.arAccountNativeName) ||
        !sameName(arAccountName)) throw new Error('AR_SELECTION_UNVERIFIED');
    const token = await verifiedArSelectionToken(page,{session,accountId,profileId});
    if (!token) throw new Error('AR_SELECTION_UNVERIFIED');
    ar = {accountId,profileId,token};
  }
  return {arrival,departure,session:guest || ar ? identity.session : null,guest,ar};
}
function proofsCurrent(page, proof) {
  return (!proof.guest || isVerifiedLabtestProfileCurrent(page,{session:proof.session,...proof.guest})) &&
    (!proof.ar || isVerifiedArSelectionCurrent(page,{session:proof.session,...proof.ar}));
}
const draftFingerprint = draft => fingerprint([draft.fields,draft.identity]);
function changedFields(before, after) {
  const key = (field,index) => field.id || `${field.name || ''}:${index}`;
  const a = new Map(before.map((field,index) => [key(field,index),field]));
  const b = new Map(after.map((field,index) => [key(field,index),field]));
  return [...new Set([...a.keys(),...b.keys()])].flatMap(id => {
    const old = a.get(id) ?? null, current = b.get(id) ?? null;
    return JSON.stringify(old) === JSON.stringify(current) ? [] : [{before:old,after:current}];
  });
}

function requestUrl(request, path) {
  try {
    const url = new URL(request.url());
    return request.method() === 'POST' && url.origin === ORIGIN && url.pathname === path && !url.search && !url.hash &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '');
  } catch { return false; }
}
function validationRequest(request, code, dates) {
  if (!requestUrl(request,VALIDATE)) return false;
  const body = new URLSearchParams(request.postData() || '');
  const expected = {
    GRID_NAME:'LVRATEPLANS2',GRID_TYPE:'LOV',REQUEST_TYPE:'LOV.HEAD_DATA.STORED',LOV_TAGNAME:'rateplan',
    RUN_DS:'false',USER_FUNCTION_NAME:'OSRESV',CURRENT_TAB_NAME:'HDR',
    LOV_ALIAS_NAME_1:'param.propertycode',LOV_ALIAS_VALUE_1:PROPERTY,LOV_ALIAS_TYPE_1:'text',
    LOV_ALIAS_NAME_2:'param.arrivaldate',LOV_ALIAS_VALUE_2:dates.arrival.wire,LOV_ALIAS_TYPE_2:'date',
    LOV_ALIAS_NAME_3:'param.departuredate',LOV_ALIAS_VALUE_3:dates.departure.wire,LOV_ALIAS_TYPE_3:'date',
    filterfields:'rateplancode',filteroperator:'=',filtervalue:code,
  };
  return [...body.keys()].length === Object.keys(expected).length &&
    Object.entries(expected).every(([key,value]) => body.getAll(key).length === 1 && body.get(key) === value);
}
function draftIdIssue(request, guestId, ar) {
  if (!requestUrl(request,CHANGE)) return null;
  const body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
  const exact = (key,value) => body.getAll(key).length === 1 && body.get(key) === value &&
    keys.filter(name => name.toLowerCase() === key.toLowerCase()).length === 1;
  const accountKeys = keys.filter(key => key.toLowerCase() === 'araccountid');
  if (body.getAll('guestid').length !== 1 || body.get('guestid') !== guestId ||
      keys.filter(key => key.toLowerCase() === 'guestid').length !== 1 ||
      !BLANK_DRAFT_IDS.every(key => exact(key,key === 'arprofileid' && ar ? ar.profileId : '')) ||
      (ar ? !exact('araccountid',ar.accountId) : accountKeys.length > 1 || accountKeys.some(key => clean(body.get(key))))) {
    return 'DRAFT_ID_UNSUPPORTED';
  }
  if (keys.filter(key => /(?:guest|profile|reservation|record|stay).*id/i.test(key) &&
      !/^is/i.test(key) && key !== 'guestid' && !(ar && key === 'arprofileid')).some(key => clean(body.get(key)))) {
    return 'DRAFT_ID_UNSUPPORTED';
  }
  return null;
}
function rateChangeRequest(page, request, code, dates, sessionId, draft) {
  if (!requestUrl(request,CHANGE) || !sessionId || !proofsCurrent(page,dates)) return false;
  const body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
  if (new Set(keys).size !== keys.length) return false;
  const expected = {
    propertycode:PROPERTY,PKID:`@[EMPTY]#@[EMPTY]#${PROPERTY}#`,confirmationnumber:'',recordid:'',reservationid:'',
    reservationstayid:'',reservationshareid:'',guestid:clean(draft.guestId),firstname:draft.first,lastname:draft.last,status:'New',
    arrivaldate:dates.arrival.wire,departuredate:dates.departure.wire,rateplan:code,
    ONLY_DATA_REQUIRED:'true',bookingsessionid:sessionId,
    newprofileclick:'',linkprofileflag:'',savecctoprofile:'0',createinactiveprofileflag:'0',reqguestprofilelookup:'',
    pagemode:'display',isafterreservationsave:'',savesettlementcctoprofile:'0',linkedprofileflag:'0',
    ...(dates.ar ? {araccountid:dates.ar.accountId,arprofileid:dates.ar.profileId,araccountname:draft.arAccountName} : {}),
  };
  if (!Object.entries(expected).every(([key,value]) => body.getAll(key).length === 1 && body.get(key) === value &&
      keys.filter(name => name.toLowerCase() === key.toLowerCase()).length === 1)) return false;
  return !draftIdIssue(request,clean(draft.guestId),dates.ar);
}

// Normalize the vendor's data-only object literal without executing it.
function parseResponse(body) {
  if (typeof body !== 'string' || !body.trim() || /^\s*</.test(body)) throw new Error('HMS_RESPONSE_UNVERIFIED');
  let badEscape = false;
  const strings = body.replace(/("(?:\\.|[^"\\])*")|'((?:\\.|[^'\\])*)'/gs, (all,double,single) => {
    if (double) return double;
    const value = single.replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)/gs, (match,escape) => {
      const values = {"'":"'",'"':'"','\\':'\\','/':'/',n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v',0:'\0'};
      if (Object.hasOwn(values,escape)) return values[escape];
      if (escape[0] === 'u' || escape[0] === 'x') return String.fromCharCode(parseInt(escape.slice(1),16));
      badEscape = true; return '';
    });
    return JSON.stringify(value);
  });
  if (badEscape) throw new Error('HMS_RESPONSE_UNVERIFIED');
  const json = strings.replace(/("(?:\\.|[^"\\])*")|([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    (match,quoted,prefix,key) => quoted || `${prefix}"${key}":`);
  let payload;
  try { payload = JSON.parse(json); } catch { throw new Error('HMS_RESPONSE_UNVERIFIED'); }
  const data = payload?.pageData;
  const content = value => Array.isArray(value) ? value.length > 0 : value != null && value !== false && value !== '';
  if (!data || [payload,data].some(part => part && ((Object.hasOwn(part,'success') && part.success !== true) ||
      content(part.error) || content(part.errors))) || content(data.messages)) throw new Error('HMS_RESPONSE_UNVERIFIED');
  return data;
}
function validateResponses(validation, change, code, dates, sessionId, draft) {
  if (validation.status() !== 200 || change.status() !== 200) throw new Error('HMS_RESPONSE_UNVERIFIED');
  return Promise.all([validation.text(),change.text()]).then(([validationText,changeText]) => {
    const response = parseResponse(validationText), grid = response?.grid?.GRIDRESULT?.GRID;
    if (!grid?.METADATA || clean(grid.METADATA.GRIDNAME) !== 'LVRATEPLANS2' || !Array.isArray(grid.DATA) ||
        grid.DATA.filter(row => clean(row.rateplancode) === code).length !== 1) throw new Error('RATE_VALIDATION_UNVERIFIED');
    const values = parseResponse(changeText)?.values;
    const expected = {propertycode:PROPERTY,confirmationnumber:'',recordid:'',reservationid:'',reservationstayid:'',guestid:clean(draft.guestId),
      firstname:clean(draft.first),lastname:clean(draft.last),arrivaldate:dates.arrival.wire,departuredate:dates.departure.wire,rateplan:code,bookingsessionid:sessionId,
      ...(dates.ar ? {araccountid:dates.ar.accountId,arprofileid:dates.ar.profileId,araccountname:clean(draft.arAccountName)} : {})};
    const keys = Object.keys(values || {});
    const exact = (key,value) => Object.hasOwn(values,key) && clean(values[key]) === value &&
      keys.filter(name => name.toLowerCase() === key.toLowerCase()).length === 1;
    if (!values || !Object.entries(expected).every(([key,value]) => exact(key,value)) ||
        !BLANK_DRAFT_IDS.every(key => exact(key,key === 'arprofileid' && dates.ar ? dates.ar.profileId : '')) ||
        (!dates.ar && keys.some(key => key.toLowerCase() === 'araccountid' && clean(values[key]))) ||
        keys.some(key => /(?:guest|profile|reservation|record|stay).*id/i.test(key) &&
          !/^is/i.test(key) && key !== 'guestid' && !(dates.ar && key === 'arprofileid') && clean(values[key]))) {
      throw new Error('RATE_CHANGE_UNVERIFIED');
    }
  });
}
function bounded(promise, ms, issue) {
  let timer;
  return Promise.race([promise,new Promise((_,reject) => {timer=setTimeout(() => reject(new Error(issue)),ms);})])
    .finally(() => clearTimeout(timer));
}

/** Select an explicit current code on a verified unsaved draft, without saving. */
export async function selectGuestStayRatePlan(page, { code, guestProfileId } = {}) {
  if (guestProfileId !== undefined && (typeof guestProfileId !== 'string' || !/^\d{1,100}$/.test(guestProfileId))) {
    return {outcome:'input_gap',issue:'GUEST_PROFILE_ID_INVALID'};
  }
  const guestId = guestProfileId ?? '';
  if (typeof code !== 'string' || !code.trim() || code !== code.trim() || code.length > 100 || /[\r\n]/.test(code)) {
    return {outcome:'input_gap',issue:'RATE_CODE_REQUIRED'};
  }
  if (!page || typeof page.route !== 'function' || typeof page.evaluate !== 'function') return {outcome:'input_gap',issue:'PAGE_REQUIRED'};
  if (busy.has(page)) return {outcome:'execution_failure',issue:'RATE_SELECTION_IN_PROGRESS'};
  busy.add(page);
  let nativeDialog = false, attempted = false, unsupportedId = null, before = null, after = null, guard = null, fence = null, scope = null;
  const blocked = [], requests = new Map(), responses = [], sessions = [];
  const onDialog = () => {nativeDialog = true;};
  const onRequest = request => {
    try {
      const url = new URL(request.url());
      if (url.origin !== ORIGIN || request.method() !== 'POST') return;
      const input = JSON.parse(request.postData() || '{}');
      if (url.pathname === '/api/internalBooking/rateshop/inquiryForGrid' && input.propertyCodes === PROPERTY && !clean(input.reservationStayID)) {
        sessions.push({kind:'inquiry',id:input.bookingSessionID,request});
      }
      if (url.pathname === `/api/internalBooking/${PROPERTY}/rateshop/rateSelection` && input.action === 'CANCEL') {
        sessions.push({kind:'cancel',id:input.rateShopping?.bookingSessionID,request});
      }
    } catch { /* Only the observed JSON requests contribute session evidence. */ }
  };
  const onResponse = response => {
    const session = sessions.find(item => item.request === response.request());
    if (session) session.status = response.status();
    if (requests.has(response.request())) responses.push({kind:requests.get(response.request()),response});
  };
  page.on('dialog',onDialog); page.on('request',onRequest); page.on('response',onResponse);
  try {
    fence = await installPageRequestFence(page,[CHANGE]);
    scope = fence.open();
    before = await bounded(readDraft(page),10000,'DRAFT_READ_TIMEOUT');
    const dates = await bounded(checkedDraft(before,guestId,page),10000,'DRAFT_IDENTITY_PROOF_TIMEOUT');
    const previousCode = clean(before.rate) || null, prior = selectedOnPage.get(page);
    const previousRateEvidence = !previousCode ? 'blank' : prior?.code === previousCode && prior.fingerprint === draftFingerprint(before)
      ? 'selected_by_this_tool_same_page' : 'observed_on_draft';
    if (nativeDialog) throw new Error('UNEXPECTED_DIALOG');
    const search = await searchRatePlans(page,{query:code,limit:100});
    if (nativeDialog) throw new Error('UNEXPECTED_DIALOG');
    const close = await closeRoomRatePicker(page);
    if (nativeDialog) throw new Error('UNEXPECTED_DIALOG');
    if (close.outcome !== 'closed_unsaved') throw new Error('RATE_CATALOG_CLOSE_UNVERIFIED');
    if (search.outcome === 'criteria_unavailable') return { ...search, cleanupRequired: false, cleanup: close.outcome };
    if (search.outcome !== 'matches' || search.coverage?.complete !== true ||
        search.coverage.returned !== search.coverage.matchingLoaded ||
        search.candidates.filter(candidate => candidate.code === code).length !== 1) throw new Error('CURRENT_RATE_CODE_UNVERIFIED');
    const inquiry = sessions.filter(item => item.kind === 'inquiry'), cancel = sessions.filter(item => item.kind === 'cancel');
    if (inquiry.length !== 1 || cancel.length !== 1 || !inquiry[0].id || inquiry[0].id !== cancel[0].id ||
        inquiry[0].status !== 200 || cancel[0].status !== 200 ||
        (dates.session && inquiry[0].id !== dates.session)) throw new Error('BOOKING_SESSION_UNVERIFIED');
    const sessionId = inquiry[0].id;
    const ready = await bounded(readDraft(page),10000,'DRAFT_READ_TIMEOUT');
    const readyProof = await bounded(checkedDraft(ready,guestId,page),10000,'DRAFT_IDENTITY_PROOF_TIMEOUT');
    if (JSON.stringify(ready.fields) !== JSON.stringify(before.fields) || JSON.stringify(readyProof) !== JSON.stringify(dates)) {
      throw new Error('DRAFT_CHANGED_DURING_SEARCH');
    }
    guard = async route => {
      const request = route.request();
      let kind = null;
      if (!Array.from(requests.values()).includes('validation') && validationRequest(request,code,dates)) kind = 'validation';
      else if (Array.from(requests.values()).includes('validation') && !Array.from(requests.values()).includes('change') &&
          rateChangeRequest(page,request,code,dates,sessionId,before)) kind = 'change';
      if (kind) {
        if (kind === 'change' && !scope?.allow(request)) return route.abort();
        requests.set(request,kind);
        return route.fallback();
      }
      unsupportedId = draftIdIssue(request,guestId,dates.ar) || unsupportedId;
      const url = new URL(request.url());
      blocked.push({method:request.method(),path:url.pathname,originMatches:url.origin === ORIGIN,query:Boolean(url.search)});
      return route.abort();
    };
    await page.route('**/*',guard);
    const input = page.locator('input[name="rateplan"]:visible');
    if (await input.count() !== 1 || !await input.isEditable()) throw new Error('RATE_FIELD_UNAVAILABLE');
    attempted = true;
    await input.fill(code,{timeout:5000});
    if (nativeDialog) throw new Error('UNEXPECTED_DIALOG');
    await input.press('Tab',{timeout:12000});
    await page.waitForTimeout(1500);
    if (nativeDialog) throw new Error('UNEXPECTED_DIALOG');
    const onlyAsset = blocked.every(item => item.method === 'GET' && item.originMatches && !item.query && item.path === ASSET);
    if (!onlyAsset) throw new Error('UNEXPECTED_REQUEST_BLOCKED');
    await page.waitForFunction(() => !Ext.Ajax.isLoading(),null,{timeout:10000});
    if (nativeDialog) throw new Error('UNEXPECTED_DIALOG');
    after = await bounded(readDraft(page),10000,'DRAFT_READ_TIMEOUT');
    const afterArrival = dateParts(after.arrival), afterDeparture = dateParts(after.departure);
    if (!afterArrival || !afterDeparture || afterArrival.iso !== dates.arrival.iso || afterDeparture.iso !== dates.departure.iso) {
      throw new Error('DRAFT_DATES_CHANGED');
    }
    const afterProof = await bounded(checkedDraft(after,guestId,page),10000,'DRAFT_IDENTITY_PROOF_TIMEOUT');
    if (JSON.stringify(afterProof) !== JSON.stringify(dates) || clean(after.first) !== clean(before.first) ||
        clean(after.last) !== clean(before.last) || clean(after.arAccountName) !== clean(before.arAccountName)) {
      throw new Error('DRAFT_IDENTITY_CHANGED');
    }
    if (after.rate !== code || after.rateValue !== code || after.rateSubmit !== code || after.rateErrors.length || after.rateInvalid === 'true') {
      throw new Error('RATE_READBACK_UNVERIFIED');
    }
    const deadline = Date.now() + 10000;
    while (responses.length < 2 && Date.now() < deadline) await page.waitForTimeout(100);
    const validation = responses.filter(item => item.kind === 'validation'), change = responses.filter(item => item.kind === 'change');
    if (validation.length !== 1 || change.length !== 1 || requests.size !== 2) throw new Error('HMS_RESPONSE_UNVERIFIED');
    await bounded(validateResponses(validation[0].response,change[0].response,code,dates,sessionId,before),10000,'HMS_RESPONSE_TIMEOUT');
    if (!proofsCurrent(page,dates)) throw new Error('DRAFT_IDENTITY_CHANGED');
    if (nativeDialog || blocked.some(item => item.method !== 'GET' || !item.originMatches || item.query || item.path !== ASSET)) {
      throw new Error(nativeDialog ? 'UNEXPECTED_DIALOG' : 'UNEXPECTED_REQUEST_BLOCKED');
    }
    selectedOnPage.set(page,{code,fingerprint:draftFingerprint(after)});
    return {outcome:'selected_unsaved',code,previousCode,previousRateEvidence,propertyCode:PROPERTY,arrivalDate:dates.arrival.iso,departureDate:dates.departure.iso,
      nativeCodeEvidence:'validated_row_and_draft_change_response',nativeRatePlanId:'unsupported',
      identityReadback:{guestProfileId:guestId || null,arAccount:dates.ar ? {accountId:dates.ar.accountId,
        profileId:dates.ar.profileId,displayName:after.arAccountName,nativeName:after.arAccountNativeName} : null},
      changedFields:changedFields(before.fields,after.fields),
      effects:{validationStatus:validation[0].response.status(),rateChangeStatus:change[0].response.status(),blockedRequests:blocked}};
  } catch (error) {
    if (attempted) { selectedOnPage.delete(page); fence?.quarantine(); }
    const unsupported = unsupportedId || (['GUEST_PROFILE_ID_UNSUPPORTED','AR_SELECTION_UNVERIFIED'].includes(error?.message) ? error.message : null);
    return {outcome:unsupported ? 'unsupported' : attempted ? 'selection_uncertain' : 'execution_failure',
      issue:unsupported || (nativeDialog ? 'UNEXPECTED_DIALOG' : safeIssue(error)),
      ...(attempted && unsupported ? {draftMayHaveChanged:true} : {}),
      ...(blocked.length ? {blockedRequests:blocked} : {}),
      ...(before && after ? {changedFields:changedFields(before.fields,after.fields)} : {})};
  } finally {
    scope?.close();
    if (guard) await page.unroute('**/*',guard).catch(() => {});
    page.off('dialog',onDialog); page.off('request',onRequest); page.off('response',onResponse); busy.delete(page);
  }
}
