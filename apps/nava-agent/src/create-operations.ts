import { z } from 'zod';
import type { ProposalOperations } from './main.js';
import { sql, json, uid } from './db.js';
import { claimGoInTransaction, writeEvent } from './session-store.js';
import { proposalDraft } from './schema.js';
import { createPilotRequested, hmsSaveEnabled } from './hms-mode.js';
import { describePrepareRejection, readPrepareRejection } from './prepare-feedback.js';
import { attachmentsUnconfirmed, completeAttachmentSnapshot, staffAttachmentsChecked } from './attachment-gate.js';
import type { LeaseFence, RegistryContext, ToolRegistry, ToolResult } from './tool-registry.js';

export const manualLabtestTarget = z.object({
  arrival_date: z.string().date(), departure_date: z.string().date(),
}).strict().refine(target => target.arrival_date >= '2027-01-01' && target.departure_date > target.arrival_date);

export function createPilotEnabled() {
  return createPilotRequested() && process.env.NAVA_QUOTE_SKELETON !== '1'
    && (process.env.NAVA_AGENT_RUNTIME ?? 'bedrock') === 'bedrock'
    && process.env.HMS_CREDENTIAL_SESSION_CAP === '2' && !!process.env.HMS_CREDENTIAL_LEASE_DATABASE_URL;
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
}).strict();

export function createPilotOperations(): ProposalOperations | undefined {
  if (!createPilotEnabled()) return;
  return {
    capabilities:{create:{stage:true,go_labtest:hmsSaveEnabled(),reconcile:false}},
    async submit(tx, request) {
      const [p] = await tx`SELECT p.*,s.config,s.status,s.mode FROM nava_agent.proposal p
        JOIN nava_agent.agent_session s ON s.id=p.session_id WHERE p.id=${request.proposalId}`;
      if (!p) return {ok:false,code:'NOT_FOUND'};
      const input = createInput(p.current);
      if (!input) return {ok:false,code:'INVALID_INPUT'};
      if (request.mode === 'labtest' && !isSeededLabtest(p.config?.manual_create_labtest, input.booking.fields)) return {ok:false,code:'FORBIDDEN'};
      if (request.operation === 'stage') {
        if (!['idle','waiting_go'].includes(p.status)) return {ok:false,code:'INVALID_PHASE'};
        if (process.env.NAVA_CREATE_PREPARE_ONLY==='1' && (!await staffAttachmentsChecked(tx,p.id,p.revision)
            || !await completeAttachmentSnapshot(tx,p.session_id,true))) {
          return {ok:false,code:attachmentsUnconfirmed.code};
        }
        const stage = queuedStage.parse({job_id:uid('stage'),revision:request.expectedRevision,actor:request.actor,previous_phase:p.phase,state:'queued'});
        await tx`UPDATE nava_agent.proposal SET phase='staging',stage=${json(stage)},execution=COALESCE(execution,'{}'::jsonb)-'error',updated_at=now() WHERE id=${request.proposalId}`;
        await writeEvent(tx,p.session_id,'stage_queued',{proposal_id:request.proposalId,...stage});
        return {ok:true,phase:'staging'};
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

const nativePrice = z.object({native:z.object({ratePlanAvailability:z.object({
  averageRate:z.string().nullable().optional(), totalRate:z.string().nullable().optional(), currency:z.string().nullable().optional(),
}).nullable().optional()})});

export async function runCreateStage(lease: LeaseFence, registry: ToolRegistry, context: Omit<RegistryContext,'toolUseId'>) {
  const [p] = await sql`SELECT id,revision,stage,current FROM nava_agent.proposal
    WHERE session_id=${lease.sessionId} AND workflow='create' AND phase='staging' AND stage->>'state'='queued' ORDER BY updated_at LIMIT 1`;
  if (!p) return false;
  const job = queuedStage.parse(p.stage);
  const input = createInput(p.current);
  const answer = input ? await registry.run('hms_prepare',input,{...context,toolUseId:job.job_id,
    staffStage:{proposalId:p.id,revision:job.revision,jobId:job.job_id,workerId:lease.workerId,epoch:lease.epoch}}) : null;
  const result: ToolResult | null = answer?.kind === 'result' ? answer.result : null;
  const price = nativePrice.safeParse(result?.data);
  const rate = price.success ? price.data.native.ratePlanAvailability : null;
  const displayRows = (rate ? [
    {label:'Average nightly rate', amount:rate.averageRate, unit:'night', native_path:'/native/ratePlanAvailability/averageRate'},
    {label:'Stay total', amount:rate.totalRate, unit:'stay', native_path:'/native/ratePlanAvailability/totalRate'},
  ] : []).filter(row => typeof row.amount === 'string' && rate?.currency).map(row => ({
    ...row,id:row.unit,booking_id:input?.booking.id ?? null,kind:'money',currency:rate?.currency,date:null,basis:'native',official:true,
  }));
  const stage = result?.ok ? {state:'prepared',revision:job.revision,summary:['HMS Prepare complete. Nothing saved.'],
    native_result:rate ?? null,display_rows:displayRows} : null;
  const prepare = readPrepareRejection(result?.data, result?.error?.code);
  const attachmentsBlocked = result?.error?.code===attachmentsUnconfirmed.code;
  const error = result?.ok ? null : {code:result?.error?.code ?? 'CREATE_PREPARE_FAILED',
    message:attachmentsBlocked ? attachmentsUnconfirmed.message : describePrepareRejection(prepare),prepare,
    outcome:'known',recovery:attachmentsBlocked ? attachmentsUnconfirmed.message : 'Review the booking fields and run Prepare again.'};
  await sql.begin(async tx => {
    const [owner] = await tx`SELECT id FROM nava_agent.agent_session WHERE id=${lease.sessionId} AND worker_id=${lease.workerId}
      AND lease_epoch=${lease.epoch}::bigint AND lease_until>clock_timestamp() FOR NO KEY UPDATE`;
    if (!owner) throw new Error('LEASE_LOST');
    const updated = await tx`UPDATE nava_agent.proposal SET phase=${job.previous_phase},stage=${json(stage)},
      execution=COALESCE(execution,'{}'::jsonb)||${json({error})}::jsonb,updated_at=now()
      WHERE id=${p.id} AND revision=${job.revision} AND phase='staging' AND stage->>'job_id'=${job.job_id} RETURNING id`;
    if (!updated.length) throw new Error('STAGE_CHANGED');
    await writeEvent(tx,lease.sessionId,'stage_finished',{proposal_id:p.id,job_id:job.job_id,revision:job.revision,ok:!!stage,error});
  });
  return true;
}
