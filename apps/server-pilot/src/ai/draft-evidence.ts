import type { QuarantinedNegative, ValidatedBusinessNotFound } from '../hms/negative-result.js';
import { toBusinessNotFoundToolStatus } from '../hms/negative-result.js';
import type { PreparedFact } from './prepared-draft-input.js';
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
  /** Private durable join to the finalized browser capture, when audited. */
  artifactRef?: string;
  /** All finalized branch artifacts joined by one typed result. */
  artifactRefs?: string[];
  scopeVerified?: boolean;
  /** Exact reviewed branch manifest and finance scope joins, when present. */
  manifestSha256?: string;
  /** Every reviewed branch exercised by one normal finance result. */
  manifestSha256ByBranch?: Record<string, string>;
  scopeHash?: string;
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
  status: 'ok' | 'partial' | 'not_found' | 'unverified_negative' | 'ambiguous' | 'manual_required';
  draftReady: boolean;
  data: T;
  unresolvedFields: string[];
  evidence: HmsEvidenceRef | MailEvidenceRef;
};

/**
 * Sole adapter from branded negative gate → ToolResult business `not_found`.
 * Unbranded / quarantined negatives stay `unverified_negative`.
 */
export function toolResultStatusFromNegativeGate(
  result: ValidatedBusinessNotFound | QuarantinedNegative,
): Extract<ToolResult<unknown>['status'], 'not_found' | 'unverified_negative'> {
  return toBusinessNotFoundToolStatus(result);
}

export type EvidenceClaim = {
  id: string;
  kind:
    | 'reservation_summary'
    | 'reservation_status'
    | 'stay_dates'
    | 'inventory'
    | 'displayed_rate'
    | 'quote_stay_summary'
    | 'document_metadata'
    | 'sent_email_audit'
    | 'folio_deposit_summary'
    | 'company_billing_summary'
    | 'group_block_summary'
    | 'event_summary'
    | 'workflow_summary';
  value: unknown;
  evidenceId: string;
  /** Closed envelope claims always set evidenceIds (primary first). */
  evidenceIds?: string[];
  observedAt?: string;
  sourceHash?: string;
  scopeVerified?: boolean;
  expiresAt?: string;
};

/** Convert a code-owned claim to the bounded fact shape used by U5 replies. */
export function evidenceClaimToPreparedFact(claim: EvidenceClaim): PreparedFact {
  const source =
    claim.kind === 'document_metadata' || claim.kind === 'sent_email_audit' ? 'attachment' : 'hms';
  return {
    key: `claim.${claim.kind}`,
    label: claim.kind.replace(/_/g, ' '),
    value: claim.value,
    source,
    authority: 'authorized',
    status: 'known',
    evidenceRef: claim.evidenceId,
    ...(claim.observedAt ? { observedAt: claim.observedAt } : {}),
    ...(claim.sourceHash ? { sourceHash: claim.sourceHash } : {}),
    ...(claim.scopeVerified === undefined ? {} : { scopeVerified: claim.scopeVerified }),
    ...(claim.expiresAt ? { expiresAt: claim.expiresAt } : {}),
  };
}

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
    artifactRef: z.string().min(1).optional(),
    artifactRefs: z.array(z.string().min(1)).min(1).optional(),
    scopeVerified: z.boolean().optional(),
    manifestSha256: sha256Hex.optional(),
    manifestSha256ByBranch: z.record(sha256Hex).optional(),
    scopeHash: sha256Hex.optional(),
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
    status: z.enum([
      'ok',
      'partial',
      'not_found',
      'unverified_negative',
      'ambiguous',
      'manual_required',
    ]),
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
      'reservation_summary',
      'reservation_status',
      'stay_dates',
      'inventory',
      'displayed_rate',
      'quote_stay_summary',
      'document_metadata',
      'sent_email_audit',
      'folio_deposit_summary',
      'company_billing_summary',
      'group_block_summary',
      'event_summary',
      'workflow_summary',
    ]),
    value: z.unknown(),
    evidenceId: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)).min(1).max(16).optional(),
    expiresAt: z.string().min(1).optional(),
  })
  .strict();

export function isEvidenceFresh(
  evidence: HmsEvidenceRef | MailEvidenceRef,
  now: Date = new Date(),
): boolean {
  const observed = Date.parse(evidence.observedAt);
  if (Number.isNaN(observed) || observed > now.getTime()) return false;
  if (!sha256Hex.safeParse(evidence.sourceHash).success) return false;
  if (evidence.kind === 'hms') {
    const expires = Date.parse(evidence.expiresAt);
    if (Number.isNaN(expires)) return false;
    return expires > now.getTime();
  }
  // Mail attachment evidence has no TTL in the base ref; it is fresh only
  // after a valid, non-future observation.
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
    case 'reservation_summary': {
      const reference = String(
        v.confirmationNumber ?? v.externalReference ?? 'reference unavailable',
      );
      const status = String(v.reservationStatus ?? 'status unavailable');
      const guest = String(v.guestName ?? 'guest unavailable');
      const arrival = String(v.arrivalDate ?? '?');
      const departure = String(v.departureDate ?? '?');
      const room = String(v.roomType ?? 'unavailable');
      const ratePlan = String(v.ratePlan ?? 'unavailable');
      return `Reservation ${reference}: ${status}, ${guest}, ${arrival} to ${departure}, room ${room}, rate plan ${ratePlan}.`;
    }
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
    case 'quote_stay_summary': {
      const nights = Array.isArray(v.nights) ? v.nights : [];
      const rendered = nights
        .map((night) => {
          const row = asRecord(night);
          return `${String(row.date)}: ${String(row.roomType)}, ${String(row.availableCount)} available, ${String(row.displayedAmount)} ${String(row.currency)} ${String(row.rateBasis)}, restrictions ${String(row.restrictions)}`;
        })
        .join('; ');
      return `Observed stay quote: ${rendered}. Caveat: displayed nightly rates only; not bookable, no stay total, and occupancy pricing is unverified.`;
    }
    case 'document_metadata': {
      const rows = Array.isArray(v.rows) ? v.rows : [];
      const rendered = rows
        .map((row) => {
          const item = asRecord(row);
          return `${String(item.documentType)} ${String(item.status)} from ${String(item.sourceClass)}, retrievable false`;
        })
        .join('; ');
      return `Document metadata only: ${rendered}. Inventory is incomplete; delivery credit is Partial.`;
    }
    case 'sent_email_audit': {
      const rows = Array.isArray(v.rows) ? v.rows : [];
      const rendered = rows
        .map((row) => {
          const item = asRecord(row);
          return `${String(item.sentAt)} ${String(item.subjectClass)}, attachment ${String(item.attachmentPresent)}, error ${String(item.errorClass)}`;
        })
        .join('; ');
      return `Sent email audit (recipient exact-match redacted): ${rendered}.`;
    }
    case 'folio_deposit_summary': {
      const deposit = asRecord(v.depositSummary);
      const status = ['due', 'paid', 'refunded', 'forfeited', 'transferred']
        .map((key) => {
          const item = asRecord(deposit[key]);
          return `${key} ${String(item.amount)} (${String(item.status)})`;
        })
        .join(', ');
      const credit =
        v.responseCredit === 'full_labelled_narrow_status'
          ? 'Full credit: labelled narrow status inquiry only'
          : 'Partial credit: status only';
      return `Folio/deposit summary: balance ${String(v.totalBalance)} ${String(v.currency)}; deposits total ${String(deposit.total)} ${String(v.currency)}; ${status}. ${credit}.`;
    }
    case 'company_billing_summary': {
      return `Company billing summary (${String(v.organizationClass)}): eligibility ${String(v.billingEligibility)}, mode ${String(v.billingMode)}, payment terms ${String(v.paymentTermClass)}, contract ${String(v.contractStatus)}. Full credit: labelled company billing inquiry only.`;
    }
    case 'group_block_summary': {
      const rows = Array.isArray(v.rows) ? v.rows : [];
      const rendered = rows
        .map((row) => {
          const item = asRecord(row);
          const restrictions = Array.isArray(item.restrictions) ? item.restrictions.join(', ') : '';
          return `${String(item.date)} ${String(item.roomTypeClass)}: CON ${String(item.con)}, BLK ${String(item.blk)}, pickup ${String(item.pickup)}, remaining ${String(item.remaining)}, restrictions ${restrictions || 'none'}`;
        })
        .join('; ');
      const credit =
        v.responseCredit === 'full_existing_group_status'
          ? 'Full credit: existing group-status inquiry only'
          : 'Partial credit: status only';
      return `Group block summary: ${String(v.groupStatus)}, ${String(v.startDate)} to ${String(v.endDate)}; ${rendered}. ${credit}.`;
    }
    case 'event_summary': {
      const credit =
        v.responseCredit === 'full_existing_event_status'
          ? 'Full credit: existing event-status inquiry only'
          : 'Partial credit: status only';
      return `Event summary: ${String(v.eventStatus)} ${String(v.eventTypeClass)}, ${String(v.startAt)} to ${String(v.endAt)}, attendees ${String(v.attendeeCount)}, total ${String(v.total)} ${String(v.currency)}, deposit ${String(v.depositStatus)}. ${credit}.`;
    }
    case 'workflow_summary': {
      const evidenceIds = Array.isArray(v.evidenceIds) ? v.evidenceIds : [];
      const planKind = String(v.planKind ?? 'unknown');
      return `Workflow summary (${planKind}): ${evidenceIds.length} evidence pack(s). Select whole claim IDs only.`;
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

export function renderOpening(opening: 'acknowledge_request' | 'thanks_for_details'): string {
  return opening === 'acknowledge_request'
    ? 'Thank you for your request. Here is what we can confirm from our records:'
    : 'Thank you for the details. Based on the information on file:';
}

export function renderClosing(closing: 'invite_questions' | 'await_confirmation'): string {
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
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

  const factualLines = plan.selectedClaimIds.map((id) => renderClaim(requireClaim(claims, id)));
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

/**
 * Square-bracket placeholder for facts we must not invent.
 * Prefer naming the read tool or a named blocker over vague "unknown".
 */
export function formatMissingBracket(input: { need: string; acquisition: string }): string {
  const need = input.need.trim();
  const acquisition = input.acquisition.trim();
  if (!need) throw new Error('missing bracket need required');
  if (!acquisition) throw new Error('missing bracket acquisition required');
  return `[MISSING: ${need} | how: ${acquisition}]`;
}

export function listMissingBrackets(
  fields: ReadonlyArray<{ field: string; acquisition: string }>,
): string[] {
  return fields.map((f) => formatMissingBracket({ need: f.field, acquisition: f.acquisition }));
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
    if (claim.kind === 'workflow_summary') {
      const value = asRecord(claim.value);
      const evidenceIds = Array.isArray(value.evidenceIds)
        ? value.evidenceIds.map(String)
        : [claim.evidenceId];
      for (const evidenceId of evidenceIds) {
        if (!input.eligibleEvidenceIds.has(evidenceId)) {
          throw new Error(`claim cites ineligible evidence: ${id}`);
        }
      }
      continue;
    }
    if (!input.eligibleEvidenceIds.has(claim.evidenceId)) {
      throw new Error(`claim cites ineligible evidence: ${id}`);
    }
  }
}
