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
import { bindCloudAmendForm, bindCloudAmendInput, cloudAmendSelectionSchema, cloudAmendWriteState } from '../../ai/pane-cloud-amend.js';
import { cloudAmendWriteReady, labtestAmendWorkerEnabled } from '../../ai/pane-cloud-amend-readiness.js';
import { paneStayHmsTargetForTransport } from '../../ai/pane-stay-spawn-env.js';
import { CENTURION_HMS_READ_TARGET } from '../../hms/hms-read-target.js';
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
const cloudStateInput = z.object({ workItemId: uuid, source: cloudAmendSelectionSchema }).strict();
const cloudApproveInput = cloudStateInput.extend({ formDigest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const cloudEvidenceInput = cloudStateInput.extend({ eventId: uuid }).strict();
const cloudReviewInput = z.discriminatedUnion('decision', [
  z.object({ workItemId: uuid, runId: uuid, source: cloudAmendSelectionSchema, decision: z.literal('ok') }).strict(),
  z.object({ workItemId: uuid, runId: uuid, source: cloudAmendSelectionSchema,
    decision: z.literal('flag'), note: z.string().trim().min(3).max(500) }).strict(),
]);
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
  cloudAmendReady: mailboxProcedure.query(({ ctx }) => {
    const target = paneStayHmsTargetForTransport(ctx.activeTransportId);
    const targetKeys = ['propertyCode', 'secretId', 'browserSlot', 'origin', 'installationEnvName'] as const;
    const selected = target.ok ? target.target : null;
    return { ready: cloudAmendWriteReady() && labtestAmendWorkerEnabled() && selected !== null &&
      targetKeys.every((key) => selected[key] === CENTURION_HMS_READ_TARGET[key]) };
  }),
  bindCloudAmend: mailboxProcedure.input(bindCloudAmendInput).mutation(({ input, ctx }) =>
    bindCloudAmendForm({ ...input, transportId: ctx.activeTransportId }),
  ),
  cloudAmendState: mailboxProcedure.input(cloudStateInput).query(async ({ input, ctx }) => {
    const view = await cloudAmendWriteState({ ...input, transportId: ctx.activeTransportId });
    if (!view) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'state_changed' });
    return view;
  }),
  approveCloudAmend: mailboxProcedure.input(cloudApproveInput).mutation(async ({ input, ctx }) => {
    try {
      return await approveHmsWrite({ transportId: ctx.activeTransportId, actorUserId: ctx.sessionUser.id,
        sessionId: ctx.sessionUser.sessionId, sessionProfile: ctx.sessionUser.sessionProfile,
        workItemId: input.workItemId, formDigest: input.formDigest, cloudSelection: input.source });
    } catch (err) { return refusal(err); }
  }),
  reviewCloudAmend: mailboxProcedure.input(cloudReviewInput).mutation(async ({ input, ctx }) => {
    try {
      return await reviewHmsWrite({ transportId: ctx.activeTransportId, actorUserId: ctx.sessionUser.id,
        workItemId: input.workItemId, runId: input.runId, cloudSelection: input.source,
        decision: input.decision, note: input.decision === 'flag' ? input.note : undefined });
    } catch (err) { return refusal(err); }
  }),
  cloudAmendEvidence: mailboxProcedure.input(cloudEvidenceInput).query(async ({ input, ctx }) => {
    const selected = { transportId: ctx.activeTransportId, workItemId: input.workItemId, source: input.source };
    const before = await cloudAmendWriteState(selected);
    if (!before?.run?.evidence.some((row) => row.eventId === input.eventId)) {
      return { status: 'unavailable' as const, reason: 'evidence_unavailable' };
    }
    const evidence = await readHmsWriteEvidence({ transportId: ctx.activeTransportId,
      workItemId: input.workItemId, eventId: input.eventId });
    const after = await cloudAmendWriteState(selected);
    return after?.run?.runId === before.run.runId && after.run.evidence.some((row) => row.eventId === input.eventId)
      ? evidence : { status: 'unavailable' as const, reason: 'evidence_unavailable' };
  }),
  approve: mailboxProcedure.input(approveInput).mutation(async ({ input, ctx }) => {
    try {
      return await approveHmsWrite({
        transportId: ctx.activeTransportId,
        actorUserId: ctx.sessionUser.id,
        sessionId: ctx.sessionUser.sessionId,
        sessionProfile: ctx.sessionUser.sessionProfile,
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
      // A legacy reread cannot replace the source-bound Cloud preimage.
      if (Object.hasOwn(view.form, 'cloudAmend')) return { status: 'refused' as const, reason: 'amend_refresh_required' };
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
