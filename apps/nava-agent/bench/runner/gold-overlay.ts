import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import type {CaseCard, GoldField, Workflow} from '../types.js';
import {DEFAULT_DATA_ROOT} from '../twin/world.js';

export type GoldVersion = 'v4' | 'v5';
type GoldEntry = Pick<CaseCard, 'gold' | 'unscored_request_fields'> & {
  workflow?: Workflow;
  staff_outcome_only?: unknown;
  skip?: boolean;
  /** Roster not_evaluable — stays in attempted denominator (U7). */
  not_evaluable?: boolean;
  gold_patches?: Array<Partial<GoldField> & {path: string}>;
  doc_kind?: string;
  expected_targets?: string[];
  expected_action_count?: number;
  expected_disposition?: string;
  expected_dispositions?: string[];
  is_vcc_trap?: boolean;
  is_staff_reply_trap?: boolean;
};
export type GoldMap = Record<string, GoldEntry>;

/** Legacy v4/v5 gold map reader — schema-tagged v7 stays isolated elsewhere. */
export function isLegacyGoldMap(map: unknown): map is GoldMap {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
  const schema = (map as {schema?: unknown; $schema?: unknown}).schema
    ?? (map as {$schema?: unknown}).$schema;
  if (typeof schema === 'string' && /v7|nava\.replay\.(?:gold|grade)/i.test(schema)) return false;
  if ((map as {gold_version?: unknown}).gold_version === 'v7') return false;
  // Case-id keyed map: reject if every entry looks like a schema-tagged unit bundle.
  const values = Object.values(map as Record<string, unknown>);
  if (values.length && values.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof (entry as {schema?: unknown}).schema === 'string'
    && /v7/i.test(String((entry as {schema: string}).schema)))) {
    return false;
  }
  return true;
}

const sets = new Set(['holdout-fresh', 'holdout-v2', 'holdout-v3', 'v1', 'dev-fresh', 'dev-v2']);

export async function loadReplayGold(options: {casesDir: string; goldFile?: string; gold?: GoldVersion}) {
  const set = basename(options.casesDir);
  const version = options.gold ?? (process.env.BENCH_GOLD === 'v4' ? 'v4' : 'v5');
  const file = options.goldFile ? resolve(options.goldFile) : sets.has(set)
    ? join(process.env.NAVA_BENCH_DATA_ROOT ?? DEFAULT_DATA_ROOT, 'gold-audit', set, `gold-${version}.json`)
    : null;
  if (!file) throw new Error('Pass --gold-file for a custom case set');
  const bytes = await readFile(file);
  const map: GoldMap = JSON.parse(bytes.toString('utf8'));
  if (!isLegacyGoldMap(map)) throw new Error(`Invalid gold map: ${file}`);
  return {file, map, sha256: createHash('sha256').update(bytes).digest('hex'), reader: 'legacy_v4_v5' as const};
}

export function applyGoldOverlay(card: CaseCard, overlay: GoldEntry | undefined): CaseCard {
  if (!overlay) throw new Error(`Missing gold entry: ${card.case_id}`);
  const {workflow, gold, gold_patches, unscored_request_fields, skip, not_evaluable, doc_kind, expected_targets,
    expected_action_count, expected_disposition, expected_dispositions, is_vcc_trap, is_staff_reply_trap} = overlay;
  if (!Array.isArray(gold) && !Array.isArray(gold_patches) && !not_evaluable && !skip) {
    throw new Error(`Gold entry has no fields or patches: ${card.case_id}`);
  }
  const patches = new Map(gold_patches?.map(patch => [patch.path, patch]));
  return {
    ...card,
    workflow: workflow ?? card.workflow,
    gold: gold ?? card.gold?.map(field => ({...field, ...patches.get(field.path)} as GoldField)),
    unscored_request_fields: unscored_request_fields ?? card.unscored_request_fields,
    staff_outcome_only: [card.staff_outcome_only, overlay.staff_outcome_only],
    doc_kind: doc_kind ?? card.doc_kind,
    expected_targets: expected_targets ?? card.expected_targets,
    expected_action_count: expected_action_count ?? (skip ? 0 : card.expected_action_count),
    expected_disposition: expected_disposition ?? (skip ? 'skip' : card.expected_disposition),
    expected_dispositions: expected_dispositions ?? card.expected_dispositions,
    is_vcc_trap: is_vcc_trap ?? card.is_vcc_trap,
    is_staff_reply_trap: is_staff_reply_trap ?? card.is_staff_reply_trap,
    not_evaluable: not_evaluable ?? card.not_evaluable,
  };
}
