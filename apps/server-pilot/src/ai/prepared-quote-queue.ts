import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import {
  enqueueHmsJob,
  hmsMailCopiesForMessage,
  hmsMailReadIdempotencyKey,
  quoteJobNeedsSourceWitness,
} from './hms-jobs.js';
import { reservePrefetchCapacity } from './prefetch-capacity.js';
import { HMS_JOB_PROMPT_VERSION } from './run-ledger.js';
import { QUOTE_SOURCE_PROOF_VERSION } from './child-occupancy.js';

export type PreparedQuoteCapResult = {
  created: boolean;
  deferred: boolean;
};

const NOT_QUEUED: PreparedQuoteCapResult = { created: false, deferred: false };

function metricsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function coversBatchSize(metrics: Record<string, unknown>, batchSize: number): boolean {
  return (
    typeof metrics.prefetchBatchSize === 'number' &&
    Number.isSafeInteger(metrics.prefetchBatchSize) &&
    metrics.prefetchBatchSize >= batchSize
  );
}

/** Serializes prepared-quote cap checks/inserts across workers for one mailbox. Live digests remain idempotent. */
export async function enqueuePreparedQuoteWithinCap(
  db: DB,
  input: Parameters<typeof enqueueHmsJob>[0],
  perHour: number,
  batchSize = 1,
): Promise<PreparedQuoteCapResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(
        ${'hms-prefetch:staff_quote:' + input.transportId}, 0
      ))`,
    );
    const scoped = tx as unknown as DB;
    const copies = await hmsMailCopiesForMessage(scoped, input.transportId, input.triggerMessageId);
    const centurionExtraction = copies.propertyCode === 'HRCEN' && input.request.kind === 'staff_quote';
    const sourceExtractionId = input.request.kind === 'staff_quote' ? input.request.input.sourceExtractionId ?? null : null;
    const storedIdentity =
      !quoteJobNeedsSourceWitness(input) && copies.propertyCode && copies.messageIdHeader
        ? hmsMailReadIdempotencyKey(
            copies.propertyCode,
            copies.messageIdHeader,
            input.request,
            input.createdAt ?? new Date(),
            input.idempotencyKey,
            input.threadId,
          )
        : input.idempotencyKey;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(
        ${'hms-prefetch:staff_quote_identity:' + storedIdentity}, 0
      ))`,
    );
    const existing = await scoped
      .select({ state: aiWorkflowRun.state })
      .from(aiWorkflowRun)
      .where(
        and(
          sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`,
          sql`${aiWorkflowRun.readRequest}->>'kind' = 'staff_quote'`,
          sql`left(${aiWorkflowRun.idempotencyKey}, length(${storedIdentity})) = ${storedIdentity}`,
        ),
      );
    if (existing.some((run) => run.state !== 'dead_letter' && run.state !== 'superseded')) {
      // Let enqueueHmsJob attach this mailbox to an active shared result for run-id polling.
      await enqueueHmsJob(input, scoped);
      return NOT_QUEUED;
    }
    const now = input.createdAt ?? new Date();
    const batchRows =
      !existing.length && input.triggerMessageId
        ? await scoped
            .select({ metrics: aiWorkflowRun.metrics, nextRunAt: aiWorkflowRun.nextRunAt })
            .from(aiWorkflowRun)
            .where(
              and(
                eq(aiWorkflowRun.transportId, input.transportId),
                eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
                eq(aiWorkflowRun.triggerMessageId, input.triggerMessageId),
                sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`,
                sql`${aiWorkflowRun.readRequest}->>'kind' = 'staff_quote'`,
                ...(quoteJobNeedsSourceWitness(input)
                  ? [sql`${aiWorkflowRun.metrics}->>'quoteSourcePolicyVersion' = ${String(QUOTE_SOURCE_PROOF_VERSION)}`]
                  : []),
                ...(centurionExtraction
                  ? [sql`${aiWorkflowRun.readRequest}->'input'->>'sourceExtractionId' IS NOT DISTINCT FROM ${sourceExtractionId}`]
                  : []),
              ),
            )
        : [];
    const admittedSibling = batchRows.find((row) => {
      const metrics = metricsRecord(row.metrics);
      return (
        metrics.prefetchBatchDecision === 'admitted' ||
        (coversBatchSize(metrics, batchSize) && metrics.prefetchDeferred !== true)
      );
    });
    const deferredSibling = batchRows.find((row) => {
      const metrics = metricsRecord(row.metrics);
      return (
        metrics.prefetchBatchDecision === 'deferred' ||
        (coversBatchSize(metrics, batchSize) && metrics.prefetchDeferred === true)
      );
    });
    const reusedDecision = admittedSibling
      ? { action: 'admit' as const, used: 0, nextRunAt: now }
      : deferredSibling
        ? { action: 'defer' as const, used: 0, nextRunAt: deferredSibling.nextRunAt ?? now }
        : null;
    const reservationBatchSize = existing.length ? 1 : batchSize;
    const capacity = reusedDecision ?? await reservePrefetchCapacity(scoped, {
      transportId: input.transportId,
      kind: 'staff_quote',
      perHour,
      batchSize: reservationBatchSize,
      now,
      ...(existing.length || centurionExtraction ? {} : { excludeTriggerMessageId: input.triggerMessageId }),
    });
    if (capacity.action === 'disable') return NOT_QUEUED;
    // A dead-letter retry while the hour is full must not spawn another reserved row.
    if (capacity.action === 'defer' && existing.length) return NOT_QUEUED;
    const retryInput = existing.length
      ? { ...input, idempotencyKey: `${storedIdentity}:retry:${randomUUID()}` }
      : input;
    const queued = await enqueueHmsJob(
      {
        ...retryInput,
        nextRunAt: capacity.nextRunAt,
        extraMetrics: {
          ...retryInput.extraMetrics,
          prefetchBatchSize: reservationBatchSize,
          ...(existing.length
            ? {}
            : { prefetchBatchDecision: capacity.action === 'defer' ? 'deferred' : 'admitted' }),
          ...(capacity.action === 'defer' ? { prefetchDeferred: true } : {}),
        },
      },
      scoped,
    );
    return { created: queued.created, deferred: queued.created && capacity.action === 'defer' };
  });
}
