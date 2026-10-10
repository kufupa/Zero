import { fingerprint } from './reservationist-replay.js';
import {occupiedDates,quoteDigest} from '../quote-proposal/quote-revision.js';
import { existsSync, readFileSync } from 'node:fs';
import type { CenturionCorpusMessageRow } from '../ops/centurion-thread-corpus-postgres-reader.js';
import { type ReservationistDecision } from './reservationist-agent.js';
import { reservationistDecisionSchema, type LunaAnalysis } from './reservationist-decision.js';
import { z } from 'zod';
import type { ModelAdapter } from './bedrock/adapter.js';
import { extractInboundMail } from './extraction/extract.js';
import type { SanitizedExtraction } from './extraction/schema.js';
import { amendmentFromAnalysis, analyseQuoteSelection, mapLlmDecision } from './quote-workflow-llm.js';
import { orderCausalPreceding, type SyncedQuoteSelection } from './quote-workflow-synced-selection.js';

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

const AMOUNT_RE = /\b(?:R|ZAR)\s?(\d{1,3}(?:[ ,]\d{3})+|\d+)(?:[.,](\d{2}))?\b/g;

export function amountsIn(text: string): Set<number> {
  return new Set([...text.matchAll(AMOUNT_RE)].map((m) => Number(m[1]!.replace(/[ ,]/g, '')) * 100 + Number(m[2] ?? 0)));
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
const GOLDEN_FIELDS = [
  'workflow',
  'arrivalDate',
  'departureDate',
  'adults',
  'children',
  'rooms',
  'bookedArrivalDate',
  'bookedDepartureDate',
  'stays',
] as const;
export type GoldenField = (typeof GOLDEN_FIELDS)[number];
type Scalar = string | number | null;
/** A target's answer. A field the target cannot express is left out, and is then unscored for that target. */
export type GoldenFields = Partial<Record<GoldenField, Scalar>>;

/**
 * What a run scores. `pane` is the Nava pane analysis (lunaAnalysisSchema), `extract` the inbound mail extraction,
 * and `agent` the reservationist agent decision. pane and extract call the production prompt builders directly.
 */
export const BACKTEST_TARGETS = ['pane', 'extract', 'agent'] as const;
export type BacktestTarget = (typeof BACKTEST_TARGETS)[number];

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
      // Amend and cancel rows: the booking as it stands. arrivalDate and departureDate are then the requested stay.
      bookedArrivalDate: isoDay,
      bookedDepartureDate: isoDay,
      // Distinct date sets the mail asks for (multi-stay mails).
      stays: z.number().int().nullable(),
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

export function actualFields(decision: ReservationistDecision | null): GoldenFields {
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
export function scoreFields(expected: GoldenRow['expected'], actual: GoldenFields, answered = true) {
  const fields = GOLDEN_FIELDS.filter((field) => field in expected && field in actual).map((field): FieldResult => {
    const want = expected[field] ?? null;
    const got = actual[field] ?? null;
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

type Occupancy = { rooms: number | null; adultsPerRoom: number | null; children: number };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Totals over the rows of one stay. Adults are total adults; a lone row with no room count is one room. */
function occupancyOf(rows: Occupancy[], totalRooms: number | null = null): Pick<GoldenFields, 'rooms' | 'adults' | 'children'> {
  if (!rows.length) return { rooms: totalRooms, adults: null, children: null };
  const adultsKnown = rows.every((r) => r.adultsPerRoom !== null && (r.rooms !== null || rows.length === 1));
  return {
    rooms: totalRooms ?? (rows.every((r) => r.rooms !== null) ? sum(rows.map((r) => r.rooms!)) : null),
    adults: adultsKnown ? sum(rows.map((r) => (r.rooms ?? 1) * r.adultsPerRoom!)) : null,
    children: sum(rows.map((r) => r.children)),
  };
}

/**
 * What the pane shows for an analysis: the mapped quote groups (mapLlmDecision), or the amendment card
 * (amendmentFromAnalysis), whose requested stay is scored as arrival/departure. The first stay's groups are scored.
 */
export function paneFields(analysis: LunaAnalysis | null): GoldenFields {
  const amendment = analysis ? amendmentFromAnalysis(analysis) : null;
  const groups = (analysis && !amendment ? mapLlmDecision(analysis).groups : []).filter(
    (g) => g.arrivalDate || g.departureDate || g.quantity !== undefined || g.adults !== undefined,
  );
  const first = groups[0];
  const stay = groups.filter((g) => g.arrivalDate === first?.arrivalDate && g.departureDate === first?.departureDate);
  const requested = amendment && (amendment.requestedArrival || amendment.requestedDeparture);
  return {
    workflow: analysis?.workflow ?? null,
    arrivalDate: (amendment ? amendment.requestedArrival : first?.arrivalDate) ?? null,
    departureDate: (amendment ? amendment.requestedDeparture : first?.departureDate) ?? null,
    ...occupancyOf(stay.map((g) => ({ rooms: g.quantity ?? null, adultsPerRoom: g.adults ?? null, children: g.childrenAges.length }))),
    bookedArrivalDate: amendment?.arrival ?? null,
    bookedDepartureDate: amendment?.departure ?? null,
    stays: (requested ? 1 : new Set(groups.map((g) => `${g.arrivalDate}|${g.departureDate}`)).size) || null,
  };
}

export type GoldenExtraction = Pick<SanitizedExtraction, 'kind' | 'payload'>;

/** The stored mail_extraction payload: kind, and the first stay's requested and booked dates and rows. */
export function extractFields(extraction: GoldenExtraction | null): GoldenFields {
  const stay = extraction?.payload.stays[0];
  return {
    workflow: extraction?.kind ?? null,
    arrivalDate: stay?.requested.arrival ?? null,
    departureDate: stay?.requested.departure ?? null,
    ...occupancyOf(
      (stay?.rows ?? []).map((r) => ({ rooms: r.rooms, adultsPerRoom: r.adultsPerRoom, children: r.childAges.length })),
      stay?.totalRooms ?? null,
    ),
    bookedArrivalDate: stay?.booked?.arrival ?? null,
    bookedDepartureDate: stay?.booked?.departure ?? null,
    stays: extraction?.payload.stays.length || null,
  };
}

/**
 * Each prompt names workflows its own way. Gold (agent vocabulary) and answer both fold onto the labels the target
 * can tell apart, so a target is not marked wrong for a distinction its schema cannot make.
 */
const WORKFLOW_FOLD: Record<BacktestTarget, Record<string, string>> = {
  agent: {},
  // K2_MAPPING: create is create_booking; skip and spam are other.
  pane: { create_booking: 'create', skip: 'other', spam: 'other' },
  // EXTRACTION_RULES: create is booking, amend amendment, cancel cancellation, skip other. A voucher or POP is other.
  extract: { booking: 'create', amendment: 'amend', cancellation: 'cancel', voucher_pop: 'other', skip: 'other' },
};

/** A trace without a target is an agent trace (runs recorded before targets existed). */
export type GoldenTrace = { replayMisses: number; error?: string } & (
  | { target?: 'agent'; decision: ReservationistDecision | null }
  | { target: 'pane'; analysis: LunaAnalysis | null }
  | { target: 'extract'; extraction: GoldenExtraction | null }
);

function traceAnswer(trace: GoldenTrace): { target: BacktestTarget; fields: GoldenFields; answered: boolean } {
  if (trace.target === 'pane') return { target: 'pane', fields: paneFields(trace.analysis), answered: trace.analysis !== null };
  if (trace.target === 'extract') return { target: 'extract', fields: extractFields(trace.extraction), answered: trace.extraction !== null };
  return { target: 'agent', fields: actualFields(trace.decision), answered: trace.decision !== null };
}

export function scoreGoldenCase(row: GoldenRow, trace: GoldenTrace) {
  const answer = traceAnswer(trace);
  const fold = (value: Scalar | undefined) =>
    typeof value === 'string' ? (WORKFLOW_FOLD[answer.target][value] ?? value) : value;
  const expected = 'workflow' in row.expected ? { ...row.expected, workflow: fold(row.expected.workflow) } : row.expected;
  const actual = 'workflow' in answer.fields ? { ...answer.fields, workflow: fold(answer.fields.workflow) } : answer.fields;
  const { fields, flags, correct, scored } = scoreFields(
    expected as GoldenRow['expected'],
    actual,
    answer.answered && !trace.error,
  );
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

/**
 * The golden row as the synced selection prod builds from the mailbox. The thread goes through prod's own causal
 * filter (orderCausalPreceding), so a later reply in the row's context never reaches the prompt.
 */
export function goldenSelection(row: GoldenRow): SyncedQuoteSelection {
  const at = (eventAt: string | null) => (eventAt ? new Date(eventAt) : null);
  return {
    subject: row.trigger.subject,
    bodyText: row.trigger.text,
    ...(row.trigger.eventAt ? { receivedAt: row.trigger.eventAt } : {}),
    preceding: orderCausalPreceding(
      { id: row.trigger.id, receivedAt: at(row.trigger.eventAt) },
      row.context.map((message) => ({ id: message.id, textBody: message.text, receivedAt: at(message.eventAt) })),
    ),
    attachments: [],
    messageId: row.trigger.id,
    fromAddress: row.trigger.from,
  };
}

export type GoldenUsage = { inputTokens?: number; outputTokens?: number; costUsd?: number } | null;

/**
 * Runs one row through the production pane analysis (analyseQuoteSelection) or inbound extraction
 * (extractInboundMail) with their own prompts and deadlines. Neither path reads HMS, so nothing is replayed.
 */
export async function runProductionTarget(
  target: 'pane' | 'extract',
  row: GoldenRow,
  adapter: ModelAdapter,
): Promise<GoldenTrace & { usage: GoldenUsage }> {
  const selection = goldenSelection(row);
  if (target === 'pane') {
    const res = await analyseQuoteSelection({ selection, adapter, enabled: true });
    const usage = res.telemetry?.usage ?? null;
    return res.source === 'luna'
      ? { target, analysis: res.analysis, replayMisses: 0, usage }
      : { target, analysis: null, replayMisses: 0, usage, error: res.fallbackReason };
  }
  const res = await extractInboundMail({ adapter, selection, messageId: row.trigger.id, from: row.trigger.from });
  const usage = { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: res.usage.costUsd };
  return res.ok
    ? { target, extraction: { kind: res.kind, payload: res.payload }, replayMisses: 0, usage }
    : { target, extraction: null, replayMisses: 0, usage, error: res.reason };
}
