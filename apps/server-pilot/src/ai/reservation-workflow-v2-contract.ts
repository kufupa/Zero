import { z } from 'zod';
import { propertyCodeSchema, propertySwitchSchema } from '../hms/property-registry.js';

/** Wire contract for the source-bound reservation draft. No runtime/database imports. */
export const RESERVATION_WORKFLOW_V2_VERSION = 2 as const;
export const RESERVATION_PREFILL_SCHEMA_VERSION = 'reservation-prefill.v0.2' as const;

/** Safe metadata vocabularies for best-effort client reports of failed reservation RPCs. */
export const RESERVATION_WORKFLOW_V2_ERROR_PROCEDURES = [
  'resolveSource', 'ensure', 'prefill', 'addAction', 'changeRows', 'selectNative', 'verifyNativeLead', 'reviewScope',
  'get', 'reconcileSource', 'edit', 'review', 'undo', 'redo', 'lookup', 'guestProfileOptions',
  'prepareGuestProfile', 'createGuestProfile', 'prepare', 'execute', 'reconcile', 'configureFiling',
  'lookupServices', 'prepareServices', 'executeServices', 'reconcileServices',
] as const;
export const PANE_ERROR_CLASSES = ['trpc', 'network', 'timeout', 'client', 'unknown'] as const;
export const PANE_ERROR_CODES = [
  'PARSE_ERROR', 'BAD_REQUEST', 'INTERNAL_SERVER_ERROR', 'NOT_IMPLEMENTED', 'BAD_GATEWAY', 'SERVICE_UNAVAILABLE',
  'GATEWAY_TIMEOUT', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'METHOD_NOT_SUPPORTED', 'TIMEOUT', 'CONFLICT',
  'PRECONDITION_FAILED', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'UNPROCESSABLE_CONTENT', 'TOO_MANY_REQUESTS',
  'CLIENT_CLOSED_REQUEST', 'UNKNOWN',
] as const;

const idSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const refSchema = z.string().min(1).max(160);
const noneSchema = z.object({ kind: z.literal('none') }).strict();
const value = (schema: z.ZodTypeAny) => z.union([schema, noneSchema, z.null()]);
const occupancySchema = z.object({
  adults: z.number().int().nullable(),
  childCount: z.number().int().nullable(),
  childAges: z.array(z.number().int().nullable()).max(12).nullable(),
}).strict();
const moneyRequestSchema = z.object({
  id: idSchema,
  amount: z.string().max(80).nullable(),
  currency: z.string().max(12).nullable(),
  unit: z.string().max(80).nullable(),
  scope: z.enum(['overall', 'per_target', 'unresolved']),
  targetRefs: z.array(refSchema).max(100),
  sourceRefs: z.array(refSchema).max(100),
  staffAllowanceType: z.enum(['dinner', 'lunch', 'airport_transfer', 'office_transfer', 'unsupported']).optional(),
}).strict();
const partySchema = z.object({
  name: z.string().max(300).nullable(),
  candidateRefs: z.array(refSchema).max(100),
  suggestedRef: refSchema.nullable(),
}).strict();
const targetHintSchema = z.object({
  id: idSchema,
  confirmation: z.string().max(200).optional(),
  guestName: z.string().max(300).optional(),
  bookedArrival: z.string().max(40).optional(),
  bookedDeparture: z.string().max(40).optional(),
  candidateRefs: z.array(refSchema).max(100),
  suggestedRef: refSchema.nullable(),
  sourceRefs: z.array(refSchema).max(100),
}).strict();
const savedScopeSchema = z.object({
  mode: z.enum(['explicit', 'scoped_all', 'unresolved']),
  include: z.array(targetHintSchema).max(100),
  exclude: z.array(targetHintSchema).max(100),
  sourceRefs: z.array(refSchema).max(100),
}).strict();
const targetRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allocation'), requestId: idSchema, allocationId: idSchema }).strict(),
  z.object({ kind: z.literal('quote_group'), requestId: idSchema, groupId: idSchema }).strict(),
  z.object({ kind: z.literal('saved_target'), requestId: idSchema, hintId: idSchema }).strict(),
]);

/** Host-admitted source material handed to extraction/synthesis; dates are the visibility cutoff. */
export const reservationWorkflowV2EvidenceSchema = z.object({
  ref: refSchema,
  kind: z.enum(['message', 'attachment_text', 'attachment_vision']),
  relation: z.enum(['current_message', 'prior_thread', 'attachment']),
  messageId: z.string().min(1).max(500),
  threadId: z.string().min(1).max(500),
  observedAt: z.string().datetime({ offset: true }),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  page: z.number().int().min(1).max(100).optional(),
  text: z.string().max(100_000),
}).strict();
export type ReservationWorkflowV2Evidence = z.infer<typeof reservationWorkflowV2EvidenceSchema>;

const extractedClaimSchema = z.object({
  raw: z.string().max(2000),
  value: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
  sourceRefs: z.array(refSchema).min(1).max(20),
}).strict();
const guestHintSchema = z.object({ role: z.enum(['guest', 'booker']), name: extractedClaimSchema.optional(),
  email: extractedClaimSchema.optional(), mobile: extractedClaimSchema.optional() }).strict();
const partyHintSchema = z.object({ role: z.enum(['bookingAgency', 'organization', 'ar_account']),
  name: extractedClaimSchema }).strict();
const prefillRequestFactsSchema = z.object({
  id: idSchema,
  kind: z.enum(['quote', 'create', 'amend', 'cancel', 'services', 'filing', 'other']),
  requestText: extractedClaimSchema,
  dates: z.array(z.object({ arrival: extractedClaimSchema.optional(), departure: extractedClaimSchema.optional(),
    roomCount: extractedClaimSchema.optional(), guestNames: z.array(extractedClaimSchema).max(200).optional(),
    mealPlan: extractedClaimSchema.optional() }).strict()).max(100).default([]),
  roomCount: extractedClaimSchema.optional(),
  requestedPrice: z.object({ nightlyRate: extractedClaimSchema.optional(), total: extractedClaimSchema.optional(),
    currency: extractedClaimSchema.optional(), scope: z.enum(['per_room', 'whole_group', 'unknown']),
    dateIndex: z.number().int().nonnegative().optional() }).strict().optional(),
  occupancy: z.array(z.object({ scope: z.enum(['per_room', 'whole_group', 'unknown']),
    adults: extractedClaimSchema.optional(), childCount: extractedClaimSchema.optional(),
    childAges: z.array(extractedClaimSchema).max(12).optional() }).strict()).max(100).default([]),
  guests: z.array(guestHintSchema).max(200).default([]),
  parties: z.array(partyHintSchema).max(100).default([]),
  confirmationHints: z.array(extractedClaimSchema).max(100).default([]),
  roomTypeHints: z.array(extractedClaimSchema).max(100).default([]),
  rateHints: z.array(extractedClaimSchema).max(100).default([]),
  mealPlanHints: z.array(extractedClaimSchema).max(100).default([]),
  serviceHints: z.array(extractedClaimSchema).max(200).default([]),
  documentRefs: z.array(refSchema).max(200).default([]),
  documentHints: z.array(z.object({ documentRef: refSchema,
    kind: z.enum(['voucher', 'payment_proof', 'other', 'unclassified']),
    sourceRefs: z.array(refSchema).min(1).max(20) }).strict()).max(200).default([]),
}).strict();

/** Typed first pass. Host derives lookups from these cited facts; the model does not author arbitrary queries. */
export const reservationWorkflowV2ExtractionSchema = z.object({
  requests: z.array(prefillRequestFactsSchema).max(200).default([]),
  issues: z.array(z.object({ explanation: z.string().max(1000), sourceRefs: z.array(refSchema).max(20) }).strict()).max(200).default([]),
}).strict();
export type ReservationWorkflowV2Extraction = z.infer<typeof reservationWorkflowV2ExtractionSchema>;
export const reservationWorkflowV2PrefillInputSchema = z.object({
  transportId: z.string().min(1).max(200),
  propertyCode: propertyCodeSchema,
  source: z.object({ threadId: z.string().min(1).max(500), messageId: z.string().min(1).max(500),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/), decisionAt: z.string().datetime({ offset: true }) }).strict(),
  evidence: z.array(reservationWorkflowV2EvidenceSchema).max(500),
}).strict();
export type ReservationWorkflowV2PrefillInput = z.infer<typeof reservationWorkflowV2PrefillInputSchema>;

const bookingFieldsSchema = z.object({
  requestedRoomDescription: value(z.string().max(1000)).optional(),
  requestedMealPlan: value(z.string().max(120)).optional(),
  mealPlan: value(z.string().max(120)).optional(),
  roomType: value(z.string().max(120)).optional(),
  roomTypeForCharge: value(z.string().max(120)).optional(),
  ratePlan: value(z.string().max(120)).optional(),
  bookingAgency: value(partySchema).optional(),
  organization: value(partySchema).optional(),
  arAccount: value(partySchema).optional(),
  guaranteeType: value(z.string().max(120)).optional(),
  taCommission: value(z.union([z.number().min(0).max(100), z.string().max(40)])).optional(),
  sourceOfBusiness: value(z.string().max(120)).optional(),
  reasonForStay: value(z.string().max(500)).optional(),
  billingReference: value(z.string().max(50)).optional(),
  track: value(z.string().max(120)).optional(),
  marketSegment: value(z.string().max(20)).optional(),
  guestOptIn: value(z.boolean()).optional(),
  bookerName: value(z.string().max(300)).optional(),
  bookerEmail: value(z.string().max(320)).optional(),
  bookerMobile: value(z.string().max(120)).optional(),
  reservationNote: value(z.string().max(2000)).optional(),
  cmsSend: value(z.boolean()).optional(),
  cmsMessageId: value(z.string().max(200)).optional(),
  cmsRecipient: value(z.string().max(500)).optional(),
}).strict();

const createBodySchema = z.object({
  shared: bookingFieldsSchema,
  dateSections: z.array(z.object({
    id: idSchema,
    arrival: z.string().max(40).nullable(),
    departure: z.string().max(40).nullable(),
    requestedRooms: z.number().int().nullable(),
    requestedTotals: occupancySchema,
    defaults: bookingFieldsSchema,
    unassignedGuestNames: z.array(z.string().max(300)).max(200),
  }).strict()).max(100),
  allocations: z.array(z.object({
    id: idSchema,
    dateSectionId: idSchema,
    overrides: bookingFieldsSchema,
    guest: z.object({
      firstName: z.string().max(200).nullable(),
      lastName: z.string().max(200).nullable(),
      email: z.string().max(320).nullable(),
      mobile: z.string().max(120).nullable(),
      titleCode: z.string().max(200).nullable().optional(),
      phoneNumber: z.string().max(200).nullable().optional(),
      phoneTypeCode: z.string().max(200).nullable().optional(),
      emailTypeCode: z.string().max(200).nullable().optional(),
      profileIntent: z.enum(['existing_or_unknown', 'requested_new']),
      candidateRefs: z.array(refSchema).max(100),
      suggestedRef: refSchema.nullable(),
    }).strict(),
    occupancy: occupancySchema,
    priceObservationRefs: z.array(refSchema).max(100),
  }).strict()).max(100),
}).strict();

const quoteBodySchema = z.object({
  groups: z.array(z.object({
    id: idSchema,
    arrival: z.string().max(40).nullable(),
    departure: z.string().max(40).nullable(),
    quantity: z.number().int().nullable(),
    mealPlan: z.string().max(120).nullable(),
    requestedMealPlan: z.string().max(120).nullable().default(null),
    requestedRoomDescription: z.string().max(1000).nullable().optional(),
    guestNames: z.array(z.string().max(300)).max(200).optional(),
    roomCodes: z.array(z.string().max(120)).max(100),
    ratePlan: z.string().max(120).nullable(),
    occupancy: occupancySchema.extend({ scope: z.enum(['per_room', 'whole_group', 'unresolved']) }),
    priceObservationRefs: z.array(refSchema).max(100),
  }).strict()).max(100),
  guestNames: z.array(z.string().max(300)).max(200).optional(),
  parties: z.object({ organization: value(partySchema).optional(), bookingAgency: value(partySchema).optional() }).strict(),
  salesStrategy: z.string().max(1000).nullable(),
  client: z.object({ attention: z.string().max(300).nullable(), email: z.string().max(320).nullable(),
    telephone: z.string().max(120).nullable() }).strict(),
  requestedMoney: z.array(moneyRequestSchema).max(100),
  notes: z.string().max(4000).nullable(),
  outputIntent: z.object({ artifacts: z.array(z.enum(['email_quote', 'pdf_quote', 'xlsx_quote'])).max(3),
    evidenceRefs: z.array(refSchema).max(100) }).strict(),
  provisionalBookingRequested: z.boolean().nullable(),
}).strict();

const amendFieldSchema = z.enum([
  'arrival', 'departure', 'adults', 'childCount', 'childAges', 'roomType', 'roomTypeForCharge', 'ratePlan',
  'firstName', 'lastName', 'guestEmail', 'bookerName', 'bookerEmail', 'bookerMobile', 'reservationNote', 'cmsSend',
  'requestedMealPlan', 'roomCount', 'bookingAgency', 'organization', 'arAccount', 'billingReference', 'taCommission', 'track', 'guaranteeType',
  'cmsMessageId', 'cmsRecipient', 'guestOptIn',
]);
export const reservationWorkflowV2TrackSchema = z.object({
  lookupCode: z.string().regex(/^[A-Z0-9]{1,12}$/),
  display: z.string().max(200).regex(/\S/u)
    .refine((text) => ![...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)),
}).strict();
export type ReservationWorkflowV2Track = z.infer<typeof reservationWorkflowV2TrackSchema>;
const amendScalarSchema = z.union([
  z.string().max(4000), z.number(), z.boolean(), z.array(z.number().int().nullable()).max(12), partySchema,
  reservationWorkflowV2TrackSchema,
]);
const changeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), field: amendFieldSchema, value: amendScalarSchema, sourceRefs: z.array(refSchema).max(100) }).strict(),
  z.object({ op: z.literal('clear'), field: amendFieldSchema, sourceRefs: z.array(refSchema).max(100) }).strict(),
  z.object({ op: z.literal('shift_dates'), days: z.number().int(), sourceRefs: z.array(refSchema).max(100) }).strict(),
  z.object({ op: z.literal('shift_departure'), days: z.number().int(), sourceRefs: z.array(refSchema).max(100) }).strict(),
]).superRefine((change, ctx) => {
  if (change.op === 'set' && change.field === 'billingReference' &&
      (typeof change.value !== 'string' || change.value.length > 50)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'],
      message: 'Billing Reference must be at most 50 characters.' });
  }
});
const amendSourceCueSchema = z.object({
  kind: z.enum(['room_description', 'nightly_price']),
  text: z.string().min(1).max(2000),
  sourceRefs: z.array(refSchema).min(1).max(20),
}).strict();
const amendBodySchema = z.object({
  targets: savedScopeSchema,
  sharedChanges: z.array(changeSchema).max(200),
  perTarget: z.array(z.object({ hintId: idSchema, changes: z.array(changeSchema).max(200),
    rateHandling: z.enum(['retain', 'reprice']).nullable(), currentObservationRefs: z.array(refSchema).max(100) }).strict()).max(100),
  sourceCues: z.array(amendSourceCueSchema).max(20).optional(),
}).strict();
const cancelBodySchema = z.object({
  targets: savedScopeSchema,
  reason: z.object({ text: z.string().max(1000).nullable(), candidateRefs: z.array(refSchema).max(100),
    suggestedRef: refSchema.nullable() }).strict(),
  cancellationNote: z.string().max(4000).nullable(),
  previewObservationRefs: z.array(refSchema).max(100),
}).strict();

const serviceFieldsSchema = z.object({
  quantity: value(z.string().max(80)).optional(),
  startDate: value(z.string().max(40)).optional(),
  endDate: value(z.string().max(40)).optional(),
  unitPrice: value(z.string().max(80)).optional(),
  frequency: value(z.string().max(120)).optional(),
  pricingControl: value(z.string().max(120)).optional(),
  folio: value(z.string().max(120)).optional(),
  comment: value(z.string().max(2000)).optional(),
}).strict();
const serviceBodySchema = z.object({ targets: savedScopeSchema }).strict();
const filingBodySchema = z.object({ targets: z.union([savedScopeSchema, z.null()]),
  allocationTarget: z.object({ requestId: idSchema, allocationId: idSchema }).strict().optional() }).strict();
const serviceRequestSchema = z.object({
  id: idSchema,
  ownerRequestId: idSchema.nullable(),
  operation: z.enum(['add', 'edit', 'remove']),
  requestedText: z.string().max(2000),
  code: z.string().max(160).nullable(),
  itemCandidateRef: refSchema.nullable(),
  sharedFields: serviceFieldsSchema,
  requestedMoney: z.array(moneyRequestSchema).max(100),
  targets: z.array(z.object({ target: targetRefSchema, fields: serviceFieldsSchema,
    savedRowCandidateRef: refSchema.nullable(), previewObservationRef: refSchema.nullable() }).strict()).max(100),
  quantityRequest: z.object({ value: z.string().max(80).nullable(), scope: z.enum(['overall', 'per_target', 'unresolved']),
    sourceRefs: z.array(refSchema).max(100) }).strict(),
  sourceRefs: z.array(refSchema).max(100),
}).strict();
const documentRequestSchema = z.object({
  id: idSchema,
  ownerRequestId: idSchema.nullable(),
  documentSourceRef: refSchema,
  kind: z.enum(['voucher', 'payment_proof', 'other', 'unclassified']),
  handling: z.enum(['filing_requested', 'context', 'unclear']),
  targetRefs: z.array(targetRefSchema).max(100),
  requestedName: z.string().max(300).nullable(),
  requestedDescription: z.string().max(1000).nullable(),
  uploadArtifactRef: refSchema.nullable(),
  sourceRefs: z.array(refSchema).max(100),
}).strict();

const requestSchema = z.discriminatedUnion('kind', [
  z.object({ id: idSchema, requestText: z.string().max(2000), sourceRefs: z.array(refSchema).max(100),
    serviceRefs: z.array(refSchema).max(100), documentRefs: z.array(refSchema).max(100), kind: z.literal('quote'), body: quoteBodySchema }).strict(),
  z.object({ id: idSchema, requestText: z.string().max(2000), sourceRefs: z.array(refSchema).max(100),
    serviceRefs: z.array(refSchema).max(100), documentRefs: z.array(refSchema).max(100), kind: z.literal('create'), body: createBodySchema }).strict(),
  z.object({ id: idSchema, requestText: z.string().max(2000), sourceRefs: z.array(refSchema).max(100),
    serviceRefs: z.array(refSchema).max(100), documentRefs: z.array(refSchema).max(100), kind: z.literal('amend'), body: amendBodySchema }).strict(),
  z.object({ id: idSchema, requestText: z.string().max(2000), sourceRefs: z.array(refSchema).max(100),
    serviceRefs: z.array(refSchema).max(100), documentRefs: z.array(refSchema).max(100), kind: z.literal('cancel'), body: cancelBodySchema }).strict(),
  z.object({ id: idSchema, requestText: z.string().max(2000), sourceRefs: z.array(refSchema).max(100),
    serviceRefs: z.array(refSchema).max(100), documentRefs: z.array(refSchema).max(100), kind: z.literal('services'), body: serviceBodySchema }).strict(),
  z.object({ id: idSchema, requestText: z.string().max(2000), sourceRefs: z.array(refSchema).max(100),
    serviceRefs: z.array(refSchema).max(100), documentRefs: z.array(refSchema).max(100), kind: z.literal('filing'), body: filingBodySchema }).strict(),
  z.object({ id: idSchema, requestText: z.string().max(2000), sourceRefs: z.array(refSchema).max(100),
    serviceRefs: z.array(refSchema).max(100), documentRefs: z.array(refSchema).max(100), kind: z.literal('other'),
    body: z.object({ requestedText: z.string().max(2000), supported: z.literal(false),
      separatedFrom: z.object({ requestId: idSchema, moneyId: idSchema,
        allowance: z.object({ kind: z.enum(['dinner', 'lunch', 'airport_transfer', 'office_transfer']),
          groupIds: z.array(idSchema).max(100), quoteRequestIds: z.array(idSchema).max(200) }).strict().optional(),
      }).strict().optional() }).strict() }).strict(),
]);

export const reservationWorkflowV2ProposalSchema = z.object({
  schemaVersion: z.literal(RESERVATION_PREFILL_SCHEMA_VERSION),
  content: z.object({ requests: z.array(requestSchema).max(200), services: z.array(serviceRequestSchema).max(200),
    documents: z.array(documentRequestSchema).max(200) }).strict(),
  annotations: z.array(z.object({ path: z.string().min(1).max(300),
    basis: z.enum(['source', 'native_read', 'policy', 'inferred', 'assumption']),
    evidenceRefs: z.array(refSchema).max(100) }).strict()).max(2000),
  issues: z.array(z.object({ path: z.string().min(1).max(300), kind: z.string().min(1).max(100),
    explanation: z.string().max(2000), evidenceRefs: z.array(refSchema).max(100) }).strict()).max(1000),
  sourceClaims: z.array(z.object({ path: z.string().min(1).max(300), raw: z.string().max(2000),
    sourceRefs: z.array(refSchema).max(100) }).strict()).max(1000),
  lookupResultRefs: z.array(refSchema).max(1000),
}).strict();

export type ReservationWorkflowV2Proposal = z.infer<typeof reservationWorkflowV2ProposalSchema>;

export function separatedQuoteMoneyLinked(
  link: Extract<ReservationWorkflowV2Proposal['content']['requests'][number], { kind: 'other' }>['body']['separatedFrom'],
  requestId: string, moneyId: string,
): boolean {
  return link?.moneyId === moneyId && (link.allowance
    ? link.allowance.quoteRequestIds.includes(requestId) : link.requestId === requestId);
}


// Existing drafts may contain notes accepted before the native limit was fixed.
// New/model proposals still use the strict 2,000-character schema above.
const storedBookingFieldsSchema = bookingFieldsSchema.extend({
  billingReference: value(z.string().max(4000)).optional(),
  guestOptIn: value(z.boolean()).optional(),
  bookerName: value(z.string().max(300)).optional(),
  reservationNote: value(z.string().max(4000)).optional(),
});
const storedCreateBodySchema = createBodySchema.extend({
  shared: storedBookingFieldsSchema,
  dateSections: z.array(createBodySchema.shape.dateSections.element.extend({ defaults: storedBookingFieldsSchema })).max(100),
  allocations: z.array(createBodySchema.shape.allocations.element.extend({ overrides: storedBookingFieldsSchema })).max(100),
});
// Existing Amend drafts may retain billing references accepted before the native
// 50-character limit. New/model proposals still use the strict changeSchema above.
const storedAmendChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), field: amendFieldSchema, value: amendScalarSchema, sourceRefs: z.array(refSchema).max(100) }).strict(),
  z.object({ op: z.literal('clear'), field: amendFieldSchema, sourceRefs: z.array(refSchema).max(100) }).strict(),
  z.object({ op: z.literal('shift_dates'), days: z.number().int(), sourceRefs: z.array(refSchema).max(100) }).strict(),
  z.object({ op: z.literal('shift_departure'), days: z.number().int(), sourceRefs: z.array(refSchema).max(100) }).strict(),
]).superRefine((change, ctx) => {
  if (change.op === 'set' && change.field === 'billingReference' &&
      (typeof change.value !== 'string' || change.value.length > 4000)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'],
      message: 'Billing Reference must be at most 4000 characters.' });
  }
});
const storedAmendBodySchema = z.object({
  targets: savedScopeSchema,
  sharedChanges: z.array(storedAmendChangeSchema).max(200),
  perTarget: z.array(z.object({ hintId: idSchema, changes: z.array(storedAmendChangeSchema).max(200),
    rateHandling: z.enum(['retain', 'reprice']).nullable(), currentObservationRefs: z.array(refSchema).max(100) }).strict()).max(100),
  sourceCues: z.array(amendSourceCueSchema).max(20).optional(),
}).strict();
const storedRequestSchema = z.discriminatedUnion('kind', [requestSchema.options[0],
  requestSchema.options[1].extend({ body: storedCreateBodySchema }),
  requestSchema.options[2].extend({ body: storedAmendBodySchema }), requestSchema.options[3],
  requestSchema.options[4], requestSchema.options[5], requestSchema.options[6]]);
const storedProposalSchema = reservationWorkflowV2ProposalSchema.extend({
  content: reservationWorkflowV2ProposalSchema.shape.content.extend({ requests: z.array(storedRequestSchema).max(200) }),
});

/** Host-owned evidence. Model output can cite these refs but cannot create or edit registry entries. */
export const reservationWorkflowV2ObservationSchema = z.object({
  ref: refSchema,
  generationId: z.string().uuid(),
  kind: z.enum(['source', 'mail_candidate', 'stay_candidate', 'guest_candidate', 'party_candidate',
    'rate_availability', 'service_preview', 'document']),
  status: z.enum(['complete', 'partial', 'unavailable', 'failed']),
  observedAt: z.string().datetime({ offset: true }),
  propertyCode: propertyCodeSchema,
  sourceMessageId: z.string().max(500).nullable(),
  sourceRefs: z.array(refSchema).max(500),
  criteria: z.record(z.unknown()),
  coverage: z.object({ complete: z.boolean(), notes: z.array(z.string().max(500)).max(50) }).strict(),
  result: z.record(z.unknown()),
}).strict();
export type ReservationWorkflowV2Observation = z.infer<typeof reservationWorkflowV2ObservationSchema>;

export const reservationWorkflowV2SourceSchema = z.object({
  propertyId: propertyCodeSchema.optional(),
  threadId: z.string().min(1).max(500),
  messageId: z.string().min(1).max(500),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  arrivedAt: z.string().datetime({ offset: true }),
}).strict();
export type ReservationWorkflowV2Source = z.infer<typeof reservationWorkflowV2SourceSchema>;

const fieldReviewRequirementSchema = z.object({
  required: z.boolean(),
  reasons: z.array(z.string().max(500)).max(20),
  evidenceRefs: z.array(refSchema).max(100),
}).strict();
const staffReviewSchema = z.object({ status: z.enum(['pending', 'accepted', 'flagged']),
  note: z.string().max(1000).nullable(), at: z.string().datetime({ offset: true }).nullable() }).strict();
const operationResultSchema = z.object({
  id: refSchema,
  generationId: z.string().uuid(),
  requestId: idSchema,
  allocationId: idSchema.nullable(),
  workflow: z.enum(['create', 'quote', 'amend', 'cancel', 'services', 'filing', 'guest_profile']),
  status: z.enum(['prepared', 'succeeded', 'failed', 'unknown']),
  draftRevision: z.number().int().nonnegative(),
  observationRefs: z.array(refSchema).max(100),
  updatedAt: z.string().datetime({ offset: true }),
  summary: z.string().max(2000).nullable(),
}).strict();
export const reservationWorkflowV2FieldOverrideSchema = z.object({
  state: z.enum(['set', 'none', 'unknown', 'inherit', 'clear']),
  value: z.unknown().optional(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type ReservationWorkflowV2FieldOverride = z.infer<typeof reservationWorkflowV2FieldOverrideSchema>;

/** Single canonical state JSONB value stored on WorkItem; extraction/prefill never writes into pane-owned overrides. */
export const reservationWorkflowV2DraftSchema = z.object({
  contractVersion: z.literal(RESERVATION_WORKFLOW_V2_VERSION),
  schemaVersion: z.literal(RESERVATION_PREFILL_SCHEMA_VERSION),
  workItemId: z.string().uuid(),
  transportId: z.string().min(1).max(200),
  propertyCode: propertyCodeSchema,
  source: reservationWorkflowV2SourceSchema,
  generationId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  status: z.enum(['ready', 'partial', 'prefill_failed']),
  extraction: reservationWorkflowV2ExtractionSchema.optional(),
  extractionGenerationId: z.string().uuid().optional(),
  proposal: storedProposalSchema,
  observations: z.array(reservationWorkflowV2ObservationSchema).max(5000),
  fieldReviewRequirements: z.record(fieldReviewRequirementSchema),
  staffReviews: z.record(staffReviewSchema),
  /** Native results are separate from editable history and cannot be rolled back by undo. */
  operationResults: z.array(operationResultSchema).max(2000),
  /** Staff-only leaf overrides; value envelopes preserve set/none/unknown/inherit/clear distinctly. */
  fieldOverrides: z.record(reservationWorkflowV2FieldOverrideSchema),
  errors: z.array(z.object({ stage: z.enum(['extract', 'lookup', 'synthesis', 'persist']),
    code: z.string().min(1).max(100), message: z.string().max(1000) }).strict()).max(100),
  prefill: z.object({ status: z.enum(['idle', 'queued', 'running', 'complete', 'failed', 'superseded']),
    jobRunId: z.string().optional(),
    evidenceHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    phase: z.enum(['generation', 'native_checks', 'complete']).optional(),
    nativeStartedAt: z.string().datetime({ offset: true }).optional(),
    nativeSpentMs: z.number().int().min(0).max(420000).optional(),
    nativeActive: z.object({ key: z.string().min(1).max(200), startedAt: z.string().datetime({ offset: true }) }).strict().nullable().optional(),
    nativeChecks: z.array(z.object({ key: z.string().min(1).max(200), status: z.string().min(1).max(50),
      issue: z.string().max(500).nullable() }).strict()).max(2000).optional(),
    attemptId: z.string().uuid().nullable(), attemptCount: z.number().int().min(0).max(2),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    finishedAt: z.string().datetime({ offset: true }).nullable() }).strict().optional(),
}).strict();
export type ReservationWorkflowV2Draft = z.infer<typeof reservationWorkflowV2DraftSchema>;

// Native, derived and staff-only Create fields are filled after synthesis.
const modelBookingFieldsSchema = bookingFieldsSchema.omit({ mealPlan: true, roomType: true,
  roomTypeForCharge: true, ratePlan: true, bookingAgency: true, organization: true, arAccount: true,
  guaranteeType: true, taCommission: true, sourceOfBusiness: true, reasonForStay: true, track: true, marketSegment: true,
  guestOptIn: true, cmsSend: true, cmsMessageId: true, cmsRecipient: true });
const modelCreateBodySchema = createBodySchema.extend({
  shared: modelBookingFieldsSchema,
  dateSections: z.array(createBodySchema.shape.dateSections.element.extend({ defaults: modelBookingFieldsSchema })).max(100),
  allocations: z.array(createBodySchema.shape.allocations.element.extend({ overrides: modelBookingFieldsSchema })).max(100),
});
const modelMoneyRequestSchema = moneyRequestSchema.omit({ staffAllowanceType: true });
const modelQuoteGroupSchema = quoteBodySchema.shape.groups.element.omit({ mealPlan: true })
  .transform((group) => ({ ...group, mealPlan: null }));
const modelQuoteBodySchema = quoteBodySchema.extend({ groups: z.array(modelQuoteGroupSchema).max(100),
  requestedMoney: z.array(modelMoneyRequestSchema).max(100) });
const modelServiceRequestSchema = serviceRequestSchema.extend({ requestedMoney: z.array(modelMoneyRequestSchema).max(100) });
const modelRequestSchema = z.discriminatedUnion('kind', [requestSchema.options[0].extend({ body: modelQuoteBodySchema }),
  requestSchema.options[1].extend({ body: modelCreateBodySchema }),
  requestSchema.options[2].extend({ body: amendBodySchema.omit({ sourceCues: true }) }),
  requestSchema.options[3], requestSchema.options[4], requestSchema.options[5], requestSchema.options[6].extend({
    body: requestSchema.options[6].shape.body.extend({
      separatedFrom: z.object({ requestId: idSchema, moneyId: idSchema }).strict().optional(),
    }),
  })]);
const modelProposalSchema = reservationWorkflowV2ProposalSchema.extend({
  content: reservationWorkflowV2ProposalSchema.shape.content.extend({ requests: z.array(modelRequestSchema).max(200),
    services: z.array(modelServiceRequestSchema).max(200) }),
});
/** A model's first-pass output is evidence-only: it cannot author host observations or staff state. */
export const reservationWorkflowV2ModelOutputSchema = z.object({
  proposal: modelProposalSchema,
  reviewRequirements: z.record(fieldReviewRequirementSchema).optional(),
}).strict();
export type ReservationWorkflowV2ModelOutput = z.infer<typeof reservationWorkflowV2ModelOutputSchema>;

export type ReservationWorkflowV2ApiSource = ReservationWorkflowV2Source;
export const reservationWorkflowV2EnsureInputSchema = z.object({
  /** Optional display/routing convenience only; canonical messageId on `source` is authoritative. */
  internetMessageId: z.string().min(1).max(998).nullable().optional(),
  source: reservationWorkflowV2SourceSchema,
  propertySwitch: propertySwitchSchema.optional(),
  mode: z.enum(['initialize', 'prefill']).optional(),
}).strict();
export type ReservationWorkflowV2EnsureInput = z.infer<typeof reservationWorkflowV2EnsureInputSchema>;
export const reservationWorkflowV2ItemInputSchema = z.object({
  workItemId: z.string().uuid(), source: reservationWorkflowV2SourceSchema,
  propertySwitch: propertySwitchSchema.optional(),
  expectedRevision: z.number().int().nonnegative(), expectedSeq: z.number().int().nonnegative(),
}).strict();
export type ReservationWorkflowV2ItemInput = z.infer<typeof reservationWorkflowV2ItemInputSchema>;
export const reservationWorkflowV2AddActionInputSchema = reservationWorkflowV2ItemInputSchema.extend({
  kind: z.enum(['create', 'quote', 'amend', 'cancel', 'services', 'filing']),
}).strict();
export const reservationWorkflowV2ChangeRowsInputSchema = reservationWorkflowV2ItemInputSchema.extend({
  kind: z.enum(['add_allocation', 'remove_allocation', 'move_allocation', 'add_date_section', 'remove_date_section',
    'add_quote_group', 'remove_quote_group', 'add_quote_extra', 'remove_quote_extra', 'add_target', 'remove_target', 'add_service', 'remove_service',
    'add_document', 'remove_document', 'remove_action', 'separate_quote_money', 'split_quote_dates',
    'separate_filing_target', 'separate_cancel_target', 'link_created_addon_target']),
  requestId: idSchema, parentId: idSchema.optional(), entityId: idSchema.optional(), childIds: z.array(idSchema).max(200).optional(),
  targetHintId: idSchema.optional(), documentId: idSchema.optional(),
  targetDisposition: z.enum(['included', 'excluded']).optional(), allocationId: idSchema.optional(), serviceId: idSchema.optional(),
}).strict().superRefine((input, ctx) => {
  const special = ['targetHintId', 'documentId', 'targetDisposition', 'allocationId', 'serviceId'] as const;
  const present = (key: typeof special[number]) => input[key] !== undefined;
  const invalidGeneric = input.parentId !== undefined || input.entityId !== undefined || input.childIds !== undefined;
  if (input.kind === 'separate_filing_target') {
    if (!present('targetHintId') || !present('documentId') || !present('targetDisposition') ||
        present('allocationId') || present('serviceId') || invalidGeneric) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Filing split requires one exact document, target and disposition.' });
    }
  } else if (input.kind === 'separate_cancel_target') {
    if (!input.entityId || present('targetHintId') || present('documentId') || present('targetDisposition') ||
        present('allocationId') || present('serviceId') || input.parentId !== undefined || input.childIds !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Cancel split requires one exact included stay.' });
    }
  } else if (input.kind === 'link_created_addon_target') {
    if (!present('allocationId') || !present('serviceId') || present('targetHintId') || present('documentId') ||
        present('targetDisposition') || invalidGeneric) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Create Add-On link requires one exact allocation and service.' });
    }
  } else if (special.some(present)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Target-link fields are valid only for their matching command.' });
  }
});
export const reservationWorkflowV2SelectNativeInputSchema = reservationWorkflowV2ItemInputSchema.extend({
  requestId: idSchema, fieldPath: z.string().min(1).max(300), observationRef: refSchema,
}).strict();
export const reservationWorkflowV2ReviewScopeInputSchema = reservationWorkflowV2ItemInputSchema.extend({
  requestId: idSchema, scope: z.enum(['request', 'allocations', 'targets', 'services', 'documents']),
  ids: z.array(idSchema).max(200),
}).strict();
export const reservationWorkflowV2EditInputSchema = reservationWorkflowV2ItemInputSchema.extend({
  fieldPath: z.string().min(1).max(300), value: z.unknown(),
}).strict();
export type ReservationWorkflowV2EditInput = z.infer<typeof reservationWorkflowV2EditInputSchema>;
export const reservationWorkflowV2ReviewInputSchema = reservationWorkflowV2ItemInputSchema.extend({
  fieldPath: z.string().min(1).max(300), decision: z.enum(['accepted', 'flagged']), note: z.string().max(1000).nullable().optional(),
}).strict();
export type ReservationWorkflowV2ReviewInput = z.infer<typeof reservationWorkflowV2ReviewInputSchema>;
export const reservationWorkflowV2LookupInputSchema = reservationWorkflowV2ItemInputSchema.extend({
  requestId: idSchema.optional(), nativeFieldPath: z.string().min(1).max(300).optional(),
}).strict();
export type ReservationWorkflowV2LookupInput = z.infer<typeof reservationWorkflowV2LookupInputSchema>;
export const reservationWorkflowV2PrepareInputSchema = reservationWorkflowV2ItemInputSchema.extend({
  requestId: idSchema, allocationId: idSchema.optional(),
}).strict();
export type ReservationWorkflowV2PrepareInput = z.infer<typeof reservationWorkflowV2PrepareInputSchema>;
export const reservationWorkflowV2GuestPrepareInputSchema = reservationWorkflowV2PrepareInputSchema.extend({
  allocationId: idSchema, confirmDuplicateName: z.boolean().optional(),
}).strict();
export const reservationWorkflowV2GuestCreateInputSchema = reservationWorkflowV2GuestPrepareInputSchema.extend({
  go: z.literal(true), idempotencyKey: z.string().uuid(), prepareRef: refSchema,
}).strict();
export const reservationWorkflowV2ExecuteInputSchema = reservationWorkflowV2PrepareInputSchema.extend({
  go: z.literal(true), idempotencyKey: z.string().uuid(),
}).strict();
export type ReservationWorkflowV2ExecuteInput = z.infer<typeof reservationWorkflowV2ExecuteInputSchema>;
export const reservationWorkflowV2ReconcileInputSchema = reservationWorkflowV2ItemInputSchema.extend({
  operationId: z.string().min(1).max(200),
}).strict();
export type ReservationWorkflowV2ReconcileInput = z.infer<typeof reservationWorkflowV2ReconcileInputSchema>;

