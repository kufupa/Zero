/**
 * Ops-JSON same-move compare. Lives in src so typecheck rootDir stays `src`.
 * Copied from scripts/compare-centurion-human-gold.ts compareSemantics.
 * Src must not import scripts/.
 */

const GRADES = [
  'match',
  'partial',
  'mismatch',
  'prediction_error',
  'unavailable',
  'not_scored',
] as const;

export type GoldGrade = (typeof GRADES)[number];

export type GoldOperation = {
  operation: string;
  needLevel: string;
  requiredFields: string[];
  candidateTool: string | null;
  unknownReason: string | null;
};

function operationMap(operations: readonly GoldOperation[]): Map<string, GoldOperation> {
  return new Map(operations.map((operation) => [operation.operation, operation]));
}

export function compareSemantics(
  predicted: readonly GoldOperation[],
  claimed: readonly GoldOperation[],
  predictionError: string | null,
): { grade: GoldGrade; mismatchReasons: string[] } {
  if (predictionError) return { grade: 'prediction_error', mismatchReasons: ['prediction_error'] };
  if (predicted.length === 0 || claimed.length === 0)
    return { grade: 'not_scored', mismatchReasons: [] };
  const predictedMap = operationMap(predicted);
  const claimedMap = operationMap(claimed);
  const reasons: string[] = [];
  for (const operation of predictedMap.keys()) {
    if (!claimedMap.has(operation)) reasons.push('missing_operation');
  }
  for (const operation of claimedMap.keys()) {
    if (!predictedMap.has(operation)) reasons.push('unexpected_operation');
  }
  for (const operation of predictedMap.keys()) {
    const expected = predictedMap.get(operation);
    const actual = claimedMap.get(operation);
    if (!expected || !actual) continue;
    for (const field of expected.requiredFields) {
      if (!actual.requiredFields.includes(field)) reasons.push('missing_required_field');
    }
    for (const field of actual.requiredFields) {
      if (!expected.requiredFields.includes(field)) reasons.push('unexpected_required_field');
    }
  }
  const uniqueReasons = [...new Set(reasons)].sort();
  if (uniqueReasons.length === 0) return { grade: 'match', mismatchReasons: [] };
  const overlap = [...predictedMap.keys()].some((operation) => claimedMap.has(operation));
  return { grade: overlap ? 'partial' : 'mismatch', mismatchReasons: uniqueReasons };
}
