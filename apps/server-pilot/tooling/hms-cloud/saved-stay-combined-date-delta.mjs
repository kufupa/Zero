// Exact unsaved date delta only. This module never authorizes a request.
import { isDeepStrictEqual } from 'node:util';
import { savedAmendDateParts } from './guest-stay-amend-date-room-rate.mjs';

const same = isDeepStrictEqual;
const own = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const dates = { arrival:'arrivaldate', departure:'departuredate' };

/** Accept only an exact date delta on top of an independently validated occupancy draft. */
export function matchesCombinedDateDraft(before, after, expected, changes) {
  if (!own(before) || !own(after) || !own(before.values) || !own(before.data) || !own(after.values) || !own(after.data) ||
      !Array.isArray(before.dirtyFields) || !Array.isArray(before.modifiedFields) ||
      !Array.isArray(after.dirtyFields) || !Array.isArray(after.modifiedFields) ||
      !same(Object.keys(before).sort(), Object.keys(after).sort()) ||
      !same(before.partyControls, after.partyControls) || before.partyInputsBlank !== after.partyInputsBlank) return false;
  const changedDates = Object.entries(dates).filter(([key]) => Object.hasOwn(changes, key) && changes[key] !== expected[key]);
  const allowed = new Set(changedDates.map(([, field]) => field));
  const allowedDirty = new Set([...before.dirtyFields, ...before.modifiedFields, ...allowed]);
  if (typeof after.formDirty !== 'boolean' || typeof after.recordDirty !== 'boolean' ||
      new Set(after.dirtyFields).size !== after.dirtyFields.length || new Set(after.modifiedFields).size !== after.modifiedFields.length ||
      before.dirtyFields.some((name) => !after.dirtyFields.includes(name)) ||
      before.modifiedFields.some((name) => !after.modifiedFields.includes(name)) ||
      (before.formDirty && !after.formDirty) || (before.recordDirty && !after.recordDirty) ||
      changedDates.some(([, field]) => !after.dirtyFields.includes(field)) || (changedDates.length > 0 && !after.formDirty) ||
      [...after.dirtyFields, ...after.modifiedFields].some((name) => !allowedDirty.has(name)) ||
      (after.formDirty && !after.dirtyFields.length) || (after.recordDirty && !after.modifiedFields.length)) return false;
  for (const part of ['values', 'data']) {
    const left = before[part], right = after[part];
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return false;
      if (same(left[key], right[key])) continue;
      const entry = changedDates.find(([, field]) => field === key);
      if (!entry) return false;
      const target = savedAmendDateParts(changes[entry[0]]);
      if (!target || String(right[key] ?? '') !== (part === 'values' ? target.display : target.wire)) return false;
    }
  }
  return changedDates.every(([key, field]) => {
    const target = savedAmendDateParts(changes[key]);
    return target && Object.hasOwn(after.values, field) && after.values[field] === target.display &&
      Object.hasOwn(after.data, field) && (same(before.data[field], after.data[field]) || after.data[field] === target.wire);
  });
}
