/**
 * Typed Phase B read-tool registry.
 * Single source for tool/version, caps, privacy, denied actions, promotion evidence.
 * Capability docs, fingerprints, release checks, and eval membership derive from this.
 */
import { companyAccountReadDataSchema } from './company-account-read-contract.js';
import { sentEmailAuditReadDataSchema } from './sent-email-audit-contract.js';
import { groupBlockReadDataSchema } from './group-block-read-contract.js';
import { documentListReadDataSchema } from './document-list-contract.js';
import { quoteStayReadDataSchema } from './quote-stay-contract.js';
import { folioReadDataSchema } from './folio-read-contract.js';
import { eventReadDataSchema } from './event-read-contract.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const READ_TOOL_IDS = [
  'mail_read_artifact',
  'hms_find_reservation',
  'hms_quote_stay',
  'hms_list_documents',
  'hms_sent_email_audit',
  'hms_read_folio',
  'hms_company_account_read',
  'hms_group_block_read',
  'hms_event_read',
] as const;

export type ReadToolId = (typeof READ_TOOL_IDS)[number];

/**
 * U15 normal read-service branches are intentionally tracked separately from
 * the Phase-B promotion portfolio. Their typed receipts can be exercised by
 * the model-free worker while the active HMS release remains unavailable.
 */
export const U15_CONTEXT_READ_TOOL_IDS = [
  'hms_company_account_read',
  'hms_group_block_read',
  'hms_event_read',
  'hms_read_notes_traces',
] as const;
export type U15ContextReadToolId = (typeof U15_CONTEXT_READ_TOOL_IDS)[number];
export const u15ContextReadToolIdSchema = z.enum(U15_CONTEXT_READ_TOOL_IDS);
export const U15_CONTEXT_DISCOVERY_OPERATION_IDS = [
  'reservation_linked_company_billing',
  'group_block_list',
  'event_list',
  'notes_traces_list',
] as const;
export type U15ContextDiscoveryOperationId = (typeof U15_CONTEXT_DISCOVERY_OPERATION_IDS)[number];

/**
 * Mail-first existing-document operations are dispatched by the closed U8
 * read service. They remain a separate registry union so the accepted Phase-B
 * promotion/fingerprint key set above cannot drift while these adapters gain
 * their own evidence.
 */
export const EXISTING_DOCUMENT_TOOL_IDS = [
  'documents_list_existing',
  'documents_read_existing',
] as const;
export type ExistingDocumentToolId = (typeof EXISTING_DOCUMENT_TOOL_IDS)[number];
export const existingDocumentToolIdSchema = z.enum(EXISTING_DOCUMENT_TOOL_IDS);

/**
 * U8 context reads are dispatched by the closed read service and are kept
 * outside the Phase-B promotion registry until their own release evidence is
 * installed.  Keeping a separate union preserves existing portfolio IDs.
 */
export const RESERVATION_CONTEXT_TOOL_IDS = ['hms_read_reservation'] as const;
export type ReservationContextToolId = (typeof RESERVATION_CONTEXT_TOOL_IDS)[number];

export const HMS_READ_TOOL_IDS = [
  'hms_find_reservation',
  'hms_quote_stay',
  'hms_list_documents',
  'hms_sent_email_audit',
  'hms_read_folio',
  'hms_company_account_read',
  'hms_group_block_read',
  'hms_event_read',
] as const satisfies readonly ReadToolId[];

export const hmsReadToolIdSchema = z.enum(HMS_READ_TOOL_IDS);
export type HmsReadToolId = z.infer<typeof hmsReadToolIdSchema>;

export const ROLE_SURFACE_IDS = [
  'guest_stay',
  'room_type_rate_availability',
  'sent_email',
  'tax_invoice',
  'folio',
  'deposit_ledger',
  'company_account_billing',
  'group_block',
  'event_list',
] as const;

export const roleSurfaceIdSchema = z.enum(ROLE_SURFACE_IDS);
export type RoleSurfaceId = z.infer<typeof roleSurfaceIdSchema>;

export const DISCOVERY_OPERATION_IDS = [
  'guest_stay_search',
  'quote_availability_search',
  'sent_email_list',
  'tax_invoice_list',
  'folio_summary',
  'deposit_ledger_summary',
  'reservation_linked_company_billing',
  'group_block_list',
  'event_list',
] as const;

export const discoveryOperationIdSchema = z.enum(DISCOVERY_OPERATION_IDS);
export type DiscoveryOperationId = z.infer<typeof discoveryOperationIdSchema>;

export const CAPABILITY_PROMOTION_ORDER = [
  'planned',
  'fixture_verified',
  'discovery_verified',
  'live_verified',
  'shadow_enabled',
] as const;

export type CapabilityState = (typeof CAPABILITY_PROMOTION_ORDER)[number];

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

export const controlOracleDefinitionSchema = z
  .object({
    kind: z.enum([
      'authorized_source_artifact',
      'preexisting_record',
      'independent_rendered_observation',
    ]),
    acquisitionOperationId: discoveryOperationIdSchema,
    maxAgeMs: z.number().int().positive(),
  })
  .strict();

export type ControlOracleDefinition = z.infer<typeof controlOracleDefinitionSchema>;

export const requestBranchDefinitionSchema = z
  .object({
    id: z.string().min(1),
    discoveryOperationId: discoveryOperationIdSchema,
    manifestPath: z.string().min(1),
    requiredRoleSurfaces: z.array(roleSurfaceIdSchema).min(1),
    parserSchemaSha256: sha256Hex,
    requiredControlKinds: z.array(z.enum(['positive', 'canonical_negative', 'ambiguity'])).min(1),
    controlOracle: controlOracleDefinitionSchema,
  })
  .strict()
  .superRefine((branch, context) => {
    if (new Set(branch.requiredRoleSurfaces).size !== branch.requiredRoleSurfaces.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredRoleSurfaces'],
        message: 'role surfaces must be unique',
      });
    }
    if (new Set(branch.requiredControlKinds).size !== branch.requiredControlKinds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredControlKinds'],
        message: 'control kinds must be unique',
      });
    }
  });

export type RequestBranchDefinition = z.infer<typeof requestBranchDefinitionSchema>;

export const capabilityEvidenceRefsSchema = z
  .object({
    fixtureDigest: sha256Hex.optional(),
    discoveryDigest: sha256Hex.optional(),
    liveProofDigest: sha256Hex.optional(),
    shadowDigest: sha256Hex.optional(),
  })
  .strict();

export type CapabilityEvidenceRefs = z.infer<typeof capabilityEvidenceRefsSchema>;

export type PromotionEvidenceFlags = {
  fixture: boolean;
  discovery: boolean;
  live: boolean;
  shadow: boolean;
};

type ReadToolDefinitionBase<TId extends ReadToolId> = {
  id: TId;
  version: string;
  effect: 'read';
  sourceUrls: readonly string[];
  deniedActions: readonly string[];
  candidateRequirement: string;
  attemptCap: number;
  promotionEvidence: PromotionEvidenceFlags;
  /** Present digests only — state derives from contiguous refs. */
  evidenceRefs: CapabilityEvidenceRefs;
  observationSchema: z.ZodTypeAny;
  claimKinds: readonly string[];
};

export type HmsReadToolDefinition = ReadToolDefinitionBase<HmsReadToolId> & {
  privacyClass: 'minimized_hms';
  discoveryOperationIds: readonly DiscoveryOperationId[];
  requestBranches: readonly RequestBranchDefinition[];
};

export type MailReadToolDefinition = ReadToolDefinitionBase<'mail_read_artifact'> & {
  privacyClass: 'mail_server_only';
  discoveryOperationIds?: never;
  requestBranches?: never;
};

export type ReadToolDefinition = HmsReadToolDefinition | MailReadToolDefinition;

const deniedCommon = [
  'save',
  'submit',
  'create',
  'amend',
  'cancel',
  'assign',
  'post',
  'settle',
  'refund',
  'transfer',
  'void',
  'finalize',
  'send',
  'resend',
  'print',
  'export',
  'generate',
] as const;

/** Closed observation placeholders — concrete schemas land with each tool task. */
const opaqueObservationSchema = z.object({ observedAt: z.string().datetime() }).strict();

const REQUEST_BRANCH_CONTROL_KINDS = ['positive', 'canonical_negative', 'ambiguity'] as const;
const CONTROL_ORACLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function defineRequestBranch(input: {
  id: string;
  discoveryOperationId: DiscoveryOperationId;
  requiredRoleSurfaces: RoleSurfaceId[];
  parserSchemaSha256: string;
  oracleKind: ControlOracleDefinition['kind'];
}): RequestBranchDefinition {
  return requestBranchDefinitionSchema.parse({
    id: input.id,
    discoveryOperationId: input.discoveryOperationId,
    // Path identity is static contract only. Release evidence separately proves
    // an installed manifest before any branch can activate.
    manifestPath: `src/hms/request-branches/${input.id}.manifest.json`,
    requiredRoleSurfaces: input.requiredRoleSurfaces,
    parserSchemaSha256: input.parserSchemaSha256,
    requiredControlKinds: REQUEST_BRANCH_CONTROL_KINDS,
    controlOracle: {
      kind: input.oracleKind,
      acquisitionOperationId: input.discoveryOperationId,
      maxAgeMs: CONTROL_ORACLE_MAX_AGE_MS,
    },
  });
}

export const READ_TOOLS: Readonly<Record<ReadToolId, ReadToolDefinition>> = {
  hms_find_reservation: {
    id: 'hms_find_reservation',
    version: '1.2.0',
    effect: 'read',
    sourceUrls: ['https://docs.infor.com/hms/3.8/en-us/hmsolh/pages/osresv_help.html'],
    privacyClass: 'minimized_hms',
    deniedActions: [...deniedCommon, 'open_guest_stay_detail', 'new_record', 'stay_wizard'],
    candidateRequirement: 'exact_confirmation_or_external_ref',
    attemptCap: 3,
    discoveryOperationIds: ['guest_stay_search'],
    requestBranches: [
      defineRequestBranch({
        id: 'guest_stay_search',
        discoveryOperationId: 'guest_stay_search',
        requiredRoleSurfaces: ['guest_stay'],
        parserSchemaSha256: '1fe75700f61799feb4ff2da9238af4ebd46396b422c94266356365f0df0da820',
        oracleKind: 'preexisting_record',
      }),
    ],
    promotionEvidence: {
      fixture: true,
      // No digests yet — flags must not claim discovery/live until real evidence returns.
      discovery: false,
      live: false,
      shadow: false,
    },
    // Fixture contract only. Discovery/live evidence must come from immutable
    // operator-observed artifacts and cannot be pre-credited in source.
    evidenceRefs: {
      // Fixture digest = live Guest Stay row fingerprint manifestSha256 (valuesCaptured:false).
      fixtureDigest: '1fe75700f61799feb4ff2da9238af4ebd46396b422c94266356365f0df0da820',
    },
    observationSchema: opaqueObservationSchema,
    claimKinds: ['reservation_summary'],
  },
  mail_read_artifact: {
    id: 'mail_read_artifact',
    version: '2',
    effect: 'read',
    sourceUrls: ['docs/superpowers/plans/2026-08-05-phase-b-hms-read-expansion.md'],
    privacyClass: 'mail_server_only',
    deniedActions: [...deniedCommon, 'ocr', 'attachment_fact_claim'],
    candidateRequirement: 'authorized_inbound_pdf_attachment',
    attemptCap: 3,
    promotionEvidence: {
      fixture: true,
      discovery: false,
      live: false,
      shadow: false,
    },
    evidenceRefs: {
      fixtureDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    observationSchema: opaqueObservationSchema,
    // Server-only candidate material — no model-visible claim kinds.
    claimKinds: [],
  },
  hms_quote_stay: {
    id: 'hms_quote_stay',
    version: '2.0.0',
    effect: 'read',
    sourceUrls: [
      'https://docs.infor.com/hms/3.8.x/en-us/useradminlist/HMS%203.8.4%20User%20Guide_70179.pdf',
    ],
    privacyClass: 'minimized_hms',
    deniedActions: [...deniedCommon, 'crs_check_availability', 'click_result_row', 'paging'],
    candidateRequirement: 'unambiguous_dates_occupancy_room_rate_authored_segment',
    attemptCap: 1,
    discoveryOperationIds: ['quote_availability_search'],
    requestBranches: [
      defineRequestBranch({
        id: 'quote_availability_search',
        discoveryOperationId: 'quote_availability_search',
        requiredRoleSurfaces: ['room_type_rate_availability'],
        parserSchemaSha256: '909a0f6e086bca1464eaafae78bf54a0650c02bc9be90f5726d594e0e6d47bcc',
        oracleKind: 'independent_rendered_observation',
      }),
    ],
    promotionEvidence: {
      fixture: true,
      discovery: false,
      live: false,
      shadow: false,
    },
    evidenceRefs: {
      fixtureDigest: '909a0f6e086bca1464eaafae78bf54a0650c02bc9be90f5726d594e0e6d47bcc',
    },
    observationSchema: quoteStayReadDataSchema,
    claimKinds: ['quote_stay_summary'],
  },
  hms_list_documents: {
    id: 'hms_list_documents',
    version: '1.0.0',
    effect: 'read',
    sourceUrls: [
      'https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428580083.html',
      'https://docs.infor.com/hms/2025.x/en-us/hmsolh/pages/pssnel_help.html',
    ],
    privacyClass: 'minimized_hms',
    deniedActions: [...deniedCommon, 'open_attachment', 'preview', 'document_byte_fetch'],
    candidateRequirement: 'exact_reservation_child_or_sent_email_scope',
    attemptCap: 2,
    discoveryOperationIds: ['sent_email_list', 'tax_invoice_list'],
    requestBranches: [
      defineRequestBranch({
        id: 'sent_email_documents',
        discoveryOperationId: 'sent_email_list',
        requiredRoleSurfaces: ['sent_email'],
        parserSchemaSha256: '092f92a82592866fbc85e6e68cdffaa312e32a8dbfbc8d3cf1b596856567ba42',
        oracleKind: 'authorized_source_artifact',
      }),
      defineRequestBranch({
        id: 'tax_invoice_documents',
        discoveryOperationId: 'tax_invoice_list',
        requiredRoleSurfaces: ['tax_invoice'],
        parserSchemaSha256: '092f92a82592866fbc85e6e68cdffaa312e32a8dbfbc8d3cf1b596856567ba42',
        oracleKind: 'authorized_source_artifact',
      }),
    ],
    promotionEvidence: {
      fixture: true,
      discovery: false,
      live: false,
      shadow: false,
    },
    evidenceRefs: {
      fixtureDigest: '092f92a82592866fbc85e6e68cdffaa312e32a8dbfbc8d3cf1b596856567ba42',
      discoveryDigest: '45f2e1372e37187f4757dbcaf2a4ea95d1094acb6ab29c089e9fb39470c475b8',
    },
    observationSchema: documentListReadDataSchema,
    claimKinds: ['document_metadata'],
  },
  hms_sent_email_audit: {
    id: 'hms_sent_email_audit',
    version: '1.0.0',
    effect: 'read',
    sourceUrls: ['https://docs.infor.com/hms/2025.x/en-us/hmsolh/pages/pssnel_help.html'],
    privacyClass: 'minimized_hms',
    deniedActions: [...deniedCommon, 'open_attachment', 'resend'],
    candidateRequirement: 'exact_reservation_or_account_scope',
    attemptCap: 2,
    discoveryOperationIds: ['sent_email_list'],
    requestBranches: [
      defineRequestBranch({
        id: 'sent_email_audit',
        discoveryOperationId: 'sent_email_list',
        requiredRoleSurfaces: ['sent_email'],
        parserSchemaSha256: '80db0d4e4db89de7e86e1b65733943823913b8275fe59d86a438a34e842b1830',
        oracleKind: 'authorized_source_artifact',
      }),
    ],
    promotionEvidence: {
      fixture: true,
      discovery: false,
      live: false,
      shadow: false,
    },
    evidenceRefs: {
      fixtureDigest: '80db0d4e4db89de7e86e1b65733943823913b8275fe59d86a438a34e842b1830',
      discoveryDigest: '45f2e1372e37187f4757dbcaf2a4ea95d1094acb6ab29c089e9fb39470c475b8',
    },
    observationSchema: sentEmailAuditReadDataSchema,
    claimKinds: ['sent_email_audit'],
  },
  hms_read_folio: {
    id: 'hms_read_folio',
    version: '1.0.0',
    effect: 'read',
    sourceUrls: [
      'https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428571861.html',
      'https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428579271.html',
    ],
    privacyClass: 'minimized_hms',
    deniedActions: [
      ...deniedCommon,
      'email',
      'line_item_export',
      'advance_deposit_form',
      'report_execution',
    ],
    candidateRequirement: 'exact_reservation_child',
    attemptCap: 2,
    discoveryOperationIds: ['folio_summary', 'deposit_ledger_summary'],
    requestBranches: [
      defineRequestBranch({
        id: 'folio_summary',
        discoveryOperationId: 'folio_summary',
        requiredRoleSurfaces: ['folio'],
        parserSchemaSha256: '716018585f130515af72a506721849c0f1e5e22ccf521241136e03f96e653b65',
        oracleKind: 'preexisting_record',
      }),
      defineRequestBranch({
        id: 'deposit_ledger_summary',
        discoveryOperationId: 'deposit_ledger_summary',
        requiredRoleSurfaces: ['deposit_ledger'],
        parserSchemaSha256: '716018585f130515af72a506721849c0f1e5e22ccf521241136e03f96e653b65',
        oracleKind: 'preexisting_record',
      }),
    ],
    promotionEvidence: {
      fixture: true,
      discovery: false,
      live: false,
      shadow: false,
    },
    evidenceRefs: {
      fixtureDigest: '716018585f130515af72a506721849c0f1e5e22ccf521241136e03f96e653b65',
      discoveryDigest: '2a8ffeaecb91a5c59ee17b371e3154aab16c07628fd42399a891ce9c8c60bc82',
    },
    observationSchema: folioReadDataSchema,
    claimKinds: ['folio_deposit_summary'],
  },
  hms_company_account_read: {
    id: 'hms_company_account_read',
    version: '1.0.0',
    effect: 'read',
    // BAC OLH URL is contrast only — availability fields must not substitute billing terms.
    sourceUrls: ['https://docs.infor.com/hms/2024.x/en-us/hmsolh/s_t1424428594638.html'],
    privacyClass: 'minimized_hms',
    deniedActions: [
      ...deniedCommon,
      'autosave',
      'arbitrary_company_search',
      'credit_limit_read',
      'contact_read',
    ],
    candidateRequirement: 'exact_reservation_linked_organization',
    attemptCap: 1,
    discoveryOperationIds: ['reservation_linked_company_billing'],
    requestBranches: [
      defineRequestBranch({
        id: 'reservation_linked_company_billing',
        discoveryOperationId: 'reservation_linked_company_billing',
        requiredRoleSurfaces: ['company_account_billing'],
        parserSchemaSha256: '1f5433aae2fa18b9f839a7a1cacac95589bef375c77347a862718a2754b9ba1c',
        oracleKind: 'preexisting_record',
      }),
    ],
    promotionEvidence: {
      fixture: true,
      discovery: false,
      live: false,
      shadow: false,
    },
    evidenceRefs: {
      fixtureDigest: '1f5433aae2fa18b9f839a7a1cacac95589bef375c77347a862718a2754b9ba1c',
    },
    observationSchema: companyAccountReadDataSchema,
    claimKinds: ['company_billing_summary'],
  },
  hms_group_block_read: {
    id: 'hms_group_block_read',
    version: '1.0.0',
    effect: 'read',
    sourceUrls: [
      'https://docs.infor.com/hms/3.8/en-us/hmsolh/pages/groupbooking_help.html',
      'https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428588367.html',
    ],
    privacyClass: 'minimized_hms',
    deniedActions: [
      ...deniedCommon,
      'rooming_list',
      'quick_entry',
      'room_assignment',
      'release',
      'block_tab_direct_entry',
      'document_tabs',
      'focus',
      'input',
      'change',
      'blur',
    ],
    candidateRequirement: 'exact_group_reference_plus_bounded_dates',
    attemptCap: 1,
    discoveryOperationIds: ['group_block_list'],
    requestBranches: [
      defineRequestBranch({
        id: 'group_block_list',
        discoveryOperationId: 'group_block_list',
        requiredRoleSurfaces: ['group_block'],
        parserSchemaSha256: 'e7a031b4edfc8a943b54a4cf759e512912cc74cc905ea893f5751bb942738412',
        oracleKind: 'preexisting_record',
      }),
    ],
    promotionEvidence: {
      fixture: true,
      discovery: false,
      live: false,
      shadow: false,
    },
    evidenceRefs: {
      fixtureDigest: 'e7a031b4edfc8a943b54a4cf759e512912cc74cc905ea893f5751bb942738412',
    },
    observationSchema: groupBlockReadDataSchema,
    claimKinds: ['group_block_summary'],
  },
  hms_event_read: {
    id: 'hms_event_read',
    version: '1.0.0',
    effect: 'read',
    sourceUrls: ['https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428591097.html'],
    privacyClass: 'minimized_hms',
    deniedActions: [
      ...deniedCommon,
      'contact_read',
      'notes_read',
      'calculate',
      'copy',
      'pro_forma_generate',
      'beo_generate',
      'detail_double_click',
    ],
    candidateRequirement: 'exact_event_confirmation_or_reference',
    attemptCap: 1,
    discoveryOperationIds: ['event_list'],
    requestBranches: [
      defineRequestBranch({
        id: 'event_list',
        discoveryOperationId: 'event_list',
        requiredRoleSurfaces: ['event_list'],
        parserSchemaSha256: '93c95d304b1b3e814a787c060086771768b78f83c77be0d0edfeb092ec98b8e2',
        oracleKind: 'preexisting_record',
      }),
    ],
    promotionEvidence: {
      fixture: true,
      discovery: false,
      live: false,
      shadow: false,
    },
    evidenceRefs: {
      fixtureDigest: '93c95d304b1b3e814a787c060086771768b78f83c77be0d0edfeb092ec98b8e2',
    },
    observationSchema: eventReadDataSchema,
    claimKinds: ['event_summary'],
  },
} as const;

export function listReadToolIds(): ReadToolId[] {
  return [...READ_TOOL_IDS];
}

export function assertReadToolRegistrySealed(
  registry: Readonly<Record<string, ReadToolDefinition>>,
): void {
  const keys = Object.keys(registry).sort();
  const expected = [...READ_TOOL_IDS].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new Error(
      `READ_TOOLS key set drift: got [${keys.join(',')}] expected [${expected.join(',')}]`,
    );
  }
  for (const id of READ_TOOL_IDS) {
    const tool = registry[id];
    if (!tool || tool.id !== id || tool.effect !== 'read') {
      throw new Error(`READ_TOOLS entry invalid for ${id}`);
    }
    if (tool.id === 'mail_read_artifact') {
      if ('discoveryOperationIds' in tool || 'requestBranches' in tool) {
        throw new Error('mail_read_artifact cannot declare HMS request contracts');
      }
      continue;
    }
    if (
      tool.privacyClass !== 'minimized_hms' ||
      !hmsReadToolIdSchema.safeParse(tool.id).success ||
      tool.discoveryOperationIds.length === 0 ||
      tool.requestBranches.length === 0
    ) {
      throw new Error(`READ_TOOLS HMS entry invalid for ${id}`);
    }
    for (const branch of tool.requestBranches) {
      requestBranchDefinitionSchema.parse(branch);
      if (!tool.discoveryOperationIds.includes(branch.discoveryOperationId)) {
        throw new Error(`READ_TOOLS branch operation drift for ${id}:${branch.id}`);
      }
    }
  }
}

/**
 * Production active-read allowlist: only tools at live_verified+ with
 * promotionEvidence.live may enter the worker allowlist.
 * Shadow registry requires shadow_enabled separately.
 */
export function isProductionActiveReadTool(id: ReadToolId): boolean {
  const tool = READ_TOOLS[id];
  const state = deriveCapabilityState(tool.evidenceRefs);
  return tool.promotionEvidence.live && (state === 'live_verified' || state === 'shadow_enabled');
}

export function productionActiveReadToolIds(): ReadToolId[] {
  return listReadToolIds().filter(isProductionActiveReadTool);
}

export function deriveCapabilityState(refs: CapabilityEvidenceRefs): CapabilityState {
  const parsed = capabilityEvidenceRefsSchema.parse(refs);
  if (!parsed.fixtureDigest) return 'planned';
  if (!parsed.discoveryDigest) return 'fixture_verified';
  if (!parsed.liveProofDigest) return 'discovery_verified';
  if (!parsed.shadowDigest) return 'live_verified';
  return 'shadow_enabled';
}

export function capabilityStateFor(id: ReadToolId): CapabilityState {
  return deriveCapabilityState(READ_TOOLS[id].evidenceRefs);
}

/** Only shadow_enabled tools enter the active shadow registry. */
export function activeShadowToolIds(): ReadToolId[] {
  return listReadToolIds().filter((id) => capabilityStateFor(id) === 'shadow_enabled');
}

export function fingerprintReadToolRegistry(): string {
  const payload = listReadToolIds()
    .sort()
    .map((id) => ({
      id,
      version: READ_TOOLS[id].version,
      effect: READ_TOOLS[id].effect,
      attemptCap: READ_TOOLS[id].attemptCap,
      privacyClass: READ_TOOLS[id].privacyClass,
      deniedActions: READ_TOOLS[id].deniedActions,
      candidateRequirement: READ_TOOLS[id].candidateRequirement,
      claimKinds: READ_TOOLS[id].claimKinds,
      promotionEvidence: READ_TOOLS[id].promotionEvidence,
      discoveryOperationIds:
        READ_TOOLS[id].id === 'mail_read_artifact'
          ? undefined
          : READ_TOOLS[id].discoveryOperationIds,
      requestBranches:
        READ_TOOLS[id].id === 'mail_read_artifact' ? undefined : READ_TOOLS[id].requestBranches,
    }));
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export type PortfolioCaseV3 = {
  threadId: number;
  labelStatus: 'adjudicated' | 'placeholder';
  outcome: 'full' | 'useful_partial' | 'abstain' | 'manual_required' | null;
};

export type AblationOutcome = 'full' | 'useful_partial' | 'abstain' | 'manual_required';

export type AblationStepReport = {
  toolId: string;
  eligible: number;
  attempted: number;
  exact: number;
  partial: number;
  manual: number;
  numerator: number;
  denominator: number;
  deltaFull: number;
  confidenceInterval95: { lower: number; upper: number } | null;
};

export type AblationReport = {
  denominator: number;
  steps: AblationStepReport[];
};

function countOutcomes(
  cases: PortfolioCaseV3[],
  outcomes: Record<number, AblationOutcome>,
): Omit<AblationStepReport, 'toolId' | 'deltaFull' | 'confidenceInterval95'> {
  let attempted = 0;
  let exact = 0;
  let partial = 0;
  let manual = 0;
  for (const c of cases) {
    // Placeholder labels never score.
    if (c.labelStatus !== 'adjudicated') continue;
    const outcome = outcomes[c.threadId];
    if (!outcome) continue;
    attempted += 1;
    if (outcome === 'full') exact += 1;
    else if (outcome === 'useful_partial') partial += 1;
    else if (outcome === 'manual_required') manual += 1;
  }
  const denominator = cases.length;
  return {
    eligible: denominator,
    attempted,
    exact,
    partial,
    manual,
    numerator: exact,
    denominator,
  };
}

/**
 * One-sided 95% Wilson lower bound published only when adjudicated n >= 30.
 * Returns null below that floor (plan: never pre-credit; no CI at n<30).
 */
function wilsonLower95(successes: number, n: number): number | null {
  if (n < 30) return null;
  const z = 1.6448536269514722;
  const phat = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = phat + (z * z) / (2 * n);
  const spread = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);
  const lower = (centre - spread) / denom;
  return Math.max(0, Math.min(1, lower));
}

/**
 * Partition opaque thread IDs into mutually exclusive primary-intent buckets.
 * A thread appears in exactly one bucket (first matching priority) or uncovered.
 * Never returns message text — IDs and counts only.
 */
export function nonOverlappingIntentMembership(input: {
  threads: Array<{ threadId: number; intents: string[] }>;
  priority: readonly string[];
}): {
  buckets: Record<string, number[]>;
  uncovered: number[];
  totals: Record<string, number>;
} {
  const buckets: Record<string, number[]> = {};
  for (const intent of input.priority) buckets[intent] = [];
  const uncovered: number[] = [];
  for (const thread of input.threads) {
    const primary = input.priority.find((intent) => thread.intents.includes(intent));
    if (!primary) {
      uncovered.push(thread.threadId);
      continue;
    }
    buckets[primary].push(thread.threadId);
  }
  const totals: Record<string, number> = {};
  for (const intent of input.priority) {
    totals[intent] = buckets[intent]?.length ?? 0;
  }
  totals.uncovered = uncovered.length;
  return { buckets, uncovered, totals };
}

export function portfolioAblationReplay(input: {
  cases: PortfolioCaseV3[];
  releaseOrder: string[];
  outcomesByToolStep: Record<string, Record<number, AblationOutcome>>;
}): AblationReport {
  const steps: AblationStepReport[] = [];
  let prevExact = 0;
  const order = ['baseline', ...input.releaseOrder];
  for (const toolId of order) {
    const outcomes = input.outcomesByToolStep[toolId] ?? {};
    const counts = countOutcomes(input.cases, outcomes);
    const deltaFull = counts.exact - prevExact;
    const lower = wilsonLower95(counts.exact, counts.attempted);
    steps.push({
      toolId,
      ...counts,
      deltaFull,
      confidenceInterval95:
        lower === null
          ? null
          : { lower, upper: counts.attempted === 0 ? 0 : counts.exact / counts.attempted },
    });
    prevExact = counts.exact;
  }
  return { denominator: input.cases.length, steps };
}
