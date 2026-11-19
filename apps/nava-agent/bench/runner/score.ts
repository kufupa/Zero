import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {withCreateNativeFields, withQuoteStaffFields} from '../../src/proposal-fields.js';
import {proposalDraft} from '../../src/schema.js';
import type {CaseCard, GoldField, Workflow} from '../types.js';

const DATA_ROOT = process.env.NAVA_BENCH_DATA_ROOT ?? '/home/orca/.local/share/zero/bench/replay-bench-20261119';

export type FieldScore = {
  path: string;
  expectation: GoldField['expectation'];
  result: 'hit' | 'miss' | 'not_expected' | 'no_gold' | 'skipped' | 'spurious';
  expected?: unknown;
  actual?: unknown;
  basis?: string;
  tier?: string;
  priority?: string;
  source?: string;
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
  /** Proposal after prod field normalization (what staff see). */
  proposal: unknown;
  /** Raw proposal_publish input before normalization. */
  proposal_raw?: unknown;
  /** True when proposal listed more bookings than gold paths expect. */
  spray?: boolean;
  /** Set when the case threw before a proposal; all expected fields scored miss. */
  run_error?: string;
};

export type GoldMeta = GoldField & {
  tier?: string;
  priority?: string;
  source?: string;
};

const LUNA_IN = 0.10 / 1_000_000;
const LUNA_CACHED = 0.01 / 1_000_000;
const LUNA_OUT = 0.50 / 1_000_000;

export function costUsd(tokens: {input: number; output: number; cached_input: number}): number {
  const uncached = Math.max(0, tokens.input - tokens.cached_input);
  return uncached * LUNA_IN + tokens.cached_input * LUNA_CACHED + tokens.output * LUNA_OUT;
}

export function dig(value: unknown, path: string): unknown {
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

/** Apply the same create/quote field scaffolding prod shows staff. */
export function normalizePublishedProposal(raw: unknown): {proposal_raw: unknown; proposal: unknown} {
  if (raw == null || typeof raw !== 'object') return {proposal_raw: raw, proposal: raw};
  const parsed = proposalDraft.safeParse(raw);
  if (!parsed.success) return {proposal_raw: raw, proposal: raw};
  const proposal = withQuoteStaffFields(withCreateNativeFields(parsed.data));
  return {proposal_raw: raw, proposal};
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

function normalizePerson(value: unknown): string {
  return normalize(value).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Extra guarantee spellings beyond native catalogue meanings. */
const GUARANTEE_ALIASES: Record<string, string[]> = {
  // GTDAGT = Guaranteed By Agent (NOT DEPREQ)
  'guaranteed by agent': ['gtdagt', 'gtdagent', 'guaranteedbyagent'],
  gtdagt: ['guaranteed by agent', 'gtdagent', 'guaranteedbyagent'],
  // DEPREQ = Deposit Requested
  'deposit requested': ['depreq'],
  depreq: ['deposit requested'],
  // GTDCMP = Guaranteed By Company
  'guaranteed by company': ['gtdcmp', 'guaranteedbycompany'],
  gtdcmp: ['guaranteed by company', 'guaranteedbycompany'],
  'guaranteed by deposit': ['gtddep', 'guaranteedbydeposit'],
  gtddep: ['guaranteed by deposit', 'guaranteedbydeposit'],
  '6pm hold': ['6pm', 'hold', 'non-guaranteed', 'nonguaranteed', 'ngi'],
  ngi: ['6pm hold', '6pm', 'hold', 'non-guaranteed', 'nonguaranteed'],
};

/** Board/meal code ↔ meaning from centurion-rate-catalogue (+ common BB/RO forms). */
const BOARD_MEAL_PAIRS: Array<[string, string]> = [
  ['BB', 'Bed & Breakfast'],
  ['BB', 'bed_breakfast'],
  ['BB', 'Bed & Breakfast R'],
  ['DBB', 'Dinner, Bed & Breakfast'],
  ['DBB', 'dinner_bed_breakfast'],
  ['RO', 'Room Only'],
  ['RO', 'room_only'],
  ['BARRO', 'BAR Room Only'],
  ['BARRO', 'room_only'],
];

function acronym(value: string): string {
  return value.split(/[^a-z0-9]+/i).filter(Boolean).map(part => part[0] ?? '').join('').toLowerCase();
}

function compactAlnum(value: string): string {
  return value.replace(/[^a-z0-9]+/g, '');
}

/** Normalized token → canonical catalogue code (exact code↔meaning only; no substring). */
let catalogueCanon: Map<string, string> | null = null;

function linkCatalogueTokens(map: Map<string, string>, code: string, meaning: string) {
  const canon = normalize(code);
  if (!canon) return;
  const tokens = [code, meaning]
    .flatMap(v => {
      const n = normalize(v);
      return n ? [n, compactAlnum(n)] : [];
    })
    .filter(Boolean);
  for (const t of tokens) map.set(t, canon);
}

function loadCatalogueCanon(): Map<string, string> {
  if (catalogueCanon) return catalogueCanon;
  const map = new Map<string, string>();
  const catalogPath = join(DATA_ROOT, 'catalog/catalog.json');
  if (existsSync(catalogPath)) {
    try {
      const raw = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
        catalogs?: Record<string, {records?: Array<{code?: unknown; meaning?: unknown; name?: unknown}>}>;
      };
      const sections = [
        'trackSubsegment', 'ratePlans', 'roomTypes', 'guaranteeTypes', 'sourceBusiness',
      ];
      for (const key of sections) {
        for (const row of raw.catalogs?.[key]?.records ?? []) {
          const code = row.code != null ? String(row.code) : '';
          const meaning = row.meaning != null ? String(row.meaning) : (row.name != null ? String(row.name) : '');
          if (code) linkCatalogueTokens(map, code, meaning || code);
        }
      }
      // Rate-plan meal readbacks (board/meal strings observed with a rate).
      for (const row of raw.catalogs?.ratePlans?.records ?? []) {
        const code = row.code != null ? String(row.code) : '';
        const evidence = (row as {rateMealReadbackEvidence?: {mealPlan?: unknown}}).rateMealReadbackEvidence;
        if (code && evidence?.mealPlan != null) linkCatalogueTokens(map, code, String(evidence.mealPlan));
        for (const obs of (row as {mealPlanObservations?: Array<{mealPlan?: unknown}>}).mealPlanObservations ?? []) {
          if (code && obs.mealPlan != null) linkCatalogueTokens(map, code, String(obs.mealPlan));
        }
      }
    } catch {
      // Catalogue optional for unit smokes without bench data.
    }
  }
  // Centurion static rate/board meanings (apps/server-pilot/.../centurion-rate-catalogue.ts).
  const centurionPath = join(
    process.cwd().endsWith('nava-agent') ? join(process.cwd(), '../server-pilot') : join(process.cwd(), 'apps/server-pilot'),
    'src/hms/centurion-rate-catalogue.ts',
  );
  if (existsSync(centurionPath)) {
    try {
      const text = readFileSync(centurionPath, 'utf8');
      const block = text.match(/export const CENTURION_RATE_CATALOGUE = \{([\s\S]*?)\} as const/);
      if (block) {
        for (const m of block[1]!.matchAll(/^\s*([A-Z0-9]+):\s*\{\s*name:\s*'([^']*)',\s*mealPlan:\s*'([^']*)'/gm)) {
          linkCatalogueTokens(map, m[1]!, m[2]!);
          if (m[3] && m[3] !== 'unknown') linkCatalogueTokens(map, m[1]!, m[3]!);
        }
      }
    } catch {
      // ignore
    }
  }
  for (const [code, meaning] of BOARD_MEAL_PAIRS) linkCatalogueTokens(map, code, meaning);
  for (const [canon, alts] of Object.entries(GUARANTEE_ALIASES)) {
    for (const alt of alts) linkCatalogueTokens(map, canon, alt);
  }
  catalogueCanon = map;
  return map;
}

function catalogueCanonOf(token: string): string | null {
  const map = loadCatalogueCanon();
  const n = normalize(token);
  if (!n) return null;
  return map.get(n) ?? map.get(compactAlnum(n)) ?? null;
}

function valueTokens(value: unknown): string[] {
  if (value == null || value === '') return [];
  if (typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    const out: string[] = [];
    for (const key of ['code', 'name', 'value', 'meaning', 'nativeId', 'native_id']) {
      if (row[key] != null && row[key] !== '') out.push(String(row[key]));
    }
    return out.length ? out : [normalize(value)].filter(Boolean);
  }
  return [String(value)];
}

/** Exact catalogue code↔meaning (either direction). No substring. */
function catalogueEquivMatch(expected: unknown, actual: unknown): boolean {
  if (isBlank(actual)) return false;
  const expTokens = valueTokens(expected);
  const actTokens = valueTokens(actual);
  for (const e of expTokens) {
    for (const a of actTokens) {
      const ne = normalize(e);
      const na = normalize(a);
      if (!ne || !na) continue;
      if (ne === na || compactAlnum(ne) === compactAlnum(na)) return true;
      const ce = catalogueCanonOf(e);
      const ca = catalogueCanonOf(a);
      if (ce && ca && ce === ca) return true;
      if (ce && (ce === na || ce === compactAlnum(na))) return true;
      if (ca && (ca === ne || ca === compactAlnum(ne))) return true;
    }
  }
  return false;
}

function isCatalogueFieldPath(path: string): boolean {
  return /(^|\/)(track|rate_plan|room_type|board|meal_plan|meal|guarantee_type|guarantee|source_of_business)(\/|$)/.test(
    path.replace(/\/fields\//g, '/'),
  ) || /\/(track|rate_plan|room_type|board|meal_plan|guarantee_type|source_of_business)$/.test(path);
}

function isBlank(value: unknown): boolean {
  return value == null || value === '';
}

function isNumericEqual(a: string, b: string): boolean | null {
  if (!/^-?\d+(\.\d+)?$/.test(a) || !/^-?\d+(\.\d+)?$/.test(b)) return null;
  return Number(a) === Number(b);
}

/**
 * Agency/org: exact code or exact normalised full name; acronym match allowed on names only.
 * tokenOverlap ("Nexus Travel" ↔ "XL Nexus") is a false hit — do not use here.
 */
function partyExactMatch(expected: unknown, actual: unknown): boolean {
  if (isBlank(actual)) return false;
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
      if (actualNorm === needle || actualCompact === compactAlnum(needle)) return true;
      // Acronym only for organization/agency names (MISA ↔ Municipal Infrastructure Support Agent).
      if (acronym(actualNorm) === needle || acronym(needle) === actualNorm) return true;
      if (acronym(actualNorm) === compactAlnum(needle) || acronym(needle) === actualCompact) return true;
    }
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
  if (a === actualNorm || compactAlnum(a) === actualCompact) return true;
  if (acronym(actualNorm) === a || acronym(a) === actualNorm) return true;
  return false;
}

function personEqual(expected: unknown, actual: unknown): boolean {
  if (isBlank(actual)) return false;
  const a = normalizePerson(expected);
  const b = normalizePerson(actual);
  if (!a || !b) return false;
  return a === b || compactAlnum(a) === compactAlnum(b);
}

/** Exact-ish: case/whitespace/punct, ISO dates, numeric equality, guarantee aliases. No substrings. */
function equalish(expected: unknown, actual: unknown): boolean {
  // Count fields: null/'' gold or actual ↔ 0 (measurement; not agent tuning).
  if (expected == null || expected === '') {
    if (actual == null || actual === '' || actual === 0 || actual === '0') return true;
  }
  if ((expected === 0 || expected === '0') && (actual == null || actual === '' || actual === 0 || actual === '0')) {
    return true;
  }
  if (isBlank(actual)) return false;
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const row = expected as Record<string, unknown>;
    const actualNorm = normalize(actual);
    if (!actualNorm) return false;
    const aliases = Array.isArray(row.aliases) ? row.aliases : [];
    for (const part of [row.code, row.name, row.value, row.first_name, row.last_name, row.nativeId, row.native_id, ...aliases]) {
      if (part == null || part === '') continue;
      const needle = normalize(part);
      if (!needle) continue;
      if (actualNorm === needle || compactAlnum(actualNorm) === compactAlnum(needle)) return true;
      const num = isNumericEqual(needle, actualNorm);
      if (num != null) {
        if (num) return true;
        continue;
      }
    }
    return false;
  }
  const a = normalize(expected);
  const b = normalize(actual);
  if (!a || !b) return false;
  const da = normalizeDate(expected);
  const db = normalizeDate(actual);
  if (da && db && /^\d{4}-\d{2}-\d{2}$/.test(da) && da === db) return true;
  const num = isNumericEqual(a, b);
  if (num != null) return num;
  // Guarantee name ↔ code
  for (const [canon, alts] of Object.entries(GUARANTEE_ALIASES)) {
    const bucket = new Set([compactAlnum(canon), ...alts.map(x => compactAlnum(x))]);
    if (bucket.has(compactAlnum(a)) && bucket.has(compactAlnum(b))) return true;
  }
  return a === b || compactAlnum(a) === compactAlnum(b);
}

/** Org/agency exact; reservation_id / confirmation_number against a concrete actual value. */
function partyHit(expected: unknown, proposal: unknown, path: string, actualOverride?: unknown): boolean {
  const actual = actualOverride !== undefined ? actualOverride : dig(proposal, path);
  if (path.endsWith('organization_name') || path.endsWith('agency_name')) {
    if (partyExactMatch(expected, actual)) return true;
    if (path.endsWith('organization_name')) {
      const idPath = path.replace(/organization_name$/, 'organization_id');
      if (partyExactMatch(expected, dig(proposal, idPath))) return true;
    }
    if (path.endsWith('agency_name')) {
      const idPath = path.replace(/agency_name$/, 'agency_id');
      if (partyExactMatch(expected, dig(proposal, idPath))) return true;
    }
    return false;
  }
  if (path.endsWith('reservation_id') || path.endsWith('confirmation_number')) {
    const a = normalize(expected);
    const b = normalize(actual);
    if (!a || !b) return false;
    if (a === b || compactAlnum(a) === compactAlnum(b)) return true;
    // Same-field confirmation suffix (516441-1 ↔ 516441).
    if (a.split('-')[0] === b.split('-')[0]) return true;
    return false;
  }
  return equalish(expected, actual);
}

function bookingFields(booking: unknown): Record<string, unknown> {
  const row = booking && typeof booking === 'object' ? booking as Record<string, unknown> : {};
  return row.fields && typeof row.fields === 'object' ? row.fields as Record<string, unknown> : {};
}

function normalizeStayId(value: unknown): string {
  const n = normalize(value);
  if (!n) return '';
  return n.split('-')[0] ?? n;
}

function idsEqual(a: unknown, b: unknown): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb || compactAlnum(na) === compactAlnum(nb)) return true;
  return normalizeStayId(na) === normalizeStayId(nb);
}

function proposalStayIds(proposal: unknown): string[] {
  const bookings = dig(proposal, '/bookings');
  if (!Array.isArray(bookings)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const booking of bookings) {
    const row = booking && typeof booking === 'object' ? booking as Record<string, unknown> : {};
    const fields = bookingFields(booking);
    for (const cand of [row.reservation_id, fields.confirmation_number, fields.reservation_id]) {
      const key = normalizeStayId(cand);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function goldStayIds(card: CaseCard): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const gold of card.gold ?? []) {
    if (gold.expectation !== 'expected') continue;
    if (!gold.path.endsWith('reservation_id') && !gold.path.endsWith('confirmation_number')) continue;
    const key = normalizeStayId((gold as GoldMeta).value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

type CreateAlign = {
  /** gold booking index → proposal booking index */
  map: Map<number, number>;
  /** proposal bookings with no gold partner */
  spray: boolean;
};

function collectCreateGoldHints(card: CaseCard): Map<number, {
  index: number;
  first_name?: unknown;
  last_name?: unknown;
  arrival_date?: unknown;
}> {
  const hints = new Map<number, {index: number; first_name?: unknown; last_name?: unknown; arrival_date?: unknown}>();
  for (const gold of (card.gold ?? []) as GoldMeta[]) {
    const m = /^\/bookings\/(\d+)(?:\/|$)/.exec(gold.path);
    if (!m) continue;
    const index = Number(m[1]);
    const row = hints.get(index) ?? {index};
    if (gold.expectation === 'expected') {
      if (gold.path.endsWith('/first_name') || gold.path.endsWith('fields/first_name')) row.first_name = gold.value;
      if (gold.path.endsWith('/last_name') || gold.path.endsWith('fields/last_name')) row.last_name = gold.value;
      if (gold.path.endsWith('/arrival_date') || gold.path.endsWith('fields/arrival_date')) row.arrival_date = gold.value;
    }
    hints.set(index, row);
  }
  return hints;
}

/** One-to-one CREATE alignment: last+first name, then arrival. Extras → spray. */
function alignCreateBookings(card: CaseCard, proposal: unknown): CreateAlign {
  const bookings = dig(proposal, '/bookings');
  const hints = [...collectCreateGoldHints(card).values()];
  const map = new Map<number, number>();
  if (!Array.isArray(bookings) || !bookings.length) {
    return {map, spray: false};
  }
  if (!hints.length) {
    // No gold booking paths — any proposal bookings are extras only if gold expected zero.
    return {map, spray: false};
  }
  type Cand = {gi: number; pi: number; score: number};
  const cands: Cand[] = [];
  for (const hint of hints) {
    for (let pi = 0; pi < bookings.length; pi++) {
      const fields = bookingFields(bookings[pi]);
      let score = 0;
      const hasName = hint.first_name != null || hint.last_name != null;
      if (hasName) {
        const firstOk = hint.first_name == null || personEqual(hint.first_name, fields.first_name);
        const lastOk = hint.last_name == null || personEqual(hint.last_name, fields.last_name);
        if (hint.first_name != null && hint.last_name != null) {
          if (firstOk && lastOk) score += 100;
        } else if (lastOk && hint.last_name != null) score += 60;
        else if (firstOk && hint.first_name != null) score += 50;
      }
      if (hint.arrival_date != null) {
        const arrival = fields.arrival_date;
        if (equalish(hint.arrival_date, arrival)) score += 10;
      }
      if (score > 0) cands.push({gi: hint.index, pi, score});
    }
  }
  cands.sort((a, b) => b.score - a.score || a.gi - b.gi || a.pi - b.pi);
  const usedG = new Set<number>();
  const usedP = new Set<number>();
  for (const c of cands) {
    if (usedG.has(c.gi) || usedP.has(c.pi)) continue;
    usedG.add(c.gi);
    usedP.add(c.pi);
    map.set(c.gi, c.pi);
  }
  // Index fallback for gold bookings with no name/arrival signal.
  for (const hint of hints) {
    if (map.has(hint.index)) continue;
    if (
      hint.first_name == null && hint.last_name == null && hint.arrival_date == null
      && hint.index < bookings.length && !usedP.has(hint.index)
    ) {
      map.set(hint.index, hint.index);
      usedP.add(hint.index);
    }
  }
  const spray = bookings.length > map.size;
  return {map, spray};
}

function remapCreatePath(path: string, align: Map<number, number>): string | null {
  const m = /^\/bookings\/(\d+)(\/.*)?$/.exec(path);
  if (!m) return path;
  const gi = Number(m[1]);
  if (!align.has(gi)) return null;
  return `/bookings/${align.get(gi)}${m[2] ?? ''}`;
}

function selectedPdfRows(card: CaseCard): unknown[] {
  const selected = card.selected_email as Record<string, unknown> | undefined;
  return Array.isArray(selected?.pdf_attachments_text) ? selected.pdf_attachments_text : [];
}

/** pdf-N → real id when present; else keep pdf-N and accept filename/sha256. */
function resolveAttachmentGold(gold: GoldMeta, card: CaseCard): {
  expectation: GoldField['expectation']; value: unknown; basis: string; alts?: string[];
} {
  const exp = String(gold.value ?? '');
  const m = /^pdf-(\d+)$/i.exec(exp);
  if (!m) return {expectation: 'expected', value: gold.value, basis: gold.basis};
  const pdfs = selectedPdfRows(card);
  const idx = Number(m[1]);
  if (idx < 0 || idx >= pdfs.length || pdfs[idx] == null) {
    return {expectation: 'no_gold', value: gold.value, basis: 'no_pdf_in_input'};
  }
  const row = pdfs[idx] as Record<string, unknown>;
  const id = row.attachment_id ?? row.id;
  const alts = [exp, id, row.filename, row.sha256].filter(v => v != null && v !== '').map(String);
  return {expectation: 'expected', value: id != null && id !== '' ? String(id) : exp, basis: gold.basis, alts};
}

/** CREATE: missing quantity → same-room_type booking count (else all bookings). */
function createQuantityActual(proposal: unknown, digPath: string, actual: unknown): unknown {
  if (actual != null && actual !== '' || !/\/bookings\/\d+\/fields\/quantity$/.test(digPath)) return actual;
  const m = /^\/bookings\/(\d+)\//.exec(digPath);
  const bookings = dig(proposal, '/bookings');
  if (!m || !Array.isArray(bookings) || !bookings[Number(m[1])]) return actual;
  const roomType = bookingFields(bookings[Number(m[1])]).room_type;
  if (roomType == null || roomType === '') return bookings.length;
  return bookings.filter(b => catalogueEquivMatch(roomType, bookingFields(b).room_type) || equalish(roomType, bookingFields(b).room_type)).length;
}

const workflowTools: Record<Workflow, string[]> = {
  create: ['mail_read_thread', 'skill_read', 'hms_search_parties', 'hms_read_catalogue', 'hms_quote', 'hms_prepare', 'proposal_publish'],
  amend: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'hms_prepare', 'proposal_publish'],
  cancel: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'hms_prepare', 'proposal_publish'],
  filing: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'hms_prepare', 'proposal_publish'],
  quote: ['mail_read_thread', 'skill_read', 'hms_read_catalogue', 'hms_quote', 'proposal_publish'],
  triage: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'proposal_publish'],
};

export function goldTier(gold: GoldMeta): string {
  if (gold.tier) return gold.tier;
  if (gold.path.includes('cms_') || gold.path.includes('guarantee') || gold.path.includes('source_of') || gold.path.includes('/track') || gold.path.includes('billing_')) {
    return 'tier2_defaults';
  }
  return 'tier1_core';
}

function goldPriority(gold: GoldMeta): string {
  const p = gold.priority;
  if (p === 'P0' || p === 'P1' || p === 'P2') return p;
  return 'unknown';
}

function goldSource(gold: GoldMeta): string {
  const s = gold.source;
  if (s === 'hms_truth' || s === 'email_explicit' || s === 'heuristic') return s;
  return 'unknown';
}

export function scoreCase(input: {
  card: CaseCard;
  proposal: unknown;
  toolCalls: Array<{name: string; input?: unknown; result?: {ok?: boolean; data?: unknown; error?: {code?: string} | null}}>;
  tokens: {input: number; output: number; cached_input: number};
  wall_ms: number;
  /** When false, `proposal` is already normalized and raw is in proposal_raw. Default true. */
  normalize?: boolean;
  proposal_raw?: unknown;
}): CaseScore {
  const {card, toolCalls, tokens, wall_ms} = input;
  const normalized = input.normalize === false
    ? {proposal_raw: input.proposal_raw ?? input.proposal, proposal: input.proposal}
    : normalizePublishedProposal(input.proposal);
  const proposal = normalized.proposal;
  const proposal_raw = normalized.proposal_raw;
  const fields: FieldScore[] = [];
  const workflow = card.workflow;
  const createAlign = workflow === 'create' ? alignCreateBookings(card, proposal) : null;
  const stayGoldIds = goldStayIds(card);
  const stayPropIds = proposalStayIds(proposal);
  const stayIdSpray = (workflow === 'amend' || workflow === 'cancel' || workflow === 'filing')
    && stayGoldIds.length > 0
    && stayPropIds.length > stayGoldIds.length;
  const pdfCount = selectedPdfRows(card).length;

  for (const gold of (card.gold ?? []) as GoldMeta[]) {
    // Refuse /hms/* gold — proposal_publish has no such key (structural bug guard).
    if (gold.path.startsWith('/hms/')) {
      fields.push({
        path: gold.path,
        expectation: gold.expectation,
        result: 'skipped',
        basis: 'REFUSE_HMS_GOLD_PATH',
        tier: goldTier(gold),
        priority: goldPriority(gold),
        source: goldSource(gold),
      });
      continue;
    }
    const tier = goldTier(gold);
    const priority = goldPriority(gold);
    const source = goldSource(gold);

    // CREATE: score gold booking fields against the aligned proposal booking.
    let digPath: string | null = gold.path;
    if (createAlign && /^\/bookings\/\d+/.test(gold.path)) {
      digPath = remapCreatePath(gold.path, createAlign.map);
    }

    if (gold.expectation === 'not_expected') {
      const actual = digPath == null ? undefined : dig(proposal, digPath);
      if (!isBlank(actual)) {
        fields.push({
          path: gold.path,
          expectation: 'not_expected',
          result: 'spurious',
          expected: undefined,
          actual,
          basis: gold.basis,
          tier,
          priority,
          source,
        });
      } else {
        fields.push({
          path: gold.path,
          expectation: 'not_expected',
          result: 'not_expected',
          basis: gold.basis,
          tier,
          priority,
          source,
        });
      }
      continue;
    }
    if (gold.expectation === 'no_gold') {
      fields.push({
        path: gold.path,
        expectation: 'no_gold',
        result: 'no_gold',
        basis: gold.basis,
        tier,
        priority,
        source,
      });
      continue;
    }

    // Filing with zero PDFs: type + attachment_id unknowable → no_gold.
    if (
      workflow === 'filing' && pdfCount === 0
      && (gold.path === '/actions/0/type' || gold.path === '/actions/0/details/attachment_id')
    ) {
      fields.push({
        path: gold.path,
        expectation: 'no_gold',
        result: 'no_gold',
        expected: gold.value,
        actual: digPath == null ? undefined : dig(proposal, digPath),
        basis: 'no_pdf_in_input',
        tier,
        priority,
        source,
      });
      continue;
    }

    let expectedValue = gold.value;
    let expectation: GoldField['expectation'] = 'expected';
    let basis = gold.basis;
    let attachmentAlts: string[] | undefined;
    if (gold.path.endsWith('attachment_id')) {
      const resolved = resolveAttachmentGold(gold, card);
      expectation = resolved.expectation;
      expectedValue = resolved.value;
      basis = resolved.basis;
      attachmentAlts = resolved.alts;
      if (expectation === 'no_gold') {
        fields.push({
          path: gold.path,
          expectation: 'no_gold',
          result: 'no_gold',
          expected: gold.value,
          actual: digPath == null ? undefined : dig(proposal, digPath),
          basis,
          tier,
          priority,
          source,
        });
        continue;
      }
    }

    let actual = digPath == null ? undefined : dig(proposal, digPath);
    if (workflow === 'create' && digPath) actual = createQuantityActual(proposal, digPath, actual);
    const idPath = gold.path.endsWith('reservation_id') || gold.path.endsWith('confirmation_number');
    const partyPath = /organization_name$|agency_name$/.test(gold.path) || idPath;
    const guestPath = /\/fields\/(first_name|last_name)$/.test(gold.path);
    let hit = false;
    if (attachmentAlts) {
      hit = attachmentAlts.some(alt => equalish(alt, actual));
    } else if (idPath && (workflow === 'amend' || workflow === 'cancel' || workflow === 'filing')) {
      // Hit iff gold id ∈ proposal stay ids AND proposal does not list more ids than gold.
      const inSet = stayPropIds.some(id => idsEqual(id, expectedValue));
      hit = inSet && stayPropIds.length <= stayGoldIds.length;
    } else if (partyPath) {
      hit = partyHit(expectedValue, proposal, digPath ?? gold.path, actual);
    } else if (guestPath) {
      hit = personEqual(expectedValue, actual);
    } else if (isCatalogueFieldPath(gold.path)) {
      hit = catalogueEquivMatch(expectedValue, actual) || equalish(expectedValue, actual);
    } else {
      hit = equalish(expectedValue, actual);
    }
    fields.push({
      path: gold.path,
      expectation: 'expected',
      result: hit ? 'hit' : 'miss',
      expected: expectedValue,
      actual,
      basis,
      tier,
      priority,
      source,
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
    priority: 'P0',
    source: 'unknown',
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

  const spray = Boolean(createAlign?.spray || stayIdSpray);

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
    proposal_raw,
    spray,
  };
}

export type TierBucket = {
  hit: number;
  miss: number;
  not_expected: number;
  no_gold: number;
  spurious: number;
  field_accuracy: number | null;
  by_path: Record<string, {hit: number; miss: number}>;
  spurious_by_path: Record<string, number>;
};

export type WeightedBucket = {
  hit: number;
  miss: number;
  field_accuracy: number | null;
};

export type RulerStamp = {
  scorer_sha: string;
  gold_file: string | null;
  gold_sha256: string | null;
};

export type Scoreboard = {
  ruler?: RulerStamp;
  n: number;
  by_workflow: Record<string, {
    n: number;
    hit: number;
    miss: number;
    not_expected: number;
    no_gold: number;
    spray: number;
    spurious: number;
    field_accuracy: number | null;
    p50_ms: number | null;
    p95_ms: number | null;
    cost_usd: number;
    tier1_core: TierBucket;
    tier2_defaults: TierBucket;
    history_knowable: TierBucket;
    workflow_routing: TierBucket;
    parity: TierBucket;
  }>;
  by_priority: Record<string, WeightedBucket>;
  by_source: Record<string, WeightedBucket>;
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
    spray: number;
    spurious: number;
  };
  cases: CaseScore[];
};

function emptyTier(): TierBucket {
  return {
    hit: 0, miss: 0, not_expected: 0, no_gold: 0, spurious: 0,
    field_accuracy: null, by_path: {}, spurious_by_path: {},
  };
}

function emptyWeighted(): WeightedBucket {
  return {hit: 0, miss: 0, field_accuracy: null};
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
  else if (field.result === 'spurious') {
    bucket.spurious += 1;
    bucket.spurious_by_path[field.path] = (bucket.spurious_by_path[field.path] ?? 0) + 1;
  }
}

function pickTier(bucket: Scoreboard['by_workflow'][string], tier: string | undefined): TierBucket {
  if (tier === 'tier2_defaults') return bucket.tier2_defaults;
  if (tier === 'history_knowable') return bucket.history_knowable;
  if (tier === 'workflow_routing') return bucket.workflow_routing;
  if (tier === 'parity') return bucket.parity;
  return bucket.tier1_core;
}

function bumpWeighted(map: Record<string, WeightedBucket>, key: string, field: FieldScore) {
  if (field.result !== 'hit' && field.result !== 'miss') return;
  // Routing tracked separately; still include in priority/source when tagged.
  const row = map[key] ??= emptyWeighted();
  if (field.result === 'hit') row.hit += 1;
  else row.miss += 1;
}

export function buildScoreboard(cases: CaseScore[]): Scoreboard {
  const by_workflow: Scoreboard['by_workflow'] = {};
  const by_priority: Record<string, WeightedBucket> = {
    P0: emptyWeighted(), P1: emptyWeighted(), P2: emptyWeighted(), unknown: emptyWeighted(),
  };
  const by_source: Record<string, WeightedBucket> = {
    hms_truth: emptyWeighted(), email_explicit: emptyWeighted(), heuristic: emptyWeighted(), unknown: emptyWeighted(),
  };
  let hit = 0, miss = 0, cost = 0, wall = 0, twin = 0, routeHit = 0, routeMiss = 0, errors = 0, spray = 0, spurious = 0;
  for (const row of cases) {
    const bucket = by_workflow[row.workflow] ??= {
      n: 0, hit: 0, miss: 0, not_expected: 0, no_gold: 0, spray: 0, spurious: 0, field_accuracy: null,
      p50_ms: null, p95_ms: null, cost_usd: 0,
      tier1_core: emptyTier(), tier2_defaults: emptyTier(),
      history_knowable: emptyTier(), workflow_routing: emptyTier(), parity: emptyTier(),
    };
    bucket.n += 1;
    bucket.cost_usd += row.cost_usd;
    cost += row.cost_usd;
    wall = Math.max(wall, row.wall_ms);
    twin += row.twin_uncovered.length ? 1 : 0;
    if (row.run_error) errors += 1;
    if (row.spray) {
      bucket.spray += 1;
      spray += 1;
    }
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
      else if (field.result === 'spurious') {
        bucket.spurious += 1;
        spurious += 1;
      }
      bumpTier(pickTier(bucket, field.tier), field);
      bumpWeighted(by_priority, field.priority ?? 'unknown', field);
      bumpWeighted(by_source, field.source ?? 'unknown', field);
    }
  }
  for (const [wf, bucket] of Object.entries(by_workflow)) {
    const denom = bucket.hit + bucket.miss;
    bucket.field_accuracy = denom ? bucket.hit / denom : null;
    for (const tier of [bucket.tier1_core, bucket.tier2_defaults, bucket.history_knowable, bucket.workflow_routing, bucket.parity]) {
      const d = tier.hit + tier.miss;
      tier.field_accuracy = d ? tier.hit / d : null;
    }
    const walls = cases.filter(c => c.workflow === wf).map(c => c.wall_ms);
    bucket.p50_ms = percentile(walls, 0.5);
    bucket.p95_ms = percentile(walls, 0.95);
  }
  for (const row of Object.values(by_priority)) {
    const d = row.hit + row.miss;
    row.field_accuracy = d ? row.hit / d : null;
  }
  for (const row of Object.values(by_source)) {
    const d = row.hit + row.miss;
    row.field_accuracy = d ? row.hit / d : null;
  }
  const routeDenom = routeHit + routeMiss;
  return {
    n: cases.length,
    by_workflow,
    by_priority,
    by_source,
    totals: {
      hit, miss, cost_usd: cost, wall_ms: wall, twin_no_price: twin,
      workflow_routing_hit: routeHit,
      workflow_routing_miss: routeMiss,
      workflow_routing_accuracy: routeDenom ? routeHit / routeDenom : null,
      errors,
      spray,
      spurious,
    },
    cases,
  };
}

export function scorerSha(cwd = process.cwd()): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {cwd, encoding: 'utf8'}).trim();
  } catch {
    return 'unknown';
  }
}

export async function goldSha256(goldFile: string | null | undefined): Promise<string | null> {
  if (!goldFile) return null;
  try {
    const buf = await readFile(goldFile);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

export async function attachRuler(
  board: Scoreboard,
  opts: {goldFile?: string | null; scorerSha?: string; cwd?: string} = {},
): Promise<Scoreboard> {
  const gold_file = opts.goldFile ?? null;
  board.ruler = {
    scorer_sha: opts.scorerSha ?? scorerSha(opts.cwd),
    gold_file,
    gold_sha256: await goldSha256(gold_file),
  };
  return board;
}
