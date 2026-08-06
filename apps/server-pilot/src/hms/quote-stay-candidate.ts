import { createHash } from 'node:crypto';
import { z } from 'zod';

export const QUOTE_STAY_MAX_NIGHTS = 30;
export const QUOTE_STAY_MAX_ROOMS = 4;
export const QUOTE_STAY_MAX_GUESTS = 16;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const quoteStayCandidateSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    kind: z.literal('quote_stay'),
    arrivalDate: isoDate,
    departureDate: isoDate,
    adults: z.number().int().min(1).max(QUOTE_STAY_MAX_GUESTS),
    children: z.number().int().min(0).max(QUOTE_STAY_MAX_GUESTS),
    rooms: z.number().int().min(1).max(QUOTE_STAY_MAX_ROOMS),
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

function parseCalendarDate(value: string): number | null {
  if (!isoDate.safeParse(value).success) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : null;
}

function captureAll(
  segment: string,
  pattern: RegExp,
  indexes: readonly number[],
): string[][] {
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
  if (dateTuples.length !== 1 || occupancyTuples.length !== 1) return null;

  const [arrivalDate, departureDate] = dateTuples[0]!;
  const [adultsRaw, childrenRaw, roomsRaw] = occupancyTuples[0]!;
  const canonical = [
    arrivalDate,
    departureDate,
    adultsRaw,
    childrenRaw,
    roomsRaw,
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
    }).data ?? null
  );
}
