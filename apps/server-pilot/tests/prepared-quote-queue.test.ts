import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  enqueuePreparedQuoteWithinCap,
} from '../src/ai/prepared-quote-queue.js';
import { countPrefetchReservations } from '../src/ai/prefetch-capacity.js';
import {
  enqueuePreparedQuoteWithinCap as enqueuePreparedQuoteWithinCapFromJobs,
  HMS_JOB_PRIORITY_PREFETCH,
} from '../src/ai/hms-jobs.js';
import { aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
import { DAVINCI_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';
import { quotePaneConfigForProperty } from '../src/hms/rate-catalogue.js';
import type { DB } from '../src/db/client.js';
import { DAVINCI_TRANSPORT_ID, NAVA_TRANSPORT_ID } from '../src/db/seed.js';
import { probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';

const reachable = await probeTestDb();

const STAFF_QUOTE_INPUT = {
  messageId: 'prepared-quote-queue-message',
  sourceHash: 'a'.repeat(64),
  selectionEpoch: 1,
  inputRevision: 1,
  groups: [
    {
      id: 'single',
      arrivalDate: '2099-11-12',
      departureDate: '2099-11-14',
      quantity: 1,
      adults: 2,
      childrenAges: [],
      board: 'bb' as const,
    },
  ],
  salesStrategy: 'BAR',
  company: '',
  agency: '',
  attention: '',
  clientEmail: '',
  clientTelephone: '',
};

async function seedMailboxMessage(db: DB, transportId: string, messageIdHeader: string) {
  const threadId = `thread-${randomUUID()}`;
  const messageId = `msg-${randomUUID()}`;
  await db.insert(mailThread).values({ id: threadId, transportId, threadRootId: threadId });
  await db.insert(message).values({
    id: messageId,
    transportId,
    threadId,
    direction: 'inbound',
    fromAddress: 'agent@example.test',
    toAddresses: [],
    subject: 'Quote request',
    textBody: 'Please quote a future stay.',
    receivedAt: new Date(),
    messageIdHeader,
  });
  return { threadId, messageId };
}

function preparedQuoteInput(
  seeded: { threadId: string; messageId: string },
  transportId: string,
  idempotencyKey: string,
  salesStrategy: string = STAFF_QUOTE_INPUT.salesStrategy,
) {
  return {
    transportId,
    threadId: seeded.threadId,
    triggerMessageId: seeded.messageId,
    workItemId: null,
    userId: null,
    request: {
      kind: 'staff_quote' as const,
      input: { ...STAFF_QUOTE_INPUT, messageId: seeded.messageId, salesStrategy },
    },
    priority: HMS_JOB_PRIORITY_PREFETCH,
    idempotencyKey,
    extraMetrics: { quotePrepared: true },
  };
}

async function preparedRows(db: DB, transportId: string) {
  return db
    .select({
      id: aiWorkflowRun.id,
      state: aiWorkflowRun.state,
      idempotencyKey: aiWorkflowRun.idempotencyKey,
      triggerMessageId: aiWorkflowRun.triggerMessageId,
      readRequest: aiWorkflowRun.readRequest,
      nextRunAt: aiWorkflowRun.nextRunAt,
      metrics: aiWorkflowRun.metrics,
    })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, transportId),
        sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`,
        sql`${aiWorkflowRun.readRequest}->>'kind' = 'staff_quote'`,
      ),
    );
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('prepared quote queue cap seam', { timeout: 60_000 }, () => {
  it('moved helper retains cap/idempotency', () =>
    withSeededTestDb(async (db) => {
        expect(enqueuePreparedQuoteWithinCapFromJobs).toBeTypeOf('function');
      const mailboxes = [
        { transportId: DAVINCI_TRANSPORT_ID, registeredProperty: true },
        { transportId: NAVA_TRANSPORT_ID, registeredProperty: false },
      ];
      for (const { transportId, registeredProperty } of mailboxes) {
        const first = await seedMailboxMessage(db, transportId, `quote-first-${randomUUID()}@example.test`);
        const second = await seedMailboxMessage(db, transportId, `quote-second-${randomUUID()}@example.test`);
        const firstKey = `hms-job:staff-quote-prepared:${transportId}:${first.messageId}:${randomUUID()}`;
        const secondKey = `hms-job:staff-quote-prepared:${transportId}:${second.messageId}:${randomUUID()}`;

        expect(await enqueuePreparedQuoteWithinCap(db, preparedQuoteInput(first, transportId, firstKey), 1)).toEqual({
          created: true,
          deferred: false,
        });
        const afterFirst = await preparedRows(db, transportId);
        expect(afterFirst).toHaveLength(1);
        if (registeredProperty) {
          expect(afterFirst[0]?.idempotencyKey).toMatch(/^hms-job:mail:[A-Z0-9]+:/);
        } else {
          expect(afterFirst[0]?.idempotencyKey).toBe(firstKey);
        }

        expect(await enqueuePreparedQuoteWithinCap(db, preparedQuoteInput(first, transportId, firstKey), 1)).toEqual({
          created: false,
          deferred: false,
        });
        expect(await preparedRows(db, transportId)).toHaveLength(1);

        const aged = new Date(Date.now() - 2 * 60 * 60_000);
        await db
          .update(aiWorkflowRun)
          .set({ state: 'dead_letter', createdAt: aged, finishedAt: new Date(), updatedAt: new Date() })
          .where(eq(aiWorkflowRun.id, afterFirst[0]!.id));

        expect(await enqueuePreparedQuoteWithinCap(db, preparedQuoteInput(first, transportId, firstKey), 1)).toEqual({
          created: true,
          deferred: false,
        });
        const afterRetry = await preparedRows(db, transportId);
        expect(afterRetry).toHaveLength(2);
        expect(afterRetry.some((row) => row.idempotencyKey.includes(':retry:'))).toBe(true);

        expect(await enqueuePreparedQuoteWithinCap(db, preparedQuoteInput(second, transportId, secondKey), 1)).toEqual({
          created: true,
          deferred: true,
        });
        const afterOverflow = await preparedRows(db, transportId);
        expect(afterOverflow).toHaveLength(3);
        const overflow = afterOverflow.filter(
          (row) => (row.metrics as { prefetchDeferred?: boolean } | null)?.prefetchDeferred === true,
        );
        expect(overflow.length).toBeGreaterThanOrEqual(1);
        expect(overflow.every((row) => row.nextRunAt && row.nextRunAt.getTime() > Date.now())).toBe(true);
        expect(await enqueuePreparedQuoteWithinCap(db, preparedQuoteInput(second, transportId, secondKey), 1)).toEqual({
          created: false,
          deferred: false,
        });
        expect(await preparedRows(db, transportId)).toHaveLength(3);
      }
    }));

  it('keeps interleaved strategy batches on their first capacity decision', () =>
    withSeededTestDb(async (db) => {
      const config = await quotePaneConfigForProperty(DAVINCI_HMS_READ_TARGET.propertyCode, DAVINCI_TRANSPORT_ID);
      const strategies = config?.salesStrategies ?? [];
      expect(strategies).toHaveLength(9);
      const first = await seedMailboxMessage(db, DAVINCI_TRANSPORT_ID, `quote-batch-a-${randomUUID()}@example.test`);
      const second = await seedMailboxMessage(db, DAVINCI_TRANSPORT_ID, `quote-batch-b-${randomUUID()}@example.test`);
      const batchSize = strategies.length;
      const makeBatch = (mail: typeof first, prefix: string) =>
        strategies.map((strategy, index) =>
          preparedQuoteInput(
            mail,
            DAVINCI_TRANSPORT_ID,
            `${prefix}:${mail.messageId}:${index}`,
            strategy.requestValue,
          ),
        );
      const firstBatch = makeBatch(first, 'quote-batch-a');
      const secondBatch = makeBatch(second, 'quote-batch-b');
      const enqueue = (input: ReturnType<typeof preparedQuoteInput>) =>
        enqueuePreparedQuoteWithinCap(db, input, 6, batchSize);

      expect(await enqueue(firstBatch[0]!)).toEqual({ created: true, deferred: false });
      expect(await enqueue(secondBatch[0]!)).toEqual({ created: true, deferred: true });
      for (let index = 1; index < batchSize; index++) {
        expect(await enqueue(firstBatch[index]!)).toEqual({ created: true, deferred: false });
        expect(await enqueue(secondBatch[index]!)).toEqual({ created: true, deferred: true });
      }

      const allRows = await preparedRows(db, DAVINCI_TRANSPORT_ID);
      const firstRows = allRows.filter((row) => row.triggerMessageId === first.messageId);
      const secondRows = allRows.filter((row) => row.triggerMessageId === second.messageId);
      expect(firstRows).toHaveLength(batchSize);
      expect(
        firstRows.every(
          (row) =>
            (row.metrics as { prefetchBatchDecision?: string; prefetchDeferred?: boolean } | null)
              ?.prefetchBatchDecision === 'admitted' &&
            (row.metrics as { prefetchDeferred?: boolean } | null)?.prefetchDeferred !== true,
        ),
      ).toBe(true);
      expect(secondRows).toHaveLength(batchSize);
      expect(
        secondRows.every(
          (row) =>
            (row.metrics as { prefetchBatchDecision?: string; prefetchDeferred?: boolean } | null)
              ?.prefetchBatchDecision === 'deferred' &&
            (row.metrics as { prefetchDeferred?: boolean } | null)?.prefetchDeferred === true &&
            row.nextRunAt !== null &&
            row.nextRunAt.getTime() > Date.now(),
        ),
      ).toBe(true);
    }));

  it('does not reuse an unmarked legacy strategy row as admission for a larger batch', () =>
    withSeededTestDb(async (db) => {
      const config = await quotePaneConfigForProperty(DAVINCI_HMS_READ_TARGET.propertyCode, DAVINCI_TRANSPORT_ID);
      const strategies = config?.salesStrategies ?? [];
      expect(strategies).toHaveLength(9);
      const legacy = await seedMailboxMessage(db, DAVINCI_TRANSPORT_ID, `quote-legacy-${randomUUID()}@example.test`);
      const legacyInput = preparedQuoteInput(
        legacy,
        DAVINCI_TRANSPORT_ID,
        `quote-legacy:${legacy.messageId}:0`,
        strategies[0]!.requestValue,
      );
      expect(await enqueuePreparedQuoteWithinCap(db, legacyInput, 6)).toEqual({ created: true, deferred: false });

      const [legacyRow] = (await preparedRows(db, DAVINCI_TRANSPORT_ID)).filter(
        (row) => row.triggerMessageId === legacy.messageId,
      );
      if (!legacyRow) throw new Error('expected a legacy prepared quote row');
      const aged = new Date(Date.now() - 2 * 60 * 60_000);
      await db
        .update(aiWorkflowRun)
        .set({ metrics: { quotePrepared: true }, createdAt: aged, updatedAt: aged })
        .where(eq(aiWorkflowRun.id, legacyRow.id));

      const other = await seedMailboxMessage(db, DAVINCI_TRANSPORT_ID, `quote-other-${randomUUID()}@example.test`);
      for (const [index, strategy] of strategies.slice(0, 6).entries()) {
        expect(
          await enqueuePreparedQuoteWithinCap(
            db,
            preparedQuoteInput(
              other,
              DAVINCI_TRANSPORT_ID,
              `quote-other:${other.messageId}:${index}`,
              strategy.requestValue,
            ),
            6,
          ),
        ).toEqual({ created: true, deferred: false });
      }

      const nextLegacyInput = preparedQuoteInput(
        legacy,
        DAVINCI_TRANSPORT_ID,
        `quote-legacy:${legacy.messageId}:1`,
        strategies[1]!.requestValue,
      );
      expect(await enqueuePreparedQuoteWithinCap(db, nextLegacyInput, 6, strategies.length)).toEqual({
        created: true,
        deferred: true,
      });
      const legacyRows = (await preparedRows(db, DAVINCI_TRANSPORT_ID)).filter(
        (row) => row.triggerMessageId === legacy.messageId,
      );
      const deferred = legacyRows.find(
        (row) => (row.metrics as { prefetchBatchDecision?: string } | null)?.prefetchBatchDecision === 'deferred',
      );
      expect(deferred?.metrics).toMatchObject({
        quotePrepared: true,
        prefetchBatchDecision: 'deferred',
        prefetchBatchSize: strategies.length,
      });
    }));

  it('charges only the extra slot for a single strategy retry', () =>
    withSeededTestDb(async (db) => {
      const config = await quotePaneConfigForProperty(DAVINCI_HMS_READ_TARGET.propertyCode, DAVINCI_TRANSPORT_ID);
      const strategies = config?.salesStrategies.slice(0, 4) ?? [];
      expect(strategies).toHaveLength(4);
      const seeded = await seedMailboxMessage(db, DAVINCI_TRANSPORT_ID, `quote-retry-${randomUUID()}@example.test`);
      const inputs = strategies.map((strategy, index) =>
        preparedQuoteInput(
          seeded,
          DAVINCI_TRANSPORT_ID,
          `quote-retry:${seeded.messageId}:${index}`,
          strategy.requestValue,
        ),
      );
      for (const input of inputs) {
        expect(await enqueuePreparedQuoteWithinCap(db, input, 6, strategies.length)).toEqual({
          created: true,
          deferred: false,
        });
      }

      const beforeRetry = (await preparedRows(db, DAVINCI_TRANSPORT_ID)).filter(
        (row) => row.triggerMessageId === seeded.messageId,
      );
      const retryInput = inputs[0]!;
      const retryStrategy = retryInput.request.input.salesStrategy;
      const failed = beforeRetry.find(
        (row) =>
          (row.readRequest as { input?: { salesStrategy?: string } } | null)?.input?.salesStrategy ===
          retryStrategy,
      );
      if (!failed) throw new Error('expected a queued strategy to retry');
      const failedAt = new Date();
      await db
        .update(aiWorkflowRun)
        .set({ state: 'dead_letter', finishedAt: failedAt, updatedAt: failedAt })
        .where(eq(aiWorkflowRun.id, failed.id));

      expect(await enqueuePreparedQuoteWithinCap(db, retryInput, 6, strategies.length)).toEqual({
        created: true,
        deferred: false,
      });
      const afterRetry = (await preparedRows(db, DAVINCI_TRANSPORT_ID)).filter(
        (row) => row.triggerMessageId === seeded.messageId,
      );
      expect(afterRetry).toHaveLength(5);
      expect(
        afterRetry.some(
          (row) =>
            row.idempotencyKey.includes(':retry:') &&
            (row.metrics as { prefetchBatchSize?: number } | null)?.prefetchBatchSize === 1,
        ),
      ).toBe(true);
      expect(
        await countPrefetchReservations(db, {
          transportId: DAVINCI_TRANSPORT_ID,
          kind: 'staff_quote',
          since: new Date(Date.now() - 60 * 60_000),
        }),
      ).toMatchObject({ used: 5 });
    }));
});
