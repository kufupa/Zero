import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import type { ProposalOperations } from './main.js';
import { sql, json, uid } from './db.js';
import { claimGoInTransaction, writeEvent } from './session-store.js';
import { groupedQuoteRequest, proposalDraft, type ProposalDraft, type Workflow } from './schema.js';
import { createGoEnabled, createPilotRequested, hmsSaveEnabled, staffPrepareOnly } from './hms-mode.js';
import { missingCreateFields } from './proposal-fields.js';
import { stageFeedback } from './prepare-feedback.js';
import { attachmentsUnconfirmed, hasBoundCreateGuest, invalidGuestSelection, requiresStaffAttachmentCheck, selectedStageSource, stageSource, staffAttachmentsChecked } from './attachment-gate.js';
import { installedStaffTools, type LeaseFence, type RegistryContext, type StaffNativeInput, type ToolRegistry, type ToolResult } from './tool-registry.js';

export const manualLabtestTarget = z.object({
  arrival_date: z.string().date(), departure_date: z.string().date(),
}).strict().refine(target => target.arrival_date >= '2027-01-01' && target.departure_date > target.arrival_date);

export function createPilotEnabled() {
  const nativeCap=process.env.HMS_CREDENTIAL_SESSION_CAP ?? '';
  return createPilotRequested() && process.env.NAVA_QUOTE_SKELETON !== '1'
    && (process.env.NAVA_AGENT_RUNTIME ?? 'bedrock') === 'bedrock'
    && (staffPrepareOnly() ? /^[1-4]$/.test(nativeCap) && /^[1-4]$/.test(process.env.NAVA_HMS_SLOTS ?? '4') : nativeCap==='2')
    && !!process.env.HMS_CREDENTIAL_LEASE_DATABASE_URL;
}

function createInput(value: unknown) {
  const draft = proposalDraft.safeParse(value);
  if (!draft.success || draft.data.workflow !== 'create' || draft.data.disposition !== 'propose') return null;
  const { actions, bookings } = draft.data;
  if (actions.length !== 1 || bookings.length !== 1) return null;
  const [action] = actions, [booking] = bookings;
  if (action.type !== 'create' || action.booking_ids.length !== 1 || action.booking_ids[0] !== booking.id
      || booking.property_code !== 'HRCEN' || booking.reservation_id !== null) return null;
  return {workflow:'create', booking, action};
}

function isSeededLabtest(value: unknown, fields: Record<string, unknown>) {
  const target = manualLabtestTarget.safeParse(value);
  return target.success && fields.first_name === 'Proof' && fields.last_name === 'Labtest' && fields.cms_send === false
    && fields.arrival_date === target.data.arrival_date && fields.departure_date === target.data.departure_date;
}

const queuedStage = z.object({
  job_id:z.string(), revision:z.number().int().positive(), actor:z.string(), previous_phase:z.enum(['ready','waiting_go']), state:z.literal('queued'),
  workflow:proposalDraft.shape.workflow.optional(), source:stageSource.optional(), quote_id:z.string().optional(),
}).strict();

function stageInput(draft:ProposalDraft,workflow:Workflow,property:string,quoteId:string|null):StaffNativeInput|null {
  if(draft.workflow!==workflow) return null;
  if(workflow==='quote') {
    if(!quoteId || !['propose','staff_review','needs_info'].includes(draft.disposition)) return null;
    const matches=draft.actions.filter(action=>action.type==='quote' && z.object({quote_id:z.literal(quoteId)}).safeParse(action.details).success);
    const selected=matches.length===1 && groupedQuoteRequest.safeParse(matches[0].details);
    return selected && selected.success && selected.data.property_code===property ? {workflow,request:selected.data} : null;
  }
  if(draft.actions.length!==1) return null;
  const [action]=draft.actions;
  if(workflow==='triage') {
    if(!['propose','staff_review'].includes(draft.disposition) || action.type!=='triage') return null;
    const [booking]=draft.bookings;
    if(!draft.bookings.length && !action.booking_ids.length) return {workflow,booking:null,action};
    if(draft.bookings.length!==1 || action.booking_ids.length!==1 || action.booking_ids[0]!==booking.id
        || (booking.property_code!==null && booking.property_code!==property)) return null;
    return {workflow,booking,action};
  }
  if(draft.disposition!=='propose' || draft.bookings.length!==1 || action.booking_ids.length!==1) return null;
  const [booking]=draft.bookings;
  if(action.booking_ids[0]!==booking.id) return null;
  if(workflow==='filing') {
    if(!['filing','attach_document','voucher_submission','payment_proof_submission'].includes(action.type)) return null;
    const nested=booking.fields.property_code;
    if((booking.property_code!==null && booking.property_code!==property) || (nested!=null && nested!==property)) return null;
    const {property_code:_nested,...fields}=booking.fields;
    return {workflow,booking:{...booking,fields,property_code:property},action};
  }
  if(action.type!==workflow || booking.property_code!==property || (workflow==='create' && booking.reservation_id!==null)) return null;
  return {workflow,booking,action};
}

export function createPilotOperations(): ProposalOperations | undefined {
  if (!createPilotEnabled()) return;
  let installed: ReturnType<typeof installedStaffTools> | undefined;
  const installedTools=()=>installed ??= installedStaffTools();
  return {
    capabilities:staffPrepareOnly() ? {} : {create:{stage:true,go_labtest:hmsSaveEnabled(),reconcile:false}},
    ...(staffPrepareOnly() ? {
      async installed() {
        const {stages,modelTools}=await installedTools();
        return {modelTools,capabilities:Object.fromEntries(stages.map(workflow=>[workflow,{
          stage:workflow!=='quote',quote:workflow==='quote',go_labtest:false,reconcile:false,go:workflow==='create' && createGoEnabled(),
        }]))};
      },
    } : {}),
    async submit(tx, request) {
      const [p] = await tx`SELECT p.*,s.config,s.status,s.mode,s.pending_tool_use_id FROM nava_agent.proposal p
        JOIN nava_agent.agent_session s ON s.id=p.session_id AND s.thread_id=p.thread_id WHERE p.id=${request.proposalId}`;
      if (!p) return {ok:false,code:'NOT_FOUND'};
      if(staffPrepareOnly()) {
        if(request.operation==='go') return submitStaffGo(tx,p,request);
        if(request.mode!=='live' || (request.operation!=='stage' && request.operation!=='quote')) return {ok:false,code:'UNAVAILABLE'};
        const source=await selectedStageSource(tx,p.session_id);
        if(!source.success || source.data.mailbox_id!==request.mailboxId) return {ok:false,code:'FORBIDDEN'};
        const draft=proposalDraft.safeParse(p.current);
        const input=draft.success && p.workflow===request.workflow ? stageInput(draft.data,request.workflow,source.data.property_code,request.quoteId) : null;
        if(!input) return {ok:false,code:'INVALID_INPUT'};
        if(input.workflow==='create' && !hasBoundCreateGuest(input.booking,p.execution)) return {ok:false,code:invalidGuestSelection.code};
        if(input.workflow==='create' && draft.success) {
          const missing=missingCreateFields(draft.data,'stage');
          if(missing.length) return {ok:false,code:'REQUIRED_FIELDS_MISSING',details:{fields:fieldLabels(draft.data,missing)}};
        }
        const key=request.idempotencyKey===null?null:createHash('sha256').update(request.idempotencyKey).digest('hex');
        if(key) {
          const [prior]=await tx`SELECT payload FROM nava_agent.agent_event WHERE session_id=${p.session_id} AND kind='stage_queued'
            AND payload->>'proposal_id'=${p.id} AND payload->>'key_hash'=${key} ORDER BY sequence DESC LIMIT 1`;
          if(prior) {
            if(prior.payload.revision!==request.expectedRevision || prior.payload.quote_id!==request.quoteId
                || prior.payload.actor!==request.actor) return {ok:false,code:'IDEMPOTENCY_CONFLICT'};
            return {ok:true,phase:'staging',jobId:prior.payload.job_id,replayed:true};
          }
        }
        if(p.status!=='idle' || p.pending_tool_use_id!==null || p.phase!=='ready') return {ok:false,code:'INVALID_PHASE'};
        if(requiresStaffAttachmentCheck(request.workflow) && !await staffAttachmentsChecked(tx,p.id,p.revision)) {
          return {ok:false,code:attachmentsUnconfirmed.code};
        }
        const stage=queuedStage.parse({job_id:uid('stage'),revision:request.expectedRevision,actor:request.actor,previous_phase:p.phase,state:'queued',
          workflow:request.workflow,source:source.data,...(request.quoteId?{quote_id:request.quoteId}:{})});
        await tx`UPDATE nava_agent.proposal SET phase='staging',stage=${json(stage)},execution=COALESCE(execution,'{}'::jsonb)-'error',updated_at=now()
          WHERE id=${p.id}`;
        await writeEvent(tx,p.session_id,'stage_queued',{proposal_id:p.id,job_id:stage.job_id,revision:stage.revision,
          workflow:request.workflow,actor:request.actor,...(key?{key_hash:key,quote_id:request.quoteId}:{})});
        return {ok:true,phase:'staging',jobId:stage.job_id};
      }
      const input = createInput(p.current);
      if (!input) return {ok:false,code:'INVALID_INPUT'};
      if (request.mode === 'labtest' && !isSeededLabtest(p.config?.manual_create_labtest, input.booking.fields)) return {ok:false,code:'FORBIDDEN'};
      if (request.operation === 'stage') {
        if (!['idle','waiting_go'].includes(p.status)) return {ok:false,code:'INVALID_PHASE'};
        const stage = queuedStage.parse({job_id:uid('stage'),revision:request.expectedRevision,actor:request.actor,previous_phase:p.phase,state:'queued'});
        await tx`UPDATE nava_agent.proposal SET phase='staging',stage=${json(stage)},execution=COALESCE(execution,'{}'::jsonb)-'error',updated_at=now() WHERE id=${request.proposalId}`;
        await writeEvent(tx,p.session_id,'stage_queued',{proposal_id:request.proposalId,...stage});
        return {ok:true,phase:'staging',jobId:stage.job_id};
      }
      if (request.operation !== 'go' || !hmsSaveEnabled() || request.mode !== 'labtest' || !request.idempotencyKey) return {ok:false,code:'UNAVAILABLE'};
      if (p.stage?.state !== 'prepared' || p.stage.revision !== request.expectedRevision) return {ok:false,code:'INVALID_PHASE'};
      try {
        await claimGoInTransaction(tx,{proposalId:p.id,expectedRevision:request.expectedRevision,actor:request.actor,idempotencyKey:request.idempotencyKey});
      } catch (error) {
        if (error instanceof Error && error.message === 'GO_CONFLICT') return {ok:false,code:'IDEMPOTENCY_CONFLICT'};
        if (error instanceof Error && ['NOT_WAITING_GO','PENDING_PROPOSAL_MISMATCH'].includes(error.message)) return {ok:false,code:'INVALID_PHASE'};
        throw error;
      }
      return {ok:true,phase:'saving'};
    },
  };
}

type SubmitRequest = Parameters<ProposalOperations['submit']>[1];
type SubmitResult = Awaited<ReturnType<ProposalOperations['submit']>>;
type ProposalRow = Record<string, any>;

function fieldLabels(draft: ProposalDraft, keys: string[]) {
  return keys.map(key=>draft.field_specs.find(spec=>spec.path.replace(/^\//,'')===`bookings/0/fields/${key}`)?.label ?? key);
}

const staffGo = z.object({
  executionId:z.string(), revision:z.number().int().positive(), idempotencyKey:z.string(), actor:z.string(),
  snapshot:z.unknown(), dispatch:z.enum(['pending','dispatched']), state:z.enum(['queued','running']), staff:z.literal(true), details:z.unknown().optional(),
}).strict();

// Staff Go is a signed staff click on a Prepared Create: the model never saves. It queues durable work for the worker,
// which re-stages, checks the binding, persists the dispatch marker, clicks Save once and reads back.
async function submitStaffGo(tx: postgres.TransactionSql, p: ProposalRow, request: SubmitRequest): Promise<SubmitResult> {
  if(!createGoEnabled() || request.workflow!=='create' || p.workflow!=='create' || request.mode!=='live' || !request.idempotencyKey) return {ok:false,code:'UNAVAILABLE'};
  const existing=p.execution?.go;
  if(existing) {
    const prior=staffGo.safeParse(existing);
    if(!prior.success || prior.data.idempotencyKey!==request.idempotencyKey || prior.data.actor!==request.actor || prior.data.revision!==request.expectedRevision) return {ok:false,code:'IDEMPOTENCY_CONFLICT'};
    return p.phase==='saving' ? {ok:true,phase:'saving',replayed:true} : {ok:false,code:'INVALID_PHASE'};
  }
  const source=await selectedStageSource(tx,p.session_id);
  if(!source.success || source.data.mailbox_id!==request.mailboxId) return {ok:false,code:'FORBIDDEN'};
  const draft=proposalDraft.safeParse(p.current);
  const input=draft.success ? stageInput(draft.data,'create',source.data.property_code,null) : null;
  if(!draft.success || !input || input.workflow!=='create') return {ok:false,code:'INVALID_INPUT'};
  if(!hasBoundCreateGuest(input.booking,p.execution)) return {ok:false,code:invalidGuestSelection.code};
  if(p.status!=='idle' || p.pending_tool_use_id!==null || p.phase!=='ready' || p.revision!==request.expectedRevision
      || p.stage?.state!=='prepared' || p.stage?.revision!==p.revision) return {ok:false,code:'INVALID_PHASE'};
  if(!await staffAttachmentsChecked(tx,p.id,p.revision)) return {ok:false,code:attachmentsUnconfirmed.code};
  const missing=missingCreateFields(draft.data,'go');
  if(missing.length) return {ok:false,code:'REQUIRED_FIELDS_MISSING',details:{fields:fieldLabels(draft.data,missing)}};
  const go=staffGo.parse({executionId:uid('execution'),revision:p.revision,idempotencyKey:request.idempotencyKey,actor:request.actor,
    snapshot:p.current,dispatch:'pending',state:'queued',staff:true});
  const [seq]=await tx`SELECT COALESCE(max(sequence),0)+1 AS n FROM nava_agent.staff_edit WHERE proposal_id=${p.id}`;
  await tx`INSERT INTO nava_agent.staff_edit(id,sequence,proposal_id,session_id,workflow,kind,revision,who,snapshot)
    VALUES (${uid('edit')},${seq.n},${p.id},${p.session_id},${p.workflow},'staff_final',${p.revision},${request.actor},${json(p.current)})`;
  await tx`UPDATE nava_agent.proposal SET phase='saving',execution=(COALESCE(execution,'{}'::jsonb)-'error'-'last_go') || ${json({go})}::jsonb,updated_at=now() WHERE id=${p.id}`;
  await writeEvent(tx,p.session_id,'go_claimed',{proposal_id:p.id,execution_id:go.executionId,revision:go.revision,actor:request.actor,staff:true});
  return {ok:true,phase:'saving'};
}

async function lockedProposal(tx: postgres.TransactionSql, lease: LeaseFence, proposalId: string, executionId: string) {
  const [owner]=await tx`SELECT id FROM nava_agent.agent_session WHERE id=${lease.sessionId} AND worker_id=${lease.workerId}
    AND lease_epoch=${lease.epoch}::bigint AND lease_until>clock_timestamp() FOR NO KEY UPDATE`;
  if(!owner) throw new Error('LEASE_LOST');
  const [p]=await tx`SELECT * FROM nava_agent.proposal WHERE id=${proposalId} AND session_id=${lease.sessionId} FOR UPDATE`;
  const go=staffGo.safeParse(p?.execution?.go);
  if(!p || p.phase!=='saving' || !go.success || go.data.executionId!==executionId) throw new Error('EXECUTION_MISMATCH');
  return {p,go:go.data};
}

async function finishStaffGo(lease: LeaseFence, proposalId: string, executionId: string, result: ToolResult) {
  await sql.begin(async tx => {
    const {p,go}=await lockedProposal(tx,lease,proposalId,executionId);
    const uncertain=!result.ok && (result.error?.outcome==='uncertain' || go.dispatch==='dispatched');
    const completion={...go,state:result.ok?'saved':uncertain?'uncertain':'failed',error:result.error ?? null};
    if(result.ok) {
      const data=z.object({confirmation:z.string().nullable(),reservation_id:z.string().nullable(),readback:z.unknown()}).passthrough().parse(result.data);
      await tx`UPDATE nava_agent.proposal SET phase='done',result=${json({confirmation:data.confirmation,reservation_id:data.reservation_id,readback:data.readback})},
        execution=(execution-'go') || ${json({last_go:completion})}::jsonb,updated_at=now() WHERE id=${p.id}`;
    } else if(uncertain) {
      await tx`UPDATE nava_agent.proposal SET phase='uncertain',execution=(execution-'go') || ${json({last_go:completion,
        error:{...(result.error ?? {code:'SAVE_UNCERTAIN',message:'Save may have dispatched.',retryable:false}),outcome:'uncertain'}})}::jsonb,updated_at=now() WHERE id=${p.id}`;
    } else {
      // Known refusal before dispatch: nothing was saved; staff may fix fields and Prepare again.
      await tx`UPDATE nava_agent.proposal SET phase='ready',execution=(execution-'go') || ${json({last_go:completion,
        error:{...result.error,operation:'staff_stage'}})}::jsonb,updated_at=now() WHERE id=${p.id}`;
    }
    await writeEvent(tx,lease.sessionId,'go_finished',{proposal_id:p.id,execution_id:executionId,revision:go.revision,
      outcome:completion.state,error:result.error ?? null,...(result.ok?{result:result.data}:{})});
  });
}

export async function runStaffGo(lease: LeaseFence, registry: ToolRegistry, context: {sessionId:string;mode:'live'|'labtest'|'historical';signal:AbortSignal}) {
  if(!createGoEnabled()) return false;
  const [row]=await sql`SELECT id,execution->'go'->>'executionId' AS execution_id FROM nava_agent.proposal WHERE session_id=${lease.sessionId}
    AND workflow='create' AND phase='saving' AND execution->'go'->>'staff'='true' ORDER BY updated_at LIMIT 1`;
  if(!row) return false;
  const executionId:string=row.execution_id;
  const claimed=await sql.begin(async tx => {
    const {p,go}=await lockedProposal(tx,lease,row.id,executionId);
    // A crash after the dispatch marker means Save may have been clicked: never retry blindly.
    if(go.dispatch==='dispatched') return {p,go,source:null,resume:false};
    await tx`UPDATE nava_agent.proposal SET execution=jsonb_set(execution,'{go,state}','"running"'::jsonb),updated_at=now() WHERE id=${p.id}`;
    return {p,go,source:await selectedStageSource(tx,p.session_id),resume:true};
  });
  if(!claimed.resume) {
    await finishStaffGo(lease,row.id,executionId,{ok:false,data:null,error:{code:'SAVE_UNCERTAIN',message:'Save may have dispatched; check HMS before any retry.',retryable:false,outcome:'uncertain'}});
    return true;
  }
  const {p,go,source}=claimed;
  const draft=proposalDraft.safeParse(go.snapshot);
  const input=draft.success && source?.success ? stageInput(draft.data,'create',source.data.property_code,null) : null;
  let result:ToolResult;
  if(!input || input.workflow!=='create' || p.revision!==go.revision) {
    result={ok:false,data:null,error:{code:'INVALID_INPUT',message:'The booking changed before Save.',retryable:false,outcome:'known'}};
  } else {
    result=await registry.save({workflow:'create',booking:input.booking,action:input.action,executionId},{sessionId:context.sessionId,mode:context.mode,signal:context.signal,
      markDispatched:async details=>{
        await sql.begin(async tx => {
          const {p:locked,go:current}=await lockedProposal(tx,lease,row.id,executionId);
          if(current.dispatch!=='pending' || current.state!=='running') throw new Error('ALREADY_DISPATCHED');
          if(locked.revision!==current.revision) throw new Error('VERSION_CONFLICT');
          await tx`UPDATE nava_agent.proposal SET execution=jsonb_set(execution,'{go}',${json({...current,dispatch:'dispatched',details})}::jsonb),updated_at=now() WHERE id=${row.id}`;
          await writeEvent(tx,lease.sessionId,'save_dispatched',{proposal_id:row.id,execution_id:executionId,details,staff:true});
        });
      }});
  }
  await finishStaffGo(lease,row.id,executionId,result);
  return true;
}

export async function runStaffStage(lease: LeaseFence, registry: ToolRegistry, context: Omit<RegistryContext,'toolUseId'>) {
  const [p] = await sql`SELECT id,revision,workflow,stage,current FROM nava_agent.proposal
    WHERE session_id=${lease.sessionId} AND (${staffPrepareOnly()} OR workflow='create') AND phase='staging' AND stage->>'state'='queued' ORDER BY updated_at LIMIT 1`;
  if (!p) return false;
  const job = queuedStage.parse(p.stage);
  const draft=proposalDraft.safeParse(p.current);
  const legacy=staffPrepareOnly()?null:createInput(p.current);
  const input=draft.success && job.source && job.workflow && job.workflow===p.workflow
    ? stageInput(draft.data,job.workflow,job.source.property_code,job.quote_id ?? null) : null;
  const binding={proposalId:p.id,revision:job.revision,jobId:job.job_id,workerId:lease.workerId,epoch:lease.epoch};
  let result:ToolResult|null=null;
  if(staffPrepareOnly() && draft.success && input && job.source && job.workflow) {
    result=await registry.runStaffStage(input,draft.data,{...binding,workflow:job.workflow,source:job.source,quoteId:job.quote_id},context);
  } else if(legacy) {
    const answer=await registry.run('hms_prepare',legacy,{...context,toolUseId:job.job_id,staffStage:binding});
    if(answer.kind==='result') result=answer.result;
  }
  const workflow=job.workflow ?? 'create';
  const bookingId=(input && 'booking' in input ? input.booking?.id : legacy?.booking.id) ?? null;
  const {stage,error}=stageFeedback({result,workflow,bookingId,revision:job.revision,jobId:job.job_id,quoteId:job.quote_id});
  await sql.begin(async tx => {
    const [owner] = await tx`SELECT id FROM nava_agent.agent_session WHERE id=${lease.sessionId} AND worker_id=${lease.workerId}
      AND lease_epoch=${lease.epoch}::bigint AND lease_until>clock_timestamp() FOR NO KEY UPDATE`;
    if (!owner) throw new Error('LEASE_LOST');
    const updated = await tx`UPDATE nava_agent.proposal SET phase=${job.previous_phase},stage=${json(stage)},
      execution=COALESCE(execution,'{}'::jsonb)||${json({error})}::jsonb,updated_at=now()
      WHERE id=${p.id} AND revision=${job.revision} AND phase='staging' AND stage->>'job_id'=${job.job_id} RETURNING id`;
    if (!updated.length) throw new Error('STAGE_CHANGED');
    await writeEvent(tx,lease.sessionId,'stage_finished',{proposal_id:p.id,job_id:job.job_id,revision:job.revision,
      workflow,...(job.quote_id?{quote_id:job.quote_id}:{}),ok:!error,error});
  });
  return true;
}
