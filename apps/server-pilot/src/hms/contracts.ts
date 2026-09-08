/**
 * Docs/corpus-backed HMS capability contract for fail-closed read discovery.
 * Live HMS mutation surfaces stay out of autonomousAllowed / active_read.
 *
 * Phase B tool portfolio registry (versions, caps, promotion state):
 * `./read-tools.ts` (`READ_TOOLS`, `capabilityStateFor`).
 */

import { z } from 'zod';
export {
  documentListReadDataSchema,
  documentMetadataClaimValueSchema,
  documentMetadataRowSchema,
  finalizedTaxInvoiceMetadataSchema,
  mapDocumentMetadataClaim,
  parseDocumentMetadataFixture,
  sentAttachmentMetadataSchema,
  type DocumentListReadData,
  type DocumentMetadataClaimValue,
} from './document-list-contract.js';
export {
  FOLIO_READ_PRIVACY_POLICY,
  folioDepositClaimValueSchema,
  folioReadDataSchema,
  mapFolioDepositClaim,
  parseFolioReadFixture,
  type FolioDepositClaimValue,
  type FolioReadData,
} from './folio-read-contract.js';
import { quoteStayReadDataSchema, type QuoteStayReadData } from './quote-stay-contract.js';
export {
  quoteNightObservationSchema,
  quoteStayReadDataSchema,
  type QuoteNightObservation,
  type QuoteStayReadData,
} from './quote-stay-contract.js';
export {
  normalizeQuoteRequest,
  normalizeQuoteRequestFromAuthoredSegment,
  quoteRequestSchema,
  type QuoteRequest,
  type QuoteRequestNormalization,
} from './quote-request-normalization.js';
export {
  mapSentEmailAuditClaim,
  parseSentEmailAuditFixture,
  sentEmailAuditClaimValueSchema,
  sentEmailAuditReadDataSchema,
  sentEmailAuditRowSchema,
  type SentEmailAuditClaimValue,
  type SentEmailAuditReadData,
} from './sent-email-audit-contract.js';
export {
  DISCOVERY_OPERATION_IDS,
  HMS_READ_TOOL_IDS,
  READ_TOOLS,
  READ_TOOL_IDS,
  ROLE_SURFACE_IDS,
  capabilityStateFor,
  controlOracleDefinitionSchema,
  deriveCapabilityState,
  discoveryOperationIdSchema,
  fingerprintReadToolRegistry,
  hmsReadToolIdSchema,
  listReadToolIds,
  portfolioAblationReplay,
  productionActiveReadToolIds,
  requestBranchDefinitionSchema,
  roleSurfaceIdSchema,
  type CapabilityState,
  type ControlOracleDefinition,
  type DiscoveryOperationId,
  type HmsReadToolId,
  type ReadToolId,
  type RequestBranchDefinition,
  type RoleSurfaceId,
  U15_CONTEXT_READ_TOOL_IDS,
  U15_CONTEXT_DISCOVERY_OPERATION_IDS,
  u15ContextReadToolIdSchema,
  type U15ContextReadToolId,
  type U15ContextDiscoveryOperationId,
} from './read-tools.js';

export type CapabilityRow = {
  id: string;
  officialDocs: string[];
  corpusThreadIds: number[];
  phase: 'active_read' | 'roadmap_read' | 'future_write';
  credentialRequirement: 'documented_read_screen' | 'view_only' | 'human_supervised';
  autonomousAllowed: boolean;
  mutationRisk: string;
  evidenceNeeded: string[];
};

/**
 * Frozen capability matrix rows. Source of truth for discovery allowlist.
 * Keep in sync with docs/infor-hms/capability-matrix.md.
 */
export const CAPABILITY_ROWS: readonly CapabilityRow[] = [
  {
    id: 'login',
    officialDocs: ['https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428565917.html'],
    corpusThreadIds: [],
    phase: 'active_read',
    credentialRequirement: 'documented_read_screen',
    autonomousAllowed: true,
    mutationRisk:
      'auth session only; no PMS mutation on login GET/POST itself beyond session establish',
    evidenceNeeded: [
      'login URL origin matches manifest',
      'tenant/property header verification',
      'redacted gate JSON on unknown request',
    ],
  },
  {
    id: 'reservation-search',
    officialDocs: ['https://docs.infor.com/hms/3.8/en-us/hmsolh/pages/osresv_help.html'],
    corpusThreadIds: [],
    phase: 'active_read',
    credentialRequirement: 'view_only',
    autonomousAllowed: true,
    mutationRisk:
      'Guest Stay list/search read; must not open New Record or Stay Wizard mutate paths',
    evidenceNeeded: [
      'search by confirmation/external ref/bounded surname+date',
      'result ambiguity handling',
      'no create/amend controls exercised',
    ],
  },
  {
    id: 'room-type-rate-availability',
    officialDocs: [
      'https://docs.infor.com/hms/3.8.x/en-us/useradminlist/HMS%203.8.4%20User%20Guide_70179.pdf',
    ],
    corpusThreadIds: [],
    phase: 'active_read',
    credentialRequirement: 'view_only',
    autonomousAllowed: true,
    mutationRisk: 'Single Room Type and Rate Availability read; never CRS Check Availability',
    evidenceNeeded: [
      'one exact search and complete contiguous nightly schedule',
      'available count + displayed nightly amount + currency + restrictions',
      'bookable false; stay total null; occupancy pricing unverified',
    ],
  },
  {
    id: 'crs-check-availability',
    officialDocs: ['https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428583967.html'],
    corpusThreadIds: [],
    phase: 'future_write',
    credentialRequirement: 'human_supervised',
    autonomousAllowed: false,
    mutationRisk:
      'Official CRS docs: Check Availability creates a new reservation record — forbidden for autonomous discovery',
    evidenceNeeded: [
      'fixture-only write validation plan',
      'human-supervised live validation before any production registry entry',
    ],
  },
  {
    id: 'write-forms',
    officialDocs: ['https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428600707.html'],
    corpusThreadIds: [],
    phase: 'future_write',
    credentialRequirement: 'human_supervised',
    autonomousAllowed: false,
    mutationRisk:
      'Property Forms / any submit-save-create-amend-cancel path; mutation prohibited in Wave 1A',
    evidenceNeeded: [
      'synthetic fixture write adapters first',
      'production write requires authorization + idempotency + audit',
    ],
  },
  {
    id: 'sent-email-audit',
    officialDocs: ['https://docs.infor.com/hms/2025.x/en-us/hmsolh/pages/pssnel_help.html'],
    corpusThreadIds: [],
    phase: 'roadmap_read',
    credentialRequirement: 'view_only',
    autonomousAllowed: false,
    mutationRisk: 'Wave 1B read; deferred from autonomous discovery until foundation green',
    evidenceNeeded: ['delivery state fields', 'attachment metadata without re-send'],
  },
  {
    id: 'folio-read',
    officialDocs: ['https://docs.infor.com/hms/2024.x/en-us/hmsolh/s_t1424428571861-2.html'],
    corpusThreadIds: [],
    phase: 'roadmap_read',
    credentialRequirement: 'view_only',
    autonomousAllowed: false,
    mutationRisk: 'Wave 2 finance read; deferred; never post/settle/refund',
    evidenceNeeded: ['balance + charges + payments read-only'],
  },
] as const;

/** IDs allowed for autonomous discovery (active_read + autonomousAllowed). */
export function activeDiscoveryCapabilities(): string[] {
  return CAPABILITY_ROWS.filter((row) => row.phase === 'active_read' && row.autonomousAllowed).map(
    (row) => row.id,
  );
}

const variableFieldSchema = z
  .object({
    pattern: z.string(),
    maxLength: z.number().int().positive(),
  })
  .strict();

const multimapValueSchema = z.union([z.string(), z.array(z.string())]);
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const requiredHeaderHmacDeclarationSchema = z
  .object({
    purpose: z.literal('request_header'),
    privateDigestKeyVersion: z.string().min(1),
    hmacSha256: sha256HexSchema,
  })
  .strict();

export type RequiredHeaderHmacDeclaration = z.infer<typeof requiredHeaderHmacDeclarationSchema>;

function expectedKeyMultiplicity(
  fixed: Record<string, string | string[]>,
  variable: Record<string, unknown>,
): Map<string, number> {
  const expected = new Map<string, number>();
  for (const [key, value] of Object.entries(fixed)) {
    expected.set(key, Array.isArray(value) ? value.length : 1);
  }
  for (const key of Object.keys(variable)) {
    expected.set(key, 1);
  }
  return expected;
}

function keySequenceMatchesDeclarations(
  sequence: readonly string[],
  fixed: Record<string, string | string[]>,
  variable: Record<string, unknown>,
): boolean {
  const expected = expectedKeyMultiplicity(fixed, variable);
  if (sequence.length !== [...expected.values()].reduce((sum, count) => sum + count, 0)) {
    return false;
  }
  const actual = new Map<string, number>();
  for (const key of sequence) {
    actual.set(key, (actual.get(key) ?? 0) + 1);
  }
  if (actual.size !== expected.size) return false;
  for (const [key, count] of expected) {
    if (actual.get(key) !== count) return false;
  }
  return true;
}

/**
 * Canonical HMS read request template. Fail closed: only exact reviewed
 * signatures may continue; values never widen from live observation.
 */
export const requestRuleSchema = z
  .object({
    id: z.string().min(1),
    origin: z.string().url(),
    method: z.enum(['GET', 'POST']),
    path: z.string().startsWith('/'),
    resourceTypes: z.array(z.string()).min(1),
    fixedQuery: z.record(multimapValueSchema).default({}),
    variableQuery: z.record(variableFieldSchema).default({}),
    requiredContentType: z.string().min(1).optional(),
    contentType: z.string().optional(),
    requiredHeaderHmacs: z.record(requiredHeaderHmacDeclarationSchema).optional(),
    queryKeySequence: z.array(z.string().min(1)).optional(),
    fixedBody: z.record(multimapValueSchema).default({}),
    variableBody: z.record(variableFieldSchema).default({}),
    bodyKeySequence: z.array(z.string().min(1)).optional(),
    maxBodyBytes: z.number().int().positive().default(16_384),
    redirectPolicy: z.literal('same-reviewed-chain'),
  })
  .strict()
  .superRefine((rule, context) => {
    if (
      rule.requiredContentType &&
      rule.contentType &&
      rule.requiredContentType !== rule.contentType
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredContentType'],
        message: 'requiredContentType conflicts with legacy contentType',
      });
    }
    for (const name of Object.keys(rule.requiredHeaderHmacs ?? {})) {
      if (name !== name.toLowerCase() || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requiredHeaderHmacs', name],
          message: 'header names must be lowercase HTTP tokens',
        });
      }
    }
    if (
      rule.queryKeySequence &&
      !keySequenceMatchesDeclarations(rule.queryKeySequence, rule.fixedQuery, rule.variableQuery)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['queryKeySequence'],
        message: 'query key sequence must declare exact key multiplicity',
      });
    }
    if (
      rule.bodyKeySequence &&
      !keySequenceMatchesDeclarations(rule.bodyKeySequence, rule.fixedBody, rule.variableBody)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bodyKeySequence'],
        message: 'body key sequence must declare exact key multiplicity',
      });
    }
  });

export type RequestRule = z.infer<typeof requestRuleSchema>;

/** Structural request fingerprint only — never raw query/body values. */
export const redactedRequestSignatureSchema = z
  .object({
    method: z.string(),
    origin: z.string(),
    path: z.string(),
    resourceType: z.string(),
    contentType: z.string().optional(),
    queryKeys: z.array(z.string()),
    bodyKeys: z.array(z.string()),
    bodyBytes: z.number().int().nonnegative(),
  })
  .strict();

export type RedactedRequestSignature = z.infer<typeof redactedRequestSignatureSchema>;

export type RequestDecision =
  | { action: 'allow'; ruleId: string }
  | {
      action: 'block';
      code: string;
      redactedSignature: RedactedRequestSignature;
    };

export const requestPolicyManifestSchema = z
  .object({
    rules: z.array(requestRuleSchema).min(1),
  })
  .strict();

export type RequestPolicyManifest = z.infer<typeof requestPolicyManifestSchema>;

export const REQUESTER_CLASSES = [
  'reservation_guest',
  'authorized_booking_contact',
  'internal_finance',
  'third_party',
  'unknown',
] as const;

export const INQUIRY_CLASSES = [
  'labelled_narrow_status',
  'refund_request',
  'settlement_request',
  'invoice_request',
  'quote_request',
  'document_request',
  'group_status_request',
  'event_status_request',
  'other',
] as const;

export const TRUSTED_REQUESTER_CLAIM_KINDS = [
  'reservation_summary',
  'quote',
  'document_metadata',
  'sent_email_audit',
  'folio_status',
  'company_billing',
  'company_billing_summary',
  'group_status',
  'event_status',
  'notes_trace_observation',
] as const;

export const requesterClassSchema = z.enum(REQUESTER_CLASSES);
export const inquiryClassSchema = z.enum(INQUIRY_CLASSES);
export const trustedRequesterClaimKindSchema = z.enum(TRUSTED_REQUESTER_CLAIM_KINDS);

export type RequesterClass = z.infer<typeof requesterClassSchema>;
export type InquiryClass = z.infer<typeof inquiryClassSchema>;
export type TrustedRequesterClaimKind = z.infer<typeof trustedRequesterClaimKindSchema>;

export const trustedRequesterAuthorizationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    authorizationId: z.string().min(1),
    operationId: z.string().min(1),
    mailboxGrantSha256: sha256HexSchema,
    threadIdHmacSha256: sha256HexSchema,
    threadStateVersion: z.string().min(1),
    requesterIdentityHmacSha256: sha256HexSchema,
    requesterClass: requesterClassSchema,
    inquiryClass: inquiryClassSchema,
    allowedClaimKinds: z.array(trustedRequesterClaimKindSchema),
    privateDigestKeyVersion: z.string().min(1),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .superRefine((authorization, context) => {
    if (new Set(authorization.allowedClaimKinds).size !== authorization.allowedClaimKinds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedClaimKinds'],
        message: 'allowed claim kinds must be unique',
      });
    }
    if (Date.parse(authorization.expiresAt) <= Date.parse(authorization.issuedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'authorization expiry must follow issuance',
      });
    }
  });

export type TrustedRequesterAuthorizationV1 = z.infer<typeof trustedRequesterAuthorizationV1Schema>;

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected ISO date YYYY-MM-DD');

/** Single Guest Stay list/detail observation (capped lists use this row shape). */
export const reservationObservationSchema = z
  .object({
    confirmationNumber: z.string().nullable(),
    externalReference: z.string().nullable(),
    guestName: z.string().nullable(),
    arrivalDate: isoDateSchema.nullable(),
    departureDate: isoDateSchema.nullable(),
    reservationStatus: z.string().nullable(),
    roomType: z.string().nullable(),
    ratePlan: z.string().nullable(),
  })
  .strict();

export type ReservationObservation = z.infer<typeof reservationObservationSchema>;

/** Model-facing reservation read payload (wrapped by ToolResult). */
export const reservationReadDataSchema = z
  .object({
    matches: z.array(reservationObservationSchema).max(20),
    matchCount: z.number().int().nonnegative(),
    capped: z.boolean(),
  })
  .strict();

export type ReservationReadData = z.infer<typeof reservationReadDataSchema>;

export const inventoryObservationSchema = z
  .object({
    date: isoDateSchema,
    roomType: z.string().min(1),
    inventoryStatus: z.enum(['available', 'unavailable', 'unknown']),
    availableCount: z.number().int().min(0).nullable(),
  })
  .strict();

export type InventoryObservation = z.infer<typeof inventoryObservationSchema>;

export const rateObservationSchema = z
  .object({
    roomType: z.string().min(1),
    ratePlan: z.string().nullable(),
    amount: z.string().nullable(),
    amountBasis: z.enum(['nightly', 'weekly', 'monthly', 'stay_total', 'unknown']),
    currency: z.string().nullable(),
    taxIncluded: z.boolean().nullable(),
    inclusions: z.array(z.string()),
    restrictions: z.array(z.string()),
    boardBasis: z.string().nullable(),
    organizationEligibility: z.enum(['confirmed', 'unresolved', 'not_requested']),
  })
  .strict();

export type RateObservation = z.infer<typeof rateObservationSchema>;

/**
 * hms_quote_stay@2.0.0 payload. One Room Type and Rate Availability search
 * yields a complete contiguous nightly schedule. Never represents a bookable
 * offer, stay total, or occupancy-priced amount.
 */
/** Compatibility export while callers migrate from v1 naming. */
export const stayOptionReadDataSchema = quoteStayReadDataSchema;
export type StayOptionReadData = QuoteStayReadData;

/** Exact CSS / data-attr selectors — no loose record + parallel key list. */
export const reservationSelectorsSchema = z
  .object({
    pagePath: z.string().startsWith('/'),
    searchPath: z.string().startsWith('/'),
    detailPath: z.string().startsWith('/'),
    resultsTable: z.string().min(1),
    resultRow: z.string().min(1),
    noResults: z.string().min(1),
    detailLink: z.string().min(1),
    confirmationAttr: z.string().min(1),
    externalRefAttr: z.string().min(1),
    guestNameAttr: z.string().min(1),
    arrivalAttr: z.string().min(1),
    departureAttr: z.string().min(1),
    statusAttr: z.string().min(1),
    roomTypeAttr: z.string().min(1),
    ratePlanAttr: z.string().min(1),
  })
  .strict();

export const quoteSelectorsSchema = z
  .object({
    pagePath: z.string().startsWith('/'),
    searchPath: z.string().startsWith('/'),
    resultsTable: z.string().min(1),
    resultRow: z.string().min(1),
    noResults: z.string().min(1),
    dateAttr: z.string().min(1),
    roomTypeAttr: z.string().min(1),
    availableCountAttr: z.string().min(1),
    ratePlanAttr: z.string().min(1),
    displayedAmountAttr: z.string().min(1),
    currencyAttr: z.string().min(1),
    rateBasisAttr: z.string().min(1),
    restrictionsAttr: z.string().min(1),
  })
  .strict();

export const centurionManifestSchema = z
  .object({
    version: z.string().min(1),
    binding: z
      .object({
        transportId: z.string().min(1),
        origin: z
          .string()
          .url()
          .refine(
            (value) => value.startsWith('https://') || /^http:\/\/127\.0\.0\.1:\d+$/.test(value),
            'origin must be HTTPS or literal loopback test origin',
          ),
        tenantId: z.string().min(1),
        propertyKey: z.string().min(1),
        expectedPropertyText: z.string().min(1),
      })
      .strict(),
    rules: z.array(requestRuleSchema).min(1),
    selectors: z
      .object({
        reservation: reservationSelectorsSchema,
        quote: quoteSelectorsSchema,
      })
      .strict(),
  })
  .strict();

export type CenturionManifest = z.infer<typeof centurionManifestSchema>;
export type ReservationSelectors = z.infer<typeof reservationSelectorsSchema>;
export type QuoteSelectors = z.infer<typeof quoteSelectorsSchema>;

/**
 * Structural Guest Stay list-row fingerprint only.
 * Never stores cardinality, cell values, HTML, screenshots, traces, or value hashes.
 */
export const liveGuestStayRowFingerprintV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    selectorKeys: z.array(z.string().min(1)).min(1),
    columnKeys: z.array(z.string().min(1)).min(1),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    valuesCaptured: z.literal(false),
  })
  .strict();

export type LiveGuestStayRowFingerprintV1 = z.infer<typeof liveGuestStayRowFingerprintV1Schema>;

/**
 * V2 adds exact reviewed live GRIDRESULT row aliases.
 * Keys only: no values, cardinality, HTML, or value-derived hashes.
 */
export const liveGuestStayRowFingerprintV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    selectorKeys: z.array(z.string().min(1)).min(1),
    columnKeys: z.array(z.string().min(1)).min(1),
    rowAliasKeys: z.array(z.string().min(1)).min(1),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    valuesCaptured: z.literal(false),
  })
  .strict();

export type LiveGuestStayRowFingerprintV2 = z.infer<typeof liveGuestStayRowFingerprintV2Schema>;
