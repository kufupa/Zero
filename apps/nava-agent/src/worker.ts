import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import { client, cmaServerConfigured, deliverPending, environmentId, mirrorEvent, runtimeProvider, startPending } from './runtime.js';
import { event, json, sql, uid } from './db.js';
import { discoverToolPacks, ToolRegistry, type LeaseFence, type Mode, type MutationInput, type NativeAdmission, type NativeLease, type ToolDefinition, type ToolResult, type SkillConfig } from './tool-registry.js';
import { createPilotEnabled, manualLabtestTarget, runStaffGo, runStaffReconcile, runStaffStage } from './create-operations.js';
import { writeEvent } from './session-store.js';
import { createGoEnabled, createPilotRequested, hmsSaveEnabled, maxStaffHmsSlots, nativeSaveAllowed, staffPrepareOnly } from './hms-mode.js';
import { initialSkillContext } from './initial-skill-context.js';

export type RuntimeBlock = {type:string;[key:string]:unknown};
export type RuntimeMessage = {role:'user'|'assistant';content:RuntimeBlock[];stop_reason?:string|null};
export type SessionState = {threadId:string;sessionId:string;messages:RuntimeMessage[];pendingToolUseId:string|null;version:number;toolOutcomes:Record<string,unknown>;status:string};
export type SessionStore = {
  claim(sessionId:string,workerId:string,leaseMs:number):Promise<LeaseFence|null>;
  refresh(lease:LeaseFence,leaseMs:number):Promise<boolean>;
  release(lease:LeaseFence):Promise<boolean>;
  load(sessionId:string):Promise<SessionState>;
  append(lease:LeaseFence,version:number,deliveryId:string,message:RuntimeMessage):Promise<number>;
  event(lease:LeaseFence,kind:string,payload:unknown):Promise<void>;
  park(lease:LeaseFence,toolUseId:string):Promise<void>;
  finish(lease:LeaseFence,reason:string):Promise<void>;
  recordToolOutcome(lease:LeaseFence,toolUseId:string,result:unknown):Promise<void>;
  markDispatched(lease:LeaseFence,proposalId:string,executionId:string,details:unknown):Promise<void>;
  claimGo(input:{proposalId:string;expectedRevision:number;idempotencyKey:string;actor:string}):Promise<unknown>;
  finishGo(lease:LeaseFence,proposalId:string,executionId:string,completion:{outcome:'saved'|'not_saved'|'uncertain';toolResult:unknown;proposalResult:unknown}):Promise<void>;
};
export type RuntimeDeps = {
  load(sessionId:string):Promise<{threadId:string;sessionId:string;messages:RuntimeMessage[];pendingToolUseId:string|null;toolOutcomes:Record<string,unknown>;version:number}>;
  append(sessionId:string,message:RuntimeMessage):Promise<void>;
  event(sessionId:string,kind:string,payload:unknown):Promise<void>;
  tools(sessionId:string):Promise<ToolDefinition[]>;
  runTool(sessionId:string,toolUse:{id:string;name:string;input:unknown}):Promise<{kind:'result';result:unknown}|{kind:'pause'}>;
  recordToolOutcome(sessionId:string,toolUseId:string,result:unknown):Promise<void>;
  assistantStopReason(sessionId:string,version:number,message:RuntimeMessage):Promise<string|null|undefined>;
  publishStaffReview(sessionId:string,turnId:string,reason:string):Promise<void>;
  park(sessionId:string,toolUseId:string):Promise<void>;
  finish(sessionId:string,reason:string):Promise<void>;
};
export type AgentRuntime = {startTurn(threadId:string,input:{sessionId:string;content:string}):Promise<void>;resumeWithToolResult(sessionId:string,toolUseId:string,result:unknown):Promise<void>};
export type RuntimeFactory = (deps:RuntimeDeps,skillContext?:string)=>AgentRuntime;
export type PendingInput = {id:string;kind:'mail_pending'|'context_pending';payload:{text?:string}};
export type ApprovedSave = MutationInput & {sessionId:string;proposalId:string;executionId:string;toolUseId:string;mode:Mode;propertyCode:string|null;dispatch:'pending'|'dispatched';completed?:ToolResult;preflightFailure?:ToolResult};
export type SaveQueue = {
  // A claim is an already-authenticated, durably pinned Go, owned by this fenced lease.
  claimApprovedSave(lease:LeaseFence,supportsSave:(workflow:string)=>boolean):Promise<ApprovedSave|null>;
  completeSave(lease:LeaseFence,job:ApprovedSave,result:ToolResult):Promise<'completed'|'reconcile'>;
};
export type WorkerDeps = {store:SessionStore;runtime:RuntimeFactory;native:NativeAdmission;saveQueue?:SaveQueue};

const leaseMs=60_000;
const owner=`${hostname()}:${process.pid}:${uid('worker')}`;

function cap(value:string|undefined,fallback:number,maximum:number,name:string):number {
  const parsed=value===undefined ? fallback : Number(value);
  if(!Number.isInteger(parsed) || parsed<1 || parsed>maximum) throw new Error(`${name}_INVALID`);
  return parsed;
}
export function configuredSlots() {
  const prepareOnly=staffPrepareOnly();
  const requested=cap(process.env.NAVA_HMS_SLOTS,prepareOnly?4:10,maxStaffHmsSlots,'NAVA_HMS_SLOTS');
  const native=cap(process.env.HMS_CREDENTIAL_SESSION_CAP,prepareOnly?4:8,prepareOnly?maxStaffHmsSlots:8,'HMS_CREDENTIAL_SESSION_CAP');
  return {requested,native,local:Math.min(requested,native)};
}

class Semaphore {
  private used=0;
  private readonly waiting:Array<()=>void>=[];
  constructor(private readonly limit:number) {}
  async run<T>(signal:AbortSignal|undefined,work:()=>Promise<T>):Promise<T> {
    signal?.throwIfAborted();
    while(this.used>=this.limit) {
      await new Promise<void>((resolve,reject)=>{
        const wake=()=>{signal?.removeEventListener('abort',abort);resolve();};
        const abort=()=>{const i=this.waiting.indexOf(wake);if(i>=0)this.waiting.splice(i,1);reject(signal?.reason);};
        this.waiting.push(wake); signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted) abort();
      });
      signal?.throwIfAborted();
    }
    this.used++;
    try { return await work(); } finally { this.used--;this.waiting.shift()?.(); }
  }
}

export function createNativeAdmission():NativeAdmission {
  const semaphore=new Semaphore(configuredSlots().local);
  async function withLease<T>(propertyCode:string,signal:AbortSignal|undefined,readOnly:boolean,work:(lease:NativeLease)=>Promise<T>,scope?:'quote'):Promise<T> {
    if(!process.env.HMS_CREDENTIAL_SESSION_CAP) throw new Error('HMS_CREDENTIAL_SESSION_CAP_REQUIRED');
    const databaseUrl=process.env.HMS_CREDENTIAL_LEASE_DATABASE_URL;
    if(!databaseUrl) throw new Error('NATIVE_SHARED_LEASE_DATABASE_REQUIRED');
    return semaphore.run(signal,async()=>{
      const bundledQuote=fileURLToPath(new URL('../tools/quote/native/tooling/hms-cloud/cloud-session.mjs',import.meta.url));
      let nativePath=process.env.NAVA_HMS_SESSION_MODULE ?? fileURLToPath(new URL('../../server-pilot/tooling/hms-cloud/cloud-session.mjs',import.meta.url));
      if(scope==='quote') { try { await access(bundledQuote);nativePath=bundledQuote; } catch { /* quote uses the shared native module */ } }
      const cloud=await import(pathToFileURL(nativePath).href);
      if(typeof cloud.withCloudCredentialLease!=='function') throw new Error('NATIVE_ADMISSION_UNAVAILABLE');
      return cloud.withCloudCredentialLease(propertyCode,async(lease:NativeLease)=>{
        lease.signal.throwIfAborted();
        const result=await work(lease);
        lease.signal.throwIfAborted();
        return result;
      },{databaseUrl,readOnly,priority:'staff',signal});
    });
  }
  return {available:()=>Boolean(process.env.HMS_CREDENTIAL_SESSION_CAP && process.env.HMS_CREDENTIAL_LEASE_DATABASE_URL),withRead:(property,signal,work,scope)=>withLease(property,signal,true,work,scope),withSave:async(property,signal,work)=>{
    if(!nativeSaveAllowed()) throw new Error('SAVE_DISABLED');
    return withLease(property,signal,false,work);
  }};
}

async function pendingInput(sessionId:string,deliveryId?:string):Promise<PendingInput|null> {
  const [row]=deliveryId ? await sql`SELECT id,kind,payload FROM nava_agent.agent_event WHERE id=${deliveryId} AND session_id=${sessionId} AND kind IN ('mail_pending','context_pending')` : await sql`SELECT id,kind,payload FROM nava_agent.agent_event WHERE session_id=${sessionId} AND kind IN ('mail_pending','context_pending') AND payload->>'delivered'='false' ORDER BY sequence LIMIT 1`;
  if(!row || (row.kind!=='mail_pending' && row.kind!=='context_pending')) return null;
  return {id:row.id,kind:row.kind,payload:row.payload};
}
async function markDelivered(lease:LeaseFence,id:string) {
  const rows=await sql`UPDATE nava_agent.agent_event e SET payload=jsonb_set(e.payload,'{delivered}','true'::jsonb) FROM nava_agent.agent_session s WHERE e.id=${id} AND e.session_id=s.id AND s.id=${lease.sessionId} AND s.worker_id=${lease.workerId} AND s.lease_epoch=${lease.epoch}::bigint AND s.lease_until>clock_timestamp() RETURNING e.id`;
  if(!rows.length) throw new Error('LEASE_LOST');
}
async function canParkSave(lease:LeaseFence,proposalId:string,revision:number) {
  const [proposal]=await sql`SELECT p.id FROM nava_agent.proposal p JOIN nava_agent.agent_session s ON s.id=p.session_id WHERE p.id=${proposalId} AND p.session_id=${lease.sessionId} AND p.revision=${revision} AND p.phase='ready' AND p.workflow IN ('create','amend','cancel','filing') AND s.worker_id=${lease.workerId} AND s.lease_epoch=${lease.epoch}::bigint AND s.lease_until>clock_timestamp()`;
  return !!proposal;
}
function deliveryId(message:RuntimeMessage,version:number,pending:PendingInput|null):string {
  const text=message.content.filter(block=>block.type==='text' && typeof block.text==='string').map(block=>block.text).join('\n');
  if(message.role==='user' && pending && text.includes(`nava-mail-event:${pending.id}`)) return `input:${pending.id}`;
  const resultIds=message.content.filter(block=>block.type==='tool_result' && typeof block.tool_use_id==='string').map(block=>block.tool_use_id).sort();
  if(message.role==='user' && resultIds.length) return `results:${createHash('sha256').update(JSON.stringify(resultIds)).digest('hex')}`;
  return `message:${version}:${createHash('sha256').update(JSON.stringify(message)).digest('hex')}`;
}

export async function runSession(sessionId:string,deps:WorkerDeps):Promise<void> {
  const lease=await deps.store.claim(sessionId,owner,leaseMs);
  if(!lease) return;
  const abort=new AbortController();
  let refreshing=false;
  const timer=setInterval(()=>{if(refreshing)return;refreshing=true;void deps.store.refresh(lease,leaseMs).then(ok=>{if(!ok)abort.abort();},()=>abort.abort()).finally(()=>{refreshing=false;});},20_000);
  timer.unref();
  try {
    let state=await deps.store.load(sessionId);
    const [session]=await sql`SELECT s.mode,s.config,t.property_code FROM nava_agent.agent_session s JOIN nava_agent.mail_thread t ON t.id=s.thread_id WHERE s.id=${sessionId}`;
    if(!session || !['live','labtest','historical'].includes(session.mode)) throw new Error('SESSION_MODE_INVALID');
    const mode:Mode=session.mode;
    const pending=await pendingInput(sessionId,state.status==='running' && typeof session.config?.worker_delivery_id==='string' ? session.config.worker_delivery_id : undefined);
    const registry=new ToolRegistry({native:deps.native,emit:async(_id,kind,payload)=>{abort.signal.throwIfAborted();await deps.store.event(lease,kind,payload);}});
    await discoverToolPacks(registry);
    let skillConfig:SkillConfig|undefined;
    if(registry.hasSkillPack()) {
      const existing=z.object({root:z.string(),pin:z.object({version:z.string(),files:z.record(z.string())}).strict()}).strict().safeParse(session.config?.skill_config);
      if(existing.success) skillConfig={root:resolve(process.env.NAVA_SKILLS_DIR ?? fileURLToPath(new URL('../skills/',import.meta.url))),pin:existing.data.pin};
      else {
        const pin=await registry.pinSkillTree(resolve(process.env.NAVA_SKILLS_DIR ?? fileURLToPath(new URL('../skills/',import.meta.url))));
        if(!pin) throw new Error('SKILL_PIN_UNAVAILABLE');
        const rows=await sql`UPDATE nava_agent.agent_session SET config=config || ${json({skill_config:pin})}::jsonb WHERE id=${sessionId} AND worker_id=${lease.workerId} AND lease_epoch=${lease.epoch}::bigint AND lease_until>clock_timestamp() RETURNING id`;
        if(!rows.length) throw new Error('LEASE_LOST');
        skillConfig=pin;
      }
    }
    if(createPilotEnabled() && await runStaffStage(lease,registry,{sessionId,mode,propertyCode:session.property_code,fence:lease,signal:abort.signal,skillConfig})) return;
    if(createPilotEnabled() && await runStaffGo(lease,registry,{sessionId,mode,signal:abort.signal})) return;
    if(createPilotEnabled() && await runStaffReconcile(lease,registry,abort.signal)) return;
    const skillContext=staffPrepareOnly() && process.env.NAVA_QUOTE_SKELETON!=='1' && skillConfig
      ? await initialSkillContext(skillConfig,sessionId,mode,abort.signal) : null;
    let version=state.version;
    const checkSession=(id:string)=>{if(id!==sessionId)throw new Error('SESSION_MISMATCH');abort.signal.throwIfAborted();};
    const runtime=deps.runtime({
      load:async id=>{checkSession(id);state=await deps.store.load(id);version=state.version;return state;},
      append:async(id,message)=>{checkSession(id);const delivery=deliveryId(message,version,pending);version=await deps.store.append(lease,version,delivery,message);version=(await deps.store.load(id)).version;if(pending && delivery===`input:${pending.id}`)await markDelivered(lease,pending.id);},
      event:async(id,kind,payload)=>{checkSession(id);await deps.store.event(lease,kind,payload);},
      tools:async id=>{checkSession(id);return registry.definitions().filter(tool=>!createPilotRequested()||tool.name!=='hms_prepare');},
      runTool:async(id,toolUse)=>{
        if(createPilotRequested() && toolUse.name==='hms_prepare') return {kind:'result',result:{ok:false,data:null,error:{code:'STAFF_PREPARE_REQUIRED',message:'Staff runs Prepare from the proposal.',retryable:false,outcome:'known'}}};
        checkSession(id); if(!await deps.store.refresh(lease,leaseMs)) throw new Error('LEASE_LOST'); const current=await deps.store.load(id);
        if(Object.hasOwn(current.toolOutcomes,toolUse.id)) return {kind:'result',result:current.toolOutcomes[toolUse.id]};
        const answer=await registry.run(toolUse.name,toolUse.input,{sessionId:id,mode,propertyCode:session.property_code,toolUseId:toolUse.id,fence:lease,signal:abort.signal,skillConfig});
        if(answer.kind==='pause') {
          if(!await canParkSave(lease,answer.proposalId,answer.revision)) return {kind:'result',result:{ok:false,data:null,error:{code:'INVALID_SAVE',message:'Proposal is unavailable or revision changed.',retryable:false,outcome:'known'}}};
          return {kind:'pause'};
        }
        checkSession(id);await deps.store.recordToolOutcome(lease,toolUse.id,answer.result);return {kind:'result',result:answer.result};
      },
      recordToolOutcome:async(id,toolUseId,result)=>{checkSession(id);const current=await deps.store.load(id);if(Object.hasOwn(current.toolOutcomes,toolUseId)) { if(!isDeepStrictEqual(current.toolOutcomes[toolUseId],result)) throw new Error('TOOL_OUTCOME_CONFLICT');return;} await deps.store.recordToolOutcome(lease,toolUseId,result);},
      assistantStopReason:async(id,messageVersion,message)=>{checkSession(id);const [row]=await sql`SELECT payload->>'stop_reason' AS reason FROM nava_agent.agent_event WHERE session_id=${id} AND kind='model_call' AND payload->>'assistant_version'=${String(messageVersion)} AND payload->'assistant'=${json(message)}::jsonb ORDER BY sequence DESC LIMIT 1`;return row ? row.reason : undefined;},
      publishStaffReview:async(id,turnId,reason)=>{
        checkSession(id);
        const draft={workflow:'triage',disposition:'staff_review',reason:'Agent ended without a proposal. Review this email manually.',bookings:[],actions:[],field_specs:[],missing:[],warnings:[],reply_draft:null,native_result:null};
        const answer=await registry.run('proposal_publish',draft,{sessionId:id,mode,propertyCode:session.property_code,toolUseId:`runtime-fallback:${turnId}`,fence:lease,signal:abort.signal,skillConfig});
        if(answer.kind!=='result'||!answer.result.ok) throw new Error('STAFF_REVIEW_PUBLISH_FAILED');
        await deps.store.event(lease,'proposal_fallback',{reason,turn_id:turnId,result:answer.result.data});
      },
      park:async(id,toolUseId)=>{checkSession(id);await deps.store.park(lease,toolUseId);},
      finish:async(id,reason)=>{checkSession(id);await deps.store.finish(lease,reason);},
    },skillContext ?? undefined);
    if(state.pendingToolUseId) {
      if(!hmsSaveEnabled()) return;
      const save=await deps.saveQueue?.claimApprovedSave(lease,workflow=>registry.supportsSave(workflow) && (deps.native.available?.() ?? true));
      if(save) {
        if(save.sessionId!==sessionId || save.toolUseId!==state.pendingToolUseId || save.mode!==mode || save.propertyCode!==session.property_code) throw new Error('SAVE_BINDING_MISMATCH');
        const outcome:ToolResult=save.completed ?? (save.dispatch==='dispatched' ? {ok:false,data:null,error:{code:'SAVE_UNCERTAIN',message:'Save may have dispatched; reconcile before retry.',retryable:false,outcome:'uncertain'}} : save.preflightFailure ?? await registry.save(save,{sessionId,mode,signal:abort.signal,markDispatched:details=>deps.store.markDispatched(lease,save.proposalId,save.executionId,details)}));
        const completion=save.completed ? 'completed' : await deps.saveQueue!.completeSave(lease,save,outcome);
        if(completion==='completed') await runtime.resumeWithToolResult(sessionId,save.toolUseId,outcome);
      }
      return;
    }
    if(!pending) return;
    const marker=`nava-mail-event:${pending.id}`;
    const exists=state.messages.some(message=>message.role==='user' && message.content.some(block=>block.type==='text' && typeof block.text==='string' && block.text.includes(marker)));
    if(exists && !['running','pending'].includes(state.status)) {await markDelivered(lease,pending.id);return;}
    const begun=await sql`UPDATE nava_agent.agent_session SET status='running',config=jsonb_set(config,'{worker_delivery_id}',to_jsonb(${pending.id}::text)),updated_at=now() WHERE id=${sessionId} AND worker_id=${lease.workerId} AND lease_epoch=${lease.epoch}::bigint AND lease_until>clock_timestamp() RETURNING id`;
    if(!begun.length) throw new Error('LEASE_LOST');
    const content=pending.kind==='mail_pending'?'Read the selected thread and handle its request.':`Staff context: ${pending.payload.text ?? ''}`;
    await runtime.startTurn(state.threadId,{sessionId,content:`${marker} ${content}`});
  } finally {clearInterval(timer);abort.abort();await deps.store.release(lease);}
}

// After repeated worker failures, leave every queued step in a visible terminal state so staff see it and the session
// stops being picked. A Save whose dispatch marker was written may have been clicked: it becomes uncertain, never retried.
async function parkFailedSession(sessionId:string):Promise<string|null> {
  const failed={code:'WORKER_FAILED',message:'Nava could not finish this step. Nothing new was saved; run Prepare again.',
    recovery:'Run Prepare again.',retryable:false,outcome:'known',operation:'staff_stage'};
  const uncertain={code:'SAVE_UNCERTAIN',message:'Save may have dispatched; check HMS before any retry.',retryable:false,outcome:'uncertain'};
  return sql.begin(async tx=>{
    const [s]=await tx`SELECT id FROM nava_agent.agent_session WHERE id=${sessionId} AND (lease_until IS NULL OR lease_until<clock_timestamp()) FOR NO KEY UPDATE`;
    if(!s) return null;
    await tx`UPDATE nava_agent.proposal SET phase='uncertain',
      execution=COALESCE(execution,'{}'::jsonb)||jsonb_build_object('profile_uncertain',stage->'profile_dispatch','error',${json(uncertain)}::jsonb),stage=NULL,updated_at=now()
      WHERE session_id=${sessionId} AND phase='staging' AND stage->>'state'='queued' AND stage ? 'profile_dispatch'`;
    await tx`UPDATE nava_agent.proposal SET phase=COALESCE(stage->>'previous_phase','ready'),stage=NULL,
      execution=COALESCE(execution,'{}'::jsonb)||${json({error:failed})}::jsonb,updated_at=now()
      WHERE session_id=${sessionId} AND phase='staging' AND stage->>'state'='queued'`;
    const saves=await tx`SELECT id,execution,result FROM nava_agent.proposal WHERE session_id=${sessionId} AND phase='saving' AND execution->'go'->>'staff'='true' FOR UPDATE`;
    for(const proposal of saves) {
      const go=proposal.execution.go;
      const dispatched=go.dispatch!=='pending';
      const rooms=Array.isArray(go.rooms) ? go.rooms.map((room:Record<string,unknown>)=>room.state==='dispatched'?{...room,state:'uncertain'}:room) : undefined;
      const partial=rooms?.some((room:Record<string,unknown>)=>room.state==='saved') ?? false;
      const phase=dispatched?'uncertain':partial?'error':'ready';
      const error=dispatched?uncertain:partial?{...failed,message:'Some rooms were saved. Review the completed rooms before continuing.',recovery:'Check Infor before taking further action.'}:failed;
      const execution={...proposal.execution,last_go:{...go,...(rooms?{rooms}:{}),state:dispatched?'uncertain':'failed'},error};
      delete execution.go;
      const result=rooms?{...(proposal.result ?? {}),confirmation:null,reservation_id:null,readback:null,rooms}:proposal.result;
      await tx`UPDATE nava_agent.proposal SET phase=${phase},result=${json(result)},execution=${json(execution)},updated_at=now() WHERE id=${proposal.id}`;
    }
    await tx`UPDATE nava_agent.agent_event SET payload=jsonb_set(payload,'{delivered}','true'::jsonb)
      WHERE session_id=${sessionId} AND kind IN ('mail_pending','context_pending') AND payload->>'delivered'='false'`;
    await tx`UPDATE nava_agent.agent_session SET status='idle',updated_at=now() WHERE id=${sessionId} AND status='running'`;
    await writeEvent(tx,sessionId,'worker_parked',{reason:'repeated_worker_failure'});
    // writeEvent holds the per-session event lock until commit, so any later staff event gets a higher sequence.
    const [row]=await tx`SELECT max(sequence)::text AS n FROM nava_agent.agent_event WHERE session_id=${sessionId}`;
    return row.n as string;
  });
}

export async function runWorker(deps:WorkerDeps,signal?:AbortSignal):Promise<void> {
  const active=new Set<string>();
  // Consecutive failures per session: after 3, stop picking it up (and stop a stuck model turn) instead of retrying forever.
  const failures=new Map<string,number>();
  // Parked sessions stay excluded only until a newer event (e.g. a fresh signed Prepare/Go) arrives; then they get 3 new tries.
  // A dispatched Save is already uncertain in the DB, so re-admission never re-clicks it.
  const parked=new Map<string,string>();
  const limit=configuredSlots().requested;
  while(!signal?.aborted) {
    const parkedIds=[...parked.keys()],parkedSeqs=[...parked.values()];
    const rows=await sql`SELECT s.id FROM nava_agent.agent_session s WHERE (s.lease_until IS NULL OR s.lease_until<now())
      AND NOT EXISTS (SELECT 1 FROM unnest(${sql.array(parkedIds)}::text[],${sql.array(parkedSeqs)}::bigint[]) AS x(id,seq)
        WHERE x.id=s.id::text AND NOT EXISTS (SELECT 1 FROM nava_agent.agent_event e WHERE e.session_id=s.id AND e.sequence>x.seq)) AND (
      ((s.pending_tool_use_id IS NULL OR ${hmsSaveEnabled()}) AND (
        EXISTS (SELECT 1 FROM nava_agent.agent_event e WHERE e.session_id=s.id AND e.kind IN ('mail_pending','context_pending') AND e.payload->>'delivered'='false')
        OR s.status='running'))
      OR (${createPilotEnabled()} AND EXISTS (SELECT 1 FROM nava_agent.proposal p WHERE p.session_id=s.id AND p.phase='staging' AND p.stage->>'state'='queued'))
      OR (${createPilotEnabled() && createGoEnabled()} AND EXISTS (SELECT 1 FROM nava_agent.proposal p WHERE p.session_id=s.id AND p.phase='saving' AND p.execution->'go'->>'staff'='true'))
      OR (${createPilotEnabled()} AND EXISTS (SELECT 1 FROM nava_agent.proposal p WHERE p.session_id=s.id AND p.phase='uncertain' AND p.execution->'reconcile'->>'state'='queued'))
      OR (s.status='waiting_go' AND ${hmsSaveEnabled() && Boolean(deps.saveQueue)} AND (
        (s.mode='labtest' AND ${!createPilotRequested()} AND NOT (s.config ? 'manual_create_labtest'))
        OR EXISTS (SELECT 1 FROM nava_agent.proposal p WHERE p.session_id=s.id AND p.execution->'go' IS NOT NULL
          AND (p.phase='saving' OR p.execution->'go'->'completion' IS NOT NULL))))
      ) ORDER BY s.updated_at LIMIT ${limit}`;
    for(const row of rows) if(parked.delete(row.id)) failures.delete(row.id);
    for(const row of rows) if(active.size<limit && !active.has(row.id)) {
      active.add(row.id);
      void runSession(row.id,deps).then(()=>{failures.delete(row.id);},async error=>{
        const message=error instanceof Error?error.message:'';
        const count=(failures.get(row.id) ?? 0)+1;
        failures.set(row.id,count);
        console.error(JSON.stringify({event:count>=3?'worker_gave_up':'worker_error',session_id:row.id,attempt:count,error:/^[A-Z_:-]+$/.test(message)?message:error instanceof Error?error.name:'unknown'}));
        if(count>=3) {
          const sequence=await parkFailedSession(row.id).catch(()=>null);
          if(sequence) parked.set(row.id,sequence);
        }
      }).finally(()=>active.delete(row.id));
    }
    await delay(3000,undefined,{signal}).catch(()=>{});
  }
  while(active.size) await delay(100);
}

const goSchema=z.object({executionId:z.string().min(1),toolUseId:z.string().min(1),dispatch:z.enum(['pending','dispatched']),snapshot:z.unknown(),completion:z.object({toolResult:z.unknown()}).passthrough().optional()}).passthrough();
const toolResultSchema=z.object({ok:z.boolean(),data:z.unknown(),error:z.object({code:z.string(),message:z.string(),retryable:z.boolean(),outcome:z.enum(['known','uncertain'])}).strict().nullable()}).strict();
const savedSnapshotSchema=z.object({bookings:z.array(z.object({id:z.string(),property_code:z.string().nullable()}).passthrough()),actions:z.array(z.object({id:z.string(),type:z.string(),booking_ids:z.array(z.string()),details:z.unknown()}).passthrough())}).passthrough();
const knownFailure=(code:string,message:string):ToolResult=>({ok:false,data:null,error:{code,message,retryable:false,outcome:'known'}});

export function createSaveQueue(store:SessionStore):SaveQueue {
  return {
    async claimApprovedSave(lease,supportsSave) {
      if(!hmsSaveEnabled()) return null;
      const [session]=await sql`SELECT s.mode,s.config,s.pending_tool_use_id,t.property_code FROM nava_agent.agent_session s JOIN nava_agent.mail_thread t ON t.id=s.thread_id WHERE s.id=${lease.sessionId} AND s.worker_id=${lease.workerId} AND s.lease_epoch=${lease.epoch}::bigint AND s.lease_until>clock_timestamp()`;
      if(!session) throw new Error('LEASE_LOST');
      if(!['live','labtest','historical'].includes(session.mode) || !session.pending_tool_use_id) return null;
      const state=await store.load(lease.sessionId);
      const last=state.messages.at(-1);
      const call=last?.role==='assistant' ? last.content.find(block=>block.type==='tool_use' && block.id===session.pending_tool_use_id && block.name==='hms_save') : undefined;
      const input=z.object({proposal_id:z.string().min(1)}).passthrough().safeParse(call?.input);
      if(!input.success) throw new Error('SAVE_BINDING_MISMATCH');
      let [proposal]=await sql`SELECT p.id,p.revision,p.workflow,p.phase,p.execution FROM nava_agent.proposal p WHERE p.id=${input.data.proposal_id} AND p.session_id=${lease.sessionId}`;
      if(!proposal) return null;
      const manual=manualLabtestTarget.safeParse(session.config?.manual_create_labtest).success;
      const pilot=createPilotRequested();
      if(pilot && (!createPilotEnabled() || !manual || session.mode!=='labtest' || proposal.workflow!=='create')) return null;
      if((pilot || Object.hasOwn(session.config ?? {},'manual_create_labtest')) && !proposal.execution?.go) return null;
      if(!proposal.execution?.go && (!supportsSave(proposal.workflow) || session.mode!=='labtest')) return null;
      if(!proposal.execution?.go && session.mode==='labtest') {
        await store.claimGo({proposalId:proposal.id,expectedRevision:proposal.revision,idempotencyKey:`labtest:${session.pending_tool_use_id}`,actor:'labtest-auto'});
        [proposal]=await sql`SELECT id,revision,workflow,phase,execution FROM nava_agent.proposal WHERE id=${proposal.id} AND session_id=${lease.sessionId}`;
      }
      if(!proposal?.execution?.go) return null;
      const go=goSchema.parse(proposal.execution.go);
      if(proposal.phase==='uncertain' && !go.completion) return null;
      if(go.dispatch==='pending' && !go.completion && !supportsSave(proposal.workflow)) return null;
      if(go.toolUseId!==session.pending_tool_use_id) throw new Error('SAVE_BINDING_MISMATCH');
      const snapshot=savedSnapshotSchema.safeParse(go.snapshot);
      let booking:Record<string,unknown>={},action:Record<string,unknown>={},preflightFailure:ToolResult|undefined;
      if(!snapshot.success || snapshot.data.actions.length!==1 || snapshot.data.actions[0].booking_ids.length!==1) {
        preflightFailure=knownFailure('AMBIGUOUS_SAVE','One action bound to one booking is required for Save.');
      } else {
        action=snapshot.data.actions[0];
        const matches=snapshot.data.bookings.filter(item=>item.id===snapshot.data.actions[0].booking_ids[0]);
        if(matches.length!==1 || typeof matches[0].property_code!=='string' || (session.property_code && matches[0].property_code!==session.property_code)) preflightFailure=knownFailure('SAVE_BINDING_MISMATCH','Booking property or identity does not match the selected thread.');
        else booking=matches[0];
      }
      let completed:ToolResult|undefined;
      if(go.completion) {
        const value=toolResultSchema.parse(go.completion.toolResult);
        completed={ok:value.ok,data:value.data,error:value.error};
      }
      return {sessionId:lease.sessionId,proposalId:proposal.id,executionId:go.executionId,toolUseId:go.toolUseId,mode:session.mode,propertyCode:session.property_code,workflow:proposal.workflow,booking,action,dispatch:go.dispatch,...(completed?{completed}:{}),...(preflightFailure?{preflightFailure}:{})};
    },
    async completeSave(lease,job,result) {
      const outcome=result.ok ? 'saved' : result.error?.outcome==='uncertain' ? 'uncertain' : 'not_saved';
      if(outcome==='uncertain') {
        const dispatched=await sql.begin(async tx=>{
          const [session]=await tx`SELECT id FROM nava_agent.agent_session WHERE id=${lease.sessionId} AND worker_id=${lease.workerId} AND lease_epoch=${lease.epoch}::bigint AND lease_until>clock_timestamp() FOR UPDATE`;
          if(!session) throw new Error('LEASE_LOST');
          const [proposal]=await tx`SELECT phase,execution FROM nava_agent.proposal WHERE id=${job.proposalId} AND session_id=${lease.sessionId} FOR UPDATE`;
          if(!proposal || proposal.phase!=='saving' || proposal.execution?.go?.executionId!==job.executionId) throw new Error('EXECUTION_MISMATCH');
          if(proposal.execution.go.dispatch==='dispatched') return true;
          await tx`UPDATE nava_agent.proposal SET phase='uncertain',result=${json(result.data)},execution=execution || ${json({unmarked_uncertain:true})}::jsonb,updated_at=now() WHERE id=${job.proposalId}`;
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:events:'+lease.sessionId},0))`;
          await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${lease.sessionId},'save_uncertain',${json({proposal_id:job.proposalId,execution_id:job.executionId,reason:'writer_uncertain_before_marker'})})`;
          return false;
        });
        if(!dispatched) return 'reconcile';
      }
      await store.finishGo(lease,job.proposalId,job.executionId,{outcome,toolResult:result,proposalResult:result.data});
      return 'completed';
    },
  };
}

async function runCma(native:NativeAdmission):Promise<void> {
  if(!cmaServerConfigured() || !process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_ENVIRONMENT_KEY || !environmentId) throw new Error('CMA_SERVER_CONFIGURATION_REQUIRED');
  const registry=new ToolRegistry({native,emit:event});
  await discoverToolPacks(registry);
  const running=new Set<string>();
  async function mirror(session:{id:string;managed_session_id:string}) {
    const abort=new AbortController();
    const renew=setInterval(()=>{void sql`UPDATE nava_agent.agent_session SET lease_until=now()+interval '60 seconds' WHERE id=${session.id} AND worker_id=${owner} RETURNING id`.then(rows=>{if(!rows.length)abort.abort();},()=>abort.abort());},20_000);
    try {
      const stream=await client.beta.sessions.events.stream(session.managed_session_id,{}, {signal:abort.signal});
      for await(const item of client.beta.sessions.events.list(session.managed_session_id,{order:'asc'})) await mirrorEvent(session.id,item);
      for await(const item of stream) await mirrorEvent(session.id,item);
    } catch { /* reopen and replay history on the next lease */ }
    finally {clearInterval(renew);abort.abort();await sql`UPDATE nava_agent.agent_session SET worker_id=NULL,lease_until=NULL WHERE id=${session.id} AND worker_id=${owner}`;running.delete(session.id);}
  }
  async function mirrorLoop() {
    for(;;) {
      const rows=await sql`UPDATE nava_agent.agent_session SET worker_id=${owner},lease_until=now()+interval '60 seconds' WHERE id IN (SELECT id FROM nava_agent.agent_session WHERE managed_session_id IS NOT NULL AND (lease_until IS NULL OR lease_until<now()) FOR UPDATE SKIP LOCKED LIMIT 100) RETURNING id,managed_session_id`;
      for(const row of rows) if(!running.has(row.id)){running.add(row.id);void mirror({id:row.id,managed_session_id:row.managed_session_id});}
      await delay(3000);
    }
  }
  async function pendingLoop() {
    for(;;) {
      const rows=await sql`SELECT s.id,s.managed_session_id FROM nava_agent.agent_session s WHERE EXISTS (SELECT 1 FROM nava_agent.agent_event e WHERE e.session_id=s.id AND e.kind IN ('mail_pending','context_pending') AND e.payload->>'delivered'='false') LIMIT 50`;
      for(const row of rows) try {if(row.managed_session_id)await deliverPending(row.id);else await startPending(row.id);} catch { /* durable input remains pending */ }
      await delay(3000);
    }
  }
  void mirrorLoop(); void pendingLoop();
  await Promise.all(Array.from({length:configuredSlots().requested},async(_,index)=>{
    const workdir=resolve(process.env.NAVA_WORK_DIR ?? '.private/nava-agent/work',owner,String(index));
    await mkdir(workdir,{recursive:true,mode:0o700});
    const worker=client.beta.environments.work.worker({environmentId,environmentKey:process.env.ANTHROPIC_ENVIRONMENT_KEY,workdir,memorySyncIntervalMs:null,workerId:`${owner}:${index}`,tools:context=>registry.definitions().filter(def=>def.name!=='hms_save').map(def=>({type:'custom',name:def.name,description:def.description,input_schema:def.input_schema,parse:(input:unknown)=>input,run:async(input:unknown,ctx?:{toolUse:{id:string};signal?:AbortSignal|null})=>{
      const managedId=context.session?.id ?? context.sessionId ?? '';
      const [session]=await sql`SELECT s.id,s.mode,s.config,t.property_code FROM nava_agent.agent_session s JOIN nava_agent.mail_thread t ON t.id=s.thread_id WHERE s.managed_session_id=${managedId}`;
      if(!session || !['live','labtest','historical'].includes(session.mode)) return JSON.stringify({ok:false,data:null,error:{code:'SESSION_NOT_FOUND',message:'Session is unavailable.',retryable:false,outcome:'known'}});
      let skillConfig:SkillConfig|undefined;
      if(def.name==='skill_read' && registry.hasSkillPack()) {
        const root=resolve(process.env.NAVA_SKILLS_DIR ?? fileURLToPath(new URL('../skills/',import.meta.url)));
        const saved=z.object({root:z.string(),pin:z.object({version:z.string(),files:z.record(z.string())}).strict()}).strict().safeParse(session.config?.skill_config);
        if(saved.success) skillConfig={root,pin:saved.data.pin};
        else {
          const pin=await registry.pinSkillTree(root);
          if(!pin) throw new Error('SKILL_PIN_UNAVAILABLE');
          const legacy=z.record(z.string()).safeParse(session.config?.skill_files);
          if(legacy.success && Object.entries(legacy.data).some(([name,text])=>pin.pin.files[name]!==createHash('sha256').update(text).digest('hex'))) throw new Error('SKILL_PIN_CHANGED');
          await sql`UPDATE nava_agent.agent_session SET config=config || ${json({skill_config:pin})}::jsonb WHERE id=${session.id} AND NOT (config ? 'skill_config')`;
          const [current]=await sql`SELECT config->'skill_config' AS skill_config FROM nava_agent.agent_session WHERE id=${session.id}`;
          const actual=z.object({root:z.string(),pin:z.object({version:z.string(),files:z.record(z.string())}).strict()}).strict().parse(current.skill_config);
          skillConfig={root,pin:actual.pin};
        }
      }
      const answer=await registry.run(def.name,input,{sessionId:session.id,mode:session.mode,propertyCode:session.property_code,toolUseId:ctx?.toolUse.id ?? '',signal:ctx?.signal ?? undefined,skillConfig});
      if(answer.kind==='pause') throw new Error('CMA_SAVE_PAUSE_UNAVAILABLE');
      return JSON.stringify(answer.result);
    }}) as BetaRunnableTool)});
    await worker.run();
  }));
}

async function main():Promise<void> {
  if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
  const native=createNativeAdmission();
  if(runtimeProvider()==='cma') return runCma(native);
  if((process.env.AWS_REGION ?? 'eu-west-1')!=='eu-west-1') throw new Error('BEDROCK_REGION_INVALID');
  const storePath='./session-store.js',runtimePath='./agent-runtime/index.js';
  const store:SessionStore=await import(storePath);
  const runtimeModule=await import(runtimePath);
  if(typeof runtimeModule.BedrockRuntime!=='function') throw new Error('BEDROCK_RUNTIME_UNAVAILABLE');
  const quoteOnly=process.env.NAVA_QUOTE_SKELETON==='1';
  const pilot=createPilotRequested();
  const saveEnabled=hmsSaveEnabled() && !quoteOnly && (!pilot || createPilotEnabled());
  const system=quoteOnly?'Read the selected email using mail_read_thread and load quote/SKILL.md and its references with skill_read. If dates, property and occupancy support a native search, call hms_quote before publishing, including when group review is still needed. Never fabricate missing input or prices. Publish a quote proposal with native_result null; the server attaches native capture. Read only: no Save or email send.'
    :staffPrepareOnly()?'Read the selected inbound with mail_read_thread. Use the pinned triage files supplied in the system context, or load triage/SKILL.md and its references with skill_read if they were not supplied. Load the relevant workflow skill and any references not already supplied with skill_read. Handle the selected request using quote, create, amend, cancel, filing or triage as the pinned skills specify. Use only the registered tools. Publish the grounded proposal, with editable field paths for staff and native_result null (the server binds actual quote captures). For uncertain intent, scope or targets, use needs_info or staff_review. Staff runs the native action after review; never call a staging or writing tool. Never send mail, invent missing facts, or treat earlier quoted material as the current ask.'
    :pilot?'Read the selected email using mail_read_thread and read triage/SKILL.md and create/SKILL.md for new bookings. Load shared tool rules with skill_read({"skill_name":"create","path":"../references/tools-and-proposal.md"}). Create is the only supported native workflow in this pilot. Publish one grounded Create action and booking for one complete supported request, or needs_info/staff_review when unclear. Use first_name and last_name, empty Create action details, and editable pointers under /bookings/0/fields. Publish with native_result null. Only staff runs Prepare. Never send mail or invent missing input.'
    :'Read the selected mail thread with mail_read_thread, then read triage/SKILL.md and the relevant workflow skill and references with skill_read. Use registered tools and native facts only; never invent prices or send email. Publish a proposal for staff, including missing information.';
  const saveInstruction=saveEnabled ? ' When ready, request hms_save to pause for approval.' : ' End after publishing the proposal. Save is disabled.';
  await runWorker({store,native,...(saveEnabled?{saveQueue:createSaveQueue(store)}:{}),runtime:(deps,skillContext)=>new runtimeModule.BedrockRuntime(deps,{system:system+saveInstruction+(skillContext ? `\n\n${skillContext}` : '')})});
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
