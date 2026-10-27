import { randomUUID } from 'node:crypto';
import { and, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import {
  enqueueHmsJob,
  hmsMailCopiesForMessage,
  hmsMailReadIdempotencyKey,
} from './hms-jobs.js';
import { reservePrefetchCapacity } from './prefetch-capacity.js';

export type PreparedQuoteCapResult = {
  created: boolean;
  deferred: boolean;
};

const NOT_QUEUED: PreparedQuoteCapResult = { created: false, deferred: false };

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
    const storedIdentity =
      copies.propertyCode && copies.messageIdHeader
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
    const capacity = await reservePrefetchCapacity(scoped, {
      transportId: input.transportId,
      kind: 'staff_quote',
      perHour,
      batchSize,
      now: input.createdAt,
      ...(existing.length ? {} : { excludeTriggerMessageId: input.triggerMessageId }),
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
          prefetchBatchSize: batchSize,
          ...(capacity.action === 'defer' ? { prefetchDeferred: true } : {}),
        },
      },
      scoped,
    );
    return { created: queued.created, deferred: queued.created && capacity.action === 'defer' };
  });
}
