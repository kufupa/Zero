// Exact read-only identity and clean-form preimage, never Save authority.
import { cleanLabtestRecord } from './labtest-record.mjs';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const ownObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

export function realStageDateParts(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return { display: `${value.slice(8)}-${MONTHS[date.getUTCMonth()]}-${value.slice(0, 4)}`,
    wire: `${value.slice(5, 7)}/${value.slice(8)}/${value.slice(0, 4)}` };
}

function exact(source, name, value) {
  return ownObject(source) && Object.keys(source).filter((key) => key.toLowerCase() === name.toLowerCase()).length === 1 &&
    Object.hasOwn(source, name) && String(source[name] ?? '') === value;
}

/** A diagnostic preimage check, not authority for any persistence. */
export function matchesRealDateStagePreimage(snapshot, expected) {
  if (!ownObject(expected) || Object.keys(expected).sort().join(',') !==
      'arrival,confirmation,departure,firstName,guestId,lastName,ratePlan,roomType' ||
      !/^\d{6,}-\d+$/.test(expected.confirmation || '') || !/^\d+$/.test(expected.guestId || '') ||
      ![expected.firstName, expected.lastName, expected.roomType, expected.ratePlan].every((v) =>
        typeof v === 'string' && v.length > 0 && v.length <= 200 && v.trim() === v) ||
      !realStageDateParts(expected.arrival) || !realStageDateParts(expected.departure) || expected.arrival >= expected.departure) return false;
  try {
    if (!cleanLabtestRecord(snapshot)) return false;
    const data = { propertycode: 'HRCEN', status: 'Reserved', confirmationnumber: expected.confirmation,
      guestid: expected.guestId, firstname: expected.firstName, lastname: expected.lastName,
      arrivaldate: realStageDateParts(expected.arrival).wire, departuredate: realStageDateParts(expected.departure).wire,
      roomtype: expected.roomType, rateplan: expected.ratePlan };
    const values = { ...data, arrivaldate: realStageDateParts(expected.arrival).display,
      departuredate: realStageDateParts(expected.departure).display };
    delete values.propertycode; // Property is a native model field, not always a visible control.
    return Object.entries(data).every(([key, value]) => exact(snapshot.data, key, value)) &&
      Object.entries(values).every(([key, value]) => exact(snapshot.values, key, value));
  } catch { return false; }
}
