import { getPropertyRegistration } from './property-registry.mjs';

// HRCEN's native selector was read in a guarded, unsaved draft. Values here
// are code/display pairs, not aliases inferred from their descriptions.
export const CREATE_GUARANTEES = Object.freeze({
  AVOUCH: 'Awaiting Voucher',
  CNFREC: 'Confirmation Received',
  DEPREQ: 'Deposit Requested',
  GRPDEF: 'Group Definite',
  GTDAGT: 'Guaranteed By Agent',
  GTDCMP: 'Guaranteed By Company',
  GTDCC: 'Guaranteed By Credit Card',
  GTDDEP: 'Guaranteed By Deposit',
  NGG: 'Non-Guaranteed Group',
  NGI: 'Non-Guaranteed Individual',
});

export function createGuaranteeCode(value) {
  if (typeof value !== 'string') return null;
  if (Object.hasOwn(CREATE_GUARANTEES, value)) return value;
  return Object.entries(CREATE_GUARANTEES).find(([, display]) => display === value)?.[0] ?? null;
}

export function validCreateGuest(guest) {
  const valid = (value) => typeof value === 'string' && value === value.trim() && value.length > 0 &&
    value.length <= 256 && !/[\p{Cc}]/u.test(value);
  return Boolean(guest && valid(guest.firstName) && valid(guest.lastName) &&
    `${guest.firstName} ${guest.lastName}`.length <= 256);
}

export const isLabtestGuest = (guest) => guest?.firstName === 'Proof' && guest?.lastName === 'Labtest';
export const createNameKey = (value) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
export const sameCreateGuest = (left, right) => validCreateGuest(left) && validCreateGuest(right) &&
  createNameKey(left.firstName) === createNameKey(right.firstName) &&
  createNameKey(left.lastName) === createNameKey(right.lastName);

export function createCloudTargetKey(guest, arrival, propertyCode = 'HRCEN') {
  const property = getPropertyRegistration(propertyCode);
  if (!property?.active || !validCreateGuest(guest) || !isCreateDate(arrival)) return null;
  return JSON.stringify([propertyCode, 'create', createNameKey(guest.firstName), createNameKey(guest.lastName), arrival,
    ...(propertyCode === 'HRCEN' ? [] : [property.expectedTenant])]);
}

export function isCreateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function hrcenToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

// Past stays are permitted for a read-only recovery, never for a new Save.
export function validCreateDates(arrival, departure, allowRealGuest = false, allowPast = false) {
  return isCreateDate(arrival) && isCreateDate(departure) && arrival < departure &&
    (allowRealGuest ? (allowPast || arrival >= hrcenToday()) : arrival >= '2027-01-01');
}
