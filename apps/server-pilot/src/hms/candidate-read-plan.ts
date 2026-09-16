/**
 * Closed CandidateReadPlan + promoted-only portfolio ablation / load replay.
 * Model never chooses tools or loops — code owns the plan; model picks claim IDs.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EvidenceClaim } from '../ai/draft-evidence.js';
import {
  trustedRequesterAuthorizationV1Schema,
  type TrustedRequesterAuthorizationV1,
} from './contracts.js';
import type { HmsPortfolioToolReleaseV2 } from './release-kernel.js';
import {
  isProductionActiveReadTool,
  portfolioAblationReplay,
  productionActiveReadToolIds,
  READ_TOOLS,
  type AblationOutcome,
  type AblationReport,
  type PortfolioCaseV3,
  type ReadToolId,
} from './read-tools.js';

export const MAX_RESERVATION_FOLLOWUPS = 2;
export const MAX_TOTAL_READ_ATTEMPTS = 6;

export const RESERVATION_FOLLOWUP_KINDS = [
  'documents',
  'sent_email',
  'folio',
  'company',
] as const;

export type ReservationFollowupKind = (typeof RESERVATION_FOLLOWUP_KINDS)[number];

const followupSchema = z.enum(RESERVATION_FOLLOWUP_KINDS);

const uniqueFollowups = z
  .array(followupSchema)
  .max(MAX_RESERVATION_FOLLOWUPS)
  .superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'followups must be unique',
      });
    }
  });

export const candidateReadPlanSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('reservation'),
      find: z.literal(true),
      followups: uniqueFollowups,
    })
    .strict(),
  z
    .object({
      kind: z.literal('artifact_reservation'),
      artifacts: z.number().int().min(1).max(3),
      find: z.literal(true),
      followups: uniqueFollowups,
    })
    .strict(),
  z
    .object({
      kind: z.literal('quote'),
      quote: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('group'),
      group: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('event'),
      event: z.literal(true),
    })
    .strict(),
]);

export type CandidateReadPlan = z.infer<typeof candidateReadPlanSchema>;

export const FOLLOWUP_TOOL_IDS: Readonly<
  Record<ReservationFollowupKind, ReadToolId>
> = {
  documents: 'hms_list_documents',
  sent_email: 'hms_sent_email_audit',
  folio: 'hms_read_folio',
  company: 'hms_company_account_read',
};

export function followupToToolId(kind: ReservationFollowupKind): ReadToolId {
  return FOLLOWUP_TOOL_IDS[kind];
}

/** Canonical release order; ablation membership uses promoted subset only. */
export const PORTFOLIO_RELEASE_ORDER: readonly ReadToolId[] = [
  'hms_find_reservation',
  'hms_quote_stay',
  'hms_list_documents',
  'hms_sent_email_audit',
  'hms_read_folio',
  'hms_company_account_read',
  'hms_group_block_read',
  'hms_event_read',
];

export function promotedPortfolioReleaseOrder(): ReadToolId[] {
  const active = new Set(productionActiveReadToolIds());
  return PORTFOLIO_RELEASE_ORDER.filter((id) => active.has(id));
}

export type PlanSignals = {
  authoredSegment: string;
  attachmentCount: number;
  hasExactReservationCandidate: boolean;
  hasQuoteCandidate: boolean;
  hasGroupRef: boolean;
  hasEventRef: boolean;
};

const FOLLOWUP_SIGNAL_PRIORITY: ReadonlyArray<{
  kind: ReservationFollowupKind;
  pattern: RegExp;
}> = [
  { kind: 'documents', pattern: /\b(tax\s*invoice|document|invoice|pro[\s-]?forma)\b/i },
  { kind: 'sent_email', pattern: /\b(sent\s+email|email\s+sent|confirmation\s+email)\b/i },
  { kind: 'folio', pattern: /\b(folio|balance|deposit|payment\s+status)\b/i },
  { kind: 'company', pattern: /\b(company|agency|billing\s+terms|bill[\s-]?to)\b/i },
];

/**
 * Select followup *request classes* from authored segment without silently
 * dropping overflow. Returns prioritized classes (may exceed MAX followups).
 */
export function selectRequestedFollowupClasses(
  segment: string,
): ReservationFollowupKind[] {
  const selected: ReservationFollowupKind[] = [];
  for (const entry of FOLLOWUP_SIGNAL_PRIORITY) {
    if (entry.pattern.test(segment)) selected.push(entry.kind);
  }
  return selected;
}

function selectFollowups(segment: string): ReservationFollowupKind[] {
  return selectRequestedFollowupClasses(segment).slice(
    0,
    MAX_RESERVATION_FOLLOWUPS,
  );
}

/**
 * Deterministic code-owned planner. One closed branch; max two unique followups.
 * Model cannot request arbitrary tools or loops.
 */
export function planCandidateReads(signals: PlanSignals): CandidateReadPlan {
  const segment = signals.authoredSegment.trim();
  if (
    signals.hasQuoteCandidate &&
    /\b(availab|quote|rate|night|occupanc)/i.test(segment)
  ) {
    return candidateReadPlanSchema.parse({ kind: 'quote', quote: true });
  }
  if (signals.hasGroupRef) {
    return candidateReadPlanSchema.parse({ kind: 'group', group: true });
  }
  if (signals.hasEventRef) {
    return candidateReadPlanSchema.parse({ kind: 'event', event: true });
  }
  const followups = selectFollowups(segment);
  if (signals.attachmentCount > 0) {
    return candidateReadPlanSchema.parse({
      kind: 'artifact_reservation',
      artifacts: Math.min(3, Math.max(1, signals.attachmentCount)),
      find: true,
      followups,
    });
  }
  return candidateReadPlanSchema.parse({
    kind: 'reservation',
    find: true,
    followups,
  });
}

export function plannedToolIds(plan: CandidateReadPlan): ReadToolId[] {
  switch (plan.kind) {
    case 'reservation':
      return [
        'hms_find_reservation',
        ...plan.followups.map(followupToToolId),
      ];
    case 'artifact_reservation':
      return [
        'hms_find_reservation',
        ...plan.followups.map(followupToToolId),
      ];
    case 'quote':
      return ['hms_quote_stay'];
    case 'group':
      return ['hms_group_block_read'];
    case 'event':
      return ['hms_event_read'];
    default: {
      const _exhaustive: never = plan;
      return _exhaustive;
    }
  }
}

/**
 * Production mode strips fixture-only / blocked tools so proven allowlist
 * never couples to company/group/event/folio/quote discovery blockers.
 */
export function executableToolIdsForPlan(
  plan: CandidateReadPlan,
  mode: 'production' | 'fixture' = 'production',
): ReadToolId[] {
  const planned = plannedToolIds(plan);
  if (mode === 'fixture') return planned;
  return planned.filter(isProductionActiveReadTool);
}

export type ExecutableReadStep = {
  toolId: ReadToolId;
  requestBranchId: string | null;
  candidateId: string;
  releaseId: string;
  requesterAuthorizationId: string;
  attemptCost: 1;
};

export type ExecutableReadPlanResult = {
  status: 'complete' | 'manual_required';
  steps: ExecutableReadStep[];
  omittedRequestClasses: string[];
};

export type CandidateBinding = {
  candidateId: string;
  toolId: ReadToolId;
  allowedRequestBranchIds: readonly string[];
  parentEvidenceId: string | null;
  requesterAuthorizationId: string;
};

export type ReadonlyCandidateBindings = ReadonlyMap<string, CandidateBinding>;

/**
 * Deterministic branch selection from authored segment + enabled release branches.
 * Ambiguous or disabled → null (caller marks manual_required); never falls back.
 */
export function selectRequestBranchId(input: {
  toolId: ReadToolId;
  authoredSegment: string;
  enabledBranchIds: readonly string[];
}): string | null {
  const enabled = new Set(input.enabledBranchIds);
  const tool = READ_TOOLS[input.toolId];
  if (tool.id === 'mail_read_artifact') return null;
  const branches = tool.requestBranches.filter((b) => enabled.has(b.id));
  if (branches.length === 0) return null;
  if (branches.length === 1) return branches[0]!.id;

  const matches = branches.filter((branch) => {
    if (
      branch.id.includes('tax_invoice') ||
      branch.discoveryOperationId === 'tax_invoice_list'
    ) {
      return /\b(tax\s*invoice|invoice|pro[\s-]?forma)\b/i.test(
        input.authoredSegment,
      );
    }
    if (
      branch.id.includes('sent_email') ||
      branch.discoveryOperationId === 'sent_email_list'
    ) {
      return /\b(sent\s+email|email\s+sent|confirmation\s+email)\b/i.test(
        input.authoredSegment,
      );
    }
    if (branch.discoveryOperationId === 'folio_summary') {
      return /\bfolio\b/i.test(input.authoredSegment);
    }
    if (branch.discoveryOperationId === 'deposit_ledger_summary') {
      return /\b(deposit|ledger)\b/i.test(input.authoredSegment);
    }
    return false;
  });
  if (matches.length === 1) return matches[0]!.id;
  return null;
}

/**
 * Derive executable steps before any browser I/O.
 * Reservation followup limit applies AFTER branch expansion.
 * >2 requested classes → first two steps + manual_required + every omitted class.
 * Total durable cap remains six.
 */
export function executableReadStepsForPlan(
  plan: CandidateReadPlan,
  activeReleases: ReadonlyMap<ReadToolId, HmsPortfolioToolReleaseV2>,
  candidates: ReadonlyCandidateBindings,
  requesterAuthorization: TrustedRequesterAuthorizationV1,
  options?: {
    authoredSegment?: string;
    requestedFollowupClasses?: readonly ReservationFollowupKind[];
  },
): ExecutableReadPlanResult {
  const authoredSegment = options?.authoredSegment ?? '';
  const steps: ExecutableReadStep[] = [];
  const omittedRequestClasses: string[] = [];
  let status: 'complete' | 'manual_required' = 'complete';

  const pushStep = (
    toolId: ReadToolId,
    candidateId: string,
    requestBranchId: string | null,
  ): boolean => {
    if (steps.length >= MAX_TOTAL_READ_ATTEMPTS) {
      omittedRequestClasses.push(toolId);
      status = 'manual_required';
      return false;
    }
    const release = activeReleases.get(toolId);
    if (!release) {
      omittedRequestClasses.push(toolId);
      status = 'manual_required';
      return false;
    }
    const binding = candidates.get(candidateId);
    if (!binding || binding.toolId !== toolId) {
      omittedRequestClasses.push(toolId);
      status = 'manual_required';
      return false;
    }
    if (
      binding.requesterAuthorizationId !==
      requesterAuthorization.authorizationId
    ) {
      throw new Error('stale or cross-thread requester authorization rejected');
    }
    if (requestBranchId !== null) {
      if (!binding.allowedRequestBranchIds.includes(requestBranchId)) {
        throw new Error('sibling-branch swap rejected');
      }
      if (release.evidenceKind === 'hms') {
        const enabled = release.requestBranches.some(
          (b) => b.id === requestBranchId,
        );
        if (!enabled) {
          omittedRequestClasses.push(`${toolId}:${requestBranchId}`);
          status = 'manual_required';
          return false;
        }
      }
    }
    steps.push({
      toolId,
      requestBranchId,
      candidateId,
      releaseId: release.releaseId,
      requesterAuthorizationId: requesterAuthorization.authorizationId,
      attemptCost: 1,
    });
    return true;
  };

  const resolveBranch = (toolId: ReadToolId): string | null => {
    const release = activeReleases.get(toolId);
    if (!release || release.evidenceKind !== 'hms') return null;
    const enabledIds = release.requestBranches.map((b) => b.id);
    const selected = selectRequestBranchId({
      toolId,
      authoredSegment,
      enabledBranchIds: enabledIds,
    });
    if (selected === null && enabledIds.length > 0) {
      status = 'manual_required';
      omittedRequestClasses.push(`${toolId}:ambiguous_or_disabled_branch`);
    }
    return selected;
  };

  const findCandidate = (toolId: ReadToolId): string | null => {
    for (const [id, binding] of candidates) {
      if (binding.toolId === toolId) return id;
    }
    return null;
  };

  const appendFollowups = (
    followups: readonly ReservationFollowupKind[],
  ): void => {
    const requested = options?.requestedFollowupClasses ?? followups;
    const taken = followups.slice(0, MAX_RESERVATION_FOLLOWUPS);
    const omitted = requested.filter((k) => !taken.includes(k));
    for (const kind of omitted) {
      omittedRequestClasses.push(kind);
      status = 'manual_required';
    }
    let followupCount = 0;
    for (const kind of taken) {
      if (followupCount >= MAX_RESERVATION_FOLLOWUPS) break;
      const toolId = followupToToolId(kind);
      const candidateId = findCandidate(toolId);
      if (!candidateId) {
        omittedRequestClasses.push(kind);
        status = 'manual_required';
        continue;
      }
      const binding = candidates.get(candidateId)!;
      if (!binding.parentEvidenceId) {
        omittedRequestClasses.push(`${kind}:missing_parent_evidence`);
        status = 'manual_required';
        continue;
      }
      const branch = resolveBranch(toolId);
      if (!branch) {
        status = 'manual_required';
        continue;
      }
      if (pushStep(toolId, candidateId, branch)) followupCount += 1;
    }
  };

  switch (plan.kind) {
    case 'artifact_reservation': {
      const findId = findCandidate('hms_find_reservation');
      if (findId) {
        const branch = resolveBranch('hms_find_reservation');
        if (branch) pushStep('hms_find_reservation', findId, branch);
        else status = 'manual_required';
      } else {
        omittedRequestClasses.push('hms_find_reservation');
        status = 'manual_required';
      }
      appendFollowups(plan.followups);
      break;
    }
    case 'reservation': {
      const findId = findCandidate('hms_find_reservation');
      if (findId) {
        const branch = resolveBranch('hms_find_reservation');
        if (branch) pushStep('hms_find_reservation', findId, branch);
        else status = 'manual_required';
      } else {
        omittedRequestClasses.push('hms_find_reservation');
        status = 'manual_required';
      }
      appendFollowups(plan.followups);
      break;
    }
    case 'quote':
    case 'group':
    case 'event': {
      const toolId =
        plan.kind === 'quote'
          ? 'hms_quote_stay'
          : plan.kind === 'group'
            ? 'hms_group_block_read'
            : 'hms_event_read';
      const candidateId = findCandidate(toolId);
      if (!candidateId) {
        omittedRequestClasses.push(toolId);
        status = 'manual_required';
        break;
      }
      const branch = resolveBranch(toolId);
      if (branch) pushStep(toolId, candidateId, branch);
      else status = 'manual_required';
      break;
    }
    default: {
      const _exhaustive: never = plan;
      return _exhaustive;
    }
  }

  if (steps.length > MAX_TOTAL_READ_ATTEMPTS) {
    throw new Error('executable plan exceeded total cap of six');
  }

  return {
    status,
    steps,
    omittedRequestClasses: [...new Set(omittedRequestClasses)],
  };
}

/** Full scoring forbidden when plan omitted request classes. */
export function canScoreFull(result: ExecutableReadPlanResult): boolean {
  return (
    result.status === 'complete' && result.omittedRequestClasses.length === 0
  );
}

/** Map lookup candidate kind → active release tool (null if no matching release). */
export function toolIdForLookupCandidateKind(
  kind: string,
  activeReleases: ReadonlyMap<ReadToolId, HmsPortfolioToolReleaseV2>,
): ReadToolId | null {
  if (kind === 'confirmation' || kind === 'external_reference') {
    return activeReleases.has('hms_find_reservation')
      ? 'hms_find_reservation'
      : null;
  }
  if (kind === 'surname_dates') {
    if (activeReleases.has('hms_quote_stay')) return 'hms_quote_stay';
    if (activeReleases.has('hms_find_reservation')) return 'hms_find_reservation';
    return null;
  }
  return null;
}

/**
 * Bind opaque candidates to active releases + requester auth id.
 * Branch allow-list = release-enabled branches (selectRequestBranchId picks one).
 */
export function buildPlanScopedCandidateBindings(input: {
  lookupCandidates: ReadonlyMap<string, { id: string; kind: string }>;
  activeReleases: ReadonlyMap<ReadToolId, HmsPortfolioToolReleaseV2>;
  requesterAuthorizationId: string;
  authorizedAttachmentIds?: ReadonlySet<string>;
}): Map<string, CandidateBinding> {
  const out = new Map<string, CandidateBinding>();
  for (const [id, cand] of input.lookupCandidates) {
    const toolId = toolIdForLookupCandidateKind(
      cand.kind,
      input.activeReleases,
    );
    if (!toolId) continue;
    const release = input.activeReleases.get(toolId);
    if (!release) continue;
    const allowedRequestBranchIds =
      release.evidenceKind === 'hms'
        ? release.requestBranches.map((b) => b.id)
        : [];
    out.set(id, {
      candidateId: id,
      toolId,
      allowedRequestBranchIds,
      parentEvidenceId: null,
      requesterAuthorizationId: input.requesterAuthorizationId,
    });
  }
  return out;
}

/**
 * Run-scoped TrustedRequesterAuthorization for plan gate binding.
 * Digests are deterministic from operationId (not mailbox-trust proof).
 */
export function mintPlanScopedRequesterAuthorization(input: {
  operationId: string;
  now?: Date;
  ttlMs?: number;
}): TrustedRequesterAuthorizationV1 {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? 15 * 60_000;
  const digest = (purpose: string) =>
    createHash('sha256')
      .update(`plan-scoped:${purpose}:${input.operationId}`)
      .digest('hex');
  return trustedRequesterAuthorizationV1Schema.parse({
    schemaVersion: 1,
    authorizationId: digest('authorization'),
    operationId: input.operationId,
    mailboxGrantSha256: digest('mailbox'),
    threadIdHmacSha256: digest('thread'),
    threadStateVersion: '1',
    requesterIdentityHmacSha256: digest('identity'),
    requesterClass: 'reservation_guest',
    inquiryClass: 'labelled_narrow_status',
    allowedClaimKinds: ['reservation_summary'],
    privateDigestKeyVersion: 'v1',
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
}

export type PlanScopedDraftGate = {
  candidateBindings: ReadonlyMap<string, CandidateBinding>;
  requesterAuthorization: TrustedRequesterAuthorizationV1;
};

/**
 * When activeReleases empty/absent → null (legacy executableToolIdsForPlan).
 * When non-empty → bindings + auth so executableReadStepsForPlan / Full gate run.
 */
export function resolvePlanScopedDraftGate(input: {
  activeReleases?: ReadonlyMap<
    ReadToolId,
    HmsPortfolioToolReleaseV2
  > | null;
  lookupCandidates: ReadonlyMap<string, { id: string; kind: string }>;
  operationId: string;
  authorizedAttachmentIds?: ReadonlySet<string>;
  now?: Date;
}): PlanScopedDraftGate | null {
  const releases = input.activeReleases;
  if (!releases || releases.size === 0) return null;
  const requesterAuthorization = mintPlanScopedRequesterAuthorization({
    operationId: input.operationId,
    now: input.now,
  });
  return {
    requesterAuthorization,
    candidateBindings: buildPlanScopedCandidateBindings({
      lookupCandidates: input.lookupCandidates,
      activeReleases: releases,
      requesterAuthorizationId: requesterAuthorization.authorizationId,
      authorizedAttachmentIds: input.authorizedAttachmentIds,
    }),
  };
}

function claimId(parts: string): string {
  return createHash('sha256').update(parts).digest('hex').slice(0, 16);
}

export function buildWorkflowSummaryClaim(input: {
  plan: CandidateReadPlan;
  evidenceIds: readonly string[];
  childClaimIds?: readonly string[];
  toolIds?: readonly ReadToolId[];
}): EvidenceClaim {
  const evidenceIds = [...new Set(input.evidenceIds.filter(Boolean))];
  if (evidenceIds.length === 0) {
    throw new Error('workflow summary requires at least one evidence id');
  }
  const toolIds = input.toolIds ?? plannedToolIds(input.plan);
  const childClaimIds = [...(input.childClaimIds ?? [])];
  const value = {
    planKind: input.plan.kind,
    evidenceIds,
    childClaimIds,
    toolIds: [...toolIds],
  };
  return {
    id: claimId(`workflow_summary:${input.plan.kind}:${evidenceIds.join(',')}`),
    kind: 'workflow_summary',
    value,
    evidenceId: evidenceIds[0]!,
  };
}

export function portfolioAblationForPromotedReleases(input: {
  cases: PortfolioCaseV3[];
  outcomesByToolStep: Record<string, Record<number, AblationOutcome>>;
}): AblationReport {
  const releaseOrder = promotedPortfolioReleaseOrder();
  for (const toolId of Object.keys(input.outcomesByToolStep)) {
    if (toolId === 'baseline') continue;
    if (!releaseOrder.includes(toolId as ReadToolId)) {
      throw new Error(
        `ablation outcomes include non-promoted tool ${toolId}; portfolio gate uses promoted releases only`,
      );
    }
  }
  return portfolioAblationReplay({
    cases: input.cases,
    releaseOrder,
    outcomesByToolStep: input.outcomesByToolStep,
  });
}

export type LoadCapacitySample = {
  queuedRuns: 1 | 5 | 20;
  queueWaitMs: number;
  toolLatencyMs: number;
  endToEndLatencyMs: number;
  memoryBytes: number;
  captureBytes: number;
  contextClosed: boolean;
  deadlineAborts: number;
};

export type LoadCapacityReport = {
  toolIds: ReadToolId[];
  byConcurrency: Record<
    string,
    {
      samples: number;
      queueWaitMsAvg: number;
      toolLatencyMsAvg: number;
      endToEndLatencyMsAvg: number;
      memoryBytesMax: number;
      captureBytesMax: number;
      contextClosed: number;
      deadlineAborts: number;
    }
  >;
};

export function replayLoadCapacity(
  samples: readonly LoadCapacitySample[],
): LoadCapacityReport {
  const byConcurrency: LoadCapacityReport['byConcurrency'] = {};
  for (const sample of samples) {
    const key = String(sample.queuedRuns);
    const prev = byConcurrency[key];
    if (!prev) {
      byConcurrency[key] = {
        samples: 1,
        queueWaitMsAvg: sample.queueWaitMs,
        toolLatencyMsAvg: sample.toolLatencyMs,
        endToEndLatencyMsAvg: sample.endToEndLatencyMs,
        memoryBytesMax: sample.memoryBytes,
        captureBytesMax: sample.captureBytes,
        contextClosed: sample.contextClosed ? 1 : 0,
        deadlineAborts: sample.deadlineAborts,
      };
      continue;
    }
    const n = prev.samples + 1;
    byConcurrency[key] = {
      samples: n,
      queueWaitMsAvg:
        (prev.queueWaitMsAvg * prev.samples + sample.queueWaitMs) / n,
      toolLatencyMsAvg:
        (prev.toolLatencyMsAvg * prev.samples + sample.toolLatencyMs) / n,
      endToEndLatencyMsAvg:
        (prev.endToEndLatencyMsAvg * prev.samples + sample.endToEndLatencyMs) /
        n,
      memoryBytesMax: Math.max(prev.memoryBytesMax, sample.memoryBytes),
      captureBytesMax: Math.max(prev.captureBytesMax, sample.captureBytes),
      contextClosed: prev.contextClosed + (sample.contextClosed ? 1 : 0),
      deadlineAborts: prev.deadlineAborts + sample.deadlineAborts,
    };
  }
  return {
    toolIds: promotedPortfolioReleaseOrder(),
    byConcurrency,
  };
}
