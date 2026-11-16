import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiWorkflowRun, attachment, mailboxTransport, mailThread, message } from '../db/schema/mail.js';
import { resolvePropertyTransport } from '../../tooling/hms-cloud/property-registry.mjs';
import { guardCenturionHmsMailboxOrigin } from '../hms/mailbox-hms-origin-bind.js';
import { MESSAGE_ARRIVED_AT } from './message-arrival-time.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { reservationArrivalEnabled } from './reservation-workflow-v2-arrival.js';
import { reservationArrivalEvidence } from './reservation-workflow-v2-evidence.js';
import { markAiRunDeadLetter, markAiRunRetry, markAiRunSucceeded, type AiRunFence, type AiWorkflowRun } from './run-ledger.js';
import { getReservationWorkflowV2Draft, initializeReservationWorkflowV2Draft } from './reservation-workflow-v2-state.js';
import type { ReservationWorkflowV2ItemInput } from './reservation-workflow-v2-contract.js';
import type { ReservationPrefillJobFence, ReservationWorkflowV2Context } from './reservation-workflow-v2-state.js';
import { checkpointReservationWorkflowV2Extraction, claimReservationWorkflowV2Prefill,
  finishReservationWorkflowV2Prefill } from './reservation-workflow-v2-state.js';
import { runReservationWorkflowV2Prefill } from './reservation-workflow-v2-prefill.js';
import { createAzureExtractionAdapter } from './extraction/extract.js';
import { prefillSimpleSynthesisEnabled } from './extraction/config.js';
import type { ModelAdapter, ModelInvokeResult } from './bedrock/adapter.js';
import { loadSyncedQuoteSelectionFromMailbox } from './quote-workflow-synced-selection.js';
import { attachmentEvidenceUnknown, fileAttachmentPresence } from '../mail/ingest/attachment-evidence.js';
import { runReservationArrivalChecks } from './reservation-workflow-v2-arrival-checks.js';

/** Failure classes safe for production logs; any unlisted name collapses to 'other'. */
const MODEL_CALL_ERROR_CLASSES = new Set([
  'AbortError', 'TimeoutError', 'Error', 'TypeError', 'FetchError', 'RunDeadlineError',
  'AI_APICallError', 'AI_DownloadError', 'AI_InvalidResponseDataError', 'AI_JSONParseError',
  'AI_NoObjectGeneratedError', 'AI_NoSuchModelError', 'AI_RetryError', 'AI_TypeValidationError',
]);

/** Transport-level codes that carry no message text. */
const MODEL_CALL_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_DESTROYED',
]);

/** Object check that survives revoked Proxies, whose typeof throws. */
function isErrorLikeObject(value: unknown): boolean {
  try {
    return value !== null && typeof value === 'object';
  } catch {
    return false;
  }
}

/** Single guarded property read: a throwing getter or Proxy trap yields undefined
 *  instead of throwing, so classification keeps metadata already read. */
function readErrorProp(value: unknown, key: 'name' | 'code' | 'statusCode' | 'status' | 'cause'): unknown {
  try {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Bounded failure metadata: allowlisted class/code or numeric HTTP status, never messages or stacks.
 *  Fetch wrappers keep the transport code under `cause`, so walk a bounded, cycle-safe chain;
 *  each field keeps the first allowlisted value, outermost first. */
function classifyModelCallError(error: unknown): { errorClass: string; errorCode?: string; httpStatus?: number } {
  let errorClass: string | undefined;
  let errorCode: string | undefined;
  let httpStatus: number | undefined;
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && isErrorLikeObject(current) && !seen.has(current); depth++) {
    seen.add(current);
    const name = readErrorProp(current, 'name');
    const code = readErrorProp(current, 'code');
    const statusCode = readErrorProp(current, 'statusCode');
    const status = readErrorProp(current, 'status');
    const rawStatus = typeof statusCode === 'number' ? statusCode
      : typeof status === 'number' ? status : undefined;
    if (errorClass === undefined && typeof name === 'string' && MODEL_CALL_ERROR_CLASSES.has(name)) errorClass = name;
    if (errorCode === undefined && typeof code === 'string' && MODEL_CALL_ERROR_CODES.has(code)) errorCode = code;
    if (httpStatus === undefined && rawStatus !== undefined &&
        Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599) httpStatus = rawStatus;
    if (errorClass !== undefined && errorCode !== undefined && httpStatus !== undefined) break;
    current = readErrorProp(current, 'cause');
  }
  return {
    errorClass: errorClass ?? 'other',
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  };
}

/** Preserve model failure timing even when a bounded retry keeps its original fallback. */
function observedPrefillAdapter(adapter: ModelAdapter | null, sourceMessageId: string,
  stage: 'extract' | 'synthesis', reasoningEffort: string, jobRunId?: string): ModelAdapter | null {
  if (!adapter) return null;
  let callNumber = 0;
  return {
    ...(adapter.reserveCalls ? { reserveCalls: adapter.reserveCalls.bind(adapter) } : {}),
    async invoke(input) {
      const call = ++callNumber;
      const startedAt = Date.now();
      // Request-side context for latency root cause: sizes are raw UTF-8 and file bytes,
      // never provider tokens; prompt text, filenames and addresses are never logged.
      const request = {
        modelId: input.modelId,
        systemPromptBytes: Buffer.byteLength(input.systemPrompt),
        userPromptBytes: Buffer.byteLength(input.userPrompt),
        fileCount: input.files?.length ?? 0,
        fileBytes: (input.files ?? []).reduce((sum, file) => sum + file.data.byteLength, 0),
        imageCount: input.images?.length ?? 0,
        imageBytes: (input.images ?? []).reduce((sum, image) => sum + image.data.byteLength, 0),
        ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
        ...(input.deadlineAt !== undefined ? { deadlineRemainingMs: input.deadlineAt - startedAt } : {}),
      };
      let reported = false;
      const report = (outcome: string, result?: ModelInvokeResult,
        failure?: { errorClass: string; errorCode?: string; httpStatus?: number }) => {
        if (reported) return;
        reported = true;
        console.info('reservation_v2_model_call', JSON.stringify({
          at: new Date().toISOString(), sourceMessageId, stage, callNumber: call,
          ...(jobRunId ? { jobRunId } : {}), ...request, reasoningEffort, outcome,
          elapsedMs: Date.now() - startedAt,
          // adapterLatencyMs is the adapter's measured round-trip, never
          // provider-reported; token counts emit only when the provider reported
          // usage, otherwise they are unknown rather than measured zeros.
          ...(result?.usage ? {
            ...(result.provenance?.usageSource === 'reported'
              ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : {}),
            adapterLatencyMs: result.usage.latencyMs } : {}),
          ...(failure ?? {}) }));
      };
      const aborted = () => report(readErrorProp(input.signal?.reason, 'name') === 'TimeoutError' ? 'timeout' : 'aborted',
        undefined, classifyModelCallError(input.signal?.reason));
      input.signal?.addEventListener('abort', aborted, { once: true });
      if (input.signal?.aborted) aborted();
      try {
        const result = await adapter.invoke(input);
        report('succeeded', result);
        return result;
      } catch (error) {
        if (input.signal?.aborted) aborted();
        else report('model_error', undefined, classifyModelCallError(error));
        throw error;
      } finally {
        input.signal?.removeEventListener('abort', aborted);
      }
    },
  };
}

export async function prefillDraft(scoped: ReservationWorkflowV2Context, input: ReservationWorkflowV2ItemInput,
  mailboxAddress: string | null | undefined, allowRetry: boolean, jobFence?: ReservationPrefillJobFence, signal?: AbortSignal, parentSignal?: AbortSignal) {
  const claimed = await claimReservationWorkflowV2Prefill(scoped, { ...input, allowRetry, jobFence });
  if (!claimed.claim) return claimed.result;
  const callerSignal = signal;
  const timeoutSignal = AbortSignal.timeout(9 * 60_000);
  const operationSignal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  let activeClaim = claimed.claim;
  try {
    const selection = await loadSyncedQuoteSelectionFromMailbox({ db: scoped.db, transportId: scoped.transportId,
      messageId: input.source.messageId, includeThreadState: true, sourceCutoffOnly: true,
      includeVisionImages: true, trackVisionImages: true, signal: operationSignal });
    operationSignal.throwIfAborted();
    if (!selection) return finishReservationWorkflowV2Prefill(scoped, { ...input, claim: claimed.claim, failed: true, jobFence });
    const [sourceMessage] = await scoped.db.select({ sourceProvenance: message.sourceProvenance })
      .from(message).where(and(eq(message.id, input.source.messageId),
        eq(message.transportId, scoped.transportId))).limit(1);
    const [fileAttachment] = await scoped.db.select({ id: attachment.id })
      .from(attachment).where(and(eq(attachment.messageId, input.source.messageId),
        eq(attachment.isInline, false))).limit(1);
    const modelEnv = { ...process.env, EXTRACTION_REASONING_EFFORT: process.env.EXTRACTION_REASONING_EFFORT?.trim() || 'high' };
    const azureAdapter = createAzureExtractionAdapter(modelEnv);
    const generated = await runReservationWorkflowV2Prefill({ db: scoped.db, transportId: scoped.transportId,
      propertyCode: scoped.propertyCode, source: input.source, selection, mailboxAddress, env: modelEnv,
      attachmentEvidenceUnknown: attachmentEvidenceUnknown(sourceMessage?.sourceProvenance),
      hasPersistedNonInlineAttachment: fileAttachmentPresence(fileAttachment != null, sourceMessage?.sourceProvenance) === true,
      signal: operationSignal,
      adapter: observedPrefillAdapter(azureAdapter, input.source.messageId, 'extract',
        modelEnv.EXTRACTION_REASONING_EFFORT, jobFence?.runId),
      synthesisAdapter: observedPrefillAdapter(azureAdapter, input.source.messageId, 'synthesis',
        modelEnv.EXTRACTION_REASONING_EFFORT, jobFence?.runId),
      simpleSynthesisAdapter: prefillSimpleSynthesisEnabled(modelEnv) ? observedPrefillAdapter(
        createAzureExtractionAdapter({ ...modelEnv, EXTRACTION_REASONING_EFFORT: 'medium' }),
        input.source.messageId, 'synthesis', 'medium', jobFence?.runId) : null,
      onValidatedExtraction: async (generationId, extraction) => {
        const checkpoint = await checkpointReservationWorkflowV2Extraction(scoped, { ...input, claim: activeClaim,
          generationId, extraction, jobFence });
        if (!checkpoint.claim) return false;
        activeClaim = checkpoint.claim;
        return true;
      } });
    const { missing } = await reservationArrivalEvidence(scoped.db, input.source.messageId);
    if (missing.length) {
      generated.status = 'partial';
      generated.errors = [...(generated.errors ?? []).slice(0, 99), { stage: 'lookup', code: 'missing_attachment',
        message: `Some attachments could not be copied: ${missing.map((entry) => entry.fileName || entry.role).join(', ')}`.slice(0, 1000) }];
    }
    operationSignal.throwIfAborted();
    const failed = !generated.sourceBound || (generated.skippedReason !== undefined && generated.skippedReason !== 'self_prestay') ||
      (generated.errors ?? []).some((error) => error.stage === 'extract' ||
        (error.stage === 'synthesis' && ['model_timeout', 'model_error'].includes(error.code)));
    return finishReservationWorkflowV2Prefill(scoped, { ...input, claim: activeClaim, failed, jobFence,
      seed: generated.sourceBound && !generated.skippedReason ? { generationId: generated.generationId,
        status: generated.status, ...(generated.extraction ? { extraction: generated.extraction } : {}),
        ...(generated.disposition ? { disposition: generated.disposition } : {}),
        proposal: generated.proposal, observations: generated.observations,
        fieldReviewRequirements: generated.fieldReviewRequirements, errors: generated.errors } : undefined });
  } catch (error) {
    const callerCancelled = Boolean(parentSignal?.aborted || (!parentSignal && callerSignal?.aborted));
    if (callerCancelled) throw error;
    const timedOut = timeoutSignal.aborted || operationSignal.aborted;
    return finishReservationWorkflowV2Prefill(scoped, { ...input, claim: activeClaim, failed: true, jobFence,
      ...(timedOut ? { failure: { stage: 'extract' as const, code: 'model_timeout',
        message: 'Prefill timed out before it could finish. You can retry or enter details manually.' } } : {}) });
  }
}


/** Worker scope comes only from a claimed ledger row and the canonical server mailbox. */
export async function executeReservationArrival(input: {
  run: AiWorkflowRun; fence: AiRunFence; signal: AbortSignal; db: DB;
}): Promise<'succeeded' | 'retry_wait' | 'dead_letter'> {
  const { run, fence, db, signal } = input;
  if (!reservationArrivalEnabled()) {
    const deferred = await markAiRunRetry({ ...fence, expectedStates: ['running'], attempts: run.attempts,
      nextRunAt: new Date(Date.now() + 5 * 60_000), lastError: 'arrival prefill disabled',
      failureClass: 'POLICY_BLOCK', resetDeadline: true }, db);
    return deferred ? 'retry_wait' : 'dead_letter';
  }
  const resolved = resolvePropertyTransport(run.transportId);
  const [row] = await db.select({ id: message.id, threadId: message.threadId, subject: message.subject,
    textBody: message.textBody, htmlBody: message.htmlBody, fromAddress: message.fromAddress,
    arrivedAt: MESSAGE_ARRIVED_AT, mailboxAddress: mailboxTransport.email }).from(message)
    .innerJoin(mailThread, and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, message.transportId)))
    .innerJoin(mailboxTransport, eq(mailboxTransport.id, message.transportId))
    .where(and(eq(message.id, run.triggerMessageId), eq(message.threadId, run.threadId),
      eq(message.transportId, run.transportId))).limit(1);
  const sourceHash = run.metrics?.sourceHash;
  const evidenceHash = run.metrics?.evidenceHash;
  const arrivedAt = run.metrics?.arrivedAt;
  const origin = resolved.kind === 'property' && resolved.property.propertyCode === 'HRDAV'
    ? { ok: true } : await guardCenturionHmsMailboxOrigin({ transportId: run.transportId,
      threadId: run.threadId, messageId: run.triggerMessageId });
  if (resolved.kind !== 'property' || !['HRCEN', 'HRDAV'].includes(resolved.property.propertyCode) || !origin.ok || !row ||
      typeof sourceHash !== 'string' || typeof evidenceHash !== 'string' || typeof arrivedAt !== 'string' || !row.arrivedAt ||
      (await reservationArrivalEvidence(db, run.triggerMessageId)).hash !== evidenceHash ||
      row.arrivedAt.toISOString() !== arrivedAt || staffQuoteSourceHash(row) !== sourceHash) {
    await markAiRunDeadLetter({ ...fence, expectedStates: ['running'], lastError: 'arrival source binding changed',
      failureClass: 'POLICY_BLOCK' }, db);
    return 'dead_letter';
  }
  const propertyCode = resolved.property.propertyCode;
  const source = { ...(propertyCode === 'HRDAV' ? { propertyId: propertyCode } : {}),
    threadId: row.threadId, messageId: row.id, sourceHash, arrivedAt };
  const scoped: ReservationWorkflowV2Context = { db, transportId: run.transportId, propertyCode };
  const initialized = await initializeReservationWorkflowV2Draft(scoped, source,
    { allowPropertySwitch: propertyCode !== 'HRDAV' });
  if (initialized.status !== 'ok') {
    await markAiRunDeadLetter({ ...fence, expectedStates: ['running'], lastError: `source rejected: ${initialized.status}`,
      failureClass: 'POLICY_BLOCK' }, db);
    return 'dead_letter';
  }
  const resumingChecks = initialized.draft.prefill?.jobRunId === run.id &&
    initialized.draft.prefill.status === 'running' && initialized.draft.prefill.phase === 'native_checks';
  await db.update(aiWorkflowRun).set({ workItemId: initialized.draft.workItemId,
    metrics: { ...run.metrics, phase: resumingChecks ? 'native_checks' : 'generation' }, updatedAt: new Date() }).where(and(
      eq(aiWorkflowRun.id, fence.runId), eq(aiWorkflowRun.claimOwner, fence.claimOwner),
      eq(aiWorkflowRun.claimToken, fence.claimToken), eq(aiWorkflowRun.state, 'running')));
  const item = { workItemId: initialized.draft.workItemId, source,
    expectedRevision: initialized.revision, expectedSeq: initialized.seq };
  const generationSignal = AbortSignal.any([signal, AbortSignal.timeout(9 * 60_000)]);
  let result = resumingChecks ? initialized : await prefillDraft(scoped, item, row.mailboxAddress, true, fence, generationSignal, signal);
  if (result.status !== 'ok') {
    await markAiRunDeadLetter({ ...fence, expectedStates: ['running'], lastError: `draft rejected: ${result.status}`,
      failureClass: 'POLICY_BLOCK' }, db);
    return 'dead_letter';
  }
  const transientModelFailure = result.draft.errors.some((error) => ['extract', 'synthesis'].includes(error.stage) &&
    ['model_timeout', 'model_error'].includes(error.code));
  const failureSummary = result.draft.errors.map(error => `${error.stage}:${error.code}`).join(', ').slice(0, 800) || 'generation:prefill_unavailable';
  if (result.draft.prefill?.status === 'failed' && transientModelFailure &&
      run.attempts < 1 && result.draft.prefill.attemptCount < 2) {
    const retry = await markAiRunRetry({ ...fence, expectedStates: ['running'], attempts: run.attempts + 1,
      nextRunAt: new Date(Date.now() + 5 * 60_000), lastError: `reservation prefill incomplete (${failureSummary})`,
      failureClass: 'BEDROCK_TRANSIENT', resetDeadline: true }, db);
    return retry ? 'retry_wait' : 'dead_letter';
  }
  if (result.draft.prefill?.status === 'failed') {
    await markAiRunDeadLetter({ ...fence, expectedStates: ['running'], lastError: `reservation prefill attempts exhausted (${failureSummary})`,
      failureClass: transientModelFailure ? 'BEDROCK_TRANSIENT' : 'POLICY_BLOCK' }, db);
    return 'dead_letter';
  }
  if (result.draft.prefill?.status === 'running' && result.draft.prefill.phase === 'native_checks' &&
      result.draft.prefill.jobRunId === run.id) {
    await db.update(aiWorkflowRun).set({ metrics: { ...run.metrics, phase: 'native_checks' }, updatedAt: new Date() }).where(and(
      eq(aiWorkflowRun.id, fence.runId), eq(aiWorkflowRun.claimOwner, fence.claimOwner),
      eq(aiWorkflowRun.claimToken, fence.claimToken), eq(aiWorkflowRun.state, 'running')));
    const checkItem = { ...item, expectedRevision: result.revision, expectedSeq: result.seq };
    await runReservationArrivalChecks({ scoped, item: checkItem, draft: result.draft, fence,
      deadlineAt: fence.deadlineAt, signal,
      ...(typeof run.metrics?.interruptedHeartbeatAt === 'string' ? { recoveryHeartbeat: run.metrics.interruptedHeartbeatAt } : {}) });
    const fresh = await getReservationWorkflowV2Draft(scoped, checkItem);
    if (fresh.status !== 'ok' || (fresh.draft.prefill?.status === 'running' && fresh.draft.prefill.phase === 'native_checks')) {
      await markAiRunDeadLetter({ ...fence, expectedStates: ['running'], lastError: 'reservation native checks incomplete',
        failureClass: 'LEASE_LOST' }, db);
      return 'dead_letter';
    }
    result = fresh;
  }
  const done = await markAiRunSucceeded({ ...fence, expectedStates: ['running'],
    metrics: { ...run.metrics, phase: 'complete', prefillStatus: result.draft.prefill?.status,
      workItemId: result.draft.workItemId } }, db);
  return done ? 'succeeded' : 'dead_letter';
}
