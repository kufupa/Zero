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
import { parseHmsWriteForm, prepareHmsWriteSnapshot } from '../../ai/pane-hms-write.js';
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
      });
    } catch (err) {
      return refusal(err);
    }
  }),
  /**
   * Re-reads the booking the form names and stores it as the snapshot the next approval binds (KTD11). Used after a
   * flag and when the snapshot is missing or 30 minutes old. One browser read under the property lock.
   */
  reread: mailboxProcedure.input(stateInput).mutation(async ({ input, ctx }) => {
    const view = await hmsWriteStateOf({
      transportId: ctx.activeTransportId,
      workItemId: input.workItemId,
    });
    if (!view) throw new TRPCError({ code: 'NOT_FOUND', message: 'not_found' });
    const form = parseHmsWriteForm(view.form);
    if (!form) return { status: 'refused' as const, reason: 'form_invalid' };
    try {
      const read = await prepareHmsWriteSnapshot({
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
        confirmation: form.confirmation,
        arrival: form.arrival,
      });
      return read.status === 'stored' ? { status: 'stored' as const, readAt: read.readAt } : read;
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
