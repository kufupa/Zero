// Tiny Draft 2020-12 subset shared by the create CLI and offline tests.
// Ajv is not a repo dependency (only an uninstalled devDependency of
// zod-to-json-schema). $ref siblings other than description are not used.
// Descriptions are ignored at validation time.
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseStayProperty, profileFor } from './property-profile.mjs';

const schemaUrl = new URL('./create-tool.schema.json', import.meta.url);

function deref(schema, root) {
  if (!schema?.$ref) return schema;
  const prefix = '#/$defs/';
  if (!schema.$ref.startsWith(prefix)) throw new Error(`unsupported $ref ${schema.$ref}`);
  const target = root.$defs?.[schema.$ref.slice(prefix.length)];
  if (!target) throw new Error(`missing $ref ${schema.$ref}`);
  return target;
}

function typeList(schema) {
  if (!schema.type) return null;
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function matchesType(type, data) {
  if (type === 'null') return data === null;
  if (type === 'string') return typeof data === 'string';
  if (type === 'boolean') return typeof data === 'boolean';
  if (type === 'integer') return Number.isInteger(data);
  if (type === 'number') return typeof data === 'number' && Number.isFinite(data);
  if (type === 'object') return data !== null && typeof data === 'object' && !Array.isArray(data);
  if (type === 'array') return Array.isArray(data);
  return false;
}

function check(schema, data, path, errors, root) {
  schema = deref(schema, root);
  if (schema.oneOf) {
    const matched = schema.oneOf.filter((sub) => {
      const nested = [];
      check(sub, data, path, nested, root);
      return nested.length === 0;
    });
    if (matched.length !== 1) errors.push(`${path} oneOf`);
  }
  if (schema.allOf) {
    for (const sub of schema.allOf) check(sub, data, path, errors, root);
  }
  if (schema.if) {
    const ifErrors = [];
    check(schema.if, data, path, ifErrors, root);
    if (ifErrors.length === 0 && schema.then) check(schema.then, data, path, errors, root);
  }
  if (Object.hasOwn(schema, 'const') && data !== schema.const) {
    errors.push(`${path} const`);
    return;
  }
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${path} enum`);
    return;
  }
  const types = typeList(schema);
  if (types && !types.some((type) => matchesType(type, data))) {
    errors.push(`${path} type`);
    return;
  }
  if (typeof data === 'string') {
    if (schema.minLength != null && data.length < schema.minLength) errors.push(`${path} minLength`);
    if (schema.maxLength != null && data.length > schema.maxLength) errors.push(`${path} maxLength`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) errors.push(`${path} pattern`);
  }
  if (typeof data === 'number') {
    if (schema.minimum != null && data < schema.minimum) errors.push(`${path} minimum`);
    if (schema.maximum != null && data > schema.maximum) errors.push(`${path} maximum`);
  }
  if (Array.isArray(data)) {
    if (schema.minItems != null && data.length < schema.minItems) errors.push(`${path} minItems`);
    if (schema.uniqueItems && new Set(data.map(item => JSON.stringify(item))).size !== data.length) errors.push(`${path} uniqueItems`);
    if (schema.maxItems != null && data.length > schema.maxItems) errors.push(`${path} maxItems`);
    if (schema.items) {
      data.forEach((item, index) => check(schema.items, item, `${path}[${index}]`, errors, root));
    }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const props = schema.properties ?? {};
    if (schema.required) {
      for (const key of schema.required) {
        if (!Object.hasOwn(data, key)) errors.push(`${path}.${key} required`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(data)) {
        if (!Object.hasOwn(props, key)) errors.push(`${path}.${key} additionalProperties`);
      }
    }
    if (props) {
      for (const [key, sub] of Object.entries(props)) {
        if (Object.hasOwn(data, key)) check(sub, data[key], `${path}.${key}`, errors, root);
      }
    }
  }
}

export function validate(schema, data, root) {
  const errors = [];
  check(schema, data, '$', errors, root);
  return { ok: errors.length === 0, errors };
}

export async function loadCreateToolSchema() {
  return JSON.parse(await readFile(schemaUrl, 'utf8'));
}

function createTrackEnumForProperty(schema, propertyCode) {
  const trackSchema = schema.$defs.request.properties.track;
  const propertyEnums = trackSchema['x-propertyEnums']?.[propertyCode] ?? [];
  const validatorTracks = new Set([...trackSchema.enum, ...propertyEnums]);
  const profileChoices = profileFor(propertyCode)?.createForm?.options?.track?.choices;
  const propertyTracks = Array.isArray(profileChoices)
    ? profileChoices.map(({ value }) => value)
    : trackSchema.enum;
  return propertyTracks.filter((track) => validatorTracks.has(track));
}

const ROOM_LABELS = {
  'Standard Queen': 'STQN',
  'Standard Twin': 'STWN',
  'Standard King': 'SKNG',
  'Executive King': 'EXKNG',
  'Luxury King': 'LUXKNG',
  Suite: 'SUITE',
  'Deluxe King': 'DLXKNG',
  'Deluxe Queen': 'DLXQN',
  'Deluxe Twin': 'DLXTWN',
};

export const TRACK_LABELS = {
  'Airline Rate': 'AIR',
  'Best Available': 'BAR',
  Complimentary: 'COM',
  'Corporate Rate': 'COR',
  'Day Use': 'DAY',
  'Domestic Leisure': 'DOML',
  Educational: 'EDU',
  'Extended Stay': 'EXST',
  'GDS BAR': 'GDSB',
  'GDS Negotiated': 'GDSN',
  'Group and Convention': 'GNC',
  Government: 'GOV',
  'House Use': 'HSE',
  'Legacy Lifestyle Corporate': 'LLC',
  'Online Chinese Market': 'OTA1',
  'OTA Automated': 'OTAA',
  'Legacy Public Website': 'OWS',
  Promotions: 'PROMO',
  'Redemption Rate': 'RED',
  Specials: 'SPE',
  'STO Rate': 'STO',
};

export function parseTrackLookupText(text) {
  const norm = String(text || '').replace(/\s+/g, ' ').trim();
  if (!norm) return null;
  const dashed = /^([A-Z][A-Z0-9]{1,7})\s*[-:]\s+(.+)$/.exec(norm);
  if (dashed) return { code: dashed[1], description: dashed[2], text: norm };
  const spaced = /^([A-Z][A-Z0-9]{1,7})\s+(.+)$/.exec(norm);
  if (spaced) return { code: spaced[1], description: spaced[2], text: norm };
  if (norm === 'BAR' || Object.values(TRACK_LABELS).includes(norm)) {
    return { code: norm, description: '', text: norm };
  }
  return { code: '', description: norm, text: norm };
}

export function matchTrackRow(rows, want) {
  const wantBar = want === 'BAR' || want === 'Best Available';
  const match = (rows || []).find((row) => {
    if (wantBar) return row.description === 'Best Available' || row.code === 'BAR';
    return row.code === want || row.description === want;
  });
  if (!match) return null;
  const code = match.code || (match.description === 'Best Available' ? 'BAR' : '');
  return { ...match, code };
}

export function assertTrackReadyForGuarantee({ validation }) {
  if (validation?.invalid) {
    const msg = (validation.messages || []).filter(Boolean).join('; ') || 'invalid';
    throw new Error(`track_invalid:${msg}`);
  }
}

function normalizeProfileId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const nativeId = typeof value.nativeId === 'string' ? value.nativeId.trim() : '';
  const guest = value.kind === undefined || value.kind === 'guest';
  return guest && /^\d+$/.test(nativeId) ? Number(nativeId) : value;
}

export function normalizeCreateLabels(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const next = { ...data };
  if (Object.hasOwn(next, 'profileId')) next.profileId = normalizeProfileId(next.profileId);
  if (typeof next.roomType === 'string' && ROOM_LABELS[next.roomType]) next.roomType = ROOM_LABELS[next.roomType];
  if (typeof next.track === 'string' && TRACK_LABELS[next.track]) next.track = TRACK_LABELS[next.track];
  return next;
}

// Text the runner types into the optional New Record fields, keyed by native field name. The two lookups take the
// exact party name. LIVE-UNVERIFIED: typed lookup text may not bind the HMS party; Opus checks the readback live.
export function optionalPartyAndNoteFills(stay) {
  const organization = typeof stay.organization === 'string' ? stay.organization : (stay.organization?.name ?? '');
  return {
    ta1: stay.bookingAgency?.name ?? stay.agency ?? '', // LIVE-UNVERIFIED Primary Booking Agency lookup
    company: organization, // LIVE-UNVERIFIED Organization lookup
    reservationnote: stay.reservationNote ?? '', // LIVE-UNVERIFIED multiline textarea
    caller: stay.bookerName ?? '', // LIVE-UNVERIFIED Booker Name
    udfchar06: stay.bookerEmail ?? '', // LIVE-UNVERIFIED Booker Contact
  };
}

/** Native Book fills. guestoptin4 is emitted only when staff opted in; never inferred true. */
export function bookFieldFills(stay) {
  const marketsegment = typeof stay?.marketSegment === 'string' ? stay.marketSegment.trim() : '';
  return {
    ...(marketsegment ? { marketsegment } : {}),
    ...(stay?.guestoptin4 === true ? { guestoptin4: true } : {}),
  };
}

export function validateCreateRequest(data, schema) {
  return validate(schema.$defs.request, data, schema);
}

export function parseShop(argv) {
  return argv.includes('--shop');
}

export function shopRowsFromRecords(records) {
  if (!Array.isArray(records)) throw new Error('shop records');
  const rows = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const roomType = String(record.roomType || '').trim();
    const code = String(record.code || '').trim();
    const name = String(record.name || '').trim();
    if (!roomType || !code || !name) continue;
    rows.push({ roomType, code, name });
  }
  return rows;
}

export function shopRowsFromTexts(lines) {
  const rooms = new Set(['EXKNG', 'LUXKNG', 'SUITE', 'STQN', 'STWN', 'DLXKNG', 'DLXQN', 'DLXTWN', 'SKNG']);
  let roomType = '';
  const rows = [];
  for (const line of lines || []) {
    const text = String(line || '').replace(/\s+/g, ' ').trim();
    if (!text || text === 'Current Rates' || text.startsWith('HRCEN')) continue;
    if (rooms.has(text)) {
      roomType = text;
      continue;
    }
    const match = text.match(/^([A-Z0-9]{2,8})\s+(.+)$/);
    if (match && roomType) rows.push({ roomType, code: match[1], name: match[2] });
  }
  return rows;
}

export function shopResult(records, lines = []) {
  const fromRecords = shopRowsFromRecords(records);
  return {
    salesStrategy: 'BAR',
    rowClicked: false,
    rows: fromRecords.length ? fromRecords : shopRowsFromTexts(lines),
  };
}

export function refuseRateRowClick() {
  throw new Error('RATE_ROW_CLICK_REFUSED');
}

export function parseStopBefore(argv) {
  const paneCommit = argv.includes('--pane-commit');
  const index = argv.indexOf('--stop-before');
  if (index === -1) return { ok: true, stopBefore: null, paneCommit };
  const value = argv[index + 1];
  if (value !== 'availability' && value !== 'save') {
    return { ok: false, exitCode: 2, error: 'Required: --stop-before availability|save' };
  }
  if (paneCommit) {
    return { ok: false, exitCode: 2, error: 'Do not combine --pane-commit with --stop-before' };
  }
  return { ok: true, stopBefore: value, paneCommit: false };
}

const STAY_FILL = ['arrival', 'departure', 'adults', 'sourceOfBusiness', 'roomType', 'ratePlan', 'track', 'guaranteeType', 'filled.png'];

export function stayActions(stopBefore) {
  if (stopBefore === 'availability') return [...STAY_FILL];
  if (stopBefore === 'save') {
    return [...STAY_FILL, 'firstName', 'lastName', 'checkAvailability', 'availability.png'];
  }
  return [...STAY_FILL, 'firstName', 'lastName', 'checkAvailability', 'availability.png', 'save', 'saved.png'];
}

// --out <absolute dir>: where this run writes its screenshots and result.json. Absent: the shared proof dir.
export function parseOutDir(argv) {
  const index = argv.indexOf('--out');
  if (index === -1) return { ok: true, exitCode: 0, outDir: null };
  const value = argv[index + 1];
  if (!value || value.startsWith('--') || !isAbsolute(value)) {
    return { ok: false, exitCode: 2, error: 'Required: --out <absolute directory>' };
  }
  return { ok: true, exitCode: 0, outDir: value };
}

export function parseRequestPath(argv) {
  const index = argv.indexOf('--request');
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value || value.startsWith('--')) {
    return { ok: false, exitCode: 2, error: 'Required: --request <path>' };
  }
  return { ok: true, path: value };
}

export async function loadCreateRequest(argv) {
  const parsed = parseRequestPath(argv);
  if (!parsed.ok) return parsed;
  const property = parseStayProperty(argv);
  if (!property.ok) return property;
  const schema = await loadCreateToolSchema();
  schema.$defs.request.properties.track.enum = createTrackEnumForProperty(schema, property.propertyCode);
  let text;
  try {
    text = await readFile(parsed.path, 'utf8');
  } catch (error) {
    return { ok: false, exitCode: 2, error: `request file: ${error.message}` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, exitCode: 2, error: `invalid request JSON: ${error.message}` };
  }
  data = normalizeCreateLabels(data);
  const result = validateCreateRequest(data, schema);
  if (!result.ok) {
    return { ok: false, exitCode: 2, error: `invalid request: ${result.errors.join('; ')}` };
  }
  return { ok: true, exitCode: 0, request: data };
}
