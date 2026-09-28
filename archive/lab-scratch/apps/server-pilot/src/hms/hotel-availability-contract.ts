/**
 * Tenant-bound Hotel Availability contract.
 *
 * This intentionally contains no guessed Infor field names.  A manifest is
 * issued only after live discovery of the tenant's Hotel Availability surface;
 * the encoder/decoder then uses exactly those names and paths.  This keeps
 * the old OSRRAV adapter available for diagnostics without letting it become
 * a production fallback.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { QuoteRequest } from '../../../../../../apps/server-pilot/src/hms/quote-request-normalization.js';
import { quoteRequestSchema } from '../../../../../../apps/server-pilot/src/hms/quote-request-normalization.js';
import { quoteStayReadDataSchema, type QuoteNightObservation } from '../../../../../../apps/server-pilot/src/hms/quote-stay-contract.js';
import { buildQuoteStayReadData, type QuoteStayReadData } from '../../../../../../apps/server-pilot/src/hms/quote-stay-contract.js';

const pathSchema = z
  .string()
  .regex(/^[A-Za-z0-9_$.[\]-]+(?:\.[A-Za-z0-9_$.[\]-]+)*$/, 'expected a response path');
const fieldNameSchema = z.string().regex(/^[A-Za-z0-9_.[\]-]{1,96}$/);

const roomFieldSchema = z.object({
  quantity: fieldNameSchema,
  adultsPerRoom: fieldNameSchema,
  childAges: fieldNameSchema,
  roomTypeRef: fieldNameSchema,
  ratePlanRef: fieldNameSchema,
});

const responseMapSchema = z.object({
  rowsPath: pathSchema,
  successPath: pathSchema.optional(),
  messagesPath: pathSchema.optional(),
  datePath: pathSchema,
  roomTypePath: pathSchema,
  ratePlanPath: pathSchema,
  availableCountPath: pathSchema,
  amountPath: pathSchema,
  currencyPath: pathSchema,
  restrictionsPath: pathSchema,
  roomGroupIndexPath: pathSchema.optional(),
  quantityPath: pathSchema.optional(),
  /** Optional source assertion that this response priced requested occupancy. */
  occupancyPricedPath: pathSchema.optional(),
  stayTotalPath: pathSchema.optional(),
});

export const hotelAvailabilitySurfaceManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Explicit tenant surface identity; prevents OSRRAV manifest reuse. */
    surface: z.literal('hotel_availability'),
    /** Must be the function discovered from the tenant menu, never guessed. */
    functionName: z.string().regex(/^[A-Z][A-Z0-9_]{2,31}$/),
    openPath: z.string().regex(/^\/[^?]*$/),
    openMethod: z.enum(['GET', 'POST']),
    openBody: z.record(fieldNameSchema, z.string().max(512)),
    searchPath: z.string().regex(/^\/[^?]*$/),
    method: z.literal('POST'),
    contentType: z.literal('application/x-www-form-urlencoded'),
    noWrite: z.literal(true),
    fixedBody: z.record(fieldNameSchema, z.string().max(512)),
    fields: z.object({
      property: fieldNameSchema,
      arrival: fieldNameSchema,
      departure: fieldNameSchema,
      nights: fieldNameSchema,
      currency: fieldNameSchema,
      adults: fieldNameSchema,
      children: fieldNameSchema,
      childAges: fieldNameSchema,
      roomGroups: fieldNameSchema,
      organization: fieldNameSchema.optional(),
      agency: fieldNameSchema.optional(),
      group: fieldNameSchema.optional(),
    }),
    roomEncoding: z.enum(['json', 'indexed_form']),
    roomFields: roomFieldSchema.optional(),
    indexedRoomPrefix: fieldNameSchema.optional(),
    response: responseMapSchema,
    /** SHA-256 over redacted live discovery evidence, not raw PMS output. */
    discoveryEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/i),
    discoveredAt: z.string().datetime(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.roomEncoding === 'json' && manifest.roomFields) {
      ctx.addIssue({ code: 'custom', path: ['roomFields'], message: 'roomFields only for indexed_form' });
    }
    if (manifest.roomEncoding === 'indexed_form' && (!manifest.roomFields || !manifest.indexedRoomPrefix)) {
      ctx.addIssue({ code: 'custom', path: ['roomFields'], message: 'indexed_form requires roomFields and indexedRoomPrefix' });
    }
    const forbidden = /(?:reserve|save|submit|cancel|amend|delete|post|refund|checkin|checkout|crs)/i;
    if (forbidden.test(manifest.openPath) || forbidden.test(manifest.searchPath)) {
      ctx.addIssue({ code: 'custom', path: ['searchPath'], message: 'Hotel Availability manifest contains write path' });
    }
  });

export type HotelAvailabilitySurfaceManifest = z.infer<
  typeof hotelAvailabilitySurfaceManifestSchema
>;

export type HotelAvailabilitySearchInput = {
  request: QuoteRequest;
  manifest: HotelAvailabilitySurfaceManifest;
};

export type HotelAvailabilitySearchBody = Record<string, string>;

function nightsBetween(arrival: string, departure: string): number {
  const start = Date.parse(`${arrival}T00:00:00.000Z`);
  const end = Date.parse(`${departure}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.round((end - start) / 86_400_000);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function assertFieldValue(
  body: HotelAvailabilitySearchBody,
  key: string,
  value: string,
): void {
  const previous = body[key];
  if (previous !== undefined && previous !== value) {
    throw new Error(`Hotel Availability manifest fixed field conflict: ${key}`);
  }
  body[key] = value;
}

function roomPayload(request: QuoteRequest) {
  return request.rooms.map((room) => ({
    quantity: room.quantity,
    adultsPerRoom: room.adultsPerRoom,
    childAges: [...room.childAges],
    ...(room.roomTypeRef ? { roomTypeRef: room.roomTypeRef } : {}),
    ...(room.ratePlanRef ? { ratePlanRef: room.ratePlanRef } : {}),
  }));
}

/** Build exact tenant-bound form fields; no field/default is invented here. */
export function buildHotelAvailabilitySearchBody(
  input: HotelAvailabilitySearchInput,
): HotelAvailabilitySearchBody {
  const request = quoteRequestSchema.parse(input.request);
  const manifest = hotelAvailabilitySurfaceManifestSchema.parse(input.manifest);
  const nights = nightsBetween(request.arrival, request.departure);
  if (nights < 1 || nights > 30) throw new Error('Hotel Availability stay length out of bounds');

  const groups = roomPayload(request);
  const adults = groups.reduce((sum, room) => sum + room.quantity * room.adultsPerRoom, 0);
  const children = groups.reduce((sum, room) => sum + room.quantity * room.childAges.length, 0);
  const childAges = groups.map((room) => [...room.childAges]);
  const body: HotelAvailabilitySearchBody = { ...manifest.fixedBody };
  const fields = manifest.fields;

  assertFieldValue(body, fields.property, request.propertyCode);
  assertFieldValue(body, fields.arrival, request.arrival);
  assertFieldValue(body, fields.departure, request.departure);
  assertFieldValue(body, fields.nights, String(nights));
  assertFieldValue(body, fields.currency, request.currency);
  assertFieldValue(body, fields.adults, String(adults));
  assertFieldValue(body, fields.children, String(children));
  assertFieldValue(body, fields.childAges, json(childAges));

  if (manifest.roomEncoding === 'json') {
    assertFieldValue(body, fields.roomGroups, json(groups));
  } else {
    const roomFields = manifest.roomFields!;
    const prefix = manifest.indexedRoomPrefix!;
    // Indexed encoding still carries each group and quantity; never flatten
    // mixed rooms into the first room's type/rate.
    groups.forEach((room, index) => {
      const key = (name: string) => `${prefix}${index}.${name}`;
      assertFieldValue(body, key(roomFields.quantity), String(room.quantity));
      assertFieldValue(body, key(roomFields.adultsPerRoom), String(room.adultsPerRoom));
      assertFieldValue(body, key(roomFields.childAges), json(room.childAges));
      if (room.roomTypeRef) assertFieldValue(body, key(roomFields.roomTypeRef), room.roomTypeRef);
      if (room.ratePlanRef) assertFieldValue(body, key(roomFields.ratePlanRef), room.ratePlanRef);
    });
    assertFieldValue(body, fields.roomGroups, String(groups.length));
  }

  const optionalRefs: Array<[string | undefined, string | null]> = [
    [fields.organization, request.organizationRef],
    [fields.agency, request.agencyRef],
    [fields.group, request.groupRef],
  ];
  const optionalRefNames = ['organization', 'agency', 'group'] as const;
  for (const [index, [key, value]] of optionalRefs.entries()) {
    if (value === null || value === undefined) continue;
    if (!key) {
      throw new Error(
        `Hotel Availability commercial context mapping missing: ${optionalRefNames[index]}`,
      );
    }
    assertFieldValue(body, key, value);
  }
  return body;
}

function pathValue(value: unknown, path: string): unknown {
  // Tenant responses commonly mix object keys and array indexes
  // (`result.rows[0].pricing.amount`). Tokenize both forms explicitly; a
  // naive dot split would silently miss `rows[0]` and turn a valid response
  // into a false unavailable result.
  const tokens: string[] = [];
  const tokenPattern = /(?:^|\.)([^.[\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(path)) !== null) {
    tokens.push(match[1] ?? match[2]!);
  }
  if (tokens.length === 0) return undefined;
  let current = value;
  for (const part of tokens) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Infor sometimes wraps JSON in a small mixed envelope.  Extract the
    // first balanced object without eval or object-literal execution.
  }
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const opening = text[start]!;
    const closing = opening === '{' ? '}' : ']';
    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"') {
        quote = char;
        continue;
      }
      if (char === opening) depth += 1;
      else if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, index + 1)) as unknown;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function isoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const dmy = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(value);
  if (dmy) {
    const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(dmy[2]!.toUpperCase());
    if (month >= 0) return `${dmy[3]}-${String(month + 1).padStart(2, '0')}-${dmy[1]}`;
  }
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  return mdy ? `${mdy[3]}-${mdy[1]!.padStart(2, '0')}-${mdy[2]!.padStart(2, '0')}` : null;
}

function amount(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw.toFixed(2);
  if (typeof raw === 'string' && /^\d+(?:\.\d{1,2})?$/.test(raw.trim())) return raw.trim();
  return null;
}

function integer(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw)
    ? raw
    : typeof raw === 'string' && /^-?\d+$/.test(raw.trim())
      ? Number(raw)
      : null;
}

function restrictions(raw: unknown): string[] | null {
  if (Array.isArray(raw) && raw.every((item) => typeof item === 'string' && item.trim())) {
    return raw.map((item) => item.trim()).slice(0, 20);
  }
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return null;
}

export type HotelAvailabilityParseResult = {
  envelopeRecognized: boolean;
  rows: QuoteNightObservation[];
  unresolvedFields: string[];
  currency: string | null;
  occupancyPriced: boolean;
  stayTotal: { amount: string; currency: string; basis: 'per_stay'; taxTreatment: 'unknown' } | null;
};

/** Decode only response paths declared by live tenant discovery evidence. */
export function parseHotelAvailabilityResponse(
  text: string,
  request: QuoteRequest,
  manifest: HotelAvailabilitySurfaceManifest,
  observedAt: Date,
): HotelAvailabilityParseResult {
  const root = extractJsonObject(text);
  if (!root || typeof root !== 'object') {
    return { envelopeRecognized: false, rows: [], unresolvedFields: ['hotel_availability_envelope'], currency: null, occupancyPriced: false, stayTotal: null };
  }
  const response = manifest.response;
  const success = response.successPath ? pathValue(root, response.successPath) : true;
  if (success === false) {
    return { envelopeRecognized: true, rows: [], unresolvedFields: ['hotel_availability_search_error'], currency: null, occupancyPriced: false, stayTotal: null };
  }
  const rawRows = pathValue(root, response.rowsPath);
  if (!Array.isArray(rawRows)) {
    return { envelopeRecognized: false, rows: [], unresolvedFields: ['hotel_availability_rows'], currency: null, occupancyPriced: false, stayTotal: null };
  }
  const unresolved: string[] = [];
  const rows: QuoteNightObservation[] = [];
  const currencies = new Set<string>();
  for (const [index, raw] of rawRows.entries()) {
    if (!raw || typeof raw !== 'object') {
      unresolved.push(`hotel_availability.row.${index}`);
      continue;
    }
    const row = raw as Record<string, unknown>;
    const date = isoDate(pathValue(row, response.datePath));
    const roomType = String(pathValue(row, response.roomTypePath) ?? '').trim();
    const ratePlan = String(pathValue(row, response.ratePlanPath) ?? '').trim();
    const availableCount = integer(pathValue(row, response.availableCountPath));
    const displayedAmount = amount(pathValue(row, response.amountPath));
    const rowCurrency = String(pathValue(row, response.currencyPath) ?? '').trim().toUpperCase();
    const rowRestrictions = restrictions(pathValue(row, response.restrictionsPath));
    const roomGroupIndex = response.roomGroupIndexPath
      ? integer(pathValue(row, response.roomGroupIndexPath))
      : null;
    const quantity = response.quantityPath ? integer(pathValue(row, response.quantityPath)) : null;
    if (!date) unresolved.push(`hotel_availability.row.${index}.date`);
    if (!roomType) unresolved.push(`hotel_availability.row.${index}.roomType`);
    if (!ratePlan) unresolved.push(`hotel_availability.row.${index}.ratePlan`);
    if (availableCount === null) unresolved.push(`hotel_availability.row.${index}.availableCount`);
    if (!displayedAmount) unresolved.push(`hotel_availability.row.${index}.displayedAmount`);
    if (!/^[A-Z]{3}$/.test(rowCurrency)) unresolved.push(`hotel_availability.row.${index}.currency`);
    if (!rowRestrictions) unresolved.push(`hotel_availability.row.${index}.restrictions`);
    if (date && roomType && ratePlan && availableCount !== null && displayedAmount && /^[A-Z]{3}$/.test(rowCurrency) && rowRestrictions) {
      currencies.add(rowCurrency);
      rows.push({
        date,
        roomType,
        ratePlan,
        availableCount,
        displayedAmount,
        currency: rowCurrency,
        rateBasis: 'nightly',
        restrictions: rowRestrictions,
        observedAt: observedAt.toISOString(),
        ...(roomGroupIndex !== null ? { roomGroupIndex } : {}),
        ...(quantity !== null && quantity > 0 ? { quantity } : {}),
      });
    }
  }
  const currency = currencies.size === 1 ? [...currencies][0]! : null;
  if (!currency) unresolved.push('source_currency_unresolved');
  if (currencies.size > 1) unresolved.push('source_currency_mismatch');
  if (request.rooms.length > 1 && rows.some((row) => row.roomGroupIndex === undefined)) {
    unresolved.push('room_group_correlation_unresolved');
  }
  const occupancyPriced = response.occupancyPricedPath
    ? pathValue(root, response.occupancyPricedPath) === true
    : false;
  if (!occupancyPriced) unresolved.push('occupancy_pricing_unverified');
  let stayTotal: HotelAvailabilityParseResult['stayTotal'] = null;
  if (response.stayTotalPath) {
    const total = amount(pathValue(root, response.stayTotalPath));
    if (total && currency) stayTotal = { amount: total, currency, basis: 'per_stay', taxTreatment: 'unknown' };
    else unresolved.push('stay_total_unresolved');
  } else {
    unresolved.push('stay_total_unresolved');
  }
  return { envelopeRecognized: true, rows, unresolvedFields: [...new Set(unresolved)], currency, occupancyPriced, stayTotal };
}

export function hotelAvailabilityManifestDigest(manifest: HotelAvailabilitySurfaceManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export function buildHotelAvailabilityReadData(input: {
  request: QuoteRequest;
  parsed: HotelAvailabilityParseResult;
}): QuoteStayReadData {
  const unresolved = new Set(input.parsed.unresolvedFields);
  const expectedNights = new Set(
    input.request.coveredNights.length > 0
      ? input.request.coveredNights
      : (() => {
          const start = Date.parse(`${input.request.arrival}T00:00:00.000Z`);
          const end = Date.parse(`${input.request.departure}T00:00:00.000Z`);
          const dates: string[] = [];
          if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
            for (let cursor = start; cursor < end; cursor += 86_400_000) {
              dates.push(new Date(cursor).toISOString().slice(0, 10));
            }
          }
          return dates;
        })(),
  );
  for (const row of input.parsed.rows) {
    if (!expectedNights.has(row.date)) unresolved.add(`nightly.out_of_window:${row.date}`);
    const groupIndex =
      row.roomGroupIndex !== undefined
        ? row.roomGroupIndex
        : input.request.rooms.length === 1
          ? 0
          : null;
    const room = groupIndex === null ? undefined : input.request.rooms[groupIndex];
    if (room?.roomTypeRef && room.roomTypeRef.toUpperCase() !== row.roomType.toUpperCase()) {
      unresolved.add(`room_type_scope_mismatch:room_group:${groupIndex}`);
    }
    if (room?.ratePlanRef && room.ratePlanRef.toUpperCase() !== row.ratePlan.toUpperCase()) {
      unresolved.add(`rate_plan_scope_mismatch:room_group:${groupIndex}`);
    }
  }
  if (input.parsed.occupancyPriced) unresolved.delete('occupancy_pricing_unverified');
  if (input.parsed.stayTotal) unresolved.delete('stay_total_unresolved');
  const data = buildQuoteStayReadData({
    nightlyObservations: input.parsed.rows,
    requestedRooms: input.request.rooms.reduce((sum, room) => sum + room.quantity, 0),
    requestRef: input.request.quoteRequestRef,
    arrival: input.request.arrival,
    departure: input.request.departure,
    rooms: input.request.rooms,
    currency: input.request.currency,
    sourceCurrency: input.parsed.currency,
    unresolvedInputs: [...unresolved],
  });
  return quoteStayReadDataSchema.parse({
    ...data,
    stayTotal: input.parsed.stayTotal,
    occupancyPriced: input.parsed.occupancyPriced,
  });
}

export type HotelAvailabilityResultStatus =
  | 'ok'
  | 'partial'
  | 'unverified_negative'
  | 'manual_required';

/** Classify one result only after parser and derived-data errors are merged. */
export function classifyHotelAvailabilityResult(input: {
  parsed: Pick<HotelAvailabilityParseResult, 'envelopeRecognized' | 'rows' | 'unresolvedFields'>;
  data: Pick<QuoteStayReadData, 'unresolvedInputs'>;
}): HotelAvailabilityResultStatus {
  const unresolved = new Set([
    ...input.parsed.unresolvedFields,
    ...(input.data.unresolvedInputs ?? []),
  ]);
  if (!input.parsed.envelopeRecognized) return 'manual_required';
  if (input.parsed.rows.length === 0) return 'unverified_negative';
  return unresolved.size === 0 ? 'ok' : 'partial';
}
