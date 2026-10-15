import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('tsx/esm', pathToFileURL('./'));

const { scoreReplayOutput } = await import('./score-row.ts');

/** Promptfoo javascript assertion. One scorer: score-row.ts. Ops JSON only. */
export default function assertAgentSameMove(output, context) {
  return scoreReplayOutput(output, context?.vars);
}
