import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('tsx/esm', pathToFileURL('./'));

const { scoreSameMove } = await import('../../src/ai/same-move-scorer.ts');

function opsFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.predicted) && !Array.isArray(value.claimed)) {
    return value.predicted;
  }
  if (value && typeof value === 'object' && Array.isArray(value.claimed) && !Array.isArray(value.predicted)) {
    return value.claimed;
  }
  if (value && typeof value === 'object' && Array.isArray(value.predicted)) {
    return value.predicted;
  }
  return [];
}

function claimedFrom(value, fallback) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.claimed)) return value.claimed;
  return fallback;
}

export default function assertSameMove(output, context) {
  const predicted = opsFrom(output);
  const claimed = claimedFrom(context?.vars?.claimed, opsFrom(context?.vars?.claimed));
  const scored = scoreSameMove({ predicted, claimed });
  const expectPass = context?.vars?.expectPass === true || context?.vars?.expectPass === 'true';
  const harnessPass = expectPass ? scored.pass : !scored.pass;
  return {
    pass: harnessPass,
    score: harnessPass ? 1 : 0,
    reason: scored.grade,
  };
}
