import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STRATA,
  cellOf,
  pickSubset,
  readGoldenSet,
  replayRunners,
  runProductionTarget,
  scoreFields,
  scoreGoldenCase,
  senderDomainOf,
  summarizeGolden,
  validateGoldenSet,
  type GoldenRow,
  type GoldenScoredCase,
  type RuntimeReplayAssertions,
} from '../src/ai/reservationist-backtest.js';
import type { ReservationistDecision } from '../src/ai/reservationist-agent.js';
import type { ModelAdapter, ModelInvokeInput } from '../src/ai/bedrock/adapter.js';
import { EXTRACTION_RULES } from '../src/ai/extraction/extract.js';
import { K2_MAPPING } from '../src/ai/quote-workflow-llm.js';

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
 const approved:any={tasks:tasks.map(({kind: _kind,...task})=>task),bodyClauses:[body],moneyCents:[],artifacts:[],quoteRefs:[],packetRequired:false,pendingActions:[action]};
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
 const cancelApproved={...approved,tasks:cancelTasks.map(({kind: _kind,...task})=>task),pendingActions:[cancelAction]};
 expect(scoreRuntimeReplay({...runtime,tasks:cancelTasks,packets:[cancel]},cancelApproved,'authoritative_source_replay').pass).toBe(true);
 expect(scoreRuntimeReplay({...runtime,tasks:cancelTasks,packets:[{...cancel,requested}]},cancelApproved,'authoritative_source_replay').pass).toBe(false);
});

const DOMAINS = ['d0.test', 'd1.test', 'd2.test', 'd3.test', 'd4.test', 'd5.test', 'd6.test', 'd7.test'];
const ASK = { arrivalDate: '2026-10-12', departureDate: '2026-10-14', adults: 2, children: 0, rooms: 1 };

function golden(index: number, split: 'dev' | 'holdout', from = `guest${index}@${DOMAINS[index % DOMAINS.length]}`): GoldenRow {
  return {
    id: `${split}-${index}`,
    split,
    type: STRATA[index % STRATA.length]!,
    trigger: { id: `${split}-${index}-m`, direction: 'inbound', eventAt: '2026-10-06T08:00:00.000Z', from, subject: 'Enquiry', text: 'Synthetic request' },
    context: [],
    expected: { workflow: 'quote', ...ASK },
    recordedReads: [],
  };
}

/** The full 80 dev + 40 holdout shape; sender domains and types cycle so every split stays under the cap. */
function fullSet(): GoldenRow[] {
  return [
    ...Array.from({ length: 80 }, (_, i) => golden(i, 'dev')),
    ...Array.from({ length: 40 }, (_, i) => golden(80 + i, 'holdout')),
  ];
}

function decision(stay: Partial<NonNullable<ReservationistDecision['stayAsk']>> | null, workflow: ReservationistDecision['workflow'] = 'quote'): ReservationistDecision {
  return { workflow, stayAsk: stay === null ? null : { ...ASK, ...stay }, missing: [], replyDraft: '', rationale: '' };
}

describe('golden set field scoring', () => {
  it('flags a wrong arrival and counts the other named fields as correct', () => {
    const scored = scoreGoldenCase(golden(0, 'dev'), { decision: decision({ arrivalDate: '2026-10-13' }), replayMisses: 0 });
    expect(scored.flags).toEqual(['wrong_arrival']);
    expect(scored.fields.find((f) => f.field === 'arrivalDate')).toMatchObject({ status: 'wrong', expected: '2026-10-12', actual: '2026-10-13' });
    expect([scored.correct, scored.scored]).toEqual([5, 6]);
  });

  it('penalises a hallucinated field that the row says must be absent', () => {
    const row: GoldenRow = { ...golden(1, 'dev'), expected: { ...golden(1, 'dev').expected, children: null } };
    const scored = scoreGoldenCase(row, { decision: decision({ children: 2 }), replayMisses: 0 });
    expect(scored.flags).toEqual(['hallucinated_children']);
    expect([scored.correct, scored.scored]).toEqual([5, 6]);
  });

  it('separates missing from correct, and leaves fields the row omits unscored', () => {
    expect(
      scoreFields(
        { arrivalDate: '2026-10-12', adults: 2 },
        { workflow: null, arrivalDate: null, departureDate: null, adults: 2, children: null, rooms: null },
      ).fields.map((f) => [f.field, f.status]),
    ).toEqual([
      ['arrivalDate', 'missing'],
      ['adults', 'correct'],
    ]);
    const row: GoldenRow = { ...golden(2, 'dev'), expected: { workflow: 'quote', arrivalDate: '2026-10-12' } };
    expect(scoreGoldenCase(row, { decision: decision(null), replayMisses: 0 }).fields.map((f) => [f.field, f.status])).toEqual([
      ['workflow', 'correct'],
      ['arrivalDate', 'missing'],
    ]);
    const unscored = scoreGoldenCase({ ...row, expected: { arrivalDate: '2026-10-12' } }, { decision: decision({ children: 2 }), replayMisses: 0 });
    expect(unscored.fields.map((f) => f.field)).toEqual(['arrivalDate']);
    expect(unscored.scored).toBe(1);
  });

  it('scores a failed run as missing on every named field', () => {
    expect(scoreGoldenCase(golden(3, 'dev'), { decision: null, replayMisses: 2, error: 'boom' })).toMatchObject({
      correct: 0,
      scored: 6,
      replayMisses: 2,
      error: true,
    });
  });

  it('derives the sender domain and stratification cell from the first address', () => {
    expect(senderDomainOf('Ann Guest <Ann@Example.CO.za>, other@x.test')).toBe('example.co.za');
    expect(senderDomainOf('no address')).toBe('unknown');
    expect(cellOf(golden(0, 'dev', 'x@Booking.Example.test'))).toBe(`${STRATA[0]}|booking.example.test`);
  });
});

describe('golden set validation and subset', () => {
  it('accepts the full set and rejects wrong counts, an over-cap domain, and duplicate ids', () => {
    expect(validateGoldenSet(fullSet())).toEqual([]);
    expect(validateGoldenSet(fullSet().slice(1))).toContainEqual('dev: 79 cases, need 80');
    const crowded = fullSet().map((row, i) =>
      row.split === 'dev' && i < 13 ? { ...row, trigger: { ...row.trigger, from: 'guest@big.test' } } : row,
    );
    expect(validateGoldenSet(crowded)).toContainEqual(expect.stringContaining('sender domain big.test holds 13 of 80'));
    const dup = fullSet();
    dup[1] = { ...dup[1]!, id: dup[0]!.id };
    expect(validateGoldenSet(dup)).toContainEqual('duplicate id dev-0');
  });

  it('picks a deterministic 30 at 20 dev / 10 holdout, covering distinct cells', () => {
    const rows = fullSet();
    const subset = pickSubset(rows, 30);
    const ids = subset.map((row) => row.id);
    expect(new Set(ids).size).toBe(30);
    expect(subset.filter((row) => row.split === 'dev')).toHaveLength(20);
    expect(subset.filter((row) => row.split === 'holdout')).toHaveLength(10);
    expect(new Set(subset.filter((row) => row.split === 'dev').map(cellOf)).size).toBe(20);
    expect(pickSubset([...rows].reverse(), 30).map((row) => row.id)).toEqual(ids);
  });
});

describe('golden set file', () => {
  it('fails clearly when the operator file is absent and names a bad line without echoing it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'golden-set-'));
    try {
      const file = path.join(dir, 'golden-set.jsonl');
      expect(() => readGoldenSet(file)).toThrow(`golden set not found at ${file}`);
      const bad = { ...golden(1, 'dev'), split: 'train', trigger: { text: 'private body' } };
      writeFileSync(file, `${JSON.stringify(golden(0, 'dev'))}\n${JSON.stringify(bad)}\n`);
      let message = '';
      try {
        readGoldenSet(file);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/^golden set line 2 is invalid: split /);
      expect(message).not.toContain('private body');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads back the rows it was given', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'golden-set-'));
    try {
      const file = path.join(dir, 'golden-set.jsonl');
      const rows = [golden(0, 'dev'), golden(81, 'holdout')];
      writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n'));
      expect(readGoldenSet(file)).toEqual(rows);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('overfit alarm', () => {
  const part = (split: 'dev' | 'holdout', correct: number, scored: number): GoldenScoredCase => ({
    id: `${split}-${correct}`,
    split,
    type: 'create',
    senderDomain: 'd.test',
    fields: [],
    flags: [],
    correct,
    scored,
    replayMisses: 0,
    error: false,
  });

  it('fires only when dev beats holdout by more than 10 points', () => {
    expect(summarizeGolden([part('dev', 100, 100), part('holdout', 90, 100)]).overfitAlarm).toBe(false);
    expect(summarizeGolden([part('dev', 100, 100), part('holdout', 89, 100)])).toMatchObject({ gapPoints: 11, overfitAlarm: true });
    expect(summarizeGolden([part('dev', 0, 0), part('holdout', 1, 2)]).overfitAlarm).toBe(false);
  });
});

describe('replayed reads', () => {
  it('serves recorded reads by request fingerprint and counts anything unrecorded as a miss', async () => {
    const row: GoldenRow = {
      ...golden(0, 'dev'),
      recordedReads: [
        {
          toolName: 'quote_stay',
          args: { schemaVersion: 2, propertyCode: 'HRCEN', arrivalDate: '2026-10-12' },
          result: { outcome: 'quote', groups: [] },
        },
      ],
    };
    const replay = replayRunners(row);
    expect(await replay.quote({ arrivalDate: '2026-10-12', propertyCode: 'HRCEN', schemaVersion: 2 })).toEqual({ outcome: 'quote', groups: [] });
    expect(await replay.quote({ schemaVersion: 2, propertyCode: 'HRCEN', arrivalDate: '2026-10-13' })).toEqual({
      status: 'tool_error',
      message: 'replay_miss',
    });
    expect(await replay.party({ kind: 'organization', query: {} })).toEqual({ status: 'tool_error', message: 'replay_miss' });
    expect(replay.misses()).toBe(2);
  });
});

/** A fake model: records each request and answers with `output`. */
function fakeAdapter(output: Record<string, unknown>) {
  const calls: ModelInvokeInput[] = [];
  const adapter: ModelAdapter = {
    async invoke(input) {
      calls.push(input);
      return {
        modelId: 'fake',
        output,
        usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, latencyMs: 1, estimatedCostUsd: 0.0002, rateTableVersion: 't' },
      };
    },
  };
  return { adapter, calls };
}

const lunaGroup = (over: Record<string, unknown> = {}) => ({
  arrival: '2026-10-12',
  departure: '2026-10-14',
  rooms: 1,
  adultsPerRoom: 2,
  childAges: [],
  board: null,
  roomPreference: null,
  guestNames: [],
  ...over,
});
const luna = (over: Record<string, unknown> = {}) => ({
  workflow: 'quote',
  flags: [],
  groups: [lunaGroup()],
  party: { kind: null, name: null, reference: null },
  rateClaims: [],
  missing: [],
  evidence: [],
  tasks: [],
  ...over,
});
const extraction = (over: Record<string, unknown> = {}) => ({
  sourceLanguage: 'en',
  kind: 'quote',
  agency: null,
  endClient: null,
  contact: { name: null, email: null, phone: null },
  confirmationNumbers: [],
  stays: [
    {
      hotel: null,
      requested: { arrival: '2026-10-12', departure: '2026-10-14' },
      booked: null,
      totalRooms: null,
      rows: [{ roomType: null, rooms: 1, adultsPerRoom: 2, childAges: [], board: null }],
    },
  ],
  missing: [],
  ...over,
});
const statuses = (scored: GoldenScoredCase) => Object.fromEntries(scored.fields.map((f) => [f.field, f.status]));

describe('production targets', () => {
  const row: GoldenRow = {
    ...golden(0, 'dev'),
    context: [{ id: 'c1', direction: 'outbound', eventAt: '2026-10-05T08:00:00.000Z', from: 'desk@hotel.test', subject: 'Re', text: 'Earlier thread body' }],
  };

  it('pane: sends the production analyse prompt and scores the mapped groups', async () => {
    const { adapter, calls } = fakeAdapter(luna());
    const trace = await runProductionTarget('pane', row, adapter);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.systemPrompt).toContain(K2_MAPPING);
    expect(calls[0]!.userPrompt).toContain('Synthetic request');
    expect(calls[0]!.userPrompt).toContain('Earlier thread body');
    // prod's causal filter: a reply after the trigger never reaches the prompt.
    const later = { ...row, context: [...row.context, { ...row.context[0]!, id: 'c2', eventAt: '2026-10-07T08:00:00.000Z', text: 'Later reply' }] };
    const laterCalls = fakeAdapter(luna());
    await runProductionTarget('pane', later, laterCalls.adapter);
    expect(laterCalls.calls[0]!.userPrompt).not.toContain('Later reply');
    expect(trace.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200 });
    const scored = scoreGoldenCase(row, trace);
    expect([scored.correct, scored.scored, scored.error]).toEqual([6, 6, false]);
  });

  it('pane: folds create and skip onto its own labels, totals adults over rooms, and flags a wrong arrival', async () => {
    const create = { ...row, expected: { workflow: 'create' as const, rooms: 3, adults: 6 } };
    const answer = luna({ workflow: 'create_booking', groups: [lunaGroup({ rooms: 3, adultsPerRoom: 2 })] });
    expect(statuses(scoreGoldenCase(create, await runProductionTarget('pane', create, fakeAdapter(answer).adapter)))).toEqual({
      workflow: 'correct',
      adults: 'correct',
      rooms: 'correct',
    });
    const skip = { ...row, expected: { workflow: 'skip' as const, arrivalDate: null } };
    expect(statuses(scoreGoldenCase(skip, await runProductionTarget('pane', skip, fakeAdapter(luna({ workflow: 'other' })).adapter)))).toEqual({
      workflow: 'correct',
      arrivalDate: 'correct',
    });
    const wrong = await runProductionTarget('pane', row, fakeAdapter(luna({ groups: [lunaGroup({ arrival: '2026-10-13' })] })).adapter);
    expect(scoreGoldenCase(row, wrong).flags).toEqual(['wrong_arrival']);
  });

  it('pane: scores an amendment as requested vs booked dates, and counts distinct stays', async () => {
    const amend = {
      ...row,
      expected: { workflow: 'amend' as const, arrivalDate: '2026-10-11', departureDate: '2026-10-14', bookedArrivalDate: '2026-10-12', bookedDepartureDate: '2026-10-14', stays: 1 },
    };
    const answer = luna({ workflow: 'amend', groups: [], arrival: '2026-10-12', departure: '2026-10-14', requestedArrival: '2026-10-11', requestedDeparture: '2026-10-14' });
    const scored = scoreGoldenCase(amend, await runProductionTarget('pane', amend, fakeAdapter(answer).adapter));
    expect([scored.correct, scored.scored]).toEqual([6, 6]);
    const multi = { ...row, expected: { stays: 2, rooms: 2 } };
    const two = luna({ groups: [lunaGroup(), lunaGroup({ adultsPerRoom: 1 }), lunaGroup({ arrival: '2026-11-17', departure: '2026-11-18' })] });
    expect(statuses(scoreGoldenCase(multi, await runProductionTarget('pane', multi, fakeAdapter(two).adapter)))).toEqual({ stays: 'correct', rooms: 'correct' });
  });

  it('pane: an invalid model answer is a failed case, every named field missing', async () => {
    const trace = await runProductionTarget('pane', row, fakeAdapter({ workflow: 'nonsense' }).adapter);
    expect(trace.error).toBe('invalid_output');
    expect(scoreGoldenCase(row, trace)).toMatchObject({ correct: 0, scored: 6, error: true });
  });

  it('extract: sends the production extraction prompt and scores kind, requested and booked dates, rows and stays', async () => {
    const { adapter, calls } = fakeAdapter(extraction());
    const trace = await runProductionTarget('extract', row, adapter);
    expect(calls[0]!.systemPrompt).toContain(EXTRACTION_RULES);
    expect(calls[0]!.userPrompt).toContain(`From: ${row.trigger.from}`);
    expect(scoreGoldenCase(row, trace)).toMatchObject({ correct: 6, scored: 6, error: false });

    const amend = {
      ...row,
      expected: { workflow: 'amend' as const, arrivalDate: '2026-10-11', bookedArrivalDate: '2026-10-12', adults: 3, rooms: 2, stays: 2 },
    };
    const answer = extraction({
      kind: 'amendment',
      stays: [
        {
          hotel: null,
          requested: { arrival: '2026-10-11', departure: '2026-10-14' },
          booked: { arrival: '2026-10-12', departure: '2026-10-14' },
          totalRooms: null,
          rows: [
            { roomType: 'Single', rooms: 1, adultsPerRoom: 1, childAges: [], board: null },
            { roomType: 'Double', rooms: 1, adultsPerRoom: 2, childAges: [], board: null },
          ],
        },
        { hotel: null, requested: { arrival: '2026-11-01', departure: '2026-11-02' }, booked: null, totalRooms: null, rows: [] },
      ],
    });
    const scored = scoreGoldenCase(amend, await runProductionTarget('extract', amend, fakeAdapter(answer).adapter));
    expect([scored.correct, scored.scored]).toEqual([6, 6]);
  });

  it('agent: leaves the booked-date and stay-count fields unscored, since its decision cannot state them', () => {
    const amend = { ...golden(0, 'dev'), expected: { workflow: 'quote' as const, bookedArrivalDate: '2026-10-12', stays: 1 } };
    expect(scoreGoldenCase(amend, { decision: decision({}), replayMisses: 0 }).fields.map((f) => f.field)).toEqual(['workflow']);
  });
});
