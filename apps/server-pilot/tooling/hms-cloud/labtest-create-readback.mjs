// Fresh, read-only evidence for a guarded HRCEN create attempt.
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { searchLabtestPreimage } from './labtest-preimage.mjs';
import { withSavedStayAgentSession } from './saved-stay-agent-session.mjs';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { CREATE_GUARANTEES, createCloudTargetKey, isLabtestGuest, validCreateGuest } from './cloud-create-policy.mjs';
import { compareChargeRoomCriteria, compareChargeRoomPricing } from './charge-room-pricing.mjs';

const same = (a, b) => String(a ?? '').trim().toLocaleLowerCase() === String(b ?? '').trim().toLocaleLowerCase();
const uniqueValue = (fields, name) => {
  const matches = fields.filter((field) => field.name === name);
  return matches.length === 1 ? (name === 'reservationnote' ? matches[0].rawValue ?? null : matches[0].value) : null;
};

function validExpected(stay, expected) {
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const bands = expected?.childBands, names = ['child1', 'child2', 'child3'];
  const guest = expected?.allowRealGuest === true ? expected : { firstName: 'Proof', lastName: 'Labtest' };
  return Boolean(expected && validDate(stay?.arrival) && validDate(stay?.departure) && stay.arrival < stay.departure &&
    validCreateGuest(guest) && (expected.allowRealGuest === true || isLabtestGuest(guest)) &&
    (expected.cmsSend === undefined || typeof expected.cmsSend === 'boolean') &&
    !(isLabtestGuest(guest) && expected.cmsSend === true) &&
    expected.arrival === stay.arrival && expected.departure === stay.departure && /^\d+$/.test(String(expected.guestId ?? '')) &&
    ['roomType', 'ratePlan', 'note', 'guarantee'].every((key) => typeof expected[key] === 'string' && expected[key].trim()) &&
    (expected.roomTypeForCharge === undefined || /^[A-Z0-9]{1,12}$/.test(expected.roomTypeForCharge)) &&
    (expected.guaranteeCode === undefined || CREATE_GUARANTEES[expected.guaranteeCode] === expected.guarantee) &&
    Number.isInteger(expected.adults) && expected.adults > 0 && Number.isInteger(expected.children) && expected.children >= 0 &&
    bands && Object.keys(bands).length === names.length && names.every((name) => Number.isInteger(bands[name]) && bands[name] >= 0) &&
    names.reduce((sum, name) => sum + bands[name], 0) === expected.children);
}

function compareRecord(fields, expected) {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const displayDate = (iso) => `${iso.slice(8, 10)}-${months[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
  const mismatches = [];
  for (const [field, name, wanted] of [
    ['arrival', 'arrivaldate', displayDate(expected.arrival)], ['departure', 'departuredate', displayDate(expected.departure)],
    ['adults', 'adults', expected.adults], ['children', 'children', expected.children],
    ['roomType', 'roomtype', expected.roomType], ['ratePlan', 'rateplan', expected.ratePlan],
    ['roomTypeForCharge', 'roomtypecharge', expected.roomTypeForCharge],
    ['note', 'reservationnote', expected.note], ['guestId', 'guestid', expected.guestId], ['status', 'status', 'Reserved'],
    ['firstName', 'firstname', expected.allowRealGuest ? expected.firstName : 'Proof'],
    ['lastName', 'lastname', expected.allowRealGuest ? expected.lastName : 'Labtest'],
    ['sourceOfBusiness', 'sourceofbusinessdesc', expected.source], ['organization', 'company', expected.organization],
    ['guaranteeType', 'guaranteetype', expected.guarantee], ['cmsSend', 'udfchkbox04', expected.cmsSend ?? false],
    ['cmsMessageId', 'udfchar09', expected.cmsMessageId],
    ['cmsRecipient', 'udfchar13', expected.cmsRecipient], ['guestEmail', 'emailaddress', expected.guestEmail],
    ['bookerName', 'caller', expected.booker?.name], ['bookerContact', 'udfchar06', expected.booker?.contact],
    ['track', 'track', expected.track], ['guestOptIn', 'guestoptin4', expected.guestOptIn],
    ...Object.entries(expected.childBands || {}).map(([name, value]) => [name, name, value]),
  ]) {
    if (wanted == null) continue;
    const actual = uniqueValue(fields, name);
    if (actual == null || (['note', 'guestId', 'firstName', 'lastName', 'roomType', 'roomTypeForCharge', 'ratePlan', 'cmsMessageId', 'cmsRecipient', 'guestEmail', 'bookerName', 'bookerContact'].includes(field) ? String(actual) !== String(wanted) : !same(actual, wanted))) {
      mismatches.push({ field, expected: wanted, actual, ...(actual == null ? { issue: 'not_visible_or_ambiguous' } : {}) });
    }
  }
  return mismatches;
}

/** Independently reopen one confirmation and compare the visible Record View. */
export async function readLabtestCreate({ confirmation, stay, expected }, { withSavedSession = withSavedStayAgentSession, cloudTargetKey } = {}) {
  if (!validExpected(stay, expected)) return { issue: 'expected_record_invalid' };
  const firstName = expected.allowRealGuest ? expected.firstName : 'Proof';
  const lastName = expected.allowRealGuest ? expected.lastName : 'Labtest';
  const read = await withSavedSession(({ runTool }) => runTool({ tool: 'read', confirmation,
    guestName: `${firstName} ${lastName}`, arrivalDate: stay.arrival,
    ...(expected.guaranteeCode || expected.roomTypeForCharge !== undefined ? { includeNativePreimage: true } : {}) }),
  { readOnly: true, readOnlyConfirmation: confirmation, ...(cloudTargetKey ? { cloudTargetKey } : {}) });
  const fields = read?.record?.details?.fields;
  if (read?.outcome !== 'ok' || !Array.isArray(fields)) return { issue: 'readback_unverified', detail: read };
  const mismatches = compareRecord(fields, expected);
  const pricing = expected.roomTypeForCharge !== undefined ? compareChargeRoomPricing(fields, expected.checkedPricing) : null;
  if (pricing && (pricing.averageRate !== 'MATCHED' || pricing.totalRate !== 'MATCHED' || pricing.currency !== 'MATCHED')) {
    mismatches.push({ field: 'checkedPricing', issue: 'saved_price_unverified', pricing });
  }
  let criteria;
  if (expected.roomTypeForCharge !== undefined) {
    const native = read.record.nativePreimage;
    const identityMatches = native?.source === 'record_view_ext_model' && native.propertyCode === 'HRCEN' &&
      native.confirmation === confirmation && native.guestId === String(expected.guestId) && native.status === 'Reserved' &&
      native.firstName === firstName && native.lastName === lastName && native.arrival === expected.arrival &&
      native.departure === expected.departure && native.roomType === expected.roomType && native.ratePlan === expected.ratePlan;
    const data = identityMatches ? { adults: native.adults, children: native.children,
      childages: Array.isArray(native.childAges) ? native.childAges : null, sourceofbus: native.sourceBusinessCode,
      ...Object.fromEntries(['child1', 'child2', 'child3'].map(name => [name, uniqueValue(fields, name)])) } : null;
    criteria = compareChargeRoomCriteria(expected.checkedPricing, data);
    if (Object.values(criteria).some(value => value !== 'MATCHED')) {
      mismatches.push({ field: 'checkedPricingCriteria', issue: 'saved_criteria_unverified', criteria });
    }
  }
  if (expected.guaranteeCode) {
    const native = read.record.nativePreimage;
    const verified = native?.source === 'record_view_ext_model' && native.propertyCode === 'HRCEN' &&
      native.confirmation === confirmation && native.guestId === String(expected.guestId) && native.status === 'Reserved' &&
      native.firstName === firstName && native.lastName === lastName && native.arrival === expected.arrival &&
      native.departure === expected.departure && native.roomType === expected.roomType && native.ratePlan === expected.ratePlan &&
      native.adults === expected.adults && native.children === expected.children && native.guaranteeCode === expected.guaranteeCode;
    if (!verified) mismatches.push({ field: 'guaranteeTypeCode', issue: 'native_code_unverified' });
  }
  return { fields, captureScope: read.record.details.captureScope, mismatches, ...(pricing ? { pricing, criteria } : {}) };
}

const readCensus = (stay, expected, cloudTargetKey) => withCenturionStay360Page((page) => searchLabtestPreimage(page, {
  arrival: stay.arrival, departure: stay.departure,
  ...(expected?.allowRealGuest ? { firstName: expected.firstName, lastName: expected.lastName } : {}),
}, { allowRealGuest: expected?.allowRealGuest === true, allowPast: true }),
{ headless: true, blockServiceWorkers: true, prepareContext: installReadOnlyGuard, ...(cloudTargetKey ? { cloudTargetKey } : {}) });

/** A fresh census and record reads are evidence only; this never dispatches a save. */
export async function reconcileLabtestCreate({ stay, expected }, { census = readCensus, withSavedSession = withSavedStayAgentSession,
  cloudTargetKey = createCloudTargetKey(expected?.allowRealGuest ? expected : { firstName: 'Proof', lastName: 'Labtest' }, stay?.arrival) } = {}) {
  let result;
  try { result = await census(stay, expected, cloudTargetKey); } catch { result = { outcome: 'incomplete', issue: 'census_unverified' }; }
  const candidates = [];
  const rows = result?.outcome === 'existing_matches' && result.coverage?.complete && Array.isArray(result.sameArrival) ? result.sameArrival : [];
  for (const row of rows) {
    try { candidates.push({ confirmation: row.confirmation, readback: await readLabtestCreate({ confirmation: row.confirmation, stay, expected }, { withSavedSession, cloudTargetKey }) }); }
    catch { candidates.push({ confirmation: row.confirmation, issue: 'readback_unverified' }); }
  }
  return { census: result, candidates };
}
