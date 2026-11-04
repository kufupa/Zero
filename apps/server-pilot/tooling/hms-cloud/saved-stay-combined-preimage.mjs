// A diagnostic/approval binding, not a Save authorization or request matcher.
import { createHash } from 'node:crypto';
import { cleanLabtestRecord, unchangedLabtestBusinessParties } from './labtest-record.mjs';
import { planSavedChildOccupancy, savedChildOccupancy } from './guest-stay-amend-children.mjs';

const identityFields = ['confirmation', 'guestId', 'arrival', 'departure', 'roomType', 'ratePlan', 'note', 'adults', 'childCount', 'childAges'];
const optionalIdentityFields = ['firstName', 'lastName'];
const changeFields = ['arrival', 'departure', 'adults', 'children', 'childCount', 'childAges', 'roomType', 'ratePlan', 'retainRates',
  'firstName', 'lastName', 'guestEmail', 'bookerName', 'bookerContact', 'cmsSend', 'cmsMessageId', 'cmsRecipient'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v, keys) => object(v) && Object.keys(v).every((key) => keys.includes(key));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const adult = (v) => Number.isInteger(v) && v >= 1 && v <= 16;
const date = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const parsed = new Date(`${v}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v) return null;
  return `${v.slice(5, 7)}/${v.slice(8, 10)}/${v.slice(0, 4)}`;
};
const displayDate = (v) => {
  if (!date(v)) return null;
  return `${v.slice(8, 10)}-${MONTHS[Number(v.slice(5, 7)) - 1]}-${v.slice(0, 4)}`;
};
const businessKeysUnique = (source) => object(source) && ['confirmationnumber', 'guestid', 'arrivaldate', 'departuredate',
  'roomtype', 'rateplan', 'adults', 'children', 'firstname', 'lastname', 'guaranteetype', 'udfchkbox04',
  'udfchar09', 'udfchar13', 'emailaddress'].every((wanted) =>
  Object.keys(source).filter((key) => key.toLowerCase() === wanted).length <= 1);
const exact = (source, key, wanted) => Object.hasOwn(source, key) && String(source[key] ?? '') === String(wanted);

// Refuse values JSON could silently omit or change. Sort object keys for stable hashes.
function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (!value || typeof value !== 'object' || ancestors.has(value) ||
      (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) throw new Error('UNSUPPORTED_PREIMAGE');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new Error('UNSUPPORTED_PREIMAGE');
      return value.map((entry) => canonical(entry, ancestors));
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], ancestors)]));
  } finally { ancestors.delete(value); }
}
function validChanges(expected, changes, minimumArrival) {
  if (!only(changes, changeFields) || !Object.keys(changes).length) return false;
  const arrival = Object.hasOwn(changes, 'arrival') ? changes.arrival : expected.arrival;
  const departure = Object.hasOwn(changes, 'departure') ? changes.departure : expected.departure;
  if (!date(arrival) || !date(departure) || arrival < minimumArrival || arrival >= departure ||
      (Object.hasOwn(changes, 'adults') && !adult(changes.adults)) ||
      (['roomType', 'ratePlan'].some((key) => Object.hasOwn(changes, key) &&
        (typeof changes[key] !== 'string' || !/^[A-Z0-9]{1,12}$/.test(changes[key])))) ||
      (Object.hasOwn(changes, 'cmsSend') && typeof changes.cmsSend !== 'boolean') ||
      ['firstName', 'lastName', 'guestEmail', 'bookerName', 'bookerContact', 'cmsMessageId', 'cmsRecipient'].some((key) =>
        Object.hasOwn(changes, key) && (typeof changes[key] !== 'string' || changes[key].length > 1000 || /[\p{Cc}]/u.test(changes[key]))) ||
      (Object.hasOwn(changes, 'retainRates') && !['yes', 'no'].includes(changes.retainRates))) return false;
  const childChange = Object.hasOwn(changes, 'children') || Object.hasOwn(changes, 'childCount') || Object.hasOwn(changes, 'childAges');
  if (childChange) {
    if ((!Object.hasOwn(changes, 'children') && !Object.hasOwn(changes, 'childCount')) || !Object.hasOwn(changes, 'childAges') ||
        (Object.hasOwn(changes, 'children') && Object.hasOwn(changes, 'childCount') && changes.children !== changes.childCount)) return false;
    const plan = planSavedChildOccupancy({ childCount: changes.children ?? changes.childCount, childAges: changes.childAges });
    if (plan.outcome !== 'planned' || plan.childCount === null || plan.childAges === null) return false;
  }
  return Object.entries(changes).some(([key, value]) => key !== 'retainRates' && !same(value, expected[key]));
}

/** Bind a clean current HRCEN Labtest snapshot and explicit changes across fresh browser sessions. */
export function labtestCombinedAmendPreimageBinding(expected, state, snapshot, changes) {
  try {
    const allowRealGuest = state?.allowRealGuest === true;
    const firstName = expected?.firstName ?? (allowRealGuest ? null : 'Proof');
    const lastName = expected?.lastName ?? (allowRealGuest ? null : 'Labtest');
    const minimumArrival = firstName === 'Proof' && lastName === 'Labtest' ? '2027-01-01' : '0000-01-01';
    const guarantee = state?.expectedGuarantee ?? (allowRealGuest ? null : { code:'NGI' });
    if (!only(expected, [...identityFields, ...optionalIdentityFields]) || !identityFields.every((key) => Object.hasOwn(expected, key)) ||
        typeof firstName !== 'string' || !firstName.trim() || firstName !== firstName.trim() ||
        typeof lastName !== 'string' || !lastName.trim() || lastName !== lastName.trim() ||
        (allowRealGuest && (state.expectedFirstName !== firstName || state.expectedLastName !== lastName)) ||
        (!allowRealGuest && (firstName !== 'Proof' || lastName !== 'Labtest')) ||
        !guarantee || typeof guarantee.code !== 'string' || !/^[A-Z0-9]{1,20}$/.test(guarantee.code) ||
        typeof expected.confirmation !== 'string' || !/^\d{6,}-\d+$/.test(expected.confirmation) ||
        typeof expected.guestId !== 'string' || !/^\d+$/.test(expected.guestId) ||
        !date(expected.arrival) || !date(expected.departure) || expected.arrival < minimumArrival || expected.arrival >= expected.departure ||
        typeof expected.roomType !== 'string' || !/^[A-Z0-9]{1,12}$/.test(expected.roomType) ||
        typeof expected.ratePlan !== 'string' || !/^[A-Z0-9]{1,12}$/.test(expected.ratePlan) ||
        typeof expected.note !== 'string' || expected.note.length > 2_000 || !adult(expected.adults) ||
        !state?.frame || !object(state.native) || !cleanLabtestRecord(snapshot) || !businessKeysUnique(snapshot.data) ||
        !businessKeysUnique(snapshot.values) || !Array.isArray(snapshot.partyControls) ||
        !unchangedLabtestBusinessParties(state.partyPreimage, snapshot,
          { allowModelOnlyPrimaryPartyIds: state.allowModelOnlyPrimaryPartyIds === true, allowRealGuest }) || !validChanges(expected, changes, minimumArrival)) return null;
    const prior = planSavedChildOccupancy({ childCount: expected.childCount, childAges: expected.childAges });
    const actual = savedChildOccupancy(snapshot);
    if (prior.outcome !== 'planned' || prior.childCount === null || !actual.valid || actual.count !== prior.childCount ||
        !same(actual.ages, prior.childAges) || !exact(snapshot.values, 'adults', expected.adults) ||
        !exact(snapshot.data, 'adults', expected.adults)) return null;
    const formAges = actual.fields.childages.form;
    if (prior.childAges === null) {
      // Unknown is not []. Do not bind a populated form value the model cannot verify.
      if (formAges.present && formAges.value !== '' && formAges.value !== null) return null;
    } else if (!same(actual.bands, prior.derivedBands) || (formAges.present &&
        !((prior.childCount === 0 && formAges.value === '') ||
          (typeof formAges.value === 'string' && formAges.value === prior.childAges.join(','))))) return null;
    const identity = { propertycode:'HRCEN', status:'Reserved', firstname:firstName, lastname:lastName,
      confirmationnumber:expected.confirmation, guestid:expected.guestId, arrivaldate:date(expected.arrival),
      departuredate:date(expected.departure), roomtype:expected.roomType, rateplan:expected.ratePlan, reservationnote:expected.note };
    const formIdentity = { ...identity, arrivaldate:displayDate(expected.arrival), departuredate:displayDate(expected.departure) };
    delete formIdentity.propertycode;
    if (!Object.entries(identity).every(([key, value]) => exact(snapshot.data, key, value)) ||
        !Object.entries(formIdentity).every(([key, value]) => exact(snapshot.values, key, value)) ||
        !exact(snapshot.data, 'guaranteetype', guarantee.code) || !exact(snapshot.values, 'guaranteetype', guarantee.code) ||
        !['PKID', 'bookingsessionid', 'reservationid', 'reservationstayid', 'recordid'].every((key) =>
          typeof state.native[key] === 'string' && state.native[key] && exact(snapshot.data, key, state.native[key]))) return null;
    // Accept real CMS/email values, but do not bind conflicting model and form values.
    for (const name of ['emailaddress', 'udfchar13', 'udfchar09']) {
      if (Object.hasOwn(snapshot.data, name) && Object.hasOwn(snapshot.values, name) &&
          String(snapshot.data[name] ?? '') !== String(snapshot.values[name] ?? '')) return null;
    }
    const checked = (value) => [true, 1, '1', 'true', 'on', 'yes', 'Y'].includes(value);
    if ((!allowRealGuest && checked(snapshot.data.udfchkbox04)) ||
        (Object.hasOwn(snapshot.values, 'udfchkbox04') && checked(snapshot.values.udfchkbox04) !== checked(snapshot.data.udfchkbox04)) ||
        (typeof state.cmsSend === 'boolean' && state.cmsSend !== checked(snapshot.data.udfchkbox04)) ||
        (typeof state.cmsRecipient === 'string' && state.cmsRecipient !== String(snapshot.data.udfchar13 ?? '')) ||
        (typeof state.guestEmail === 'string' && state.guestEmail !== String(snapshot.data.emailaddress ?? ''))) return null;
    // Bind the selected stay and its business preimage, not HMS's entire changing form.
    const business = ['reservationid', 'reservationstayid', 'recordid', 'guaranteetype', 'caller', 'udfchar06',
      'emailaddress', 'udfchkbox04', 'udfchar09', 'udfchar13'];
    const fields = Object.fromEntries(business.filter((key) => Object.hasOwn(snapshot.data, key))
      .map((key) => [key, snapshot.data[key] ?? '']));
    const payload = { version:1, expected, changes, fields, parties:state.partyPreimage };
    return { version:1, digest:createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex') };
  } catch { return null; }
}
