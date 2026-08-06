/**
 * Registry-derived cumulative ablation replay for currently promoted releases only.
 * No HMS login, no database, no private mail bodies.
 */
import portfolioCases from '../../evals/hms/portfolio-cases.v3.json' with { type: 'json' };
import {
  portfolioAblationForPromotedReleases,
  promotedPortfolioReleaseOrder,
  replayLoadCapacity,
} from '../hms/candidate-read-plan.js';
import type { AblationOutcome, PortfolioCaseV3 } from '../hms/read-tools.js';

function main(): void {
  const releaseOrder = promotedPortfolioReleaseOrder();
  const cases = portfolioCases.cases as PortfolioCaseV3[];
  const baseline: Record<number, AblationOutcome> = Object.fromEntries(
    cases.map((c) => [
      c.threadId,
      c.labelStatus === 'adjudicated' && c.outcome === 'full'
        ? ('full' as const)
        : ('abstain' as const),
    ]),
  );
  const outcomesByToolStep: Record<string, Record<number, AblationOutcome>> = {
    baseline,
  };
  for (const toolId of releaseOrder) {
    outcomesByToolStep[toolId] = { ...baseline };
  }

  const ablation = portfolioAblationForPromotedReleases({
    cases,
    outcomesByToolStep,
  });
  const load = replayLoadCapacity([
    {
      queuedRuns: 1,
      queueWaitMs: 0,
      toolLatencyMs: 0,
      endToEndLatencyMs: 0,
      memoryBytes: 0,
      captureBytes: 0,
      contextClosed: true,
      deadlineAborts: 0,
    },
    {
      queuedRuns: 5,
      queueWaitMs: 0,
      toolLatencyMs: 0,
      endToEndLatencyMs: 0,
      memoryBytes: 0,
      captureBytes: 0,
      contextClosed: true,
      deadlineAborts: 0,
    },
    {
      queuedRuns: 20,
      queueWaitMs: 0,
      toolLatencyMs: 0,
      endToEndLatencyMs: 0,
      memoryBytes: 0,
      captureBytes: 0,
      contextClosed: true,
      deadlineAborts: 0,
    },
  ]);

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        promotedReleaseOrder: releaseOrder,
        ablation: {
          denominator: ablation.denominator,
          steps: ablation.steps.map((s) => ({
            toolId: s.toolId,
            eligible: s.eligible,
            attempted: s.attempted,
            exact: s.exact,
            partial: s.partial,
            manual: s.manual,
            numerator: s.numerator,
            denominator: s.denominator,
            deltaFull: s.deltaFull,
            confidenceInterval95: s.confidenceInterval95,
          })),
        },
        loadCapacity: {
          toolIds: load.toolIds,
          concurrencies: Object.keys(load.byConcurrency)
            .map(Number)
            .sort((a, b) => a - b),
        },
        portfolioPromotionBlocked: true,
        blockers: [
          'role-proof-v2',
          'discovery',
          'fixture_verified_tools_not_live',
        ],
      },
      null,
      2,
    )}\n`,
  );
}

main();
