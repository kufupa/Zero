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

export type CandidateDraftPlan =
  | {
      outcome: 'candidate';
      salutation: 'first_name' | 'generic';
      openingTemplate: 'acknowledge_request' | 'thanks_for_details';
      selectedClaimIds: string[];
      closingTemplate: 'invite_questions' | 'await_confirmation';
    }
  | {
      outcome: 'needs_clarification' | 'insufficient_evidence';
      questionCodes: string[];
      unavailableSources: string[];
    };

export const CandidateDraftPlanSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('candidate'),
      salutation: z.enum(['first_name', 'generic']),
      openingTemplate: z.enum(['acknowledge_request', 'thanks_for_details']),
      selectedClaimIds: z.array(z.string().min(1)).min(1),
      closingTemplate: z.enum(['invite_questions', 'await_confirmation']),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('needs_clarification'),
      questionCodes: z.array(z.string().min(1)).min(1),
      unavailableSources: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('insufficient_evidence'),
      questionCodes: z.array(z.string()),
      unavailableSources: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);

const QUESTION_TEXT: Record<string, string> = {
  missing_confirmation: 'Could you share your confirmation number?',
  missing_stay_dates: 'Could you confirm your arrival and departure dates?',
  missing_guest_name: 'Could you confirm the guest surname on the reservation?',
  ambiguous_match: 'We found more than one matching reservation — which confirmation is yours?',
  source_unavailable: 'We could not reach the property system just now; we will follow up shortly.',
};

export function renderSalutation(salutation: 'first_name' | 'generic'): string {
  return salutation === 'first_name' ? 'Hi,' : 'Hello,';
}

export function renderOpening(
  opening: 'acknowledge_request' | 'thanks_for_details',
): string {
  return opening === 'acknowledge_request'
    ? 'Thank you for your request. Here is what we can confirm from our records:'
    : 'Thank you for the details. Based on the information on file:';
}

export function renderClosing(
  closing: 'invite_questions' | 'await_confirmation',
): string {
  return closing === 'invite_questions'
    ? 'Please let us know if you have any questions.\n\nBest regards,\nFront Office'
    : 'We await your confirmation to proceed.\n\nBest regards,\nFront Office';
}

export function renderClarificationQuestions(questionCodes: readonly string[]): string[] {
  return questionCodes.map(
    (code) => QUESTION_TEXT[code] ?? 'Could you provide additional details so we can assist?',
  );
}

/** Escape + paragraphize; model never supplies HTML. */
export function textToSafeHtml(text: string): string {
  const escape = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  return text
    .split(/\n\n+/)
    .filter((p) => p.length > 0)
    .map((p) => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function requireClaim(
  claims: ReadonlyMap<string, EvidenceClaim>,
  id: string,
): EvidenceClaim {
  const claim = claims.get(id);
  if (!claim) throw new Error(`unknown claim: ${id}`);
  return claim;
}

/**
 * Deterministic candidate body from approved templates + selected claims.
 * Non-candidate outcomes return the plan unchanged (no draft body).
 */
export function renderCandidate(
  plan: CandidateDraftPlan,
  claims: ReadonlyMap<string, EvidenceClaim>,
):
  | CandidateDraftPlan
  | { outcome: 'candidate'; textBody: string; htmlBody: string; plan: CandidateDraftPlan } {
  if (plan.outcome !== 'candidate') return plan;

  const factualLines = plan.selectedClaimIds.map((id) =>
    renderClaim(requireClaim(claims, id)),
  );
  const textBody = [
    renderSalutation(plan.salutation),
    renderOpening(plan.openingTemplate),
    ...factualLines,
    renderClosing(plan.closingTemplate),
  ].join('\n\n');

  return {
    outcome: 'candidate',
    textBody,
    htmlBody: textToSafeHtml(textBody),
    plan,
  };
}

/** Money / ISO date / confirmation-like tokens that must come from claims. */
const CRITICAL_LITERAL_PATTERNS = [
  /\b(?:ZAR|R)\s?\d[\d,.]*/gi,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\bCONF-[A-Z0-9-]{2,}\b/gi,
  /\bEXT-[A-Z0-9-]{2,}\b/gi,
];

/**
 * Reject model-authored money/date/reference literals that are not present
 * in the deterministic claim renderings for selectedClaimIds.
 */
export function assertNoUncitedCriticalLiterals(input: {
  textBody: string;
  selectedClaimIds: readonly string[];
  claims: ReadonlyMap<string, EvidenceClaim>;
}): void {
  const allowed = new Set(
    input.selectedClaimIds.flatMap((id) => {
      const line = renderClaim(requireClaim(input.claims, id));
      return CRITICAL_LITERAL_PATTERNS.flatMap((re) => {
        re.lastIndex = 0;
        return line.match(re) ?? [];
      });
    }),
  );
  const normalize = (v: string) => v.toLocaleLowerCase().replace(/\s+/g, '');
  const allowedNorm = new Set([...allowed].map(normalize));

  for (const re of CRITICAL_LITERAL_PATTERNS) {
    re.lastIndex = 0;
    for (const match of input.textBody.match(re) ?? []) {
      if (!allowedNorm.has(normalize(match))) {
        throw new Error(`uncited critical literal: ${match}`);
      }
    }
  }
}

/**
 * Candidate plan may only select claims that cite currently eligible evidence
 * (ok + draftReady + fresh + empty unresolved).
 */
export function assertSelectedClaimsEligible(input: {
  selectedClaimIds: readonly string[];
  claims: ReadonlyMap<string, EvidenceClaim>;
  eligibleEvidenceIds: ReadonlySet<string>;
}): void {
  for (const id of input.selectedClaimIds) {
    const claim = requireClaim(input.claims, id);
    if (!input.eligibleEvidenceIds.has(claim.evidenceId)) {
      throw new Error(`claim cites ineligible evidence: ${id}`);
    }
  }
}
