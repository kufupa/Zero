/**
 * Docs/corpus-backed HMS capability contract for fail-closed read discovery.
 * Live HMS mutation surfaces stay out of autonomousAllowed / active_read.
 */

import { z } from 'zod';

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
    officialDocs: [
      'https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428565917.html',
    ],
    corpusThreadIds: [],
    phase: 'active_read',
    credentialRequirement: 'documented_read_screen',
    autonomousAllowed: true,
    mutationRisk: 'auth session only; no PMS mutation on login GET/POST itself beyond session establish',
    evidenceNeeded: [
      'login URL origin matches manifest',
      'tenant/property header verification',
      'redacted gate JSON on unknown request',
    ],
  },
  {
    id: 'reservation-search',
    officialDocs: [
      'https://docs.infor.com/hms/3.8/en-us/hmsolh/pages/osresv_help.html',
    ],
    corpusThreadIds: [],
    phase: 'active_read',
    credentialRequirement: 'view_only',
    autonomousAllowed: true,
    mutationRisk: 'Guest Stay list/search read; must not open New Record or Stay Wizard mutate paths',
    evidenceNeeded: [
      'search by confirmation/external ref/bounded surname+date',
      'result ambiguity handling',
      'no create/amend controls exercised',
    ],
  },
  {
    id: 'room-availability',
    officialDocs: [
      'https://docs.infor.com/hms/3.8.x/en-us/hmsolh/s_t1424428570987.html',
    ],
    corpusThreadIds: [],
    phase: 'active_read',
    credentialRequirement: 'view_only',
    autonomousAllowed: true,
    mutationRisk: 'Front Desk > Availability > Room Availability is inventory view only; never CRS Check Availability',
    evidenceNeeded: [
      'start date + room type observation',
      'inventory counts only',
      'separate from Display Rates (no merged bookable offer)',
    ],
  },
  {
    id: 'display-rates',
    officialDocs: [
      'https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428571268.html',
    ],
    corpusThreadIds: [],
    phase: 'active_read',
    credentialRequirement: 'view_only',
    autonomousAllowed: true,
    mutationRisk: 'Front Desk > Availability > Display Rates calculates prices; does not bind inventory or create reservation',
    evidenceNeeded: [
      'rate plan + room cost calculation',
      'amount basis / currency / inclusions unresolved fields',
      'bookable remains false until quote constraints resolve',
    ],
  },
  {
    id: 'crs-check-availability',
    officialDocs: [
      'https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428583967.html',
    ],
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
    officialDocs: [
      'https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428600707.html',
    ],
    corpusThreadIds: [],
    phase: 'future_write',
    credentialRequirement: 'human_supervised',
    autonomousAllowed: false,
    mutationRisk: 'Property Forms / any submit-save-create-amend-cancel path; mutation prohibited in Wave 1A',
    evidenceNeeded: [
      'synthetic fixture write adapters first',
      'production write requires authorization + idempotency + audit',
    ],
  },
  {
    id: 'sent-email-audit',
    officialDocs: [
      'https://docs.infor.com/hms/2025.x/en-us/hmsolh/pages/pssnel_help.html',
    ],
    corpusThreadIds: [],
    phase: 'roadmap_read',
    credentialRequirement: 'view_only',
    autonomousAllowed: false,
    mutationRisk: 'Wave 1B read; deferred from autonomous discovery until foundation green',
    evidenceNeeded: ['delivery state fields', 'attachment metadata without re-send'],
  },
  {
    id: 'folio-read',
    officialDocs: [
      'https://docs.infor.com/hms/2024.x/en-us/hmsolh/s_t1424428571861-2.html',
    ],
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
  return CAPABILITY_ROWS.filter(
    (row) => row.phase === 'active_read' && row.autonomousAllowed,
  ).map((row) => row.id);
}

const variableFieldSchema = z
  .object({
    pattern: z.string(),
    maxLength: z.number().int().positive(),
  })
  .strict();

const multimapValueSchema = z.union([z.string(), z.array(z.string())]);

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
    contentType: z.string().optional(),
    fixedBody: z.record(multimapValueSchema).default({}),
    variableBody: z.record(variableFieldSchema).default({}),
    maxBodyBytes: z.number().int().positive().default(16_384),
    redirectPolicy: z.literal('same-reviewed-chain'),
  })
  .strict();

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

export type RedactedRequestSignature = z.infer<
  typeof redactedRequestSignatureSchema
>;

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

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected ISO date YYYY-MM-DD');

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
    amountBasis: z.enum([
      'nightly',
      'weekly',
      'monthly',
      'stay_total',
      'unknown',
    ]),
    currency: z.string().nullable(),
    taxIncluded: z.boolean().nullable(),
    inclusions: z.array(z.string()),
    restrictions: z.array(z.string()),
    boardBasis: z.string().nullable(),
    organizationEligibility: z.enum([
      'confirmed',
      'unresolved',
      'not_requested',
    ]),
  })
  .strict();

export type RateObservation = z.infer<typeof rateObservationSchema>;

/**
 * Stay-option / quote payload. Inventory + rates stay separate observations.
 * bookable is always false — separate screens never prove an executable offer.
 */
export const stayOptionReadDataSchema = z
  .object({
    inventoryObservations: z.array(inventoryObservationSchema).max(100),
    rateObservations: z.array(rateObservationSchema).max(100),
    bookable: z.literal(false),
    requestedRooms: z.number().int().positive(),
  })
  .strict();

export type StayOptionReadData = z.infer<typeof stayOptionReadDataSchema>;

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
    inventoryPagePath: z.string().startsWith('/'),
    ratesPagePath: z.string().startsWith('/'),
    inventoryRow: z.string().min(1),
    inventoryDateAttr: z.string().min(1),
    inventoryRoomTypeAttr: z.string().min(1),
    inventoryAvailableAttr: z.string().min(1),
    rateRow: z.string().min(1),
    rateRoomTypeAttr: z.string().min(1),
    ratePlanAttr: z.string().min(1),
    amountAttr: z.string().min(1),
    currencyAttr: z.string().min(1),
    amountBasisAttr: z.string().min(1),
    taxIncludedAttr: z.string().min(1),
    inclusionsAttr: z.string().min(1),
    restrictionsAttr: z.string().min(1),
    boardBasisAttr: z.string().min(1),
    orgEligibilityAttr: z.string().min(1),
    amountBasisDefault: z.enum([
      'nightly',
      'weekly',
      'monthly',
      'stay_total',
      'unknown',
    ]),
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
            (value) =>
              value.startsWith('https://') ||
              /^http:\/\/127\.0\.0\.1:\d+$/.test(value),
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

export type LiveGuestStayRowFingerprintV1 = z.infer<
  typeof liveGuestStayRowFingerprintV1Schema
>;
