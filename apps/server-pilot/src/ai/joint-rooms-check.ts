import { propertyPoolBasis, type QuoteRevision } from '../quote-proposal/quote-revision.js';
import { aiDraftGeneration, aiWorkflowRun } from '../db/schema/mail.js';
import type { StaffQuoteAttestation } from './staff-quote-workflow.js';
import { jointRoomsChecked } from './work-events.js';
import { workItem } from '../db/schema/work.js';
import type { DB } from '../db/client.js';
import { and, eq } from 'drizzle-orm';

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

/** A run the saved reply carries cannot be bound to this user, transport and thread, or has no approved revision. */
export class ReplyQuoteRunUnavailable extends Error {
  constructor() {
    super('Proposal source not found');
  }
}

/**
 * The quote runs a saved reply carries (the same stays its PDF names) that need the joint-rooms check and lack it.
 * Each run must be this user's staff quote on this transport and thread. Run inside the save's transaction: it holds a
 * share lock on each run's work item, and recordJointRoomsCheck takes an update lock on it, so an untick that races
 * the save is ordered before or after it, never between the check and the commit.
 */
export async function uncheckedReplyRuns(
  db: DB,
  scope: {
    transportId: string;
    threadId: string;
    userId: string;
    runs: readonly { workflowRunId: string; revisionRef: string }[];
  },
): Promise<{ workflowRunId: string; revisionRef: string }[]> {
  const unchecked: { workflowRunId: string; revisionRef: string }[] = [];
  for (const request of scope.runs) {
    const [bound] = await db
      .select({ run: aiWorkflowRun })
      .from(aiWorkflowRun)
      .innerJoin(aiDraftGeneration, eq(aiWorkflowRun.generationId, aiDraftGeneration.id))
      .where(
        and(
          eq(aiDraftGeneration.requestedByUserId, scope.userId),
          eq(aiWorkflowRun.id, request.workflowRunId),
          eq(aiWorkflowRun.transportId, scope.transportId),
          eq(aiWorkflowRun.threadId, scope.threadId),
        ),
      )
      .limit(1);
    const staff = bound?.run.metrics?.staffQuoteAttestation as StaffQuoteAttestation | undefined;
    const result = bound?.run.metrics?.reservationistResult as
      | { quoteRevisions?: QuoteRevision[] }
      | undefined;
    const revision = staff?.revisionIds?.includes(request.revisionRef)
      ? result?.quoteRevisions?.find((candidate) => candidate.id === request.revisionRef)
      : undefined;
    if (!bound || !revision) throw new ReplyQuoteRunUnavailable();
    if (!propertyPoolBasis(revision)) continue;
    await db
      .select({ id: workItem.id })
      .from(workItem)
      .where(
        and(
          eq(workItem.transportId, scope.transportId),
          eq(workItem.threadId, bound.run.threadId),
          eq(workItem.sourceMessageId, bound.run.triggerMessageId),
        ),
      )
      .for('share');
    if (
      await jointRoomsUnchecked(db, {
        transportId: scope.transportId,
        threadId: bound.run.threadId,
        messageId: bound.run.triggerMessageId,
        workflowRunId: bound.run.id,
        revision,
      })
    )
      unchecked.push({ workflowRunId: bound.run.id, revisionRef: revision.id });
  }
  return unchecked;
}
