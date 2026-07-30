import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db/client.js';
import {
  aiWorkflowRun,
  aiDraftGeneration,
  mailThread,
  mailboxTransport,
  message,
} from '../src/db/schema/mail.js';
import { user as userAuthTable } from '../src/db/schema/auth.js';
import {
  claimNextAiRun,
  enqueueAiRun,
  markAiRunDeadLetter,
  markAiRunRetry,
  markAiRunSucceeded,
} from '../src/ai/run-ledger.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';

const reachable = await probeTestDb();

async function seedMailContext() {
  const db = getDb();
  const transportId = randomUUID();
  const threadId = randomUUID();
  const messageId = randomUUID();

  await db.insert(mailboxTransport).values({
    id: transportId,
    email: `nava-${transportId.slice(0, 8)}@example.com`,
    ownerHeaderValue: `nava-${transportId.slice(0, 8)}@example.com`,
  });
  await db
    .insert(userAuthTable)
    .values({
      id: 'user-1',
      name: 'User',
      email: 'user@example.com',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await db.insert(mailThread).values({
    id: threadId,
    transportId,
    threadRootId: `<root-${threadId}@example.com>`,
    subject: 'Booking',
    snippet: 'Need help',
    latestMessageAt: new Date('2026-07-06T10:00:00Z'),
  });
  await db.insert(message).values({
    id: messageId,
    transportId,
    threadId,
    direction: 'inbound',
    fromAddress: 'guest@example.com',
    toAddresses: ['nava@example.com'],
    subject: 'Booking',
    textBody: 'Need help',
    receivedAt: new Date('2026-07-06T10:00:00Z'),
  });

  return { transportId, threadId, messageId };
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('ai workflow run contract', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(aiWorkflowRun);
    await db.delete(message);
    await db.delete(mailThread);
    await db.delete(mailboxTransport);
  });

  it('returns existing run on duplicate idempotency key', async () => {
    const { transportId, threadId, messageId } = await seedMailContext();
    const idempotencyKey = `inbound-triage:${messageId}`;

    const first = await enqueueAiRun({
      transportId,
      threadId,
      triggerMessageId: messageId,
      runKind: 'inbound_triage',
      idempotencyKey,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v4',
    });
    const second = await enqueueAiRun({
      transportId,
      threadId,
      triggerMessageId: messageId,
      runKind: 'inbound_triage',
      idempotencyKey,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v4',
    });

    expect(second.id).toBe(first.id);
    const db = getDb();
    const rows = await db
      .select()
      .from(aiWorkflowRun)
      .where(eq(aiWorkflowRun.idempotencyKey, idempotencyKey));
    expect(rows).toHaveLength(1);
  });

  it('claims exactly one queued run under concurrent claim attempts', async () => {
    const { transportId, threadId, messageId } = await seedMailContext();
    await enqueueAiRun({
      transportId,
      threadId,
      triggerMessageId: messageId,
      runKind: 'inbound_triage',
      idempotencyKey: `inbound-triage:${messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v4',
    });

    const [first, second] = await Promise.all([
      claimNextAiRun({ ownerId: 'worker-a' }),
      claimNextAiRun({ ownerId: 'worker-b' }),
    ]);

    const claimed = [first, second].filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.claimOwner).toBeTruthy();
    expect(claimed[0]?.state).toBe('claimed');
  });

  it('stores retry attempts, next run time, and last error', async () => {
    const { transportId, threadId, messageId } = await seedMailContext();
    const run = await enqueueAiRun({
      transportId,
      threadId,
      triggerMessageId: messageId,
      runKind: 'inbound_triage',
      idempotencyKey: `inbound-triage:${messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v4',
    });
    const claimed = await claimNextAiRun({ ownerId: 'worker-a' });
    expect(claimed?.id).toBe(run.id);

    const nextRunAt = new Date('2026-07-07T12:00:00Z');
    await markAiRunRetry({
      runId: run.id,
      claimOwner: claimed!.claimOwner!,
      expectedStates: ['claimed'],
      attempts: 1,
      nextRunAt,
      lastError: 'bedrock timeout',
    });

    const db = getDb();
    const [row] = await db
      .select()
      .from(aiWorkflowRun)
      .where(eq(aiWorkflowRun.id, run.id));
    expect(row?.state).toBe('retry_wait');
    expect(row?.attempts).toBe(1);
    expect(row?.nextRunAt?.toISOString()).toBe(nextRunAt.toISOString());
    expect(row?.lastError).toBe('bedrock timeout');
  });

  it('requires transport, thread, and trigger message ids for mail-triggered runs', async () => {
    await expect(
      enqueueAiRun({
        transportId: '',
        threadId: randomUUID(),
        triggerMessageId: randomUUID(),
        runKind: 'inbound_triage',
        idempotencyKey: 'missing-transport',
        modelId: 'amazon.nova-lite-v1:0',
        promptVersion: 'triage-v4',
      }),
    ).rejects.toThrow(/transport/i);

    await expect(
      enqueueAiRun({
        transportId: randomUUID(),
        threadId: '',
        triggerMessageId: randomUUID(),
        runKind: 'inbound_triage',
        idempotencyKey: 'missing-thread',
        modelId: 'amazon.nova-lite-v1:0',
        promptVersion: 'triage-v4',
      }),
    ).rejects.toThrow(/thread/i);

    await expect(
      enqueueAiRun({
        transportId: randomUUID(),
        threadId: randomUUID(),
        triggerMessageId: '',
        runKind: 'inbound_triage',
        idempotencyKey: 'missing-message',
        modelId: 'amazon.nova-lite-v1:0',
        promptVersion: 'triage-v4',
      }),
    ).rejects.toThrow(/message/i);
  });

  it('marks dead letter and stops future claims', async () => {
    const { transportId, threadId, messageId } = await seedMailContext();
    const run = await enqueueAiRun({
      transportId,
      threadId,
      triggerMessageId: messageId,
      runKind: 'feedback_extraction',
      idempotencyKey: `feedback:${messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'feedback-v1',
    });
    await claimNextAiRun({ ownerId: 'worker-a' });
    await markAiRunDeadLetter({
      runId: run.id,
      claimOwner: 'worker-a',
      expectedStates: ['claimed'],
      lastError: 'policy violation',
    });

    const claimed = await claimNextAiRun({ ownerId: 'worker-b' });
    expect(claimed).toBeNull();

    const db = getDb();
    const [row] = await db
      .select()
      .from(aiWorkflowRun)
      .where(eq(aiWorkflowRun.id, run.id));
    expect(row?.state).toBe('dead_letter');
    expect(row?.lastError).toBe('policy violation');
  });

  it('marks succeeded with trace and metrics metadata', async () => {
    const { transportId, threadId, messageId } = await seedMailContext();
    const run = await enqueueAiRun({
      transportId,
      threadId,
      triggerMessageId: messageId,
      runKind: 'candidate_draft',
      idempotencyKey: `candidate-draft:${messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'draft-v1',
    });
    const claimed = await claimNextAiRun({ ownerId: 'worker-a' });

    const generationId = randomUUID();
    const db = getDb();
    await db.insert(aiDraftGeneration).values({
      id: generationId,
      transportId,
      threadId,
      requestedByUserId: 'user-1',
      contextMessageIds: [messageId],
      model: 'amazon.nova-lite-v1:0',
      promptVersion: 'draft-v1',
    });
    await markAiRunSucceeded({
      runId: run.id,
      claimOwner: claimed!.claimOwner!,
      expectedStates: ['claimed'],
      mastraTraceId: 'trace-123',
      mastraScorerId: 'scorer-456',
      generationId,
      metrics: { latencyMs: 1200, inputTokens: 400, outputTokens: 120 },
    });

    const [row] = await db
      .select()
      .from(aiWorkflowRun)
      .where(eq(aiWorkflowRun.id, run.id));
    expect(row?.state).toBe('succeeded');
    expect(row?.mastraTraceId).toBe('trace-123');
    expect(row?.mastraScorerId).toBe('scorer-456');
    expect(row?.generationId).toBe(generationId);
    expect(row?.metrics).toMatchObject({ latencyMs: 1200 });
  });

  it('prevents original owner from marking success after stale reclaim', async () => {
    await withSeededTestDb(async (db) => {
      const transportId = randomUUID();
      const threadId = randomUUID();
      const messageId = randomUUID();
      await db.insert(mailboxTransport).values({
        id: transportId,
        email: `nava-${transportId.slice(0, 8)}@example.com`,
        ownerHeaderValue: `nava-${transportId.slice(0, 8)}@example.com`,
      });
      await db.insert(mailThread).values({
        id: threadId,
        transportId,
        threadRootId: `<root-${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date(),
      });
      await db.insert(message).values({
        id: messageId,
        transportId,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Booking',
        textBody: 'Need help',
        receivedAt: new Date(),
      });

      const run = await enqueueAiRun(
        {
          transportId,
          threadId,
          triggerMessageId: messageId,
          runKind: 'inbound_triage',
          idempotencyKey: `inbound-triage:${messageId}`,
          modelId: 'amazon.nova-lite-v1:0',
          promptVersion: 'triage-v4',
        },
        db,
      );

      await db
        .update(aiWorkflowRun)
        .set({
          state: 'running',
          claimOwner: 'owner-a',
          updatedAt: new Date(Date.now() - 60 * 60_000),
        })
        .where(eq(aiWorkflowRun.id, run.id));

      const reclaimed = await claimNextAiRun({
        ownerId: 'owner-b',
        staleRunTimeoutMs: 15 * 60_000,
        db,
      });
      expect(reclaimed?.id).toBe(run.id);
      expect(reclaimed?.claimOwner).toBe('owner-b');

      const staleWrite = await markAiRunSucceeded(
        {
          runId: run.id,
          claimOwner: 'owner-a',
          expectedStates: ['running'],
          metrics: { stale: true },
        },
        db,
      );
      expect(staleWrite).toBeNull();

      const [row] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
      expect(row?.claimOwner).toBe('owner-b');
      expect(row?.state).toBe('claimed');
    });
  });

  it('scoped claim cannot take another transport/kind/prefix/version', async () => {
    const a = await seedMailContext();
    const b = await seedMailContext();

    const match = await enqueueAiRun({
      transportId: a.transportId,
      threadId: a.threadId,
      triggerMessageId: a.messageId,
      runKind: 'inbound_triage',
      idempotencyKey: `inbound-triage-retag-v5:${a.messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v5',
    });
    await enqueueAiRun({
      transportId: b.transportId,
      threadId: b.threadId,
      triggerMessageId: b.messageId,
      runKind: 'inbound_triage',
      idempotencyKey: `inbound-triage:${b.messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v4',
    });
    await enqueueAiRun({
      transportId: a.transportId,
      threadId: a.threadId,
      triggerMessageId: a.messageId,
      runKind: 'candidate_draft',
      idempotencyKey: `candidate-draft:${a.messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'draft-v1',
    });

    const wrongTransport = await claimNextAiRun({
      ownerId: 'scoped-worker',
      transportId: b.transportId,
      runKind: 'inbound_triage',
      promptVersion: 'triage-v5',
      idempotencyPrefix: 'inbound-triage-retag-v5',
    });
    expect(wrongTransport).toBeNull();

    const wrongKind = await claimNextAiRun({
      ownerId: 'scoped-worker',
      transportId: a.transportId,
      runKind: 'candidate_draft',
      promptVersion: 'triage-v5',
      idempotencyPrefix: 'inbound-triage-retag-v5',
    });
    expect(wrongKind).toBeNull();

    const wrongVersion = await claimNextAiRun({
      ownerId: 'scoped-worker',
      transportId: a.transportId,
      runKind: 'inbound_triage',
      promptVersion: 'triage-v4',
      idempotencyPrefix: 'inbound-triage-retag-v5',
    });
    expect(wrongVersion).toBeNull();

    const wrongPrefix = await claimNextAiRun({
      ownerId: 'scoped-worker',
      transportId: a.transportId,
      runKind: 'inbound_triage',
      promptVersion: 'triage-v5',
      idempotencyPrefix: 'inbound-triage:',
    });
    expect(wrongPrefix).toBeNull();

    const claimed = await claimNextAiRun({
      ownerId: 'scoped-worker',
      transportId: a.transportId,
      runKind: 'inbound_triage',
      promptVersion: 'triage-v5',
      idempotencyPrefix: 'inbound-triage-retag-v5',
    });
    expect(claimed?.id).toBe(match.id);

    const db = getDb();
    const [untouched] = await db
      .select()
      .from(aiWorkflowRun)
      .where(eq(aiWorkflowRun.idempotencyKey, `inbound-triage:${b.messageId}`));
    expect(untouched?.state).toBe('queued');
    expect(untouched?.claimOwner).toBeNull();
  });

  it('markAiRunRunning returns null when fence loses', async () => {
    const { markAiRunRunning } = await import('../src/ai/run-ledger.js');
    const { transportId, threadId, messageId } = await seedMailContext();
    const run = await enqueueAiRun({
      transportId,
      threadId,
      triggerMessageId: messageId,
      runKind: 'inbound_triage',
      idempotencyKey: `inbound-triage-fence:${messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v4',
    });
    const claimed = await claimNextAiRun({ ownerId: 'owner-a' });
    expect(claimed?.id).toBe(run.id);

    const db = getDb();
    await db
      .update(aiWorkflowRun)
      .set({ state: 'succeeded', claimOwner: null, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(aiWorkflowRun.id, run.id));

    const fenced = await markAiRunRunning({
      runId: run.id,
      claimOwner: 'owner-a',
    });
    expect(fenced).toBeNull();
  });
});
