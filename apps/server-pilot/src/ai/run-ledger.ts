import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { getDb, type DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import type {
  aiWorkflowRunKindEnum,
  aiWorkflowRunStateEnum,
} from '../db/schema/mail.js';
import { parseEnv } from '../env.js';

export const DEFAULT_AI_MODEL_ID = 'amazon.nova-lite-v1:0';
export const DEFAULT_TRIAGE_PROMPT_VERSION = 'triage-v2';
export const DEFAULT_FEEDBACK_PROMPT_VERSION = 'feedback-v1';

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
  staleRunTimeoutMs?: number;
  db?: DB;
}

export interface MarkAiRunSucceededInput {
  runId: string;
  claimOwner: string;
  expectedStates: AiWorkflowRunState[];
  mastraTraceId?: string;
  mastraScorerId?: string;
  generationId?: string;
  metrics?: Record<string, unknown>;
}

export interface MarkAiRunRetryInput {
  runId: string;
  claimOwner: string;
  expectedStates: AiWorkflowRunState[];
  attempts: number;
  nextRunAt: Date;
  lastError: string;
}

export interface MarkAiRunDeadLetterInput {
  runId: string;
  claimOwner: string;
  expectedStates: AiWorkflowRunState[];
  lastError: string;
}

function assertMailRunLinks(input: EnqueueAiRunInput): void {
  if (!input.transportId) throw new Error('transport id is required for mail-triggered AI runs');
  if (!input.threadId) throw new Error('thread id is required for mail-triggered AI runs');
  if (!input.triggerMessageId) {
    throw new Error('trigger message id is required for mail-triggered AI runs');
  }
}

export async function enqueueAiRun(input: EnqueueAiRunInput, db: DB = getDb()) {
  assertMailRunLinks(input);
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
  const db = input.db ?? getDb();
  const now = new Date();
  const staleRunTimeoutMs =
    input.staleRunTimeoutMs ??
    parseEnv(process.env as Record<string, string | undefined>).AI_STALE_RUN_TIMEOUT_MS;
  const staleBefore = new Date(now.getTime() - staleRunTimeoutMs);

  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(aiWorkflowRun)
      .where(
        or(
          and(
            inArray(aiWorkflowRun.state, ['queued', 'retry_wait']),
            or(sql`${aiWorkflowRun.nextRunAt} IS NULL`, lte(aiWorkflowRun.nextRunAt, now)),
          ),
          and(
            inArray(aiWorkflowRun.state, ['claimed', 'running']),
            lte(aiWorkflowRun.updatedAt, staleBefore),
          ),
        ),
      )
      .orderBy(aiWorkflowRun.createdAt)
      .limit(1)
      .for('update', { skipLocked: true });

    if (!candidate) return null;

    const isReclaim = candidate.state === 'claimed' || candidate.state === 'running';
    const reclaimCount =
      isReclaim && typeof candidate.metrics === 'object' && candidate.metrics !== null
        ? Number((candidate.metrics as Record<string, unknown>).reclaimCount ?? 0) + 1
        : isReclaim
          ? 1
          : undefined;

    const [claimed] = await tx
      .update(aiWorkflowRun)
      .set({
        state: 'claimed',
        claimOwner: input.ownerId,
        claimedAt: now,
        updatedAt: now,
        ...(reclaimCount !== undefined
          ? {
              metrics: {
                ...(typeof candidate.metrics === 'object' && candidate.metrics !== null
                  ? (candidate.metrics as Record<string, unknown>)
                  : {}),
                reclaimCount,
              },
            }
          : {}),
      })
      .where(
        and(
          eq(aiWorkflowRun.id, candidate.id),
          or(
            and(
              inArray(aiWorkflowRun.state, ['queued', 'retry_wait']),
              or(sql`${aiWorkflowRun.nextRunAt} IS NULL`, lte(aiWorkflowRun.nextRunAt, now)),
            ),
            and(
              inArray(aiWorkflowRun.state, ['claimed', 'running']),
              lte(aiWorkflowRun.updatedAt, staleBefore),
            ),
          ),
        ),
      )
      .returning();

    return claimed ?? null;
  });
}

export async function markAiRunSucceeded(input: MarkAiRunSucceededInput, db: DB = getDb()) {
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
    .where(
      and(
        eq(aiWorkflowRun.id, input.runId),
        eq(aiWorkflowRun.claimOwner, input.claimOwner),
        inArray(aiWorkflowRun.state, input.expectedStates),
      ),
    )
    .returning();
  return row ?? null;
}

export async function markAiRunRetry(input: MarkAiRunRetryInput, db: DB = getDb()) {
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
    .where(
      and(
        eq(aiWorkflowRun.id, input.runId),
        eq(aiWorkflowRun.claimOwner, input.claimOwner),
        inArray(aiWorkflowRun.state, input.expectedStates),
      ),
    )
    .returning();
  return row ?? null;
}

export async function markAiRunDeadLetter(input: MarkAiRunDeadLetterInput, db: DB = getDb()) {
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
    .where(
      and(
        eq(aiWorkflowRun.id, input.runId),
        eq(aiWorkflowRun.claimOwner, input.claimOwner),
        inArray(aiWorkflowRun.state, input.expectedStates),
      ),
    )
    .returning();
  return row ?? null;
}
