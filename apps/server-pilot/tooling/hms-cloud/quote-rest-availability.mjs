// Offline only: BSSTRT HttpOnly cookies, shell/empty bookingSessionID, cold-session
// CSRF initialization, and selected-property response parity are unverified in live HMS.
// A rejected or unprovable session/response must fall back to the browser reader.
import { getPropertyRegistration } from './property-registry.mjs';
import { withCloudReadSession } from './cloud-session.mjs';
import { isReviewedAvailabilityInquiry, rejectDuplicateAvailabilityJsonKeys } from './quote-availability-policy.mjs';

const path = '/api/internalBooking/rateshop/inquiryForGrid?houseAvailabilityOnly=false';
const evidence = Object.freeze({ evidenceKind: 'rest_availability_read', domCalendarVerified: false,
  screenshotsVerified: false, displayedRounding: 'unverified_no_dom', payableTotal: 'unverified' });
const failure = (outcome, issue) => ({ ...evidence, outcome, issue });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const isoDay = value => {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const iso = match ? `${match[3]}-${match[1]}-${match[2]}` : value;
  return day(iso) ? iso : null;
};
const code = value => typeof value === 'string' && /^[A-Z0-9_-]{1,128}$/.test(value);
const label = value => typeof value === 'string' && value.length <= 300 && !/[\p{Cc}]/u.test(value) ? value : null;
const amount = value => (typeof value === 'string' || typeof value === 'number') &&
  /^\d{1,15}(?:\.\d{1,4})?$/.test(String(value)) ? String(value) : null;
const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;

/** The cache is private to one leased Cloud session, and scoped to the selected property. */
export function quoteRestSessionCacheKey(identity) {
  if (!object(identity) || !['tenantId', 'landingPropertyCode', 'selectedPropertyCode', 'origin', 'capabilityScope']
    .every(key => typeof identity[key] === 'string' && identity[key].length > 0) ||
    !/^[a-f0-9]{64}$/.test(identity.credentialVersionHmacSha256 ?? '')) return null;
  return JSON.stringify([identity.tenantId, identity.landingPropertyCode, identity.selectedPropertyCode,
    identity.origin, identity.credentialVersionHmacSha256, identity.capabilityScope]);
}

/** Admission for direct HTTP is independent of Playwright's route guard. */
export function validateDirectAvailabilityInquiryRequest(request, propertyCode) {
  try {
    const property = getPropertyRegistration(propertyCode);
    if (!property?.active || !object(request) || request.method !== 'POST' || request.redirect !== 'manual' ||
        request.url !== `${property.origin}${path}` || !(request.signal instanceof AbortSignal)) return false;
    const headers = new Headers(request.headers);
    if (headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return false;
    const nativeRequest = { url: () => request.url, method: () => request.method, resourceType: () => 'fetch',
      headers: () => ({ 'content-type': headers.get('content-type') }), postData: () => request.body };
    return isReviewedAvailabilityInquiry(nativeRequest, { origin: property.origin, propertyCode,
      rejectDuplicateJsonBodyKeys: rejectDuplicateAvailabilityJsonKeys });
  } catch { return false; }
}

function requestBody(criteria, bookingSessionID) {
  if (!object(criteria) || !day(criteria.arrivalDate) || !day(criteria.departureDate) ||
      !Array.isArray(criteria.childAges) || !Number.isSafeInteger(criteria.adults) ||
      !Array.isArray(criteria.roomTypeCodes) || !criteria.roomTypeCodes.every(code) ||
      !Array.isArray(criteria.ratePlanCodes) || !criteria.ratePlanCodes.every(code)) return null;
  const nights = (Date.parse(criteria.departureDate) - Date.parse(criteria.arrivalDate)) / 86400000;
  if (!Number.isInteger(nights) || nights < 1 || nights > 30) return null;
  return {
    propertyCodes: criteria.propertyCode, startDate: `${criteria.arrivalDate}T00:00:00`, numberOfDays: String(nights),
    lengthOfStay: 'DY', adultCount: criteria.adults, childCount: criteria.childAges.length,
    childAges: [...criteria.childAges], salesStrategy: null, roomTypeCodes: criteria.roomTypeCodes.join(','),
    ratePlanCodes: criteria.ratePlanCodes.join(','), currency: null, convertFromPropertyCurrency: false,
    shopByDay: false, showCollapsedByProperty: false, showCollapsedByRoomType: false,
    excludeOverbookingLimits: false, showRestrictedSellOptions: false, showExclusiveRates: false,
    launchedFrom: 'hotelavailability', showCollapsedByBuilding: false, buildingCodes: [],
    showArrivalDepartureCount: false, showSubGroupView: false, groupID: '',
    organizationID: criteria.organizationID ?? '', travelAgencyID: criteria.travelAgencyID ?? '', bookingSessionID,
  };
}

const appliedFields = ['propertyCodes', 'startDate', 'numberOfDays', 'adultCount', 'childCount', 'childAges',
  'organizationID', 'travelAgencyID', 'groupID', 'roomTypeCodes', 'ratePlanCodes'];
function matchingEcho(echo, body) {
  return object(echo) && appliedFields.every(key => Object.hasOwn(echo, key) &&
    JSON.stringify(echo[key]) === JSON.stringify(body[key]));
}

function restrictionEvidence(...values) {
  const sources = values.filter(object);
  const closedOrRestricted = sources.some(source => source.restricted === true || source.closed === true ||
    source.combClosed === true || source.isRestrictedByRevenueManagement === true || source.israteavailable === false);
  const known = {
    isclosed: ['isclosed', 'closed', 'combClosed'],
    isclosetoarrival: ['isclosetoarrival', 'closedToArrival', 'combClosedToArrival'],
    isclosetedeparture: ['isclosetedeparture', 'closedToDeparture', 'combClosedToDeparture'],
  };
  const flags = {};
  const unknown = new Set();
  for (const [name, aliases] of Object.entries(known)) {
    const values = sources.flatMap(source => aliases.filter(key => Object.hasOwn(source, key)).map(key => source[key]));
    flags[name] = values.length && values.every(value => typeof value === 'boolean') ? values.some(Boolean) : null;
    if (flags[name] === null) unknown.add(name);
  }
  for (const source of sources) for (const [key, value] of Object.entries(source)) {
    if (!/restrict|closed|los|leadtime|israteavailable|maxnights|availablelimitnightcount|externalselloptionnotavailablereason/i.test(key) ||
        Object.values(known).some(list => list.includes(key))) continue;
    if (['restricted', 'isRestrictedByRevenueManagement', 'israteavailable'].includes(key) &&
        value != null && typeof value !== 'boolean') {
      unknown.add(key);
    } else if ((key === 'restricted' || key === 'isRestrictedByRevenueManagement') && typeof value === 'boolean') {
      // Known restrictions are retained in closedOrRestricted.
    } else if (key === 'israteavailable' && typeof value === 'boolean') {
      // A true rate-available flag does not prove the missing restrictions.
    } else if (typeof value === 'boolean' || (value !== null && value !== false && value !== 0 && value !== '')) unknown.add(key);
  }
  return { ...flags, closedOrRestricted, unknownRestrictionFlags: [...unknown].sort() };
}

/** Requires a server echo; the submitted body alone cannot prove HMS applied the criteria. */
export function normalizeQuoteRestAvailability(response, body) {
  if (!object(body) || !object(response) || !matchingEcho(response.appliedCriteria, body)) return null;
  const data = response.availabilitydata;
  if (!object(data) || !Array.isArray(data.datesList) || !Array.isArray(data.children)) return null;
  const nights = Number(body.numberOfDays);
  if (!Number.isInteger(nights) || nights < 1 || nights > 30) return null;
  const start = Date.parse(`${String(body.startDate).slice(0, 10)}T00:00:00Z`);
  const expectedDates = Array.from({ length: nights }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
  if (data.datesList.length !== nights && data.datesList.length !== nights + 1) return null;
  if (data.datesList.some((value, i) => isoDay(value) !== new Date(start + i * 86400000).toISOString().slice(0, 10))) return null;
  const properties = data.children.filter(row => object(row) && row.isprop === true && row.issummary !== true);
  if (properties.length !== 1 || properties[0].code !== body.propertyCodes || !Array.isArray(properties[0].children)) return null;
  const observations = [];
  const seen = new Set();
  const roomFilter = body.roomTypeCodes ? new Set(body.roomTypeCodes.split(',')) : null;
  const rateFilter = body.ratePlanCodes ? new Set(body.ratePlanCodes.split(',')) : null;
  let partial = data.datesList.length === nights;
  for (const room of properties[0].children) {
    if (!object(room) || !code(room.code) || (roomFilter && !roomFilter.has(room.code)) ||
        !Array.isArray(room.children) || !object(room.columns)) return null;
    for (const rate of room.children) {
      if (!object(rate) || !code(rate.code) || (rateFilter && !rateFilter.has(rate.code)) || !object(rate.columns)) return null;
      if (rate.promotioncode != null && rate.promotioncode !== '' && !code(rate.promotioncode)) return null;
      const promotionCode = rate.promotioncode || null;
      const rowKey = JSON.stringify([room.code, rate.code, promotionCode]);
      if (seen.has(rowKey)) return null;
      seen.add(rowKey);
      const serverCurrency = currency(rate.currency);
      const nightly = expectedDates.map((date, i) => {
        const roomColumn = room.columns[`col${i + 1}`];
        const rateColumn = rate.columns[`col${i + 1}`];
        const propertyColumn = properties[0].columns?.[`col${i + 1}`];
        const count = object(roomColumn) && Number.isSafeInteger(roomColumn.value) && roomColumn.value >= 0 ? roomColumn.value : null;
        const value = object(rateColumn) ? amount(rateColumn.value) : null;
        const restrictions = restrictionEvidence(properties[0], propertyColumn, room, roomColumn, rate, rateColumn);
        for (const [name, value] of [['property.restricted', propertyColumn?.restricted], ['rate.restricted', rate.restricted],
          ['rateCell.restricted', rateColumn?.restricted], ['rateCell.combClosed', rateColumn?.combClosed],
          ['rateCell.israteavailable', rateColumn?.israteavailable]]) {
          if (typeof value !== 'boolean') restrictions.unknownRestrictionFlags.push(name);
        }
        restrictions.unknownRestrictionFlags.sort();
        if (count === null || value === null || !serverCurrency || restrictions.unknownRestrictionFlags.length) partial = true;
        return { date, availableCount: count, rate: value, currency: serverCurrency, restrictions };
      });
      const departureColumn = `col${nights + 1}`;
      const hasDeparture = data.datesList.length === nights + 1;
      const propertyColumn = hasDeparture ? properties[0].columns?.[departureColumn] : null;
      const roomColumn = hasDeparture ? room.columns[departureColumn] : null;
      const rateColumn = hasDeparture ? rate.columns[departureColumn] : null;
      const restrictions = restrictionEvidence(properties[0], propertyColumn, room, roomColumn, rate, rateColumn);
      for (const [name, value] of [['property.restricted', propertyColumn?.restricted], ['rate.restricted', rate.restricted],
        ['rateCell.restricted', rateColumn?.restricted], ['rateCell.combClosed', rateColumn?.combClosed],
        ['rateCell.israteavailable', rateColumn?.israteavailable]]) {
        if (typeof value !== 'boolean') restrictions.unknownRestrictionFlags.push(name);
      }
      restrictions.unknownRestrictionFlags.sort();
      const departure = { date: new Date(start + nights * 86400000).toISOString().slice(0, 10),
        verified: hasDeparture && restrictions.unknownRestrictionFlags.length === 0, restrictions };
      if (!departure.verified) partial = true;
      observations.push({ room: { code: room.code, label: label(room.desc) },
        rate: { code: rate.code, label: label(rate.desc), promotionCode }, nightly, departure });
      if (observations.length > 1000) return null;
    }
  }
  const appliedCriteria = Object.fromEntries(appliedFields.map(key => [key, structuredClone(body[key])]));
  return { ...evidence, outcome: partial ? 'partial' : 'rest_observed', observedAt: new Date().toISOString(),
    appliedCriteria, criteriaEchoVerified: true, observations };
}

function cookieHeader(cookies) {
  if (!Array.isArray(cookies) || !cookies.length) return null;
  const names = new Set();
  const pairs = [];
  for (const cookie of cookies) {
    if (!object(cookie) || typeof cookie.name !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name) ||
        typeof cookie.value !== 'string' || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(cookie.value) || names.has(cookie.name)) return null;
    names.add(cookie.name);
    pairs.push(`${cookie.name}=${cookie.value}`);
  }
  return pairs.join('; ');
}

async function boundedJsonText(response, signal) {
  const limit = 4 * 1024 * 1024;
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error('REST_RESPONSE_REJECTED');
  if (!response.body) throw new Error('REST_RESPONSE_REJECTED');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('REST_RESPONSE_REJECTED');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** The caller holds the property read lock; every request also holds the verified Cloud credential lease. */
export async function readQuoteRestAvailability({ propertyCode, transportId, criteria, signal, env = process.env } = {}) {
  if (env?.HMS_QUOTE_REST_FAST_PATH !== 'on') return failure('unsupported_context', 'REST_FAST_PATH_DISABLED');
  signal?.throwIfAborted();
  const property = getPropertyRegistration(propertyCode);
  if (!property?.active || !Array.isArray(criteria) || !criteria.length || criteria.length > 8 ||
      criteria.some(item => item?.propertyCode !== propertyCode)) return failure('unsupported_context', 'REST_CRITERIA_UNSUPPORTED');
  const cache = new Map();
  let cacheKey = null;
  try {
    return await withCloudReadSession(async (page, identity, session) => {
      session.signal.throwIfAborted();
      if (identity.propertyCode !== propertyCode || identity.tenantId !== property.expectedTenant ||
          identity.landingPropertyCode !== property.landingPropertyCode || identity.origin !== property.origin) {
        return failure('unsupported_context', 'REST_SESSION_IDENTITY_UNVERIFIED');
      }
      cacheKey = quoteRestSessionCacheKey({ tenantId: identity.tenantId, landingPropertyCode: identity.landingPropertyCode,
        selectedPropertyCode: identity.propertyCode, origin: identity.origin,
        credentialVersionHmacSha256: session.credentialVersionHmacSha256,
        capabilityScope: `rateshop-read:${transportId ?? 'unbound'}` });
      if (!cacheKey) return failure('unsupported_context', 'REST_CREDENTIAL_VERSION_UNVERIFIED');
      const cookies = await page.context().cookies(property.origin);
      const cookie = cookieHeader(cookies);
      const bookingSessionID = await page.evaluate(() => {
        const app = globalThis.EAM?.AppData?.getRawAppData?.() ?? {};
        const values = [app.bookingSessionID, app.bookingsessionid,
          ...Array.from(document.querySelectorAll('input[name="bookingsessionid"]'), element => element.value)];
        const unique = [...new Set(values.filter(value => typeof value === 'string' && value.trim()))];
        return unique.length === 1 ? unique[0] : null;
      });
      if (!cookie || typeof bookingSessionID !== 'string' || !bookingSessionID.trim() ||
          !/^[\x20-\x7e]{1,128}$/.test(bookingSessionID)) return failure('unsupported_context', 'REST_SESSION_UNAVAILABLE');
      cache.set(cacheKey, { cookie, bookingSessionID });
      const observations = [];
      for (const item of criteria) {
        session.signal.throwIfAborted();
        const sessionState = cache.get(cacheKey);
        const body = requestBody(item, sessionState.bookingSessionID);
        const requestSignal = AbortSignal.any([session.signal, AbortSignal.timeout(30000)]);
        const request = { method: 'POST', url: `${property.origin}${path}`, redirect: 'manual', signal: requestSignal,
          headers: { 'content-type': 'application/json', accept: 'application/json', cookie: sessionState.cookie },
          body: JSON.stringify(body) };
        if (!body || !validateDirectAvailabilityInquiryRequest(request, propertyCode)) throw new Error('REST_REQUEST_REJECTED');
        const response = await fetch(request.url, { method: 'POST', headers: request.headers,
          body: request.body, redirect: request.redirect, signal: request.signal });
        requestSignal.throwIfAborted();
        if (response.status !== 200 || response.redirected ||
            (response.url && response.url !== request.url) ||
            response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          throw new Error('REST_RESPONSE_REJECTED');
        }
        const raw = await boundedJsonText(response, requestSignal);
        requestSignal.throwIfAborted();
        const data = JSON.parse(raw);
        rejectDuplicateAvailabilityJsonKeys(raw);
        const normalized = normalizeQuoteRestAvailability(data, body);
        if (!normalized) throw new Error('REST_RESPONSE_UNVERIFIED');
        observations.push(normalized);
      }
      return { ...evidence, outcome: observations.some(item => item.outcome === 'partial') ? 'partial' : 'rest_observed',
        groups: observations };
    }, { propertyCode, transportId, signal, headless: true, startScreen: 'BSSTRT', requireBoundCredentialVersion: true });
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    return failure('execution_failure', 'REST_AVAILABILITY_FAILED');
  } finally {
    if (cacheKey) cache.delete(cacheKey);
    cache.clear();
  }
}
