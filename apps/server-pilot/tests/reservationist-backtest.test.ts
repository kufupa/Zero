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
