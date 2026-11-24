import {mkdir, writeFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {pinSkills} from '../../tools/skills/index.js';
import {applyGoldOverlay, loadReplayGold} from './gold-overlay.js';
import {loadCaseCards, mapPool, readOptionalJson, skillsPath, writeBoards, type ReplayOptions} from './artifacts.js';
import {
  attemptedStateOf,
  preservePredictionSha,
  rosterPlaceholder,
  rulerStamp,
  scoreCase,
  type CaseScore,
  type ReplayProvenance,
} from './score.js';
import {DEFAULT_DATA_ROOT} from '../twin/world.js';
import type {AttemptedState} from '../types.js';

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
  root_prediction_shas?: Record<string, string>;
  dataset_window?: string;
  cohort?: string;
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

function recordedToolCalls(saved: CaseScore): NonNullable<CaseScore['tool_calls']> {
  if (saved.tool_calls) return saved.tool_calls;
  // Legacy runs saved search response IDs, but only the input for reads.
  return (saved.tool_quality?.calls ?? []).map(call => ({
    name: call.name,
    result: {
      ok: call.ok && !call.error,
      ...(call.error ? {error: {code: call.error}} : {}),
      data: call.name === 'hms_search_reservations' && call.hits === 1
        ? {candidates: call.top?.map(row => ({reservation_id: row.id}))}
        : undefined,
    },
  }));
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
  const priorShas = prior.root_prediction_shas ?? {};
  const results = await mapPool(cards, options.concurrency ?? 10, async card => {
    const overlay = gold.map[card.case_id];
    const graded = applyGoldOverlay(card, overlay);
    const saved: CaseScore | null = await readOptionalJson(join(runDir, `${card.case_id}.json`));
    if (graded.not_evaluable) {
      const sha = preservePredictionSha({
        root_prediction_sha: priorShas[card.case_id] ?? saved?.root_prediction_sha ?? saved?.raw_prediction_sha,
        proposal_raw: saved?.proposal_raw, proposal: saved?.proposal,
      });
      return rosterPlaceholder({
        case_id: card.case_id, workflow: graded.workflow, attempted_state: 'not_evaluable',
        ...sha, cohort_leak: saved?.cohort_leak,
      });
    }
    if (saved === null) {
      return rosterPlaceholder({
        case_id: card.case_id, workflow: graded.workflow, attempted_state: 'missing_prediction',
        root_prediction_sha: priorShas[card.case_id],
      });
    }
    const shas = preservePredictionSha({
      raw_prediction_sha: saved.raw_prediction_sha,
      root_prediction_sha: saved.root_prediction_sha ?? priorShas[card.case_id],
      proposal_raw: saved.proposal_raw,
      proposal: saved.proposal,
    });
    // The saved proposal is already staged. Tool responses only establish discovery evidence.
    const score = scoreCase({
      card: graded,
      proposal: saved.proposal,
      proposal_raw: saved.proposal_raw ?? saved.proposal,
      toolCalls: recordedToolCalls(saved),
      tokens: saved.tokens ?? {input: 0, output: 0, cached_input: 0},
      wall_ms: saved.wall_ms ?? 0,
      normalize: false,
      publish_invalid: saved.publish_invalid,
      run_error: saved.run_error,
      model: model ?? 'unknown',
      worldDir: ruler.world_dir ?? undefined,
      ...shas,
    });
    if (saved.cost_usd !== undefined) score.cost_usd = saved.cost_usd;
    score.twin_uncovered = (saved.twin_uncovered ?? []).filter(reason => !reason.startsWith('RUN_ERROR:'));
    if (saved.tool_quality) score.tool_quality = saved.tool_quality;
    score.quote_capture_ok = saved.quote_capture_ok ?? false;
    score.raw_prediction_sha = shas.raw_prediction_sha;
    score.root_prediction_sha = shas.root_prediction_sha;
    score.attempted_state = attemptedStateOf({
      ...score,
      attempted_state: saved.run_error ? 'runtime_error' : score.attempted_state,
    });
    // Reconcile email_outcome after restoring twin_uncovered (tool_calls tape may be truncated).
    const modelFields = score.fields.filter(field => field.path !== '/workflow' && field.model_quality !== false
      && field.knowable !== false && (field.result === 'hit' || field.result === 'miss' || field.result === 'blocked_by_route'));
    if (score.attempted_state === 'runtime_error') score.email_outcome = 'runtime_error';
    else if (score.attempted_state === 'missing_prediction') score.email_outcome = 'missing_prediction';
    else if (score.attempted_state === 'not_evaluable') score.email_outcome = 'not_evaluable';
    else if (score.twin_uncovered.length > 0 && modelFields.length === 0) score.email_outcome = 'unobservable';
    else {
      const anyHarm = score.harm_flags ? Object.values(score.harm_flags).some(Boolean) : false;
      const modelOk = modelFields.every(field => field.result === 'hit' || field.route_independent_hit === true);
      score.email_outcome = score.route_ok && score.disposition_ok && !anyHarm && modelOk ? 'success' : 'failure';
    }
    return score;
  });
  // Keep every requested roster slot — never drop missing/runtime from primary n.
  let scores = results.slice(0, options.limit ?? results.length);
  if (!scores.length) throw new Error('No roster cases matched');
  const missing = scores.filter(score => attemptedStateOf(score) === 'missing_prediction').map(score => score.case_id);
  if (options.caseIds && missing.length && options.caseIds.every(id => missing.includes(id))) {
    // Explicit single-case request that is missing still returns the placeholder (U7).
  }
  await mapPool(scores, options.concurrency ?? 10, score =>
    writeFile(join(outDir, `${score.case_id}.json`), JSON.stringify(score)));
  const caseIds = scores.map(score => score.case_id);
  const root_prediction_shas = Object.fromEntries(scores.map(score => [
    score.case_id, score.root_prediction_sha ?? score.raw_prediction_sha ?? '',
  ]).filter(([, sha]) => sha));
  const rosterCounts = scores.reduce<Record<AttemptedState, number>>((acc, score) => {
    acc[attemptedStateOf(score)] += 1;
    return acc;
  }, {produced: 0, runtime_error: 0, missing_prediction: 0, not_evaluable: 0});
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify({
    ...ruler, provenance: ruler, runDir, cases_dir: casesDir, case_ids: caseIds, pinned_property: property,
    skills_dir: skillsDir ? skillsPath(skillsDir) : null,
    source_git_sha: prior.git_sha ?? null, source_git_dirty: prior.git_dirty ?? null,
    missing_result_count: rosterCounts.missing_prediction,
    roster: rosterCounts,
    root_prediction_shas,
    gold_reader: gold.reader,
    dataset_window: prior.dataset_window ?? null,
    cohort: prior.cohort ?? null,
    units: scores.reduce((n, score) => n + (score.expected_units ?? 0), 0),
    effort: ruler.reasoning_effort,
  }, null, 2));
  await writeFile(join(outDir, 'roster.json'), JSON.stringify({
    n: scores.length,
    states: rosterCounts,
    case_ids: caseIds,
    root_prediction_shas,
  }, null, 2));
  const sourceWall = scores.length === prior.case_ids?.length && prior.case_ids.every(id => caseIds.includes(id))
    ? sourceBoard?.totals?.wall_ms : undefined;
  const boards = await writeBoards(outDir, casesDir, scores, ruler, sourceWall);
  return {...boards, n: scores.length, caseIds, goldFile: gold.file, roster: rosterCounts};
}
