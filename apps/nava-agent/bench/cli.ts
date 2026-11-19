#!/usr/bin/env tsx
import {parseArgs} from 'node:util';
import {resolveCasesDir} from './cases-sets.js';
import {runBench} from './runner/run.js';
import type {Scoreboard} from './runner/score.js';

const {values} = parseArgs({
  options: {
    cases: {type: 'string', default: 'all'},
    concurrency: {type: 'string', default: '20'},
    limit: {type: 'string'},
    out: {type: 'string'},
    'cases-dir': {type: 'string'},
  },
});

const resolved = resolveCasesDir(values.cases, values['cases-dir']);
const concurrency = Number(values.concurrency ?? 20);
const limit = values.limit ? Number(values.limit) : resolved.limit;
const {outDir, board, devBoard, holdBoard} = await runBench({
  concurrency,
  limit: Number.isFinite(limit) ? limit : undefined,
  outDir: values.out,
  casesDir: resolved.casesDir,
});

function summarize(board: Scoreboard) {
  const t1 = {hit: 0, miss: 0};
  const hist = {hit: 0, miss: 0};
  for (const row of Object.values(board.by_workflow)) {
    t1.hit += row.tier1_core.hit;
    t1.miss += row.tier1_core.miss;
    hist.hit += row.history_knowable.hit;
    hist.miss += row.history_knowable.miss;
  }
  const t1n = t1.hit + t1.miss;
  const hn = hist.hit + hist.miss;
  return {
    n: board.n,
    tier1: {hit: t1.hit, miss: t1.miss, acc: t1n ? t1.hit / t1n : null},
    history: {hit: hist.hit, miss: hist.miss, acc: hn ? hist.hit / hn : null},
    routing: {
      hit: board.totals.workflow_routing_hit,
      miss: board.totals.workflow_routing_miss,
      acc: board.totals.workflow_routing_accuracy,
    },
    cost_usd: Number(board.totals.cost_usd.toFixed(4)),
    wall_ms: board.totals.wall_ms,
  };
}

console.log(JSON.stringify({
  outDir,
  casesDir: resolved.casesDir,
  all: summarize(board),
  dev: summarize(devBoard),
  holdout: summarize(holdBoard),
  by_workflow: Object.fromEntries(Object.entries(board.by_workflow).map(([wf, row]) => [wf, {
    n: row.n,
    tier1_acc: row.tier1_core.field_accuracy,
    routing_acc: row.workflow_routing.field_accuracy,
    hit: row.hit,
    miss: row.miss,
  }])),
}, null, 2));
