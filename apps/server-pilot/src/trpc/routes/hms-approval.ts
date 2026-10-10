import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  HmsApprovalError,
  approveHmsWrite,
  hmsWriteStateOf,
  readHmsWriteEvidence,
  resolveHmsNeedsCheck,
  reviewHmsWrite,
} from '../../ai/hms-approval.js';
import { mailboxProcedure, router } from '../trpc.js';

const uuid = z.string().uuid();

// strict(): the client names only the work item. Grant, digests and snapshot are server-made.
const approveInput = z.object({ workItemId: uuid }).strict();
const evidenceInput = z.object({ workItemId: uuid, eventId: uuid }).strict();
const stateInput = z.object({ workItemId: uuid }).strict();
// No HMS reader is wired here yet, so a resolve is staff saying they checked the booking in HMS, with a note.
const resolveInput = z.object({ workItemId: uuid, note: z.string().trim().min(3).max(500) }).strict();
// A flag must say why. An OK carries no note.
const reviewInput = z.discriminatedUnion('decision', [
  z.object({ workItemId: uuid, decision: z.literal('ok') }).strict(),
  z
    .object({
      workItemId: uuid,
      decision: z.literal('flag'),
      note: z.string().trim().min(3).max(500),
    })
    .strict(),
]);

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
  resolveNeedsCheck: mailboxProcedure.input(resolveInput).mutation(async ({ input, ctx }) => {
    try {
      return await resolveHmsNeedsCheck({
        transportId: ctx.activeTransportId,
        actorUserId: ctx.sessionUser.id,
        workItemId: input.workItemId,
        note: input.note,
      });
    } catch (err) {
      return refusal(err);
    }
  }),
  review: mailboxProcedure.input(reviewInput).mutation(async ({ input, ctx }) => {
    try {
      return await reviewHmsWrite({
        transportId: ctx.activeTransportId,
        actorUserId: ctx.sessionUser.id,
        workItemId: input.workItemId,
        decision: input.decision,
        note: input.decision === 'flag' ? input.note : undefined,
        // U26 passes its HMS re-read here. Until then a Flag is logged with reread 'not_wired'.
      });
    } catch (err) {
      return refusal(err);
    }
  }),
  writeState: mailboxProcedure.input(stateInput).query(async ({ input, ctx }) => {
    const view = await hmsWriteStateOf({
      transportId: ctx.activeTransportId,
      workItemId: input.workItemId,
    });
    if (!view) throw new TRPCError({ code: 'NOT_FOUND', message: 'not_found' });
    return view;
  }),
  evidence: mailboxProcedure.input(evidenceInput).query(({ input, ctx }) =>
    readHmsWriteEvidence({
      transportId: ctx.activeTransportId,
      workItemId: input.workItemId,
      eventId: input.eventId,
    }),
  ),
});
