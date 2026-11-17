/**
 * Quote stay candidate: one authored segment with dates, occupancy, room type, rate plan.
 * Live OSRRAV requires roomtypes+rateplans filters (unscoped search → result-limit error).
 */
import type { QuoteRequest } from './quote-request-normalization.js';
import { normalizedQuoteRoomSchema } from './quote-stay-contract.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const QUOTE_STAY_MAX_NIGHTS = 30;
export const QUOTE_STAY_MAX_GROUPS = 8;
/** Legacy direct-search adapter bound; native v2 groups support independent quantities. */
export const QUOTE_STAY_MAX_ROOMS = 4;
export const QUOTE_STAY_MAX_GUESTS = 16;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const codeToken = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/, 'expected room/rate code');

export const quoteStayCandidateSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    kind: z.literal('quote_stay'),
    arrivalDate: isoDate,
    departureDate: isoDate,
    adults: z.number().int().min(1).max(QUOTE_STAY_MAX_GUESTS),
    children: z.number().int().min(0).max(QUOTE_STAY_MAX_GUESTS),
    rooms: z.number().int().min(1).max(QUOTE_STAY_MAX_ROOMS),
    roomType: codeToken,
    ratePlan: codeToken,
    childAges: z.array(z.number().int().min(0).max(17)).max(16).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    quoteRequestRef: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)
      .optional(),
    normalizedRooms: z.array(normalizedQuoteRoomSchema).max(QUOTE_STAY_MAX_GROUPS).optional(),
  })
  .strict()
  .superRefine((candidate, context) => {
    const start = parseCalendarDate(candidate.arrivalDate);
    const end = parseCalendarDate(candidate.departureDate);
    if (start === null || end === null) {
      context.addIssue({ code: 'custom', message: 'invalid calendar date' });
      return;
    }
    const nights = (end - start) / 86_400_000;
    if (nights < 1 || nights > QUOTE_STAY_MAX_NIGHTS) {
      context.addIssue({ code: 'custom', message: 'stay length out of bounds' });
    }
    if (candidate.adults + candidate.children > QUOTE_STAY_MAX_GUESTS) {
      context.addIssue({ code: 'custom', message: 'guest count out of bounds' });
    }
    if (candidate.adults < candidate.rooms) {
      context.addIssue({ code: 'custom', message: 'each room requires one adult' });
    }
  });

export type QuoteStayCandidate = z.infer<typeof quoteStayCandidateSchema>;

/**
 * Adapt only a trusted normalized producer request to the legacy exact-search
 * driver shape.  Missing room/rate references remain a clarification rather
 * than receiving a default from the locale or the driver.
 */
export function quoteStayCandidateFromRequest(request: QuoteRequest): QuoteStayCandidate | null {
  if (request.segments.length === 0 || request.roomMoveRequired) return null;
  const room = request.rooms[0];
  if (!room?.roomTypeRef || !room.ratePlanRef) return null;
  if (
    request.rooms.some(
      (item) => item.roomTypeRef !== room.roomTypeRef || item.ratePlanRef !== room.ratePlanRef,
    )
  ) {
    return null;
  }
  const rooms = request.rooms.reduce((sum, item) => sum + item.quantity, 0);
  const adults = request.rooms.reduce((sum, item) => sum + item.quantity * item.adultsPerRoom, 0);
  const children = request.rooms.reduce(
    (sum, item) => sum + item.quantity * item.childAges.length,
    0,
  );
  const candidate = {
    id: createHash('sha256')
      .update(`quote_stay:${request.quoteRequestRef}`)
      .digest('hex')
      .slice(0, 32),
    kind: 'quote_stay' as const,
    arrivalDate: request.arrival,
    departureDate: request.departure,
    adults,
    children,
    rooms,
    roomType: room.roomTypeRef,
    ratePlan: room.ratePlanRef,
    childAges: [...room.childAges],
    currency: request.currency,
    quoteRequestRef: request.quoteRequestRef,
    normalizedRooms: request.rooms,
  };
  return quoteStayCandidateSchema.safeParse(candidate).data ?? null;
}

function parseCalendarDate(value: string): number | null {
  if (!isoDate.safeParse(value).success) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

function captureAll(segment: string, pattern: RegExp, indexes: readonly number[]): string[][] {
  pattern.lastIndex = 0;
  const captures: string[][] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment)) !== null) {
    captures.push(indexes.map((index) => match![index]!));
  }
  return captures;
}

/**
 * Parse one sender-authored, already dequoted segment.
 * Caller owns segment selection; this function never walks thread history.
 */
export function parseQuoteStayCandidateFromAuthoredSegment(
  authoredSegment: string,
): QuoteStayCandidate | null {
  if (Buffer.byteLength(authoredSegment, 'utf8') > 16 * 1024) return null;

  const dateTuples = captureAll(
    authoredSegment,
    /\b(?:arrival|arrive|check[- ]?in)\s*(?:date)?\s*[:=-]?\s*(\d{4}-\d{2}-\d{2})\b[\s\S]{0,120}?\b(?:departure|depart|check[- ]?out)\s*(?:date)?\s*[:=-]?\s*(\d{4}-\d{2}-\d{2})\b/gi,
    [1, 2],
  );
  const occupancyTuples = captureAll(
    authoredSegment,
    /\b(\d{1,2})\s*adults?\b[\s,;/&-]{0,12}\b(\d{1,2})\s*(?:children|child)\b[\s,;/&-]{0,12}\b(\d{1,2})\s*rooms?\b/gi,
    [1, 2, 3],
  );
  const roomTuples = captureAll(
    authoredSegment,
    /\b(?:room\s*type|roomtype)\s*[:=-]?\s*([A-Za-z0-9][A-Za-z0-9._/-]{0,31})\b/gi,
    [1],
  );
  const rateTuples = captureAll(
    authoredSegment,
    /\b(?:rate\s*plan|rateplan)\s*[:=-]?\s*([A-Za-z0-9][A-Za-z0-9._/-]{0,31})\b/gi,
    [1],
  );
  if (
    dateTuples.length !== 1 ||
    occupancyTuples.length !== 1 ||
    roomTuples.length !== 1 ||
    rateTuples.length !== 1
  ) {
    return null;
  }

  const [arrivalDate, departureDate] = dateTuples[0]!;
  const [adultsRaw, childrenRaw, roomsRaw] = occupancyTuples[0]!;
  const [roomType] = roomTuples[0]!;
  const [ratePlan] = rateTuples[0]!;
  const canonical = [
    arrivalDate,
    departureDate,
    adultsRaw,
    childrenRaw,
    roomsRaw,
    roomType.toUpperCase(),
    ratePlan.toUpperCase(),
  ].join('|');
  return (
    quoteStayCandidateSchema.safeParse({
      id: createHash('sha256').update(`quote_stay:${canonical}`).digest('hex').slice(0, 32),
      kind: 'quote_stay',
      arrivalDate,
      departureDate,
      adults: Number(adultsRaw),
      children: Number(childrenRaw),
      rooms: Number(roomsRaw),
      roomType: roomType.toUpperCase(),
      ratePlan: ratePlan.toUpperCase(),
    }).data ?? null
  );
}

/** Contiguous ISO night dates [arrival, departure). */
export function quoteStayNightDates(candidate: QuoteStayCandidate): string[] {
  const nights: string[] = [];
  let cursor = Date.parse(`${candidate.arrivalDate}T00:00:00.000Z`);
  const end = Date.parse(`${candidate.departureDate}T00:00:00.000Z`);
  if (!Number.isFinite(cursor) || !Number.isFinite(end) || end <= cursor) {
    return nights;
  }
  while (cursor < end) {
    nights.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return nights;
}

/** HMS form Start Date: DD-MMM-YYYY (UTC calendar). */
export function isoDateToHmsDisplay(iso: string): string {
  const months = [
    'JAN',
    'FEB',
    'MAR',
    'APR',
    'MAY',
    'JUN',
    'JUL',
    'AUG',
    'SEP',
    'OCT',
    'NOV',
    'DEC',
  ] as const;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error('invalid ISO date');
  const day = m[3]!;
  const month = months[Number(m[2]) - 1];
  if (!month) throw new Error('invalid ISO month');
  return `${day}-${month}-${m[1]}`;
}
