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
/** Native Book fields the pane maps. Required/options come from the profile, never a hotel branch. */
export const BOOK_NATIVE_FIELDS = Object.freeze(['marketsegment', 'guestoptin4']);
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

function uniqueChoiceLabels(choices) {
  const seen = new Set();
  const labels = [];
  for (const row of choices ?? []) {
    for (const label of [row?.display, row?.value]) {
      const text = typeof label === 'string' ? label.trim() : '';
      if (!text || seen.has(text)) continue;
      seen.add(text);
      labels.push(text);
    }
  }
  return labels;
}

/** Native Book fields this profile marks required on the create form. Empty when the profile has no markers. */
export function requiredBookNativeFields(profile) {
  const names = [];
  const markers = profile?.createForm?.requiredMarkers;
  if (!markers || typeof markers !== 'object' || Array.isArray(markers)) return names;
  for (const name of BOOK_NATIVE_FIELDS) {
    if (markers[name]?.required === true) names.push(name);
  }
  return names;
}

/**
 * Market Segment labels from the profile. Prefer createForm.options.marketsegment; else unique
 * track.choices[].marketSegment. null means the profile has no option list.
 */
export function marketSegmentOptions(profile) {
  const direct = profile?.createForm?.options?.marketsegment?.choices;
  if (Array.isArray(direct) && direct.length) return uniqueChoiceLabels(direct);
  const tracks = profile?.createForm?.options?.track?.choices;
  if (!Array.isArray(tracks)) return null;
  const labels = uniqueChoiceLabels(
    tracks.map((row) => ({ value: row?.marketSegment, display: row?.marketSegment })),
  );
  return labels.length ? labels : null;
}

/** Fail closed when the profile is missing, a required Book field is absent, or a listed option does not match. */
export function stayBookFieldRefusal(stay, profile) {
  if (!profile) return 'property_profile_required';
  const required = requiredBookNativeFields(profile);
  const marketSegment = typeof stay?.marketSegment === 'string' ? stay.marketSegment.trim() : '';
  const options = marketSegmentOptions(profile);
  if (required.includes('marketsegment') && !marketSegment) return 'pane_save_market_segment_required';
  if (marketSegment && options && !options.includes(marketSegment)) return 'pane_save_market_segment_invalid';
  if (required.includes('guestoptin4') && stay?.guestoptin4 !== true) return 'pane_save_guest_opt_in_required';
  return null;
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
