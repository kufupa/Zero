import {createHash} from 'node:crypto';
import {createReadStream, existsSync} from 'node:fs';
import {readdir, readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import type {CaseCard} from '../types.js';
import {contentDigest, orderedBusinessValue} from '../twin/read-result.js';

export const PREDICTION_SCHEMA = 'nava.replay.prediction_inputs/v1';
export const GRADE_SCHEMA = 'nava.replay.grade_inputs/v1';

/** Agent-visible case: strip gold / scores / workflow labels used only for grading. */
export function sealPublicCaseCard(card: CaseCard): CaseCard {
  const {
    gold: _gold,
    unscored_request_fields: _unscored,
    omitted: _omitted,
    expected_targets: _targets,
    expected_action_count: _count,
    expected_disposition: _disp,
    expected_dispositions: _disps,
    is_vcc_trap: _vcc,
    is_staff_reply_trap: _staff,
    doc_kind: _doc,
    ...publicCard
  } = card;
  return {...publicCard, case_id: card.case_id, workflow: card.workflow};
}

/** Evaluator-only material; never mount during strict predict. */
export function privateGradeMaterial(card: CaseCard) {
  return {
    schema: GRADE_SCHEMA,
    case_id: card.case_id,
    workflow: card.workflow,
    gold: card.gold ?? null,
    unscored_request_fields: card.unscored_request_fields ?? null,
    omitted: card.omitted ?? null,
    expected_targets: card.expected_targets ?? null,
    expected_action_count: card.expected_action_count ?? null,
    expected_disposition: card.expected_disposition ?? null,
    expected_dispositions: card.expected_dispositions ?? null,
    is_vcc_trap: card.is_vcc_trap ?? null,
    is_staff_reply_trap: card.is_staff_reply_trap ?? null,
    doc_kind: card.doc_kind ?? null,
  };
}

export async function digestFile(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Content digest of world inputs (not directory basename). */
export async function worldContentDigest(worldDir: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(`world:${worldDir}\n`);
  const names = (await readdir(worldDir)).filter(name => !name.startsWith('.')).sort();
  for (const name of names) {
    const path = join(worldDir, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    hash.update(`${name}\0`);
    hash.update(await readFile(path));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export type PredictionCacheParts = {
  git_sha: string;
  world_content_digest: string;
  skills_digest: string;
  model: string;
  reasoning: string;
  direct_evidence: string;
  case_id: string;
  evidence_digest: string;
  flags_digest: string;
};

/** Cache prediction by evidence/world/model/flags/skills — never gold. */
export function predictionCacheKey(parts: PredictionCacheParts): string {
  const payload = [
    parts.git_sha,
    parts.world_content_digest,
    parts.skills_digest,
    parts.model,
    parts.reasoning,
    parts.direct_evidence,
    parts.case_id,
    parts.evidence_digest,
    parts.flags_digest,
  ].join('\0');
  return createHash('sha256').update(payload).digest('hex');
}

export function evidenceDigestFromMail(mail: unknown): string {
  return contentDigest(orderedBusinessValue(mail));
}

export function flagsDigest(flags: Record<string, string | boolean | null | undefined>): string {
  return contentDigest(flags);
}

export function rawPredictionSha(prediction: unknown): string {
  return createHash('sha256').update(JSON.stringify(orderedBusinessValue(prediction))).digest('hex');
}

export type AttemptedState = 'produced' | 'runtime_error' | 'missing_prediction' | 'not_evaluable';

export function attemptedStateOf(row: {
  run_error?: string | null;
  proposal?: unknown;
  not_evaluable?: boolean;
}): AttemptedState {
  if (row.not_evaluable) return 'not_evaluable';
  if (row.run_error) return 'runtime_error';
  if (row.proposal == null) return 'missing_prediction';
  return 'produced';
}

/** Load unlabelled roster IDs without opening gold. */
export async function loadRosterIds(path: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const line of createInterface({input: createReadStream(path), crlfDelay: Infinity})) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {case_id?: string; id?: string};
    const id = row.case_id ?? row.id;
    if (typeof id === 'string' && id) ids.push(id);
  }
  return ids;
}

export function publicPredictionRecord(args: {
  case_id: string;
  evidence_digest: string;
  world_content_digest: string;
  skills_digest: string;
  model: string;
  reasoning: string;
  proposal: unknown;
  proposal_raw: unknown;
  tool_calls: unknown[];
  run_error?: string | null;
  attempted_state: AttemptedState;
}) {
  const body = {
    schema: PREDICTION_SCHEMA,
    case_id: args.case_id,
    evidence_digest: args.evidence_digest,
    world_content_digest: args.world_content_digest,
    skills_digest: args.skills_digest,
    model: args.model,
    reasoning: args.reasoning,
    proposal: args.proposal,
    proposal_raw: args.proposal_raw,
    tool_calls: args.tool_calls,
    run_error: args.run_error ?? null,
    attempted_state: args.attempted_state,
  };
  return {...body, raw_prediction_sha: rawPredictionSha(body)};
}
