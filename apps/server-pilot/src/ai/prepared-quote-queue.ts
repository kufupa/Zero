import { randomUUID } from 'node:crypto';
import { and, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import {
  countRecentPrefetches,
  enqueueHmsJob,
  hmsMailCopiesForMessage,
  hmsMailReadIdempotencyKey,
  PREFETCH_WINDOW_MS,
} from './hms-jobs.js';

/** Serializes prepared-quote cap checks/inserts across workers for one mailbox. Live digests remain idempotent. */
export async function enqueuePreparedQuoteWithinCap(
  db: DB,
  input: Parameters<typeof enqueueHmsJob>[0],
  perHour: number,
): Promise<boolean> {
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
      return false;
    }
    const used = await countRecentPrefetches(
      scoped,
      input.transportId,
      'staff_quote',
      new Date(Date.now() - PREFETCH_WINDOW_MS),
    );
    if (used >= perHour) return false;
    const retryInput = existing.length
      ? { ...input, idempotencyKey: `${storedIdentity}:retry:${randomUUID()}` }
      : input;
    const queued = await enqueueHmsJob(retryInput, scoped);
    return queued.created;
  });
}
