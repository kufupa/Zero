import { z } from 'zod';

export type HmsEvidenceRef = {
  kind: 'hms';
  id: string;
  toolId: string;
  toolVersion: string;
  propertyCode: string;
  observedAt: string;
  expiresAt: string;
  claimKeys: string[];
  sourceHash: string;
};

export type MailEvidenceRef = {
  kind: 'mail_attachment';
  id: string;
  toolId: 'mail_read_artifact';
  toolVersion: string;
  attachmentId: string;
  observedAt: string;
  sourceHash: string;
  claimKeys: string[];
};

export type ToolResult<T> = {
  status: 'ok' | 'partial' | 'not_found' | 'ambiguous' | 'manual_required';
  draftReady: boolean;
  data: T;
  unresolvedFields: string[];
  evidence: HmsEvidenceRef | MailEvidenceRef;
};

export type EvidenceClaim = {
  id: string;
  kind:
    | 'reservation_status'
    | 'stay_dates'
    | 'inventory'
    | 'displayed_rate'
    | 'attachment_fact';
  value: unknown;
  evidenceId: string;
  expiresAt?: string;
};

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/i);

/** HMS evidence requires property; rejects raw body/text. */
export const HmsEvidenceRefSchema = z
  .object({
    kind: z.literal('hms'),
    id: z.string().min(1),
    toolId: z.string().min(1),
    toolVersion: z.string().min(1),
    propertyCode: z.string().min(1),
    observedAt: z.string().min(1),
    expiresAt: z.string().min(1),
    claimKeys: z.array(z.string().min(1)).max(64),
    sourceHash: sha256Hex,
  })
  .strict();

/** Attachment evidence requires attachment ID; rejects raw body/text. */
export const MailEvidenceRefSchema = z
  .object({
    kind: z.literal('mail_attachment'),
    id: z.string().min(1),
    toolId: z.literal('mail_read_artifact'),
    toolVersion: z.string().min(1),
    attachmentId: z.string().min(1),
    observedAt: z.string().min(1),
    sourceHash: sha256Hex,
    claimKeys: z.array(z.string().min(1)).max(64),
  })
  .strict();

export const EvidenceRefSchema = z.discriminatedUnion('kind', [
  HmsEvidenceRefSchema,
  MailEvidenceRefSchema,
]);

export const ToolResultSchema = z
  .object({
    status: z.enum(['ok', 'partial', 'not_found', 'ambiguous', 'manual_required']),
    draftReady: z.boolean(),
    data: z.unknown(),
    unresolvedFields: z.array(z.string()),
    evidence: EvidenceRefSchema,
  })
  .strict();

export const EvidenceClaimSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum([
      'reservation_status',
      'stay_dates',
      'inventory',
      'displayed_rate',
      'attachment_fact',
    ]),
    value: z.unknown(),
    evidenceId: z.string().min(1),
    expiresAt: z.string().min(1).optional(),
  })
  .strict();

export function isEvidenceFresh(
  evidence: HmsEvidenceRef | MailEvidenceRef,
  now: Date = new Date(),
): boolean {
  if (evidence.kind === 'hms') {
    const expires = Date.parse(evidence.expiresAt);
    if (Number.isNaN(expires)) return false;
    return expires > now.getTime();
  }
  // Mail attachment evidence has no TTL in the base ref; treat as fresh once observed.
  return true;
}

/**
 * draftReady requires status ok, no unresolved fields, and fresh evidence.
 * Partial/ambiguous/stale/manual never support a candidate.
 */
export function evaluateDraftReadiness<T>(
  result: ToolResult<T>,
  now: Date = new Date(),
): { draftReady: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (result.status !== 'ok') reasons.push(`status:${result.status}`);
  if (result.unresolvedFields.length > 0) reasons.push('unresolved_fields');
  if (!isEvidenceFresh(result.evidence, now)) reasons.push('stale_evidence');
  return { draftReady: reasons.length === 0 && result.draftReady, reasons };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Deterministic factual line for a typed claim. No free-form model prose. */
export function renderClaim(claim: EvidenceClaim): string {
  const v = asRecord(claim.value);
  switch (claim.kind) {
    case 'reservation_status': {
      const status = String(v.status ?? 'unknown');
      const confirmation = v.confirmation != null ? String(v.confirmation) : null;
      return confirmation
        ? `Reservation status: ${status} (confirmation ${confirmation}).`
        : `Reservation status: ${status}.`;
    }
    case 'stay_dates': {
      return `Stay dates: ${String(v.arrivalDate ?? '?')} to ${String(v.departureDate ?? '?')}.`;
    }
    case 'inventory': {
      const rooms = v.availableCount != null ? String(v.availableCount) : '?';
      const roomType = v.roomType != null ? String(v.roomType) : 'room';
      return `Inventory: ${rooms} available (${roomType}).`;
    }
    case 'displayed_rate': {
      const amount = String(v.amount ?? '?');
      const currency = String(v.currency ?? '');
      const basis = v.basis != null ? String(v.basis) : null;
      return basis
        ? `Displayed rate: ${amount} ${currency} (${basis}).`.replace(/  +/g, ' ')
        : `Displayed rate: ${amount} ${currency}.`.replace(/  +/g, ' ');
    }
    case 'attachment_fact': {
      const label = String(v.label ?? 'Attachment fact');
      const fact = String(v.fact ?? '');
      return `${label}: ${fact}`.trim();
    }
    default: {
      const _exhaustive: never = claim.kind;
      throw new Error(`unknown claim kind: ${_exhaustive}`);
    }
  }
}

export function renderFactualLines(
  selectedClaimIds: readonly string[],
  claims: ReadonlyMap<string, EvidenceClaim>,
): string[] {
  return selectedClaimIds.map((id) => {
    const claim = claims.get(id);
    if (!claim) throw new Error(`unknown claim: ${id}`);
    return renderClaim(claim);
  });
}
