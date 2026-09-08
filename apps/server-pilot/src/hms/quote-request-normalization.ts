import {
  QUOTE_STAY_MAX_GUESTS,
  QUOTE_STAY_MAX_NIGHTS,
  QUOTE_STAY_MAX_ROOMS,
} from './quote-stay-candidate.js';
import { normalizedQuoteRoomSchema, type NormalizedQuoteRoom } from './quote-stay-contract.js';
import { parseQuoteStayCandidateFromAuthoredSegment } from './quote-stay-candidate.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected ISO date YYYY-MM-DD');
const refSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'expected opaque reference');
const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'expected ISO currency');

const quoteRoomInputSchema = z
  .object({
    quantity: z.number().int().positive().max(QUOTE_STAY_MAX_ROOMS),
    adultsPerRoom: z.number().int().positive().max(QUOTE_STAY_MAX_GUESTS),
    children: z.number().int().min(0).max(QUOTE_STAY_MAX_GUESTS).optional(),
    childAges: z.array(z.number().int().min(0).max(17)).max(16),
    roomTypeRef: z.string().min(1).nullable().optional(),
    ratePlanRef: z.string().min(1).nullable().optional(),
  })
  .strict();

const quoteSegmentSchema = z
  .object({
    arrival: isoDateSchema,
    departure: isoDateSchema,
    rooms: z.array(normalizedQuoteRoomSchema).min(1).max(QUOTE_STAY_MAX_ROOMS),
    currency: currencySchema,
  })
  .strict();

export const quoteRequestSchema = z
  .object({
    quoteRequestRef: refSchema,
    arrival: isoDateSchema,
    departure: isoDateSchema,
    rooms: z.array(normalizedQuoteRoomSchema).min(1).max(QUOTE_STAY_MAX_ROOMS),
    currency: currencySchema,
    organizationRef: refSchema.nullable(),
    agencyRef: refSchema.nullable(),
    groupRef: refSchema.nullable(),
    segments: z.array(quoteSegmentSchema).min(1).max(QUOTE_STAY_MAX_NIGHTS),
    coveredNights: z.array(isoDateSchema).max(QUOTE_STAY_MAX_NIGHTS),
    missingNights: z.array(isoDateSchema).max(QUOTE_STAY_MAX_NIGHTS),
    continuousStay: z.boolean(),
    roomMoveRequired: z.boolean(),
    referenceAuthoritySha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export type QuoteRequestNormalization =
  | { status: 'ready'; request: QuoteRequest }
  | { status: 'clarification'; request: null; unresolvedInputs: string[] };

/** Server-owned current quote reference/eligibility snapshot. */
export type QuoteReferenceAuthority = {
  propertyCode: string;
  roomTypeRefs: readonly string[];
  ratePlanRefs: readonly string[];
  currencyCodes: readonly string[];
  organizationRefs?: readonly string[];
  agencyRefs?: readonly string[];
  groupRefs?: readonly string[];
};

/** The only reviewed local quote catalog; live activation must replace this with current data. */
export const DEFAULT_QUOTE_REFERENCE_AUTHORITY: QuoteReferenceAuthority = {
  propertyCode: 'HRCEN',
  roomTypeRefs: ['STD'],
  ratePlanRefs: ['BAR'],
  currencyCodes: ['ZAR'],
  organizationRefs: [],
  agencyRefs: [],
  groupRefs: [],
};

export type QuoteRequestNormalizationOptions = {
  referenceAuthority?: QuoteReferenceAuthority;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function calendarDate(value: unknown): number | null {
  if (typeof value !== 'string' || !isoDateSchema.safeParse(value).success) {
    return null;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

function nightDates(arrival: string, departure: string): string[] {
  const start = calendarDate(arrival);
  const end = calendarDate(departure);
  if (start === null || end === null || end <= start) return [];
  const dates: string[] = [];
  for (let cursor = start; cursor < end; cursor += 86_400_000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

function sameRoomShape(
  left: readonly NormalizedQuoteRoom[],
  right: readonly NormalizedQuoteRoom[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function authorityDigest(authority: QuoteReferenceAuthority): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        propertyCode: authority.propertyCode,
        roomTypeRefs: [...authority.roomTypeRefs].sort(),
        ratePlanRefs: [...authority.ratePlanRefs].sort(),
        currencyCodes: [...authority.currencyCodes].sort(),
        organizationRefs: [...(authority.organizationRefs ?? [])].sort(),
        agencyRefs: [...(authority.agencyRefs ?? [])].sort(),
        groupRefs: [...(authority.groupRefs ?? [])].sort(),
      }),
    )
    .digest('hex');
}

function checkConfiguredRef(
  value: string | null,
  configured: readonly string[] | undefined,
  unresolved: string[],
  code: string,
): void {
  if (value === null) return;
  if (!configured?.includes(value)) unresolved.push(code);
}

function normalizeRooms(
  value: unknown,
  prefix: string,
  unresolved: string[],
  authority: QuoteReferenceAuthority,
): NormalizedQuoteRoom[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > QUOTE_STAY_MAX_ROOMS) {
    unresolved.push(`${prefix}.rooms`);
    return null;
  }
  const rooms: NormalizedQuoteRoom[] = [];
  for (const [index, raw] of value.entries()) {
    const parsed = quoteRoomInputSchema.safeParse(raw);
    if (!parsed.success) {
      unresolved.push(`${prefix}.rooms:${index}`);
      continue;
    }
    const room = parsed.data;
    if (room.children !== undefined && room.children !== room.childAges.length) {
      for (let child = room.childAges.length; child < room.children; child += 1) {
        unresolved.push(`child_age:${index}:${child}`);
      }
      continue;
    }
    rooms.push({
      quantity: room.quantity,
      adultsPerRoom: room.adultsPerRoom,
      childAges: [...room.childAges],
      roomTypeRef: room.roomTypeRef ?? null,
      ratePlanRef: room.ratePlanRef ?? null,
    });
    checkConfiguredRef(
      room.roomTypeRef ?? null,
      authority.roomTypeRefs,
      unresolved,
      'room_reference_configuration',
    );
    checkConfiguredRef(
      room.ratePlanRef ?? null,
      authority.ratePlanRefs,
      unresolved,
      'rate_reference_configuration',
    );
  }
  if (rooms.length !== value.length) return null;
  const guestCount = rooms.reduce(
    (sum, room) => sum + room.quantity * (room.adultsPerRoom + room.childAges.length),
    0,
  );
  const roomCount = rooms.reduce((sum, room) => sum + room.quantity, 0);
  if (roomCount > QUOTE_STAY_MAX_ROOMS) unresolved.push(`${prefix}.room_cap`);
  if (guestCount > QUOTE_STAY_MAX_GUESTS) unresolved.push(`${prefix}.guest_cap`);
  if (rooms.reduce((sum, room) => sum + room.quantity * room.adultsPerRoom, 0) < roomCount) {
    unresolved.push(`${prefix}.adult_per_room`);
  }
  return rooms;
}

function normalizeCurrency(value: unknown, unresolved: string[], prefix: string): string | null {
  if (typeof value !== 'string' || !currencySchema.safeParse(value).success) {
    unresolved.push(prefix);
    return null;
  }
  return value as string;
}

function normalizedRef(value: unknown, unresolved: string[], prefix: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!refSchema.safeParse(value).success) {
    unresolved.push(prefix);
    return null;
  }
  return value as string;
}

function canonicalRefPayload(request: Omit<QuoteRequest, 'quoteRequestRef'>): string {
  return JSON.stringify(request);
}

function mintQuoteRequestRef(request: Omit<QuoteRequest, 'quoteRequestRef'>): string {
  return `quote_stay_request:${createHash('sha256').update(canonicalRefPayload(request)).digest('hex')}`;
}

function normalizeSegment(
  value: unknown,
  index: number,
  fallbackCurrency: string,
  unresolved: string[],
  authority: QuoteReferenceAuthority,
): z.infer<typeof quoteSegmentSchema> | null {
  if (!isRecord(value)) {
    unresolved.push(`segments:${index}`);
    return null;
  }
  const arrival = value.arrival;
  const departure = value.departure;
  const start = calendarDate(arrival);
  const end = calendarDate(departure);
  if (start === null) unresolved.push(`segments:${index}.arrival`);
  if (end === null) unresolved.push(`segments:${index}.departure`);
  const rooms = normalizeRooms(value.rooms, `segments:${index}`, unresolved, authority);
  const currency = normalizeCurrency(
    value.currency ?? fallbackCurrency,
    unresolved,
    `segments:${index}.currency`,
  );
  const dates =
    typeof arrival === 'string' && typeof departure === 'string'
      ? nightDates(arrival, departure)
      : [];
  if (dates.length < 1 || dates.length > QUOTE_STAY_MAX_NIGHTS) {
    unresolved.push(`segments:${index}.stay_length`);
  }
  if (!rooms || !currency || start === null || end === null || dates.length < 1) return null;
  return { arrival: arrival as string, departure: departure as string, rooms, currency };
}

/**
 * Normalize only an explicit, producer-owned request shape.  This function
 * does not infer locale dates, occupancy, currency, room/rate references, or
 * authorization scope from prose.
 */
export function normalizeQuoteRequest(
  input: unknown,
  options: QuoteRequestNormalizationOptions = {},
): QuoteRequestNormalization {
  const unresolved: string[] = [];
  const authority = options.referenceAuthority ?? DEFAULT_QUOTE_REFERENCE_AUTHORITY;
  if (!isRecord(input)) {
    return { status: 'clarification', request: null, unresolvedInputs: ['request'] };
  }

  const arrival = input.arrival ?? input.arrivalDate;
  const departure = input.departure ?? input.departureDate;
  if (
    input.arrival !== undefined &&
    input.arrivalDate !== undefined &&
    input.arrival !== input.arrivalDate
  ) {
    unresolved.push('arrival_ambiguous');
  }
  if (
    input.departure !== undefined &&
    input.departureDate !== undefined &&
    input.departure !== input.departureDate
  ) {
    unresolved.push('departure_ambiguous');
  }
  const start = calendarDate(arrival);
  const end = calendarDate(departure);
  if (start === null) unresolved.push('arrival');
  if (end === null) unresolved.push('departure');
  const dates =
    typeof arrival === 'string' && typeof departure === 'string'
      ? nightDates(arrival, departure)
      : [];
  if (dates.length < 1 || dates.length > QUOTE_STAY_MAX_NIGHTS) {
    unresolved.push('stay_length');
  }

  if (input.propertyCode !== undefined && input.propertyCode !== authority.propertyCode) {
    unresolved.push('property_scope_mismatch');
  }
  const currency = normalizeCurrency(input.currency, unresolved, 'currency');
  if (currency && !authority.currencyCodes.includes(currency)) {
    unresolved.push('currency_configuration');
  }
  const rooms = normalizeRooms(input.rooms, 'request', unresolved, authority);
  const segmentsRaw = input.segments;
  const segments: z.infer<typeof quoteSegmentSchema>[] = [];
  if (segmentsRaw === undefined) {
    if (rooms && currency && typeof arrival === 'string' && typeof departure === 'string') {
      segments.push({ arrival, departure, rooms, currency });
    }
  } else if (!Array.isArray(segmentsRaw) || segmentsRaw.length < 1) {
    unresolved.push('segments');
  } else {
    for (const [index, segment] of segmentsRaw.entries()) {
      const normalized = normalizeSegment(segment, index, currency ?? '', unresolved, authority);
      if (normalized) segments.push(normalized);
    }
  }

  if (start !== null && end !== null && segments.length > 0) {
    const covered = new Set<string>();
    for (const segment of segments) {
      for (const date of nightDates(segment.arrival, segment.departure)) covered.add(date);
    }
    for (const date of dates) {
      if (!covered.has(date)) unresolved.push(`missing_night:${date}`);
    }
  }
  if (segments.length > 1) {
    for (let index = 1; index < segments.length; index += 1) {
      if (segments[index - 1]!.departure !== segments[index]!.arrival) {
        unresolved.push(`segment_gap:${index - 1}`);
      }
    }
  }

  if (currency) {
    for (const [index, segment] of segments.entries()) {
      if (segment.currency !== currency) unresolved.push(`segment_currency_mismatch`);
      const segmentDates = nightDates(segment.arrival, segment.departure);
      if (segmentDates.some((date) => !dates.includes(date))) {
        unresolved.push('segment_date_mismatch');
      }
      if (index === 0 && segment.arrival !== arrival) unresolved.push('segment_date_mismatch');
      if (index === segments.length - 1 && segment.departure !== departure) {
        unresolved.push('segment_date_mismatch');
      }
    }
  }

  checkConfiguredRef(
    normalizedRef(input.organizationRef, unresolved, 'organizationRef'),
    authority.organizationRefs,
    unresolved,
    'organization_reference_configuration',
  );
  checkConfiguredRef(
    normalizedRef(input.agencyRef, unresolved, 'agencyRef'),
    authority.agencyRefs,
    unresolved,
    'agency_reference_configuration',
  );
  checkConfiguredRef(
    normalizedRef(input.groupRef, unresolved, 'groupRef'),
    authority.groupRefs,
    unresolved,
    'group_reference_configuration',
  );

  const organizationRef = normalizedRef(input.organizationRef, unresolved, 'organizationRef');
  const agencyRef = normalizedRef(input.agencyRef, unresolved, 'agencyRef');
  const groupRef = normalizedRef(input.groupRef, unresolved, 'groupRef');
  if (
    unresolved.length > 0 ||
    !rooms ||
    !currency ||
    start === null ||
    end === null ||
    segments.length === 0
  ) {
    return {
      status: 'clarification',
      request: null,
      unresolvedInputs: [...new Set(unresolved)],
    };
  }

  const canonical: Omit<QuoteRequest, 'quoteRequestRef'> = {
    arrival: arrival as string,
    departure: departure as string,
    rooms,
    currency,
    organizationRef,
    agencyRef,
    groupRef,
    segments,
    coveredNights: dates,
    missingNights: [],
    continuousStay: segments.length === 1,
    roomMoveRequired: segments.some(
      (segment, index) => index > 0 && !sameRoomShape(segment.rooms, segments[index - 1]!.rooms),
    ),
    referenceAuthoritySha256: authorityDigest(authority),
  };
  const request = quoteRequestSchema.parse({
    ...canonical,
    quoteRequestRef: mintQuoteRequestRef(canonical),
  });
  return { status: 'ready', request };
}

/**
 * Producer adapter for one already-selected authored segment.  It recognizes
 * only the existing explicit ISO/date/occupancy/room/rate vocabulary and
 * requires one explicit currency token; prose is never locale-parsed.
 */
export function normalizeQuoteRequestFromAuthoredSegment(
  authoredSegment: string,
  options: QuoteRequestNormalizationOptions = {},
): QuoteRequestNormalization {
  const candidate = parseQuoteStayCandidateFromAuthoredSegment(authoredSegment);
  if (!candidate) {
    return { status: 'clarification', request: null, unresolvedInputs: ['quote_input'] };
  }
  const currencies = [...authoredSegment.matchAll(/\bcurrency\s*[:=-]?\s*([A-Z]{3})\b/gi)];
  if (currencies.length !== 1 || !currencies[0]?.[1]) {
    return {
      status: 'clarification',
      request: null,
      unresolvedInputs: [currencies.length === 0 ? 'currency' : 'currency_ambiguous'],
    };
  }
  const ageMatches = [
    ...authoredSegment.matchAll(
      /\bchild(?:ren)?\s+ages?\s*[:=-]?\s*([0-9]{1,2}(?:\s*(?:,|and)\s*[0-9]{1,2})*)\b/gi,
    ),
  ];
  const childAges =
    ageMatches.length === 1 ? (ageMatches[0]![1]!.match(/\d{1,2}/g) ?? []).map(Number) : [];
  if (candidate.children > 0 && childAges.length !== candidate.children) {
    return {
      status: 'clarification',
      request: null,
      unresolvedInputs: Array.from(
        { length: candidate.children - childAges.length },
        (_, index) => `child_age:0:${childAges.length + index}`,
      ),
    };
  }
  if (candidate.adults % candidate.rooms !== 0) {
    return {
      status: 'clarification',
      request: null,
      unresolvedInputs: ['adult_distribution'],
    };
  }
  if (candidate.children > 0 && candidate.rooms > 1) {
    return {
      status: 'clarification',
      request: null,
      unresolvedInputs: ['child_distribution'],
    };
  }
  return normalizeQuoteRequest(
    {
      arrival: candidate.arrivalDate,
      departure: candidate.departureDate,
      rooms: [
        {
          quantity: candidate.rooms,
          adultsPerRoom: Math.floor(candidate.adults / candidate.rooms),
          children: candidate.children,
          childAges,
          roomTypeRef: candidate.roomType,
          ratePlanRef: candidate.ratePlan,
        },
      ],
      currency: currencies[0]![1]!.toUpperCase(),
    },
    options,
  );
}
