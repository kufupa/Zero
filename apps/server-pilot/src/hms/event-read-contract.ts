import { z } from 'zod';

export const EVENT_READ_MAX_ITEMS = 50;
export const EVENT_READ_MAX_BYTES = 32 * 1024;
export const EVENT_READ_MAX_DURATION_MS = 5_000;
export const EVENT_READ_MAX_SOURCE_AGE_MS = 5 * 60 * 1_000;

export const EVENT_READ_PRIVACY_POLICY = {
  allowedSurfaces: ['Event Reservation List'],
  deniedData: ['contact', 'notes', 'private_item_description'],
  deniedActions: [
    'save',
    'create',
    'amend',
    'copy',
    'cancel',
    'calculate',
    'post',
    'print',
    'contact_read',
    'notes_read',
    'detail_double_click',
    'beo_generate',
    'pro_forma_generate',
  ],
} as const;

/**
 * Live blocker — view_only Group Sales menu lacks Events / Event Reservation;
 * heuristic event function opens return 400. Observed 2026-08-06 (Task 17).
 */
export const EVENT_READ_SURFACE_BLOCKER = 'BLOCKED_EVENT_READ_SURFACE_UNPROVEN';

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const isoTimestamp = z.string().datetime();
const currencyCode = z.string().regex(/^[A-Z]{3}$/);
const money = z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/);
const eventStatusSchema = z.enum(['inquiry', 'tentative', 'confirmed', 'cancelled', 'completed']);
const recipientClassSchema = z.enum([
  'authorized_event_contact',
  'internal_events',
  'linked_group_contact',
  'third_party',
  'unknown',
]);
const inquiryClassSchema = z.enum([
  'existing_event_status',
  'quote_request',
  'create_request',
  'amend_request',
  'beo_request',
  'pro_forma_request',
  'other',
]);
const itemSummarySchema = z
  .object({
    itemClass: z.enum(['venue', 'catering', 'equipment', 'accommodation', 'other_approved']),
    count: z.number().int().min(0),
    total: money,
  })
  .strict();

export function eventSummaryClaimEligibility(
  recipientClass: z.infer<typeof recipientClassSchema>,
  inquiryClass: z.infer<typeof inquiryClassSchema>,
): 'full' | 'partial' | 'blocked' {
  if (recipientClass === 'third_party' || recipientClass === 'unknown') {
    return 'blocked';
  }
  return inquiryClass === 'existing_event_status' ? 'full' : 'partial';
}

export const eventReadDataSchema = z
  .object({
    eventBinding: z.literal('exact_reference_redacted'),
    eventStatus: eventStatusSchema,
    eventTypeClass: z.string().min(1).max(64),
    startAt: isoTimestamp,
    endAt: isoTimestamp,
    layoutClass: z.string().min(1).max(64).nullable(),
    attendeeCount: z.number().int().min(0),
    setupMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .nullable(),
    teardownMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .nullable(),
    approvedItemSummary: z.array(itemSummarySchema).max(EVENT_READ_MAX_ITEMS),
    currency: currencyCode,
    total: money,
    linkedGroupClass: z.enum(['group_block', 'none', 'unknown']),
    linkedAccountClass: z.enum(['company', 'agency', 'none', 'unknown']),
    depositStatus: z.enum(['not_required', 'due', 'partial', 'paid', 'unknown']),
    disclosure: z
      .object({
        recipientClass: recipientClassSchema,
        inquiryClass: inquiryClassSchema,
        claimEligibility: z.enum(['full', 'partial', 'blocked']),
      })
      .strict(),
    observedAt: isoTimestamp,
  })
  .strict();

export type EventReadData = z.infer<typeof eventReadDataSchema>;

// Normal executor payload preserves HMS source identity and separate deposit
// facts; the older fixture kernel remains unchanged below.
export { eventContextDataSchema, type EventContextData } from './context-read-contracts.js';

const privateFieldsSchema = z
  .object({
    contactName: z.string().optional(),
    contactEmail: z.string().optional(),
    notes: z.string().optional(),
    itemDescription: z.string().optional(),
  })
  .strict();

export const eventReadFixtureInputSchema = z
  .object({
    candidate: z
      .object({
        exactEventReferenceHash: sha256Hex,
        observedEventReferenceHash: sha256Hex,
      })
      .strict(),
    roleProof: z
      .object({
        schemaVersion: z.literal(2),
        credentialMode: z.enum(['view_only', 'write_capable']),
        eventSummaryRead: z.boolean(),
        allowedSurfaces: z.array(z.string().min(1)),
        deniedActions: z.array(z.string().min(1)),
        issuedAt: isoTimestamp,
        expiresAt: isoTimestamp,
      })
      .strict(),
    surfaceProof: z
      .object({
        listOnly: z.boolean(),
        exactSearchProven: z.boolean(),
        requiredSummaryPresentInList: z.boolean(),
        detailNavigationUsed: z.boolean(),
        detailNavigationProvenInert: z.boolean(),
        reviewedRequestManifest: z.boolean(),
        mutationEventsObserved: z.array(
          z.enum(['double_click', 'calculate', 'post', 'copy', 'cancel', 'print', 'save']),
        ),
      })
      .strict(),
    eventStatus: eventStatusSchema.nullable(),
    eventTypeClass: z.string().min(1).max(64).nullable(),
    startAt: isoTimestamp.nullable(),
    endAt: isoTimestamp.nullable(),
    layoutClass: z.string().min(1).max(64).nullable(),
    attendeeCount: z.number().int().min(0).nullable(),
    setupMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .nullable(),
    teardownMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .nullable(),
    approvedItemSummary: z.array(itemSummarySchema).max(EVENT_READ_MAX_ITEMS),
    currency: currencyCode.nullable(),
    total: money.nullable(),
    linkedGroupClass: z.enum(['group_block', 'none', 'unknown']),
    linkedAccountClass: z.enum(['company', 'agency', 'none', 'unknown']),
    depositStatus: z.enum(['not_required', 'due', 'partial', 'paid', 'unknown']),
    recipientClass: recipientClassSchema,
    inquiryClass: inquiryClassSchema,
    observedAt: isoTimestamp,
    evaluatedAt: isoTimestamp,
    durationMs: z.number().int(),
    bytesObserved: z.number().int(),
    privateFields: privateFieldsSchema.optional(),
  })
  .strict();

export type EventReadFixtureInput = z.input<typeof eventReadFixtureInputSchema>;

export type EventReadKernelResult = {
  status: 'ok' | 'unverified_negative' | 'manual_required';
  data: EventReadData | null;
  blocker: string | null;
};

function fail(blocker: string): EventReadKernelResult {
  return { status: 'manual_required', data: null, blocker };
}

function cents(value: string): bigint {
  const [whole, fraction] = value.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction!);
}

export function parseEventReadFixture(rawInput: EventReadFixtureInput): EventReadKernelResult {
  const parsed = eventReadFixtureInputSchema.safeParse(rawInput);
  if (!parsed.success) return fail('EVENT_CONTRACT_OR_SCHEMA_DRIFT');
  const input = parsed.data;

  if (input.candidate.exactEventReferenceHash !== input.candidate.observedEventReferenceHash) {
    return fail('EVENT_EXACT_REFERENCE_MISMATCH');
  }

  const evaluatedAt = Date.parse(input.evaluatedAt);
  const observedAt = Date.parse(input.observedAt);
  const roleIssuedAt = Date.parse(input.roleProof.issuedAt);
  const roleExpiresAt = Date.parse(input.roleProof.expiresAt);
  const surfacesProven = EVENT_READ_PRIVACY_POLICY.allowedSurfaces.every((surface) =>
    input.roleProof.allowedSurfaces.includes(surface),
  );
  const actionsDenied = EVENT_READ_PRIVACY_POLICY.deniedActions.every((action) =>
    input.roleProof.deniedActions.includes(action),
  );
  if (
    input.roleProof.credentialMode !== 'view_only' ||
    !input.roleProof.eventSummaryRead ||
    !surfacesProven ||
    !actionsDenied ||
    roleIssuedAt > evaluatedAt ||
    roleExpiresAt <= evaluatedAt
  ) {
    return fail('BLOCKED_NO_EVENT_READ_ROLE_PROOF_V2');
  }

  if (input.surfaceProof.mutationEventsObserved.length > 0) {
    return fail('BLOCKED_EVENT_MUTATION_RISK');
  }
  if (
    !input.surfaceProof.listOnly ||
    !input.surfaceProof.exactSearchProven ||
    !input.surfaceProof.requiredSummaryPresentInList ||
    input.surfaceProof.detailNavigationUsed ||
    !input.surfaceProof.reviewedRequestManifest
  ) {
    return fail('BLOCKED_EVENT_READ_SURFACE_UNPROVEN');
  }

  if (
    input.durationMs < 0 ||
    input.durationMs > EVENT_READ_MAX_DURATION_MS ||
    input.bytesObserved < 0 ||
    input.bytesObserved > EVENT_READ_MAX_BYTES
  ) {
    return fail('EVENT_READ_BOUNDS_EXCEEDED');
  }
  const age = evaluatedAt - observedAt;
  if (age < 0 || age > EVENT_READ_MAX_SOURCE_AGE_MS) {
    return fail('EVENT_READ_SOURCE_STALE');
  }

  if (
    input.eventStatus === null ||
    input.eventTypeClass === null ||
    input.startAt === null ||
    input.endAt === null ||
    input.attendeeCount === null ||
    input.currency === null ||
    input.total === null
  ) {
    return {
      status: 'unverified_negative',
      data: null,
      blocker: 'UNVERIFIED_NEGATIVE',
    };
  }

  if (Date.parse(input.endAt) < Date.parse(input.startAt)) {
    return fail('EVENT_DATE_OR_COUNT_INCONSISTENT');
  }
  const itemTotal = input.approvedItemSummary.reduce((sum, item) => sum + cents(item.total), 0n);
  if (itemTotal !== cents(input.total)) {
    return fail('EVENT_CURRENCY_OR_TOTAL_INCONSISTENT');
  }

  const data = eventReadDataSchema.parse({
    eventBinding: 'exact_reference_redacted',
    eventStatus: input.eventStatus,
    eventTypeClass: input.eventTypeClass,
    startAt: input.startAt,
    endAt: input.endAt,
    layoutClass: input.layoutClass,
    attendeeCount: input.attendeeCount,
    setupMinutes: input.setupMinutes,
    teardownMinutes: input.teardownMinutes,
    approvedItemSummary: input.approvedItemSummary,
    currency: input.currency,
    total: input.total,
    linkedGroupClass: input.linkedGroupClass,
    linkedAccountClass: input.linkedAccountClass,
    depositStatus: input.depositStatus,
    disclosure: {
      recipientClass: input.recipientClass,
      inquiryClass: input.inquiryClass,
      claimEligibility: eventSummaryClaimEligibility(input.recipientClass, input.inquiryClass),
    },
    observedAt: input.observedAt,
  });
  return { status: 'ok', data, blocker: null };
}

export const eventSummaryClaimValueSchema = z
  .object({
    eventStatus: eventStatusSchema,
    eventTypeClass: z.string().min(1).max(64),
    startAt: isoTimestamp,
    endAt: isoTimestamp,
    attendeeCount: z.number().int().min(0),
    currency: currencyCode,
    total: money,
    depositStatus: z.enum(['not_required', 'due', 'partial', 'paid', 'unknown']),
    responseCredit: z.enum(['full_existing_event_status', 'partial_status_only']),
    observedAt: isoTimestamp,
  })
  .strict();

export type EventSummaryClaimValue = z.infer<typeof eventSummaryClaimValueSchema>;

export function mapEventSummaryClaim(data: EventReadData): EventSummaryClaimValue | null {
  const parsed = eventReadDataSchema.parse(data);
  const eligibility = eventSummaryClaimEligibility(
    parsed.disclosure.recipientClass,
    parsed.disclosure.inquiryClass,
  );
  if (eligibility === 'blocked') return null;
  return eventSummaryClaimValueSchema.parse({
    eventStatus: parsed.eventStatus,
    eventTypeClass: parsed.eventTypeClass,
    startAt: parsed.startAt,
    endAt: parsed.endAt,
    attendeeCount: parsed.attendeeCount,
    currency: parsed.currency,
    total: parsed.total,
    depositStatus: parsed.depositStatus,
    responseCredit: eligibility === 'full' ? 'full_existing_event_status' : 'partial_status_only',
    observedAt: parsed.observedAt,
  });
}
