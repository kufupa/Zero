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
import { previewFiling } from '../../ai/pane-filing-preview.js';
import { mailboxProcedure, router } from '../trpc.js';

const uuid = z.string().uuid();
const selectedEmail = z.string().min(1).max(998);

// strict(): the client names the work item and the form digest it showed. Grant, HMS digest and snapshot are server-made.
const approveInput = z.object({ workItemId: uuid, internetMessageId: selectedEmail, formDigest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const evidenceInput = z.object({ workItemId: uuid, internetMessageId: selectedEmail, eventId: uuid }).strict();
const stateInput = z.object({ workItemId: uuid, internetMessageId: selectedEmail }).strict();
const filingPreviewInput = z.object({ workItemId: uuid, sourceMessageId: z.string().min(1).max(512),
  attachmentId: z.string().min(1).max(200), confirmation: z.string().regex(/^\d+-\d+$/).max(100),
  arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), lastName: z.string().trim().min(1).max(100) }).strict();
// No HMS reader is wired here yet, so a resolve is staff saying they checked the booking in HMS, with a note.
const resolveInput = z.object({ workItemId: uuid, internetMessageId: selectedEmail, note: z.string().trim().min(3).max(500) }).strict();
// A flag must say why. An OK carries no note. Both name the run the reviewer was shown.
const reviewInput = z.discriminatedUnion('decision', [
  z.object({ workItemId: uuid, internetMessageId: selectedEmail, runId: uuid, decision: z.literal('ok') }).strict(),
  z
    .object({
      workItemId: uuid,
      internetMessageId: selectedEmail,
      runId: uuid,
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
  /** This preview makes no approval and never queues a write. */
  previewAttach: mailboxProcedure.input(filingPreviewInput).mutation(({ input, ctx }) =>
    previewFiling({ ...input, transportId: ctx.activeTransportId, actorUserId: ctx.sessionUser.id })),
  approve: mailboxProcedure.input(approveInput).mutation(async ({ input, ctx }) => {
    try {
      return await approveHmsWrite({
        transportId: ctx.activeTransportId,
        actorUserId: ctx.sessionUser.id,
        workItemId: input.workItemId,
        selectedInternetMessageId: input.internetMessageId,
        formDigest: input.formDigest,
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
        selectedInternetMessageId: input.internetMessageId,
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
        selectedInternetMessageId: input.internetMessageId,
        runId: input.runId,
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
    try {
      const view = await hmsWriteStateOf({
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
        selectedInternetMessageId: input.internetMessageId,
      });
      if (!view) throw new TRPCError({ code: 'NOT_FOUND', message: 'not_found' });
      const form = parseHmsWriteForm(view.form);
      if (!form) return { status: 'refused' as const, reason: 'form_invalid' };
      const read = await prepareHmsWriteSnapshot({
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
        selectedInternetMessageId: input.internetMessageId,
        expectedFormDigest: view.formDigest,
        confirmation: form.confirmation,
        arrival: form.arrival,
      });
      return read.status === 'stored' ? { status: 'stored' as const, readAt: read.readAt } : read;
    } catch (err) {
      return refusal(err);
    }
  }),
  writeState: mailboxProcedure.input(stateInput).query(async ({ input, ctx }) => {
    try {
      const view = await hmsWriteStateOf({
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
        selectedInternetMessageId: input.internetMessageId,
      });
      if (!view) throw new TRPCError({ code: 'NOT_FOUND', message: 'not_found' });
      return view;
    } catch (err) {
      return refusal(err);
    }
  }),
  evidence: mailboxProcedure.input(evidenceInput).query(async ({ input, ctx }) => {
    try {
      return await readHmsWriteEvidence({
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
        selectedInternetMessageId: input.internetMessageId,
        eventId: input.eventId,
      });
    } catch (err) {
      return refusal(err);
    }
  }),
});
