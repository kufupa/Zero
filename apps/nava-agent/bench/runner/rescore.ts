import {mkdir, writeFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {pinSkills} from '../../tools/skills/index.js';
import {applyGoldOverlay, loadReplayGold} from './gold-overlay.js';
import {loadCaseCards, mapPool, readOptionalJson, skillsPath, writeBoards, type ReplayOptions} from './artifacts.js';
import {rulerStamp, scoreCase, type CaseScore, type ReplayProvenance} from './score.js';
import {DEFAULT_DATA_ROOT} from '../twin/world.js';

type PriorManifest = Partial<ReplayProvenance> & {
  cases_dir?: string;
  gold_file?: string;
  gold_sha256?: string;
  casesDir?: string;
  case_ids?: string[];
  pinned_property?: string;
  skill_sha256?: string;
  deployment?: string;
  effort?: string;
  git_sha?: string;
  git_dirty?: boolean;
};

export function inferCasesDir(runDir: string): string {
  const name = basename(resolve(runDir));
  const inferred = ['holdout-v3', 'holdout-v2', 'holdout-fresh', 'dev-v2', 'dev-fresh'].find(set => name.startsWith(set))
    ?? (name.startsWith('holdout-') ? 'holdout-v3' : name.startsWith('dev-') ? 'dev-v2' : 'v1');
  return join(process.env.NAVA_BENCH_DATA_ROOT ?? DEFAULT_DATA_ROOT, 'cases', inferred);
}

function recorded(label: string, prior: string | null | undefined, supplied?: string) {
  if (prior && supplied && prior !== supplied) throw new Error(`Cannot change recorded ${label} in offline rescore: ${prior}`);
  return prior ?? supplied ?? null;
}

export async function rescoreRun(options: ReplayOptions & {runDir: string}) {
  const runDir = resolve(options.runDir);
  const prior: PriorManifest = await readOptionalJson(join(runDir, 'manifest.json')) ?? {};
  const casesDir = resolve(options.casesDir ?? prior.cases_dir ?? prior.casesDir ?? inferCasesDir(runDir));
  const outDir = resolve(options.outDir ?? join(runDir, 'rescored'));
  const gold = await loadReplayGold({...options, goldFile: options.goldFile ?? (options.gold ? undefined : prior.gold_file), casesDir});
  if (!options.goldFile && !options.gold && prior.gold_sha256 && gold.sha256 !== prior.gold_sha256) {
    throw new Error('Recorded gold file changed; pass --gold-file to rescore with its new contents');
  }
  const skillsDir = options.skillsDir ?? process.env.NAVA_SKILLS_DIR;
  const digest = skillsDir ? (await pinSkills(skillsPath(skillsDir))).version : undefined;
  const worldDir = options.worldDir ? resolve(options.worldDir) : undefined;
  const model = recorded('model', prior.model ?? prior.deployment, options.model);
  const property = recorded('property', prior.pinned_property, options.property);
  const ruler = rulerStamp(gold.file, gold.sha256, {
    model,
    reasoning_effort: recorded('reasoning effort', prior.reasoning_effort ?? prior.effort, options.reasoning),
    world_dir: recorded('world directory', prior.world_dir, worldDir),
    skills_digest: recorded('skills digest', prior.skills_digest ?? prior.skill_sha256, digest),
  });
  const cards = await loadCaseCards(casesDir, options.caseIds ?? prior.case_ids);
  const sourceBoard = await readOptionalJson(join(runDir, 'scoreboard.json'));
  await mkdir(outDir, {recursive: true});
  const results = await mapPool(cards, options.concurrency ?? 10, async card => {
    const saved: CaseScore | null = await readOptionalJson(join(runDir, `${card.case_id}.json`));
    if (saved === null) return null;
    // Saved staged proposals are authoritative. Truncated tool summaries cannot recreate binding.
    const score = scoreCase({
      card: applyGoldOverlay(card, gold.map[card.case_id]),
      proposal: saved.proposal,
      proposal_raw: saved.proposal_raw ?? saved.proposal,
      toolCalls: [],
      tokens: saved.tokens ?? {input: 0, output: 0, cached_input: 0},
      wall_ms: saved.wall_ms ?? 0,
      normalize: false,
      publish_invalid: saved.publish_invalid,
      run_error: saved.run_error,
      model: model ?? 'unknown',
    });
    if (saved.cost_usd !== undefined) score.cost_usd = saved.cost_usd;
    score.twin_uncovered = (saved.twin_uncovered ?? []).filter(reason => !reason.startsWith('RUN_ERROR:'));
    if (saved.tool_quality) score.tool_quality = saved.tool_quality;
    score.quote_capture_ok = saved.quote_capture_ok ?? false;
    return score;
  });
  const scores = results.filter(score => score !== null).slice(0, options.limit);
  if (!scores.length) throw new Error('No saved replay cases matched');
  const missing = cards.filter((_, index) => results[index] === null).map(card => card.case_id);
  if (options.caseIds && missing.length) throw new Error(`Saved replay results missing: ${missing.join(', ')}`);
  await mapPool(scores, options.concurrency ?? 10, score =>
    writeFile(join(outDir, `${score.case_id}.json`), JSON.stringify(score)));
  const caseIds = scores.map(score => score.case_id);
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify({
    ...ruler, provenance: ruler, runDir, cases_dir: casesDir, case_ids: caseIds, pinned_property: property,
    skills_dir: skillsDir ? skillsPath(skillsDir) : null,
    source_git_sha: prior.git_sha ?? null, source_git_dirty: prior.git_dirty ?? null, missing_result_count: missing.length,
  }, null, 2));
  const sourceWall = scores.length === prior.case_ids?.length && prior.case_ids.every(id => caseIds.includes(id)) ? sourceBoard?.totals?.wall_ms : undefined;
  const boards = await writeBoards(outDir, casesDir, scores, ruler, sourceWall);
  return {...boards, n: scores.length, caseIds, goldFile: gold.file};
}
