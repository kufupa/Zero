// A diagnostic/approval binding, not a Save authorization or request matcher.
import { createHash } from 'node:crypto';
import { cleanLabtestRecord, unchangedLabtestBusinessParties } from './labtest-record.mjs';
import { planSavedChildOccupancy, savedChildOccupancy } from './guest-stay-amend-children.mjs';

const TRANSIENT = new Set(['bookingsessionid', 'sessionid', 'extid']);
const identityFields = ['confirmation', 'guestId', 'arrival', 'departure', 'roomType', 'ratePlan', 'note', 'adults', 'childCount', 'childAges'];
const changeFields = ['arrival', 'departure', 'adults', 'childCount', 'childAges', 'ratePlan', 'retainRates'];
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
const uniqueKeys = (source) => object(source) && new Set(Object.keys(source).map((key) => key.toLowerCase())).size === Object.keys(source).length;
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
function stable(source) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !TRANSIENT.has(key.toLowerCase())));
}
function validChanges(expected, changes) {
  if (!only(changes, changeFields) || !Object.keys(changes).length) return false;
  const arrival = Object.hasOwn(changes, 'arrival') ? changes.arrival : expected.arrival;
  const departure = Object.hasOwn(changes, 'departure') ? changes.departure : expected.departure;
  if (!date(arrival) || !date(departure) || arrival < '2027-01-01' || arrival >= departure ||
      (Object.hasOwn(changes, 'adults') && !adult(changes.adults)) ||
      (Object.hasOwn(changes, 'ratePlan') && (typeof changes.ratePlan !== 'string' || !/^[A-Z0-9]{1,12}$/.test(changes.ratePlan))) ||
      (Object.hasOwn(changes, 'retainRates') && !['yes', 'no'].includes(changes.retainRates))) return false;
  const childChange = Object.hasOwn(changes, 'childCount') || Object.hasOwn(changes, 'childAges');
  if (childChange) {
    if (!Object.hasOwn(changes, 'childCount') || !Object.hasOwn(changes, 'childAges')) return false;
    const plan = planSavedChildOccupancy({ childCount: changes.childCount, childAges: changes.childAges });
    if (plan.outcome !== 'planned' || plan.childCount === null || plan.childAges === null) return false;
  }
  return Object.entries(changes).some(([key, value]) => key !== 'retainRates' && !same(value, expected[key]));
}

/** Bind a clean current HRCEN Labtest snapshot and explicit changes across fresh browser sessions. */
export function labtestCombinedAmendPreimageBinding(expected, state, snapshot, changes) {
  try {
    if (!only(expected, identityFields) || !identityFields.every((key) => Object.hasOwn(expected, key)) ||
        typeof expected.confirmation !== 'string' || !/^\d{6,}-\d+$/.test(expected.confirmation) ||
        typeof expected.guestId !== 'string' || !/^\d+$/.test(expected.guestId) ||
        !date(expected.arrival) || !date(expected.departure) || expected.arrival < '2027-01-01' || expected.arrival >= expected.departure ||
        typeof expected.roomType !== 'string' || !/^[A-Z0-9]{1,12}$/.test(expected.roomType) ||
        typeof expected.ratePlan !== 'string' || !/^[A-Z0-9]{1,12}$/.test(expected.ratePlan) ||
        typeof expected.note !== 'string' || expected.note.length > 200 || !adult(expected.adults) ||
        !state?.frame || !object(state.native) || !cleanLabtestRecord(snapshot) || !uniqueKeys(snapshot.data) ||
        !uniqueKeys(snapshot.values) || !Array.isArray(snapshot.partyControls) ||
        !unchangedLabtestBusinessParties(state.partyPreimage, snapshot) || !validChanges(expected, changes)) return null;
    const prior = planSavedChildOccupancy({ childCount: expected.childCount, childAges: expected.childAges });
    const actual = savedChildOccupancy(snapshot);
    if (prior.outcome !== 'planned' || prior.childCount === null || !actual.valid || actual.count !== prior.childCount ||
        !same(actual.ages, prior.childAges) || !exact(snapshot.values, 'adults', expected.adults) ||
        !exact(snapshot.data, 'adults', expected.adults)) return null;
    const formAges = actual.fields.childages.form;
    if (prior.childAges === null) {
      // Unknown is not []. Do not bind a populated form value the model cannot verify.
      if ((formAges.present && formAges.value !== '' && formAges.value !== null) ||
          Object.hasOwn(changes, 'childCount') || Object.hasOwn(changes, 'childAges')) return null;
    } else if (!same(actual.bands, prior.derivedBands) || (formAges.present &&
        !((prior.childCount === 0 && formAges.value === '') ||
          (typeof formAges.value === 'string' && formAges.value === prior.childAges.join(','))))) return null;
    const identity = { propertycode:'HRCEN', status:'Reserved', firstname:'Proof', lastname:'Labtest',
      confirmationnumber:expected.confirmation, guestid:expected.guestId, arrivaldate:date(expected.arrival),
      departuredate:date(expected.departure), roomtype:expected.roomType, rateplan:expected.ratePlan, reservationnote:expected.note };
    const formIdentity = { ...identity, arrivaldate:displayDate(expected.arrival), departuredate:displayDate(expected.departure) };
    delete formIdentity.propertycode;
    const sendOff = (source) => !Object.hasOwn(source, 'udfchkbox04') ||
      source.udfchkbox04 === '0' || source.udfchkbox04 === 0 || source.udfchkbox04 === false;
    if (!Object.entries(identity).every(([key, value]) => exact(snapshot.data, key, value)) ||
        !Object.entries(formIdentity).every(([key, value]) => exact(snapshot.values, key, value)) ||
        !exact(snapshot.data, 'guaranteetype', 'NGI') || !exact(snapshot.values, 'guaranteetype', 'NGI') ||
        !exact(snapshot.data, 'udfchkbox04', '0') || !sendOff(snapshot.values) ||
        !['udfchar13', 'emailaddress'].every((key) => exact(snapshot.data, key, '') && exact(snapshot.values, key, '')) ||
        !['PKID', 'bookingsessionid', 'reservationid', 'reservationstayid', 'recordid'].every((key) =>
          typeof state.native[key] === 'string' && state.native[key] && exact(snapshot.data, key, state.native[key]))) return null;
    const controls = snapshot.partyControls.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const payload = { version:1, expected, changes, data:stable(snapshot.data), values:stable(snapshot.values), partyControls:controls };
    return { version:1, digest:createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex') };
  } catch { return null; }
}
