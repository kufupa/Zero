import { htmlToPlainText } from '../mail/inbound-reaction-parser.js';
import {
  harvestStayDates,
  parseNeededTools,
  parseOccupancyFromBody,
  stripQuotedHistory,
} from '../ops/centurion-eval-lab.js';
import type { CenturionCorpusMessageRow } from '../ops/centurion-thread-corpus-postgres-reader.js';
import { QUOTE_STUB_NOT_ORACLE, type ReservationistDecision } from './reservationist-agent.js';

export const STRATA = ['quote_party', 'quote_fit', 'create', 'no_tool', 'other'] as const;
export type Stratum = (typeof STRATA)[number];

export type CaseMessage = {
  id: string;
  direction: string;
  eventAt: string | null;
  from: string;
  subject: string;
  text: string;
};

export type BacktestCase = {
  threadId: string;
  trigger: CaseMessage;
  context: CaseMessage[];
  goldId: string;
  goldText: string;
  stratum: Stratum;
  oracle: { quote: boolean; party: boolean; create: boolean };
};

export type ToolCall = { toolName: string; args: unknown; result: unknown };

const QUOTE_SECONDS = 220;
const UNSENT_QUEUE_STATES = new Set(['pending', 'sending', 'cancelled']);
const EMPTY_REPLY_RE = /^\s*(?:From:\s|-----Original Message-----)/i;

function textOf(row: CenturionCorpusMessageRow): string {
  return row.textBody?.trim() ? row.textBody : htmlToPlainText(row.htmlBody ?? '');
}

function toCaseMessage(row: CenturionCorpusMessageRow): CaseMessage {
  return {
    id: row.id,
    direction: row.businessDirection,
    eventAt: row.eventAt,
    from: row.from.join(', '),
    subject: row.subject,
    text: textOf(row),
  };
}

const AMOUNT_RE = /\b(?:R|ZAR)\s?(\d{1,3}(?:[ ,]\d{3})+|\d+)(?:[.,]\d{2})?\b/g;

export function amountsIn(text: string): Set<number> {
  return new Set([...text.matchAll(AMOUNT_RE)].map((m) => Number(m[1]!.replace(/[ ,]/g, ''))));
}

function numbersIn(value: unknown, out = new Set<number>()): Set<number> {
  if (typeof value === 'number') out.add(Math.round(value));
  else if (Array.isArray(value)) for (const v of value) numbersIn(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) numbersIn(v, out);
  return out;
}

function classify(triggerText: string, goldText: string) {
  const { floor } = parseNeededTools(triggerText);
  const group = floor.hms_group_block_read;
  const quote = (floor.hms_quote_stay || amountsIn(stripQuotedHistory(goldText)).size > 0) && !group;
  const party = quote && floor.hms_company_account_read;
  const create = floor.hms_create_reservation && !quote;
  const anyTool = Object.values(floor).some(Boolean);
  const stratum: Stratum = party
    ? 'quote_party'
    : quote
      ? 'quote_fit'
      : create
        ? 'create'
        : anyTool || group
          ? 'other'
          : 'no_tool';
  return { stratum, oracle: { quote, party, create } };
}

function latestFirst(cases: readonly BacktestCase[]) {
  return [...cases].sort(
    (a, b) => (b.trigger.eventAt ?? '').localeCompare(a.trigger.eventAt ?? '') || a.threadId.localeCompare(b.threadId),
  );
}

const byEventAt = (a: CenturionCorpusMessageRow, b: CenturionCorpusMessageRow) =>
  (a.eventAt ?? '9999').localeCompare(b.eventAt ?? '9999') || a.id.localeCompare(b.id);

export function buildCases(rows: readonly CenturionCorpusMessageRow[]): BacktestCase[] {
  const threads = new Map<string, CenturionCorpusMessageRow[]>();
  for (const row of rows) {
    if (!row.threadId || !row.eventAt) continue;
    threads.set(row.threadId, [...(threads.get(row.threadId) ?? []), row]);
  }
  const cases: BacktestCase[] = [];
  for (const [threadId, list] of threads) {
    list.sort(byEventAt);
    const goldIndex = list.findIndex(
      (row, i) =>
        row.businessDirection === 'outbound' &&
        row.scope === 'in_window' &&
        !UNSENT_QUEUE_STATES.has(row.queueState ?? '') &&
        list.slice(0, i).some((prior) => prior.businessDirection === 'inbound'),
    );
    if (goldIndex < 0) continue;
    const gold = list[goldIndex]!;
    const before = list.slice(0, goldIndex);
    const triggerIndex = gold.inReplyTo
      ? before.findIndex((row) => row.businessDirection === 'inbound' && row.messageId === gold.inReplyTo)
      : before.map((row) => row.businessDirection).lastIndexOf('inbound');
    if (triggerIndex < 0) continue;
    const goldText = textOf(gold);
    if (EMPTY_REPLY_RE.test(goldText)) continue;
    const trigger = toCaseMessage(before[triggerIndex]!);
    cases.push({
      threadId,
      trigger,
      context: before.slice(0, triggerIndex).map(toCaseMessage),
      goldId: gold.id,
      goldText,
      ...classify(`${trigger.subject}\n${trigger.text}`, goldText),
    });
  }
  return latestFirst(cases);
}

const PHASE_A_QUOTAS: Record<Stratum, number> = {
  quote_party: 1,
  quote_fit: 3,
  create: 2,
  no_tool: 2,
  other: 2,
};

export function pickPhaseA(cases: readonly BacktestCase[], size = 15) {
  const sorted = latestFirst(cases);
  const picked: BacktestCase[] = [];
  const emptyStrata: Stratum[] = [];
  for (const stratum of STRATA) {
    const pool = sorted.filter((c) => c.stratum === stratum);
    if (!pool.length) emptyStrata.push(stratum);
    picked.push(...pool.slice(0, PHASE_A_QUOTAS[stratum]));
  }
  const fill = sorted.filter((c) => !c.oracle.quote && !picked.includes(c));
  picked.push(...fill.slice(0, Math.max(0, size - picked.length)));
  return { picked: latestFirst(picked), emptyStrata };
}

export function describeRun(cases: readonly BacktestCase[]) {
  const quoteShaped = cases.filter((c) => c.oracle.quote).length;
  return {
    n: cases.length,
    quoteShaped,
    createShaped: cases.filter((c) => c.oracle.create).length,
    strata: Object.fromEntries(STRATA.map((s) => [s, cases.filter((c) => c.stratum === s).length])),
    hmsEtaMinutesUpperBound: Math.ceil((quoteShaped * QUOTE_SECONDS) / 60),
  };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = MONTHS.join('|');
const DATE_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => [number, number, number]]> = [
  [/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => [+m[1]!, +m[2]!, +m[3]!]],
  [/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/, (m) => [+m[3]!, +m[2]!, +m[1]!]],
  [
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})[a-z]*\\.?(?:,?\\s+(\\d{4}))?`, 'i'),
    (m) => [+(m[3] ?? 2026), MONTHS.indexOf(m[2]!.toLowerCase()) + 1, +m[1]!],
  ],
  [
    new RegExp(`\\b(${MON})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'i'),
    (m) => [+(m[3] ?? 2026), MONTHS.indexOf(m[1]!.toLowerCase()) + 1, +m[2]!],
  ],
];

export function toIsoDay(raw: string): string | null {
  let best: { index: number; ymd: [number, number, number] } | null = null;
  for (const [re, pick] of DATE_PATTERNS) {
    const m = re.exec(raw);
    if (m && (!best || m.index < best.index)) best = { index: m.index, ymd: pick(m) };
  }
  if (!best) return null;
  const [y, mo, d] = best.ymd;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export type L1Row = {
  threadId: string;
  stratum: Stratum;
  workflow: ReservationistDecision['workflow'] | null;
  workflowOk: boolean;
  quoteCalled: boolean;
  quoteLive: boolean;
  quoteFalsePositive: boolean;
  quoteMiss: boolean;
  partyCalled: boolean;
  partyMiss: boolean;
  createCalled: boolean;
  createValid: boolean | null;
  createMiss: boolean;
  pdfCalled: boolean;
  datesOk: boolean | null;
  paxOk: boolean | null;
  money: 'match' | 'rate_stale' | 'extract_fail' | 'rate_missing' | 'n/a';
  hmsElapsedMs: number;
  pass: boolean;
};

export function scoreCase(
  c: BacktestCase,
  decision: ReservationistDecision | null,
  calls: readonly ToolCall[],
): L1Row {
  const named = (name: string) => calls.filter((call) => call.toolName === name);
  const quotes = named('quote_stay');
  const liveQuotes = quotes.filter(
    (call) => (call.result as { status?: string } | null)?.status !== QUOTE_STUB_NOT_ORACLE,
  );
  const creates = named('create_reservation_dry_run');
  const workflow = decision?.workflow ?? null;
  const expected = c.oracle.quote ? 'quote' : c.oracle.create ? 'create' : null;
  const workflowOk = expected ? workflow === expected : workflow !== null && workflow !== 'quote' && workflow !== 'create';

  const triggerText = `${c.trigger.subject}\n${c.trigger.text}`;
  const harvested = harvestStayDates(triggerText).arrival;
  const goldArrival = harvested ? toIsoDay(harvested) : null;
  const datesOk = goldArrival && decision?.stayAsk ? decision.stayAsk.arrivalDate === goldArrival : null;
  const pax = parseOccupancyFromBody(triggerText).paxTotal;
  const paxOk = pax != null && decision?.stayAsk ? decision.stayAsk.adults + decision.stayAsk.children === pax : null;

  const gold = amountsIn(stripQuotedHistory(c.goldText));
  const draft = amountsIn(decision?.replyDraft ?? '');
  const grounded = numbersIn(liveQuotes.map((call) => call.result));
  for (const text of [triggerText, ...c.context.map((m) => m.text)]) for (const n of amountsIn(text)) grounded.add(n);
  const draftList = [...draft];
  const money: L1Row['money'] = draftList.some((n) => !grounded.has(n))
    ? 'extract_fail'
    : !gold.size
      ? 'n/a'
      : !draft.size
        ? 'rate_missing'
        : draftList.some((n) => gold.has(n))
          ? 'match'
          : 'rate_stale';

  const row = {
    threadId: c.threadId,
    stratum: c.stratum,
    workflow,
    workflowOk,
    quoteCalled: quotes.length > 0,
    quoteLive: liveQuotes.length > 0,
    quoteFalsePositive: quotes.length > 0 && !c.oracle.quote,
    quoteMiss: c.oracle.quote && quotes.length === 0,
    partyCalled: named('party_lookup').length > 0,
    partyMiss: c.oracle.party && named('party_lookup').length === 0,
    createCalled: creates.length > 0,
    createValid: creates.length ? creates.some((call) => (call.result as { ok?: boolean })?.ok === true) : null,
    createMiss: c.oracle.create && creates.length === 0,
    pdfCalled: named('quote_proposal_pdf').length > 0,
    datesOk,
    paxOk,
    money,
    hmsElapsedMs: liveQuotes.reduce(
      (sum, call) => sum + Number((call.result as { elapsedMs?: number })?.elapsedMs ?? 0),
      0,
    ),
  };
  const pass =
    row.workflowOk &&
    !row.quoteFalsePositive &&
    !row.quoteMiss &&
    !row.partyMiss &&
    !row.createMiss &&
    datesOk !== false &&
    paxOk !== false &&
    money !== 'extract_fail' &&
    money !== 'rate_missing';
  return { ...row, pass };
}

export function summarizeL1(rows: readonly L1Row[]) {
  const count = (pred: (r: L1Row) => boolean) => rows.filter(pred).length;
  return {
    n: rows.length,
    pass: count((r) => r.pass),
    workflowOk: count((r) => r.workflowOk),
    quoteFalsePositive: count((r) => r.quoteFalsePositive),
    quoteMiss: count((r) => r.quoteMiss),
    quoteLive: count((r) => r.quoteLive),
    partyMiss: count((r) => r.partyMiss),
    createMiss: count((r) => r.createMiss),
    createInvalid: count((r) => r.createValid === false),
    datesWrong: count((r) => r.datesOk === false),
    paxWrong: count((r) => r.paxOk === false),
    money: Object.fromEntries(
      ['match', 'rate_stale', 'extract_fail', 'rate_missing', 'n/a'].map((m) => [m, count((r) => r.money === m)]),
    ),
    hmsHours: +(rows.reduce((s, r) => s + r.hmsElapsedMs, 0) / 3_600_000).toFixed(2),
    byStratum: Object.fromEntries(
      STRATA.map((s) => [s, { n: count((r) => r.stratum === s), pass: count((r) => r.stratum === s && r.pass) }]),
    ),
  };
}
