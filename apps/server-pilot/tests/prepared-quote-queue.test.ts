import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  enqueuePreparedQuoteWithinCap,
} from '../src/ai/prepared-quote-queue.js';
import {
  enqueuePreparedQuoteWithinCap as enqueuePreparedQuoteWithinCapFromJobs,
  HMS_JOB_PRIORITY_PREFETCH,
} from '../src/ai/hms-jobs.js';
import { aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
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
) {
  return {
    transportId,
    threadId: seeded.threadId,
    triggerMessageId: seeded.messageId,
    workItemId: null,
    userId: null,
    request: {
      kind: 'staff_quote' as const,
      input: { ...STAFF_QUOTE_INPUT, messageId: seeded.messageId },
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

        expect(await enqueuePreparedQuoteWithinCap(db, preparedQuoteInput(first, transportId, firstKey), 2)).toEqual({
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

        expect(await enqueuePreparedQuoteWithinCap(db, preparedQuoteInput(first, transportId, firstKey), 2)).toEqual({
          created: false,
          deferred: false,
        });
        expect(await preparedRows(db, transportId)).toHaveLength(1);

        await db
          .update(aiWorkflowRun)
          .set({ state: 'dead_letter', finishedAt: new Date(), updatedAt: new Date() })
          .where(eq(aiWorkflowRun.id, afterFirst[0]!.id));

        expect(await enqueuePreparedQuoteWithinCap(db, preparedQuoteInput(first, transportId, firstKey), 2)).toEqual({
          created: true,
          deferred: false,
        });
        const afterRetry = await preparedRows(db, transportId);
        expect(afterRetry).toHaveLength(2);
        expect(afterRetry.some((row) => row.idempotencyKey.includes(':retry:'))).toBe(true);

        expect(await enqueuePreparedQuoteWithinCap(db, preparedQuoteInput(second, transportId, secondKey), 2)).toEqual({
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
        expect(await enqueuePreparedQuoteWithinCap(db, preparedQuoteInput(second, transportId, secondKey), 2)).toEqual({
          created: false,
          deferred: false,
        });
        expect(await preparedRows(db, transportId)).toHaveLength(3);
      }
    }));
});
