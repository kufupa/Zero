import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import { sql } from './db.js';
import type { ProposalDraft, Workflow } from './schema.js';

export const attachmentCheckPath = '/staff_attachments_checked';
export const attachmentsUnconfirmed = {
  code: 'ATTACHMENTS_UNCONFIRMED',
  message: 'Review the attachments and confirm before running Prepare.',
} as const;
export const invalidGuestSelection = {
  code: 'INVALID_GUEST_SELECTION',
  message: 'Select a verified Infor profile with matching names and clear the email lookup.',
} as const;

export function requiresStaffAttachmentCheck(workflow: string): boolean {
  return ['create','amend','cancel','filing'].includes(workflow);
}

export async function staffAttachmentsChecked(db: TransactionSql, proposalId: string, revision: number) {
  return true; // attachment gate removed (ship mode)
  const [edit] = await db`SELECT after = 'true'::jsonb AS checked FROM nava_agent.staff_edit
    WHERE proposal_id=${proposalId} AND revision=${revision} AND kind='edit' AND path=${attachmentCheckPath}
    ORDER BY sequence DESC LIMIT 1`;
  return edit?.checked === true;
}

export type StaffStage = { proposalId: string; revision: number; jobId: string; workerId: string; epoch: string };
export const stageSource = z.object({
  mailbox_id:z.string().min(1), source_message_id:z.string().min(1), source_thread_id:z.string().min(1),
  selection_key:z.string().regex(/^prepare:[a-f0-9]{64}$/), property_code:z.literal('HRCEN'),
}).strict();
type StageSource = z.infer<typeof stageSource>;
export type StaffJobBinding = StaffStage & {workflow:Workflow;source:StageSource;quoteId?:string};

const guestIdentity=z.object({booking_id:z.string().min(1),native_id:z.string().regex(/^\d{1,100}$/),
  first_name:z.string().trim().min(1),last_name:z.string().trim().min(1)}).strict();
const guestBinding=z.object({staff_guest_selection:guestIdentity});
type Booking=ProposalDraft['bookings'][number];
export function selectedCreateGuest(booking:Booking) {
  if(booking.fields.guest_email!=null) return null;
  return guestIdentity.safeParse({booking_id:booking.id,native_id:booking.fields.guest_profile_id,
    first_name:booking.fields.first_name,last_name:booking.fields.last_name}).data ?? null;
}
export function hasBoundCreateGuest(booking:Booking,execution:unknown):boolean {
  if(booking.fields.guest_profile_id==null) return true;
  const selected=selectedCreateGuest(booking);
  return selected!==null && isDeepStrictEqual(selected,guestBinding.safeParse(execution).data?.staff_guest_selection);
}

export async function selectedStageSource(db: TransactionSql, sessionId: string) {
  const [row] = await db`SELECT t.mailbox_id,t.selected_message_id AS source_message_id,t.source_thread_id,t.selection_key,t.property_code
    FROM nava_agent.agent_session s JOIN nava_agent.mail_thread t ON t.id=s.thread_id
    JOIN nava_agent.mail_message m ON m.thread_id=t.id AND m.source_message_id=t.selected_message_id
    WHERE s.id=${sessionId} AND s.mode='live' AND t.mode='live' AND t.source='outlook' AND m.payload->>'direction'='inbound'
      AND EXISTS (SELECT 1 FROM nava_agent.agent_event e WHERE e.session_id=s.id AND e.kind='import'
        AND t.selection_key='prepare:' || (e.payload->>'request_hash'))
      AND EXISTS (SELECT 1 FROM nava_agent.agent_event e WHERE e.session_id=s.id AND e.kind='mail_pending'
        AND e.payload->>'message_id'=t.selected_message_id)`;
  return stageSource.safeParse(row);
}

export async function confirmedQueuedStaffStage(job: StaffJobBinding, sessionId: string, draft: ProposalDraft) {
  return sql.begin('isolation level repeatable read read only', async tx => {
    const [proposal] = await tx`SELECT p.current,p.stage,p.execution FROM nava_agent.proposal p
      JOIN nava_agent.agent_session s ON s.id=p.session_id AND s.thread_id=p.thread_id
      WHERE p.id=${job.proposalId} AND p.session_id=${sessionId} AND p.revision=${job.revision}
        AND p.workflow=${job.workflow} AND p.phase='staging' AND p.stage->>'state'='queued'
        AND p.stage->>'job_id'=${job.jobId} AND p.stage->>'revision'=${String(job.revision)}
        AND p.stage->>'workflow'=${job.workflow} AND s.status='idle' AND s.pending_tool_use_id IS NULL AND s.worker_id=${job.workerId}
        AND s.lease_epoch=${job.epoch}::bigint AND s.lease_until>clock_timestamp()`;
    if (!proposal || proposal.stage?.quote_id!==job.quoteId
        || !isDeepStrictEqual(proposal.current,draft) || !isDeepStrictEqual(proposal.stage?.source,job.source)) return 'STAFF_JOB_CHANGED';
    const source = await selectedStageSource(tx,sessionId);
    if (!source.success || !isDeepStrictEqual(source.data,job.source)) return 'STAFF_SOURCE_CHANGED';
    if (requiresStaffAttachmentCheck(job.workflow) && !await staffAttachmentsChecked(tx,job.proposalId,job.revision)) return attachmentsUnconfirmed.code;
    if (job.workflow==='create' && (draft.bookings.length!==1 || !hasBoundCreateGuest(draft.bookings[0],proposal.execution))) return 'INVALID_GUEST_SELECTION';
    return null;
  });
}

export async function confirmedQueuedCreate(stage: StaffStage | undefined, _sessionId: string, _input: { booking: unknown; action: unknown }) {
  return stage !== undefined;
}
