import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as replayCli from '../scripts/run-reservationist-backtest.js';
import { deriveReservationistTaskKinds, deriveReservationistAskSpans } from '../src/ai/worker.js';
import { runReservationistRuntime } from '../src/ai/reservationist-runtime.js';
import type { ReplayAssertionApproval } from '../src/ai/reservationist-replay.js';
const runner = readFileSync(new URL('../scripts/run-reservationist-backtest.ts', import.meta.url), 'utf8');
describe('runner fail-closed contract', () => {
  it('defaults to replay, rejects smoke flags and removes evaluator gates', () => {
    expect(runner).toContain("mode: { type: 'string', default: 'replay' }");
    expect(runner).not.toContain("['liveQuoteOk', c.oracle.quote]");
    expect(runner).toContain('assertCompatibleManifest');
    expect(runner).toContain('validateRunId');
    expect(runner).toContain('Migration: --dry-tools');
  });
  it('reviews without showing deterministic verdict and keys traces by inbound', () => {
    expect(runner).not.toContain('<l1>');
    expect(runner).toContain('t.caseId');
    expect(runner).toContain("help: { type: 'boolean'");
  });
});

it('CLI calls shared runtime replay instead of legacy free-prose agent',()=>{
 expect(runner).toContain('await runSharedReservationistReplay(');
 expect(runner).not.toContain('await agent.generate(');
 expect(runner).toContain('approved-assertions.jsonl');
 expect(runner).toContain('shared-replay-fixtures.jsonl');
});
it('CLI default deterministic replay is no-paid and traces bind full manifest',()=>{
 expect(runner).not.toContain('adapter:new LunaModelAdapter(');
 expect(runner).toContain('deterministic_paid_adapter_unavailable');
 expect(runner).toContain('manifestHash');
 expect(runner).toContain("quote-proposal/quote-revision.ts");
 expect(runner).toContain('trace_manifest_or_declared_case_mismatch');
});
it('manifest includes transitive task price/artifact/approval authority and all paths exist',()=>{
 const block=runner.slice(runner.indexOf('const implementationHash'),runner.indexOf('const MODEL_LABEL'));
 for(const name of ['ai/bedrock/azure-luna.ts','ai/reservationist-existing-document.ts','ai/reservationist-current-read.ts','ai/draft-approval.ts','ai/prepared-draft-input.ts','mail/artifacts/read-artifact.ts','quote-proposal/patch-sheet.ts','quote-proposal/patch-template.ts','quote-proposal/gotenberg.ts','hms/quote-request-normalization.ts','hms/quote-stay-contract.ts','hms/quote-stay-candidate.ts','fetch-quote.mjs'])expect(block).toContain(name);
 for(const match of block.matchAll(/'([^']+\.(?:ts|mjs|json))'/g)){
  const relative=match[1]!.includes('/')?'../src/':'../tooling/playwright-quote/';
  expect(()=>readFileSync(new URL(relative+match[1],import.meta.url))).not.toThrow();
 }
});
it('local factory seal rejects forged transport admission without paid invocation',async()=>{
 const {createSharedReplayProductionFactory,verifySharedReplayProductionFactory}=await import('../scripts/run-reservationist-backtest.js');
 const admission:any={route:{routeId:'azure',releaseId:'r',modelId:'gpt-6-luna',purpose:'extraction',provider:'azure-foundry',deployment:'gpt-6-luna'},tokenLimits:{version:'v',maxInputTokens:8192,maxOutputTokens:100,maxModelCalls:8,reservedUsd:1},cost:{version:'v',inputUsdPerMillion:1,outputUsdPerMillion:1}};
 const adapter:any={invoke:async()=>{throw new Error('must not invoke');}};
 const genuine=createSharedReplayProductionFactory({adapter,admissions:[],header:{} as any,converter:{url:'unused'},services:{}},admission);
 expect(verifySharedReplayProductionFactory(genuine,admission)).toBe(true);
 expect(verifySharedReplayProductionFactory({...genuine},admission)).toBe(false);
 expect(verifySharedReplayProductionFactory(genuine,{...admission,cost:{...admission.cost,version:'changed'}})).toBe(false);
});

it('genuine historical factory preserves unknown spend after bad cost without allowing source execution',async()=>{
 const admission:any={route:{routeId:'route',releaseId:'release',modelId:'gpt-6-luna',purpose:'extraction',provider:'azure-foundry',deployment:'gpt-6-luna'},tokenLimits:{version:'tokens',maxInputTokens:80000,maxOutputTokens:1000,maxModelCalls:2,reservedUsd:1},cost:{version:'cost',inputUsdPerMillion:1,outputUsdPerMillion:1}};let calls=0;
 const adapter:any={invoke:async()=>{calls++;return {modelId:'gpt-6-luna',output:{facts:[],tasks:[],unresolvedAsks:[]},provenance:{usageSource:'reported',routeId:'route',modelId:'gpt-6-luna',purpose:'extraction'},usage:{inputTokens:100,outputTokens:50,totalTokens:150,estimatedCostUsd:30,rateTableVersion:'cost'}};}};
 const factory=replayCli.createSharedReplayProductionFactory({adapter,admissions:[],header:{} as any,converter:{url:'unused'},services:{}},admission);expect(replayCli.verifySharedReplayProductionFactory(factory,admission)).toBe(true);
 const input:any={version:1,requestId:'inbound',propertyCode:'HRCEN',authorizationScope:{ownerRef:'owner',threadId:'thread'},trigger:{id:'inbound',at:'2026-10-04T10:00:00Z'},messages:[{id:'inbound',at:'2026-10-04T10:00:00Z',direction:'inbound',text:'Please quote.'}],authorizedArtifacts:[],clock:{causalAt:'2026-10-04T10:00:00Z',sourceAt:'2026-10-04T10:00:00Z',deadlineAt:Date.now()+60000},capabilities:{pmsWrite:false,emailSend:false}};
 await expect(factory.dependencies.plan(input,new AbortController().signal)).rejects.toThrow(/cost/);await expect(factory.dependencies.plan(input,new AbortController().signal)).rejects.toThrow(/unknown/);expect(calls).toBe(1);expect(factory.collectUsage()).toMatchObject({known:false,inputTokens:null,outputTokens:null,estimatedCostUsd:null});
});
const replayCase:any={threadId:'synthetic-thread',trigger:{id:'incoming',eventAt:'2026-10-04T10:00:00Z',direction:'inbound',text:'Please quote. Is parking available? Is wifi available?'},context:[{id:'earlier',eventAt:'2026-10-03T10:00:00Z',direction:'outbound',text:'Private account detail.'}]};
const replayFixture:any={sourceAt:'2026-10-04T10:00:00Z',authorizationScope:{ownerRef:'synthetic-owner',threadId:'synthetic-thread'},authorizedArtifacts:[],requiredTaskIds:['fixture-only'],requiredArtifactRefs:[]};
it('replay derives all request obligations from the same worker functions before fixture matching',()=>{
 expect(replayCli.buildReplayRuntimeInput).toBeTypeOf('function');
 const input=replayCli.buildReplayRuntimeInput(replayCase,replayFixture,Date.now()+60000);
 expect(input.requiredTaskKinds).toEqual(deriveReservationistTaskKinds(replayCase.trigger.text));
 expect(input.requiredAskSpans).toEqual(deriveReservationistAskSpans(replayCase.trigger.text,replayCase.trigger.id));
 expect(input.requiredAskSpans).toHaveLength(2);
 expect(input.requiredTaskIds).toBeUndefined();
 expect(input.messages.map(m=>m.disclosure)).toEqual(['staff_only','guest']);
 expect(input.clock.sourceMode).toBe('historical');
});
it('fixture cannot omit a second ask or replace an ask source with fixture-only IDs',async()=>{
 expect(replayCli.buildReplayRuntimeInput).toBeTypeOf('function');
 const input=replayCli.buildReplayRuntimeInput(replayCase,replayFixture,Date.now()+60000);
 let executions=0;
 const first=input.requiredAskSpans![0];
 const source={attachmentId:first.sourceId,sourceHash:createHash('sha256').update(replayCase.trigger.text).digest('hex'),page:1,quote:first.text,start:first.start,end:first.end};
 await expect(runReservationistRuntime(input,{plan:async()=>({tasks:[{id:'quote',kind:'quote',required:true},{id:'parking',kind:'question',required:true,source}],facts:[]}),execute:async()=>{executions++;throw new Error('must not execute');}})).rejects.toThrow('required_obligation_omitted');
 expect(executions).toBe(0);
});
it('replay input builder rejects future source and causal context before fixture or model work',()=>{
 expect(replayCli.buildReplayRuntimeInput).toBeTypeOf('function');
 expect(()=>replayCli.buildReplayRuntimeInput(replayCase,{...replayFixture,sourceAt:'2026-10-05T10:00:00Z'},Date.now()+60000)).toThrow('historical_replay_clock_required');
 expect(()=>replayCli.buildReplayRuntimeInput({...replayCase,context:[{...replayCase.context[0],eventAt:'2026-10-05T10:00:00Z'}]},replayFixture,Date.now()+60000)).toThrow('causal_input_invalid');
});
it('replay attachments bind original causal descriptors, scope, locator and qualified source hash',()=>{
 const descriptor={id:'original-pdf',messageId:'earlier',filename:'Original.pdf',contentType:'application/pdf',byteSize:100,s3Key:'synthetic/private/original.pdf'};
 const c={...replayCase,context:[{...replayCase.context[0],documents:[descriptor]}]};
 const artifact={attachmentId:descriptor.id,messageId:descriptor.messageId,s3Key:descriptor.s3Key,mimeType:descriptor.contentType,sizeBytes:descriptor.byteSize,sourceHash:'a'.repeat(64),ownerRef:replayFixture.authorizationScope.ownerRef,threadId:replayCase.threadId};
 const f={...replayFixture,authorizedArtifacts:[artifact],sourceQualification:{sourceHashes:[artifact.sourceHash]}};
 expect(replayCli.buildReplayRuntimeInput(c,f,Date.now()+60000).authorizedArtifacts).toEqual([{attachmentId:artifact.attachmentId,sourceHash:artifact.sourceHash}]);
 for(const changed of [{attachmentId:'future-pdf'},{s3Key:'synthetic/other.pdf'},{ownerRef:'other'},{messageId:'incoming'},{sourceHash:'b'.repeat(64)}])expect(()=>replayCli.buildReplayRuntimeInput(c,{...f,authorizedArtifacts:[{...artifact,...changed}]},Date.now()+60000)).toThrow('causal_attachment_inventory_unbound');
 expect(()=>replayCli.buildReplayRuntimeInput(c,{...f,authorizedArtifacts:[]},Date.now()+60000)).toThrow('causal_attachment_inventory_unbound');
});
it('programmatic replay reaches missing-cost admission without invoking a model or writing a run',async()=>{
 const costPath=new URL('../../../.private/reservationist-backtest/corpus/azure-cost-estimate.json',import.meta.url);
 const {existsSync}=await import('node:fs');
 expect(existsSync(costPath)).toBe(false);
 await expect(replayCli.runPhase('a','synthetic-cost-admission','replay',false)).rejects.toThrow('missing_cost_estimate');
});

describe('bounded blind review lane',()=>{
 function reviewFixture(){
  const c:any={threadId:'thread',trigger:{id:'case',eventAt:'2026-10-04T10:00:00Z',direction:'inbound',text:'Please quote.',subject:'Quote',from:'test@example.invalid'},context:[],goldId:'gold',goldText:'Staff source quotation',stratum:'quote_fit',oracle:{quote:true,party:false,create:false},approvedFacts:{requiredCalls:[],bodyClauses:['Price'],moneyCents:[]}};
  const manifest:any={schemaVersion:'reservationist-per-inbound-v2',runId:'review-test',cases:[{caseId:'case',inputHash:(replayCli as any).reviewFingerprint?.({trigger:c.trigger,context:c.context})??createHash('sha256').update('pending').digest('hex')}]};
  return{c,manifest};
 }
 const admission:any={route:{routeId:'judge-route',releaseId:'release',modelId:'gpt-6-luna',purpose:'judge',provider:'azure-foundry',deployment:'gpt-6-luna',protocol:'synthetic'},release:{releaseId:'release',version:'v',sourceRevision:'synthetic-source',fingerprint:'a'.repeat(64),purpose:'judge',issuedAt:'2026-10-01T00:00:00.000Z',expiresAt:'2030-10-04T00:00:00.000Z',withdrawn:false},tokenLimits:{version:'v',maxInputTokens:20000,maxOutputTokens:1000,maxModelCalls:2,reservedUsd:1},cost:{version:'v',inputUsdPerMillion:1,outputUsdPerMillion:1}};
 const approval={status:'independently_adjudicated',version:'v',reviewerRef:'reviewer',sourceHashes:['a'.repeat(64)]} satisfies ReplayAssertionApproval;
 async function fixture(overrides:Record<string,unknown>={}){
  const {fingerprint}=await import('../src/ai/reservationist-replay.js');const {c,manifest}=reviewFixture();manifest.cases[0].inputHash=fingerprint({trigger:c.trigger,context:c.context});
  const runtime:any={version:'reservationist-runtime-v1',readiness:'ready_for_staff_review',tasks:[{id:'q',status:'complete',guestText:'Price',evidenceRefs:[]}],artifacts:[],quoteRefs:[],packets:[],errors:[],assessment:{ok:true},textBody:'Price'};
  const trace:any={manifestHash:fingerprint(manifest),inputHash:manifest.cases[0].inputHash,caseId:'case',threadId:'thread',stratum:'quote_fit',attempt:1,runtime,runtimeMode:'authoritative_source_replay',decision:null,toolCalls:[],usage:null,ms:1,l1Verdict:'LEAK_L1',oracleVerdict:'LEAK_ORACLE'};
  const dimensions={workflow:'pass',money:'pass',artifact:'pass',extraction:'pass',style:'pass',completion:'pass'};
  let received:any;const adapter:any={invoke:async(request:any)=>{received=request;return{modelId:'gpt-6-luna',output:{caseId:'case',verdicts:dimensions,reasons:[]},usage:{inputTokens:100,outputTokens:50,totalTokens:150,latencyMs:1,estimatedCostUsd:0.00015,rateTableVersion:'v'},provenance:{routeId:'judge-route',protocol:'synthetic',modelId:'gpt-6-luna',purpose:'judge',usageSource:'reported'}};}};
  const assertions:any=[{caseId:'case',inputHash:trace.inputHash,approval,runtimeAssertions:{tasks:[{id:'q',status:'complete',evidenceRefs:[]}],bodyClauses:['Price'],moneyCents:[],artifacts:[],quoteRefs:[],packetRequired:false}}];
  const input:any={cases:[c],manifest,traces:[trace],assertions,...overrides};return{input,adapter,admission:structuredClone(admission),approval,received:()=>received,reviewApproval(){return {...approval,sourceHashes:[...approval.sourceHashes],admissionHash:fingerprint(this.admission),manifestHash:fingerprint(input.manifest)};}};
 }
 it('reviews actual facts/output/gold without deterministic verdicts and records separate outcomes',async()=>{
  const f=await fixture();const r=await (replayCli as any).runReservationistReview(f.input,{adapter:f.adapter,admission:f.admission,approval:f.reviewApproval(),signal:new AbortController().signal});
  expect(r.rows[0]).toMatchObject({caseId:'case',pass:true,verdicts:{workflow:'pass',money:'pass',artifact:'pass',extraction:'pass',style:'pass',completion:'pass'}});expect(f.received().userPrompt).toContain('Staff source quotation');expect(f.received().userPrompt).not.toMatch(/LEAK_L1|LEAK_ORACLE|"oracle"|"approvedFacts"/);expect(f.received().signal).toBeInstanceOf(AbortSignal);expect(r.summary).toMatchObject({declared:1,pass:1,reviewed:1});
 });
 it('counts missing traces/assertions/reviewer as nonpass without dropping cases',async()=>{
  const f=await fixture({traces:[]});const r=await (replayCli as any).runReservationistReview(f.input,{signal:new AbortController().signal});expect(r.rows).toHaveLength(1);expect(r.summary).toMatchObject({declared:1,pass:0});expect(r.rows[0].verdicts.completion).toBe('abstain');
 });
 it('never grants completion for a prepared pending action even if reviewer says pass',async()=>{
  const f=await fixture();f.input.traces[0].runtime.readiness='pending_pms_action';f.input.traces[0].runtime.tasks[0].status='pending_pms_action';const r=await (replayCli as any).runReservationistReview(f.input,{adapter:f.adapter,admission:f.admission,approval:f.reviewApproval(),signal:new AbortController().signal});expect(r.rows[0].pass).toBe(false);expect(r.rows[0].verdicts.completion).toBe('fail');
 });
 it('bounds source text and does not call an adapter without reviewer approval',async()=>{
  const f=await fixture();let calls=0;f.adapter.invoke=async()=>{calls++;throw new Error('must not invoke');};await (replayCli as any).runReservationistReview(f.input,{adapter:f.adapter,admission:f.admission,signal:new AbortController().signal});expect(calls).toBe(0);
  f.input.cases[0].goldText='x'.repeat(200000);const r=await (replayCli as any).runReservationistReview(f.input,{adapter:f.adapter,admission:f.admission,approval:f.reviewApproval(),signal:new AbortController().signal});expect(calls).toBe(0);expect(r.rows[0].pass).toBe(false);
 });
 it('aborts a reviewer that ignores cancellation and leaves remaining cases nonpass',async()=>{
  const f=await fixture();f.adapter.invoke=()=>new Promise(()=>{});const controller=new AbortController();const pending=(replayCli as any).runReservationistReview(f.input,{adapter:f.adapter,admission:f.admission,approval:f.reviewApproval(),signal:controller.signal});controller.abort(new Error('cancelled'));const result=await pending;expect(result.rows).toHaveLength(1);expect(result.rows[0].pass).toBe(false);expect(result.summary.pass).toBe(0);
 });
 it('preserves correct independently required clarification and abstains only style without gold',async()=>{
  const f=await fixture();f.input.cases[0].goldText='';f.input.traces[0].runtime.readiness='needs_clarification';f.input.traces[0].runtime.tasks[0].status='needs_clarification';f.input.assertions[0].runtimeAssertions.tasks[0].status='needs_clarification';const r=await replayCli.runReservationistReview(f.input,{adapter:f.adapter,admission:f.admission,approval:f.reviewApproval() as any,signal:new AbortController().signal});expect(r.rows[0].verdicts.completion).toBe('pass');expect(r.rows[0].verdicts.style).toBe('abstain');expect(r.summary.byDimension.money.pass).toBe(1);
 });
 it('retains unreviewed cases after model call budget is exhausted',async()=>{
  const f=await fixture();const {fingerprint}=await import('../src/ai/reservationist-replay.js');f.admission={...f.admission,tokenLimits:{...f.admission.tokenLimits,maxModelCalls:1}};const c={...f.input.cases[0],trigger:{...f.input.cases[0].trigger,id:'second'}};f.input.cases.push(c);f.input.manifest.cases.push({caseId:'second',inputHash:fingerprint({trigger:c.trigger,context:c.context})});f.input.traces[0].manifestHash=fingerprint(f.input.manifest);f.input.traces.push({...f.input.traces[0],caseId:'second',inputHash:f.input.manifest.cases[1].inputHash});f.input.assertions.push({...f.input.assertions[0],caseId:'second',inputHash:f.input.manifest.cases[1].inputHash});const r=await replayCli.runReservationistReview(f.input,{adapter:f.adapter,admission:f.admission,approval:f.reviewApproval() as any,signal:new AbortController().signal});expect(r.summary).toMatchObject({declared:2,modelCalls:1,reviewed:1});expect(r.rows[1].reasons).toContain('review_budget_exhausted');
 });
 it('rejects schema-invalid verdicts and stops after unknown transport spend',async()=>{
  const f=await fixture();f.adapter.invoke=async()=>({modelId:'gpt-6-luna',output:{caseId:'case',verdicts:{workflow:'all_good'},reasons:[]},usage:undefined});const r=await replayCli.runReservationistReview(f.input,{adapter:f.adapter,admission:f.admission,approval:f.reviewApproval() as any,signal:new AbortController().signal});expect(r.rows[0].pass).toBe(false);expect(r.summary.budget.costUnknown).toBe(true);
 });
 it('rejects forged trace binding and schema-invalid reviewer verdict',async()=>{
  const f=await fixture();f.input.traces[0].manifestHash='foreign';const r=await (replayCli as any).runReservationistReview(f.input,{adapter:f.adapter,admission:f.admission,approval:f.reviewApproval(),signal:new AbortController().signal});expect(r.rows[0].pass).toBe(false);expect(f.received()).toBeUndefined();
 });
 function secondCase(f:any,fingerprint:(value:unknown)=>string){
  const c={...f.input.cases[0],trigger:{...f.input.cases[0].trigger,id:'second'}};f.input.cases.push(c);f.input.manifest.cases.push({caseId:'second',inputHash:fingerprint({trigger:c.trigger,context:c.context})});f.input.traces[0].manifestHash=fingerprint(f.input.manifest);f.input.traces.push({...f.input.traces[0],caseId:'second',inputHash:f.input.manifest.cases[1].inputHash});f.input.assertions.push({...f.input.assertions[0],caseId:'second',inputHash:f.input.manifest.cases[1].inputHash});
 }
 it.each(['calls','output','cost','approval','manifest','runtime','invoke','limits'] as const)('rejects reviewer mutation of %s authority and leaves remaining cases nonpass',async change=>{
  const f=await fixture(),{fingerprint}=await import('../src/ai/reservationist-replay.js');secondCase(f,fingerprint);f.admission.tokenLimits.maxModelCalls=1;
  const approved=f.reviewApproval(),original=f.adapter.invoke;let calls=0;
  f.adapter.invoke=async(request:any)=>{calls++;const response=await original(request);if(change==='calls')f.admission.tokenLimits.maxModelCalls=8;if(change==='output'){f.admission.tokenLimits.maxOutputTokens=30000;response.usage.outputTokens=20000;response.usage.totalTokens=20100;}if(change==='cost')f.admission.cost.inputUsdPerMillion=0.001;if(change==='approval')approved.sourceHashes[0]='b'.repeat(64);if(change==='manifest')f.input.manifest.runId='mutated';if(change==='runtime')f.input.traces[0].runtime.tasks[0].guestText='mutated';if(change==='invoke')f.adapter.invoke=async()=>response;if(change==='limits')reviewOptions.limits.spendUsd=26;return response;};
  const reviewOptions:any={adapter:f.adapter,admission:f.admission,approval:approved,signal:new AbortController().signal,limits:{...((await import('../src/ai/reservationist-replay.js')).DEFAULT_RUN_LIMITS)}};const r=await replayCli.runReservationistReview(f.input,reviewOptions);expect(calls).toBe(1);expect(r.rows[0].reviewed).toBe(false);expect(r.rows[0].pass).toBe(false);expect(r.summary.budget.costUnknown).toBe(true);expect(r.rows).toHaveLength(2);expect(r.rows[1].reviewed).toBe(false);
 });
 it.each(['price','version'] as const)('stops subsequent reviewer calls after unproved reported %s',async change=>{
  const f=await fixture(),{fingerprint}=await import('../src/ai/reservationist-replay.js');secondCase(f,fingerprint);let calls=0;const original=f.adapter.invoke;
  f.adapter.invoke=async(request:any)=>{calls++;const response=await original(request);if(change==='price')response.usage.estimatedCostUsd=30;else response.usage.rateTableVersion='unapproved';return response;};
  const r=await replayCli.runReservationistReview(f.input,{adapter:f.adapter,admission:f.admission,approval:f.reviewApproval(),signal:new AbortController().signal});expect(calls).toBe(1);expect(r.rows[0].reviewed).toBe(false);expect(r.summary.budget.costUnknown).toBe(true);expect(r.rows[1].reviewed).toBe(false);
 });
 it.each(['release','protocol','seal','reserve','nonfinite','limits','infinite_limits','deadline_limit'] as const)('rejects unapproved reviewer %s before dispatch',async change=>{
  const f=await fixture(),approved=f.reviewApproval();let calls=0;const original=f.adapter.invoke;f.adapter.invoke=async(request:any)=>{calls++;return original(request);};
  if(change==='release')f.admission.release.withdrawn=true;if(change==='protocol')f.admission.route.protocol='unapproved';if(change==='seal')approved.admissionHash='c'.repeat(64);if(change==='reserve')f.admission.tokenLimits.reservedUsd=0.021;if(change==='nonfinite')f.admission.tokenLimits.reservedUsd=NaN;
  const r=await replayCli.runReservationistReview(f.input,{adapter:f.adapter,admission:f.admission,approval:change==='reserve'||change==='nonfinite'?f.reviewApproval():approved,signal:new AbortController().signal,...(['limits','infinite_limits','deadline_limit'].includes(change)?{limits:{...((await import('../src/ai/reservationist-replay.js')).DEFAULT_RUN_LIMITS),...(change==='limits'?{spendUsd:26}:change==='infinite_limits'?{durationMs:Infinity}:{caseDeadlineMs:2700001})}}:{})} as any);expect(calls).toBe(0);expect(r.rows[0].pass).toBe(false);expect(r.rows[0].reviewed).toBe(false);
 });
 it('checks full reviewer protocol provenance independently of model identity',async()=>{
  const f=await fixture(),original=f.adapter.invoke;f.adapter.invoke=async(request:any)=>({...await original(request),provenance:{routeId:'judge-route',protocol:'foreign',modelId:'gpt-6-luna',purpose:'judge',usageSource:'reported'}});
  const r=await replayCli.runReservationistReview(f.input,{adapter:f.adapter,admission:f.admission,approval:f.reviewApproval(),signal:new AbortController().signal});expect(r.rows[0].reviewed).toBe(false);expect(r.summary.budget.costUnknown).toBe(true);
 });

});


describe('separate current-read runner',()=>{
 async function currentFixture(){
  const {currentReadInputHash,currentReadScopeDigest}=await import('../src/ai/reservationist-current-read.js');
  const sourceAt='2026-10-04T10:00:00Z',causal='2026-10-01T10:00:00Z',text='Please quote arrival 2026-10-12 departure 2026-10-14.';
  const c:any={threadId:'thread',trigger:{id:'inbound',eventAt:causal,direction:'inbound',text,subject:'Quote',from:'test@example.invalid'},context:[],goldText:'EVALUATOR_SECRET',oracle:{quote:true},stratum:'quote_fit'};
  const source={attachmentId:'message:inbound',sourceHash:createHash('sha256').update(text).digest('hex'),page:1,quote:text,start:0,end:text.length};
  const room={id:'g1',quantity:2,adults:1,children:0,childAges:[]},nativeRequest={propertyCode:'HRCEN',requestedCurrency:'ZAR',arrivalDate:'2026-10-12',departureDate:'2026-10-14',rooms:[room]};let modelCalls=0,nativeCalls=0,received:any;
  const native:any={ref:'native',sha256:'a'.repeat(64),toolVersion:'2',observedAt:sourceAt,request:nativeRequest,result:{outcome:'quote',propertyCode:'HRCEN',groups:[{id:'g1',request:room,completeness:{search:'complete',requiredFacts:'complete'},options:[{id:'selected',room:{code:'STQN',label:'Standard Queen',buildingCode:'MAIN'},rate:{code:'BAR',label:'Best Available'},board:'Room Only R',appliedContext:{},eligibility:'verified',availability:'available',matchStatus:'match',held:false,totals:{taxInclusive:true},nightly:[{date:'2026-10-12',inventory:5,price:{amount:'100.00',currency:'ZAR'}},{date:'2026-10-13',inventory:5,price:{amount:'150.00',currency:'ZAR'}}]}]}]}};
  const resolver:any={version:'source-v1',releaseId:'release',sourceRevision:'source',fingerprint:'a'.repeat(64),issuedAt:'2026-10-01T00:00:00Z',expiresAt:'2030-01-01T00:00:00Z',withdrawn:false,protocol:'in_process',access:'current_app',egress:'none',pmsWrite:false,emailSend:false,coverage:'synthetic',authorizeRun:async()=>true,resolveCase:async(ctx:any,signal:AbortSignal)=>{
   received=ctx;const input:any={version:1,requestId:ctx.caseId,propertyCode:'HRCEN',authorizationScope:{ownerRef:'mailbox',threadId:ctx.causalCase.threadId},trigger:{id:ctx.caseId,at:ctx.causalCase.trigger.eventAt},messages:[...ctx.causalCase.context,ctx.causalCase.trigger].map((m:any)=>({id:m.id,at:m.eventAt,direction:m.direction,text:m.text,disclosure:m.direction==='inbound'?'guest':'staff_only'})),authorizedArtifacts:[],requiredTaskKinds:deriveReservationistTaskKinds(ctx.causalCase.trigger.text),requiredAskSpans:deriveReservationistAskSpans(ctx.causalCase.trigger.text,ctx.caseId),clock:{causalAt:ctx.causalCase.trigger.eventAt,sourceAt:ctx.sourceAt,sourceMode:'current_read',deadlineAt:ctx.deadlineAt},capabilities:{pmsWrite:false,emailSend:false}};
   const admission:any={version:'reservationist-current-read-v1',coverage:'synthetic',authorizationId:'grant',inputHash:currentReadInputHash(input),scopeDigest:'',sourceAt:ctx.sourceAt,sources:[{sourceRef:'native',sourceHash:'a'.repeat(64),toolVersion:'2',observedAt:sourceAt,expiresAt:'2026-10-04T11:00:00Z',maxSourceAgeMs:3600000}],sourcePolicy:{version:'policy-v1',sourceHashes:['b'.repeat(64)],vat:'included',levy:'included'},requestedQuotes:[{groupId:'g1',arrivalDate:nativeRequest.arrivalDate,departureDate:nativeRequest.departureDate,quantity:2,adults:1,children:0,childAges:[],roomCode:'STQN',rateCode:'BAR',board:'room_only',context:{},currency:'ZAR'}],requestedReads:[],budget:{route:{routeId:'route',releaseId:'release',modelId:'gpt-6-luna',purpose:'extraction',provider:'azure-foundry',deployment:'gpt-6-luna'},tokenLimits:{version:'tokens',maxInputTokens:65536,maxOutputTokens:8192,maxModelCalls:2,reservedUsd:1},cost:{version:'cost',inputUsdPerMillion:1,outputUsdPerMillion:1}}};admission.scopeDigest=currentReadScopeDigest(input,admission);
   const factory:any={adapter:{invoke:async()=>{modelCalls++;return {modelId:'gpt-6-luna',output:{facts:[{id:'dates',kind:'dates',value:{arrival:'2026-10-12',departure:'2026-10-14'},source,disclosure:'guest'}],tasks:[{id:'quote',kind:'quote',factIds:['dates'],source}],unresolvedAsks:[]},usage:{inputTokens:100,outputTokens:100,totalTokens:200,latencyMs:1,estimatedCostUsd:0.0002,rateTableVersion:'cost'},provenance:{usageSource:'reported',routeId:'route',modelId:'gpt-6-luna',purpose:'extraction'}};}},admissions:[],header:{attention:'',company:'',clientEmail:'',clientTelephone:'',agency:'',signerName:'',signerEmail:''},converter:{url:'http://synthetic',fetchImpl:async()=>new Response('%PDF-1.4 synthetic',{headers:{'content-type':'application/pdf'}})},services:{resolveQuoteTask:async()=>({propertyCode:'HRCEN',authoredDate:'2026-10-04',selections:[{sourceRef:'native',groupId:'g1',optionId:'selected'}],resolveSource:async()=>{nativeCalls++;return native;},resolvePolicy:async()=>({ref:'policy',propertyCode:'HRCEN',sourceHashes:['b'.repeat(64)],authoredDates:['2026-09-26'],families:[{rateCode:'BAR',board:'room_only'}],vat:'included',levy:'included'}),admission:{authorizationId:'grant',sourceEvaluationAt:sourceAt,maxSourceAgeMs:3600000,expectedRequests:{native:nativeRequest},authorizeSource:async()=>true}}),authorizeGuestProposal:async()=>true}};
   return {input,admission,factory,authorizeAdmission:async()=>true,artifactInventory:[]};
  }};
  return{cases:[c],sourceAt,resolver,received:()=>received,calls:()=>({modelCalls,nativeCalls})};
 }
 it('executes the real current-read quote lane while preserving causal originals and hiding evaluator data',async()=>{
  expect((replayCli as any).runReservationistCurrentRead).toBeTypeOf('function');const f=await currentFixture();const r=await (replayCli as any).runReservationistCurrentRead({cases:f.cases,runId:'current-test',sourceAt:f.sourceAt},{signal:new AbortController().signal,resolver:f.resolver});expect(r.summary).toMatchObject({declared:1,pass:1,historicalTruth:false,qualificationEligible:0});expect(r.rows[0]).toMatchObject({pass:true,mode:'current_reader',historicalTruth:false});expect(f.calls()).toEqual({modelCalls:1,nativeCalls:1});expect(JSON.stringify(f.received())).not.toMatch(/EVALUATOR_SECRET|oracle|gold/);expect(r.manifest.mode).toBe('current-read');
 });
 it('keeps every missing resolver case in the denominator without paid/source defaults',async()=>{
  expect((replayCli as any).runReservationistCurrentRead).toBeTypeOf('function');const f=await currentFixture(),second={...f.cases[0],trigger:{...f.cases[0].trigger,id:'second'}};const r=await (replayCli as any).runReservationistCurrentRead({cases:[...f.cases,second],runId:'current-missing',sourceAt:f.sourceAt},{signal:new AbortController().signal});expect(r.summary).toMatchObject({declared:2,pass:0,notPassed:2,resolverAvailable:false});expect(r.rows).toHaveLength(2);expect(f.calls()).toEqual({modelCalls:0,nativeCalls:0});
 });
 it.each(['source_clock','causal_text','asks','write','denied','reserve'] as const)('rejects unbound current %s before model/native invocation',async bad=>{
  expect((replayCli as any).runReservationistCurrentRead).toBeTypeOf('function');const f=await currentFixture(),resolve=f.resolver.resolveCase;if(bad==='write')f.resolver.pmsWrite=true;if(bad==='denied')f.resolver.authorizeRun=async()=>false;
  f.resolver.resolveCase=async(...args:any[])=>{const result=await resolve(...args);if(bad==='source_clock')result.input.clock.sourceAt='2026-10-05T10:00:00Z';if(bad==='causal_text')result.input.messages[0].text='other';if(bad==='asks')result.input.requiredTaskKinds=[];if(bad==='reserve')result.admission.budget.tokenLimits.reservedUsd=26;return result;};
  const r=await (replayCli as any).runReservationistCurrentRead({cases:f.cases,runId:'current-invalid',sourceAt:f.sourceAt},{signal:new AbortController().signal,resolver:f.resolver});expect(r.rows[0].pass).toBe(false);expect(f.calls()).toEqual({modelCalls:0,nativeCalls:0});
 });
 it('stops after unknown model spend and counts the remaining case',async()=>{
  expect((replayCli as any).runReservationistCurrentRead).toBeTypeOf('function');const f=await currentFixture(),resolve=f.resolver.resolveCase;f.resolver.resolveCase=async(...args:any[])=>{const result=await resolve(...args);result.factory.adapter.invoke=async()=>{throw new Error('unknown_model_spend');};return result;};const second={...f.cases[0],trigger:{...f.cases[0].trigger,id:'second'}};const r=await (replayCli as any).runReservationistCurrentRead({cases:[...f.cases,second],runId:'current-unknown',sourceAt:f.sourceAt},{signal:new AbortController().signal,resolver:f.resolver});expect(r.summary.budget.costUnknown).toBe(true);expect(r.rows).toHaveLength(2);expect(r.rows[1].reasons).toContain('current_read_budget_exhausted');
 });
 it('isolates exact resume identity and repeated first outcomes from historical scores',async()=>{
  expect((replayCli as any).runReservationistCurrentRead).toBeTypeOf('function');const f=await currentFixture(),request={cases:f.cases,runId:'current-repeat',sourceAt:f.sourceAt,repeatCaseIds:['inbound']};const first=await (replayCli as any).runReservationistCurrentRead(request,{signal:new AbortController().signal,resolver:f.resolver});expect(first.rows).toHaveLength(3);expect(first.summary.declared).toBe(1);expect(first.summary.stability).toMatchObject({passedFirst:1,passedAllRepeated:1});const before=f.calls();const resumed=await (replayCli as any).runReservationistCurrentRead({...request,previous:first},{signal:new AbortController().signal,resolver:f.resolver});expect(resumed.rows).toHaveLength(3);expect(f.calls()).toEqual(before);await expect((replayCli as any).runReservationistCurrentRead({...request,sourceAt:'2026-10-05T10:00:00Z',previous:first},{signal:new AbortController().signal,resolver:f.resolver})).rejects.toThrow(/resume|manifest/);expect(first.summary.historicalTruth).toBe(false);
 });
 it('binds resolver release immutably through resolution and aborts an ignoring resolver',async()=>{
  expect((replayCli as any).runReservationistCurrentRead).toBeTypeOf('function');const f=await currentFixture(),resolve=f.resolver.resolveCase;f.resolver.resolveCase=async(...args:any[])=>{const result=await resolve(...args);f.resolver.fingerprint='b'.repeat(64);return result;};const r=await (replayCli as any).runReservationistCurrentRead({cases:f.cases,runId:'current-revoked',sourceAt:f.sourceAt},{signal:new AbortController().signal,resolver:f.resolver});expect(r.rows[0].pass).toBe(false);expect(f.calls().modelCalls).toBe(0);
  f.resolver.resolveCase=()=>new Promise(()=>{});const controller=new AbortController(),pending=(replayCli as any).runReservationistCurrentRead({cases:f.cases,runId:'current-abort',sourceAt:f.sourceAt},{signal:controller.signal,resolver:f.resolver});controller.abort();expect((await pending).rows[0].pass).toBe(false);
 });
 it('rejects exposure provenance changed by the resolver before model or native calls',async()=>{
  const f=await currentFixture(),request={cases:f.cases,runId:'current-exposure-mutated',sourceAt:f.sourceAt,exposureVersion:'sealed-exposure-v1'},resolve=f.resolver.resolveCase;
  f.resolver.resolveCase=async(...args:any[])=>{const result=await resolve(...args);request.exposureVersion='changed-exposure';return result;};
  const r=await (replayCli as any).runReservationistCurrentRead(request,{signal:new AbortController().signal,resolver:f.resolver});
  expect(r.rows[0].pass).toBe(false);expect(r.rows[0].reasons).toContain('current_read_resolver_denied_or_changed');expect(f.calls()).toEqual({modelCalls:0,nativeCalls:0});
 });
 it('marks admission mutation during the model call unknown and stops the next current case',async()=>{
  const f=await currentFixture(),resolve=f.resolver.resolveCase;f.resolver.resolveCase=async(...args:any[])=>{const result=await resolve(...args),invoke=result.factory.adapter.invoke;result.factory.adapter.invoke=async(request:any)=>{const response=await invoke(request);result.admission.budget.cost.inputUsdPerMillion=0.0001;return response;};return result;};const second={...f.cases[0],trigger:{...f.cases[0].trigger,id:'second'}};
  const r=await (replayCli as any).runReservationistCurrentRead({cases:[...f.cases,second],runId:'current-mutated-cost',sourceAt:f.sourceAt},{signal:new AbortController().signal,resolver:f.resolver});expect(r.rows[0].pass).toBe(false);expect(r.summary.budget.costUnknown).toBe(true);expect(r.rows[1].reasons).toContain('current_read_budget_exhausted');
 });
 it('rejects a fabricated pass in a resealed unavailable resume row',async()=>{
  const f=await currentFixture(),request={cases:f.cases,runId:'current-forged',sourceAt:f.sourceAt},previous=await (replayCli as any).runReservationistCurrentRead(request,{signal:new AbortController().signal});previous.rows[0].pass=true;previous.summary.pass=1;const {digest,...data}=previous,{fingerprint}=await import('../src/ai/reservationist-replay.js');previous.digest=fingerprint(data);await expect((replayCli as any).runReservationistCurrentRead({...request,previous},{signal:new AbortController().signal})).rejects.toThrow(/resume|pass/);
 });
 it('recomputes current score denominators instead of trusting a resealed summary',async()=>{
  expect((replayCli as any).scoreCurrentReadReport).toBeTypeOf('function');const f=await currentFixture(),report=await (replayCli as any).runReservationistCurrentRead({cases:f.cases,runId:'current-summary',sourceAt:f.sourceAt},{signal:new AbortController().signal});report.summary.pass=1;report.summary.notPassed=0;const {digest,...data}=report,{fingerprint}=await import('../src/ai/reservationist-replay.js');report.digest=fingerprint(data);expect((replayCli as any).scoreCurrentReadReport(report)).toMatchObject({declared:1,pass:0,notPassed:1,historicalTruth:false});
 });
 it('rejects current mode through the historical programmatic runPhase before cost/source resolution',async()=>{await expect(replayCli.runPhase('a','current-wrong-lane','current-read',false)).rejects.toThrow('historical_runner_mode_required');});
 it('rejects unsafe installed current release before loading any module',async()=>{
  expect((replayCli as any).loadCurrentReadResolver).toBeTypeOf('function');await expect((replayCli as any).loadCurrentReadResolver(JSON.stringify({module:'/tmp/does-not-exist.mjs',release:{pmsWrite:true,emailSend:true}}))).rejects.toThrow('current_read_installed_resolver_invalid');
 });
 it('CLI current-read has a separate installed-source path and cannot enter historical score',()=>{expect(runner).not.toContain("current-read qualification is not enabled by this replay runner");expect(runner).toContain('runCurrentReadPhase');expect(runner).toContain('current_read_report_requires_separate_score');});
});


describe('installed causal local evaluation lane',()=>{
 it('loads a truthful local evaluation adapter through the actual CLI seam',async()=>{
  const {mkdtemp,writeFile}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'reservationist-local-loader-')),module=join(dir,'adapter.mjs');
  const identity={version:'reservationist-local-adapter-v1',kind:'user_authorized_local_evaluation',authorizationSource:'reservationist-recovery-user-20261004',scope:'local_disposable_evaluation',issuedAt:'2026-10-04T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',pmsWrite:false,emailSend:false,productionDraftWrite:false,holdoutEligible:false};
  await writeFile(module,`export const createReservationistLocalEvaluationAdapter=()=>(${JSON.stringify(identity)});`);
  const load=(replayCli as any).loadLocalEvaluationAdapter;expect(typeof load).toBe('function');
  const found=await load(JSON.stringify({module,release:identity}));expect(found.scope).toBe('local_disposable_evaluation');
  await expect(load(JSON.stringify({module,release:{...identity,scope:'production'}}))).rejects.toThrow('local_evaluation_installed_adapter_invalid');
  await expect(load(JSON.stringify({module,release:{...identity,holdoutEligible:true}}))).rejects.toThrow('local_evaluation_installed_release_mismatch');
 });
});
