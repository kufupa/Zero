/** Named bench case-set → directory under NAVA_BENCH_DATA_ROOT/cases/. */
import {join} from 'node:path';

const DATA_ROOT = process.env.NAVA_BENCH_DATA_ROOT ?? '/home/orca/.local/share/zero/bench/replay-bench-20261119';

export const CASE_SETS: Record<string, string> = {
  'holdout-fresh': 'holdout-fresh',
  'holdout-v2': 'holdout-v2',
  'holdout-v3': 'holdout-v3',
  'dev-fresh': 'dev-fresh',
  'dev-v2': 'dev-v2',
  v1: 'v1',
  samples: 'samples',
  smoke1: 'smoke1',
};

export function resolveCasesDir(cases: string | undefined, casesDirFlag: string | undefined): {
  casesDir: string;
  limit?: number;
} {
  if (casesDirFlag) {
    return {casesDir: casesDirFlag};
  }
  const key = (cases ?? 'all').trim();
  if (key === 'all' || key === '') {
    return {casesDir: join(DATA_ROOT, 'cases/v1')};
  }
  if (key in CASE_SETS) {
    return {casesDir: join(DATA_ROOT, 'cases', CASE_SETS[key]!)};
  }
  const asNum = Number(key);
  if (Number.isFinite(asNum) && asNum > 0) {
    return {casesDir: join(DATA_ROOT, 'cases/v1'), limit: asNum};
  }
  // Treat unknown string as relative cases/<name> under data root.
  return {casesDir: join(DATA_ROOT, 'cases', key)};
}
