import type { AnalyseQuoteSelectionResult, QuoteTreatAs } from './quote-workflow-llm.js';
import type { LunaAnalysis, ReservationistDecision } from './reservationist-decision.js';
import type { ReservationistRunners } from './reservationist-agent.js';
import type { SyncedQuoteSelection } from './quote-workflow-synced-selection.js';

/** Slice A owns the real mapper. This stub keeps slice B compilable until that PR lands. */
export function agentDecisionToLunaAnalysis(
  _decision: ReservationistDecision,
  _selection: SyncedQuoteSelection,
): LunaAnalysis {
  return {
    workflow: 'other',
    flags: [],
    groups: [],
    party: { kind: null, name: null, reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [],
  };
}

/** Slice A runs the Mastra agent. Stub fail-softs so PANE_BRAIN=agent never writes or sends. */
export async function analyseSelectionWithAgent(_input: {
  selection: SyncedQuoteSelection;
  model?: unknown;
  runners?: ReservationistRunners;
  deadlineMs?: number;
  treatAs?: QuoteTreatAs;
  staffNote?: string;
}): Promise<AnalyseQuoteSelectionResult> {
  return { source: 'regex_fallback', fallbackReason: 'error' };
}
