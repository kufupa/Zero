import type {CaseCard, GoldField, Workflow} from '../types.js';

export type FieldScore = {
  path: string;
  expectation: GoldField['expectation'];
  result: 'hit' | 'miss' | 'not_expected' | 'no_gold' | 'skipped';
  expected?: unknown;
  actual?: unknown;
  basis?: string;
};

export type ToolQuality = {
  calls: Array<{name: string; ok: boolean}>;
  right_tool: number;
  wasted_calls: number;
  key_arg_hits: number;
  key_arg_misses: number;
};

export type CaseScore = {
  case_id: string;
  workflow: Workflow;
  fields: FieldScore[];
  tool_quality: ToolQuality;
  tokens: {input: number; output: number; cached_input: number};
  cost_usd: number;
  wall_ms: number;
  twin_uncovered: string[];
  proposal: unknown;
};

const LUNA_IN = 0.10 / 1_000_000;
const LUNA_CACHED = 0.01 / 1_000_000;
const LUNA_OUT = 0.50 / 1_000_000;

export function costUsd(tokens: {input: number; output: number; cached_input: number}): number {
  const uncached = Math.max(0, tokens.input - tokens.cached_input);
  return uncached * LUNA_IN + tokens.cached_input * LUNA_CACHED + tokens.output * LUNA_OUT;
}

function dig(value: unknown, path: string): unknown {
  if (!path.startsWith('/')) return undefined;
  const parts = path.split('/').filter(Boolean);
  let cur: unknown = value;
  for (const part of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function normalize(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>;
    if (row.code != null || row.name != null || row.value != null) {
      return [row.code, row.name, row.value].filter(v => v != null).map(v => String(v).trim().toLowerCase()).join('|');
    }
    return JSON.stringify(value).toLowerCase();
  }
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function equalish(expected: unknown, actual: unknown): boolean {
  if (actual == null || actual === '') return false;
  // object gold: match code or name against actual string/object
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const row = expected as Record<string, unknown>;
    const actualNorm = normalize(actual);
    if (!actualNorm) return false;
    for (const key of ['code', 'name', 'value']) {
      const part = row[key];
      if (part == null || part === '') continue;
      const needle = normalize(part);
      if (needle && (actualNorm === needle || actualNorm.includes(needle) || needle.includes(actualNorm))) return true;
    }
    return false;
  }
  const a = normalize(expected);
  const b = normalize(actual);
  if (!a || !b) return false;
  return a === b || b.includes(a) || a.includes(b);
}

const workflowTools: Record<Workflow, string[]> = {
  create: ['mail_read_thread', 'skill_read', 'hms_search_parties', 'hms_read_catalogue', 'hms_quote', 'proposal_publish'],
  amend: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'proposal_publish'],
  cancel: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'proposal_publish'],
  filing: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'proposal_publish'],
  quote: ['mail_read_thread', 'skill_read', 'hms_read_catalogue', 'hms_quote', 'proposal_publish'],
  triage: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'proposal_publish'],
};

export function scoreCase(input: {
  card: CaseCard;
  proposal: unknown;
  toolCalls: Array<{name: string; input?: unknown; result?: {ok?: boolean; error?: {code?: string} | null}}>;
  tokens: {input: number; output: number; cached_input: number};
  wall_ms: number;
}): CaseScore {
  const {card, proposal, toolCalls, tokens, wall_ms} = input;
  const fields: FieldScore[] = [];
  for (const gold of card.gold ?? []) {
    if (gold.expectation === 'not_expected') {
      fields.push({path: gold.path, expectation: 'not_expected', result: 'not_expected', basis: gold.basis});
      continue;
    }
    if (gold.expectation === 'no_gold') {
      fields.push({path: gold.path, expectation: 'no_gold', result: 'no_gold', basis: gold.basis});
      continue;
    }
    const actual = dig(proposal, gold.path);
    const hit = equalish(gold.value, actual);
    fields.push({
      path: gold.path,
      expectation: 'expected',
      result: hit ? 'hit' : 'miss',
      expected: gold.value,
      actual,
      basis: gold.basis,
    });
  }

  const allowed = new Set(workflowTools[card.workflow] ?? []);
  let wasted = 0;
  let right = 0;
  for (const call of toolCalls) {
    if (allowed.has(call.name)) right += 1;
    else wasted += 1;
  }

  const twin_uncovered = toolCalls
    .filter(call => call.result?.ok === false && call.result.error?.code === 'TWIN_NO_PRICE')
    .map(call => call.name);

  return {
    case_id: card.case_id,
    workflow: card.workflow,
    fields,
    tool_quality: {
      calls: toolCalls.map(call => ({name: call.name, ok: call.result?.ok !== false})),
      right_tool: right,
      wasted_calls: wasted,
      key_arg_hits: 0,
      key_arg_misses: 0,
    },
    tokens,
    cost_usd: costUsd(tokens),
    wall_ms,
    twin_uncovered,
    proposal,
  };
}

export type Scoreboard = {
  n: number;
  by_workflow: Record<string, {
    n: number;
    hit: number;
    miss: number;
    not_expected: number;
    no_gold: number;
    field_accuracy: number | null;
    p50_ms: number | null;
    p95_ms: number | null;
    cost_usd: number;
  }>;
  totals: {hit: number; miss: number; cost_usd: number; wall_ms: number; twin_no_price: number};
  cases: CaseScore[];
};

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

export function buildScoreboard(cases: CaseScore[]): Scoreboard {
  const by_workflow: Scoreboard['by_workflow'] = {};
  let hit = 0, miss = 0, cost = 0, wall = 0, twin = 0;
  for (const row of cases) {
    const bucket = by_workflow[row.workflow] ??= {
      n: 0, hit: 0, miss: 0, not_expected: 0, no_gold: 0, field_accuracy: null, p50_ms: null, p95_ms: null, cost_usd: 0,
    };
    bucket.n += 1;
    bucket.cost_usd += row.cost_usd;
    cost += row.cost_usd;
    wall = Math.max(wall, row.wall_ms); // parallel wall approx set by runner
    twin += row.twin_uncovered.length ? 1 : 0;
    for (const field of row.fields) {
      if (field.result === 'hit') { bucket.hit += 1; hit += 1; }
      else if (field.result === 'miss') { bucket.miss += 1; miss += 1; }
      else if (field.result === 'not_expected') bucket.not_expected += 1;
      else if (field.result === 'no_gold') bucket.no_gold += 1;
    }
  }
  for (const [wf, bucket] of Object.entries(by_workflow)) {
    const denom = bucket.hit + bucket.miss;
    bucket.field_accuracy = denom ? bucket.hit / denom : null;
    const walls = cases.filter(c => c.workflow === wf).map(c => c.wall_ms);
    bucket.p50_ms = percentile(walls, 0.5);
    bucket.p95_ms = percentile(walls, 0.95);
  }
  return {
    n: cases.length,
    by_workflow,
    totals: {hit, miss, cost_usd: cost, wall_ms: wall, twin_no_price: twin},
    cases,
  };
}
