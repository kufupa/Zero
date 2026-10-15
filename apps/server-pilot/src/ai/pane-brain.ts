import { analyseSelectionWithAgent } from './agent-pane-adapter.js';
import type { ModelAdapter } from './bedrock/adapter.js';
import { createAzureLunaModel } from './bedrock/luna.js';
import {
  analyseQuoteSelection,
  type AnalyseQuoteSelectionResult,
  type QuoteTreatAs,
} from './quote-workflow-llm.js';
import type { SyncedQuoteSelection } from './quote-workflow-synced-selection.js';

export type PaneBrain = 'agent' | 'classifier';

export function paneBrain(env: NodeJS.Dict<string> = process.env): PaneBrain {
  return env.PANE_BRAIN === 'agent' ? 'agent' : 'classifier';
}

/**
 * One pane analysis producer. Agent path: Azure GPT-6 Luna, no HMS runners (tools off,
 * writes off, no send). Model errors fall through to regex → to-do card.
 */
export async function analyseWithPaneBrain(input: {
  selection: SyncedQuoteSelection;
  adapter: ModelAdapter | null;
  enabled: boolean;
  deadlineMs?: number;
  treatAs?: QuoteTreatAs;
  staffNote?: string;
  env?: NodeJS.Dict<string>;
}): Promise<AnalyseQuoteSelectionResult> {
  if (paneBrain(input.env) === 'agent') {
    try {
      return await analyseSelectionWithAgent({
        selection: input.selection,
        model: createAzureLunaModel(),
        deadlineMs: input.deadlineMs,
        treatAs: input.treatAs,
        staffNote: input.staffNote,
      });
    } catch {
      return { source: 'regex_fallback', fallbackReason: 'error' };
    }
  }
  return analyseQuoteSelection({
    selection: input.selection,
    adapter: input.adapter,
    enabled: input.enabled,
    deadlineMs: input.deadlineMs,
    treatAs: input.treatAs,
    staffNote: input.staffNote,
  });
}
