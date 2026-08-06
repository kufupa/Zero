import { z } from 'zod';

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected ISO date YYYY-MM-DD');

export const quoteNightObservationSchema = z
  .object({
    date: isoDateSchema,
    roomType: z.string().min(1),
    availableCount: z.number().int().min(0),
    ratePlan: z.string().min(1),
    displayedAmount: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    rateBasis: z.literal('nightly'),
    restrictions: z.array(z.string().min(1)).min(1).max(20),
    observedAt: z.string().datetime(),
  })
  .strict();

export type QuoteNightObservation = z.infer<typeof quoteNightObservationSchema>;

export const quoteStayReadDataSchema = z
  .object({
    nightlyObservations: z.array(quoteNightObservationSchema).max(120),
    bookable: z.literal(false),
    stayTotal: z.null(),
    occupancyPriced: z.literal(false),
    requestedRooms: z.number().int().positive(),
  })
  .strict();

export type QuoteStayReadData = z.infer<typeof quoteStayReadDataSchema>;
