import type { ReservationWorkflowV2Draft, ReservationWorkflowV2ItemInput } from '../../ai/reservation-workflow-v2-contract.js';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { aiWorkflowRun, attachment, mailThread, message } from '../../db/schema/mail.js';
import { outlookSyncObservation, outlookSyncSource } from '../../db/schema/outlook-sync.js';
import { workEvent, workItem } from '../../db/schema/work.js';
import { MESSAGE_ARRIVED_AT } from '../../ai/message-arrival-time.js';
import { staffQuoteSourceHash } from '../../ai/staff-quote-workflow.js';
import { hasRecoverableHmsOperation } from '../../ai/reservation-workflow-v2-source-recovery.js';
import { hasReservationWorkflowV2Draft, reservationWorkflowV2DraftOf } from '../../ai/reservation-workflow-v2-state.js';

async function findRecoverableExcludedSourceWorkItem(
  scoped: ReturnType<typeof context>,
  source: { messageId: string; threadId: string },
): Promise<string | null> {
  const candidates = await scoped.db
    .select({ id: workItem.id, status: workItem.status, state: workItem.state })
    .from(workItem)
    .where(and(
      eq(workItem.transportId, scoped.transportId),
      eq(workItem.threadId, source.threadId),
      eq(workItem.sourceMessageId, source.messageId),
    ))
    .orderBy(desc(workItem.updatedAt), desc(workItem.id))
    .limit(10);
  for (const row of candidates) {
    if (!hasReservationWorkflowV2Draft(row.state ?? {})) continue;
    const draft = reservationWorkflowV2DraftOf(row.state ?? {});
    if (!draft || draft.propertyCode !== scoped.propertyCode ||
        draft.source.messageId !== source.messageId ||
        draft.source.threadId !== source.threadId) continue;
    if (await hasRecoverableHmsOperation(scoped.db, { workItemId: row.id, draft })) {
      return row.id;
    }
  }
  return null;
}

async function excludedSourceReason(
  scoped: { db: ReturnType<typeof getDb>; transportId: string },
  transportEmail: string | null | undefined,
  source: { messageId: string; threadId: string },
): Promise<string | null> {
  const [sourceRow] = await scoped.db
    .select({
      fromAddress: message.fromAddress,
      subject: message.subject,
      textBody: message.textBody,
      htmlBody: message.htmlBody,
      sourceProvenance: message.sourceProvenance,
    })
    .from(message)
    .innerJoin(mailThread, and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, message.transportId)))
    .where(and(
      eq(message.transportId, scoped.transportId),
      eq(message.id, source.messageId),
      eq(message.threadId, source.threadId),
      eq(message.direction, 'inbound'),
      eq(message.historyOnly, false),
      eq(mailThread.historyOnly, false),
      isNull(mailThread.trashedAt),
      isNull(mailThread.spamAt),
    ))
    .limit(1);
  if (!sourceRow) return null;
  const [fileAttachment] = await scoped.db
    .select({ id: attachment.id })
    .from(attachment)
    .where(and(eq(attachment.messageId, source.messageId), eq(attachment.isInline, false)))
    .limit(1);
  const admission = classifyReservationWorkflowV2Source({
    fromAddress: sourceRow.fromAddress,
    subject: sourceRow.subject,
    bodyText: canonicalSourceBodyText({ textBody: sourceRow.textBody, htmlBody: sourceRow.htmlBody }),
    mailboxAddress: transportEmail ?? undefined,
    hasAttachments: fileAttachmentPresence(fileAttachment != null, sourceRow.sourceProvenance),
  });
  return admission.skippedReason ?? null;
}

async function assertNotExcludedSource(
  scoped: { db: ReturnType<typeof getDb>; transportId: string },
  transportEmail: string | null | undefined,
  source: { messageId: string; threadId: string },
): Promise<void> {
  const reason = await excludedSourceReason(scoped, transportEmail, source);
  if (reason) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Excluded ${reason} source is recovery-only; new workflow actions and edits are disabled.`,
    });
  }
}
import { canonicalJson } from '../../ai/draft-approval.js';
import { approveHmsWrite, formDigest, hmsAllocationOperationId, HmsApprovalError, prepareNativeHmsWrite, revokeUnsentFilingPreparation, type V2HmsNativePreparation } from '../../ai/hms-approval.js';
import { hmsConfigurationIdentities, hmsPreparationSchema, hmsWriteGrantV2Schema, loadHmsPreparation,
  preparationDigest } from '../../hms/hms-preparation.js';
import { propertyConfigurationForScope } from '../../hms/rate-catalogue.js';
import { stayCommitsOf } from '../../ai/work-items.js';
import {
  reservationWorkflowV2ItemInputSchema,
  reservationWorkflowV2EnsureInputSchema,
  reservationWorkflowV2EditInputSchema,
  reservationWorkflowV2ReviewInputSchema,
  reservationWorkflowV2LookupInputSchema,
  reservationWorkflowV2PrepareInputSchema,
  reservationWorkflowV2ExecuteInputSchema,
  reservationWorkflowV2ReconcileInputSchema,
  reservationWorkflowV2AddActionInputSchema, reservationWorkflowV2ChangeRowsInputSchema,
  reservationWorkflowV2SelectNativeInputSchema, reservationWorkflowV2ReviewScopeInputSchema,
  reservationWorkflowV2GuestPrepareInputSchema, reservationWorkflowV2GuestCreateInputSchema,
} from '../../ai/reservation-workflow-v2-contract.js';
import {
  getReservationWorkflowV2Draft,
  reservationWorkflowV2DraftOf,
  editReservationWorkflowV2Draft,
  reviewReservationWorkflowV2Draft,
  moveReservationWorkflowV2History,
  configureReservationWorkflowV2Filing,
  initializeReservationWorkflowV2Draft, markReservationWorkflowV2Queued, retryReservationWorkflowV2Arrival,
  markReservationWorkflowV2NativeActivity,
  reconcileReservationWorkflowV2Source,
} from '../../ai/reservation-workflow-v2-state.js';
import { classifyReservationWorkflowV2Source } from '../../ai/reservation-workflow-v2-prefill.js';
import { addReservationWorkflowV2Action, changeReservationWorkflowV2Rows,
  selectReservationWorkflowV2Native, reviewReservationWorkflowV2Scope } from '../../ai/reservation-workflow-v2-draft-commands.js';
import { reservationWorkflowV2VerifyLead } from '../../ai/reservation-workflow-v2-verify-lead.js';
import { preStaySourceText } from '../../ai/existing-stay-information.js';
import { canonicalSourceBodyText } from '../../ai/mail-source.js';
import { prefillDraft } from '../../ai/reservation-workflow-v2-prefill-service.js';
import { enqueueReservationArrival, promoteReservationArrival, reservationArrivalEnabled } from '../../ai/reservation-workflow-v2-arrival.js';
import {
  reservationWorkflowV2PreparationViews,
  reservationWorkflowV2CreatePreparation,
  reservationWorkflowV2Lookup,
  reservationWorkflowV2NativeChoices,
  reservationWorkflowV2Prepare,
  reservationWorkflowV2Reconcile,
} from '../../ai/reservation-workflow-v2-tools.js';
import {
  reservationWorkflowV2LookupServices,
  reservationWorkflowV2LookupSavedServices,
  reservationWorkflowV2PreviewSavedServices,
  reservationWorkflowV2PreviewServices,
  reservationWorkflowV2ReconcileServices,
  reservationWorkflowV2ServicesExecuteInputSchema,
} from '../../ai/reservation-workflow-v2-services.js';
import { reservationWorkflowV2SavedServicesExecuteInputSchema, reservationWorkflowV2ServicePreparation }
  from '../../ai/reservation-workflow-v2-services-execute.js';
import { reservationWorkflowV2QuoteLookup, reservationWorkflowV2QuotePrepare,
  reservationWorkflowV2QuoteExecute, reservationWorkflowV2QuoteReconcile } from '../../ai/reservation-workflow-v2-quote.js';
import { reservationWorkflowV2CancelLookup, reservationWorkflowV2CancelPrepare, reservationWorkflowV2CancelPreparation,
  reservationWorkflowV2CancelReconcile } from '../../ai/reservation-workflow-v2-cancel.js';
import { reservationWorkflowV2AmendLookup, reservationWorkflowV2AmendPrepare, reservationWorkflowV2AmendPreparation, reservationWorkflowV2AmendReviewView,
  reservationWorkflowV2AmendReconcile } from '../../ai/reservation-workflow-v2-amend.js';
import { reservationWorkflowV2FilingLookup, reservationWorkflowV2FilingPrepare, reservationWorkflowV2FilingPreparation,
  reservationWorkflowV2FilingReconcile } from '../../ai/reservation-workflow-v2-filing.js';
import { reservationWorkflowV2GuestOptions, reservationWorkflowV2PrepareGuestProfile, reservationWorkflowV2GuestProfilePreparation,
  reservationWorkflowV2ReconcileGuestProfile } from '../../ai/reservation-workflow-v2-guest.js';
import { propertySwitchSchema, resolvePropertyScope, type PropertySwitch } from '../../hms/property-registry.js';
import { bindHmsMailboxProperty, guardCenturionHmsMailboxOrigin, loadThreadMailboxHmsOriginScan }
  from '../../hms/mailbox-hms-origin-bind.js';
import { paneSourceMatchesContentHash, paneSourceContentHashSchema, paneSourceSelectionCondition, paneSourceSelectionSchema } from '../../mail/pane-source-selection.js';
import { canonicalMessageId } from '../../mail/ingest/message-id.js';
import { fileAttachmentPresence } from '../../mail/ingest/attachment-evidence.js';
import { logPaneSourceResolution } from '../../mail/pane-source-diagnostics.js';
import { mailboxProcedure, router } from '../trpc.js';
import { logReservationWorkflowFailure } from '../reservation-workflow-v2-diagnostics.js';

export const reservationWorkflowV2Procedure = mailboxProcedure.use(async ({ ctx, path, getRawInput, next }) => {
  const startedAt = Date.now();
  const result = await next();
  try {
    await logReservationWorkflowFailure({ path, rawInput: await getRawInput(),
      ...(result.ok ? { result: result.data } : { error: result.error }),
      userId: ctx.sessionUser.id, transportId: ctx.activeTransportId,
      db: getDb,
      correlationId: ctx.reqHeaders.get('x-nava-action-id'), elapsedMs: Date.now() - startedAt });
  } catch {
    // Diagnostics must never change the result of a staff operation.
  }
  return result;
});

function context(userId: string, transportId: string, propertySwitch?: PropertySwitch,
  source?: { propertyId?: 'HRCEN' | 'HRDAV' | 'HRDAVS' }) {
  try {
    const scope = resolvePropertyScope({ transportId, propertySwitch });
    if (source && (source.propertyId ?? 'HRCEN') !== scope.propertyCode) throw new Error('source_property_mismatch');
    return { db: getDb(), userId, transportId, propertyCode: scope.propertyCode };
  } catch {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Reservation tools are not available for this property and mailbox.' });
  }
}

async function nativeIssueSnapshot(ctx: Awaited<ReturnType<typeof nativeContext>>, input: ReservationWorkflowV2ItemInput) {
  const [item] = await ctx.db.select({ state: workItem.state, revision: workItem.revision, seq: workItem.revisionSeq })
    .from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, ctx.transport.id))).limit(1);
  const draft = item && reservationWorkflowV2DraftOf(item.state);
  if (!item || !draft || item.state.propertyCode !== ctx.property.propertyCode || draft.propertyCode !== ctx.property.propertyCode ||
      item.revision !== input.expectedRevision || item.seq !== input.expectedSeq) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Reservation changed; prepare it again.' });
  }
  return { expectedBusinessDigest: formDigest(item.state), expectedSourceHash: input.source.sourceHash,
    expectedRevision: input.expectedRevision, expectedSeq: input.expectedSeq };
}

async function issuePreparedV2(ctx: Awaited<ReturnType<typeof nativeContext>>, input: {
  workItemId: string; propertySwitch?: PropertySwitch;
}, native: Omit<V2HmsNativePreparation, 'policyIdentity' | 'catalogueIdentity'>,
  snapshot: Awaited<ReturnType<typeof nativeIssueSnapshot>>) {
  if (!ctx.user.sessionId || !ctx.user.sessionProfile) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'authenticated_staff_session_required' });
  const scope = resolvePropertyScope({ transportId: ctx.transport.id, propertySwitch: input.propertySwitch });
  const configuration = await propertyConfigurationForScope(scope);
  const workflow = native.operation === 'create_guest_profile' ? 'guest_profile_create'
    : native.operation === 'attach_document' ? 'attach' : native.operation === 'add_on' ? 'addons' : native.operation;
  if (configuration.capabilities[workflow].status === 'unavailable') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This workflow is not available for this property yet.' });
  }
  return prepareNativeHmsWrite({ db: ctx.db, transportId: ctx.transport.id, workItemId: input.workItemId,
    actorUserId: ctx.user.id, sessionId: ctx.user.sessionId, sessionProfile: ctx.user.sessionProfile,
    propertySwitch: input.propertySwitch, ...snapshot,
    native: { ...native, ...hmsConfigurationIdentities(scope, configuration, native.operation) } });
}

async function queuePreparedV2(ctx: Awaited<ReturnType<typeof nativeContext>>, preparedRef: string | undefined,
  endpoint: 'execute' | 'createGuestProfile' | 'executeServices' | 'executeSavedServices',
  input: { workItemId: string; expectedRevision: number; source: { threadId: string; messageId: string; sourceHash: string };
    propertySwitch?: PropertySwitch; [key: string]: unknown }) {
  if (!preparedRef || !ctx.user.sessionId || !ctx.user.sessionProfile) return { status: 'needs_prepare' as const, issue: 'staff_go_preparation_required' };
  const prepared = await ctx.db.transaction(tx => loadHmsPreparation(tx, preparedRef, input.workItemId));
  if (prepared.workflowContext?.endpoint !== endpoint || canonicalJson(prepared.workflowContext.input) !== canonicalJson(input) ||
      prepared.revision !== input.expectedRevision || prepared.scope.propertyCode !== ctx.property.propertyCode ||
      prepared.scope.transportId !== ctx.transport.id || prepared.session.actorUserId !== ctx.user.id ||
      prepared.session.sessionId !== ctx.user.sessionId || prepared.session.sessionProfile !== ctx.user.sessionProfile) {
    return { status: 'needs_prepare' as const, issue: 'staff_go_preparation_changed' };
  }
  try {
    const approved = await approveHmsWrite({ db: ctx.db, transportId: ctx.transport.id, workItemId: input.workItemId,
      actorUserId: ctx.user.id, sessionId: ctx.user.sessionId, sessionProfile: ctx.user.sessionProfile,
      propertySwitch: input.propertySwitch, preparedRef, expectedRevision: input.expectedRevision,
      selectedSource: { threadId: input.source.threadId, messageId: input.source.messageId, sourceHash: input.source.sourceHash },
      formDigest: prepared.businessDigest });
    return { status: 'queued' as const, ...approved, operationId: approved.grantId };
  } catch (error) {
    if (prepared.operation === 'attach_document' && error instanceof HmsApprovalError &&
        (error.refusal === 'snapshot_stale' || error.refusal === 'state_changed'))
      return { status: 'needs_prepare' as const, issue: 'filing_preparation_expired_or_changed' };
    throw error;
  }
}

const sourceInput = z.object({
  internetMessageId: z.string().min(1).max(998).optional(),
  contentHash: paneSourceContentHashSchema.optional(),
  selection: paneSourceSelectionSchema,
  propertySwitch: propertySwitchSchema.optional(),
}).strict();

async function nativeContext(user: { id: string; sessionId?: string; sessionProfile?: 'legacy' | 'remote' },
  transportId: string, source: ReservationWorkflowV2ItemInput['source'], propertySwitch?: PropertySwitch) {
  const scoped = context(user.id, transportId, propertySwitch, source);
  const selection = { transportId, threadId: source.threadId, messageId: source.messageId };
  if (scoped.propertyCode === 'HRCEN') {
    const origin = await guardCenturionHmsMailboxOrigin(selection);
    if (!origin.ok) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: origin.message });
  } else {
    const scan = await loadThreadMailboxHmsOriginScan(selection);
    if (!scan.selectedFound || !scan.selected || !bindHmsMailboxProperty({ transportId,
      propertyCode: scoped.propertyCode, origin: scan.selected }).ok) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This property and mailbox are not available for HMS reads.' });
    }
  }
  return { db: scoped.db, transport: { id: transportId }, user: { ...user },
    property: { propertyCode: scoped.propertyCode } };
}

/** Reclassify the bound mailbox source before creating a reservation. */
async function requireCreateSource(scoped: ReturnType<typeof context>, source: ReservationWorkflowV2ItemInput['source'], mailboxAddress: string) {
  if (!mailboxAddress.trim()) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'The mailbox address is unavailable.' });
  const [row] = await scoped.db.select({ id: message.id, threadId: message.threadId, fromAddress: message.fromAddress,
    subject: message.subject, textBody: message.textBody, htmlBody: message.htmlBody,
    sourceProvenance: message.sourceProvenance, arrivedAt: MESSAGE_ARRIVED_AT })
    .from(message).innerJoin(mailThread, and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, message.transportId)))
    .where(and(eq(message.transportId, scoped.transportId), eq(message.id, source.messageId),
      eq(message.threadId, source.threadId), eq(message.direction, 'inbound'), eq(message.historyOnly, false),
      eq(mailThread.historyOnly, false), isNull(mailThread.trashedAt), isNull(mailThread.spamAt))).limit(1);
  if (!row || row.sourceProvenance?.attention != null || !row.arrivedAt ||
      row.arrivedAt.toISOString() !== source.arrivedAt || staffQuoteSourceHash(row) !== source.sourceHash) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This email is no longer available. Reopen it and try again.' });
  }
  const [fileAttachment] = await scoped.db.select({ id: attachment.id }).from(attachment)
    .where(and(eq(attachment.messageId, row.id), eq(attachment.isInline, false))).limit(1);
  const classification = classifyReservationWorkflowV2Source({ fromAddress: row.fromAddress, subject: row.subject,
    bodyText: canonicalSourceBodyText({ textBody: row.textBody, htmlBody: row.htmlBody }), mailboxAddress,
    hasAttachments: fileAttachmentPresence(fileAttachment != null, row.sourceProvenance) });
  if (classification.skippedReason) throw new TRPCError({ code: 'FORBIDDEN',
    message: 'This email comes from an automated source; it cannot create a booking.' });
  if (classification.selfPreStay) throw new TRPCError({ code: 'FORBIDDEN',
    message: 'This pre-stay email describes an existing reservation. Choose another action.' });
}

async function withPreparation<T extends { status: string }>(reply: Promise<T>, propertyCode: string) {
  let result = await reply;
  let draft = 'draft' in result ? result.draft as ReservationWorkflowV2Draft | null : null;
  if (!draft) return { ...result, preparationViews: [] };
  // Ledger state can change without a pane revision (defer, lost lease, or terminal failure).
  if (draft.prefill?.jobRunId && ['queued', 'running', 'failed'].includes(draft.prefill.status)) {
    const [job] = await getDb().select({ state: aiWorkflowRun.state }).from(aiWorkflowRun).where(and(
      eq(aiWorkflowRun.id, draft.prefill.jobRunId), eq(aiWorkflowRun.transportId, draft.transportId),
      eq(aiWorkflowRun.triggerMessageId, draft.source.messageId), eq(aiWorkflowRun.runKind, 'reservation_prefill'))).limit(1);
    const status = job?.state === 'dead_letter' ? 'failed' : job?.state === 'superseded' ? 'superseded' :
      job?.state === 'retry_wait' || job?.state === 'queued' ? 'queued' : draft.prefill.status;
    draft = { ...draft, prefill: { ...draft.prefill, status } };
    result = { ...result, draft };
  }
  // A source can have several legacy classifications. Show their receipts
  // without guessing an allocation mapping onto the v2 draft.
  const items = await getDb().select({ id: workItem.id, state: workItem.state }).from(workItem)
    .where(and(eq(workItem.transportId, draft.transportId), eq(workItem.threadId, draft.source.threadId),
      eq(workItem.sourceMessageId, draft.source.messageId)));
  if (!items.some((item) => item.id === draft.workItemId)) return { status: 'not_found' as const, preparationViews: [] };
  const legacyCreateReceipts = items.flatMap((item) => Object.entries(stayCommitsOf(item.state)).map(([stayId, receipt]) => ({
    stayId, status: receipt.status, confirmationNumber: receipt.confirmationNumber,
  })));
  const views = reservationWorkflowV2PreparationViews(draft, propertyCode).map((view) =>
    'sourceChanged' in result && result.sourceChanged === true
      ? { ...view, current: false, issue: 'The email evidence changed; review the saved draft before native work.' } : view);
  if (!legacyCreateReceipts.length) return { ...result, preparationViews: views, legacyCreateReceipts };
  const receiptSummary = legacyCreateReceipts.slice(0, 3).map((receipt) =>
    `${receipt.stayId}: ${receipt.status}${receipt.confirmationNumber ?
      `; confirmation ${receipt.confirmationNumber.slice(0, 60)}` : '; confirmation unavailable'}`
  ).join('; ');
  const remainder = legacyCreateReceipts.length > 3 ? `; and ${legacyCreateReceipts.length - 3} more` : '';
  const warning = `Create is blocked to prevent duplicates. Review previous legacy results in Infor: ${receiptSummary}${remainder}.`;
  return { ...result, legacyCreateReceipts,
    draft: { ...draft, errors: [...draft.errors.slice(0, 99),
      { stage: 'persist' as const, code: 'legacy_create_receipts', message: warning.slice(0, 1000) }] },
    preparationViews: views.map((view) => ({ ...view, current: false, issue: 'Previous legacy Create results require review in Infor.' })) };
}

async function nativeWorkflow(
  ctx: Awaited<ReturnType<typeof nativeContext>>,
  input: z.infer<typeof reservationWorkflowV2ItemInputSchema>,
  requestId?: string,
  operationId?: string,
) {
  const current = await getReservationWorkflowV2Draft({ db: ctx.db, userId: ctx.user.id,
    transportId: ctx.transport.id, propertyCode: ctx.property.propertyCode }, input);
  if (current.status !== 'ok') return { kind: null, result: current };
  if (current.revision !== input.expectedRevision || current.seq !== input.expectedSeq) {
    return { kind: null, result: { status: 'stale_revision' as const } };
  }
  const kind = operationId ? current.draft.operationResults.find((row) => row.id === operationId)?.workflow
    : requestId ? current.draft.proposal.content.requests.find((row) => row.id === requestId)?.kind : 'create';
  if (!kind) return { kind: null, result: { status: 'not_found' as const } };
  const marked = await markReservationWorkflowV2NativeActivity({ db: ctx.db, userId: ctx.user.id,
    transportId: ctx.transport.id, propertyCode: ctx.property.propertyCode }, input);
  return marked.status === 'ok' ? { kind, result: null } : { kind: null, result: marked };
}

/** Keep recovery bound to the original operation while authenticating the current email. */
async function recoveryWorkflow(ctx: Awaited<ReturnType<typeof nativeContext>>,
  input: z.infer<typeof reservationWorkflowV2ReconcileInputSchema>) {
  const current = await getReservationWorkflowV2Draft({ db: ctx.db, userId: ctx.user.id,
    transportId: ctx.transport.id, propertyCode: ctx.property.propertyCode }, input, { allowSourceChanged: true });
  if (current.status !== 'ok') return { state: 'error' as const, result: current };
  if (!current.sourceChanged) return { state: 'unchanged' as const };
  if (current.revision !== input.expectedRevision || current.seq !== input.expectedSeq) {
    return { state: 'error' as const, result: { status: 'stale_revision' as const } };
  }
  const operation = current.draft.operationResults.find((row) => row.id === input.operationId &&
    row.generationId === current.draft.generationId && ['unknown', 'succeeded', 'failed'].includes(row.status));
  if (!operation) return { state: 'error' as const, result: { status: 'not_found' as const } };
  return { state: 'recovery' as const, kind: operation.workflow,
    scoped: { ...ctx, recovery: { workItemId: input.workItemId, operationId: operation.id,
      generationId: current.draft.generationId, currentSource: input.source } },
    input: { ...input, source: current.draft.source } };
}

/** Format alone is not enough: 2026-02-30 and month 13 must fail input, not reach the state validator. */
const isoCalendarDay = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const configureFilingInput = reservationWorkflowV2ItemInputSchema.extend({
  requestId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  attachmentId: z.string().min(1).max(500), confirmation: z.string().trim().regex(/^\d+-\d+$/).max(200).optional(),
  guestName: z.string().trim().min(1).max(300).optional(),
  bookedArrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isoCalendarDay, 'Date must be a real calendar day.').optional(),
  bookedDeparture: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isoCalendarDay, 'Date must be a real calendar day.').optional(),
  allocationTarget: z.object({ requestId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
    allocationId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/) }).strict().optional(),
  kind: z.enum(['voucher', 'payment_proof']),
}).strict().refine(input => Boolean(input.confirmation) !== Boolean(input.allocationTarget), 'Choose an existing confirmation or a new-booking room.')
  .refine(input => !input.allocationTarget || (input.guestName === undefined && input.bookedArrival === undefined &&
    input.bookedDeparture === undefined), 'Stay hints apply only to an existing reservation.')
  .refine(input => input.bookedDeparture === undefined ||
    (input.bookedArrival !== undefined && input.bookedDeparture > input.bookedArrival), 'Departure must follow arrival.');

const servicesInput = reservationWorkflowV2PrepareInputSchema.extend({
  allocationId: z.string().min(1).max(80).optional(),
  targetRef: z.object({ kind: z.literal('saved_target'), requestId: z.string().min(1).max(80),
    hintId: z.string().min(1).max(80) }).strict().optional(), serviceId: z.string().min(1).max(80).optional(),
  reviewedPrepareRef: z.string().min(1).max(160).optional(),
}).strict().refine((value) => Boolean(value.allocationId) !== Boolean(value.targetRef), 'Choose exactly one target.');

/** Source, state and tools share the authenticated mailbox; clients cannot select another hotel. */
export const reservationWorkflowV2Router = router({
  resolveSource: reservationWorkflowV2Procedure.input(sourceInput).query(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch);
    const internetMessageId = canonicalMessageId(input.internetMessageId);
    const diagnostic = { userId: ctx.sessionUser.id, sessionId: ctx.sessionUser.sessionId,
      transportId: scoped.transportId, selection: input.selection, internetMessageId: input.internetMessageId };
    const rows = await scoped.db.select({
      id: message.id, threadId: message.threadId, internetMessageId: message.messageIdHeader,
      subject: message.subject, fromAddress: message.fromAddress, textBody: message.textBody, htmlBody: message.htmlBody,
      sourceProvenance: message.sourceProvenance, arrivedAt: MESSAGE_ARRIVED_AT,
      nativeLinked: sql<boolean>`${paneSourceSelectionCondition(input.selection)}`,
    }).from(message).innerJoin(mailThread, and(eq(mailThread.id, message.threadId),
      eq(mailThread.transportId, message.transportId)))
      .where(and(eq(message.transportId, scoped.transportId), eq(message.direction, 'inbound'),
        eq(message.historyOnly, false), eq(mailThread.historyOnly, false),
        isNull(mailThread.trashedAt), isNull(mailThread.spamAt),
        paneSourceSelectionCondition(input.selection, { userId: scoped.userId, internetMessageId: input.internetMessageId, contentHash: input.contentHash }),
        input.internetMessageId !== undefined ? eq(message.messageIdHeader, internetMessageId ?? '') : undefined))
      .limit(2);
    const selected = rows.length === 1 ? rows[0] : null;
    if (selected && input.selection.kind === 'outlook' && input.contentHash && !paneSourceMatchesContentHash(selected, input.contentHash)) {
      logPaneSourceResolution({ ...diagnostic, matches: 1, result: 'content_mismatch' });
      return { status: 'source_unavailable' as const, reason: 'content_mismatch' as const };
    }
    if (!selected && rows.length === 0 && input.selection.kind === 'outlook') {
      const selection = input.selection;
      const observations = await scoped.db.select({ state: outlookSyncObservation.ingestionState,
        errorCode: outlookSyncObservation.errorCode })
        .from(outlookSyncObservation).innerJoin(outlookSyncSource,
          eq(outlookSyncSource.id, outlookSyncObservation.sourceId))
        .where(and(eq(outlookSyncSource.transportId, scoped.transportId),
          eq(outlookSyncSource.userId, scoped.userId), eq(outlookSyncSource.storeId, selection.storeId),
          sql`${outlookSyncObservation.evidence} #>> '{locator,entryId}' = ${selection.entryId}`,
          selection.folderEntryId !== undefined
            ? sql`${outlookSyncObservation.evidence} #>> '{locator,folderEntryId}' = ${selection.folderEntryId}` : undefined))
        .orderBy(sql`${outlookSyncObservation.semanticVersion} desc`).limit(1);
      const observation = observations[0];
      if (observation?.state === 'attention') {
        const reason = observation.errorCode === 'AMBIGUOUS_IDENTITY' ? 'ambiguous' as const : 'attention' as const;
        logPaneSourceResolution({ ...diagnostic, matches: 0, result: reason });
        return { status: 'source_unavailable' as const, reason };
      }
    }
    if (!selected || selected.sourceProvenance?.attention != null || !selected.arrivedAt) {
      const reason = rows.length > 1 || selected?.sourceProvenance?.attention === 'AMBIGUOUS_IDENTITY' ? 'ambiguous' as const : !selected ? 'not_found' as const
        : selected.sourceProvenance?.attention != null ? 'attention' as const : 'missing_arrival' as const;
      logPaneSourceResolution({ ...diagnostic, matches: rows.length, result: reason });
      return { status: 'source_unavailable' as const, reason };
    }
    const origin = scoped.propertyCode === 'HRCEN' ? await guardCenturionHmsMailboxOrigin({ transportId: scoped.transportId,
      threadId: selected.threadId, messageId: selected.id }) : { ok: true as const };
    if (!origin.ok) {
      logPaneSourceResolution({ ...diagnostic, matches: 1, result: 'wrong_property' });
      return { status: 'wrong_property' as const, message: origin.message };
    }
    const attachments = await scoped.db.select({ id: attachment.id, filename: attachment.filename,
      mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, isInline: attachment.isInline })
      .from(attachment).where(eq(attachment.messageId, selected.id)).limit(50);
    const [fileAttachment] = await scoped.db.select({ id: attachment.id }).from(attachment)
      .where(and(eq(attachment.messageId, selected.id), eq(attachment.isInline, false))).limit(1);
    logPaneSourceResolution({ ...diagnostic, matches: 1, result: 'ready',
      matchedBy: input.selection.kind === 'web' ? 'web' : selected.nativeLinked ? 'native' : 'mailbox-copy' });
    const admission = classifyReservationWorkflowV2Source({ fromAddress: selected.fromAddress, subject: selected.subject,
      bodyText: canonicalSourceBodyText({ textBody: selected.textBody, htmlBody: selected.htmlBody }),
      mailboxAddress: ctx.transportEmail,
      hasAttachments: fileAttachmentPresence(fileAttachment != null, selected.sourceProvenance) });
    const sourceHash = staffQuoteSourceHash(selected);
    const sourceRecoveryOnly = admission.skippedReason
      ? (await findRecoverableExcludedSourceWorkItem(scoped, { messageId: selected.id, threadId: selected.threadId })) !== null
      : false;
    return { status: 'ok' as const, propertyCode: scoped.propertyCode,
      internetMessageId: selected.internetMessageId,
      sourceText: preStaySourceText(selected.textBody, selected.htmlBody),
      sourceSubject: selected.subject ?? '', sourceSender: selected.fromAddress,
      selfPreStay: admission.selfPreStay,
      skippedSource: admission.skippedReason
        ? { kind: admission.skippedReason, source: admission.classification.source } : null,
      sourceRecoveryOnly,
      attachments,
      source: { propertyId: scoped.propertyCode, threadId: selected.threadId, messageId: selected.id,
        sourceHash, arrivedAt: selected.arrivedAt.toISOString() } };
  }),
  ensure: reservationWorkflowV2Procedure.input(reservationWorkflowV2EnsureInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch, input.source);
    const [source] = await scoped.db.select({ id: message.id, threadId: message.threadId, fromAddress: message.fromAddress,
      subject: message.subject, textBody: message.textBody, htmlBody: message.htmlBody,
      sourceProvenance: message.sourceProvenance, arrivedAt: MESSAGE_ARRIVED_AT })
      .from(message).innerJoin(mailThread, and(eq(mailThread.id, message.threadId),
        eq(mailThread.transportId, message.transportId)))
      .where(and(eq(message.transportId, scoped.transportId), eq(message.id, input.source.messageId),
        eq(message.threadId, input.source.threadId), eq(message.direction, 'inbound'),
        eq(message.historyOnly, false), eq(mailThread.historyOnly, false),
        isNull(mailThread.trashedAt), isNull(mailThread.spamAt))).limit(1);
    if (!source || source.sourceProvenance?.attention != null || !source.arrivedAt ||
      staffQuoteSourceHash(source) !== input.source.sourceHash) return { status: 'invalid_source' as const };
    const origin = scoped.propertyCode === 'HRCEN' ? await guardCenturionHmsMailboxOrigin({ transportId: scoped.transportId,
      threadId: source.threadId, messageId: source.id }) : { ok: true as const };
    if (!origin.ok) return { status: 'wrong_property' as const };
    const canonicalSource = { ...input.source, propertyId: scoped.propertyCode, arrivedAt: source.arrivedAt.toISOString() };
    const [fileAttachment] = await scoped.db.select({ id: attachment.id }).from(attachment)
      .where(and(eq(attachment.messageId, source.id), eq(attachment.isInline, false))).limit(1);
    const admission = classifyReservationWorkflowV2Source({ fromAddress: source.fromAddress, subject: source.subject,
      bodyText: canonicalSourceBodyText({ textBody: source.textBody, htmlBody: source.htmlBody }),
      mailboxAddress: ctx.transportEmail,
      hasAttachments: fileAttachmentPresence(fileAttachment != null, source.sourceProvenance) });
    if (admission.skippedReason) {
      const recoverableWorkItemId = await findRecoverableExcludedSourceWorkItem(scoped, {
        messageId: source.id,
        threadId: source.threadId,
      });
      if (!recoverableWorkItemId) {
        return { status: 'skipped' as const, reason: `Known ${admission.skippedReason} source is excluded.`,
          skippedSource: { kind: admission.skippedReason, source: admission.classification.source } };
      }
      return withPreparation(
        getReservationWorkflowV2Draft(
          scoped,
          { workItemId: recoverableWorkItemId, source: canonicalSource },
          { allowSourceChanged: true, recoverSourceFields: false },
        ),
        scoped.propertyCode,
      );
    }
    const initialized = await initializeReservationWorkflowV2Draft(scoped, canonicalSource, { allowSourceChanged: true });
    // Staff opened an email whose arrival job is still waiting: move that job ahead of newly admitted mail.
    const waitingJobId = initialized.status === 'ok' && !initialized.sourceChanged &&
      ['queued', 'running'].includes(initialized.draft.prefill?.status ?? '') ? initialized.draft.prefill?.jobRunId : undefined;
    if (waitingJobId) await promoteReservationArrival(scoped.db, { transportId: scoped.transportId, jobRunId: waitingJobId });
    if (initialized.status !== 'ok' || initialized.sourceChanged || input.mode === 'initialize')
      return withPreparation(Promise.resolve(initialized), scoped.propertyCode);
    const item = { workItemId: initialized.draft.workItemId, source: canonicalSource,
      expectedRevision: initialized.revision, expectedSeq: initialized.seq };
    if (!['HRCEN', 'HRDAV'].includes(scoped.propertyCode) || !reservationArrivalEnabled()) return withPreparation(prefillDraft(scoped, item, ctx.transportEmail, false), scoped.propertyCode);
    if (initialized.draft.prefill?.status !== 'idle') return withPreparation(Promise.resolve(initialized), scoped.propertyCode);
    const job = await enqueueReservationArrival(scoped.db, { transportId: scoped.transportId, messageId: canonicalSource.messageId, requestedByPane: true });
    return withPreparation(job ? markReservationWorkflowV2Queued(scoped, { ...item, jobRunId: job.id })
      : scoped.propertyCode === 'HRDAV' ? prefillDraft(scoped, item, ctx.transportEmail, false) : Promise.resolve(initialized), scoped.propertyCode);
  }),
  prefill: reservationWorkflowV2Procedure.input(reservationWorkflowV2ItemInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch, input.source);
    await assertNotExcludedSource(scoped, ctx.transportEmail, input.source);
    if (!['HRCEN', 'HRDAV'].includes(scoped.propertyCode) || !reservationArrivalEnabled()) return withPreparation(prefillDraft(scoped, input, ctx.transportEmail, true), scoped.propertyCode);
    const current = await getReservationWorkflowV2Draft(scoped, input);
    if (current.status !== 'ok' || current.revision !== input.expectedRevision || current.seq !== input.expectedSeq ||
        current.draft.prefill?.status === 'complete' || current.draft.prefill?.status === 'superseded')
      return withPreparation(Promise.resolve(current), scoped.propertyCode);
    const job = await enqueueReservationArrival(scoped.db, { transportId: scoped.transportId,
      messageId: input.source.messageId, requestedByPane: true });
    if (!job) return withPreparation(scoped.propertyCode === 'HRDAV'
      ? prefillDraft(scoped, input, ctx.transportEmail, true) : Promise.resolve(current), scoped.propertyCode);
    if (['dead_letter', 'succeeded', 'retry_wait'].includes(job.state))
      return withPreparation(retryReservationWorkflowV2Arrival(scoped, { ...input, jobRunId: job.id }), scoped.propertyCode);
    return withPreparation(markReservationWorkflowV2Queued(scoped, { ...input, jobRunId: job.id }), scoped.propertyCode);
  }),
  get: reservationWorkflowV2Procedure.input(reservationWorkflowV2ItemInputSchema).query(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch, input.source);
    const excluded = (await excludedSourceReason(scoped, ctx.transportEmail, input.source)) !== null;
    const result = excluded
      ? await getReservationWorkflowV2Draft(scoped, input, { allowSourceChanged: true, recoverSourceFields: false })
      : await withPreparation(getReservationWorkflowV2Draft(scoped, input,
          { allowSourceChanged: true, recoverSourceFields: true }), scoped.propertyCode);
    if (!('draft' in result) || !result.draft || result.status !== 'ok' ||
        !ctx.sessionUser.sessionId || !ctx.sessionUser.sessionProfile) return result;
    const draft = result.draft;
    const sourceChanged = 'sourceChanged' in result && result.sourceChanged === true;
    const [item] = await scoped.db.select({ state: workItem.state }).from(workItem).where(and(
      eq(workItem.id, input.workItemId), eq(workItem.transportId, scoped.transportId))).limit(1);
    if (!item) return result;
    const events = await scoped.db.select({ type: workEvent.type, value: workEvent.value,
      actorKind: workEvent.actorKind, payloadHash: workEvent.payloadHash }).from(workEvent)
      .where(and(eq(workEvent.workItemId, input.workItemId),
        sql`${workEvent.type} in ('hms.prepared', 'hms.prepare.revoked', 'approval.granted', 'hms.dispatch.reviewed')`))
      .orderBy(desc(workEvent.at), desc(workEvent.id)).limit(1000);
    const allPreparations = events.flatMap(event => {
      if (event.type !== 'hms.prepared') return [];
      const parsed = hmsPreparationSchema.safeParse(event.value);
      if (!parsed.success) return [];
      const saved = parsed.data;
      return saved.workflowContext && saved.scope.propertyCode === scoped.propertyCode &&
        saved.scope.transportId === scoped.transportId && saved.session.actorUserId === ctx.sessionUser.id &&
        saved.session.sessionId === ctx.sessionUser.sessionId && saved.session.sessionProfile === ctx.sessionUser.sessionProfile &&
        saved.source.threadId === draft.source.threadId && saved.source.sourceMessageId === draft.source.messageId &&
        saved.source.sourceHash === draft.source.sourceHash ? [saved] : [];
    });
    const grants = events.flatMap(event => {
      if (event.type !== 'approval.granted') return [];
      const parsed = hmsWriteGrantV2Schema.safeParse(event.value);
      return parsed.success && allPreparations.some(saved => saved.preparedRef === parsed.data.preparedRef) ? [parsed.data] : [];
    });
    const granted = new Set(grants.map(grant => grant.preparedRef));
    for (const event of events) {
      if (event.type !== 'hms.prepare.revoked' || event.actorKind !== 'system') continue;
      const value = z.object({ preparedRef: z.string().uuid() }).safeParse(event.value);
      if (value.success) granted.add(value.data.preparedRef);
    }
    const runs = grants.length ? await scoped.db.select({ id: aiWorkflowRun.id, state: aiWorkflowRun.state,
      idempotencyKey: aiWorkflowRun.idempotencyKey, failureClass: aiWorkflowRun.failureClass }).from(aiWorkflowRun).where(and(
        eq(aiWorkflowRun.workItemId, input.workItemId), eq(aiWorkflowRun.transportId, scoped.transportId),
        eq(aiWorkflowRun.runKind, 'hms_write'), inArray(aiWorkflowRun.idempotencyKey, grants.map(grant => `hms-write:${grant.grantId}`)),
        inArray(aiWorkflowRun.state, ['queued', 'claimed', 'running', 'retry_wait', 'dead_letter', 'superseded', 'succeeded']))) : [];
    const preparations = allPreparations.filter(saved => !sourceChanged && saved.generationId === draft.generationId &&
      saved.revision === result.revision && saved.workflowContext?.input.expectedSeq === result.seq &&
      saved.businessDigest === formDigest(item.state) && Date.parse(saved.expiresAt) > Date.now() && !granted.has(saved.preparedRef));
    const workflowDispatches = grants.flatMap(grant => {
      const saved = allPreparations.find(entry => entry.preparedRef === grant.preparedRef);
      const captured = saved?.workflowContext;
      if (!saved || !captured) return [];
      const run = runs.find(entry => entry.idempotencyKey === `hms-write:${grant.grantId}`);
      const terminal = !run || ['dead_letter', 'superseded', 'succeeded'].includes(run.state);
      const operationIds = grant.operation === 'create' && saved.allocations
        ? saved.allocations.map(allocation => hmsAllocationOperationId(grant.grantId, allocation.allocationId)) : [grant.grantId];
      const results = operationIds.map(id => draft.operationResults.find(operation => operation.id === id));
      const amendReview = grant.operation === 'amend' && captured.input.allocationId
        ? reservationWorkflowV2AmendReviewView(draft, captured.input.requestId, captured.input.allocationId) : null;
      const financialReview = amendReview?.financialReview && typeof amendReview.financialReview === 'object'
        ? amendReview.financialReview as { observationRef?: unknown; approvalDigest?: unknown } : null;
      const reviewEvents = events.filter(event => {
        if (event.type !== 'hms.dispatch.reviewed' || event.actorKind !== 'system' ||
            event.payloadHash !== preparationDigest(grant)) return false;
        const evidence = z.object({ version: z.literal(1), runId: z.string().uuid(), grantId: z.string().uuid(),
          preparedRef: z.string().uuid(), payloadHash: z.string(), propertyCode: z.string(), observationRef: z.string(),
          requestId: z.string(), allocationId: z.string(), holdId: z.string().uuid(), callbackReviewDigest: z.string(),
          freshReadbackDigest: z.string().regex(/^[a-f0-9]{64}$/), finalSave: z.literal(false) }).strict().safeParse(event.value);
        return evidence.success && evidence.data.runId === run?.id && evidence.data.grantId === grant.grantId &&
          evidence.data.preparedRef === grant.preparedRef && evidence.data.payloadHash === event.payloadHash &&
          evidence.data.propertyCode === grant.propertyCode && evidence.data.requestId === captured.input.requestId &&
          evidence.data.allocationId === captured.input.allocationId && evidence.data.observationRef === financialReview?.observationRef &&
          evidence.data.callbackReviewDigest === financialReview?.approvalDigest;
      });
      const verifiedReview = !!run && amendReview?.status === 'needs_review' &&
        amendReview.operationId === grant.grantId && reviewEvents.length === 1;
      const status = !terminal ? run!.state : verifiedReview ? 'needs_review' as const
        : results.every(row => row?.status === 'succeeded') ? 'succeeded' as const
        : results.every(row => row && (row.status === 'succeeded' || row.status === 'failed')) && results.some(row => row?.status === 'failed')
          ? 'failed' as const : 'needs_reconcile' as const;
      return [{ endpoint: captured.endpoint, requestId: captured.input.requestId,
        ...(captured.input.allocationId ? { allocationId: captured.input.allocationId } : {}),
        ...('serviceId' in captured.input ? { serviceId: captured.input.serviceId } : {}),
        runId: run?.id ?? null, grantId: grant.grantId, operationId: grant.grantId, preparedRef: grant.preparedRef, status,
        // Only closed codes leave the server; never expose stored error text.
        ...(run?.failureClass && ['failed', 'needs_reconcile', 'retry_wait'].includes(status)
          ? { failureClass: ['BEDROCK_TRANSIENT', 'ARTIFACT_TRANSIENT', 'AUDIT_CAPTURE', 'STAFF_QUOTE_ACTIVE',
            'WORKER_SHUTDOWN', 'HMS_OUTAGE', 'UNKNOWN'].includes(run.failureClass) ? run.failureClass : 'UNKNOWN' } : {}) }];
    });
    const workflowPreparations = preparations.flatMap(saved => {
      const captured = saved.workflowContext;
      if (!captured || saved.operation === 'create') return [];
      return [{ endpoint: captured.endpoint, requestId: captured.input.requestId,
        ...(captured.input.allocationId ? { allocationId: captured.input.allocationId } : {}),
        ...('serviceId' in captured.input ? { serviceId: captured.input.serviceId } : {}),
        ...('targetRef' in captured.input ? { targetRef: captured.input.targetRef } : {}),
        ...('reviewedPrepareRef' in captured.input && captured.input.reviewedPrepareRef
          ? { reviewedPrepareRef: captured.input.reviewedPrepareRef } : {}),
        ...('prepareRef' in captured.input ? { prepareRef: captured.input.prepareRef } : {}),
        preparedRef: saved.preparedRef, expectedRevision: saved.revision, generationId: saved.generationId }];
    });
    return { ...result, workflowPreparations, workflowDispatches, preparationViews: result.preparationViews.map(view => {
      const pending = grants.flatMap(grant => {
        const saved = allPreparations.find(entry => entry.preparedRef === grant.preparedRef);
        if (saved?.operation !== 'create' || saved.workflowContext?.endpoint !== 'execute' ||
            saved.workflowContext.input.requestId !== view.requestId ||
            !saved.allocations?.some(allocation => allocation.allocationId === view.allocationId)) return [];
        const run = runs.find(entry => entry.idempotencyKey === `hms-write:${grant.grantId}`);
        const finished = !run || ['dead_letter', 'superseded', 'succeeded'].includes(run.state);
        const operationId = hmsAllocationOperationId(grant.grantId, view.allocationId);
        const closed = draft.operationResults.some(operation => operation.id === operationId &&
          (operation.status === 'succeeded' || operation.status === 'failed'));
        return !(finished && closed) ? [{ grant, run, finished, operationId }] : [];
      })[0];
      if (pending) return { ...view, current: false, dispatch: { status: pending.finished ? 'needs_reconcile' as const : pending.run!.state,
        requestId: view.requestId, allocationId: view.allocationId, runId: pending.run?.id ?? null, grantId: pending.grant.grantId,
        operationId: pending.operationId } };
      const saved = preparations.find(entry => entry.operation === 'create' && entry.workflowContext?.endpoint === 'execute' &&
        entry.workflowContext.input.requestId === view.requestId && entry.allocations?.some(allocation => allocation.allocationId === view.allocationId));
      return saved && view.current ? { ...view, preparedRef: saved.preparedRef,
        expectedRevision: saved.revision, generationId: saved.generationId } : view;
    }) };
  }),
  revokeUnsentFiling: reservationWorkflowV2Procedure.input(reservationWorkflowV2ItemInputSchema.extend({
    requestId: z.string().min(1), preparedRef: z.string().uuid(),
  }).strict()).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch, input.source);
    if (!ctx.sessionUser.sessionId || !ctx.sessionUser.sessionProfile)
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'authenticated_staff_session_required' });
    const status = await revokeUnsentFilingPreparation({ db: scoped.db, transportId: scoped.transportId,
      workItemId: input.workItemId, actorUserId: ctx.sessionUser.id, sessionId: ctx.sessionUser.sessionId,
      sessionProfile: ctx.sessionUser.sessionProfile, propertySwitch: input.propertySwitch,
      selectedSource: { threadId: input.source.threadId, messageId: input.source.messageId, sourceHash: input.source.sourceHash },
      requestId: input.requestId, preparedRef: input.preparedRef });
    return { status };
  }),
  reconcileSource: reservationWorkflowV2Procedure.input(reservationWorkflowV2ItemInputSchema.extend({ confirmed: z.literal(true) })).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch, input.source);
    await assertNotExcludedSource(scoped, ctx.transportEmail, input.source);
    return withPreparation(reconcileReservationWorkflowV2Source(scoped, input), scoped.propertyCode);
  }),
  edit: reservationWorkflowV2Procedure.input(reservationWorkflowV2EditInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch, input.source);
    await assertNotExcludedSource(scoped, ctx.transportEmail, input.source);
    return withPreparation(editReservationWorkflowV2Draft(scoped, { ...input, value: input.value }), scoped.propertyCode);
  }),
  addAction: reservationWorkflowV2Procedure.input(reservationWorkflowV2AddActionInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch, input.source);
    await assertNotExcludedSource(scoped, ctx.transportEmail, input.source);
    if (input.kind === 'create') await requireCreateSource(scoped, input.source, ctx.transportEmail);
    return withPreparation(addReservationWorkflowV2Action(scoped, input), scoped.propertyCode);
  }),
  changeRows: reservationWorkflowV2Procedure.input(reservationWorkflowV2ChangeRowsInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch, input.source);
    await assertNotExcludedSource(scoped, ctx.transportEmail, input.source);
    return withPreparation(changeReservationWorkflowV2Rows(scoped, input), scoped.propertyCode);
  }),
  selectNative: reservationWorkflowV2Procedure.input(reservationWorkflowV2SelectNativeInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch, input.source);
    await assertNotExcludedSource(scoped, ctx.transportEmail, input.source);
    return withPreparation(selectReservationWorkflowV2Native(scoped, input), scoped.propertyCode);
  }),
  verifyNativeLead: reservationWorkflowV2Procedure.input(reservationWorkflowV2SelectNativeInputSchema).mutation(async ({ input, ctx, signal }) => {
    const native = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source, input.propertySwitch);
    const scoped = { db: native.db, transportId: native.transport.id, userId: native.user.id,
      propertyCode: native.property.propertyCode };
    await assertNotExcludedSource(scoped, ctx.transportEmail, input.source);
    const timeout = AbortSignal.timeout(120_000);
    return withPreparation(reservationWorkflowV2VerifyLead(scoped, input,
      signal ? AbortSignal.any([signal, timeout]) : timeout), scoped.propertyCode);
  }),
  reviewScope: reservationWorkflowV2Procedure.input(reservationWorkflowV2ReviewScopeInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch, input.source);
    await assertNotExcludedSource(scoped, ctx.transportEmail, input.source);
    return withPreparation(reviewReservationWorkflowV2Scope(scoped, input), scoped.propertyCode);
  }),
  review: reservationWorkflowV2Procedure.input(reservationWorkflowV2ReviewInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch, input.source);
    await assertNotExcludedSource(scoped, ctx.transportEmail, input.source);
    return withPreparation(reviewReservationWorkflowV2Draft(scoped, input), scoped.propertyCode);
  }),
  undo: reservationWorkflowV2Procedure.input(reservationWorkflowV2ItemInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch, input.source);
    await assertNotExcludedSource(scoped, ctx.transportEmail, input.source);
    return withPreparation(moveReservationWorkflowV2History(scoped, { ...input, direction: 'undo' }), scoped.propertyCode);
  }),
  redo: reservationWorkflowV2Procedure.input(reservationWorkflowV2ItemInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch, input.source);
    await assertNotExcludedSource(scoped, ctx.transportEmail, input.source);
    return withPreparation(moveReservationWorkflowV2History(scoped, { ...input, direction: 'redo' }), scoped.propertyCode);
  }),
  configureFiling: reservationWorkflowV2Procedure.input(configureFilingInput).mutation(async ({ input, ctx }) => {
    const native = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source, input.propertySwitch);
    const scoped = { db: native.db, transportId: native.transport.id, userId: native.user.id,
      propertyCode: native.property.propertyCode };
    await assertNotExcludedSource(scoped, ctx.transportEmail, input.source);
    return withPreparation(configureReservationWorkflowV2Filing(scoped, input), scoped.propertyCode);
  }),
  lookup: reservationWorkflowV2Procedure.input(reservationWorkflowV2LookupInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source, input.propertySwitch);
    const workflow = await nativeWorkflow(scoped, input, input.requestId);
    if (workflow.result) return workflow.result;
    if (input.nativeFieldPath) return reservationWorkflowV2NativeChoices(scoped, input);
    if (workflow.kind === 'quote') return reservationWorkflowV2QuoteLookup(scoped, input);
    if (workflow.kind === 'filing') return reservationWorkflowV2FilingLookup(scoped, input);
    if (workflow.kind === 'create') return reservationWorkflowV2Lookup(scoped, input);
    if (workflow.kind === 'cancel') return reservationWorkflowV2CancelLookup(scoped, input);
    if (workflow.kind === 'amend') return reservationWorkflowV2AmendLookup(scoped, input);
    return { status: 'unsupported', issue: 'workflow_connection_not_ready' };
  }),
  guestProfileOptions: reservationWorkflowV2Procedure.input(reservationWorkflowV2GuestPrepareInputSchema.extend({
    field: z.enum(['title', 'phoneType', 'emailType']),
  }).strict()).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source, input.propertySwitch);
    const workflow = await nativeWorkflow(scoped, input, input.requestId);
    if (workflow.result) return workflow.result;
    if (workflow.kind !== 'create') return { status: 'unsupported' as const, issue: 'create_request_required' };
    return reservationWorkflowV2GuestOptions(scoped, input);
  }),
  prepareGuestProfile: reservationWorkflowV2Procedure.input(reservationWorkflowV2GuestPrepareInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source, input.propertySwitch);
    await assertNotExcludedSource({ db: scoped.db, transportId: scoped.transport.id }, ctx.transportEmail, input.source);
    const workflow = await nativeWorkflow(scoped, input, input.requestId);
    if (workflow.result) return workflow.result;
    if (workflow.kind !== 'create') return { status: 'unsupported' as const, issue: 'create_request_required' };
    const snapshot = await nativeIssueSnapshot(scoped, input);
    const result = await reservationWorkflowV2PrepareGuestProfile(scoped, input);
    if (result.status !== 'prepared') return result;
    const native = await reservationWorkflowV2GuestProfilePreparation(scoped, input, result.prepareRef);
    if (!native) return { status: 'needs_prepare' as const, issue: 'guest_profile_preparation_changed' };
    const prepared = await issuePreparedV2(scoped, input, native, snapshot);
    return { ...result, preparedRef: prepared.preparedRef, expectedRevision: prepared.revision, generationId: prepared.generationId };
  }),
  createGuestProfile: reservationWorkflowV2Procedure.input(reservationWorkflowV2GuestCreateInputSchema.extend({
    preparedRef: z.string().uuid().optional() }).strict()).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source, input.propertySwitch);
    await assertNotExcludedSource({ db: scoped.db, transportId: scoped.transport.id }, ctx.transportEmail, input.source);
    await requireCreateSource(context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch, input.source), input.source, ctx.transportEmail);
    const { preparedRef, go: _go, idempotencyKey: _key, ...captured } = input;
    return queuePreparedV2(scoped, preparedRef, 'createGuestProfile', captured);
  }),
  prepare: reservationWorkflowV2Procedure.input(reservationWorkflowV2PrepareInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source, input.propertySwitch);
    await assertNotExcludedSource({ db: scoped.db, transportId: scoped.transport.id }, ctx.transportEmail, input.source);
    const workflow = await nativeWorkflow(scoped, input, input.requestId);
    if (workflow.result) return workflow.result;
    if (workflow.kind === 'quote') return reservationWorkflowV2QuotePrepare(scoped, input);
    const snapshot = await nativeIssueSnapshot(scoped, input);
    if (workflow.kind === 'create') {
      const existing = await reservationWorkflowV2CreatePreparation(scoped, input);
      if (existing) {
        const prepared = await issuePreparedV2(scoped, input, existing, snapshot);
        return { status: 'prepared' as const, requestId: input.requestId, allocationId: input.allocationId,
          preparedRef: prepared.preparedRef, expectedRevision: prepared.revision, generationId: prepared.generationId };
      }
      const result = await reservationWorkflowV2Prepare(scoped, input);
      if (result.status !== 'prepared' || typeof result.observationRef !== 'string') return result;
      const native = await reservationWorkflowV2CreatePreparation(scoped, input, result.observationRef);
      if (!native) return { ...result, issue: 'batch_preparations_incomplete' };
      const prepared = await issuePreparedV2(scoped, input, native, snapshot);
      return { ...result, preparedRef: prepared.preparedRef, expectedRevision: prepared.revision, generationId: prepared.generationId };
    }
    if (workflow.kind === 'amend' || workflow.kind === 'cancel') {
      // A staff review binds an existing preview; retain it instead of replacing the reviewed observation.
      const existing = workflow.kind === 'amend' ? await reservationWorkflowV2AmendPreparation(scoped, input)
        : await reservationWorkflowV2CancelPreparation(scoped, input);
      if (existing) {
        const prepared = await issuePreparedV2(scoped, input, existing, snapshot);
        return { status: 'prepared' as const, requestId: input.requestId, allocationId: input.allocationId,
          preparedRef: prepared.preparedRef, expectedRevision: prepared.revision, generationId: prepared.generationId };
      }
      const result = workflow.kind === 'amend' ? await reservationWorkflowV2AmendPrepare(scoped, input)
        : await reservationWorkflowV2CancelPrepare(scoped, input);
      if (result.status !== 'prepared') return result;
      const native = workflow.kind === 'amend' ? await reservationWorkflowV2AmendPreparation(scoped, input)
        : await reservationWorkflowV2CancelPreparation(scoped, input);
      if (!native) return result; // Cancellation waits for its explicit financial review.
      const prepared = await issuePreparedV2(scoped, input, native, snapshot);
      return { ...result, preparedRef: prepared.preparedRef, expectedRevision: prepared.revision, generationId: prepared.generationId };
    }
    if (workflow.kind === 'filing') {
      const result = await reservationWorkflowV2FilingPrepare(scoped, input);
      if (result.status !== 'prepared') return result;
      const native = await reservationWorkflowV2FilingPreparation(scoped, input);
      if (!native) return { status: 'needs_prepare', issue: 'filing_preparation_changed' };
      const prepared = await issuePreparedV2(scoped, input, native, snapshot);
      return { ...result, preparedRef: prepared.preparedRef, expectedRevision: prepared.revision, generationId: prepared.generationId };
    }
    return { status: 'unsupported', issue: 'workflow_connection_not_ready' };
  }),
  execute: reservationWorkflowV2Procedure.input(reservationWorkflowV2ExecuteInputSchema.extend({
    preparedRef: z.string().uuid().optional() }).strict()).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source, input.propertySwitch);
    await assertNotExcludedSource({ db: scoped.db, transportId: scoped.transport.id }, ctx.transportEmail, input.source);
    const workflow = await nativeWorkflow(scoped, input, input.requestId);
    if (workflow.result) return workflow.result;
    const { preparedRef, ...nativeInput } = input;
    if (workflow.kind === 'quote') return reservationWorkflowV2QuoteExecute(scoped, nativeInput);
    if (workflow.kind === 'create') {
      await requireCreateSource(context(ctx.sessionUser.id, ctx.activeTransportId, input.propertySwitch, input.source), input.source, ctx.transportEmail);
    }
    if (!['create', 'filing', 'cancel', 'amend'].includes(workflow.kind ?? '')) return { status: 'unsupported', issue: 'workflow_connection_not_ready' };
    const { go: _go, idempotencyKey: _key, ...captured } = nativeInput;
    return queuePreparedV2(scoped, preparedRef, 'execute', captured);
  }),
  lookupServices: reservationWorkflowV2Procedure.input(servicesInput).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source, input.propertySwitch);
    const marked = await markReservationWorkflowV2NativeActivity({ db: scoped.db, userId: scoped.user.id,
      transportId: scoped.transport.id, propertyCode: scoped.property.propertyCode }, input);
    if (marked.status !== 'ok') return marked;
    if (input.targetRef) return reservationWorkflowV2LookupSavedServices(scoped, { ...input, targetRef: input.targetRef });
    if (!input.allocationId) return { status: 'unsupported' as const, issue: 'service_target_required' };
    return reservationWorkflowV2LookupServices(scoped, { ...input, allocationId: input.allocationId });
  }),
  prepareServices: reservationWorkflowV2Procedure.input(servicesInput).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source, input.propertySwitch);
    await assertNotExcludedSource({ db: scoped.db, transportId: scoped.transport.id }, ctx.transportEmail, input.source);
    const marked = await markReservationWorkflowV2NativeActivity({ db: scoped.db, userId: scoped.user.id,
      transportId: scoped.transport.id, propertyCode: scoped.property.propertyCode }, input);
    if (marked.status !== 'ok') return marked;
    const snapshot = await nativeIssueSnapshot(scoped, input);
    if (!input.serviceId) {
      if (input.targetRef) return { status: 'needs_input' as const, issue: 'service_required' };
      if (!input.allocationId) return { status: 'unsupported' as const, issue: 'service_target_required' };
      return reservationWorkflowV2PreviewServices(scoped, { ...input, allocationId: input.allocationId });
    }
    if (input.targetRef) {
      const { allocationId: _allocationId, targetRef, serviceId, reviewedPrepareRef, ...base } = input;
      if (reviewedPrepareRef) {
        const captured = { ...base, targetRef, serviceId, reviewedPrepareRef };
        const native = await reservationWorkflowV2ServicePreparation(scoped, captured);
        if (!native) return { status: 'needs_review' as const, issue: 'reviewed_service_preparation_changed' };
        const prepared = await issuePreparedV2(scoped, input, native, snapshot);
        return { status: 'prepared' as const, observationRef: reviewedPrepareRef, targetRef, serviceId,
          preparedRef: prepared.preparedRef, expectedRevision: prepared.revision, generationId: prepared.generationId };
      }
      return reservationWorkflowV2PreviewSavedServices(scoped, { ...input, targetRef, serviceId });
    }
    if (!input.allocationId) return { status: 'unsupported' as const, issue: 'service_target_required' };
    const { targetRef: _targetRef, allocationId, serviceId, reviewedPrepareRef, ...base } = input;
    const captured = { ...base, allocationId, serviceId, ...(reviewedPrepareRef ? { reviewedPrepareRef } : {}) };
    if (reviewedPrepareRef) {
      const native = await reservationWorkflowV2ServicePreparation(scoped, captured);
      if (!native) return { status: 'needs_review' as const, issue: 'reviewed_service_preparation_changed' };
      const prepared = await issuePreparedV2(scoped, input, native, snapshot);
      return { status: 'prepared' as const, observationRef: reviewedPrepareRef, allocationId, serviceId,
        preparedRef: prepared.preparedRef, expectedRevision: prepared.revision, generationId: prepared.generationId };
    }
    const result = await reservationWorkflowV2PreviewServices(scoped, captured);
    if (result.status !== 'prepared') return result;
    const native = await reservationWorkflowV2ServicePreparation(scoped, captured);
    if (!native) return result;
    const prepared = await issuePreparedV2(scoped, input, native, snapshot);
    return { ...result, preparedRef: prepared.preparedRef, expectedRevision: prepared.revision, generationId: prepared.generationId };
  }),
  reconcile: reservationWorkflowV2Procedure.input(reservationWorkflowV2ReconcileInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source, input.propertySwitch);
    const recovery = await recoveryWorkflow(scoped, input);
    if (recovery.state === 'error') return recovery.result;
    const workflow = recovery.state === 'recovery' ? { kind: recovery.kind, result: null }
      : await nativeWorkflow(scoped, input, undefined, input.operationId);
    if (workflow.result) return workflow.result;
    const recoveryScoped = recovery.state === 'recovery' ? recovery.scoped : scoped;
    const recoveryInput = recovery.state === 'recovery' ? recovery.input : input;
    if (workflow.kind === 'guest_profile') return reservationWorkflowV2ReconcileGuestProfile(recoveryScoped, recoveryInput);
    if (workflow.kind === 'quote') return reservationWorkflowV2QuoteReconcile(recoveryScoped, recoveryInput);
    if (workflow.kind === 'filing') return reservationWorkflowV2FilingReconcile(recoveryScoped, recoveryInput);
    if (workflow.kind === 'create') return reservationWorkflowV2Reconcile(recoveryScoped, recoveryInput);
    if (workflow.kind === 'cancel') return reservationWorkflowV2CancelReconcile(recoveryScoped, recoveryInput);
    if (workflow.kind === 'amend') return reservationWorkflowV2AmendReconcile(recoveryScoped, recoveryInput);
    return { status: 'unsupported', issue: 'workflow_connection_not_ready' };
  }),
  executeServices: reservationWorkflowV2Procedure.input(z.union([
    reservationWorkflowV2ServicesExecuteInputSchema.extend({ preparedRef: z.string().uuid().optional() }).strict(),
    reservationWorkflowV2SavedServicesExecuteInputSchema.extend({ preparedRef: z.string().uuid().optional() }).strict(),
  ])).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source, input.propertySwitch);
    await assertNotExcludedSource({ db: scoped.db, transportId: scoped.transport.id }, ctx.transportEmail, input.source);
    const marked = await markReservationWorkflowV2NativeActivity({ db: scoped.db, userId: scoped.user.id,
      transportId: scoped.transport.id, propertyCode: scoped.property.propertyCode }, input);
    if (marked.status !== 'ok') return marked;
    const { preparedRef, go: _go, idempotencyKey: _key, ...captured } = input;
    return queuePreparedV2(scoped, preparedRef, 'targetRef' in captured ? 'executeSavedServices' : 'executeServices', captured);
  }),
  reconcileServices: reservationWorkflowV2Procedure.input(reservationWorkflowV2ReconcileInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source, input.propertySwitch);
    const recovery = await recoveryWorkflow(scoped, input);
    if (recovery.state === 'error') return recovery.result;
    if (recovery.state === 'recovery') return recovery.kind === 'services'
      ? reservationWorkflowV2ReconcileServices(recovery.scoped, recovery.input) : { status: 'not_found' as const };
    return reservationWorkflowV2ReconcileServices(scoped, input);
  }),
});
