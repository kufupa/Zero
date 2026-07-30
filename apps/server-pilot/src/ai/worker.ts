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
import { parseEnv, type AiExecutorLane } from '../env.js';
import { createMastraRuntime } from './mastra.js';
import { persistAiCandidateDraft } from './drafts.js';
import { extractDraftFeedbackLabels } from './feedback.js';
import {
  claimNextAiRun,
  CLEANUP_RESERVE_MS,
  enqueueAiRun,
  heartbeatAiRun,
  markAiRunDeadLetter,
  markAiRunRetry,
  markAiRunRunning,
  markAiRunSucceeded,
  remainingRunBudgetMs,
  RunDeadlineError,
  shouldRetryAiFailure,
  toAiRunFence,
  type AiFailureClass,
  type AiRunFence,
} from './run-ledger.js';
import { validateTriageOutput } from './triage.js';

function resolveWorkerLane(): AiExecutorLane {
  return parseEnv(process.env as Record<string, string | undefined>).AI_WORKER_LANE;
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

export type CandidateSessionFactory = (input: {
  transportId: string;
  threadId: string;
  lookupCandidates: import('./thread-context.js').LookupCandidate[];
  authorizedAttachmentIds: string[];
  signal: AbortSignal;
}) => import('./candidate-draft-agent.js').CandidateToolSession;

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
        })
        .from(message)
        .where(and(eq(message.threadId, run.threadId), eq(message.transportId, run.transportId)))
        .orderBy(asc(message.receivedAt));

      const messages = threadMessages.map((m) => ({
        id: m.id,
        from: m.fromAddress ?? '',
        subject: m.subject ?? undefined,
        body: m.textBody ?? m.htmlBody ?? '',
        direction: m.direction ?? undefined,
      }));

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

      // shadow | enabled: claim-safe path (mocked tools injectable via options).
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
        latestDraftRevisionId: null,
      });

      const session =
        options.candidateSessionFactory?.({
          transportId: run.transportId,
          threadId: run.threadId,
          lookupCandidates: context.lookupCandidates,
          authorizedAttachmentIds: context.authorizedAttachmentIds,
          signal,
        }) ??
        createMockCandidateSession({
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

      const persistDraft =
        hmsMode === 'enabled' && claimSafe.outcome === 'candidate';
      const textBody =
        claimSafe.outcome === 'candidate'
          ? claimSafe.textBody
          : claimSafe.plan.questionCodes.join('\n') ||
            'Insufficient evidence for an automated candidate.';
      const htmlBody =
        claimSafe.outcome === 'candidate'
          ? claimSafe.htmlBody
          : `<p>${textBody.replace(/</g, '&lt;')}</p>`;

      const draft = await persistAiCandidateDraft({
        db,
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
        persistDraft,
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
          hmsMode,
          outcome: claimSafe.outcome,
          persistDraft,
          threadStateVersion: context.threadStateVersion,
          ...claimSafe.metrics,
        },
      });
      if (!marked) {
        return { runId, state: 'retry_wait' };
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

function maybeInitHmsRuntime(lane: AiExecutorLane): void {
  if (lane === 'hms') {
    // HMS runtime init reserved for later tasks; only HMS lane may enter this path.
  }
}

export async function runAiWorkerOnce(
  options: { shutdownSignal?: AbortSignal } = {},
): Promise<boolean> {
  const env = parseEnv(process.env as Record<string, string | undefined>);
  const lane = env.AI_WORKER_LANE;
  maybeInitHmsRuntime(lane);
  const owner = `${lane}-ai-worker-${process.pid}`;
  const claimed = await claimNextAiRun({ ownerId: owner, lane });
  if (!claimed) return false;
  await executeAiRun(claimed.id, options);
  return true;
}

export async function runAiWorkerLoop(pollIntervalMs = 5_000): Promise<void> {
  let stopping = false;
  const shutdown = new AbortController();
  const stop = () => {
    stopping = true;
    shutdown.abort();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (!stopping) {
    const worked = await runAiWorkerOnce({ shutdownSignal: shutdown.signal });
    if (!worked) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  await closeDb();
}

async function main() {
  parseEnv(process.env as Record<string, string | undefined>);
  await runAiWorkerLoop();
}

if (isCliEntry(import.meta.url, 'ai-worker')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
