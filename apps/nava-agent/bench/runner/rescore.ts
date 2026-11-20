#!/usr/bin/env tsx
/** Offline re-score of an existing run (no Luna calls). Uses updated case gold + scorer. */
import {readdir, readFile, writeFile, mkdir} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import type {CaseCard} from '../types.js';
import {attachRuler, buildScoreboard, scoreCase, type CaseScore} from './score.js';
import {
  applyGoldV4,
  goldSetFromCasesDir,
  goldV4Path,
  loadGoldV4,
  type GoldSetName,
  type GoldV4Map,
} from './gold-overlay.js';

const DATA_ROOT = process.env.NAVA_BENCH_DATA_ROOT ?? '/home/orca/.local/share/zero/bench/replay-bench-20261119';

export type GoldVersion = 'v4' | 'v5';

function goldPath(setName: GoldSetName, version: GoldVersion): string {
  return join(DATA_ROOT, 'gold-audit', setName, version === 'v5' ? 'gold-v5.json' : 'gold-v4.json');
}

async function loadGoldOverlay(casesDir: string, version: GoldVersion): Promise<{map: GoldV4Map | null; file: string | null}> {
  const setName = goldSetFromCasesDir(casesDir);
  if (!setName) return {map: null, file: null};
  if (process.env.NAVA_BENCH_GOLD_OVERLAY === 'off' || process.env.NAVA_BENCH_GOLD_OVERLAY === '0') {
    return {map: null, file: null};
  }
  const file = goldPath(setName, version);
  try {
    const raw = await readFile(file, 'utf8');
    return {map: JSON.parse(raw) as GoldV4Map, file};
  } catch {
    if (version === 'v4') {
      // Fall back to helper path (same file) when load fails for other reasons.
      try {
        const map = await loadGoldV4(casesDir);
        return {map, file: goldV4Path(setName)};
      } catch {
        return {map: null, file: null};
      }
    }
    return {map: null, file};
  }
}

/** Infer cases dir from run folder name (holdout-v2-*, holdout-v3-*, dev-v2-*, …). */
export function inferCasesDir(runDir: string): string {
  const name = basename(runDir.replace(/\/$/, ''));
  if (name.startsWith('holdout-v3')) return join(DATA_ROOT, 'cases/holdout-v3');
  if (name.startsWith('holdout-v2')) return join(DATA_ROOT, 'cases/holdout-v2');
  if (name.startsWith('dev-v2')) return join(DATA_ROOT, 'cases/dev-v2');
  if (name.startsWith('holdout-fresh')) return join(DATA_ROOT, 'cases/holdout-fresh');
  if (name.startsWith('dev-fresh')) return join(DATA_ROOT, 'cases/dev-fresh');
  return join(DATA_ROOT, 'cases/v1');
}

export async function rescoreRun(options: {
  runDir: string;
  casesDir?: string;
  outDir?: string;
  /** Freeze the case set for fair before/after compares (growing runs otherwise drift). */
  caseIds?: string[];
  /** gold-v4 (default) or gold-v5 overlay under gold-audit/<set>/. */
  gold?: GoldVersion;
}) {
  const casesDir = options.casesDir ?? inferCasesDir(options.runDir);
  const goldVersion: GoldVersion = options.gold ?? 'v4';
  const outDir = options.outDir ?? join(options.runDir, 'rescored-L1');
  await mkdir(outDir, {recursive: true});
  const {map: goldMap, file: goldFile} = await loadGoldOverlay(casesDir, goldVersion);
  const skip = new Set([
    'scoreboard.json', 'scoreboard-dev.json', 'scoreboard-holdout.json',
    'split.json', 'tier-report.json', 'manifest.json',
  ]);
  // Snapshot once — a live run dir can grow while we rescore.
  const frozenEntries = (await readdir(options.runDir))
    .filter(name => name.endsWith('.json') && !skip.has(name))
    .sort();
  const allow = options.caseIds ? new Set(options.caseIds) : null;
  const scores: CaseScore[] = [];
  const scoredIds: string[] = [];
  for (const name of frozenEntries) {
    const prior = JSON.parse(await readFile(join(options.runDir, name), 'utf8')) as CaseScore & {
      proposal?: unknown;
      proposal_raw?: unknown;
      tool_quality?: {calls?: Array<{name: string; ok: boolean}>};
    };
    // Skip non-case artifacts accidentally dropped in the run dir.
    if (!prior.case_id && !('proposal' in prior) && !('fields' in prior)) continue;
    const caseId = prior.case_id ?? name.replace(/\.json$/, '');
    if (allow && !allow.has(caseId)) continue;
    let card: CaseCard;
    try {
      card = JSON.parse(await readFile(join(casesDir, caseId, 'case.json'), 'utf8')) as CaseCard;
    } catch {
      continue;
    }
    if (goldMap) card = applyGoldV4(card, goldMap[caseId]);
    const toolCalls = (prior.tool_quality?.calls ?? []).map(call => ({
      name: call.name,
      input: (() => { try { return JSON.parse((call as {input?: string}).input ?? ''); } catch { return undefined; } })(),
      result: {ok: call.ok},
    }));
    // Prefer full tool calls if present on prior score files
    const priorAny = prior as CaseScore & {toolCalls?: typeof toolCalls};
    // Prefer raw proposal from prior runs; fall back to stored proposal (pre-L1 runs only saved raw).
    const rawProposal = prior.proposal_raw ?? prior.proposal ?? null;
    const score = scoreCase({
      card,
      proposal: rawProposal,
      toolCalls: priorAny.toolCalls ?? toolCalls,
      tokens: prior.tokens ?? {input: 0, output: 0, cached_input: 0},
      wall_ms: prior.wall_ms ?? 0,
    });
    // Preserve cost/tokens from original Luna run
    score.tokens = prior.tokens ?? score.tokens;
    score.cost_usd = prior.cost_usd ?? score.cost_usd;
    score.wall_ms = prior.wall_ms ?? score.wall_ms;
    score.twin_uncovered = prior.twin_uncovered ?? score.twin_uncovered;
    if (prior.tool_quality?.calls?.length) score.tool_quality.calls = prior.tool_quality.calls; // keep L8 input/hits/top
    await writeFile(join(outDir, `${caseId}.json`), JSON.stringify(score));
    scores.push(score);
    scoredIds.push(caseId);
  }
  const board = buildScoreboard(scores);
  board.totals.wall_ms = Math.max(...scores.map(s => s.wall_ms), 0);
  board.totals.cost_usd = scores.reduce((sum, s) => sum + s.cost_usd, 0);
  await attachRuler(board, {goldFile});
  // All cases in the run are the measured set (v1 = full 200-dev).
  const labels: Record<string, 'dev' | 'holdout'> = Object.fromEntries(
    scores.map(s => [s.case_id, 'dev' as const]),
  );
  const caseIds = [...scoredIds].sort();
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify({
    runDir: options.runDir,
    casesDir,
    n: caseIds.length,
    case_ids: caseIds,
    frozen_entry_count: frozenEntries.length,
    gold: goldVersion,
    gold_file: goldFile,
    gold_overlay: goldMap ? `gold-${goldVersion}` : 'off',
    gold_sha256: board.ruler?.gold_sha256 ?? null,
    scorer_sha: board.ruler?.scorer_sha ?? null,
    note: 'L1 honest scorer offline rescore. Case set frozen at rescore start.',
  }, null, 2));
  await writeFile(join(outDir, 'scoreboard.json'), JSON.stringify(board, null, 2));
  await writeFile(join(outDir, 'scoreboard-dev.json'), JSON.stringify(board, null, 2));
  await writeFile(join(outDir, 'split.json'), JSON.stringify({
    seed: 'replay-bench-all-dev',
    n_dev: scores.length,
    n_holdout: 0,
    labels,
  }, null, 2));
  return {outDir, board, devBoard: board, holdBoard: buildScoreboard([]), n: scores.length, caseIds, goldFile};
}

function summarizeBoard(board: Awaited<ReturnType<typeof rescoreRun>>['board']) {
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
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {values, positionals} = parseArgs({
    args: process.argv.slice(2),
    options: {
      gold: {type: 'string', default: 'v4'},
      'cases-dir': {type: 'string'},
      out: {type: 'string'},
    },
    allowPositionals: true,
  });
  const goldRaw = (values.gold ?? 'v4').toLowerCase();
  if (goldRaw !== 'v4' && goldRaw !== 'v5') {
    throw new Error(`--gold must be v4|v5, got ${values.gold}`);
  }
  const runDir = positionals[0] ?? join(DATA_ROOT, 'runs/run-2026-11-19T08-35-06-901Z');
  const {outDir, board, n, goldFile} = await rescoreRun({
    runDir,
    casesDir: values['cases-dir'],
    outDir: values.out,
    gold: goldRaw,
  });
  process.stdout.write(JSON.stringify({
    outDir, n, gold: goldRaw, goldFile,
    summary: summarizeBoard(board),
    by_workflow: Object.fromEntries(Object.entries(board.by_workflow).map(([wf, row]) => [wf, {
      n: row.n,
      field_accuracy: row.field_accuracy,
      hit: row.hit, miss: row.miss,
      spray: row.spray,
      spurious: row.spurious,
      tier1: {hit: row.tier1_core.hit, miss: row.tier1_core.miss, acc: row.tier1_core.field_accuracy},
      tier2: {hit: row.tier2_defaults.hit, miss: row.tier2_defaults.miss, acc: row.tier2_defaults.field_accuracy},
      history: {hit: row.history_knowable.hit, miss: row.history_knowable.miss, acc: row.history_knowable.field_accuracy},
      parity: {hit: row.parity.hit, miss: row.parity.miss, acc: row.parity.field_accuracy},
      routing: {hit: row.workflow_routing.hit, miss: row.workflow_routing.miss, acc: row.workflow_routing.field_accuracy},
      by_path: {
        ...Object.fromEntries(Object.entries(row.tier1_core.by_path).map(([p, c]) => [p, {...c, tier: 'tier1_core'}])),
        ...Object.fromEntries(Object.entries(row.tier2_defaults.by_path).map(([p, c]) => [p, {...c, tier: 'tier2_defaults'}])),
        ...Object.fromEntries(Object.entries(row.history_knowable.by_path).map(([p, c]) => [p, {...c, tier: 'history_knowable'}])),
        ...Object.fromEntries(Object.entries(row.parity.by_path).map(([p, c]) => [p, {...c, tier: 'parity'}])),
      },
    }])),
  }, null, 2) + '\n');
}
