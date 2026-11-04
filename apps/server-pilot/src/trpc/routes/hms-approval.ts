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
import { bindAttachDocumentForm, parseHmsWriteForm, prepareHmsWriteSnapshot } from '../../ai/pane-hms-write.js';
import { previewFiling } from '../../ai/pane-filing-preview.js';
import { isSelectedHmsInboundMessage } from '../../ai/hms-jobs.js';
import { cancelSelectionSchema, commitCloudCancel, previewCloudCancel } from '../../ai/pane-cloud-cancel.js';
import { paneStayHmsTargetForTransport } from '../../ai/pane-stay-spawn-env.js';
import { mailboxProcedure, router } from '../trpc.js';

const uuid = z.string().uuid();
const selectedEmail = z.string().min(1).max(998);
const selectedSource = z.object({ threadId: z.string().min(1).max(512), messageId: z.string().min(1).max(512),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const formDigestInput = z.string().regex(/^[0-9a-f]{64}$/);
const cancelTarget = z.object({ confirmation: z.string().regex(/^\d+-\d+$/).max(100),
  arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), source: cancelSelectionSchema }).strict();
const cancelCommit = cancelTarget.extend({ reason: z.string().trim().min(1).max(120).refine((value) => !value.startsWith('-')),
  previewDigest: formDigestInput, cancellationNote: z.string().max(200).optional() }).strict();
const cancelPreviewInput = cancelTarget.extend({ workItemId: uuid, internetMessageId: selectedEmail,
  formDigest: formDigestInput }).strict();

// strict(): the client names the work item and the form digest it showed. Grant, HMS digest and snapshot are server-made.
const approveInput = z.object({ workItemId: uuid, internetMessageId: selectedEmail, formDigest: formDigestInput,
  selectedSource: selectedSource.optional(), cancel: cancelCommit.optional() }).strict();
const evidenceInput = z.object({ workItemId: uuid, internetMessageId: selectedEmail, eventId: uuid,
  selectedSource: selectedSource.optional() }).strict();
const stateInput = z.object({ workItemId: uuid, internetMessageId: selectedEmail, selectedSource: selectedSource.optional(),
  cancelSource: cancelSelectionSchema.optional() }).strict();
const filingPreviewInput = z.object({ workItemId: uuid, sourceMessageId: z.string().min(1).max(512),
  attachmentId: z.string().min(1).max(200), confirmation: z.string().regex(/^\d+-\d+$/).max(100),
  arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), lastName: z.string().trim().min(1).max(200), selectedSource }).strict();
const bindAttachInput = filingPreviewInput.extend({ internetMessageId: selectedEmail }).strict();
// No HMS reader is wired here yet, so a resolve is staff saying they checked the booking in HMS, with a note.
const resolveInput = z.object({ workItemId: uuid, internetMessageId: selectedEmail,
  note: z.string().trim().min(3).max(500), selectedSource: selectedSource.optional() }).strict();
// A flag must say why. An OK carries no note. Both name the run the reviewer was shown.
const reviewInput = z.discriminatedUnion('decision', [
  z.object({ workItemId: uuid, internetMessageId: selectedEmail, runId: uuid, decision: z.literal('ok'),
    selectedSource: selectedSource.optional() }).strict(),
  z
    .object({
      workItemId: uuid,
      internetMessageId: selectedEmail,
      selectedSource: selectedSource.optional(),
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
  previewCancel: mailboxProcedure.input(cancelPreviewInput).mutation(async ({ input, ctx }) => {
    const target = paneStayHmsTargetForTransport(ctx.activeTransportId);
    if (!target.ok || target.target.propertyCode !== 'HRCEN') {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'cancel_unavailable' });
    }
    return previewCloudCancel({ transportId: ctx.activeTransportId, actorUserId: ctx.sessionUser.id,
      sessionId: ctx.sessionUser.sessionId, sessionProfile: ctx.sessionUser.sessionProfile,
      workItemId: input.workItemId, selectedInternetMessageId: input.internetMessageId,
      expectedFormDigest: input.formDigest, source: input.source, confirmation: input.confirmation,
      arrival: input.arrival, target: target.target });
  }),
  /** This preview makes no approval and never queues a write. */
  previewAttach: mailboxProcedure.input(filingPreviewInput).mutation(async ({ input, ctx }) => {
    const current = () => input.selectedSource.messageId === input.sourceMessageId &&
      isSelectedHmsInboundMessage({ transportId: ctx.activeTransportId, ...input.selectedSource });
    if (!await current()) return { status: 'refused' as const, reason: 'source_changed' };
    const preview = await previewFiling({ ...input, transportId: ctx.activeTransportId, actorUserId: ctx.sessionUser.id });
    return await current() ? preview : { status: 'refused' as const, reason: 'source_changed' };
  }),
  /** Binding prepares the reviewed PDF and booking; it never approves or sends the upload. */
  bindAttach: mailboxProcedure.input(bindAttachInput).mutation(async ({ input, ctx }) => {
    try {
      const target = paneStayHmsTargetForTransport(ctx.activeTransportId);
      if (!target.ok || target.target.propertyCode !== 'HRCEN') return { status: 'refused' as const, reason: 'filing_unavailable' };
      const bound = await bindAttachDocumentForm({ ...input, transportId: ctx.activeTransportId, actorUserId: ctx.sessionUser.id });
      if (bound.status !== 'bound' || !bound.formDigest) return bound;
      const snapshot = await prepareHmsWriteSnapshot({ transportId: ctx.activeTransportId, workItemId: input.workItemId,
        selectedInternetMessageId: input.internetMessageId, selectedSource: input.selectedSource, expectedFormDigest: bound.formDigest,
        confirmation: bound.form.confirmation, arrival: bound.form.arrival });
      return snapshot.status === 'stored' ? bound : snapshot;
    } catch (err) { return refusal(err); }
  }),
  approve: mailboxProcedure.input(approveInput).mutation(async ({ input, ctx }) => {
    try {
      if (input.cancel) {
        const target = paneStayHmsTargetForTransport(ctx.activeTransportId);
        if (!target.ok || target.target.propertyCode !== 'HRCEN') {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'cancel_unavailable' });
        }
        if (input.selectedSource && (input.selectedSource.threadId !== input.cancel.source.threadId ||
            input.selectedSource.messageId !== input.cancel.source.messageId ||
            input.selectedSource.sourceHash !== input.cancel.source.sourceHash)) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'source_mail_changed' });
        }
        return await commitCloudCancel({ ...input.cancel, transportId: ctx.activeTransportId,
          actorUserId: ctx.sessionUser.id, sessionId: ctx.sessionUser.sessionId, sessionProfile: ctx.sessionUser.sessionProfile,
          workItemId: input.workItemId, selectedInternetMessageId: input.internetMessageId,
          expectedFormDigest: input.formDigest, target: target.target });
      }
      return await approveHmsWrite({
        transportId: ctx.activeTransportId,
        actorUserId: ctx.sessionUser.id,
        sessionId: ctx.sessionUser.sessionId,
        sessionProfile: ctx.sessionUser.sessionProfile,
        workItemId: input.workItemId,
        selectedInternetMessageId: input.internetMessageId,
        selectedSource: input.selectedSource,
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
        selectedSource: input.selectedSource,
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
        selectedSource: input.selectedSource,
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
        selectedSource: input.selectedSource,
      });
      if (!view) throw new TRPCError({ code: 'NOT_FOUND', message: 'not_found' });
      if (Object.hasOwn(view.form, 'cloudCancel')) return { status: 'refused' as const, reason: 'cancel_preview_required' };
      const form = parseHmsWriteForm(view.form);
      if (!form) return { status: 'refused' as const, reason: 'form_invalid' };
      const read = await prepareHmsWriteSnapshot({
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
        selectedInternetMessageId: input.internetMessageId,
        selectedSource: input.selectedSource,
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
        selectedSource: input.selectedSource,
        cancelSource: input.cancelSource,
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
        selectedSource: input.selectedSource,
        eventId: input.eventId,
      });
    } catch (err) {
      return refusal(err);
    }
  }),
});
