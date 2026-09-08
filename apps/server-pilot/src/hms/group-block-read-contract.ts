import { z } from 'zod';

export const GROUP_BLOCK_READ_MAX_DAYS = 31;
export const GROUP_BLOCK_READ_MAX_ROWS = 100;
export const GROUP_BLOCK_READ_MAX_BYTES = 32 * 1024;
export const GROUP_BLOCK_READ_MAX_DURATION_MS = 5_000;
export const GROUP_BLOCK_READ_MAX_SOURCE_AGE_MS = 5 * 60 * 1_000;

export const GROUP_BLOCK_READ_PRIVACY_POLICY = {
  allowedSurfaces: ['Group Booking', 'Subgroup Room Blocks'],
  deniedData: [
    'delegate_identity',
    'rooming_list_identity',
    'notes',
    'rates',
    'billing_instructions',
  ],
  deniedActions: [
    'save',
    'create',
    'amend',
    'assign',
    'release',
    'rooming_list',
    'block_tab_direct_entry',
    'quick_entry',
    'room_assignment',
    'document_tabs',
    'focus',
    'input',
    'change',
    'blur',
  ],
} as const;

/**
 * Live blocker — GSGRPB.LST has exact ref/status/dates but lacks
 * con/blk/pickup/remaining/restriction rows; BLK tab empty without detail load.
 * Observed 2026-08-06 (Task 17 discovery phases 4–6).
 */
export const GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER = 'BLOCKED_GROUP_BLOCK_AGGREGATE_COUNTS_UNPROVEN';

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoTimestamp = z.string().datetime();
const recipientClassSchema = z.enum([
  'authorized_group_contact',
  'internal_groups',
  'reservation_guest',
  'third_party',
  'unknown',
]);
const inquiryClassSchema = z.enum([
  'existing_group_status',
  'create_request',
  'amend_request',
  'allocation_action',
  'other',
]);
const groupStatusSchema = z.enum(['inquiry', 'tentative', 'definite', 'cancelled', 'closed']);
const restrictionSchema = z.enum([
  'closed_to_arrival',
  'closed_to_departure',
  'minimum_stay',
  'maximum_stay',
  'stop_sell',
]);

export function groupBlockClaimEligibility(
  recipientClass: z.infer<typeof recipientClassSchema>,
  inquiryClass: z.infer<typeof inquiryClassSchema>,
): 'full' | 'partial' | 'blocked' {
  if (recipientClass === 'third_party' || recipientClass === 'unknown') {
    return 'blocked';
  }
  return inquiryClass === 'existing_group_status' ? 'full' : 'partial';
}

const groupBlockRowSchema = z
  .object({
    date: isoDate,
    roomTypeClass: z.string().min(1).max(64),
    con: z.number().int().min(0),
    blk: z.number().int().min(0),
    pickup: z.number().int().min(0),
    remaining: z.number().int().min(0),
    restrictions: z.array(restrictionSchema).max(8),
  })
  .strict();

export const groupBlockReadDataSchema = z
  .object({
    groupBinding: z.literal('exact_reference_redacted'),
    groupStatus: groupStatusSchema,
    startDate: isoDate,
    endDate: isoDate,
    rows: z.array(groupBlockRowSchema).min(1).max(GROUP_BLOCK_READ_MAX_ROWS),
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

export type GroupBlockReadData = z.infer<typeof groupBlockReadDataSchema>;

// Normal executor payload: summary, blocks, and delegates remain independent
// sections with field-level known/unknown evidence.
export {
  groupBlockContextDataSchema,
  groupBlockRowsDataSchema,
  groupBlockSummaryDataSchema,
  groupDelegatesDataSchema,
  type GroupBlockContextData,
} from './context-read-contracts.js';

const privateFieldsSchema = z
  .object({
    delegateName: z.string().optional(),
    roomingListIdentity: z.string().optional(),
    notes: z.string().optional(),
    rate: z.string().optional(),
    billingInstructions: z.string().optional(),
  })
  .strict();

export const groupBlockReadFixtureInputSchema = z
  .object({
    candidate: z
      .object({
        exactGroupReferenceHash: sha256Hex,
        observedGroupReferenceHash: sha256Hex,
        startDate: isoDate,
        endDate: isoDate,
      })
      .strict(),
    roleProof: z
      .object({
        schemaVersion: z.literal(2),
        credentialMode: z.enum(['view_only', 'write_capable']),
        groupBlockRead: z.boolean(),
        allowedSurfaces: z.array(z.string().min(1)),
        deniedActions: z.array(z.string().min(1)),
        issuedAt: isoTimestamp,
        expiresAt: isoTimestamp,
      })
      .strict(),
    surfaceProof: z
      .object({
        exactSearchProven: z.boolean(),
        conSemanticsProven: z.boolean(),
        blkSemanticsProven: z.boolean(),
        pickupSemanticsProven: z.boolean(),
        remainingSemanticsProven: z.boolean(),
        restrictionSemanticsProven: z.boolean(),
        reviewedRequestManifest: z.boolean(),
        editEventsObserved: z.array(z.enum(['focus', 'input', 'change', 'blur'])),
      })
      .strict(),
    groupStatus: groupStatusSchema,
    rows: z.array(groupBlockRowSchema).max(GROUP_BLOCK_READ_MAX_ROWS),
    recipientClass: recipientClassSchema,
    inquiryClass: inquiryClassSchema,
    observedAt: isoTimestamp,
    evaluatedAt: isoTimestamp,
    durationMs: z.number().int(),
    bytesObserved: z.number().int(),
    privateFields: privateFieldsSchema.optional(),
  })
  .strict();

export type GroupBlockReadFixtureInput = z.input<typeof groupBlockReadFixtureInputSchema>;

export type GroupBlockReadKernelResult = {
  status: 'ok' | 'unverified_negative' | 'manual_required';
  data: GroupBlockReadData | null;
  blocker: string | null;
};

function fail(blocker: string): GroupBlockReadKernelResult {
  return { status: 'manual_required', data: null, blocker };
}

function dayNumber(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

export function parseGroupBlockReadFixture(
  rawInput: GroupBlockReadFixtureInput,
): GroupBlockReadKernelResult {
  const parsed = groupBlockReadFixtureInputSchema.safeParse(rawInput);
  if (!parsed.success) return fail('GROUP_BLOCK_CONTRACT_OR_SCHEMA_DRIFT');
  const input = parsed.data;

  if (input.candidate.exactGroupReferenceHash !== input.candidate.observedGroupReferenceHash) {
    return fail('GROUP_BLOCK_EXACT_REFERENCE_MISMATCH');
  }

  const start = dayNumber(input.candidate.startDate);
  const end = dayNumber(input.candidate.endDate);
  const days = (end - start) / 86_400_000;
  if (!Number.isInteger(days) || days < 0 || days > GROUP_BLOCK_READ_MAX_DAYS) {
    return fail('GROUP_BLOCK_DATE_WINDOW_INVALID');
  }

  const evaluatedAt = Date.parse(input.evaluatedAt);
  const observedAt = Date.parse(input.observedAt);
  const roleIssuedAt = Date.parse(input.roleProof.issuedAt);
  const roleExpiresAt = Date.parse(input.roleProof.expiresAt);
  const surfacesProven = GROUP_BLOCK_READ_PRIVACY_POLICY.allowedSurfaces.every((surface) =>
    input.roleProof.allowedSurfaces.includes(surface),
  );
  const actionsDenied = GROUP_BLOCK_READ_PRIVACY_POLICY.deniedActions.every((action) =>
    input.roleProof.deniedActions.includes(action),
  );
  if (
    input.roleProof.credentialMode !== 'view_only' ||
    !input.roleProof.groupBlockRead ||
    !surfacesProven ||
    !actionsDenied ||
    roleIssuedAt > evaluatedAt ||
    roleExpiresAt <= evaluatedAt
  ) {
    return fail('BLOCKED_NO_GROUP_BLOCK_ROLE_PROOF_V2');
  }

  if (input.surfaceProof.editEventsObserved.length > 0) {
    return fail('BLOCKED_GROUP_BLOCK_MUTATION_RISK');
  }
  if (
    !input.surfaceProof.exactSearchProven ||
    !input.surfaceProof.conSemanticsProven ||
    !input.surfaceProof.blkSemanticsProven ||
    !input.surfaceProof.pickupSemanticsProven ||
    !input.surfaceProof.remainingSemanticsProven ||
    !input.surfaceProof.restrictionSemanticsProven ||
    !input.surfaceProof.reviewedRequestManifest
  ) {
    return fail('BLOCKED_GROUP_BLOCK_SURFACE_UNPROVEN');
  }

  if (
    input.durationMs < 0 ||
    input.durationMs > GROUP_BLOCK_READ_MAX_DURATION_MS ||
    input.bytesObserved < 0 ||
    input.bytesObserved > GROUP_BLOCK_READ_MAX_BYTES
  ) {
    return fail('GROUP_BLOCK_BOUNDS_EXCEEDED');
  }
  const age = evaluatedAt - observedAt;
  if (age < 0 || age > GROUP_BLOCK_READ_MAX_SOURCE_AGE_MS) {
    return fail('GROUP_BLOCK_SOURCE_STALE');
  }

  if (input.rows.length === 0) {
    return {
      status: 'unverified_negative',
      data: null,
      blocker: 'UNVERIFIED_NEGATIVE',
    };
  }
  for (const row of input.rows) {
    const rowDate = dayNumber(row.date);
    if (rowDate < start || rowDate > end) {
      return fail('GROUP_BLOCK_ROW_OUTSIDE_DATE_WINDOW');
    }
    if (row.blk > row.con || row.pickup > row.blk || row.remaining !== row.blk - row.pickup) {
      return fail('GROUP_BLOCK_COUNT_INCONSISTENT');
    }
  }

  const data = groupBlockReadDataSchema.parse({
    groupBinding: 'exact_reference_redacted',
    groupStatus: input.groupStatus,
    startDate: input.candidate.startDate,
    endDate: input.candidate.endDate,
    rows: input.rows,
    disclosure: {
      recipientClass: input.recipientClass,
      inquiryClass: input.inquiryClass,
      claimEligibility: groupBlockClaimEligibility(input.recipientClass, input.inquiryClass),
    },
    observedAt: input.observedAt,
  });
  return { status: 'ok', data, blocker: null };
}

export const groupBlockClaimValueSchema = z
  .object({
    groupStatus: groupStatusSchema,
    startDate: isoDate,
    endDate: isoDate,
    rows: z.array(groupBlockRowSchema).min(1).max(GROUP_BLOCK_READ_MAX_ROWS),
    responseCredit: z.enum(['full_existing_group_status', 'partial_status_only']),
    observedAt: isoTimestamp,
  })
  .strict();

export type GroupBlockClaimValue = z.infer<typeof groupBlockClaimValueSchema>;

export function mapGroupBlockClaim(data: GroupBlockReadData): GroupBlockClaimValue | null {
  const parsed = groupBlockReadDataSchema.parse(data);
  const eligibility = groupBlockClaimEligibility(
    parsed.disclosure.recipientClass,
    parsed.disclosure.inquiryClass,
  );
  if (eligibility === 'blocked') return null;
  return groupBlockClaimValueSchema.parse({
    groupStatus: parsed.groupStatus,
    startDate: parsed.startDate,
    endDate: parsed.endDate,
    rows: parsed.rows,
    responseCredit: eligibility === 'full' ? 'full_existing_group_status' : 'partial_status_only',
    observedAt: parsed.observedAt,
  });
}
