import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProposalOperations } from './main.js';
import { sql, json, uid } from './db.js';
import { claimGoInTransaction, writeEvent } from './session-store.js';
import { groupedQuoteRequest, proposalDraft, type ProposalDraft, type Workflow } from './schema.js';
import { createPilotRequested, hmsSaveEnabled, staffPrepareOnly } from './hms-mode.js';
import { stageFeedback } from './prepare-feedback.js';
import { attachmentsUnconfirmed, requiresStaffAttachmentCheck, selectedStageSource, stageSource, staffAttachmentsChecked } from './attachment-gate.js';
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
    return {workflow,booking:{...booking,property_code:property},action};
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
          stage:workflow!=='quote',quote:workflow==='quote',go_labtest:false,reconcile:false,
        }]))};
      },
    } : {}),
    async submit(tx, request) {
      const [p] = await tx`SELECT p.*,s.config,s.status,s.mode FROM nava_agent.proposal p
        JOIN nava_agent.agent_session s ON s.id=p.session_id AND s.thread_id=p.thread_id WHERE p.id=${request.proposalId}`;
      if (!p) return {ok:false,code:'NOT_FOUND'};
      if(staffPrepareOnly()) {
        if(request.mode!=='live' || (request.operation!=='stage' && request.operation!=='quote')) return {ok:false,code:'UNAVAILABLE'};
        const source=await selectedStageSource(tx,p.session_id);
        if(!source.success || source.data.mailbox_id!==request.mailboxId) return {ok:false,code:'FORBIDDEN'};
        const draft=proposalDraft.safeParse(p.current);
        if(!draft.success || p.workflow!==request.workflow || !stageInput(draft.data,request.workflow,source.data.property_code,request.quoteId)) return {ok:false,code:'INVALID_INPUT'};
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
        if(p.status!=='idle' || p.phase!=='ready') return {ok:false,code:'INVALID_PHASE'};
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
    result=await registry.runStaffStage(input,draft.data,{...binding,workflow:job.workflow,source:job.source},context);
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
