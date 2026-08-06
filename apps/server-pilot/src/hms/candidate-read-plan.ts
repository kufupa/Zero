/**
 * Closed CandidateReadPlan + promoted-only portfolio ablation / load replay.
 * Model never chooses tools or loops — code owns the plan; model picks claim IDs.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EvidenceClaim } from '../ai/draft-evidence.js';
import {
  isProductionActiveReadTool,
  portfolioAblationReplay,
  productionActiveReadToolIds,
  type AblationOutcome,
  type AblationReport,
  type PortfolioCaseV3,
  type ReadToolId,
} from './read-tools.js';

export const MAX_RESERVATION_FOLLOWUPS = 2;

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
  'mail_read_artifact',
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

function selectFollowups(segment: string): ReservationFollowupKind[] {
  const selected: ReservationFollowupKind[] = [];
  for (const entry of FOLLOWUP_SIGNAL_PRIORITY) {
    if (selected.length >= MAX_RESERVATION_FOLLOWUPS) break;
    if (entry.pattern.test(segment)) selected.push(entry.kind);
  }
  return selected;
}

/**
 * Deterministic code-owned planner. One closed branch; max two unique followups.
 * Model cannot request arbitrary tools or loops.
 */
export function planCandidateReads(signals: PlanSignals): CandidateReadPlan {
  const segment = signals.authoredSegment.trim();
  if (signals.hasQuoteCandidate && /\b(availab|quote|rate|night|occupanc)/i.test(segment)) {
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
        'mail_read_artifact',
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
      queueWaitMsAvg: (prev.queueWaitMsAvg * prev.samples + sample.queueWaitMs) / n,
      toolLatencyMsAvg:
        (prev.toolLatencyMsAvg * prev.samples + sample.toolLatencyMs) / n,
      endToEndLatencyMsAvg:
        (prev.endToEndLatencyMsAvg * prev.samples + sample.endToEndLatencyMs) / n,
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
