import { z } from 'zod';

export const CENTURION_HOTEL_RULES = `Property: Centurion Hotel (HMS property code HRCEN), Johannesburg timezone.
- Dates are ISO yyyy-mm-dd; departureDate is the checkout day (exclusive). Rates are per room per night in ZAR.
- A stay request with dates and occupancy that asks for price/availability is a quote. Quote before replying with any rate.
- A named company, agency or corporate account that should get its negotiated rate: party_lookup first, then quote_stay with rateContext using the returned nativeId.
- A formal written quotation (company/agency ask, or "send a quote") after a successful quote: quote_proposal_pdf.
- An explicit instruction to book/confirm with guest name, dates and room: create_reservation_dry_run. It never saves; it only validates the create request.
- Cold vendor/sales outreach, newsletters, promos, quarantine digests and cold solicitation are spam. OTP codes, bounces, payment notices, OTA relays, job/CV, day-visitor or F&B asks are not spam.
- Thank-you/acknowledgement/FYI with no ask, and internal handovers, are skip.
- Amendments and cancellations of an existing booking: workflow=amend or cancel. Fill confirmationNumber exactly as written (e.g. 57291630-1), guestLastName, arrival/departure as stated, requestedChange as one short plain-English line (e.g. 'Change departure from 15 Nov to 17 Nov'). No tools. Invoices, folios, payment queries stay other.
- Venue hire, conference or delegate packages (DDR), and events, are other (no tools). A rooms-only group is quote at any size, 10+ rooms included.
- Fill occupancy the way staff do, then run the tool: one named guest or "a room" is 1 adult in 1 room; N named guests in N rooms is single occupancy; "two people" with no room count is 2 adults in 1 room. A day-month without a year is its next occurrence.
- A request to "assist with"/"book" rooms with dates and guest names is create.
- Missing dates: no tool can run; decide the workflow and list what is missing.`;

export const reservationistDecisionSchema = z.object({
  workflow: z.enum(['quote', 'create', 'skip', 'spam', 'other', 'amend', 'cancel']),
  stayAsk: z
    .object({
      arrivalDate: z.string(),
      departureDate: z.string(),
      adults: z.number().int(),
      children: z.number().int(),
      rooms: z.number().int(),
    })
    .nullable(),
  missing: z.array(z.string()),
  replyDraft: z.string(),
  rationale: z.string(),
});
export type ReservationistDecision = z.infer<typeof reservationistDecisionSchema>;

const lunaGroupSchema = z.object({
  arrival: z.string().nullable().describe('ISO YYYY-MM-DD arrival, or null if not stated.'),
  departure: z
    .string()
    .nullable()
    .describe('ISO YYYY-MM-DD checkout day (exclusive), or null if not stated.'),
  rooms: z.number().int().nullable().describe('Number of identical rooms in this group.'),
  adultsPerRoom: z
    .number()
    .int()
    .nullable()
    .describe("Adults in EACH room; '6 adults in 3 rooms' = 2"),
  childAges: z.array(z.number().int()),
  board: z.enum(['room_only', 'bb', 'dbb']).nullable(),
  roomPreference: z.string().nullable(),
  guestNames: z.array(z.string()),
});

export const lunaAnalysisSchema = z.object({
  workflow: z.enum(['quote', 'create_booking', 'other', 'amend', 'cancel']),
  flags: z.array(
    z.enum([
      'conference_or_group',
      'rooms_only_group',
      'amendment_or_cancel',
      'long_stay',
      'discount_or_negotiation',
      'multi_date',
      'extras',
      'mixed_request',
      'attachment_unread',
    ]),
  ),
  groups: z.array(lunaGroupSchema),
  party: z.object({
    kind: z.enum(['agency', 'organization', 'government', 'private']).nullable(),
    name: z.string().nullable(),
    reference: z.string().nullable(),
  }),
  rateClaims: z.array(
    z.object({
      kind: z.enum(['exact', 'ceiling', 'budget', 'average_daily', 'total', 'paid']),
      amount: z.string(),
      currency: z.string(),
      basis: z.enum(['per_room_per_night', 'total', 'unknown']),
      taxBasis: z.enum(['gross_included', 'exclusive', 'unknown']),
      quote: z.string(),
    }),
  ),
  missing: z.array(z.object({ field: z.string(), question: z.string() })),
  evidence: z.array(
    z.object({
      field: z.string(),
      quote: z.string(),
      source: z.enum(['staff_note']).optional(),
    }),
  ),
  tasks: z
    .array(
      z.object({
        kind: z.enum(['quote', 'create_booking', 'amend', 'cancel', 'availability', 'other']),
        groupIndexes: z.array(z.number().int()),
        note: z.string(),
      }),
    )
    .max(8),
  confirmationNumber: z
    .preprocess((value) => (typeof value === 'number' ? String(value) : value), z.string().nullish())
    .describe(
      'Existing booking confirmation number exactly as written, e.g. 57291630-1. Null if none.',
    ),
  guestLastName: z
    .string()
    .nullish()
    .describe('Surname on the existing booking, as stated. Null if not stated.'),
  arrival: z
    .string()
    .nullish()
    .describe('ISO YYYY-MM-DD arrival on the existing booking, as stated. Null if not stated.'),
  departure: z
    .string()
    .nullish()
    .describe('ISO YYYY-MM-DD checkout day (exclusive), as stated. Null if not stated.'),
  requestedChange: z
    .string()
    .nullish()
    .describe(
      'One short plain-English line describing the requested change, at most 300 characters, card numbers masked. Null if none.',
    ),
});
export type LunaAnalysis = z.infer<typeof lunaAnalysisSchema>;
