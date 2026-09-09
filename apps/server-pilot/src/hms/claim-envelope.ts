/**
 * Closed generic tool observation → typed summary claim envelopes.
 * Disclosure gate runs before claim creation; extra fields rejected.
 * Requester trust comes only from separately issued TrustedRequesterAuthorizationV1.
 */
import {
  type TrustedRequesterAuthorizationV1,
  type TrustedRequesterClaimKind,
  reservationReadDataSchema,
} from './contracts.js';
import {
  validateTrustedRequesterAuthorization,
  type TrustedRequesterSourceState,
} from './requester-authorization.js';
import {
  mapCompanyBillingClaim,
  companyAccountReadDataSchema,
} from './company-account-read-contract.js';
import {
  mapSentEmailAuditClaim,
  sentEmailAuditReadDataSchema,
} from './sent-email-audit-contract.js';
import { mapDocumentMetadataClaim, documentListReadDataSchema } from './document-list-contract.js';
import { mapGroupBlockClaim, groupBlockReadDataSchema } from './group-block-read-contract.js';
import { mapFolioDepositClaim, folioReadDataSchema } from './folio-read-contract.js';
import { mapEventSummaryClaim, eventReadDataSchema } from './event-read-contract.js';
import { quoteStayReadDataSchema } from './quote-stay-contract.js';
import { READ_TOOL_IDS, type ReadToolId } from './read-tools.js';
import type { EvidenceClaim } from '../ai/draft-evidence.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const claimableToolIds = [
  'hms_find_reservation',
  'hms_quote_stay',
  'hms_list_documents',
  'hms_sent_email_audit',
  'hms_read_folio',
  'hms_company_account_read',
  'hms_group_block_read',
  'hms_event_read',
] as const satisfies readonly ReadToolId[];

/** EvidenceClaim.kind → TrustedRequesterClaimKind (observations never set this). */
const EVIDENCE_KIND_TO_TRUSTED_CLAIM = {
  reservation_summary: 'reservation_summary',
  quote_stay_summary: 'quote',
  document_metadata: 'document_metadata',
  sent_email_audit: 'sent_email_audit',
  folio_deposit_summary: 'folio_status',
  company_billing_summary: 'company_billing',
  group_block_summary: 'group_status',
  event_summary: 'event_status',
} as const satisfies Partial<Record<EvidenceClaim['kind'], TrustedRequesterClaimKind>>;

export type MapEnvelopeRequesterAuthorization = {
  authorization: unknown;
  currentState: unknown;
  key: string | Buffer;
  expectedPrivateDigestKeyVersion: string;
  now?: Date;
};

export type MapEnvelopeToClaimsOptions = {
  expiresAt?: string;
  /**
   * Separately issued server authorization.
   * - omit/null: missing authorization → no claims
   * - object: must validate for the emitted claim kind
   */
  requesterAuthorization?: MapEnvelopeRequesterAuthorization | null;
};

export const claimEnvelopeSchema = z
  .object({
    toolId: z.enum(READ_TOOL_IDS),
    toolVersion: z.string().min(1),
    status: z.enum([
      'ok',
      'partial',
      'not_found',
      'unverified_negative',
      'ambiguous',
      'manual_required',
    ]),
    observedAt: z.string().min(1),
    evidenceId: z.string().min(1),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    scopeVerified: z.boolean().optional(),
    manifestSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    manifestSha256ByBranch: z.record(z.string().regex(/^[a-f0-9]{64}$/i)).optional(),
    scopeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    requesterAuthorizationId: z.string().min(1).optional(),
    expiresAt: z.string().min(1).optional(),
    data: z.unknown(),
  })
  .strict();

export type ClaimEnvelope = z.infer<typeof claimEnvelopeSchema>;

function claimId(parts: string): string {
  return createHash('sha256').update(parts).digest('hex').slice(0, 16);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function disclosureBlocksClaim(data: unknown): boolean {
  const disclosure = asRecord(asRecord(data).disclosure);
  if (Object.keys(disclosure).length === 0) return false;
  if (disclosure.claimEligibility === 'blocked') return true;
  return false;
}

function withEvidenceIds(claim: EvidenceClaim, evidenceId: string): EvidenceClaim {
  return {
    ...claim,
    evidenceId,
    evidenceIds: [evidenceId],
  };
}

/**
 * Observations must not carry requester/authorization trust fields.
 * Any attempt to self-assert trust fails closed.
 */
function observationAttemptsSelfTrust(data: unknown): boolean {
  const root = asRecord(data);
  if (
    'requesterAuthorization' in root ||
    'trustedRequesterAuthorization' in root ||
    'authorizationId' in root
  ) {
    return true;
  }
  const disclosure = asRecord(root.disclosure);
  if (
    'authorizationId' in disclosure ||
    'requesterAuthorization' in disclosure ||
    'trustedRequesterAuthorization' in disclosure
  ) {
    return true;
  }
  return false;
}

function authorizeClaimKind(
  auth: MapEnvelopeRequesterAuthorization | null | undefined,
  claimKind: EvidenceClaim['kind'],
): TrustedRequesterAuthorizationV1 | null {
  if (auth === null || auth === undefined) return null;
  const required =
    EVIDENCE_KIND_TO_TRUSTED_CLAIM[claimKind as keyof typeof EVIDENCE_KIND_TO_TRUSTED_CLAIM];
  if (!required) return null;
  return validateTrustedRequesterAuthorization({
    authorization: auth.authorization,
    currentState: auth.currentState,
    requiredClaimKind: required,
    key: auth.key,
    expectedPrivateDigestKeyVersion: auth.expectedPrivateDigestKeyVersion,
    now: auth.now ?? new Date(),
  });
}

export function parseClaimEnvelope(
  raw: unknown,
): { success: true; data: ClaimEnvelope } | { success: false } {
  const parsed = claimEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return { success: false };
  return { success: true, data: parsed.data };
}

/**
 * Map a closed observation envelope to at most one typed summary claim.
 * Rejects unknown keys, non-claimable toolIds, and unverified_negative.
 * A separately issued requester authorization is mandatory for every claim;
 * observations never mint requester trust and omitted authorization fails
 * closed.
 */
export function mapEnvelopeToClaims(
  raw: unknown,
  options?: MapEnvelopeToClaimsOptions,
): EvidenceClaim[] {
  const claims = mapEnvelopeToClaimsInternal(raw, options);
  const parsed = parseClaimEnvelope(raw);
  if (!parsed.success) return claims;
  return claims.map((claim) => ({
    ...claim,
    observedAt: parsed.data.observedAt,
    ...(parsed.data.sourceHash ? { sourceHash: parsed.data.sourceHash } : {}),
    ...(parsed.data.scopeVerified === undefined
      ? {}
      : { scopeVerified: parsed.data.scopeVerified }),
    ...(parsed.data.manifestSha256 ? { manifestSha256: parsed.data.manifestSha256 } : {}),
    ...(parsed.data.manifestSha256ByBranch
      ? { manifestSha256ByBranch: parsed.data.manifestSha256ByBranch }
      : {}),
    ...(parsed.data.scopeHash ? { scopeHash: parsed.data.scopeHash } : {}),
    ...(parsed.data.requesterAuthorizationId
      ? { requesterAuthorizationId: parsed.data.requesterAuthorizationId }
      : {}),
  }));
}

function mapEnvelopeToClaimsInternal(
  raw: unknown,
  options?: MapEnvelopeToClaimsOptions,
): EvidenceClaim[] {
  const parsed = parseClaimEnvelope(raw);
  if (!parsed.success) return [];
  const envelope = parsed.data;
  if (envelope.status === 'unverified_negative') return [];
  if (envelope.status !== 'ok') return [];
  if (!(claimableToolIds as readonly string[]).includes(envelope.toolId)) {
    return [];
  }
  if (disclosureBlocksClaim(envelope.data)) return [];
  if (observationAttemptsSelfTrust(envelope.data)) return [];
  if (
    envelope.manifestSha256ByBranch &&
    envelope.manifestSha256 &&
    !Object.values(envelope.manifestSha256ByBranch).includes(envelope.manifestSha256)
  ) {
    return [];
  }

  const authOpt = options?.requesterAuthorization;
  if (authOpt === undefined || authOpt === null) return [];

  const evidenceId = envelope.evidenceId;
  const expiresAt = options?.expiresAt ?? envelope.expiresAt;

  const gate = (kind: EvidenceClaim['kind']): boolean => {
    const validated = authorizeClaimKind(authOpt, kind);
    return (
      validated !== null &&
      (envelope.requesterAuthorizationId === undefined ||
        envelope.requesterAuthorizationId === validated.authorizationId)
    );
  };

  if (envelope.toolId === 'hms_find_reservation') {
    const data = reservationReadDataSchema.safeParse(envelope.data);
    if (!data.success) return [];
    const first = data.data.matches[0];
    if (!first) return [];
    if (!gate('reservation_summary')) return [];
    return [
      withEvidenceIds(
        {
          id: claimId(`${evidenceId}:reservation_summary`),
          kind: 'reservation_summary',
          value: {
            confirmationNumber: first.confirmationNumber ?? null,
            externalReference: first.externalReference ?? null,
            guestName: first.guestName ?? null,
            arrivalDate: first.arrivalDate ?? null,
            departureDate: first.departureDate ?? null,
            reservationStatus: first.reservationStatus ?? null,
            roomType: first.roomType ?? null,
            ratePlan: first.ratePlan ?? null,
          },
          evidenceId,
          expiresAt,
        },
        evidenceId,
      ),
    ];
  }

  if (envelope.toolId === 'hms_quote_stay') {
    const data = quoteStayReadDataSchema.safeParse(envelope.data);
    if (!data.success) return [];
    const observations = data.data.nightlyObservations;
    if (
      observations.length === 0 ||
      data.data.bookable !== false ||
      data.data.stayTotal !== null ||
      data.data.occupancyPriced !== false
    ) {
      return [];
    }
    if (!gate('quote_stay_summary')) return [];
    return [
      withEvidenceIds(
        {
          id: claimId(`${evidenceId}:quote_stay_summary`),
          kind: 'quote_stay_summary',
          value: {
            requestRef: data.data.requestRef ?? null,
            coveredNights: data.data.coveredNights ?? observations.map((row) => row.date),
            missingNights: data.data.missingNights ?? [],
            displayRateSum: data.data.displayRateSum ?? null,
            unresolvedInputs: data.data.unresolvedInputs ?? [],
            nights: observations.map((row) => ({
              date: row.date,
              roomType: row.roomType,
              availableCount: row.availableCount,
              ratePlan: row.ratePlan,
              displayedAmount: row.displayedAmount,
              currency: row.currency,
              rateBasis: row.rateBasis,
              restrictions: Array.isArray(row.restrictions) ? row.restrictions.join(', ') : '',
            })),
            bookable: false,
            stayTotal: null,
            occupancyPriced: false,
          },
          evidenceId,
          expiresAt,
        },
        evidenceId,
      ),
    ];
  }

  if (envelope.toolId === 'hms_list_documents') {
    const data = documentListReadDataSchema.safeParse(envelope.data);
    if (!data.success || data.data.rows.length === 0) return [];
    if (!gate('document_metadata')) return [];
    return [
      withEvidenceIds(
        {
          id: claimId(`${evidenceId}:document_metadata`),
          kind: 'document_metadata',
          value: mapDocumentMetadataClaim(data.data),
          evidenceId,
          expiresAt,
        },
        evidenceId,
      ),
    ];
  }

  if (envelope.toolId === 'hms_sent_email_audit') {
    const data = sentEmailAuditReadDataSchema.safeParse(envelope.data);
    if (!data.success || data.data.rows.length === 0) return [];
    if (!gate('sent_email_audit')) return [];
    return [
      withEvidenceIds(
        {
          id: claimId(`${evidenceId}:sent_email_audit`),
          kind: 'sent_email_audit',
          value: mapSentEmailAuditClaim(data.data),
          evidenceId,
          expiresAt,
        },
        evidenceId,
      ),
    ];
  }

  if (envelope.toolId === 'hms_read_folio') {
    const data = folioReadDataSchema.safeParse(envelope.data);
    if (!data.success) return [];
    const value = mapFolioDepositClaim(data.data);
    if (!value) return [];
    if (!gate('folio_deposit_summary')) return [];
    return [
      withEvidenceIds(
        {
          id: claimId(`${evidenceId}:folio_deposit_summary`),
          kind: 'folio_deposit_summary',
          value,
          evidenceId,
          expiresAt,
        },
        evidenceId,
      ),
    ];
  }

  if (envelope.toolId === 'hms_company_account_read') {
    const data = companyAccountReadDataSchema.safeParse(envelope.data);
    if (!data.success) return [];
    const value = mapCompanyBillingClaim(data.data);
    if (!value) return [];
    if (!gate('company_billing_summary')) return [];
    return [
      withEvidenceIds(
        {
          id: claimId(`${evidenceId}:company_billing_summary`),
          kind: 'company_billing_summary',
          value,
          evidenceId,
          expiresAt,
        },
        evidenceId,
      ),
    ];
  }

  if (envelope.toolId === 'hms_group_block_read') {
    const data = groupBlockReadDataSchema.safeParse(envelope.data);
    if (!data.success) return [];
    const value = mapGroupBlockClaim(data.data);
    if (!value) return [];
    if (!gate('group_block_summary')) return [];
    return [
      withEvidenceIds(
        {
          id: claimId(`${evidenceId}:group_block_summary`),
          kind: 'group_block_summary',
          value,
          evidenceId,
          expiresAt,
        },
        evidenceId,
      ),
    ];
  }

  if (envelope.toolId === 'hms_event_read') {
    const data = eventReadDataSchema.safeParse(envelope.data);
    if (!data.success) return [];
    const value = mapEventSummaryClaim(data.data);
    if (!value) return [];
    if (!gate('event_summary')) return [];
    return [
      withEvidenceIds(
        {
          id: claimId(`${evidenceId}:event_summary`),
          kind: 'event_summary',
          value,
          evidenceId,
          expiresAt,
        },
        evidenceId,
      ),
    ];
  }

  return [];
}

/** Build closed envelope from a ToolResult-shaped observation. */
export function toolResultToClaimEnvelope(result: {
  status: ClaimEnvelope['status'];
  data: unknown;
  evidence: {
    id: string;
    toolId: string;
    toolVersion: string;
    observedAt: string;
    sourceHash?: string;
    scopeVerified?: boolean;
    manifestSha256?: string;
    manifestSha256ByBranch?: Record<string, string>;
    scopeHash?: string;
    requesterAuthorizationId?: string;
    expiresAt?: string;
  };
}): unknown {
  return {
    toolId: result.evidence.toolId,
    toolVersion: result.evidence.toolVersion,
    status: result.status,
    observedAt: result.evidence.observedAt,
    ...(result.evidence.sourceHash ? { sourceHash: result.evidence.sourceHash } : {}),
    ...(result.evidence.scopeVerified === undefined
      ? {}
      : { scopeVerified: result.evidence.scopeVerified }),
    ...(result.evidence.manifestSha256 ? { manifestSha256: result.evidence.manifestSha256 } : {}),
    ...(result.evidence.manifestSha256ByBranch
      ? { manifestSha256ByBranch: result.evidence.manifestSha256ByBranch }
      : {}),
    ...(result.evidence.scopeHash ? { scopeHash: result.evidence.scopeHash } : {}),
    ...(result.evidence.requesterAuthorizationId
      ? { requesterAuthorizationId: result.evidence.requesterAuthorizationId }
      : {}),
    ...(result.evidence.expiresAt ? { expiresAt: result.evidence.expiresAt } : {}),
    evidenceId: result.evidence.id,
    data: result.data,
  };
}

export type { TrustedRequesterSourceState, TrustedRequesterAuthorizationV1 };
