import { describe, expect, it } from 'vitest';
import type { CenturionCorpusMessageRow } from '../src/ops/centurion-thread-corpus-postgres-reader.js';
import {
  buildCases,
  pickPhaseA,
  scoreCase,
  toIsoDay,
  type BacktestCase,
  type ToolCall,
  type RuntimeReplayAssertions,
} from '../src/ai/reservationist-backtest.js';
import { QUOTE_UNAVAILABLE, type ReservationistDecision } from '../src/ai/reservationist-agent.js';

let seq = 0;
function msg(p: Partial<CenturionCorpusMessageRow>): CenturionCorpusMessageRow {
  seq += 1;
  return {
    id: `m${seq}`,
    threadId: 't',
    businessDirection: 'inbound',
    confirmedOutbound: false,
    scope: 'in_window',
    eventAt: '2026-09-27T08:00:00.000Z',
    subject: 's',
    textBody: '',
    htmlBody: '',
    from: ['guest@example.test'],
    ...p,
  } as CenturionCorpusMessageRow;
}

function thread(id: string, day: string, ask: string, gold: string, extra: Partial<CenturionCorpusMessageRow> = {}) {
  return [
    msg({ threadId: id, messageId: `<ask-${id}>`, eventAt: `${day}T08:00:00.000Z`, textBody: ask, ...extra }),
    msg({
      threadId: id,
      eventAt: `${day}T09:00:00.000Z`,
      businessDirection: 'outbound',
      inReplyTo: `<ask-${id}>`,
      queueState: null,
      textBody: gold,
      from: ['reservations@centurion.test'],
    }),
  ];
}

const QUOTE = 'Please quote 2 adults check in 2 October 2026 check out 4 October 2026';
const PARTY = 'Please quote for our company account ACME, corporate rate, check in 2 October 2026';
const CREATE = 'Please book a room for Mr Smith, arriving 2 October 2026';
const THANKS = 'Thank you, noted.';

describe('buildCases', () => {
  it('keeps sent in-window replies paired to the inbound they answer', () => {
    const rows = [
      ...thread('gold', '2026-09-28', QUOTE, 'Rate is R1 850 per night'),
      msg({ threadId: 'no-gold', textBody: QUOTE }),
      ...thread('queued', '2026-09-28', QUOTE, 'x').map((m) =>
        m.businessDirection === 'outbound' ? { ...m, queueState: 'pending' } : m,
      ),
      ...thread('missing-trigger', '2026-09-28', QUOTE, 'x').map((m) =>
        m.businessDirection === 'outbound' ? { ...m, inReplyTo: '<never-ingested>' } : m,
      ),
      ...thread('no-header', '2026-09-27', QUOTE, 'R1 000').map((m) => ({ ...m, inReplyTo: null, subject: 'RE: stay' })),
      ...thread('staff-initiated', '2026-09-27', QUOTE, 'Group report').map((m) => ({ ...m, inReplyTo: null })),
      msg({ threadId: 'later-reply', messageId: '<a1>', eventAt: '2026-09-26T07:00:00.000Z', textBody: QUOTE }),
      msg({ threadId: 'later-reply', eventAt: '2026-09-26T08:00:00.000Z', businessDirection: 'outbound', subject: 'Report', textBody: 'FYI' }),
      msg({ threadId: 'later-reply', eventAt: '2026-09-26T09:00:00.000Z', businessDirection: 'outbound', inReplyTo: '<a1>', textBody: 'R1 500' }),
      msg({ threadId: 'split-in', messageId: '<s1>', eventAt: '2026-09-26T05:00:00.000Z', textBody: QUOTE }),
      msg({ threadId: 'split-out', eventAt: '2026-09-26T06:00:00.000Z', businessDirection: 'outbound', inReplyTo: '<s1>', textBody: 'R1 700' }),
      ...thread('empty-forward', '2026-09-28', 'Thank you', ' From: Guest\nSent: Monday\nRate R2 000'),
    ];
    const cases = buildCases(rows);
    expect(cases).toHaveLength(9);
    expect(cases.filter(c => c.goldId).map(c => c.threadId)).toEqual(['gold', 'no-header', 'later-reply', 'split-in']);
    expect(cases.find((c) => c.threadId === 'split-in')?.goldText).toBe('R1 700');
    expect(cases.find(c => c.threadId === 'gold')).toMatchObject({ stratum: 'quote_fit', oracle: { quote: true }, goldText: 'Rate is R1 850 per night' });
  });

  it('reads html-only bodies and strata from the oracle', () => {
    const cases = buildCases([
      ...thread('p', '2026-09-28', '', 'ok', { htmlBody: `<p>${PARTY}</p>` }),
      ...thread('c', '2026-09-28', CREATE, 'Booked'),
      ...thread('n', '2026-09-28', THANKS, 'Pleasure'),
    ]);
    expect(Object.fromEntries(cases.map((c) => [c.threadId, c.stratum]))).toEqual({
      p: 'quote_party',
      c: 'create',
      n: 'no_tool',
    });
    const [agent] = buildCases(thread('a', '2026-09-28', 'Please quote our agent rate for 2 nights', 'R900'));
    expect(agent?.stratum).toBe('quote_party');
  });
});

describe('pickPhaseA', () => {
  it('is deterministic, prefers the latest day, and caps quotes at 1 party + 3 fit', () => {
    const rows = [];
    for (let i = 0; i < 6; i += 1) rows.push(...thread(`fit28-${i}`, '2026-09-28', QUOTE, 'R1 000'));
    for (let i = 0; i < 3; i += 1) rows.push(...thread(`fit26-${i}`, '2026-09-26', QUOTE, 'R1 000'));
    for (let i = 0; i < 2; i += 1) rows.push(...thread(`party-${i}`, '2026-09-27', PARTY, 'R900'));
    for (let i = 0; i < 5; i += 1) rows.push(...thread(`create-${i}`, '2026-09-26', CREATE, 'Booked'));
    for (let i = 0; i < 8; i += 1) rows.push(...thread(`none-${i}`, '2026-09-27', THANKS, 'Pleasure'));
    const cases = buildCases(rows);
    const a = pickPhaseA(cases);
    const b = pickPhaseA([...cases].reverse());
    expect(a.picked.map((c) => c.threadId)).toEqual(b.picked.map((c) => c.threadId));
    expect(a.picked).toHaveLength(15);
    const by = (s: string) => a.picked.filter((c) => c.stratum === s);
    expect(by('quote_party')).toHaveLength(1);
    expect(by('quote_fit').map((c) => c.threadId)).toEqual(['fit28-0', 'fit28-1', 'fit28-2']);
    expect(by('create').length).toBeGreaterThanOrEqual(2);
    expect(by('no_tool').length).toBeGreaterThanOrEqual(2);
    expect(a.emptyStrata).toEqual(['other']);
  });
});

describe('toIsoDay', () => {
  it('normalises SA date formats', () => {
    expect(toIsoDay('2 October 2026')).toBe('2026-10-02');
    expect(toIsoDay('02/10/2026')).toBe('2026-10-02');
    expect(toIsoDay('2026-10-02')).toBe('2026-10-02');
    expect(toIsoDay('Fri 2 Oct', '2026-09-27T08:00:00.000Z')).toBe('2026-10-02');
    expect(toIsoDay('15 Jan', '2026-09-27T08:00:00.000Z')).toBe('2027-01-15');
    expect(toIsoDay('soon')).toBeNull();
  });
});

describe('scoreCase', () => {
  const [quoteCase] = buildCases(thread('q', '2026-09-28', QUOTE, 'Rate is R1 850 per night')) as [BacktestCase];
  quoteCase.approvedFacts = { requiredCalls: [{ toolName: 'quote_stay', args: {} }], bodyClauses: ['R1 850 per night'], moneyCents: [185000] };
  const [noneCase] = buildCases(thread('n', '2026-09-28', THANKS, 'Pleasure')) as [BacktestCase];
  const decision = (p: Partial<ReservationistDecision>): ReservationistDecision => ({
    workflow: 'quote',
    stayAsk: { arrivalDate: '2026-10-02', departureDate: '2026-10-04', adults: 2, children: 0, rooms: 1 },
    missing: [],
    replyDraft: '',
    rationale: '',
    ...p,
  });
  const live = (rate: number): ToolCall => ({
    toolName: 'quote_stay',
    args: {},
    result: { outcome: 'quote', bookable: true, occupancyPriced: true, elapsedMs: 220000, groups: [{ options: [{ total: rate }] }] },
  });

  it('matches gold money and dates', () => {
    const row = scoreCase(quoteCase, decision({ replyDraft: 'R1 850 per night' }), [live(1850)]);
    expect(row).toMatchObject({ money: 'match', datesOk: true, paxOk: true, quoteLive: true, hmsElapsedMs: 220000, pass: true });
  });

  it('grounds draft amounts in HMS decimal-string rates', () => {
    const call: ToolCall = { ...live(0), result: { outcome: 'quote', bookable: true, occupancyPriced: true, groups: [{ options: [{ amount: '1850.00' }] }] } };
    expect(scoreCase(quoteCase, decision({ replyDraft: 'R1,850 (R7,400 for 4 nights)' }), [call]).money).toBe('extract_fail');
    expect(scoreCase(quoteCase, decision({ replyDraft: 'R1,850' }), [call]).money).toBe('match');
  });

  it('grounds cents the same way on both sides', () => {
    const call: ToolCall = { ...live(0), result: { outcome: 'quote', bookable: true, occupancyPriced: true, groups: [{ options: [{ amount: 1850.5 }] }] } };
    expect(scoreCase(quoteCase, decision({ replyDraft: 'R1 850.50' }), [call]).money).toBe('rate_stale');
  });

  it('separates rate_stale from extract_fail', () => {
    expect(scoreCase(quoteCase, decision({ replyDraft: 'R2 100' }), [live(2100)]).money).toBe('rate_stale');
    const bad = scoreCase(quoteCase, decision({ replyDraft: 'R1 234' }), [live(2100)]);
    expect(bad.money).toBe('extract_fail');
    expect(bad.pass).toBe(false);
  });

  it('flags quote false positive on stub and quote miss', () => {
    const fp = scoreCase(noneCase, decision({ workflow: 'quote' }), [
      { toolName: 'quote_stay', args: {}, result: { status: QUOTE_UNAVAILABLE } },
    ]);
    expect(fp).toMatchObject({ quoteCalled: true, quoteLive: false, quoteFalsePositive: true, workflowOk: false, pass: false });
    const miss = scoreCase(quoteCase, decision({ workflow: 'other' }), []);
    expect(miss).toMatchObject({ quoteMiss: true, pass: false });
    const skip = scoreCase(noneCase, decision({ workflow: 'skip', stayAsk: null }), []);
    expect(skip).toMatchObject({ workflowOk: true, pass: true });
  });
});

describe('chronological coverage and strict completion', () => {
  it('retains every inbound, no-gold and split-thread pairing, and only prior context', () => {
    const first = msg({ id: 'first', messageId: '<first>', textBody: QUOTE });
    const second = msg({ id: 'second', messageId: '<second>', eventAt: '2026-09-27T08:30:00Z', textBody: QUOTE });
    const gold = msg({ id: 'gold', threadId: 'split', businessDirection: 'outbound', inReplyTo: '<second>', eventAt: '2026-09-27T09:00:00Z', textBody: 'R100' });
    const cases = buildCases([gold, second, first]);
    expect(cases).toHaveLength(2);
    expect(cases.find(c => c.trigger.id === 'first')?.goldId).toBe('');
    expect(cases.find(c => c.trigger.id === 'second')?.context.map(m => m.id)).toEqual(['first']);
    expect(cases.find(c => c.trigger.id === 'second')?.goldId).toBe('gold');
  });
  it('gold changes cannot change execution classification', () => {
    const a = buildCases(thread('g', '2026-09-28', THANKS, 'Pleasure'))[0]!;
    const b = buildCases(thread('g', '2026-09-28', THANKS, 'R900'))[0]!;
    expect(a.oracle).toEqual(b.oracle);
  });
  it('unavailable quote and invalid create never pass', () => {
    const c = buildCases(thread('q', '2026-09-28', QUOTE, 'R100'))[0]!;
    const d = { workflow: 'quote', stayAsk: { arrivalDate: '2026-10-02', departureDate: '2026-10-04', adults: 2, children: 0, rooms: 1 }, missing: [], replyDraft: 'R100', rationale: '' } as ReservationistDecision;
    expect(scoreCase(c, d, [{ toolName: 'quote_stay', args: {}, result: { outcome: 'unavailable' } }]).pass).toBe(false);
    const create = buildCases(thread('c', '2026-09-28', CREATE, 'Booked'))[0]!;
    expect(scoreCase(create, { ...d, workflow: 'create' }, [{ toolName: 'create_reservation_dry_run', args: {}, result: { ok: false } }]).pass).toBe(false);
  });
});

describe('approved completion assertions', () => {
  it('rejects partial payloads and one-cent body errors', () => {
    const c = buildCases(thread('strict', '2026-09-28', QUOTE, 'R100'))[0]!;
    const decision = { workflow: 'quote', stayAsk: { arrivalDate: '2026-10-02', departureDate: '2026-10-04', adults: 2, children: 0, rooms: 1 }, missing: [], replyDraft: 'R100.01', rationale: '' } as ReservationistDecision;
    const call = { toolName: 'quote_stay', args: decision.stayAsk, result: { outcome: 'quote', bookable: false, occupancyPriced: true, groups: [{ options: [{ amount: '100.00' }] }] } };
    expect(scoreCase(c, decision, [call]).pass).toBe(false);
    expect(scoreCase(c, { ...decision, replyDraft: 'R100' }, [call]).pass).toBe(false);
  });
});

describe('payload and artifact integrity', () => {
  it('does not ground money from unrelated quantities and demands successful party lookup', () => {
    const c = buildCases(thread('party', '2026-09-28', PARTY, 'R100'))[0]!;
    const d = { workflow: 'quote', stayAsk: null, missing: [], replyDraft: 'R100', rationale: '' } as ReservationistDecision;
    const q = { toolName: 'quote_stay', args: {}, result: { outcome: 'quote', bookable: true, occupancyPriced: true, groups: [{ options: [{ quantity: 100, amount: '50.00' }] }] } };
    expect(scoreCase(c, d, [q, { toolName: 'party_lookup', args: {}, result: { outcome: 'unavailable' } }]).money).toBe('extract_fail');
  });
  it('empty PDF and invalid successful create packets cannot pass', () => {
    const c = buildCases(thread('c', '2026-09-28', CREATE, 'Booked'))[0]!;
    const d = { workflow: 'create', stayAsk: null, missing: [], replyDraft: 'Validated', rationale: '' } as ReservationistDecision;
    expect(scoreCase(c, d, [{ toolName: 'create_reservation_dry_run', args: { request: {} }, result: { ok: true, dryRun: true, saved: false, errors: [] } }]).pass).toBe(false);
  });
});

it('resolves yearless stay dates using Johannesburg causal day and rejects invalid dates', () => {
  expect(toIsoDay('1 Oct', '2026-09-30T23:30:00Z')).toBe('2026-10-01');
  expect(toIsoDay('31 February 2026')).toBeNull();
});

it('shared runtime scorer validates every obligation and never counts frozen work as qualification',async()=>{
 const {scoreRuntimeReplay}=await import('../src/ai/reservationist-backtest.js');
 const approved:any={tasks:[{id:'q',status:'complete',evidenceRefs:['quote:1']}],bodyClauses:['Accommodation total: ZAR 100.00.'],moneyCents:[10000],artifacts:[],quoteRefs:['quote:1'],packetRequired:false};
 const runtime:any={tasks:approved.tasks,textBody:'Accommodation total: ZAR 100.00.',artifacts:[],quoteRefs:['quote:1'],packets:[],errors:[],assessment:{ok:true},readiness:'ready_for_staff_review'};
 expect(scoreRuntimeReplay(runtime,approved,'authoritative_source_replay').pass).toBe(true);
 expect(scoreRuntimeReplay(runtime,approved,'deterministic_work_fixture').pass).toBe(false);
 expect(scoreRuntimeReplay({...runtime,textBody:'Accommodation total: ZAR 100.01.'},approved,'authoritative_source_replay').pass).toBe(false);
 expect(scoreRuntimeReplay({...runtime,tasks:[]},approved,'authoritative_source_replay').pass).toBe(false);
 expect(scoreRuntimeReplay(runtime,undefined,'authoritative_source_replay').pass).toBe(false);
});

it('scores authoritative quote totals from immutable revisions and rejects one cent drift',async()=>{
 const {scoreRuntimeReplay}=await import('../src/ai/reservationist-backtest.js');
 const approved:any={tasks:[{id:'q',status:'complete',evidenceRefs:['quote:1']}],bodyClauses:['Total ZAR 100.00.'],moneyCents:[10000],artifacts:[],quoteRefs:['quote:1'],packetRequired:false,quoteTotals:[{ref:'quote:1',totalMinor:10000}]};
 const runtime:any={tasks:approved.tasks,textBody:'Total ZAR 100.00.',artifacts:[],quoteRefs:['quote:1'],quoteRevisions:[{id:'quote:1',totalMinor:10000}],packets:[],errors:[],assessment:{ok:true},readiness:'ready_for_staff_review'};
 expect(scoreRuntimeReplay(runtime,approved,'authoritative_source_replay').pass).toBe(true);
 expect(scoreRuntimeReplay({...runtime,quoteRevisions:[{id:'quote:1',totalMinor:10001}]},approved,'authoritative_source_replay').pass).toBe(false);
});

it('grades every physical booking room field and rejects missing packet assertions or boolean success stubs',async()=>{
 const {scoreRuntimeReplay}=await import('../src/ai/reservationist-backtest.js');
 const room={groupId:'selected',roomIndex:1,pricing:{currency:'ZAR',totalMinor:10000,nightly:[{date:'2026-10-12',amountMinor:10000}],source:{sourceRef:'source',sourceHash:'a'.repeat(64),toolVersion:'v2',observedAt:'2026-10-04T10:00:00Z'}},guests:[{factRef:'guest-a',firstName:'Synthetic',lastName:'Guest'}],request:{arrival:'2026-10-12',departure:'2026-10-14',adults:1,childAges:[],roomType:'STQN',ratePlan:'BAR',sourceOfBusiness:'DIRECT',track:'LEISURE',guaranteeType:'GUAR',firstName:'Synthetic',lastName:'Guest'}};
 const approved:any={tasks:[{id:'booking',status:'pending_pms_action',evidenceRefs:['source']}],bodyClauses:['Your booking request is prepared.'],moneyCents:[],artifacts:[],quoteRefs:['quote:1'],packetRequired:true,packetRooms:[room],bookingPackets:[{kind:'accepted_quote',taskId:'booking',revisionId:'quote:1',scopeDigest:'scope',currency:'ZAR',totalMinor:10000}]};
 const packet={kind:'accepted_quote',taskId:'booking',revisionId:'quote:1',scopeDigest:'scope',currency:'ZAR',totalMinor:10000,nativePriceApplication:'pending_staff_review',saved:false,status:'pending_pms_action',schemaValid:true,businessRulesValidated:true,nativeSaveAcceptance:'untested',rooms:[room]};
 const runtime:any={tasks:approved.tasks.map((t:RuntimeReplayAssertions['tasks'][number])=>({...t,kind:'acceptance'})),textBody:approved.bodyClauses[0],artifacts:[],quoteRefs:approved.quoteRefs,packets:[packet],errors:[],assessment:{ok:true},readiness:'pending_pms_action'};
 expect(scoreRuntimeReplay(runtime,approved,'authoritative_source_replay').pass).toBe(true);
 for(const change of [{taskId:'wrong'},{revisionId:'wrong'},{totalMinor:9999},{currency:'USD'},{kind:'unknown'}])expect(scoreRuntimeReplay({...runtime,packets:[{...packet,...change}]},approved,'authoritative_source_replay').pass).toBe(false);
 expect(scoreRuntimeReplay(runtime,{...approved,bookingPackets:undefined},'authoritative_source_replay').pass).toBe(false);
 expect(scoreRuntimeReplay(runtime,{...approved,packetRooms:undefined},'authoritative_source_replay').pass).toBe(false);
 expect(scoreRuntimeReplay({...runtime,packets:[{...packet,rooms:undefined}]},approved,'authoritative_source_replay').pass).toBe(false);
 for(const request of [{...room.request,arrival:'2026-10-13'},{...room.request,adults:2},{...room.request,ratePlan:'FICTIONAL'}])expect(scoreRuntimeReplay({...runtime,packets:[{...packet,rooms:[{...room,request}]}]},approved,'authoritative_source_replay').pass).toBe(false);
 expect(scoreRuntimeReplay({...runtime,packets:[{...packet,rooms:[{...room,guests:[{...room.guests[0],lastName:'Other'}]}]}]},approved,'authoritative_source_replay').pass).toBe(false);
 expect(scoreRuntimeReplay({...runtime,packets:[{...packet,rooms:[room,room]}]},approved,'authoritative_source_replay').pass).toBe(false);
 expect(scoreRuntimeReplay({...runtime,packets:[{...packet,status:'blocked'}]},approved,'authoritative_source_replay').pass).toBe(false);
 expect(scoreRuntimeReplay({...runtime,packets:[null]},approved,'authoritative_source_replay').pass).toBe(false);
 expect(scoreRuntimeReplay(runtime,{...approved,packetRooms:[null]},'authoritative_source_replay').pass).toBe(false);
});

it('scores sourced pending amendment and cancellation actions against exact independent postconditions',async()=>{
 const {scoreRuntimeReplay}=await import('../src/ai/reservationist-backtest.js');
 const {prepareReservationistPendingAction}=await import('../src/ai/reservationist-pending-action.js');
 const at='2026-10-04T10:00:00Z',current={arrivalDate:'2026-10-12',departureDate:'2026-10-14'},requested={arrivalDate:'2026-10-15',departureDate:'2026-10-17'};
 const input={kind:'change' as const,taskId:'change',requestId:'inbound',ownerRef:'synthetic-owner',threadId:'synthetic-thread',propertyCode:'HRCEN',reservationRef:'reservation:one',changes:requested,clock:{causalAt:at,sourceAt:at,sourceMode:'historical' as const}};
 const evidence={...input,authorizationId:'synthetic-auth',sourceRef:'reservation-source',sourceHash:'a'.repeat(64),observedAt:at,expiresAt:'2026-10-04T11:00:00Z',maxSourceAgeMs:3600000,current,requestSource:{taskId:input.taskId,sourceRef:'request-source',sourceHash:'b'.repeat(64),observedAt:at,changes:requested}};
 const packet=await prepareReservationistPendingAction(input,{signal:new AbortController().signal,resolveEvidence:async()=>evidence,authorizeSource:async()=>true});
 const action={kind:packet.kind,taskId:packet.taskId,reservationRef:packet.reservationRef,current:packet.current,requested:packet.requested,sourceRefs:packet.sourceRefs,digest:packet.digest};
 const tasks=[{id:'change',kind:'change',status:'pending_pms_action',evidenceRefs:packet.sourceRefs}],body='Your amendment request is prepared for staff review.';
 const approved:any={tasks:tasks.map(({kind,...task})=>task),bodyClauses:[body],moneyCents:[],artifacts:[],quoteRefs:[],packetRequired:false,pendingActions:[action]};
 const runtime:any={tasks,textBody:body,artifacts:[],quoteRefs:[],packets:[packet],errors:[],assessment:{ok:true},readiness:'pending_pms_action'};
 expect(scoreRuntimeReplay(runtime,approved,'authoritative_source_replay').pass).toBe(true);
 for(const change of [{reservationRef:'reservation:other'},{requested:{...requested,arrivalDate:'2026-10-16'}},{sourceRefs:['other']},{kind:'arbitrary'},{saved:true},{status:'complete'},{digest:'bad'},{errors:['unsafe']},{current:{arrivalDate:'2026-02-31',departureDate:'2026-03-02'}}])expect(scoreRuntimeReplay({...runtime,packets:[{...packet,...change}]},approved,'authoritative_source_replay').pass).toBe(false);
 expect(scoreRuntimeReplay(runtime,{...approved,pendingActions:undefined},'authoritative_source_replay').pass).toBe(false);
 expect(scoreRuntimeReplay(runtime,{...approved,pendingActions:[null]},'authoritative_source_replay').pass).toBe(false);
 expect(scoreRuntimeReplay({...runtime,tasks:[{...tasks[0],status:'complete'}]},{...approved,tasks:[{...approved.tasks[0],status:'complete'}]},'authoritative_source_replay').pass).toBe(false);
 expect(scoreRuntimeReplay({...runtime,readiness:'ready_for_staff_review'},approved,'authoritative_source_replay').pass).toBe(false);
 const cancelInput={...input,kind:'cancel_request' as const,taskId:'cancel',changes:undefined};
 const cancel=await prepareReservationistPendingAction(cancelInput,{signal:new AbortController().signal,resolveEvidence:async()=>({...evidence,requestSource:{...evidence.requestSource,taskId:'cancel',changes:undefined}}),authorizeSource:async()=>true});
 const cancelAction={kind:cancel.kind,taskId:cancel.taskId,reservationRef:cancel.reservationRef,current:cancel.current,sourceRefs:cancel.sourceRefs};
 const cancelTasks=[{id:'cancel',kind:'cancel_request',status:'pending_pms_action',evidenceRefs:cancel.sourceRefs}];
 const cancelApproved={...approved,tasks:cancelTasks.map(({kind,...task})=>task),pendingActions:[cancelAction]};
 expect(scoreRuntimeReplay({...runtime,tasks:cancelTasks,packets:[cancel]},cancelApproved,'authoritative_source_replay').pass).toBe(true);
 expect(scoreRuntimeReplay({...runtime,tasks:cancelTasks,packets:[{...cancel,requested}]},cancelApproved,'authoritative_source_replay').pass).toBe(false);
});

