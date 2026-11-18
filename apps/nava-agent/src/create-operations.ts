import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import type { ProposalOperations } from './main.js';
import { sql, json, uid } from './db.js';
import { claimGoInTransaction, writeEvent } from './session-store.js';
import { groupedQuoteRequest, proposalDraft, type ProposalDraft, type Workflow } from './schema.js';
import { createGoEnabled, createGoRealGuests, createPilotRequested, hmsSaveEnabled, isWriteWorkflow, staffPrepareOnly, staffSlotCount } from './hms-mode.js';
import { missingCreateFields } from './proposal-fields.js';
import { stageFeedback } from './prepare-feedback.js';
import { attachmentsUnconfirmed, confirmedQueuedStaffStage, hasBoundCreateGuest, invalidGuestSelection, profileReviewFor, requiresStaffAttachmentCheck, selectedCreateGuest, selectedStageSource, stageSource, staffAttachmentsChecked, type StaffJobBinding } from './attachment-gate.js';
import { installedStaffTools, type LeaseFence, type RegistryContext, type StaffNativeInput, type ToolRegistry, type ToolResult } from './tool-registry.js';
import { targetLookup, targetIsBound } from './stay-target.js';

export const manualLabtestTarget = z.object({
  arrival_date: z.string().date(), departure_date: z.string().date(),
}).strict().refine(target => target.arrival_date >= '2027-01-01' && target.departure_date > target.arrival_date);

export function createPilotEnabled() {
  const nativeCap=process.env.HMS_CREDENTIAL_SESSION_CAP ?? '';
  return createPilotRequested() && process.env.NAVA_QUOTE_SKELETON !== '1'
    && (process.env.NAVA_AGENT_RUNTIME ?? 'bedrock') === 'bedrock'
    && (staffPrepareOnly() ? staffSlotCount(nativeCap) && staffSlotCount(process.env.NAVA_HMS_SLOTS ?? '4') : nativeCap==='2')
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
  profile_dispatch:z.object({booking_id:z.string(),attempt_id:z.string()}).optional(),
  profile_created:z.array(z.object({booking_id:z.string(),native_id:z.string()})).optional(),
  profile_go:z.literal(true).optional(),
  lookup:targetLookup.optional(),
}).strict();

type CreateNativeInput=Extract<StaffNativeInput,{workflow:'create'|'amend'|'cancel'|'filing'}> & {workflow:'create'};
function createInputs(draft:ProposalDraft, property:string): CreateNativeInput[] | null {
  if(draft.workflow!=='create' || !['propose','needs_info','staff_review'].includes(draft.disposition) || draft.bookings.length<1 || draft.bookings.length>8) return null;
  if(new Set(draft.bookings.map(booking=>booking.id)).size!==draft.bookings.length) return null;
  const actions=draft.actions.filter(action=>action.type!=='invoice_request');
  const inputs:CreateNativeInput[]=[];
  for(const booking of draft.bookings) {
    const matching=actions.filter(action=>action.type==='create' && action.booking_ids.includes(booking.id));
    if(matching.length!==1 || booking.property_code!==property || booking.reservation_id!==null) return null;
    inputs.push({workflow:'create',booking,action:{...matching[0],booking_ids:[booking.id]}});
  }
  if(actions.some(action=>action.type!=='create' || action.booking_ids.some(id=>!draft.bookings.some(booking=>booking.id===id)))) return null;
  return inputs;
}

function hasBoundTarget(input:StaffNativeInput,execution:unknown) {
  if(input.workflow!=='amend' && input.workflow!=='cancel') return true;
  return targetIsBound(input.booking,execution);
}

function stageInput(draft:ProposalDraft,workflow:Workflow,property:string,quoteId:string|null):StaffNativeInput|null {
  if(draft.workflow!==workflow) return null;
  if(workflow==='quote') {
    if(!quoteId || !['propose','staff_review','needs_info'].includes(draft.disposition)) return null;
    const matches=draft.actions.filter(action=>action.type==='quote' && z.object({quote_id:z.literal(quoteId)}).safeParse(action.details).success);
    const selected=matches.length===1 && groupedQuoteRequest.safeParse(matches[0].details);
    return selected && selected.success && selected.data.property_code===property ? {workflow,request:selected.data} : null;
  }
  if(workflow==='create') return createInputs(draft,property)?.[0] ?? null;
  const actions=draft.actions;
  if(actions.length!==1) return null;
  const [action]=actions;
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
  if(action.type!==workflow || booking.property_code!==property) return null;
  return {workflow,booking,action};
}

function targetStageInput(draft:ProposalDraft,workflow:Workflow,property:string):StaffNativeInput|null {
  if((workflow!=='amend' && workflow!=='cancel' && workflow!=='filing') || draft.workflow!==workflow || draft.disposition!=='propose' ||
    draft.bookings.length!==1 || draft.actions.length!==1) return null;
  const [booking]=draft.bookings, [action]=draft.actions;
  if((action.type!==workflow && !(workflow==='filing' && ['attach_document','voucher_submission','payment_proof_submission'].includes(action.type))) ||
    action.booking_ids.length!==1 || action.booking_ids[0]!==booking.id ||
    (booking.property_code!==null && booking.property_code!==property) ||
    (workflow==='filing' && booking.fields.property_code!=null && booking.fields.property_code!==property)) return null;
  return {workflow,booking:{...booking,property_code:property},action};
}

export function createPilotOperations(): ProposalOperations | undefined {
  if (!createPilotEnabled()) return;
  let installed: ReturnType<typeof installedStaffTools> | undefined;
  const installedTools=()=>installed ??= installedStaffTools();
  return {
    capabilities:staffPrepareOnly() ? {} : {create:{stage:true,go_labtest:hmsSaveEnabled(),reconcile:false}},
    ...(staffPrepareOnly() ? {
      async installed() {
        const {stages,writers,modelTools}=await installedTools();
        return {modelTools,capabilities:Object.fromEntries(stages.map(workflow=>[workflow,{
          stage:workflow!=='quote',quote:workflow==='quote',go_labtest:false,reconcile:workflow==='create' && createGoEnabled(),go:createGoEnabled() && writers.includes(workflow),
        }]))};
      },
    } : {}),
    async submit(tx, request) {
      const [p] = await tx`SELECT p.*,s.config,s.status,s.mode,s.pending_tool_use_id FROM nava_agent.proposal p
        JOIN nava_agent.agent_session s ON s.id=p.session_id AND s.thread_id=p.thread_id WHERE p.id=${request.proposalId}`;
      if (!p) return {ok:false,code:'NOT_FOUND'};
      if(staffPrepareOnly()) {
        if(request.operation==='reconcile') {
          const source=await selectedStageSource(tx,p.session_id);
          if(!source.success || source.data.mailbox_id!==request.mailboxId) return {ok:false,code:'FORBIDDEN'};
          if(request.mode!=='live' || request.workflow!=='create' || p.workflow!=='create' || p.phase!=='uncertain' ||
            p.config?.replay_id || !p.execution?.last_go?.details) return {ok:false,code:'UNAVAILABLE'};
          if(p.execution?.reconcile?.state==='queued') return {ok:true,phase:'uncertain',jobId:p.execution.reconcile.job_id,replayed:true};
          const reconcile={job_id:uid('reconcile'),revision:p.revision,state:'queued'};
          await tx`UPDATE nava_agent.proposal SET execution=execution || ${json({reconcile})}::jsonb,updated_at=now() WHERE id=${p.id}`;
          await writeEvent(tx,p.session_id,'reconcile_queued',{proposal_id:p.id,job_id:reconcile.job_id,revision:p.revision,actor:request.actor});
          return {ok:true,phase:'uncertain',jobId:reconcile.job_id};
        }
        if(request.operation==='go' && !request.createProfile) return p.config?.replay_id ? {ok:false,code:'UNAVAILABLE'} : submitStaffGo(tx,p,request);
        if(request.mode!=='live' || (request.operation!=='stage' && request.operation!=='quote' && request.operation!=='target' && !(request.operation==='go' && request.createProfile))) return {ok:false,code:'UNAVAILABLE'};
        const source=await selectedStageSource(tx,p.session_id);
        if(!source.success || source.data.mailbox_id!==request.mailboxId) return {ok:false,code:'FORBIDDEN'};
        const draft=proposalDraft.safeParse(p.current);
        const input=draft.success && p.workflow===request.workflow ? request.operation==='target'
          ? targetStageInput(draft.data,request.workflow,source.data.property_code)
          : stageInput(draft.data,request.workflow,source.data.property_code,request.quoteId) : null;
        if(!input) return {ok:false,code:'INVALID_INPUT'};
        if(request.operation==='target' && (!request.lookup || !['amend','cancel','filing'].includes(input.workflow))) return {ok:false,code:'INVALID_INPUT'};
        if(request.operation==='stage' && !hasBoundTarget(input,p.execution)) return {ok:false,code:'INVALID_INPUT'};
        if(input.workflow==='create' && draft.success) {
          const needsProfile=draft.data.bookings.some(booking=>booking.fields.profile_create_new===true && booking.fields.guest_profile_id==null);
          if(needsProfile && !request.createProfile) return {ok:false,code:'REQUIRED_FIELDS_MISSING',details:{fields:['Go: Create Guest Profile and check price']}};
          if(request.createProfile && (!needsProfile || !request.idempotencyKey || p.config?.replay_id)) return {ok:false,code:'UNAVAILABLE'};
          const missing=draft.data.bookings.flatMap((_,index)=>fieldLabels(draft.data,missingCreateFields(draft.data,'stage',index),index).map(label=>draft.data.bookings.length===1 ? label : `Room ${index+1}: ${label}`));
          if(missing.length) return {ok:false,code:'REQUIRED_FIELDS_MISSING',details:{fields:missing}};
          for(const [index,booking] of draft.data.bookings.entries()) {
            if(booking.fields.profile_create_new!==true || booking.fields.guest_profile_id!=null) continue;
            if(p.config?.replay_id) return {ok:false,code:'UNAVAILABLE'};
            const choice=draft.data.field_specs.find(spec=>spec.path===`/bookings/${index}/fields/profile_create_new`);
            if(!createGoEnabled() || choice?.provenance!=='staff' || !profileReviewFor(booking,p.execution) || typeof booking.fields.profile_mobile!=='string' || !booking.fields.profile_mobile.trim())
              return {ok:false,code:'REQUIRED_FIELDS_MISSING',details:{fields:[draft.data.bookings.length===1?'Review New Guest Profile and enter mobile':`Room ${index+1}: review New Guest Profile and enter mobile`]}};
          }
        }
        if(request.createProfile && input.workflow!=='create') return {ok:false,code:'INVALID_INPUT'};
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
          workflow:request.workflow,source:source.data,...(request.quoteId?{quote_id:request.quoteId}:{}),...(request.lookup?{lookup:request.lookup}:{}),...(request.createProfile?{profile_go:true}:{})});
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

function fieldLabels(draft: ProposalDraft, keys: string[], index=0) {
  return keys.map(key=>draft.field_specs.find(spec=>spec.path.replace(/^\//,'')===`bookings/${index}/fields/${key}`)?.label ?? key);
}

const staffGo = z.object({
  executionId:z.string(), revision:z.number().int().positive(), idempotencyKey:z.string(), actor:z.string(),
  snapshot:z.unknown(), dispatch:z.enum(['pending','dispatched']), state:z.enum(['queued','running']), staff:z.literal(true), details:z.unknown().optional(),
  expectedPrice:z.object({averageRate:z.string().min(1),totalRate:z.string().min(1),currency:z.string().min(1)}).strict().optional(),
  prepareJobId:z.string().optional(),confirmPenalty:z.literal(true).optional(),
  rooms:z.array(z.object({booking_id:z.string(),state:z.enum(['unattempted','dispatched','saved','failed','uncertain']),
    expectedPrice:z.object({averageRate:z.string(),totalRate:z.string(),currency:z.string()}).strict(),
    confirmation:z.string().nullable().optional(),reservation_id:z.string().nullable().optional(),readback:z.unknown().optional(),sibling:z.unknown().optional()})).optional(),
}).strict();
const shownPrice = z.object({averageRate:z.string().trim().min(1),totalRate:z.string().trim().min(1),currency:z.string().trim().min(1)});
const observedPenalty = z.object({state:z.literal('review_required'),text:z.string().trim().min(1)});

// Staff Go queues durable work for the worker after a signed staff click on the current Prepare.
// which re-stages, checks the binding, persists the dispatch marker, clicks Save once and reads back.
async function submitStaffGo(tx: postgres.TransactionSql, p: ProposalRow, request: SubmitRequest): Promise<SubmitResult> {
  if(!createGoEnabled() || !isWriteWorkflow(request.workflow) || p.workflow!==request.workflow || request.mode!=='live' || !request.idempotencyKey) return {ok:false,code:'UNAVAILABLE'};
  const existing=p.execution?.go;
  if(existing) {
    const prior=staffGo.safeParse(existing);
    if(!prior.success || prior.data.idempotencyKey!==request.idempotencyKey || prior.data.actor!==request.actor ||
        prior.data.revision!==request.expectedRevision || prior.data.confirmPenalty!==request.confirmPenalty ||
        (request.preparedJobId!==undefined && prior.data.prepareJobId!==request.preparedJobId)) return {ok:false,code:'IDEMPOTENCY_CONFLICT'};
    return p.phase==='saving' ? {ok:true,phase:'saving',replayed:true} : {ok:false,code:'INVALID_PHASE'};
  }
  const source=await selectedStageSource(tx,p.session_id);
  if(!source.success || source.data.mailbox_id!==request.mailboxId) return {ok:false,code:'FORBIDDEN'};
  const draft=proposalDraft.safeParse(p.current);
  const input=draft.success ? stageInput(draft.data,request.workflow,source.data.property_code,null) : null;
  if(!draft.success || !input || input.workflow==='quote' || input.workflow==='triage') return {ok:false,code:'INVALID_INPUT'};
  if(!hasBoundTarget(input,p.execution)) return {ok:false,code:'INVALID_INPUT'};
  if(p.status!=='idle' || p.pending_tool_use_id!==null || p.phase!=='ready' || p.revision!==request.expectedRevision
      || p.stage?.state!=='prepared' || p.stage?.revision!==p.revision
      || (request.preparedJobId!==undefined && p.stage?.job_id!==request.preparedJobId)) return {ok:false,code:'INVALID_PHASE'};
  if(!await staffAttachmentsChecked(tx,p.id,p.revision)) return {ok:false,code:attachmentsUnconfirmed.code};
  let expectedPrice:z.infer<typeof shownPrice>|undefined;
  if(input.workflow==='create') {
    if(draft.data.bookings.some(booking=>!hasBoundCreateGuest(booking,p.execution))) return {ok:false,code:invalidGuestSelection.code};
    const hasRealGuest=draft.data.bookings.some(({fields})=>!(fields.first_name==='Proof' && fields.last_name==='Labtest' && typeof fields.arrival_date==='string'
      && fields.arrival_date>='2027-01-01' && fields.cms_send!==true));
    if(hasRealGuest && !createGoRealGuests()) return {ok:false,code:'REAL_GUEST_GO_UNAVAILABLE'};
    const missing=draft.data.bookings.flatMap((_,index)=>fieldLabels(draft.data,missingCreateFields(draft.data,'go',index),index).map(label=>draft.data.bookings.length===1 ? label : `Room ${index+1}: ${label}`));
    if(missing.length) return {ok:false,code:'REQUIRED_FIELDS_MISSING',details:{fields:missing}};
    const price=shownPrice.safeParse(p.stage?.native_result?.native?.ratePlanAvailability);
    if(!price.success) return {ok:false,code:'REQUIRED_FIELDS_MISSING',details:{fields:['Infor price (run Prepare again)']}};
    expectedPrice=price.data;
  }
  const fee=input.workflow==='cancel' && observedPenalty.safeParse(p.stage.cancellation_fee ?? p.stage.native_result?.cancellation_fee).success;
  if(fee!==Boolean(request.confirmPenalty) || (fee && !request.preparedJobId)) return {ok:false,code:'INVALID_PHASE'};
  const rooms=input.workflow==='create' && draft.data.bookings.length>1 ? draft.data.bookings.map((booking,index)=>({
    booking_id:booking.id,state:'unattempted',expectedPrice:shownPrice.safeParse(p.stage?.native_result?.rooms?.[index]?.native?.ratePlanAvailability).data,
  })) : undefined;
  if(rooms?.some(room=>!room.expectedPrice)) return {ok:false,code:'REQUIRED_FIELDS_MISSING',details:{fields:['Infor price for every room (run Prepare again)']}};
  const go=staffGo.parse({executionId:uid('execution'),revision:p.revision,idempotencyKey:request.idempotencyKey,actor:request.actor,
    snapshot:p.current,dispatch:'pending',state:'queued',staff:true,
    expectedPrice,rooms,prepareJobId:p.stage.job_id,confirmPenalty:request.confirmPenalty});
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

async function resumeFilingAfterCreate(tx: postgres.TransactionSql, p: ProposalRow, data: {confirmation:string|null;reservation_id:string|null;readback:unknown}) {
  if(p.workflow!=='create' || !data.confirmation || !data.reservation_id || data.readback==null) return;
  const [row]=await tx`SELECT m.payload FROM nava_agent.mail_thread t JOIN nava_agent.mail_message m
    ON m.thread_id=t.id AND m.source_message_id=t.selected_message_id WHERE t.id=${p.thread_id}`;
  const selected=z.object({id:z.string(),direction:z.literal('inbound'),subject:z.string(),body_text:z.string(),
    attachments:z.array(z.object({id:z.string(),name:z.string(),mime_type:z.string(),extracted_text:z.string().nullable()}))}).safeParse(row?.payload);
  if(!selected.success) return;
  const document=/voucher|proof[\s_-]+of[\s_-]+payment|(?:^|[^a-z])pop(?:[^a-z]|$)/i;
  const pdfs=selected.data.attachments.filter(file=>file.mime_type==='application/pdf');
  const attachments=pdfs.filter(file=>document.test(`${file.name}\n${file.extracted_text ?? ''}`) ||
    (pdfs.length===1 && document.test(`${selected.data.subject}\n${selected.data.body_text}`)));
  if(!attachments.length) return;
  const readback={create_proposal_id:p.id,source_message_id:selected.data.id,
    attachments:attachments.map(({id,name})=>({id,name})),confirmation:data.confirmation,
    reservation_stay_id:data.reservation_id,readback:data.readback};
  await writeEvent(tx,p.session_id,'context_pending',{delivered:false,origin:'create_readback',text:
    `Infor Create Go completed. Use this exact readback and selected source for the outstanding voucher or proof of payment Filing; publish a separate Filing proposal with booking.reservation_id set to this confirmation. Staff must review and select the Infor target before Prepare. ${JSON.stringify(readback)}`});
}

async function finishStaffGo(lease: LeaseFence, proposalId: string, executionId: string, result: ToolResult) {
  await sql.begin(async tx => {
    const {p,go}=await lockedProposal(tx,lease,proposalId,executionId);
    const uncertain=!result.ok && (result.error?.outcome==='uncertain' || go.dispatch==='dispatched');
    const completion={...go,state:result.ok?'saved':uncertain?'uncertain':'failed',error:result.error ?? null};
    const penaltyResult=z.object({cancellation_fee:observedPenalty}).safeParse(result.data);
    if(result.ok) {
      const data=z.object({confirmation:z.string().nullable(),reservation_id:z.string().nullable(),readback:z.unknown()}).passthrough().parse(result.data);
      const draft=proposalDraft.safeParse(go.snapshot);
      const rooms=draft.success && draft.data.workflow==='create' && draft.data.bookings.length===1
        ? [{booking_id:draft.data.bookings[0].id,state:'saved',confirmation:data.confirmation,reservation_id:data.reservation_id,readback:data.readback}] : undefined;
      await tx`UPDATE nava_agent.proposal SET phase='done',result=${json({confirmation:data.confirmation,reservation_id:data.reservation_id,readback:data.readback,...(rooms?{rooms}:{})})},
        execution=(execution-'go') || ${json({last_go:completion})}::jsonb,updated_at=now() WHERE id=${p.id}`;
      await resumeFilingAfterCreate(tx,p,data);
    } else if(uncertain) {
      await tx`UPDATE nava_agent.proposal SET phase='uncertain',execution=(execution-'go') || ${json({last_go:completion,
        error:{...(result.error ?? {code:'SAVE_UNCERTAIN',message:'Save may have dispatched.',retryable:false}),outcome:'uncertain'}})}::jsonb,updated_at=now() WHERE id=${p.id}`;
    } else if(p.workflow==='cancel' && result.error?.code==='CANCEL_PENALTY_CHANGED' && penaltyResult.success) {
      const penalty=penaltyResult.data.cancellation_fee;
      const native=p.stage.native_result;
      const stage={...p.stage,cancellation_fee:penalty,native_result:{...native,cancellation_fee:penalty,
        native:{...native.native,penaltyText:penalty.text,commitPenaltyText:penalty.text}},
        display_rows:(p.stage.display_rows ?? []).map((row:any)=>row.id==='cancel-fee'?{...row,value:penalty.text}:row)};
      await tx`UPDATE nava_agent.proposal SET phase='ready',stage=${json(stage)},execution=(execution-'go') || ${json({last_go:completion,
        error:{...result.error,operation:'staff_stage',message:'Infor showed a cancellation fee. Review it and press Go again.',recovery:'Review the fee before confirming.'}})}::jsonb,updated_at=now() WHERE id=${p.id}`;
    } else {
      // Known refusal before dispatch: nothing was saved; staff may fix fields and Prepare again.
      await tx`UPDATE nava_agent.proposal SET phase='ready',execution=(execution-'go') || ${json({last_go:completion,
        error:{...result.error,operation:'staff_stage'}})}::jsonb,updated_at=now() WHERE id=${p.id}`;
    }
    await writeEvent(tx,lease.sessionId,'go_finished',{proposal_id:p.id,execution_id:executionId,revision:go.revision,
      outcome:completion.state,error:result.error ?? null,...(result.ok?{result:result.data}:
        p.workflow==='filing' && !uncertain && result.data ? {native_diagnostics:result.data} : {})});
  });
}

export async function runStaffGo(lease: LeaseFence, registry: ToolRegistry, context: {sessionId:string;mode:'live'|'labtest'|'historical';signal:AbortSignal}) {
  if(!createGoEnabled()) return false;
  const [row]=await sql`SELECT id,execution->'go'->>'executionId' AS execution_id FROM nava_agent.proposal WHERE session_id=${lease.sessionId}
    AND phase='saving' AND execution->'go'->>'staff'='true' ORDER BY updated_at LIMIT 1`;
  if(!row) return false;
  const executionId:string=row.execution_id;
  const claimed=await sql.begin(async tx => {
    const {p,go}=await lockedProposal(tx,lease,row.id,executionId);
    // A crash after the dispatch marker means Save may have been clicked: never retry blindly.
    if(go.dispatch==='dispatched') return {p,go,source:null,resume:false};
    await tx`UPDATE nava_agent.proposal SET execution=jsonb_set(execution,'{go,state}','"running"'::jsonb),updated_at=now() WHERE id=${p.id}`;
    return {p,go,source:await selectedStageSource(tx,p.session_id),resume:true};
  });
  if(!claimed.resume && claimed.go.rooms) {
    await finishCreateRoom(lease,row.id,executionId,{ok:false,data:null,error:{code:'SAVE_UNCERTAIN',message:'Save may have dispatched; check HMS before any retry.',retryable:false,outcome:'uncertain'}});
    return true;
  }
  if(!claimed.resume) {
    await finishStaffGo(lease,row.id,executionId,{ok:false,data:null,error:{code:'SAVE_UNCERTAIN',message:'Save may have dispatched; check HMS before any retry.',retryable:false,outcome:'uncertain'}});
    return true;
  }
  const {p,go,source}=claimed;
  if(go.rooms) { await runCreateRooms(lease,registry,context,p,go,source); return true; }
  const draft=proposalDraft.safeParse(go.snapshot);
  const input=draft.success && source?.success && isWriteWorkflow(draft.data.workflow)
    ? stageInput(draft.data,draft.data.workflow,source.data.property_code,null) : null;
  let result:ToolResult;
  if(!input || input.workflow==='quote' || input.workflow==='triage' || !hasBoundTarget(input,p.execution) || !source?.success || p.revision!==go.revision
      || p.stage?.state!=='prepared' || p.stage.revision!==go.revision || (go.prepareJobId && p.stage.job_id!==go.prepareJobId)) {
    result={ok:false,data:null,error:{code:'INVALID_INPUT',message:'The booking changed before Save.',retryable:false,outcome:'known'}};
  } else {
    const staffStage:StaffJobBinding={proposalId:p.id,revision:go.revision,jobId:p.stage.job_id,workerId:lease.workerId,epoch:lease.epoch,
      workflow:input.workflow,source:source.data};
    const approved=input.workflow==='create' ? {expectedPrice:go.expectedPrice} : {prepared:p.stage.native_result};
    result=await registry.save({...input,executionId,...approved,...(go.confirmPenalty?{confirmPenalty:go.confirmPenalty}:{})},
      {sessionId:context.sessionId,mode:context.mode,signal:context.signal,staffStage,staffGo:{executionId},
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

async function finishCreateRoom(lease:LeaseFence,proposalId:string,executionId:string,result:ToolResult) {
  return sql.begin(async tx=>{
    const {p,go}=await lockedProposal(tx,lease,proposalId,executionId);
    if(!go.rooms) throw new Error('ROOMS_MISSING');
    const index=go.rooms.findIndex(room=>room.state==='dispatched' || room.state==='unattempted');
    if(index<0) throw new Error('ROOMS_COMPLETE');
    const rooms=go.rooms.map(room=>({...room}));
    const uncertain=!result.ok && (go.dispatch==='dispatched' || result.error?.outcome==='uncertain');
    if(result.ok) {
      const saved=z.object({confirmation:z.string().nullable(),reservation_id:z.string().nullable(),readback:z.unknown(),sibling:z.unknown()}).parse(result.data);
      rooms[index]={...rooms[index],...saved,state:'saved'};
    } else rooms[index]={...rooms[index],state:uncertain?'uncertain':'failed'};
    const complete=rooms.every(room=>room.state==='saved');
    const partial=rooms.some(room=>room.state==='saved');
    const next={...go,rooms,dispatch:'pending' as const};
    const view={confirmation:null,reservation_id:null,readback:complete?rooms.map(room=>room.readback):null,rooms};
    const error=result.error ? {...result.error,operation:'staff_stage',...(partial && !uncertain ? {
      message:'The next room could not be saved. Review the completed and unattempted rooms below.',
      recovery:'Check Infor before taking further action.',
    } : {})} : null;
    const phase=complete?'done':result.ok?'saving':uncertain?'uncertain':partial?'error':'ready';
    await tx`UPDATE nava_agent.proposal SET phase=${phase},result=${json(view)},
      execution=${phase==='saving' ? json({...p.execution,go:next}) : json({...p.execution,go:undefined,last_go:{...next,state:complete?'saved':uncertain?'uncertain':'failed'},error})},updated_at=now() WHERE id=${proposalId}`;
    await writeEvent(tx,lease.sessionId,'create_room_finished',{proposal_id:proposalId,execution_id:executionId,booking_id:rooms[index].booking_id,
      outcome:rooms[index].state,confirmation:rooms[index].confirmation ?? null,reservation_id:rooms[index].reservation_id ?? null});
    return phase==='saving';
  });
}

export async function runStaffReconcile(lease:LeaseFence,registry:ToolRegistry,signal:AbortSignal) {
  const [row]=await sql`SELECT id,revision,execution FROM nava_agent.proposal WHERE session_id=${lease.sessionId}
    AND phase='uncertain' AND execution->'reconcile'->>'state'='queued' ORDER BY updated_at LIMIT 1`;
  if(!row) return false;
  const job=row.execution.reconcile, last=row.execution.last_go;
  const {error:_lastError,...lastGo}=last ?? {};
  const prior=staffGo.safeParse({...lastGo,state:'queued'});
  const draft=prior.success ? proposalDraft.safeParse(prior.data.snapshot) : null;
  const recovered=prior.success && draft?.success && draft.data.workflow==='create'
    ? await registry.reconcileCreate(prior.data.details,signal)
    : {ok:false,data:null,error:{code:'SAVE_UNCERTAIN',message:'Check the booking in Infor before taking further action.',retryable:false,outcome:'uncertain' as const}};
  const saved=z.object({confirmation:z.string().regex(/^\d+-\d+$/),reservation_id:z.string().regex(/^\d+$/),readback:z.unknown(),sibling:z.unknown()}).safeParse(recovered.data);
  await sql.begin(async tx=>{
    const [owner]=await tx`SELECT id FROM nava_agent.agent_session WHERE id=${lease.sessionId} AND worker_id=${lease.workerId}
      AND lease_epoch=${lease.epoch}::bigint AND lease_until>clock_timestamp() FOR NO KEY UPDATE`;
    if(!owner) throw new Error('LEASE_LOST');
    const [p]=await tx`SELECT * FROM nava_agent.proposal WHERE id=${row.id} AND session_id=${lease.sessionId} FOR UPDATE`;
    if(!p || p.phase!=='uncertain' || p.revision!==row.revision || p.execution?.reconcile?.job_id!==job.job_id ||
      p.execution.reconcile.state!=='queued' || p.execution?.last_go?.executionId!==last?.executionId) return;
    let phase='uncertain', result=p.result, error=p.execution.error;
    const identified=prior.success && draft?.success && (prior.data.rooms
      ? prior.data.rooms.filter(room=>room.state==='uncertain').length===1 : draft.data.bookings.length===1);
    if(recovered.ok && saved.success && prior.success && draft?.success && identified) {
      const rooms=prior.data.rooms ? prior.data.rooms.map(room=>room.state==='uncertain'?{...room,...saved.data,state:'saved' as const}:room)
        : [{booking_id:draft.data.bookings[0].id,...saved.data,state:'saved' as const}];
      const complete=rooms.every(room=>room.state==='saved');
      phase=complete?'done':'error';
      result=prior.data.rooms ? {confirmation:null,reservation_id:null,readback:complete?rooms.map(room=>room.readback):null,rooms}
        : {confirmation:saved.data.confirmation,reservation_id:saved.data.reservation_id,readback:saved.data.readback,rooms};
      error=complete?null:{code:'PARTIAL_CREATE',message:'Infor confirmed the interrupted room. Review the completed and remaining rooms.',
        recovery:'Check Infor before taking further action.',retryable:false,outcome:'known',operation:'staff_stage'};
      last.rooms=rooms;
      last.state=complete?'saved':'failed';
    } else error={code:'SAVE_UNCERTAIN',message:'Infor did not confirm the Save. Check the booking before taking further action.',retryable:false,outcome:'uncertain'};
    const execution={...p.execution,last_go:last,reconcile:{...job,state:'finished'},error};
    await tx`UPDATE nava_agent.proposal SET phase=${phase},result=${json(result)},execution=${json(execution)},updated_at=now() WHERE id=${row.id}`;
    await writeEvent(tx,lease.sessionId,'reconcile_finished',{proposal_id:row.id,job_id:job.job_id,outcome:phase});
  });
  return true;
}

async function runCreateRooms(lease:LeaseFence,registry:ToolRegistry,context:{sessionId:string;mode:'live'|'labtest'|'historical';signal:AbortSignal},
  p:ProposalRow,go:z.infer<typeof staffGo>,source:Awaited<ReturnType<typeof selectedStageSource>>|null) {
  const draft=proposalDraft.safeParse(go.snapshot);
  const inputs=draft.success && source?.success ? createInputs(draft.data,source.data.property_code) : null;
  if(!inputs || !source?.success || p.revision!==go.revision || p.stage?.state!=='prepared' || p.stage.revision!==go.revision || p.stage.job_id!==go.prepareJobId) {
    await finishCreateRoom(lease,p.id,go.executionId,{ok:false,data:null,error:{code:'INVALID_INPUT',message:'The booking changed before Save.',retryable:false,outcome:'known'}});
    return;
  }
  while(true) {
    const [latest]=await sql`SELECT execution FROM nava_agent.proposal WHERE id=${p.id}`;
    const current=staffGo.parse(latest.execution.go);
    const index=current.rooms?.findIndex(room=>room.state==='unattempted') ?? -1;
    if(index<0 || !current.rooms || !inputs[index] || current.rooms[index].booking_id!==inputs[index].booking.id) throw new Error('ROOMS_CHANGED');
    const staffStage:StaffJobBinding={proposalId:p.id,revision:go.revision,jobId:p.stage.job_id,workerId:lease.workerId,epoch:lease.epoch,
      workflow:'create',source:source.data};
    const priorRooms=current.rooms.slice(0,index).map(room=>room.sibling);
    const result=await registry.save({...inputs[index],executionId:go.executionId,expectedPrice:current.rooms[index].expectedPrice,priorRooms},
      {sessionId:context.sessionId,mode:context.mode,signal:context.signal,staffStage,staffGo:{executionId:go.executionId},
        markDispatched:async details=>{
          await sql.begin(async tx=>{
            const {p:locked,go:active}=await lockedProposal(tx,lease,p.id,go.executionId);
            if(active.dispatch!=='pending' || active.state!=='running' || locked.revision!==active.revision || active.rooms?.[index]?.state!=='unattempted') throw new Error('ALREADY_DISPATCHED');
            const rooms=active.rooms.map((room,i)=>i===index?{...room,state:'dispatched' as const}:room);
            await tx`UPDATE nava_agent.proposal SET execution=jsonb_set(execution,'{go}',${json({...active,rooms,dispatch:'dispatched',details})}::jsonb),updated_at=now() WHERE id=${p.id}`;
            await writeEvent(tx,lease.sessionId,'save_dispatched',{proposal_id:p.id,execution_id:go.executionId,booking_id:rooms[index].booking_id,details,staff:true});
          });
        }});
    if(!await finishCreateRoom(lease,p.id,go.executionId,result)) return;
  }
}

async function prepareNewProfiles(lease:LeaseFence,registry:ToolRegistry,context:Omit<RegistryContext,'toolUseId'>,
  p:ProposalRow,job:z.infer<typeof queuedStage>):Promise<boolean> {
  if(job.profile_dispatch) {
    await profileStageFailure(lease,p.id,job,'PROFILE_CREATE_UNCERTAIN',true);
    return false;
  }
  if(!job.source) return false;
  while(true) {
    const [row]=await sql`SELECT current,stage,execution FROM nava_agent.proposal WHERE id=${p.id}`;
    p.execution=row.execution;
    const draft=proposalDraft.parse(row.current);
    const index=draft.bookings.findIndex(booking=>booking.fields.profile_create_new===true && booking.fields.guest_profile_id==null);
    if(index<0) return true;
    const booking=draft.bookings[index], fields=booking.fields;
    const [session]=await sql`SELECT config FROM nava_agent.agent_session WHERE id=${lease.sessionId}`;
    if(session?.config?.replay_id) { await profileStageFailure(lease,p.id,job,'UNAVAILABLE',false); return false; }
    const choice=draft.field_specs.find(spec=>spec.path===`/bookings/${index}/fields/profile_create_new`);
    const profile=z.object({firstName:z.string().trim().min(1),lastName:z.string().trim().min(1),mobile:z.string().trim().min(1),email:z.string().optional()}).safeParse({
      firstName:fields.first_name,lastName:fields.last_name,mobile:fields.profile_mobile,
      ...(typeof fields.profile_email==='string' && fields.profile_email.trim()?{email:fields.profile_email.trim()}:{})});
    if(!profile.success || choice?.provenance!=='staff' || !profileReviewFor(booking,p.execution)) { await profileStageFailure(lease,p.id,job,'PROFILE_INPUT_REQUIRED',false);return false; }
    const binding:StaffJobBinding={proposalId:p.id,revision:job.revision,jobId:job.job_id,workerId:lease.workerId,epoch:lease.epoch,workflow:'create',source:job.source};
    if(await confirmedQueuedStaffStage(binding,lease.sessionId,draft)) { await profileStageFailure(lease,p.id,job,'STAFF_JOB_CHANGED',false);return false; }
    const attemptId=`profile_${createHash('sha256').update(job.job_id+':'+booking.id).digest('hex')}`;
    const owned=async()=>{
      const [current]=await sql`SELECT p.id FROM nava_agent.proposal p JOIN nava_agent.agent_session s ON s.id=p.session_id
        WHERE p.id=${p.id} AND p.phase='staging' AND p.revision=${job.revision} AND p.stage->>'job_id'=${job.job_id}
        AND s.worker_id=${lease.workerId} AND s.lease_epoch=${lease.epoch}::bigint AND s.lease_until>clock_timestamp()`;
      return !!current;
    };
    const result=await registry.createGuestProfile({propertyCode:job.source.property_code,guest:profile.data,attemptId},{signal:context.signal ?? new AbortController().signal,authorize:owned,
      markDispatched:async()=>{
        await sql.begin(async tx=>{
          const [owner]=await tx`SELECT id FROM nava_agent.agent_session WHERE id=${lease.sessionId} AND worker_id=${lease.workerId}
            AND lease_epoch=${lease.epoch}::bigint AND lease_until>clock_timestamp() FOR NO KEY UPDATE`;
          if(!owner) throw new Error('LEASE_LOST');
          const [updated]=await tx`UPDATE nava_agent.proposal SET stage=jsonb_set(stage,'{profile_dispatch}',${json({booking_id:booking.id,attempt_id:attemptId})}::jsonb),updated_at=now()
            WHERE id=${p.id} AND phase='staging' AND revision=${job.revision} AND stage->>'job_id'=${job.job_id} RETURNING id`;
          if(!updated) throw new Error('STAGE_CHANGED');
        });
      }});
    const saved=z.object({nativeId:z.string().regex(/^\d+$/)}).safeParse(result.data);
    if(!result.ok || !saved.success) {
      const [latest]=await sql`SELECT stage FROM nava_agent.proposal WHERE id=${p.id}`;
      await profileStageFailure(lease,p.id,job,result.error?.code ?? 'PROFILE_CREATE_UNCERTAIN',!!latest?.stage?.profile_dispatch || result.error?.outcome==='uncertain',
        z.object({nativeId:z.string().nullable().optional()}).safeParse(result.data).data?.nativeId ?? null);
      return false;
    }
    await sql.begin(async tx=>{
      const [owner]=await tx`SELECT id FROM nava_agent.agent_session WHERE id=${lease.sessionId} AND worker_id=${lease.workerId}
        AND lease_epoch=${lease.epoch}::bigint AND lease_until>clock_timestamp() FOR NO KEY UPDATE`;
      if(!owner) throw new Error('LEASE_LOST');
      const [locked]=await tx`SELECT current,execution,stage FROM nava_agent.proposal WHERE id=${p.id} AND phase='staging' AND revision=${job.revision} AND stage->>'job_id'=${job.job_id} FOR UPDATE`;
      if(!locked || locked.stage?.profile_dispatch?.attempt_id!==attemptId) throw new Error('STAGE_CHANGED');
      const updated=proposalDraft.parse(locked.current);
      const selections=z.array(z.unknown()).safeParse(locked.execution?.staff_guest_selections).data ?? [];
      if(locked.execution?.staff_guest_selection) selections.push(locked.execution.staff_guest_selection);
      const sameProfile=(room:ProposalDraft['bookings'][number])=>room.fields.profile_create_new===true && room.fields.guest_profile_id==null &&
        room.fields.first_name===fields.first_name && room.fields.last_name===fields.last_name &&
        (room.fields.guest_email??null)===(fields.guest_email??null) && room.fields.profile_mobile===fields.profile_mobile &&
        (room.fields.profile_email??null)===(fields.profile_email??null);
      for(const [roomIndex,room] of updated.bookings.entries()) {
        const approved=updated.field_specs.find(spec=>spec.path===`/bookings/${roomIndex}/fields/profile_create_new`)?.provenance==='staff';
        if(!sameProfile(room) || !approved || !profileReviewFor(room,locked.execution)) continue;
        room.fields.guest_profile_id=saved.data.nativeId;
        room.fields.profile_create_new=false;
        room.fields.guest_email=null;
        const selected=selectedCreateGuest(room);
        if(!selected) throw new Error('INVALID_GUEST_SELECTION');
        selections.push(selected);
      }
      const created=[...(Array.isArray(locked.stage.profile_created)?locked.stage.profile_created:[]),{booking_id:booking.id,native_id:saved.data.nativeId}];
      await tx`UPDATE nava_agent.proposal SET current=${json(updated)},stage=jsonb_set(stage-'profile_dispatch','{profile_created}',${json(created)}::jsonb),
        execution=COALESCE(execution,'{}'::jsonb)||${json({staff_guest_selections:selections})}::jsonb,updated_at=now() WHERE id=${p.id}`;
      await writeEvent(tx,lease.sessionId,'guest_profile_created',{proposal_id:p.id,job_id:job.job_id,booking_id:booking.id,native_id:saved.data.nativeId});
    });
  }
}

async function profileStageFailure(lease:LeaseFence,proposalId:string,job:z.infer<typeof queuedStage>,code:string,uncertain:boolean,nativeId:string|null=null) {
  await sql.begin(async tx=>{
    const [owner]=await tx`SELECT id FROM nava_agent.agent_session WHERE id=${lease.sessionId} AND worker_id=${lease.workerId}
      AND lease_epoch=${lease.epoch}::bigint AND lease_until>clock_timestamp() FOR NO KEY UPDATE`;
    if(!owner) throw new Error('LEASE_LOST');
    const error={code,outcome:uncertain?'uncertain':'known',operation:'staff_stage',message:uncertain?'Guest Profile outcome is unconfirmed. Check Infor before retrying.':'Infor could not create the Guest Profile.',
      recovery:uncertain?'Check the Guest Profile in Infor before any retry.':'Review the Guest Profile details.'};
    await tx`UPDATE nava_agent.proposal SET phase=${uncertain?'uncertain':'ready'},
      execution=COALESCE(execution,'{}'::jsonb)||${json({error})}::jsonb || CASE WHEN ${uncertain} THEN jsonb_build_object('profile_uncertain',COALESCE(stage->'profile_dispatch','{}'::jsonb) || ${json({native_id:nativeId})}::jsonb) ELSE '{}'::jsonb END,
      stage=NULL,updated_at=now()
      WHERE id=${proposalId} AND phase='staging' AND stage->>'job_id'=${job.job_id}`;
    await writeEvent(tx,lease.sessionId,'guest_profile_finished',{proposal_id:proposalId,job_id:job.job_id,outcome:uncertain?'uncertain':'failed'});
  });
}

export async function runStaffStage(lease: LeaseFence, registry: ToolRegistry, context: Omit<RegistryContext,'toolUseId'>) {
  const [p] = await sql`SELECT id,revision,workflow,stage,current,execution FROM nava_agent.proposal
    WHERE session_id=${lease.sessionId} AND (${staffPrepareOnly()} OR workflow='create') AND phase='staging' AND stage->>'state'='queued' ORDER BY updated_at LIMIT 1`;
  if (!p) return false;
  const job = queuedStage.parse(p.stage);
  if(staffPrepareOnly() && job.workflow==='create' && job.profile_go && !await prepareNewProfiles(lease,registry,context,p,job)) return true;
  const [latest]=await sql`SELECT current,stage FROM nava_agent.proposal WHERE id=${p.id}`;
  const profileCreated=Array.isArray(latest?.stage?.profile_created) && latest.stage.profile_created.length>0;
  const draft=proposalDraft.safeParse(latest?.current ?? p.current);
  const legacy=staffPrepareOnly()?null:createInput(p.current);
  const input=draft.success && job.source && job.workflow && job.workflow===p.workflow
    ? job.lookup ? targetStageInput(draft.data,job.workflow,job.source.property_code)
      : stageInput(draft.data,job.workflow,job.source.property_code,job.quote_id ?? null) : null;
  const binding={proposalId:p.id,revision:job.revision,jobId:job.job_id,workerId:lease.workerId,epoch:lease.epoch};
  let result:ToolResult|null=null;
  let captures:ReturnType<typeof stageFeedback>[]|undefined;
  const guestCaptures:unknown[]=[];
  if(staffPrepareOnly() && draft.success && input && job.source && job.workflow) {
    const inputs=input.workflow==='create' ? createInputs(draft.data,job.source.property_code) : null;
    if(inputs && inputs.length>1) {
      captures=[];
      for(const room of inputs) {
        const answer=await registry.runStaffStage(room,draft.data,{...binding,workflow:job.workflow,source:job.source,quoteId:job.quote_id},context);
        guestCaptures.push(answer.data);
        captures.push(stageFeedback({result:answer,workflow:'create',bookingId:room.booking.id,revision:job.revision,jobId:job.job_id}));
      }
    } else {
      const jobBinding={...binding,workflow:job.workflow,source:job.source,quoteId:job.quote_id};
      result=job.lookup && 'booking' in input && input.booking
        ? await registry.runStayLookup(job.lookup,input.booking.id,draft.data,jobBinding,context)
        : await registry.runStaffStage(input,draft.data,jobBinding,context);
    }
  } else if(legacy) {
    const answer=await registry.run('hms_prepare',legacy,{...context,toolUseId:job.job_id,staffStage:binding});
    if(answer.kind==='result') result=answer.result;
  }
  const workflow=job.workflow ?? 'create';
  const bookingId=(input && 'booking' in input ? input.booking?.id : legacy?.booking.id) ?? null;
  const first=captures?.[0];
  const failed=captures?.find(capture=>capture.error);
  const {stage,error}=captures && first ? {
    stage:{...first.stage,state:failed?'incomplete':'prepared',revision:job.revision,job_id:job.job_id,
      summary:[failed?'Some rooms could not be checked. No booking saved.':'All rooms checked in Infor. No booking saved.'],
      native_result:{...z.record(z.unknown()).parse(first.stage?.native_result ?? {}),rooms:captures.map(capture=>({
        ...z.record(z.unknown()).parse(capture.stage?.native_result ?? {}),state:capture.stage?.state ?? 'incomplete',
        observed_fields:capture.stage?.observed_fields ?? null,summary:capture.stage?.summary ?? []}))},
      display_rows:captures.flatMap((capture,index)=>(capture.stage?.display_rows ?? []).map(row=>({...row,id:`room-${index+1}-${row.id}`})))},
    error:failed?.error ?? null,
  } : stageFeedback({result,workflow,bookingId,revision:job.revision,jobId:job.job_id,quoteId:job.quote_id});
  if(profileCreated && stage) stage.summary=['Guest Profile created in Infor. Booking not saved.',...stage.summary.map(text=>text.replace('Nothing saved.','No booking saved.'))];
  if(stage && job.lookup) Object.assign(stage,{state:'target',source:job.source});
  const selections=draft.success && workflow==='create' && stage ? draft.data.bookings.flatMap((booking,index)=>{
    const selected=selectedCreateGuest(booking);
    if(!selected) return [];
    const observed=captures ? guestCaptures[index] : result?.data;
    const guest=z.object({native:z.object({applied:z.object({guest:z.object({nativeId:z.string(),firstName:z.string(),lastName:z.string()})})})}).safeParse(observed);
    const match=guest.success && guest.data.native.applied.guest.nativeId===selected.native_id &&
      guest.data.native.applied.guest.firstName.trim().toLowerCase()===selected.first_name.trim().toLowerCase() &&
      guest.data.native.applied.guest.lastName.trim().toLowerCase()===selected.last_name.trim().toLowerCase();
    return match || hasBoundCreateGuest(booking,p.execution) ? [selected] : [];
  }) : [];
  await sql.begin(async tx => {
    const [owner] = await tx`SELECT id FROM nava_agent.agent_session WHERE id=${lease.sessionId} AND worker_id=${lease.workerId}
      AND lease_epoch=${lease.epoch}::bigint AND lease_until>clock_timestamp() FOR NO KEY UPDATE`;
    if (!owner) throw new Error('LEASE_LOST');
    const updated = await tx`UPDATE nava_agent.proposal SET phase=${job.previous_phase},stage=${json(stage)},
      execution=COALESCE(execution,'{}'::jsonb)||${json({error,...(selections.length?{staff_guest_selections:selections}:{})})}::jsonb,updated_at=now()
      WHERE id=${p.id} AND revision=${job.revision} AND phase='staging' AND stage->>'job_id'=${job.job_id} RETURNING id`;
    if (!updated.length) throw new Error('STAGE_CHANGED');
    await writeEvent(tx,lease.sessionId,'stage_finished',{proposal_id:p.id,job_id:job.job_id,revision:job.revision,
      workflow,...(job.quote_id?{quote_id:job.quote_id}:{}),ok:!error,error});
  });
  return true;
}
