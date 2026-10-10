import { propertyPoolBasis, type QuoteRevision } from '../quote-proposal/quote-revision.js';
import { approvedStaySpan, type StaffQuoteAttestation } from './staff-quote-workflow.js';
import { aiDraftGeneration, aiWorkflowRun } from '../db/schema/mail.js';
import { jointRoomsChecked } from './work-events.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';

/** The refusal code when HMS gave no building for 2+ room types and staff have not ticked that they checked them in HMS. */
export const JOINT_ROOMS_UNCHECKED = 'joint_rooms_unchecked';

/** True when the revision needs the staff check and the latest recorded event for its run is not a tick. */
export async function jointRoomsUnchecked(
  db: DB,
  scope: {
    transportId: string;
    threadId: string;
    messageId: string;
    workflowRunId: string;
    revision: QuoteRevision;
  },
): Promise<boolean> {
  if (!propertyPoolBasis(scope.revision)) return false;
  return !(await jointRoomsChecked(db, {
    transportId: scope.transportId,
    threadId: scope.threadId,
    messageId: scope.messageId,
    workflowRunId: scope.workflowRunId,
    revisionRef: scope.revision.id,
  }));
}

/**
 * The user's current staff quote runs on this message (newest per stay dates, as the combined quote counts them) that
 * need the joint-rooms check and lack it. A saved reply on this message is refused while any is left.
 */
export async function uncheckedJointRoomRuns(
  db: DB,
  scope: { transportId: string; threadId: string; messageId: string; userId: string },
): Promise<{ workflowRunId: string; revisionRef: string }[]> {
  const rows = await db
    .select({ run: aiWorkflowRun })
    .from(aiDraftGeneration)
    .innerJoin(aiWorkflowRun, eq(aiWorkflowRun.generationId, aiDraftGeneration.id))
    .where(
      and(
        eq(aiDraftGeneration.transportId, scope.transportId),
        eq(aiDraftGeneration.threadId, scope.threadId),
        eq(aiDraftGeneration.requestedByUserId, scope.userId),
        eq(aiDraftGeneration.model, 'staff-approved-native'),
        sql`${aiDraftGeneration.contextMessageIds} @> ${JSON.stringify([scope.messageId])}::jsonb`,
      ),
    )
    .orderBy(desc(aiDraftGeneration.createdAt));
  const approvals = rows.map(({ run }) => {
    const staff = run.metrics?.staffQuoteAttestation as StaffQuoteAttestation | undefined;
    const result = run.metrics?.reservationistResult as
      | { quoteRevisions?: QuoteRevision[] }
      | undefined;
    const revision = result?.quoteRevisions?.find(
      (candidate) => candidate.id === staff?.revisionIds?.[0],
    );
    return { run, revision, span: revision ? approvedStaySpan(revision) : null };
  });
  const unchecked: { workflowRunId: string; revisionRef: string }[] = [];
  for (const [index, approval] of approvals.entries()) {
    if (!approval.revision) continue;
    // A newer approved revision for the same dates (or for unknown dates) supersedes this one. A failed run does not.
    if (
      approvals
        .slice(0, index)
        .some((newer) => newer.revision && (newer.span === null || newer.span === approval.span))
    )
      continue;
    if (
      await jointRoomsUnchecked(db, {
        transportId: scope.transportId,
        threadId: scope.threadId,
        messageId: approval.run.triggerMessageId,
        workflowRunId: approval.run.id,
        revision: approval.revision,
      })
    )
      unchecked.push({ workflowRunId: approval.run.id, revisionRef: approval.revision.id });
  }
  return unchecked;
}
