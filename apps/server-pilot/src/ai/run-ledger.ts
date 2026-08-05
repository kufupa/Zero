import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { getDb, type DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import type {
  aiExecutorLaneEnum,
  aiWorkflowRunKindEnum,
  aiWorkflowRunStateEnum,
} from '../db/schema/mail.js';
import { parseEnv } from '../env.js';

export const DEFAULT_AI_MODEL_ID = 'amazon.nova-lite-v1:0';
export const DEFAULT_TRIAGE_PROMPT_VERSION = 'triage-v5';
export const DEFAULT_FEEDBACK_PROMPT_VERSION = 'feedback-v1';
export const CLEANUP_RESERVE_MS = 10_000;

export type AiWorkflowRunKind = (typeof aiWorkflowRunKindEnum.enumValues)[number];
export type AiWorkflowRunState = (typeof aiWorkflowRunStateEnum.enumValues)[number];
export type AiExecutorLane = (typeof aiExecutorLaneEnum.enumValues)[number];
export type AiWorkflowRun = typeof aiWorkflowRun.$inferSelect;

export const NONTERMINAL_AI_RUN_STATES = [
  'queued',
  'claimed',
  'running',
  'retry_wait',
] as const satisfies readonly AiWorkflowRunState[];

export type AiRunFence = {
  runId: string;
  claimOwner: string;
  claimToken: string;
  deadlineAt: Date;
};

export type AiFailureClass =
  | 'RUN_DEADLINE'
  | 'LEASE_LOST'
  | 'POLICY_BLOCK'
  | 'AUTH'
  | 'PROPERTY_MISMATCH'
  | 'SCHEMA_DRIFT'
  | 'TRANSIENT_NETWORK'
  | 'BEDROCK_TRANSIENT'
  | 'ARTIFACT_TRANSIENT'
  | 'AUDIT_CAPTURE'
  | 'UNKNOWN';

const RETRYABLE_FAILURE_CLASSES: ReadonlySet<AiFailureClass> = new Set([
  'TRANSIENT_NETWORK',
  'BEDROCK_TRANSIENT',
  'ARTIFACT_TRANSIENT',
]);

export interface EnqueueAiRunInput {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  runKind: AiWorkflowRunKind;
  idempotencyKey: string;
  modelId: string;
  promptVersion: string;
  promptHash?: string;
  executorLane?: AiExecutorLane;
}

export interface AiRunScopeFilter {
  transportId?: string;
  runKind?: AiWorkflowRunKind;
  promptVersion?: string;
  idempotencyPrefix?: string;
}

export interface ClaimNextAiRunInput extends AiRunScopeFilter {
  ownerId: string;
  lane: AiExecutorLane;
  now?: Date;
  staleRunTimeoutMs?: number;
  db?: DB;
}

export interface MarkAiRunSucceededInput {
  runId: string;
  claimOwner: string;
  claimToken: string;
  expectedStates: AiWorkflowRunState[];
  mastraTraceId?: string;
  mastraScorerId?: string;
  generationId?: string;
  metrics?: Record<string, unknown>;
}

export interface MarkAiRunRetryInput {
  runId: string;
  claimOwner: string;
  claimToken: string;
  expectedStates: AiWorkflowRunState[];
  attempts: number;
  nextRunAt: Date;
  lastError: string;
  failureClass: AiFailureClass;
}

export interface MarkAiRunDeadLetterInput {
  runId: string;
  claimOwner: string;
  claimToken: string;
  expectedStates: AiWorkflowRunState[];
  lastError: string;
  failureClass?: AiFailureClass;
}

export class RunDeadlineError extends Error {
  readonly failureClass = 'RUN_DEADLINE' as const;
  constructor(message = 'AI run deadline exceeded or cleanup reserve exhausted') {
    super(message);
    this.name = 'RunDeadlineError';
  }
}

function assertMailRunLinks(input: EnqueueAiRunInput): void {
  if (!input.transportId) throw new Error('transport id is required for mail-triggered AI runs');
  if (!input.threadId) throw new Error('thread id is required for mail-triggered AI runs');
  if (!input.triggerMessageId) {
    throw new Error('trigger message id is required for mail-triggered AI runs');
  }
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

export function remainingRunBudgetMs(fence: AiRunFence, now: Date = new Date()): number {
  return fence.deadlineAt.getTime() - now.getTime();
}

export function shouldRetryAiFailure(input: {
  failureClass: AiFailureClass;
  fence: AiRunFence;
  attempts: number;
  now?: Date;
}): boolean {
  if (!RETRYABLE_FAILURE_CLASSES.has(input.failureClass)) return false;
  if (input.attempts >= 1) return false;
  if (remainingRunBudgetMs(input.fence, input.now) < CLEANUP_RESERVE_MS) return false;
  return true;
}

export function toAiRunFence(run: AiWorkflowRun): AiRunFence | null {
  if (!run.claimOwner || !run.claimToken || !run.deadlineAt) return null;
  return {
    runId: run.id,
    claimOwner: run.claimOwner,
    claimToken: run.claimToken,
    deadlineAt: run.deadlineAt,
  };
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
      executorLane: input.executorLane ?? 'default',
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
  const now = input.now ?? new Date();
  const env = parseEnv(process.env as Record<string, string | undefined>);
  const staleRunTimeoutMs = input.staleRunTimeoutMs ?? env.AI_STALE_RUN_TIMEOUT_MS;
  const staleBefore = new Date(now.getTime() - staleRunTimeoutMs);
  const runDeadlineMs = env.HMS_RUN_DEADLINE_MS;
  const scope = scopePredicates({
    transportId: input.transportId,
    runKind: input.runKind,
    promptVersion: input.promptVersion,
    idempotencyPrefix: input.idempotencyPrefix,
  });

  return db.transaction(async (tx) => {
    for (let attempt = 0; attempt < 32; attempt++) {
      const [candidate] = await tx
        .select()
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.executorLane, input.lane),
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

      if (candidate.deadlineAt && candidate.deadlineAt.getTime() <= now.getTime()) {
        await tx
          .update(aiWorkflowRun)
          .set({
            state: 'dead_letter',
            failureClass: 'RUN_DEADLINE',
            lastError: 'RUN_DEADLINE',
            claimOwner: null,
            claimToken: null,
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(aiWorkflowRun.id, candidate.id));
        continue;
      }

      const isReclaim = candidate.state === 'claimed' || candidate.state === 'running';
      const reclaimCount =
        isReclaim && typeof candidate.metrics === 'object' && candidate.metrics !== null
          ? Number((candidate.metrics as Record<string, unknown>).reclaimCount ?? 0) + 1
          : isReclaim
            ? 1
            : undefined;

      const deadlineAt = candidate.deadlineAt ?? new Date(now.getTime() + runDeadlineMs);
      const claimToken = randomUUID();

      const [claimed] = await tx
        .update(aiWorkflowRun)
        .set({
          state: 'claimed',
          claimOwner: input.ownerId,
          claimToken,
          claimedAt: now,
          heartbeatAt: now,
          deadlineAt,
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
            eq(aiWorkflowRun.executorLane, input.lane),
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

      if (claimed) return claimed;
    }

    return null;
  });
}

export async function heartbeatAiRun(fence: AiRunFence, db: DB = getDb()): Promise<boolean> {
  const now = new Date();
  const [row] = await db
    .update(aiWorkflowRun)
    .set({
      heartbeatAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(aiWorkflowRun.id, fence.runId),
        eq(aiWorkflowRun.claimOwner, fence.claimOwner),
        eq(aiWorkflowRun.claimToken, fence.claimToken),
        inArray(aiWorkflowRun.state, ['claimed', 'running']),
      ),
    )
    .returning({ id: aiWorkflowRun.id });
  return Boolean(row);
}

export async function markAiRunRunning(fence: AiRunFence, db: DB = getDb()): Promise<boolean> {
  const now = new Date();
  const [row] = await db
    .update(aiWorkflowRun)
    .set({
      state: 'running',
      heartbeatAt: now,
      startedAt: now,
      deadlineAt: fence.deadlineAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(aiWorkflowRun.id, fence.runId),
        eq(aiWorkflowRun.claimOwner, fence.claimOwner),
        eq(aiWorkflowRun.claimToken, fence.claimToken),
        inArray(aiWorkflowRun.state, ['claimed', 'running']),
      ),
    )
    .returning({ id: aiWorkflowRun.id });
  return Boolean(row);
}

export async function countNonterminalAiRuns(
  scope: AiRunScopeFilter,
  db: DB = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(aiWorkflowRun)
    .where(
      and(inArray(aiWorkflowRun.state, [...NONTERMINAL_AI_RUN_STATES]), ...scopePredicates(scope)),
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
      claimOwner: null,
      claimToken: null,
    })
    .where(
      and(
        eq(aiWorkflowRun.id, input.runId),
        eq(aiWorkflowRun.claimOwner, input.claimOwner),
        eq(aiWorkflowRun.claimToken, input.claimToken),
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
      failureClass: input.failureClass,
      claimOwner: null,
      claimToken: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(aiWorkflowRun.id, input.runId),
        eq(aiWorkflowRun.claimOwner, input.claimOwner),
        eq(aiWorkflowRun.claimToken, input.claimToken),
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
      failureClass: input.failureClass,
      claimOwner: null,
      claimToken: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(aiWorkflowRun.id, input.runId),
        eq(aiWorkflowRun.claimOwner, input.claimOwner),
        eq(aiWorkflowRun.claimToken, input.claimToken),
        inArray(aiWorkflowRun.state, input.expectedStates),
      ),
    )
    .returning();
  return row ?? null;
}
