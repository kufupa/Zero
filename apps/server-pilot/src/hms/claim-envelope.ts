/**
 * Closed generic tool observation → typed summary claim envelopes.
 * Disclosure gate runs before claim creation; extra fields rejected.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EvidenceClaim } from '../ai/draft-evidence.js';
import { reservationReadDataSchema } from './contracts.js';
import {
  mapCompanyBillingClaim,
  companyAccountReadDataSchema,
} from './company-account-read-contract.js';
import {
  mapDocumentMetadataClaim,
  documentListReadDataSchema,
} from './document-list-contract.js';
import {
  mapEventSummaryClaim,
  eventReadDataSchema,
} from './event-read-contract.js';
import {
  mapFolioDepositClaim,
  folioReadDataSchema,
} from './folio-read-contract.js';
import {
  mapGroupBlockClaim,
  groupBlockReadDataSchema,
} from './group-block-read-contract.js';
import { quoteStayReadDataSchema } from './quote-stay-contract.js';
import {
  mapSentEmailAuditClaim,
  sentEmailAuditReadDataSchema,
} from './sent-email-audit-contract.js';
import { READ_TOOL_IDS, type ReadToolId } from './read-tools.js';

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

function withEvidenceIds(
  claim: EvidenceClaim,
  evidenceId: string,
): EvidenceClaim {
  return {
    ...claim,
    evidenceId,
    evidenceIds: [evidenceId],
  };
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
 */
export function mapEnvelopeToClaims(
  raw: unknown,
  options?: { expiresAt?: string },
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

  const evidenceId = envelope.evidenceId;
  const expiresAt = options?.expiresAt;

  if (envelope.toolId === 'hms_find_reservation') {
    const data = reservationReadDataSchema.safeParse(envelope.data);
    if (!data.success) return [];
    const first = data.data.matches[0];
    if (!first) return [];
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
    return [
      withEvidenceIds(
        {
          id: claimId(`${evidenceId}:quote_stay_summary`),
          kind: 'quote_stay_summary',
          value: {
            nights: observations.map((row) => ({
              date: row.date,
              roomType: row.roomType,
              availableCount: row.availableCount,
              ratePlan: row.ratePlan,
              displayedAmount: row.displayedAmount,
              currency: row.currency,
              rateBasis: row.rateBasis,
              restrictions: Array.isArray(row.restrictions)
                ? row.restrictions.join(', ')
                : '',
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
  };
}): unknown {
  return {
    toolId: result.evidence.toolId,
    toolVersion: result.evidence.toolVersion,
    status: result.status,
    observedAt: result.evidence.observedAt,
    evidenceId: result.evidence.id,
    data: result.data,
  };
}
