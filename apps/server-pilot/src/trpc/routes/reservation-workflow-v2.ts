import type { ReservationWorkflowV2Draft, ReservationWorkflowV2ItemInput } from '../../ai/reservation-workflow-v2-contract.js';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { aiWorkflowRun, attachment, mailThread, message } from '../../db/schema/mail.js';
import { workItem } from '../../db/schema/work.js';
import { MESSAGE_ARRIVED_AT } from '../../ai/message-arrival-time.js';
import { staffQuoteSourceHash } from '../../ai/staff-quote-workflow.js';
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
import { prefillDraft } from '../../ai/reservation-workflow-v2-prefill-service.js';
import { enqueueReservationArrival, reservationArrivalEnabled } from '../../ai/reservation-workflow-v2-arrival.js';
import {
  reservationWorkflowV2PreparationViews,
  reservationWorkflowV2Lookup,
  reservationWorkflowV2Prepare,
  reservationWorkflowV2Execute,
  reservationWorkflowV2Reconcile,
} from '../../ai/reservation-workflow-v2-tools.js';
import {
  reservationWorkflowV2ExecuteServices,
  reservationWorkflowV2LookupServices,
  reservationWorkflowV2LookupSavedServices,
  reservationWorkflowV2PreviewSavedServices,
  reservationWorkflowV2PreviewServices,
  reservationWorkflowV2ReconcileServices,
  reservationWorkflowV2ServicesExecuteInputSchema,
} from '../../ai/reservation-workflow-v2-services.js';
import { reservationWorkflowV2ExecuteSavedServices, reservationWorkflowV2SavedServicesExecuteInputSchema }
  from '../../ai/reservation-workflow-v2-services-execute.js';
import { reservationWorkflowV2QuoteLookup, reservationWorkflowV2QuotePrepare,
  reservationWorkflowV2QuoteExecute, reservationWorkflowV2QuoteReconcile } from '../../ai/reservation-workflow-v2-quote.js';
import { reservationWorkflowV2CancelLookup, reservationWorkflowV2CancelPrepare,
  reservationWorkflowV2CancelExecute, reservationWorkflowV2CancelReconcile } from '../../ai/reservation-workflow-v2-cancel.js';
import { reservationWorkflowV2AmendLookup, reservationWorkflowV2AmendPrepare,
  reservationWorkflowV2AmendExecute, reservationWorkflowV2AmendReconcile } from '../../ai/reservation-workflow-v2-amend.js';
import { reservationWorkflowV2FilingLookup, reservationWorkflowV2FilingPrepare,
  reservationWorkflowV2FilingExecute, reservationWorkflowV2FilingReconcile } from '../../ai/reservation-workflow-v2-filing.js';
import { reservationWorkflowV2GuestOptions, reservationWorkflowV2PrepareGuestProfile,
  reservationWorkflowV2CreateGuestProfile, reservationWorkflowV2ReconcileGuestProfile } from '../../ai/reservation-workflow-v2-guest.js';
import { resolvePropertyTransport } from '../../../tooling/playwright-quote/property-registry.mjs';
import { guardCenturionHmsMailboxOrigin } from '../../hms/mailbox-hms-origin-bind.js';
import { paneSourceSelectionCondition, paneSourceSelectionSchema } from '../../mail/pane-source-selection.js';
import { canonicalMessageId } from '../../mail/ingest/message-id.js';
import { logPaneSourceResolution } from '../../mail/pane-source-diagnostics.js';
import { mailboxProcedure, router } from '../trpc.js';

function context(userId: string, transportId: string) {
  const resolved = resolvePropertyTransport(transportId);
  if (resolved.kind !== 'property' || resolved.property.propertyCode !== 'HRCEN') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Reservation tools are not available for this mailbox yet.' });
  }
  return { db: getDb(), userId, transportId, propertyCode: resolved.property.propertyCode };
}

const sourceInput = z.object({
  internetMessageId: z.string().min(1).max(998).optional(),
  selection: paneSourceSelectionSchema,
}).strict();

async function nativeContext(user: { id: string; sessionId?: string; sessionProfile?: 'legacy' | 'remote' },
  transportId: string, source: { threadId: string; messageId: string }) {
  const scoped = context(user.id, transportId);
  const origin = await guardCenturionHmsMailboxOrigin({ transportId, threadId: source.threadId, messageId: source.messageId });
  if (!origin.ok) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: origin.message });
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
  const classification = classifyReservationWorkflowV2Source({ fromAddress: row.fromAddress, subject: row.subject,
    bodyText: preStaySourceText(row.textBody, row.htmlBody), mailboxAddress });
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

const configureFilingInput = reservationWorkflowV2ItemInputSchema.extend({
  requestId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  attachmentId: z.string().min(1).max(500), confirmation: z.string().trim().regex(/^\d+-\d+$/).max(200),
  kind: z.enum(['voucher', 'payment_proof']),
}).strict();

const servicesInput = reservationWorkflowV2PrepareInputSchema.extend({
  allocationId: z.string().min(1).max(80).optional(),
  targetRef: z.object({ kind: z.literal('saved_target'), requestId: z.string().min(1).max(80),
    hintId: z.string().min(1).max(80) }).strict().optional(), serviceId: z.string().min(1).max(80).optional(),
}).strict().refine((value) => Boolean(value.allocationId) !== Boolean(value.targetRef), 'Choose exactly one target.');

/** Source, state and tools share the authenticated mailbox; clients cannot select another hotel. */
export const reservationWorkflowV2Router = router({
  resolveSource: mailboxProcedure.input(sourceInput).query(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
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
        paneSourceSelectionCondition(input.selection, { userId: scoped.userId, internetMessageId: input.internetMessageId }),
        input.internetMessageId !== undefined ? eq(message.messageIdHeader, internetMessageId ?? '') : undefined))
      .limit(2);
    const selected = rows.length === 1 ? rows[0] : null;
    if (!selected || selected.sourceProvenance?.attention != null || !selected.arrivedAt) {
      const reason = rows.length > 1 ? 'ambiguous' as const : !selected ? 'not_found' as const
        : selected.sourceProvenance?.attention != null ? 'attention' as const : 'missing_arrival' as const;
      logPaneSourceResolution({ ...diagnostic, matches: rows.length, result: reason });
      return { status: 'source_unavailable' as const, reason };
    }
    const origin = await guardCenturionHmsMailboxOrigin({ transportId: scoped.transportId,
      threadId: selected.threadId, messageId: selected.id });
    if (!origin.ok) {
      logPaneSourceResolution({ ...diagnostic, matches: 1, result: 'wrong_property' });
      return { status: 'wrong_property' as const, message: origin.message };
    }
    logPaneSourceResolution({ ...diagnostic, matches: 1, result: 'ready',
      matchedBy: input.selection.kind === 'web' ? 'web' : selected.nativeLinked ? 'native' : 'mailbox-copy' });
    const attachments = await scoped.db.select({ id: attachment.id, filename: attachment.filename,
      mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, isInline: attachment.isInline })
      .from(attachment).where(eq(attachment.messageId, selected.id)).limit(50);
    return { status: 'ok' as const, propertyCode: scoped.propertyCode,
      internetMessageId: selected.internetMessageId,
      sourceText: preStaySourceText(selected.textBody, selected.htmlBody),
      sourceSubject: selected.subject ?? '', sourceSender: selected.fromAddress,
      selfPreStay: classifyReservationWorkflowV2Source({ fromAddress: selected.fromAddress, subject: selected.subject,
        bodyText: preStaySourceText(selected.textBody, selected.htmlBody), mailboxAddress: ctx.transportEmail }).selfPreStay,
      attachments,
      source: { threadId: selected.threadId, messageId: selected.id,
        sourceHash: staffQuoteSourceHash(selected), arrivedAt: selected.arrivedAt.toISOString() } };
  }),
  ensure: mailboxProcedure.input(reservationWorkflowV2EnsureInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
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
    const origin = await guardCenturionHmsMailboxOrigin({ transportId: scoped.transportId,
      threadId: source.threadId, messageId: source.id });
    if (!origin.ok) return { status: 'wrong_property' as const };
    const canonicalSource = { ...input.source, arrivedAt: source.arrivedAt.toISOString() };
    const admission = classifyReservationWorkflowV2Source({ fromAddress: source.fromAddress, subject: source.subject,
      bodyText: preStaySourceText(source.textBody, source.htmlBody), mailboxAddress: ctx.transportEmail });
    if (admission.skippedReason) return { status: 'skipped' as const, reason: `Known ${admission.skippedReason} source is excluded.` };
    const initialized = await initializeReservationWorkflowV2Draft(scoped, canonicalSource, { allowSourceChanged: true });
    if (initialized.status !== 'ok' || initialized.sourceChanged || input.mode === 'initialize')
      return withPreparation(Promise.resolve(initialized), scoped.propertyCode);
    const item = { workItemId: initialized.draft.workItemId, source: canonicalSource,
      expectedRevision: initialized.revision, expectedSeq: initialized.seq };
    if (!reservationArrivalEnabled()) return withPreparation(prefillDraft(scoped, item, ctx.transportEmail, false), scoped.propertyCode);
    if (initialized.draft.prefill?.status !== 'idle') return withPreparation(Promise.resolve(initialized), scoped.propertyCode);
    const job = await enqueueReservationArrival(scoped.db, { transportId: scoped.transportId, messageId: canonicalSource.messageId, requestedByPane: true });
    return withPreparation(job ? markReservationWorkflowV2Queued(scoped, { ...item, jobRunId: job.id }) : Promise.resolve(initialized), scoped.propertyCode);
  }),
  prefill: mailboxProcedure.input(reservationWorkflowV2ItemInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    if (!reservationArrivalEnabled()) return withPreparation(prefillDraft(scoped, input, ctx.transportEmail, true), scoped.propertyCode);
    const current = await getReservationWorkflowV2Draft(scoped, input);
    if (current.status !== 'ok' || current.revision !== input.expectedRevision || current.seq !== input.expectedSeq ||
        current.draft.prefill?.status === 'complete' || current.draft.prefill?.status === 'superseded')
      return withPreparation(Promise.resolve(current), scoped.propertyCode);
    const job = await enqueueReservationArrival(scoped.db, { transportId: scoped.transportId,
      messageId: input.source.messageId, priority: 0, requestedByPane: true });
    if (!job) return withPreparation(Promise.resolve(current), scoped.propertyCode);
    if (['dead_letter', 'succeeded', 'retry_wait'].includes(job.state))
      return withPreparation(retryReservationWorkflowV2Arrival(scoped, { ...input, jobRunId: job.id }), scoped.propertyCode);
    return withPreparation(markReservationWorkflowV2Queued(scoped, { ...input, jobRunId: job.id }), scoped.propertyCode);
  }),
  get: mailboxProcedure.input(reservationWorkflowV2ItemInputSchema).query(({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    return withPreparation(getReservationWorkflowV2Draft(scoped, input, { allowSourceChanged: true }), scoped.propertyCode);
  }),
  reconcileSource: mailboxProcedure.input(reservationWorkflowV2ItemInputSchema.extend({ confirmed: z.literal(true) })).mutation(({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    return withPreparation(reconcileReservationWorkflowV2Source(scoped, input), scoped.propertyCode);
  }),
  edit: mailboxProcedure.input(reservationWorkflowV2EditInputSchema).mutation(({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    return withPreparation(editReservationWorkflowV2Draft(scoped, { ...input, value: input.value }), scoped.propertyCode);
  }),
  addAction: mailboxProcedure.input(reservationWorkflowV2AddActionInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    if (input.kind === 'create') await requireCreateSource(scoped, input.source, ctx.transportEmail);
    return withPreparation(addReservationWorkflowV2Action(scoped, input), scoped.propertyCode);
  }),
  changeRows: mailboxProcedure.input(reservationWorkflowV2ChangeRowsInputSchema).mutation(({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    return withPreparation(changeReservationWorkflowV2Rows(scoped, input), scoped.propertyCode);
  }),
  selectNative: mailboxProcedure.input(reservationWorkflowV2SelectNativeInputSchema).mutation(({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    return withPreparation(selectReservationWorkflowV2Native(scoped, input), scoped.propertyCode);
  }),
  verifyNativeLead: mailboxProcedure.input(reservationWorkflowV2SelectNativeInputSchema).mutation(async ({ input, ctx, signal }) => {
    const native = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source);
    const scoped = { db: native.db, transportId: native.transport.id, userId: native.user.id,
      propertyCode: native.property.propertyCode };
    const timeout = AbortSignal.timeout(120_000);
    return withPreparation(reservationWorkflowV2VerifyLead(scoped, input,
      signal ? AbortSignal.any([signal, timeout]) : timeout), scoped.propertyCode);
  }),
  reviewScope: mailboxProcedure.input(reservationWorkflowV2ReviewScopeInputSchema).mutation(({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    return withPreparation(reviewReservationWorkflowV2Scope(scoped, input), scoped.propertyCode);
  }),
  review: mailboxProcedure.input(reservationWorkflowV2ReviewInputSchema).mutation(({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    return withPreparation(reviewReservationWorkflowV2Draft(scoped, input), scoped.propertyCode);
  }),
  undo: mailboxProcedure.input(reservationWorkflowV2ItemInputSchema).mutation(({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    return withPreparation(moveReservationWorkflowV2History(scoped, { ...input, direction: 'undo' }), scoped.propertyCode);
  }),
  redo: mailboxProcedure.input(reservationWorkflowV2ItemInputSchema).mutation(({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    return withPreparation(moveReservationWorkflowV2History(scoped, { ...input, direction: 'redo' }), scoped.propertyCode);
  }),
  configureFiling: mailboxProcedure.input(configureFilingInput).mutation(async ({ input, ctx }) => {
    const native = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source);
    const scoped = { db: native.db, transportId: native.transport.id, userId: native.user.id,
      propertyCode: native.property.propertyCode };
    return withPreparation(configureReservationWorkflowV2Filing(scoped, input), scoped.propertyCode);
  }),
  lookup: mailboxProcedure.input(reservationWorkflowV2LookupInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source);
    const workflow = await nativeWorkflow(scoped, input, input.requestId);
    if (workflow.result) return workflow.result;
    if (workflow.kind === 'quote') return reservationWorkflowV2QuoteLookup(scoped, input);
    if (workflow.kind === 'filing') return reservationWorkflowV2FilingLookup(scoped, input);
    if (workflow.kind === 'create') return reservationWorkflowV2Lookup(scoped, input);
    if (workflow.kind === 'cancel') return reservationWorkflowV2CancelLookup(scoped, input);
    if (workflow.kind === 'amend') return reservationWorkflowV2AmendLookup(scoped, input);
    return { status: 'unsupported', issue: 'workflow_connection_not_ready' };
  }),
  guestProfileOptions: mailboxProcedure.input(reservationWorkflowV2GuestPrepareInputSchema.extend({
    field: z.enum(['title', 'phoneType', 'emailType']),
  }).strict()).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source);
    const workflow = await nativeWorkflow(scoped, input, input.requestId);
    if (workflow.result) return workflow.result;
    if (workflow.kind !== 'create') return { status: 'unsupported' as const, issue: 'create_request_required' };
    return reservationWorkflowV2GuestOptions(scoped, input);
  }),
  prepareGuestProfile: mailboxProcedure.input(reservationWorkflowV2GuestPrepareInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source);
    const workflow = await nativeWorkflow(scoped, input, input.requestId);
    if (workflow.result) return workflow.result;
    if (workflow.kind !== 'create') return { status: 'unsupported' as const, issue: 'create_request_required' };
    return reservationWorkflowV2PrepareGuestProfile(scoped, input);
  }),
  createGuestProfile: mailboxProcedure.input(reservationWorkflowV2GuestCreateInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source);
    await requireCreateSource(context(ctx.sessionUser.id, ctx.activeTransportId), input.source, ctx.transportEmail);
    return reservationWorkflowV2CreateGuestProfile(scoped, input);
  }),
  prepare: mailboxProcedure.input(reservationWorkflowV2PrepareInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source);
    const workflow = await nativeWorkflow(scoped, input, input.requestId);
    if (workflow.result) return workflow.result;
    if (workflow.kind === 'quote') return reservationWorkflowV2QuotePrepare(scoped, input);
    if (workflow.kind === 'filing') return reservationWorkflowV2FilingPrepare(scoped, input);
    if (workflow.kind === 'create') return reservationWorkflowV2Prepare(scoped, input);
    if (workflow.kind === 'cancel') return reservationWorkflowV2CancelPrepare(scoped, input);
    if (workflow.kind === 'amend') return reservationWorkflowV2AmendPrepare(scoped, input);
    return { status: 'unsupported', issue: 'workflow_connection_not_ready' };
  }),
  execute: mailboxProcedure.input(reservationWorkflowV2ExecuteInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source);
    const workflow = await nativeWorkflow(scoped, input, input.requestId);
    if (workflow.result) return workflow.result;
    if (workflow.kind === 'quote') return reservationWorkflowV2QuoteExecute(scoped, input);
    if (workflow.kind === 'filing') return reservationWorkflowV2FilingExecute(scoped, input);
    if (workflow.kind === 'create') {
      await requireCreateSource(context(ctx.sessionUser.id, ctx.activeTransportId), input.source, ctx.transportEmail);
      return reservationWorkflowV2Execute(scoped, input);
    }
    if (workflow.kind === 'cancel') return reservationWorkflowV2CancelExecute(scoped, input);
    if (workflow.kind === 'amend') return reservationWorkflowV2AmendExecute(scoped, input);
    return { status: 'unsupported', issue: 'workflow_connection_not_ready' };
  }),
  lookupServices: mailboxProcedure.input(servicesInput).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source);
    const marked = await markReservationWorkflowV2NativeActivity({ db: scoped.db, userId: scoped.user.id,
      transportId: scoped.transport.id, propertyCode: scoped.property.propertyCode }, input);
    if (marked.status !== 'ok') return marked;
    if (input.targetRef) return reservationWorkflowV2LookupSavedServices(scoped, { ...input, targetRef: input.targetRef });
    if (!input.allocationId) return { status: 'unsupported' as const, issue: 'service_target_required' };
    return reservationWorkflowV2LookupServices(scoped, { ...input, allocationId: input.allocationId });
  }),
  prepareServices: mailboxProcedure.input(servicesInput).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source);
    const marked = await markReservationWorkflowV2NativeActivity({ db: scoped.db, userId: scoped.user.id,
      transportId: scoped.transport.id, propertyCode: scoped.property.propertyCode }, input);
    if (marked.status !== 'ok') return marked;
    if (input.targetRef) {
      if (!input.serviceId) return { status: 'needs_input' as const, issue: 'service_required' };
      return reservationWorkflowV2PreviewSavedServices(scoped, { ...input, targetRef: input.targetRef, serviceId: input.serviceId });
    }
    if (!input.allocationId) return { status: 'unsupported' as const, issue: 'service_target_required' };
    return reservationWorkflowV2PreviewServices(scoped, { ...input, allocationId: input.allocationId });
  }),
  reconcile: mailboxProcedure.input(reservationWorkflowV2ReconcileInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source);
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
  executeServices: mailboxProcedure.input(z.union([reservationWorkflowV2ServicesExecuteInputSchema,
    reservationWorkflowV2SavedServicesExecuteInputSchema])).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source);
    const marked = await markReservationWorkflowV2NativeActivity({ db: scoped.db, userId: scoped.user.id,
      transportId: scoped.transport.id, propertyCode: scoped.property.propertyCode }, input);
    if (marked.status !== 'ok') return marked;
    return 'targetRef' in input ? reservationWorkflowV2ExecuteSavedServices(scoped, input)
      : reservationWorkflowV2ExecuteServices(scoped, input);
  }),
  reconcileServices: mailboxProcedure.input(reservationWorkflowV2ReconcileInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source);
    const recovery = await recoveryWorkflow(scoped, input);
    if (recovery.state === 'error') return recovery.result;
    if (recovery.state === 'recovery') return recovery.kind === 'services'
      ? reservationWorkflowV2ReconcileServices(recovery.scoped, recovery.input) : { status: 'not_found' as const };
    return reservationWorkflowV2ReconcileServices(scoped, input);
  }),
});
