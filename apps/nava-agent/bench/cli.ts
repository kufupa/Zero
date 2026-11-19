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

console.log(JSON.stringify({
  outDir,
  n: board.n,
  totals: board.totals,
  by_workflow: Object.fromEntries(Object.entries(board.by_workflow).map(([wf, row]) => [wf, {
    n: row.n,
    field_accuracy: row.field_accuracy,
    hit: row.hit,
    miss: row.miss,
    p50_ms: row.p50_ms,
    p95_ms: row.p95_ms,
    cost_usd: Number(row.cost_usd.toFixed(4)),
  }])),
}, null, 2));
