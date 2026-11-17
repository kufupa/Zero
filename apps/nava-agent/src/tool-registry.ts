import { access } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { json, sql, uid } from './db.js';
import { schemas, tools, type ProposalDraft } from './schema.js';

export type Mode = 'live' | 'labtest' | 'historical';
export type ToolContext = { sessionId: string; mode: Mode; signal?: AbortSignal };
export type ToolResult = { ok: boolean; data: unknown; error: {code:string;message:string;retryable:boolean;outcome:'known'|'uncertain'} | null };
export type ToolDefinition = { name:string; description:string; input_schema:{type:'object';properties:Record<string,unknown>;required?:string[];additionalProperties?:boolean} };
export type PackTool = ToolDefinition & {run(input:unknown,context:ToolContext):Promise<ToolResult>};
export type MutationInput = {workflow:string;booking:Record<string,unknown>;action:Record<string,unknown>};
export type MutationPack = {prepare(input:MutationInput,context:ToolContext):Promise<ToolResult>;save?: (input:MutationInput & {executionId:string},context:ToolContext & {markDispatched(details:unknown):Promise<void>})=>Promise<ToolResult>};
export type NativeAdmission = {withRead<T>(propertyCode:string, signal:AbortSignal|undefined, work:()=>Promise<T>):Promise<T>;withSave<T>(propertyCode:string,signal:AbortSignal|undefined,work:()=>Promise<T>):Promise<T>;withQuote?<T>(propertyCode:string,signal:AbortSignal|undefined,work:()=>Promise<T>):Promise<T>};
export type RegistryDeps = {native:NativeAdmission; emit(sessionId:string,kind:string,payload:unknown):Promise<void>};
export type LeaseFence = {sessionId:string;workerId:string;epoch:string};
export type RegistryContext = ToolContext & {propertyCode:string|null; toolUseId:string; fence?:LeaseFence};

function result(data:unknown) { return JSON.stringify({ok:true,data,error:null}); }
function failure(code:string,message:string) { return JSON.stringify({ok:false,data:null,error:{code,message,retryable:false,outcome:'known'}}); }
async function baselineDispatch(sessionId:string,name:string,input:unknown,toolEvent:string,emit:RegistryDeps['emit'],fence?:LeaseFence,signal?:AbortSignal) {
  const [session]=await sql`SELECT s.*,t.property_code FROM nava_agent.agent_session s JOIN nava_agent.mail_thread t ON t.id=s.thread_id WHERE s.id=${sessionId} OR s.managed_session_id=${sessionId}`;
  if (!session) return failure('SESSION_NOT_FOUND','Session is not registered.');
  await emit(session.id,'tool_started',{tool:name,tool_event_id:toolEvent});
  let response:string;
  try {
    if(name==='skill_read') {
      const request=schemas.skill_read.parse(input);
      if(request.skill_name!=='quote') response=failure('UNAVAILABLE','Only the quote skill is available.');
      else {
        const requested=request.path ?? 'SKILL.md';
        const path=posix.normalize(`quote/${requested}`);
        const files=session.config?.skill_files;
        if(posix.isAbsolute(requested) || (!path.startsWith('quote/') && !path.startsWith('references/')) || !files || !Object.hasOwn(files,path) || typeof files[path]!=='string') response=failure('SKILL_REFERENCE_UNAVAILABLE','Skill reference unavailable in pinned tree.');
        else response=result({skill_name:'quote',path,version:session.config.skill_sha256,text:files[path]});
      }
    } else if(name==='mail_read_thread') {
      schemas.mail_read_thread.parse(input);
      const thread=await sql`SELECT source,source_thread_id,mailbox_id,selected_message_id,property_code,mode FROM nava_agent.mail_thread WHERE id=${session.thread_id}`;
      const messages=await sql`SELECT payload FROM nava_agent.mail_message WHERE thread_id=${session.thread_id} ORDER BY received_at,id`;
      const [source]=await sql`SELECT payload FROM nava_agent.agent_event WHERE session_id=${session.id} AND kind='train_source' ORDER BY sequence DESC LIMIT 1`;
      const sourceInput=source?.payload;
      response=result({...thread[0],messages:messages.map(m=>m.payload),...(sourceInput ? {source_input:{input_cutoff:sourceInput.input_cutoff,selected_message:sourceInput.selected_message,earlier_relevant_source_events:sourceInput.earlier_relevant_source_events}} : {})});
    } else if (name==='hms_quote') {
      const q=schemas.hms_quote.parse(input);
      if(session.mode==='historical') response=failure('HISTORICAL_HMS_UNAVAILABLE','Historical sessions cannot access live HMS.');
      else if (session.property_code && session.property_code!==q.property_code) response=failure('PROPERTY_MISMATCH','Requested property differs from thread property.');
      else {
        const [prior]=await sql`SELECT payload FROM nava_agent.agent_event WHERE session_id=${session.id} AND kind='native_quote' AND payload->>'tool_event_id'=${toolEvent}`;
        if(prior) response=JSON.stringify(prior.payload.response);
        else {
          const nativePath=process.env.NAVA_HMS_QUOTE_MODULE ?? resolve('apps/server-pilot/tooling/hms-cloud/fetch-quote.mjs');
          const {fetchQuote}=await import(nativePath);
          const request={schemaVersion:2,propertyCode:q.property_code,arrivalDate:q.arrival_date,departureDate:q.departure_date,rooms:q.rooms.map(r=>({id:r.id,quantity:r.quantity,adults:r.adults,children:r.children,childAges:r.child_ages})),...(q.search?{search:q.search}:{}),...(q.details?{details:q.details}:{}),...(q.max_options_per_group?{maxOptionsPerGroup:q.max_options_per_group}:{})};
          const native=await fetchQuote({propertyCode:q.property_code,request,signal});
          const complete=['quote','no_match','unavailable'].includes(native.outcome) && native.audit?.status==='complete';
          const envelope=complete ? {ok:true,data:native,error:null} : {ok:false,data:native,error:{code:typeof native.outcome==='string'?native.outcome.toUpperCase():'NATIVE_FAILURE',message:'Native quote incomplete or failed; inspect returned capture.',retryable:native.outcome==='execution_failure',outcome:'known'}};
          await emit(session.id,'native_quote',{tool_event_id:toolEvent,response:envelope});
          response=JSON.stringify(envelope);
        }
      }
    } else if (name==='proposal_publish') {
      const draft:ProposalDraft=schemas.proposal_publish.parse(input);
      if(draft.workflow!=='quote' && draft.native_result!==null) response=failure('NATIVE_RESULT_MISMATCH','Only an independently captured native result may be published.');
      else response=await sql.begin(async tx=>{
          if(fence) { const rows=await tx`SELECT id FROM nava_agent.agent_session WHERE id=${session.id} AND worker_id=${fence.workerId} AND lease_epoch=${fence.epoch}::bigint AND lease_until>clock_timestamp() FOR UPDATE`; if(!rows.length) throw new Error('LEASE_LOST'); }
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:quote:'+session.id},0))`;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${toolEvent},0))`;
        const [existing]=await tx`SELECT id,revision,phase FROM nava_agent.proposal WHERE session_id=${session.id} AND execution->>'publish_event_id'=${toolEvent}`;
        if(existing) return result({proposal_id:existing.id,revision:existing.revision,phase:existing.phase});
        const [lastCall]=await tx`SELECT payload FROM nava_agent.agent_event WHERE session_id=${session.id} AND kind='tool_started' AND payload->>'tool'='hms_quote' AND sequence > COALESCE((SELECT max(sequence) FROM nava_agent.agent_event WHERE session_id=${session.id} AND kind IN ('mail_pending','context_pending')),0) ORDER BY sequence DESC LIMIT 1`;
        const [capture]=lastCall ? await tx`SELECT payload FROM nava_agent.agent_event WHERE session_id=${session.id} AND kind='native_quote' AND payload->>'tool_event_id'=${lastCall.payload.tool_event_id} ORDER BY sequence DESC LIMIT 1` : [];
        const native=capture?.payload.response.data ?? null;
        if(draft.native_result!==null) {
          const [same]=await tx`SELECT ${json(draft.native_result)}::jsonb IS NOT DISTINCT FROM ${json(native)}::jsonb AS equal`;
          if(!same.equal || !capture || draft.workflow!=='quote') return failure('NATIVE_RESULT_MISMATCH','native_result must equal the actual quote capture for this session and request.');
        }
        const incomplete=draft.workflow==='quote' && (!capture || capture.payload.response.ok!==true);
        const current={...draft,native_result:draft.workflow==='quote'?native:null,...(incomplete && (draft.disposition==='propose'||draft.disposition==='decline')?{disposition:'staff_review',warnings:[...draft.warnings,'Native quote was not completed; staff review required.']}: {})};
        const id=uid('proposal');
        await tx`INSERT INTO nava_agent.proposal(id,thread_id,session_id,revision,workflow,phase,original,current,execution) VALUES (${id},${session.thread_id},${session.id},1,${draft.workflow},'ready',${json(current)},${json(current)},${json({publish_event_id:toolEvent,native_quote_event_id:capture?.payload.tool_event_id ?? null})})`;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:events:'+session.id},0))`;
        await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${session.id},'proposal',${json({proposal_id:id,workflow:draft.workflow,revision:1,fields:{bookings:current.bookings,actions:current.actions}})})`;
        return result({proposal_id:id,revision:1,phase:'ready'});
      });
    } else if (name==='reply_draft') {
      const draft=schemas.reply_draft.parse(input);
      response=await sql.begin(async tx=>{
          if(fence) { const rows=await tx`SELECT id FROM nava_agent.agent_session WHERE id=${session.id} AND worker_id=${fence.workerId} AND lease_epoch=${fence.epoch}::bigint AND lease_until>clock_timestamp() FOR UPDATE`; if(!rows.length) throw new Error('LEASE_LOST'); }
        const rows=await tx`UPDATE nava_agent.proposal SET current=jsonb_set(current,'{reply_draft}',to_jsonb(${draft.text}::text)),revision=revision+1,updated_at=now() WHERE id=${draft.proposal_id} AND session_id=${session.id} AND current->>'reply_draft' IS DISTINCT FROM ${draft.text} RETURNING id,revision`;
        if(rows.length) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:events:'+session.id},0))`;
        if(rows.length) await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${session.id},'proposal',${json({proposal_id:rows[0].id,revision:rows[0].revision,change:'reply_draft'})})`;
        const [current]=rows.length?rows:await tx`SELECT id,revision FROM nava_agent.proposal WHERE id=${draft.proposal_id} AND session_id=${session.id}`;
        return current?result({proposal_id:current.id,revision:current.revision}):failure('NOT_FOUND','Proposal not found in this session.');
      });
    } else response=failure('UNAVAILABLE','Tool is unavailable.');
  } catch (error) { if(error instanceof Error && error.message==='LEASE_LOST') throw error; response=failure('TOOL_FAILED','Tool execution failed or input was invalid.'); }
  await emit(session.id,'tool_result',{tool:name,tool_event_id:toolEvent,result:JSON.parse(response)});
  return response;
}

const prepareInput=z.object({workflow:z.enum(['create','amend','cancel','filing']),booking:z.object({id:z.string(),property_code:z.string().nullable(),reservation_id:z.string().nullable(),current_state:z.record(z.unknown()).nullable(),fields:z.record(z.unknown())}).strict(),action:z.object({id:z.string(),type:z.string(),booking_ids:z.array(z.string()),details:z.unknown()}).strict()}).strict();
const saveInput=z.object({proposal_id:z.string().min(1),expected_revision:z.number().int().positive()}).strict();
const definitionSchema=z.object({name:z.string().regex(/^[a-z][a-z0-9_]*$/),description:z.string(),input_schema:z.object({type:z.literal('object'),properties:z.record(z.unknown()),required:z.array(z.string()).optional(),additionalProperties:z.boolean().optional()}).passthrough(),run:z.function()});
const resultSchema=z.object({ok:z.boolean(),data:z.unknown(),error:z.object({code:z.string(),message:z.string(),retryable:z.boolean(),outcome:z.enum(['known','uncertain'])}).strict().nullable()}).strict();
const failureObject=(code:string,message:string):ToolResult=>({ok:false,data:null,error:{code,message,retryable:false,outcome:'known'}});
const prepareDefinition:ToolDefinition={name:'hms_prepare',description:'Prepare a native change without saving.',input_schema:{type:'object',properties:{workflow:{type:'string',enum:['create','amend','cancel','filing']},booking:{type:'object'},action:{type:'object'}},required:['workflow','booking','action'],additionalProperties:false}};
const saveDefinition:ToolDefinition={name:'hms_save',description:'Pause for approval before saving the current proposal.',input_schema:{type:'object',properties:{proposal_id:{type:'string'},expected_revision:{type:'integer',minimum:1}},required:['proposal_id','expected_revision'],additionalProperties:false}};

export class ToolRegistry {
  private readonly packTools=new Map<string,PackTool>();
  private readonly mutations=new Map<string,MutationPack>();
  constructor(private readonly deps:RegistryDeps) {}

  registerPack(name:string,pack:{tools?:unknown;prepare?:unknown;save?:unknown}) {
    if(pack.tools!==undefined) {
      if(!Array.isArray(pack.tools)) throw new Error(`INVALID_TOOL_PACK:${name}`);
      for(const item of pack.tools) {
        const parsed=definitionSchema.parse(item);
        if(parsed.name==='hms_prepare' && typeof pack.prepare==='function') continue;
        if(!parsed.name.startsWith('hms_') && !['skill_read','outlook_reply_draft'].includes(parsed.name)) throw new Error(`INVALID_PACK_TOOL:${parsed.name}`);
        if(['hms_prepare','hms_save'].includes(parsed.name) || this.packTools.has(parsed.name)) throw new Error(`DUPLICATE_TOOL:${parsed.name}`);
        // The structural boundary checks declaration and callable handler; packs own their own input parsing.
        const tool:PackTool={name:parsed.name,description:parsed.description,input_schema:parsed.input_schema,run:async(input,context)=>parsed.run(input,context)};
        this.packTools.set(tool.name,tool);
      }
    }
    if(pack.prepare!==undefined || pack.save!==undefined) {
      if(!['create','amend','cancel','filing'].includes(name) || typeof pack.prepare!=='function' || (pack.save!==undefined && typeof pack.save!=='function')) throw new Error(`INVALID_MUTATION_PACK:${name}`);
      const prepare=pack.prepare;
      const save=pack.save;
      this.mutations.set(name,{prepare:async(input,context)=>prepare(input,context),...(typeof save==='function'?{save:async(input:MutationInput & {executionId:string},context:ToolContext & {markDispatched(details:unknown):Promise<void>})=>save(input,context)}:{})});
    }
  }

  definitions():ToolDefinition[] {
    const merged=new Map<string,ToolDefinition>(tools.map(({name,description,input_schema})=>[name,{name,description,input_schema}]));
    for(const {name,description,input_schema} of this.packTools.values()) merged.set(name,{name,description,input_schema});
    if(this.mutations.size) { merged.set(prepareDefinition.name,prepareDefinition); merged.set(saveDefinition.name,saveDefinition); }
    return [...merged.values()];
  }

  async run(name:string,input:unknown,context:RegistryContext):Promise<{kind:'result';result:ToolResult}|{kind:'pause';proposalId:string;revision:number}> {
    context.signal?.throwIfAborted();
    if(name==='hms_save') {
      const request=saveInput.safeParse(input);
      if(!request.success) return {kind:'result',result:failureObject('INVALID_INPUT','Invalid Save request.')};
      return {kind:'pause',proposalId:request.data.proposal_id,revision:request.data.expected_revision};
    }
    if(name.startsWith('hms_') && context.mode==='historical') return {kind:'result',result:failureObject('HISTORICAL_HMS_UNAVAILABLE','Historical sessions cannot access live HMS.')};
    const pack=this.packTools.get(name);
    if(name==='hms_prepare') {
      const request=prepareInput.safeParse(input);
      if(!request.success) return {kind:'result',result:failureObject('INVALID_INPUT','Invalid prepare request.')};
      const handler=this.mutations.get(request.data.workflow);
      if(!handler) return {kind:'result',result:failureObject('UNAVAILABLE','Workflow prepare is unavailable.')};
      const property=request.data.booking.property_code;
      if(typeof property!=='string' || !property || (context.propertyCode && context.propertyCode!==property)) return {kind:'result',result:failureObject('PROPERTY_MISMATCH','Booking property is missing or differs from the thread.')};
      return {kind:'result',result:await this.nativeResult(()=>this.deps.native.withRead(property,context.signal,()=>handler.prepare(request.data,context)))};
    }
    if(pack) {
      await this.deps.emit(context.sessionId,'tool_started',{tool:name,tool_event_id:context.toolUseId});
      let response:ToolResult;
      if(name.startsWith('hms_')) {
        const request=z.object({property_code:z.string().min(1)}).passthrough().safeParse(input);
        if(!request.success || (context.propertyCode && context.propertyCode!==request.data.property_code)) return {kind:'result',result:failureObject('PROPERTY_MISMATCH','Requested property is missing or differs from the thread.')};
        const admission=name==='hms_quote' ? this.deps.native.withQuote ?? this.deps.native.withRead : this.deps.native.withRead;
        response=await this.nativeResult(()=>admission(request.data.property_code,context.signal,()=>pack.run(input,context)));
      } else response=await this.nativeResult(()=>pack.run(input,context));
      if(name==='hms_quote') await this.deps.emit(context.sessionId,'native_quote',{tool_event_id:context.toolUseId,response});
      await this.deps.emit(context.sessionId,'tool_result',{tool:name,tool_event_id:context.toolUseId,result:response});
      return {kind:'result',result:response};
    }
    const baseline=tools.find(tool=>tool.name===name);
    if(!baseline) return {kind:'result',result:failureObject('UNAVAILABLE','Tool is unavailable.')};
    if(name==='hms_quote') {
      const request=schemas.hms_quote.safeParse(input);
      if(!request.success || (context.propertyCode && context.propertyCode!==request.data.property_code)) return {kind:'result',result:failureObject('PROPERTY_MISMATCH','Requested property is missing or differs from the thread.')};
      return {kind:'result',result:await this.nativeResult(async()=>JSON.parse(await this.deps.native.withRead(request.data.property_code,context.signal,()=>baselineDispatch(context.sessionId,name,input,context.toolUseId,this.deps.emit,context.fence,context.signal))))};
    }
    return {kind:'result',result:await this.nativeResult(async()=>JSON.parse(await baselineDispatch(context.sessionId,name,input,context.toolUseId,this.deps.emit,context.fence,context.signal)))};
  }

  async save(input:MutationInput & {executionId:string},context:ToolContext & {markDispatched(details:unknown):Promise<void>}):Promise<ToolResult> {
    if(context.mode!=='labtest') return failureObject('SAVE_UNAUTHORIZED','Native Save is only available for authorized Labtest sessions.');
    const pack=this.mutations.get(input.workflow),property=input.booking.property_code;
    if(!pack?.save || typeof property!=='string' || !property) return failureObject('UNAVAILABLE','A native writer or property is unavailable.');
    let marked=false;
    const uncertain:ToolResult={ok:false,data:null,error:{code:'SAVE_UNCERTAIN',message:'Save may have dispatched; reconcile before any retry.',retryable:false,outcome:'uncertain'}};
    try {
      const value=await this.deps.native.withSave(property,context.signal,()=>pack.save!(input,{...context,markDispatched:async details=>{if(marked) throw new Error('DISPATCH_ALREADY_MARKED'); await context.markDispatched(details); marked=true;}}));
      const parsed=resultSchema.safeParse(value);
      if(!parsed.success) return marked ? uncertain : failureObject('INVALID_WRITER_RESULT','Writer returned an invalid result before dispatch.');
      if(!marked && parsed.data.ok) return failureObject('DISPATCH_MARKER_MISSING','Writer did not record dispatch.');
      if(marked && !parsed.data.ok && parsed.data.error?.outcome!=='uncertain') return uncertain;
      if(marked && parsed.data.ok) {
        const readback=z.object({confirmation:z.string().nullable(),reservation_id:z.string().nullable(),readback:z.unknown()}).strict().safeParse(parsed.data.data);
        if(!readback.success || readback.data.readback==null) return uncertain;
      }
      return parsed.data;
    } catch {
      return marked ? uncertain : failureObject('SAVE_FAILED','Save stopped before dispatch.');
    }
  }

  private async nativeResult(work:()=>Promise<ToolResult>):Promise<ToolResult> {
    try { const parsed=resultSchema.safeParse(await work()); return parsed.success ? parsed.data : failureObject('INVALID_TOOL_RESULT','Tool returned an invalid result.'); } catch(error) { if(error instanceof Error && error.message==='LEASE_LOST') throw error; return failureObject('TOOL_FAILED','Tool execution failed or was interrupted.'); }
  }
}

export async function discoverToolPacks(registry:ToolRegistry,root=resolve('apps/nava-agent/tools'),names=['quote','create','amend','cancel','filing','triage','outlook-reply']):Promise<void> {
  for(const name of names) {
    let path:string|undefined;
    for(const extension of ['js','ts']) {
      const candidate=resolve(root,name,`index.${extension}`);
      try { await access(candidate); path=candidate; break; } catch { /* optional pack */ }
    }
    if(path) registry.registerPack(name,await import(pathToFileURL(path).href));
  }
}
