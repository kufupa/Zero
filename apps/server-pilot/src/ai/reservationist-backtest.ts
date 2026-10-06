import { fingerprint } from './reservationist-replay.js';
import {occupiedDates,quoteDigest} from '../quote-proposal/quote-revision.js';
import { readFileSync } from 'node:fs';
import { htmlToPlainText } from '../mail/inbound-reaction-parser.js';
import {
  harvestStayDates,
  parseNeededTools,
  parseOccupancyFromBody,
  stripQuotedHistory,
} from '../ops/centurion-eval-lab.js';
import type { CenturionCorpusMessageRow } from '../ops/centurion-thread-corpus-postgres-reader.js';
import { QUOTE_UNAVAILABLE, type ReservationistDecision } from './reservationist-agent.js';

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

function classify(triggerText: string, goldText: string) {
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
