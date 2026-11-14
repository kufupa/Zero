import { isDeepStrictEqual } from 'node:util';
import { blankSavedPartyFields } from './labtest-party-fields.mjs';
import { matchesSavedStageRequest } from './saved-stay-room-stage-gate.mjs';
import { parseSavedStayNativeResponse } from './saved-stay-native-response.mjs';
import { getPropertyRegistration } from './property-registry.mjs';

const SPECS = Object.freeze({
  organization: { field: 'company', label: 'Organization', title: 'Organizations', grid: 'LVCOMPANIES2',
    id: 'companyid', name: 'companyname', alias: 'companyname', link: 'companyid', display: 'company',
    path: '/web/base/OSRESV.HDR.changeorganization', scope: 'param.companyid' },
  bookingAgency: { field: 'ta1', label: 'Primary Booking Agency', title: 'Booking Agencies', grid: 'LVTRAVELAGENCIES4',
    id: 'travelagencyid', name: 'travelagencyname', alias: 'travelagencyname', link: 'taid1', display: 'ta1',
    path: '/web/base/OSRESV.HDR.changetravelagency', scope: 'param.grouptaid' },
  arAccount: { field: 'araccountname', label: 'A/R Account', title: 'A/R Account', grid: 'LVARACCOUNT',
    id: 'araccountid', name: 'araccountname', alias: 'araccountname', link: 'araccountid', display: 'araccountname',
    path: '/web/base/OSRESV.HDR.araccountchange' },
});
for (const spec of Object.values(SPECS)) Object.freeze(spec);
export const SAVED_PARTY_STAGE_PATHS = Object.freeze(['/web/base/LOVPOP', '/web/base/GRIDDATA',
  ...Object.values(SPECS).map(spec => spec.path)]);
const issued = new WeakSet();
export const isSavedPartyStageRequestGate = gate => Boolean(gate && issued.has(gate));
export const savedPartySpec = kind => SPECS[kind] ?? null;
const scalar = value => value == null || ['string', 'number', 'boolean'].includes(typeof value);
const text = value => value == null ? '' : String(value);
const validId = value => /^\d{1,100}$/.test(value || '');
const validText = value => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
  value.trim() === value && !/[\p{Cc}]/u.test(value);

/** Compare commission decimals without rounding or accepting values above 100. */
export function savedPartyCommissionKey(value) {
  if (!(typeof value === 'string' || typeof value === 'number' && Number.isFinite(value))) return null;
  const source = String(value);
  if (source.length > 200) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match || Math.abs(Number(match[3] || 0)) > 400) return null;
  let digits = (match[1] + (match[2] || '')).replace(/^0+/, '');
  if (!digits) return '0e0';
  let power = Number(match[3] || 0) - (match[2] || '').length;
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); power += 1; }
  const magnitude = digits.length + power;
  if (magnitude > 3 || (magnitude === 3 && (digits !== '1' || power !== 2))) return null;
  return `${digits}e${power}`;
}
const field = (source, name) => {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { present: false };
  const keys = Object.keys(source).filter(key => key.toLowerCase() === name.toLowerCase());
  if (keys.length !== 1 || keys[0] !== name || !scalar(source[name])) return { present: false };
  return { present: true, value: source[name] };
};
const value = (source, name) => field(source, name).present ? text(source[name]) : null;
const identityFields = ['PKID', 'propertycode', 'status', 'confirmationnumber', 'reservationstayid',
  'reservationid', 'recordid', 'guestid', 'bookingsessionid', 'firstname', 'lastname'];
const partyFields = [...blankSavedPartyFields, 'companyid', 'company', 'companyname', 'taid1', 'ta1', 'araccountid', 'araccountname',
  'arprofileid', 'groupid', 'groupname', 'grouptaid', 'bookingagencycontractid', 'bacontract',
  'bookingagency1iatanumber', 'ta1commission', 'billingreference', 'sourceofbus', 'sourceofbusinessdesc'];
const businessFields = ['arrivaldate', 'departuredate', 'nights', 'roomtype', 'roomtypecharge', 'rateplan', 'mealplan', 'marketsegment',
  'adults', 'children', 'child1', 'child2', 'child3', 'childages', 'track', 'guaranteetype', 'reservationnote',
  'emailaddress', 'caller', 'udfchar06', 'guestoptin4', 'udfchkbox04', 'udfchar09', 'udfchar13',
  'newprofileclick', 'createinactiveprofileflag', 'reqguestprofilelookup', 'linkprofileflag', 'linkedprofileflag',
  'savecctoprofile', 'savesettlementcctoprofile'];
export const SAVED_PARTY_POST_CALLBACK_AMOUNTS = Object.freeze([
  'grandtotal', 'averagenightly', 'averagerate', 'totalrate', 'totalratewithtax', 'enhancedexptotal',
  'guesttotal', 'guesttax', 'guesttotalwithtax', 'tax', 'totalresortfee', 'ratetax',
]);
const priceFields = [...SAVED_PARTY_POST_CALLBACK_AMOUNTS, 'averageratecurr', 'totalratecurr', 'currency',
  'enablecheckavailability'];
const observedPrice = name => /(?:price|tax|total|amount|averagenightly|averagerate|currency|curr)$/i.test(name);
const preimageFields = [...new Set([...identityFields, ...partyFields, ...businessFields, ...priceFields])];
const guardedIfPresent = [...new Set([...identityFields, ...partyFields, ...businessFields, ...priceFields])];
const profileWriteSwitches = new Set(['newprofileclick', 'createinactiveprofileflag', 'reqguestprofilelookup',
  'linkprofileflag', 'linkedprofileflag', 'savecctoprofile', 'savesettlementcctoprofile']);
const requestFields = ['PKID', 'propertycode', 'confirmationnumber', 'reservationstayid', 'reservationid',
  'recordid', 'guestid', 'bookingsessionid', 'companyid', 'company', 'companyname', 'taid1', 'ta1',
  'araccountid', 'araccountname', 'arprofileid', 'guaranteetype', 'rateplan', 'roomtype', 'arrivaldate',
  'departuredate', 'adults', 'children'];

/** Preserve absence separately from blank and capture relevant form/model business and price state. */
export function savedPartyBeforeImage(snapshot) {
  if (!snapshot?.data || !snapshot?.values) return null;
  const image = {};
  const names = [...new Set([...preimageFields, ...['data', 'values'].flatMap(part =>
    Object.keys(snapshot[part]).filter(name => observedPrice(name) || /^child\d+$/i.test(name)))])];
  for (const part of ['data', 'values']) {
    const source = snapshot[part];
    if (typeof source !== 'object' || Array.isArray(source)) return null;
    for (const name of names) {
      const keys = Object.keys(source).filter(key => key.toLowerCase() === name.toLowerCase());
      if (keys.length > 1 || (keys.length === 1 && (keys[0] !== name || !scalar(source[name])))) return null;
    }
    image[part] = Object.fromEntries(names.map(name => [name, field(source, name)]));
  }
  return image;
}

function verifiedSnapshot(snapshot, selected) {
  const data = snapshot?.data, values = snapshot?.values;
  if (!data || !values) return false;
  const fixed = { propertycode: selected.propertyCode, status: 'Reserved', confirmationnumber: selected.confirmation,
    reservationstayid: selected.reservationStayId, reservationid: selected.reservationId,
    recordid: selected.recordId, guestid: selected.guestId, firstname: selected.firstName, lastname: selected.lastName };
  if (Object.entries(fixed).some(([key, expected]) => !validText(expected) || value(data, key) !== expected) ||
      !validText(value(data, 'bookingsessionid')) || value(data, 'PKID') !== `${selected.confirmation}#${selected.reservationStayId}#${selected.propertyCode}#` ||
      requestFields.some(key => value(data, key) === null)) return false;
  return ['company', 'ta1', 'araccountname', 'confirmationnumber', 'guestid'].every(key =>
    value(values, key) !== null && value(values, key) === value(data, key));
}

function modelRow(row, spec, kind) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const nativeId = value(row, spec.id), name = value(row, spec.name);
  if (!validId(nativeId) || !validText(name)) return null;
  const details = kind === 'arAccount' ? { profileId: value(row, 'profileid'), arProfileId: value(row, 'arprofileid'), accountNumber: value(row, 'araccountnumber') }
    : kind === 'bookingAgency' ? { referenceNumber: value(row, 'iatanumber'),
      commissionPercentage: value(row, 'commissionpercentage'), payCommissionFlag: value(row, 'paycommissionflag'),
      commissionFlatAmount: value(row, 'commissionflatamount') }
      : { corporateAccountNumber: value(row, 'corporateaccountnumber') };
  return { nativeId, name, ...details };
}

function coverage(metadata, loaded) {
  const more = metadata?.MORERECORDPRESENT === '+' ? true : metadata?.MORERECORDPRESENT === '-' ? false : null;
  const total = /^\d+$/.test(String(metadata?.RECORDS ?? '')) ? Number(metadata.RECORDS) : null;
  const validTotal = Number.isSafeInteger(total) && total >= loaded ? total : null;
  const complete = more === false && validTotal === loaded;
  return { loaded, total: validTotal, serverMoreRecords: more, complete, possiblyTruncated: !complete,
    nativeResponseCorrelated: true };
}

function filtersMatch(request, query, alias) {
  const body = new URLSearchParams(request.postData() || '');
  const expected = { MADDON_FILTER_ALIAS_NAME_1: alias, MADDON_FILTER_OPERATOR_1: 'CONTAINS',
    MADDON_FILTER_VALUE_1: query, MADDON_FILTER_JOINER_1: 'AND', MADDON_FILTER_SEQNUM_1: '1' };
  const filters = [...body].filter(([key]) => key.toUpperCase().startsWith('MADDON_FILTER_'));
  return filters.length === Object.keys(expected).length && Object.entries(expected).every(([key, wanted]) =>
    body.getAll(key).length === 1 && body.get(key) === wanted &&
    filters.filter(([actual]) => actual.toLowerCase() === key.toLowerCase()).length === 1);
}

/** A page-owned gate: picker reads and a single exact Go callback have separate authority. */
export function createSavedPartyStageRequestGate({ frame, selected, deadlineAt } = {}) {
  if (!frame || !getPropertyRegistration(selected?.propertyCode)?.active || selected.status !== 'Reserved' ||
      !/^\d{6,}-\d+$/.test(selected.confirmation || '') ||
      !['guestId', 'reservationStayId', 'reservationId', 'recordId'].every(key => validId(selected[key])) ||
      !validText(selected.firstName) || !validText(selected.lastName) ||
      !Number.isFinite(deadlineAt) || deadlineAt <= performance.now()) throw new Error('PARTY_STAGE_GATE_INPUT_INVALID');
  selected = structuredClone(selected);
  let state = 'ready', spec, kind, query, image, snapshot, gridIds, candidates, rowsCoverage, chosen, callbacks, expectedEffects;
  let authorizedRequest = null, authorizationPending = false, dispatchPending = false, dispatchTask = null;
  const requests = new Map();
  const active = () => { if (performance.now() >= deadlineAt) state = 'closed'; return state !== 'closed'; };
  const base = () => {
    const aliases = spec.scope ? { LOV_ALIAS_NAME_1: spec.scope,
      LOV_ALIAS_VALUE_1: spec.scope === 'param.companyid' ? value(snapshot.data, 'companyid') : '', LOV_ALIAS_TYPE_1: 'text',
      LOV_ALIAS_NAME_2: 'param.propertycode', LOV_ALIAS_VALUE_2: selected.propertyCode, LOV_ALIAS_TYPE_2: 'text' }
      : { LOV_ALIAS_NAME_1: 'param.propertycode', LOV_ALIAS_VALUE_1: selected.propertyCode, LOV_ALIAS_TYPE_1: 'text' };
    return { GRID_NAME: spec.grid, GRID_TYPE: 'LOV', LOV_TAGNAME: spec.field,
      USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR', ...aliases };
  };
  const clear = () => { spec = kind = query = image = snapshot = gridIds = candidates = rowsCoverage = chosen = callbacks = expectedEffects = null;
    authorizedRequest = null; authorizationPending = false; dispatchPending = false; dispatchTask = null; requests.clear(); };
  const gate = Object.freeze({
    armRead(next, input) {
      if (!active() || state !== 'ready' || !input || !Object.hasOwn(SPECS, input.kind) || !validText(input.query) ||
          !verifiedSnapshot(next, selected)) return false;
      // The agency picker group constraint was only captured for a blank group.
      if (input.kind === 'bookingAgency' && (value(next.data, 'groupid') !== '' ||
          (value(next.data, 'grouptaid') !== null && value(next.data, 'grouptaid') !== ''))) return false;
      const nextImage = savedPartyBeforeImage(next);
      if (!nextImage) return false;
      kind = input.kind; spec = SPECS[kind]; query = input.query; snapshot = structuredClone(next);
      image = nextImage; candidates = rowsCoverage = null; state = 'popup_armed'; return true;
    },
    armRows(metadata) {
      if (!active() || state !== 'popup_consumed' || metadata?.GRIDNAME !== spec.grid ||
          !validId(String(metadata.GRIDID ?? '')) || !validId(String(metadata.DATASPYID ?? ''))) return false;
      gridIds = { GRID_ID: String(metadata.GRIDID), DATASPY_ID: String(metadata.DATASPYID) };
      state = 'rows_armed'; return true;
    },
    consume(request) {
      if (!active()) return false;
      let phase = null;
      if (state === 'popup_armed' && matchesSavedStageRequest(request, frame, SAVED_PARTY_STAGE_PATHS[0],
        { ...base(), REQUEST_TYPE: 'LOV.HEAD_DATA.STORED', popup: 'true' })) phase = 'popup';
      else if (state === 'rows_armed' && matchesSavedStageRequest(request, frame, SAVED_PARTY_STAGE_PATHS[1],
        { ...base(), ...gridIds, REQUEST_TYPE: 'LOV.DATA_ONLY.STORED' }) && filtersMatch(request, query, spec.alias)) phase = 'rows';
      if (!phase) { state = 'closed'; return false; }
      requests.set(phase, request); state = `${phase}_consumed`; return true;
    },
    verifyRows(status, body) {
      if (!active() || state !== 'rows_consumed' || status !== 200) return false;
      try {
        const grid = parseSavedStayNativeResponse(body)?.grid?.GRIDRESULT?.GRID;
        if (grid?.METADATA?.GRIDNAME !== spec.grid || String(grid.METADATA.GRIDID) !== gridIds.GRID_ID ||
            String(grid.METADATA.DATASPYID) !== gridIds.DATASPY_ID || !Array.isArray(grid.DATA)) return false;
        candidates = grid.DATA.map(row => modelRow(row, spec, kind));
        if (candidates.some(row => !row)) return false;
        rowsCoverage = coverage(grid.METADATA, candidates.length);
        if (!candidates.length && !rowsCoverage.complete) return false;
        state = 'rows_verified'; return true;
      } catch { return false; }
    },
    choices() { return active() && state === 'rows_verified' ? structuredClone({ kind, query, sourceField: spec.field,
      beforeImage: image, candidates, coverage: rowsCoverage }) : null; },
    finishRead() { if (!active() || state !== 'rows_verified') return false; clear(); state = 'ready'; return true; },
    armCandidate(next, candidate, authority) {
      if (!active() || state !== 'rows_verified' || !rowsCoverage.complete || !verifiedSnapshot(next, selected) ||
          !isDeepStrictEqual(savedPartyBeforeImage(next), image) || !candidate || candidate.kind !== kind || candidate.query !== query ||
          candidate.sourceField !== spec.field || typeof authority?.authorizeCandidate !== 'function' ||
          typeof authority?.dispatchCandidate !== 'function') return false;
      const matches = candidates.filter(row => row.nativeId === candidate.nativeId && row.name === candidate.name);
      if (matches.length !== 1 || candidates.filter(row => row.nativeId === candidate.nativeId).length !== 1 ||
          !isDeepStrictEqual(matches[0], candidate.row) ||
          (kind === 'arAccount' && !validId(matches[0].profileId))) return false;
      const effects = candidate.expectedEffects;
      if (effects !== undefined) {
        if (kind !== 'bookingAgency' || !effects || typeof effects !== 'object' || Array.isArray(effects) ||
            Object.keys(effects).length !== 1 || !Object.hasOwn(effects, 'ta1commission') ||
            typeof effects.ta1commission !== 'string' || !savedPartyCommissionKey(effects.ta1commission) ||
            effects.ta1commission !== matches[0].commissionPercentage ||
            matches[0].payCommissionFlag !== '-1') return false;
      }
      chosen = matches[0]; expectedEffects = effects ? structuredClone(effects) : null;
      callbacks = { authorizeCandidate: authority.authorizeCandidate, dispatchCandidate: authority.dispatchCandidate };
      state = 'candidate_armed'; return true;
    },
    matchesCandidate(request) {
      if (!active() || state !== 'candidate_armed') return false;
      const wanted = Object.fromEntries(requestFields.map(key => [key, value(snapshot.data, key)]));
      wanted[spec.link] = chosen.nativeId; wanted[spec.display] = chosen.name;
      if (kind === 'arAccount') wanted.arprofileid = chosen.profileId;
      if (expectedEffects) wanted.ta1commission = expectedEffects.ta1commission;
      wanted.ONLY_DATA_REQUIRED = 'true';
      try {
        const url = new URL(request.url()), body = new URLSearchParams(request.postData() || '');
        if (url.username || url.password) return false;
        const actionCounts = [...body.keys()].filter(key => ['pageaction', 'action'].includes(key.toLowerCase()));
        if (new Set(actionCounts.map(key => key.toLowerCase())).size !== actionCounts.length) return false;
        const guarded = new Set([...guardedIfPresent, ...[...body.keys()].filter(name => observedPrice(name) || /^child\d+$/i.test(name))]);
        for (const name of guarded) {
          const matching = [...body.keys()].filter(key => key.toLowerCase() === name.toLowerCase());
          if (!matching.length) continue;
          if (matching.length !== 1 || matching[0] !== name) return false;
          const expected = Object.hasOwn(wanted, name) ? wanted[name] : value(snapshot.data, name);
          if (expected === null) {
            if (profileWriteSwitches.has(name) && ['', '0', 'false'].includes(body.get(name).trim().toLowerCase())) continue;
            return false;
          }
          const native = snapshot.data[name];
          const wire = !Object.hasOwn(wanted, name) && typeof native === 'boolean' ? (native ? '1' : '0') : String(expected);
          if (body.get(name) !== wire) return false;
        }
        for (const [key, raw] of body) {
          const name = key.toLowerCase(), val = raw.trim().toLowerCase();
          if (['pageaction', 'action'].includes(name) && val) return false;
          if (['newprofileclick', 'createinactiveprofileflag', 'savecctoprofile', 'savesettlementcctoprofile'].includes(name) &&
              !['', '0', 'false'].includes(val)) return false;
        }
        return matchesSavedStageRequest(request, frame, spec.path, wanted);
      } catch { return false; }
    },
    async authorizeCandidate(request) {
      if (!gate.matchesCandidate(request) || authorizationPending || authorizedRequest || dispatchPending) return false;
      authorizationPending = true;
      try {
        if ((await callbacks.authorizeCandidate(request)) !== true || !gate.matchesCandidate(request)) return false;
        authorizedRequest = request; return true;
      } finally { authorizationPending = false; }
    },
    async dispatchCandidate(request, proceedOnce) {
      if (!gate.matchesCandidate(request) || authorizedRequest !== request || dispatchPending ||
          typeof proceedOnce !== 'function') return false;
      authorizedRequest = null; dispatchPending = true;
      let used = false, continuationActive = true;
      dispatchTask = (async () => {
        try {
          return await callbacks.dispatchCandidate(request, () => {
            if (!continuationActive || used || !gate.matchesCandidate(request)) return false;
            used = true; requests.set('candidate', request); state = 'candidate_consumed';
            return proceedOnce();
          });
        } finally {
          continuationActive = false; dispatchPending = false;
          if (state === 'candidate_armed') state = 'closed';
        }
      })();
      return dispatchTask;
    },
    async drainCandidate() {
      if (!dispatchTask) return false;
      await dispatchTask;
      return active() && state === 'candidate_consumed' && !dispatchPending;
    },
    finishCandidate() { if (!active() || state !== 'candidate_consumed' || dispatchPending) return false; clear(); state = 'ready'; return true; },
    isRequest(phase, request) { return requests.get(phase) === request; },
    isActive() { return active(); },
    close() { state = 'closed'; clear(); },
  });
  issued.add(gate); return gate;
}
