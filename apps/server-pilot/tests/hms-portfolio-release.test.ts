import { describe, expect, it } from 'vitest';
import portfolioCases from '../evals/hms/portfolio-cases.v3.json';
import {
  MAX_RESERVATION_FOLLOWUPS,
  buildWorkflowSummaryClaim,
  candidateReadPlanSchema,
  executableToolIdsForPlan,
  followupToToolId,
  planCandidateReads,
  portfolioAblationForPromotedReleases,
  promotedPortfolioReleaseOrder,
  replayLoadCapacity,
  type CandidateReadPlan,
} from '../src/hms/candidate-read-plan';
import {
  isProductionActiveReadTool,
  productionActiveReadToolIds,
  type AblationOutcome,
} from '../src/hms/read-tools';

describe('CandidateReadPlan closed union', () => {
  it('accepts reservation with at most two unique followups', () => {
    const plan = candidateReadPlanSchema.parse({
      kind: 'reservation',
      find: true,
      followups: ['documents', 'folio'],
    });
    expect(plan.followups).toHaveLength(2);
    expect(MAX_RESERVATION_FOLLOWUPS).toBe(2);
  });

  it('rejects more than two reservation followups', () => {
    expect(() =>
      candidateReadPlanSchema.parse({
        kind: 'reservation',
        find: true,
        followups: ['documents', 'sent_email', 'folio'],
      }),
    ).toThrow();
  });

  it('rejects duplicate followups', () => {
    expect(() =>
      candidateReadPlanSchema.parse({
        kind: 'reservation',
        find: true,
        followups: ['folio', 'folio'],
      }),
    ).toThrow();
  });

  it('plans at most two deterministic followups from signals', () => {
    const plan = planCandidateReads({
      authoredSegment:
        'Please send the tax invoice and confirm the folio balance and company billing terms.',
      attachmentCount: 0,
      hasExactReservationCandidate: true,
      hasQuoteCandidate: false,
      hasGroupRef: false,
      hasEventRef: false,
    });
    expect(plan.kind).toBe('reservation');
    if (plan.kind !== 'reservation') throw new Error('expected reservation');
    expect(plan.followups.length).toBeLessThanOrEqual(MAX_RESERVATION_FOLLOWUPS);
    expect(plan.followups.length).toBe(2);
    expect(new Set(plan.followups).size).toBe(plan.followups.length);
  });

  it('never invents model-driven tool loops — plan is code-owned closed union', () => {
    const plan = planCandidateReads({
      authoredSegment: 'What is available for these dates?',
      attachmentCount: 0,
      hasExactReservationCandidate: false,
      hasQuoteCandidate: true,
      hasGroupRef: false,
      hasEventRef: false,
    });
    expect(plan).toEqual({ kind: 'quote', quote: true });
    expect(candidateReadPlanSchema.safeParse({ kind: 'custom', tools: ['x'] }).success).toBe(
      false,
    );
  });
});

describe('production executable steps stay decoupled from blocked surfaces', () => {
  it('excludes fixture-only blocked tools from active production read allowlist', () => {
    const active = productionActiveReadToolIds();
    expect(active).toEqual(['hms_find_reservation']);
    for (const blocked of [
      'hms_quote_stay',
      'hms_list_documents',
      'hms_sent_email_audit',
      'hms_read_folio',
      'hms_company_account_read',
      'hms_group_block_read',
      'hms_event_read',
      'mail_read_artifact',
    ] as const) {
      expect(isProductionActiveReadTool(blocked)).toBe(false);
    }
  });

  it('filters planned followups out of production executable steps', () => {
    const plan: CandidateReadPlan = {
      kind: 'reservation',
      find: true,
      followups: ['documents', 'company'],
    };
    expect(executableToolIdsForPlan(plan, 'fixture')).toEqual([
      'hms_find_reservation',
      followupToToolId('documents'),
      followupToToolId('company'),
    ]);
    expect(executableToolIdsForPlan(plan, 'production')).toEqual([
      'hms_find_reservation',
    ]);
  });

  it('yields empty production executable for fixture-only plan kinds', () => {
    expect(
      executableToolIdsForPlan({ kind: 'quote', quote: true }, 'production'),
    ).toEqual([]);
    expect(
      executableToolIdsForPlan({ kind: 'group', group: true }, 'production'),
    ).toEqual([]);
    expect(
      executableToolIdsForPlan({ kind: 'event', event: true }, 'production'),
    ).toEqual([]);
  });
});

describe('workflow summary claim', () => {
  it('emits one typed claim with evidence IDs for whole-claim selection', () => {
    const claim = buildWorkflowSummaryClaim({
      plan: { kind: 'reservation', find: true, followups: [] },
      evidenceIds: ['ev-find-1', 'ev-find-1'],
      childClaimIds: ['claim-a'],
    });
    expect(claim.kind).toBe('workflow_summary');
    expect(claim.value).toEqual({
      planKind: 'reservation',
      evidenceIds: ['ev-find-1'],
      childClaimIds: ['claim-a'],
      toolIds: ['hms_find_reservation'],
    });
    expect(claim.evidenceId).toBe('ev-find-1');
    expect(claim.id).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('cumulative ablation across promoted releases only', () => {
  it('release order is currently promoted tools only', () => {
    expect(promotedPortfolioReleaseOrder()).toEqual(['hms_find_reservation']);
    expect(promotedPortfolioReleaseOrder()).not.toContain('hms_quote_stay');
    expect(promotedPortfolioReleaseOrder()).not.toContain('hms_company_account_read');
    expect(promotedPortfolioReleaseOrder()).not.toContain('hms_group_block_read');
    expect(promotedPortfolioReleaseOrder()).not.toContain('hms_event_read');
    expect(promotedPortfolioReleaseOrder()).not.toContain('hms_read_folio');
  });

  it('ablation membership does not overlap and never requires blocked live promotion', () => {
    const baseline = Object.fromEntries(
      portfolioCases.cases.map((c) => [
        c.threadId,
        c.labelStatus === 'adjudicated' && c.outcome === 'full'
          ? ('full' as AblationOutcome)
          : ('abstain' as AblationOutcome),
      ]),
    );
    const findStep = { ...baseline };
    const report = portfolioAblationForPromotedReleases({
      cases: portfolioCases.cases,
      outcomesByToolStep: {
        baseline,
        hms_find_reservation: findStep,
      },
    });
    expect(report.steps.map((s) => s.toolId)).toEqual([
      'baseline',
      'hms_find_reservation',
    ]);
    expect(report.denominator).toBe(56);
    // Gate must not demand company/group/event/folio/quote steps.
    for (const blocked of [
      'hms_quote_stay',
      'hms_read_folio',
      'hms_company_account_read',
      'hms_group_block_read',
      'hms_event_read',
    ]) {
      expect(report.steps.some((s) => s.toolId === blocked)).toBe(false);
    }
  });
});

describe('load/capacity replay (promoted tools only)', () => {
  it('aggregates 1/5/20 queue samples without blocked tool membership', () => {
    const report = replayLoadCapacity([
      {
        queuedRuns: 1,
        queueWaitMs: 10,
        toolLatencyMs: 100,
        endToEndLatencyMs: 200,
        memoryBytes: 1_000,
        captureBytes: 100,
        contextClosed: true,
        deadlineAborts: 0,
      },
      {
        queuedRuns: 5,
        queueWaitMs: 50,
        toolLatencyMs: 120,
        endToEndLatencyMs: 400,
        memoryBytes: 2_000,
        captureBytes: 200,
        contextClosed: true,
        deadlineAborts: 0,
      },
      {
        queuedRuns: 20,
        queueWaitMs: 200,
        toolLatencyMs: 150,
        endToEndLatencyMs: 900,
        memoryBytes: 4_000,
        captureBytes: 400,
        contextClosed: true,
        deadlineAborts: 1,
      },
    ]);
    expect(report.toolIds).toEqual(['hms_find_reservation']);
    expect(Object.keys(report.byConcurrency).sort()).toEqual(['1', '20', '5']);
    expect(report.byConcurrency['20']?.deadlineAborts).toBe(1);
    expect(report.byConcurrency['1']?.samples).toBe(1);
  });
});
