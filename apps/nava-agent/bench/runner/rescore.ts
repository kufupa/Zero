#!/usr/bin/env tsx
/** Offline re-score of an existing run (no Luna calls). Uses updated case gold + scorer. */
import {readdir, readFile, writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {CaseCard} from '../types.js';
import {buildScoreboard, scoreCase, type CaseScore} from './score.js';

const DATA_ROOT = process.env.NAVA_BENCH_DATA_ROOT ?? '/home/orca/.local/share/zero/bench/replay-bench-20261119';

export async function rescoreRun(options: {
  runDir: string;
  casesDir?: string;
  outDir?: string;
}) {
  const casesDir = options.casesDir ?? join(DATA_ROOT, 'cases/v1');
  const outDir = options.outDir ?? join(options.runDir, 'rescored');
  await mkdir(outDir, {recursive: true});
  const entries = (await readdir(options.runDir)).filter(name => name.endsWith('.json') && name !== 'scoreboard.json' && name !== 'tier-report.json');
  const scores: CaseScore[] = [];
  for (const name of entries) {
    const prior = JSON.parse(await readFile(join(options.runDir, name), 'utf8')) as CaseScore & {proposal?: unknown; tool_quality?: {calls?: Array<{name: string; ok: boolean}>}};
    const caseId = prior.case_id ?? name.replace(/\.json$/, '');
    let card: CaseCard;
    try {
      card = JSON.parse(await readFile(join(casesDir, caseId, 'case.json'), 'utf8')) as CaseCard;
    } catch {
      continue;
    }
    const toolCalls = (prior.tool_quality?.calls ?? []).map(call => ({
      name: call.name,
      input: undefined,
      result: {ok: call.ok},
    }));
    // Prefer full tool calls if present on prior score files
    const priorAny = prior as CaseScore & {toolCalls?: typeof toolCalls};
    const score = scoreCase({
      card,
      proposal: prior.proposal ?? null,
      toolCalls: priorAny.toolCalls ?? toolCalls,
      tokens: prior.tokens ?? {input: 0, output: 0, cached_input: 0},
      wall_ms: prior.wall_ms ?? 0,
    });
    // Preserve cost/tokens from original Luna run
    score.tokens = prior.tokens ?? score.tokens;
    score.cost_usd = prior.cost_usd ?? score.cost_usd;
    score.wall_ms = prior.wall_ms ?? score.wall_ms;
    score.twin_uncovered = prior.twin_uncovered ?? score.twin_uncovered;
    await writeFile(join(outDir, `${caseId}.json`), JSON.stringify(score));
    scores.push(score);
  }
  const board = buildScoreboard(scores);
  board.totals.wall_ms = Math.max(...scores.map(s => s.wall_ms), 0);
  board.totals.cost_usd = scores.reduce((sum, s) => sum + s.cost_usd, 0);
  await writeFile(join(outDir, 'scoreboard.json'), JSON.stringify(board, null, 2));
  return {outDir, board, n: scores.length};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runDir = process.argv[2] ?? join(DATA_ROOT, 'runs/run-2026-11-19T08-35-06-901Z');
  const {outDir, board, n} = await rescoreRun({runDir});
  process.stdout.write(JSON.stringify({
    outDir, n,
    totals: board.totals,
    by_workflow: Object.fromEntries(Object.entries(board.by_workflow).map(([wf, row]) => [wf, {
      n: row.n,
      field_accuracy: row.field_accuracy,
      hit: row.hit, miss: row.miss,
      tier1: {hit: row.tier1_core.hit, miss: row.tier1_core.miss, acc: row.tier1_core.field_accuracy},
      tier2: {hit: row.tier2_defaults.hit, miss: row.tier2_defaults.miss, acc: row.tier2_defaults.field_accuracy},
      history: {hit: row.history_knowable.hit, miss: row.history_knowable.miss, acc: row.history_knowable.field_accuracy},
      routing: {hit: row.workflow_routing.hit, miss: row.workflow_routing.miss, acc: row.workflow_routing.field_accuracy},
      by_path: {
        ...Object.fromEntries(Object.entries(row.tier1_core.by_path).map(([p, c]) => [p, {...c, tier: 'tier1_core'}])),
        ...Object.fromEntries(Object.entries(row.tier2_defaults.by_path).map(([p, c]) => [p, {...c, tier: 'tier2_defaults'}])),
        ...Object.fromEntries(Object.entries(row.history_knowable.by_path).map(([p, c]) => [p, {...c, tier: 'history_knowable'}])),
      },
    }])),
  }, null, 2) + '\n');
}
