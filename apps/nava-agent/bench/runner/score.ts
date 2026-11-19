import type {CaseCard, GoldField, Workflow} from '../types.js';

export type FieldScore = {
  path: string;
  expectation: GoldField['expectation'];
  result: 'hit' | 'miss' | 'not_expected' | 'no_gold' | 'skipped';
  expected?: unknown;
  actual?: unknown;
  basis?: string;
  tier?: string;
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
  /** Set when the case threw before a proposal; all expected fields scored miss. */
  run_error?: string;
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
    if (row.code != null || row.name != null || row.value != null || row.first_name != null) {
      return [row.code, row.name, row.value, row.first_name, row.last_name]
        .filter(v => v != null && v !== '')
        .map(v => String(v).trim().toLowerCase())
        .join('|');
    }
    return JSON.stringify(value).toLowerCase();
  }
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Measurement-only: date / whitespace / case already in normalize; add ISO date aliases. */
function normalizeDate(value: unknown): string {
  const raw = normalize(value);
  if (!raw) return '';
  const m = raw.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const m2 = raw.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  return raw;
}

const GUARANTEE_ALIASES: Record<string, string[]> = {
  'guaranteed by agent': ['depreq', 'gtdagent', 'agent', 'guaranteedbyagent'],
  depreq: ['guaranteed by agent', 'gtdagent', 'agent'],
  'guaranteed by company': ['depco', 'company'],
  '6pm hold': ['6pm', 'hold', 'non-guaranteed', 'nonguaranteed'],
};

function acronym(value: string): string {
  return value.split(/[^a-z0-9]+/i).filter(Boolean).map(part => part[0] ?? '').join('').toLowerCase();
}

function compactAlnum(value: string): string {
  return value.replace(/[^a-z0-9]+/g, '');
}

/**
 * Agency/org: exact code or exact normalised full name only.
 * tokenOverlap ("Nexus Travel" ↔ "XL Nexus") is a false hit — do not use here.
 */
function partyExactMatch(expected: unknown, actual: unknown): boolean {
  if (actual == null || actual === '') return false;
  const actualNorm = normalize(actual);
  const actualCompact = compactAlnum(actualNorm);
  if (!actualNorm) return false;

  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const row = expected as Record<string, unknown>;
    const aliases = Array.isArray(row.aliases) ? row.aliases : [];
    for (const part of [row.code, row.nativeId, row.native_id, ...aliases]) {
      if (part == null || part === '') continue;
      const needle = normalize(part);
      if (!needle) continue;
      if (actualNorm === needle || actualCompact === compactAlnum(needle)) return true;
    }
    for (const part of [row.name, row.value]) {
      if (part == null || part === '') continue;
      const needle = normalize(part);
      if (!needle) continue;
      // Full normalised name equality only (not substring / token overlap).
      if (actualNorm === needle || actualCompact === compactAlnum(needle)) return true;
    }
    // Actual may be {code,name} too.
    if (typeof actual === 'object' && actual && !Array.isArray(actual)) {
      const act = actual as Record<string, unknown>;
      for (const key of ['code', 'nativeId', 'native_id'] as const) {
        if (row.code != null && act[key] != null && normalize(row.code) === normalize(act[key])) return true;
        if (row.nativeId != null && act[key] != null && normalize(row.nativeId) === normalize(act[key])) return true;
        if (row.native_id != null && act[key] != null && normalize(row.native_id) === normalize(act[key])) return true;
      }
      if (row.name != null && act.name != null && normalize(row.name) === normalize(act.name)) return true;
    }
    return false;
  }

  const a = normalize(expected);
  if (!a) return false;
  return a === actualNorm || compactAlnum(a) === actualCompact;
}

function equalish(expected: unknown, actual: unknown): boolean {
  // Count fields: null/'' gold or actual ↔ 0 (measurement; not agent tuning).
  if (expected == null || expected === '') {
    if (actual == null || actual === '' || actual === 0 || actual === '0') return true;
  }
  if ((expected === 0 || expected === '0') && (actual == null || actual === '' || actual === 0 || actual === '0')) {
    return true;
  }
  if (actual == null || actual === '') return false;
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const row = expected as Record<string, unknown>;
    const actualNorm = normalize(actual);
    if (!actualNorm) return false;
    const aliases = Array.isArray(row.aliases) ? row.aliases : [];
    for (const part of [row.code, row.name, row.value, row.first_name, row.last_name, row.nativeId, row.native_id, ...aliases]) {
      if (part == null || part === '') continue;
      const needle = normalize(part);
      if (!needle) continue;
      if (actualNorm === needle || actualNorm.includes(needle) || needle.includes(actualNorm)) return true;
      // Acronym only (MISA ↔ Municipal Infrastructure Support Agent). No tokenOverlap
      // (that false-hit "Nexus Travel" ↔ "XL Nexus") and no person-name swap.
      if (acronym(actualNorm) === needle || acronym(needle) === actualNorm) return true;
    }
    return false;
  }
  const a = normalize(expected);
  const b = normalize(actual);
  if (!a || !b) return false;
  const da = normalizeDate(expected);
  const db = normalizeDate(actual);
  if (da && db && da === db) return true;
  // Guarantee name ↔ code
  for (const [canon, alts] of Object.entries(GUARANTEE_ALIASES)) {
    const bucket = new Set([compactAlnum(canon), ...alts.map(x => compactAlnum(x))]);
    if (bucket.has(compactAlnum(a)) && bucket.has(compactAlnum(b))) return true;
  }
  // Swapped person names ("First Last" ↔ "Last First") are real staff/agent errors — miss.
  return (
    a === b ||
    b.includes(a) ||
    a.includes(b) ||
    compactAlnum(a) === compactAlnum(b) ||
    compactAlnum(a).includes(compactAlnum(b)) ||
    compactAlnum(b).includes(compactAlnum(a)) ||
    acronym(a) === b ||
    acronym(b) === a
  );
}

/**
 * Create multi-guest: gold first/last are for one confirmation stay, but the agent
 * correctly publishes all listed guests in list order. Hit if any booking carries
 * the gold name pair (same any-sibling rule as reservation_id). Swapped first/last
 * stays a miss — that lands wrong in HMS.
 */
function guestNameHit(expected: unknown, proposal: unknown, path: string, card: CaseCard): boolean {
  const actual = dig(proposal, path);
  if (equalish(expected, actual)) return true;
  if (!path.endsWith('first_name') && !path.endsWith('last_name')) return false;
  const golds = card.gold ?? [];
  const wantFirst = golds.find(g => g.path.endsWith('first_name') && g.expectation === 'expected')?.value;
  const wantLast = golds.find(g => g.path.endsWith('last_name') && g.expectation === 'expected')?.value;
  if (wantFirst == null && wantLast == null) return false;
  const bookings = dig(proposal, '/bookings');
  if (!Array.isArray(bookings)) return false;
  for (const booking of bookings) {
    const row = booking && typeof booking === 'object' ? booking as Record<string, unknown> : {};
    const fields = row.fields && typeof row.fields === 'object' ? row.fields as Record<string, unknown> : {};
    const first = fields.first_name;
    const last = fields.last_name;
    const direct =
      (wantFirst == null || equalish(wantFirst, first)) &&
      (wantLast == null || equalish(wantLast, last));
    if (direct) return true;
  }
  return false;
}

/** Org/agency: exact code or exact normalised name; sibling *_id vs gold.code/nativeId. */
function partyHit(expected: unknown, proposal: unknown, path: string): boolean {
  const actual = dig(proposal, path);
  if (path.endsWith('organization_name') || path.endsWith('agency_name')) {
    if (partyExactMatch(expected, actual)) return true;
    if (path.endsWith('organization_name')) {
      if (partyExactMatch(expected, dig(proposal, path.replace(/organization_name$/, 'organization_id')))) return true;
    }
    if (path.endsWith('agency_name')) {
      if (partyExactMatch(expected, dig(proposal, path.replace(/agency_name$/, 'agency_id')))) return true;
    }
  } else if (equalish(expected, actual)) {
    return true;
  }
  // reservation_id / confirmation_number: accept suffix-normalized match on the
  // gold path OR any sibling booking (multi-conf cancel/filing publishes all stays).
  if (path.endsWith('reservation_id') || path.endsWith('confirmation_number')) {
    const a = normalize(expected);
    const b = normalize(actual);
    if (a && b && (a.split('-')[0] === b.split('-')[0])) return true;
    const bookings = dig(proposal, '/bookings');
    if (a && Array.isArray(bookings)) {
      for (const booking of bookings) {
        const row = booking && typeof booking === 'object' ? booking as Record<string, unknown> : {};
        const fields = row.fields && typeof row.fields === 'object' ? row.fields as Record<string, unknown> : {};
        for (const cand of [row.reservation_id, fields.confirmation_number, fields.reservation_id]) {
          const c = normalize(cand);
          if (c && (c === a || c.split('-')[0] === a.split('-')[0])) return true;
        }
      }
    }
  }
  return false;
}

const workflowTools: Record<Workflow, string[]> = {
  create: ['mail_read_thread', 'skill_read', 'hms_search_parties', 'hms_read_catalogue', 'hms_quote', 'hms_prepare', 'proposal_publish'],
  amend: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'hms_prepare', 'proposal_publish'],
  cancel: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'hms_prepare', 'proposal_publish'],
  filing: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'hms_prepare', 'proposal_publish'],
  quote: ['mail_read_thread', 'skill_read', 'hms_read_catalogue', 'hms_quote', 'proposal_publish'],
  triage: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'proposal_publish'],
};

function goldTier(gold: GoldField & {tier?: string}): string {
  if (gold.tier) return gold.tier;
  if (gold.path.includes('cms_') || gold.path.includes('guarantee') || gold.path.includes('source_of') || gold.path.includes('/track') || gold.path.includes('billing_')) {
    return 'tier2_defaults';
  }
  return 'tier1_core';
}

export function scoreCase(input: {
  card: CaseCard;
  proposal: unknown;
  toolCalls: Array<{name: string; input?: unknown; result?: {ok?: boolean; data?: unknown; error?: {code?: string} | null}}>;
  tokens: {input: number; output: number; cached_input: number};
  wall_ms: number;
}): CaseScore {
  const {card, proposal, toolCalls, tokens, wall_ms} = input;
  const fields: FieldScore[] = [];
  for (const gold of card.gold ?? []) {
    // Refuse /hms/* gold — proposal_publish has no such key (structural bug guard).
    if (gold.path.startsWith('/hms/')) {
      fields.push({
        path: gold.path,
        expectation: gold.expectation,
        result: 'skipped',
        basis: 'REFUSE_HMS_GOLD_PATH',
        tier: goldTier(gold as GoldField & {tier?: string}),
      });
      continue;
    }
    const tier = goldTier(gold as GoldField & {tier?: string});
    if (gold.expectation === 'not_expected') {
      fields.push({path: gold.path, expectation: 'not_expected', result: 'not_expected', basis: gold.basis, tier});
      continue;
    }
    if (gold.expectation === 'no_gold') {
      fields.push({path: gold.path, expectation: 'no_gold', result: 'no_gold', basis: gold.basis, tier});
      continue;
    }
    const actual = dig(proposal, gold.path);
    const partyPath = /organization_name$|agency_name$|reservation_id$|confirmation_number$/.test(gold.path);
    const guestPath = /\/fields\/(first_name|last_name)$/.test(gold.path);
    let hit = partyPath
      ? partyHit(gold.value, proposal, gold.path)
      : guestPath
        ? guestNameHit(gold.value, proposal, gold.path, card)
        : equalish(gold.value, actual);
    // Bench gold often uses pdf-0 placeholder; agent publishes real attachment UUID.
    if (!hit && gold.path.endsWith('attachment_id')) {
      const exp = String(gold.value ?? '');
      if (/^pdf-\d+$/i.test(exp) && actual != null && String(actual).length > 0) hit = true;
    }
    fields.push({
      path: gold.path,
      expectation: 'expected',
      result: hit ? 'hit' : 'miss',
      expected: gold.value,
      actual,
      basis: gold.basis,
      tier,
    });
  }

  // (f) Workflow routing — most important single number.
  const published = proposal && typeof proposal === 'object'
    ? String((proposal as {workflow?: unknown}).workflow ?? '')
    : '';
  fields.push({
    path: '/workflow',
    expectation: 'expected',
    result: published && published === card.workflow ? 'hit' : 'miss',
    expected: card.workflow,
    actual: published || null,
    basis: 'workflow_routing',
    tier: 'workflow_routing',
  });

  const allowed = new Set(workflowTools[card.workflow] ?? []);
  let wasted = 0;
  let right = 0;
  let keyHits = 0;
  let keyMisses = 0;
  for (const call of toolCalls) {
    if (allowed.has(call.name)) right += 1;
    else wasted += 1;
    if (call.name === 'hms_search_reservations' || call.name === 'hms_read_reservation') {
      const rid = card.real_confirmation ?? card.confirmation;
      const body = (call.input ?? {}) as Record<string, unknown>;
      const got = String(
        body.reservation_id
        ?? (body.criteria as {reservation_id?: unknown} | undefined)?.reservation_id
        ?? '',
      );
      if (rid && got && (got === rid || got.startsWith(String(rid).split('-')[0]))) keyHits += 1;
      else if (rid) keyMisses += 1;
    }
  }

  const twin_uncovered = toolCalls
    .filter(call => call.result?.ok === false && (call.result.error?.code === 'TWIN_NO_PRICE' || call.result.error?.code === 'TWIN_NO_SAVE'))
    .map(call => `${call.name}:${call.result?.error?.code ?? 'err'}`);

  return {
    case_id: card.case_id,
    workflow: card.workflow,
    fields,
    tool_quality: {
      calls: toolCalls.map(call => ({name: call.name, ok: call.result?.ok !== false})),
      right_tool: right,
      wasted_calls: wasted,
      key_arg_hits: keyHits,
      key_arg_misses: keyMisses,
    },
    tokens,
    cost_usd: costUsd(tokens),
    wall_ms,
    twin_uncovered,
    proposal,
  };
}

export type TierBucket = {
  hit: number;
  miss: number;
  not_expected: number;
  no_gold: number;
  field_accuracy: number | null;
  by_path: Record<string, {hit: number; miss: number}>;
};

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
    tier1_core: TierBucket;
    tier2_defaults: TierBucket;
    history_knowable: TierBucket;
    workflow_routing: TierBucket;
  }>;
  totals: {
    hit: number;
    miss: number;
    cost_usd: number;
    wall_ms: number;
    twin_no_price: number;
    workflow_routing_hit: number;
    workflow_routing_miss: number;
    workflow_routing_accuracy: number | null;
    errors: number;
  };
  cases: CaseScore[];
};

function emptyTier(): TierBucket {
  return {hit: 0, miss: 0, not_expected: 0, no_gold: 0, field_accuracy: null, by_path: {}};
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

function bumpTier(bucket: TierBucket, field: FieldScore) {
  if (field.result === 'hit') {
    bucket.hit += 1;
    const row = bucket.by_path[field.path] ??= {hit: 0, miss: 0};
    row.hit += 1;
  } else if (field.result === 'miss') {
    bucket.miss += 1;
    const row = bucket.by_path[field.path] ??= {hit: 0, miss: 0};
    row.miss += 1;
  } else if (field.result === 'not_expected') bucket.not_expected += 1;
  else if (field.result === 'no_gold') bucket.no_gold += 1;
}

function pickTier(bucket: Scoreboard['by_workflow'][string], tier: string | undefined): TierBucket {
  if (tier === 'tier2_defaults') return bucket.tier2_defaults;
  if (tier === 'history_knowable') return bucket.history_knowable;
  if (tier === 'workflow_routing') return bucket.workflow_routing;
  return bucket.tier1_core;
}

export function buildScoreboard(cases: CaseScore[]): Scoreboard {
  const by_workflow: Scoreboard['by_workflow'] = {};
  let hit = 0, miss = 0, cost = 0, wall = 0, twin = 0, routeHit = 0, routeMiss = 0, errors = 0;
  for (const row of cases) {
    const bucket = by_workflow[row.workflow] ??= {
      n: 0, hit: 0, miss: 0, not_expected: 0, no_gold: 0, field_accuracy: null,
      p50_ms: null, p95_ms: null, cost_usd: 0,
      tier1_core: emptyTier(), tier2_defaults: emptyTier(),
      history_knowable: emptyTier(), workflow_routing: emptyTier(),
    };
    bucket.n += 1;
    bucket.cost_usd += row.cost_usd;
    cost += row.cost_usd;
    wall = Math.max(wall, row.wall_ms);
    twin += row.twin_uncovered.length ? 1 : 0;
    if (row.run_error) errors += 1;
    for (const field of row.fields) {
      const isRoute = field.tier === 'workflow_routing' || field.path === '/workflow';
      if (field.result === 'hit') {
        if (isRoute) routeHit += 1;
        else { bucket.hit += 1; hit += 1; }
      } else if (field.result === 'miss') {
        if (isRoute) routeMiss += 1;
        else { bucket.miss += 1; miss += 1; }
      } else if (field.result === 'not_expected') bucket.not_expected += 1;
      else if (field.result === 'no_gold') bucket.no_gold += 1;
      bumpTier(pickTier(bucket, field.tier), field);
    }
  }
  for (const [wf, bucket] of Object.entries(by_workflow)) {
    const denom = bucket.hit + bucket.miss;
    bucket.field_accuracy = denom ? bucket.hit / denom : null;
    for (const tier of [bucket.tier1_core, bucket.tier2_defaults, bucket.history_knowable, bucket.workflow_routing]) {
      const d = tier.hit + tier.miss;
      tier.field_accuracy = d ? tier.hit / d : null;
    }
    const walls = cases.filter(c => c.workflow === wf).map(c => c.wall_ms);
    bucket.p50_ms = percentile(walls, 0.5);
    bucket.p95_ms = percentile(walls, 0.95);
  }
  const routeDenom = routeHit + routeMiss;
  return {
    n: cases.length,
    by_workflow,
    totals: {
      hit, miss, cost_usd: cost, wall_ms: wall, twin_no_price: twin,
      workflow_routing_hit: routeHit,
      workflow_routing_miss: routeMiss,
      workflow_routing_accuracy: routeDenom ? routeHit / routeDenom : null,
      errors,
    },
    cases,
  };
}
