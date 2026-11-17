import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql } from 'postgres';
import { sql } from './db.js';

export const attachmentCheckPath = '/staff_attachments_checked';
export const attachmentsUnconfirmed = {
  code: 'ATTACHMENTS_UNCONFIRMED',
  message: 'Check the attachments in Outlook and confirm before running Prepare.',
} as const;

export async function staffAttachmentsChecked(db: TransactionSql, proposalId: string, revision: number) {
  const [edit] = await db`SELECT after = 'true'::jsonb AS checked FROM nava_agent.staff_edit
    WHERE proposal_id=${proposalId} AND revision=${revision} AND kind='edit' AND path=${attachmentCheckPath}
    ORDER BY sequence DESC LIMIT 1`;
  return edit?.checked === true;
}

export type StaffStage = { proposalId: string; revision: number; jobId: string; workerId: string; epoch: string };

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
