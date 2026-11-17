import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { authenticate, hasMailbox, type Principal } from './auth.js';
import { editInput, editProposal } from './edit.js';
import { ZodError } from 'zod';
import { event, sql } from './db.js';
import { authReady, verifiedAuth, importThread, model, snapshot, startPending, deliverPending } from './runtime.js';
import { threadInput } from './schema.js';

if (!process.env.DATABASE_URL || !process.env.NAVA_API_TOKEN) throw new Error('DATABASE_URL and NAVA_API_TOKEN required');
const app=new Hono<{Variables:{principal:Principal}}>().basePath('/api/nava/v1');
app.use('*',async(c,next)=>{
  const principal=authenticate(c.req.header('Authorization'));
  if(!principal) return c.json({error:{code:'UNAUTHORIZED',message:'Authentication required',details:null}},401);
  c.set('principal',principal);
  await next();
});
async function authorizedThread(id:string,principal:Principal) {
  const [thread]=await sql`SELECT mailbox_id FROM nava_agent.mail_thread WHERE id=${id}`;
  return !!thread && hasMailbox(principal,thread.mailbox_id);
}
app.get('/capabilities',async c=>c.json({workflows:['quote'],tools:['skill_read','mail_read_thread','hms_quote','proposal_publish','reply_draft'],model,environment_type:'self_hosted',auth_ready:await verifiedAuth(),auth_configured:await authReady(),configured_hms_slots:Number(process.env.NAVA_HMS_SLOTS ?? 10),native_read_slot_cap:Number(process.env.HMS_CREDENTIAL_SESSION_CAP ?? 8),effective_hms_slots:'not measured; bounded by shared native credential admission',staff_go:false,staff_edit:!!process.env.NAVA_STAFF_JWT_SECRET}));
app.post('/threads',async c=>{
  if (!c.req.header('Idempotency-Key')) return c.json({error:{code:'IDEMPOTENCY_REQUIRED',message:'Idempotency-Key required',details:null}},400);
  const parsed=threadInput.safeParse(await c.req.json().catch(()=>null));
  if (!parsed.success) return c.json({error:{code:'INVALID_INPUT',message:'Invalid thread',details:parsed.error.flatten()}},400);
  const principal=c.get('principal');
  if(!hasMailbox(principal,parsed.data.mailbox_id) || (principal.kind==='staff' && parsed.data.mode!=='live')) return c.json({error:{code:'FORBIDDEN',message:'Mailbox or mode unavailable',details:null}},403);
  try { const imported=await importThread(parsed.data,c.req.header('Idempotency-Key')!); const current=await snapshot(imported.id); if(current?.session) void startPending(current.session.id).catch(()=>{}); return c.json(current,imported.created?201:200); }
  catch (error) { const message=error instanceof Error ? error.message : 'IMPORT_FAILED'; return c.json({error:{code:['THREAD_MODE_CONFLICT','IDEMPOTENCY_CONFLICT','MESSAGE_CONFLICT','HISTORICAL_CONTEXT_CONFLICT'].includes(message)?message:'IMPORT_UNAVAILABLE',message:['THREAD_MODE_CONFLICT','IDEMPOTENCY_CONFLICT','MESSAGE_CONFLICT','HISTORICAL_CONTEXT_CONFLICT'].includes(message)?message:'Unable to import thread',details:null}},['THREAD_MODE_CONFLICT','IDEMPOTENCY_CONFLICT','MESSAGE_CONFLICT','HISTORICAL_CONTEXT_CONFLICT'].includes(message)?409:503); }
});
app.get('/threads/:id',async c=>{if(!await authorizedThread(c.req.param('id'),c.get('principal'))) return c.json({error:{code:'NOT_FOUND',message:'Thread not found',details:null}},404);const result=await snapshot(c.req.param('id')); return result?c.json(result):c.json({error:{code:'NOT_FOUND',message:'Thread not found',details:null}},404);});
app.get('/threads/:id/events',async c=>{
  if(!await authorizedThread(c.req.param('id'),c.get('principal'))) return c.json({error:{code:'NOT_FOUND',message:'Thread not found',details:null}},404);
  const thread=await snapshot(c.req.param('id')); if (!thread || !thread.session) return c.json({error:{code:'NOT_FOUND',message:'Thread not found',details:null}},404);
  const start=Number(c.req.query('after_sequence') ?? 0); if (!Number.isSafeInteger(start) || start<0) return c.json({error:{code:'INVALID_CURSOR',message:'Invalid sequence',details:null}},400);
  const session=thread.session.id;
  return streamSSE(c,async stream=>{let after=start; while(!stream.aborted) {const rows=await sql`SELECT sequence::text,id,managed_event_id,kind,payload,at FROM nava_agent.agent_event WHERE session_id=${session} AND sequence>${after} ORDER BY sequence LIMIT 200`; for(const row of rows){after=Number(row.sequence); await stream.writeSSE({id:String(after),event:'event',data:JSON.stringify({sequence:after,event_id:row.managed_event_id ?? row.id,kind:row.kind,at:row.at,session_id:session,proposal_id:row.payload?.proposal_id ?? null,payload:row.payload})});} if(!rows.length) await stream.sleep(1000); }});
});
app.post('/threads/:id/messages',async c=>{
  if(!await authorizedThread(c.req.param('id'),c.get('principal'))) return c.json({error:{code:'NOT_FOUND',message:'Thread not found',details:null}},404);
  const body=await c.req.json().catch(()=>null); if(!body || typeof body.text!=='string' || !body.text.trim()) return c.json({error:{code:'INVALID_INPUT',message:'text required',details:null}},400);
  if(body.proposal_id!==undefined && typeof body.proposal_id!=='string') return c.json({error:{code:'INVALID_INPUT',message:'Invalid proposal_id',details:null}},400);
  const [s]=await sql`SELECT * FROM nava_agent.agent_session WHERE thread_id=${c.req.param('id')}`; if(!s) return c.json({error:{code:'NOT_FOUND',message:'Session not found',details:null}},404);
  if(body.proposal_id) {const [p]=await sql`SELECT id FROM nava_agent.proposal WHERE id=${body.proposal_id} AND session_id=${s.id}`; if(!p) return c.json({error:{code:'NOT_FOUND',message:'Proposal not found',details:null}},404);}
  const principal=c.get('principal');
  await event(s.id,'context_pending',{text:body.text,proposal_id:body.proposal_id ?? null,who:principal.kind==='staff'?principal.id:null,delivered:false});
  void (s.managed_session_id?deliverPending(s.id):startPending(s.id)).catch(()=>{}); return c.json({accepted:true},202);
});
for (const route of ['/proposals/:id/undo','/proposals/:id/redo','/proposals/:id/stage','/proposals/:id/go','/proposals/:id/reconcile']) app.post(route,c=>c.json({error:{code:'UNAVAILABLE',message:'This operation is not supported.',details:null}},501));
app.patch('/proposals/:id',async c=>{
  const principal=c.get('principal');
  if(principal.kind!=='staff') return c.json({error:{code:'STAFF_IDENTITY_REQUIRED',message:'Signed staff identity required',details:null}},403);
  const input=editInput.safeParse(await c.req.json().catch(()=>null));
  if(!input.success) return c.json({error:{code:'INVALID_INPUT',message:'Invalid edit',details:input.error.flatten()}},400);
  try { return c.json(await editProposal(c.req.param('id'),principal.mailboxes,principal.id,input.data)); }
  catch(error) {
    const code=error instanceof Error?error.message:'EDIT_FAILED';
    if(code==='NOT_FOUND') return c.json({error:{code,message:'Proposal not found',details:null}},404);
    if(code==='STALE_REVISION'||code==='NOT_EDITABLE') return c.json({error:{code,message:'Proposal revision or phase changed',details:null}},409);
    if(error instanceof ZodError) return c.json({error:{code:'INVALID_INPUT',message:'Invalid field value',details:null}},400);
    if(code==='INVALID_PATH') return c.json({error:{code,message:'Field is not editable',details:null}},400);
    return c.json({error:{code:'EDIT_FAILED',message:'Edit could not be saved',details:null}},503);
  }
});
app.get('/threads/:id/staff-edits',async c=>{
  if(!await authorizedThread(c.req.param('id'),c.get('principal'))) return c.json({error:{code:'NOT_FOUND',message:'Thread not found',details:null}},404);
  const proposals=await sql`SELECT id,session_id,workflow,original,created_at FROM nava_agent.proposal WHERE thread_id=${c.req.param('id')} ORDER BY created_at,id`;
  const records:unknown[]=[];
  for(const p of proposals) {
    records.push({event_id:`proposal:${p.id}:original`,kind:'proposal',session_id:p.session_id,proposal_id:p.id,workflow:p.workflow,at:p.created_at,sequence:0,fields:{bookings:p.original.bookings,actions:p.original.actions}});
    const edits=await sql`SELECT * FROM nava_agent.staff_edit WHERE proposal_id=${p.id} ORDER BY sequence`;
    for(const e of edits) records.push({event_id:e.id,kind:e.kind,session_id:e.session_id,proposal_id:e.proposal_id,workflow:e.workflow,at:e.at,sequence:Number(e.sequence),field:e.path,before:e.before,after:e.after,before_present:e.before_present,after_present:e.after_present,who:e.who});
  }
  return c.body(records.map(record=>JSON.stringify(record)).join('\n')+(records.length?'\n':''),200,{'Content-Type':'application/x-ndjson'});
});
serve({fetch:app.fetch,hostname:process.env.NAVA_HOST ?? '127.0.0.1',port:Number(process.env.NAVA_PORT ?? 3107)});
