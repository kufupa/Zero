import { isCliEntry } from '../lib/is-cli-entry.js';
import { and, asc, eq } from 'drizzle-orm';
import { closeDb, getDb } from '../db/client.js';
import {
  aiWorkflowRun,
  aiDraftGeneration,
  mailDraft,
  mailDraftRevision,
  mailThread,
  message,
} from '../db/schema/mail.js';
import {
  parseEnv,
  requireHmsWorkerRuntimeConfig,
  type AiExecutorLane,
  type EnvInput,
} from '../env.js';
import { createMastraRuntime } from './mastra.js';
import { persistAiCandidateDraft, loadLatestThreadAffectingDraftRevisionId } from './drafts.js';
import { extractDraftFeedbackLabels } from './feedback.js';
import {
  claimNextAiRun,
  CLEANUP_RESERVE_MS,
  countNonterminalAiRuns,
  enqueueAiRun,
  heartbeatAiRun,
  isSupportedInboundTriagePromptVersion,
  markAiRunDeadLetter,
  markAiRunRetry,
  markAiRunRunning,
  markAiRunSucceeded,
  remainingRunBudgetMs,
  resolveDeployedTriagePromptVersion,
  RunDeadlineError,
  shouldRetryAiFailure,
  toAiRunFence,
  type AiFailureClass,
  type AiRunFence,
  type AiRunScopeFilter,
  type AiWorkflowRunKind,
} from './run-ledger.js';
import { buildCausalTriageMessages, type TriageMessageRow } from './triage-input.js';
import { validateTriageOutput } from './triage.js';

function resolveWorkerLane(): AiExecutorLane {
  return parseEnv(process.env as Record<string, string | undefined>).AI_WORKER_LANE;
}

/**
 * Fail-closed HMS shadow gate for hms-ai-worker. Default lane never invokes
 * requireHmsWorkerRuntimeConfig; mode=off on HMS lane stays secret-free.
 */
export function assertHmsLaneRuntimeReady(
  input: EnvInput = process.env as EnvInput,
): void {
  const env = parseEnv(input);
  if (env.AI_WORKER_LANE !== 'hms') return;
  if (env.HMS_DRAFT_ENRICHMENT_MODE !== 'shadow') return;
  requireHmsWorkerRuntimeConfig(input);
}

export function aiWorkerOwnerId(lane: AiExecutorLane = resolveWorkerLane()): string {
  return `${lane}-ai-worker-${process.pid}`;
}

/** @deprecated Prefer aiWorkerOwnerId(lane); kept for older call sites. */
export const AI_WORKER_OWNER = aiWorkerOwnerId('default');

const MONEY_DRAFT_CATEGORIES = new Set(['new-bookings', 'groups-events', 'at-risk']);
/** Periodic lease renewal while a run executes (15–30s band). */
export const AI_LEASE_HEARTBEAT_INTERVAL_MS = 20_000;
export interface ExecuteAiRunResult {
  runId: string;
  state: 'succeeded' | 'retry_wait' | 'dead_letter';
}

export interface AiWorkerCliArgs {
  drainPrefix?: string;
  transportId?: string;
  promptVersion?: string;
  timeoutMs?: number;
  runKind: AiWorkflowRunKind;
}

export interface RunAiWorkerDrainInput extends AiRunScopeFilter {
  timeoutMs: number;
  pollIntervalMs?: number;
  ownerId?: string;
}

export interface RunAiWorkerDrainResult {
  ok: boolean;
  reason: 'drained' | 'timeout';
  remainingNonterminal: number;
  processed: number;
}

function claimOwnerFor(run: typeof aiWorkflowRun.$inferSelect): string {
  return run.claimOwner ?? aiWorkerOwnerId(run.executorLane ?? resolveWorkerLane());
}

function classifyAiFailure(error: unknown): AiFailureClass {
  if (error instanceof RunDeadlineError) return 'RUN_DEADLINE';
  if (error && typeof error === 'object' && 'failureClass' in error) {
    return (error as { failureClass: AiFailureClass }).failureClass;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|ECONNRESET|ENOTFOUND|network/i.test(message)) return 'TRANSIENT_NETWORK';
  if (/bedrock|throttl|TooManyRequests|ServiceUnavailable/i.test(message)) {
    return 'BEDROCK_TRANSIENT';
  }
  if (/artifact|s3|NoSuchKey/i.test(message)) return 'ARTIFACT_TRANSIENT';
  if (/policy|guardrail/i.test(message)) return 'POLICY_BLOCK';
  if (/auth|unauthorized|forbidden/i.test(message)) return 'AUTH';
  return 'UNKNOWN';
}

function buildRunAbortSignal(input: {
  fence: AiRunFence;
  leaseAbort: AbortController;
  shutdownSignal: AbortSignal;
  now?: Date;
}): AbortSignal {
  const remaining = remainingRunBudgetMs(input.fence, input.now);
  if (remaining <= CLEANUP_RESERVE_MS) throw new RunDeadlineError();
  const budgetSignal = AbortSignal.timeout(remaining);
  return AbortSignal.any([budgetSignal, input.leaseAbort.signal, input.shutdownSignal]);
}

export function parseAiWorkerCliArgs(argv: string[]): AiWorkerCliArgs {
  let drainPrefix: string | undefined;
  let transportId: string | undefined;
  let promptVersion: string | undefined;
  let timeoutMs: number | undefined;
  let runKind: AiWorkflowRunKind = 'inbound_triage';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--drain-prefix') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--drain-prefix requires a value');
      drainPrefix = value;
      continue;
    }
    if (arg === '--transport-id') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--transport-id requires a value');
      transportId = value;
      continue;
    }
    if (arg === '--prompt-version') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--prompt-version requires a value');
      promptVersion = value;
      continue;
    }
    if (arg === '--timeout-ms') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--timeout-ms requires a value');
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--timeout-ms must be a positive number, got: ${value}`);
      }
      timeoutMs = parsed;
      continue;
    }
    if (arg === '--run-kind') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--run-kind requires a value');
      runKind = value as AiWorkflowRunKind;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return { drainPrefix, transportId, promptVersion, timeoutMs, runKind };
}

async function failAiRun(
  run: typeof aiWorkflowRun.$inferSelect,
  error: unknown,
  fence: AiRunFence | null,
): Promise<ExecuteAiRunResult> {
  const message = error instanceof Error ? error.message : String(error);
  const failureClass = classifyAiFailure(error);
  const attempts = run.attempts + 1;
  const owner = claimOwnerFor(run);
  const claimToken = fence?.claimToken ?? run.claimToken;
  if (!claimToken) {
    return { runId: run.id, state: 'dead_letter' };
  }

  const canRetry =
    fence !== null &&
    shouldRetryAiFailure({
      failureClass,
      fence,
      attempts: run.attempts,
    });

  if (!canRetry) {
    await markAiRunDeadLetter({
      runId: run.id,
      claimOwner: owner,
      claimToken,
      expectedStates: ['running'],
      lastError: message,
      failureClass,
    });
    return { runId: run.id, state: 'dead_letter' };
  }

  await markAiRunRetry({
    runId: run.id,
    claimOwner: owner,
    claimToken,
    expectedStates: ['running'],
    attempts,
    nextRunAt: new Date(Date.now() + attempts * 60_000),
    lastError: message,
    failureClass,
  });
  return { runId: run.id, state: 'retry_wait' };
}

export type CandidateSessionInput = {
  transportId: string;
  threadId: string;
  lookupCandidates: readonly import('./thread-context.js').LookupCandidate[];
  signal: AbortSignal;
  /** AI run UUID — becomes HMS browser audit operationId when capture is enabled. */
  runId?: string;
};

export type CandidateSessionFactory = (
  input: CandidateSessionInput,
) => Promise<import('./candidate-draft-agent.js').CandidateToolSession>;

/** Singleton production HMS runtime — one Chromium process per HMS worker. */
let productionHmsRuntime:
  | import('../hms/runtime.js').HmsRuntime
  | null
  | undefined;

async function getOrCreateProductionHmsRuntime(): Promise<
  import('../hms/runtime.js').HmsRuntime
> {
  if (productionHmsRuntime) return productionHmsRuntime;
  const { createProductionHmsRuntime } = await import(
    '../hms/production-runtime.js'
  );
  const config = requireHmsWorkerRuntimeConfig(
    process.env as Record<string, string | undefined>,
  );
  const runtime = await createProductionHmsRuntime(config);
  await runtime.start(AbortSignal.timeout(Math.min(60_000, config.runDeadlineMs)));
  productionHmsRuntime = runtime;
  return runtime;
}

/** Test / shutdown hook — closes singleton and clears handle. */
export async function closeProductionHmsRuntimeForTests(): Promise<void> {
  const rt = productionHmsRuntime;
  productionHmsRuntime = null;
  if (rt) await rt.close();
}

export function createLiveHmsCandidateSessionFactory(): CandidateSessionFactory {
  return async (input) => {
    const runtime = await getOrCreateProductionHmsRuntime();
    const { createLiveGuestStayDriver } = await import(
      '../hms/live-guest-stay-driver.js'
    );
    const { createReservationCandidateSession } = await import(
      '../hms/reservation-candidate-session.js'
    );
    const { filterExactReservationCandidates } = await import(
      './thread-context.js'
    );
    const exact = filterExactReservationCandidates(input.lookupCandidates);
    const driver = createLiveGuestStayDriver({
      runtime,
      transportId: input.transportId,
      auditSpecFor: input.runId
        ? ({ inputClass }) => ({
            operationId: input.runId!,
            toolId: 'hms_find_reservation',
            toolVersion: '1.1.0',
            dependencyRevision:
              'playwright-1.52.0-chromium-1169',
            executionClass: 'normal',
            inputClass,
          })
        : undefined,
    });
    // openReadSession already authenticates + verifies property; do not open a
    // second pre-tool login session (would create a second audited context).
    return createReservationCandidateSession({
      driver,
      candidates: new Map(exact.map((c) => [c.id, c])),
      close: async () => undefined,
      runId: input.runId,
    });
  };
}

export async function executeAiRun(
  runId: string,
  options: {
    shutdownSignal?: AbortSignal;
    /** Injectable claim-safe tool session (tests / Task 7 mocks). */
    candidateSessionFactory?: CandidateSessionFactory;
    candidatePlanModel?: (prompt: {
      systemPrompt: string;
      userPrompt: string;
    }) => Promise<unknown>;
  } = {},
): Promise<ExecuteAiRunResult> {
  const db = getDb();
  const env = parseEnv(process.env as Record<string, string | undefined>);
  const [run] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId)).limit(1);
  if (!run) throw new Error(`AI run not found: ${runId}`);

  const owner = claimOwnerFor(run);
  const now = new Date();
  if (!run.claimToken) {
    return { runId: run.id, state: 'dead_letter' };
  }
  const claimToken = run.claimToken;
  const deadlineAt = run.deadlineAt ?? new Date(now.getTime() + env.HMS_RUN_DEADLINE_MS);
  const fence: AiRunFence = {
    runId: run.id,
    claimOwner: owner,
    claimToken,
    deadlineAt,
  };
  const leaseAbort = new AbortController();
  const shutdownSignal = options.shutdownSignal ?? new AbortController().signal;
  const signal = buildRunAbortSignal({ fence, leaseAbort, shutdownSignal, now });

  const flipped = await markAiRunRunning(fence);
  if (!flipped) {
    return { runId: run.id, state: 'dead_letter' };
  }

  if (run.runKind === 'inbound_triage' && !isSupportedInboundTriagePromptVersion(run.promptVersion)) {
    const deployed = resolveDeployedTriagePromptVersion();
    await markAiRunDeadLetter({
      runId: run.id,
      claimOwner: owner,
      claimToken,
      expectedStates: ['running'],
      lastError: `unsupported prompt version: ${run.promptVersion} (deployed ${deployed})`,
    });
    return { runId: run.id, state: 'dead_letter' };
  }

  const runWithFence = { ...run, claimOwner: owner, claimToken, deadlineAt };

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  try {
    heartbeatTimer = setInterval(() => {
      void heartbeatAiRun(fence).then((ok) => {
        if (!ok) leaseAbort.abort();
      });
    }, AI_LEASE_HEARTBEAT_INTERVAL_MS);

    if (signal.aborted) throw new RunDeadlineError();

    if (run.runKind === 'inbound_triage') {
      const [trigger] = await db
        .select()
        .from(message)
        .where(eq(message.id, run.triggerMessageId))
        .limit(1);

      const threadMessages = await db
        .select({
          id: message.id,
          fromAddress: message.fromAddress,
          subject: message.subject,
          textBody: message.textBody,
          htmlBody: message.htmlBody,
          direction: message.direction,
          createdAt: message.createdAt,
          receivedAt: message.receivedAt,
          sentAt: message.sentAt,
        })
        .from(message)
        .where(and(eq(message.threadId, run.threadId), eq(message.transportId, run.transportId)))
        .orderBy(asc(message.createdAt), asc(message.id));

      const rows: TriageMessageRow[] = threadMessages.map((m) => ({
        id: m.id,
        from: m.fromAddress ?? '',
        subject: m.subject ?? undefined,
        body: m.textBody ?? m.htmlBody ?? '',
        direction: m.direction === 'outbound' ? 'outbound' : 'inbound',
        createdAt: m.createdAt,
        receivedAt: m.receivedAt ?? null,
        sentAt: m.sentAt ?? null,
      }));
      const messages = buildCausalTriageMessages(rows, run.triggerMessageId);

      const mastra = createMastraRuntime(process.env.MASTRA_STORAGE_PATH);
      const workflow = mastra.getWorkflow('mailTriage');
      const workflowRun = await workflow.createRun();
      const result = await workflowRun.start({
        inputData: {
          transportId: run.transportId,
          threadId: run.threadId,
          triggerMessageId: run.triggerMessageId,
          subject: trigger?.subject ?? undefined,
          from: trigger?.fromAddress ?? '',
          to: trigger?.toAddresses ?? [],
          body: trigger?.textBody ?? trigger?.htmlBody ?? '',
          messages,
          asOf: run.createdAt.toISOString(),
          modelId: run.modelId,
          promptVersion: run.promptVersion,
        },
        // Budget/lease fence for Mastra + future Playwright/S3/subprocess callers.
        abortSignal: signal,
      } as Parameters<typeof workflowRun.start>[0] & { abortSignal: AbortSignal });
      if (result.status !== 'success') {
        throw new Error(`mail triage workflow failed: ${result.status}`);
      }

      const output = validateTriageOutput(result.result?.output);

      await db.transaction(async (tx) => {
        const applyResult = await applyDurableTriageFromWorker({
          db: tx as unknown as typeof db,
          transportId: run.transportId,
          threadId: run.threadId,
          output,
          writeGateEnabled: env.AI_WRITE_GATE_ENABLED,
        });

        const [threadBeforeDraft] = await tx
          .select({ spamAt: mailThread.spamAt })
          .from(mailThread)
          .where(and(eq(mailThread.id, run.threadId), eq(mailThread.transportId, run.transportId)))
          .limit(1);

        let draftRunId: string | undefined;
        if (
          env.AI_DRAFTS_ENABLED &&
          MONEY_DRAFT_CATEGORIES.has(output.category) &&
          !threadBeforeDraft?.spamAt
        ) {
          const draftRun = await enqueueAiRun(
            {
              transportId: run.transportId,
              threadId: run.threadId,
              triggerMessageId: run.triggerMessageId,
              runKind: 'candidate_draft',
              idempotencyKey: `candidate-draft:${run.triggerMessageId}`,
              modelId: run.modelId,
              promptVersion: 'draft-v1',
              promptHash: run.promptHash ?? undefined,
              executorLane: run.executorLane ?? 'default',
            },
            tx as unknown as typeof db,
          );
          draftRunId = draftRun.id;
        }

        const marked = await markAiRunSucceeded(
          {
            runId,
            claimOwner: owner,
            claimToken,
            expectedStates: ['running'],
            mastraTraceId: result.result?.traceId,
            metrics: {
              ...(result.result?.metrics as Record<string, unknown>),
              durableWrite: env.AI_WRITE_GATE_ENABLED,
              draftRunId,
              applyMode: applyResult.applyMode,
            },
          },
          tx as unknown as typeof db,
        );
        if (!marked) {
          throw new Error(`failed to mark AI run succeeded with claim fencing: ${runId}`);
        }
      });

      return { runId, state: 'succeeded' };
    }

    if (run.runKind === 'candidate_draft') {
      const [trigger] = await db
        .select()
        .from(message)
        .where(eq(message.id, run.triggerMessageId))
        .limit(1);
      if (!trigger) throw new Error(`trigger message not found: ${run.triggerMessageId}`);

      const { deriveReplySubject, deriveReplyToAddress } = await import(
        './workflows/candidate-draft.js'
      );
      const replyTo = deriveReplyToAddress(trigger.fromAddress);
      if (!replyTo) {
        const marked = await markAiRunSucceeded({
          runId,
          claimOwner: owner,
          claimToken,
          expectedStates: ['running'],
          metrics: { skipped: true, reason: 'missing_reply_to_address' },
        });
        if (!marked) {
          return { runId, state: 'retry_wait' };
        }
        return { runId, state: 'succeeded' };
      }

      const generationId = run.generationId ?? `${run.id}-generation`;
      const [existingGeneration] = await db
        .select({ requestedByUserId: aiDraftGeneration.requestedByUserId })
        .from(aiDraftGeneration)
        .where(eq(aiDraftGeneration.id, generationId))
        .limit(1);
      const createdByUserId = existingGeneration?.requestedByUserId ?? 'user-navaai';
      const subject = deriveReplySubject(trigger.subject);
      const hmsMode = env.HMS_DRAFT_ENRICHMENT_MODE;

      // Off mode: existing skeleton workflow / evidence rules do not apply.
      if (hmsMode === 'off') {
        const mastra = createMastraRuntime(process.env.MASTRA_STORAGE_PATH);
        const workflow = mastra.getWorkflow('candidateDraft');
        const workflowRun = await workflow.createRun();
        const result = await workflowRun.start({
          inputData: {
            transportId: run.transportId,
            threadId: run.threadId,
            triggerMessageId: run.triggerMessageId,
            fromAddress: trigger.fromAddress,
            subject: trigger.subject ?? undefined,
            body: trigger.textBody ?? trigger.htmlBody ?? '',
          },
          abortSignal: signal,
        } as Parameters<typeof workflowRun.start>[0] & { abortSignal: AbortSignal });
        if (result.status !== 'success') {
          throw new Error(`candidate draft workflow failed: ${result.status}`);
        }

        const draft = await persistAiCandidateDraft({
          db,
          transportId: run.transportId,
          threadId: run.threadId,
          replyToMessageId: run.triggerMessageId,
          createdByUserId,
          generationId,
          model: run.modelId,
          promptVersion: run.promptVersion,
          contextMessageIds: [run.triggerMessageId],
          toAddresses: [replyTo],
          subject,
          textBody: result.result!.draftBody.textBody,
          htmlBody: result.result!.draftBody.htmlBody,
          outcome: 'candidate',
          persistDraft: true,
        });
        const marked = await markAiRunSucceeded({
          runId,
          claimOwner: owner,
          claimToken,
          expectedStates: ['running'],
          generationId: draft.generationId ?? generationId,
          metrics: {
            draftId: draft.id,
            generationId: draft.generationId ?? generationId,
            modelId: run.modelId,
            hmsMode: 'off',
            ...(result.result?.metrics as Record<string, unknown>),
          },
        });
        if (!marked) {
          return { runId, state: 'retry_wait' };
        }
        return { runId, state: 'succeeded' };
      }

      // HMS lane + shadow: strict terminal writer — never persistAiCandidateDraft.
      // Default lane never enters this branch (executorLane gate).
      if (run.executorLane === 'hms' && hmsMode === 'shadow') {
        const { runClaimSafeCandidateDraft } = await import(
          './candidate-draft-agent.js'
        );
        const {
          finishHmsShadowRun,
          failHmsShadowRun,
          resolveHmsShadowPreBrowser,
        } = await import('./hms-shadow.js');

        const loadThreadMessages = async () =>
          db
            .select({
              id: message.id,
              transportId: message.transportId,
              threadId: message.threadId,
              direction: message.direction,
              textBody: message.textBody,
              htmlBody: message.htmlBody,
              subject: message.subject,
              receivedAt: message.receivedAt,
              sentAt: message.sentAt,
            })
            .from(message)
            .where(
              and(
                eq(message.threadId, run.threadId),
                eq(message.transportId, run.transportId),
              ),
            );

        const mapMessages = (
          threadMessages: Awaited<ReturnType<typeof loadThreadMessages>>,
        ) =>
          threadMessages.map((m) => ({
            id: m.id,
            transportId: m.transportId,
            threadId: m.threadId,
            direction: (m.direction === 'outbound' ? 'outbound' : 'inbound') as
              | 'inbound'
              | 'outbound',
            textBody: m.textBody,
            htmlBody: m.htmlBody,
            subject: m.subject,
            receivedAt: m.receivedAt,
            sentAt: m.sentAt,
            attachmentIds: [] as string[],
          }));

        try {
          // Double freshness + exactly-one gate before browser context.
          // Pass 2 reloads latestDraftRevisionId (must not reuse pass-1 id).
          if (signal.aborted) throw new RunDeadlineError();
          const pre = await resolveHmsShadowPreBrowser(
            {
              transportId: run.transportId,
              threadId: run.threadId,
              triggerMessageId: run.triggerMessageId,
              loadLatestDraftRevisionId: () =>
                loadLatestThreadAffectingDraftRevisionId(db, {
                  transportId: run.transportId,
                  threadId: run.threadId,
                }),
              loadMessages: async () => mapMessages(await loadThreadMessages()),
            },
            { signal },
          );

          if (pre.kind === 'stale_thread') {
            const finished = await finishHmsShadowRun(fence, {
              outcome: 'stale_thread',
              toolCalls: 0,
              toolBudgetUsed: 0,
              claimCount: 0,
            });
            return {
              runId,
              state: finished ? 'succeeded' : 'retry_wait',
            };
          }

          if (pre.kind === 'insufficient_evidence') {
            const finished = await finishHmsShadowRun(fence, {
              outcome: 'insufficient_evidence',
              toolCalls: 0,
              toolBudgetUsed: 0,
              claimCount: 0,
            });
            return {
              runId,
              state: finished ? 'succeeded' : 'retry_wait',
            };
          }

          if (signal.aborted) throw new RunDeadlineError();

          const sessionFactory =
            options.candidateSessionFactory ??
            createLiveHmsCandidateSessionFactory();
          // Production HMS lane refuses missing live factory (never mock).
          if (!sessionFactory) {
            throw new Error('HMS_LIVE_SESSION_FACTORY_REQUIRED');
          }

          // Exactly one exact candidate reaches the browser.
          const session = await sessionFactory({
            transportId: run.transportId,
            threadId: run.threadId,
            lookupCandidates: [pre.exact],
            signal,
            runId,
          });

          const claimSafe = await runClaimSafeCandidateDraft({
            session,
            normalizedThreadText: pre.context.normalizedText,
            signal,
            probeCandidateIds: [pre.exact.id],
            probeAttachmentIds: [],
            planModel: options.candidatePlanModel,
          });

          // Discard draft bodies / evidence — counters only.
          const finished = await finishHmsShadowRun(fence, {
            outcome: claimSafe.outcome,
            toolCalls: Number(claimSafe.metrics.toolCalls ?? 0),
            toolBudgetUsed: Number(claimSafe.metrics.toolBudgetUsed ?? 0),
            claimCount: Number(claimSafe.metrics.claimCount ?? 0),
          });
          return {
            runId,
            state: finished ? 'succeeded' : 'retry_wait',
          };
        } catch (error) {
          const state = await failHmsShadowRun(fence, error, {
            attempts: run.attempts,
          });
          return { runId, state };
        }
      }

      // Non-HMS claim-safe path (fixtures / default lane enrichment tests).
      // HMS shadow never reaches here. enabled rejected at env parse.
      const { runClaimSafeCandidateDraft, createMockCandidateSession } = await import(
        './candidate-draft-agent.js'
      );
      const { buildThreadContext } = await import('./thread-context.js');
      const threadMessages = await db
        .select({
          id: message.id,
          transportId: message.transportId,
          threadId: message.threadId,
          direction: message.direction,
          textBody: message.textBody,
          htmlBody: message.htmlBody,
          subject: message.subject,
          receivedAt: message.receivedAt,
          sentAt: message.sentAt,
        })
        .from(message)
        .where(and(eq(message.threadId, run.threadId), eq(message.transportId, run.transportId)));

      const latestDraftRevisionId = await loadLatestThreadAffectingDraftRevisionId(db, {
        transportId: run.transportId,
        threadId: run.threadId,
      });
      const context = await buildThreadContext({
        transportId: run.transportId,
        threadId: run.threadId,
        triggerMessageId: run.triggerMessageId,
        messages: threadMessages.map((m) => ({
          id: m.id,
          transportId: m.transportId,
          threadId: m.threadId,
          direction: (m.direction === 'outbound' ? 'outbound' : 'inbound') as
            | 'inbound'
            | 'outbound',
          textBody: m.textBody,
          htmlBody: m.htmlBody,
          subject: m.subject,
          receivedAt: m.receivedAt,
          sentAt: m.sentAt,
          attachmentIds: [],
        })),
        latestDraftRevisionId,
      });

      const session = options.candidateSessionFactory
        ? await options.candidateSessionFactory({
            transportId: run.transportId,
            threadId: run.threadId,
            lookupCandidates: context.lookupCandidates,
            signal,
            runId,
          })
        : createMockCandidateSession({
            lookupCandidates: new Map(
              context.lookupCandidates.map((c) => [c.id, c]),
            ),
            authorizedAttachmentIds: new Set(context.authorizedAttachmentIds),
          });

      const claimSafe = await runClaimSafeCandidateDraft({
        session,
        normalizedThreadText: context.normalizedText,
        signal,
        planModel: options.candidatePlanModel,
      });

      // HMS_DRAFT_ENRICHMENT_MODE=enabled is rejected at env parse; non-HMS
      // shadow-like paths still use persistDraft=false lifecycle fencing.
      const persistDraft = false;
      const { renderClarificationQuestions, textToSafeHtml } = await import(
        './draft-evidence.js'
      );
      const clarificationText =
        claimSafe.outcome === 'candidate'
          ? null
          : renderClarificationQuestions(claimSafe.plan.questionCodes).join('\n\n') ||
            'Insufficient evidence for an automated candidate.';
      const textBody =
        claimSafe.outcome === 'candidate' ? claimSafe.textBody : clarificationText!;
      const htmlBody =
        claimSafe.outcome === 'candidate'
          ? claimSafe.htmlBody
          : textToSafeHtml(textBody);

      let claimFenceLost = false;
      try {
        await db.transaction(async (tx) => {
          const draft = await persistAiCandidateDraft({
            db: tx as unknown as typeof db,
            transportId: run.transportId,
            threadId: run.threadId,
            replyToMessageId: run.triggerMessageId,
            createdByUserId,
            generationId,
            model: run.modelId,
            promptVersion: run.promptVersion,
            contextMessageIds: context.includedMessageIds,
            toAddresses: [replyTo],
            subject,
            textBody,
            htmlBody,
            outcome: claimSafe.outcome,
            evidence: claimSafe.evidence.map((e) => e.evidence),
            threadStateVersion: context.threadStateVersion,
            latestDraftRevisionId,
            persistDraft,
          });

          const marked = await markAiRunSucceeded(
            {
              runId,
              claimOwner: owner,
              claimToken,
              expectedStates: ['running'],
              generationId: draft.generationId ?? generationId,
              metrics: {
                draftId: draft.id,
                generationId: draft.generationId ?? generationId,
                modelId: run.modelId,
                hmsMode,
                outcome: claimSafe.outcome,
                persistDraft,
                threadStateVersion: context.threadStateVersion,
                ...claimSafe.metrics,
              },
            },
            tx as unknown as typeof db,
          );
          if (!marked) {
            claimFenceLost = true;
            throw new Error(`failed to mark AI run succeeded with claim fencing: ${runId}`);
          }
        });
      } catch (error) {
        if (claimFenceLost) return { runId, state: 'retry_wait' };
        throw error;
      }
      return { runId, state: 'succeeded' };
    }

    if (run.runKind === 'feedback_extraction') {
      const [draft] = await db
        .select()
        .from(mailDraft)
        .where(eq(mailDraft.sentMessageId, run.triggerMessageId))
        .limit(1);
      if (!draft) throw new Error('sent draft not found for feedback extraction');
      const revisions = await db
        .select()
        .from(mailDraftRevision)
        .where(eq(mailDraftRevision.draftId, draft.id));
      const aiGenerated = revisions.find((row) => row.kind === 'ai_generated');
      const sent = revisions.find((row) => row.kind === 'sent');
      if (!aiGenerated || !sent) {
        throw new Error('missing ai_generated or sent revision for feedback extraction');
      }
      const feedback = extractDraftFeedbackLabels({
        aiGenerated,
        sent,
      });
      const marked = await markAiRunSucceeded({
        runId,
        claimOwner: owner,
        claimToken,
        expectedStates: ['running'],
        metrics: {
          labels: feedback.labels,
          ...feedback.metrics,
        },
      });
      if (!marked) {
        return { runId, state: 'retry_wait' };
      }
      return { runId, state: 'succeeded' };
    }

    throw new Error(`unsupported AI run kind: ${run.runKind}`);
  } catch (error) {
    return failAiRun(runWithFence, error, toAiRunFence(runWithFence) ?? fence);
  } finally {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  }
}

async function applyDurableTriageFromWorker(input: {
  db: ReturnType<typeof getDb>;
  transportId: string;
  threadId: string;
  output: ReturnType<typeof validateTriageOutput>;
  writeGateEnabled: boolean;
}) {
  const { applyDurableTriageResult } = await import('./triage.js');
  return applyDurableTriageResult(input);
}

function scopeFromCli(args: AiWorkerCliArgs): AiRunScopeFilter {
  return {
    transportId: args.transportId,
    runKind: args.runKind,
    promptVersion: args.promptVersion,
    idempotencyPrefix: args.drainPrefix,
  };
}

function maybeInitHmsRuntime(lane: AiExecutorLane): void {
  if (lane !== 'hms') return;
  // Shadow must fail closed on secret/chromium/role-proof before accepting jobs.
  assertHmsLaneRuntimeReady();
}

export type RunAiWorkerOnceOptions = { shutdownSignal?: AbortSignal } & AiRunScopeFilter;

export async function runAiWorkerOnce(options: RunAiWorkerOnceOptions = {}): Promise<boolean> {
  const env = parseEnv(process.env as Record<string, string | undefined>);
  const lane = env.AI_WORKER_LANE;
  // hms + off: worker present for ops but claims none.
  if (lane === 'hms' && env.HMS_DRAFT_ENRICHMENT_MODE === 'off') {
    return false;
  }
  maybeInitHmsRuntime(lane);
  // Eager singleton browser for HMS shadow (reuse across runs).
  if (lane === 'hms' && env.HMS_DRAFT_ENRICHMENT_MODE === 'shadow') {
    await getOrCreateProductionHmsRuntime();
  }
  const owner = aiWorkerOwnerId(lane);
  const { shutdownSignal, ...scope } = options;
  const claimed = await claimNextAiRun({ ownerId: owner, lane, ...scope });
  if (!claimed) return false;
  await executeAiRun(claimed.id, {
    shutdownSignal,
    // HMS lane: live factory only — never createMockCandidateSession.
    ...(lane === 'hms'
      ? { candidateSessionFactory: createLiveHmsCandidateSessionFactory() }
      : {}),
  });
  return true;
}

export async function runAiWorkerDrain(
  input: RunAiWorkerDrainInput,
): Promise<RunAiWorkerDrainResult> {
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  const scope: AiRunScopeFilter = {
    transportId: input.transportId,
    runKind: input.runKind,
    promptVersion: input.promptVersion,
    idempotencyPrefix: input.idempotencyPrefix,
  };
  const deadline = Date.now() + input.timeoutMs;
  let processed = 0;

  while (true) {
    const remaining = await countNonterminalAiRuns(scope);
    if (remaining === 0) {
      return { ok: true, reason: 'drained', remainingNonterminal: 0, processed };
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        reason: 'timeout',
        remainingNonterminal: remaining,
        processed,
      };
    }

    const worked = await runAiWorkerOnce({ ...scope });
    if (worked) {
      processed += 1;
      continue;
    }
    // No due claim — wait for retry-wait nextRunAt or timeout.
    const sleepMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    if (sleepMs <= 0) {
      const still = await countNonterminalAiRuns(scope);
      return {
        ok: still === 0,
        reason: still === 0 ? 'drained' : 'timeout',
        remainingNonterminal: still,
        processed,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}

async function closeAiWorkerResources(): Promise<void> {
  let closeError: unknown;
  try {
    await closeProductionHmsRuntimeForTests();
  } catch (error) {
    closeError = error;
  }
  try {
    await closeDb();
  } catch (error) {
    closeError ??= error;
  }
  if (closeError) throw closeError;
}

export async function runAiWorkerLoop(
  pollIntervalMs = 5_000,
  scope: AiRunScopeFilter = {},
): Promise<void> {
  let stopping = false;
  const shutdown = new AbortController();
  const stop = () => {
    stopping = true;
    shutdown.abort();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  try {
    while (!stopping) {
      const worked = await runAiWorkerOnce({ ...scope, shutdownSignal: shutdown.signal });
      if (!worked) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await closeAiWorkerResources();
  }
}

async function main() {
  const env = parseEnv(process.env as Record<string, string | undefined>);
  maybeInitHmsRuntime(env.AI_WORKER_LANE);
  const args = parseAiWorkerCliArgs(process.argv.slice(2));
  const scoped =
    args.drainPrefix !== undefined ||
    args.transportId !== undefined ||
    args.promptVersion !== undefined ||
    args.timeoutMs !== undefined;

  if (scoped) {
    if (args.timeoutMs === undefined) {
      throw new Error('scoped drain requires --timeout-ms');
    }
    let result: RunAiWorkerDrainResult;
    try {
      result = await runAiWorkerDrain({
        ...scopeFromCli(args),
        timeoutMs: args.timeoutMs,
      });
    } finally {
      await closeAiWorkerResources();
    }
    if (!result.ok) {
      console.error(
        JSON.stringify({
          ok: false,
          reason: result.reason,
          remainingNonterminal: result.remainingNonterminal,
          processed: result.processed,
        }),
      );
      process.exit(1);
    }
    console.log(
      JSON.stringify({
        ok: true,
        reason: result.reason,
        remainingNonterminal: 0,
        processed: result.processed,
      }),
    );
    return;
  }

  // Proof isolation: ops-hms-shadow start sets AI_WORKER_IDEMPOTENCY_PREFIX.
  const idempotencyPrefix = process.env.AI_WORKER_IDEMPOTENCY_PREFIX?.trim();
  await runAiWorkerLoop(
    5_000,
    idempotencyPrefix ? { idempotencyPrefix } : {},
  );
}

if (isCliEntry(import.meta.url, 'ai-worker')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
