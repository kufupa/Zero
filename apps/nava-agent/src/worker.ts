import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { client, environmentId, mirrorEvent, startPending, deliverPending } from './runtime.js';
import { event, json, sql, uid } from './db.js';
import { schemas, tools, type ProposalDraft } from './schema.js';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';

if (!process.env.DATABASE_URL || !process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_ENVIRONMENT_KEY || !environmentId) throw new Error('DATABASE_URL and first-party Managed Agents credentials required');
const slots=Number(process.env.NAVA_HMS_SLOTS ?? 10);
if (!Number.isInteger(slots) || slots<1 || slots>12) throw new Error('NAVA_HMS_SLOTS must be 1..12');
const nativeCap=Number(process.env.HMS_CREDENTIAL_SESSION_CAP ?? 8);
if (!Number.isInteger(nativeCap) || nativeCap<1 || nativeCap>8) throw new Error('HMS_CREDENTIAL_SESSION_CAP must be 1..8');
const owner=`${hostname()}:${process.pid}:${uid('worker')}`;
const running=new Set<string>();
async function mirror(session:{id:string;managed_session_id:string}) {
  const abort=new AbortController();
  const renew=setInterval(()=>{void sql`UPDATE nava_agent.agent_session SET lease_until=now()+interval '60 seconds' WHERE id=${session.id} AND worker_id=${owner} RETURNING id`.then(rows=>{if(!rows.length)abort.abort();},()=>abort.abort());},20000);
  try {
    const stream=await client.beta.sessions.events.stream(session.managed_session_id,{}, {signal:abort.signal});
    for await (const item of client.beta.sessions.events.list(session.managed_session_id,{order:'asc'})) await mirrorEvent(session.id,item);
    for await (const item of stream) await mirrorEvent(session.id,item);
  } catch { /* next pass opens a new stream before replaying history */ }
  finally { clearInterval(renew); abort.abort(); await sql`UPDATE nava_agent.agent_session SET worker_id=NULL,lease_until=NULL WHERE id=${session.id} AND worker_id=${owner}`; running.delete(session.id); }
}
async function mirrorLoop() {
  for (;;) {
    const rows=await sql`UPDATE nava_agent.agent_session SET worker_id=${owner},lease_until=now()+interval '60 seconds' WHERE id IN (SELECT id FROM nava_agent.agent_session WHERE managed_session_id IS NOT NULL AND (lease_until IS NULL OR lease_until<now()) FOR UPDATE SKIP LOCKED LIMIT 100) RETURNING id,managed_session_id`;
    for (const row of rows) if (!running.has(row.id)) { running.add(row.id); void mirror({id:row.id,managed_session_id:row.managed_session_id}); }
    await delay(3000);
  }
}
function result(data:unknown) { return JSON.stringify({ok:true,data,error:null}); }
function failure(code:string,message:string) { return JSON.stringify({ok:false,data:null,error:{code,message,retryable:false,outcome:'known'}}); }
async function dispatch(managedId:string,name:string,input:unknown,toolEvent:string,signal?:AbortSignal|null) {
  const [session]=await sql`SELECT s.*,t.property_code FROM nava_agent.agent_session s JOIN nava_agent.mail_thread t ON t.id=s.thread_id WHERE s.managed_session_id=${managedId}`;
  if (!session) return failure('SESSION_NOT_FOUND','Session is not registered.');
  await event(session.id,'tool_started',{tool:name,tool_event_id:toolEvent});
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
        response=await sql.begin(async tx=>{
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:quote:'+session.id},0))`;
          const [prior]=await tx`SELECT payload FROM nava_agent.agent_event WHERE session_id=${session.id} AND kind='native_quote' AND payload->>'tool_event_id'=${toolEvent}`;
          if(prior) return JSON.stringify(prior.payload.response);
          const nativePath=process.env.NAVA_HMS_QUOTE_MODULE ?? resolve('apps/server-pilot/tooling/hms-cloud/fetch-quote.mjs');
          const {fetchQuote}=await import(nativePath);
          const request={schemaVersion:2,propertyCode:q.property_code,arrivalDate:q.arrival_date,departureDate:q.departure_date,rooms:q.rooms.map(r=>({id:r.id,quantity:r.quantity,adults:r.adults,children:r.children,childAges:r.child_ages})),...(q.search?{search:q.search}:{}),...(q.details?{details:q.details}:{}),...(q.max_options_per_group?{maxOptionsPerGroup:q.max_options_per_group}:{})};
          const native=await fetchQuote({propertyCode:q.property_code,request,signal:signal ?? undefined});
          const complete=['quote','no_match','unavailable'].includes(native.outcome) && native.audit?.status==='complete';
          const envelope=complete ? {ok:true,data:native,error:null} : {ok:false,data:native,error:{code:typeof native.outcome==='string'?native.outcome.toUpperCase():'NATIVE_FAILURE',message:'Native quote incomplete or failed; inspect returned capture.',retryable:native.outcome==='execution_failure',outcome:'known'}};
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:events:'+session.id},0))`;
          await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${session.id},'native_quote',${json({tool_event_id:toolEvent,response:envelope})})`;
          return JSON.stringify(envelope);
        });
      }
    } else if (name==='proposal_publish') {
      const draft:ProposalDraft=schemas.proposal_publish.parse(input);
      if(draft.workflow!=='quote') response=failure('WORKFLOW_UNAVAILABLE','Only quote proposals are supported.');
      else response=await sql.begin(async tx=>{
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
        const rows=await tx`UPDATE nava_agent.proposal SET current=jsonb_set(current,'{reply_draft}',to_jsonb(${draft.text}::text)),revision=revision+1,updated_at=now() WHERE id=${draft.proposal_id} AND session_id=${session.id} AND current->>'reply_draft' IS DISTINCT FROM ${draft.text} RETURNING id,revision`;
        if(rows.length) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:events:'+session.id},0))`;
        if(rows.length) await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${session.id},'proposal',${json({proposal_id:rows[0].id,revision:rows[0].revision,change:'reply_draft'})})`;
        const [current]=rows.length?rows:await tx`SELECT id,revision FROM nava_agent.proposal WHERE id=${draft.proposal_id} AND session_id=${session.id}`;
        return current?result({proposal_id:current.id,revision:current.revision}):failure('NOT_FOUND','Proposal not found in this session.');
      });
    } else response=failure('UNAVAILABLE','Tool is unavailable.');
  } catch { response=failure('TOOL_FAILED','Tool execution failed or input was invalid.'); }
  await event(session.id,'tool_result',{tool:name,tool_event_id:toolEvent,result:JSON.parse(response)});
  return response;
}
function registry(managedId:string):BetaRunnableTool[] {
  return tools.map(def=>({type: "custom",name:def.name,input_schema:def.input_schema,description:def.description,
    parse:(input:unknown)=>input,
    run:(input:unknown,context?:{toolUse:{id:string};signal?:AbortSignal|null})=>dispatch(managedId,def.name,input,context?.toolUse.id ?? '',context?.signal)
  } as BetaRunnableTool));
}
async function pendingLoop() {
  for (;;) {
    const rows=await sql`SELECT s.id,s.managed_session_id FROM nava_agent.agent_session s WHERE EXISTS (SELECT 1 FROM nava_agent.agent_event e WHERE e.session_id=s.id AND e.kind IN ('mail_pending','context_pending') AND e.payload->>'delivered'='false') LIMIT 50`;
    for (const row of rows) { try { if (row.managed_session_id) await deliverPending(row.id); else await startPending(row.id); } catch { /* retry from durable pending event */ } }
    await delay(3000);
  }
}
void pendingLoop();
void mirrorLoop();
await Promise.all(Array.from({length:slots},async(_,i)=>{
  const workdir=resolve(process.env.NAVA_WORK_DIR ?? '.private/nava-agent/work',owner,String(i)); await mkdir(workdir,{recursive:true,mode:0o700});
  const worker=client.beta.environments.work.worker({environmentId,environmentKey:process.env.ANTHROPIC_ENVIRONMENT_KEY,workdir,memorySyncIntervalMs:null,workerId:`${owner}:${i}`,tools:ctx=>registry(ctx.session?.id ?? ctx.sessionId ?? '')});
  await worker.run();
}));
