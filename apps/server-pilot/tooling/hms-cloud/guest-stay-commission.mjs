// Stage the native Commission Percent on an already selected agency; never save.
import { validCreateGuest } from './cloud-create-policy.mjs';
import { verifiedLabtestProfileToken, isVerifiedLabtestProfileCurrent } from './guest-profile.mjs';
import { isLabtestAmendStageContext } from './labtest-amend-save.mjs';
import { snapshotLabtestRecord } from './labtest-record.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';
import { getPropertyRegistration } from './property-registry.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const SAVE_PATH = '/web/base/OSRESV.HDR';
const AVAILABILITY_PATH = '/web/base/OSRESV.HDR.getcheckavailability';
const ALLOWED_LATER = new Set([SAVE_PATH.toLowerCase(), AVAILABILITY_PATH.toLowerCase()]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BUSINESS = ['propertycode', 'PKID', 'status', 'confirmationnumber', 'bookingsessionid',
  'reservationid', 'reservationstayid', 'recordid', 'guestid', 'firstname', 'lastname',
  'arrivaldate', 'departuredate', 'nights', 'adults', 'children', 'child1', 'child2', 'child3', 'childages',
  'roomtype', 'roomtypecharge', 'rateplan', 'mealplan', 'promotioncode', 'track', 'trackcode', 'guaranteetype', 'reasonforstay',
  'taid1', 'ta1', 'companyid', 'company', 'companyname', 'groupid', 'groupname', 'groupcompanyid',
  'grouptaid', 'groupta2id', 'groupta3id', 'bookingagency2id', 'bookingagency3id', 'bookingagency2name',
  'bookingagency3name', 'bookingagency2percent', 'bookingagency2amount', 'bookingagency3percent', 'bookingagency3amount',
  'bookingagencycontractid', 'bacontract', 'bookingagency1iatanumber',
  'bookingagency2iatanumber', 'bookingagency3iatanumber', 'bookingagency1commissionable',
  'bookingagencycommissionpricing', 'bookingagencycommissiontype',
  'araccountid', 'araccountname', 'arprofileid', 'guaranteecreditcardid', 'leaseguaranteecreditcardid',
  'billingreference', 'sourceofbus',
  'sourceofbusinessdesc', 'reservationnote', 'emailaddress', 'caller', 'udfchar06',
  'guestoptin4', 'udfchkbox04', 'udfchar09', 'udfchar13', 'averagerate', 'averageratecurr',
  'averagenightly', 'averagenightlycurr', 'totalrate', 'totalratecurr', 'totalratewithtax',
  'totalratewithtaxcurr', 'grandtotal', 'currency', 'grandtotalcurr'];
const SAVED_IDENTITY = ['propertycode', 'PKID', 'status', 'confirmationnumber', 'guestid',
  'reservationid', 'reservationstayid', 'recordid'];
const busy = new WeakSet();
const fences = new WeakMap();
const id = (value) => typeof value === 'string' && /^\d{1,30}$/.test(value);
const validPercent = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const issue = (error) => /\b(COMMISSION_[A-Z_]{3,80})\b/.exec(String(error?.message ?? ''))?.[1] || 'COMMISSION_STAGING_FAILED';

function decimalKey(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(value ?? '').trim());
  if (!match || Math.abs(Number(match[3] || 0)) > 400) return null;
  let digits = (match[1] + (match[2] || '')).replace(/^0+/, '');
  if (!digits) return '0e0';
  let power = Number(match[3] || 0) - (match[2] || '').length;
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); power += 1; }
  return `${digits}e${power}`;
}

// Expand exponent notation without rounding the number supplied by the caller.
function decimalText(value) {
  const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  const digits = whole + fraction, position = whole.length + Number(exponent);
  if (position <= 0) return `0.${'0'.repeat(-position)}${digits}`;
  if (position >= digits.length) return digits + '0'.repeat(position - digits.length);
  return `${digits.slice(0, position)}.${digits.slice(position)}`;
}

function safeContext(page) {
  try {
    const context = page.context();
    return context?._options?.serviceWorkers === 'block' && typeof context.serviceWorkers === 'function' &&
      Array.isArray(context.serviceWorkers()) && context.serviceWorkers().length === 0;
  } catch { return false; }
}

// The later SAVE and availability requests still have to pass the existing
// single-request page fence and the caller's exact business-value matcher.
async function installFence(page, frame, stop) {
  if (fences.has(page)) throw new Error('COMMISSION_PAGE_ALREADY_USED');
  const state = { stage: true, failed: false, pending: new Set() };
  fences.set(page, state);
  const fail = () => {
    if (state.failed) return;
    state.failed = true;
    stop('COMMISSION_REQUEST_BLOCKED');
  };
  const allows = (request) => {
    let allowed = false;
    try {
      const url = new URL(request.url()), method = request.method().toUpperCase();
      const action = [...url.searchParams].some(([key, value]) => ['pageaction', 'action'].includes(key.toLowerCase()) &&
        /^(save|delete|cancel|duplicate|checkin|checkout|send|crs|insert|update|commit|create|submit|autosave|amend|post)$/i.test(value.trim()));
      allowed = SAFE_METHODS.has(method) && !action && !/save|delete|cancel|duplicate|checkin|checkout|send|crs/i.test(url.pathname);
      if (!state.stage && method === 'POST' && url.origin === ORIGIN && !url.hash &&
          ALLOWED_LATER.has(url.pathname.toLowerCase()) && request.frame() === frame) allowed = true;
    } catch { /* Malformed requests are refused. */ }
    return allowed;
  };
  const handler = (route) => {
    const allowed = allows(route.request());
    const work = Promise.resolve().then(() => {
      if (!allowed) { fail(); return route.abort(); }
      return route.fallback();
    });
    state.pending.add(work);
    void work.finally(() => state.pending.delete(work)).catch(() => {});
    return work;
  };
  const context = page.context();
  const observe = (request) => { if (!allows(request)) fail(); };
  // Another page or context route may abort before this handler sees a request.
  context.on('request', observe);
  page.once('close', () => context.off('request', observe));
  await context.route('**/*', handler);
  await page.route('**/*', handler);
  await installPageRequestFence(page, [SAVE_PATH, AVAILABILITY_PATH]);
  return state;
}

// One synchronous browser operation checks the current form before touching it.
async function inspect(surface, expected, target, edit) {
  return surface.evaluate(({ origin, expected, target, edit, business }) => {
    const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) &&
      getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const named = (name) => [...document.querySelectorAll('input,textarea,select')].filter((el) =>
      el.name?.toLowerCase() === name.toLowerCase() && visible(el));
    const one = (name) => {
      const found = named(name);
      if (found.length !== 1 || found[0].name !== name) throw new Error('COMMISSION_FIELD_NOT_UNIQUE');
      return found[0];
    };
    const component = (el) => el.id && globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
    if (location.origin !== origin) throw new Error('COMMISSION_ORIGIN_MISMATCH');
    if ([...document.querySelectorAll('.x-window:not(.x-menu),.x-message-box')].some((el) =>
      (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden')) throw new Error('COMMISSION_DIALOG_OPEN');
    const guest = one('guestid'), agency = one('ta1'), field = one('ta1commission');
    const guestCmp = component(guest), agencyCmp = component(agency), cmp = component(field);
    const panel = guestCmp?.up?.('form'), form = panel?.getForm?.(), record = panel?.getRecord?.(), data = record?.data;
    if (!panel?.el?.dom || !form || !record || !data || !Array.isArray(form.getFields?.()?.items) ||
        ![guest, agency, field].every((el) => panel.el.dom.contains(el) && component(el)?.up?.('form') === panel) ||
        !cmp || typeof cmp.getValue !== 'function' || typeof cmp.getSubmitData !== 'function' ||
        typeof cmp.setValue !== 'function' || typeof panel.updateRecord !== 'function') throw new Error('COMMISSION_FORM_UNVERIFIED');
    const matches = form.getFields().items.filter((item) => String(item.getName?.() || item.name || '').toLowerCase() === 'ta1commission');
    if (matches.length !== 1 || matches[0] !== cmp) throw new Error('COMMISSION_CONTROL_NOT_UNIQUE');
    const keys = Object.keys(data);
    const exact = (name, value) => Object.hasOwn(data, name) && keys.filter((key) => key.toLowerCase() === name.toLowerCase()).length === 1 &&
      String(data[name] ?? '').trim() === String(value);
    const read = (name) => {
      if (!Object.hasOwn(data, name) || keys.filter((key) => key.toLowerCase() === name.toLowerCase()).length !== 1) {
        throw new Error('COMMISSION_IDENTITY_UNVERIFIED');
      }
      return String(data[name] ?? '').trim();
    };
    const propertyCode = expected.propertyCode ?? expected.identity?.propertycode;
    if (!propertyCode || !exact('propertycode', propertyCode) || !exact('taid1', expected.agencyId) || !read('ta1') ||
        agency.value.trim() !== read('ta1') || String(agencyCmp?.getValue?.() ?? '').trim() !== read('ta1') ||
        !read('guestid') || guest.value.trim() !== read('guestid') ||
        String(guestCmp?.getValue?.() ?? '').trim() !== read('guestid')) throw new Error('COMMISSION_IDENTITY_UNVERIFIED');
    const identityValues = form.getValues?.();
    if (!identityValues || typeof identityValues !== 'object' || Array.isArray(identityValues)) throw new Error('COMMISSION_IDENTITY_UNVERIFIED');
    for (const name of ['taid1', 'ta1', 'guestid', 'confirmationnumber']) {
      const found = Object.keys(identityValues).filter((key) => key.toLowerCase() === name);
      if (found.length > 1 || (found.length && (found[0] !== name || Array.isArray(identityValues[name]) ||
          String(identityValues[name] ?? '').trim() !== read(name)))) throw new Error('COMMISSION_IDENTITY_UNVERIFIED');
    }
    if (expected.mode === 'new') {
      if (!exact('PKID', `@[EMPTY]#@[EMPTY]#${propertyCode}#`) || !exact('status', 'New') ||
          !exact('confirmationnumber', '') || !exact('reservationid', '') || !exact('reservationstayid', '') || !exact('recordid', '') ||
          !read('bookingsessionid') || !exact('guestid', expected.guestId) ||
          !exact('firstname', expected.firstName) || !exact('lastname', expected.lastName)) throw new Error('COMMISSION_IDENTITY_UNVERIFIED');
      for (const [name, value] of [['confirmationnumber', ''], ['firstname', expected.firstName], ['lastname', expected.lastName]]) {
        const element = one(name), control = component(element);
        if (!panel.el.dom.contains(element) || control?.up?.('form') !== panel || element.value !== value ||
            String(control.getValue?.() ?? '') !== value) throw new Error('COMMISSION_IDENTITY_UNVERIFIED');
      }
    } else {
      for (const [name, value] of Object.entries(expected.identity)) {
        if (!value || !exact(name, value)) throw new Error('COMMISSION_IDENTITY_UNVERIFIED');
      }
      const confirmation = one('confirmationnumber');
      if (!panel.el.dom.contains(confirmation) || confirmation.value.trim() !== expected.identity.confirmationnumber ||
          String(component(confirmation)?.getValue?.() ?? '').trim() !== expected.identity.confirmationnumber) {
        throw new Error('COMMISSION_IDENTITY_UNVERIFIED');
      }
    }
    const decimal = (input) => {
      const text = String(input ?? '').trim();
      const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
      if (!match || Math.abs(Number(match[3] || 0)) > 400) return null;
      let digits = (match[1] + (match[2] || '')).replace(/^0+/, '');
      if (!digits) return '0e0';
      let power = Number(match[3] || 0) - (match[2] || '').length;
      while (digits.endsWith('0')) { digits = digits.slice(0, -1); power += 1; }
      return `${digits}e${power}`;
    };
    const requested = decimal(target);
    const snapshot = () => {
      const values = form.getValues?.(), submission = cmp.getSubmitData();
      if (!values || typeof values !== 'object' || Array.isArray(values) || !submission ||
          Object.keys(submission).filter((key) => key.toLowerCase() === 'ta1commission').length !== 1 ||
          !Object.hasOwn(submission, 'ta1commission') ||
          Object.keys(values).filter((key) => key.toLowerCase() === 'ta1commission').length !== 1 ||
          !Object.hasOwn(values, 'ta1commission') || !Object.hasOwn(data, 'ta1commission') ||
          keys.filter((key) => key.toLowerCase() === 'ta1commission').length !== 1) throw new Error('COMMISSION_SUBMIT_UNVERIFIED');
      const sources = [field.value, cmp.getValue(), submission.ta1commission, values.ta1commission, data.ta1commission];
      const empty = sources.every((value) => value == null || String(value).trim() === '');
      const normalized = sources.map(decimal);
      if (!empty && (normalized.some((value) => value === null) || new Set(normalized).size !== 1)) {
        throw new Error('COMMISSION_VALUE_UNVERIFIED');
      }
      const errors = cmp.getActiveErrors?.();
      if (field.disabled || field.readOnly || cmp.disabled || cmp.readOnly || cmp.isDisabled?.() ||
          field.getAttribute('aria-invalid') === 'true' || (Array.isArray(errors) && errors.length)) {
        throw new Error('COMMISSION_CONTROL_NOT_EDITABLE');
      }
      const dynamic = [...new Set([...Object.keys(data), ...Object.keys(values)].filter(name => /^child[1-9]\d*$/i.test(name)))].sort();
      const allBusiness = [...new Set([...business, ...dynamic])];
      const names = new Set(allBusiness.map((name) => name.toLowerCase()));
      const controls = {};
      for (const el of panel.el.dom.querySelectorAll('input,textarea,select')) {
        const name = el.name?.toLowerCase();
        if (!name || !names.has(name) || !visible(el) || ['hidden', 'password'].includes(el.type)) continue;
        (controls[name] ||= []).push(['checkbox', 'radio'].includes(el.type) ? el.checked : el.value);
      }
      const orderedControls = Object.fromEntries(Object.keys(controls).sort().map((name) => [name, controls[name]]));
      const model = {};
      const otherValues = {};
      for (const name of allBusiness) {
        const found = Object.keys(data).filter((key) => key.toLowerCase() === name.toLowerCase());
        if (found.length > 1) throw new Error('COMMISSION_MODEL_AMBIGUOUS');
        if (found.length) {
          const value = JSON.stringify(data[found[0]] ?? null);
          if (value === undefined) throw new Error('COMMISSION_MODEL_UNVERIFIED');
          model[found[0]] = value;
        }
        const formKeys = Object.keys(values).filter((key) => key.toLowerCase() === name.toLowerCase());
        if (formKeys.length > 1) throw new Error('COMMISSION_FORM_AMBIGUOUS');
        if (formKeys.length) otherValues[name.toLowerCase()] = values[formKeys[0]];
      }
      return { actual: normalized[0], empty, controls: orderedControls, values: otherValues, model,
        session: read('bookingsessionid'), guestId: read('guestid') };
    };
    const before = snapshot();
    const changed = before.actual !== requested;
    if (edit && changed) {
      cmp.setValue(target);
      panel.updateRecord(record);
    }
    const after = snapshot();
    if (!requested || (edit && after.actual !== requested)) throw new Error('COMMISSION_VALUE_UNVERIFIED');
    return { before, after, changed };
  }, { origin: ORIGIN, expected, target, edit, business: BUSINESS });
}

function sameOtherFields(left, right, allowModelSync = false) {
  if (!left || !right || left.session !== right.session || left.guestId !== right.guestId ||
      JSON.stringify(left.controls) !== JSON.stringify(right.controls) ||
      JSON.stringify(left.values) !== JSON.stringify(right.values)) return false;
  return [...new Set([...Object.keys(left.model), ...Object.keys(right.model)])].every((name) => {
    if (left.model[name] === right.model[name]) return true;
    const field = name.toLowerCase();
    // updateRecord may synchronize a previously staged form value into the model.
    return allowModelSync && Object.hasOwn(left.values, field) && Object.hasOwn(right.model, name) &&
      JSON.stringify(left.values[field] ?? null) === right.model[name];
  });
}

function sameSnapshot(proof, snapshot) {
  if (!proof || !snapshot?.values || !snapshot.data) return false;
  const values = {}, model = {};
  const dynamic = [...new Set([...Object.keys(snapshot.values), ...Object.keys(snapshot.data)]
    .filter(name => /^child[1-9]\d*$/i.test(name)))].sort();
  for (const name of new Set([...BUSINESS, ...dynamic])) {
    const keys = Object.keys(snapshot.values).filter((key) => key.toLowerCase() === name.toLowerCase());
    if (keys.length > 1) return false;
    if (keys.length) values[name.toLowerCase()] = snapshot.values[keys[0]];
    const modelKeys = Object.keys(snapshot.data).filter((key) => key.toLowerCase() === name.toLowerCase());
    if (modelKeys.length > 1) return false;
    if (modelKeys.length) model[modelKeys[0]] = JSON.stringify(snapshot.data[modelKeys[0]] ?? null);
  }
  return JSON.stringify(values) === JSON.stringify(proof.values) && JSON.stringify(model) === JSON.stringify(proof.model);
}

async function stage(page, frame, expected, percent, stopOwner) {
  if (!page || !frame || !safeContext(page) || typeof page.route !== 'function' ||
      typeof page.on !== 'function' || typeof page.off !== 'function') throw new Error('COMMISSION_CONTEXT_UNSAFE');
  if (busy.has(page)) throw new Error('COMMISSION_ACTION_IN_PROGRESS');
  busy.add(page);
  let stopped = false, state, onDialog;
  const stop = (reason) => {
    if (stopped) return;
    stopped = true;
    if (state) state.failed = true;
    if (stopOwner) stopOwner(reason);
    else { try { void page.close({ runBeforeUnload: false }).catch(() => {}); } catch { /* The page is unusable. */ } }
  };
  onDialog = dialog => { stop('COMMISSION_UNEXPECTED_DIALOG'); void dialog.dismiss().catch(() => {}); };
  page.on('dialog', onDialog);
  const timeoutMs = Math.max(1, Math.min(expected.remaining?.() ?? 25000, 25000));
  const timer = setTimeout(() => stop('COMMISSION_STAGE_TIMEOUT'), timeoutMs);
  try {
    state = await installFence(page, frame, stop);
    if (stopped || !safeContext(page)) throw new Error('COMMISSION_CONTEXT_UNSAFE');
    const checkActive = () => {
      if (stopped || state.failed || !safeContext(page) || (expected.active && !expected.active())) {
        throw new Error('COMMISSION_STAGE_INACTIVE');
      }
    };
    const browserExpected = { ...expected }; delete browserExpected.active; delete browserExpected.remaining;
    const target = decimalText(percent);
    const pre = await inspect(frame, browserExpected, target, false);
    checkActive();
    let token;
    if (expected.mode === 'new') {
      token = await verifiedLabtestProfileToken(page, { nativeId: expected.guestId, session: pre.before.session });
      checkActive();
      if (!token) throw new Error('COMMISSION_GUEST_PROOF_STALE');
    }
    const edited = await inspect(frame, browserExpected, target, true);
    checkActive();
    if (!sameOtherFields(pre.before, edited.before) || pre.before.actual !== edited.before.actual ||
        pre.before.empty !== edited.before.empty || !sameOtherFields(edited.before, edited.after, true)) {
      throw new Error('COMMISSION_OTHER_FIELDS_CHANGED');
    }
    await frame.waitForFunction(() => {
      if (typeof globalThis.Ext?.Ajax?.isLoading !== 'function' || Ext.Ajax.isLoading()) return false;
      return ![...document.querySelectorAll('.x-mask,.x-mask-msg,.x-loadmask')].some((el) =>
        (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden');
    }, null, { timeout: Math.max(1, Math.min(expected.remaining?.() ?? 15000, 15000)) });
    checkActive();
    const after = await inspect(frame, browserExpected, target, false);
    checkActive();
    if (!sameOtherFields(edited.after, after.before) || after.before.actual !== edited.after.actual ||
        (token && !isVerifiedLabtestProfileCurrent(page, { nativeId: expected.guestId, session: pre.before.session, token }))) {
      throw new Error('COMMISSION_READBACK_CHANGED');
    }
    await Promise.allSettled(state.pending);
    checkActive();
    const drained = await inspect(frame, browserExpected, target, false);
    checkActive();
    if (!sameOtherFields(after.before, drained.before) || after.before.actual !== drained.before.actual ||
        (token && !isVerifiedLabtestProfileCurrent(page, { nativeId: expected.guestId, session: pre.before.session, token }))) {
      throw new Error('COMMISSION_READBACK_CHANGED');
    }
    state.stage = false;
    return { changed: edited.changed, actual: percent, proof: drained.before };
  } catch (error) {
    const code = issue(error);
    stop(code);
    throw new Error(code);
  } finally {
    clearTimeout(timer);
    page.off('dialog', onDialog);
    busy.delete(page);
  }
}

/** Stage an explicit or verified directory percent on a selected new-stay agency. */
export async function stageNewStayCommission(page, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['propertyCode', 'expectedGuest', 'expectedGuestId', 'expectedAgencyId', 'percent'].includes(key)) ||
      !getPropertyRegistration(input.propertyCode)?.active || !validCreateGuest(input.expectedGuest) || !id(input.expectedGuestId) ||
      !id(input.expectedAgencyId) || !validPercent(input.percent)) throw new Error('COMMISSION_INPUT_INVALID');
  if (!page || typeof page.mainFrame !== 'function') throw new Error('COMMISSION_CONTEXT_UNSAFE');
  const expected = { mode: 'new', propertyCode: input.propertyCode, agencyId: input.expectedAgencyId, guestId: input.expectedGuestId,
    firstName: input.expectedGuest.firstName, lastName: input.expectedGuest.lastName };
  const result = await stage(page, page.mainFrame(), expected, input.percent);
  return { outcome: result.changed ? 'updated_unsaved' : 'unchanged_unsaved', actual: result.actual };
}

/** Stage commission within the authenticated, already fenced saved-stay lifecycle. */
export async function stageSavedStayCommission(context, input) {
  if (!isLabtestAmendStageContext(context) || !context.isActive() || !input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['expectedAgencyId', 'percent'].includes(key)) ||
      !id(input.expectedAgencyId) || !validPercent(input.percent)) throw new Error('COMMISSION_INPUT_INVALID');
  const baseline = context.baseline?.data;
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) throw new Error('COMMISSION_BASELINE_UNAVAILABLE');
  const identity = {};
  for (const name of SAVED_IDENTITY) {
    if (!Object.hasOwn(baseline, name) || Object.keys(baseline).filter((key) => key.toLowerCase() === name.toLowerCase()).length !== 1 ||
        !String(baseline[name] ?? '').trim()) throw new Error('COMMISSION_BASELINE_UNAVAILABLE');
    identity[name] = String(baseline[name]).trim();
  }
  if (!getPropertyRegistration(identity.propertycode)?.active) throw new Error('COMMISSION_BASELINE_UNAVAILABLE');
  const expected = { mode: 'saved', agencyId: input.expectedAgencyId, identity,
    active: context.isActive, remaining: context.remainingMs };
  try {
    const result = await stage(context.page, context.frame, expected, input.percent, context.stop);
    if (!context.isActive()) throw new Error('COMMISSION_STAGE_INACTIVE');
    const snapshot = await snapshotLabtestRecord(context.frame);
    if (!context.isActive() || !snapshot || !sameSnapshot(result.proof, snapshot) ||
        decimalKey(snapshot.values?.ta1commission) !== decimalKey(input.percent) ||
        decimalKey(snapshot.data?.ta1commission) !== decimalKey(input.percent)) throw new Error('COMMISSION_READBACK_UNAVAILABLE');
    const verified = await inspect(context.frame, { mode: 'saved', agencyId: input.expectedAgencyId, identity }, decimalText(input.percent), false);
    if (!context.isActive() || !sameOtherFields(result.proof, verified.before) ||
        result.proof.actual !== verified.before.actual) throw new Error('COMMISSION_READBACK_CHANGED');
    return snapshot;
  } catch (error) {
    context.stop('COMMISSION_STAGE_FAILED');
    throw new Error(issue(error));
  }
}
