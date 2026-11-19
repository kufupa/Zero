#!/usr/bin/env tsx
import {parseArgs} from 'node:util';
import {runBench} from './runner/run.js';

const {values} = parseArgs({
  options: {
    cases: {type: 'string', default: 'all'},
    concurrency: {type: 'string', default: '20'},
    limit: {type: 'string'},
    out: {type: 'string'},
    'cases-dir': {type: 'string'},
  },
});

const concurrency = Number(values.concurrency ?? 20);
const limit = values.limit ? Number(values.limit) : values.cases === 'all' ? undefined : Number(values.cases);
const {outDir, board} = await runBench({
  concurrency,
  limit: Number.isFinite(limit) ? limit : undefined,
  outDir: values.out,
  casesDir: values['cases-dir'],
});

function tierTable(row: (typeof board.by_workflow)[string]) {
  const paths: Record<string, {hit: number; miss: number; tier: string}> = {};
  for (const [tierName, tier] of [['tier1_core', row.tier1_core], ['tier2_defaults', row.tier2_defaults]] as const) {
    for (const [path, counts] of Object.entries(tier.by_path)) {
      paths[path] = {hit: counts.hit, miss: counts.miss, tier: tierName};
    }
  }
  return {
    n: row.n,
    field_accuracy: row.field_accuracy,
    hit: row.hit,
    miss: row.miss,
    tier1_core: {hit: row.tier1_core.hit, miss: row.tier1_core.miss, field_accuracy: row.tier1_core.field_accuracy},
    tier2_defaults: {hit: row.tier2_defaults.hit, miss: row.tier2_defaults.miss, field_accuracy: row.tier2_defaults.field_accuracy},
    by_path: paths,
    p50_ms: row.p50_ms,
    p95_ms: row.p95_ms,
    cost_usd: Number(row.cost_usd.toFixed(4)),
  };
}

console.log(JSON.stringify({
  outDir,
  n: board.n,
  totals: board.totals,
  by_workflow: Object.fromEntries(Object.entries(board.by_workflow).map(([wf, row]) => [wf, tierTable(row)])),
}, null, 2));
