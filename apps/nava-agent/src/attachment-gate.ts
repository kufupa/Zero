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

export function requiresStaffAttachmentCheck(workflow: string): boolean {
  return ['create','amend','cancel','filing'].includes(workflow);
}

export async function staffAttachmentsChecked(db: TransactionSql, proposalId: string, revision: number) {
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
export type StaffJobBinding = StaffStage & {workflow:Workflow;source:StageSource};

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
    const [proposal] = await tx`SELECT p.current,p.stage FROM nava_agent.proposal p
      JOIN nava_agent.agent_session s ON s.id=p.session_id AND s.thread_id=p.thread_id
      WHERE p.id=${job.proposalId} AND p.session_id=${sessionId} AND p.revision=${job.revision}
        AND p.workflow=${job.workflow} AND p.phase='staging' AND p.stage->>'state'='queued'
        AND p.stage->>'job_id'=${job.jobId} AND p.stage->>'revision'=${String(job.revision)}
        AND p.stage->>'workflow'=${job.workflow} AND s.worker_id=${job.workerId}
        AND s.lease_epoch=${job.epoch}::bigint AND s.lease_until>clock_timestamp()`;
    if (!proposal || !isDeepStrictEqual(proposal.current,draft) || !isDeepStrictEqual(proposal.stage?.source,job.source)) return 'STAFF_JOB_CHANGED';
    const source = await selectedStageSource(tx,sessionId);
    if (!source.success || !isDeepStrictEqual(source.data,job.source)) return 'STAFF_SOURCE_CHANGED';
    if (requiresStaffAttachmentCheck(job.workflow) && !await staffAttachmentsChecked(tx,job.proposalId,job.revision)) return attachmentsUnconfirmed.code;
    return null;
  });
}

export async function confirmedQueuedCreate(stage: StaffStage | undefined, sessionId: string, input: { booking: unknown; action: unknown }) {
  if (!stage) return false;
  return sql.begin('isolation level repeatable read read only', async tx => {
    const [proposal] = await tx`SELECT p.current FROM nava_agent.proposal p
      JOIN nava_agent.agent_session s ON s.id=p.session_id AND s.thread_id=p.thread_id
      JOIN nava_agent.mail_thread t ON t.id=p.thread_id
      WHERE p.id=${stage.proposalId} AND p.session_id=${sessionId} AND p.revision=${stage.revision}
        AND p.workflow='create' AND p.phase='staging' AND p.stage->>'state'='queued'
        AND p.stage->>'job_id'=${stage.jobId} AND p.stage->>'revision'=${String(stage.revision)}
        AND t.mode='live' AND t.selection_key LIKE 'prepare:%' AND s.worker_id=${stage.workerId}
        AND s.lease_epoch=${stage.epoch}::bigint AND s.lease_until>clock_timestamp()`;
    if (!proposal || !isDeepStrictEqual(proposal.current?.bookings, [input.booking])
        || !isDeepStrictEqual(proposal.current?.actions, [input.action])) return false;
    // Import metadata is a hint. The staff edit is the trusted check for this revision.
    return staffAttachmentsChecked(tx, stage.proposalId, stage.revision);
  });
}
