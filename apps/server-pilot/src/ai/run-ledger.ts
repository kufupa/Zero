import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { getDb, type DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import type {
  aiWorkflowRunKindEnum,
  aiWorkflowRunStateEnum,
} from '../db/schema/mail.js';
import { parseEnv } from '../env.js';

export const DEFAULT_AI_MODEL_ID = 'amazon.nova-lite-v1:0';
export const DEFAULT_TRIAGE_PROMPT_VERSION = 'triage-v4';
export const DEFAULT_FEEDBACK_PROMPT_VERSION = 'feedback-v1';

export type AiWorkflowRunKind = (typeof aiWorkflowRunKindEnum.enumValues)[number];
export type AiWorkflowRunState = (typeof aiWorkflowRunStateEnum.enumValues)[number];

export const NONTERMINAL_AI_RUN_STATES = [
  'queued',
  'claimed',
  'running',
  'retry_wait',
] as const satisfies readonly AiWorkflowRunState[];

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
  transportId?: string;
  runKind?: AiWorkflowRunKind;
  promptVersion?: string;
  idempotencyPrefix?: string;
  db?: DB;
}

export interface AiRunScopeFilter {
  transportId?: string;
  runKind?: AiWorkflowRunKind;
  promptVersion?: string;
  idempotencyPrefix?: string;
}

export interface MarkAiRunRunningInput {
  runId: string;
  claimOwner: string;
  db?: DB;
}

/** Deployed inbound triage prompt this binary will execute. Others dead-letter. */
export function resolveDeployedTriagePromptVersion(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const fromEnv = env.AI_TRIAGE_PROMPT_VERSION?.trim();
  return fromEnv || DEFAULT_TRIAGE_PROMPT_VERSION;
}

export function isSupportedInboundTriagePromptVersion(
  promptVersion: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): boolean {
  return promptVersion === resolveDeployedTriagePromptVersion(env);
}

function scopePredicates(scope: AiRunScopeFilter): SQL[] {
  const parts: SQL[] = [];
  if (scope.transportId) parts.push(eq(aiWorkflowRun.transportId, scope.transportId));
  if (scope.runKind) parts.push(eq(aiWorkflowRun.runKind, scope.runKind));
  if (scope.promptVersion) parts.push(eq(aiWorkflowRun.promptVersion, scope.promptVersion));
  if (scope.idempotencyPrefix) {
    parts.push(like(aiWorkflowRun.idempotencyKey, `${scope.idempotencyPrefix}%`));
  }
  return parts;
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
  const scope = scopePredicates({
    transportId: input.transportId,
    runKind: input.runKind,
    promptVersion: input.promptVersion,
    idempotencyPrefix: input.idempotencyPrefix,
  });

  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(aiWorkflowRun)
      .where(
        and(
          ...scope,
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
          ...scope,
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

export async function markAiRunRunning(input: MarkAiRunRunningInput) {
  const db = input.db ?? getDb();
  const now = new Date();
  const [row] = await db
    .update(aiWorkflowRun)
    .set({
      state: 'running',
      claimOwner: input.claimOwner,
      startedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(aiWorkflowRun.id, input.runId),
        or(
          inArray(aiWorkflowRun.state, ['queued', 'retry_wait']),
          and(
            eq(aiWorkflowRun.claimOwner, input.claimOwner),
            inArray(aiWorkflowRun.state, ['claimed', 'running']),
          ),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

export async function countNonterminalAiRuns(
  scope: AiRunScopeFilter,
  db: DB = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(aiWorkflowRun)
    .where(
      and(
        inArray(aiWorkflowRun.state, [...NONTERMINAL_AI_RUN_STATES]),
        ...scopePredicates(scope),
      ),
    );
  return Number(row?.count ?? 0);
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
