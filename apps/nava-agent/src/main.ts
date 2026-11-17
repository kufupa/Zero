import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { authenticate, hasMailbox, type Principal } from './auth.js';
import { editInput, editProposal } from './edit.js';
import { z, ZodError } from 'zod';
import { event, sql } from './db.js';
import { authReady, verifiedAuth, importThread, model, snapshot, startPending, deliverPending } from './runtime.js';
import { goInput, groupedQuoteRequest, proposalDraft, requoteInput, revisionInput, threadInput, type Workflow } from './schema.js';
import { createPilotOperations, manualLabtestTarget } from './create-operations.js';
import { hmsSaveEnabled } from './hms-mode.js';
import { attachmentsUnconfirmed, verifyAttachmentImport } from './attachment-gate.js';

type Operation = 'stage'|'go'|'reconcile'|'quote';
type OperationFailure = 'NOT_FOUND'|'FORBIDDEN'|'INVALID_INPUT'|'STALE_REVISION'|'NOT_EDITABLE'|'INVALID_PHASE'|'IDEMPOTENCY_CONFLICT'|'UNAVAILABLE'|typeof attachmentsUnconfirmed.code;
type OperationRequest = {proposalId:string;expectedRevision:number;actor:string;mailboxId:string;workflow:Workflow;mode:'live'|'labtest';operation:Operation;idempotencyKey:string|null;quoteId:string|null};

// Called with session then proposal locked, matching core-db lock order. Only enqueue/claim durable work in this
// transaction; a separate claimGo transaction would deadlock on the same row.
// Never perform native I/O here. Go must pin the revision and
// staff-final audit, enforce idempotency and pending Save, and use the native
// Labtest checks and durable dispatch marker before any later Save.
export interface ProposalOperations {
  capabilities: Partial<Record<Workflow, {stage:boolean;go_labtest:boolean;reconcile:boolean;quote?:boolean}>>;
  submit(tx:postgres.TransactionSql, request:OperationRequest):Promise<
    {ok:true;phase:'staging'|'saving'|'uncertain';jobId?:string} |
    {ok:false;code:OperationFailure}
  >;
}
class OperationError extends Error {
  constructor(readonly code:OperationFailure|'REAL_GUEST_GO_UNAVAILABLE'|'HISTORICAL_UNAVAILABLE') { super(code); }
}
const workflows:Workflow[]=['triage','quote','create','amend','cancel','filing'];
const labtestSource = z.object({source: z.enum(['outlook','webmail','corpus','eval']), mailbox_id: z.string().min(1), source_thread_id: z.string().min(1), selected_message_id: z.string().min(1)});
const labtestSeed = z.object({thread:threadInput, target:manualLabtestTarget}).strict();
export function createApp(operations:ProposalOperations|undefined=createPilotOperations()) {
const app=new Hono<{Variables:{principal:Principal}}>().basePath('/api/nava/v1');
app.use('*',async(c,next)=>{
  const principal=authenticate(c.req.header('Authorization'));
  if(!principal) return c.json({error:{code:'UNAUTHORIZED',message:'Authentication required',details:null}},401);
  c.set('principal',principal);
  await next();
});
async function threadDenial(id:string,principal:Principal):Promise<403|404|null> {
  const [thread]=await sql`SELECT mailbox_id FROM nava_agent.mail_thread WHERE id=${id}`;
  return !thread?404:hasMailbox(principal,thread.mailbox_id)?null:403;
}
const threadError=(status:403|404)=>({error:{code:status===403?'FORBIDDEN':'NOT_FOUND',message:status===403?'Mailbox unavailable':'Thread not found',details:null}});
app.get('/capabilities',async c=>{
  const staff=!!process.env.NAVA_STAFF_JWT_SECRET;
  const workflow_capabilities=Object.fromEntries(workflows.map(workflow=>{
    const supported=operations?.capabilities[workflow];
    const labtestSave=staff && hmsSaveEnabled() && !!supported?.go_labtest;
    return [workflow,{edit:staff,stage:staff && !!supported?.stage,go:false,save:false,go_labtest:labtestSave,save_labtest:labtestSave,reconcile:staff && !!supported?.reconcile,quote:staff && workflow==='quote' && !!supported?.quote,undo:false,redo:false}];
  }));
  const create=!!operations?.capabilities.create?.stage;
  return c.json({workflows:create?['triage','create']:['quote'],tools:['skill_read','mail_read_thread','hms_quote','proposal_publish','reply_draft',...(create?['hms_prepare']:[]),...(hmsSaveEnabled() && operations?.capabilities.create?.go_labtest?['hms_save']:[])],model,environment_type:'self_hosted',auth_ready:create?c.get('principal').kind==='staff':await verifiedAuth(),auth_configured:await authReady(),configured_hms_slots:Number(process.env.NAVA_HMS_SLOTS ?? 10),native_read_slot_cap:Number(process.env.HMS_CREDENTIAL_SESSION_CAP ?? 8),effective_hms_slots:'not measured; bounded by shared native credential admission',staff_go:false,staff_edit:staff,workflow_capabilities,deployed_sha:process.env.NAVA_DEPLOYED_SHA ?? process.env.NAVA_DEPLOY_SHA ?? null});
});
async function findManualLabtest(source:z.infer<typeof labtestSource>) {
  if(!hmsSaveEnabled() || !operations?.capabilities.create?.go_labtest) return null;
  const [thread]=await sql`SELECT t.id FROM nava_agent.mail_thread t JOIN nava_agent.agent_session s ON s.thread_id=t.id
    WHERE t.source=${source.source} AND t.mailbox_id=${source.mailbox_id} AND t.source_thread_id=${source.source_thread_id}
    AND t.selected_message_id=${source.selected_message_id} AND t.mode='labtest' AND t.selection_key='' AND s.config ? 'manual_create_labtest'`;
  return thread ? snapshot(thread.id) : null;
}
app.get('/labtest/create',async c=>{
  const source=labtestSource.safeParse(c.req.query());
  const principal=c.get('principal');
  if(!source.success) return c.json({error:{code:'INVALID_INPUT',message:'Exact selected mail required',details:null}},400);
  if(!hasMailbox(principal,source.data.mailbox_id)) return c.json(threadError(403),403);
  const active=await findManualLabtest(source.data);
  return active?c.json(active):c.json({error:{code:'NOT_FOUND',message:'No manual Labtest for selected mail',details:null}},404);
});
app.post('/labtest/create/seed',async c=>{
  if(c.get('principal').kind!=='service') return c.json(threadError(403),403);
  if(!hmsSaveEnabled()) return c.json({error:{code:'SAVE_DISABLED',message:'Only unsaved Prepare is available.',details:null}},403);
  if(!operations?.capabilities.create?.go_labtest) return c.json({error:{code:'UNAVAILABLE',message:'Create pilot not enabled',details:null}},501);
  const input=labtestSeed.safeParse(await c.req.json().catch(()=>null)), key=c.req.header('Idempotency-Key');
  if(!input.success || !key || input.data.thread.messages.find(message=>message.id===input.data.thread.selected_message_id)?.direction!=='inbound') {
    return c.json({error:{code:'INVALID_INPUT',message:'Labtest target, exact inbound and idempotency key required',details:null}},400);
  }
  try {
    const seeded=await importThread({...input.data.thread,mode:'labtest',property_code:'HRCEN'},key,undefined,{manualCreateLabtest:input.data.target});
    if(seeded.skipped) return c.json({error:{code:'SKIPPED',message:'Selected email was filtered',details:null}},409);
    return c.json(await snapshot(seeded.id),seeded.created?201:200);
  } catch (error) {
    const conflict=error instanceof Error && ['LABTEST_SEED_CONFLICT','THREAD_MODE_CONFLICT','IDEMPOTENCY_CONFLICT','MESSAGE_CONFLICT'].includes(error.message);
    return c.json({error:{code:conflict?'LABTEST_SEED_CONFLICT':'IMPORT_UNAVAILABLE',message:'Could not seed manual Labtest',details:null}},conflict?409:503);
  }
});
app.post('/threads',async c=>{
  if (!c.req.header('Idempotency-Key')) return c.json({error:{code:'IDEMPOTENCY_REQUIRED',message:'Idempotency-Key required',details:null}},400);
  const raw=await c.req.text().catch(()=>'');
  let body:unknown=null;
  try { body=JSON.parse(raw); } catch { /* rejected by schema */ }
  const parsed=threadInput.safeParse(body);
  if (!parsed.success) return c.json({error:{code:'INVALID_INPUT',message:'Invalid thread',details:parsed.error.flatten()}},400);
  const principal=c.get('principal');
  if(!hasMailbox(principal,parsed.data.mailbox_id) || (principal.kind==='staff' && parsed.data.mode!=='live')) return c.json({error:{code:'FORBIDDEN',message:'Mailbox or mode unavailable',details:null}},403);
  const coverage=verifyAttachmentImport(raw,c.req.header('X-Nava-Attachment-Coverage'),process.env.NAVA_STAFF_JWT_SECRET);
  try { if(principal.kind==='staff') {const seeded=await findManualLabtest(parsed.data);if(seeded)return c.json(seeded,200);} const imported=await importThread(parsed.data,c.req.header('Idempotency-Key')!,undefined,undefined,coverage); const current=await snapshot(imported.id); if(process.env.NAVA_CREATE_PREPARE_ONLY==='1' && parsed.data.mode==='live' && current?.selected_message_id!==parsed.data.selected_message_id) throw new Error('IMPORT_SELECTION_MISMATCH'); if(!imported.skipped && current?.session) void startPending(current.session.id).catch(()=>{}); return c.json(current,imported.created?201:200); }
  catch (error) { const message=error instanceof Error ? error.message : 'IMPORT_FAILED'; return c.json({error:{code:['THREAD_MODE_CONFLICT','IDEMPOTENCY_CONFLICT','MESSAGE_CONFLICT','HISTORICAL_CONTEXT_CONFLICT'].includes(message)?message:'IMPORT_UNAVAILABLE',message:['THREAD_MODE_CONFLICT','IDEMPOTENCY_CONFLICT','MESSAGE_CONFLICT','HISTORICAL_CONTEXT_CONFLICT'].includes(message)?message:'Unable to import thread',details:null}},['THREAD_MODE_CONFLICT','IDEMPOTENCY_CONFLICT','MESSAGE_CONFLICT','HISTORICAL_CONTEXT_CONFLICT'].includes(message)?409:503); }
});
app.get('/threads/:id',async c=>{const denied=await threadDenial(c.req.param('id'),c.get('principal'));if(denied) return c.json(threadError(denied),denied);const result=await snapshot(c.req.param('id')); return result?c.json(result):c.json({error:{code:'NOT_FOUND',message:'Thread not found',details:null}},404);});
app.get('/threads/:id/events',async c=>{
  const denied=await threadDenial(c.req.param('id'),c.get('principal'));if(denied) return c.json(threadError(denied),denied);
  const thread=await snapshot(c.req.param('id')); if (!thread || !thread.session) return c.json({error:{code:'NOT_FOUND',message:'Thread not found',details:null}},404);
  const requested=Number(c.req.query('after_sequence') ?? 0), lastEvent=Number(c.req.header('Last-Event-ID') ?? 0);
  if (![requested,lastEvent].every(value=>Number.isSafeInteger(value) && value>=0)) return c.json({error:{code:'INVALID_CURSOR',message:'Invalid sequence',details:null}},400);
  const start=Math.max(requested,lastEvent);
  const session=thread.session.id;
  return streamSSE(c,async stream=>{let after=start; while(!stream.aborted) {const rows=await sql`SELECT sequence::text,id,managed_event_id,kind,payload,at FROM nava_agent.agent_event WHERE session_id=${session} AND sequence>${after} ORDER BY sequence LIMIT 200`; for(const row of rows){after=Number(row.sequence); await stream.writeSSE({id:String(after),event:'event',data:JSON.stringify({sequence:after,event_id:row.managed_event_id ?? row.id,kind:row.kind,at:row.at,session_id:session,proposal_id:row.payload?.proposal_id ?? null,payload:row.payload})});} if(!rows.length) await stream.sleep(1000); }});
});
app.post('/threads/:id/messages',async c=>{
  const denied=await threadDenial(c.req.param('id'),c.get('principal'));if(denied) return c.json(threadError(denied),denied);
  const body=await c.req.json().catch(()=>null); if(!body || typeof body.text!=='string' || !body.text.trim()) return c.json({error:{code:'INVALID_INPUT',message:'text required',details:null}},400);
  if(body.proposal_id!==undefined && typeof body.proposal_id!=='string') return c.json({error:{code:'INVALID_INPUT',message:'Invalid proposal_id',details:null}},400);
  const [s]=await sql`SELECT * FROM nava_agent.agent_session WHERE thread_id=${c.req.param('id')}`; if(!s) return c.json({error:{code:'NOT_FOUND',message:'Session not found',details:null}},404);
  if(body.proposal_id) {const [p]=await sql`SELECT id FROM nava_agent.proposal WHERE id=${body.proposal_id} AND session_id=${s.id}`; if(!p) return c.json({error:{code:'NOT_FOUND',message:'Proposal not found',details:null}},404);}
  const principal=c.get('principal');
  await event(s.id,'context_pending',{text:body.text,proposal_id:body.proposal_id ?? null,who:principal.kind==='staff'?principal.id:null,delivered:false});
  void (s.managed_session_id?deliverPending(s.id):startPending(s.id)).catch(()=>{}); return c.json({accepted:true},202);
});
for (const operation of ['stage','go','reconcile','undo','redo','quote'] as const) app.post(`/proposals/:id/${operation}`,async c=>{
  const principal=c.get('principal');
  if(principal.kind!=='staff') return c.json({error:{code:'STAFF_IDENTITY_REQUIRED',message:'Signed staff identity required',details:null}},403);
  if(operation==='go' && !hmsSaveEnabled()) return c.json({error:{code:'SAVE_DISABLED',message:'Only unsaved Prepare is available.',details:null}},403);
  const input=(operation==='go'?goInput:operation==='quote'?requoteInput:revisionInput).safeParse(await c.req.json().catch(()=>null));
  if(!input.success) return c.json({error:{code:'INVALID_INPUT',message:'Invalid operation input',details:input.error.flatten()}},400);
  try {
    const result=await sql.begin(async tx=>{
      const [ref]=await tx`SELECT p.session_id,t.mailbox_id FROM nava_agent.proposal p JOIN nava_agent.mail_thread t ON t.id=p.thread_id WHERE p.id=${c.req.param('id')}`;
      if(!ref) throw new OperationError('NOT_FOUND');
      if(!principal.mailboxes.includes(ref.mailbox_id)) throw new OperationError('FORBIDDEN');
      const [session]=await tx`SELECT id FROM nava_agent.agent_session WHERE id=${ref.session_id} FOR NO KEY UPDATE`;
      if(!session) throw new OperationError('NOT_FOUND');
      const [p]=await tx`SELECT p.id,p.revision,p.workflow,p.phase,p.current,t.mailbox_id,t.mode,t.selection_key FROM nava_agent.proposal p JOIN nava_agent.mail_thread t ON t.id=p.thread_id WHERE p.id=${c.req.param('id')} AND p.session_id=${ref.session_id} FOR UPDATE OF p`;
      if(!p) throw new OperationError('NOT_FOUND');
      if(!principal.mailboxes.includes(p.mailbox_id)) throw new OperationError('FORBIDDEN');
      if(p.revision!==input.data.expected_revision) throw new OperationError('STALE_REVISION');
      if(operation==='undo' || operation==='redo') throw new OperationError('UNAVAILABLE');
      if(p.mode==='historical') throw new OperationError('HISTORICAL_UNAVAILABLE');
      if(p.mode!=='live' && p.mode!=='labtest') throw new OperationError('UNAVAILABLE');
      if(operation==='stage' && process.env.NAVA_CREATE_PREPARE_ONLY==='1' && p.mode==='live' && !p.selection_key.startsWith('prepare:')) throw new OperationError('UNAVAILABLE');
      if(operation==='go' && p.mode==='live') throw new OperationError('REAL_GUEST_GO_UNAVAILABLE');
      const workflow=proposalDraft.shape.workflow.safeParse(p.workflow);
      if(!workflow.success) throw new OperationError('UNAVAILABLE');
      const capability=operations?.capabilities[workflow.data];
      if(!operations || !(operation==='go'?capability?.go_labtest:capability?.[operation])) throw new OperationError('UNAVAILABLE');
      if((operation==='stage' && p.phase!=='ready' && p.phase!=='waiting_go') ||
         (operation==='go' && p.phase!=='waiting_go' && p.phase!=='saving') ||
         (operation==='quote' && p.phase!=='ready' && p.phase!=='staging') ||
         (operation==='reconcile' && p.phase!=='uncertain')) throw new OperationError('INVALID_PHASE');
      const idempotencyKey='idempotency_key' in input.data && typeof input.data.idempotency_key==='string'?input.data.idempotency_key:null;
      const quoteId='quote_id' in input.data && typeof input.data.quote_id==='string'?input.data.quote_id:null;
      if(operation==='quote') {
        const draft=proposalDraft.safeParse(p.current);
        if(!draft.success || workflow.data!=='quote') throw new OperationError('NOT_FOUND');
        const action=draft.data.actions.find(item=>item.type==='quote' && typeof item.details==='object' && item.details!==null && !Array.isArray(item.details) && item.details.quote_id===quoteId);
        if(!action) throw new OperationError('NOT_FOUND');
        if(!groupedQuoteRequest.safeParse(action.details).success) throw new OperationError('INVALID_INPUT');
      }
      const accepted=await operations.submit(tx,{proposalId:p.id,expectedRevision:input.data.expected_revision,actor:principal.id,mailboxId:p.mailbox_id,workflow:workflow.data,mode:p.mode,operation,idempotencyKey,quoteId});
      if(!accepted.ok) throw new OperationError(accepted.code);
      const expectedPhase=operation==='stage'||operation==='quote'?'staging':operation==='go'?'saving':'uncertain';
      if(accepted.phase!==expectedPhase) throw new OperationError('UNAVAILABLE');
      if(operation==='quote' && (!accepted.jobId || !quoteId)) throw new OperationError('UNAVAILABLE');
      const [updated]=await tx`SELECT phase,revision FROM nava_agent.proposal WHERE id=${p.id}`;
      if(!updated || updated.phase!==expectedPhase || updated.revision!==input.data.expected_revision) throw new OperationError('UNAVAILABLE');
      return operation==='quote'?{job_id:accepted.jobId,proposal_id:p.id,revision:p.revision,quote_id:quoteId,phase:accepted.phase}:{proposal_id:p.id,revision:p.revision,phase:accepted.phase};
    });
    return c.json(result,202);
  } catch(error) {
    const code=error instanceof OperationError?error.code:'UNAVAILABLE';
    if(code==='NOT_FOUND') return c.json({error:{code,message:'Proposal not found',details:null}},404);
    if(code==='FORBIDDEN') return c.json({error:{code,message:'Mailbox unavailable',details:null}},403);
    if(code==='REAL_GUEST_GO_UNAVAILABLE') return c.json({error:{code,message:'Real guest Save is disabled in this pilot.',details:null}},403);
    if(code==='INVALID_INPUT') return c.json({error:{code,message:'Invalid quote fields',details:null}},400);
    if(code===attachmentsUnconfirmed.code) return c.json({error:{...attachmentsUnconfirmed,details:null}},409);
    if(code==='STALE_REVISION'||code==='NOT_EDITABLE'||code==='INVALID_PHASE'||code==='IDEMPOTENCY_CONFLICT') return c.json({error:{code,message:'Proposal revision or phase changed',details:null}},409);
    return c.json({error:{code,message:'This operation is not supported.',details:null}},501);
  }
});
app.patch('/proposals/:id',async c=>{
  const principal=c.get('principal');
  if(principal.kind!=='staff') return c.json({error:{code:'STAFF_IDENTITY_REQUIRED',message:'Signed staff identity required',details:null}},403);
  const input=editInput.safeParse(await c.req.json().catch(()=>null));
  if(!input.success) return c.json({error:{code:'INVALID_INPUT',message:'Invalid edit',details:input.error.flatten()}},400);
  try {
    const updated=await editProposal(c.req.param('id'),principal.mailboxes,principal.id,input.data);
    const [thread]=await sql`SELECT selected_message_id,selection_key FROM nava_agent.mail_thread WHERE id=${updated.thread_id}`;
    return c.json({...updated,source_message_id:thread?.selection_key.startsWith('prepare:')?thread.selected_message_id:null});
  }
  catch(error) {
    const code=error instanceof Error?error.message:'EDIT_FAILED';
    if(code==='NOT_FOUND') return c.json({error:{code,message:'Proposal not found',details:null}},404);
    if(code==='FORBIDDEN') return c.json({error:{code,message:'Mailbox unavailable',details:null}},403);
    if(code==='STALE_REVISION'||code==='NOT_EDITABLE') return c.json({error:{code,message:'Proposal revision or phase changed',details:null}},409);
    if(error instanceof ZodError) return c.json({error:{code:'INVALID_INPUT',message:'Invalid field value',details:null}},400);
    if(code==='INVALID_CHILD_AGES') return c.json({error:{code,message:'Enter an age from 0 to 17 for each child.',details:null}},400);
    if(code==='INVALID_PATH') return c.json({error:{code,message:'Field is not editable',details:null}},400);
    return c.json({error:{code:'EDIT_FAILED',message:'Edit could not be saved',details:null}},503);
  }
});
app.get('/threads/:id/staff-edits',async c=>{
  const denied=await threadDenial(c.req.param('id'),c.get('principal'));if(denied) return c.json(threadError(denied),denied);
  const proposals=await sql`SELECT id,session_id,workflow,original,created_at FROM nava_agent.proposal WHERE thread_id=${c.req.param('id')} ORDER BY created_at,id`;
  const records:unknown[]=[];
  for(const p of proposals) {
    records.push({event_id:`proposal:${p.id}:original`,kind:'proposal',session_id:p.session_id,proposal_id:p.id,workflow:p.workflow,at:p.created_at,sequence:0,fields:{bookings:p.original.bookings,actions:p.original.actions}});
    const edits=await sql`SELECT * FROM nava_agent.staff_edit WHERE proposal_id=${p.id} ORDER BY sequence`;
    for(const e of edits) records.push({event_id:e.id,kind:e.kind,session_id:e.session_id,proposal_id:e.proposal_id,workflow:e.workflow,at:e.at,sequence:Number(e.sequence),field:e.path,before:e.before,after:e.after,before_present:e.before_present,after_present:e.after_present,who:e.who});
  }
  return c.body(records.map(record=>JSON.stringify(record)).join('\n')+(records.length?'\n':''),200,{'Content-Type':'application/x-ndjson'});
});
return app;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL || !process.env.NAVA_API_TOKEN) throw new Error('DATABASE_URL and NAVA_API_TOKEN required');
  serve({fetch:createApp().fetch,hostname:process.env.NAVA_HOST ?? '127.0.0.1',port:Number(process.env.NAVA_PORT ?? 3107)});
}
