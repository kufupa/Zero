// Unsaved real-stay diagnostic only. Never use this as a Save candidate matcher.
import { isDeepStrictEqual } from 'node:util';
import { savedAmendDateParts } from './guest-stay-amend-date-room-rate.mjs';

const same = isDeepStrictEqual;
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const dateFields = { arrival:'arrivaldate', departure:'departuredate' };
const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const formAmounts = new Set(['averagenightly','averagerate','enhancedexptotal','grandtotal','guesttax',
  'guesttotal','guesttotalwithtax','tax','total','totalrate','totalratewithtax','totalresortfee']);
const modelOnlyAmounts = new Set(['guesttotalresortfee','ratetax','totalcomptaxamount','totalguestcomptaxamount']);

function normalizedAmount(value) {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
  const [integer, fraction = ''] = text.replaceAll(',', '').split('.');
  return `${integer.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`;
}

// Match only invalidation patterns observed in a saved fake-stay date probe.
function invalidation(before, after, name) {
  const oldData = before.data, data = after.data, oldValues = before.values, values = after.values;
  if (!Object.hasOwn(oldData, name) || !Object.hasOwn(data, name)) return false;
  const hasForm = Object.hasOwn(oldValues, name) && Object.hasOwn(values, name);
  const noForm = !Object.hasOwn(oldValues, name) && !Object.hasOwn(values, name);
  if (name === 'enablecheckavailability') return noForm && oldData[name] === '0' && data[name] === '-1';
  if (modelOnlyAmounts.has(name)) return noForm && oldData[name] === '0' && data[name] === '';
  if (name === 'nightsvalue' || name === 'revenuevalue') {
    return hasForm && oldData[name] === '0' && (data[name] === '0' || data[name] === '') &&
      oldValues[name] === (name === 'nightsvalue' ? '0' : '0.00') && values[name] === '';
  }
  if (!formAmounts.has(name) || !hasForm || values[name] !== '' ||
      !(same(oldData[name], data[name]) || data[name] === '')) return false;
  const oldForm = normalizedAmount(oldValues[name]), oldModel = normalizedAmount(oldData[name]);
  return oldForm !== null && oldModel !== null && oldForm === oldModel;
}

/** Classify a local date draft after an independently validated occupancy draft. */
export function matchesRealDateDraft(before, after, expected, changes) {
  if (!object(before) || !object(after) || !object(before.data) || !object(before.values) ||
      !object(after.data) || !object(after.values) || !object(expected) || !object(changes) ||
      !same(Object.keys(before).sort(), Object.keys(after).sort()) ||
      !['dirtyFields','modifiedFields'].every((key) => Array.isArray(before[key]) && Array.isArray(after[key]) &&
        before[key].every((v) => typeof v === 'string' && v) && after[key].every((v) => typeof v === 'string' && v) &&
        new Set(before[key]).size === before[key].length && new Set(after[key]).size === after[key].length &&
        before[key].every((v) => after[key].includes(v))) ||
      typeof before.formDirty !== 'boolean' || typeof before.recordDirty !== 'boolean' ||
      typeof after.formDirty !== 'boolean' || typeof after.recordDirty !== 'boolean' ||
      (before.formDirty && !after.formDirty) || (before.recordDirty && !after.recordDirty) ||
      !same(before.partyControls, after.partyControls) || before.partyInputsBlank !== after.partyInputsBlank) return false;
  const beforeDates = {}, finalDates = {};
  for (const key of Object.keys(dateFields)) {
    const initial = savedAmendDateParts(expected[key]), next = savedAmendDateParts(changes[key] ?? expected[key]);
    if (!initial || !next || (Object.hasOwn(changes, key) && changes[key] == null)) return false;
    beforeDates[key] = initial; finalDates[key] = next;
  }
  const arrival = changes.arrival ?? expected.arrival, departure = changes.departure ?? expected.departure;
  if (arrival >= departure) return false;
  const changedDates = Object.keys(dateFields).filter((key) => Object.hasOwn(changes, key) && changes[key] !== expected[key]);
  if (!changedDates.length || !after.formDirty || changedDates.some((key) => !after.dirtyFields.includes(dateFields[key]))) return false;
  const actualChanges = new Set();
  for (const part of ['data','values']) {
    const left = before[part], right = after[part];
    if (!same(Object.keys(left).sort(), Object.keys(right).sort())) return false;
    for (const name of Object.keys(left)) {
      if (same(left[name], right[name])) continue;
      actualChanges.add(name);
      const date = changedDates.find((key) => dateFields[key] === name);
      if (date) {
        if (right[name] !== (part === 'values' ? finalDates[date].display : finalDates[date].wire)) return false;
      } else if (part === 'values' && name === 'nights') {
        const nights = (Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86400000;
        if (String(right[name]) !== String(nights)) return false;
      } else if (part === 'values' && ['arrivaldayofweek','departuredayofweek'].includes(name)) {
        const key = name.startsWith('arrival') ? 'arrival' : 'departure';
        if (!changedDates.includes(key) || right[name] !== weekdays[new Date(`${key === 'arrival' ? arrival : departure}T00:00:00Z`).getUTCDay()]) return false;
      } else if (!invalidation(before, after, name)) return false;
    }
  }
  for (const [key, name] of Object.entries(dateFields)) {
    if (before.values[name] !== beforeDates[key].display || before.data[name] !== beforeDates[key].wire ||
        after.values[name] !== finalDates[key].display ||
        !(after.data[name] === before.data[name] || after.data[name] === finalDates[key].wire)) return false;
  }
  const allowed = new Set([...before.dirtyFields, ...before.modifiedFields, ...actualChanges]);
  if ([...after.dirtyFields, ...after.modifiedFields].some((name) => !allowed.has(name)) ||
      (after.formDirty && !after.dirtyFields.length) || (after.recordDirty && !after.modifiedFields.length)) return false;
  const permittedTop = new Set(['data','values','formDirty','recordDirty','dirtyFields','modifiedFields']);
  return Object.keys(before).every((key) => permittedTop.has(key) || same(before[key], after[key]));
}
