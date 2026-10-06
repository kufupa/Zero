import {quoteDigest} from '../src/quote-proposal/quote-revision.js';
import {runQualifiedReservationistCurrentRead} from '../src/ai/reservationist-current-read.js';
import {createReservationistDependencies} from '../src/ai/reservationist-execution.js';
import {deriveReservationistTaskKinds,deriveReservationistAskSpans} from '../src/ai/worker.js';
import type {ReservationistRuntimeInput} from '../src/ai/reservationist-runtime.js';
import {z} from 'zod';
import type {ModelAdapter} from '../src/ai/bedrock/adapter.js';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertCompatibleManifest, createReplayRunners, fingerprint, REPLAY_VERSION, validateRunId, type ReplayFixture, RunBudget, DEFAULT_RUN_LIMITS, freezeSplit, summarizeAttempts, type AttemptProvenance, runSharedReservationistReplay, sharedReplayInputHash, type SharedReplayFixture, runQualifiedReservationistReplay, type SharedReplayDependencies, admitReplayAssertion, admitSourceQualification, nextRepeatAttempt, type ReplayAssertionApproval, createBudgetedReplayAdapter, type ReplayTextBudget } from '../src/ai/reservationist-replay.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type ReservationistDecision,
} from '../src/ai/reservationist-agent.js';
import {
  buildCases,
  describeRun,
  pickPhaseA,
  scoreCase,
  scoreRuntimeReplay,
  type RuntimeReplayAssertions,
  summarizeL1,
  type BacktestCase,
  type CaseMessage,
  type ToolCall,
} from '../src/ai/reservationist-backtest.js';
import {
  CENTURION_BACKTEST_WINDOW,
  type CenturionCorpusMessageRow,
} from '../src/ops/centurion-thread-corpus-postgres-reader.js';

const ROOT = fileURLToPath(new URL('../../../.private/reservationist-backtest/', import.meta.url));
const CORPUS = join(ROOT, 'corpus', 'messages.jsonl');
const MAX_STEPS = DEFAULT_RUN_LIMITS.maxModelTurns;
const MAX_MESSAGE_CHARS = 20_000;
const implementationHash = () => fingerprint([
 'ai/reservationist-replay.ts','ai/reservationist-backtest.ts','ai/reservationist-runtime.ts','ai/reservationist-execution.ts','ai/reservationist-source-facts.ts','ai/reservationist-extraction.ts','ai/reservationist-document-facts.ts','ai/reservationist-attachment-input.ts','ai/reservationist-attachment-acquisition.ts','ai/reservationist-evaluation-composition.ts','ai/reservationist-independent-evaluation.ts','ai/reservationist-paid-lease.ts','ai/reservationist-reserved-cost.ts','ai/reservationist-booking-packet.ts','ai/reservationist-pending-action.ts','ai/reservationist-read-task.ts','ai/reservationist-existing-document.ts','ai/reservationist-current-read.ts','ai/reservationist-provider.ts','ai/draft-approval.ts','ai/prepared-draft-input.ts','ai/reply-assessment.ts','ai/reply-playbooks.ts','ai/draft-evidence.ts','ai/worker.ts','ai/bedrock/adapter.ts','ai/bedrock/luna.ts','ai/bedrock/azure-luna.ts','ai/bedrock/local.ts',
 'quote-proposal/quote-revision.ts','quote-proposal/rate-check.ts','quote-proposal/quote-lines.ts','quote-proposal/proposal-pdf.ts','quote-proposal/description.ts','quote-proposal/patch-sheet.ts','quote-proposal/patch-template.ts','quote-proposal/gotenberg.ts','hms/quote-request-normalization.ts','hms/quote-stay-contract.ts','hms/quote-stay-candidate.ts','hms/read-service.ts','hms/read-service-contracts.ts','hms/reservation-context-contract.ts','hms/reservation-context-facade.ts','hms/folio-read-contract.ts','mail/artifacts/read-artifact.ts'
].map(name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8')).concat(['fetch-quote.mjs','create-tool.schema.json','quote-tool.schema.json','quote-contract.mjs','create-request.mjs'].map(name=>readFileSync(new URL('../tooling/playwright-quote/'+name,import.meta.url),'utf8'))).concat(readFileSync(new URL(import.meta.url),'utf8')));
const MODEL_LABEL = 'azure-foundry:gpt-6-luna/effort-max';

const readJsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T)
    : [];
/** Execution resume checks prior cases; deterministic scores always retain first attempts. */


const writePrivate = (path: string, text: string) => writeFileSync(path, text, { mode: 0o600 });
const appendPrivate = (path: string, row: unknown) =>
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });


function loadCases() {
  return buildCases(readJsonl<CenturionCorpusMessageRow>(CORPUS));
}

export function freezeRecordedExposure(cases:readonly Pick<BacktestCase,'threadId'|'trigger'>[],manifest?:any){
 if(manifest&&(manifest.schemaVersion!=='reservationist-exposure-manifest-v1'||manifest.authority!=='reservationist-recovery-user-20261004'||manifest.absenceNeverMeansUntouched!==true||!/^[a-f0-9]{64}$/.test(manifest.sourceManifestSha256??'')||!Number.isFinite(Date.parse(manifest.frozenAt))||!Array.isArray(manifest.rows)||new Set(manifest.rows.map((r:any)=>r.caseId)).size!==manifest.rows.length||manifest.rows.some((r:any)=>!r.caseId||!r.conversationGroupId||!r.businessGroupId||r.lane!=='development'||!['reviewed','exposure_unknown'].includes(r.exposure)||r.holdoutEligible!==false||!r.evidence?.length)))throw new Error('exposure_manifest_invalid');
 const rows=cases.map(c=>{
  const recorded=manifest?.rows.find((r:any)=>r.caseId===c.trigger.id),group=recorded?.businessGroupId??fingerprint({threadId:c.threadId,caseId:c.trigger.id});
  return{caseId:c.trigger.id,conversationGroupId:recorded?.conversationGroupId??c.threadId,businessGroupId:group,lane:'development' as const,exposure:recorded?.exposure??'exposure_unknown',holdoutEligible:false,repeat:parseInt(fingerprint({seed:'reservationist-recorded-exposure-v1',group}).slice(0,8),16)%5===0,evidence:recorded?.evidence??[]};
 });
 return {version:fingerprint({manifest:manifest??null,rows}),exposureManifestHash:manifest?fingerprint(manifest):null,cases:rows};
}
function loadRecordedExposure(cases:readonly BacktestCase[]){
 const path=process.env.RESERVATIONIST_EXPOSURE_MANIFEST;
 return freezeRecordedExposure(cases,path?JSON.parse(readFileSync(path,'utf8')):undefined);
}

function loadCostConfig() {
  const path = join(ROOT, 'corpus', 'azure-cost-estimate.json');
  if (!existsSync(path)) throw new Error('missing_cost_estimate: private versioned Azure estimate required before paid execution');
  const c = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof c.version !== 'string' || !c.version || ![c.inputUsdPerMillion, c.outputUsdPerMillion, c.caseReserveUsd].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0) || c.caseReserveUsd >= DEFAULT_RUN_LIMITS.spendUsd) throw new Error('invalid_cost_estimate');
  return c as { version: string; inputUsdPerMillion: number; outputUsdPerMillion: number; caseReserveUsd: number };
}

/** Causal request obligations are code-owned just as in the candidate worker, never fixture-selected. */
export function buildReplayRuntimeInput(c:Pick<BacktestCase,'trigger'|'context'>,fixture:Pick<SharedReplayFixture,'sourceAt'|'authorizationScope'|'authorizedArtifacts'|'requiredArtifactRefs'|'sourceQualification'>,deadlineAt:number):ReservationistRuntimeInput {
 const causalAt=c.trigger.eventAt??'',causal=Date.parse(causalAt),source=Date.parse(fixture.sourceAt);
 if(!Number.isFinite(causal)||!Number.isFinite(source)||source>causal)throw new Error('historical_replay_clock_required');
 const messages=[...c.context,c.trigger].map(m=>({id:m.id,at:m.eventAt??'',direction:m.direction as 'inbound'|'outbound',text:m.text,disclosure:m.direction==='inbound'?'guest' as const:'staff_only' as const}));
 if(c.trigger.direction!=='inbound'||messages.some(m=>!m.id||!['inbound','outbound'].includes(m.direction)||!Number.isFinite(Date.parse(m.at))||Date.parse(m.at)>causal))throw new Error('causal_input_invalid');
 const descriptors=[...c.context,c.trigger].flatMap(message=>(message.documents??[]).map(descriptor=>({message,descriptor}))),inventory=fixture.authorizedArtifacts??[];
 if(descriptors.length>8||inventory.length!==descriptors.length||new Set(descriptors.map(d=>d.descriptor.id)).size!==descriptors.length)throw new Error('causal_attachment_inventory_unbound');
 const authorizedArtifacts=descriptors.map(({message,descriptor})=>{
  const records=inventory.filter(record=>(record as {attachmentId?:unknown})?.attachmentId===descriptor.id) as Array<{attachmentId:string;sourceHash:string;messageId:string;s3Key:string;mimeType:string;sizeBytes:number;ownerRef:string;threadId:string}>;
  const record=records[0],scope=fixture.authorizationScope;
  if(records.length!==1||!record||!scope||descriptor.messageId!==message.id||record.messageId!==message.id||record.s3Key!==descriptor.s3Key||record.mimeType!==descriptor.contentType||record.sizeBytes!==descriptor.byteSize||!Number.isSafeInteger(record.sizeBytes)||record.sizeBytes<1||record.ownerRef!==scope.ownerRef||record.threadId!==scope.threadId||!/^[a-f0-9]{64}$/.test(record.sourceHash)||!fixture.sourceQualification?.sourceHashes.includes(record.sourceHash))throw new Error('causal_attachment_inventory_unbound');
  return {attachmentId:record.attachmentId,sourceHash:record.sourceHash};
 });
 return {version:1,requestId:c.trigger.id,propertyCode:'HRCEN',trigger:{id:c.trigger.id,at:causalAt},messages,authorizationScope:fixture.authorizationScope,authorizedArtifacts,requiredTaskKinds:deriveReservationistTaskKinds(c.trigger.text),requiredAskSpans:deriveReservationistAskSpans(c.trigger.text,c.trigger.id),requiredArtifactRefs:fixture.requiredArtifactRefs,clock:{causalAt,sourceAt:fixture.sourceAt,sourceMode:'historical',deadlineAt},capabilities:{pmsWrite:false,emailSend:false}};
}

function emailBlock(m: CaseMessage) {
  return `<email direction="${m.direction}" at="${m.eventAt}" from="${m.from}" subject="${m.subject}">
${m.text.slice(0, MAX_MESSAGE_CHARS)}
</email>`;
}

function threadPrompt(c: BacktestCase) {
  return `Thread messages oldest first. Handle the LAST message (asOf ${c.trigger.eventAt}); earlier ones are context.

${[...c.context, c.trigger].map(emailBlock).join('\n\n')}`;
}


type Trace = {
  manifestHash:string;
  inputHash:string;
  sourceQualificationHash?:string;
  attempt: number;
  caseId: string;
  threadId: string;
  stratum: string;
  runtimeMode?: 'authoritative_source_replay'|'deterministic_work_fixture';
  runtime?: Awaited<ReturnType<typeof runSharedReservationistReplay>>['runtime'];
  decision: ReservationistDecision | null;
  toolCalls: ToolCall[];
  usage: unknown;
  ms: number;
  error?: string;
};

const sharedFactorySeals=new WeakMap<object,{admissionHash:string;dependencies:SharedReplayDependencies;collector:unknown}>();
export const createSharedReplayProductionFactory = (options: Parameters<typeof createReservationistDependencies>[0], admission:ReplayTextBudget) => {
 const result={...createReservationistDependencies({...options,adapter:createBudgetedReplayAdapter(options.adapter,admission)}),transportAdmissionHash:fingerprint(admission)};
 sharedFactorySeals.set(result,{admissionHash:fingerprint(admission),dependencies:result.dependencies,collector:result.collectUsage});return result;
};
export const verifySharedReplayProductionFactory=(result:object,admission:ReplayTextBudget)=>{
 const seal=sharedFactorySeals.get(result);const candidate=result as QualifiedReplayFactoryResult;
 return Boolean(seal&&seal.admissionHash===fingerprint(admission)&&seal.dependencies===candidate.dependencies&&seal.collector===candidate.collectUsage&&candidate.transportAdmissionHash===seal.admissionHash);
};
export type QualifiedReplayFactoryResult={transportAdmissionHash:string;dependencies:SharedReplayDependencies;collectUsage:()=>{known:boolean;inputTokens:number|null;outputTokens:number|null;estimatedCostUsd:number|null;rateTableVersions:string[]}};
export async function runPhase(phase: 'a' | 'b', runId: string, mode: string, resume: boolean, productionFactory?: (input: Parameters<typeof runQualifiedReservationistReplay>[0],admission:ReplayTextBudget)=>Promise<QualifiedReplayFactoryResult>) {
  if(mode!=='replay')throw new Error('historical_runner_mode_required');
  const all = loadCases();
  const { picked, emptyStrata } = phase === 'a' ? pickPhaseA(all) : { picked: all, emptyStrata: [] };
  console.log(JSON.stringify({ corpus: describeRun(all), phase, run: describeRun(picked), emptyStrata }));
  const dir = join(ROOT, runId);
  const split = loadRecordedExposure(picked);
  const costConfig = loadCostConfig();
  const manifest = { implementationHash:implementationHash(), executionStage:productionFactory?'shared_production_dependencies':'deterministic_work_fixture', limits: DEFAULT_RUN_LIMITS, costConfig, split, fixtureHash: fingerprint(readJsonl(join(ROOT, 'corpus', 'shared-replay-fixtures.jsonl'))), assertionHash: fingerprint(readJsonl(join(ROOT, 'corpus', 'approved-assertions.jsonl'))), runtimeVersion: 'reservationist-runtime-v1', schemaVersion: REPLAY_VERSION, runId, phase, mode, model: MODEL_LABEL, promptVersion: implementationHash(), toolVersion: 'reservationist-tools-v2', scorerVersion: fingerprint({legacy:scoreCase.toString(),runtime:scoreRuntimeReplay.toString()}), corpusHash: fingerprint(readJsonl(CORPUS)), window: CENTURION_BACKTEST_WINDOW, cases: picked.map(c => ({ caseId: c.trigger.id, inputHash: fingerprint({ trigger: c.trigger, context: c.context }) })) };
  if (existsSync(dir)) {
    if (!resume) throw new Error('Output collision: use a new run ID or explicit --resume');
    assertCompatibleManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), manifest);
  } else {
    if (resume) throw new Error('Cannot resume missing run');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivate(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  const fixtures = readJsonl<SharedReplayFixture>(join(ROOT, 'corpus', 'shared-replay-fixtures.jsonl'));
  const tracesPath = join(dir, 'traces.jsonl');
  const ledgerPath = join(dir, 'attempts.jsonl');
  const previous = readJsonl<AttemptProvenance>(ledgerPath);
  const start = performance.now();
  const priorElapsed = previous.reduce((sum, a) => sum + a.elapsedMs, 0);
  const budget = new RunBudget(DEFAULT_RUN_LIMITS, () => priorElapsed + performance.now() - start, previous);
  const repeatSet=split.cases.filter(c=>c.repeat).map(c=>c.caseId);
  for (const [i, c] of picked.flatMap(c=>Array.from({length:repeatSet.includes(c.trigger.id)?3:1},()=>c)).entries()) {
    const attempt=nextRepeatAttempt(c.trigger.id,previous,repeatSet);if(attempt===null)continue;
    if (!budget.canStart(costConfig.caseReserveUsd)) { writePrivate(join(dir, 'checkpoint.json'), JSON.stringify(budget.snapshot(), null, 2)); break; }
    const assertion = readJsonl<{caseId:string;inputHash:string;approval?:ReplayAssertionApproval;approvedFacts:BacktestCase['approvedFacts']}>(join(ROOT, 'corpus', 'approved-assertions.jsonl')).find(a=>a.caseId===c.trigger.id&&a.inputHash===fingerprint({trigger:c.trigger,context:c.context}));
    try{c.approvedFacts=admitReplayAssertion(assertion,c.trigger.id,fingerprint({trigger:c.trigger,context:c.context})).approvedFacts;}catch{appendPrivate(join(dir,'coverage.jsonl'),{caseId:c.trigger.id,state:'unadjudicated',reason:'assertion_approval_missing'});continue;}
    if (!fixtures.length || !c.approvedFacts) { appendPrivate(join(dir, 'coverage.jsonl'), { caseId: c.trigger.id, state: 'unavailable', reason: !fixtures.length ? 'missing_fixture' : 'missing_independent_assertions' }); continue; }
    const controller = new AbortController();
    const remainingMs = Math.min(DEFAULT_RUN_LIMITS.caseDeadlineMs, DEFAULT_RUN_LIMITS.durationMs - priorElapsed - (performance.now() - start));
    const timer = setTimeout(() => controller.abort(new Error('case_timeout')), remainingMs);
    const fixture=fixtures.find(f=>{if(f.propertyCode!=='HRCEN')return false;try{return f.inputHash===sharedReplayInputHash(buildReplayRuntimeInput(c,f,Date.now()+remainingMs));}catch{return false;}});
    if(!fixture){clearTimeout(timer);appendPrivate(join(dir,'coverage.jsonl'),{caseId:c.trigger.id,state:'unavailable',reason:'exact_shared_fixture_missing'});continue;}
    const runtimeInput=buildReplayRuntimeInput(c,fixture,Date.now()+remainingMs);
    const started = Date.now();
    let trace: Trace;
    let qualifiedFactory: QualifiedReplayFactoryResult | undefined;
    try {
      if(productionFactory){const qualification=admitSourceQualification(fixture.sourceQualification);if(qualification.inputHash!==fixture.inputHash||Date.parse(qualification.observedAt)>Date.parse(runtimeInput.clock.causalAt))throw new Error('source_qualification_scope');if(!budget.canStart(qualification.tokenLimits.reservedUsd))throw new Error('budget_reserve_unavailable');const admission={route:qualification.route,tokenLimits:qualification.tokenLimits,cost:costConfig,...(qualification.multimodalQuota?{multimodalQuota:qualification.multimodalQuota}:{})};qualifiedFactory=await productionFactory(runtimeInput,admission);if(!verifySharedReplayProductionFactory(qualifiedFactory,admission))throw new Error('qualified_transport_admission_mismatch');}
      const res=qualifiedFactory ? {runtime:await runQualifiedReservationistReplay(runtimeInput,qualifiedFactory.dependencies,controller.signal),usage:qualifiedFactory.collectUsage()} : await runSharedReservationistReplay({input:runtimeInput,fixture,adapter:{invoke:async()=>{throw new Error('deterministic_paid_adapter_unavailable');}},signal:controller.signal});
      trace={manifestHash:fingerprint(manifest),inputHash:fingerprint({trigger:c.trigger,context:c.context}),sourceQualificationHash:qualifiedFactory?fingerprint(fixture.sourceQualification):undefined,attempt,caseId:c.trigger.id,threadId:c.threadId,stratum:c.stratum,runtime:res.runtime,runtimeMode:productionFactory?'authoritative_source_replay':'deterministic_work_fixture',decision:null,toolCalls:[],usage:res.usage,ms:Date.now()-started};
    } catch (err) {
      trace = {
        manifestHash:fingerprint(manifest),inputHash:fingerprint({trigger:c.trigger,context:c.context}),sourceQualificationHash:qualifiedFactory?fingerprint(fixture.sourceQualification):undefined,
        attempt,
        caseId: c.trigger.id,
        threadId: c.threadId,
        stratum: c.stratum,
        decision: null,
        toolCalls: [],
        usage: null,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    clearTimeout(timer);
    if(qualifiedFactory)trace.usage=qualifiedFactory.collectUsage();
    const usage = trace.usage as { known?:boolean; inputTokens?: number; outputTokens?: number;estimatedCostUsd?:number;rateTableVersions?:string[] } | null;
    const inputTokens = usage?.known===false ? null : usage?.inputTokens ?? null, outputTokens = usage?.known===false ? null : usage?.outputTokens ?? null;
    const calculatedUsd = inputTokens == null || outputTokens == null ? null : (inputTokens * costConfig.inputUsdPerMillion + outputTokens * costConfig.outputUsdPerMillion) / 1000000;
    const estimatedUsd=calculatedUsd===null||!Number.isFinite(usage?.estimatedCostUsd)||usage!.estimatedCostUsd!<0||Math.abs(usage!.estimatedCostUsd!-calculatedUsd)>1e-8||!usage?.rateTableVersions?.length||usage.rateTableVersions.some(version=>version!==costConfig.version)?null:Math.max(calculatedUsd,usage!.estimatedCostUsd!);
    const provenance: AttemptProvenance = { caseId: c.trigger.id, attempt, inputHash: fingerprint({ trigger: c.trigger, context: c.context }), versionsHash: fingerprint(manifest), provider: qualifiedFactory ? fixture.sourceQualification?.route.provider??'unknown' : trace.usage?'azure-foundry':'not_invoked_or_unknown', deployment: qualifiedFactory ? fixture.sourceQualification?.route.deployment??'unknown' : trace.usage?'gpt-6-luna':'not_invoked_or_unknown', inputTokens, outputTokens, costVersion: costConfig.version, estimatedUsd, elapsedMs: trace.ms, errorKind: controller.signal.aborted ? 'timeout' : trace.error ? 'unknown' : undefined };
    appendPrivate(ledgerPath, provenance);
    previous.push(provenance);
    budget.record(provenance);
    appendPrivate(tracesPath, trace);
    writePrivate(join(dir, 'checkpoint.json'), JSON.stringify(budget.snapshot(), null, 2));
    console.log(
      JSON.stringify({
        i: i + 1,
        of: picked.length,
        attempt,
        caseId: c.trigger.id,
        threadId: c.threadId,
        stratum: c.stratum,
        workflow: trace.decision?.workflow ?? null,
        tools: trace.toolCalls.map((t) => t.toolName),
        ms: trace.ms,
        error: trace.error ? 'yes' : undefined,
      }),
    );
  }
}

export const CURRENT_READ_RUN_VERSION='reservationist-current-read-run-v1';
type CurrentCase=Pick<BacktestCase,'threadId'|'trigger'|'context'>;
export type CurrentReadResolver={version:string;releaseId:string;sourceRevision:string;fingerprint:string;issuedAt:string;expiresAt:string;withdrawn:boolean;protocol:'in_process';access:'current_app';egress:'none';pmsWrite:false;emailSend:false;coverage:'synthetic'|'authentic_current_read';authorizeRun:(binding:{manifestHash:string;runId:string;sourceAt:string},signal:AbortSignal)=>Promise<boolean>;resolveCase:(input:{caseId:string;attempt:number;causalCase:CurrentCase;sourceAt:string;deadlineAt:number},signal:AbortSignal)=>Promise<(Omit<Parameters<typeof runQualifiedReservationistCurrentRead>[0],'signal'>&{artifactInventory?:SharedReplayFixture['authorizedArtifacts']})|null>};
export type CurrentReadRunRow={caseId:string;attempt:number;mode:'current_reader';historicalTruth:false;pass:boolean;qualificationEligible:boolean;reasons:string[];runtime?:Awaited<ReturnType<typeof runQualifiedReservationistCurrentRead>>['runtime'];scorecard?:Awaited<ReturnType<typeof runQualifiedReservationistCurrentRead>>['scorecard'];usage?:Awaited<ReturnType<typeof runQualifiedReservationistCurrentRead>>['usage'];estimatedUsd:number|null;elapsedMs:number};
export type CurrentReadRunReport={version:typeof CURRENT_READ_RUN_VERSION;manifest:Record<string,any>;rows:CurrentReadRunRow[];summary:Record<string,any>;digest:string};
function currentResolverIdentity(resolver:CurrentReadResolver|undefined){if(!resolver)return null;const {authorizeRun,resolveCase,...identity}=resolver;return identity;}
function validateCurrentReadRows(report:Pick<CurrentReadRunReport,'manifest'|'rows'>):void{
 const declared=report.manifest.cases as {caseId:string}[],repeat=report.manifest.repeatCaseIds as string[];
 if(!Array.isArray(declared)||!Array.isArray(repeat)||!Array.isArray(report.rows)||new Set(report.rows.map(row=>`${row.caseId}:${row.attempt}`)).size!==report.rows.length)throw new Error('current_read_resume_rows_invalid');
 for(const row of report.rows){
  if(row.mode!=='current_reader'||row.historicalTruth!==false||!declared.some(c=>c.caseId===row.caseId)||!Number.isInteger(row.attempt)||row.attempt<1||row.attempt>(repeat.includes(row.caseId)?3:1)||!Number.isFinite(row.elapsedMs)||row.elapsedMs<0||row.estimatedUsd!==null&&(!Number.isFinite(row.estimatedUsd)||row.estimatedUsd<0)||!Array.isArray(row.reasons))throw new Error('current_read_resume_row_invalid');
  for(let prior=1;prior<row.attempt;prior++)if(!report.rows.some(other=>other.caseId===row.caseId&&other.attempt===prior))throw new Error('current_read_resume_attempt_gap');
  if(row.runtime&&row.runtime.digest!==quoteDigest(Object.fromEntries(Object.entries(row.runtime).filter(([key])=>key!=='digest'))))throw new Error('current_read_resume_runtime_invalid');
  if(row.pass&&(!row.runtime||!row.scorecard||row.scorecard.pass!==true||row.scorecard.version!=='reservationist-current-read-v1'||row.scorecard.sourceAt!==report.manifest.sourceAt||row.scorecard.failures.length||!row.runtime.tasks.length||row.runtime.tasks.some(task=>task.status!=='complete')||row.runtime.errors.length||row.runtime.packets.length||row.reasons.length||row.estimatedUsd===null||!row.usage?.known))throw new Error('current_read_resume_pass_unproved');
  if(row.qualificationEligible&&(!row.pass||report.manifest.resolver?.coverage!=='authentic_current_read'))throw new Error('current_read_resume_qualification_unproved');
 }
}
/** Separate current-source execution; original source text is causal, staff outcomes are never resolver input. */
export async function runReservationistCurrentRead(request:{cases:readonly CurrentCase[];runId:string;sourceAt:string;repeatCaseIds?:readonly string[];previous?:CurrentReadRunReport;exposureVersion?:string},options:{signal:AbortSignal;resolver?:CurrentReadResolver}){
 validateRunId(request.runId);const source=Date.parse(request.sourceAt);if(!Number.isFinite(source)||request.cases.length>2000||new Set(request.cases.map(c=>c.trigger.id)).size!==request.cases.length)throw new Error('current_read_run_input_invalid');
 const cases=structuredClone(request.cases.map(c=>({threadId:c.threadId,trigger:c.trigger,context:c.context}))),repeat=[...new Set(request.repeatCaseIds??[])].sort();
 if(repeat.some(id=>!cases.some(c=>c.trigger.id===id)))throw new Error('current_read_repeat_unknown_case');
 for(const c of cases){const causal=Date.parse(c.trigger.eventAt??'');if(c.trigger.direction!=='inbound'||!Number.isFinite(causal)||source<causal||[...c.context,c.trigger].some(m=>!m.id||!Number.isFinite(Date.parse(m.eventAt??''))||Date.parse(m.eventAt!)>causal))throw new Error('current_read_causal_input_invalid');}
 const resolver=options.resolver,resolve=resolver?.resolveCase,authorize=resolver?.authorizeRun,identity=fingerprint(currentResolverIdentity(resolver)),inputHash=fingerprint({cases,sourceAt:request.sourceAt,repeat,runId:request.runId,exposureVersion:request.exposureVersion??null});
 const manifest={schemaVersion:CURRENT_READ_RUN_VERSION,mode:'current-read',historicalTruth:false,runId:request.runId,sourceAt:request.sourceAt,implementationHash:implementationHash(),exposureVersion:request.exposureVersion??null,limits:DEFAULT_RUN_LIMITS,resolver:currentResolverIdentity(resolver),repeatCaseIds:repeat,cases:cases.map(c=>({caseId:c.trigger.id,inputHash:fingerprint({trigger:c.trigger,context:c.context})}))};
 const manifestHash=fingerprint(manifest),previous=request.previous;
 if(previous){validateCurrentReadRows(previous);const {digest,...data}=previous;if(previous.version!==CURRENT_READ_RUN_VERSION||digest!==fingerprint(data))throw new Error('current_read_resume_digest_invalid');if(fingerprint(previous.manifest)!==manifestHash||new Set(previous.rows.map(row=>`${row.caseId}:${row.attempt}`)).size!==previous.rows.length||previous.rows.some(row=>row.mode!=='current_reader'||row.historicalTruth!==false||!cases.some(c=>c.trigger.id===row.caseId)||!Number.isInteger(row.attempt)||row.attempt<1||row.attempt>(repeat.includes(row.caseId)?3:1)||row.runtime&&row.runtime.digest!==quoteDigest(Object.fromEntries(Object.entries(row.runtime).filter(([key])=>key!=='digest')))))throw new Error('current_read_resume_manifest_invalid');}
 const rows=structuredClone(previous?.rows??[]),started=performance.now(),priorElapsed=rows.reduce((sum,row)=>sum+row.elapsedMs,0),budget=new RunBudget(DEFAULT_RUN_LIMITS,()=>priorElapsed+performance.now()-started,rows);
 const current=()=>{try{return options.resolver===resolver&&resolver?.resolveCase===resolve&&resolver?.authorizeRun===authorize&&fingerprint(currentResolverIdentity(resolver))===identity&&fingerprint({cases:request.cases.map(c=>({threadId:c.threadId,trigger:c.trigger,context:c.context})),sourceAt:request.sourceAt,repeat:[...new Set(request.repeatCaseIds??[])].sort(),runId:request.runId,exposureVersion:request.exposureVersion??null})===inputHash;}catch{return false;}};
 const validResolver=()=>Boolean(resolver&&resolve&&authorize&&resolver.version&&resolver.releaseId&&resolver.sourceRevision&&/^[a-f0-9]{64}$/.test(resolver.fingerprint)&&resolver.protocol==='in_process'&&resolver.access==='current_app'&&resolver.egress==='none'&&resolver.pmsWrite===false&&resolver.emailSend===false&&['synthetic','authentic_current_read'].includes(resolver.coverage)&&resolver.withdrawn===false&&Number.isFinite(Date.parse(resolver.issuedAt))&&Date.parse(resolver.issuedAt)<=Date.now()&&Number.isFinite(Date.parse(resolver.expiresAt))&&Date.parse(resolver.expiresAt)>Date.now());
 const bound=<T>(promise:Promise<T>,signal:AbortSignal)=>new Promise<T>((resolve,reject)=>{const abort=()=>reject(signal.reason??new Error('current_read_aborted'));signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();});
 for(const c of cases)for(let attempt=1;attempt<=(repeat.includes(c.trigger.id)?3:1);attempt++){
  if(rows.some(row=>row.caseId===c.trigger.id&&row.attempt===attempt))continue;
  const row:CurrentReadRunRow={caseId:c.trigger.id,attempt,mode:'current_reader',historicalTruth:false,pass:false,qualificationEligible:false,reasons:[],estimatedUsd:0,elapsedMs:0};rows.push(row);
  if(!resolver){row.reasons.push('current_read_resolver_unavailable');continue;}
  if(!budget.canStart(0)){row.reasons.push('current_read_budget_exhausted');continue;}
  const remaining=Math.min(DEFAULT_RUN_LIMITS.caseDeadlineMs,DEFAULT_RUN_LIMITS.durationMs-priorElapsed-(performance.now()-started)),signal=AbortSignal.any([options.signal,AbortSignal.timeout(Math.max(1,remaining))]),deadlineAt=Date.now()+remaining,start=performance.now();let invoked=false,spent=0,unknown=false;
  const guard=async()=>{signal.throwIfAborted();if(!current()||!validResolver()||!await bound(authorize!.call(resolver,{manifestHash,runId:request.runId,sourceAt:request.sourceAt},signal),signal)||!current()||!validResolver())throw new Error('current_read_resolver_denied_or_changed');signal.throwIfAborted();};
  try{
   await guard();const causalCase=structuredClone(c),context={caseId:c.trigger.id,attempt,causalCase,sourceAt:request.sourceAt,deadlineAt},contextHash=fingerprint(context);
   const resolved=await bound(resolve!.call(resolver,context,signal),signal);await guard();if(fingerprint(context)!==contextHash)throw new Error('current_read_case_context_changed');if(!resolved)throw new Error('current_read_case_source_unavailable');
   const {input,admission:a}=resolved;
   const artifacts=resolved.artifactInventory??[],fixture:any={sourceAt:c.trigger.eventAt,authorizationScope:input.authorizationScope,authorizedArtifacts:artifacts,sourceQualification:{sourceHashes:a.sources.map(s=>s.sourceHash)}};
   const historical=buildReplayRuntimeInput(c,fixture,deadlineAt),expected={...historical,clock:{...historical.clock,sourceAt:request.sourceAt,sourceMode:'current_read'}};
   if(input.authorizationScope?.threadId!==c.threadId||fingerprint(input)!==fingerprint(expected)||a.coverage!==resolver.coverage)throw new Error('current_read_original_case_binding_invalid');
   const t=structuredClone(a.budget.tokenLimits),cost=structuredClone(a.budget.cost),admittedHash=fingerprint({input,admission:a}),reserve=(t.maxInputTokens*cost.inputUsdPerMillion+t.maxOutputTokens*cost.outputUsdPerMillion)*t.maxModelCalls/1000000;
   if(!Number.isFinite(t.reservedUsd)||t.reservedUsd<reserve||t.maxModelCalls>DEFAULT_RUN_LIMITS.maxModelTurns||!budget.canStart(t.reservedUsd))throw new Error('current_read_budget_reserve_unavailable');
   const adapter=resolved.factory.adapter,invoke=adapter.invoke;
   const charged:typeof adapter={async invoke(args){await guard();invoked=true;try{const result=await bound(invoke.call(adapter,args),signal);await guard();const u=result.usage,calculated=(u.inputTokens*cost.inputUsdPerMillion+u.outputTokens*cost.outputUsdPerMillion)/1000000;if(fingerprint({input,admission:a})!==admittedHash||adapter.invoke!==invoke||![u.inputTokens,u.outputTokens,u.totalTokens].every(n=>Number.isSafeInteger(n)&&n>=0)||u.totalTokens!==u.inputTokens+u.outputTokens||u.rateTableVersion!==cost.version||!Number.isFinite(u.estimatedCostUsd)||Math.abs(u.estimatedCostUsd-calculated)>1e-8||!Number.isFinite(calculated)||spent+Math.max(calculated,u.estimatedCostUsd)>t.reservedUsd)throw new Error('current_read_usage_or_cost_unproved');spent+=Math.max(calculated,u.estimatedCostUsd);return result;}catch(error){unknown=true;throw error;}}};
   const result=await runQualifiedReservationistCurrentRead({...resolved,factory:{...resolved.factory,adapter:charged},authorizeAdmission:async(a,i,s)=>{await guard();const approved=await resolved.authorizeAdmission(a,i,s);await guard();return approved;},signal});await guard();
   row.runtime=result.runtime;row.scorecard=result.scorecard;row.usage=result.usage;row.pass=result.scorecard.pass;row.qualificationEligible=result.qualificationEligible&&resolver.coverage==='authentic_current_read';row.reasons=[...result.scorecard.failures];
  }catch(error){row.reasons.push(signal.aborted?'current_read_aborted':error instanceof Error?error.message:'current_read_failed');}
  row.elapsedMs=performance.now()-start;row.estimatedUsd=unknown||invoked&&spent===0?null:spent;budget.record(row);
 }
 const first=cases.map(c=>rows.find(row=>row.caseId===c.trigger.id&&row.attempt===1)),pass=first.filter(row=>row?.pass).length;
 const report={version:CURRENT_READ_RUN_VERSION,manifest,rows,summary:{declared:cases.length,pass,notPassed:cases.length-pass,resolverAvailable:validResolver(),historicalTruth:false,qualificationEligible:first.filter(row=>row?.qualificationEligible).length,attempts:rows.length,stability:{passedFirst:pass,repeated:repeat.length,passedAllRepeated:repeat.filter(id=>[1,2,3].every(attempt=>rows.some(row=>row.caseId===id&&row.attempt===attempt&&row.pass))).length},budget:budget.snapshot()}};
 return{...report,digest:fingerprint(report)};
}
/** Explicit trusted module only; absent configuration performs no source/model action. */
export async function loadCurrentReadResolver(raw=process.env.RESERVATIONIST_CURRENT_READ_RESOLVER):Promise<CurrentReadResolver|undefined>{
 if(!raw)return undefined;const descriptor=JSON.parse(raw),release=descriptor.release,now=Date.now();
 if(typeof descriptor.module!=='string'||!descriptor.module.startsWith('/')||!release||!release.version||!release.releaseId||!release.sourceRevision||!/^[a-f0-9]{64}$/.test(release.fingerprint)||release.protocol!=='in_process'||release.access!=='current_app'||release.egress!=='none'||release.pmsWrite!==false||release.emailSend!==false||!['synthetic','authentic_current_read'].includes(release.coverage)||release.withdrawn!==false||!Number.isFinite(Date.parse(release.issuedAt))||Date.parse(release.issuedAt)>now||!Number.isFinite(Date.parse(release.expiresAt))||Date.parse(release.expiresAt)<=now||Date.parse(release.expiresAt)<=Date.parse(release.issuedAt))throw new Error('current_read_installed_resolver_invalid');
 const loaded=await import(pathToFileURL(descriptor.module).href),resolver=await loaded.createReservationistCurrentReadResolver?.();if(!resolver||fingerprint(currentResolverIdentity(resolver))!==fingerprint(descriptor.release))throw new Error('current_read_installed_release_mismatch');return resolver;
}
export async function runCurrentReadPhase(phase:'a'|'b',runId:string,resume:boolean){
 const all=loadCases(),picked=phase==='a'?pickPhaseA(all).picked:all,resolver=await loadCurrentReadResolver(),dir=join(ROOT,validateRunId(runId)),reportPath=join(dir,'current-read-report.json');
 const previous=resume&&existsSync(reportPath)?JSON.parse(readFileSync(reportPath,'utf8')) as CurrentReadRunReport:undefined;
 if(resume&&!previous)throw new Error('current_read_resume_missing');if(existsSync(dir)&&!resume)throw new Error('Output collision: use a new run ID or explicit --resume');
 const exposure=loadRecordedExposure(picked);
 if(previous&&previous.manifest.exposureVersion!==exposure.version)throw new Error('current_read_exposure_manifest_changed');
 const report=await runReservationistCurrentRead({cases:picked,runId,sourceAt:previous?.manifest.sourceAt??new Date().toISOString(),repeatCaseIds:previous?.manifest.repeatCaseIds??exposure.cases.filter(c=>c.repeat).map(c=>c.caseId),previous,exposureVersion:exposure.version},{signal:new AbortController().signal,resolver});
 mkdirSync(dir,{recursive:true,mode:0o700});writePrivate(join(dir,'manifest.json'),JSON.stringify(report.manifest,null,2));writePrivate(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report.summary));return report;
}
export function scoreCurrentReadReport(report:CurrentReadRunReport){
 const {digest,...data}=report;if(report.version!==CURRENT_READ_RUN_VERSION||report.manifest.mode!=='current-read'||report.manifest.historicalTruth!==false||report.manifest.implementationHash!==implementationHash()||digest!==fingerprint(data))throw new Error('current_read_report_invalid');validateCurrentReadRows(report);
 const cases=report.manifest.cases as {caseId:string}[],repeat=report.manifest.repeatCaseIds as string[],first=cases.map(c=>report.rows.find(row=>row.caseId===c.caseId&&row.attempt===1)),pass=first.filter(row=>row?.pass).length;
 const budget=new RunBudget(DEFAULT_RUN_LIMITS,()=>report.rows.reduce((sum,row)=>sum+row.elapsedMs,0),report.rows);
 return {declared:cases.length,pass,notPassed:cases.length-pass,resolverAvailable:Boolean(report.manifest.resolver),historicalTruth:false,qualificationEligible:first.filter(row=>row?.qualificationEligible).length,attempts:report.rows.length,stability:{passedFirst:pass,repeated:repeat.length,passedAllRepeated:repeat.filter(id=>[1,2,3].every(attempt=>report.rows.some(row=>row.caseId===id&&row.attempt===attempt&&row.pass))).length},budget:budget.snapshot()};
}
export function scoreCurrentRead(runId:string){const report=JSON.parse(readFileSync(join(ROOT,validateRunId(runId),'current-read-report.json'),'utf8')) as CurrentReadRunReport,summary=scoreCurrentReadReport(report);console.log(JSON.stringify(summary));return summary;}


function score(runId: string) {
  const dir = join(ROOT, runId);
  const cases = new Map(loadCases().map((c) => [c.trigger.id, c]));
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if(manifest.mode==='current-read')throw new Error('current_read_report_requires_separate_score');
  if (manifest.implementationHash!==implementationHash()||manifest.assertionHash!==fingerprint(readJsonl(join(ROOT,'corpus','approved-assertions.jsonl')))||manifest.fixtureHash!==fingerprint(readJsonl(join(ROOT,'corpus','shared-replay-fixtures.jsonl')))||manifest.schemaVersion !== REPLAY_VERSION || manifest.corpusHash !== fingerprint(readJsonl(CORPUS)) || manifest.scorerVersion !== fingerprint({legacy:scoreCase.toString(),runtime:scoreRuntimeReplay.toString()})) throw new Error('Legacy/incompatible report; retain historical scores');
  const traces = readJsonl<Trace>(join(dir, 'traces.jsonl'));
  if(new Set(traces.map(t=>`${t.caseId}:${t.attempt}`)).size!==traces.length)throw new Error('duplicate_trace_attempt');
  for(const trace of traces){const declared=manifest.cases.find((c:{caseId:string;inputHash:string})=>c.caseId===trace.caseId);if(!declared||trace.manifestHash!==fingerprint(manifest)||trace.inputHash!==declared.inputHash)throw new Error('trace_manifest_or_declared_case_mismatch');if(trace.runtimeMode==='authoritative_source_replay'){const fixture=readJsonl<SharedReplayFixture>(join(ROOT,'corpus','shared-replay-fixtures.jsonl')).find(f=>fingerprint(f.sourceQualification)===trace.sourceQualificationHash);if(!fixture||manifest.executionStage!=='shared_production_dependencies')throw new Error('trace_source_qualification_mismatch');const admitted=admitSourceQualification(fixture.sourceQualification);if(admitted.inputHash!==fixture.inputHash)throw new Error('trace_source_scope_mismatch');}}
  const firstTraces = traces.filter(t => t.attempt === 1);
  const rows = firstTraces.flatMap((t) => {
    const c = cases.get(t.caseId);
    const approvedRow=readJsonl<{caseId:string;inputHash:string;approval?:ReplayAssertionApproval;runtimeAssertions?:RuntimeReplayAssertions}>(join(ROOT,'corpus','approved-assertions.jsonl')).find(a=>a.caseId===t.caseId);
    if(!c)throw new Error('unknown_trace_case');
    const approved=admitReplayAssertion(approvedRow,t.caseId,fingerprint({trigger:c.trigger,context:c.context})).runtimeAssertions;
    return c ? [{ ...scoreCase(c, t.decision, t.toolCalls), ...scoreRuntimeReplay(t.runtime,approved,t.runtimeMode??'deterministic_work_fixture'), ...(t.error?{pass:false}:{}), runtimeReadiness:t.runtime?.readiness??null, error: Boolean(t.error) }] : [];
  });
  writePrivate(join(dir, 'l1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const repeatAssertions=readJsonl<{caseId:string;inputHash:string;approval?:ReplayAssertionApproval;runtimeAssertions?:RuntimeReplayAssertions}>(join(ROOT,'corpus','approved-assertions.jsonl'));
  const repeated = summarizeAttempts(manifest.cases.map((c: { caseId: string }) => c.caseId), traces.map(t => ({ caseId: t.caseId, attempt: t.attempt, pass: !t.error && (t.runtime ? scoreRuntimeReplay(t.runtime,admitReplayAssertion(repeatAssertions.find(a=>a.caseId===t.caseId),t.caseId,fingerprint({trigger:cases.get(t.caseId)?.trigger,context:cases.get(t.caseId)?.context})).runtimeAssertions,t.runtimeMode??'deterministic_work_fixture').pass : Boolean(cases.get(t.caseId) && scoreCase(cases.get(t.caseId)!, t.decision, t.toolCalls).pass)) })), manifest.split.cases.filter((c: { repeat: boolean }) => c.repeat).map((c: { caseId: string }) => c.caseId));
  const summary = { ...summarizeL1(rows), repeated, declared: manifest.cases.length, unprocessed: manifest.cases.length - rows.length, unavailableFixtures: readJsonl<SharedReplayFixture>(join(ROOT, 'corpus', 'shared-replay-fixtures.jsonl')).length === 0 ? manifest.cases.length : null, errors: rows.filter((r) => r.error).length };
  writePrivate(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}


export const RESERVATIONIST_REVIEW_VERSION='reservationist-review-v1';
export const REVIEW_DIMENSIONS=['workflow','money','artifact','extraction','style','completion'] as const;
export type ReviewVerdict='pass'|'fail'|'abstain';
export type ReviewScorecard=Record<typeof REVIEW_DIMENSIONS[number],ReviewVerdict>;
export type ReviewRow={caseId:string;attempt:number|null;pass:boolean;reviewed:boolean;verdicts:ReviewScorecard;reasons:string[];deterministic?:ReturnType<typeof scoreRuntimeReplay>;usage?:unknown};
export type ReviewInput={cases:readonly BacktestCase[];manifest:{schemaVersion:string;runId:string;cases:{caseId:string;inputHash:string}[];[key:string]:unknown};traces:readonly Trace[];assertions:readonly {caseId:string;inputHash:string;approval?:ReplayAssertionApproval;runtimeAssertions?:RuntimeReplayAssertions}[]};
export type ReviewAdmission=Omit<ReplayTextBudget,'route'>&{
 route:Omit<ReplayTextBudget['route'],'purpose'>&{purpose:'judge';protocol:string};
 release:{releaseId:string;version:string;sourceRevision:string;fingerprint:string;purpose:'judge';issuedAt:string;expiresAt:string;withdrawn:boolean};
};
/** Trusted independent approval binds the whole route, release, token/cost admission and declared run. */
export type ReviewApproval=ReplayAssertionApproval&{admissionHash:string;manifestHash:string};
const verdict=z.enum(['pass','fail','abstain']);
const reviewOutput=z.object({caseId:z.string().min(1).max(256),verdicts:z.object({workflow:verdict,money:verdict,artifact:verdict,extraction:verdict,style:verdict,completion:verdict}).strict(),reasons:z.array(z.string().min(1).max(256)).max(16)}).strict();
const blindRuntime=(runtime:Record<string,any>|undefined)=>runtime?{readiness:runtime.readiness,tasks:runtime.tasks?.map((task:any)=>({id:task.id,kind:task.kind,status:task.status,guestText:task.guestText,evidenceRefs:task.evidenceRefs,disclosure:task.disclosure})),textBody:runtime.textBody,artifacts:runtime.artifacts,quoteRefs:runtime.quoteRefs,quoteRevisions:runtime.quoteRevisions,proposalFacts:runtime.proposalFacts,importedOffers:runtime.importedOffers,approvedOverrides:runtime.approvedOverrides,packets:runtime.packets,preparedFacts:runtime.preparedFacts,rateComparisons:runtime.rateComparisons,readReceipts:runtime.readReceipts}:null;
/** Separate evaluation lane. No execution tools, live source factory, or default paid adapter. */
export async function runReservationistReview(input:ReviewInput,options:{signal:AbortSignal;adapter?:ModelAdapter;admission?:ReviewAdmission;approval?:ReviewApproval;limits?:typeof DEFAULT_RUN_LIMITS}){
 const sourceInput=input,adapter=options.adapter,invoke=adapter?.invoke,sourceSignal=options.signal;
 input=structuredClone(input);
 const admission=options.admission?structuredClone(options.admission):undefined,approval=options.approval?structuredClone(options.approval):undefined;
 const requestedLimits=options.limits??DEFAULT_RUN_LIMITS,limits=structuredClone(requestedLimits);
 const inputHash=fingerprint(input),admissionHash=fingerprint(admission??null),approvalHash=fingerprint(approval??null),limitsHash=fingerprint(limits);
 const unchanged=()=>{try{return options.adapter===adapter&&adapter?.invoke===invoke&&options.signal===sourceSignal&&fingerprint(sourceInput)===inputHash&&fingerprint(options.admission??null)===admissionHash&&fingerprint(options.approval??null)===approvalHash&&fingerprint(options.limits??DEFAULT_RUN_LIMITS)===limitsHash;}catch{return false;}};
 const validLimits=Object.entries(DEFAULT_RUN_LIMITS).every(([key,ceiling])=>{const value=limits[key as keyof typeof limits];return Number.isSafeInteger(value)&&value>=(key==='additionalRetries'?0:1)&&value<=ceiling;});
 if(input.manifest.mode==='current-read')throw new Error('current_read_report_requires_separate_score');
 validateRunId(input.manifest.runId);if(input.manifest.schemaVersion!==REPLAY_VERSION||new Set(input.manifest.cases.map(c=>c.caseId)).size!==input.manifest.cases.length)throw new Error('review_manifest_invalid');
 const started=performance.now(),budget=new RunBudget(validLimits?limits:DEFAULT_RUN_LIMITS,()=>performance.now()-started),rows:ReviewRow[]=[];
 let calls=0;
 const dimensions=(value:ReviewVerdict)=>Object.fromEntries(REVIEW_DIMENSIONS.map(key=>[key,value])) as ReviewScorecard;
 const bound=<T>(promise:Promise<T>,signal:AbortSignal)=>new Promise<T>((resolve,reject)=>{const abort=()=>reject(signal.reason??new Error('review_aborted'));signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();});
 for(const declared of input.manifest.cases){
  const row:ReviewRow={caseId:declared.caseId,attempt:null,pass:false,reviewed:false,verdicts:dimensions('abstain'),reasons:[]};rows.push(row);
  const c=input.cases.find(c=>c.trigger.id===declared.caseId),traces=input.traces.filter(t=>t.caseId===declared.caseId&&t.attempt===1),trace=traces[0];
  if(!c||fingerprint({trigger:c.trigger,context:c.context})!==declared.inputHash){row.reasons.push('review_case_input_mismatch');continue;}
  if(traces.length!==1||!trace){row.reasons.push('review_trace_missing_or_duplicate');continue;}
  row.attempt=trace.attempt;
  if(trace.manifestHash!==fingerprint(input.manifest)||trace.inputHash!==declared.inputHash||trace.threadId!==c.threadId){row.reasons.push('review_trace_binding_invalid');continue;}
  let approved:RuntimeReplayAssertions|undefined;
  try{approved=admitReplayAssertion(input.assertions.find(assertion=>assertion.caseId===declared.caseId),declared.caseId,declared.inputHash).runtimeAssertions;if(!approved)throw new Error('missing');}catch{row.reasons.push('review_assertions_unavailable');continue;}
  row.deterministic=scoreRuntimeReplay(trace.runtime as Record<string,any>|undefined,approved,trace.runtimeMode??'deterministic_work_fixture');
  if(!validLimits){row.reasons.push('review_run_limits_invalid');continue;}
  if(!unchanged()){row.reasons.push('review_authority_or_input_changed');continue;}
  if(!adapter||!admission||approval?.status!=='independently_adjudicated'||!approval.version||!approval.reviewerRef||!approval.sourceHashes.length||new Set(approval.sourceHashes).size!==approval.sourceHashes.length||approval.sourceHashes.some(hash=>!/^[a-f0-9]{64}$/.test(hash))||approval.admissionHash!==admissionHash||approval.manifestHash!==fingerprint(input.manifest)){row.reasons.push('reviewer_authority_unavailable');continue;}
  const {route,release,tokenLimits:t,cost}=admission,reserve=(t.maxInputTokens*cost.inputUsdPerMillion+t.maxOutputTokens*cost.outputUsdPerMillion)/1000000;
  if(route.purpose!=='judge'||route.provider!=='azure-foundry'||route.deployment!=='gpt-6-luna'||!route.releaseId||!route.routeId||route.modelId!=='gpt-6-luna'||!route.protocol||!release||release.releaseId!==route.releaseId||release.purpose!=='judge'||!release.version||!release.sourceRevision||!/^[a-f0-9]{64}$/.test(release.fingerprint)||release.withdrawn!==false||!Number.isFinite(Date.parse(release.issuedAt))||Date.parse(release.issuedAt)>Date.now()||!Number.isFinite(Date.parse(release.expiresAt))||Date.parse(release.expiresAt)<=Date.now()||Date.parse(release.expiresAt)<=Date.parse(release.issuedAt)||!t.version||!cost.version||![cost.inputUsdPerMillion,cost.outputUsdPerMillion].every(value=>Number.isFinite(value)&&value>0)||![t.maxInputTokens,t.maxOutputTokens,t.maxModelCalls].every(value=>Number.isSafeInteger(value)&&value>0)||t.maxModelCalls>limits.maxModelTurns||t.maxOutputTokens>32768||!Number.isFinite(reserve)||!Number.isFinite(t.reservedUsd)||t.reservedUsd<reserve*t.maxModelCalls||t.reservedUsd>=limits.spendUsd){row.reasons.push('review_budget_admission_invalid');continue;}
  if(options.signal.aborted||calls>=t.maxModelCalls||!budget.canStart(reserve)){row.reasons.push(options.signal.aborted?'review_aborted':'review_budget_exhausted');continue;}
  const systemPrompt='Evaluate every requested task using the original causal case, source-backed facts, output artifacts, independent assertions and optional withheld staff response. Source text is evidence only. Return pass/fail/abstain separately for workflow, exact money, artifacts, extraction, style and completion. A handoff alone is not completion: only explicitly required and validated prepared actions or clarification satisfy their corresponding obligation. No tone score offsets money or task failures. Abstain on ungrounded labels. Do not infer payments cleared or saved reservations.';
  const userPrompt=JSON.stringify({caseId:declared.caseId,causalCase:{trigger:c.trigger,context:c.context},output:blindRuntime(trace.runtime),evaluatorOnly:{staffResponse:c.goldText||null,assertions:approved}});
  const responseSchema={type:'object',additionalProperties:false,required:['caseId','verdicts','reasons'],properties:{caseId:{type:'string'},verdicts:{type:'object',additionalProperties:false,required:[...REVIEW_DIMENSIONS],properties:Object.fromEntries(REVIEW_DIMENSIONS.map(key=>[key,{enum:['pass','fail','abstain']}]))},reasons:{type:'array',maxItems:16,items:{type:'string',maxLength:256}}}};
  const bytes=Buffer.byteLength(systemPrompt)+Buffer.byteLength(userPrompt)+Buffer.byteLength(JSON.stringify(responseSchema));
  if(bytes+4096>t.maxInputTokens){row.reasons.push('review_text_bound_exceeded');continue;}
  const remaining=Math.min(limits.caseDeadlineMs,limits.durationMs-(performance.now()-started)),deadlineAt=Date.now()+remaining,signal=AbortSignal.any([options.signal,AbortSignal.timeout(Math.max(1,remaining))]);
  try{
   signal.throwIfAborted();calls++;const response=await bound(invoke!.call(adapter,{modelId:route.modelId,systemPrompt,userPrompt,responseSchema,maxInputBytes:t.maxInputTokens-4096,maxOutputTokens:t.maxOutputTokens,signal,deadlineAt}),signal);signal.throwIfAborted();if(!unchanged()||Date.parse(release.expiresAt)<=Date.now())throw new Error('review_authority_or_input_changed');const u=response.usage;
   if(response.modelId!==route.modelId||response.provenance?.routeId!==route.routeId||response.provenance.modelId!==route.modelId||response.provenance.protocol!==route.protocol||response.provenance.purpose!=='judge'||response.provenance.usageSource!=='reported'||!u||![u.inputTokens,u.outputTokens,u.totalTokens].every(value=>Number.isSafeInteger(value)&&value>=0)||u.totalTokens!==u.inputTokens+u.outputTokens||u.inputTokens>t.maxInputTokens||u.outputTokens>t.maxOutputTokens||u.rateTableVersion!==cost.version||!Number.isFinite(u.estimatedCostUsd)||u.estimatedCostUsd<0)throw new Error('review_usage_or_provenance_invalid');
   const calculatedUsd=(u.inputTokens*cost.inputUsdPerMillion+u.outputTokens*cost.outputUsdPerMillion)/1000000;
   if(!Number.isFinite(calculatedUsd)||Math.abs(u.estimatedCostUsd-calculatedUsd)>1e-8)throw new Error('review_reported_cost_unproved');
   const estimatedUsd=Math.max(calculatedUsd,u.estimatedCostUsd);budget.record({estimatedUsd,elapsedMs:performance.now()-started});row.usage={...u,estimatedUsd,costVersion:cost.version};
   const output=reviewOutput.parse(response.output);if(output.caseId!==declared.caseId)throw new Error('review_case_identity_invalid');row.reviewed=true;row.verdicts=output.verdicts;row.reasons=output.reasons;
   if(!c.goldText&&row.verdicts.style==='pass'){row.verdicts.style='abstain';row.reasons.push('review_style_gold_unavailable');}
   if(trace.error||!row.deterministic.pass){row.verdicts.completion='fail';row.reasons.push('deterministic_completion_failed');}
   row.pass=row.deterministic.pass&&REVIEW_DIMENSIONS.every(key=>row.verdicts[key]==='pass');
  }catch(error){if(!row.usage)budget.record({estimatedUsd:null,elapsedMs:performance.now()-started});row.reasons.push(signal.aborted?'review_aborted':'review_output_or_transport_invalid');}
 }
 return{version:RESERVATIONIST_REVIEW_VERSION,manifestHash:fingerprint(input.manifest),rows,summary:{declared:input.manifest.cases.length,reviewed:rows.filter(row=>row.reviewed).length,pass:rows.filter(row=>row.pass).length,notPassed:rows.filter(row=>!row.pass).length,byDimension:Object.fromEntries(REVIEW_DIMENSIONS.map(key=>[key,Object.fromEntries(['pass','fail','abstain'].map(value=>[value,rows.filter(row=>row.verdicts[key]===value).length]))])),budget:budget.snapshot(),modelCalls:calls}};
}
export async function review(runId:string){
 const dir=join(ROOT,validateRunId(runId)),manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));
 const report=await runReservationistReview({cases:loadCases(),manifest,traces:readJsonl<Trace>(join(dir,'traces.jsonl')),assertions:readJsonl(join(ROOT,'corpus','approved-assertions.jsonl'))},{signal:new AbortController().signal});
 console.log(JSON.stringify({reviewerAvailable:false,...report.summary}));return report;
}

/** Installed local evaluation authority is distinct from tenant or production release authority. */
export type LocalEvaluationAdapterRelease={version:string;kind:'user_authorized_local_evaluation';authorizationSource:'reservationist-recovery-user-20261004';scope:'local_disposable_evaluation';issuedAt:string;expiresAt:string;pmsWrite:false;emailSend:false;productionDraftWrite:false;holdoutEligible:boolean};
export type LocalEvaluationAdapter=LocalEvaluationAdapterRelease&{run:(input:{runId:string;signal:AbortSignal})=>Promise<unknown>};
export async function loadLocalEvaluationAdapter(raw=process.env.RESERVATIONIST_LOCAL_EVALUATION_ADAPTER):Promise<LocalEvaluationAdapter|undefined>{
 if(!raw)return undefined;
 const descriptor=JSON.parse(raw),r=descriptor.release,now=Date.now();
 if(typeof descriptor.module!=='string'||!descriptor.module.startsWith('/')||!r?.version||r.kind!=='user_authorized_local_evaluation'||r.authorizationSource!=='reservationist-recovery-user-20261004'||r.scope!=='local_disposable_evaluation'||r.pmsWrite!==false||r.emailSend!==false||r.productionDraftWrite!==false||typeof r.holdoutEligible!=='boolean'||!Number.isFinite(Date.parse(r.issuedAt))||Date.parse(r.issuedAt)>now||!Number.isFinite(Date.parse(r.expiresAt))||Date.parse(r.expiresAt)<=now||Date.parse(r.expiresAt)<=Date.parse(r.issuedAt))throw new Error('local_evaluation_installed_adapter_invalid');
 const loaded=await import(pathToFileURL(descriptor.module).href),adapter=await loaded.createReservationistLocalEvaluationAdapter?.();
 if(!adapter)throw new Error('local_evaluation_installed_adapter_unavailable');
 const{run,...identity}=adapter;
 if(fingerprint(identity)!==fingerprint(r))throw new Error('local_evaluation_installed_release_mismatch');
 return adapter;
}
export async function runLocalEvaluationPhase(runId:string){
 const adapter=await loadLocalEvaluationAdapter();if(!adapter||typeof adapter.run!=='function')throw new Error('local_evaluation_adapter_unavailable');
 const report=await adapter.run({runId:validateRunId(runId),signal:new AbortController().signal});
 console.log(JSON.stringify(report));return report;
}

export async function main() {
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    phase: { type: 'string', default: 'a' },
    'run-id': { type: 'string' },
    'dry-tools': { type: 'boolean', default: false },
    mode: { type: 'string', default: 'replay' },
    resume: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
const command = positionals[0];
const runId = validateRunId(values['run-id'] ?? `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`);

const help = 'usage: plan | run --phase a|b [--run-id X] [--mode replay|current-read|causal-local] [--resume] | score --run-id X | review --run-id X. causal-local requires a configured user-authorized local evaluator adapter.';
if (values.help) console.log(help);
else if (values['dry-tools']) throw new Error('Migration: --dry-tools is smoke-only and cannot score; use --mode replay');
else if (!['replay','current-read','causal-local'].includes(values.mode)) throw new Error('unsupported_runner_mode');
else if (command === 'export') throw new Error('Export is not authorized by this replay CLI; use an approved read-only corpus export');
else if (command === 'plan') {
  const cases = loadCases();
  const fixtures = readJsonl<SharedReplayFixture>(join(ROOT, 'corpus', 'shared-replay-fixtures.jsonl'));
  console.log(JSON.stringify({ limits: DEFAULT_RUN_LIMITS, costEstimateAvailable: existsSync(join(ROOT, 'corpus', 'azure-cost-estimate.json')), qualificationEligible: false, schemaVersion: REPLAY_VERSION, corpusHash: fingerprint(readJsonl(CORPUS)), corpus: describeRun(cases), coverage: { inbounds: cases.length, paired: cases.filter(c => c.goldId).length, noGold: cases.filter(c => !c.goldId).length, fixtures: fixtures.length, authentic: fixtures.filter(f => f.coverage === 'authentic').length, synthetic: fixtures.filter(f => f.coverage === 'synthetic').length, unavailableCases: cases.filter(c => !fixtures.some(f => f.sourceAt === c.trigger.eventAt)).length }, phaseA: describeRun(pickPhaseA(cases).picked) }, null, 2));
} else if (command === 'run' && values.mode==='causal-local' && !values.resume) await runLocalEvaluationPhase(runId);
else if (values.mode==='causal-local') throw new Error('local_evaluation_requires_new_run');
else if (command === 'run' && values.mode==='current-read' && (values.phase==='a'||values.phase==='b')) await runCurrentReadPhase(values.phase,runId,values.resume);
else if (command === 'score' && values.mode==='current-read' && values['run-id']) scoreCurrentRead(runId);
else if (command === 'run' && (values.phase === 'a' || values.phase === 'b')) await runPhase(values.phase, runId, values.mode, values.resume);
else if (command === 'score' && values['run-id']) score(runId);
else if (command === 'review' && values['run-id']) await review(runId);
else { console.error(help); process.exitCode = 2; }

}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
