import {execFileSync} from 'node:child_process';
import {proposalDraft} from '../../src/schema.js';
import {sameQuoteCriteria, stagePublishedDraft} from '../../src/tool-registry.js';
import {selectedCutoff} from '../twin/world.js';
import type {CaseCard, GoldField, Workflow} from '../types.js';

export type FieldScore = {
  path: string;
  expectation: GoldField['expectation'];
  result: 'hit' | 'miss' | 'not_expected' | 'no_gold' | 'skipped' | 'spurious';
  expected?: unknown;
  actual?: unknown;
  basis?: string;
  knowable?: boolean;
  tier?: string;
  priority?: string;
  source?: string;
};

export type ToolQuality = {
  calls: Array<{
    name: string;
    ok: boolean;
    error?: string;
    input?: string;
    hits?: number;
    top?: Array<{displayName?: unknown; name?: unknown; id?: unknown}>;
  }>;
  right_tool: number;
  wasted_calls: number;
  key_arg_hits: number;
  key_arg_misses: number;
};

type ScoringToolCall = {
  name: string;
  input?: unknown;
  result?: {ok?: boolean; data?: unknown; error?: {code?: string} | null};
};

export type CaseScore = {
  case_id: string;
  workflow: Workflow;
  fields: FieldScore[];
  tool_quality: ToolQuality;
  /** Only confirmed stay IDs from HMS responses, never the rest of the guest record. */
  tool_calls?: ScoringToolCall[];
  tokens: {input: number; output: number; cached_input: number};
  cost_usd: number | null;
  wall_ms: number;
  twin_uncovered: string[];
  /** Proposal after prod field normalization (what staff see). */
  proposal: unknown;
  /** Raw proposal_publish input before normalization. */
  proposal_raw?: unknown;
  /** Set when stagePublishedDraft rejected the draft (path) or parse failed. */
  publish_invalid?: string | true;
  /** True when proposal listed more bookings than gold paths expect. */
  spray?: boolean;
  /** Set when the case threw before a proposal; all expected fields scored miss. */
  run_error?: string;
  /** Attempts used (incl. retries on Azure 429/5xx/timeout). */
  attempts?: number;
  roi_score: number;
  route_ok: boolean;
  disposition_ok: boolean;
  safety_flags: SafetyFlags;
  spurious_action_count: number;
  quote_capture_ok: boolean;
  expected_units: number;
  actual_units: number;
  failure_reason: string | null;
};

export type GoldMeta = GoldField & {
  tier?: string;
  priority?: string;
  source?: string;
};

export function costUsd(tokens: CaseScore['tokens'], model = 'gpt-6-luna'): number | null {
  // Live Azure invoices can differ. Supply the deployed model's input/cached/output USD per million.
  const configured = process.env.NAVA_BENCH_USD_PER_MTOK?.split(',').map(value => value.trim() ? Number(value) : NaN);
  const rates = configured ?? (model === 'gpt-6-luna' ? [0.10, 0.01, 0.50] : []);
  if (rates.length !== 3 || rates.some(value => !Number.isFinite(value) || value < 0)) return null;
  const [input, cached, output] = rates;
  return (Math.max(0, tokens.input - tokens.cached_input) * input + tokens.cached_input * cached + tokens.output * output) / 1_000_000;
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

/** Apply the same create/quote publish staging prod shows staff (empty partyReads = no bind). */
export function normalizePublishedProposal(
  raw: unknown,
  partyReads: Array<{input: unknown; response: unknown}> = [],
): {proposal_raw: unknown; proposal: unknown; publish_invalid?: string | true} {
  if (raw == null || typeof raw !== 'object') return {proposal_raw: raw, proposal: raw};
  const parsed = proposalDraft.safeParse(raw);
  if (!parsed.success) return {proposal_raw: raw, proposal: raw, publish_invalid: true};
  const staged = stagePublishedDraft(parsed.data, partyReads);
  if (staged.kind === 'invalid') return {proposal_raw: raw, proposal: raw, publish_invalid: staged.path};
  return {proposal_raw: raw, proposal: staged.draft};
}

/** Quote rows with the same spec are one HMS request: `single:1 + single:1` == `single:2`. */
function mergeQuoteRooms(proposal: unknown): unknown {
  const actions = dig(proposal, '/actions');
  if (!Array.isArray(actions) || !actions.some(a => Array.isArray(dig(a, '/details/groups')))) return proposal;
  const merge = (rooms: unknown[]) => {
    const out = new Map<string, Record<string, unknown>>();
    for (const room of rooms) {
      const row = room && typeof room === 'object' ? {...room as Record<string, unknown>} : {};
      const {quantity, ...spec} = row;
      const key = JSON.stringify(spec);
      const prev = out.get(key);
      const n = Number(quantity ?? 1);
      if (prev) prev.quantity = Number(prev.quantity ?? 1) + (Number.isFinite(n) ? n : 1);
      else out.set(key, row);
    }
    return [...out.values()];
  };
  return {...proposal as Record<string, unknown>, actions: actions.map(action => {
    const groups = dig(action, '/details/groups');
    if (!Array.isArray(groups)) return action;
    return {...action, details: {...dig(action, '/details') as Record<string, unknown>,
      groups: groups.map(g => Array.isArray(dig(g, '/rooms')) ? {...g as Record<string, unknown>, rooms: merge(dig(g, '/rooms') as unknown[])} : g)}};
  })};
}

/** Staff-did HMS code gold: `{code, alt_codes?}` — hit only on a native code, never prose. */
function codeGoldHit(expected: unknown, actual: unknown): boolean | null {
  const code = dig(expected, '/code');
  if (typeof code !== 'string' || dig(expected, '/source') !== 'hms_anchor') return null;
  const got = String(nativeCode(actual) ?? actual ?? '').trim().toUpperCase();
  return [code, ...array(dig(expected, '/alt_codes'))].some(value => String(value).toUpperCase() === got);
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
  return normalize(value).replace(/^(?:(?:mr|mrs|ms|miss|mx|dr|prof|sir|dame)\.?\s+)+/, '').trim();
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

/** HRCEN rate_plan → board. Mirrors build_gold_v5.rate_plan_to_board. */
export function ratePlanToBoard(ratePlan: unknown): 'DBB' | 'BB' | 'RO' | null {
  let code: unknown = ratePlan;
  if (ratePlan && typeof ratePlan === 'object' && !Array.isArray(ratePlan)) {
    const row = ratePlan as Record<string, unknown>;
    code = row.code ?? row.rate_plan ?? row.rateplan;
  }
  if (code == null || code === '') return null;
  const c = String(code).trim().toUpperCase();
  if (c === 'HSE' || c === 'BARB2B') return null;
  if (/DBB?$/i.test(c)) return 'DBB';
  if (/RO$/i.test(c) || c === 'DAY') return 'RO';
  if (c === 'BAR' || c === 'EDU' || /^BDIRB[1-5]$/i.test(c)) return 'BB';
  if (/B$/i.test(c) && !/DB$/i.test(c)) return 'BB';
  return null;
}

function compactAlnum(value: string): string {
  return value.replace(/[^a-z0-9]/g, '');
}

function isBlank(value: unknown): boolean {
  return value == null || value === '';
}

function isNumericEqual(a: string, b: string): boolean | null {
  if (!/^-?\d+(\.\d+)?$/.test(a) || !/^-?\d+(\.\d+)?$/.test(b)) return null;
  return Number(a) === Number(b);
}

function strictMatch(expected: unknown, actual: unknown): boolean {
  const key = (value: unknown) => typeof value === 'string' || typeof value === 'number'
    ? String(value) : '';
  if (expected == null || actual == null) return expected === actual;
  const expectedKeys = typeof expected === 'object' ? ['code', 'nativeId', 'native_id', 'name', 'value'] : [];
  const actualKeys = typeof actual === 'object' ? ['code', 'nativeId', 'native_id', 'name', 'value'] : [];
  const candidates = (value: unknown, keys: string[]) => (keys.length ? keys.map(k => dig(value, `/${k}`)) : [value]).map(key).filter(Boolean);
  const code = (value: unknown) => key(dig(value, '/code') ?? dig(value, '/nativeId') ?? dig(value, '/native_id'));
  if (code(expected) && code(actual)) return code(expected) === code(actual);
  const wanted = candidates(expected, expectedKeys);
  return candidates(actual, actualKeys).some(value => wanted.includes(value));
}

const nativeCode = (value: unknown) => dig(value, '/code') ?? dig(value, '/nativeId') ?? dig(value, '/native_id');
const label = (value: unknown) => normalize(nativeCode(value) ?? dig(value, '/name') ?? dig(value, '/value') ?? value);

function roomMatch(expected: unknown, actual: unknown): boolean {
  if (strictMatch(expected, actual)) return true;
  const want = label(expected);
  const got = label(actual);
  if (want === got) return want !== '';
  const family = (room: string) => {
    if (/^(?:stqn|sttw|standard(?: (?:single|double|queen|twin|twin \/ queen))?(?: rooms?)?|(?:single|double|twin)(?: rooms?)?)$/.test(room)) return 'standard';
    if (/^(?:exec|executive(?: rooms?)?)$/.test(room)) return 'executive';
    if (/^(?:suit|suite(?: rooms?)?)$/.test(room)) return 'suite';
  };
  // A stated native code is exact; a room-use preference can match its available family.
  if (nativeCode(expected) != null || /^(?:stqn|sttw|exec|suit)$/.test(want) && /^(?:stqn|sttw|exec|suit)$/.test(got)) return false;
  if (/^(?:standard )?twin(?: rooms?)?$/.test(want) && got === 'stqn'
    || want === 'stqn' && /^(?:standard )?twin(?: rooms?)?$/.test(got)) return false;
  return family(want) !== undefined && family(want) === family(got);
}

function quoteRoomTypes(room: unknown): unknown[] {
  return [dig(room, '/room_type'), dig(room, '/requested_room_type'), dig(room, '/room_type_request'),
    ...array(dig(room, '/required/roomCodes')), ...array(dig(room, '/preferred/roomCodes'))].filter(value => !isBlank(value));
}

function boardLabel(value: unknown): 'DBB' | 'BB' | 'RO' | null {
  const meal = label(value).replace(/_/g, ' ');
  if (/\b(?:dbb|dinner)\b/.test(meal)) return 'DBB';
  if (/\b(?:bb|b\s*&\s*b|breakfast)\b/.test(meal)) return 'BB';
  if (/\b(?:ro|room[ -]+only)\b/.test(meal)) return 'RO';
  return null;
}

function rateMatch(expected: unknown, actual: unknown, board: unknown): boolean {
  if (strictMatch(expected, actual)) return true;
  const want = label(expected);
  const got = label(actual);
  if (!want || !got) return false;
  if (want === got) return true;
  if (nativeCode(expected) != null) return false;
  const family = /\b(?:govt?|government)\b/.test(want) ? /^(?:ngov[\da-z]*|gov(?:t|ernment)\b)/
    : /\bcorporate\b/.test(want) ? /^(?:ncor[\da-z]*|corporate\b)/ : null;
  const meal = boardLabel(expected);
  return family !== null && family.test(got) && (!meal || meal === board);
}

function cancellationTextMatch(expected: unknown, actual: unknown): boolean {
  if (strictMatch(expected, actual)) return true;
  const tokens = (value: unknown) => new Set(normalize(value).replaceAll('’', "'").match(/[a-z]+(?:'t)?/g)?.filter(word =>
    !/^(?:the|a|an|has|have|had|been|is|are|was|were|be|will|to|of|for|that|this|it|by|as|he|she|they|client|guest)$/.test(word))
    .map(word => word.replace(/^(attend)(?:ing|ed|s)$/, '$1')) ?? []);
  const wanted = tokens(expected);
  const got = tokens(actual);
  const negated = (words: Set<string>) => [...words].some(word => /^(?:no|not|never|without|cannot)$|n't$/.test(word));
  const overlap = [...wanted].filter(word => got.has(word)).length;
  return wanted.size >= 2 && negated(wanted) === negated(got) &&
    overlap >= Math.max(2, Math.ceil(wanted.size * 0.60), Math.ceil(got.size * 0.50));
}

function distance(a: string, b: string): number {
  let prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (const [i, char] of [...a].entries()) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, prev[j + 1] + 1, prev[j] + Number(char !== b[j])));
    prev = next;
  }
  return prev[b.length];
}

export function personEqual(expected: unknown, actual: unknown, aliases: unknown[] = []): boolean {
  const variants = typeof expected === 'object' && expected !== null
    ? [dig(expected, '/name'), dig(expected, '/value'), dig(expected, '/first_name'), dig(expected, '/last_name'), ...array(dig(expected, '/aliases'))]
    : [expected];
  const nameKey = (value: unknown) => normalizePerson(value).normalize('NFC').replace(/[^\p{L}\p{N}]/gu, '');
  const b = nameKey(actual);
  return b !== '' && [...variants, ...aliases].some(value => {
    const a = nameKey(value);
    const size = a.length;
    const limit = size >= 7 ? 2 : size >= 4 ? 1 : 0;
    return a !== '' && distance(a, b) <= limit;
  });
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

function bookingFields(booking: unknown): Record<string, unknown> {
  const row = booking && typeof booking === 'object' ? booking as Record<string, unknown> : {};
  return row.fields && typeof row.fields === 'object' ? row.fields as Record<string, unknown> : {};
}

const actionTypes = {create: 'create_reservation', amend: 'amend_reservation', cancel: 'cancel_reservation', filing: 'attach_document'};
const filingTypes = new Set(['attach_document', 'payment_proof_submission', 'voucher_submission']);
const reviewDispositions = new Set(['needs_info', 'staff_review', 'needs_review', 'review']);
type WriteWorkflow = keyof typeof actionTypes;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const idField = (path: string) => /\/(reservation_id|confirmation_number)$/.test(path);
const stayId = (value: unknown) => /^\d+(?:-\d+)?$/.test(String(value ?? '')) ? String(value) : '';
function writeWorkflow(type: unknown): WriteWorkflow | undefined {
  if (filingTypes.has(String(type))) return 'filing';
  if (type === actionTypes.create || type === 'create') return 'create';
  if (type === actionTypes.amend || type === 'amend') return 'amend';
  if (type === actionTypes.cancel || type === 'cancel') return 'cancel';
}
const goldTargets = (card: CaseCard) => [...new Set((Array.isArray(card.expected_targets) ? card.expected_targets :
  (card.gold ?? []).flatMap(field => field.expectation === 'expected' && idField(field.path) ? [field.value] : []))
  .map(stayId).filter(Boolean))];

function idsEqual(actual: unknown, expected: unknown, targets: string[]): boolean {
  const a = stayId(actual), e = stayId(expected);
  return Boolean(a && e && (a === e || (!a.includes('-') && e === `${a}-1`
    && targets.filter(id => id === a || id.startsWith(`${a}-`)).length === 1)));
}

function boundActions(proposal: unknown, includeReviewFields: boolean) {
  const bookings = array(dig(proposal, '/bookings'));
  return array(dig(proposal, '/actions')).flatMap((action, index) => {
    const workflow = writeWorkflow(dig(action, '/type'));
    if (!workflow) return [];
    const linked = array(dig(action, '/booking_ids'));
    const bindings = linked.length ? linked : [undefined];
    const direct = includeReviewFields
      ? [dig(action, '/details'), dig(action, '/details/lookup')].flatMap(boundConfirmationFields)
      : [dig(action, '/details/reservation_id'), dig(action, '/details/confirmation_number'), dig(action, '/details/lookup/reservation_id')];
    return bindings.map(bookingId => {
      const bookingIndex = bookingId == null ? -1 : bookings.findIndex(booking => dig(booking, '/id') === bookingId);
      const booking = bookings[bookingIndex];
      const bookingTargets = includeReviewFields ? [booking, dig(booking, '/fields')].flatMap(boundConfirmationFields)
        : [dig(booking, '/reservation_id'), dig(booking, '/fields/reservation_id'), dig(booking, '/fields/confirmation_number')];
      const targets = [...direct, ...bookingTargets].filter(value => value != null && value !== '');
      return {workflow, index, bookingIndex, targets: [...new Set(targets.map(value => String(value)))]};
    });
  });
}

const confirmationFields = /^(?:reservation_id|confirmation_(?:number|id)|target_confirmation(?:_number)?|hms_confirmation(?:_number)?)$/;
function boundConfirmationFields(row: unknown): unknown[] {
  return row && typeof row === 'object' ? Object.entries(row).flatMap(([key, value]) =>
    confirmationFields.test(key) ? [value] : []) : [];
}
const evidenceConfirmationFields = /^(?:confirmation|confirmationnumber|confirmation_labels|confirmations|staff_confirmation|staff_confirmations|real_confirmation)$/i;
const exactConfirmation = (value: unknown) => {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^\d{6,10}-\d+$/.test(id) ? id : '';
};

function confirmationValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(confirmationValues);
  const id = exactConfirmation(value);
  return id ? [id] : [];
}

function outcomeConfirmations(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(outcomeConfirmations);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => confirmationFields.test(key) || evidenceConfirmationFields.test(key)
    ? confirmationValues(child) : outcomeConfirmations(child));
}

function pdfConfirmations(pdf: unknown): string[] {
  const filename = String(dig(pdf, '/filename') ?? dig(pdf, '/name') ?? '');
  const text = String(dig(pdf, '/text') ?? dig(pdf, '/extracted_text') ?? '').slice(0, 20_000);
  const declared = [...['confirmation', 'confirmation_labels'].map(key => dig(pdf, '/' + key)),
    ...['fields', 'pdf_fields'].flatMap(key => ['confirmation', 'confirmationNumber', 'confirmation_number']
      .map(field => dig(pdf, `/${key}/${field}`)))].flatMap(confirmationValues);
  const fromName = /Confirmation[_ -]Letter[_ -](\d{6,10}-\d+)(?=$|[_. ])/i.exec(filename)?.[1];
  if (fromName) declared.push(fromName);
  try {
    const parsed: unknown = JSON.parse(text);
    declared.push(...['confirmationNumber', 'confirmation_number'].flatMap(key => confirmationValues(dig(parsed, '/' + key))));
  } catch {
    for (const match of text.matchAll(/\bConfirmation\s+(?:Number|No\.?)\s*:?\s*(\d{6,10}-\d+)(?![\w-])/gi)) {
      declared.push(...confirmationValues(match[1]));
    }
  }
  return declared;
}

function visiblePdfConfirmations(card: CaseCard): string[] {
  const selected = card.selected_email;
  const timestamp = (value: unknown) => Date.parse(typeof value === 'string' ? value : '');
  const selectedAt = timestamp(dig(selected, '/received_at') ?? dig(selected, '/timestamp') ?? card.as_of);
  const cutoff = selectedCutoff(card);
  if (!Number.isFinite(cutoff)) return [];
  const attached = (message: unknown, at: number) => {
    const owner = dig(message, '/source_row_id');
    const pdfRows = dig(message, '/pdf_attachments_text');
    return array(pdfRows ?? dig(message, '/attachments')).filter(row => {
      const sent = dig(row, '/sent_at');
      const source = dig(row, '/source_row_id');
      const isPdf = Array.isArray(pdfRows) || dig(row, '/content_type') === 'application/pdf'
        || dig(row, '/contentType') === 'application/pdf' || /\.pdf$/i.test(String(dig(row, '/filename') ?? dig(row, '/name') ?? ''));
      return isPdf && (sent == null || timestamp(sent) <= at) && (owner == null || source == null || source === owner);
    });
  };
  const selectedPdfs = selectedAt <= cutoff ? attached(selected, selectedAt) : [];
  const priorPdfs = array(card.context_before).flatMap(event => {
    const message = dig(event, '/message') ?? event;
    const at = timestamp(dig(message, '/received_at') ?? dig(message, '/timestamp'));
    return at < cutoff ? attached(message, at) : [];
  });
  const attachmentId = (row: unknown) => dig(row, '/pdf_attachment_id') ?? dig(row, '/attachment_id') ?? dig(row, '/id');
  const versions = array(card.pdf_versions).filter(version => {
    const at = timestamp(dig(version, '/sent_at'));
    const hash = dig(version, '/sha256');
    const id = attachmentId(version);
    return at < cutoff || at === cutoff && selectedPdfs.some(row =>
      (hash != null && hash === dig(row, '/sha256')) || (id != null && id === attachmentId(row)));
  });
  return [...selectedPdfs, ...priorPdfs, ...versions].flatMap(pdfConfirmations);
}

function stayToolEvidence(toolCalls: ScoringToolCall[]): ScoringToolCall[] {
  const publish = toolCalls.findLastIndex(call => call.name === 'proposal_publish' && call.result?.ok === true);
  return toolCalls.slice(0, publish < 0 ? undefined : publish).flatMap<ScoringToolCall>(call => {
    if (call.result?.ok !== true) return [];
    const data = call.result.data;
    if (call.name === 'hms_read_reservation') {
      const record = dig(data, '/record') ?? dig(data, '/stay');
      const fields = dig(record, '/details/fields');
      const confirmations = [...outcomeConfirmations({
        confirmation: dig(record, '/confirmation'),
        confirmationnumber: dig(record, '/confirmationnumber'),
        confirmation_number: dig(record, '/confirmation_number'),
        confirmations: dig(record, '/confirmations'),
        reservation_id: dig(record, '/reservation_id'),
      }), ...array(fields).flatMap(field => {
        const name = String(dig(field, '/name') ?? '');
        return /^(?:confirmation(?:_?number)?|reservation_id)$/i.test(name) ? confirmationValues(dig(field, '/value')) : [];
      })];
      return confirmations.length ? [{name: call.name, result: {ok: true, data: {record: {confirmations}}}}] : [];
    }
    if (call.name === 'hms_search_reservations') {
      const rows = array(dig(data, '/candidates') ?? dig(data, '/native/candidates'));
      if (rows.length !== 1 || ['ambiguous_or_incomplete', 'incomplete'].includes(String(dig(data, '/outcome')))) return [];
      const candidates = rows.flatMap(row =>
        confirmationValues(dig(row, '/reservation_id') ?? dig(row, '/confirmation') ?? dig(row, '/confirmation_number'))
          .map(reservation_id => ({reservation_id})));
      return candidates.length ? [{name: call.name, result: {ok: true, data: {candidates}}}] : [];
    }
    return [];
  });
}
const confirmationNumber = /^\d{7,10}(?:-\d+)?$/;
function reviewConfirmationIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(reviewConfirmationIds);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    if (!confirmationFields.test(key)) return reviewConfirmationIds(child);
    const id = String(child ?? '').trim();
    return confirmationNumber.test(id) ? [id] : [];
  });
}

function bookingUnits(booking: unknown): number {
  const quantity = Number(bookingFields(booking).quantity ?? dig(booking, '/quantity') ?? 1);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 1;
}

type SafetyFlags = {
  vcc_false_filing: boolean;
  staff_reply_false_action: boolean;
  wrong_target: boolean;
  spurious_action: boolean;
};

type CreateAlign = {
  /** gold booking index → proposal booking index */
  map: Map<number, number>;
  /** proposal bookings with no gold partner */
  spray: boolean;
};

function collectCreateGoldHints(card: CaseCard) {
  type Name = {value: unknown; aliases?: string[]};
  const hints = new Map<number, {index: number; first_name?: Name; last_name?: Name; arrival_date?: unknown}>();
  for (const gold of (card.gold ?? []) as GoldMeta[]) {
    const m = /^\/bookings\/(\d+)(?:\/|$)/.exec(gold.path);
    if (!m) continue;
    const index = Number(m[1]);
    const row = hints.get(index) ?? {index};
    if (gold.expectation === 'expected') {
      if (gold.path.endsWith('/first_name') || gold.path.endsWith('fields/first_name')) row.first_name = {value: gold.value, aliases: gold.aliases};
      if (gold.path.endsWith('/last_name') || gold.path.endsWith('fields/last_name')) row.last_name = {value: gold.value, aliases: gold.aliases};
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
        const firstOk = hint.first_name == null || personEqual(hint.first_name.value, fields.first_name, hint.first_name.aliases);
        const lastOk = hint.last_name == null || personEqual(hint.last_name.value, fields.last_name, hint.last_name.aliases);
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

/** Maximum-weight one-to-one assignment. Zero-weight dummy rows allow missing quotes. */
function alignRows(weights: number[][], columns: number): number[] {
  const size = Math.max(weights.length, columns);
  const rowOffset = Array(size + 1).fill(0);
  const colOffset = Array(size + 1).fill(0);
  const owner = Array(size + 1).fill(0);
  const result = weights.map(() => -1);
  for (let row = 1; row <= size; row++) {
    owner[0] = row;
    const parent = Array(size + 1).fill(0);
    const seen = Array(size + 1).fill(false);
    const best = Array(size + 1).fill(Infinity);
    let col = 0;
    do {
      seen[col] = true;
      const r = owner[col];
      let delta = Infinity;
      let next = 0;
      for (let c = 1; c <= size; c++) {
        if (seen[c]) continue;
        const cost = -(weights[r - 1]?.[c - 1] ?? 0) - rowOffset[r] - colOffset[c];
        if (cost < best[c]) {
          best[c] = cost;
          parent[c] = col;
        }
        if (best[c] < delta) [delta, next] = [best[c], c];
      }
      for (let c = 0; c <= size; c++) {
        if (seen[c]) {
          rowOffset[owner[c]] += delta;
          colOffset[c] -= delta;
        } else best[c] -= delta;
      }
      col = next;
    } while (owner[col] !== 0);
    do {
      owner[col] = owner[parent[col]];
      col = parent[col];
    } while (col !== 0);
  }
  for (let col = 1; col <= columns; col++) {
    if (owner[col] <= weights.length) result[owner[col] - 1] = col - 1;
  }
  return result;
}

function indexedFields(fields: GoldField[], prefix: RegExp) {
  const rows = new Map<number, GoldField[]>();
  for (const field of fields) {
    const match = prefix.exec(field.path);
    if (!match) continue;
    const index = Number(match[1]);
    const row = rows.get(index) ?? [];
    row.push({...field, path: match[2] ?? ''});
    rows.set(index, row);
  }
  return [...rows].sort(([a], [b]) => a - b);
}

function quotePaths(fields: GoldField[], proposal: unknown) {
  const paths = new Map<string, string>();
  for (const [action, actionFields] of indexedFields(fields, /^\/actions\/(\d+)(\/.*)$/)) {
    const groups = indexedFields(actionFields, /^\/details\/groups\/(\d+)(\/.*)$/);
    const root = `/actions/${action}/details/groups`;
    const actualGroups = array(dig(proposal, root));
    const candidates = groups.map(([, gold]) => actualGroups.map(actual => {
      const rooms = indexedFields(gold, /^\/rooms\/(\d+)(\/.*)$/);
      const actualRooms = array(dig(actual, '/rooms'));
      const weights = rooms.map(([, room]) => actualRooms.map(got => room.reduce((total, f) =>
        total + Number(f.expectation === 'expected' && (f.path === '/room_type'
          ? quoteRoomTypes(got).some(roomType => roomMatch(f.value, roomType)) : strictMatch(f.value, dig(got, f.path)))), 0)));
      const roomMatches = alignRows(weights, actualRooms.length);
      const roomScore = roomMatches.reduce((total, match, i) => total + (weights[i]?.[match] ?? 0), 0);
      const dates = gold.filter(f => f.expectation === 'expected' && /^\/(arrival|departure)_date$/.test(f.path));
      const datesHit = dates.filter(f => f.expectation === 'expected' && strictMatch(f.value, dig(actual, f.path))).length;
      const other = gold.filter(f => f.expectation === 'expected' && !/^\/(?:rooms\/|(?:arrival|departure)_date$)/.test(f.path)
        && equalish(f.value, dig(actual, f.path))).length;
      return {weight: 2 * datesHit + roomScore + other, rooms, roomMatches};
    }));
    const matches = alignRows(candidates.map(row => row.map(candidate => candidate.weight)), actualGroups.length);
    for (const [i, [index, gold]] of groups.entries()) {
      const candidate = candidates[i]?.[matches[i]];
      if (!candidate) continue;
      const src = `${root}/${index}`, dst = `${root}/${matches[i]}`;
      for (const field of gold) {
        if (!/^\/rooms\/\d+\//.test(field.path)) paths.set(src + field.path, dst + field.path);
      }
      for (const [j, [room, roomFields]] of candidate.rooms.entries()) {
        if (candidate.roomMatches[j] < 0) continue;
        for (const field of roomFields) {
          paths.set(`${src}/rooms/${room}${field.path}`, `${dst}/rooms/${candidate.roomMatches[j]}${field.path}`);
        }
      }
    }
  }
  return paths;
}

function selectedPdfRows(card: CaseCard): unknown[] {
  const selected = dig(card, '/selected_email');
  return array(dig(selected, '/pdf_attachments_text') ?? dig(selected, '/attachments'));
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
  const id = row.id ?? row.attachment_id;
  const alts = [String(id ?? exp)];
  return {expectation: 'expected', value: id != null && id !== '' ? String(id) : exp, basis: gold.basis, alts};
}

/** CREATE: missing quantity → same-room_type booking count (else all bookings). */
function createQuantityActual(proposal: unknown, digPath: string, actual: unknown): unknown {
  if (actual != null && actual !== '' || !/\/bookings\/\d+\/fields\/quantity$/.test(digPath)) return actual;
  const m = /^\/bookings\/(\d+)\//.exec(digPath);
  const bookings = dig(proposal, '/bookings');
  if (!m || !Array.isArray(bookings) || !bookings[Number(m[1])]) return actual;
  const fields = bookingFields(bookings[Number(m[1])]);
  if (!fields.room_type || !fields.arrival_date || !fields.departure_date) return actual;
  return bookings.filter(b => ['arrival_date', 'departure_date', 'room_type'].every(key => strictMatch(fields[key], bookingFields(b)[key]))).length;
}

function createBoard(fields: Record<string, unknown>): unknown {
  if (!isBlank(fields.board)) return fields.board;
  const notes = [fields.reservation_note, fields.notes, fields.note].map(boardLabel);
  return boardLabel(fields.meal_plan) ?? (notes.includes('DBB') ? 'DBB' : null)
    ?? ratePlanToBoard(fields.rate_plan) ?? notes.find(Boolean);
}

const workflowTools: Record<Workflow, string[]> = {
  create: ['mail_read_thread', 'skill_read', 'hms_search_parties', 'hms_read_catalogue', 'hms_quote', 'proposal_publish'],
  amend: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'proposal_publish'],
  cancel: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'proposal_publish'],
  filing: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'proposal_publish'],
  quote: ['mail_read_thread', 'skill_read', 'hms_read_catalogue', 'hms_quote', 'proposal_publish'],
  triage: ['mail_read_thread', 'skill_read', 'hms_search_reservations', 'hms_read_reservation', 'proposal_publish'],
};

export function goldTier(gold: GoldMeta): string {
  if (gold.tier && ['tier1_core', 'tier2_defaults', 'history_knowable', 'parity', 'workflow_routing'].includes(gold.tier)) return gold.tier;
  if (gold.source === 'hms_truth' || /\bhistory_knowable\b/.test(gold.basis)) return 'history_knowable';
  if (gold.path.includes('cms_') || gold.path.includes('guarantee') || gold.path.includes('source_of') || gold.path.includes('/track') || gold.path.includes('billing_')) {
    return 'tier2_defaults';
  }
  return 'tier1_core';
}

function goldPriority(gold: GoldMeta): string {
  const p = gold.priority ?? gold.tier;
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
  toolCalls: ScoringToolCall[];
  tokens: {input: number; output: number; cached_input: number};
  wall_ms: number;
  /** When false, `proposal` is already staged and raw is in proposal_raw. Default true. */
  normalize?: boolean;
  proposal_raw?: unknown;
  partyReads?: Array<{input: unknown; response: unknown}>;
  publish_invalid?: string | true;
  run_error?: string;
  model?: string;
}): CaseScore {
  const {card, toolCalls, tokens, wall_ms} = input;
  const normalized = input.normalize === false
    ? {proposal_raw: input.proposal_raw ?? input.proposal, proposal: input.proposal, publish_invalid: input.publish_invalid}
    : normalizePublishedProposal(input.proposal, input.partyReads ?? []);
  const proposal = mergeQuoteRooms(input.run_error || normalized.publish_invalid ? null : normalized.proposal);
  const proposal_raw = normalized.proposal_raw;
  const publish_invalid = normalized.publish_invalid;
  const fields: FieldScore[] = [];
  const workflow = card.workflow;
  const createAlign = workflow === 'create' ? alignCreateBookings(card, proposal) : null;
  const stayGoldIds = goldTargets(card);
  const write = workflow in actionTypes;
  const targeted = write && workflow !== 'create';
  const inferredCount = stayGoldIds.length || new Set((card.gold ?? []).filter(field => field.expectation === 'expected')
    .map(field => /^\/bookings\/(\d+)/.exec(field.path)?.[1]).filter(index => index !== undefined)).size;
  const expectedDispositionField = (card.gold ?? []).find(field => field.path === '/disposition' && field.expectation === 'expected');
  const expectedDisposition = card.expected_disposition ?? (expectedDispositionField?.expectation === 'expected' ? expectedDispositionField.value : undefined);
  const trap = workflow === 'triage' || card.doc_kind === 'vcc' || card.is_vcc_trap === true || card.is_staff_reply_trap === true;
  const expectsNoAction = trap || expectedDisposition === 'skip';
  const explicitCount = typeof card.expected_action_count === 'number' ? card.expected_action_count : undefined;
  const expectedCount = expectsNoAction ? 0 : explicitCount ?? (!write ? 0 : Math.max(1, inferredCount));
  const published = dig(proposal, '/workflow');
  const disposition = dig(proposal, '/disposition');
  const reviewOnly = targeted && explicitCount === 0 && !expectsNoAction;
  const actions = boundActions(proposal, reviewOnly);
  const matchingActions = actions.filter(action => action.workflow === workflow);
  const bookings = array(dig(proposal, '/bookings'));
  const publishedActions = array(dig(proposal, '/actions'));
  const knownSuffixes = [...new Set([...stayGoldIds, ...array(card.input_confs_visible), ...actions.flatMap(action => action.targets)]
    .map(stayId).filter(id => id.includes('-')))];
  const review = reviewDispositions.has(String(disposition));
  const toolEvidence = targeted ? stayToolEvidence(toolCalls) : [];
  const boundTargets = actions.flatMap(action => action.targets);
  const trueConfirmations = new Set(reviewOnly && boundTargets.length ? [
    ...confirmationValues(card.real_confirmation),
    ...confirmationValues(dig(card.hms_shown, '/confirmation')),
    ...confirmationValues(dig(card.hms_raw, '/confirmation')),
    ...outcomeConfirmations(card.staff_outcome_only),
    ...array(card.pdf_versions).flatMap(pdfConfirmations),
  ] : []);
  const verifiedConfirmations = new Set(reviewOnly && boundTargets.length ? [
    ...toolEvidence.flatMap(call => outcomeConfirmations(call.result?.data)),
    ...visiblePdfConfirmations(card),
  ] : []);
  const isVerifiedTarget = (value: string) => {
    const id = exactConfirmation(value);
    return trueConfirmations.has(id) && verifiedConfirmations.has(id);
  };
  const unverifiedTarget = reviewOnly && boundTargets.some(id => !isVerifiedTarget(id));
  const discovered = reviewOnly && boundTargets.length > 0 && !unverifiedTarget &&
    actions.every(action => action.workflow === workflow);
  const executable = (action: typeof actions[number]) => !reviewOnly || action.workflow !== workflow ||
    (!(discovered && action.targets.length > 0) && !review && disposition !== 'skip' && (workflow !== 'filing' ||
      disposition === 'propose' && action.targets.some(id => confirmationNumber.test(id.trim()))));
  const executableActions = actions.filter(executable);
  const countActions = (rows: typeof actions) => explicitCount === undefined ? rows.length : new Set(rows.map(action => action.index)).size;
  const createUnits = (rows: typeof actions) => [...new Map(rows.filter(action => action.bookingIndex >= 0)
    .map(action => [`${action.index}:${action.bookingIndex}`, action.bookingIndex])).values()]
    .reduce((sum, index) => sum + bookingUnits(bookings[index]), 0);
  const matchingUnits = workflow === 'create' && expectedCount > 0
    ? createUnits(matchingActions) : countActions(matchingActions.filter(executable));
  const actualUnits = expectedCount === 0 ? countActions(executableActions) : matchingUnits;
  const expectedBookings = Math.max(inferredCount, expectedCount);
  const sameWorkflowExtras = workflow === 'create' && expectedCount > 0
    ? Math.max(0, matchingUnits - expectedCount, bookings.reduce<number>((n, b) => n + bookingUnits(b), 0) - expectedBookings)
    : Math.max(0, matchingUnits - expectedCount, write && expectedCount > 0 ? bookings.length - expectedBookings : 0);
  const spurious_action_count = sameWorkflowExtras + countActions(executableActions.filter(action => action.workflow !== workflow));
  const actionForTarget = (value: unknown) => matchingActions.find(action => action.targets.length > 0
    && action.targets.every(target => idsEqual(target, value, knownSuffixes)));
  const goldFields = [...(card.gold ?? [])];
  if (reviewOnly) {
    for (const field of card.unscored_request_fields ?? []) {
      if (!idField(field.path) && !/^\/actions\/\d+\/type$/.test(field.path)
        && !goldFields.some(gold => gold.path === field.path)) goldFields.push(field);
    }
  }
  const selectedIds = selectedPdfRows(card).map(row => dig(row, '/id') ?? dig(row, '/attachment_id')).filter(id => !isBlank(id));
  const fallbackAttachment = '/actions/0/details/attachment_id';
  const useSelectedIds = reviewOnly && workflow === 'filing' && selectedIds.length > 0
    && !goldFields.some(field => field.expectation === 'expected' && field.path.endsWith('/attachment_id'));
  if (useSelectedIds) goldFields.push({path: fallbackAttachment, value: selectedIds[0], expectation: 'expected',
    basis: 'selected_pdf', priority: 'P0', source: 'email_explicit'});
  const quoteAlign = workflow === 'quote' ? quotePaths(goldFields, proposal) : null;
  const quotePartial = workflow === 'quote' && (expectedCount === 0 || !goldFields.some(field =>
    field.expectation === 'expected' && field.knowable !== false && !field.unobserved_in_twin &&
    !isBlank(field.value) && /\/(?:adults|occupancy)$/.test(field.path)));
  const quoteTwinNoPrice = workflow === 'quote' && toolCalls.some(call =>
    call.name === 'hms_quote' && call.result?.error?.code === 'TWIN_NO_PRICE');
  const allowedDispositions = card.expected_dispositions ?? (expectedDisposition ? [expectedDisposition] : undefined);
  const dispositionOk = reviewOnly
    ? executableActions.length === 0 && (review || disposition === 'propose' && (discovered || workflow === 'filing' && matchingActions.length > 0))
    : workflow === 'quote'
      ? actions.length === 0 && (disposition !== 'skip' || expectsNoAction || allowedDispositions?.includes('skip') === true)
        && (quotePartial && (disposition === 'needs_info' || disposition === 'propose')
        || quoteTwinNoPrice && disposition === 'staff_review'
        || (allowedDispositions ?? ['propose', 'needs_info', 'staff_review', 'decline', 'skip']).includes(String(disposition)))
      : disposition !== 'skip' && expectedCount > 0
        ? matchingUnits === expectedCount && matchingActions.every(action => workflow === 'create'
          ? action.bookingIndex >= 0 : action.targets.length > 0) && (allowedDispositions ?? ['propose']).includes(String(disposition))
        : expectedCount === 0 && actions.length === 0 && (allowedDispositions ??
          (write ? ['needs_info', 'staff_review', 'decline', 'skip'] : ['propose', 'needs_info', 'staff_review', 'decline', 'skip']))
          .includes(String(disposition));
  const routeOk = published === workflow;
  const safety_flags: SafetyFlags = {
    vcc_false_filing: (card.is_vcc_trap === true || card.doc_kind === 'vcc') && (published === 'filing' || actions.some(action => action.workflow === 'filing')),
    staff_reply_false_action: card.is_staff_reply_trap === true && actions.length > 0,
    wrong_target: reviewOnly ? unverifiedTarget || [
      ...reviewConfirmationIds(bookings), ...reviewConfirmationIds(publishedActions),
    ].some(id => !(discovered && isVerifiedTarget(id)) && !stayGoldIds.some(expected => idsEqual(id, expected, knownSuffixes)))
      || (workflow !== 'filing' && executableActions.some(action => action.workflow === workflow))
      : actions.some(action => action.workflow !== 'create' &&
      (stayGoldIds.length > 0 || expectedCount === 0 || Array.isArray(card.expected_targets)) &&
      (action.targets.length === 0 || action.targets.some(target => !stayGoldIds.some(id => idsEqual(target, id, knownSuffixes))))),
    spurious_action: spurious_action_count > 0,
  };
  const usableActions = disposition === 'skip' ? [] : matchingActions;

  for (const gold of goldFields) {
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
    if (gold.path === '/workflow' || gold.path === '/disposition') continue;
    const tier = goldTier(gold);
    const priority = goldPriority(gold);
    const source = goldSource(gold);

    // CREATE: score gold booking fields against the aligned proposal booking.
    let digPath: string | null = gold.path;
    if (createAlign && /^\/bookings\/\d+/.test(gold.path)) {
      digPath = remapCreatePath(gold.path, createAlign.map);
    }
    if (quoteAlign && /^\/actions\/\d+\/details\/groups\/\d+\//.test(gold.path)) {
      digPath = quoteAlign.get(gold.path) ?? null;
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
    // Diagnostic rows (e.g. child_count==0) stay out of P0 hit/miss; equalish blank↔0 untouched.
    if (gold.expectation === 'diagnostic') {
      fields.push({
        path: gold.path,
        expectation: 'diagnostic',
        result: 'no_gold',
        expected: gold.value,
        basis: gold.basis,
        tier,
        priority,
        source,
      });
      continue;
    }

    const knowable = gold.knowable !== false && !gold.unobserved_in_twin
      && !/\bunobserved_in_twin\b/.test(`${gold.basis} ${gold.source ?? ''} ${gold.derivable ?? ''}`);

    let expectedValue = gold.value;
    let expectation: GoldField['expectation'] = 'expected';
    let basis = gold.basis;
    let attachmentAlts: string[] | undefined;
    if (gold.path.endsWith('attachment_id')) {
      const resolved = resolveAttachmentGold(gold, card);
      expectation = resolved.expectation;
      expectedValue = resolved.value;
      basis = resolved.basis;
      attachmentAlts = useSelectedIds && gold.path === fallbackAttachment ? selectedIds.map(String) : resolved.alts;
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

    const bookingPath = /^\/bookings\/(\d+)(\/.*)$/.exec(gold.path);
    const expectedBookingId = bookingPath && goldFields.find(field =>
      field.expectation === 'expected' && field.path.startsWith(`/bookings/${bookingPath[1]}/`) && idField(field.path));
    const binding = expectedBookingId?.expectation === 'expected' ? actionForTarget(expectedBookingId.value) : undefined;
    if (targeted && !reviewOnly && bookingPath && !idField(gold.path) && expectedBookingId) {
      digPath = binding && binding.bookingIndex >= 0 ? `/bookings/${binding.bookingIndex}${bookingPath[2]}` : null;
    }
    const filingDocument = workflow === 'filing' && /^\/actions\/\d+\/(?:type|details\/(?:attachment_id|doc_kind))$/.test(gold.path);
    if (workflow === 'filing' && !filingDocument && !reviewOnly && /^\/actions\/\d+\//.test(gold.path) && stayGoldIds.length === 1) {
      const bound = actionForTarget(stayGoldIds[0]);
      digPath = bound ? gold.path.replace(/^\/actions\/\d+/, `/actions/${bound.index}`) : null;
    }
    let actual = digPath == null ? undefined : dig(proposal, digPath);
    if (reviewOnly && workflow === 'filing' && gold.path.endsWith('/attachment_id') && dispositionOk) {
      const supplied = publishedActions.map(action => dig(action, '/details/attachment_id')).filter(id => !isBlank(id));
      actual = supplied.find(id => (attachmentAlts ?? [expectedValue]).some(wanted => String(id) === String(wanted)))
        ?? supplied[0];
    }
    let board: 'DBB' | 'BB' | 'RO' | null = null;
    if (workflow === 'create' && digPath) {
      actual = createQuantityActual(proposal, digPath, actual);
      const booking = /^\/bookings\/(\d+)\//.exec(digPath);
      if (booking && /\/(?:board|rate_plan)$/.test(digPath)) {
        const derived = createBoard(bookingFields(bookings[Number(booking[1])]));
        board = boardLabel(derived);
        if (digPath.endsWith('/board')) actual = derived;
      }
    }
    const idPath = idField(gold.path);
    const guestPath = /\/fields\/(first_name|last_name|guest_name|guest_full_name|guestfullname)$/.test(gold.path);
    let hit: boolean;
    if (idPath && targeted) {
      const match = usableActions.length ? actionForTarget(expectedValue) : undefined;
      actual = match?.targets[0] ?? actual;
      hit = Boolean(match);
    } else if (idPath || gold.path.endsWith('/attachment_id')) {
      hit = (attachmentAlts ?? [expectedValue]).some(value => value != null && String(value) === String(actual ?? ''));
    } else if (guestPath) {
      hit = personEqual(expectedValue, actual, gold.aliases);
    } else if (/\/(organization|agency)(_name|_id)?$/.test(gold.path)) {
      hit = strictMatch(expectedValue, actual) || equalish(expectedValue, actual) || (digPath !== null && /_name$/.test(digPath)
        && strictMatch(expectedValue, dig(proposal, digPath.replace(/_name$/, '_id'))));
    } else if (/\/(arrival_date|departure_date)$/.test(gold.path)) {
      hit = strictMatch(expectedValue, actual);
    } else if ((workflow === 'create' || workflow === 'quote') && gold.path.endsWith('/room_type')) {
      if (workflow === 'quote' && digPath && /\/rooms\/\d+\/room_type$/.test(digPath)) {
        const candidates = quoteRoomTypes(dig(proposal, digPath.replace(/\/room_type$/, '')));
        actual = candidates.find(roomType => roomMatch(expectedValue, roomType)) ?? candidates[0];
      }
      hit = codeGoldHit(expectedValue, actual) ?? roomMatch(expectedValue, actual);
    } else if (workflow === 'create' && gold.path.endsWith('/rate_plan')) {
      hit = codeGoldHit(expectedValue, actual) ?? rateMatch(expectedValue, actual, board);
    } else if ((workflow === 'create' || workflow === 'quote') && gold.path.endsWith('/board')) {
      const meal = boardLabel(expectedValue);
      hit = (meal !== null && meal === boardLabel(actual)) || equalish(expectedValue, actual);
    } else if (workflow === 'cancel' && /\/cancellation_(?:note|reason)$/.test(gold.path)) {
      const prose = gold.path.endsWith('/cancellation_note') || typeof expectedValue === 'string' && /\w\s+\w/.test(expectedValue);
      const alternate = digPath && dig(proposal, digPath.replace(/cancellation_(note|reason)$/,
        (_, field) => field === 'note' ? 'cancellation_reason' : 'cancellation_note'));
      hit = prose ? cancellationTextMatch(expectedValue, actual) || cancellationTextMatch(expectedValue, alternate)
        : strictMatch(expectedValue, actual);
      if (hit && prose && !cancellationTextMatch(expectedValue, actual)) actual = alternate;
    } else if (/\/(room_type|rate_plan|nights|adults|children|child_count|quantity)$/.test(gold.path)) {
      hit = strictMatch(expectedValue, actual);
    } else if (workflow === 'filing' && /\/actions\/\d+\/type$/.test(gold.path)) {
      hit = strictMatch(expectedValue, actual) || (filingTypes.has(String(expectedValue)) && actual === 'attach_document');
    } else {
      hit = equalish(expectedValue, actual);
    }
    if (write && expectedCount > 0 && (!usableActions.length ||
      workflow === 'create' && bookingPath && !usableActions.some(action => action.bookingIndex >= 0 && digPath?.startsWith(`/bookings/${action.bookingIndex}/`)))) hit = false;
    fields.push({
      path: gold.path,
      expectation: 'expected',
      result: hit ? 'hit' : 'miss',
      knowable,
      expected: expectedValue,
      actual,
      basis,
      tier,
      priority,
      source,
    });
  }

  fields.push({
    path: '/workflow',
    expectation: 'expected',
    result: routeOk ? 'hit' : 'miss',
    expected: card.workflow,
    actual: published || null,
    basis: 'workflow_routing',
    tier: 'workflow_routing',
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
      if (rid && got && idsEqual(got, rid, stayGoldIds)) keyHits += 1;
      else if (rid) keyMisses += 1;
    }
  }

  const twin_uncovered = toolCalls.flatMap(call => {
    const code = call.result?.error?.code;
    if (code && /^TWIN_(NO_PRICE|PRE_CUTOFF_.*_UNAVAILABLE)$/.test(code)) return [`${call.name}:${code}`];
    if (call.name === 'hms_read_reservation' && dig(call.result?.data, '/documents_observed') === false) return ['hms_read_reservation:DOCUMENTS_UNOBSERVED'];
    return [];
  });
  const p0 = roiFields(fields, ['P0']);
  const p1 = roiFields(fields, ['P1', 'P2']);
  const spuriousFields = fields.some(field => field.result === 'spurious');
  const routeAndDisposition = Number(routeOk && dispositionOk && !safety_flags.spurious_action && !spuriousFields);
  const base = workflow === 'triage' && !safety_flags.spurious_action ? routeAndDisposition
    : (0.30 * routeAndDisposition + 0.50 * (p0.field_accuracy ?? 0) + 0.20 * (p1.field_accuracy ?? 0))
      / (0.30 + (p0.field_accuracy === null ? 0 : 0.50) + (p1.field_accuracy === null ? 0 : 0.20));
  const harmful = safety_flags.vcc_false_filing || safety_flags.staff_reply_false_action || safety_flags.wrong_target;
  const unsafe = Object.entries(safety_flags).find(([, flagged]) => flagged)?.[0];
  const failureReason = input.run_error ? 'run_error' : publish_invalid ? 'publish_invalid'
    : unsafe ?? (!routeOk ? 'workflow_mismatch' : expectedCount !== actualUnits ? 'unit_count_mismatch'
      : !dispositionOk ? 'disposition_mismatch' : spuriousFields ? 'spurious_field'
      : fields.some(field => field.knowable !== false && field.result === 'miss') ? 'field_mismatch' : null);

  return {
    case_id: card.case_id,
    workflow: card.workflow,
    roi_score: input.run_error || (trap && safety_flags.spurious_action) ? 0
      : Math.min(1, Math.max(0, base - (harmful ? 0.50 : 0))),
    route_ok: routeOk,
    disposition_ok: dispositionOk,
    safety_flags,
    spurious_action_count,
    expected_units: expectedCount,
    actual_units: actualUnits,
    failure_reason: failureReason,
    quote_capture_ok: workflow === 'quote' && disposition !== 'skip' && publishedActions.some(action =>
      dig(action, '/type') === 'quote' && toolCalls.some(call => call.name === 'hms_quote' &&
        call.result?.ok === true && call.result.data != null && sameQuoteCriteria(call.input, dig(action, '/details')))),
    ...(input.run_error ? {run_error: input.run_error} : {}),
    fields,
    ...(targeted ? {tool_calls: toolEvidence} : {}),
    tool_quality: {
      calls: toolCalls.map(call => {
        const args = call.name === 'proposal_publish' ? {
          workflow: dig(call.input, '/workflow'), disposition: dig(call.input, '/disposition'),
          actions: array(dig(call.input, '/actions')).map(action => dig(action, '/type')),
        } : call.input;
        const input = JSON.stringify(args ?? '').slice(0, 350);
        const row: ToolQuality['calls'][number] = {name: call.name, ok: call.result?.ok !== false, input, error: call.result?.error?.code};
        if (call.name === 'hms_search_parties' || call.name === 'hms_search_reservations') {
          const cands = array(dig(call.result?.data, '/candidates') ?? dig(call.result?.data, '/native/candidates'));
          row.hits = cands.length;
          row.top = cands.slice(0, 5).map(c => ({
            displayName: dig(c, '/displayName') ?? dig(c, '/name') ?? null,
            name: dig(c, '/name') ?? null,
            id: dig(c, '/nativeId') ?? dig(c, '/reservation_id') ?? dig(c, '/id') ?? null,
          }));
        }
        return row;
      }),
      right_tool: right,
      wasted_calls: wasted,
      key_arg_hits: keyHits,
      key_arg_misses: keyMisses,
    },
    tokens,
    cost_usd: costUsd(tokens, input.model),
    wall_ms,
    twin_uncovered,
    proposal,
    proposal_raw,
    ...(publish_invalid !== undefined ? {publish_invalid} : {}),
    spray: Boolean(createAlign?.spray || safety_flags.spurious_action),
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
  git_sha: string;
  git_dirty: boolean;
  skills_digest: string | null;
  world_dir: string | null;
  model: string | null;
  reasoning_effort: string | null;
};

export type Scoreboard = {
  ruler?: RulerStamp;
  roi_score: {micro: number | null; workflow_macro: number | null};
  safety: ReturnType<typeof safetySummary>;
  vcc_false_filing_count: number;
  staff_reply_false_action_count: number;
  wrong_target_count: number;
  spurious_action_count: number;
  twin_unobserved_count: number;
  run_error_count: number;
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
    route_acc: number | null;
    disposition_acc: number | null;
    p0_acc: WeightedBucket;
    p1_acc: WeightedBucket;
    p2_acc: WeightedBucket;
    roi_score: number;
    safety_violations: number;
    quote_capture_count: number;
    p50_s: number | null;
    p95_s: number | null;
    cost_per_email_usd: number | null;
    unpriced_cases: number;
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
    cost_usd: number | null;
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

function roiFields(fields: FieldScore[], priorities: string[]): WeightedBucket {
  const rows = fields.filter(field => field.knowable !== false && field.path !== '/workflow' && priorities.includes(field.priority ?? ''));
  const hit = rows.filter(field => field.result === 'hit').length;
  const miss = rows.filter(field => field.result === 'miss').length;
  return {hit, miss, field_accuracy: hit + miss ? hit / (hit + miss) : null};
}

const safetySummary = () => ({vcc_false_filing: 0, staff_reply_false_action: 0, wrong_target: 0, spurious_action: 0});
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

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
  if (field.knowable === false || field.path === '/workflow' || field.result !== 'hit' && field.result !== 'miss') return;
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
  const safety = safetySummary();
  let unobserved = 0;
  let hit = 0, miss = 0, cost = 0, wall = 0, twin = 0, routeHit = 0, routeMiss = 0, errors = 0, spray = 0, spurious = 0;
  for (const row of cases) {
    const bucket = by_workflow[row.workflow] ??= {
      n: 0, hit: 0, miss: 0, not_expected: 0, no_gold: 0, spray: 0, spurious: 0, field_accuracy: null,
      p50_ms: null, p95_ms: null, p50_s: null, p95_s: null, cost_usd: 0, cost_per_email_usd: null, unpriced_cases: 0,
      route_acc: null, disposition_acc: null, p0_acc: emptyWeighted(), p1_acc: emptyWeighted(), p2_acc: emptyWeighted(), roi_score: 0, safety_violations: 0, quote_capture_count: 0,
      tier1_core: emptyTier(), tier2_defaults: emptyTier(),
      history_knowable: emptyTier(), workflow_routing: emptyTier(), parity: emptyTier(),
    };
    bucket.n += 1;
    bucket.cost_usd += row.cost_usd ?? 0;
    bucket.unpriced_cases += Number(row.cost_usd === null);
    cost += row.cost_usd ?? 0;
    bucket.quote_capture_count += Number(row.quote_capture_ok);
    bucket.safety_violations += Number(Object.values(row.safety_flags).some(Boolean));
    safety.vcc_false_filing += Number(row.safety_flags.vcc_false_filing);
    safety.staff_reply_false_action += Number(row.safety_flags.staff_reply_false_action);
    safety.wrong_target += Number(row.safety_flags.wrong_target);
    safety.spurious_action += row.spurious_action_count;
    unobserved += Number(row.twin_uncovered.length > 0);
    wall = Math.max(wall, row.wall_ms);
    twin += Number(row.twin_uncovered.some(reason => reason.endsWith(':TWIN_NO_PRICE')));
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
    const rows = cases.filter(c => c.workflow === wf);
    const walls = rows.map(c => c.wall_ms);
    bucket.route_acc = mean(rows.map(c => Number(c.route_ok)));
    bucket.disposition_acc = mean(rows.map(c => Number(c.disposition_ok)));
    bucket.roi_score = mean(rows.map(c => c.roi_score)) ?? 0;
    const fields = rows.flatMap(c => c.fields);
    bucket.p0_acc = roiFields(fields, ['P0']);
    bucket.p1_acc = roiFields(fields, ['P1']);
    bucket.p2_acc = roiFields(fields, ['P2']);
    bucket.cost_per_email_usd = bucket.unpriced_cases ? null : bucket.cost_usd / bucket.n;
    bucket.p50_ms = percentile(walls, 0.5);
    bucket.p95_ms = percentile(walls, 0.95);
    bucket.p50_s = (bucket.p50_ms ?? 0) / 1000;
    bucket.p95_s = (bucket.p95_ms ?? 0) / 1000;
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
    roi_score: {micro: mean(cases.map(row => row.roi_score)), workflow_macro: mean(Object.values(by_workflow).map(row => row.roi_score))},
    safety,
    vcc_false_filing_count: safety.vcc_false_filing,
    staff_reply_false_action_count: safety.staff_reply_false_action,
    wrong_target_count: safety.wrong_target,
    spurious_action_count: safety.spurious_action,
    twin_unobserved_count: unobserved,
    run_error_count: errors,
    by_workflow,
    by_priority,
    by_source,
    totals: {
      hit, miss, cost_usd: cases.some(row => row.cost_usd === null) ? null : cost, wall_ms: wall, twin_no_price: twin,
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

export type ReplayProvenance = Pick<RulerStamp, 'skills_digest' | 'world_dir' | 'model' | 'reasoning_effort'>;

export function rulerStamp(gold_file: string | null, gold_sha256: string | null, provenance: ReplayProvenance): RulerStamp {
  const git_sha = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  const git_dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {encoding: 'utf8'}).length > 0;
  return {scorer_sha: git_sha, git_sha, git_dirty, gold_file, gold_sha256, ...provenance};
}

export function gepaFeedback(score: CaseScore) {
  const compact = (value: unknown) => value != null && typeof value === 'object'
    ? JSON.stringify(value).slice(0, 220) : typeof value === 'string' ? value.slice(0, 220) : value;
  return {
    case_id: score.case_id,
    workflow: score.workflow,
    roi_score: score.roi_score,
    route_ok: score.route_ok,
    expected_units: score.expected_units,
    actual_units: score.actual_units,
    failure_reason: score.failure_reason,
    gold_workflow: score.workflow,
    pred_workflow: dig(score.proposal, '/workflow') ?? null,
    safety_flags: score.safety_flags,
    field_diffs: {
      hits: score.fields.filter(field => field.path !== '/workflow' && field.knowable !== false && field.result === 'hit').length,
      misses: score.fields.filter(field => field.path !== '/workflow' && field.knowable !== false && field.result === 'miss')
        .map(field => ({path: field.path, expected: compact(field.expected), actual: compact(field.actual) ?? null})),
    },
    tool_trace_summary: score.tool_quality.calls.map(call => ({tool: call.name, args: call.input, ok: call.ok, hits: call.hits, error: call.error})),
    warnings: [...score.twin_uncovered, ...array(dig(score.proposal, '/warnings')).map(compact),
      ...(score.publish_invalid ? [`publish_invalid:${score.publish_invalid}`] : []),
      ...(score.run_error ? [score.run_error] : []), ...(!score.disposition_ok ? ['disposition_miss'] : [])],
    latency_ms: score.wall_ms,
    cost_usd: score.cost_usd,
  };
}
