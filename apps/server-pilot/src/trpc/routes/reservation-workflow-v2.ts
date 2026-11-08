import type { ReservationWorkflowV2Draft } from '../../ai/reservation-workflow-v2-contract.js';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { attachment, mailThread, message } from '../../db/schema/mail.js';
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
} from '../../ai/reservation-workflow-v2-contract.js';
import {
  getReservationWorkflowV2Draft,
  editReservationWorkflowV2Draft,
  reviewReservationWorkflowV2Draft,
  moveReservationWorkflowV2History,
  configureReservationWorkflowV2Filing,
} from '../../ai/reservation-workflow-v2-state.js';
import { ensureReservationWorkflowV2Prefill } from '../../ai/reservation-workflow-v2-prefill.js';
import { preStaySourceText } from '../../ai/existing-stay-information.js';
import { createAzureExtractionAdapter } from '../../ai/extraction/extract.js';
import type { ModelAdapter } from '../../ai/bedrock/adapter.js';
import { loadSyncedQuoteSelectionFromMailbox } from '../../ai/quote-workflow-synced-selection.js';
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
  reservationWorkflowV2PreviewServices,
  reservationWorkflowV2ReconcileServices,
  reservationWorkflowV2ServicesExecuteInputSchema,
} from '../../ai/reservation-workflow-v2-services.js';
import { reservationWorkflowV2QuoteLookup, reservationWorkflowV2QuotePrepare,
  reservationWorkflowV2QuoteExecute, reservationWorkflowV2QuoteReconcile } from '../../ai/reservation-workflow-v2-quote.js';
import { reservationWorkflowV2CancelLookup, reservationWorkflowV2CancelPrepare,
  reservationWorkflowV2CancelExecute, reservationWorkflowV2CancelReconcile } from '../../ai/reservation-workflow-v2-cancel.js';
import { reservationWorkflowV2AmendLookup, reservationWorkflowV2AmendPrepare,
  reservationWorkflowV2AmendExecute, reservationWorkflowV2AmendReconcile } from '../../ai/reservation-workflow-v2-amend.js';
import { reservationWorkflowV2FilingLookup, reservationWorkflowV2FilingPrepare,
  reservationWorkflowV2FilingExecute, reservationWorkflowV2FilingReconcile } from '../../ai/reservation-workflow-v2-filing.js';
import { resolvePropertyTransport } from '../../../tooling/playwright-quote/property-registry.mjs';
import { guardCenturionHmsMailboxOrigin } from '../../hms/mailbox-hms-origin-bind.js';
import { paneSourceSelectionCondition, paneSourceSelectionSchema } from '../../mail/pane-source-selection.js';
import { mailboxProcedure, router } from '../trpc.js';

function context(userId: string, transportId: string) {
  const resolved = resolvePropertyTransport(transportId);
  if (resolved.kind !== 'property' || resolved.property.propertyCode !== 'HRCEN') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Reservation tools are not available for this mailbox yet.' });
  }
  return { db: getDb(), userId, transportId, propertyCode: resolved.property.propertyCode };
}

/** Preserve model failure timing even when a bounded retry keeps its original fallback. */
function observedPrefillAdapter(adapter: ModelAdapter | null, sourceMessageId: string,
  reasoningEffort: string): ModelAdapter | null {
  if (!adapter) return null;
  let callNumber = 0;
  return {
    ...(adapter.reserveCalls ? { reserveCalls: adapter.reserveCalls.bind(adapter) } : {}),
    async invoke(input) {
      const call = ++callNumber;
      const startedAt = Date.now();
      let reported = false;
      const report = (outcome: string, usage?: { inputTokens: number; outputTokens: number }) => {
        if (reported) return;
        reported = true;
        console.info('reservation_v2_model_call', JSON.stringify({ sourceMessageId, callNumber: call,
          reasoningEffort, outcome, elapsedMs: Date.now() - startedAt,
          ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}) }));
      };
      const aborted = () => report(input.signal?.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted');
      input.signal?.addEventListener('abort', aborted, { once: true });
      if (input.signal?.aborted) aborted();
      try {
        const result = await adapter.invoke(input);
        report('succeeded', result.usage);
        return result;
      } catch (error) {
        if (input.signal?.aborted) aborted();
        else report('model_error');
        throw error;
      } finally {
        input.signal?.removeEventListener('abort', aborted);
      }
    },
  };
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

async function withPreparation<T extends { status: string }>(reply: Promise<T>, propertyCode: string) {
  const result = await reply;
  const draft = 'draft' in result ? result.draft as ReservationWorkflowV2Draft | null : null;
  if (!draft) return { ...result, preparationViews: [] };
  // A source can have several legacy classifications. Show their receipts
  // without guessing an allocation mapping onto the v2 draft.
  const items = await getDb().select({ id: workItem.id, state: workItem.state }).from(workItem)
    .where(and(eq(workItem.transportId, draft.transportId), eq(workItem.threadId, draft.source.threadId),
      eq(workItem.sourceMessageId, draft.source.messageId)));
  if (!items.some((item) => item.id === draft.workItemId)) return { status: 'not_found' as const, preparationViews: [] };
  const legacyCreateReceipts = items.flatMap((item) => Object.entries(stayCommitsOf(item.state)).map(([stayId, receipt]) => ({
    stayId, status: receipt.status, confirmationNumber: receipt.confirmationNumber,
  })));
  const views = reservationWorkflowV2PreparationViews(draft, propertyCode);
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
  return kind ? { kind, result: null } : { kind: null, result: { status: 'not_found' as const } };
}

const configureFilingInput = reservationWorkflowV2ItemInputSchema.extend({
  requestId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  attachmentId: z.string().min(1).max(500), confirmation: z.string().trim().regex(/^\d+-\d+$/).max(200),
  kind: z.enum(['voucher', 'payment_proof']),
}).strict();

const servicesInput = reservationWorkflowV2PrepareInputSchema.extend({
  allocationId: z.string().min(1).max(80), serviceId: z.string().min(1).max(80).optional(),
}).strict();

/** Source, state and tools share the authenticated mailbox; clients cannot select another hotel. */
export const reservationWorkflowV2Router = router({
  resolveSource: mailboxProcedure.input(sourceInput).query(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    const rows = await scoped.db.select({
      id: message.id, threadId: message.threadId, internetMessageId: message.messageIdHeader,
      subject: message.subject, fromAddress: message.fromAddress, textBody: message.textBody, htmlBody: message.htmlBody,
      sourceProvenance: message.sourceProvenance, arrivedAt: MESSAGE_ARRIVED_AT,
    }).from(message).innerJoin(mailThread, and(eq(mailThread.id, message.threadId),
      eq(mailThread.transportId, message.transportId)))
      .where(and(eq(message.transportId, scoped.transportId), eq(message.direction, 'inbound'),
        eq(message.historyOnly, false), eq(mailThread.historyOnly, false),
        isNull(mailThread.trashedAt), isNull(mailThread.spamAt),
        paneSourceSelectionCondition(input.selection),
        input.internetMessageId ? eq(message.messageIdHeader, input.internetMessageId.trim()) : undefined))
      .limit(2);
    const selected = rows.length === 1 ? rows[0] : null;
    if (!selected || selected.sourceProvenance?.attention != null || !selected.arrivedAt) {
      return { status: 'source_unavailable' as const };
    }
    const origin = await guardCenturionHmsMailboxOrigin({ transportId: scoped.transportId,
      threadId: selected.threadId, messageId: selected.id });
    if (!origin.ok) return { status: 'wrong_property' as const, message: origin.message };
    const attachments = await scoped.db.select({ id: attachment.id, filename: attachment.filename,
      mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, isInline: attachment.isInline })
      .from(attachment).where(eq(attachment.messageId, selected.id)).limit(50);
    return { status: 'ok' as const, propertyCode: scoped.propertyCode,
      internetMessageId: selected.internetMessageId,
      sourceText: preStaySourceText(selected.textBody, selected.htmlBody),
      sourceSubject: selected.subject ?? '', sourceSender: selected.fromAddress,
      attachments,
      source: { threadId: selected.threadId, messageId: selected.id,
        sourceHash: staffQuoteSourceHash(selected), arrivedAt: selected.arrivedAt.toISOString() } };
  }),
  ensure: mailboxProcedure.input(reservationWorkflowV2EnsureInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    const [source] = await scoped.db.select({ id: message.id, threadId: message.threadId,
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
    const selection = await loadSyncedQuoteSelectionFromMailbox({ db: scoped.db, transportId: scoped.transportId,
      messageId: source.id, includeThreadState: true, sourceCutoffOnly: true,
      includeVisionImages: true, trackVisionImages: true });
    if (!selection) return { status: 'invalid_source' as const };
    // Match the corpus-tested v2 profile while retaining an explicit deployment override.
    const modelEnv = { ...process.env,
      EXTRACTION_REASONING_EFFORT: process.env.EXTRACTION_REASONING_EFFORT?.trim() || 'high' };
    return withPreparation(ensureReservationWorkflowV2Prefill({ context: scoped, source: canonicalSource, selection,
      mailboxAddress: ctx.transportEmail, env: modelEnv,
      adapter: observedPrefillAdapter(createAzureExtractionAdapter(modelEnv), source.id,
        modelEnv.EXTRACTION_REASONING_EFFORT) }), scoped.propertyCode);
  }),
  get: mailboxProcedure.input(reservationWorkflowV2ItemInputSchema).query(({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    return withPreparation(getReservationWorkflowV2Draft(scoped, input), scoped.propertyCode);
  }),
  edit: mailboxProcedure.input(reservationWorkflowV2EditInputSchema).mutation(({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    return withPreparation(editReservationWorkflowV2Draft(scoped, { ...input, value: input.value }), scoped.propertyCode);
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
    if (workflow.kind === 'create') return reservationWorkflowV2Execute(scoped, input);
    if (workflow.kind === 'cancel') return reservationWorkflowV2CancelExecute(scoped, input);
    if (workflow.kind === 'amend') return reservationWorkflowV2AmendExecute(scoped, input);
    return { status: 'unsupported', issue: 'workflow_connection_not_ready' };
  }),
  lookupServices: mailboxProcedure.input(servicesInput).mutation(async ({ input, ctx }) =>
    reservationWorkflowV2LookupServices(await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source), input)),
  prepareServices: mailboxProcedure.input(servicesInput).mutation(async ({ input, ctx }) =>
    reservationWorkflowV2PreviewServices(await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source), input)),
  reconcile: mailboxProcedure.input(reservationWorkflowV2ReconcileInputSchema).mutation(async ({ input, ctx }) => {
    const scoped = await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source);
    const workflow = await nativeWorkflow(scoped, input, undefined, input.operationId);
    if (workflow.result) return workflow.result;
    if (workflow.kind === 'quote') return reservationWorkflowV2QuoteReconcile(scoped, input);
    if (workflow.kind === 'filing') return reservationWorkflowV2FilingReconcile(scoped, input);
    if (workflow.kind === 'create') return reservationWorkflowV2Reconcile(scoped, input);
    if (workflow.kind === 'cancel') return reservationWorkflowV2CancelReconcile(scoped, input);
    if (workflow.kind === 'amend') return reservationWorkflowV2AmendReconcile(scoped, input);
    return { status: 'unsupported', issue: 'workflow_connection_not_ready' };
  }),
  executeServices: mailboxProcedure.input(reservationWorkflowV2ServicesExecuteInputSchema).mutation(async ({ input, ctx }) =>
    reservationWorkflowV2ExecuteServices(await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source), input)),
  reconcileServices: mailboxProcedure.input(reservationWorkflowV2ReconcileInputSchema).mutation(async ({ input, ctx }) =>
    reservationWorkflowV2ReconcileServices(await nativeContext(ctx.sessionUser, ctx.activeTransportId, input.source), input)),
});
