import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiWorkflowRun, mailboxTransport, mailThread, message } from '../db/schema/mail.js';
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
import type { ModelAdapter } from './bedrock/adapter.js';
import { loadSyncedQuoteSelectionFromMailbox } from './quote-workflow-synced-selection.js';
import { runReservationArrivalChecks } from './reservation-workflow-v2-arrival-checks.js';

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
    const modelEnv = { ...process.env, EXTRACTION_REASONING_EFFORT: process.env.EXTRACTION_REASONING_EFFORT?.trim() || 'high' };
    const generated = await runReservationWorkflowV2Prefill({ db: scoped.db, transportId: scoped.transportId,
      propertyCode: scoped.propertyCode, source: input.source, selection, mailboxAddress, env: modelEnv,
      signal: operationSignal, adapter: observedPrefillAdapter(createAzureExtractionAdapter(modelEnv), input.source.messageId, modelEnv.EXTRACTION_REASONING_EFFORT),
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
