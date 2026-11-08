import { z } from 'zod';

/** Wire contract for the source-bound reservation draft. No runtime/database imports. */
export const RESERVATION_WORKFLOW_V2_VERSION = 2 as const;
export const RESERVATION_PREFILL_SCHEMA_VERSION = 'reservation-prefill.v0.2' as const;

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
const partyHintSchema = z.object({ role: z.enum(['agency', 'organization', 'ar_account']),
  name: extractedClaimSchema }).strict();
const prefillRequestFactsSchema = z.object({
  id: idSchema,
  kind: z.enum(['quote', 'create', 'amend', 'cancel', 'services', 'filing', 'other']),
  requestText: extractedClaimSchema,
  dates: z.array(z.object({ arrival: extractedClaimSchema.optional(), departure: extractedClaimSchema.optional() }).strict()).max(100).default([]),
  roomCount: extractedClaimSchema.optional(),
  occupancy: z.array(z.object({ scope: z.enum(['per_room', 'whole_group', 'unknown']),
    adults: extractedClaimSchema.optional(), childCount: extractedClaimSchema.optional(),
    childAges: z.array(extractedClaimSchema).max(12).optional() }).strict()).max(100).default([]),
  guests: z.array(guestHintSchema).max(200).default([]),
  parties: z.array(partyHintSchema).max(100).default([]),
  confirmationHints: z.array(extractedClaimSchema).max(100).default([]),
  roomTypeHints: z.array(extractedClaimSchema).max(100).default([]),
  rateHints: z.array(extractedClaimSchema).max(100).default([]),
  boardHints: z.array(extractedClaimSchema).max(100).default([]),
  serviceHints: z.array(extractedClaimSchema).max(200).default([]),
  documentRefs: z.array(refSchema).max(200).default([]),
}).strict();

/** Typed first pass. Host derives lookups from these cited facts; the model does not author arbitrary queries. */
export const reservationWorkflowV2ExtractionSchema = z.object({
  requests: z.array(prefillRequestFactsSchema).max(200).default([]),
  issues: z.array(z.object({ explanation: z.string().max(1000), sourceRefs: z.array(refSchema).max(20) }).strict()).max(200).default([]),
}).strict();
export type ReservationWorkflowV2Extraction = z.infer<typeof reservationWorkflowV2ExtractionSchema>;
export const reservationWorkflowV2PrefillInputSchema = z.object({
  transportId: z.string().min(1).max(200),
  propertyCode: z.string().min(1).max(80),
  source: z.object({ threadId: z.string().min(1).max(500), messageId: z.string().min(1).max(500),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/), decisionAt: z.string().datetime({ offset: true }) }).strict(),
  evidence: z.array(reservationWorkflowV2EvidenceSchema).max(500),
}).strict();
export type ReservationWorkflowV2PrefillInput = z.infer<typeof reservationWorkflowV2PrefillInputSchema>;

const bookingFieldsSchema = z.object({
  roomType: value(z.string().max(120)).optional(),
  roomTypeForCharge: value(z.string().max(120)).optional(),
  ratePlan: value(z.string().max(120)).optional(),
  bookingAgency: value(partySchema).optional(),
  organization: value(partySchema).optional(),
  arAccount: value(partySchema).optional(),
  guaranteeType: value(z.string().max(120)).optional(),
  sourceOfBusiness: value(z.string().max(120)).optional(),
  reasonForStay: value(z.string().max(500)).optional(),
  billingReference: value(z.string().max(300)).optional(),
  track: value(z.string().max(120)).optional(),
  guestOptIn: value(z.boolean()).optional(),
  bookerName: value(z.string().max(300)).optional(),
  bookerContact: value(z.string().max(500)).optional(),
  reservationNote: value(z.string().max(4000)).optional(),
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
    board: z.string().max(120).nullable(),
    roomCodes: z.array(z.string().max(120)).max(100),
    ratePlan: z.string().max(120).nullable(),
    occupancy: occupancySchema.extend({ scope: z.enum(['per_room', 'whole_group', 'unresolved']) }),
    priceObservationRefs: z.array(refSchema).max(100),
  }).strict()).max(100),
  parties: z.object({ company: value(partySchema).optional(), agency: value(partySchema).optional() }).strict(),
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
  'firstName', 'lastName', 'guestEmail', 'bookerName', 'bookerContact', 'reservationNote', 'cmsSend',
  'cmsMessageId', 'cmsRecipient',
]);
const amendScalarSchema = z.union([
  z.string().max(4000), z.number().int(), z.boolean(), z.array(z.number().int().nullable()).max(12),
]);
const changeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), field: amendFieldSchema, value: amendScalarSchema, sourceRefs: z.array(refSchema).max(100) }).strict(),
  z.object({ op: z.literal('clear'), field: amendFieldSchema, sourceRefs: z.array(refSchema).max(100) }).strict(),
  z.object({ op: z.literal('shift_dates'), days: z.number().int(), sourceRefs: z.array(refSchema).max(100) }).strict(),
  z.object({ op: z.literal('shift_departure'), days: z.number().int(), sourceRefs: z.array(refSchema).max(100) }).strict(),
]);
const amendBodySchema = z.object({
  targets: savedScopeSchema,
  sharedChanges: z.array(changeSchema).max(200),
  perTarget: z.array(z.object({ hintId: idSchema, changes: z.array(changeSchema).max(200),
    rateHandling: z.enum(['retain', 'reprice']).nullable(), currentObservationRefs: z.array(refSchema).max(100) }).strict()).max(100),
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
const filingBodySchema = z.object({ targets: z.union([savedScopeSchema, z.null()]) }).strict();
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
    body: z.object({ requestedText: z.string().max(2000), supported: z.literal(false) }).strict() }).strict(),
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

/** Host-owned evidence. Model output can cite these refs but cannot create or edit registry entries. */
export const reservationWorkflowV2ObservationSchema = z.object({
  ref: refSchema,
  generationId: z.string().uuid(),
  kind: z.enum(['source', 'mail_candidate', 'stay_candidate', 'guest_candidate', 'party_candidate',
    'rate_availability', 'service_preview', 'document']),
  status: z.enum(['complete', 'partial', 'unavailable', 'failed']),
  observedAt: z.string().datetime({ offset: true }),
  propertyCode: z.string().min(1).max(80),
  sourceMessageId: z.string().max(500).nullable(),
  sourceRefs: z.array(refSchema).max(500),
  criteria: z.record(z.unknown()),
  coverage: z.object({ complete: z.boolean(), notes: z.array(z.string().max(500)).max(50) }).strict(),
  result: z.record(z.unknown()),
}).strict();
export type ReservationWorkflowV2Observation = z.infer<typeof reservationWorkflowV2ObservationSchema>;

export const reservationWorkflowV2SourceSchema = z.object({
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
  workflow: z.enum(['create', 'quote', 'amend', 'cancel', 'services', 'filing']),
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
  propertyCode: z.string().min(1).max(80),
  source: reservationWorkflowV2SourceSchema,
  generationId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  status: z.enum(['ready', 'partial', 'prefill_failed']),
  proposal: reservationWorkflowV2ProposalSchema,
  observations: z.array(reservationWorkflowV2ObservationSchema).max(5000),
  fieldReviewRequirements: z.record(fieldReviewRequirementSchema),
  staffReviews: z.record(staffReviewSchema),
  /** Native results are separate from editable history and cannot be rolled back by undo. */
  operationResults: z.array(operationResultSchema).max(2000),
  /** Staff-only leaf overrides; value envelopes preserve set/none/unknown/inherit/clear distinctly. */
  fieldOverrides: z.record(reservationWorkflowV2FieldOverrideSchema),
  errors: z.array(z.object({ stage: z.enum(['extract', 'lookup', 'synthesis', 'persist']),
    code: z.string().min(1).max(100), message: z.string().max(1000) }).strict()).max(100),
  prefill: z.object({ status: z.enum(['idle', 'running', 'complete', 'failed', 'superseded']),
    attemptId: z.string().uuid().nullable(), attemptCount: z.number().int().min(0).max(2),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    finishedAt: z.string().datetime({ offset: true }).nullable() }).strict().optional(),
}).strict();
export type ReservationWorkflowV2Draft = z.infer<typeof reservationWorkflowV2DraftSchema>;

/** A model's first-pass output is evidence-only: it cannot author host observations or staff state. */
export const reservationWorkflowV2ModelOutputSchema = z.object({
  proposal: reservationWorkflowV2ProposalSchema,
  reviewRequirements: z.record(fieldReviewRequirementSchema).optional(),
}).strict();
export type ReservationWorkflowV2ModelOutput = z.infer<typeof reservationWorkflowV2ModelOutputSchema>;

export type ReservationWorkflowV2ApiSource = ReservationWorkflowV2Source;
export const reservationWorkflowV2EnsureInputSchema = z.object({
  /** Optional display/routing convenience only; canonical messageId on `source` is authoritative. */
  internetMessageId: z.string().min(1).max(998).nullable().optional(),
  source: reservationWorkflowV2SourceSchema,
  mode: z.enum(['initialize', 'prefill']).optional(),
}).strict();
export type ReservationWorkflowV2EnsureInput = z.infer<typeof reservationWorkflowV2EnsureInputSchema>;
export const reservationWorkflowV2ItemInputSchema = z.object({
  workItemId: z.string().uuid(), source: reservationWorkflowV2SourceSchema,
  expectedRevision: z.number().int().nonnegative(), expectedSeq: z.number().int().nonnegative(),
}).strict();
export type ReservationWorkflowV2ItemInput = z.infer<typeof reservationWorkflowV2ItemInputSchema>;
export const reservationWorkflowV2AddActionInputSchema = reservationWorkflowV2ItemInputSchema.extend({
  kind: z.enum(['create', 'quote', 'amend', 'cancel', 'services', 'filing']),
}).strict();
export const reservationWorkflowV2ChangeRowsInputSchema = reservationWorkflowV2ItemInputSchema.extend({
  kind: z.enum(['add_allocation', 'remove_allocation', 'move_allocation', 'add_date_section', 'remove_date_section',
    'add_quote_group', 'remove_quote_group', 'add_target', 'remove_target', 'add_service', 'remove_service',
    'add_document', 'remove_document', 'remove_action']),
  requestId: idSchema, parentId: idSchema.optional(), entityId: idSchema.optional(), childIds: z.array(idSchema).max(200).optional(),
}).strict();
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
  requestId: idSchema.optional(),
}).strict();
export type ReservationWorkflowV2LookupInput = z.infer<typeof reservationWorkflowV2LookupInputSchema>;
export const reservationWorkflowV2PrepareInputSchema = reservationWorkflowV2ItemInputSchema.extend({
  requestId: idSchema, allocationId: idSchema.optional(),
}).strict();
export type ReservationWorkflowV2PrepareInput = z.infer<typeof reservationWorkflowV2PrepareInputSchema>;
export const reservationWorkflowV2ExecuteInputSchema = reservationWorkflowV2PrepareInputSchema.extend({
  go: z.literal(true), idempotencyKey: z.string().uuid(),
}).strict();
export type ReservationWorkflowV2ExecuteInput = z.infer<typeof reservationWorkflowV2ExecuteInputSchema>;
export const reservationWorkflowV2ReconcileInputSchema = reservationWorkflowV2ItemInputSchema.extend({
  operationId: z.string().min(1).max(200),
}).strict();
export type ReservationWorkflowV2ReconcileInput = z.infer<typeof reservationWorkflowV2ReconcileInputSchema>;

