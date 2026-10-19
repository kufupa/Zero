import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { appRouter } from '../src/trpc/router.js';
import {
  cancelHmsBatch,
  createHmsRecoveryGate,
  enqueueHmsBatch,
  enqueueHmsJob,
  HMS_JOB_PRIORITY_PREFETCH,
  HMS_JOB_PRIORITY_USER,
  prefetchHmsConfirmations,
  readHmsBatchView,
  requeueHmsReadsAfterRestart,
  selectHmsBatchRequest,
  type HmsBatchView,
  type HmsJobRequest,
} from '../src/ai/hms-jobs.js';
import { runHmsJobOnce } from '../src/ai/worker.js';
import { paneStayLookupLoaders } from '../src/ai/pane-stay-lookup.js';
import type { PaneStayLock } from '../src/ai/pane-stay-save.js';
import { parseEnv } from '../src/env.js';
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

/**
 * One batch run held by a worker whose heartbeat went stale long ago, with its deadline already elapsed: what the
 * restart sweep must requeue, and what a claim without recovery would dead-letter as RUN_DEADLINE.
 */
async function seedDeadClaim(db: DB): Promise<string> {
  const [item] = await seedBatchItems(db, 1);
  const batch = await enqueueBatch(
    { batchId: randomUUID(), transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, workItemIds: [item!.workItemId] },
    db,
  );
  const runId = batch.items[0]!.runId!;
  await db
    .update(aiWorkflowRun)
    .set({
      state: 'running',
      claimOwner: 'hms-ai-worker-dead-1',
      claimToken: randomUUID(),
      heartbeatAt: new Date(Date.now() - 2 * 60 * 60_000),
      deadlineAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 2 * 60 * 60_000),
    })
    .where(eq(aiWorkflowRun.id, runId));
  return runId;
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

  it('queues search_guest from an endClient person name and booked arrival', () => {
    expect(
      selectHmsBatchRequest({
        kind: 'amendment',
        payload: {
          confirmationNumbers: [],
          endClient: 'Jordan Hale',
          agency: 'Northwind Travel',
          contact: { name: 'Riley Quinn' },
          stays: [{ booked: { arrival: ARRIVAL }, requested: { arrival: '2026-12-01' } }],
        },
        subject: 'Please amend the stay',
        textBody: 'Please change the dates.',
      }),
    ).toEqual({ request: { kind: 'search_guest', lastName: 'Hale', arrival: ARRIVAL } });
  });

  it('does not take a surname from a company endClient', () => {
    expect(
      selectHmsBatchRequest({
        kind: 'cancellation',
        payload: {
          confirmationNumbers: [],
          endClient: 'Acme Holdings Pty Ltd',
          agency: null,
          contact: { name: null },
          stays: [{ booked: { arrival: ARRIVAL } }],
        },
        subject: 'Please cancel',
        textBody: 'Please cancel this booking.',
      }),
    ).toEqual({ skipped: 'insufficient_data' });
  });

  it('does not use the booker contact when an agency is set', () => {
    expect(
      selectHmsBatchRequest({
        kind: 'amendment',
        payload: {
          confirmationNumbers: [],
          endClient: null,
          agency: 'Northwind Travel',
          contact: { name: 'Riley Quinn' },
          stays: [{ booked: { arrival: ARRIVAL } }],
        },
        subject: 'Please amend the stay',
        textBody: 'Please change the dates.',
      }),
    ).toEqual({ skipped: 'insufficient_data' });
  });

  it('uses the contact surname for a private sender with no guest label', () => {
    expect(
      selectHmsBatchRequest({
        kind: 'amendment',
        payload: {
          confirmationNumbers: [],
          endClient: null,
          agency: null,
          contact: { name: 'Riley Quinn' },
          stays: [{ booked: { arrival: ARRIVAL } }],
        },
        subject: 'Please amend my stay',
        textBody: 'Please change the dates.',
      }),
    ).toEqual({ request: { kind: 'search_guest', lastName: 'Quinn', arrival: ARRIVAL } });
  });

  it('keeps an explicit guest label ahead of endClient and contact', () => {
    expect(
      selectHmsBatchRequest({
        kind: 'amendment',
        payload: {
          confirmationNumbers: [],
          endClient: 'Jordan Hale',
          agency: null,
          contact: { name: 'Riley Quinn' },
          stays: [{ booked: { arrival: ARRIVAL } }],
        },
        subject: 'Please amend the stay',
        textBody: 'Guest: Alex Morgan\nPlease change the dates.',
      }),
    ).toEqual({ request: { kind: 'search_guest', lastName: 'Morgan', arrival: ARRIVAL } });
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

  it('skips a spam item without a lookup and queues the rest', () =>
    withSeededTestDb(async (db) => {
      const items = await seedBatchItems(db, 2);
      await db.update(mailThread).set({ spamAt: new Date() }).where(eq(mailThread.id, items[0]!.threadId));
      const batch = await enqueueBatch(
        {
          batchId: randomUUID(),
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: items.map((item) => item.workItemId),
        },
        db,
      );
      expect(batch.items.map((item) => item.status)).toEqual(['skipped', 'queued']);
      expect(batch.items[0]).toMatchObject({ reason: 'spam', runId: null });
    }));

  it('queues an item whose extraction label says spam when staff cleared the thread spam', () =>
    withSeededTestDb(async (db) => {
      const [item] = await seedBatchItems(db, 1);
      // spamAt is the gate. The extraction label alone is not spam, and staff can clear spam on this thread.
      await db.update(mailExtraction).set({ kind: 'spam' }).where(eq(mailExtraction.id, item!.extractionId));
      const batch = await enqueueBatch(
        {
          batchId: randomUUID(),
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: [item!.workItemId],
        },
        db,
      );
      expect(batch.items[0]).toMatchObject({ status: 'queued', reason: null });
    }));

  it('queues on the message text when the only extraction failed', () =>
    withSeededTestDb(async (db) => {
      const [item] = await seedBatchItems(db, 1, {
        item: () => ({ textBody: `Please look at booking ${confirmationFor(0)} for the guest.` }),
      });
      await db.update(mailExtraction).set({ status: 'failed', payload: null }).where(eq(mailExtraction.id, item!.extractionId));
      const batch = await enqueueBatch(
        {
          batchId: randomUUID(),
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: [item!.workItemId],
        },
        db,
      );
      expect(batch.items[0]).toMatchObject({ status: 'queued', reason: null });
      expect(batch.items[0]!.request).toMatchObject({ kind: 'find', confirmation: confirmationFor(0) });
    }));

  it('a newer failed extraction does not hide the older succeeded one', () =>
    withSeededTestDb(async (db) => {
      const [item] = await seedBatchItems(db, 1);
      await db.insert(mailExtraction).values({
        messageId: item!.messageId,
        extractorVersion: `batch-test-failed-${randomUUID()}`,
        status: 'failed',
        kind: null,
        payload: null,
        createdAt: new Date(Date.now() + 60_000),
      });
      const batch = await enqueueBatch(
        {
          batchId: randomUUID(),
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: [item!.workItemId],
        },
        db,
      );
      // The confirmation exists only in the older succeeded payload, so the lookup must come from it.
      expect(batch.items[0]).toMatchObject({ status: 'queued', reason: null });
      expect(batch.items[0]!.request).toMatchObject({ kind: 'find', confirmation: confirmationFor(0) });
    }));

  it('batch enqueue and cancel never take the property lock', () =>
    withSeededTestDb(async (db) => {
      const [item] = await seedBatchItems(db, 1);
      const takeLock = vi.fn(async () => {
        throw new Error('batch path must not take the property lock');
      });
      paneStayLookupLoaders.lock = { withLock: takeLock } as unknown as PaneStayLock;
      try {
        const batchId = randomUUID();
        await enqueueBatch({ batchId, transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, workItemIds: [item!.workItemId] }, db);
        await expect(cancelHmsBatch({ batchId, transportId: TRANSPORT_ID }, db)).resolves.toMatchObject({ batchId });
        expect(takeLock).not.toHaveBeenCalled();
      } finally {
        paneStayLookupLoaders.lock = null;
      }
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

  it('a staff batch does not spend the automatic guest prefetch cap', () =>
    withSeededTestDb(async (db) => {
      const [staffItem, inboundItem] = await seedBatchItems(db, 2, {
        item: (index) =>
          index === 0
            ? {
                kind: 'amendment',
                payload: { confirmationNumbers: [], stays: [{ booked: { arrival: ARRIVAL } }] },
                textBody: 'Guest: John Smith arriving 12 October.',
              }
            : {
                kind: 'booking',
                payload: { confirmationNumbers: [], stays: [{ requested: { arrival: ARRIVAL } }] },
                textBody: 'Guest: Jane Doe arriving 12 October.',
              },
      });
      // One staff search uses the whole HMS_GUEST_PREFETCH_PER_HOUR=1 budget if batch rows were counted.
      await enqueueBatch(
        { batchId: randomUUID(), transportId: TRANSPORT_ID, userId: CENTURION_USER_ID, workItemIds: [staffItem!.workItemId] },
        db,
      );
      const [inbound] = await db
        .insert(aiWorkflowRun)
        .values({
          id: randomUUID(),
          transportId: TRANSPORT_ID,
          threadId: inboundItem!.threadId,
          triggerMessageId: inboundItem!.messageId,
          runKind: 'inbound_extraction',
          idempotencyKey: `inbound-extraction:${inboundItem!.messageId}`,
          modelId: 'amazon.nova-lite-v1:0',
          promptVersion: 'triage-v6',
          admissionSnapshotId: `snapshot-${randomUUID()}`,
          state: 'succeeded',
          executorLane: 'default',
          priority: 0,
        })
        .returning();
      const env = {
        ...parseEnv(process.env as Record<string, string | undefined>),
        HMS_PREFETCH_ENABLED: true,
        HMS_GUEST_PREFETCH_PER_HOUR: 1,
      };
      expect(await prefetchHmsConfirmations(inbound!, db, env)).toBe(1);
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
      const batch = await enqueueBatch(
        {
          batchId: randomUUID(),
          transportId,
          userId: CENTURION_USER_ID,
          workItemIds: items.map((item) => item.workItemId),
        },
        setup.db,
      );
      // Both claimers are scoped to this transport, so only this batch's runs are candidates.
      const claims = await Promise.all([
        claimNextAiRun({
          ownerId: 'hms-ai-worker-left',
          lane: 'hms',
          runKind: 'read_tool',
          promptVersion: HMS_JOB_PROMPT_VERSION,
          transportId,
          db: left.db,
        }),
        claimNextAiRun({
          ownerId: 'hms-ai-worker-right',
          lane: 'hms',
          runKind: 'read_tool',
          promptVersion: HMS_JOB_PROMPT_VERSION,
          transportId,
          db: right.db,
        }),
      ]);
      expect(claims.every(Boolean)).toBe(true);
      // Together the two claims cover both batch runs exactly once.
      expect(claims.map((run) => run!.id).sort()).toEqual(batch.items.map((item) => item.runId!).sort());
    } finally {
      await setup.db.delete(mailboxTransport).where(eq(mailboxTransport.id, transportId));
      await Promise.all([setup.close(), left.close(), right.close()]);
    }
  });

  it('overlapping batches on one transport share one lookup for the same work item', async () => {
    const setup = openTestDbSession();
    const left = openTestDbSession();
    const right = openTestDbSession();
    const transportId = `batch-overlap-${randomUUID()}`;
    const email = `${transportId}@example.test`;
    try {
      await setup.db.insert(mailboxTransport).values({ id: transportId, email, ownerHeaderValue: email });
      const [item] = await seedBatchItems(setup.db, 1, { transportId });
      // Different batchIds, so a per-batch lock would not serialize these; the transport lock does.
      const [first, second] = await Promise.all([
        enqueueBatch(
          { batchId: randomUUID(), transportId, userId: CENTURION_USER_ID, workItemIds: [item!.workItemId] },
          left.db,
        ),
        enqueueBatch(
          { batchId: randomUUID(), transportId, userId: CENTURION_USER_ID, workItemIds: [item!.workItemId] },
          right.db,
        ),
      ]);
      expect(second.items[0]!.runId).toBe(first.items[0]!.runId);
      const runs = await setup.db
        .select({ id: aiWorkflowRun.id })
        .from(aiWorkflowRun)
        .where(and(eq(aiWorkflowRun.transportId, transportId), eq(aiWorkflowRun.workItemId, item!.workItemId)));
      expect(runs).toHaveLength(1);
    } finally {
      await setup.db.delete(mailboxTransport).where(eq(mailboxTransport.id, transportId));
      await Promise.all([setup.close(), left.close(), right.close()]);
    }
  });

  it('restart sweep waits for a row a batch transaction holds instead of skipping it', async () => {
    const setup = openTestDbSession();
    const holder = openTestDbSession();
    const transportId = `batch-sweep-${randomUUID()}`;
    const email = `${transportId}@example.test`;
    try {
      await setup.db.insert(mailboxTransport).values({ id: transportId, email, ownerHeaderValue: email });
      const [item] = await seedBatchItems(setup.db, 1, { transportId });
      const batch = await enqueueBatch(
        { batchId: randomUUID(), transportId, userId: CENTURION_USER_ID, workItemIds: [item!.workItemId] },
        setup.db,
      );
      const runId = batch.items[0]!.runId!;
      // A dead worker's claim: stale heartbeat and an already-elapsed deadline.
      await setup.db
        .update(aiWorkflowRun)
        .set({
          state: 'running',
          claimOwner: 'hms-ai-worker-dead-1',
          claimToken: randomUUID(),
          heartbeatAt: new Date(Date.now() - 2 * 60 * 60_000),
          deadlineAt: new Date(Date.now() - 60_000),
          updatedAt: new Date(Date.now() - 2 * 60 * 60_000),
        })
        .where(eq(aiWorkflowRun.id, runId));

      // A batch transaction holds the dead run's row while the sweep starts. The sweep must wait, not skip it.
      let sweep: Promise<number> | undefined;
      const sweptBeforeRelease = await holder.db.transaction(async (tx) => {
        await tx.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId)).for('update');
        sweep = requeueHmsReadsAfterRestart({ ownerId: 'hms-ai-worker-new-1' }, setup.db);
        return Promise.race([
          sweep.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
        ]);
      });
      expect(sweptBeforeRelease).toBe(false);
      await expect(sweep).resolves.toBe(1);

      const [row] = await setup.db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId));
      expect(row).toMatchObject({ state: 'retry_wait', claimOwner: null, deadlineAt: null, metrics: { crashCount: 1 } });
      // The requeued run is claimable again with a fresh deadline, not failed as expired.
      const reclaimed = await claimNextAiRun({
        ownerId: 'hms-ai-worker-new-1',
        lane: 'hms',
        runKind: 'read_tool',
        promptVersion: HMS_JOB_PROMPT_VERSION,
        transportId,
        db: setup.db,
      });
      expect(reclaimed?.id).toBe(runId);
      expect(reclaimed?.deadlineAt?.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await setup.db.delete(mailboxTransport).where(eq(mailboxTransport.id, transportId));
      await Promise.all([setup.close(), holder.close()]);
    }
  });

  it('reuses a lookup through a batchLinks entry, not only the run primary workItemId', () =>
    withSeededTestDb(async (db) => {
      const confirmation = confirmationFor(0);
      const items = await seedBatchItems(db, 2, {
        item: () => ({ payload: { confirmationNumbers: [confirmation], stays: [{ requested: { arrival: ARRIVAL } }] } }),
      });
      const first = await enqueueBatch(
        {
          batchId: randomUUID(),
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: items.map((item) => item.workItemId),
        },
        db,
      );
      // Both items share the first lookup: the second is a batchLinks entry on the primary run.
      expect(first.items[1]!.runId).toBe(first.items[0]!.runId);

      const later = await enqueueBatch(
        {
          batchId: randomUUID(),
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: [items[1]!.workItemId],
        },
        db,
      );
      expect(later.items[0]).toMatchObject({
        status: 'reused',
        runId: first.items[0]!.runId,
        job: { status: 'queued' },
      });
    }));

  it('retries the restart sweep after one deadlock and still requeues the dead run', () =>
    withSeededTestDb(async (db) => {
      const runId = await seedDeadClaim(db);
      let attempts = 0;
      // The first transaction fails with a deadlock; the retry runs the real sweep.
      const deadlockOnce = {
        transaction: (run: (tx: DB) => Promise<unknown>) =>
          db.transaction((tx) => {
            attempts += 1;
            if (attempts === 1) return Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
            return run(tx as DB);
          }),
      } as unknown as DB;
      await expect(requeueHmsReadsAfterRestart({ ownerId: 'hms-ai-worker-new-1' }, deadlockOnce)).resolves.toBe(1);
      expect(attempts).toBe(2);
      const [run] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId));
      expect(run).toMatchObject({ state: 'retry_wait', metrics: { crashCount: 1 } });
    }));

  it('rethrows the lock conflict once every restart sweep attempt deadlocks, leaving the run untouched', () =>
    withSeededTestDb(async (db) => {
      const runId = await seedDeadClaim(db);
      const alwaysDeadlocked = {
        transaction: () => Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' })),
      } as unknown as DB;
      await expect(requeueHmsReadsAfterRestart({ ownerId: 'hms-ai-worker-new-1' }, alwaysDeadlocked)).rejects.toMatchObject({
        code: '40P01',
      });
      const [run] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId));
      expect(run?.state).toBe('running');
    }));

  it('reuses lookups across more than one 500-item chunk in a single candidate lock pass', () =>
    withSeededTestDb(async (db) => {
      const items = await seedBatchItems(db, 600);
      const first = await enqueueBatch(
        {
          batchId: randomUUID(),
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: items.map((item) => item.workItemId),
        },
        db,
      );
      expect(first.items.every((item) => item.status === 'queued')).toBe(true);
      const later = await enqueueBatch(
        {
          batchId: randomUUID(),
          transportId: TRANSPORT_ID,
          userId: CENTURION_USER_ID,
          workItemIds: items.map((item) => item.workItemId),
        },
        db,
      );
      expect(later.items.every((item) => item.status === 'reused')).toBe(true);
      expect(later.items.map((item) => item.runId)).toEqual(first.items.map((item) => item.runId));
    }));

  it('claims no HMS read until a restart sweep succeeds, then requeues the stale job with a fresh deadline', () =>
    withSeededTestDb(async (db) => {
      const runId = await seedDeadClaim(db);
      let sweepsFailing = true;
      let sweepCalls = 0;
      // While sweepsFailing, every transaction hits a deadlock, so each sweep call exhausts its retries and throws.
      const contended = {
        transaction: (run: (tx: DB) => Promise<unknown>) =>
          sweepsFailing
            ? Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' }))
            : db.transaction((tx) => run(tx as DB)),
      } as unknown as DB;
      let clock = Date.now();
      const recovery = createHmsRecoveryGate(
        { ownerId: 'hms-ai-worker-new-1' },
        {
          sweep: (input) => {
            sweepCalls += 1;
            return requeueHmsReadsAfterRestart(input, contended);
          },
          now: () => clock,
        },
      );
      const execute = vi.fn(async () => undefined);
      const tick = () => runHmsJobOnce({ db, execute, recovery });

      // Each failing tick retries the sweep once its backoff has passed. A tick inside the backoff does not.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await tick()).toBe(false);
        expect(await tick()).toBe(false);
        clock += 60_000;
      }
      expect(sweepCalls).toBe(3);
      expect(execute).not.toHaveBeenCalled();
      // The stale claim is still held by the dead worker, not dead-lettered as RUN_DEADLINE.
      const [stale] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId));
      expect(stale).toMatchObject({ state: 'running', claimOwner: 'hms-ai-worker-dead-1' });

      sweepsFailing = false;
      expect(await tick()).toBe(true);
      expect(sweepCalls).toBe(4);
      expect(execute).toHaveBeenCalledWith(runId);
      const [recovered] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId));
      expect(recovered?.metrics).toMatchObject({ crashCount: 1 });
      expect(recovered?.deadlineAt?.getTime()).toBeGreaterThan(Date.now());
    }));
});
