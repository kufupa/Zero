import { access } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { json, sql, uid } from './db.js';
import { groupedQuoteRequest, proposalDraft, schemas, tools, type ProposalDraft, type Workflow } from './schema.js';
import { normalizeProposalFields } from './proposal-fields.js';
import { configuredToolPacks, createGoEnabled, hmsSaveEnabled, isWriteWorkflow, nativeSaveAllowed, staffPrepareOnly } from './hms-mode.js';
import { attachmentsUnconfirmed, confirmedQueuedStaffStage, invalidGuestSelection, selectedStageSource, type StaffJobBinding, type StaffStage } from './attachment-gate.js';
import { withTriageLookupFields } from '../tools/triage/index.js';
import { lookupStay, targetLookup } from './stay-target.js';

export type Mode = 'live' | 'labtest' | 'historical';
export type SkillConfig = {root:string;pin:{version:string;files:Record<string,string>}};
export type ToolContext = { sessionId: string; mode: Mode; signal?: AbortSignal; skillConfig?:SkillConfig; staffStage?:StaffStage; staffGo?:{executionId:string}; credentialLease?:NativeLease };
const nativeErrorSchema=z.object({error_class:z.string(),message:z.string(),native_step:z.string(),stack:z.string().nullable()}).strict();
export const toolErrorSchema=z.object({code:z.string(),message:z.string(),retryable:z.boolean(),
  outcome:z.enum(['known','uncertain']),native_error:nativeErrorSchema.optional()}).strict();
export type ToolResult = { ok: boolean; data: unknown; error: z.infer<typeof toolErrorSchema> | null };
export type ToolDefinition = { name:string; description:string; input_schema:{type:'object';properties:Record<string,unknown>;required?:string[];additionalProperties?:boolean} };
export type PackTool = ToolDefinition & {run(input:unknown,context:ToolContext):Promise<ToolResult>};
export type MutationInput = {workflow:string;booking:Record<string,unknown>;action:Record<string,unknown>};
type SaveInput = MutationInput & {executionId:string;expectedPrice?:unknown;prepared?:unknown;confirmPenalty?:true;priorRooms?:unknown[]};
type SaveContext = ToolContext & {markDispatched(details:unknown):Promise<void>};
export type MutationPack = {prepare(input:MutationInput,context:ToolContext):Promise<ToolResult>;save?: (input:SaveInput,context:SaveContext)=>Promise<ToolResult>};
export type NativeLease = {signal:AbortSignal};
export type NativeTiming = (phase:string, elapsedMs:number)=>void;
export type NativeAdmission = {available?():boolean;withRead<T>(propertyCode:string, signal:AbortSignal|undefined, work:(lease:NativeLease)=>Promise<T>, scope?:'quote', timing?:NativeTiming):Promise<T>;withSave<T>(propertyCode:string,signal:AbortSignal|undefined,work:(lease:NativeLease)=>Promise<T>):Promise<T>};
export type RegistryDeps = {native:NativeAdmission; emit(sessionId:string,kind:string,payload:unknown):Promise<void>};
export type LeaseFence = {sessionId:string;workerId:string;epoch:string};
export type RegistryContext = ToolContext & {propertyCode:string|null; toolUseId:string; fence?:LeaseFence};
type Booking = ProposalDraft['bookings'][number];
type Action = ProposalDraft['actions'][number];
export type StaffNativeInput =
  | {workflow:'quote'; request:z.infer<typeof groupedQuoteRequest>}
  | {workflow:'triage'; booking:Booking|null; action:Action}
  | {workflow:'create'|'amend'|'cancel'|'filing'; booking:Booking; action:Action};
export type StaffNativeContext = ToolContext & {propertyCode:string; credentialLease:NativeLease; signal:AbortSignal;
  staffStage:StaffJobBinding & {mailboxId:string;sourceMessageId:string;sourceThreadId:string}};

const modelReadTools = new Set(['hms_quote','hms_search_reservations','hms_read_reservation','hms_read_catalogue','hms_search_parties']);
const prepareOnlyTool = (name:string) => name==='skill_read' || modelReadTools.has(name);
const replacedBaselineTool = (name:string) => name==='reply_draft' || prepareOnlyTool(name);
const workflows = ['quote','create','amend','cancel','filing','triage'] as const;
type ToolPack = {tools?:unknown;prepare?:unknown;save?:unknown;pinSkills?:unknown;quote?:unknown;quoteModelView?:unknown;stageRead?:unknown};
type FilingPorts = Required<Pick<import('../tools/filing/index.js').ToolContext,'authorizeTarget'|'resolveAttachment'>>;
type StaffHandler = (input:unknown,context:StaffNativeContext & Partial<FilingPorts>)=>Promise<unknown>;
function staffPackHandler(name:string,pack:ToolPack):StaffHandler|undefined {
  const hook=name==='quote'?pack.quote:name==='triage'?pack.stageRead:pack.prepare;
  if(typeof hook==='function') return (input,context)=>Promise.resolve(hook(input,context));
}

type FilingModule = {
  filingPortsAvailable?:()=>boolean;
  createFilingPorts?:(context:ToolContext,input:unknown)=>Partial<FilingPorts>|Promise<Partial<FilingPorts>>;
  withFilingSourceFields?:(draft:ProposalDraft,selectedMessage:unknown)=>ProposalDraft;
};
async function loadFilingModule():Promise<FilingModule|undefined> {
  const path='./filing-ports.js';
  try {
    return await import(path);
  } catch(error) {
    if(!(error instanceof Error) || !('code' in error) || error.code!=='ERR_MODULE_NOT_FOUND') throw error;
  }
}
async function filingPortFactory() {
  const mod=await loadFilingModule();
  return typeof mod?.createFilingPorts==='function' && mod.filingPortsAvailable?.()===true ? mod.createFilingPorts : undefined;
}

function result(data:unknown) { return JSON.stringify({ok:true,data,error:null}); }
function failure(code:string,message:string) { return JSON.stringify({ok:false,data:null,error:{code,message,retryable:false,outcome:'known'}}); }
const groupedCaptureSchema=z.object({quote_order:z.array(z.string()),quotes:z.record(z.unknown()),searches:z.array(z.unknown()),display_rows:z.array(z.unknown())}).passthrough();
const captureEnvelopeSchema=z.object({ok:z.boolean(),data:z.unknown()}).passthrough();
const exactProfileRead=z.object({
  input:z.object({kind:z.literal('guest'),field:z.literal('profile_id'),query:z.string().regex(/^\d+$/),property_code:z.string()}),
  response:z.object({ok:z.literal(true),data:z.object({native:z.object({
    outcome:z.literal('matches'),criteria:z.object({field:z.literal('profileId'),query:z.string()}),
    candidates:z.array(z.object({nativeId:z.string(),firstName:z.string(),lastName:z.string()})),
  })})}),
});
function readProfileId(booking:Booking,values:unknown[]):string|null {
  const first=booking.fields.first_name, last=booking.fields.last_name;
  if(typeof first!=='string' || typeof last!=='string') return null;
  const ids=new Set<string>();
  for(const value of values) {
    const read=exactProfileRead.safeParse(value);
    if(!read.success || read.data.input.property_code!==booking.property_code || read.data.input.query!==read.data.response.data.native.criteria.query) continue;
    const matches=read.data.response.data.native.candidates.filter(candidate=>candidate.nativeId===read.data.input.query);
    if(matches.length===1 && matches[0].firstName.trim().toLowerCase()===first.trim().toLowerCase() &&
       matches[0].lastName.trim().toLowerCase()===last.trim().toLowerCase()) ids.add(matches[0].nativeId);
  }
  return ids.size===1 ? [...ids][0] : null;
}
function mergeQuoteCaptures(values:unknown[],expected:Map<string,unknown>):{native:unknown;incomplete:boolean} {
  const latest=new Map<string,{data:z.infer<typeof groupedCaptureSchema>;ok:boolean;input:unknown}>();
  let legacy:unknown=null,legacyOk=false;
  for(const value of values) {
    const entry=z.object({response:z.unknown(),input:z.unknown()}).passthrough().safeParse(value);
    if(!entry.success) continue;
    const envelope=captureEnvelopeSchema.safeParse(entry.data.response);
    if(!envelope.success) continue;
    const grouped=groupedCaptureSchema.safeParse(envelope.data.data);
    if(!grouped.success) {legacy=envelope.data.data;legacyOk=envelope.data.ok;continue;}
    if(grouped.data.quote_order.length!==1) continue;
    const id=grouped.data.quote_order[0];
    if(Object.hasOwn(grouped.data.quotes,id)) latest.set(id,{data:grouped.data,ok:envelope.data.ok,input:entry.data.input});
  }
  if(!latest.size) return {native:legacy,incomplete:!legacyOk || expected.size>0};
  const quoteOrder=expected.size ? [...expected.keys()] : [...latest.keys()];
  const quotes:Record<string,unknown>=Object.create(null), searches:unknown[]=[],displayRows:unknown[]=[];
  let incomplete=false;
  for(const id of quoteOrder) {
    const capture=latest.get(id);
    if(!capture || (expected.has(id) && !isDeepStrictEqual(capture.input,expected.get(id)))) {incomplete=true;continue;}
    incomplete ||= !capture.ok;
    const offset=searches.length;
    const quote=z.object({groups:z.record(z.unknown())}).passthrough().safeParse(capture.data.quotes[id]);
    if(!quote.success) {incomplete=true;continue;}
    const groups:Record<string,unknown>=Object.create(null);
    for(const [groupId,value] of Object.entries(quote.data.groups)) {
      const group=z.object({search_index:z.number().int().nonnegative().nullable()}).passthrough().safeParse(value);
      if(!group.success) {incomplete=true;groups[groupId]=value;continue;}
      groups[groupId]={...group.data,search_index:group.data.search_index===null?null:group.data.search_index+offset};
    }
    quotes[id]={...quote.data,groups};
    searches.push(...capture.data.searches);
    for(const value of capture.data.display_rows) {
      const row=z.object({id:z.string(),native_path:z.string()}).passthrough().safeParse(value);
      if(!row.success) {incomplete=true;continue;}
      const path=row.data.native_path.replace(/^\/searches\/(\d+)(?=\/)/,(_match,index:string)=>`/searches/${Number(index)+offset}`);
      displayRows.push({...row.data,id:`${id}:${row.data.id}`,native_path:path});
    }
  }
  return {native:{quote_order:quoteOrder.filter(id=>Object.hasOwn(quotes,id)),quotes,searches,display_rows:displayRows},incomplete};
}
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
          const nativePath=process.env.NAVA_HMS_QUOTE_MODULE ?? fileURLToPath(new URL('../../server-pilot/tooling/hms-cloud/fetch-quote.mjs',import.meta.url));
          const {fetchQuote}=await import(nativePath);
          const request={schemaVersion:2,propertyCode:q.property_code,arrivalDate:q.arrival_date,departureDate:q.departure_date,rooms:q.rooms.map(r=>({id:r.id,quantity:r.quantity,adults:r.adults,children:r.children,childAges:r.child_ages})),...(q.search?{search:q.search}:{}),...(q.details?{details:q.details}:{}),...(q.max_options_per_group?{maxOptionsPerGroup:q.max_options_per_group}:{})};
          const native=await fetchQuote({propertyCode:q.property_code,request,signal});
          const complete=['quote','no_match','unavailable'].includes(native.outcome) && native.audit?.status==='complete';
          const envelope=complete ? {ok:true,data:native,error:null} : {ok:false,data:native,error:{code:typeof native.outcome==='string'?native.outcome.toUpperCase():'NATIVE_FAILURE',message:'Native quote incomplete or failed; inspect returned capture.',retryable:native.outcome==='execution_failure',outcome:'known'}};
          await emit(session.id,'native_quote',{tool_event_id:toolEvent,input,response:envelope});
          response=JSON.stringify(envelope);
        }
      }
    } else if (name==='proposal_publish') {
      const draft:ProposalDraft=schemas.proposal_publish.parse(input);
      const hasNeedsInfoAction = draft.actions.some(action => action.type === 'needs_info');
      const needsInfoType = draft.disposition === 'needs_info' && ['quote','create','amend','cancel'].includes(draft.workflow) ? draft.workflow : null;
      if (hasNeedsInfoAction && !needsInfoType) response=failure('INVALID_ACTION_TYPE','needs_info is a disposition, not an action. Put it in disposition; use the actual requested action type, or leave actions empty if unknown.');
      else if(draft.workflow!=='quote' && draft.native_result!==null) response=failure('NATIVE_RESULT_MISMATCH','Only an independently captured native result may be published.');
      else response=await sql.begin(async tx=>{
        if (needsInfoType) draft.actions = draft.actions.map(action => action.type === 'needs_info' ? {...action,type:needsInfoType} : action);
          if(fence) { const rows=await tx`SELECT id FROM nava_agent.agent_session WHERE id=${session.id} AND worker_id=${fence.workerId} AND lease_epoch=${fence.epoch}::bigint AND lease_until>clock_timestamp() FOR UPDATE`; if(!rows.length) throw new Error('LEASE_LOST'); }
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:quote:'+session.id},0))`;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${toolEvent},0))`;
        const [existing]=await tx`SELECT id,revision,phase FROM nava_agent.proposal WHERE session_id=${session.id} AND execution->>'publish_event_id'=${toolEvent}`;
        if(existing) return result({proposal_id:existing.id,revision:existing.revision,phase:existing.phase});
        const captures=await tx`SELECT payload FROM nava_agent.agent_event WHERE session_id=${session.id} AND kind='native_quote' AND sequence > COALESCE((SELECT max(sequence) FROM nava_agent.agent_event WHERE session_id=${session.id} AND kind IN ('mail_pending','context_pending')),0) ORDER BY sequence`;
        const quoteRequests=new Map<string,unknown>();
        for(const action of draft.actions) {
          const details=z.object({quote_id:z.string().min(1)}).passthrough().safeParse(action.details);
          if(action.type==='quote' && details.success) quoteRequests.set(details.data.quote_id,action.details);
        }
        const merged=mergeQuoteCaptures(captures.map(capture=>capture.payload),quoteRequests);
        const native=draft.workflow==='quote'?merged.native:null;
        if(draft.native_result!==null) {
          const [same]=await tx`SELECT ${json(draft.native_result)}::jsonb IS NOT DISTINCT FROM ${json(native)}::jsonb OR EXISTS (SELECT 1 FROM nava_agent.agent_event WHERE session_id=${session.id} AND kind='native_quote' AND sequence > COALESCE((SELECT max(sequence) FROM nava_agent.agent_event WHERE session_id=${session.id} AND kind IN ('mail_pending','context_pending')),0) AND payload->'response'->'data' IS NOT DISTINCT FROM ${json(draft.native_result)}::jsonb) AS equal`;
          if(!same.equal || draft.workflow!=='quote') return failure('NATIVE_RESULT_MISMATCH','native_result must equal an actual quote capture for this session and request.');
        }
        const incomplete=draft.workflow==='quote' && merged.incomplete;
        let staffDraft=proposalDraft.parse({...draft,native_result:native,...(incomplete && (draft.disposition==='propose'||draft.disposition==='decline')?{disposition:'staff_review',warnings:[...draft.warnings,'Native quote was not completed; staff review required.']}: {})});
        if(staffPrepareOnly() && staffDraft.workflow==='create') {
          const reads=await tx`SELECT c.payload->'input' AS input,r.payload->'result' AS response
            FROM nava_agent.agent_event r JOIN nava_agent.agent_event c ON c.session_id=r.session_id
              AND c.kind='tool_call' AND c.payload->>'tool_use_id'=r.payload->>'tool_event_id'
            WHERE r.session_id=${session.id} AND r.kind='tool_result' AND r.payload->>'tool'='hms_search_parties'
              AND r.sequence > COALESCE((SELECT max(sequence) FROM nava_agent.agent_event WHERE session_id=${session.id} AND kind IN ('mail_pending','context_pending')),0)
            ORDER BY r.sequence`;
          staffDraft={...staffDraft,
            bookings:staffDraft.bookings.map(booking=>({...booking,fields:{...booking.fields,
              guest_profile_id:booking.fields.guest_profile_id ?? readProfileId(booking,reads),profile_create_new:false}})),
          };
        }
        if(staffPrepareOnly() && draft.workflow==='filing' && draft.disposition==='propose') {
          const filing=await loadFilingModule();
          const source=await selectedStageSource(tx,session.id);
          if(filing?.withFilingSourceFields && source.success) {
            const [selected]=await tx`SELECT payload FROM nava_agent.mail_message
              WHERE thread_id=${session.thread_id} AND source_message_id=${source.data.source_message_id}`;
            staffDraft=proposalDraft.parse(filing.withFilingSourceFields(staffDraft,selected?.payload));
          }
        }
        if(staffPrepareOnly() && session.mode==='live') {
          staffDraft=withTriageLookupFields(staffDraft);
        }
        const normalized=normalizeProposalFields(staffDraft);
        if(normalized.kind==='invalid') return failure('INVALID_FIELD_PATH',`Field ${JSON.stringify(normalized.path)} must resolve to a value in the proposal. Include its action details or booking fields; use null for unknown values. Editable paths must be under actions/{index}/details, bookings/{index}/fields, or /reply_draft.`);
        const current=normalized.draft;
        const id=uid('proposal');
        await tx`INSERT INTO nava_agent.proposal(id,thread_id,session_id,revision,workflow,phase,original,current,execution) VALUES (${id},${session.thread_id},${session.id},1,${draft.workflow},'ready',${json(current)},${json(current)},${json({publish_event_id:toolEvent,native_quote_event_ids:captures.map(capture=>capture.payload.tool_event_id)})})`;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:events:'+session.id},0))`;
        await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${session.id},'proposal',${json({proposal_id:id,workflow:draft.workflow,revision:1,fields:{bookings:current.bookings,actions:current.actions}})})`;
        return result({proposal_id:id,revision:1,phase:'ready'});
      });
    } else if (name==='reply_draft') {
      const draft=schemas.reply_draft.parse(input);
      response=await sql.begin(async tx=>{
          if(fence) { const rows=await tx`SELECT id FROM nava_agent.agent_session WHERE id=${session.id} AND worker_id=${fence.workerId} AND lease_epoch=${fence.epoch}::bigint AND lease_until>clock_timestamp() FOR UPDATE`; if(!rows.length) throw new Error('LEASE_LOST'); }
        const rows=await tx`UPDATE nava_agent.proposal SET current=jsonb_set(current,'{reply_draft}',to_jsonb(${draft.text}::text)),revision=revision+1,stage=NULL,updated_at=now()
          WHERE id=${draft.proposal_id} AND session_id=${session.id} AND phase IN ('ready','waiting_go') AND current->>'reply_draft' IS DISTINCT FROM ${draft.text} RETURNING id,revision`;
        if(rows.length) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:events:'+session.id},0))`;
        if(rows.length) await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${session.id},'proposal',${json({proposal_id:rows[0].id,revision:rows[0].revision,change:'reply_draft'})})`;
        const [current]=rows.length?rows:await tx`SELECT id,revision FROM nava_agent.proposal WHERE id=${draft.proposal_id} AND session_id=${session.id} AND phase IN ('ready','waiting_go')`;
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
const resultSchema=z.object({ok:z.boolean(),data:z.unknown(),error:toolErrorSchema.nullable()}).strict().refine(value=>value.ok ? value.error===null : value.error!==null);
function parseResult(value:unknown):ToolResult {
  if(typeof value!=='object' || value===null || !Object.hasOwn(value,'data')) throw new Error('INVALID_TOOL_RESULT');
  const parsed=resultSchema.parse(value);
  return {ok:parsed.ok,data:parsed.data,error:parsed.error};
}
const failureObject=(code:string,message:string):ToolResult=>({ok:false,data:null,error:{code,message,retryable:false,outcome:'known'}});
function nativeError(error:unknown, step:string):z.infer<typeof nativeErrorSchema> {
  const e=error instanceof Error ? error : new Error(typeof error==='string'?error:'Native tool threw a non-Error value');
  const info=e as Error & {step?:unknown;stage?:unknown;phase?:unknown};
  const provided=[info.step,info.stage,info.phase].find(value=>typeof value==='string' && /^[a-z][\w.:-]{0,95}$/i.test(value));
  const redact=(value:string)=>value
    .replace(/\b(?:Bearer|Basic)\s+[\w.+\/=-]+/gi,'[redacted authorization]')
    .replace(/\b(authorization|cookie|password|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1=[redacted]')
    .replace(/([a-z][\w+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[redacted]@')
    .replace(/(https?:\/\/[^\s?]+)\?[^\s)]+/gi,'$1?[redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g,'[redacted token]')
    .replace(/\b[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+\b/g,'[redacted email]');
  const message=redact(e.message).slice(0,1800);
  const error_class=redact(e.constructor?.name || e.name || 'Error').slice(0,96);
  const frames=e.stack?.split('\n').filter(line=>/^\s+at\s/.test(line)).slice(0,14);
  return {error_class,message,native_step:typeof provided==='string'?provided:step,
    stack:frames?.length?redact([error_class+': '+message,...frames].join('\n')).slice(0,6200):null};
}
const prepareDefinition:ToolDefinition={name:'hms_prepare',description:'Prepare a native change without saving.',input_schema:{type:'object',properties:{workflow:{type:'string',enum:['create','amend','cancel','filing']},booking:{type:'object'},action:{type:'object'}},required:['workflow','booking','action'],additionalProperties:false}};
const saveDefinition:ToolDefinition={name:'hms_save',description:'Pause for approval before saving the current proposal.',input_schema:{type:'object',properties:{proposal_id:{type:'string'},expected_revision:{type:'integer',minimum:1}},required:['proposal_id','expected_revision'],additionalProperties:false}};

export class ToolRegistry {
  private readonly packTools=new Map<string,PackTool>();
  private readonly mutations=new Map<string,MutationPack>();
  private readonly staffHandlers=new Map<string,StaffHandler>();
  private quoteModelView?:(result:ToolResult)=>ToolResult;
  private pinSkills?: (root:string)=>Promise<SkillConfig['pin']>;
  constructor(private readonly deps:RegistryDeps) {}

  registerPack(name:string,pack:ToolPack) {
    const staffHandler=staffPackHandler(name,pack);
    if(staffHandler) this.staffHandlers.set(name,staffHandler);
    if(name==='quote' && typeof pack.quoteModelView==='function') {
      const modelView=pack.quoteModelView;
      this.quoteModelView=answer=>parseResult(modelView(answer));
    }
    if(name==='skills' && typeof pack.pinSkills==='function') {
      const pin=pack.pinSkills;
      this.pinSkills=async root=>z.object({version:z.string().min(1),files:z.record(z.string())}).strict().parse(await pin(root));
    }
    if(pack.tools!==undefined) {
      if(!Array.isArray(pack.tools)) throw new Error(`INVALID_TOOL_PACK:${name}`);
      for(const item of pack.tools) {
        const parsed=definitionSchema.parse(item);
        if(parsed.name==='hms_prepare' && typeof pack.prepare==='function') continue;
        if(staffPrepareOnly() && !prepareOnlyTool(parsed.name)) continue;
        if(!parsed.name.startsWith('hms_') && !['skill_read','outlook_reply_draft','outlook_reply_command'].includes(parsed.name)) throw new Error(`INVALID_PACK_TOOL:${parsed.name}`);
        if(['hms_prepare','hms_save'].includes(parsed.name) || this.packTools.has(parsed.name)) throw new Error(`DUPLICATE_TOOL:${parsed.name}`);
        // The structural boundary checks declaration and callable handler; packs own their own input parsing.
        const tool:PackTool={name:parsed.name,description:parsed.description,input_schema:parsed.input_schema,run:async(input,context)=>parseResult(await parsed.run(input,context))};
        this.packTools.set(tool.name,tool);
      }
    }
    if(pack.prepare!==undefined || pack.save!==undefined) {
      if(!['create','amend','cancel','filing'].includes(name) || typeof pack.prepare!=='function' || (pack.save!==undefined && typeof pack.save!=='function')) throw new Error(`INVALID_MUTATION_PACK:${name}`);
      const prepare=pack.prepare;
      const save=pack.save;
      this.mutations.set(name,{prepare:async(input,context)=>prepare(input,context),...(nativeSaveAllowed() && typeof save==='function'?{save:async(input:SaveInput,context:SaveContext)=>save(input,context)}:{})});
    }
  }

  hasSkillPack():boolean { return !!this.pinSkills; }
  supportsSave(workflow:string):boolean { return hmsSaveEnabled() && typeof this.mutations.get(workflow)?.save==='function'; }

  async pinSkillTree(root:string):Promise<SkillConfig|null> {
    return this.pinSkills ? {root,pin:await this.pinSkills(root)} : null;
  }

  definitions():ToolDefinition[] {
    const merged=new Map<string,ToolDefinition>(tools.filter(tool=>!staffPrepareOnly() || !replacedBaselineTool(tool.name)).map(({name,description,input_schema})=>[name,{name,description,input_schema}]));
    for(const {name,description,input_schema} of this.packTools.values()) merged.set(name,{name,description,input_schema});
    if(this.mutations.size && !staffPrepareOnly()) {
      merged.set(prepareDefinition.name,prepareDefinition);
      if(hmsSaveEnabled()) merged.set(saveDefinition.name,saveDefinition);
    }
    return [...merged.values()];
  }

  async runStaffStage(input:StaffNativeInput, draft:ProposalDraft, job:StaffJobBinding, context:Omit<RegistryContext,'toolUseId'>):Promise<ToolResult> {
    if (!staffPrepareOnly() || context.mode!=='live' || context.propertyCode!==job.source.property_code
        || input.workflow!==job.workflow || draft.workflow!==job.workflow
        || (input.workflow==='quote' && input.request.quote_id!==job.quoteId)) return failureObject('STAFF_JOB_CHANGED','Staff native job is no longer in scope.');
    const handler=this.staffHandlers.get(job.workflow);
    if(!handler) return failureObject('UNAVAILABLE','Workflow is unavailable.');
    const filing=job.workflow==='filing'?await filingPortFactory():undefined;
    if(job.workflow==='filing' && !filing) return failureObject('ATTACHMENT_SOURCE_UNAVAILABLE','The selected attachment source is unavailable.');
    let step='native_read_admission';
    return this.nativeResult(()=>this.deps.native.withRead(job.source.property_code,context.signal,async credentialLease=>{
      step='confirm_staff_stage_source';
      const denied=await confirmedQueuedStaffStage(job,context.sessionId,draft);
      if(denied) return failureObject(denied,denied===attachmentsUnconfirmed.code?attachmentsUnconfirmed.message
        :denied===invalidGuestSelection.code?invalidGuestSelection.message:'The selected source or proposal revision changed.');
      credentialLease.signal.throwIfAborted();
      const staffStage={...job,mailboxId:job.source.mailbox_id,sourceMessageId:job.source.source_message_id,sourceThreadId:job.source.source_thread_id};
      const trusted={...context,propertyCode:job.source.property_code,credentialLease,signal:credentialLease.signal,staffStage};
      step='resolve_staff_stage_inputs';
      const ports=filing?await filing(trusted,input):undefined;
      credentialLease.signal.throwIfAborted();
      step='execute_'+job.workflow;
      const raw=await handler(input.workflow==='quote'?input.request:input,{...trusted,...ports});
      step='validate_'+job.workflow+'_result';
      const parsed=parseResult(raw);
      step='release_native_read';
      return parsed;
    },job.workflow==='quote'?'quote':undefined),()=>step);
  }

  async reconcileCreate(intent:unknown, signal:AbortSignal):Promise<ToolResult> {
    const parsed=z.object({operation:z.literal('create'),propertyCode:z.string(),approvedDigest:z.string(),
      recovery:z.object({request:z.unknown(),ratePlanAvailability:z.unknown().optional(),arAccountProfileId:z.string().optional()}).passthrough()}).passthrough().safeParse(intent);
    if(!parsed.success) return failureObject('SAVE_UNCERTAIN','Check the booking in Infor before taking further action.');
    return this.nativeResult(()=>this.deps.native.withRead(parsed.data.propertyCode,signal,async credentialLease=>{
      const base=new URL('../../server-pilot/tooling/hms-cloud/',import.meta.url);
      const native=await import(new URL('create-positive-recovery.mjs',base).href);
      const proof=await native.provePositiveCreateRecovery(parsed.data,{credentialLease,signal:credentialLease.signal});
      if(proof?.outcome!=='verified') return failureObject('SAVE_UNCERTAIN','Infor did not confirm the Save. Check the booking before taking further action.');
      return {ok:true,data:{confirmation:proof.confirmation,reservation_id:proof.readback.nativeStayId,readback:proof.readback,
        sibling:{confirmation:proof.confirmation,nativeStayId:proof.readback.nativeStayId,approvedRequest:parsed.data.recovery.request,
          requestDigest:parsed.data.approvedDigest,ratePlanAvailability:parsed.data.recovery.ratePlanAvailability,
          ...(parsed.data.recovery.arAccountProfileId?{arProfileId:parsed.data.recovery.arAccountProfileId}:{})}},error:null};
    }));
  }

  async runStayLookup(lookup:z.infer<typeof targetLookup>, bookingId:string, draft:ProposalDraft, job:StaffJobBinding, context:Omit<RegistryContext,'toolUseId'>):Promise<ToolResult> {
    if(!staffPrepareOnly() || context.mode!=='live' || context.propertyCode!==job.source.property_code ||
      !['amend','cancel','filing'].includes(job.workflow) || draft.workflow!==job.workflow) return failureObject('STAFF_JOB_CHANGED','The request changed. Search again.');
    return this.nativeResult(()=>this.deps.native.withRead(job.source.property_code,context.signal,async credentialLease=>{
      const denied=await confirmedQueuedStaffStage(job,context.sessionId,draft);
      if(denied) return failureObject(denied,'The request changed. Search again.');
      const staffStage={...job,mailboxId:job.source.mailbox_id,sourceMessageId:job.source.source_message_id,sourceThreadId:job.source.source_thread_id};
      return lookupStay(lookup,bookingId,{...context,propertyCode:job.source.property_code,credentialLease,signal:credentialLease.signal,staffStage});
    }));
  }

  async run(name:string,input:unknown,context:RegistryContext):Promise<{kind:'result';result:ToolResult}|{kind:'pause';proposalId:string;revision:number}> {
    context.signal?.throwIfAborted();
    if(name==='reply_draft' && staffPrepareOnly()) return {kind:'result',result:failureObject('UNAVAILABLE','Include draft text in proposal_publish for staff review.')};
    if(name==='hms_save') {
      if(!hmsSaveEnabled()) return {kind:'result',result:failureObject('SAVE_DISABLED','Only unsaved Prepare is available.')};
      const request=saveInput.safeParse(input);
      if(!request.success) return {kind:'result',result:failureObject('INVALID_INPUT','Invalid Save request.')};
      return {kind:'pause',proposalId:request.data.proposal_id,revision:request.data.expected_revision};
    }
    if(name.startsWith('hms_') && context.mode==='historical') return {kind:'result',result:failureObject('HISTORICAL_HMS_UNAVAILABLE','Historical sessions cannot access live HMS.')};
    const pack=this.packTools.get(name);
    if(name==='hms_prepare') {
      if(staffPrepareOnly()) return {kind:'result',result:failureObject('STAFF_PREPARE_REQUIRED','Staff runs Prepare from the proposal.')};
      const request=prepareInput.safeParse(input);
      if(!request.success) return {kind:'result',result:failureObject('INVALID_INPUT','Invalid prepare request.')};
      const handler=this.mutations.get(request.data.workflow);
      if(!handler) return {kind:'result',result:failureObject('UNAVAILABLE','Workflow prepare is unavailable.')};
      const property=request.data.booking.property_code;
      if(typeof property!=='string' || !property || (context.propertyCode && context.propertyCode!==property)) return {kind:'result',result:failureObject('PROPERTY_MISMATCH','Booking property is missing or differs from the thread.')};
      return {kind:'result',result:await this.nativeResult(()=>this.deps.native.withRead(property,context.signal,lease=>handler.prepare(request.data,{...context,credentialLease:lease,signal:lease.signal})))};
    }
    if(pack) {
      await this.deps.emit(context.sessionId,'tool_started',{tool:name,tool_event_id:context.toolUseId});
      let response:ToolResult;
      if(name==='hms_quote' && context.fence) {
        const [prior]=await sql`SELECT payload FROM nava_agent.agent_event WHERE session_id=${context.sessionId}
          AND kind='native_quote' AND payload->>'tool_event_id'=${context.toolUseId} ORDER BY sequence DESC LIMIT 1`;
        if(prior) {
          if(!isDeepStrictEqual(prior.payload.input,input)) return {kind:'result',result:failureObject('TOOL_OUTCOME_CONFLICT','Native quote input differs from the captured request.')};
          const capture=parseResult(prior.payload.response);
          const result=this.quoteModelView?.(capture) ?? capture;
          await this.deps.emit(context.sessionId,'tool_result',{tool:name,tool_event_id:context.toolUseId,result});
          return {kind:'result',result};
        }
      }
      if(name.startsWith('hms_')) {
        const request=z.object({property_code:z.string().min(1)}).passthrough().safeParse(input);
        if(!request.success || (staffPrepareOnly() ? context.propertyCode!==request.data.property_code : (context.propertyCode && context.propertyCode!==request.data.property_code))) return {kind:'result',result:failureObject('PROPERTY_MISMATCH','Requested property is missing or differs from the thread.')};
        const timings:Record<string,number[]>={};
        response=await this.nativeResult(()=>this.deps.native.withRead(request.data.property_code,context.signal,async lease=>{
          if(staffPrepareOnly()) {
            const fence=context.fence;
            const verified=fence && await sql.begin('isolation level repeatable read read only',async tx=>{
              const [owned]=await tx`SELECT id FROM nava_agent.agent_session WHERE id=${context.sessionId} AND worker_id=${fence.workerId} AND lease_epoch=${fence.epoch}::bigint AND lease_until>clock_timestamp()`;
              const source=owned && await selectedStageSource(tx,context.sessionId);
              return source?.success && source.data.property_code===request.data.property_code;
            });
            if(!verified) return failureObject('STAFF_SOURCE_CHANGED','The selected live source is unavailable.');
          }
          lease.signal.throwIfAborted();
          return pack.run(input,{...context,credentialLease:lease,signal:lease.signal});
        },name==='hms_quote'?'quote':undefined,(phase,ms)=>(timings[phase]??=[]).push(Math.round(ms))));
        await this.deps.emit(context.sessionId,'native_timing',{tool:name,tool_event_id:context.toolUseId,stages_ms:timings});
      } else response=await this.nativeResult(()=>pack.run(input,context));
      if(name==='hms_quote') {
        await this.deps.emit(context.sessionId,'native_quote',{tool_event_id:context.toolUseId,input,response});
        response=this.quoteModelView?.(response) ?? response;
      }
      await this.deps.emit(context.sessionId,'tool_result',{tool:name,tool_event_id:context.toolUseId,result:response});
      return {kind:'result',result:response};
    }
    if(staffPrepareOnly() && prepareOnlyTool(name)) return {kind:'result',result:failureObject('UNAVAILABLE','Tool is not installed.')};
    const baseline=tools.find(tool=>tool.name===name);
    if(!baseline) return {kind:'result',result:failureObject('UNAVAILABLE','Tool is unavailable.')};
    if(name==='hms_quote') {
      const request=schemas.hms_quote.safeParse(input);
      if(!request.success || (context.propertyCode && context.propertyCode!==request.data.property_code)) return {kind:'result',result:failureObject('PROPERTY_MISMATCH','Requested property is missing or differs from the thread.')};
      return {kind:'result',result:await this.nativeResult(async()=>JSON.parse(await this.deps.native.withRead(request.data.property_code,context.signal,lease=>baselineDispatch(context.sessionId,name,input,context.toolUseId,this.deps.emit,context.fence,lease.signal))))};
    }
    return {kind:'result',result:await this.nativeResult(async()=>JSON.parse(await baselineDispatch(context.sessionId,name,input,context.toolUseId,this.deps.emit,context.fence,context.signal)))};
  }

  async createGuestProfile(input:{propertyCode:string;guest:{firstName:string;lastName:string;mobile:string;email?:string};attemptId:string},
    context:{signal:AbortSignal;authorize:()=>Promise<boolean>;markDispatched:()=>Promise<void>}):Promise<ToolResult> {
    const base=new URL('../../server-pilot/tooling/hms-cloud/',import.meta.url);
    try {
      return await this.deps.native.withSave(input.propertyCode,context.signal,async credentialLease=>{
        const [native,properties]=await Promise.all([import(new URL('guest-profile-runner.mjs',base).href),import(new URL('property-registry.mjs',base).href)]);
        const transportId=properties.getPropertyRegistration(input.propertyCode)?.mailboxTransportId;
        const runner=native.createGuestProfileRunner({sessionOptions:{propertyCode:input.propertyCode,transportId,credentialLease,signal:credentialLease.signal},
          authorizeStaffWrite:async()=>!credentialLease.signal.aborted && await context.authorize(),
          dispatchStaffWrite:async(_candidate:unknown,proceed:()=>Promise<unknown>)=>{await context.markDispatched(); credentialLease.signal.throwIfAborted(); return proceed();}});
        const business={propertyCode:input.propertyCode,guest:input.guest,confirmDuplicateName:true};
        const preview=await runner.prepareGuestProfile(business);
        if(preview.outcome!=='ready') return failureObject('PROFILE_PREPARE_FAILED','Infor could not prepare the Guest Profile.');
        const saved=await runner.createGuestProfile({...business,attemptId:input.attemptId,expectedPreviewDigest:preview.previewDigest,
          ...(preview.review?{expectedReview:preview.review}:{})});
        if(saved.outcome!=='created' || typeof saved.nativeId!=='string' || !/^\d+$/.test(saved.nativeId)) {
          return {ok:false,data:saved,error:{code:'PROFILE_CREATE_FAILED',message:'Infor did not confirm the new Guest Profile.',retryable:false,outcome:saved.dispatched===false?'known':'uncertain'}};
        }
        const fresh=await runner.readGuestProfile({propertyCode:input.propertyCode,nativeId:saved.nativeId,attemptId:input.attemptId});
        if(fresh.outcome!=='read' || fresh.nativeId!==saved.nativeId || fresh.reconciliation?.outcome!=='created') {
          return {ok:false,data:saved,error:{code:'PROFILE_READBACK_UNCONFIRMED',message:'Check the Guest Profile in Infor before retrying.',retryable:false,outcome:'uncertain'}};
        }
        return {ok:true,data:{nativeId:saved.nativeId,readback:fresh},error:null};
      });
    } catch {
      return {ok:false,data:null,error:{code:'PROFILE_CREATE_UNAVAILABLE',message:'Infor could not confirm the Guest Profile.',retryable:false,outcome:'uncertain'}};
    }
  }

  async save(input:SaveInput,context:SaveContext):Promise<ToolResult> {
    if(!nativeSaveAllowed()) return failureObject('SAVE_DISABLED','Only unsaved Prepare is available.');
    const staff=createGoEnabled() && context.mode==='live' && context.staffGo?.executionId===input.executionId;
    if(context.mode!=='labtest' && !staff) return failureObject('SAVE_UNAUTHORIZED','A staff Go is required to save a live booking.');
    const pack=this.mutations.get(input.workflow),property=input.booking.property_code;
    const save=pack?.save;
    if(!save || typeof property!=='string' || !property) return failureObject('UNAVAILABLE','A native writer or property is unavailable.');
    const filing=input.workflow==='filing' && staff?await filingPortFactory():undefined;
    if(input.workflow==='filing' && staff && !filing) return failureObject('ATTACHMENT_SOURCE_UNAVAILABLE','The selected attachment source is unavailable.');
    let marked=false;
    const uncertain:ToolResult={ok:false,data:null,error:{code:'SAVE_UNCERTAIN',message:'Save may have dispatched; reconcile before any retry.',retryable:false,outcome:'uncertain'}};
    try {
      const value=await this.deps.native.withSave(property,context.signal,async lease=>{
        const trusted={...context,credentialLease:lease,signal:lease.signal};
        const ports=filing?await filing(trusted,input):undefined;
        return save(input,{...trusted,...ports,markDispatched:async details=>{if(marked) throw new Error('DISPATCH_ALREADY_MARKED'); await context.markDispatched(details); marked=true;}});
      });
      const parsed=resultSchema.safeParse(value);
      if(!parsed.success) return marked ? uncertain : failureObject('INVALID_WRITER_RESULT','Writer returned an invalid result before dispatch.');
      if(!marked && parsed.data.ok) return failureObject('DISPATCH_MARKER_MISSING','Writer did not record dispatch.');
      if(marked && !parsed.data.ok && parsed.data.error?.outcome!=='uncertain') return uncertain;
      if(marked && parsed.data.ok) {
        const readback=z.object({confirmation:z.string().nullable(),reservation_id:z.string().nullable(),readback:z.unknown()}).passthrough().safeParse(parsed.data.data);
        if(!readback.success || readback.data.readback==null) return uncertain;
      }
      return {ok:parsed.data.ok,data:parsed.data.data,error:parsed.data.error};
    } catch {
      return marked ? uncertain : failureObject('SAVE_FAILED','Save stopped before dispatch.');
    }
  }

  private async nativeResult(work:()=>Promise<ToolResult>, step:()=>string=()=> 'execute_native_tool'):Promise<ToolResult> {
    try { return parseResult(await work()); } catch(error) {
      if(error instanceof Error && error.message==='LEASE_LOST') throw error;
      const admission=error instanceof Error && ['HMS_CREDENTIAL_SESSION_CAP_REQUIRED','NATIVE_SHARED_LEASE_DATABASE_REQUIRED'].includes(error.message);
      return {ok:false,data:null,error:{code:admission?error.message:'TOOL_FAILED',
        message:admission?'Native shared admission is not configured.':'Tool execution failed or was interrupted.',
        retryable:false,outcome:'known',native_error:nativeError(error,step())}};
    }
  }
}

async function loadToolPack(name:string,root:string):Promise<ToolPack|undefined> {
    let path:string|undefined;
    for(const extension of ['js','ts']) {
      const candidate=resolve(root,name,`index.${extension}`);
      try { await access(candidate); path=candidate; break; } catch { /* optional pack */ }
    }
    if(path) return import(pathToFileURL(path).href);
}

const toolRoot=fileURLToPath(new URL('../tools/',import.meta.url));
export async function discoverToolPacks(registry:ToolRegistry,root=toolRoot,names=configuredToolPacks() ?? [...workflows,'skills','outlook-reply']):Promise<void> {
  for(const name of names) {
    const pack=await loadToolPack(name,root);
    if(pack) registry.registerPack(name,pack);
  }
}

export async function installedStaffTools() {
  const installed=await Promise.all((configuredToolPacks() ?? []).map(async name=>({name,pack:await loadToolPack(name,toolRoot)})));
  const modelTools=new Set(tools.filter(tool=>!replacedBaselineTool(tool.name)).map(tool=>tool.name));
  const stages:Workflow[]=[];
  const writers:Workflow[]=[];
  for(const {name,pack} of installed) {
    if(!pack) continue;
    if(Array.isArray(pack.tools)) for(const value of pack.tools) {
      const tool=definitionSchema.parse(value);
      if(prepareOnlyTool(tool.name)) modelTools.add(tool.name);
    }
    const workflow=workflows.find(workflow=>workflow===name);
    if(workflow && staffPackHandler(name,pack) && (workflow!=='filing' || await filingPortFactory())) {
      stages.push(workflow);
      if(isWriteWorkflow(workflow) && typeof pack.save==='function') writers.push(workflow);
    }
  }
  return {stages,writers,modelTools:[...modelTools]};
}
