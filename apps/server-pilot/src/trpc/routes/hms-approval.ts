import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  HmsApprovalError,
  approveHmsWrite,
  prepareHmsWrite,
  publicHmsPreparedSummary,
  hmsWriteStateOf,
  readHmsWriteEvidence,
  resolveHmsNeedsCheck,
  reviewHmsWrite,
} from '../../ai/hms-approval.js';
import { bindAttachDocumentForm, parseHmsWriteForm, prepareHmsWriteSnapshot } from '../../ai/pane-hms-write.js';
import { previewFiling } from '../../ai/pane-filing-preview.js';
import { isSelectedHmsInboundMessage } from '../../ai/hms-jobs.js';
import { cancelRequestBindingFields, cancelSelectionSchema, commitCloudCancel, completeCancelRequestBinding,
  previewCloudCancel } from '../../ai/pane-cloud-cancel.js';
import { bindCloudAmendForm, bindCloudAmendInput, cloudAmendSelectionSchema, cloudAmendWriteState } from '../../ai/pane-cloud-amend.js';
import { labtestAmendWorkerEnabled } from '../../ai/pane-cloud-amend-readiness.js';
import { CENTURION_HMS_READ_TARGET } from '../../hms/hms-read-target.js';
import { paneStayHmsTargetForTransport } from '../../ai/pane-stay-spawn-env.js';
import { propertySwitchSchema, resolvePropertyScope } from '../../hms/property-registry.js';
import { mailboxProcedure, router } from '../trpc.js';

const uuid = z.string().uuid();
const selectedEmail = z.string().min(1).max(998);
const selectedSource = z.object({ threadId: z.string().min(1).max(512), messageId: z.string().min(1).max(512),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const formDigestInput = z.string().regex(/^[0-9a-f]{64}$/);
const cancelTarget = z.object({ confirmation: z.string().regex(/^\d+-\d+$/).max(100),
  arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), source: cancelSelectionSchema, ...cancelRequestBindingFields }).strict();
const cancelCommit = cancelTarget.extend({ reason: z.string().trim().min(1).max(120).refine((value) => !value.startsWith('-')),
  previewDigest: formDigestInput, cancellationNote: z.string().max(200).optional() }).strict().refine(completeCancelRequestBinding);
const cancelPreviewInput = cancelTarget.extend({ workItemId: uuid, internetMessageId: selectedEmail,
  formDigest: formDigestInput }).strict().refine(completeCancelRequestBinding);
const cloudStateInput = z.object({ workItemId: uuid, source: cloudAmendSelectionSchema }).strict();
const cloudApproveInput = cloudStateInput.extend({ formDigest: formDigestInput,
  preparedRef: uuid.optional(), expectedRevision: z.number().int().nonnegative().safe().optional(),
  propertySwitch: propertySwitchSchema.optional() }).strict();
const cloudEvidenceInput = cloudStateInput.extend({ eventId: uuid }).strict();
const cloudReviewInput = z.discriminatedUnion('decision', [
  z.object({ workItemId: uuid, runId: uuid, source: cloudAmendSelectionSchema, decision: z.literal('ok') }).strict(),
  z.object({ workItemId: uuid, runId: uuid, source: cloudAmendSelectionSchema,
    decision: z.literal('flag'), note: z.string().trim().min(3).max(500) }).strict(),
]);

// strict(): the client names the work item and the form digest it showed. Grant, HMS digest and snapshot are server-made.
const approveInput = z.object({ workItemId: uuid, internetMessageId: selectedEmail, formDigest: formDigestInput,
  selectedSource: selectedSource.optional(), cancel: cancelCommit.optional(),
  preparedRef: uuid.optional(), expectedRevision: z.number().int().nonnegative().safe().optional(),
  propertySwitch: propertySwitchSchema.optional() }).strict().refine((value) => !value.cancel ||
    (value.preparedRef === undefined && value.expectedRevision === undefined),
    'Legacy cancellation requires its native preview; durable preparation fields are not accepted here.');
const evidenceInput = z.object({ workItemId: uuid, internetMessageId: selectedEmail, eventId: uuid,
  selectedSource: selectedSource.optional() }).strict();
const stateInput = z.object({ workItemId: uuid, internetMessageId: selectedEmail, selectedSource: selectedSource.optional(),
  cancelSource: cancelSelectionSchema.optional() }).strict();
const filingDocumentSource = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const filingPreviewInput = z.object({ workItemId: uuid, sourceMessageId: z.string().min(1).max(512),
  attachmentId: z.string().min(1).max(200), confirmation: z.string().regex(/^\d+-\d+$/).max(100),
  arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), lastName: z.string().trim().min(1).max(200),
  selectedSource, documentSource: filingDocumentSource }).strict();
const bindAttachInput = filingPreviewInput.extend({ internetMessageId: selectedEmail,
  revisionSeq: z.number().int().nonnegative().safe(),
  expectedStay: z.object({ firstName: z.string().trim().min(1).max(200), status: z.string().trim().min(1).max(200),
    departure: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict() }).strict();
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
  prepare: mailboxProcedure.input(stateInput.extend({ formDigest: formDigestInput,
    confirmation: z.string().regex(/^\d+-\d+$/), arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    propertySwitch: propertySwitchSchema.optional() }).strict()).mutation(async ({ input, ctx }) => {
    try {
      if (resolvePropertyScope({ transportId: ctx.activeTransportId, propertySwitch: input.propertySwitch }).propertyCode !== 'HRCEN') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'write_unavailable' });
      }
      const view = await hmsWriteStateOf({ transportId: ctx.activeTransportId, workItemId: input.workItemId,
        selectedInternetMessageId: input.internetMessageId, selectedSource: input.selectedSource });
      if (!view || view.formDigest !== input.formDigest || view.form.confirmation !== input.confirmation ||
          view.form.arrival !== input.arrival) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'state_changed' });
      const canonicalCloudPreview = Object.hasOwn(view.form, 'cloudAmend') || Object.hasOwn(view.form, 'cloudCancel');
      if (view.form.action === 'cancel' && !canonicalCloudPreview) {
        return { status: 'refused' as const, reason: 'cancel_preview_required' };
      }
      if (!canonicalCloudPreview) {
        const snapshot = await prepareHmsWriteSnapshot({ transportId: ctx.activeTransportId, workItemId: input.workItemId,
          selectedInternetMessageId: input.internetMessageId, selectedSource: input.selectedSource,
          expectedFormDigest: input.formDigest, confirmation: input.confirmation, arrival: input.arrival });
        if (snapshot.status !== 'stored') return snapshot;
      }
      const prepared = await prepareHmsWrite({ transportId: ctx.activeTransportId, workItemId: input.workItemId,
        actorUserId: ctx.sessionUser.id, sessionId: ctx.sessionUser.sessionId,
        sessionProfile: ctx.sessionUser.sessionProfile, propertySwitch: input.propertySwitch,
        selectedInternetMessageId: input.internetMessageId, selectedSource: input.selectedSource,
        expectedFormDigest: input.formDigest });
      return { status: 'prepared' as const, ...publicHmsPreparedSummary(prepared) };
    } catch (err) { return refusal(err); }
  }),
  previewCancel: mailboxProcedure.input(cancelPreviewInput).mutation(async ({ input, ctx }) => {
    const target = paneStayHmsTargetForTransport(ctx.activeTransportId);
    if (!target.ok || target.target.propertyCode !== 'HRCEN') {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'cancel_unavailable' });
    }
    return previewCloudCancel({ transportId: ctx.activeTransportId, actorUserId: ctx.sessionUser.id,
      sessionId: ctx.sessionUser.sessionId, sessionProfile: ctx.sessionUser.sessionProfile,
      workItemId: input.workItemId, selectedInternetMessageId: input.internetMessageId,
      expectedFormDigest: input.formDigest, source: input.source, confirmation: input.confirmation,
      arrival: input.arrival, target: target.target, requestId: input.requestId,
      expectedSeq: input.expectedSeq, expectedExtractionId: input.expectedExtractionId });
  }),
  cloudAmendReady: mailboxProcedure.query(({ ctx }) => {
    const target = paneStayHmsTargetForTransport(ctx.activeTransportId);
    const targetKeys = ['propertyCode', 'secretId', 'browserSlot', 'origin', 'installationEnvName'] as const;
    const selected = target.ok ? target.target : null;
    return { ready: labtestAmendWorkerEnabled() && selected !== null &&
      targetKeys.every((key) => selected[key] === CENTURION_HMS_READ_TARGET[key]) };
  }),
  bindCloudAmend: mailboxProcedure.input(bindCloudAmendInput).mutation(({ input, ctx }) =>
    bindCloudAmendForm({ ...input, transportId: ctx.activeTransportId })),
  cloudAmendState: mailboxProcedure.input(cloudStateInput).query(async ({ input, ctx }) => {
    const view = await cloudAmendWriteState({ ...input, transportId: ctx.activeTransportId });
    if (!view) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'state_changed' });
    return view;
  }),
  approveCloudAmend: mailboxProcedure.input(cloudApproveInput).mutation(async ({ input, ctx }) => {
    try {
      return await approveHmsWrite({ transportId: ctx.activeTransportId, actorUserId: ctx.sessionUser.id,
        sessionId: ctx.sessionUser.sessionId, sessionProfile: ctx.sessionUser.sessionProfile,
        workItemId: input.workItemId, formDigest: input.formDigest, cloudSelection: input.source,
        preparedRef: input.preparedRef, expectedRevision: input.expectedRevision, propertySwitch: input.propertySwitch });
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
      // A bind refusal happens before storing the form; a later snapshot refusal may not.
      if (bound.status !== 'bound') return { ...bound, retryable: true as const };
      if (!bound.formDigest) return bound;
      const snapshot = await prepareHmsWriteSnapshot({ transportId: ctx.activeTransportId, workItemId: input.workItemId,
        selectedInternetMessageId: input.internetMessageId, selectedSource: input.selectedSource, expectedFormDigest: bound.formDigest,
        confirmation: bound.form.confirmation, arrival: bound.form.arrival });
      return snapshot.status === 'stored' ? bound : snapshot.reason === 'filing_target_changed'
        ? { ...snapshot, retryable: true as const } : snapshot;
    } catch (err) { return refusal(err); }
  }),
  approve: mailboxProcedure.input(approveInput).mutation(async ({ input, ctx }) => {
    try {
      const scope = resolvePropertyScope({ transportId: ctx.activeTransportId, propertySwitch: input.propertySwitch });
      if (scope.propertyCode !== 'HRCEN') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'write_unavailable' });
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
        preparedRef: input.preparedRef, expectedRevision: input.expectedRevision, propertySwitch: input.propertySwitch,
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
      if (Object.hasOwn(view.form, 'cloudAmend')) return { status: 'refused' as const, reason: 'amend_refresh_required' };
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
