import { runReservationistRuntime } from '../src/ai/reservationist-runtime.js';
import { describe, expect, it } from 'vitest';
import { runSharedReservationistReplay, createReplayRunners, fingerprint, validateRunId, assertCompatibleManifest, REPLAY_VERSION, type ReplayFixture } from '../src/ai/reservationist-replay.js';

void runReservationistRuntime;
describe('frozen replay', () => {
  const request = { propertyCode: 'HRCEN', rooms: [{ quantity: 1 }] };
  const clock = { causalAt: '2026-09-01T10:00:00Z', sourceAt: '2026-09-01T09:59:00Z', startedMonotonicMs: 0, deadlineMs: 1000 };
  const fixture = { tool: 'quote', requestHash: fingerprint(request), propertyCode: 'HRCEN', observedAt: clock.sourceAt, toolVersion: 'v1', coverage: 'authentic' as const, result: { outcome: 'quote', groups: [] } } satisfies ReplayFixture;
  it('binds exact request, property, source time and version without oracle inputs', async () => {
    const runners = createReplayRunners({ fixtures: [fixture], propertyCode: 'HRCEN', clock, toolVersion: 'v1', now: () => 1 });
    expect(await runners.quote(request)).toEqual(fixture.result);
    expect(await runners.quote({ ...request, rooms: [{ quantity: 2 }] })).toMatchObject({ outcome: 'unavailable' });
    expect(await createReplayRunners({ fixtures: [fixture], propertyCode: 'OTHER', clock, toolVersion: 'v1', now: () => 1 }).quote(request)).toMatchObject({ outcome: 'unavailable' });
    expect(await createReplayRunners({ fixtures: [fixture], propertyCode: 'HRCEN', clock, toolVersion: 'v2', now: () => 1 }).quote(request)).toMatchObject({ outcome: 'unavailable' });
  });
  it('rejects future evidence and elapsed deadline independently', async () => {
    expect(await createReplayRunners({ fixtures: [{ ...fixture, observedAt: '2026-09-02T00:00:00Z' }], propertyCode: 'HRCEN', clock, toolVersion: 'v1', now: () => 1 }).quote(request)).toMatchObject({ outcome: 'unavailable' });
    expect(await createReplayRunners({ fixtures: [fixture], propertyCode: 'HRCEN', clock, toolVersion: 'v1', now: () => 1001 }).quote(request)).toMatchObject({ outcome: 'unavailable' });
  });
  it('fails closed on legacy manifests and unsafe run identifiers', () => {
    for (const id of ['../x', '/tmp/x', '.', 'a/b', 'a\\b']) expect(() => validateRunId(id)).toThrow();
    expect(validateRunId('2026-10-04-a')).toBe('2026-10-04-a');
    expect(() => assertCompatibleManifest({ runId: 'old' }, { schemaVersion: REPLAY_VERSION })).toThrow();
    expect(() => assertCompatibleManifest({ schemaVersion: REPLAY_VERSION, corpusHash: 'x' }, { schemaVersion: REPLAY_VERSION, corpusHash: 'y' })).toThrow();
  });
});

it('executes the shared runtime with exact frozen planning/work and excludes gold', async () => {
  const input:any={version:1,requestId:'m',propertyCode:'HRCEN',trigger:{id:'m',at:'2026-10-04T10:00:00Z'},messages:[{id:'m',at:'2026-10-04T10:00:00Z',direction:'inbound',text:'Thank you'}],authorizedArtifacts:[],requiredTaskIds:['ack'],clock:{causalAt:'2026-10-04T10:00:00Z',sourceAt:'2026-10-04T09:00:00Z',deadlineAt:Date.now()+60000},capabilities:{pmsWrite:false,emailSend:false}};
  const plan={tasks:[{id:'ack',kind:'question',required:false}],facts:[]};
  const work:any={tasks:[{id:'ack',status:'complete',guestText:'Thank you.',evidenceRefs:['causal:m']}],approvedGuestClauses:{ack:'Thank you.'},artifacts:[],quoteRefs:[],packets:[],errors:[]};
  const fixture:any={schemaVersion:'reservationist-shared-fixture-v1',inputHash:fingerprint({...input,clock:{causalAt:input.clock.causalAt,sourceAt:input.clock.sourceAt,sourceMode:'historical'}}),propertyCode:'HRCEN',sourceAt:input.clock.sourceAt,runtimeVersion:'reservationist-runtime-v1',coverage:'synthetic',planHash:fingerprint(plan),work,requiredTaskIds:['ack'],requiredArtifactRefs:[],artifacts:[]};
  let calls=0;const adapter:any={invoke:async()=>{calls++;return {output:plan,usage:{inputTokens:1,outputTokens:1}};}};
  const result=await runSharedReservationistReplay({input,fixture,adapter,signal:new AbortController().signal});
  expect(result.runtime.textBody).toContain('Thank you.');expect(calls).toBe(1);expect(result.runtime.version).toBe('reservationist-runtime-v1');
  await expect(runSharedReservationistReplay({input:{...input,messages:[{...input.messages[0],text:'Changed'}]},fixture,adapter,signal:new AbortController().signal})).rejects.toThrow('fixture');expect(calls).toBe(1);
});
it('historical replay normalizes omitted clock mode and rejects current-reader bypass before planning',async()=>{
 const{sharedReplayInputHash,runQualifiedReservationistReplay}=await import('../src/ai/reservationist-replay.js');
 const input:any={version:1,requestId:'m',propertyCode:'HRCEN',trigger:{id:'m',at:'2026-10-01T00:00:00Z'},messages:[],authorizedArtifacts:[],clock:{causalAt:'2026-10-01T00:00:00Z',sourceAt:'2026-10-01T00:00:00Z',deadlineAt:Date.now()+10000},capabilities:{pmsWrite:false,emailSend:false}};
 expect(sharedReplayInputHash(input)).toBe(sharedReplayInputHash({...input,clock:{...input.clock,sourceMode:'historical'}}));
 expect(sharedReplayInputHash(input)).not.toBe(sharedReplayInputHash({...input,clock:{...input.clock,sourceMode:'current_read'}}));
 let calls=0;const deps:any={plan:async()=>{calls++;},execute:async()=>{}};
 await expect(runQualifiedReservationistReplay({...input,clock:{...input.clock,sourceMode:'current_read'}},deps,new AbortController().signal)).rejects.toThrow('historical_replay');
 await expect(runQualifiedReservationistReplay({...input,clock:{...input.clock,sourceAt:'2026-10-02T00:00:00Z'}},deps,new AbortController().signal)).rejects.toThrow('historical_replay');expect(calls).toBe(0);
});

describe('historical paid adapter admission and spend proof',()=>{
 const admission=()=>({route:{routeId:'route',releaseId:'release',modelId:'gpt-6-luna',purpose:'extraction' as const,provider:'azure-foundry',deployment:'gpt-6-luna'},tokenLimits:{version:'tokens',maxInputTokens:20000,maxOutputTokens:1000,maxModelCalls:2,reservedUsd:1},cost:{version:'cost',inputUsdPerMillion:1,outputUsdPerMillion:1}});
 const request={modelId:'gpt-6-luna',systemPrompt:'Extract',userPrompt:'Source',responseSchema:{},signal:new AbortController().signal,deadlineAt:Date.now()+60000};
 const response=()=>({modelId:'gpt-6-luna',output:{facts:[]},provenance:{usageSource:'reported' as const,routeId:'route',protocol:'synthetic',modelId:'gpt-6-luna',purpose:'extraction' as const},usage:{inputTokens:100,outputTokens:50,totalTokens:150,latencyMs:1,estimatedCostUsd:0.00015,rateTableVersion:'cost'}});
 it.each(['price','version','total','negative'] as const)('denies %s spend proof and never dispatches a second paid call',async bad=>{
  const {createBudgetedReplayAdapter}=await import('../src/ai/reservationist-replay.js');let calls=0;const a=admission(),adapter={invoke:async()=>{calls++;const r=response();if(bad==='price')r.usage.estimatedCostUsd=30;if(bad==='version')r.usage.rateTableVersion='foreign';if(bad==='total')r.usage.totalTokens=1;if(bad==='negative')r.usage.inputTokens=-1;return r;}};
  const bounded=createBudgetedReplayAdapter(adapter,a);await expect(bounded.invoke(request)).rejects.toThrow(/cost|usage|provenance/);await expect(bounded.invoke(request)).rejects.toThrow(/unknown|cost/);expect(calls).toBe(1);
 });
 it.each(['calls','cost','tokens','route','invoke'] as const)('refuses %s mutation across a paid invocation',async bad=>{
  const {createBudgetedReplayAdapter}=await import('../src/ai/reservationist-replay.js');let calls=0;const a=admission(),adapter={invoke:async()=>{calls++;if(bad==='calls')a.tokenLimits.maxModelCalls=8;if(bad==='cost')a.cost.inputUsdPerMillion=0.0001;if(bad==='tokens')a.tokenLimits.maxOutputTokens=30000;if(bad==='route')a.route.releaseId='changed';if(bad==='invoke')adapter.invoke=async()=>response();return response();}};
  const bounded=createBudgetedReplayAdapter(adapter,a);await expect(bounded.invoke(request)).rejects.toThrow(/changed|cost|admission/);await expect(bounded.invoke(request)).rejects.toThrow();expect(calls).toBe(1);
 });
 it.each(['infinite','negative','overspend','nan_calls'] as const)('rejects %s budget before invoking paid transport',async bad=>{
  const {createBudgetedReplayAdapter}=await import('../src/ai/reservationist-replay.js');const a=admission(),adapter={invoke:async()=>response()};if(bad==='infinite')a.tokenLimits.reservedUsd=Infinity;if(bad==='negative')a.cost.inputUsdPerMillion=-1;if(bad==='overspend')a.tokenLimits.reservedUsd=26;if(bad==='nan_calls')a.tokenLimits.maxModelCalls=NaN;expect(()=>createBudgetedReplayAdapter(adapter,a)).toThrow();
 });
 it('permits valid exact cost/token evidence under immutable admission',async()=>{
  const {createBudgetedReplayAdapter}=await import('../src/ai/reservationist-replay.js');const a=admission(),bounded=createBudgetedReplayAdapter({invoke:async()=>response()},a);expect((await bounded.invoke(request)).usage.estimatedCostUsd).toBe(0.00015);
 });
 it.each(['draft','judge'] as const)('reserves once and retains exact %s provenance and reported cost',async purpose=>{
  const {createBudgetedReplayAdapter}=await import('../src/ai/reservationist-replay.js');const a={...admission(),route:{...admission().route,purpose}},counts:number[]=[];let calls=0;
  const adapter={reserveCalls:async(count:number)=>{counts.push(count);},invoke:async()=>{calls++;return {...response(),provenance:{...response().provenance,purpose}};}};
  const bounded=createBudgetedReplayAdapter(adapter,a);await bounded.reserveCalls!(2,new AbortController().signal);
  const result=await bounded.invoke(request);expect(result.provenance?.purpose).toBe(purpose);expect(result.usage.estimatedCostUsd).toBe(0.00015);expect(counts).toEqual([2]);expect(calls).toBe(1);
  await expect(bounded.reserveCalls!(1,new AbortController().signal)).rejects.toThrow('replay_reservation_count_or_state');
 });
 it('rejects an unsupported route purpose before transport or reservation',async()=>{
  const {createBudgetedReplayAdapter}=await import('../src/ai/reservationist-replay.js');let calls=0;const a:any=admission();a.route.purpose='send';
  expect(()=>createBudgetedReplayAdapter({invoke:async()=>{calls++;return response();},reserveCalls:async()=>{calls++;}},a)).toThrow('text_budget_reserve_or_transport_invalid');expect(calls).toBe(0);
 });
 it.each(['purpose','route','model','cost'] as const)('makes invalid draft %s evidence terminal after one dispatch',async bad=>{
  const {createBudgetedReplayAdapter}=await import('../src/ai/reservationist-replay.js');let calls=0;const a={...admission(),route:{...admission().route,purpose:'draft' as const}};
  const bounded=createBudgetedReplayAdapter({invoke:async()=>{calls++;const r={...response(),provenance:{...response().provenance,purpose:'draft' as 'draft'|'extraction'}};if(bad==='purpose')r.provenance.purpose='extraction';if(bad==='route')r.provenance.routeId='foreign';if(bad==='model')r.modelId='foreign';if(bad==='cost')r.usage.estimatedCostUsd=0;return r;}},a);
  await expect(bounded.invoke(request)).rejects.toThrow(/provenance|cost/);await expect(bounded.invoke(request)).rejects.toThrow('replay_cost_unknown');expect(calls).toBe(1);
 });
 it.each(['draft','judge'] as const)('does not admit %s as historical source qualification',async purpose=>{
  const {admitSourceQualification}=await import('../src/ai/reservationist-replay.js');const row:any={version:'v',coverage:'authentic',authorizationId:'auth',scopeDigest:'scope',inputHash:'input',sourceHashes:['a'.repeat(64)],toolVersion:'v',observedAt:'2026-10-04T00:00:00Z',route:admission().route,tokenLimits:admission().tokenLimits};
  expect(admitSourceQualification(row)).toBe(row);row.route.purpose=purpose;expect(()=>admitSourceQualification(row)).toThrow('source_qualification_unavailable');
 });
});
