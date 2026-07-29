import { isCliEntry } from '../lib/is-cli-entry.js';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { closeDb, getDb } from '../db/client.js';
import {
  aiWorkflowRun,
  aiDraftGeneration,
  mailDraft,
  mailDraftRevision,
  mailThread,
  message,
} from '../db/schema/mail.js';
import { parseEnv } from '../env.js';
import { createMastraRuntime } from './mastra.js';
import { persistAiCandidateDraft } from './drafts.js';
import { extractDraftFeedbackLabels } from './feedback.js';
import {
  claimNextAiRun,
  enqueueAiRun,
  markAiRunDeadLetter,
  markAiRunRetry,
  markAiRunSucceeded,
} from './run-ledger.js';
import { validateTriageOutput } from './triage.js';

export const AI_WORKER_OWNER = `ai-worker-${process.pid}`;

const MONEY_DRAFT_CATEGORIES = new Set(['new-bookings', 'groups-events', 'at-risk']);

export interface ExecuteAiRunResult {
  runId: string;
  state: 'succeeded' | 'retry_wait' | 'dead_letter';
}

function claimOwnerFor(run: typeof aiWorkflowRun.$inferSelect): string {
  return run.claimOwner ?? AI_WORKER_OWNER;
}

async function failAiRun(
  run: typeof aiWorkflowRun.$inferSelect,
  error: unknown,
): Promise<ExecuteAiRunResult> {
  const message = error instanceof Error ? error.message : String(error);
  const attempts = run.attempts + 1;
  const owner = claimOwnerFor(run);
  if (attempts >= 3) {
    await markAiRunDeadLetter({
      runId: run.id,
      claimOwner: owner,
      expectedStates: ['running'],
      lastError: message,
    });
    return { runId: run.id, state: 'dead_letter' };
  }
  await markAiRunRetry({
    runId: run.id,
    claimOwner: owner,
    expectedStates: ['running'],
    attempts,
    nextRunAt: new Date(Date.now() + attempts * 60_000),
    lastError: message,
  });
  return { runId: run.id, state: 'retry_wait' };
}

export async function executeAiRun(runId: string): Promise<ExecuteAiRunResult> {
  const db = getDb();
  const [run] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId)).limit(1);
  if (!run) throw new Error(`AI run not found: ${runId}`);

  const owner = claimOwnerFor(run);

  await db
    .update(aiWorkflowRun)
    .set({
      state: 'running',
      claimOwner: owner,
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(aiWorkflowRun.id, runId),
        or(
          inArray(aiWorkflowRun.state, ['queued', 'retry_wait']),
          and(
            eq(aiWorkflowRun.claimOwner, owner),
            inArray(aiWorkflowRun.state, ['claimed', 'running']),
          ),
        ),
      ),
    );

  try {
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
      });
      if (result.status !== 'success') {
        throw new Error(`mail triage workflow failed: ${result.status}`);
      }

      const env = parseEnv(process.env as Record<string, string | undefined>);
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
            },
            tx as unknown as typeof db,
          );
          draftRunId = draftRun.id;
        }

        const marked = await markAiRunSucceeded(
          {
            runId,
            claimOwner: owner,
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
          expectedStates: ['running'],
          metrics: { skipped: true, reason: 'missing_reply_to_address' },
        });
        if (!marked) {
          return { runId, state: 'retry_wait' };
        }
        return { runId, state: 'succeeded' };
      }

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
      });
      if (result.status !== 'success') {
        throw new Error(`candidate draft workflow failed: ${result.status}`);
      }

      const generationId = run.generationId ?? `${run.id}-generation`;
      const [existingGeneration] = await db
        .select({ requestedByUserId: aiDraftGeneration.requestedByUserId })
        .from(aiDraftGeneration)
        .where(eq(aiDraftGeneration.id, generationId))
        .limit(1);
      const createdByUserId = existingGeneration?.requestedByUserId ?? 'user-navaai';
      const subject = deriveReplySubject(trigger.subject);
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
      });
      const marked = await markAiRunSucceeded({
        runId,
        claimOwner: owner,
        expectedStates: ['running'],
        generationId: draft.generationId ?? generationId,
        metrics: {
          draftId: draft.id,
          generationId: draft.generationId ?? generationId,
          modelId: run.modelId,
          ...(result.result?.metrics as Record<string, unknown>),
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
    return failAiRun(run, error);
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

export async function runAiWorkerOnce(): Promise<boolean> {
  const claimed = await claimNextAiRun({ ownerId: AI_WORKER_OWNER });
  if (!claimed) return false;
  await executeAiRun(claimed.id);
  return true;
}

export async function runAiWorkerLoop(pollIntervalMs = 5_000): Promise<void> {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (!stopping) {
    const worked = await runAiWorkerOnce();
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
