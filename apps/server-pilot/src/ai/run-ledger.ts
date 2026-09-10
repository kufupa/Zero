import {
  companyAccountContextDataSchema,
  eventContextDataSchema,
  groupBlockContextDataSchema,
  notesTracesContextDataSchema,
} from '../hms/context-read-contracts.js';
import {
  readRefSchema,
  readReservationBindingSchema,
  readResultSchema,
  type ReadReservationBinding,
  type ReadResult,
} from '../hms/read-service-contracts.js';
import {
  existingDocumentListDataSchema,
  existingDocumentReadDataSchema,
} from '../mail/artifacts/existing-document-contracts.js';
import {
  assertReadAdmissionIssuer,
  READ_CLEANUP_RESERVE_MS,
  type ReadAdmissionIssuer,
} from '../hms/read-admission.js';
import {
  reservationContextReadResultSchema,
  reservationFindResultSchema,
} from '../hms/reservation-context-contract.js';
import type {
  aiExecutorLaneEnum,
  aiWorkflowRunKindEnum,
  aiWorkflowRunStateEnum,
} from '../db/schema/mail.js';
import { and, desc, eq, inArray, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { folioReadDataSchema } from '../hms/folio-read-contract.js';
import { READ_TOOLS, type ReadToolId } from '../hms/read-tools.js';
import { readRequestSchema } from '../hms/read-service.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import { createHash, randomUUID } from 'node:crypto';
import { getDb, type DB } from '../db/client.js';
import { parseEnv } from '../env.js';

export const DEFAULT_AI_MODEL_ID = 'amazon.nova-lite-v1:0';
export const DEFAULT_TRIAGE_PROMPT_VERSION = 'triage-v6';
export const DEFAULT_FEEDBACK_PROMPT_VERSION = 'feedback-v1';
export const NOT_APPLICABLE_MODEL_ID = 'not_applicable';
export const READ_TOOL_PROMPT_VERSION = 'hms-read/1';
export const READ_TOOL_RUN_KIND = 'read_tool' as const;
export const MAIL_BASELINE_GENERATION_VERSION = 'mail-baseline-generation-v1';

/** Stable analytics generation identity for retries and immutable restatements. */
export function mailBaselineGenerationKey(input: {
  transportId: string;
  threadId: string;
  sourceMessageId: string;
  sourceVintage: string;
  interpretationVersion: string;
}): string {
  const canonical = [
    MAIL_BASELINE_GENERATION_VERSION,
    input.transportId,
    input.threadId,
    input.sourceMessageId,
    input.sourceVintage,
    input.interpretationVersion,
  ].join('\u001f');
  return `${MAIL_BASELINE_GENERATION_VERSION}:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export function canClaimReadToolRun(input: {
  runKind: AiWorkflowRunKind | string;
  lane: AiExecutorLane | string;
  readServiceEnabled: boolean;
}): boolean {
  return input.runKind !== READ_TOOL_RUN_KIND || (input.lane === 'hms' && input.readServiceEnabled);
}
export const CLEANUP_RESERVE_MS = READ_CLEANUP_RESERVE_MS;

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

const NONTERMINAL_AI_RUN_STATE_SET = new Set<AiWorkflowRunState>(NONTERMINAL_AI_RUN_STATES);

function isTerminalReadRun(run: AiWorkflowRun): boolean {
  return (
    run.runKind === READ_TOOL_RUN_KIND &&
    !NONTERMINAL_AI_RUN_STATE_SET.has(run.state) &&
    run.state !== 'succeeded'
  );
}

function escapeLikePrefix(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export type AiRunFence = {
  runId: string;
  claimOwner: string;
  claimToken: string;
  deadlineAt: Date;
};

export type CandidateReadPlanKind =
  | 'reservation'
  | 'artifact_reservation'
  | 'quote'
  | 'group'
  | 'event';

export type ReadBudgetMetrics = {
  total: number;
  byTool: Partial<Record<ReadToolId, number>>;
};

const PLAN_TOTAL_CAPS: Readonly<Record<CandidateReadPlanKind, number>> = {
  reservation: 3,
  artifact_reservation: 6,
  quote: 1,
  group: 1,
  event: 1,
};

export function mergeTerminalRunMetrics(
  existing: unknown,
  terminal: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object' ? (existing as Record<string, unknown>) : {};
  const readBudget = base.readBudget;
  return {
    ...base,
    ...terminal,
    ...(readBudget === undefined ? {} : { readBudget }),
  };
}

/**
 * Pure budget step. Returns null when the persisted counters are unusable
 * (non-finite, negative, non-numeric) or when a cap is already reached.
 */
export function nextReadBudget(
  rawBudget: Partial<ReadBudgetMetrics>,
  planKind: CandidateReadPlanKind,
  toolId: ReadToolId,
): ReadBudgetMetrics | null {
  const byTool = { ...rawBudget.byTool };
  const total = Number(rawBudget.total ?? 0);
  const perTool = Number(byTool[toolId] ?? 0);
  if (!Number.isFinite(total) || !Number.isFinite(perTool) || total < 0 || perTool < 0) {
    return null;
  }
  if (total >= PLAN_TOTAL_CAPS[planKind] || perTool >= READ_TOOLS[toolId].attemptCap) {
    return null;
  }
  return { total: total + 1, byTool: { ...byTool, [toolId]: perTool + 1 } };
}

export async function reserveReadAttempt(
  fence: AiRunFence,
  planKind: CandidateReadPlanKind,
  toolId: ReadToolId,
  db: DB = getDb(),
  now = new Date(),
): Promise<ReadBudgetMetrics | null> {
  if (fence.deadlineAt.getTime() - now.getTime() < CLEANUP_RESERVE_MS) return null;
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(aiWorkflowRun)
      .where(
        and(
          eq(aiWorkflowRun.id, fence.runId),
          eq(aiWorkflowRun.claimOwner, fence.claimOwner),
          eq(aiWorkflowRun.claimToken, fence.claimToken),
          inArray(aiWorkflowRun.state, ['claimed', 'running']),
        ),
      )
      .limit(1)
      .for('update');
    if (!run || !run.deadlineAt || run.deadlineAt.getTime() <= now.getTime()) {
      return null;
    }
    const metrics =
      run.metrics && typeof run.metrics === 'object'
        ? (run.metrics as Record<string, unknown>)
        : {};
    const rawBudget =
      metrics.readBudget && typeof metrics.readBudget === 'object'
        ? (metrics.readBudget as Partial<ReadBudgetMetrics>)
        : {};
    const next = nextReadBudget(rawBudget, planKind, toolId);
    if (!next) return null;
    const [updated] = await tx
      .update(aiWorkflowRun)
      .set({
        metrics: { ...metrics, readBudget: next },
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
    return updated ? next : null;
  });
}

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
  /** Closed, trusted read request; only present for read_tool runs. */
  readRequest?: Record<string, unknown>;
  /** Private typed receipt reference; only present for read_tool runs. */
  readResultRef?: string;
  /** Non-serializable server-issued admission provenance. */
  readAdmissionIssuer?: ReadAdmissionIssuer;
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
  readResultRef?: string;
  readResult?: ReadResult<unknown>;
  readResultExpiresAt?: Date;
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
  // Legacy versions remain drainable only when explicitly selected through
  // AI_TRIAGE_PROMPT_VERSION; unset env resolves to the v6 cutover default.
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
  let readAdmissionBinding: ReadReservationBinding | undefined;
  let readAdmissionIssuer: ReturnType<typeof assertReadAdmissionIssuer> | undefined;
  if (input.runKind === 'read_tool') {
    if (input.executorLane !== 'hms') {
      throw new Error('read_tool runs must use the hms executor lane');
    }
    if (input.modelId !== NOT_APPLICABLE_MODEL_ID) {
      throw new Error('read_tool runs require modelId=not_applicable');
    }
    if (input.promptVersion !== READ_TOOL_PROMPT_VERSION) {
      throw new Error(`read_tool runs require promptVersion=${READ_TOOL_PROMPT_VERSION}`);
    }
    if (!input.readRequest || typeof input.readRequest !== 'object')
      throw new Error('read_tool runs require a closed readRequest');
    if (!input.readResultRef) throw new Error('read_tool runs require a private readResultRef');
    const parsedReadRequest = readRequestSchema.parse(input.readRequest);
    const admission = 'admission' in parsedReadRequest ? parsedReadRequest.admission : undefined;
    if (!admission) throw new Error('read_tool runs require trusted admission');
    readAdmissionIssuer = assertReadAdmissionIssuer({
      issuer: input.readAdmissionIssuer,
      admission,
      request: parsedReadRequest as unknown as Record<string, unknown>,
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: input.triggerMessageId,
    });
    if (
      (parsedReadRequest.toolId === 'hms_find_reservation' && admission.reservationRef !== null) ||
      (parsedReadRequest.toolId === 'hms_quote_stay' && admission.reservationRef !== null) ||
      ((parsedReadRequest.toolId === 'hms_read_reservation' ||
        parsedReadRequest.toolId === 'hms_read_folio') &&
        admission.reservationRef !== parsedReadRequest.reservationRef) ||
      (parsedReadRequest.toolId === 'hms_company_account_read' &&
        admission.reservationRef !== parsedReadRequest.reservationRef) ||
      (parsedReadRequest.toolId === 'hms_group_block_read' &&
        admission.reservationRef !== parsedReadRequest.groupRef) ||
      (parsedReadRequest.toolId === 'hms_event_read' &&
        admission.reservationRef !== parsedReadRequest.eventRef) ||
      (parsedReadRequest.toolId === 'hms_read_notes_traces' &&
        admission.reservationRef !== parsedReadRequest.resourceRef)
    ) {
      throw new Error('read_tool reservation reference is not bound to trusted admission');
    }
    if (
      parsedReadRequest.toolId === 'hms_read_reservation' ||
      parsedReadRequest.toolId === 'hms_read_folio'
    ) {
      if (!parsedReadRequest.candidateId) {
        throw new Error('resolved read_tool runs require a server-bound candidateId');
      }
      readAdmissionBinding = readReservationBindingSchema.parse({
        transportId: input.transportId,
        threadId: input.threadId,
        triggerMessageId: input.triggerMessageId,
        candidateId: parsedReadRequest.candidateId,
        reservationRef: admission.reservationRef,
        reservationRefIssuedAt: admission.reservationRefIssuedAt,
        reservationRefExpiresAt: admission.reservationRefExpiresAt,
      });
    }
    input.readRequest = parsedReadRequest;
    input.readResultRef = readRefSchema.parse(input.readResultRef);
  }
  const now = new Date();
  const id = randomUUID();
  const values = {
    id,
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    runKind: input.runKind,
    idempotencyKey: input.idempotencyKey,
    modelId: input.modelId,
    promptVersion: input.promptVersion,
    promptHash: input.promptHash,
    readRequest: input.readRequest,
    readResultRef: input.readResultRef,
    ...(readAdmissionBinding || readAdmissionIssuer
      ? {
          metrics: {
            ...(readAdmissionIssuer ? { readAdmissionIssuer } : {}),
            ...(readAdmissionBinding ? { readAdmissionBinding } : {}),
          },
        }
      : {}),
    executorLane: input.executorLane ?? 'default',
    state: 'queued' as const,
    createdAt: now,
    updatedAt: now,
  };

  if (input.runKind !== READ_TOOL_RUN_KIND) {
    const [inserted] = await db
      .insert(aiWorkflowRun)
      .values(values)
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

  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(aiWorkflowRun)
      .values(values)
      .onConflictDoNothing({ target: aiWorkflowRun.idempotencyKey })
      .returning();
    if (inserted) return inserted;

    const [existing] = await tx
      .select()
      .from(aiWorkflowRun)
      .where(eq(aiWorkflowRun.idempotencyKey, input.idempotencyKey))
      .limit(1)
      .for('update');
    if (!existing) {
      throw new Error(`failed to enqueue or load AI run for key ${input.idempotencyKey}`);
    }
    if (!isTerminalReadRun(existing)) return existing;

    const retryPrefix = `${escapeLikePrefix(input.idempotencyKey)}:attempt:`;
    const [latestAttempt] = await tx
      .select()
      .from(aiWorkflowRun)
      .where(
        and(
          eq(aiWorkflowRun.runKind, READ_TOOL_RUN_KIND),
          like(aiWorkflowRun.idempotencyKey, `${retryPrefix}%`),
        ),
      )
      .orderBy(desc(aiWorkflowRun.createdAt), desc(aiWorkflowRun.id))
      .limit(1)
      .for('update');
    if (latestAttempt && !isTerminalReadRun(latestAttempt)) return latestAttempt;

    const retryKey = `${input.idempotencyKey}:attempt:${randomUUID()}`;
    const [retry] = await tx
      .insert(aiWorkflowRun)
      .values({
        ...values,
        id: randomUUID(),
        idempotencyKey: retryKey,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    if (!retry) {
      throw new Error(`failed to enqueue retry for key ${input.idempotencyKey}`);
    }
    return retry;
  });
}

export async function claimNextAiRun(input: ClaimNextAiRunInput) {
  if (input.runKind === 'read_tool' && input.lane !== 'hms') return null;
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const env = parseEnv(process.env as Record<string, string | undefined>);
  if (
    !canClaimReadToolRun({
      runKind: input.runKind ?? '',
      lane: input.lane,
      readServiceEnabled: env.HMS_READ_SERVICE_ENABLED,
    })
  )
    return null;
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
  return db.transaction(async (tx) => {
    const predicate = and(
      eq(aiWorkflowRun.id, input.runId),
      eq(aiWorkflowRun.claimOwner, input.claimOwner),
      eq(aiWorkflowRun.claimToken, input.claimToken),
      inArray(aiWorkflowRun.state, input.expectedStates),
    );
    const [current] = await tx
      .select({ metrics: aiWorkflowRun.metrics, runKind: aiWorkflowRun.runKind })
      .from(aiWorkflowRun)
      .where(predicate)
      .limit(1)
      .for('update');
    if (!current) return null;
    const [row] = await tx
      .update(aiWorkflowRun)
      .set({
        state: 'succeeded',
        mastraTraceId: input.mastraTraceId,
        mastraScorerId: input.mastraScorerId,
        generationId: input.generationId,
        ...(input.readResultRef === undefined ? {} : { readResultRef: input.readResultRef }),
        ...(input.readResult === undefined ? {} : { readResult: input.readResult }),
        ...(input.readResultExpiresAt === undefined
          ? {}
          : { readResultExpiresAt: input.readResultExpiresAt }),
        metrics: mergeTerminalRunMetrics(current.metrics, input.metrics),
        finishedAt: now,
        updatedAt: now,
        claimOwner: null,
        claimToken: null,
      })
      .where(predicate)
      .returning();
    return row ?? null;
  });
}

export interface ReadAiRunReceiptInput {
  readResultRef: string;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  requesterAuthorizationId: string;
  now?: Date;
}

/**
 * Read a private typed receipt only for the exact triggering mail scope and
 * trusted requester that admitted the run. Expired or unbound receipts are
 * deliberately indistinguishable from a missing receipt.
 */
export async function readAiRunReceipt(
  input: ReadAiRunReceiptInput,
  db: DB = getDb(),
): Promise<{ readResultRef: string; result: ReadResult<unknown>; expiresAt: Date } | null> {
  const ref = readRefSchema.parse(input.readResultRef);
  const [run] = await db
    .select()
    .from(aiWorkflowRun)
    .where(eq(aiWorkflowRun.readResultRef, ref))
    .limit(1);
  if (
    !run ||
    run.runKind !== 'read_tool' ||
    run.state !== 'succeeded' ||
    run.transportId !== input.transportId ||
    run.threadId !== input.threadId ||
    run.triggerMessageId !== input.triggerMessageId ||
    !run.readResult ||
    !run.readResultExpiresAt
  ) {
    return null;
  }
  const request = readRequestSchema.safeParse(run.readRequest);
  const admission =
    request.success && 'admission' in request.data ? request.data.admission : undefined;
  if (!admission || admission.requesterAuthorizationId !== input.requesterAuthorizationId) {
    return null;
  }
  const now = input.now ?? new Date();
  if (run.readResultExpiresAt.getTime() <= now.getTime()) return null;
  const result = readResultSchema.parse(run.readResult);
  let concrete: unknown;
  if (result.toolId === 'hms_find_reservation') {
    concrete = reservationFindResultSchema.parse(result);
  } else if (result.toolId === 'hms_read_reservation') {
    concrete = reservationContextReadResultSchema.parse(result);
  } else if (result.toolId === 'documents_list_existing') {
    if (result.data !== null) existingDocumentListDataSchema.parse(result.data);
    concrete = result;
  } else if (result.toolId === 'hms_read_folio') {
    if (result.data !== null) folioReadDataSchema.parse(result.data);
    concrete = result;
  } else if (result.toolId === 'hms_quote_stay') {
    concrete = result;
  } else if (result.toolId === 'hms_company_account_read') {
    if (result.data !== null) companyAccountContextDataSchema.parse(result.data);
    concrete = result;
  } else if (result.toolId === 'hms_group_block_read') {
    if (result.data !== null) groupBlockContextDataSchema.parse(result.data);
    concrete = result;
  } else if (result.toolId === 'hms_event_read') {
    if (result.data !== null) eventContextDataSchema.parse(result.data);
    concrete = result;
  } else if (result.toolId === 'hms_read_notes_traces') {
    if (result.data !== null) notesTracesContextDataSchema.parse(result.data);
    concrete = result;
  } else {
    if (result.data !== null) existingDocumentReadDataSchema.parse(result.data);
    concrete = result;
  }
  return {
    readResultRef: ref,
    result: concrete as ReadResult<unknown>,
    expiresAt: run.readResultExpiresAt,
  };
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
