import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setDbForTests, type DB } from '../src/db/client.js';
import * as schema from '../src/db/schema/index.js';
import { aiWorkflowRun, message } from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import { __resetInboundExtractionCapForTests, enqueueInboundExtraction } from '../src/ai/extraction/inbound-run.js';
import { claimNextAiRun } from '../src/ai/run-ledger.js';
import { storedWorkFor } from '../src/ai/work-items.js';
import { executeAiRun, storeWorkflowClassifierForInbound } from '../src/ai/worker.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import { AE1_OUTPUT, fakeModel } from './fixtures/inbound-extraction.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';

const transportId = 'transport-centurion';
const email = 'centurion@legacyhotels.co.za';
const body = 'Please quote two rooms in October 2027.';
const classification = { workflow: 'billing', confidence: 'high' } as const;

beforeEach(() => { __resetInboundExtractionCapForTests(); setS3Storage(new FakeS3Storage()); });
afterEach(() => { __setDbForTests(null); resetS3Storage(); vi.unstubAllEnvs(); });

function configureWorker(url: string) {
  for (const [name, value] of Object.entries({
    PORT: '39999', DATABASE_URL: url, BETTER_AUTH_URL: 'http://localhost:39999',
    BETTER_AUTH_SECRET: 'disposable-source-lock-test-secret', AWS_REGION: 'us-east-1',
    S3_BUCKET: 'disposable-source-lock-test', INBOUND_EXTRACTION: 'on',
    AI_ENABLED: 'false', AI_WRITE_GATE_ENABLED: 'false', AI_DRAFTS_ENABLED: 'false',
    HMS_JOB_QUEUE: 'off', HMS_AVAILABILITY_PREFETCH: 'off', HMS_QUOTE_PREPARE: 'false',
  })) vi.stubEnv(name, value);
}

async function seed(db: DB, name: string) {
  const threadId = `source-retry-${name}`, messageId = `source-retry-mail-${name}`;
  await seedInboxThread(db, { threadId, messageId, transportId, transportEmail: email,
    fromAddress: 'guest@example.invalid', subject: 'Room request', textBody: body });
  return { threadId, messageId, internetMessageId: `${threadId}@example.com` };
}

function lockMessage(otherDb: DB, messageId: string) {
  let acquired!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { acquired = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const writer = otherDb.transaction(async (tx) => {
    await tx.select({ id: message.id }).from(message).where(eq(message.id, messageId)).for('update');
    acquired();
    await hold;
  });
  return {
    ready: Promise.race([started, writer.then(() => { throw new Error('source lock ended early'); })]),
    close: async () => { release(); await writer; },
  };
}

async function queueFirstClaim(db: DB, scope: Awaited<ReturnType<typeof seed>>) {
  const queued = await enqueueInboundExtraction({ transportId, threadId: scope.threadId, messageId: scope.messageId }, db);
  // Enough time for the first failure, less than the 60-second backoff plus cleanup reserve.
  const oldDeadline = new Date(Date.now() + 45_000);
  await db.update(aiWorkflowRun).set({ state: 'claimed', claimOwner: 'test-worker', claimToken: `first-${scope.messageId}`,
    deadlineAt: oldDeadline }).where(eq(aiWorkflowRun.id, queued.id));
  return { runId: queued.id, oldDeadline };
}

async function claimRetry(db: DB, runId: string) {
  const [retry] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId));
  expect(retry).toMatchObject({ state: 'retry_wait', attempts: 1, deadlineAt: null });
  if (!retry?.nextRunAt) throw new Error('retry was not scheduled');
  // Advance only the claim clock, exercising the real due/deadline checks without waiting a minute.
  const now = new Date(retry.nextRunAt.getTime() + 1);
  const claim = await claimNextAiRun({ db, ownerId: 'test-worker', lane: 'default',
    transportId, runKind: 'inbound_extraction', now });
  expect(claim).toMatchObject({ id: runId, state: 'claimed', attempts: 1 });
  expect(claim?.deadlineAt?.getTime()).toBeGreaterThan(now.getTime());
  return claim;
}

describe('Centurion source retries in the actual worker', () => {
  it('reclaims fresh reads after capture/recheck contention or a source change, with a new bounded deadline', () =>
    withIngestionDb(async ({ db, sql, url, openConnection }) => {
      __setDbForTests({ db, conn: sql });
      configureWorker(url);
      const other = openConnection();
      const otherDb = drizzle(other, { schema });
      try {
        for (const phase of ['capture', 'recheck', 'changed'] as const) {
          const scope = await seed(db, phase);
          const { runId, oldDeadline } = await queueFirstClaim(db, scope);
          let lock: ReturnType<typeof lockMessage> | null = null;
          try {
            if (phase === 'capture') {
              lock = lockMessage(otherDb, scope.messageId);
              await lock.ready;
            }
            const model = fakeModel(async () => {
              if (phase === 'recheck') {
                lock = lockMessage(otherDb, scope.messageId);
                await lock.ready;
              }
              if (phase === 'changed') {
                await db.update(message).set({ textBody: 'Please quote different dates.' }).where(eq(message.id, scope.messageId));
              }
              return AE1_OUTPUT;
            });
            const options = { inboundExtractionAdapter: model.adapter, ingestClassify: async () => null };
            expect(await executeAiRun(runId, options), phase).toMatchObject({ state: 'retry_wait' });
            const [retry] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId));
            expect(retry?.failureClass, phase).toBe(phase === 'changed' ? 'SOURCE_CHANGED' : 'SOURCE_LOCK_BUSY');
            expect(retry?.nextRunAt?.getTime(), phase).toBeGreaterThan(oldDeadline.getTime());
            expect(model.calls, phase).toHaveLength(phase === 'capture' ? 0 : 1);
            expect(await db.select().from(mailExtraction).where(eq(mailExtraction.messageId, scope.messageId)), phase).toHaveLength(0);
            expect(await db.select().from(workItem).where(eq(workItem.sourceMessageId, scope.messageId)), phase).toHaveLength(0);
            if (lock) { await lock.close(); lock = null; }
            await claimRetry(db, runId);
            expect(await executeAiRun(runId, { inboundExtractionAdapter: fakeModel(() => AE1_OUTPUT).adapter,
              ingestClassify: async () => null }), phase).toMatchObject({ state: 'succeeded' });
            const [read] = await db.select().from(mailExtraction).where(eq(mailExtraction.messageId, scope.messageId));
            expect(read?.usage?.sourceWitness, phase).toMatchObject({ status: 'captured' });
            expect(await db.select().from(workItem).where(eq(workItem.sourceMessageId, scope.messageId)), phase).toHaveLength(1);
          } finally {
            if (lock) await lock.close();
          }
        }
      } finally {
        await other.end();
      }
    }));

  it('keeps one retry maximum and does not reset the deadline of another job kind', () =>
    withIngestionDb(async ({ db, sql, url, openConnection }) => {
      __setDbForTests({ db, conn: sql });
      configureWorker(url);
      const scope = await seed(db, 'cap');
      const { runId } = await queueFirstClaim(db, scope);
      const other = openConnection();
      const otherDb = drizzle(other, { schema });
      let lock = lockMessage(otherDb, scope.messageId);
      try {
        await lock.ready;
        const options = { inboundExtractionAdapter: fakeModel(() => AE1_OUTPUT).adapter, ingestClassify: async () => null };
        expect(await executeAiRun(runId, options)).toMatchObject({ state: 'retry_wait' });
        await lock.close();
        await claimRetry(db, runId);
        lock = lockMessage(otherDb, scope.messageId);
        await lock.ready;
        expect(await executeAiRun(runId, options)).toMatchObject({ state: 'dead_letter' });
        const [run] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId));
        expect(run).toMatchObject({ state: 'dead_letter', attempts: 1, failureClass: 'SOURCE_LOCK_BUSY' });
      } finally {
        await lock.close();
        await other.end();
      }

      // Inject a failing read executor; this does not invoke HMS and proves other job kinds retain their deadline.
      vi.stubEnv('HMS_READ_SERVICE_ENABLED', 'true');
      const deadline = new Date(Date.now() + 45_000);
      await db.insert(aiWorkflowRun).values({ id: 'other-job', transportId, threadId: scope.threadId,
        triggerMessageId: scope.messageId, runKind: 'read_tool', executorLane: 'hms', idempotencyKey: 'other-job',
        modelId: 'not_applicable', promptVersion: 'synthetic-read', readRequest: {}, state: 'claimed',
        claimOwner: 'test-worker', claimToken: 'other-token', deadlineAt: deadline });
      expect(await executeAiRun('other-job', { readToolExecutor: async () => {
        throw Object.assign(new Error('synthetic contention'), { failureClass: 'SOURCE_LOCK_BUSY' });
      } })).toMatchObject({ state: 'retry_wait' });
      const [otherRun] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, 'other-job'));
      expect(otherRun?.deadlineAt?.getTime()).toBe(deadline.getTime());
    }));

  it('does not classify or expose a captured classifier while its source lock is busy', () =>
    withIngestionDb(async ({ db, sql, url, openConnection }) => {
      __setDbForTests({ db, conn: sql });
      configureWorker(url);
      const scope = await seed(db, 'classifier');
      const { runId } = await queueFirstClaim(db, scope);
      expect(await executeAiRun(runId, { inboundExtractionAdapter: fakeModel(() => AE1_OUTPUT).adapter,
        ingestClassify: async () => null })).toMatchObject({ state: 'succeeded' });
      const other = openConnection();
      const otherDb = drizzle(other, { schema });
      let lock = lockMessage(otherDb, scope.messageId);
      try {
        await lock.ready;
        const classify = vi.fn(async () => classification);
        await storeWorkflowClassifierForInbound(db, scope.messageId, classify);
        expect(classify).not.toHaveBeenCalled();
        const [held] = await db.select().from(mailExtraction).where(eq(mailExtraction.messageId, scope.messageId));
        expect(held?.usage?.classifier).toBeUndefined();
        expect(held?.usage?.classifierSourceProof).toBeUndefined();
        await lock.close();
        await storeWorkflowClassifierForInbound(db, scope.messageId, classify);
        expect(classify).toHaveBeenCalledOnce();

        const lookup = { transportId, internetMessageId: scope.internetMessageId };
        expect(await storedWorkFor(db, lookup)).toMatchObject({ status: 'ready', analysis: { luna: { workflow: 'send_document' } } });
        lock = lockMessage(otherDb, scope.messageId);
        await lock.ready;
        expect(await storedWorkFor(db, lookup)).toMatchObject({ status: 'ready', analysis: { luna: { workflow: 'quote' } } });
        await lock.close();
        expect(await storedWorkFor(db, lookup)).toMatchObject({ status: 'ready', analysis: { luna: { workflow: 'send_document' } } });
      } finally {
        await lock.close();
        await other.end();
      }
    }));
});
