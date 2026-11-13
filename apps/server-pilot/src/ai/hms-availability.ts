/**
 * Availability probe for an inbound quote's stays (U10), run as a third hms-job/1 kind.
 *
 * One read per stay on the Hotel Availability screen (fetch-quote.mjs, the view-only quote reader): the stay's dates
 * and each room group's occupancy. No party lookup and no rate code. The read takes the property lock with try-lock
 * (background priority), and the job keeps the result as a dated snapshot (KTD11). Enqueued from hms-jobs.ts only
 * when HMS_JOB_QUEUE=on and HMS_AVAILABILITY_PREFETCH=on.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  isPropertyReadLockDeadline,
  type PropertyReadLockAcquisitionOptions,
} from '../hms/property-read-lock.js';
import type { ExtractionRow, ExtractionStay } from './extraction/schema.js';
import { paneStaySpawnEnv, warnPaneStaySpawnFailed } from './pane-stay-spawn-env.js';
import { classifyHmsLoginOutage } from '../hms/property-outage.js';
import { type PaneStayLock } from './pane-stay-save.js';
import { type HmsReadTarget } from '../hms/hms-read-target.js';
import type { HmsCloudRateLookup } from './hms-cloud-saved-stay-find.js';
import { canonicalJson } from './draft-approval.js';
import { matchRoomType } from './room-types.js';
import { occupiedDates } from '../quote-proposal/quote-revision.js';

const execFileAsync = promisify(execFile);
const QUOTE_TOOL = fileURLToPath(new URL('../../tooling/playwright-quote/fetch-quote.mjs', import.meta.url));
// The quote tool writes under the repo's .private/playwright-quote only (fetchQuote refuses any other output).
const QUOTE_ROOT = fileURLToPath(new URL('../../../../.private/playwright-quote/', import.meta.url));
// A summary read opens the availability screen and reads the grid. Same bound as the pane lookups.
const PROBE_TIMEOUT_MS = 5 * 60_000;

// Limits of the quote tool's v2 request (quote-contract.mjs): 8 occupancy groups, 30 nights, child ages up to 99.
const MAX_ROOM_GROUPS = 8;
const MAX_NIGHTS = 30;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const nativeCode = z.string().regex(/^[A-Z0-9]{1,12}$/);
const nativeId = z.string().trim().min(1).max(40).refine(value => !/[\p{Cc}]/u.test(value));
const partyRef = z.object({ nativeId, name: z.string().trim().min(1).max(200).refine(value => !/[\p{Cc}]/u.test(value)) }).strict();

/** Pricing identity reconstructed by the route from the bound effective draft. */
export const rateContextSchema = z.object({
  propertyCode: z.string().min(1),
  workflow: z.enum(['quote', 'create', 'amend']),
  arrival: z.string().regex(ISO_DAY), departure: z.string().regex(ISO_DAY),
  roomCode: nativeCode, quantity: z.number().int().min(1).max(99),
  adults: z.number().int().min(1).max(9), childAges: z.array(z.number().int().min(0).max(99)).max(9),
  mealPlan: z.enum(['room_only', 'bb', 'dbb']).nullable(), currency: z.string().regex(/^[A-Z]{3}$/),
  bookingAgencyId: nativeId.nullable(), organizationId: nativeId.nullable(), guestProfileId: nativeId.nullable(),
  sourceOfBusiness: z.string().nullable(), track: z.string().nullable(), guaranteeType: z.string().nullable(),
  typedRatePlan: nativeCode.nullable(),
  savedTarget: z.object({ confirmation: z.string().min(1), bookedArrival: z.string().regex(ISO_DAY),
    nativePreimageDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable(),
  retainRates: z.enum(['yes', 'no']).nullable(),
}).strict();
export type RateContext = z.infer<typeof rateContextSchema>;

export { rateContextKey } from './rate-options.js';

export const availabilityRequestSchema = z
  .object({
    kind: z.literal('availability'),
    arrival: z.string().regex(ISO_DAY),
    departure: z.string().regex(ISO_DAY),
    rateContext: rateContextSchema.optional(),
    rateParties: z.object({ organization: partyRef.optional(), bookingAgency: partyRef.optional() }).strict().optional(),
    rooms: z
      .array(
        z
          .object({
            // The stated room type, kept for the snapshot's label. It is not sent to HMS: there is no code map yet.
            roomType: z.string().min(1).max(120),
            quantity: z.number().int().min(1).max(99),
            adults: z.number().int().min(1).max(9),
            childAges: z.array(z.number().int().min(0).max(99)).max(9),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ROOM_GROUPS),
  })
  .strict();

/** Refined job schema preserves availabilityRequestSchema.shape for existing pane route consumers. */
export const availabilityJobRequestSchema = availabilityRequestSchema.superRefine((request, ctx) => {
    const context = request.rateContext;
    if (!context) {
      if (request.rateParties) ctx.addIssue({ code: 'custom', message: 'Rate parties require a rate context.' });
      return;
    }
    const room = request.rooms[0];
    if (request.rooms.length !== 1 || !room || context.arrival !== request.arrival || context.departure !== request.departure ||
        context.quantity !== room.quantity || context.adults !== room.adults ||
        JSON.stringify(context.childAges) !== JSON.stringify(room.childAges) ||
        !isRealIsoDay(context.arrival) || !isRealIsoDay(context.departure) ||
        !(context.departure > context.arrival) ||
        (Date.parse(context.departure) - Date.parse(context.arrival)) / 86_400_000 > MAX_NIGHTS) {
      ctx.addIssue({ code: 'custom', message: 'Rate context must match one complete room scenario within 30 nights.' });
    }
    for (const [kind, id] of [['organization', context.organizationId], ['bookingAgency', context.bookingAgencyId]] as const) {
      if ((request.rateParties?.[kind]?.nativeId ?? null) !== id) {
        ctx.addIssue({ code: 'custom', message: `Rate ${kind} reference must match the context ID.` });
      }
    }
  });
export type AvailabilityRequest = z.infer<typeof availabilityRequestSchema>;

const pickedRateParty = partyRef.extend({ jobId: z.string().uuid() }).strict();
export const ratePartySelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none'), ratePlan: nativeCode.nullable().optional() }).strict(),
  z.object({ kind: z.literal('selected'), bookingAgency: pickedRateParty.nullable(), organization: pickedRateParty.nullable(),
    ratePlan: nativeCode.nullable().optional() }).strict(),
]).refine(selection => selection.kind === 'none' || selection.bookingAgency !== null || selection.organization !== null);
export type RatePartySelection = z.infer<typeof ratePartySelectionSchema>;

/** Durable picker evidence, separate from native Prepare authority. */
export const ratePartyBindingSchema = z.object({
  version: z.literal(1), source: z.object({ threadId: z.string(), messageId: z.string(), sourceHash: z.string() }).strict(),
  extractionId: z.string().uuid(), requestId: z.string(), stayId: z.string(), rowId: z.string(), roomIndex: z.number().nullable(),
  workflow: z.enum(['quote', 'create']), selectedBy: z.string(), selectedAt: z.string(), selection: ratePartySelectionSchema,
}).strict();
export const ratePartyBindingKey = (request: { requestId: string; stayId: string; rowId: string | null; roomIndex: number | null }) =>
  `requests[${request.requestId}].rateContext[${JSON.stringify([request.stayId, request.rowId, request.roomIndex])}]`;

/** Current source room plus an explicit, persisted party choice; omitted parties stay unknown. */
export function boundSourceRateRequest(input: {
  propertyCode: string; workflow: 'quote' | 'create'; requestId: string; rowId: string; roomIndex: number | null;
  stay: Pick<ExtractionStay, 'id' | 'requested' | 'rows' | 'totalAdults' | 'totalChildren'>;
  state: Record<string, unknown>; selection: RatePartySelection; sourceRowExists: boolean; childAgeWarning?: boolean; typedRatePlan?: string;
}): { request: AvailabilityRequest; explicitCode: string | null; unchangedCode: null; draftContextKey: string } | { reason: string } {
  const { stay, state, selection } = input;
  const row = stay.rows.find(row => row.id === input.rowId);
  if (!row) return { reason: 'ROOM_IDENTITY_CHANGED' };
  const rowPrefix = `stays[${stay.id}].rows[${row.id}].`;
  const pick = (path: string, fallback: unknown) => Object.hasOwn(state, path) ? state[path] : fallback;
  const count = pick(`${rowPrefix}count`, row.rooms);
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 99 ||
      (input.workflow === 'quote' ? input.roomIndex !== null : input.roomIndex === null || !Number.isInteger(input.roomIndex) || input.roomIndex < 0 || input.roomIndex >= (count as number))) {
    return { reason: 'ROOM_QUANTITY_UNRESOLVED' };
  }
  const requestRow = `requests[${input.requestId}].rows[${input.rowId}].`;
  const roomPrefix = input.workflow === 'create' ? `${requestRow}rooms[${input.roomIndex}].` : null;
  const roomPick = (field: string, fallback: unknown) => roomPrefix ? pick(`${roomPrefix}${field}`, fallback) : fallback;
  const arrival = roomPick('arrival', pick(`stays[${stay.id}].requested.arrival`, stay.requested.arrival));
  const departure = roomPick('departure', pick(`stays[${stay.id}].requested.departure`, stay.requested.departure));
  const selectedRoom = roomPrefix ? roomPick('roomTypeCode', pick(`${requestRow}roomTypeCode`, undefined)) : undefined;
  const rawRoom = pick(`${rowPrefix}roomType`, row.roomType);
  const room = typeof rawRoom === 'string' ? matchRoomType(rawRoom, input.propertyCode) : null;
  const roomCode = selectedRoom !== undefined ? selectedRoom : room && 'code' in room ? room.code : null;
  const adults = roomPick('adults', pick(`${rowPrefix}adults`, stay.rows.length === 1 && count === 1 &&
    Object.hasOwn(state, `stays[${stay.id}].totalAdults`) ? state[`stays[${stay.id}].totalAdults`] :
    row.adultsPerRoom ?? (stay.rows.length === 1 && count === 1 ? stay.totalAdults : null)));
  const perRoomAges = roomPrefix !== null && Object.hasOwn(state, `${roomPrefix}childAges`);
  const childAges = roomPick('childAges', pick(`${rowPrefix}childAges`, row.childAges ??
    (stay.rows.length === 1 && stay.totalChildren === 0 ? [] : null)));
  if (!Array.isArray(childAges) || (!input.sourceRowExists && !perRoomAges && !Object.hasOwn(state, `${rowPrefix}childAges`)) ||
      (input.childAgeWarning && stay.totalChildren == null && childAges.length === 0 &&
        !perRoomAges && !Object.hasOwn(state, `${rowPrefix}childAges`)) ||
      (!perRoomAges && stay.rows.length === 1 && stay.totalChildren != null && stay.totalChildren !== childAges.length * (count as number))) {
    return { reason: 'CHILD_AGES_UNRESOLVED' };
  }
  const rawBoard = pick(`${rowPrefix}mealPlan`, row.mealPlan);
  const board = rawBoard === 'unknown' || rawBoard == null ? null : rawBoard;
  const quantity = input.workflow === 'create' ? 1 : count;
  const rateParties = selection.kind === 'none' ? {} : Object.fromEntries(
    (['bookingAgency', 'organization'] as const).flatMap(kind => selection[kind] ?
      [[kind, { nativeId: selection[kind]!.nativeId, name: selection[kind]!.name }]] : []));
  const explicitCode = selection.ratePlan ?? null;
  const parsed = availabilityJobRequestSchema.safeParse({ kind: 'availability', arrival, departure,
    rooms: [{ roomType: roomCode, quantity, adults, childAges }], rateParties,
    rateContext: { propertyCode: input.propertyCode, workflow: input.workflow, arrival, departure, roomCode, quantity,
      adults, childAges, mealPlan: board, currency: 'ZAR', // Existing HRCEN Quote currency; observations must match it.
      bookingAgencyId: selection.kind === 'selected' ? selection.bookingAgency?.nativeId ?? null : null,
      organizationId: selection.kind === 'selected' ? selection.organization?.nativeId ?? null : null,
      guestProfileId: null, sourceOfBusiness: roomPick('sourceOfBusiness', null),
      track: roomPick('track', null), guaranteeType: roomPick('guaranteeType', null),
      typedRatePlan: input.typedRatePlan ?? null, savedTarget: null, retainRates: null },
  });
  if (!parsed.success) return { reason: 'RATE_DRAFT_INCOMPLETE' };
  return { request: parsed.data, explicitCode, unchangedCode: null,
    draftContextKey: createHash('sha256').update(canonicalJson({ ...parsed.data.rateContext!, typedRatePlan: explicitCode })).digest('hex') };
}

/** Project only the current server draft and the exact saved-stay read. Explicit clears never fall back. */
export function boundAmendRateRequest(input: {
  propertyCode: string; requestId: string; stayId: string; rowId: string | null;
  fields: Record<string, unknown>; state: Record<string, unknown>;
  lookup: HmsCloudRateLookup; typedRatePlan?: string;
}): { request: AvailabilityRequest; selectedCode: string | null; explicitCode: string | null; unchangedCode: string; draftContextKey: string } |
  { reason: string } {
  const { lookup, fields, state } = input;
  if (!lookup?.native || !lookup.parties?.agency || !lookup.parties.organization || !lookup.group ||
      !lookup.promotion || !lookup.arAccount || !lookup.sourceOfBusiness || !lookup.track) return { reason: 'SAVED_CONTEXT_READ_REQUIRED' };
  const native = lookup.native;
  const target = fields.target as { confirmation?: unknown; arrival?: unknown } | null;
  if (!target || target.confirmation !== native.confirmation || target.arrival !== native.arrival ||
      native.propertyCode !== input.propertyCode || native.status !== 'Reserved') return { reason: 'SAVED_TARGET_CHANGED' };
  if (Object.values(lookup.parties).some(party => party.state === 'unknown') ||
      [lookup.group, lookup.promotion, lookup.arAccount].some(field => field.state !== 'blank')) {
    return { reason: 'SAVED_PARTY_CONTEXT_UNSUPPORTED' };
  }
  const requestPrefix = `requests[${input.requestId}].`;
  const resolved = (field: string, fallback: unknown, structural?: string) => {
    const path = structural ?? `${requestPrefix}${field}`;
    return Object.hasOwn(state, path) ? state[path] : fields[field] ?? fallback;
  };
  const arrival = resolved('arrival', native.arrival, `stays[${input.stayId}].requested.arrival`);
  const departure = resolved('departure', native.departure, `stays[${input.stayId}].requested.departure`);
  const rowPrefix = input.rowId ? `stays[${input.stayId}].rows[${input.rowId}].` : null;
  const adultPath = rowPrefix && Object.hasOwn(state, `${rowPrefix}adults`) ? `${rowPrefix}adults` :
    `stays[${input.stayId}].totalAdults`;
  const adults = resolved('adults', native.adults, adultPath);
  const childAges = Object.hasOwn(state, `${requestPrefix}childAges`) ? state[`${requestPrefix}childAges`] :
    rowPrefix && Object.hasOwn(state, `${rowPrefix}childAges`) ? state[`${rowPrefix}childAges`] :
    fields.childAges ?? (native.children === 0 ? [] : native.childAges === 'unknown' ? null : native.childAges);
  const requestedAges = Object.hasOwn(state, `${requestPrefix}childAges`) ||
    (rowPrefix && Object.hasOwn(state, `${rowPrefix}childAges`)) || fields.childAges != null;
  const children = resolved('children', requestedAges && Array.isArray(childAges) ? childAges.length : native.children,
    `stays[${input.stayId}].totalChildren`);
  if (!Array.isArray(childAges) || children !== childAges.length) {
    return { reason: 'CHILD_AGES_UNRESOLVED' };
  }
  const selectedCode = resolved('ratePlan', native.ratePlan);
  const roomCode = resolved('roomType', native.roomType);
  const retainRates = resolved('retainRates', 'no');
  const stableLookup = { ...lookup, observedAt: null };
  const rateParties = Object.fromEntries(Object.entries(lookup.parties).flatMap(([kind, party]) =>
    party.state === 'selected' ? [[kind === 'agency' ? 'bookingAgency' : kind, { nativeId: party.nativeId, name: party.name }]] : []));
  const parsed = availabilityJobRequestSchema.safeParse({ kind: 'availability', arrival, departure,
    rooms: [{ roomType: roomCode, quantity: 1, adults, childAges }], rateParties,
    rateContext: { propertyCode: input.propertyCode, workflow: 'amend', arrival, departure, roomCode,
      quantity: 1, adults, childAges, mealPlan: null, currency: lookup.currency,
      bookingAgencyId: lookup.parties.agency.nativeId, organizationId: lookup.parties.organization.nativeId,
      guestProfileId: native.guestId,
      sourceOfBusiness: lookup.sourceOfBusiness.state === 'observed' ? lookup.sourceOfBusiness.value : null,
      track: lookup.track.state === 'observed' ? lookup.track.value : null,
      guaranteeType: native.guaranteeCode ?? null, typedRatePlan: input.typedRatePlan ?? null,
      savedTarget: { confirmation: native.confirmation, bookedArrival: native.arrival,
        nativePreimageDigest: createHash('sha256').update(canonicalJson(stableLookup)).digest('hex') }, retainRates },
  });
  if (!parsed.success || !nativeCode.safeParse(selectedCode).success) return { reason: 'RATE_DRAFT_INCOMPLETE' };
  const context = parsed.data.rateContext!;
  return { request: parsed.data, selectedCode: selectedCode as string,
    explicitCode: Object.hasOwn(state, `${requestPrefix}ratePlan`) || fields.ratePlan != null ? selectedCode as string : null,
    unchangedCode: native.ratePlan,
    draftContextKey: createHash('sha256').update(canonicalJson({ ...context, typedRatePlan: selectedCode })).digest('hex') };
}

/** A real calendar day in YYYY-MM-DD form. 2026-02-30 and 2026-13-01 are not one. */
function isRealIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  // Date.parse gives NaN for a month past 12 (toISOString would throw on it), so the check stays inside the parse.
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function availabilityRequestForStay(stay: ExtractionStay | null | undefined): AvailabilityRequest | null {
  const arrival = stay?.requested?.arrival;
  const departure = stay?.requested?.departure;
  if (!arrival || !departure || !isRealIsoDay(arrival) || !isRealIsoDay(departure)) return null;
  const nights = (Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86_400_000;
  if (!(nights >= 1 && nights <= MAX_NIGHTS)) return null;
  if (!Array.isArray(stay?.rows) || stay.rows.length === 0) return null;
  // Every row must be complete. A group with no room count or no adults is not invented from a headcount.
  const rooms: unknown[] = [];
  const rows = stay.rows as ExtractionRow[];
  if (stay.totalRooms != null && ((rows.length > 1 && rows.some((row) => row.rooms === null)) ||
    rows.reduce((sum, row) => sum + (row.rooms ?? 0), 0) !== stay.totalRooms)) return null;
  if (stay.totalChildren != null) {
    let describedChildren = 0;
    for (const row of rows) {
      if (!row) return null;
      const quantity = row.rooms ?? (rows.length === 1 ? stay.totalRooms : null);
      if (row.childAges == null || quantity === null) return null;
      describedChildren += quantity * row.childAges.length;
    }
    if (describedChildren !== stay.totalChildren) return null;
  }
  if (stay.totalAdults != null) {
    let describedAdults = 0;
    for (const row of rows) {
      if (!row) return null;
      const quantity = row.rooms ?? (rows.length === 1 ? stay.totalRooms : null);
      if (row.adultsPerRoom === null || quantity === null) return null;
      describedAdults += quantity * row.adultsPerRoom;
    }
    if (describedAdults !== stay.totalAdults) return null;
  }
  for (const row of rows) {
    if (!row || !row.roomType || row.rooms === null || row.adultsPerRoom === null || row.childAges == null) return null;
    rooms.push({
      roomType: row.roomType,
      quantity: row.rooms,
      adults: row.adultsPerRoom,
      childAges: row.childAges,
    });
  }
  const parsed = availabilityRequestSchema.safeParse({ kind: 'availability', arrival, departure, rooms });
  return parsed.success ? parsed.data : null;
}

/**
 * One probe request per complete stay of a quote extraction (mail_extraction.payload). A stay with an incomplete row,
 * no dates, or a shape the quote tool would refuse yields no request.
 */
export function availabilityRequestsFor(payload: unknown): AvailabilityRequest[] {
  const missing = (payload as { missing?: unknown } | null | undefined)?.missing;
  const stays = (payload as { stays?: unknown } | null | undefined)?.stays;
  if (!Array.isArray(stays)) return [];
  const hasChildAgeWarning =
    Array.isArray(missing) &&
    missing.some((item) => {
      if (!item || typeof item !== 'object') return false;
      const value = item as { field?: unknown; question?: unknown };
      return /child/i.test(`${String(value.field ?? '')} ${String(value.question ?? '')}`);
    });
  if (
    stays.length === 1 &&
    Array.isArray(missing) &&
    missing.some((item) => {
      if (!item || typeof item !== 'object') return false;
      const field = String((item as { field?: unknown }).field ?? '');
      return /child/i.test(field) || (/adult|occupancy/i.test(field) && !/total/i.test(field));
    })
  ) {
    return [];
  }
  return stays.flatMap((stay: ExtractionStay | null) => {
    if (
      stays.length > 1 &&
      hasChildAgeWarning &&
      stay !== null &&
      stay.totalChildren == null &&
      Array.isArray(stay.rows) &&
      stay.rows.some((row) => Array.isArray(row.childAges) && row.childAges.length === 0)
    ) {
      return [];
    }
    const request = availabilityRequestForStay(stay);
    return request ? [request] : [];
  });
}

/** Return cap for an all-room probe. Matches quote-contract MAX_OPTIONS. */
export const AVAILABILITY_MAX_OPTIONS_PER_GROUP = 200;

/** The quote tool's v2 request for one probe. Groups carry no room or rate codes, so every room type is read. */
export function quoteRequestFor(request: AvailabilityRequest, target: HmsReadTarget): Record<string, unknown> {
  if (request.rateContext) throw new Error('CLOUD_RATE_CONTEXT_REQUIRED');
  const propertyCode = target.propertyCode.trim();
  if (!propertyCode) throw new Error('availability_probe_property_unknown');
  return {
    schemaVersion: 2,
    propertyCode,
    arrivalDate: request.arrival,
    departureDate: request.departure,
    details: 'summary',
    maxOptionsPerGroup: AVAILABILITY_MAX_OPTIONS_PER_GROUP,
    rooms: request.rooms.map((room, index) => ({
      id: `group-${index + 1}`,
      quantity: room.quantity,
      adults: room.adults,
      children: room.childAges.length,
      childAges: room.childAges,
    })),
  };
}

// The parts of the quote tool's result.json the snapshot reads. Everything else stays in the run folder.
type QuoteNight = {
  date?: unknown;
  inventory?: unknown;
  price?: unknown;
  restricted?: unknown;
  rateAvailable?: unknown;
  restrictions?: unknown;
} | null;
type QuoteOption = {
  room?: { code?: unknown; label?: unknown } | null;
  rate?: { code?: unknown; label?: unknown } | null;
  mealPlan?: unknown;
  availability?: unknown;
  availabilityReason?: unknown;
  eligibility?: unknown;
  nightly?: unknown;
  /** fetch-quote.mjs: public / contextual / unknown. Never inferred from the rate code here. */
  rateScope?: unknown;
} | null;
type QuoteGroup = {
  id?: unknown;
  outcome?: unknown;
  options?: QuoteOption[];
  request?: { quantity?: unknown; [key: string]: unknown } | null;
  requestedOccupancy?: { quantity?: unknown; [key: string]: unknown } | null;
  completeness?: unknown;
} | null;
export type QuoteEnvelope = {
  schemaVersion?: unknown;
  outcome?: unknown;
  observedAt?: unknown;
  searchCompleteness?: unknown;
  groups?: QuoteGroup[];
};

export type AvailabilityCompleteness = Record<string, string | number | boolean | null>;
export type AvailabilityStockStatus = 'available' | 'sold' | 'restricted' | 'unknown';
export type AvailabilityNightPrice = {
  status: 'known' | 'unknown';
  amount: string | null;
  currency: string | null;
  ratePlan: string | null;
  ratePlanLabel: string | null;
};
export type AvailabilityNightFact = {
  date: string;
  availableCount: number | null;
  requestedCount: number | null;
  stockStatus: AvailabilityStockStatus;
  restrictionReason?: string;
  price: AvailabilityNightPrice;
};

export type AvailabilitySnapshot = {
  /**
   * What the read covered. Room types are not mapped to HMS codes yet, so each group's search is for every room type
   * at that occupancy; the stated room type in the request is a label only. Show it as all-room availability.
   */
  roomScope: 'all_room_types';
  /** The quote tool's outcome for the search: quote, partial, no_match, unavailable, input_gap or execution_failure. */
  searchOutcome: string;
  /** The reader's observed-at/read-at timestamp; use it as this snapshot's freshness marker. */
  observedAt: string | null;
  availableOptions: number;
  /** Quote-tool search coverage flags, when the reader returned them. */
  searchCompleteness?: AvailabilityCompleteness;
  groups: Array<{
    id: string | null;
    outcome: string | null;
    requestedCount?: number;
    completeness?: AvailabilityCompleteness;
    options: Array<{
      room: string | null;
      rate: string | null;
      mealPlan?: string;
      availability: string;
      roomLabel?: string;
      rateLabel?: string;
      eligibility?: string;
      nightly?: AvailabilityNightFact[];
      rateScope?: 'public' | 'contextual' | 'unknown';
    }>;
  }>;
  /** True when the reader cut matching rows at maxOptionsPerGroup. */
  truncated?: boolean;
};

export type AvailabilityProbeResult =
  | ({ outcome: 'read' } & AvailabilitySnapshot)
  | {
      outcome: 'execution_failure' | 'refused_lock_busy' | 'refused_lock_unavailable' | 'refused_input_invalid';
      error?: string;
    };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function completeness(value: unknown): AvailabilityCompleteness | undefined {
  const source = record(value);
  if (!source) return undefined;
  const flags: AvailabilityCompleteness = {};
  for (const [key, flag] of Object.entries(source)) {
    if (
      flag === null ||
      typeof flag === 'string' ||
      typeof flag === 'boolean' ||
      (typeof flag === 'number' && Number.isFinite(flag))
    ) {
      flags[key] = flag;
    }
  }
  return Object.keys(flags).length > 0 ? flags : undefined;
}

function truncatedOf(flags: AvailabilityCompleteness | undefined): boolean {
  return flags?.search === 'truncated' || flags?.matchingRowsUnseen === true || flags?.optionsTruncated === true;
}

/** Pass through the reader's rateScope. A missing or unknown value stays unknown; BAR codes are not invented here. */
function rateScopeOf(option: QuoteOption): 'public' | 'contextual' | 'unknown' | undefined {
  const scope = text(option?.rateScope);
  if (scope === 'public' || scope === 'contextual' || scope === 'unknown') return scope;
  return undefined;
}

function positiveCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function inventoryCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requestedNightDates(request?: AvailabilityRequest): string[] {
  if (!request || !isRealIsoDay(request.arrival) || !isRealIsoDay(request.departure)) return [];
  const start = Date.parse(`${request.arrival}T00:00:00Z`);
  const end = Date.parse(`${request.departure}T00:00:00Z`);
  const nights = (end - start) / 86_400_000;
  if (!(nights >= 1 && nights <= MAX_NIGHTS)) return [];
  return Array.from({ length: nights }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}

function stockStatusOf(
  night: QuoteNight,
  date: string,
  request: AvailabilityRequest | undefined,
  availableCount: number | null,
  optionAvailability: string,
): AvailabilityStockStatus {
  if (availableCount === 0) return 'sold';
  const restrictions = record(night?.restrictions);
  if (
    night?.restricted === true ||
    night?.rateAvailable === false ||
    restrictions?.combClosed === true ||
    (date === request?.arrival && restrictions?.combClosedToArrival === true) ||
    (date === request?.departure && restrictions?.combClosedToDeparture === true)
  ) {
    return 'restricted';
  }
  if (
    availableCount !== null &&
    night?.restricted === false &&
    night?.rateAvailable === true
  ) {
    return 'available';
  }
  if (availableCount === null || optionAvailability === 'unknown') return 'unknown';
  if (optionAvailability === 'available') return 'available';
  return 'unknown';
}

function nightFactOf(
  night: QuoteNight,
  date: string,
  requestedCount: number | null,
  ratePlan: string | null,
  ratePlanLabel: string | null,
  optionAvailability: string,
  request: AvailabilityRequest | undefined,
  availabilityReason: string | null,
): AvailabilityNightFact {
  const sourcePrice = record(night?.price);
  const amount = text(sourcePrice?.amount);
  const currency = text(sourcePrice?.currency);
  const priceKnown = amount !== null && currency !== null;
  const availableCount = inventoryCount(night?.inventory);
  const stockStatus = stockStatusOf(night, date, request, availableCount, optionAvailability);
  const restrictions = record(night?.restrictions);
  const nightReason = night?.restricted === true
    ? 'HMS marks this night restricted.'
    : night?.rateAvailable === false
      ? 'Rate is unavailable on this night.'
      : restrictions?.combClosed === true
        ? 'HMS closes this night.'
        : date === request?.arrival && restrictions?.combClosedToArrival === true
          ? 'HMS closes the arrival date to arrivals.'
          : date === request?.departure && restrictions?.combClosedToDeparture === true
            ? 'HMS closes the departure date to departures.'
            : null;
  const restrictionReason =
    stockStatus === 'restricted'
      ? availabilityReason ?? nightReason ?? 'HMS marks this stay restricted.'
      : null;
  return {
    date,
    availableCount,
    requestedCount,
    stockStatus,
    ...(restrictionReason ? { restrictionReason } : {}),
    price: {
      status: priceKnown ? 'known' : 'unknown',
      amount,
      currency,
      ratePlan,
      ratePlanLabel,
    },
  };
}

function nightlyFactsOf(
  option: QuoteOption,
  dates: string[],
  requestedCount: number | null,
  ratePlan: string | null,
  ratePlanLabel: string | null,
  optionAvailability: string,
  request: AvailabilityRequest | undefined,
  availabilityReason: string | null,
): AvailabilityNightFact[] | undefined {
  const sourceNights = Array.isArray(option?.nightly) ? (option.nightly as QuoteNight[]) : undefined;
  if (dates.length > 0) {
    const byDate = new Map<string, QuoteNight>();
    const ambiguousDates = new Set<string>();
    for (const night of sourceNights ?? []) {
      const date = text(night?.date);
      if (!date) continue;
      if (byDate.has(date)) {
        ambiguousDates.add(date);
        byDate.delete(date);
      } else if (!ambiguousDates.has(date)) {
        byDate.set(date, night);
      }
    }
    return dates.map((date) =>
      nightFactOf(
        ambiguousDates.has(date) ? null : (byDate.get(date) ?? null),
        date,
        requestedCount,
        ratePlan,
        ratePlanLabel,
        optionAvailability,
        request,
        availabilityReason,
      ),
    );
  }
  if (!sourceNights) return undefined;
  return sourceNights.flatMap((night) => {
    const date = text(night?.date);
    return date
      ? [
          nightFactOf(
            night,
            date,
            requestedCount,
            ratePlan,
            ratePlanLabel,
            optionAvailability,
            request,
            availabilityReason,
          ),
        ]
      : [];
  });
}

/** The snapshot the job stores: outcome per group and the options with their nightly facts. No evidence or screenshots. */
export function availabilitySnapshotOf(result: QuoteEnvelope, request?: AvailabilityRequest): AvailabilitySnapshot {
  const requestedDates = requestedNightDates(request);
  const groups = (Array.isArray(result.groups) ? result.groups : []).map((group, groupIndex) => {
    const options = Array.isArray(group?.options) ? group.options : [];
    const requestRoomCount = positiveCount(request?.rooms[groupIndex]?.quantity);
    const requestedCount =
      requestRoomCount ?? positiveCount(group?.request?.quantity) ?? positiveCount(group?.requestedOccupancy?.quantity);
    const groupCompleteness = completeness(group?.completeness);
    return {
      id: text(group?.id),
      outcome: text(group?.outcome),
      ...(requestedCount === null ? {} : { requestedCount }),
      ...(groupCompleteness ? { completeness: groupCompleteness } : {}),
      options: options.map((option) => {
        const rate = text(option?.rate?.code);
        const rateLabel = text(option?.rate?.label);
        const availability = text(option?.availability) ?? 'unknown';
        const availabilityReason =
          text(option?.availabilityReason) ??
          (availability === 'restricted' ? 'HMS restricts the requested full stay.' : null);
        const nightly = nightlyFactsOf(
          option,
          requestedDates,
          requestedCount,
          rate,
          rateLabel,
          availability,
          request,
          availabilityReason,
        );
        const roomLabel = text(option?.room?.label);
        const eligibility = text(option?.eligibility);
        const board = text(option?.mealPlan);
        const rateScope = rateScopeOf(option);
        const hasNightlyFacts = nightly !== undefined;
        return {
          room: text(option?.room?.code),
          rate,
          availability,
          ...(board ? { mealPlan: board } : {}),
          ...(availabilityReason ? { availabilityReason } : {}),
          ...(hasNightlyFacts && roomLabel ? { roomLabel } : {}),
          ...(hasNightlyFacts && rateLabel ? { rateLabel } : {}),
          ...(eligibility ? { eligibility } : {}),
          ...(hasNightlyFacts ? { nightly } : {}),
          ...(rateScope ? { rateScope } : {}),
        };
      }),
    };
  });
  const availableOptions = groups.reduce(
    (count, group) => count + group.options.filter((option) => option.availability === 'available').length,
    0,
  );
  const searchCompleteness = completeness(result.searchCompleteness);
  const truncated =
    truncatedOf(searchCompleteness) || groups.some((group) => truncatedOf(group.completeness));
  return {
    roomScope: 'all_room_types',
    searchOutcome: text(result.outcome) ?? 'execution_failure',
    observedAt: text(result.observedAt),
    availableOptions,
    ...(searchCompleteness ? { searchCompleteness } : {}),
    groups,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** One raw HMS row for the read-only BAR grid. Not collapsed per rate like `buildRateOptions`. */
export type AvailabilityBoardRow = {
  groupId: string;
  roomCode: string;
  roomLabel: string;
  rateCode: string;
  rateLabel: string;
  mealPlan: string;
  mealPlanLabel: string;
  nightlyPriceMinor: number | null;
  roomsLeft: number | null;
  availability?: string;
  eligibility?: string;
  nightly?: AvailabilityNightFact[];
  coverage?: AvailabilityCompleteness;
  currency?: string | null;
  nightCoverage?: { expected: number; observed: number; complete: boolean };
  /** Reader fact only. Contract tags must not be invented from a public code. */
  rateScope?: 'public' | 'contextual' | 'unknown';
};

function amountMinor(amount: string | null): number | null {
  if (!amount || !/^\d+\.\d{2}$/.test(amount)) return null;
  const [rand, cents] = amount.split('.');
  const value = Number(rand) * 100 + Number(cents);
  return Number.isSafeInteger(value) ? value : null;
}

/** Room × rate × board rows from a quote envelope, including unpriced nights as null. */
export function availabilityBoardOf(result: QuoteEnvelope, stay?: { arrivalDate: string; departureDate: string }): {
  rows: AvailabilityBoardRow[];
  truncated: boolean;
} {
  const snapshot = availabilitySnapshotOf(result);
  const expectedDates = stay ? occupiedDates(stay.arrivalDate, stay.departureDate) : null;
  const rows: AvailabilityBoardRow[] = [];
  for (const group of snapshot.groups) {
    const groupId = group.id ?? '';
    for (const option of group.options) {
      const roomCode = option.room;
      const rateCode = option.rate;
      if (!roomCode || !rateCode) continue;
      const nights = option.nightly ?? [];
      const priced = nights
        .map((night) => amountMinor(night.price.amount))
        .filter((value): value is number => value !== null && value > 0);
      const stocks = nights
        .map((night) => night.availableCount)
        .filter((value): value is number => value !== null);
      const observedDates = new Set(nights.map(night => night.date));
      const covered = expectedDates === null || nights.length === expectedDates.length && observedDates.size === expectedDates.length && expectedDates.every(date => observedDates.has(date));
      const currencies = new Set(nights.map(night => night.price.currency).filter((value): value is string => value !== null));
      const boardLabel = option.mealPlan ?? '';
      rows.push({
        groupId,
        roomCode,
        roomLabel: option.roomLabel ?? roomCode,
        rateCode,
        rateLabel: option.rateLabel ?? rateCode,
        mealPlan: boardLabel || rateCode,
        mealPlanLabel: boardLabel,
        nightlyPriceMinor: covered && priced.length > 0 && priced.length === nights.length && currencies.size === 1
          ? Math.round(priced.reduce((sum, value) => sum + value, 0) / priced.length)
          : null,
        roomsLeft: covered && stocks.length > 0 && stocks.length === nights.length ? Math.min(...stocks) : null,
        availability: option.availability,
        ...(option.eligibility ? { eligibility: option.eligibility } : {}),
        ...(option.nightly ? { nightly: option.nightly } : {}),
        ...(group.completeness ? { coverage: group.completeness } : {}),
        ...(expectedDates ? { nightCoverage: { expected: expectedDates.length, observed: observedDates.size, complete: covered } } : {}),
        currency: currencies.size === 1 ? [...currencies][0]! : null,
        ...(option.rateScope ? { rateScope: option.rateScope } : {}),
      });
    }
  }
  return { rows, truncated: snapshot.truncated === true };
}

/**
 * Test seam: when set, replaces the spawn of the quote tool. Production runs fetch-quote.mjs. The seam returns the same
 * result.json the tool writes.
 */
export const availabilityProbeLoaders: {
  spawn: ((quote: Record<string, unknown>) => Promise<QuoteEnvelope>) | null;
} = { spawn: null };

// Runs fetch-quote.mjs on one request file and reads its run folder. The folder is removed after the snapshot is read
// (a run folder is ~24 MB with its trace, and the snapshot is what the job keeps).
async function defaultQuoteSpawn(
  quote: Record<string, unknown>,
  target: HmsReadTarget,
): Promise<QuoteEnvelope> {
  const runId = randomUUID();
  const requestDir = join(QUOTE_ROOT, 'availability-requests');
  const outputDir = join(QUOTE_ROOT, 'availability-runs');
  await mkdir(requestDir, { recursive: true, mode: 0o700 });
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const requestPath = join(requestDir, `${runId}.json`);
  await writeFile(requestPath, JSON.stringify(quote), { mode: 0o600 });
  let stdout = '';
  try {
    // The tool exits non-zero on refusals and failures but still prints its Evidence line when it wrote a result.
    const run = await execFileAsync(process.execPath, [QUOTE_TOOL, '--request', requestPath, '--output', outputDir], {
      timeout: PROBE_TIMEOUT_MS,
      env: paneStaySpawnEnv(process.env, undefined, target),
    }).catch((error: unknown) => error as { stdout?: string });
    stdout = typeof run.stdout === 'string' ? run.stdout : '';
  } finally {
    await rm(requestPath, { force: true }).catch(() => undefined);
  }
  const evidence = /^Evidence: (.+)$/m.exec(stdout)?.[1];
  if (!evidence) throw new Error('availability_probe_no_result');
  try {
    const { audit: _audit, ...result } = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8')) as QuoteEnvelope & {
      audit?: unknown;
    };
    return result;
  } finally {
    // ponytail: the run folder is removed here. Quote run folders otherwise pile up on the EC2 disk (plan: Data Handling).
    await rm(evidence, { recursive: true, force: true }).catch(() => undefined);
  }
}

export type AvailabilityProbeDeps = {
  /** The session hotel's property lock. Null means no lock can be made, so the probe is refused. */
  lock: () => PaneStayLock | null;
  acquisition: PropertyReadLockAcquisitionOptions;
  target: HmsReadTarget;
};

/**
 * One read for one stay under the property lock. The outcome uses the same vocabulary as the pane lookups, so the job
 * executor settles it the same way: busy and failed reads retry, refusals dead-letter, and a read is a dated snapshot.
 */
export async function probeAvailability(
  request: AvailabilityRequest,
  deps: AvailabilityProbeDeps,
): Promise<AvailabilityProbeResult> {
  if (request.rateContext) return { outcome: 'refused_input_invalid' };
  const lock = deps.lock();
  if (!lock) return { outcome: 'refused_lock_unavailable' };
  const spawn = availabilityProbeLoaders.spawn ?? ((quote) => defaultQuoteSpawn(quote, deps.target));
  let result: QuoteEnvelope;
  try {
    result = await lock.withLock(() => spawn(quoteRequestFor(request, deps.target)), deps.acquisition);
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return { outcome: 'refused_lock_busy' };
    warnPaneStaySpawnFailed('availability', error);
    const loginCode = classifyHmsLoginOutage(error) ? 'AUTHENTICATED_SHELL_TIMEOUT' : undefined;
    return { outcome: 'execution_failure', ...(loginCode ? { error: loginCode } : {}) };
  }
  const searchOutcome = text(result.outcome);
  if (searchOutcome === 'input_gap') return { outcome: 'refused_input_invalid' };
  if (!searchOutcome || searchOutcome === 'execution_failure') {
    const loginCode = classifyHmsLoginOutage(result) ? 'AUTHENTICATED_SHELL_TIMEOUT' : undefined;
    return { outcome: 'execution_failure', ...(loginCode ? { error: loginCode } : {}) };
  }
  return { outcome: 'read', ...availabilitySnapshotOf(result, request) };
}
