import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PROPERTY_REGISTRY } from './property-registry.mjs';
import { lookupActiveProperty } from './read-cli-lease.mjs';

export { withReadCliPage as withLeasedReadPage } from './read-cli-lease.mjs';

// Verified room profiles keyed by HMS property code. A property without an entry has no profile, so its quotes stay unknown.
const PROFILE_FILES = new Map(
  PROPERTY_REGISTRY.properties
    .filter((property) => property.active && property.profileFile)
    .map((property) => [property.propertyCode, new URL(`./${property.profileFile}`, import.meta.url)]),
);
const ROOM_CODE = /^[A-Z0-9_-]+$/;
const FIELD_NAME = /^[a-z][a-z0-9]*$/;
/** Native Hotel Availability strategy codes any registered profile may list. Not hotel-specific. */
export const PROFILE_SALES_STRATEGY_CODES = Object.freeze([
  'BAR', 'PROMO', 'PRESET', 'WS', 'NC', 'GOV', 'AIR', 'DOML', 'OTHER',
]);
const PROFILE_SALES_STRATEGY_CODE_SET = new Set(PROFILE_SALES_STRATEGY_CODES);

function invalid(reason) {
  throw new Error(`property_profile_invalid: ${reason}`);
}

function validateSalesStrategies(rows) {
  if (!Array.isArray(rows) || rows.length < 1) invalid('salesStrategies must list at least one strategy');
  const seen = new Set();
  for (const candidate of rows) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      invalid('salesStrategies entries must be objects');
    }
    const value = typeof candidate.value === 'string' ? candidate.value.trim() : '';
    const display = typeof candidate.display === 'string' ? candidate.display.trim() : '';
    if (!PROFILE_SALES_STRATEGY_CODE_SET.has(value)) {
      invalid(`sales strategy ${value || '(empty)'} is not a known HMS strategy`);
    }
    if (!display || display.length > 80 || /[<>\u0000-\u001f\u007f]/.test(display)) {
      invalid(`sales strategy ${value} display is invalid`);
    }
    if (seen.has(value)) invalid(`salesStrategies repeats ${value}`);
    seen.add(value);
  }
}

/** Checks the shape and the room arithmetic, then returns the profile with its identity digest. Throws when invalid. */
export function validateProfile(raw, propertyCode) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('not an object');
  if (raw.propertyCode !== propertyCode) invalid('property code does not match its file');
  if (raw.building !== 'none') invalid('only a property with no HMS building has a room profile');
  if (!Number.isInteger(raw.publishedRooms) || raw.publishedRooms < 1) invalid('publishedRooms must be a positive integer');
  const capacity = raw.roomCapacity;
  if (!capacity || typeof capacity !== 'object' || Array.isArray(capacity) || !Object.keys(capacity).length) {
    invalid('roomCapacity must list room types');
  }
  let total = 0;
  for (const code of Object.keys(capacity)) {
    if (!ROOM_CODE.test(code)) invalid(`room type ${code} is not an HMS code`);
    if (!Number.isInteger(capacity[code]) || capacity[code] < 1) invalid(`capacity of ${code} must be a positive integer`);
    total += capacity[code];
  }
  if (total !== raw.publishedRooms) invalid(`capacities sum to ${total} but the property publishes ${raw.publishedRooms} rooms`);
  const requiredFields = raw.requiredCreateFields;
  if (!Array.isArray(requiredFields)) invalid('requiredCreateFields must list HMS field names');
  const seenFields = new Set();
  for (const name of requiredFields) {
    if (typeof name !== 'string' || !FIELD_NAME.test(name)) invalid(`required field ${name} is not an HMS field name`);
    if (seenFields.has(name)) invalid(`requiredCreateFields repeats ${name}`);
    seenFields.add(name);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'salesStrategies')) validateSalesStrategies(raw.salesStrategies);
  if (!Array.isArray(raw.evidence?.sources) || !raw.evidence.sources.length) invalid('evidence sources are required');
  // The digest covers room facts only, so editing the evidence wording does not invalidate recorded allocations.
  const identity = JSON.stringify({
    propertyCode,
    publishedRooms: raw.publishedRooms,
    building: raw.building,
    roomCapacity: Object.fromEntries(Object.keys(capacity).sort().map((code) => [code, capacity[code]])),
  });
  return Object.freeze({ ...raw, digest: createHash('sha256').update(identity).digest('hex') });
}

/** The verified profile for an HMS property code, or null when that property has none. */
export function profileFor(propertyCode) {
  const file = typeof propertyCode === 'string' ? PROFILE_FILES.get(propertyCode) : undefined;
  if (!file) return null;
  return validateProfile(JSON.parse(readFileSync(file, 'utf8')), propertyCode);
}

/** Amend allow-list: room type codes this property actually sells. */
export function amendRoomTypes(propertyCode) {
  const profile = profileFor(propertyCode);
  return profile ? Object.keys(profile.roomCapacity) : [];
}

/** Required `--property CODE` of an active registered hotel. Strips the flag so other parsers never see it. */
export function parseStayProperty(argv) {
  const index = argv.indexOf('--property');
  if (index === -1) return { ok: false, exitCode: 2, error: 'PROPERTY_REQUIRED' };
  const value = argv[index + 1];
  if (!lookupActiveProperty(value)) return { ok: false, exitCode: 2, error: 'PROPERTY_UNKNOWN' };
  return { ok: true, propertyCode: value, rest: argv.slice(0, index).concat(argv.slice(index + 2)) };
}

/** Same hotel check create-lab-stay uses: requested --property must match the borrowed secret. */
export function propertySecretRefusal(secret, propertyCode) {
  if (secret?.expectedPropertyCode === propertyCode) return null;
  return `PROPERTY_${propertyCode}_REQUIRED`;
}
