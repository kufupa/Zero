import Anthropic from '@anthropic-ai/sdk';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { sql, uid, json, event } from './db.js';
import { proposalDraft, tools, type ThreadInput } from './schema.js';
import { withCreateNativeFields } from './proposal-fields.js';
import { quoteDisplayRows } from './display.js';
import { mailPrefilterRule } from './mail-ingest.js';
import { describePrepareRejection, prepareRejection } from './prepare-feedback.js';
import { attachmentCheckPath, attachmentsUnconfirmed } from './attachment-gate.js';

export type RuntimeProvider = 'bedrock' | 'cma';
export function runtimeProvider(): RuntimeProvider {
  const value = process.env.NAVA_AGENT_RUNTIME ?? 'bedrock';
  if (value !== 'bedrock' && value !== 'cma') throw new Error('NAVA_AGENT_RUNTIME_INVALID');
  return value;
}
export function cmaServerConfigured():boolean {
  const url=process.env.ANTHROPIC_BASE_URL;
  if(!url) return false;
  try { const parsed=new URL(url);return ['http:','https:'].includes(parsed.protocol) && parsed.hostname!=='anthropic.com' && !parsed.hostname.endsWith('.anthropic.com'); } catch { return false; }
}
export const model = runtimeProvider() === 'bedrock' ? 'global.anthropic.claude-haiku-5-5' : 'claude-haiku-5-5';
export const environmentId = process.env.ANTHROPIC_ENVIRONMENT_ID;
export const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY ?? 'not-configured'});
export async function skillSnapshot() {
  const root=resolve(process.env.NAVA_SKILLS_DIR ?? fileURLToPath(new URL('../skills/',import.meta.url)));
  const entries:Record<string,string>={};
  async function readTree(dir:string, prefix:string) {
    for (const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path=join(dir,entry.name), name=join(prefix,entry.name);
      if (entry.isDirectory()) await readTree(path,name);
      else if (entry.isFile() && entry.name.endsWith('.md')) entries[name]=await readFile(path,'utf8');
    }
  }
  await readTree(join(root,'quote'),'quote');
  await readTree(join(root,'references'),'references');
  for (const name of ['quote/SKILL.md','quote/references/rules.md','quote/references/replies.md','references/common.md','references/tools-and-proposal.md']) if (!entries[name]) throw new Error('SKILL_TREE_INCOMPLETE');
  return {files:entries,sha256:createHash('sha256').update(JSON.stringify(entries)).digest('hex')};
}
export async function authReady() {
  if (runtimeProvider() === 'bedrock') return (process.env.AWS_REGION ?? 'eu-west-1') === 'eu-west-1';
  if (!cmaServerConfigured() || !process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_ENVIRONMENT_KEY || !environmentId) return false;
  try { await skillSnapshot(); return true; } catch { return false; }
}
let authCheck: {until:number; ready:boolean}|undefined;
export async function verifiedAuth() {
  // Credential availability alone is not an authenticated Bedrock request.
  if (runtimeProvider() === 'bedrock') return false;
  if (!await authReady() || !environmentId || !process.env.ANTHROPIC_ENVIRONMENT_KEY) return false;
  if (authCheck && authCheck.until>Date.now()) return authCheck.ready;
  let ready=false;
  try {
    const workerClient=client.withOptions({apiKey:null,authToken:process.env.ANTHROPIC_ENVIRONMENT_KEY});
    const [environment]=await Promise.all([
      client.beta.environments.retrieve(environmentId,{}, {timeout:5000,maxRetries:0}),
      workerClient.beta.environments.work.stats(environmentId,{}, {timeout:5000,maxRetries:0}),
    ]);
    ready=environment.config.type==='self_hosted' && environment.archived_at===null;
  } catch { /* unavailable, unauthorized, or not yet verified */ }
  authCheck={until:Date.now()+30000,ready};
  return ready;
}
const content = (text:string) => [{type:'text' as const,text}];
type ImportOptions = {manualCreateLabtest:{arrival_date:string;departure_date:string}};
function canonicalJson(value:unknown):string {
  return JSON.stringify(value,(_key,item:unknown)=>item && typeof item==='object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)) : item);
}
export async function importThread(input:ThreadInput, key:string, sourceInput?:unknown, options?:ImportOptions) {
  const prepareLive=process.env.NAVA_CREATE_PREPARE_ONLY==='1' && input.mode==='live';
  const payload={input,sourceInput:sourceInput ?? null,...(options ? {options} : {})};
  const requestHash=createHash('sha256').update(prepareLive?canonicalJson(payload):JSON.stringify(payload)).digest('hex');
  const selectionKey=prepareLive?`prepare:${requestHash}`:'';
  const keyHash=createHash('sha256').update(prepareLive?canonicalJson(['prepare',input.source,input.mailbox_id,input.source_thread_id,requestHash]):key).digest('hex');
  const selected = input.messages.find(message => message.id === input.selected_message_id);
  const ruleId = selected ? mailPrefilterRule(selected) : null;
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${keyHash},0))`;
    const [prior]=await tx`SELECT COALESCE(e.thread_id,s.thread_id) AS thread_id,e.kind,e.payload FROM nava_agent.agent_event e LEFT JOIN nava_agent.agent_session s ON s.id=e.session_id WHERE e.kind IN ('import','mail_skipped') AND e.payload->>'key_hash'=${keyHash}`;
    if (prior) { if(prior.payload.request_hash!==requestHash) throw new Error('IDEMPOTENCY_CONFLICT'); return {id:prior.thread_id as string,created:false,skipped:prior.kind==='mail_skipped'}; }
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.source}:${input.mailbox_id}:${input.source_thread_id}`},0))`;
    const [before]=await tx`SELECT selected_message_id FROM nava_agent.mail_thread WHERE source=${input.source} AND mailbox_id=${input.mailbox_id} AND source_thread_id=${input.source_thread_id} AND selection_key=${selectionKey}`;
    const threadId=uid('thread');
    const [thread]=await tx`INSERT INTO nava_agent.mail_thread (id,source,mailbox_id,source_thread_id,selected_message_id,property_code,mode,selection_key)
      VALUES (${threadId},${input.source},${input.mailbox_id},${input.source_thread_id},${input.selected_message_id},${input.property_code},${input.mode},${selectionKey})
      ON CONFLICT (source,mailbox_id,source_thread_id,selection_key) DO UPDATE SET
        selected_message_id=CASE WHEN ${ruleId !== null} THEN mail_thread.selected_message_id ELSE EXCLUDED.selected_message_id END,
        property_code=CASE WHEN ${ruleId !== null} THEN mail_thread.property_code ELSE EXCLUDED.property_code END,
        updated_at=now()
      RETURNING *`;
    if (thread.mode !== input.mode) throw new Error('THREAD_MODE_CONFLICT');
    let messagesNew=false;
    for (const message of input.messages) {
      const rows=await tx`INSERT INTO nava_agent.mail_message (id,thread_id,source_message_id,payload,received_at) VALUES (${uid('msg')},${thread.id},${message.id},${json(message)},${message.received_at}) ON CONFLICT(thread_id,source_message_id) DO NOTHING RETURNING id`;
      if (!rows.length) { const [existing]=await tx`SELECT payload=${json(message)}::jsonb AS equal FROM nava_agent.mail_message WHERE thread_id=${thread.id} AND source_message_id=${message.id}`; if (!existing.equal) throw new Error('MESSAGE_CONFLICT'); }
      if (rows.length) messagesNew=true;
    }
    if (ruleId) {
      await tx`INSERT INTO nava_agent.agent_event(id,thread_id,kind,payload) VALUES (${uid('evt')},${thread.id},'mail_skipped',${json({rule_id:ruleId,message_id:input.selected_message_id,key_hash:keyHash,request_hash:requestHash})})`;
      return {id:thread.id as string,created:!before,skipped:true};
    }
    let [session]=await tx`SELECT * FROM nava_agent.agent_session WHERE thread_id=${thread.id}`;
    const createSession = !session;
    if (session && input.mode==='historical' && (session.config?.input_cutoff !== (input.input_cutoff ?? null) || session.config?.decision_id !== (input.decision_id ?? null))) throw new Error('HISTORICAL_CONTEXT_CONFLICT');
    if (options && (input.mode!=='labtest' || session || before)) throw new Error('LABTEST_SEED_CONFLICT');
    if (!session) [session]=await tx`INSERT INTO nava_agent.agent_session(id,thread_id,status,mode,config) VALUES (${uid('session')},${thread.id},'pending',${input.mode},${json({decision_id:input.decision_id ?? null,input_cutoff:input.input_cutoff ?? null,...(options ? {manual_create_labtest:options.manualCreateLabtest} : {})})}) RETURNING *`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:events:'+session.id},0))`;
    await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${session.id},'import',${json({key_hash:keyHash,request_hash:requestHash})})`;
    if(sourceInput !== undefined) await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${session.id},'train_source',${json(sourceInput)})`;
    if(createSession || messagesNew || (before && before.selected_message_id!==input.selected_message_id)) await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${session.id},'mail_pending',${json({message_id:input.selected_message_id,delivered:false})})`;
    return {id:thread.id as string,created:!before,skipped:false};
  });
}
export async function startPending(sessionId:string) {
  // Bedrock workers consume the durable mail_pending/context_pending events.
  if (runtimeProvider() === 'bedrock') return;
  if (!await authReady()) return;
  await sql.begin(async tx=>{
    const [session]=await tx`SELECT * FROM nava_agent.agent_session WHERE id=${sessionId} FOR UPDATE`;
    if (!session || session.managed_session_id) return;
    const skill=await skillSnapshot();
    const system='Use only registered custom tools. Read the thread and call skill_read for quote/SKILL.md and each linked reference before quote work. Other workflows and unregistered tools are unavailable. Never invent prices or send mail. Publish a proposal even when information is missing. For native_result pass null or the exact hms_quote result; the backend binds the actual capture.';
    const agent=await client.beta.agents.create({name:'nava-quote',model,system,tools});
    const created=await client.beta.sessions.create({agent:agent.id,environment_id:environmentId!});
    await tx`UPDATE nava_agent.agent_session SET managed_session_id=${created.id},agent_id=${agent.id},environment_id=${environmentId!},status='idle',config=config || ${json({skill_sha256:skill.sha256,skill_files:skill.files})}::jsonb,updated_at=now() WHERE id=${sessionId}`;
  });
  await deliverPending(sessionId);
}
export async function deliverPending(sessionId:string) {
  if (runtimeProvider() === 'bedrock') return;
  await sql.begin(async tx=>{
    const [session]=await tx`SELECT * FROM nava_agent.agent_session WHERE id=${sessionId} FOR UPDATE`;
    if (!session?.managed_session_id) return;
    const pending=await tx`SELECT id,kind,payload FROM nava_agent.agent_event WHERE session_id=${sessionId} AND kind IN ('mail_pending','context_pending') AND payload->>'delivered'='false' ORDER BY sequence`;
    for(const entry of pending) {
      const marker=`nava-mail-event:${entry.id}`;
      let found=false;
      for await(const item of client.beta.sessions.events.list(session.managed_session_id,{order:'asc'})) {
        if(item.type==='user.message' && item.content.some(block=>block.type==='text' && block.text.includes(marker))) { found=true; break; }
      }
      if (!found) {
        const text=entry.kind==='mail_pending' ? 'Read the selected thread and handle its request.' : `Staff context: ${entry.payload.text}`;
        await client.beta.sessions.events.send(session.managed_session_id,{events:[{type:'user.message',content:content(`${marker} ${text}`)}]});
      }
      await tx`UPDATE nava_agent.agent_event SET payload=jsonb_set(payload,'{delivered}','true'::jsonb) WHERE id=${entry.id}`;
    }
  });
}
export async function snapshot(threadId:string) {
  return sql.begin('isolation level repeatable read read only',async tx=>{
    const [thread]=await tx`SELECT * FROM nava_agent.mail_thread WHERE id=${threadId}`;
    if (!thread) return null;
    const messages=await tx`SELECT payload FROM nava_agent.mail_message WHERE thread_id=${threadId} ORDER BY received_at,id`;
    const [session]=await tx`SELECT * FROM nava_agent.agent_session WHERE thread_id=${threadId}`;
    const proposals=await tx`SELECT p.*,(SELECT e.after = 'true'::jsonb FROM nava_agent.staff_edit e
      WHERE e.proposal_id=p.id AND e.revision=p.revision AND e.kind='edit' AND e.path=${attachmentCheckPath}
      ORDER BY e.sequence DESC LIMIT 1) AS staff_attachments_checked
      FROM nava_agent.proposal p WHERE p.thread_id=${threadId} ORDER BY p.created_at`;
    const [sequence]=session ? await tx`SELECT COALESCE(max(sequence),0)::text AS n FROM nava_agent.agent_event WHERE session_id=${session.id}` : [{n:'0'}];
    const sourceMessageId=thread.selection_key.startsWith('prepare:') ? thread.selected_message_id : null;
    return {id:thread.id,selected_message_id:thread.selected_message_id,messages:messages.map(m=>m.payload),session:session ? {id:session.id,managed_session_id:session.managed_session_id,status:session.status,mode:session.mode,error:session.config?.error ?? null} : null,proposals:proposals.map(proposal=>proposalWire(proposal,sourceMessageId)),event_sequence:Number(sequence.n)};
  });
}
export function proposalWire(p:Record<string,any>,sourceMessageId:string|null=null) {
  const draft=p.phase==='ready' && p.workflow==='create' ? proposalDraft.safeParse(p.current) : null;
  const current=draft?.success ? withCreateNativeFields(draft.data) : p.current;
  const stage=p.stage && p.stage.state!=='queued' && p.stage.revision===p.revision ? {
    revision:p.stage.revision,summary:Array.isArray(p.stage.summary)?p.stage.summary:[],native_result:p.stage.native_result??null,
    display_rows:Array.isArray(p.stage.display_rows)?p.stage.display_rows:[],
    ...Object.fromEntries(['job_id','quote_id','observed_fields','coverage','cancellation_fee','artifacts']
      .filter(key=>p.stage[key]!==undefined).map(key=>[key,p.stage[key]])),
  } : null;
  const result=p.phase==='done' && p.result ? {
    confirmation:typeof p.result.confirmation==='string'?p.result.confirmation:null,
    reservation_id:typeof p.result.reservation_id==='string'?p.result.reservation_id:null,
    readback:p.result.readback??null,display_rows:Array.isArray(p.result.display_rows)?p.result.display_rows:[],
    artifacts:Array.isArray(p.result.artifacts)?p.result.artifacts:[],
  } : null;
  const rawError=p.execution?.error ?? p.execution?.go?.completion?.toolResult?.error;
  const uncertain=p.phase==='uncertain' || rawError?.outcome==='uncertain';
  const attachmentsBlocked=!uncertain && rawError?.code===attachmentsUnconfirmed.code;
  const staffStageError=!uncertain && rawError?.operation==='staff_stage';
  const prepare=p.workflow==='create' && !uncertain && p.phase!=='error' ? prepareRejection.safeParse(p.execution?.error?.prepare) : null;
  const error=rawError || uncertain ? {
    code:typeof rawError?.code==='string' && /^[A-Z_0-9]+$/.test(rawError.code)?rawError.code:'HMS_OPERATION_FAILED',
    outcome:uncertain?'uncertain':'known',
    message:attachmentsBlocked?attachmentsUnconfirmed.message:uncertain?'HMS Save outcome is unconfirmed.':staffStageError && typeof rawError.message==='string'?rawError.message:
      p.phase==='error'?'HMS Save did not complete.':prepare?.success?describePrepareRejection(prepare.data):'HMS Prepare did not complete.',
    recovery:attachmentsBlocked?attachmentsUnconfirmed.message:uncertain?'Check HMS before attempting another Save.':staffStageError && typeof rawError.recovery==='string'?rawError.recovery:
      p.phase==='error'?'Review the booking and verify HMS before trying again.':'Review the booking fields and run Prepare again.',
    ...(prepare?.success ? { prepare:prepare.data } : {}),
  } : null;
  return {...current,id:p.id,thread_id:p.thread_id,session_id:p.session_id,source_message_id:sourceMessageId,staff_attachments_checked:p.staff_attachments_checked===true,revision:p.revision,phase:p.phase,display_rows:Array.isArray(p.current?.native_result?.display_rows)?p.current.native_result.display_rows:quoteDisplayRows(p.current?.native_result),created_at:p.created_at,updated_at:p.updated_at,stage,result,error};
}
export async function mirrorEvent(sessionId:string, value:unknown) {
  if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string' || !('type' in value) || typeof value.type !== 'string') return;
  await event(sessionId,value.type,value,value.id);
  if (value.type === 'session.status_idle' || value.type === 'session.status_running' || value.type === 'session.status_terminated' || value.type === 'session.error')
    await sql`UPDATE nava_agent.agent_session SET status=${value.type},updated_at=now() WHERE id=${sessionId}`;
}
