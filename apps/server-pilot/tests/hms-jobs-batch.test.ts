import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { appRouter } from '../src/trpc/router.js';
import {
  cancelHmsBatch,
  enqueueHmsBatch,
  enqueueHmsJob,
  HMS_JOB_PRIORITY_PREFETCH,
  HMS_JOB_PRIORITY_USER,
  readHmsBatchView,
  requeueHmsReadsAfterRestart,
  selectHmsBatchRequest,
  type HmsBatchView,
  type HmsJobRequest,
} from '../src/ai/hms-jobs.js';
import {
  claimNextAiRun,
  HMS_JOB_PROMPT_VERSION,
  markAiRunDeadLetter,
  markAiRunRunning,
  markAiRunSucceeded,
  type AiWorkflowRun,
} from '../src/ai/run-ledger.js';
import { aiDraftGeneration, aiWorkflowRun, mailboxTransport, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import type { DB } from '../src/db/client.js';
import { CENTURION_USER_ID, TRANSPORT_ID } from '../src/db/seed.js';
import { openTestDbSession, probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';

const reachable = await probeTestDb();
const LANE_OWNER = 'hms-ai-worker-batch-test';
const ARRIVAL = '2026-10-12';

type SeededWorkItem = {
  workItemId: string;
  threadId: string;
  messageId: string;
  extractionId: string;
  confirmation: string;
};

type SeedOptions = {
  transportId?: string;
  item?: (index: number) => {
    kind?: 'booking' | 'amendment' | 'quote' | 'other';
    payload?: Record<string, unknown>;
    subject?: string;
    textBody?: string;
  };
};

function confirmationFor(index: number): string {
  return `${String(index + 1).padStart(7, '0')}-1`;
}

async function insertInChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let start = 0; start < rows.length; start += 500) {
    await insert(rows.slice(start, start + 500));
  }
}

async function seedBatchItems(db: DB, count: number, options: SeedOptions = {}): Promise<SeededWorkItem[]> {
  const transportId = options.transportId ?? TRANSPORT_ID;
  const items = Array.from({ length: count }, (_, index) => {
    const confirmation = confirmationFor(index);
    const input = options.item?.(index) ?? {};
    return {
      workItemId: randomUUID(),
      threadId: `batch-thread-${randomUUID()}`,
      messageId: `batch-message-${randomUUID()}`,
      extractionId: randomUUID(),
      confirmation,
      kind: input.kind ?? 'booking',
      payload:
        input.payload ??
        {
          confirmationNumbers: [confirmation],
          stays: [{ requested: { arrival: ARRIVAL } }],
        },
      subject: input.subject ?? 'Booking request',
      textBody: input.textBody ?? 'Please help with this stay.',
    };
  });

  await insertInChunks(
    items,
    (chunk) =>
      db.insert(mailThread).values(
        chunk.map((item) => ({
          id: item.threadId,
          transportId,
          threadRootId: item.threadId,
          subject: item.subject,
        })),
      ),
  );
  await insertInChunks(
    items,
    (chunk) =>
      db.insert(message).values(
        chunk.map((item) => ({
          id: item.messageId,
          transportId,
          threadId: item.threadId,
          direction: 'inbound' as const,
          fromAddress: 'guest@example.test',
          subject: item.subject,
          textBody: item.textBody,
          receivedAt: new Date(),
        })),
      ),
  );
  await insertInChunks(
    items,
    (chunk) =>
      db.insert(mailExtraction).values(
        chunk.map((item) => ({
          id: item.extractionId,
          messageId: item.messageId,
          extractorVersion: `batch-test-${item.extractionId}`,
          status: 'succeeded',
          kind: item.kind,
          payload: item.payload,
        })),
      ),
  );
  await insertInChunks(
    items,
    (chunk) =>
      db.insert(workItem).values(
        chunk.map((item) => ({
          id: item.workItemId,
          transportId,
          threadId: item.threadId,
          sourceMessageId: item.messageId,
          extractionId: item.extractionId,
          kind: item.kind,
          status: 'needs_you',
        })),
      ),
  );

  return items;
}

async function batchRows(db: DB, batchId: string) {
  return db
    .select()
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, TRANSPORT_ID),
        or(
          sql`${aiWorkflowRun.metrics}->>'batchId' = ${batchId}`,
          sql`${aiWorkflowRun.metrics}->'batchLinks' @> ${JSON.stringify([{ batchId }])}::jsonb`,
        ),
      ),
    );
}

/** The DB-backed tests run with HMS_JOB_QUEUE on, so a null (queue off) reply is a test failure. */
async function enqueueBatch(...args: Parameters<typeof enqueueHmsBatch>): Promise<HmsBatchView> {
  const view = await enqueueHmsBatch(...args);
  if (!view) throw new Error('HMS_JOB_QUEUE is off in this test');
  return view;
}

/** Counts transactions opened on `db` and the rows each insert statement carries; behavior is unchanged. */
function spyBatchWrites(db: DB) {
  const rowCounts: number[] = [];
  const transaction = db.transaction.bind(db);
  const transactionSpy = vi.spyOn(db, 'transaction').mockImplementation(((run: (tx: DB) => Promise<unknown>) =>
    transaction((tx) => {
      const insert = tx.insert.bind(tx);
      vi.spyOn(tx, 'insert').mockImplementation(((table: unknown) => {
        const builder = insert(table as never);
        const values = builder.values.bind(builder);
        vi.spyOn(builder, 'values').mockImplementation(((rows: unknown[]) => {
          rowCounts.push(rows.length);
          return values(rows as never);
        }) as never);
        return builder;
      }) as never);
      return run(tx as DB);
    })) as never);
  return { transactionSpy, rowCounts };
}

async function claimJob(db: DB, ownerId = LANE_OWNER): Promise<AiWorkflowRun> {
  const run = await claimNextAiRun({
    ownerId,
    lane: 'hms',
    runKind: 'read_tool',
    promptVersion: HMS_JOB_PROMPT_VERSION,
    db,
  });
  if (!run) throw new Error('expected a claimable HMS job');
  return run;
}

async function startJob(db: DB, run: AiWorkflowRun): Promise<AiWorkflowRun> {
  const running = await markAiRunRunning(
    {
      runId: run.id,
      claimOwner: run.claimOwner!,
      claimToken: run.claimToken!,
      deadlineAt: run.deadlineAt!,
    },
    db,
  );
  if (!running) throw new Error('markAiRunRunning fenced out');
  return { ...run, state: 'running' };
}

async function finishJob(db: DB, run: AiWorkflowRun): Promise<void> {
  const marked = await markAiRunSucceeded(
    {
      runId: run.id,
      claimOwner: run.claimOwner!,
      claimToken: run.claimToken!,
      expectedStates: ['running'],
      readResult: {
        kind: (run.readRequest as HmsJobRequest).kind,
        outcome: 'found',
        asOf: new Date().toISOString(),
      },
      metrics: { hmsJob: true, outcome: 'found' },
    },
    db,
  );
  if (!marked) throw new Error('markAiRunSucceeded fenced out');
}

function caller() {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: CENTURION_USER_ID, email: 'centurion@example.test', name: 'Centurion' },
    activeTransportId: TRANSPORT_ID,
    transportEmail: 'centurion@example.test',
    accessRole: 'owner',
  } as never);
}

beforeEach(() => {
  vi.stubEnv('PORT', '3000');
  vi.stubEnv('BETTER_AUTH_URL', 'https://nava.example.test');
  vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(32));
  vi.stubEnv('AWS_REGION', 'synthetic-region-1');
  vi.stubEnv('S3_BUCKET', 'hms-batch-test');
  vi.stubEnv('HMS_JOB_QUEUE', 'on');
  vi.stubEnv('HMS_LANE_PAUSED', '');
});

afterEach(() => vi.unstubAllEnvs());

describe('HMS batch request selection (pure)', () => {
  it('prefers confirmation lookup, then explicit surname plus arrival, else skips', () => {
    expect(
      selectHmsBatchRequest({
        kind: 'booking',
        payload: {
          confirmationNumbers: ['1234567-1'],
          stays: [{ requested: { arrival: ARRIVAL } }],
        },
        subject: 'Booking request',
        textBody: 'Guest: John Smith arriving 12 October.',
      }),
    ).toEqual({ request: { kind: 'find', confirmation: '1234567-1' } });
    expect(
      selectHmsBatchRequest({
        kind: 'amendment',
        payload: { confirmationNumbers: [], stays: [{ booked: { arrival: ARRIVAL } }] },
        subject: 'Booking request',
        textBody: 'Guest: John Smith arriving 12 October.',
      }),
    ).toEqual({ request: { kind: 'search_guest', lastName: 'Smith', arrival: ARRIVAL } });
    expect(selectHmsBatchRequest({ kind: 'other', payload: {}, subject: null, textBody: null })).toEqual({
      skipped: 'insufficient_data',
    });
  });

  it('queue, read, and cancel procedures are no-ops while HMS_JOB_QUEUE is off', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', 'off');
    const batchId = randomUUID();
    const batchCaller = caller();
    const input = { batchId, workItemIds: [randomUUID()] };
    await expect(batchCaller.paneStayLookup.queueBatch(input)).resolves.toBeNull();
    await expect(batchCaller.paneStayLookup.batchStatus({ batchId })).resolves.toBeNull();
    await expect(batchCaller.paneStayLookup.cancelBatch({ batchId })).resolves.toBeNull();
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('HMS batch queue (lane DB)', { timeout: 180_000 }, () => {
  it('is idempotent for the same batchId and persists batch membership for remount reads', () =>
    withSeededTestDb(async (db) => {
      const [item] = await seedBatchItems(db, 1);
      const batchId = randomUUID();
      const first = await enqueueBatch(
        { batchId, transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, workItemIds: [item!.workItemId] },
        db,
      );
      const [row] = await batchRows(db, batchId);
      expect(row?.idempotencyKey).toBe(`hms-job:batch:${batchId}:${item!.workItemId}`);
      const before = (await batchRows(db, batchId)).length;
      const replay = await enqueueBatch(
        { batchId, transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, workItemIds: [item!.workItemId] },
        db,
      );
      expect((await batchRows(db, batchId)).length).toBe(before);
      expect(replay).toMatchObject({ batchId, status: 'queued', items: [{ itemIndex: 0, workItemId: item!.workItemId }] });
      expect(first.items[0]?.runId).toBe(replay.items[0]?.runId);
    }));

  it('inserts 1,200 items in chunks and claims queued work in submission order', () =>
    withSeededTestDb(async (db) => {
      const items = await seedBatchItems(db, 1_200);
      const batchId = randomUUID();
      const writes = spyBatchWrites(db);
      const view = await enqueueBatch(
        { batchId, transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, workItemIds: items.map((item) => item.workItemId) },
        db,
      );
      expect(writes.transactionSpy).toHaveBeenCalledTimes(1);
      expect(writes.rowCounts).toEqual([500, 500, 200]);
      const queued = await db
        .select({ workItemId: aiWorkflowRun.workItemId, createdAt: aiWorkflowRun.createdAt, priority: aiWorkflowRun.priority })
        .from(aiWorkflowRun)
        .where(sql`${aiWorkflowRun.metrics}->>'batchId' = ${batchId}`)
        .orderBy(aiWorkflowRun.createdAt);
      expect(view.items).toHaveLength(1_200);
      expect(queued).toHaveLength(1_200);
      expect(queued.map((row) => row.workItemId)).toEqual(items.map((item) => item.workItemId));
      expect(queued.every((row) => row.priority === HMS_JOB_PRIORITY_PREFETCH)).toBe(true);
      expect(queued.every((row, index) => index === 0 || row.createdAt.getTime() > queued[index - 1]!.createdAt.getTime())).toBe(true);

      const claimedWorkItemIds: Array<string | null> = [];
      for (let index = 0; index < items.length; index += 1) {
        claimedWorkItemIds.push((await claimJob(db)).workItemId);
      }
      expect(claimedWorkItemIds).toEqual(items.map((item) => item.workItemId));
    }));

  it('rejects unknown or foreign-transport work items before inserting any batch rows', () =>
    withSeededTestDb(async (db) => {
      const [valid] = await seedBatchItems(db, 1);
      const foreignTransportId = `batch-foreign-${randomUUID()}`;
      const foreignEmail = `${foreignTransportId}@example.test`;
      await db.insert(mailboxTransport).values({
        id: foreignTransportId,
        email: foreignEmail,
        ownerHeaderValue: foreignEmail,
      });
      const [foreign] = await seedBatchItems(db, 1, { transportId: foreignTransportId });
      for (const ids of [
        [valid!.workItemId, randomUUID()],
        [valid!.workItemId, foreign!.workItemId],
      ]) {
        const batchId = randomUUID();
        await expect(
          enqueueHmsBatch(
            { batchId, transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, workItemIds: ids },
            db,
          ),
        ).rejects.toThrow();
        expect(await batchRows(db, batchId)).toHaveLength(0);
      }
    }));

  it('uses each item source message and its latest extraction, not a stale work-item extraction id', () =>
    withSeededTestDb(async (db) => {
      const [item] = await seedBatchItems(db, 1);
      const latestExtractionId = randomUUID();
      await db.insert(mailExtraction).values({
        id: latestExtractionId,
        messageId: item!.messageId,
        extractorVersion: `batch-newer-${latestExtractionId}`,
        status: 'succeeded',
        kind: 'booking',
        payload: { confirmationNumbers: ['7654321-2'], stays: [{ requested: { arrival: ARRIVAL } }] },
        createdAt: new Date(Date.now() + 60_000),
      });
      const laterMessageId = `batch-later-${randomUUID()}`;
      await db.insert(message).values({
        id: laterMessageId,
        transportId: TRANSPORT_ID,
        threadId: item!.threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.test',
        subject: 'A newer message in same thread',
        receivedAt: new Date(Date.now() + 120_000),
      });
      const batch = await enqueueBatch(
        { batchId: randomUUID(), transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, workItemIds: [item!.workItemId] },
        db,
      );
      const [run] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, batch.items[0]!.runId!));
      expect(run?.triggerMessageId).toBe(item!.messageId);
      expect(run?.readRequest).toEqual({ kind: 'find', confirmation: '7654321-2' });
      expect(run?.triggerMessageId).not.toBe(laterMessageId);
    }));

  it('reuses an in-flight lookup without inserting another lookup row', () =>
    withSeededTestDb(async (db) => {
      const [item] = await seedBatchItems(db, 1);
      const { run: existing } = await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId: item!.threadId,
          triggerMessageId: item!.messageId,
          workItemId: item!.workItemId,
          userId: CENTURION_USER_ID,
          request: { kind: 'find', confirmation: item!.confirmation },
          priority: 10,
          idempotencyKey: `hms-job:test-inflight:${randomUUID()}`,
        },
        db,
      );
      const before = await db
        .select({ id: aiWorkflowRun.id })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.workItemId, item!.workItemId));
      const batchId = randomUUID();
      const batch = await enqueueBatch(
        { batchId, transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, workItemIds: [item!.workItemId] },
        db,
      );
      const after = await db
        .select({ id: aiWorkflowRun.id })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.workItemId, item!.workItemId));
      expect(after).toHaveLength(before.length);
      expect(batch.items[0]).toMatchObject({ status: 'reused', runId: existing.id, job: { status: 'queued' } });
      expect((await batchRows(db, batchId))).toHaveLength(1);
    }));

  it('reuses a result under one hour old, but queues a new lookup when result is older', () =>
    withSeededTestDb(async (db) => {
      const items = await seedBatchItems(db, 2);
      const finishedAt = new Date();
      for (const [index, item] of items.entries()) {
        await enqueueHmsJob(
          {
            transportId: TRANSPORT_ID,
            threadId: item.threadId,
            triggerMessageId: item.messageId,
            workItemId: item.workItemId,
            userId: CENTURION_USER_ID,
            request: { kind: 'find', confirmation: item.confirmation },
            priority: 10,
            idempotencyKey: `hms-job:test-freshness:${randomUUID()}`,
          },
          db,
        );
        await db
          .update(aiWorkflowRun)
          .set({
            state: 'succeeded',
            readResult: { kind: 'find', outcome: 'found', asOf: finishedAt.toISOString() },
            finishedAt: new Date(Date.now() - (index === 0 ? 59 : 61) * 60_000),
            updatedAt: finishedAt,
          })
          .where(eq(aiWorkflowRun.workItemId, item.workItemId));
      }
      const batch = await enqueueBatch(
        {
          batchId: randomUUID(),
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: items.map((item) => item.workItemId),
        },
        db,
      );
      expect(batch.items.map((item) => item.status)).toEqual(['reused', 'queued']);
      expect(batch.items[0]?.job?.result).toMatchObject({ outcome: 'found' });
    }));

  it('marks insufficient items skipped while queueing items with usable extraction data', () =>
    withSeededTestDb(async (db) => {
      const items = await seedBatchItems(db, 3, {
        item: (index) =>
          index === 0
            ? { kind: 'other', payload: {}, subject: 'FYI', textBody: 'No stay details.' }
            : index === 1
              ? {
                  kind: 'amendment',
                  payload: { confirmationNumbers: [], stays: [{ booked: { arrival: ARRIVAL } }] },
                  textBody: 'Guest: John Smith arriving 12 October.',
                }
              : {},
      });
      const batch = await enqueueBatch(
        {
          batchId: randomUUID(),
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: items.map((item) => item.workItemId),
        },
        db,
      );
      expect(batch.items.map((item) => item.status)).toEqual(['skipped', 'queued', 'queued']);
      expect(batch.items[0]).toMatchObject({ reason: 'insufficient_data', runId: null });
      expect(batch.items[1]?.request).toEqual({ kind: 'search_guest', lastName: 'Smith', arrival: ARRIVAL });
    }));

  it('cancels only the queued remainder mid-batch and keeps running and done results', () =>
    withSeededTestDb(async (db) => {
      const items = await seedBatchItems(db, 3);
      const batchId = randomUUID();
      const input = {
        batchId,
        transportId: TRANSPORT_ID,
        userId: CENTURION_USER_ID,
        workItemIds: items.map((item) => item.workItemId),
      };
      const enqueued = await enqueueBatch(input, db);
      expect(enqueued.status).toBe('queued');
      const first = await startJob(db, await claimJob(db));
      await finishJob(db, first);
      const running = await startJob(db, await claimJob(db));

      const cancelled = await cancelHmsBatch({ batchId, transportId: TRANSPORT_ID }, db);
      expect(cancelled).toMatchObject({
        status: 'cancelled',
        items: [{ status: 'done' }, { status: 'running' }, { status: 'cancelled' }],
      });
      await finishJob(db, running);
      const remounted = await readHmsBatchView({ batchId, transportId: TRANSPORT_ID }, db);
      expect(remounted).toMatchObject({
        status: 'cancelled',
        items: [
          { status: 'done', job: { result: { outcome: 'found' } } },
          { status: 'done', job: { result: { outcome: 'found' } } },
          { status: 'cancelled' },
        ],
      });
      expect(await cancelHmsBatch({ batchId, transportId: TRANSPORT_ID }, db)).toEqual(remounted);
    }));

  it('keeps a reused lookup alive for another batch until its last queued consumer cancels', () =>
    withSeededTestDb(async (db) => {
      const [item] = await seedBatchItems(db, 1);
      const firstBatchId = randomUUID();
      const secondBatchId = randomUUID();
      const first = await enqueueBatch(
        {
          batchId: firstBatchId,
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: [item!.workItemId],
        },
        db,
      );
      const second = await enqueueBatch(
        {
          batchId: secondBatchId,
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: [item!.workItemId],
        },
        db,
      );
      expect(second.items[0]).toMatchObject({ status: 'reused', runId: first.items[0]?.runId });

      expect((await cancelHmsBatch({ batchId: firstBatchId, transportId: TRANSPORT_ID }, db))?.status).toBe(
        'cancelled',
      );
      expect(await readHmsBatchView({ batchId: secondBatchId, transportId: TRANSPORT_ID }, db)).toMatchObject({
        status: 'queued',
        items: [{ status: 'reused', job: { status: 'queued' } }],
      });
      const [stillQueued] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, first.items[0]!.runId!));
      expect(stillQueued?.state).toBe('queued');

      expect((await cancelHmsBatch({ batchId: secondBatchId, transportId: TRANSPORT_ID }, db))?.status).toBe(
        'cancelled',
      );
      const [finallyCancelled] = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.id, first.items[0]!.runId!));
      expect(finallyCancelled?.state).toBe('superseded');
    }));

  it('increments crashCount without burning attempts and dead-letters the third worker restart', () =>
    withSeededTestDb(async (db) => {
      const items = await seedBatchItems(db, 2);
      const batch = await enqueueBatch(
        {
          batchId: randomUUID(),
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: items.map((item) => item.workItemId),
        },
        db,
      );
      const [poison, done] = batch.items;
      await db
        .update(aiWorkflowRun)
        .set({ state: 'succeeded', readResult: { outcome: 'found' }, finishedAt: new Date() })
        .where(eq(aiWorkflowRun.id, done!.runId!));

      for (let restart = 1; restart <= 3; restart += 1) {
        await db
          .update(aiWorkflowRun)
          .set({
            state: 'running',
            claimOwner: `hms-ai-worker-dead-${restart}`,
            claimToken: randomUUID(),
            heartbeatAt: new Date(Date.now() - 2 * 60 * 60_000),
            updatedAt: new Date(Date.now() - 2 * 60 * 60_000),
          })
          .where(eq(aiWorkflowRun.id, poison!.runId!));
        expect(await requeueHmsReadsAfterRestart({ ownerId: `hms-ai-worker-new-${restart}` }, db)).toBe(1);
        const [run] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, poison!.runId!));
        expect(run?.metrics).toMatchObject({ crashCount: restart });
        expect(run?.attempts).toBe(0);
        expect(run?.state).toBe(restart === 3 ? 'dead_letter' : 'retry_wait');
      }
      expect(await readHmsBatchView({ batchId: batch.batchId, transportId: TRANSPORT_ID }, db)).toMatchObject({
        status: 'partial',
        items: [{ status: 'failed' }, { status: 'done' }],
      });
    }));

  it('leaves the serial batch queued with no attempts while HMS_LANE_PAUSED is set', () =>
    withSeededTestDb(async (db) => {
      const [item] = await seedBatchItems(db, 1);
      const batch = await enqueueBatch(
        { batchId: randomUUID(), transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, workItemIds: [item!.workItemId] },
        db,
      );
      vi.stubEnv('HMS_LANE_PAUSED', '1');
      expect(
        await claimNextAiRun({
          ownerId: LANE_OWNER,
          lane: 'hms',
          runKind: 'read_tool',
          promptVersion: HMS_JOB_PROMPT_VERSION,
          db,
        }),
      ).toBeNull();
      const [run] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, batch.items[0]!.runId!));
      expect(run).toMatchObject({ state: 'queued', attempts: 0 });
      expect((await readHmsBatchView({ batchId: batch.batchId, transportId: TRANSPORT_ID }, db))?.status).toBe('queued');
      // Same item is claimable once unpaused, so the null above came from the pause alone.
      vi.stubEnv('HMS_LANE_PAUSED', '');
      expect((await claimJob(db)).id).toBe(batch.items[0]!.runId);
    }));

  it('lets a failed item dead-letter without blocking later batch items and reports partial', () =>
    withSeededTestDb(async (db) => {
      const items = await seedBatchItems(db, 2);
      const batch = await enqueueBatch(
        {
          batchId: randomUUID(),
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: items.map((item) => item.workItemId),
        },
        db,
      );
      const failed = await startJob(db, await claimJob(db));
      await markAiRunDeadLetter(
        {
          runId: failed.id,
          claimOwner: failed.claimOwner!,
          claimToken: failed.claimToken!,
          expectedStates: ['running'],
          lastError: 'synthetic failure',
          failureClass: 'SCHEMA_DRIFT',
        },
        db,
      );
      const next = await startJob(db, await claimJob(db));
      await finishJob(db, next);
      expect(await readHmsBatchView({ batchId: batch.batchId, transportId: TRANSPORT_ID }, db)).toMatchObject({
        status: 'partial',
        items: [{ status: 'failed' }, { status: 'done' }],
      });
    }));

  it('rolls queued → running → done and reads the stored result after remount', () =>
    withSeededTestDb(async (db) => {
      const items = await seedBatchItems(db, 2);
      const batchId = randomUUID();
      const batch = await enqueueBatch(
        {
          batchId,
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: items.map((item) => item.workItemId),
        },
        db,
      );
      expect(batch.status).toBe('queued');
      const first = await startJob(db, await claimJob(db));
      expect((await readHmsBatchView({ batchId, transportId: TRANSPORT_ID }, db))?.status).toBe('running');
      await finishJob(db, first);
      await finishJob(db, await startJob(db, await claimJob(db)));
      const remounted = await readHmsBatchView({ batchId, transportId: TRANSPORT_ID }, db);
      expect(remounted).toMatchObject({ status: 'done', items: [{ status: 'done' }, { status: 'done' }] });
      expect(remounted?.items[0]?.job?.result).toMatchObject({ outcome: 'found' });
    }));

  it('yields batch reads without attempts while a staff quote is in flight', () =>
    withSeededTestDb(async (db) => {
      const [item] = await seedBatchItems(db, 1);
      await db.insert(aiDraftGeneration).values({
        id: randomUUID(),
        transportId: TRANSPORT_ID,
        threadId: item!.threadId,
        requestedByUserId: CENTURION_USER_ID,
        model: 'staff-approved-native',
        promptVersion: 'quote-v1',
        status: 'running',
      });
      const batch = await enqueueBatch(
        { batchId: randomUUID(), transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, workItemIds: [item!.workItemId] },
        db,
      );
      const running = await startJob(db, await claimJob(db));
      expect(await (await import('../src/ai/hms-jobs.js')).executeHmsJob({
        run: running,
        fence: {
          runId: running.id,
          claimOwner: running.claimOwner!,
          claimToken: running.claimToken!,
          deadlineAt: running.deadlineAt!,
        },
        db,
      })).toBe('retry_wait');
      const [requeued] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, batch.items[0]!.runId!));
      expect(requeued).toMatchObject({ state: 'retry_wait', attempts: 0, failureClass: 'STAFF_QUOTE_ACTIVE' });
    }));

  it('writes no batch rows while HMS_JOB_QUEUE is off, and writes them once it is on', () =>
    withSeededTestDb(async (db) => {
      const [item] = await seedBatchItems(db, 1);
      const batchId = randomUUID();
      const input = { batchId, transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, workItemIds: [item!.workItemId] };
      vi.stubEnv('HMS_JOB_QUEUE', 'off');
      await expect(enqueueHmsBatch(input, db)).resolves.toBeNull();
      expect(await batchRows(db, batchId)).toHaveLength(0);
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
      await expect(enqueueHmsBatch(input, db)).resolves.toMatchObject({ batchId, status: 'queued' });
      expect(await batchRows(db, batchId)).toHaveLength(1);
    }));

  it('claims a staff lookup queued after the batch before any batch item', () =>
    withSeededTestDb(async (db) => {
      const items = await seedBatchItems(db, 2);
      const batch = await enqueueBatch(
        { batchId: randomUUID(), transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, workItemIds: items.map((item) => item.workItemId) },
        db,
      );
      const [staff] = await seedBatchItems(db, 1);
      const { run: staffRun } = await enqueueHmsJob(
        {
          transportId: TRANSPORT_ID,
          threadId: staff!.threadId,
          triggerMessageId: staff!.messageId,
          workItemId: staff!.workItemId,
          userId: CENTURION_USER_ID,
          request: { kind: 'find', confirmation: staff!.confirmation },
          priority: HMS_JOB_PRIORITY_USER,
          idempotencyKey: `hms-job:test-staff-${randomUUID()}`,
        },
        db,
      );
      expect((await claimJob(db)).id).toBe(staffRun.id);
      expect((await claimJob(db)).id).toBe(batch.items[0]!.runId);
      expect((await claimJob(db)).id).toBe(batch.items[1]!.runId);
    }));

  it('does not let two concurrent claimers take the same batch item', async () => {
    const setup = openTestDbSession();
    const left = openTestDbSession();
    const right = openTestDbSession();
    const transportId = `batch-race-${randomUUID()}`;
    const email = `${transportId}@example.test`;
    try {
      await setup.db.insert(mailboxTransport).values({ id: transportId, email, ownerHeaderValue: email });
      const items = await seedBatchItems(setup.db, 2, { transportId });
      await enqueueBatch(
        {
          batchId: randomUUID(),
          transportId,
          userId: CENTURION_USER_ID,
          workItemIds: items.map((item) => item.workItemId),
        },
        setup.db,
      );
      const claims = await Promise.all([
        claimNextAiRun({
          ownerId: 'hms-ai-worker-left',
          lane: 'hms',
          runKind: 'read_tool',
          promptVersion: HMS_JOB_PROMPT_VERSION,
          db: left.db,
        }),
        claimNextAiRun({
          ownerId: 'hms-ai-worker-right',
          lane: 'hms',
          runKind: 'read_tool',
          promptVersion: HMS_JOB_PROMPT_VERSION,
          db: right.db,
        }),
      ]);
      expect(claims.every(Boolean)).toBe(true);
      expect(new Set(claims.map((run) => run?.id)).size).toBe(2);
    } finally {
      await setup.db.delete(mailboxTransport).where(eq(mailboxTransport.id, transportId));
      await Promise.all([setup.close(), left.close(), right.close()]);
    }
  });
});
