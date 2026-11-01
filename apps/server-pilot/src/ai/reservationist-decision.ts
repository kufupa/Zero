import { z } from 'zod';

/** Pane/extract fold these onto other. Agent scoring maps each to its gold op. */
export const HOLDING_MOVE_WORKFLOWS = [
  'forward_to_partner',
  'send_document',
  'payment_ack',
  'clarify',
  'acknowledge',
  'hms_todo',
] as const;
export type HoldingMoveWorkflow = (typeof HOLDING_MOVE_WORKFLOWS)[number];

const HOLDING_MOVE_SET = new Set<string>(HOLDING_MOVE_WORKFLOWS);

export function isHoldingMoveWorkflow(workflow: string): workflow is HoldingMoveWorkflow {
  return HOLDING_MOVE_SET.has(workflow);
}

export const TODO_TARGET_OPS = [
  'create',
  'amend',
  'cancel',
  'quote',
  'post_payment',
  'document',
  'attachment',
  'read',
  'refund',
  'partner',
] as const;

export const RESERVATIONIST_WORKFLOWS = [
  'quote',
  'create',
  'skip',
  'spam',
  'other',
  'amend',
  'cancel',
  ...HOLDING_MOVE_WORKFLOWS,
] as const;

const MOVE_CATALOG_RULES = `Move catalog — pick one workflow. Never claim an HMS action was done. No tools except quote_stay / party_lookup / quote_proposal_pdf / create_reservation_dry_run. Unsupported writes (post payment, VCC, refund, invoice generate, notes, group/rooming): unsupported → hms_todo.
- workflow=forward_to_partner: mail belongs to another team, property or partner (Da Vinci, events/conference team, accounts, another hotel). Staff will forward or redirect it. Fill partnerDestination. replyDraft is a short holding note. A rooms-only group or quote for this hotel stays quote even if another property is mentioned in passing. Venue hire, boardroom, conference, delegate packages (DDR) and events go to the events team: forward_to_partner with partnerDestination "events team", even when rooms are also asked.
- workflow=send_document: guest or company asks for an invoice, folio, proforma or statement. Fill documentKind and confirmationNumber if stated. replyDraft is a short holding note. A proof of payment, remittance or voucher they already sent is payment_ack. A payment question with no document ask stays other. Never compute a charge.
- workflow=payment_ack: POP / proof of payment / EFT for an existing stay. Fill confirmationNumber if stated. Never post payment. replyDraft empty (silent) or one-line received note. Amount mismatch: note shortfall in rationale. No stay match → clarify.
- workflow=amend: existing confirmation plus a change (dates, names, occupancy, board, room). Fill confirmationNumber exactly as written (e.g. 57291630-1), guestLastName, arrival/departure as stated, requestedChange as one short plain-English line. replyDraft empty for a TMC voucher; else a short holding note. Never claim amended.
- workflow=cancel: please cancel / no longer travelling / TMC cancellation notice. Fill confirmationNumber. The bot never accepts penalty dialogs. Late or same-day charge → hms_todo. Never claim cancelled.
- workflow=clarify: one specific question only when dates, rooms or confirmation number are missing and no other move can run. replyDraft is that question. Never the first move on a complete quote.
- workflow=acknowledge: thank-you or "received" with no remaining ask, where staff would send a short ack. replyDraft short or empty. File-and-forget FYI stays skip.
- workflow=hms_todo: staff must do HMS work this agent cannot. Fill todoTarget, todoReason, todoNextStep. replyDraft empty or holding. Never claim the action was done.`;

const HOTEL_OPERATING_RULES = `Johannesburg timezone.
- Dates are ISO yyyy-mm-dd; departureDate is the checkout day (exclusive). Rates are per room per night in ZAR.
- Quote/quotation, price, rate or availability asks stay workflow=quote despite book/reserve.
- Create requires explicit make/confirm and no quote/quotation, price, rate or availability ask.
- Quote before replying with any rate.
- A named company, agency or corporate account that should get its negotiated rate: party_lookup first, then quote_stay with rateContext using the returned nativeId.
- A formal written quotation (company/agency ask, or "send a quote") after a successful quote: quote_proposal_pdf.
- For create requests, an explicit instruction to book/confirm with guest name, dates and room uses create_reservation_dry_run. It never saves; it only validates the create request.
- Cold vendor/sales outreach, newsletters, promos, quarantine digests and cold solicitation are spam. OTP codes, bounces, payment notices, OTA relays, job/CV, day-visitor or F&B asks are not spam.
- Thank-you/acknowledgement/FYI with no ask, and internal handovers, are skip.
- Amendments and cancellations of an existing booking: workflow=amend or cancel.
${MOVE_CATALOG_RULES}
- Venue hire, boardroom, conference or delegate packages (DDR), and events: forward_to_partner (events team), no tools. A rooms-only group is quote at any size, 10+ rooms included.
- Fill occupancy the way staff do, then run the tool: one named guest or "a room" is 1 adult in 1 room; N named guests in N rooms is single occupancy; "two people" with no room count is 2 adults in 1 room. A stay-wide adult count across multiple rooms does not prove the number in each room, even when it divides evenly.
- In stayAsk, adults and children drive the search and may use defaults; adultsTotal and childrenTotal are explicit stay-wide counts only, never inferred from rooms, occupancy, names or ages. Do not divide or round a stay-wide adult count into adults per room.
- Resolve each stay from its own date evidence and the selected email's Received at date in Johannesburg local time, never today's date. If that stay's date phrase has an explicit year, keep the model dates as-is; only for a single stay may the subject provide that year. Otherwise, if the model arrival is before the received date, move its month/day to the next occurrence on or after receipt; if not, keep it. Resolve "next Friday" only when that phrase is in the stay's own date evidence. Never borrow a year or relative phrase from another stay.
- Missing dates: no tool can run; decide the workflow and list what is missing.`;

export const CENTURION_HOTEL_RULES = `Property: Centurion Hotel (HMS property code HRCEN), ${HOTEL_OPERATING_RULES}`;

export const DAVINCI_HOTEL_RULES = `Property: Da Vinci Hotel and Suites (HMS property code HRDAV), ${HOTEL_OPERATING_RULES.replace(
  'property or partner (Da Vinci, events/conference team, accounts, another hotel)',
  'property or partner (another Legacy hotel, events/conference team, accounts)',
)}`;

/** Quote prompts pick hotel identity from the HMS property. Unknown codes stay HRCEN. */
export function hotelRulesForProperty(propertyCode?: string | null): string {
  return propertyCode === 'HRDAV' ? DAVINCI_HOTEL_RULES : CENTURION_HOTEL_RULES;
}

export const reservationistDecisionSchema = z.object({
  workflow: z.enum(RESERVATIONIST_WORKFLOWS),
  stayAsk: z
    .object({
      arrivalDate: z.string(),
      departureDate: z.string(),
      adults: z
        .number()
        .int()
        .describe('Adults for the search; may be inferred and not explicitly stated.'),
      children: z
        .number()
        .int()
        .describe('Children for the search; may be inferred and not explicitly stated.'),
      adultsTotal: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe('Explicit stay-wide adult count only; null/omit if unknown. Never copy inferred search adults.'),
      childrenTotal: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe('Explicit stay-wide child count only; null/omit if unknown. Never copy inferred search children or ages.'),
      rooms: z.number().int(),
    })
    .nullable(),
  missing: z.array(z.string()),
  replyDraft: z.string(),
  rationale: z.string(),
  partnerDestination: z.string().nullish(),
  documentKind: z.string().nullish(),
  confirmationNumber: z.string().nullish(),
  requestedChange: z.string().nullish(),
  todoTarget: z.enum(TODO_TARGET_OPS).nullish(),
  todoReason: z.string().nullish(),
  todoNextStep: z.string().nullish(),
});
export type ReservationistDecision = z.infer<typeof reservationistDecisionSchema>;

const lunaGroupSchema = z.object({
  arrival: z.string().nullable().describe('ISO YYYY-MM-DD arrival, or null if not stated.'),
  departure: z
    .string()
    .nullable()
    .describe('ISO YYYY-MM-DD checkout day (exclusive), or null if not stated.'),
  dateEvidence: z
    .string()
    .nullable()
    .default(null)
    .describe('Exact source phrase for THIS group’s arrival/departure dates, or null if not stated. Never reuse another group’s phrase.'),
  rooms: z.number().int().nullable().describe('Number of identical rooms in this group.'),
  adultsTotal: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe('Stay-wide adult total when explicitly stated; null or omitted when unknown.'),
  adultsPerRoom: z
    .number()
    .int()
    .nullable()
    .describe('Adults in EACH room; null when only a stay-wide total is known across multiple rooms.'),
  childrenTotal: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe('Stay-wide child total when explicitly stated; null or omitted when unknown.'),
  childAges: z
    .array(z.number().int())
    .nullable()
    .describe('Actual age of each child, [] when none, or null when child ages are unknown.'),
  board: z.enum(['room_only', 'bb', 'dbb', 'half_board']).nullable(),
  roomPreference: z.string().nullable(),
  guestNames: z.array(z.string()),
});

export const lunaAnalysisSchema = z.object({
  workflow: z.enum(['quote', 'create_booking', 'other', 'skip', 'amend', 'cancel', ...HOLDING_MOVE_WORKFLOWS]),
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
    name: z
      .string()
      .nullable()
      .describe(
        "The company, agency or government body the stay is booked for or through (a 'Company name:' line, the signature's company). Never a guest's or the booker's own name; null when none is named.",
      ),
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
    .describe('ISO YYYY-MM-DD arrival on the existing booking as booked now, before the change. Null if not stated.'),
  departure: z
    .string()
    .nullish()
    .describe('ISO YYYY-MM-DD checkout day (exclusive) on the existing booking as booked now. Null if not stated.'),
  requestedArrival: z
    .string()
    .nullish()
    .describe(
      'ISO YYYY-MM-DD arrival the guest wants after the change. Adding nights before arrival moves it earlier. Same as arrival when unchanged. Null if unknown.',
    ),
  requestedDeparture: z
    .string()
    .nullish()
    .describe(
      'ISO YYYY-MM-DD checkout day (exclusive) the guest wants after the change. Same as departure when unchanged. Null if unknown.',
    ),
  requestedChange: z
    .string()
    .nullish()
    .describe(
      'One short plain-English line describing the requested change, at most 300 characters, card numbers masked. Null if none.',
    ),
  todoTarget: z.enum(TODO_TARGET_OPS).nullish(),
});
export type LunaAnalysis = z.infer<typeof lunaAnalysisSchema>;
