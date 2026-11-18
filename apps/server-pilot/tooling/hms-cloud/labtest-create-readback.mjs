// Fresh, read-only evidence for a guarded HRCEN create attempt.
import { withCloudReadSession } from './cloud-session.mjs';
import { getPropertyRegistration } from './property-registry.mjs';
import { searchLabtestPreimage } from './labtest-preimage.mjs';
import { withSavedStayAgentSession } from './saved-stay-agent-session.mjs';
import { installReadOnlyGuard } from './hms-read-only-guard.mjs';
import { CREATE_GUARANTEES, createCloudTargetKey, isLabtestGuest, validCreateGuest } from './cloud-create-policy.mjs';
import { compareChargeRoomCriteria, compareChargeRoomPricing, savedPriceFromFields } from './charge-room-pricing.mjs';

const same = (a, b) => String(a ?? '').trim().toLocaleLowerCase() === String(b ?? '').trim().toLocaleLowerCase();
const nativeBoolean = value => [true, 1, -1, '1', '-1', 'true'].includes(value) ? true :
  [false, 0, '0', 'false'].includes(value) ? false : null;
const uniqueValue = (fields, name) => {
  const matches = fields.filter((field) => field.name === name);
  return matches.length === 1 ? (name === 'reservationnote' ? matches[0].rawValue ?? null : matches[0].value) : null;
};

function validExpected(stay, expected) {
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const bands = expected?.childBands, names = bands && typeof bands === 'object' && !Array.isArray(bands) ? Object.keys(bands) : [];
  const ages = expected?.childAges;
  const guest = expected?.allowRealGuest === true ? expected : { firstName: 'Proof', lastName: 'Labtest' };
  return Boolean(expected && validDate(stay?.arrival) && validDate(stay?.departure) && stay.arrival < stay.departure &&
    validCreateGuest(guest) && (expected.allowRealGuest === true || isLabtestGuest(guest)) &&
    (expected.cmsSend === undefined || typeof expected.cmsSend === 'boolean') &&
    !(isLabtestGuest(guest) && expected.cmsSend === true) &&
    expected.arrival === stay.arrival && expected.departure === stay.departure && /^\d+$/.test(String(expected.guestId ?? '')) &&
    ['roomType', 'ratePlan', 'guarantee'].every((key) => typeof expected[key] === 'string' && expected[key].trim()) &&
    (expected.note === undefined || expected.note === null ||
      (typeof expected.note === 'string' && (expected.note === '' || expected.note.trim()))) &&
    (expected.roomTypeForCharge === undefined || /^[A-Z0-9]{1,12}$/.test(expected.roomTypeForCharge)) &&
    (expected.guaranteeCode === undefined || CREATE_GUARANTEES[expected.guaranteeCode] === expected.guarantee) &&
    Number.isInteger(expected.adults) && expected.adults > 0 && Number.isInteger(expected.children) && expected.children >= 0 &&
    (bands && names.every((name) => /^child[1-9]\d*$/.test(name) && Number.isInteger(bands[name]) && bands[name] >= 0) &&
      names.reduce((sum, name) => sum + bands[name], 0) === expected.children ||
      Array.isArray(ages) && ages.length === expected.children && ages.every(age => Number.isInteger(age) && age >= 0 && age <= 17)));
}

function compareRecord(fields, expected) {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const displayDate = (iso) => `${iso.slice(8, 10)}-${months[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
  const mismatches = [];
  for (const [field, name, wanted] of [
    ['arrival', 'arrivaldate', displayDate(expected.arrival)], ['departure', 'departuredate', displayDate(expected.departure)],
    ['adults', 'adults', expected.adults], ['children', 'children', expected.children],
    ['roomType', 'roomtype', expected.roomType], ['ratePlan', 'rateplan', expected.ratePlan],
    ['mealPlan', 'mealplan', expected.mealPlan],
    ['roomTypeForCharge', 'roomtypecharge', expected.roomTypeForCharge],
    ['note', 'reservationnote', expected.note], ['guestId', 'guestid', expected.guestId], ['status', 'status', 'Reserved'],
    ['firstName', 'firstname', expected.allowRealGuest ? expected.firstName : 'Proof'],
    ['lastName', 'lastname', expected.allowRealGuest ? expected.lastName : 'Labtest'],
    ['sourceOfBusiness', 'sourceofbusinessdesc', expected.source], ['organization', 'company', expected.organization],
    ['guaranteeType', 'guaranteetype', expected.guarantee], ['cmsSend', 'udfchkbox04', expected.cmsSend ?? false],
    ['cmsMessageId', 'udfchar09', expected.cmsMessageId],
    ['cmsRecipient', 'udfchar13', expected.cmsRecipient], ['guestEmail', 'emailaddress', expected.guestEmail],
    ['bookerName', 'caller', expected.booker?.name], ['bookerContact', 'udfchar06', expected.booker?.contact],
    ['track', 'track', expected.track], ['marketSegment', 'marketsegment', expected.marketSegment?.display], ['guestOptIn', 'guestoptin4', expected.guestOptIn],
  ]) {
    if (wanted == null) continue;
    const actual = uniqueValue(fields, name);
    if (actual == null || (field === 'guestOptIn' ? nativeBoolean(actual) !== wanted :
        ['note', 'guestId', 'firstName', 'lastName', 'roomType', 'roomTypeForCharge', 'ratePlan', 'mealPlan', 'cmsMessageId', 'cmsRecipient', 'guestEmail', 'bookerName', 'bookerContact'].includes(field) ? String(actual) !== String(wanted) : !same(actual, wanted))) {
      mismatches.push({ field, expected: wanted, actual, ...(actual == null ? { issue: 'not_visible_or_ambiguous' } : {}) });
    }
  }
  if (expected.nativeCommissionPercent !== undefined) {
    const value = uniqueValue(fields, 'ta1commission');
    if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim() ||
        !Number.isFinite(Number(value)) || Number(value) !== expected.nativeCommissionPercent) {
      mismatches.push({ field: 'taCommission', expected: expected.nativeCommissionPercent, actual: value });
    }
  }
  return mismatches;
}

/** Independently reopen one confirmation and compare the visible Record View. */
export async function readLabtestCreate({ confirmation, stay, expected }, { withSavedSession = withSavedStayAgentSession,
  propertyCode = 'HRCEN', transportId, signal, credentialLease, cloudTargetKey } = {}) {
  if (!getPropertyRegistration(propertyCode)?.active || !validExpected(stay, expected)) return { issue: 'expected_record_invalid' };
  const firstName = expected.allowRealGuest ? expected.firstName : 'Proof';
  const lastName = expected.allowRealGuest ? expected.lastName : 'Labtest';
  const read = await withSavedSession(({ runTool }) => runTool({ tool: 'read', confirmation,
    guestName: `${firstName} ${lastName}`, arrivalDate: stay.arrival,
    includeNativePreimage: true }),
  { readOnly: true, readOnlyConfirmation: confirmation, propertyCode, transportId, signal, credentialLease,
    ...(cloudTargetKey ? { cloudTargetKey } : {}) });
  const fields = read?.record?.details?.fields;
  if (read?.outcome !== 'ok' || !Array.isArray(fields)) return { issue: 'readback_unverified', detail: read };
  const native = read.record.nativePreimage;
  if (native?.source !== 'record_view_ext_model' || native.propertyCode !== propertyCode ||
      native.confirmation !== confirmation || !/^\d{1,100}$/.test(native.reservationStayId || '') ||
      native.guestId !== String(expected.guestId) || native.status !== 'Reserved' ||
      native.firstName !== firstName || native.lastName !== lastName || native.arrival !== expected.arrival ||
      native.departure !== expected.departure || native.roomType !== expected.roomType || native.ratePlan !== expected.ratePlan ||
      native.adults !== expected.adults || native.children !== expected.children) return { issue: 'readback_identity_unverified' };
  const mismatches = compareRecord(fields, expected);
  if (expected.marketSegment && native.marketSegmentCode !== expected.marketSegment.value) {
    mismatches.push({ field: 'marketSegmentCode', issue: 'native_code_unverified' });
  }
  for (const [name, wanted] of Object.entries(expected.childBands ?? {})) {
    const visible = fields.filter(field => field.name === name);
    if (native.childBands?.[name] !== wanted || visible.length > 1 ||
        visible.length === 1 && String(visible[0].value) !== String(wanted)) {
      mismatches.push({ field: name, issue: 'native_child_count_unverified' });
    }
  }
  if (Array.isArray(expected.childAges)) {
    const sorted = ages => [...ages].sort((a, b) => a - b);
    let observedAges = native.childAges;
    if (!Array.isArray(observedAges) && expected.children === 0) observedAges = [];
    if (!Array.isArray(observedAges) && expected.children > 0) {
      try {
        const { readCloudSavedChildAges } = await import('./pane-amend-session.mjs');
        const child = await readCloudSavedChildAges({ target: { propertyCode, origin: getPropertyRegistration(propertyCode).origin },
          transportId, signal, credentialLease, cloudTargetKey, selected: native, confirmation, arrival: native.arrival,
          allowRealGuest: expected.allowRealGuest === true ||
            (Boolean(expected.guaranteeCode) && expected.guaranteeCode !== 'NGI') });
        if (child.outcome === 'ok') observedAges = child.ages;
      } catch { /* Missing age proof remains unverified. */ }
    }
    if (!Array.isArray(observedAges) || JSON.stringify(sorted(observedAges)) !== JSON.stringify(sorted(expected.childAges))) {
      mismatches.push({ field: 'childAges', issue: 'native_ages_unverified' });
    }
  }
  const pricing = expected.roomTypeForCharge !== undefined ? compareChargeRoomPricing(fields, expected.checkedPricing) :
    expected.ratePlanAvailability ? compareChargeRoomPricing(fields, expected.ratePlanAvailability) : null;
  const price = savedPriceFromFields(fields, expected.roomTypeForCharge !== undefined ? expected.checkedPricing : expected.ratePlanAvailability);
  let criteria;
  if (expected.roomTypeForCharge !== undefined) {
    const identityMatches = native?.source === 'record_view_ext_model' && native.propertyCode === propertyCode &&
      native.confirmation === confirmation && native.guestId === String(expected.guestId) && native.status === 'Reserved' &&
      native.firstName === firstName && native.lastName === lastName && native.arrival === expected.arrival &&
      native.departure === expected.departure && native.roomType === expected.roomType && native.ratePlan === expected.ratePlan;
    const data = identityMatches ? { adults: native.adults, children: native.children,
      childages: Array.isArray(native.childAges) ? native.childAges : native.childAgesWire ?? null,
      sourceofbus: native.sourceBusinessCode,
      ...Object.fromEntries(Object.keys(expected.checkedPricing?.occupancy ?? {}).filter(name => /^child[1-9]\d*$/.test(name))
        .map(name => [name, native.childBands?.[name] ?? null])) } : null;
    criteria = compareChargeRoomCriteria(expected.checkedPricing, data);
    if (Object.values(criteria).some(value => value !== 'MATCHED')) {
      mismatches.push({ field: 'checkedPricingCriteria', issue: 'saved_criteria_unverified', criteria });
    }
  }
  if (expected.guaranteeCode) {
    const verified = native?.source === 'record_view_ext_model' && native.propertyCode === propertyCode &&
      native.confirmation === confirmation && native.guestId === String(expected.guestId) && native.status === 'Reserved' &&
      native.firstName === firstName && native.lastName === lastName && native.arrival === expected.arrival &&
      native.departure === expected.departure && native.roomType === expected.roomType && native.ratePlan === expected.ratePlan &&
      native.adults === expected.adults && native.children === expected.children && native.guaranteeCode === expected.guaranteeCode;
    if (!verified) mismatches.push({ field: 'guaranteeTypeCode', issue: 'native_code_unverified' });
  }
  return { nativeStayId: native.reservationStayId, fields, captureScope: read.record.details.captureScope, mismatches,
    ...(pricing ? { pricing, criteria } : {}), savedPrice: price.saved, preparedPrice: price.prepared,
    ...(price.info ? { priceInfo: price.info } : {}) };
}

const readCensus = (stay, expected, cloudTargetKey, options = {}) => withCloudReadSession((page) => searchLabtestPreimage(page, {
  propertyCode: options.propertyCode, arrival: stay.arrival, departure: stay.departure,
  ...(expected?.allowRealGuest ? { firstName: expected.firstName, lastName: expected.lastName } : {}),
}, { allowRealGuest: expected?.allowRealGuest === true, allowPast: true }),
{ propertyCode: options.propertyCode, transportId: options.transportId, signal: options.signal, credentialLease: options.credentialLease,
  startScreen: 'OSRESS', prepareContext: installReadOnlyGuard, ...(cloudTargetKey ? { cloudTargetKey } : {}) });

/** A fresh census and record reads are evidence only; this never dispatches a save. */
export async function reconcileLabtestCreate({ stay, expected }, { census = readCensus, withSavedSession = withSavedStayAgentSession,
  propertyCode = 'HRCEN', transportId, signal, credentialLease,
  cloudTargetKey = createCloudTargetKey(expected?.allowRealGuest ? expected : { firstName: 'Proof', lastName: 'Labtest' }, stay?.arrival, propertyCode) } = {}) {
  let result;
  try { result = await census(stay, expected, cloudTargetKey, { propertyCode, transportId, signal, credentialLease }); } catch { result = { outcome: 'incomplete', issue: 'census_unverified' }; }
  const candidates = [];
  const rows = ['clear', 'existing_matches'].includes(result?.outcome) && result.coverage?.complete && Array.isArray(result.sameArrival) ? result.sameArrival : [];
  for (const row of rows) {
    try { candidates.push({ confirmation: row.confirmation, readback: await readLabtestCreate({ confirmation: row.confirmation, stay, expected }, { withSavedSession, propertyCode, transportId, signal, credentialLease, cloudTargetKey }) }); }
    catch { candidates.push({ confirmation: row.confirmation, issue: 'readback_unverified' }); }
  }
  return { census: result, candidates };
}
