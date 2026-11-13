import { isDeepStrictEqual } from 'node:util';
import { blankSavedPartyFields } from './labtest-party-fields.mjs';
import { cleanLabtestRecord, matchesLabtestBody } from './labtest-record.mjs';

export const SAVED_GUARANTEE_PATH = '/web/base/OSRESV.HDR.changeguaranteemethod';
const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const issued = new WeakSet();
const business = new Set([...blankSavedPartyFields, 'propertycode', 'confirmationnumber', 'guestid', 'pkid',
  'reservationid', 'reservationstayid', 'recordid', 'bookingsessionid', 'status', 'firstname', 'lastname',
  'arrivaldate', 'departuredate', 'nights', 'roomtype', 'roomtypecharge', 'rateplan', 'mealplan', 'marketsegment',
  'track', 'adults', 'children', 'child1', 'child2', 'child3', 'childages', 'guaranteetype', 'reservationnote', 'emailaddress',
  'caller', 'udfchar06', 'billingreference', 'ta1commission', 'udfchkbox04', 'udfchar09', 'udfchar13',
  'newprofileclick', 'createinactiveprofileflag', 'reqguestprofilelookup', 'linkprofileflag', 'linkedprofileflag',
  'savecctoprofile', 'savesettlementcctoprofile']);
const price = /(?:price|tax|total|amount|averagenightly|averagerate|currency|curr)$/i;
const own = (value) => value && typeof value === 'object' && !Array.isArray(value);
const relevant = (name) => business.has(name.toLowerCase()) || price.test(name);
const scalar = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const validCode = (value) => typeof value === 'string' && /^[A-Z0-9]{1,20}$/.test(value);
const validDisplay = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
  value === value.trim() && !/[\p{Cc}]/u.test(value);
const uniqueKey = (object, key) => own(object) && Object.hasOwn(object, key) &&
  Object.keys(object).filter(name => name.toLowerCase() === key.toLowerCase()).length === 1;

export const isSavedGuaranteeRequestGate = gate => Boolean(gate && issued.has(gate));

/** Compare only known business and price preimages, allowing unrelated native form drift. */
export function sameSavedGuaranteePreimage(before, after, { allowGuaranteeChange = false } = {}) {
  return ['data', 'values'].every(part => {
    const a = before?.[part], b = after?.[part];
    if (!own(a) || !own(b)) return false;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => relevant(key) &&
      !(allowGuaranteeChange && key.toLowerCase() === 'guaranteetype')).every(key =>
      uniqueKey(a, key) && uniqueKey(b, key) && isDeepStrictEqual(a[key], b[key]));
  });
}

function wireDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}` : null;
}

/** Bind the clean current form and its native identity to the reviewed saved stay. */
export function matchesSavedGuaranteeBefore(snapshot, baseline, expected, before) {
  if (!Array.isArray(snapshot?.dirtyFields) || !Array.isArray(snapshot?.modifiedFields) ||
      !Array.isArray(baseline?.dirtyFields) || !Array.isArray(baseline?.modifiedFields) ||
      !cleanLabtestRecord(snapshot) || !cleanLabtestRecord(baseline) || !sameSavedGuaranteePreimage(baseline, snapshot) ||
      !own(expected) || !own(before) || !validCode(before.code) || !validDisplay(before.display) ||
      expected.guaranteeCode !== before.code || expected.guaranteeDisplay !== before.display) return false;
  const data = snapshot.data;
  const required = { propertycode: 'HRCEN', confirmationnumber: expected.confirmation, guestid: expected.guestId,
    reservationid: expected.reservationId, reservationstayid: expected.reservationStayId, recordid: expected.recordId,
    firstname: expected.firstName, lastname: expected.lastName, status: 'Reserved',
    arrivaldate: wireDate(expected.arrival), departuredate: wireDate(expected.departure), guaranteetype: before.code };
  if (!/^\d+-\d+$/.test(expected.confirmation || '') ||
      !['guestId', 'reservationId', 'reservationStayId', 'recordId'].every(k => /^\d{1,100}$/.test(expected[k] || '')) ||
      !required.arrivaldate || !required.departuredate || expected.arrival >= expected.departure ||
      !['firstName', 'lastName'].every(k => validDisplay(expected[k])) ||
      !Object.entries(required).every(([key, value]) => uniqueKey(data, key) && String(data[key] ?? '') === value) ||
      !['PKID', 'bookingsessionid'].every(key => uniqueKey(data, key) && typeof data[key] === 'string' && data[key].trim())) return false;
  return true;
}

function matchesRequest(request, frame, snapshot, expectedCode) {
  try {
    const url = new URL(request.url());
    if (request.method() !== 'POST' || request.frame() !== frame || url.origin !== ORIGIN || url.username || url.password ||
        url.pathname !== SAVED_GUARANTEE_PATH || url.search || url.hash ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '')) return false;
    const body = new URLSearchParams(request.postData() || ''), data = snapshot.data;
    const fixed = { propertycode: 'HRCEN', guaranteetype: expectedCode, pagemode: 'view', isafterreservationsave: '',
      ONLY_DATA_REQUIRED: 'true', REFRESH_GRID: 'false', USER_FUNCTION_NAME: 'OSRESV',
      SYSTEM_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR', newprofileclick: '',
      createinactiveprofileflag: '0', reqguestprofilelookup: '', savecctoprofile: '0', savesettlementcctoprofile: '0' };
    const exact = (key, value) => [...body.keys()].filter(name => name.toLowerCase() === key.toLowerCase()).length === 1 &&
      body.getAll(key).length === 1 && body.get(key) === String(value ?? '');
    if (!Object.entries(fixed).every(([key, value]) => exact(key, value)) ||
        [...body.keys()].some(key => key.toLowerCase() === 'pageaction') ||
        !matchesLabtestBody(body, snapshot, { guaranteetype: expectedCode })) return false;
    if (![...body.keys()].filter(key => relevant(key) && key.toLowerCase() !== 'guaranteetype').every(key =>
      uniqueKey(data, key) && scalar(data[key]) && exact(key, data[key]))) return false;
    return Object.keys(data).filter(key => (relevant(key) && key.toLowerCase() !== 'guaranteetype') ||
      ['PKID', 'bookingsessionid'].includes(key)).every(key =>
      uniqueKey(data, key) && scalar(data[key]) && exact(key, data[key]));
  } catch { return false; }
}

/** The owning page fence calls consume and dispatch on one intercepted request. */
export function createSavedGuaranteeRequestGate({ frame, isActive, deadlineAt } = {}) {
  if (!frame || typeof isActive !== 'function' || !Number.isFinite(deadlineAt) || deadlineAt <= performance.now()) {
    throw new Error('GUARANTEE_GATE_INPUT_INVALID');
  }
  let state = 'ready', request = null, snapshot, code, authorizeCandidate, dispatchCandidate;
  let possiblyDispatched = false, continued = false;
  let finishDispatch;
  const dispatchFinished = new Promise(resolve => { finishDispatch = resolve; });
  const active = () => state !== 'closed' && performance.now() < deadlineAt && isActive();
  const gate = Object.freeze({
    arm(current, baseline, expected, before, desired, callbacks) {
      if (!active() || state !== 'ready' || !matchesSavedGuaranteeBefore(current, baseline, expected, before) ||
          !validCode(desired?.code) || !validDisplay(desired?.display) || desired.code === before.code ||
          typeof callbacks?.authorizeCandidate !== 'function' || typeof callbacks?.dispatchCandidate !== 'function') return false;
      snapshot = structuredClone(current); code = desired.code;
      authorizeCandidate = callbacks.authorizeCandidate; dispatchCandidate = callbacks.dispatchCandidate;
      state = 'armed';
      return true;
    },
    consume(candidate) {
      if (!active() || state !== 'armed' || !matchesRequest(candidate, frame, snapshot, code)) {
        state = 'closed'; return false;
      }
      request = candidate; state = 'consumed'; return true;
    },
    isRequest(candidate) { return candidate === request && request !== null; },
    isActive() { return active(); },
    status() { return { phase: state, possiblyDispatched, continued }; },
    waitForDispatch() { return dispatchFinished; },
    async dispatch(candidate, proceed) {
      if (!active() || state !== 'consumed' || candidate !== request || typeof proceed !== 'function') {
        state = 'closed'; throw new Error('GUARANTEE_DISPATCH_UNAUTHORIZED');
      }
      state = 'authorizing';
      try {
        if (await authorizeCandidate(candidate) !== true || !active() || state !== 'authorizing' ||
            !matchesRequest(candidate, frame, snapshot, code)) throw new Error('GUARANTEE_DISPATCH_UNAUTHORIZED');
        state = 'dispatching';
        let finished = false, started = false, settled = false;
        const proceedOnce = () => {
          const task = Promise.resolve().then(async () => {
            if (finished || started || !active() || state !== 'dispatching' ||
                !matchesRequest(candidate, frame, snapshot, code)) throw new Error('GUARANTEE_DISPATCH_UNAUTHORIZED');
            started = true; continued = true;
            try { return await proceed(); } finally { settled = true; }
          });
          void task.catch(() => {});
          return task;
        };
        possiblyDispatched = true;
        try {
          const result = await dispatchCandidate(candidate, proceedOnce);
          finished = true;
          if (!started || !settled || !active() || state !== 'dispatching') throw new Error('GUARANTEE_DISPATCH_UNCERTAIN');
          state = 'dispatched';
          return result;
        } finally { finished = true; }
      } catch (error) { state = 'closed'; throw error; }
      finally { finishDispatch(); }
    },
    close() { state = 'closed'; },
  });
  issued.add(gate);
  return gate;
}
