import { getPropertyRegistration } from './property-registry.mjs';
import { tsImport } from 'tsx/esm/api';

const { rejectDuplicateJsonBodyKeys } = await tsImport('../../src/hms/request-policy.ts', import.meta.url);

export function rejectDuplicateAvailabilityJsonKeys(raw) {
  return rejectDuplicateJsonBodyKeys(raw);
}
// Reviewed property-scoped Hotel Availability requests. Never admit Guest Stay or saves.
export function availabilityScreenRules(origin, propertyCode) {
  if (!getPropertyRegistration(propertyCode)?.active) throw new Error('QUOTE_PROPERTY_REQUIRED');
  const rule = (id, path, fixedQuery, fixedBody) => ({
    id, origin, method: 'POST', path, resourceTypes: ['xhr', 'fetch'],
    contentType: 'application/x-www-form-urlencoded', fixedQuery, variableQuery: {},
    fixedBody, variableBody: {}, maxBodyBytes: 4096, redirectPolicy: 'same-reviewed-chain',
  });
  return [
    rule('quote-osmpav', '/web/base/OSMPAV', { USER_FUNCTION_NAME: 'OSMPAV', FUNCTION_CLASS: 'WEBL' },
      { USER_FUNCTION_NAME: 'OSMPAV', FUNCTION_CLASS: 'WEBL', SYSTEM_FUNCTION_NAME: 'OSMPAV',
        CURRENT_TAB_NAME: '', MENU_MODULE_KEY: '0', removescreenflows: 'yes' }),
    rule('quote-osmpav-hdr', '/web/base/OSMPAV.HDR', {},
      { SYSTEM_FUNCTION_NAME: 'OSMPAV', USER_FUNCTION_NAME: 'OSMPAV', CURRENT_TAB_NAME: 'HDR' }),
    rule('quote-company-picker', '/web/base/LOVPOP', {},
      { GRID_NAME: 'LVCOMPANIES2', GRID_TYPE: 'LOV', REQUEST_TYPE: 'LOV.HEAD_DATA.STORED',
        LOV_TAGNAME: 'organization', popup: 'true', USER_FUNCTION_NAME: 'OSMPAV', CURRENT_TAB_NAME: 'HDR' }),
    rule('quote-agency-picker', '/web/base/LOVPOP', {},
      { GRID_NAME: 'LVTRAVELAGENCIES5', GRID_TYPE: 'LOV', REQUEST_TYPE: 'LOV.HEAD_DATA.STORED',
        LOV_TAGNAME: 'travelagency', popup: 'true', USER_FUNCTION_NAME: 'OSMPAV', CURRENT_TAB_NAME: 'HDR' }),
    rule('quote-roomtype-picker', '/web/base/BSMSLV', {},
      { GRID_NAME: 'LVMULTIROOMTYPESMULTIPROP', GRID_TYPE: 'LIST', REQUEST_TYPE: 'LIST.HEAD_DATA.STORED',
        dataspytoolbar: 'true', LOV_ALIAS_NAME_1: 'param.propertycodes', LOV_ALIAS_VALUE_1: propertyCode, LOV_ALIAS_TYPE_1: 'text' }),
    { ...rule('quote-group-picker', '/web/base/LOVPOP', {},
      { GRID_NAME: 'LVGROUPS5', GRID_TYPE: 'LOV', REQUEST_TYPE: 'LOV.HEAD_DATA.STORED',
        LOV_TAGNAME: 'groupname', popup: 'true', USER_FUNCTION_NAME: 'OSMPAV', CURRENT_TAB_NAME: 'HDR',
        LOV_ALIAS_NAME_1: 'param.propertycodes', LOV_ALIAS_VALUE_1: propertyCode, LOV_ALIAS_TYPE_1: 'text',
        LOV_ALIAS_NAME_2: 'param.arrivaldate', LOV_ALIAS_TYPE_2: 'text',
        LOV_ALIAS_NAME_3: 'param.nights', LOV_ALIAS_TYPE_3: 'integer' }),
      variableBody: {
        LOV_ALIAS_VALUE_2: { pattern: '\\d{2}/\\d{2}/\\d{4}', maxLength: 10 },
        LOV_ALIAS_VALUE_3: { pattern: '[1-9]\\d{0,2}', maxLength: 3 },
      } },
    { ...rule('quote-company-search', '/web/base/GRIDDATA', {},
      { GRID_ID: '1134', GRID_NAME: 'LVCOMPANIES2', DATASPY_ID: '1224',
        MADDON_FILTER_ALIAS_NAME_1: 'companyname', MADDON_FILTER_OPERATOR_1: 'CONTAINS',
        MADDON_FILTER_JOINER_1: 'AND', MADDON_FILTER_SEQNUM_1: '1', USER_FUNCTION_NAME: 'OSMPAV',
        CURRENT_TAB_NAME: 'HDR', GRID_TYPE: 'LOV', REQUEST_TYPE: 'LOV.DATA_ONLY.STORED',
        LOV_TAGNAME: 'organization' }),
      variableBody: { MADDON_FILTER_VALUE_1: { pattern: '[^\\r\\n]{1,200}', maxLength: 200 } } },
    { ...rule('quote-company-id-search', '/web/base/GRIDDATA', {},
      { GRID_ID: '1134', GRID_NAME: 'LVCOMPANIES2', DATASPY_ID: '1224',
        MADDON_FILTER_ALIAS_NAME_1: 'companyid', MADDON_FILTER_OPERATOR_1: 'CONTAINS',
        MADDON_FILTER_JOINER_1: 'AND', MADDON_FILTER_SEQNUM_1: '1', USER_FUNCTION_NAME: 'OSMPAV',
        CURRENT_TAB_NAME: 'HDR', GRID_TYPE: 'LOV', REQUEST_TYPE: 'LOV.DATA_ONLY.STORED',
        LOV_TAGNAME: 'organization' }),
      variableBody: { MADDON_FILTER_VALUE_1: { pattern: '[^\\r\\n]{1,200}', maxLength: 200 } } },
    { ...rule('quote-agency-search', '/web/base/GRIDDATA', {},
      { GRID_ID: '2475', GRID_NAME: 'LVTRAVELAGENCIES5', DATASPY_ID: '2829',
        MADDON_FILTER_ALIAS_NAME_1: 'travelagencyname', MADDON_FILTER_OPERATOR_1: 'CONTAINS',
        MADDON_FILTER_JOINER_1: 'AND', MADDON_FILTER_SEQNUM_1: '1', USER_FUNCTION_NAME: 'OSMPAV',
        CURRENT_TAB_NAME: 'HDR', GRID_TYPE: 'LOV', REQUEST_TYPE: 'LOV.DATA_ONLY.STORED',
        LOV_TAGNAME: 'travelagency' }),
      variableBody: { MADDON_FILTER_VALUE_1: { pattern: '[^\\r\\n]{1,200}', maxLength: 200 } } },
    { ...rule('quote-agency-code-search', '/web/base/GRIDDATA', {},
      { GRID_ID: '2475', GRID_NAME: 'LVTRAVELAGENCIES5', DATASPY_ID: '2829',
        MADDON_FILTER_ALIAS_NAME_1: 'iatanumber', MADDON_FILTER_OPERATOR_1: 'CONTAINS',
        MADDON_FILTER_JOINER_1: 'AND', MADDON_FILTER_SEQNUM_1: '1', USER_FUNCTION_NAME: 'OSMPAV',
        CURRENT_TAB_NAME: 'HDR', GRID_TYPE: 'LOV', REQUEST_TYPE: 'LOV.DATA_ONLY.STORED',
        LOV_TAGNAME: 'travelagency' }),
      variableBody: { MADDON_FILTER_VALUE_1: { pattern: '[^\\r\\n]{1,200}', maxLength: 200 } } },
    { ...rule('quote-group-search', '/web/base/GRIDDATA', {},
      { GRID_ID: '2512', GRID_NAME: 'LVGROUPS5', DATASPY_ID: '2872',
        MADDON_FILTER_OPERATOR_1: 'CONTAINS',
        MADDON_FILTER_JOINER_1: 'AND', MADDON_FILTER_SEQNUM_1: '1', USER_FUNCTION_NAME: 'OSMPAV',
        CURRENT_TAB_NAME: 'HDR', GRID_TYPE: 'LOV', REQUEST_TYPE: 'LOV.DATA_ONLY.STORED',
        LOV_TAGNAME: 'groupname', LOV_ALIAS_NAME_1: 'param.propertycodes', LOV_ALIAS_VALUE_1: propertyCode,
        LOV_ALIAS_TYPE_1: 'text', LOV_ALIAS_NAME_2: 'param.arrivaldate', LOV_ALIAS_TYPE_2: 'text',
        LOV_ALIAS_NAME_3: 'param.nights', LOV_ALIAS_TYPE_3: 'integer' }),
      variableBody: { MADDON_FILTER_ALIAS_NAME_1: { pattern: '(?:groupsname|confirmationnumber)', maxLength: 18 },
        MADDON_FILTER_VALUE_1: { pattern: '[^\\r\\n]{1,200}', maxLength: 200 },
        LOV_ALIAS_VALUE_2: { pattern: '\\d{2}/\\d{2}/\\d{4}', maxLength: 10 },
        LOV_ALIAS_VALUE_3: { pattern: '[1-9]\\d{0,2}', maxLength: 3 } } },
  ];
}

const requiredKeys = [
  'propertyCodes', 'startDate', 'numberOfDays', 'lengthOfStay', 'adultCount', 'childCount',
  'salesStrategy', 'roomTypeCodes', 'ratePlanCodes', 'currency', 'convertFromPropertyCurrency',
  'shopByDay', 'showCollapsedByProperty', 'showCollapsedByRoomType', 'excludeOverbookingLimits',
  'showRestrictedSellOptions', 'showExclusiveRates', 'launchedFrom', 'showCollapsedByBuilding',
  'buildingCodes', 'showArrivalDepartureCount', 'showSubGroupView', 'groupID', 'organizationID',
  'travelAgencyID', 'bookingSessionID',
];
const flags = [
  'convertFromPropertyCurrency', 'shopByDay', 'showCollapsedByProperty', 'showCollapsedByRoomType',
  'excludeOverbookingLimits', 'showRestrictedSellOptions', 'showExclusiveRates',
  'showCollapsedByBuilding', 'showArrivalDepartureCount', 'showSubGroupView',
];
const nativeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{0,128}$/.test(value);
const codes = (value) => typeof value === 'string' && /^(?:[A-Z0-9_-]+(?:,[A-Z0-9_-]+)*)?$/.test(value) && value.length <= 512;

const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const roomCode = (value) => typeof value === 'string' && /^[A-Z0-9_-]{1,128}$/.test(value);
const writeAction = /^(?:save|delete|update|cancel|duplicate|checkin|checkout|insert|commit|create|submit|post|amend|book|confirm|upload|send)/i;
function hasAvailabilityWriteIntent(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) =>
    (/^(?:pageaction|action|autosave)$/i.test(key) && writeAction.test(String(entry).trim())) ||
    (/^(?:newprofileclick|confirmnewguestprofile|confirminactiveguestprofile|createinactiveprofileflag|linkprofileflag|savecctoprofile|savesettlementcctoprofile)$/i.test(key) &&
      !['', '0', 'false', '-'].includes(String(entry).trim().toLowerCase())) || hasAvailabilityWriteIntent(entry));
}

// Derive a snapshot, not a reference to the caller's mutable quote request.
export function availabilityDetailsScope(request, propertyCode) {
  try {
    if (!getPropertyRegistration(propertyCode)?.active || request?.propertyCode !== propertyCode || request.details !== 'full' ||
        !validDate(request.arrivalDate) || !validDate(request.departureDate) ||
        !Array.isArray(request.rooms) || request.rooms.length < 1 || request.rooms.length > 8) return null;
    const nights = (Date.parse(request.departureDate) - Date.parse(request.arrivalDate)) / 86400000;
    if (!Number.isInteger(nights) || nights < 1 || nights > 30) return null;
    let unrestricted = false;
    const rooms = new Set();
    for (const room of request.rooms) {
      if (!room || typeof room !== 'object' || Array.isArray(room) ||
          (room.required !== undefined && (!room.required || typeof room.required !== 'object' || Array.isArray(room.required)))) return null;
      const list = room.required?.roomCodes;
      if (list === undefined) unrestricted = true;
      else {
        if (!Array.isArray(list) || list.length < 1 || list.length > 512 || !list.every(roomCode)) return null;
        for (const code of list) rooms.add(code);
      }
    }
    return Object.freeze({ arrivalDate: request.arrivalDate, departureDate: request.departureDate,
      roomCodes: unrestricted ? null : Object.freeze([...rooms]) });
  } catch { return null; }
}

/** Only the observed read-only, single-day selected-property details inquiry is admitted. */
export function isReviewedAvailabilityDetailsInquiry(request, { origin, propertyCode, rejectDuplicateJsonBodyKeys, detailsScope }) {
  try {
    if (!getPropertyRegistration(propertyCode)?.active || !detailsScope) return false;
    const target = new URL(request.url());
    if (request.method() !== 'POST' || !['xhr', 'fetch'].includes(request.resourceType()) ||
        target.origin !== origin || target.username || target.password ||
        target.href !== `${origin}/api/booking/hotelAvail/${propertyCode}/availabilityDetailsInquiry`) return false;
    const headers = request.headers();
    const contentType = headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    const raw = request.postData();
    if (contentType !== 'application/json' || headers.bookingclientsessionid !== 'forceRelay' ||
        typeof raw !== 'string' || Buffer.byteLength(raw) > 4096 || typeof rejectDuplicateJsonBodyKeys !== 'function') return false;
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    rejectDuplicateJsonBodyKeys(raw);
    const keys = ['roomType', 'building', 'startDate', 'endDate'];
    if (keys.some((key) => !Object.hasOwn(body, key)) ||
        !roomCode(body.roomType) || body.building !== '' || !validDate(body.startDate) ||
        body.endDate !== body.startDate || body.startDate < detailsScope.arrivalDate ||
        body.startDate >= detailsScope.departureDate ||
        (detailsScope.roomCodes && !detailsScope.roomCodes.includes(body.roomType))) return false;
    return true;
  } catch { return false; }
}

/** The observed OSCCRT popup reads the selected room type, with no guest. */
export function isReviewedRoomInformationRequest(request, { origin, propertyCode, detailsScope }) {
  try {
    if (!getPropertyRegistration(propertyCode)?.active || !detailsScope) return false;
    const target = new URL(request.url());
    if (request.method() !== 'POST' || !['xhr', 'fetch'].includes(request.resourceType()) ||
        target.origin !== origin || target.username || target.password || target.href !== `${origin}/web/base/OSCCRT`) return false;
    const contentType = request.headers()['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    const raw = request.postData();
    if (contentType !== 'application/x-www-form-urlencoded' || typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) return false;
    const body = new URLSearchParams(raw);
    const keys = ['SYSTEM_FUNCTION_NAME', 'USER_FUNCTION_NAME', 'propertycode', 'roomtypecode', 'guestid'];
    if (keys.some((key) => body.getAll(key).length !== 1) ||
        body.get('SYSTEM_FUNCTION_NAME') !== 'OSCCRT' || body.get('USER_FUNCTION_NAME') !== 'OSCCRT' ||
        body.get('propertycode') !== propertyCode || body.get('guestid') !== '' || !roomCode(body.get('roomtypecode')) ||
        (detailsScope.roomCodes && !detailsScope.roomCodes.includes(body.get('roomtypecode')))) return false;
    return true;
  } catch { return false; }
}

/** Static view loaded by the reviewed room-information popup. */
export function isReviewedRoomInformationAsset(request, { origin, propertyCode, detailsScope }) {
  try {
    if (!getPropertyRegistration(propertyCode)?.active || !detailsScope || request.method() !== 'GET' || request.resourceType() !== 'xhr' ||
        request.postData() !== null) return false;
    const target = new URL(request.url());
    const cacheBuster = target.searchParams.get('_dc');
    return target.origin === origin && !target.username && !target.password &&
      typeof cacheBuster === 'string' && /^\d{13}$/.test(cacheBuster) &&
      target.href === `${origin}/web/base/app/view/operations/callcenter/osccrt.js?_dc=${cacheBuster}`;
  } catch { return false; }
}

/** Read only the scoped room information, never guest preferences. */
export function isReviewedRoomInformationRead(request, { origin, propertyCode, detailsScope }) {
  try {
    if (!getPropertyRegistration(propertyCode)?.active || !detailsScope || request.method() !== 'GET' || request.resourceType() !== 'xhr' ||
        request.postData() !== null || request.headers().bookingclientsessionid !== 'forceRelay') return false;
    const target = new URL(request.url());
    const match = new RegExp(`^/api/booking/${propertyCode}/roomType/([A-Z0-9_-]{1,128})$`).exec(target.pathname);
    const cacheBuster = target.searchParams.get('_dc');
    return target.origin === origin && !target.username && !target.password && match &&
      (!detailsScope.roomCodes || detailsScope.roomCodes.includes(match[1])) &&
      typeof cacheBuster === 'string' && /^\d{13}$/.test(cacheBuster) &&
      target.href === `${origin}${target.pathname}?_dc=${cacheBuster}`;
  } catch { return false; }
}

/** Admit the selected property's Guest Stay rate catalogue without a reservation. */
export function isReviewedGuestStayRatePlanInquiry(request, { origin, propertyCode, rejectDuplicateJsonBodyKeys }) {
  try {
    if (!getPropertyRegistration(propertyCode)?.active || request.method() !== 'POST' ||
        !['xhr', 'fetch'].includes(request.resourceType()) ||
        request.url() !== `${origin}/api/internalBooking/rateshop/inquiryForGrid?houseAvailabilityOnly=true`) return false;
    const contentType = request.headers()['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    const raw = request.postData();
    if (contentType !== 'application/json' || typeof raw !== 'string' || Buffer.byteLength(raw) > 8192 ||
        typeof rejectDuplicateJsonBodyKeys !== 'function') return false;
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body) || hasAvailabilityWriteIntent(body)) return false;
    rejectDuplicateJsonBodyKeys(raw);
    return typeof body.propertyCodes === 'string' && body.propertyCodes.trim().toUpperCase() === propertyCode &&
      !String(body.reservationStayID ?? '').trim() && typeof body.launchedFrom === 'string' &&
      body.launchedFrom.trim().toLowerCase() === 'gueststay';
  } catch { return false; }
}

/** Validate the selected property, read action and business criteria; unrelated form fields may drift. */
export function isReviewedAvailabilityInquiry(request, { origin, propertyCode, rejectDuplicateJsonBodyKeys }) {
  try {
    const target = new URL(request.url());
    if (request.method() !== 'POST' || !['xhr', 'fetch'].includes(request.resourceType()) ||
        target.origin !== origin || target.username || target.password || target.hash ||
        target.pathname !== '/api/internalBooking/rateshop/inquiryForGrid' ||
        [...target.searchParams].length !== 1 || target.searchParams.get('houseAvailabilityOnly') !== 'false') return false;
    const contentType = request.headers()['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    const raw = request.postData();
    if (contentType !== 'application/json' || typeof raw !== 'string' || Buffer.byteLength(raw) > 8192 ||
        typeof rejectDuplicateJsonBodyKeys !== 'function') return false;
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body) || hasAvailabilityWriteIntent(body)) return false;
    rejectDuplicateJsonBodyKeys(raw);
    if (requiredKeys.some((key) => !Object.hasOwn(body, key))) return false;
    if (body.propertyCodes !== propertyCode || body.launchedFrom !== 'hotelavailability' || body.lengthOfStay !== 'DY' ||
        typeof body.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(body.startDate) ||
        new Date(`${body.startDate}Z`).toISOString().slice(0, 19) !== body.startDate ||
        typeof body.numberOfDays !== 'string' || !/^[1-9]\d{0,2}$/.test(body.numberOfDays) ||
        !Number.isInteger(body.adultCount) || body.adultCount < 1 || body.adultCount > 30 ||
        !Number.isInteger(body.childCount) || body.childCount < 0 || body.childCount > 20 ||
        !(body.salesStrategy === null || (typeof body.salesStrategy === 'string' && /^[A-Z0-9_-]{1,32}$/.test(body.salesStrategy))) ||
        !codes(body.roomTypeCodes) || !codes(body.ratePlanCodes) ||
        !(body.currency === null || (typeof body.currency === 'string' && /^[A-Z]{3}$/.test(body.currency))) ||
        flags.some((key) => typeof body[key] !== 'boolean') ||
        ['shopByDay', 'showCollapsedByProperty', 'showCollapsedByRoomType', 'excludeOverbookingLimits',
          'showExclusiveRates', 'showCollapsedByBuilding', 'showArrivalDepartureCount', 'showSubGroupView']
          .some((key) => body[key] !== false) ||
        !Array.isArray(body.buildingCodes) || body.buildingCodes.length > 20 || body.buildingCodes.some((code) => !nativeId(code)) ||
        ['groupID', 'organizationID', 'travelAgencyID'].some((key) => !nativeId(body[key])) ||
        typeof body.bookingSessionID !== 'string' || !/^[\x20-\x7e]{0,128}$/.test(body.bookingSessionID)) return false;
    if (body.childAges !== undefined && (!Array.isArray(body.childAges) || body.childAges.length !== body.childCount ||
        body.childAges.some((age) => !Number.isInteger(age) || age < 0 || age > 99))) return false;
    return true;
  } catch { return false; }
}
