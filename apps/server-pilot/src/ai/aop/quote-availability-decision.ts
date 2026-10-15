import { z } from 'zod';
import { CENTURION_DINNER_ADD_ON } from '../staff-quote-installation.js';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

function isCalendarDay(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return ISO_DAY.test(value) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

const isoDateSchema = z
  .string()
  .regex(ISO_DAY, 'expected ISO date YYYY-MM-DD')
  .refine(isCalendarDay, 'expected real calendar day YYYY-MM-DD');

const dinnerAddOnSchema = z
  .object({
    amountMinor: z.number().int().positive().max(100_000_000),
    unit: z.enum(['per_person_per_night', 'per_room_per_night', 'per_person']),
    label: z.string().trim().min(1).max(120),
  })
  .strict();

export const decideQuoteAvailabilityInputSchema = z
  .object({
    requested: z
      .object({
        rooms: z.number().int().positive(),
        adultsPerRoom: z.number().int().positive(),
        arrival: isoDateSchema,
        departure: isoDateSchema.nullable(),
        board: z.enum(['room_only', 'bb', 'dbb']).nullable(),
      })
      .strict(),
    available: z.array(
      z
        .object({
          roomType: z.string().min(1),
          rooms: z.number().int().min(0),
        })
        .strict(),
    ),
    dinnerAddOn: dinnerAddOnSchema.optional(),
  })
  .strict();

export const decideQuoteAvailabilityOutputSchema = z
  .object({
    decision: z.enum(['full', 'partial', 'sold_out']),
    roomsAvailable: z.number().int().min(0),
    roomsRequested: z.number().int().positive(),
    nights: z.number().int().positive(),
    assumedOneNight: z.boolean(),
    dinnerLine: dinnerAddOnSchema.nullable(),
    replyLine: z.string().min(1).nullable(),
  })
  .strict();

export type DecideQuoteAvailabilityInput = z.infer<typeof decideQuoteAvailabilityInputSchema>;
export type DecideQuoteAvailabilityOutput = z.infer<typeof decideQuoteAvailabilityOutputSchema>;

export const decideQuoteAvailabilityDescription =
  'Call after quote_stay returns room counts (not rates). Decide full, partial, or sold_out, default missing departure to 1 night, and attach the DBB dinner line. Put replyLine in replyDraft only for partial ("shall I proceed?") or sold_out (one-line decline, no alternatives). Skip when quote_stay is unavailable — stay on workflow=quote with holding text.';

function addDays(value: string, days: number): string {
  return new Date(Date.parse(`${value}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function nightsBetween(arrival: string, departure: string): number {
  return (Date.parse(`${departure}T00:00:00.000Z`) - Date.parse(`${arrival}T00:00:00.000Z`)) / DAY_MS;
}

function formatDay(iso: string): { day: number; month: string; year: number } {
  const year = Number(iso.slice(0, 4));
  const month = MONTHS[Number(iso.slice(5, 7)) - 1]!;
  const day = Number(iso.slice(8, 10));
  return { day, month, year };
}

/** Arrival–checkout span, e.g. 18–20 Nov 2026. */
export function formatStayDates(arrival: string, departure: string): string {
  const a = formatDay(arrival);
  const b = formatDay(departure);
  if (a.year === b.year && a.month === b.month) return `${a.day}–${b.day} ${a.month} ${a.year}`;
  if (a.year === b.year) return `${a.day} ${a.month}–${b.day} ${b.month} ${a.year}`;
  return `${a.day} ${a.month} ${a.year}–${b.day} ${b.month} ${b.year}`;
}

export function decideQuoteAvailability(raw: DecideQuoteAvailabilityInput): DecideQuoteAvailabilityOutput {
  const input = decideQuoteAvailabilityInputSchema.parse(raw);
  const { requested, available, dinnerAddOn } = input;
  if (requested.departure !== null && nightsBetween(requested.arrival, requested.departure) < 1) {
    throw new Error('departure_not_after_arrival');
  }

  const checkout = requested.departure ?? addDays(requested.arrival, 1);
  const assumedOneNight = requested.departure === null;
  const nights = nightsBetween(requested.arrival, checkout);
  const roomsAvailable = available.reduce((sum, row) => sum + row.rooms, 0);
  const roomsRequested = requested.rooms;
  const dates = formatStayDates(requested.arrival, checkout);
  const decision =
    roomsAvailable <= 0 ? 'sold_out' : roomsAvailable < roomsRequested ? 'partial' : 'full';
  const replyLine =
    decision === 'partial'
      ? `We have ${roomsAvailable} of the ${roomsRequested} rooms for ${dates}; shall I proceed with ${roomsAvailable}?`
      : decision === 'sold_out'
        ? `Unfortunately we are fully booked for ${dates}.`
        : null;
  const dinnerLine = requested.board === 'dbb' ? (dinnerAddOn ?? { ...CENTURION_DINNER_ADD_ON }) : null;

  return decideQuoteAvailabilityOutputSchema.parse({
    decision,
    roomsAvailable,
    roomsRequested,
    nights,
    assumedOneNight,
    dinnerLine,
    replyLine,
  });
}
