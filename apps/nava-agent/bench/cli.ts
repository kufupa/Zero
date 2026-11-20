#!/usr/bin/env tsx
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {resolveCasesDir} from './cases-sets.js';
import {runBench} from './runner/run.js';
import {inferCasesDir, rescoreRun, type GoldVersion} from './runner/rescore.js';
import type {Scoreboard} from './runner/score.js';

const {values, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    cases: {type: 'string', default: 'all'},
    concurrency: {type: 'string', default: '20'},
    limit: {type: 'string'},
    out: {type: 'string'},
    'cases-dir': {type: 'string'},
    'case-ids': {type: 'string'},
    gold: {type: 'string', default: 'v4'},
    rescore: {type: 'boolean', default: false},
  },
});

async function loadCaseIds(path: string | undefined): Promise<string[] | undefined> {
  if (!path) return undefined;
  const text = await readFile(path, 'utf8');
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function summarize(board: Scoreboard) {
  const t1 = {hit: 0, miss: 0};
  const hist = {hit: 0, miss: 0};
  const parity = {hit: 0, miss: 0};
  let spray = 0;
  let spurious = 0;
  for (const row of Object.values(board.by_workflow)) {
    t1.hit += row.tier1_core.hit;
    t1.miss += row.tier1_core.miss;
    hist.hit += row.history_knowable.hit;
    hist.miss += row.history_knowable.miss;
    parity.hit += row.parity.hit;
    parity.miss += row.parity.miss;
    spray += row.spray;
    spurious += row.spurious;
  }
  const t1n = t1.hit + t1.miss;
  const hn = hist.hit + hist.miss;
  const pn = parity.hit + parity.miss;
  return {
    n: board.n,
    ruler: board.ruler,
    tier1: {hit: t1.hit, miss: t1.miss, acc: t1n ? t1.hit / t1n : null},
    history: {hit: hist.hit, miss: hist.miss, acc: hn ? hist.hit / hn : null},
    parity: {hit: parity.hit, miss: parity.miss, acc: pn ? parity.hit / pn : null},
    routing: {
      hit: board.totals.workflow_routing_hit,
      miss: board.totals.workflow_routing_miss,
      acc: board.totals.workflow_routing_accuracy,
    },
    spray,
    spurious,
    by_priority: board.by_priority,
    by_source: board.by_source,
    errors: board.totals.errors ?? 0,
    cost_usd: Number(board.totals.cost_usd.toFixed(4)),
    wall_ms: board.totals.wall_ms,
  };
}

const caseIds = await loadCaseIds(values['case-ids']);

if (values.rescore || positionals[0] === 'rescore') {
  const runDir = positionals[0] === 'rescore' ? positionals[1] : positionals[0];
  if (!runDir) throw new Error('Usage: bench/cli.ts [--rescore] rescore <runDir> [--gold v4|v5] [--out dir] [--case-ids file]');
  const goldRaw = (values.gold ?? 'v4').toLowerCase();
  if (goldRaw !== 'v4' && goldRaw !== 'v5') throw new Error(`--gold must be v4|v5, got ${values.gold}`);
  const casesDir = values['cases-dir'] ?? inferCasesDir(runDir);
  const {outDir, board, n} = await rescoreRun({
    runDir,
    casesDir,
    outDir: values.out,
    gold: goldRaw as GoldVersion,
    caseIds,
  });
  console.log(JSON.stringify({
    mode: 'rescore',
    outDir,
    casesDir,
    n,
    gold: goldRaw,
    all: summarize(board),
    by_workflow: Object.fromEntries(Object.entries(board.by_workflow).map(([wf, row]) => [wf, {
      n: row.n,
      tier1_acc: row.tier1_core.field_accuracy,
      routing_acc: row.workflow_routing.field_accuracy,
      spray: row.spray,
      spurious: row.spurious,
      hit: row.hit,
      miss: row.miss,
    }])),
  }, null, 2));
} else {
  const resolved = resolveCasesDir(values.cases, values['cases-dir']);
  const concurrency = Number(values.concurrency ?? 20);
  const limit = values.limit ? Number(values.limit) : resolved.limit;
  const {outDir, board, devBoard, holdBoard} = await runBench({
    concurrency,
    limit: Number.isFinite(limit) ? limit : undefined,
    outDir: values.out,
    casesDir: resolved.casesDir,
    caseIds,
  });

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
      spray: row.spray,
      spurious: row.spurious,
      hit: row.hit,
      miss: row.miss,
    }])),
  }, null, 2));
}
