import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  HmsApprovalError,
  approveHmsWrite,
  readHmsWriteEvidence,
} from '../../ai/hms-approval.js';
import { mailboxProcedure, router } from '../trpc.js';

const uuid = z.string().uuid();

// strict(): the client names only the work item. Grant, digests and snapshot are server-made.
const approveInput = z.object({ workItemId: uuid }).strict();
const evidenceInput = z.object({ workItemId: uuid, eventId: uuid }).strict();

function refusal(err: unknown): never {
  if (err instanceof HmsApprovalError) {
    throw new TRPCError({
      code: err.refusal === 'not_found' ? 'NOT_FOUND' : 'PRECONDITION_FAILED',
      message: err.refusal,
    });
  }
  throw err;
}

export const hmsApprovalRouter = router({
  approve: mailboxProcedure.input(approveInput).mutation(async ({ input, ctx }) => {
    try {
      return await approveHmsWrite({
        transportId: ctx.activeTransportId,
        actorUserId: ctx.sessionUser.id,
        workItemId: input.workItemId,
      });
    } catch (err) {
      return refusal(err);
    }
  }),
  evidence: mailboxProcedure.input(evidenceInput).query(({ input, ctx }) =>
    readHmsWriteEvidence({
      transportId: ctx.activeTransportId,
      workItemId: input.workItemId,
      eventId: input.eventId,
    }),
  ),
});
