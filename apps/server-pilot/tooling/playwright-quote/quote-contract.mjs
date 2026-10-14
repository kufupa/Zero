import { profileFor } from './property-profile.mjs';
const SCHEMA_VERSION = 2;
const MAX_GROUPS = 8;
const MAX_NIGHTS = 30;
const MAX_CHILD_AGE = 99;
const DEFAULT_MAX_OPTIONS = 50;
const MAX_OPTIONS = 200;
const FEATURE_MAPPINGS = new Set([
  'refundability',
  'payment_method',
  'accessibility',
  'parking',
  'room_description',
]);
const BOARD_ALIASES = new Map([
  ['room_only', 'room_only'],
  ['room only', 'room_only'],
  ['ro', 'room_only'],
  ['breakfast', 'breakfast'],
  ['bb', 'breakfast'],
  ['b&b', 'breakfast'],
  ['bed & breakfast', 'breakfast'],
  ['bed & breakfast r', 'breakfast'],
  ['bed and breakfast', 'breakfast'],
  ['room only r', 'room_only'],
  ['dinner_bed_breakfast', 'dinner_bed_breakfast'],
  ['dbb', 'dinner_bed_breakfast'],
  ['dinner bed breakfast', 'dinner_bed_breakfast'],
  ['dinner, bed and breakfast', 'dinner_bed_breakfast'],
  ['dinner bed & breakfast r', 'dinner_bed_breakfast'],
  ['dinner, bed & breakfast r', 'dinner_bed_breakfast'],
  ['dinner, bed, breakfast & beverage r', 'dinner_bed_breakfast'],
  ['half_board', 'half_board'],
  ['half board', 'half_board'],
  ['hb', 'half_board'],
  ['full_board', 'full_board'],
  ['full board', 'full_board'],
  ['fb', 'full_board'],
  ['all_inclusive', 'all_inclusive'],
  ['all inclusive', 'all_inclusive'],
  ['ai', 'all_inclusive'],
]);
const BED_ALIASES = new Map([
  ['single', 'single'],
  ['twin', 'twin'],
  ['double', 'double'],
  ['queen', 'queen'],
  ['king', 'king'],
]);
const LEGACY_ROOT = new Set([
  'propertyCode', 'arrivalDate', 'departureDate', 'rooms', 'roomCode', 'rateCode',
  'preferences', 'interpretation', 'requestedCurrency', 'notes', 'search', 'details',
  'maxOptionsPerGroup', 'rateContext', 'sourceReference',
]);
const V2_ROOT = new Set([
  'schemaVersion', 'propertyCode', 'arrivalDate', 'departureDate', 'rooms',
  'rateContext', 'requestedCurrency', 'search', 'details', 'maxOptionsPerGroup', 'notes',
]);
const ROOM_BASE = new Set(['quantity', 'adults', 'children', 'childAges', 'id']);
const CONSTRAINT_FIELDS = new Set(['roomCodes', 'rateCodes', 'bedTypes', 'boardBases', 'features']);
const NATIVE_CODE = /^[A-Z0-9_-]+$/;
const SALES_STRATEGIES = new Set(['Preset', 'BAR', 'Promotions', 'Wholesale', 'Negotiated Contracted', 'Group & Convention', 'Government', 'Comp / House Use', 'Other']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;
const MONEY = /^(\d+)\.(\d{2})$/;

function issue(code, path, reason, action) {
  return { code, path, reason, action };
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function calendarDate(iso) {
  if (typeof iso !== 'string' || !ISO_DATE.test(iso)) return null;
  const utc = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(utc.getTime()) || utc.toISOString().slice(0, 10) !== iso) return null;
  return utc;
}

function parseMinor(amount) {
  if (typeof amount !== 'string') return null;
  const match = MONEY.exec(amount);
  if (!match) return null;
  return BigInt(match[1]) * 100n + BigInt(match[2]);
}

function formatMinor(minor) {
  const whole = minor / 100n;
  const cents = minor % 100n;
  return `${whole}.${cents.toString().padStart(2, '0')}`;
}

function mapBoard(value) {
  return BOARD_ALIASES.get(normalizeText(value)) ?? null;
}

function mapBed(value) {
  return BED_ALIASES.get(normalizeText(value)) ?? null;
}

function uniqueStrings(values, path, issues, pattern) {
  if (!Array.isArray(values) || values.length === 0) {
    issues.push(issue('EMPTY_CONSTRAINT_LIST', path, 'Empty lists are invalid.', 'Omit the field or supply at least one value.'));
    return null;
  }
  const mapped = [];
  values.forEach((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      issues.push(issue('INVALID_CONSTRAINT', `${path}[${index}]`, 'Values must be non-empty strings.', 'Supply a native code or known vocabulary term.'));
      return;
    }
    if (pattern === 'code') {
      if (!NATIVE_CODE.test(value)) {
        issues.push(issue('INVALID_CONSTRAINT', `${path}[${index}]`, 'Native codes use A-Z, digits, underscore or hyphen.', 'Use the exact PMS code from a previous result.'));
        return;
      }
      mapped.push(value);
      return;
    }
    if (pattern === 'bed') {
      const bed = mapBed(value);
      if (!bed) {
        issues.push(issue('INVALID_CONSTRAINT', `${path}[${index}]`, 'Bed vocabulary is single, twin, double, queen or king.', 'Use that vocabulary; do not invent an equivalence.'));
        return;
      }
      mapped.push(bed);
      return;
    }
    if (pattern === 'board') {
      const board = mapBoard(value);
      if (!board) {
        issues.push(issue('INVALID_CONSTRAINT', `${path}[${index}]`, 'Board vocabulary is room_only, breakfast, dinner_bed_breakfast, half_board, full_board or all_inclusive.', 'Use a known alias; half board is not a specific meal.'));
        return;
      }
      mapped.push(board);
    }
  });
  return mapped.length === values.length ? [...new Set(mapped)] : null;
}

function parseFeatures(values, path, issues) {
  if (!Array.isArray(values) || values.length === 0) {
    issues.push(issue('EMPTY_CONSTRAINT_LIST', path, 'Empty feature lists are invalid.', 'Omit features or supply name/value pairs.'));
    return null;
  }
  const features = [];
  values.forEach((item, index) => {
    if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim() || typeof item.value !== 'string' || !item.value.trim()) {
      issues.push(issue('INVALID_FEATURE', `${path}[${index}]`, 'Each feature needs name and value strings.', 'Supply both strings; unrecognized names stay unresolved later.'));
      return;
    }
    const extra = Object.keys(item).filter((key) => key !== 'name' && key !== 'value');
    if (extra.length) {
      issues.push(issue('UNKNOWN_FIELD', `${path}[${index}].${extra[0]}`, 'Feature objects only accept name and value.', 'Remove extra fields.'));
      return;
    }
    features.push({ name: item.name.trim(), value: item.value.trim() });
  });
  return features.length === values.length ? features : null;
}

function parseConstraints(raw, path, issues) {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    issues.push(issue('INVALID_CONSTRAINT', path, 'Constraints must be an object.', 'Use roomCodes, rateCodes, bedTypes, boardBases and features.'));
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!CONSTRAINT_FIELDS.has(key)) {
      issues.push(issue('UNKNOWN_FIELD', `${path}.${key}`, 'Unknown constraint field.', 'Use roomCodes, rateCodes, bedTypes, boardBases or features.'));
    }
  }
  const parsed = {};
  if (raw.roomCodes !== undefined) {
    const values = uniqueStrings(raw.roomCodes, `${path}.roomCodes`, issues, 'code');
    if (values) parsed.roomCodes = values;
  }
  if (raw.rateCodes !== undefined) {
    const values = uniqueStrings(raw.rateCodes, `${path}.rateCodes`, issues, 'code');
    if (values) parsed.rateCodes = values;
  }
  if (raw.bedTypes !== undefined) {
    const values = uniqueStrings(raw.bedTypes, `${path}.bedTypes`, issues, 'bed');
    if (values) parsed.bedTypes = values;
  }
  if (raw.boardBases !== undefined) {
    const values = uniqueStrings(raw.boardBases, `${path}.boardBases`, issues, 'board');
    if (values) parsed.boardBases = values;
  }
  if (raw.features !== undefined) {
    const values = parseFeatures(raw.features, `${path}.features`, issues);
    if (values) parsed.features = values;
  }
  return Object.keys(parsed).length ? parsed : undefined;
}

function parseReference(raw, path, issues, kind) {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    issues.push(issue('INVALID_RATE_CONTEXT', path, 'Each context reference must be an object.', 'Supply exactly one of code, name or nativeId.'));
    return undefined;
  }
  const keys = Object.keys(raw);
  for (const key of keys) {
    if (key !== 'code' && key !== 'name' && key !== 'nativeId') {
      issues.push(issue('UNKNOWN_FIELD', `${path}.${key}`, 'References accept only code, name or nativeId.', 'Remove extra fields.'));
    }
  }
  const hasCode = Object.hasOwn(raw, 'code');
  const hasName = Object.hasOwn(raw, 'name');
  const hasNativeId = Object.hasOwn(raw, 'nativeId');
  const supplied = [hasCode, hasName && !hasNativeId, hasNativeId].filter(Boolean).length;
  if (supplied !== 1) {
    issues.push(issue('INVALID_RATE_CONTEXT', path, 'Each reference supplies exactly one of native code, exact name or party-lookup nativeId.', 'Provide code, name or nativeId (optionally with its name), not a combination.'));
    return undefined;
  }
  if (hasNativeId) return parseNativeReference(raw, path, issues, kind);
  if (hasCode) {
    if (typeof raw.code !== 'string' || !raw.code.trim() || !NATIVE_CODE.test(raw.code)) {
      issues.push(issue('INVALID_RATE_CONTEXT', `${path}.code`, 'Native codes use A-Z, digits, underscore or hyphen.', 'Use the exact picker code.'));
      return undefined;
    }
    return { code: raw.code };
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    issues.push(issue('INVALID_RATE_CONTEXT', `${path}.name`, 'Name must be an exact non-empty string.', 'Use the exact picker label.'));
    return undefined;
  }
  return { name: raw.name.trim() };
}

function parseNativeReference(raw, path, issues, kind) {
  if (kind === 'group') {
    issues.push(issue('INVALID_RATE_CONTEXT', `${path}.nativeId`, 'party-lookup nativeId applies to organization or agency only.', 'Use the group code or exact name.'));
    return undefined;
  }
  if (typeof raw.nativeId !== 'string' || !raw.nativeId.trim()) {
    issues.push(issue('INVALID_RATE_CONTEXT', `${path}.nativeId`, 'nativeId must be a non-empty party-lookup candidate id.', 'Pass candidates[].nativeId from party-lookup.'));
    return undefined;
  }
  const hasName = Object.hasOwn(raw, 'name');
  if (hasName && (typeof raw.name !== 'string' || !raw.name.trim())) {
    issues.push(issue('INVALID_RATE_CONTEXT', `${path}.name`, 'Name must be an exact non-empty string.', 'Pass candidates[].displayName from party-lookup.'));
    return undefined;
  }
  // The HMS agency picker has no internal-ID filter; it is searched by name, then matched on travelagencyid.
  if (kind === 'agency' && !hasName) {
    issues.push(issue('INVALID_RATE_CONTEXT', `${path}.name`, 'Agency nativeId needs the candidate name to search the picker.', 'Pass candidates[].displayName from party-lookup as name.'));
    return undefined;
  }
  return hasName ? { nativeId: raw.nativeId.trim(), name: raw.name.trim() } : { nativeId: raw.nativeId.trim() };
}

function parseRateContext(raw, issues) {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    issues.push(issue('INVALID_RATE_CONTEXT', 'rateContext', 'rateContext must be an object.', 'Supply organization, agency and/or group references.'));
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!['organization', 'agency', 'group'].includes(key)) {
      issues.push(issue('UNKNOWN_FIELD', `rateContext.${key}`, 'Unknown rate context field.', 'Use organization, agency or group.'));
    }
  }
  const parsed = {};
  for (const key of ['organization', 'agency', 'group']) {
    if (raw[key] !== undefined) {
      const value = parseReference(raw[key], `rateContext.${key}`, issues, key);
      if (value) parsed[key] = value;
    }
  }
  return Object.keys(parsed).length ? parsed : undefined;
}

function parseSearch(raw, issues) {
  const search = { includeRestricted: false, includeAlternatives: true };
  if (raw === undefined) return search;
  if (!isRecord(raw)) {
    issues.push(issue('INVALID_SEARCH', 'search', 'search must be an object.', 'Use salesStrategy, includeRestricted and includeAlternatives.'));
    return search;
  }
  for (const key of Object.keys(raw)) {
    if (!['salesStrategy', 'includeRestricted', 'includeAlternatives'].includes(key)) {
      issues.push(issue('UNKNOWN_FIELD', `search.${key}`, 'Unknown search field.', 'Use salesStrategy, includeRestricted or includeAlternatives.'));
    }
  }
  if (raw.salesStrategy !== undefined) {
    const salesStrategy = typeof raw.salesStrategy === 'string' ? raw.salesStrategy.trim() : '';
    if (!SALES_STRATEGIES.has(salesStrategy)) {
      issues.push(issue('INVALID_SEARCH', 'search.salesStrategy', 'salesStrategy must be one of the Hotel Availability store display labels.', 'Use a dumped label such as BAR, Preset, or Promotions.'));
    } else search.salesStrategy = salesStrategy;
  }
  if (raw.includeRestricted !== undefined) {
    if (typeof raw.includeRestricted !== 'boolean') {
      issues.push(issue('INVALID_SEARCH', 'search.includeRestricted', 'includeRestricted must be boolean.', 'Default is false; restricted offers are information only.'));
    } else search.includeRestricted = raw.includeRestricted;
  }
  if (raw.includeAlternatives !== undefined) {
    if (typeof raw.includeAlternatives !== 'boolean') {
      issues.push(issue('INVALID_SEARCH', 'search.includeAlternatives', 'includeAlternatives must be boolean.', 'Default is true.'));
    } else search.includeAlternatives = raw.includeAlternatives;
  }
  return search;
}

function parsePreferences(preferences, path, issues) {
  if (preferences === undefined) return undefined;
  if (!isRecord(preferences) || Object.values(preferences).some((value) => typeof value !== 'string')) {
    issues.push(issue('INVALID_CONSTRAINT', path, 'Legacy preferences require string values.', 'Supply text values for room, bed, board, flexibility or paymentQuestion.'));
    return undefined;
  }
  for (const key of Object.keys(preferences)) {
    if (!['room', 'bed', 'board', 'flexibility', 'paymentQuestion'].includes(key)) {
      issues.push(issue('UNKNOWN_FIELD', `${path}.${key}`, 'Unknown legacy preference.', 'Use room, bed, board, flexibility or paymentQuestion.'));
    }
  }
  const preferred = {};
  if (preferences.bed !== undefined) {
    const bed = mapBed(preferences.bed);
    if (!bed) {
      issues.push(issue('INVALID_CONSTRAINT', `${path}.bed`, 'Bed vocabulary is single, twin, double, queen or king.', 'Do not equate occupancy with a bed type.'));
    } else preferred.bedTypes = [bed];
  }
  if (preferences.board !== undefined) {
    const board = mapBoard(preferences.board);
    if (!board) {
      issues.push(issue('INVALID_CONSTRAINT', `${path}.board`, 'Board value is not a known alias.', 'Use breakfast, room only, DBB, half board, full board or all inclusive.'));
    } else preferred.boardBases = [board];
  }
  const features = [];
  if (preferences.room !== undefined && preferences.room.trim()) {
    features.push({ name: 'room_description', value: preferences.room.trim() });
  }
  if (preferences.flexibility !== undefined && preferences.flexibility.trim()) {
    features.push({ name: 'refundability', value: preferences.flexibility.trim() });
  }
  if (preferences.paymentQuestion !== undefined && preferences.paymentQuestion.trim()) {
    features.push({ name: 'payment_method', value: preferences.paymentQuestion.trim() });
  }
  if (features.length) preferred.features = features;
  return Object.keys(preferred).length ? preferred : undefined;
}

function parseRoom(raw, index, legacy, issues) {
  const path = `rooms[${index}]`;
  if (!isRecord(raw)) {
    issues.push(issue('INVALID_ROOMS', path, 'Each occupancy group must be an object.', 'Supply quantity, adults, children and childAges.'));
    return null;
  }
  const allowed = new Set(ROOM_BASE);
  if (!legacy) {
    allowed.add('required');
    allowed.add('preferred');
  }
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      issues.push(issue(legacy && (key === 'required' || key === 'preferred') ? 'CONFLICTING_FIELDS' : 'UNKNOWN_FIELD',
        `${path}.${key}`,
        legacy && (key === 'required' || key === 'preferred')
          ? 'Legacy input cannot mix v2 required/preferred fields.'
          : 'Unknown occupancy-group field.',
        legacy && (key === 'required' || key === 'preferred')
          ? 'Set schemaVersion to 2 or remove required/preferred.'
          : 'Remove the extra field.'));
    }
  }
  if (!Number.isInteger(raw.quantity) || raw.quantity < 1) {
    issues.push(issue('INVALID_QUANTITY', `${path}.quantity`, 'Quantity must be a positive integer.', 'Quantity multiplies the per-room occupancy, not the total guest count.'));
  }
  if (!Number.isInteger(raw.adults) || raw.adults < 1) {
    issues.push(issue('INVALID_ADULTS', `${path}.adults`, 'Adults must be a positive integer per room.', 'Supply the per-room adult allocation; do not invent it from a headcount.'));
  }
  if (!Number.isInteger(raw.children) || raw.children < 0) {
    issues.push(issue('INVALID_CHILDREN', `${path}.children`, 'Children must be a non-negative integer per room.', 'Supply the per-room child count.'));
  }
  const agesOk = Array.isArray(raw.childAges) && raw.childAges.every((age) => Number.isInteger(age) && age >= 0 && age <= MAX_CHILD_AGE);
  if (!agesOk || raw.childAges.length !== raw.children) {
    const stale = Array.isArray(raw.childAges) && raw.children === 0 && raw.childAges.length > 0;
    issues.push(issue(stale ? 'STALE_CHILD_AGES' : 'MISSING_CHILD_AGES', `${path}.childAges`,
      stale ? 'Adult-only groups cannot retain child ages.' : 'Supply exactly one age for every child in this group.',
      stale ? 'Remove childAges when children is 0.' : `Supply ${raw.children} integer age(s) from 0 to ${MAX_CHILD_AGE}.`));
  }
  let id;
  if (legacy) {
    if (raw.id !== undefined) {
      if (typeof raw.id !== 'string' || !raw.id.trim()) {
        issues.push(issue('MISSING_GROUP_ID', `${path}.id`, 'Group id must be a non-empty string when supplied.', 'Use a unique occupancy-group id.'));
      } else id = raw.id.trim();
    } else id = `group-${index + 1}`;
  } else if (typeof raw.id !== 'string' || !raw.id.trim()) {
    issues.push(issue('MISSING_GROUP_ID', `${path}.id`, 'v2 occupancy groups require a unique id.', 'Supply a unique rooms[].id.'));
  } else id = raw.id.trim();

  const required = legacy ? undefined : parseConstraints(raw.required, `${path}.required`, issues);
  const preferred = legacy ? undefined : parseConstraints(raw.preferred, `${path}.preferred`, issues);
  const room = {
    id,
    quantity: raw.quantity,
    adults: raw.adults,
    children: raw.children,
    childAges: Array.isArray(raw.childAges) ? [...raw.childAges] : raw.childAges,
  };
  if (required) room.required = required;
  if (preferred) room.preferred = preferred;
  return room;
}

export function normalizeQuoteRequest(input) {
  if (!isRecord(input)) {
    return { ok: false, issues: [issue('INVALID_INPUT', 'request', 'Request must be an object.', 'Supply a JSON object with property, dates and rooms.')] };
  }
  const issues = [];
  const legacy = !Object.hasOwn(input, 'schemaVersion');
  if (!legacy && input.schemaVersion !== SCHEMA_VERSION) {
    issues.push(issue('INVALID_SCHEMA_VERSION', 'schemaVersion', 'Only schemaVersion 2 is accepted.', 'Set schemaVersion to 2 or omit it for legacy input.'));
  }
  const allowed = legacy ? LEGACY_ROOT : V2_ROOT;
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      issues.push(issue('UNKNOWN_FIELD', key, 'Unknown request field.', 'Remove the field or use schemaVersion 2 fields only.'));
    }
  }
  if (!legacy) {
    for (const key of ['roomCode', 'rateCode', 'preferences', 'interpretation']) {
      if (Object.hasOwn(input, key)) {
        issues.push(issue('CONFLICTING_FIELDS', key, 'v2 requests cannot carry legacy root fields.', 'Move codes onto rooms[].required and preferences onto rooms[].preferred.'));
      }
    }
  }
  if (legacy && Array.isArray(input.rooms) && input.rooms.some((room) => isRecord(room) && (Object.hasOwn(room, 'required') || Object.hasOwn(room, 'preferred')))) {
    const index = input.rooms.findIndex((room) => isRecord(room) && (Object.hasOwn(room, 'required') || Object.hasOwn(room, 'preferred')));
    const field = Object.hasOwn(input.rooms[index], 'required') ? 'required' : 'preferred';
    issues.push(issue('CONFLICTING_FIELDS', `rooms[${index}].${field}`, 'Legacy input cannot mix v2 constraint fields.', 'Set schemaVersion to 2 to use required/preferred.'));
  }
  if (Object.hasOwn(input, 'notes') && Object.hasOwn(input, 'interpretation')) {
    issues.push(issue('CONFLICTING_FIELDS', 'notes', 'notes and interpretation both present.', 'Supply only one caller-context string.'));
  }

  const arrival = calendarDate(input.arrivalDate);
  const departure = calendarDate(input.departureDate);
  if (!arrival) issues.push(issue('INVALID_DATE', 'arrivalDate', 'Arrival must be a real ISO calendar date.', 'Use YYYY-MM-DD.'));
  if (!departure) issues.push(issue('INVALID_DATE', 'departureDate', 'Departure must be a real ISO calendar date.', 'Use YYYY-MM-DD; departure is exclusive.'));
  let nights = 0;
  if (arrival && departure) {
    nights = (departure.getTime() - arrival.getTime()) / 86400000;
    if (nights < 1) issues.push(issue('DEPARTURE_NOT_AFTER_ARRIVAL', 'departureDate', 'Departure must follow arrival.', 'Use an exclusive departure date after arrival.'));
    else if (nights > MAX_NIGHTS) issues.push(issue('STAY_LENGTH', 'departureDate', `Stays longer than ${MAX_NIGHTS} nights are out of scope.`, `Request at most ${MAX_NIGHTS} nights.`));
  }
  if (typeof input.propertyCode !== 'string' || !NATIVE_CODE.test(input.propertyCode)) {
    issues.push(issue('INVALID_PROPERTY', 'propertyCode', 'Property must be a native PMS code.', 'Use the authorized property code such as HRCEN.'));
  }
  if (!Array.isArray(input.rooms) || input.rooms.length < 1 || input.rooms.length > MAX_GROUPS) {
    issues.push(issue('INVALID_ROOMS', 'rooms', 'Supply 1-8 occupancy groups.', 'Split occupancy into at most eight groups.'));
  }
  const rooms = Array.isArray(input.rooms) ? input.rooms.map((room, index) => parseRoom(room, index, legacy, issues)).filter(Boolean) : [];
  const ids = rooms.map((room) => room.id).filter(Boolean);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) {
    issues.push(issue('DUPLICATE_GROUP_ID', `rooms[${ids.lastIndexOf(duplicate)}].id`, 'Occupancy group ids must be unique.', 'Give each rooms[].id a distinct value.'));
  }

  let details = legacy ? 'full' : 'summary';
  if (input.details !== undefined) {
    if (input.details !== 'summary' && input.details !== 'full') {
      issues.push(issue('INVALID_DETAILS', 'details', 'details must be summary or full.', 'Use summary for nightly grid facts or full for bounded detail reads.'));
    } else details = input.details;
  }
  let maxOptionsPerGroup = DEFAULT_MAX_OPTIONS;
  if (input.maxOptionsPerGroup !== undefined) {
    if (!Number.isInteger(input.maxOptionsPerGroup) || input.maxOptionsPerGroup < 1 || input.maxOptionsPerGroup > MAX_OPTIONS) {
      issues.push(issue('INVALID_MAX_OPTIONS', 'maxOptionsPerGroup', `maxOptionsPerGroup must be an integer from 1 to ${MAX_OPTIONS}.`, 'A return limit is not exhaustive search.'));
    } else maxOptionsPerGroup = input.maxOptionsPerGroup;
  }
  let requestedCurrency;
  if (input.requestedCurrency !== undefined) {
    if (typeof input.requestedCurrency !== 'string' || !ISO_CURRENCY.test(input.requestedCurrency)) {
      issues.push(issue('INVALID_CURRENCY', 'requestedCurrency', 'Currency must be an ISO 4217 code.', 'Use a three-letter uppercase code or omit to keep property currency.'));
    } else requestedCurrency = input.requestedCurrency;
  }
  const search = parseSearch(input.search, issues);
  const rateContext = parseRateContext(input.rateContext, issues);
  let notes;
  if (typeof input.notes === 'string') notes = input.notes;
  else if (input.notes !== undefined) issues.push(issue('INVALID_INPUT', 'notes', 'notes must be a string.', 'Retain caller context as data only.'));
  if (legacy && typeof input.interpretation === 'string' && notes === undefined) notes = input.interpretation;
  if (legacy && input.sourceReference !== undefined) {
    if (typeof input.sourceReference !== 'string' || !input.sourceReference.trim()) {
      issues.push(issue('INVALID_INPUT', 'sourceReference', 'sourceReference must be a non-empty string.', 'Supply caller metadata as notes, or omit it.'));
    } else if (notes === undefined) notes = input.sourceReference.trim();
    else issues.push(issue('CONFLICTING_FIELDS', 'sourceReference', 'sourceReference and notes/interpretation both present.', 'Keep a single caller-context string.'));
  }

  let requiredFromLegacy;
  if (legacy) {
    for (const key of ['roomCode', 'rateCode']) {
      if (input[key] !== undefined && (typeof input[key] !== 'string' || !NATIVE_CODE.test(input[key]))) {
        issues.push(issue('INVALID_CONSTRAINT', key, 'Legacy native codes use A-Z, digits, underscore or hyphen.', 'Supply a valid roomCode or rateCode.'));
      }
    }
    requiredFromLegacy = {};
    if (typeof input.roomCode === 'string' && NATIVE_CODE.test(input.roomCode)) requiredFromLegacy.roomCodes = [input.roomCode];
    if (typeof input.rateCode === 'string' && NATIVE_CODE.test(input.rateCode)) requiredFromLegacy.rateCodes = [input.rateCode];
    if (!Object.keys(requiredFromLegacy).length) requiredFromLegacy = undefined;
  }
  const preferredFromLegacy = legacy ? parsePreferences(input.preferences, 'preferences', issues) : undefined;
  if (requiredFromLegacy || preferredFromLegacy) {
    for (const room of rooms) {
      if (requiredFromLegacy) room.required = { ...requiredFromLegacy };
      if (preferredFromLegacy) room.preferred = structuredClone(preferredFromLegacy);
    }
  }

  if (issues.length) return { ok: false, issues };
  const request = {
    schemaVersion: SCHEMA_VERSION,
    propertyCode: input.propertyCode,
    arrivalDate: input.arrivalDate,
    departureDate: input.departureDate,
    rooms,
    search,
    details,
    maxOptionsPerGroup,
    normalizedFrom: legacy ? 'legacy' : 'v2',
  };
  if (rateContext) request.rateContext = rateContext;
  if (requestedCurrency) request.requestedCurrency = requestedCurrency;
  if (notes !== undefined) request.notes = notes;
  return { ok: true, request };
}

function listStatus(requested, observed, field) {
  if (observed === undefined || observed === null || observed === '') {
    return { status: 'unknown', evidence: observed ?? null, reason: `No source-backed ${field} fact was supplied.` };
  }
  if (requested.includes(observed)) {
    return { status: 'satisfied', evidence: observed, reason: `Observed ${field} is one of the requested values.` };
  }
  return { status: 'unsatisfied', evidence: observed, reason: `Observed ${field} is not among the requested values.` };
}

function featureStatus(requested, facts) {
  if (!FEATURE_MAPPINGS.has(requested.name)) {
    return { status: 'unknown', evidence: null, reason: 'No implemented source mapping exists for this feature; substring labels are not matches.' };
  }
  const observed = (facts.features ?? []).find((item) => item && normalizeText(item.name) === normalizeText(requested.name));
  if (!observed || typeof observed.value !== 'string') {
    return { status: 'unknown', evidence: null, reason: `Implemented ${requested.name} mapping was not observed on this offer.` };
  }
  if (normalizeText(observed.value) === normalizeText(requested.value)) {
    return { status: 'satisfied', evidence: observed.value, reason: 'Exact normalized feature value matches.' };
  }
  return { status: 'unsatisfied', evidence: observed.value, reason: 'Implemented feature value does not match.' };
}

function conditionsFor(kind, constraints, facts) {
  if (!constraints) return [];
  const conditions = [];
  if (constraints.roomCodes) {
    const result = listStatus(constraints.roomCodes, facts.roomCode, 'roomCodes');
    conditions.push({ kind, field: 'roomCodes', requested: constraints.roomCodes, ...result });
  }
  if (constraints.rateCodes) {
    const result = listStatus(constraints.rateCodes, facts.rateCode, 'rateCodes');
    conditions.push({ kind, field: 'rateCodes', requested: constraints.rateCodes, ...result });
  }
  if (constraints.bedTypes) {
    const result = listStatus(constraints.bedTypes, facts.bedType, 'bedTypes');
    conditions.push({ kind, field: 'bedTypes', requested: constraints.bedTypes, ...result });
  }
  if (constraints.boardBases) {
    const result = listStatus(constraints.boardBases, facts.boardBase, 'boardBases');
    conditions.push({ kind, field: 'boardBases', requested: constraints.boardBases, ...result });
  }
  if (constraints.features) {
    const byName = new Map();
    for (const feature of constraints.features) {
      const list = byName.get(feature.name) ?? [];
      list.push(feature);
      byName.set(feature.name, list);
    }
    for (const requested of byName.values()) {
      const results = requested.map((feature) => featureStatus(feature, facts));
      const satisfied = results.find((result) => result.status === 'satisfied') ?? results.find((result) => result.status === 'unsatisfied') ?? results[0];
      conditions.push({
        kind,
        field: 'features',
        requested,
        status: results.some((result) => result.status === 'satisfied') ? 'satisfied'
          : results.every((result) => result.status === 'unknown') ? 'unknown' : 'unsatisfied',
        evidence: satisfied.evidence,
        reason: results.some((result) => result.status === 'satisfied') ? 'One requested value for this feature matched.' : satisfied.reason,
      });
    }
  }
  return conditions;
}

export function assessConstraints(group, facts = {}) {
  const conditions = [
    ...conditionsFor('required', group?.required, facts),
    ...conditionsFor('preferred', group?.preferred, facts),
  ];
  const required = conditions.filter((condition) => condition.kind === 'required');
  let matchStatus = 'match';
  if (required.some((condition) => condition.status === 'unsatisfied')) matchStatus = 'alternative';
  else if (required.some((condition) => condition.status === 'unknown')) matchStatus = 'unresolved';
  return { matchStatus, conditions };
}

function hasSingletonSelection(group) {
  return Array.isArray(group?.required?.roomCodes) && group.required.roomCodes.length === 1
    && Array.isArray(group?.required?.rateCodes) && group.required.rateCodes.length === 1;
}

const ROOM_PROFILE_OUT_OF_DATE = 'Room profile out of date: observed HMS room types, inventory or building codes no longer match the verified property profile.';

// Every observed row: a profiled room type, no HMS building, per-night inventory within that type's capacity.
function matchesProfile(profile, groups) {
  if (!Array.isArray(groups)) return false;
  return groups.every((group) => Array.isArray(group?.options) && group.options.every((row) => {
    const code = row?.room?.code;
    if (typeof code !== 'string' || !Object.hasOwn(profile.roomCapacity, code) || row.room.buildingCode !== null) return false;
    return (row.nightly ?? []).every((night) => Number.isInteger(night?.inventory)
      && night.inventory >= 0 && night.inventory <= profile.roomCapacity[code]);
  }));
}

/** True only when propertyCode has a verified profile and the capture matches it. Any other shape means no profile pools. */
export function profileHolds(propertyCode, groups = []) {
  const profile = profileFor(propertyCode);
  return profile !== null && matchesProfile(profile, groups);
}

export function composeAllocation(groups = [], propertyCode) {
  if (!Array.isArray(groups) || groups.length <= 1) {
    return { status: 'not_selected', reason: 'Single occupancy group; per-option inventory only.', pools: [] };
  }
  const profile = profileFor(propertyCode);
  const holds = profile !== null && matchesProfile(profile, groups);
  const selected = groups.map((group) => {
    const required = group.request?.required ?? group.required;
    const quantity = group.quantity ?? group.request?.quantity;
    const options = group.options ?? [];
    const singleton = Array.isArray(required?.roomCodes) && required.roomCodes.length === 1
      && Array.isArray(required?.rateCodes) && required.rateCodes.length === 1;
    // An unavailable option keeps its pool, so its short night reads as insufficient rather than unidentified.
    const option = singleton
      ? options.find((row) => row.room?.code === required.roomCodes[0] && row.rate?.code === required.rateCodes[0]
        && row.matchStatus === 'match' && row.eligibility === 'verified' && ['available', 'unavailable'].includes(row.availability))
      : undefined;
    const building = option?.room?.buildingCode;
    // No HMS building: the room type is its own pool, but only while every observed row matches the verified profile.
    const scope = typeof building === 'string' && building ? building : building === null && holds ? 'profile' : undefined;
    const poolId = typeof propertyCode === 'string' && propertyCode && option?.room?.code && scope
      ? `${propertyCode}:${scope}:${option.room.code}` : undefined;
    return {
      id: group.id,
      quantity,
      required,
      matchStatus: option?.matchStatus ?? group.matchStatus,
      poolId,
      profilePool: scope === 'profile',
      nullBuilding: building === null,
      nightly: option?.nightly,
    };
  });
  const supplyByNight = new Map();
  for (const group of selected) {
    if (!group.poolId || !Array.isArray(group.nightly)) continue;
    for (const night of group.nightly) {
      if (!night || !Number.isInteger(night.inventory)) {
        return { status: 'unknown', reason: 'Selected offer lacks integer per-night inventory.', pools: [] };
      }
      const key = `${group.poolId}|${night.date}`;
      const prior = supplyByNight.get(key);
      if (prior !== undefined && prior !== night.inventory) {
        return { status: 'unknown', reason: 'Same-pool observations disagree; sequential searches are not an atomic inventory check.', pools: [] };
      }
      supplyByNight.set(key, night.inventory);
    }
  }
  const sourcePools = [];
  for (const group of selected) {
    if (!group.poolId || sourcePools.some((pool) => pool.id === group.poolId)) continue;
    const nights = (group.nightly ?? []).map((night) => ({ date: night.date, supply: night.inventory }));
    if (nights.length) sourcePools.push({ id: group.poolId, nights });
  }
  const allocation = evaluateAllocation(selected, sourcePools);
  if (allocation.status === 'unknown' && profile !== null && !holds && selected.some((group) => group.nullBuilding)) {
    return { ...allocation, reason: ROOM_PROFILE_OUT_OF_DATE, diagnostic: 'room_profile_mismatch' };
  }
  return allocation.pools.length && selected.some((group) => group.profilePool)
    ? { ...allocation, poolBasis: 'property_profile', profileDigest: profile.digest } : allocation;
}

export function evaluateAllocation(groups = [], sourcePools = []) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return { status: 'unknown', reason: 'No occupancy groups were supplied.', pools: [] };
  }
  if (!groups.every(hasSingletonSelection) || groups.some((group) => group.matchStatus && group.matchStatus !== 'match')) {
    return {
      status: 'not_selected',
      reason: 'All-room totals require one matching room code and rate code per group. Alternatives are not summed.',
      pools: [],
    };
  }
  if (groups.some((group) => typeof group.poolId !== 'string' || !group.poolId)) {
    return { status: 'unknown', reason: 'Source did not prove a shared inventory-pool identity.', pools: [] };
  }
  const poolById = new Map((sourcePools ?? []).filter((pool) => pool && typeof pool.id === 'string').map((pool) => [pool.id, pool]));
  for (const group of groups) {
    if (!poolById.has(group.poolId)) {
      return { status: 'unknown', reason: 'No proven source pool exists for the selected product. Pool identity is not invented.', pools: [] };
    }
  }
  const demandByPool = new Map();
  for (const group of groups) {
    demandByPool.set(group.poolId, (demandByPool.get(group.poolId) ?? 0) + group.quantity);
  }
  const pools = [];
  let insufficient = false;
  for (const [id, demand] of demandByPool) {
    const source = poolById.get(id);
    if (!Array.isArray(source.nights) || source.nights.length === 0) {
      return { status: 'unknown', reason: 'Proven pool is missing per-night supply.', pools: [] };
    }
    const nights = source.nights.map((night) => {
      if (!night || typeof night.date !== 'string' || !Number.isInteger(night.supply)) {
        return { date: night?.date, demand, supply: night?.supply, comparable: false };
      }
      if (demand > night.supply) insufficient = true;
      return { date: night.date, demand, supply: night.supply, comparable: true };
    });
    if (nights.some((night) => night.comparable === false)) {
      return { status: 'unknown', reason: 'Pool supply is not comparable across the requested nights.', pools: [] };
    }
    pools.push({ id, nights });
  }
  return {
    status: insufficient ? 'insufficient' : 'verified_at_observation',
    reason: insufficient ? 'Combined demand exceeds proven same-pool supply on at least one night.' : 'Combined demand fits the proven same-pool observation.',
    pools,
  };
}

/**
 * The short room-nights a capture proves: a shared pool whose combined demand is above its supply, then, for each group with no
 * matching room type that fits every night, each matching row whose own inventory is below its quantity. Each entry names the
 * room type, its label, the night, the demand and the supply.
 */
export function shortfallsOf(groups = [], propertyCode) {
  if (!Array.isArray(groups)) return [];
  const labelOf = (code) => {
    for (const group of groups) {
      const row = (group?.options ?? []).find((option) => option?.room?.code === code && typeof option.room.label === 'string');
      if (row?.room.label) return row.room.label;
    }
    return code;
  };
  const found = [];
  const seen = new Set();
  const add = (roomCode, date, demand, supply) => {
    if (seen.has(`${roomCode}|${date}`)) return;
    seen.add(`${roomCode}|${date}`);
    found.push({ roomCode, roomLabel: labelOf(roomCode), date, demand, supply });
  };
  for (const pool of composeAllocation(groups, propertyCode).pools ?? []) {
    const roomCode = pool.id.slice(pool.id.lastIndexOf(':') + 1);
    for (const night of pool.nights) {
      if (night.comparable && night.demand > night.supply) add(roomCode, night.date, night.demand, night.supply);
    }
  }
  for (const group of groups) {
    const quantity = group?.quantity ?? group?.request?.quantity;
    if (!Number.isInteger(quantity)) continue;
    const rows = (group?.options ?? []).filter((row) => row?.matchStatus === 'match' && typeof row.room?.code === 'string');
    // A matching room type with enough inventory on every night satisfies the group, so only a group with none names its short rows.
    const satisfied = rows.some((row) => Array.isArray(row.nightly) && row.nightly.length > 0
      && row.nightly.every((night) => Number.isInteger(night?.inventory) && night.inventory >= quantity));
    if (satisfied) continue;
    for (const row of rows) {
      for (const night of row.nightly ?? []) {
        if (Number.isInteger(night?.inventory) && night.inventory < quantity) {
          add(row.room.code, night.date, quantity, night.inventory);
        }
      }
    }
  }
  return found;
}

/**
 * Other observed room types that can cover the requested stay on the same board.
 * These are choice hints, not a quote: only verified, available and explicitly
 * unheld options are returned, with quantity bounded by every requested night.
 */
export function availableRoomAlternatives(groups = [], request) {
  if (!Array.isArray(groups) || !isRecord(request) || !Array.isArray(request.rooms)) return [];
  const arrival = calendarDate(request.arrivalDate);
  const departure = calendarDate(request.departureDate);
  if (!arrival || !departure || departure <= arrival) return [];
  const dates = [];
  for (let date = arrival; date < departure; date = new Date(date.getTime() + 86400000)) {
    dates.push(date.toISOString().slice(0, 10));
    if (dates.length > MAX_NIGHTS) return [];
  }
  const byIdentity = new Map();
  for (const group of groups) {
    const requested = request.rooms.find((room) => room?.id === group?.id);
    const requestedQuantity = requested?.quantity ?? group?.request?.quantity ?? group?.quantity;
    if (!requested || !Number.isInteger(requestedQuantity) || requestedQuantity < 1) continue;
    const required = requested.required ?? {};
    const requiredBoards = Array.isArray(required.boardBases)
      ? required.boardBases.map(mapBoard).filter(Boolean)
      : [];
    const requestedRooms = Array.isArray(required.roomCodes) ? required.roomCodes : [];
    const requestedRates = Array.isArray(required.rateCodes) ? required.rateCodes : [];
    for (const option of group?.options ?? []) {
      const roomCode = option?.room?.code;
      const roomLabel = typeof option?.room?.label === 'string' ? option.room.label.trim() : '';
      const board = mapBoard(option?.board);
      if (
        typeof roomCode !== 'string' || !NATIVE_CODE.test(roomCode) ||
        !roomLabel || roomLabel.length > 120 ||
        requestedRooms.includes(roomCode) ||
        (requiredBoards.length > 0 && !requiredBoards.includes(board)) ||
        (requestedRates.length > 0 && !requestedRates.includes(option?.rate?.code)) ||
        !['match', 'alternative'].includes(option?.matchStatus) ||
        option?.eligibility !== 'verified' ||
        !['available', 'unavailable'].includes(option?.availability) ||
        option?.held !== false ||
        (request.rateContext && option?.rateScope !== 'contextual') ||
        (Array.isArray(option?.issues) && option.issues.length > 0)
      ) continue;
      // An alternate room is acceptable only when every other required condition
      // (not the requested room code itself) was actually satisfied.
      const otherRequired = (option?.conditions ?? []).filter(
        (condition) => condition?.kind === 'required' && condition.field !== 'roomCodes',
      );
      if (otherRequired.some((condition) => condition.status !== 'satisfied')) continue;
      const nightly = option?.nightly;
      if (!Array.isArray(nightly) || nightly.length !== dates.length) continue;
      const supplyByDate = new Map();
      for (const night of nightly) {
        if (!dates.includes(night?.date) || !Number.isSafeInteger(night?.inventory) || night.inventory < 0) {
          supplyByDate.clear();
          break;
        }
        supplyByDate.set(night.date, night.inventory);
      }
      if (supplyByDate.size !== dates.length) continue;
      const quantity = Math.min(requestedQuantity, ...dates.map((date) => supplyByDate.get(date)));
      if (quantity < 1) continue;
      const groupId = typeof requested.id === 'string' ? requested.id : '';
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(groupId)) continue;
      const key = `${groupId}|${roomCode}`;
      const current = byIdentity.get(key);
      if (!current || quantity > current.quantity) {
        byIdentity.set(key, { groupId, roomCode, roomLabel, quantity });
      }
    }
  }
  return [...byIdentity.values()];
}

/**
 * The stay nights HMS closes to sale for a room type. Only a group whose every matching row is restricted names any night, and a
 * night is named for a room type only when every matching row of that type is closed on it. Length-of-stay restrictions close no night.
 */
export function restrictedNightsOf(options = []) {
  const rows = options.filter((option) => option?.matchStatus === 'match' && typeof option.room?.code === 'string');
  if (!rows.length || rows.some((option) => option.availability !== 'restricted')) return [];
  const closed = (night) => night?.restricted === true || night?.rateAvailable === false || night?.restrictions?.combClosed === true;
  const found = [];
  for (const roomCode of new Set(rows.map((row) => row.room.code))) {
    const roomRows = rows.filter((row) => row.room.code === roomCode);
    for (const date of (roomRows[0].nightly ?? []).map((night) => night?.date)) {
      if (roomRows.every((row) => (row.nightly ?? []).some((night) => night?.date === date && closed(night)))) {
        found.push({ roomCode, roomLabel: roomRows[0].room.label || roomCode, date });
      }
    }
  }
  return found;
}

const MATCH_RANK = { match: 0, alternative: 1, unresolved: 2 };
const ELIGIBILITY_RANK = { verified: 0, conditional: 1, unknown: 2 };
const AVAILABILITY_RANK = { available: 0, restricted: 1, unknown: 2, unavailable: 3 };

function displayedMinor(amount) {
  const parsed = typeof amount === 'string' ? parseMinor(amount) : null;
  return parsed === null ? -1n : parsed;
}

function preferredHits(option) {
  return (option.conditions ?? []).filter((condition) => condition.kind === 'preferred' && condition.status === 'satisfied').length;
}

export function orderOptions(options = []) {
  return [...options].sort((left, right) => {
    const match = (MATCH_RANK[left.matchStatus] ?? 9) - (MATCH_RANK[right.matchStatus] ?? 9);
    if (match) return match;
    const eligibility = (ELIGIBILITY_RANK[left.eligibility] ?? 9) - (ELIGIBILITY_RANK[right.eligibility] ?? 9);
    if (eligibility) return eligibility;
    const availability = (AVAILABILITY_RANK[left.availability] ?? 9) - (AVAILABILITY_RANK[right.availability] ?? 9);
    if (availability) return availability;
    const preferred = preferredHits(right) - preferredHits(left);
    if (preferred) return preferred;
    const sum = displayedMinor(right.displayedSum) - displayedMinor(left.displayedSum);
    if (sum < 0n) return -1;
    if (sum > 0n) return 1;
    const room = String(left.roomCode ?? '').localeCompare(String(right.roomCode ?? ''));
    if (room) return room;
    return String(left.rateCode ?? '').localeCompare(String(right.rateCode ?? ''));
  });
}

function groupIncomplete(group) {
  const completeness = group?.completeness;
  if (!completeness) return true;
  return completeness.requiredFacts !== 'complete'
    || completeness.search !== 'complete'
    || completeness.matchingRowsUnseen === true
    || completeness.search === 'truncated';
}

export function aggregateOutcome({ inputIssues, fatal, groups = [], allocation } = {}) {
  if (Array.isArray(inputIssues) && inputIssues.length) return { outcome: 'input_gap' };
  if (fatal) return { outcome: 'execution_failure' };
  if (groups.some(groupIncomplete)) return { outcome: 'partial' };
  if (groups.some((group) => group.outcome === 'no_match')) return { outcome: 'no_match' };
  if (groups.some((group) => group.outcome === 'unavailable') || allocation?.status === 'insufficient') {
    return { outcome: 'unavailable' };
  }
  if (groups.length > 1 && allocation?.status !== 'verified_at_observation') return { outcome: 'partial' };
  if (allocation?.status === 'unknown') return { outcome: 'partial' };
  if (groups.length && groups.every((group) => group.outcome === 'quote')) return { outcome: 'quote' };
  return { outcome: 'partial' };
}

export function sumDisplayedRates(nightly, quantity) {
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { ok: false, reason: 'invalid_quantity' };
  }
  if (!Array.isArray(nightly) || nightly.length === 0) {
    return { ok: false, reason: 'incomplete_dates' };
  }
  let currency;
  let total = 0n;
  for (const night of nightly) {
    if (!night || typeof night.date !== 'string' || !calendarDate(night.date)) {
      return { ok: false, reason: 'incomplete_dates' };
    }
    if (night.amount === null || night.amount === undefined || night.amount === '') {
      return { ok: false, reason: 'missing_amount' };
    }
    if (typeof night.currency !== 'string' || !ISO_CURRENCY.test(night.currency)) {
      return { ok: false, reason: 'unsupported_amount_format' };
    }
    if (currency && night.currency !== currency) {
      return { ok: false, reason: 'mixed_currency' };
    }
    currency = night.currency;
    const minor = parseMinor(night.amount);
    if (minor === null) return { ok: false, reason: 'unsupported_amount_format' };
    total += minor;
  }
  const perRoomAmount = formatMinor(total);
  const forQuantityAmount = formatMinor(total * BigInt(quantity));
  const labelled = (amount) => ({
    amount,
    currency,
    label: 'sum_of_displayed_nightly_rates',
    official: false,
  });
  return { ok: true, perRoom: labelled(perRoomAmount), forQuantity: labelled(forQuantityAmount) };
}
