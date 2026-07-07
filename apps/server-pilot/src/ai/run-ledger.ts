import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import type {
  aiWorkflowRunKindEnum,
  aiWorkflowRunStateEnum,
} from '../db/schema/mail.js';

export type AiWorkflowRunKind = (typeof aiWorkflowRunKindEnum.enumValues)[number];
export type AiWorkflowRunState = (typeof aiWorkflowRunStateEnum.enumValues)[number];

export interface EnqueueAiRunInput {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  runKind: AiWorkflowRunKind;
  idempotencyKey: string;
  modelId: string;
  promptVersion: string;
  promptHash?: string;
}

export interface ClaimNextAiRunInput {
  ownerId: string;
}

export interface MarkAiRunSucceededInput {
  runId: string;
  mastraTraceId?: string;
  mastraScorerId?: string;
  generationId?: string;
  metrics?: Record<string, unknown>;
}

export interface MarkAiRunRetryInput {
  runId: string;
  attempts: number;
  nextRunAt: Date;
  lastError: string;
}

export interface MarkAiRunDeadLetterInput {
  runId: string;
  lastError: string;
}

function assertMailRunLinks(input: EnqueueAiRunInput): void {
  if (!input.transportId) throw new Error('transport id is required for mail-triggered AI runs');
  if (!input.threadId) throw new Error('thread id is required for mail-triggered AI runs');
  if (!input.triggerMessageId) {
    throw new Error('trigger message id is required for mail-triggered AI runs');
  }
}

export async function enqueueAiRun(input: EnqueueAiRunInput) {
  assertMailRunLinks(input);
  const db = getDb();
  const now = new Date();
  const id = randomUUID();

  const [inserted] = await db
    .insert(aiWorkflowRun)
    .values({
      id,
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: input.triggerMessageId,
      runKind: input.runKind,
      idempotencyKey: input.idempotencyKey,
      modelId: input.modelId,
      promptVersion: input.promptVersion,
      promptHash: input.promptHash,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: aiWorkflowRun.idempotencyKey })
    .returning();

  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(aiWorkflowRun)
    .where(eq(aiWorkflowRun.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (!existing) {
    throw new Error(`failed to enqueue or load AI run for key ${input.idempotencyKey}`);
  }
  return existing;
}

export async function claimNextAiRun(input: ClaimNextAiRunInput) {
  const db = getDb();
  const now = new Date();

  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(aiWorkflowRun)
      .where(
        and(
          inArray(aiWorkflowRun.state, ['queued', 'retry_wait']),
          or(sql`${aiWorkflowRun.nextRunAt} IS NULL`, lte(aiWorkflowRun.nextRunAt, now)),
        ),
      )
      .orderBy(aiWorkflowRun.createdAt)
      .limit(1)
      .for('update', { skipLocked: true });

    if (!candidate) return null;

    const [claimed] = await tx
      .update(aiWorkflowRun)
      .set({
        state: 'claimed',
        claimOwner: input.ownerId,
        claimedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(aiWorkflowRun.id, candidate.id),
          inArray(aiWorkflowRun.state, ['queued', 'retry_wait']),
        ),
      )
      .returning();

    return claimed ?? null;
  });
}

export async function markAiRunSucceeded(input: MarkAiRunSucceededInput) {
  const db = getDb();
  const now = new Date();
  const [row] = await db
    .update(aiWorkflowRun)
    .set({
      state: 'succeeded',
      mastraTraceId: input.mastraTraceId,
      mastraScorerId: input.mastraScorerId,
      generationId: input.generationId,
      metrics: input.metrics,
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(aiWorkflowRun.id, input.runId))
    .returning();
  return row ?? null;
}

export async function markAiRunRetry(input: MarkAiRunRetryInput) {
  const db = getDb();
  const now = new Date();
  const [row] = await db
    .update(aiWorkflowRun)
    .set({
      state: 'retry_wait',
      attempts: input.attempts,
      nextRunAt: input.nextRunAt,
      lastError: input.lastError,
      claimOwner: null,
      updatedAt: now,
    })
    .where(eq(aiWorkflowRun.id, input.runId))
    .returning();
  return row ?? null;
}

export async function markAiRunDeadLetter(input: MarkAiRunDeadLetterInput) {
  const db = getDb();
  const now = new Date();
  const [row] = await db
    .update(aiWorkflowRun)
    .set({
      state: 'dead_letter',
      lastError: input.lastError,
      claimOwner: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(aiWorkflowRun.id, input.runId))
    .returning();
  return row ?? null;
}
