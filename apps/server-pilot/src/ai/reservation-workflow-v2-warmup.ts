import { createHash, randomUUID } from 'node:crypto';
import { hmsJobConsumerAvailableSql, hmsJobQueueAvailable } from '../../tooling/hms-cloud/cloud-session.mjs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import { staffSessionSchema } from '../hms/hms-preparation.js';
import { resolvePropertyScope } from '../hms/property-registry.js';
import { classifyHmsLoginOutage, clearPropertyOutage, decidePropertyReadJob, noteLoginOutage,
  HMS_OUTAGE_FAILURE_CLASS, HMS_OUTAGE_LAST_ERROR } from '../hms/property-outage.js';
import { reservationWorkflowV2PrepareInputSchema } from './reservation-workflow-v2-contract.js';
import { getReservationWorkflowV2Draft } from './reservation-workflow-v2-state.js';
import { HMS_JOB_PROMPT_VERSION, NOT_APPLICABLE_MODEL_ID, markAiRunDeadLetter, markAiRunRetry,
  markAiRunSucceeded, type AiRunFence, type AiWorkflowRun } from './run-ledger.js';

export const reservationWarmupRequestSchema = z.object({
  kind: z.literal('reservation_warmup'), action: z.enum(['lookup', 'prepare']),
  input: reservationWorkflowV2PrepareInputSchema,
  generationId: z.string().min(1), session: staffSessionSchema,
}).strict();
export type ReservationWarmupRequest = z.infer<typeof reservationWarmupRequestSchema>;

/** The receipt survives pane closure; only the existing HMS worker performs the work. */
export async function enqueueReservationWarmup(db: DB, transportId: string, request: ReservationWarmupRequest) {
  if (!hmsJobQueueAvailable()) return { status: 'unsupported' as const, issue: 'warmup_queue_disabled' };
  const consumers = await db.execute(sql`SELECT ${sql.raw(hmsJobConsumerAvailableSql)} AS available`);
  if (consumers[0]?.available !== true) return { status: 'unsupported' as const, issue: 'warmup_queue_disabled' };
  const current = await getReservationWorkflowV2Draft({ db, transportId, userId: request.session.actorUserId,
    propertyCode: request.input.source.propertyId ?? 'HRCEN' }, request.input);
  if (current.status !== 'ok') return current;
  if (current.revision !== request.input.expectedRevision || current.seq !== request.input.expectedSeq ||
      current.draft.generationId !== request.generationId) return { status: 'stale_revision' as const };
  const digest = createHash('sha256').update(JSON.stringify([transportId, request.input.workItemId,
    request.generationId, request.action, request.input.requestId, request.input.allocationId ?? null,
    request.input.expectedRevision, request.input.expectedSeq, request.session.actorUserId,
    request.session.sessionId, request.session.sessionProfile])).digest('hex');
  const idempotencyKey = `reservation-warmup:${digest}`;
  const values = { id: randomUUID(), transportId, threadId: request.input.source.threadId,
    triggerMessageId: request.input.source.messageId, workItemId: request.input.workItemId,
    runKind: 'read_tool', executorLane: 'hms', promptVersion: HMS_JOB_PROMPT_VERSION,
    modelId: NOT_APPLICABLE_MODEL_ID, priority: 0, idempotencyKey, readRequest: request,
    metrics: { hmsJob: true, prefetch: true, reservationWarmup: true }, state: 'queued' } satisfies typeof aiWorkflowRun.$inferInsert;
  const [inserted] = await db.insert(aiWorkflowRun).values(values)
    .onConflictDoNothing({ target: aiWorkflowRun.idempotencyKey }).returning({ id: aiWorkflowRun.id, state: aiWorkflowRun.state });
  const [existing] = inserted ? [] : await db.select({ id: aiWorkflowRun.id, state: aiWorkflowRun.state }).from(aiWorkflowRun)
    .where(eq(aiWorkflowRun.idempotencyKey, idempotencyKey)).limit(1);
  const job = inserted ?? existing;
  if (!job) throw new Error('reservation_warmup_enqueue_failed');
  if (job.state === 'dead_letter') return { status: 'failed' as const, issue: 'reservation_warmup_failed', jobRunId: job.id };
  if (job.state === 'superseded') return { status: 'superseded' as const, jobRunId: job.id };
  if (job.state === 'succeeded') return { status: 'ok' as const, jobRunId: job.id };
  return { status: 'queued' as const, jobRunId: job.id };
}

function busy(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(busy);
  return Object.entries(value).some(([key, child]) =>
    (['issue', 'code', 'outcomeClass'].includes(key) && ['HMS_LOCK_BUSY', 'STAFF_QUOTE_ACTIVE',
      'hms_busy', 'HMS_CREDENTIAL_LEASE_CONTENDED', 'RESERVATION_ACTION_LOCK_BUSY'].includes(String(child))) ||
    ['quotes', 'lookups', 'cause'].includes(key) && busy(child));
}

// Results deliberately contain only sanitized native failure metadata.
function loginOutage(value: unknown, depth = 0): boolean {
  if (depth > 4 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(child => loginOutage(child, depth + 1));
  if ('hmsLoginOutage' in value && value.hmsLoginOutage === true) return true;
  if (classifyHmsLoginOutage(value)) return true;
  if ('failureCode' in value || 'failurePhase' in value) {
    if (classifyHmsLoginOutage({ code: 'failureCode' in value ? value.failureCode : undefined,
      phase: 'failurePhase' in value ? value.failurePhase : undefined })) return true;
  }
  return Object.entries(value).some(([key, child]) =>
    ['quotes', 'quote', 'lookups', 'cause'].includes(key) && loginOutage(child, depth + 1));
}

export async function executeReservationWarmup(input: {
  db: DB; run: AiWorkflowRun; fence: AiRunFence; signal?: AbortSignal; request: ReservationWarmupRequest;
}): Promise<'succeeded' | 'retry_wait' | 'dead_letter'> {
  const { db, run, fence, request } = input;
  const mark = { ...fence, expectedStates: ['running' as const] };
  const retry = async (reason: string) => {
    const retained = await markAiRunRetry({ ...mark, attempts: run.attempts,
      nextRunAt: new Date(Date.now() + 15_000), lastError: reason,
      failureClass: 'HMS_LOCK_BUSY', resetDeadline: true }, db);
    return retained ? 'retry_wait' as const : 'dead_letter' as const;
  };
  // Reclaim never moves a queued task's creation time or charges contention as a failure.
  const [owned] = await db.select({ id: aiWorkflowRun.id }).from(aiWorkflowRun).where(and(
    eq(aiWorkflowRun.id, fence.runId), eq(aiWorkflowRun.claimOwner, fence.claimOwner),
    eq(aiWorkflowRun.claimToken, fence.claimToken), inArray(aiWorkflowRun.state, ['running']))).limit(1);
  if (!owned || run.workItemId !== request.input.workItemId || run.triggerMessageId !== request.input.source.messageId ||
      run.threadId !== request.input.source.threadId) {
    await markAiRunDeadLetter({ ...mark, lastError: 'reservation warmup binding invalid', failureClass: 'POLICY_BLOCK' }, db);
    return 'dead_letter';
  }
  let propertyCode: string | null = null;
  try {
    const scope = resolvePropertyScope({ transportId: run.transportId, propertySwitch: request.input.propertySwitch });
    if ((request.input.source.propertyId ?? 'HRCEN') === scope.propertyCode) propertyCode = scope.propertyCode;
  } catch { /* The native route reports invalid property bindings. */ }
  const park = async (delayMs: number) => {
    const retained = await markAiRunRetry({ ...mark, attempts: run.attempts,
      nextRunAt: new Date(Date.now() + delayMs), lastError: HMS_OUTAGE_LAST_ERROR,
      failureClass: HMS_OUTAGE_FAILURE_CLASS, resetDeadline: true }, db);
    return retained ? 'retry_wait' as const : 'dead_letter' as const;
  };
  input.signal?.throwIfAborted();
  const outage = decidePropertyReadJob(propertyCode);
  if (outage.kind === 'park') return park(outage.delayMs);
  try {
    const native = await import('../trpc/routes/reservation-workflow-v2.js');
    const result = await native.runReservationWorkflowV2Warmup({ transportId: run.transportId, request, fence, signal: input.signal });
    input.signal?.throwIfAborted();
    if (loginOutage(result)) {
      const parked = noteLoginOutage(propertyCode);
      if (parked.kind === 'park') return park(parked.delayMs);
      throw new Error('reservation warmup native check failed');
    }
    if (busy(result) || result.status === 'stale_revision' ||
        result.status === 'unsupported' && result.issue === 'warmup_queue_disabled') return retry('reservation warmup yielded');
    if (result.status === 'failed' || result.status === 'unsupported' ||
        'lookups' in result && Array.isArray(result.lookups) && result.lookups.some(row =>
          row && typeof row === 'object' && row.issue === 'filing_stay_lookup_failed') ||
        'quotes' in result && Array.isArray(result.quotes) && result.quotes.some(row => row && typeof row === 'object' && row.status === 'failed'))
      throw new Error('reservation warmup native check failed');
    if (result.status === 'prepared' || result.status === 'ok' &&
        ('catalogues' in result || 'quotes' in result && Array.isArray(result.quotes) && result.quotes.some(row =>
          row && typeof row === 'object' && row.status === 'priced') ||
          'lookups' in result && Array.isArray(result.lookups) && result.lookups.some(row =>
            row && typeof row === 'object' && row.status === 'candidate'))) clearPropertyOutage(propertyCode);
    const completed = await markAiRunSucceeded({ ...mark, metrics: { ...run.metrics,
      warmupStatus: result.status, ...(result.status === 'superseded' ? { superseded: true } : {}) } }, db);
    return completed ? 'succeeded' : 'retry_wait';
  } catch (failure) {
    input.signal?.throwIfAborted();
    if (classifyHmsLoginOutage(failure)) {
      const parked = noteLoginOutage(propertyCode);
      if (parked.kind === 'park') return park(parked.delayMs);
    }
    if (failure instanceof Error && (failure.message === 'HMS_CREDENTIAL_LEASE_CONTENDED' || busy(failure)))
      return retry('reservation warmup waiting for HMS');
    if (run.attempts < 3) {
      const retained = await markAiRunRetry({ ...mark, attempts: run.attempts + 1,
        nextRunAt: new Date(Date.now() + 30_000), lastError: 'reservation warmup failed',
        failureClass: 'UNKNOWN', resetDeadline: true }, db);
      return retained ? 'retry_wait' : 'dead_letter';
    }
    await markAiRunDeadLetter({ ...mark, lastError: 'reservation warmup failed', failureClass: 'UNKNOWN' }, db);
    return 'dead_letter';
  }
}
