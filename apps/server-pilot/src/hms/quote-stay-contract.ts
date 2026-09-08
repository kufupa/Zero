import { z } from 'zod';

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected ISO date YYYY-MM-DD');

const refSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'expected opaque reference');

export const normalizedQuoteRoomSchema = z
  .object({
    quantity: z.number().int().positive().max(4),
    adultsPerRoom: z.number().int().positive().max(16),
    childAges: z.array(z.number().int().min(0).max(17)).max(16),
    roomTypeRef: z.string().min(1).nullable(),
    ratePlanRef: z.string().min(1).nullable(),
  })
  .strict();

export type NormalizedQuoteRoom = z.infer<typeof normalizedQuoteRoomSchema>;

export const quoteMoneySchema = z
  .object({
    amount: z.string().regex(/^-?\d+(?:\.\d{1,2})?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    basis: z.enum(['per_room_per_night', 'per_stay', 'other']),
    taxTreatment: z.enum(['inclusive', 'exclusive', 'mixed', 'unknown']),
  })
  .strict();

export type QuoteMoney = z.infer<typeof quoteMoneySchema>;

export const quoteNightObservationSchema = z
  .object({
    date: isoDateSchema,
    roomType: z.string().min(1),
    // HMS occasionally renders a signed observed overbooking count.  It is
    // evidence about the source, not a trustworthy sold-out conclusion.
    availableCount: z.number().int(),
    ratePlan: z.string().min(1),
    displayedAmount: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    rateBasis: z.literal('nightly'),
    restrictions: z.array(z.string().min(1)).min(1).max(20),
    observedAt: z.string().datetime(),
    roomGroupIndex: z.number().int().nonnegative().optional(),
    quantity: z.number().int().positive().optional(),
  })
  .strict();

export type QuoteNightObservation = z.infer<typeof quoteNightObservationSchema>;

export const quoteStayReadDataSchema = z
  .object({
    nightlyObservations: z.array(quoteNightObservationSchema).max(120),
    requestRef: refSchema.optional(),
    arrival: isoDateSchema.optional(),
    departure: isoDateSchema.optional(),
    rooms: z.array(normalizedQuoteRoomSchema).max(4).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    coveredNights: z.array(isoDateSchema).max(30).optional(),
    missingNights: z.array(isoDateSchema).max(30).optional(),
    continuousStay: z.boolean().optional(),
    roomMoveRequired: z.boolean().optional(),
    displayRateSum: quoteMoneySchema.nullable().optional(),
    bookable: z.boolean(),
    stayTotal: quoteMoneySchema.nullable(),
    occupancyPriced: z.boolean(),
    held: z.literal(false).optional(),
    unresolvedInputs: z.array(z.string().min(1)).max(64).optional(),
    requestedRooms: z.number().int().positive(),
  })
  .strict();

export type QuoteStayReadData = z.infer<typeof quoteStayReadDataSchema>;

export type QuoteObservationSummaryInput = {
  nightlyObservations: readonly QuoteNightObservation[];
  requestedRooms: number;
  requestRef?: string;
  arrival?: string;
  departure?: string;
  rooms?: readonly NormalizedQuoteRoom[];
  currency?: string;
  roomMoveRequired?: boolean;
  unresolvedInputs?: readonly string[];
};

function quoteNightDates(arrival: string | undefined, departure: string | undefined): string[] {
  if (!arrival || !departure) return [];
  const start = Date.parse(`${arrival}T00:00:00.000Z`);
  const end = Date.parse(`${departure}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const dates: string[] = [];
  for (let cursor = start; cursor < end; cursor += 86_400_000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

function cents(amount: string): number | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) return null;
  const fraction = `${match[3] ?? ''}00`.slice(0, 2);
  const value = Number(match[2]) * 100 + Number(fraction);
  return match[1] ? -value : value;
}

function amountFromCents(value: number): string {
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

/**
 * Produce the deliberately partial quote payload from observed nightly rows.
 * Arithmetic displayed rates are retained, while occupancy/tax/restriction
 * pricing and bookability remain explicitly unproven.
 */
export function buildQuoteStayReadData(input: QuoteObservationSummaryInput): QuoteStayReadData {
  const rows = [...input.nightlyObservations];
  const expectedNights = quoteNightDates(input.arrival, input.departure);
  const observedNights = new Set(rows.map((row) => row.date));
  const missingNights = expectedNights.filter((date) => !observedNights.has(date));
  const currencies = new Set(rows.map((row) => row.currency));
  const currency = input.currency ?? (currencies.size === 1 ? rows[0]?.currency : undefined);
  const unresolved = new Set(input.unresolvedInputs ?? []);
  if (missingNights.length > 0) {
    for (const date of missingNights) unresolved.add(`missing_night:${date}`);
  }
  if (currencies.size > 1) unresolved.add('mixed_currency');
  if (input.currency && rows.some((row) => row.currency !== input.currency)) {
    unresolved.add('currency_mismatch');
  }
  if (rows.some((row) => row.availableCount < 0)) {
    unresolved.add('negative_observed_overbooking');
  }
  if (rows.some((row) => row.restrictions.some((restriction) => restriction !== 'none'))) {
    unresolved.add('restriction_pricing_unverified');
  }
  unresolved.add('occupancy_pricing_unverified');
  unresolved.add('taxes_packages_unresolved');
  unresolved.add('bookability_unproven');

  const rowCountByNight = new Map<string, number>();
  for (const row of rows) {
    rowCountByNight.set(row.date, (rowCountByNight.get(row.date) ?? 0) + 1);
  }
  const exactNightCoverage =
    expectedNights.length > 0 &&
    missingNights.length === 0 &&
    rows.length === expectedNights.length &&
    rows.every((row) => expectedNights.includes(row.date)) &&
    expectedNights.every((date) => rowCountByNight.get(date) === 1);
  const hasAmbiguousNight = [...unresolved].some(
    (value) => value.includes('.ambiguous') || value === 'ambiguous',
  );
  const requestedCurrencyMatches = Boolean(
    input.currency && currencies.size === 1 && currencies.has(input.currency),
  );
  const quantity =
    input.rooms?.reduce((sum, room) => sum + room.quantity, 0) ?? input.requestedRooms;
  const sumEligible =
    currency &&
    currencies.size === 1 &&
    exactNightCoverage &&
    requestedCurrencyMatches &&
    !hasAmbiguousNight &&
    !input.roomMoveRequired &&
    quantity > 0;

  let displayRateSum: QuoteMoney | null = null;
  if (sumEligible) {
    const total = rows.reduce((sum, row) => {
      const value = cents(row.displayedAmount);
      return value === null ? Number.NaN : sum + value * quantity;
    }, 0);
    if (Number.isFinite(total)) {
      displayRateSum = {
        amount: amountFromCents(total),
        currency,
        basis: 'per_room_per_night',
        taxTreatment: 'unknown',
      };
    } else {
      unresolved.add('display_rate_unparseable');
    }
  } else if (rows.length > 0) {
    unresolved.add('display_rate_sum_unavailable');
  }
  if (!currency) unresolved.add('currency_unresolved');

  return quoteStayReadDataSchema.parse({
    nightlyObservations: rows,
    requestRef: input.requestRef,
    arrival: input.arrival,
    departure: input.departure,
    rooms: input.rooms ? [...input.rooms] : undefined,
    currency,
    coveredNights: expectedNights.filter((date) => observedNights.has(date)),
    missingNights,
    continuousStay: missingNights.length === 0,
    roomMoveRequired: input.roomMoveRequired ?? false,
    displayRateSum,
    bookable: false,
    stayTotal: null,
    occupancyPriced: false,
    held: false,
    unresolvedInputs: [...unresolved],
    requestedRooms: input.requestedRooms,
  });
}
