import * as replayCli from '../scripts/run-reservationist-backtest.js';
import { describe, expect, it } from 'vitest';
import { RunBudget, retryableFailure, freezeSplit, summarizeAttempts, DEFAULT_RUN_LIMITS } from '../src/ai/reservationist-replay.js';
describe('run provenance', () => {
  it('checkpoints time/spend caps and rejects unknown costs', () => {
    const budget = new RunBudget(DEFAULT_RUN_LIMITS, () => 0);
    expect(budget.canStart(0)).toBe(true);
    budget.record({ elapsedMs: 1, estimatedUsd: 25 });
    expect(budget.canStart(0)).toBe(false);
    expect(new RunBudget(DEFAULT_RUN_LIMITS, () => 8 * 3600000).canStart(0)).toBe(false);
    const unknown = new RunBudget(DEFAULT_RUN_LIMITS, () => 0);
    unknown.record({ elapsedMs: 1, estimatedUsd: null });
    expect(unknown.canStart(0)).toBe(false);
  });
  it('only retries bounded transient failures', () => {
    expect(retryableFailure('timeout', 1)).toBe(true);
    expect(retryableFailure('rate_limit', 2)).toBe(true);
    for (const kind of ['auth', 'permission', 'business_invalid', 'missing_fixture', 'unknown']) expect(retryableFailure(kind, 1)).toBe(false);
    expect(retryableFailure('timeout', 3)).toBe(false);
  });
  it('keeps related cases and inspected development data out of holdout', () => {
    const split = freezeSplit([{ caseId: 'a', conversationKey: 't1', businessKey: 'same', stratum: 'quote', inspected: true }, { caseId: 'b', conversationKey: 't2', businessKey: 'same', stratum: 'quote', inspected: false }, { caseId: 'c', conversationKey: 't2', businessKey: 'new', stratum: 'quote', inspected: false }], 'seed');
    expect(split.cases.map(c => c.lane)).toEqual(['development', 'development', 'development']);
    expect(split.version).toBeTruthy();
  });
  it('successful retry never upgrades first or all-three scores and missing remains visible', () => {
    const summary = summarizeAttempts(['a', 'b'], [{ caseId: 'a', attempt: 1, pass: false }, { caseId: 'a', attempt: 2, pass: true }, { caseId: 'a', attempt: 3, pass: true }], ['a']);
    expect(summary).toMatchObject({ declared: 2, firstPass: 0, allThreePass: 0, unprocessed: 1, failedAttempts: 1 });
  });
});

it('CLI checkpoints before model and propagates elapsed abort, scores first attempts', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../scripts/run-reservationist-backtest.ts', import.meta.url), 'utf8');
  expect(source).toContain('budget.canStart(costConfig.caseReserveUsd)');
  expect(source).toContain('signal:controller.signal');
  expect(source).toContain("appendPrivate(ledgerPath, provenance)");
  expect(source).toContain('traces.filter(t => t.attempt === 1)');
});

it('score admission rejects draft assertions, changed corpus input and synthetic qualification',async()=>{
 const {admitReplayAssertion,admitSourceQualification}=await import('../src/ai/reservationist-replay.js');
 const base:any={caseId:'c',inputHash:'h',approval:{status:'independently_adjudicated',version:'v1',reviewerRef:'staff',sourceHashes:['a'.repeat(64)]}};
 expect(admitReplayAssertion(base,'c','h')).toBe(base);
 expect(()=>admitReplayAssertion({...base,approval:{status:'draft'}},'c','h')).toThrow();
 expect(()=>admitReplayAssertion(base,'c','changed')).toThrow();
 expect(()=>admitSourceQualification({coverage:'synthetic'} as any)).toThrow();
});
it('predeclares fresh repeats while rejecting duplicate attempt identities',async()=>{const{nextRepeatAttempt}=await import('../src/ai/reservationist-replay.js');expect(nextRepeatAttempt('a',[] ,['a'])).toBe(1);expect(nextRepeatAttempt('a',[{caseId:'a',attempt:1}],['a'])).toBe(2);expect(nextRepeatAttempt('a',[1,2,3].map(attempt=>({caseId:'a',attempt})),['a'])).toBeNull();expect(()=>nextRepeatAttempt('a',[{caseId:'a',attempt:1},{caseId:'a',attempt:1}],['a'])).toThrow();});
it('text budget wrapper forwards ceilings and denies files/underreserved cost before provider',async()=>{
 const {createBudgetedReplayAdapter}=await import('../src/ai/reservationist-replay.js');let calls=0;
 const route={routeId:'azure-foundry-luna',releaseId:'release',modelId:'gpt-6-luna',purpose:'extraction' as const,provider:'azure-foundry',deployment:'gpt-6-luna'};
 const budget={version:'v1',maxInputTokens:8192,maxOutputTokens:100,maxModelCalls:8,reservedUsd:1};
 const adapter:any={invoke:async(input:any)=>{calls++;expect(input.maxOutputTokens).toBe(100);expect(input.maxInputBytes).toBe(4096);return{modelId:route.modelId,output:{},provenance:{...route,usageSource:'reported'},usage:{inputTokens:1,outputTokens:1,totalTokens:2,estimatedCostUsd:0.000002,rateTableVersion:'v'}};}};
 const bounded=createBudgetedReplayAdapter(adapter,{route,tokenLimits:budget,cost:{version:'v',inputUsdPerMillion:1,outputUsdPerMillion:1}});
 await bounded.invoke({modelId:route.modelId,systemPrompt:'s',userPrompt:'u'});expect(calls).toBe(1);
 await expect(bounded.invoke({modelId:route.modelId,systemPrompt:'s',userPrompt:'u',files:[{filename:'s.pdf',mediaType:'application/pdf',data:new Uint8Array([1])}]})).rejects.toThrow('multimodal');expect(calls).toBe(1);
 expect(()=>createBudgetedReplayAdapter(adapter,{route,tokenLimits:{...budget,reservedUsd:0.001},cost:{version:'v',inputUsdPerMillion:1,outputUsdPerMillion:1}})).toThrow('reserve');
});


it('CLI uses frozen exposure evidence and treats absent records as unknown',async()=>{
 const project=(replayCli as any).freezeRecordedExposure;expect(typeof project).toBe('function');
 const cases=[{threadId:'t',trigger:{id:'c',text:'Please quote.',subject:'Quote'},context:[]}];
 const unknown=project(cases,undefined);expect(unknown.cases[0]).toMatchObject({lane:'development',exposure:'exposure_unknown',holdoutEligible:false});
 const manifest={schemaVersion:'reservationist-exposure-manifest-v1',frozenAt:'2026-10-04T00:00:00Z',authority:'reservationist-recovery-user-20261004',sourceManifestSha256:'a'.repeat(64),absenceNeverMeansUntouched:true,rows:[{caseId:'c',conversationGroupId:'t',businessGroupId:'b',lane:'development',exposure:'reviewed',evidence:[{finding:'explicit inspected source'}],holdoutEligible:false}]};
 const frozen=project(cases,manifest);expect(frozen.cases[0]).toMatchObject({lane:'development',exposure:'reviewed',holdoutEligible:false});
 expect(frozen.version).not.toBe(unknown.version);
 expect(()=>project(cases,{...manifest,rows:[{...manifest.rows[0],lane:'holdout',exposure:'reviewed',holdoutEligible:true}]})).toThrow('exposure_manifest_invalid');
 expect(()=>project(cases,{...manifest,sourceManifestSha256:'missing'})).toThrow('exposure_manifest_invalid');
});
