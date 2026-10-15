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

export type SameMoveOpsMatchRow = {
  predicted: readonly GoldOperation[];
  claimed: readonly GoldOperation[];
};

export type SameMoveWorkflowBaseline = {
  workflow: string;
  model: number;
  baseline: number;
  n: number;
};

export type SameMoveMajorityBaseline = {
  set: string;
  match: number;
  n: number;
  modelMatch: number;
  byWorkflow: SameMoveWorkflowBaseline[];
};

export function opsMatch(
  predicted: readonly Pick<GoldOperation, 'operation' | 'requiredFields'>[],
  claimed: readonly Pick<GoldOperation, 'operation' | 'requiredFields'>[],
): boolean {
  if (predicted.length === 0 || claimed.length === 0) return false;
  const predictedOps = new Set(predicted.map((row) => row.operation));
  const claimedOps = new Set(claimed.map((row) => row.operation));
  if (predictedOps.size !== claimedOps.size) return false;
  for (const operation of predictedOps) {
    if (!claimedOps.has(operation)) return false;
  }
  const predictedByOp = new Map(predicted.map((row) => [row.operation, row]));
  for (const claimedOp of claimed) {
    const predictedOp = predictedByOp.get(claimedOp.operation);
    if (!predictedOp) return false;
    for (const field of claimedOp.requiredFields) {
      if (!predictedOp.requiredFields.includes(field)) return false;
    }
  }
  return true;
}

function operationSetKey(ops: readonly GoldOperation[]): string {
  if (ops.length === 0) return 'none';
  return [...new Set(ops.map((row) => row.operation))].sort().join('+');
}

function constantOpsForSet(set: string): GoldOperation[] {
  const names = set === 'none' || set === '' ? ['none'] : set.split('+');
  return names.map((operation) => ({
    operation,
    needLevel: operation === 'none' || operation === 'unknown' ? 'not_needed' : 'required',
    requiredFields: [],
    candidateTool: null,
    unknownReason: null,
  }));
}

export function majorityBaseline(
  rows: readonly SameMoveOpsMatchRow[],
): SameMoveMajorityBaseline {
  const n = rows.length;
  const setCounts = new Map<string, number>();
  for (const row of rows) {
    const key = operationSetKey(row.claimed);
    setCounts.set(key, (setCounts.get(key) ?? 0) + 1);
  }
  const ranked = [...setCounts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  const set = ranked[0]?.[0] ?? 'none';
  const constant = constantOpsForSet(set);
  let match = 0;
  let modelMatch = 0;
  const workflow = new Map<string, { model: number; baseline: number; n: number }>();
  for (const row of rows) {
    const primary = row.claimed[0]?.operation ?? 'none';
    const bucket = workflow.get(primary) ?? { model: 0, baseline: 0, n: 0 };
    bucket.n += 1;
    if (opsMatch(row.predicted, row.claimed)) {
      modelMatch += 1;
      bucket.model += 1;
    }
    if (opsMatch(constant, row.claimed)) {
      match += 1;
      bucket.baseline += 1;
    }
    workflow.set(primary, bucket);
  }
  const byWorkflow = [...workflow.entries()]
    .map(([workflowName, counts]) => ({ workflow: workflowName, ...counts }))
    .sort((left, right) => right.n - left.n || left.workflow.localeCompare(right.workflow));
  return { set, match, n, modelMatch, byWorkflow };
}

function pct(k: number, total: number): string {
  return total === 0 ? '0.0' : ((100 * k) / total).toFixed(1);
}

export function formatSameMoveOpsBaseline(baseline: SameMoveMajorityBaseline): string {
  const modelPct = pct(baseline.modelMatch, baseline.n);
  const basePct = pct(baseline.match, baseline.n);
  const headline =
    `model match=${baseline.modelMatch}/${baseline.n} (${modelPct}%)` +
    `  baseline majority=${baseline.set} match=${baseline.match}/${baseline.n} (${basePct}%)`;
  const lines = [
    headline,
    'workflow\tmodel\tbaseline\tn',
    ...baseline.byWorkflow.map(
      (row) => `${row.workflow}\t${row.model}/${row.n}\t${row.baseline}/${row.n}\t${row.n}`,
    ),
  ];
  return lines.join('\n');
}

export function compareSemantics(
  predicted: readonly GoldOperation[],
  claimed: readonly GoldOperation[],
  predictionError: string | null,
): { grade: GoldGrade; mismatchReasons: string[] } {
  if (predictionError) return { grade: 'prediction_error', mismatchReasons: ['prediction_error'] };
  if (predicted.length === 0 || claimed.length === 0)
    return { grade: 'not_scored', mismatchReasons: [] };
  if (opsMatch(predicted, claimed)) return { grade: 'match', mismatchReasons: [] };
  const predictedMap = operationMap(predicted);
  const claimedMap = operationMap(claimed);
  const reasons: string[] = [];
  for (const operation of predictedMap.keys()) {
    if (!claimedMap.has(operation)) reasons.push('missing_operation');
  }
  for (const operation of claimedMap.keys()) {
    if (!predictedMap.has(operation)) reasons.push('unexpected_operation');
  }
  for (const claimedOp of claimed) {
    const predictedOp = predictedMap.get(claimedOp.operation);
    if (!predictedOp) continue;
    for (const field of claimedOp.requiredFields) {
      if (!predictedOp.requiredFields.includes(field)) reasons.push('unexpected_required_field');
    }
  }
  const uniqueReasons = [...new Set(reasons)].sort();
  const overlap = [...predictedMap.keys()].some((operation) => claimedMap.has(operation));
  return { grade: overlap ? 'partial' : 'mismatch', mismatchReasons: uniqueReasons };
}
