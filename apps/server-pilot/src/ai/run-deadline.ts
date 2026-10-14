import { lunaCallBudget, type LunaReasoningEffort } from './bedrock/luna.js';

export function resolveAiRunDeadlineMs(input: {
  runKind: string;
  configuredDeadlineMs: number;
  extractionEffort: LunaReasoningEffort;
}): number {
  if (input.runKind === 'inbound_extraction') {
    return Math.max(
      input.configuredDeadlineMs,
      lunaCallBudget(input.extractionEffort).minimumWorkerDeadlineMs,
    );
  }
  if (input.runKind === 'inbound_triage') {
    return Math.max(input.configuredDeadlineMs, lunaCallBudget('max').minimumWorkerDeadlineMs);
  }
  return input.configuredDeadlineMs;
}
