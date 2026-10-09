import { fingerprint } from './reservationist-replay.js';
import {occupiedDates,quoteDigest} from '../quote-proposal/quote-revision.js';
import { existsSync, readFileSync } from 'node:fs';
import { htmlToPlainText } from '../mail/inbound-reaction-parser.js';
import {
  harvestStayDates,
  parseNeededTools,
  parseOccupancyFromBody,
  stripQuotedHistory,
} from '../ops/centurion-eval-lab.js';
import type { CenturionCorpusMessageRow } from '../ops/centurion-thread-corpus-postgres-reader.js';
import { type ReservationistDecision } from './reservationist-agent.js';
import { reservationistDecisionSchema } from './reservationist-decision.js';
import { z } from 'zod';

export const STRATA = ['quote_party', 'quote_fit', 'create', 'no_tool', 'other'] as const;
export type Stratum = (typeof STRATA)[number];

export type CaseMessage = {
  id: string;
  direction: string;
  eventAt: string | null;
  from: string;
  subject: string;
  text: string;
  documents?: CenturionCorpusMessageRow['attachmentDescriptors'];
};

export type BacktestCase = {
  approvedFacts?: { requiredCalls: Array<{ toolName: string; args: unknown }>; bodyClauses: string[]; moneyCents: number[] };
  caseId?: string;
  goldEpisodeId?: string | null;
  goldObligations?: string[];
  coverage?: 'paired' | 'no-gold' | 'missing-time';
  pairing?: 'in-reply-to' | 'bounded-subject' | 'none';
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
const PARTY_RATE_RE =
  /\b(?:corporate|negotiated|contract(?:ed)?|agent|agency|sto|net)\s+rates?\b|\bon account\b|\bcompany account\b/i;
const REPLY_SUBJECT_RE = /^\s*re\s*:/i;
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
    documents: row.attachmentDescriptors ?? [],
  };
}

const AMOUNT_RE = /\b(?:R|ZAR)\s?(\d{1,3}(?:[ ,]\d{3})+|\d+)(?:[.,](\d{2}))?\b/g;

export function amountsIn(text: string): Set<number> {
  return new Set([...text.matchAll(AMOUNT_RE)].map((m) => Number(m[1]!.replace(/[ ,]/g, '')) * 100 + Number(m[2] ?? 0)));
}

function numbersIn(value: unknown, out = new Set<number>(), key = ''): Set<number> {
  if (/^(?:amount|total|rate|stayTotal|nightlyRate|displayedAmount)$/.test(key)) {
    if (typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d{1,2})?$/.test(value)) out.add(Math.round(Number(value) * 100));
  }
  if (Array.isArray(value)) for (const v of value) numbersIn(v, out, key);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) numbersIn(v, out, k);
  return out;
}

const createSchema = JSON.parse(readFileSync(new URL('../../tooling/playwright-quote/create-tool.schema.json', import.meta.url), 'utf8'));
function validPacket(value: unknown, schema: any = createSchema.$defs.request): boolean {
  if (schema.$ref) schema = createSchema.$defs[schema.$ref.replace('#/$defs/', '')];
  if (!schema) return false;
  if (schema.oneOf) return schema.oneOf.some((s: any) => validPacket(value, s));
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (schema.required?.some((k: string) => !(k in record))) return false;
    return Object.entries(record).every(([k, v]) => schema.properties?.[k] ? validPacket(v, schema.properties[k]) : schema.additionalProperties !== false);
  }
  if (schema.type === 'array') return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.every(v => validPacket(v, schema.items));
  if (schema.type === 'string') return typeof value === 'string' && value.length >= (schema.minLength ?? 0) && (!schema.pattern || new RegExp(schema.pattern).test(value));
  if (schema.type === 'integer') return Number.isInteger(value) && Number(value) >= (schema.minimum ?? -Infinity);
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return true;
}

function classify(triggerText: string, _goldText: string) {
  const { floor } = parseNeededTools(triggerText);
  const group = floor.hms_group_block_read;
  const quote = floor.hms_quote_stay && !group;
  const party = quote && (floor.hms_company_account_read || PARTY_RATE_RE.test(triggerText));
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
  const sorted = [...rows].sort(byEventAt);
  const replies = sorted.filter(row => row.businessDirection === 'outbound' && row.scope === 'in_window' && !UNSENT_QUEUE_STATES.has(row.queueState ?? '') && !EMPTY_REPLY_RE.test(textOf(row)));
  const normalize = (s: string) => s.replace(/^(?:\s*(?:re|fw|fwd)\s*:\s*)+/i, '').trim().toLowerCase();
  return latestFirst(sorted.filter(row => row.businessDirection === 'inbound' && row.scope === 'in_window').map(trigger => {
    const direct = replies.find(g => trigger.messageId && g.inReplyTo === trigger.messageId && byEventAt(trigger, g) < 0);
    const fallback = replies.find(g => !g.inReplyTo && REPLY_SUBJECT_RE.test(g.subject) && normalize(g.subject) === normalize(trigger.subject) && trigger.eventAt && g.eventAt && Date.parse(g.eventAt) > Date.parse(trigger.eventAt) && Date.parse(g.eventAt) - Date.parse(trigger.eventAt) <= 48 * 3600000 && !sorted.some(m => m.businessDirection === 'inbound' && m !== trigger && normalize(m.subject) === normalize(trigger.subject) && byEventAt(trigger, m) < 0 && byEventAt(m, g) < 0));
    const gold = direct ?? fallback;
    const message = toCaseMessage(trigger);
    return { caseId: trigger.id, threadId: trigger.threadId ?? '', trigger: message,
      context: sorted.filter(m => m.threadId === trigger.threadId && m.eventAt && trigger.eventAt && Date.parse(m.eventAt) < Date.parse(trigger.eventAt)).map(toCaseMessage),
      goldEpisodeId: gold?.id ?? null, goldObligations: gold ? sorted.filter(m => m.businessDirection === 'inbound' && m.threadId === trigger.threadId && byEventAt(m, gold) < 0).map(m => m.id) : [], coverage: !trigger.eventAt ? 'missing-time' : gold ? 'paired' : 'no-gold', goldId: gold?.id ?? '', goldText: gold ? textOf(gold) : '', pairing: direct ? 'in-reply-to' : fallback ? 'bounded-subject' : 'none',
      ...classify(`${message.subject}\n${message.text}`, '') };
  }));
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
const DATE_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => [number | null, number, number]]> = [
  [/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => [+m[1]!, +m[2]!, +m[3]!]],
  [/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/, (m) => [+m[3]!, +m[2]!, +m[1]!]],
  [
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})[a-z]*\\.?(?:,?\\s+(\\d{4}))?`, 'i'),
    (m) => [m[3] ? +m[3] : null, MONTHS.indexOf(m[2]!.toLowerCase()) + 1, +m[1]!],
  ],
  [
    new RegExp(`\\b(${MON})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'i'),
    (m) => [m[3] ? +m[3] : null, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, +m[2]!],
  ],
];

/** A day-month without a year resolves to its next occurrence on or after `asOf`. */
export function toIsoDay(raw: string, asOf?: string | null): string | null {
  let best: { index: number; ymd: [number | null, number, number] } | null = null;
  for (const [re, pick] of DATE_PATTERNS) {
    const m = re.exec(raw);
    if (m && (!best || m.index < best.index)) best = { index: m.index, ymd: pick(m) };
  }
  if (!best) return null;
  const [year, mo, d] = best.ymd;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ref = asOf && Number.isFinite(Date.parse(asOf)) ? new Date(Date.parse(asOf) + 2 * 3600000).toISOString().slice(0, 10) : null;
  let y = year ?? Number(ref?.slice(0, 4) ?? NaN);
  if (!Number.isFinite(y)) return null;
  const iso = (yy: number) => `${yy}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (year == null && ref && iso(y) < ref) y += 1;
  return new Date(`${iso(y)}T00:00:00Z`).toISOString().slice(0, 10) === iso(y) ? iso(y) : null;
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
  const liveQuotes = c.oracle.quote
    ? quotes.filter((call) => (call.result as { outcome?: string } | null)?.outcome === 'quote' && Array.isArray((call.result as { groups?: unknown })?.groups) && ((call.result as { groups: unknown[] }).groups.length > 0) && (call.result as { bookable?: boolean }).bookable === true && (call.result as { occupancyPriced?: boolean }).occupancyPriced === true && !((call.result as { unresolvedInputs?: unknown[] }).unresolvedInputs?.length))
    : [];
  const creates = named('create_reservation_dry_run');
  const workflow = decision?.workflow ?? null;
  const expected = c.oracle.quote ? 'quote' : c.oracle.create ? 'create' : null;
  const workflowOk = expected ? workflow === expected : workflow !== null && workflow !== 'quote' && workflow !== 'create';

  const triggerText = `${c.trigger.subject}\n${c.trigger.text}`;
  const harvested = harvestStayDates(triggerText).arrival;
  const goldArrival = harvested ? toIsoDay(harvested, c.trigger.eventAt) : null;
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
    quoteMiss: c.oracle.quote && liveQuotes.length === 0,
    partyCalled: named('party_lookup').length > 0,
    partyMiss: c.oracle.party && !named('party_lookup').some(call => (call.result as { outcome?: string })?.outcome === 'match' && Array.isArray((call.result as { candidates?: unknown })?.candidates) && ((call.result as { candidates: unknown[] }).candidates.length > 0)),
    createCalled: creates.length > 0,
    createValid: creates.length ? creates.some(call => { const r = call.result as { ok?: boolean; errors?: unknown[]; dryRun?: boolean; saved?: boolean }; return r?.ok === true && r.dryRun === true && r.saved === false && Array.isArray(r.errors) && !r.errors.length && validPacket((call.args as { request?: unknown })?.request); }) : null,
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
  const pdfs = named('quote_proposal_pdf');
  const artifactsOk = pdfs.every(call => {
    const r = call.result as { path?: string; bytes?: number };
    try { const bytes = readFileSync(r.path ?? ''); return bytes.length > 4 && bytes.length === r.bytes && bytes.subarray(0, 5).toString() === '%PDF-'; } catch { return false; }
  });
  const departure = harvestStayDates(triggerText).departure;
  const departureOk = !departure || decision?.stayAsk?.departureDate === toIsoDay(departure, c.trigger.eventAt);
  const assertionsOk = !c.oracle.quote && !c.oracle.create || Boolean(c.approvedFacts && c.approvedFacts.requiredCalls.length && c.approvedFacts.requiredCalls.every(expected => calls.some(call => call.toolName === expected.toolName && fingerprint(call.args) === fingerprint(expected.args))) && c.approvedFacts.bodyClauses.length && c.approvedFacts.bodyClauses.every(clause => decision?.replyDraft.includes(clause)) && [...draft].every(amount => c.approvedFacts!.moneyCents.includes(amount)));
  const pass =
    assertionsOk && artifactsOk && departureOk &&
    row.workflowOk &&
    !row.quoteFalsePositive &&
    !row.quoteMiss &&
    !row.partyMiss &&
    !row.createMiss &&
    (!c.oracle.create || row.createValid === true) &&
    datesOk !== false &&
    paxOk !== false &&
    money !== 'extract_fail' &&
    money !== 'rate_missing' &&
    (!c.oracle.quote || (datesOk === true && paxOk === true)) &&
    (workflow === 'skip' || workflow === 'spam' || Boolean(decision?.replyDraft.trim()));
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

export type PendingActionReplayAssertion={kind:'change'|'cancel_request';taskId:string;reservationRef:string;current:{arrivalDate:string;departureDate:string};requested?:{arrivalDate:string;departureDate:string};sourceRefs:string[];digest?:string};
export type BookingReplayAssertion={kind:'accepted_quote'|'new_booking';taskId:string;revisionId:string;scopeDigest:string;currency:string;totalMinor:number};
export type RuntimeReplayAssertions={tasks:{id:string;status:string;evidenceRefs:string[]}[];bodyClauses:string[];moneyCents:number[];artifacts:{ref:string;sha256:string;sizeBytes:number}[];quoteRefs:string[];packetRequired:boolean;bookingPackets?:BookingReplayAssertion[];packetRooms?:import('./reservationist-booking-packet.js').BookingPacket['rooms'];pendingActions?:PendingActionReplayAssertion[];quoteTotals?:{ref:string;totalMinor:number}[]};
export function scoreRuntimeReplay(runtime:Record<string,any>|undefined,approved:RuntimeReplayAssertions|undefined,mode:'authoritative_source_replay'|'deterministic_work_fixture'){
 const failures:string[]=[];
 if(!runtime||!approved)return {pass:false,qualificationEligible:false,failures:['missing_runtime_assertions']};
 const same=(a:unknown,b:unknown)=>fingerprint(a)===fingerprint(b);
 if(!same(runtime.tasks?.map((t:any)=>({id:t.id,status:t.status,evidenceRefs:t.evidenceRefs})),approved.tasks))failures.push('task_obligation_mismatch');
 if(!approved.bodyClauses.length||approved.bodyClauses.some(c=>!runtime.textBody?.includes(c))||[...amountsIn(runtime.textBody??'')].some(c=>!approved.moneyCents.includes(c)))failures.push('body_literal_mismatch');
 if(!same(runtime.artifacts?.map((a:any)=>({ref:a.ref,sha256:a.sha256,sizeBytes:a.sizeBytes})),approved.artifacts)||!same(runtime.quoteRefs,approved.quoteRefs))failures.push('artifact_or_quote_identity_mismatch');
 if(approved.quoteTotals?.some(q=>![...(runtime.quoteRevisions??[]),...(runtime.importedOffers??[]),...(runtime.approvedOverrides??[])].some((offer:any)=>offer.id===q.ref&&(offer.approvedTotalMinor??offer.totalMinor)===q.totalMinor)))failures.push('quote_total_unproven');
 const rawPackets=runtime.packets??[],packets=Array.isArray(rawPackets)?rawPackets:[];
 const actions=packets.filter((p:any)=>p&&['change','cancel_request'].includes(p.kind)),bookings=packets.filter((p:any)=>!p||!['change','cancel_request'].includes(p.kind));
 if(!Array.isArray(rawPackets)||approved.packetRequired&&!bookings.length||bookings.some((p:any)=>!p||!['accepted_quote','new_booking'].includes(p.kind)||!p.taskId||!p.revisionId||!p.scopeDigest||!/^[A-Z]{3}$/.test(p.currency??'')||!Number.isSafeInteger(p.totalMinor)||p.totalMinor<0||p.nativePriceApplication!=='pending_staff_review'||p.saved!==false||p.status!=='pending_pms_action'||p.schemaValid!==true||p.businessRulesValidated!==true||p.nativeSaveAcceptance!=='untested'||!Array.isArray(p.rooms)||p.rooms.length<1||p.rooms.length>96))failures.push('invalid_booking_packet');
 if(approved.packetRequired||bookings.length){
  const project=(p:any)=>p?({kind:p.kind,taskId:p.taskId,revisionId:p.revisionId,scopeDigest:p.scopeDigest,currency:p.currency,totalMinor:p.totalMinor}):null;
  if(!Array.isArray(approved.bookingPackets)||!approved.bookingPackets.length||!same(bookings.map(project),approved.bookingPackets.map(project))||bookings.some((packet:any)=>{const task=runtime.tasks?.find((t:any)=>t.id===packet.taskId);return !task||task.status!=='pending_pms_action'||(task.kind==='acceptance'?'accepted_quote':task.kind==='new_booking'?'new_booking':null)!==packet.kind;}))failures.push('booking_price_postcondition_mismatch');
  const expected=approved.packetRooms;
  const rooms=bookings.flatMap((packet:any)=>Array.isArray(packet?.rooms)?packet.rooms:[]);
  if(!Array.isArray(expected)||!expected.length||expected.length>96||rooms.length>96||expected.some(room=>!room||!room.groupId||!Number.isInteger(room.roomIndex)||room.roomIndex<1||!room.pricing||!Array.isArray(room.guests)||!room.guests.length||!room.request)||!same(rooms,expected))failures.push('booking_room_postcondition_mismatch');
 }
 if(actions.length||approved.pendingActions?.length){
  const expected=approved.pendingActions;
  const projection=(p:any)=>p?({kind:p.kind,taskId:p.taskId,reservationRef:p.reservationRef,current:p.current,...(p.requested!==undefined?{requested:p.requested}:{}),sourceRefs:p.sourceRefs}):null;
  const valid=(p:any)=>{try{
   const task=runtime.tasks?.find((t:any)=>t.id===p.taskId),{digest,...data}=p;
   if(p.saved!==false||p.status!=='pending_pms_action'||p.businessRulesValidated!==true||!Array.isArray(p.errors)||p.errors.length||!p.taskId||!p.reservationRef||!Array.isArray(p.sourceRefs)||p.sourceRefs.length<2||p.sourceRefs.some((ref:any)=>typeof ref!=='string'||!ref)||!task||task.kind!==p.kind||task.status!=='pending_pms_action'||!same(task.evidenceRefs,p.sourceRefs)||!digest||digest!==quoteDigest(data))return false;
   occupiedDates(p.current.arrivalDate,p.current.departureDate);
   if(p.kind==='change'){if(!p.requested)return false;occupiedDates(p.requested.arrivalDate,p.requested.departureDate);}else if(p.requested!==undefined)return false;
   return true;
  }catch{return false;}};
  if(!Array.isArray(expected)||expected.length>32||actions.length>32||actions.some((p:any)=>!valid(p))||!same(actions.map(projection),expected?.map(projection))||expected?.some((p:any)=>!p||!['change','cancel_request'].includes(p.kind)||p.digest!==undefined&&p.digest!==actions.find((a:any)=>a.taskId===p.taskId)?.digest)||runtime.readiness!=='pending_pms_action')failures.push('pending_action_postcondition_mismatch');
 }
 if(runtime.errors?.length||runtime.assessment?.ok!==true||!['ready_for_staff_review','pending_pms_action','needs_clarification'].includes(runtime.readiness))failures.push('runtime_not_ready');
 const qualificationEligible=mode==='authoritative_source_replay';
 if(!qualificationEligible)failures.push('deterministic_work_not_qualification');
 return {pass:failures.length===0,qualificationEligible,failures};
}

// ---- Golden set: operator-built JSONL, replayed HMS reads, field-level scoring (R20, U27) ----
// Input, gitignored and never built from prod here: apps/server-pilot/.private/reservationist-backtest/golden-set.jsonl
// One goldenRowSchema object per line: 80 dev and 40 holdout cases.

export const GOLDEN_TARGETS = { dev: 80, holdout: 40, maxDomainShare: 0.15, overfitGapPoints: 10 } as const;
const GOLDEN_FIELDS = ['workflow', 'arrivalDate', 'departureDate', 'adults', 'children', 'rooms'] as const;
export type GoldenField = (typeof GOLDEN_FIELDS)[number];
type Scalar = string | number | null;

const caseMessageSchema = z.object({
  id: z.string().min(1),
  direction: z.string(),
  eventAt: z.string().nullable(),
  from: z.string(),
  subject: z.string(),
  text: z.string(),
});
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

const goldenRowSchema = z.object({
  id: z.string().min(1),
  split: z.enum(['dev', 'holdout']),
  type: z.enum(STRATA),
  trigger: caseMessageSchema,
  context: z.array(caseMessageSchema),
  // A key left out of `expected` is unscored. `null` means the decision must not assert that field.
  expected: z
    .object({
      workflow: reservationistDecisionSchema.shape.workflow.nullable(),
      arrivalDate: isoDay,
      departureDate: isoDay,
      adults: z.number().int().nullable(),
      children: z.number().int().nullable(),
      rooms: z.number().int().nullable(),
    })
    .partial(),
  // Recorded HMS reads, each keyed by the runner request it answered (see replayRunners).
  recordedReads: z
    .array(
      z.object({
        toolName: z.enum(['quote_stay', 'party_lookup']),
        args: z.record(z.string(), z.unknown()),
        result: z.record(z.string(), z.unknown()),
      }),
    )
    .default([]),
});
export type GoldenRow = z.infer<typeof goldenRowSchema>;

/** Lowercased domain of the first address in `from`, or 'unknown'. */
export function senderDomainOf(from: string): string {
  return /@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(from)?.[1]?.toLowerCase() ?? 'unknown';
}

/** Stratification cell: request type x sender domain. */
export const cellOf = (row: GoldenRow) => `${row.type}|${senderDomainOf(row.trigger.from)}`;

export function tally<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

/** Empty when the set meets the 80 dev / 40 holdout targets and no sender domain exceeds 15% of its split. */
export function validateGoldenSet(rows: readonly GoldenRow[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) problems.push(`duplicate id ${row.id}`);
    seen.add(row.id);
  }
  for (const split of ['dev', 'holdout'] as const) {
    const part = rows.filter((row) => row.split === split);
    if (part.length !== GOLDEN_TARGETS[split]) problems.push(`${split}: ${part.length} cases, need ${GOLDEN_TARGETS[split]}`);
    for (const [domain, n] of Object.entries(tally(part, (row) => senderDomainOf(row.trigger.from)))) {
      if (n / part.length > GOLDEN_TARGETS.maxDomainShare) {
        problems.push(`${split}: sender domain ${domain} holds ${n} of ${part.length} cases, over ${GOLDEN_TARGETS.maxDomainShare * 100}%`);
      }
    }
  }
  return problems;
}

/**
 * Deterministic subset at the set's dev:holdout ratio (30 gives 20 + 10). Round-robin over type x domain cells:
 * each pass takes one case from every cell that still has one, so cells are covered before any repeats.
 */
export function pickSubset<T extends GoldenRow>(rows: readonly T[], size = 30): T[] {
  const devQuota = Math.round((size * GOLDEN_TARGETS.dev) / (GOLDEN_TARGETS.dev + GOLDEN_TARGETS.holdout));
  const quota = { dev: devQuota, holdout: size - devQuota } as const;
  const picked: T[] = [];
  for (const split of ['dev', 'holdout'] as const) {
    const cells = new Map<string, T[]>();
    for (const row of rows.filter((r) => r.split === split).sort((a, b) => a.id.localeCompare(b.id))) {
      cells.set(cellOf(row), [...(cells.get(cellOf(row)) ?? []), row]);
    }
    const queues = [...cells.keys()].sort().map((key) => cells.get(key)!);
    let taken = 0;
    for (let pass = 0; taken < quota[split]; pass += 1) {
      const level = queues.filter((queue) => queue.length > pass);
      if (!level.length) break;
      for (const queue of level) {
        if (taken < quota[split]) {
          picked.push(queue[pass]!);
          taken += 1;
        }
      }
    }
  }
  return picked;
}

/** Reads the operator's golden set. A missing or invalid file throws; it never reads as an empty set. */
export function readGoldenSet(path: string): GoldenRow[] {
  if (!existsSync(path)) {
    throw new Error(
      `golden set not found at ${path}. Expected the operator-built JSONL (80 dev + 40 holdout, one goldenRowSchema case per line). It is gitignored and not built from prod here.`,
    );
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        throw new Error(`golden set line ${index + 1} is not JSON`);
      }
      const parsed = goldenRowSchema.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ');
        throw new Error(`golden set line ${index + 1} is invalid: ${issues}`);
      }
      return [parsed.data];
    });
}

export type FieldStatus = 'correct' | 'wrong' | 'missing' | 'hallucinated';
export type FieldResult = { field: GoldenField; status: FieldStatus; expected: Scalar; actual: Scalar };

export function actualFields(decision: ReservationistDecision | null): Record<GoldenField, Scalar> {
  const stay = decision?.stayAsk;
  return {
    workflow: decision?.workflow ?? null,
    arrivalDate: stay?.arrivalDate ?? null,
    departureDate: stay?.departureDate ?? null,
    adults: stay?.adults ?? null,
    children: stay?.children ?? null,
    rooms: stay?.rooms ?? null,
  };
}

/**
 * Scores the fields the row names. A different value is `wrong`, no value is `missing`, and a value where the
 * row says there must be none is `hallucinated`. Each named field is one unit of the denominator, so a
 * hallucinated field costs accuracy. Fields the row leaves out are unscored. `answered: false` (a failed run)
 * scores every named field as missing.
 */
export function scoreFields(expected: GoldenRow['expected'], actual: Record<GoldenField, Scalar>, answered = true) {
  const fields = GOLDEN_FIELDS.filter((field) => field in expected).map((field): FieldResult => {
    const want = expected[field] ?? null;
    const got = actual[field];
    const status: FieldStatus = !answered
      ? 'missing'
      : want === null
        ? got === null
          ? 'correct'
          : 'hallucinated'
        : got === null
          ? 'missing'
          : got === want
            ? 'correct'
            : 'wrong';
    return { field, status, expected: want, actual: got };
  });
  const flags = fields.flatMap(({ field, status }) => {
    if (status === 'hallucinated') return [`hallucinated_${field}`];
    if (status === 'wrong' && field === 'arrivalDate') return ['wrong_arrival'];
    if (status === 'wrong' && field === 'departureDate') return ['wrong_departure'];
    return [];
  });
  return { fields, flags, correct: fields.filter((f) => f.status === 'correct').length, scored: fields.length };
}

export type GoldenTrace = { decision: ReservationistDecision | null; replayMisses: number; error?: string };

export function scoreGoldenCase(row: GoldenRow, trace: GoldenTrace) {
  const answered = trace.decision !== null && !trace.error;
  const { fields, flags, correct, scored } = scoreFields(row.expected, actualFields(trace.decision), answered);
  return {
    id: row.id,
    split: row.split,
    type: row.type,
    senderDomain: senderDomainOf(row.trigger.from),
    fields,
    flags,
    correct,
    scored,
    replayMisses: trace.replayMisses,
    error: Boolean(trace.error),
  };
}
export type GoldenScoredCase = ReturnType<typeof scoreGoldenCase>;

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Micro field accuracy per split. The overfit alarm fires only when dev beats holdout by more than the limit. */
export function summarizeGolden(rows: readonly GoldenScoredCase[]) {
  const part = (split: GoldenRow['split']) => {
    const xs = rows.filter((r) => r.split === split);
    const correct = xs.reduce((sum, r) => sum + r.correct, 0);
    const scored = xs.reduce((sum, r) => sum + r.scored, 0);
    return { n: xs.length, correct, scored, accuracy: scored ? round6(correct / scored) : null };
  };
  const dev = part('dev');
  const holdout = part('holdout');
  const gapPoints =
    dev.accuracy !== null && holdout.accuracy !== null ? round6((dev.accuracy - holdout.accuracy) * 100) : null;
  const flags: Record<string, number> = {};
  for (const r of rows) for (const flag of r.flags) flags[flag] = (flags[flag] ?? 0) + 1;
  return {
    dev,
    holdout,
    gapPoints,
    overfitAlarm: gapPoints !== null && gapPoints > GOLDEN_TARGETS.overfitGapPoints,
    flags,
    errors: rows.filter((r) => r.error).length,
    replayMisses: rows.reduce((sum, r) => sum + r.replayMisses, 0),
  };
}

/**
 * Serves the case's recorded HMS reads in place of the live quote and party tools. A request with no recording
 * is a tool error and is counted in misses(). Nothing here reaches HMS.
 */
export function replayRunners(row: GoldenRow) {
  let misses = 0;
  const serve =
    (toolName: 'quote_stay' | 'party_lookup') =>
    async (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const hit = row.recordedReads.find(
        (read) => read.toolName === toolName && fingerprint(read.args) === fingerprint(request),
      );
      if (hit) return hit.result;
      misses += 1;
      return { status: 'tool_error', message: 'replay_miss' };
    };
  return { quote: serve('quote_stay'), party: serve('party_lookup'), misses: () => misses };
}
