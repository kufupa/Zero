import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { closeDb, getDb } from '../db/client.js';
import { aiWorkflowRun, message } from '../db/schema/mail.js';
import { parseEnv } from '../env.js';
import { createMastraRuntime } from './mastra.js';
import { persistAiCandidateDraft } from './drafts.js';
import { extractDraftFeedbackLabels } from './feedback.js';
import {
  claimNextAiRun,
  markAiRunDeadLetter,
  markAiRunRetry,
  markAiRunSucceeded,
} from './run-ledger.js';
import { mailDraft, mailDraftRevision } from '../db/schema/mail.js';

export const AI_WORKER_OWNER = `ai-worker-${process.pid}`;

export interface ExecuteAiRunResult {
  runId: string;
  state: 'succeeded' | 'retry_wait' | 'dead_letter';
}

export async function executeAiRun(runId: string): Promise<ExecuteAiRunResult> {
  const db = getDb();
  const [run] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId)).limit(1);
  if (!run) throw new Error(`AI run not found: ${runId}`);

  await db
    .update(aiWorkflowRun)
    .set({ state: 'running', startedAt: new Date(), updatedAt: new Date() })
    .where(eq(aiWorkflowRun.id, runId));

  try {
    if (run.runKind === 'inbound_triage') {
      const [trigger] = await db
        .select()
        .from(message)
        .where(eq(message.id, run.triggerMessageId))
        .limit(1);
      const mastra = createMastraRuntime(process.env.MASTRA_STORAGE_PATH);
      const workflow = mastra.getWorkflow('mailTriage');
      const workflowRun = await workflow.createRun();
      const result = await workflowRun.start({
        inputData: {
          transportId: run.transportId,
          threadId: run.threadId,
          triggerMessageId: run.triggerMessageId,
          subject: trigger?.subject ?? undefined,
          body: trigger?.textBody ?? trigger?.htmlBody ?? '',
        },
      });
      if (result.status !== 'success') {
        throw new Error(`mail triage workflow failed: ${result.status}`);
      }
      await markAiRunSucceeded({
        runId,
        mastraTraceId: result.result?.traceId,
        metrics: result.result?.metrics as Record<string, unknown>,
      });
      return { runId, state: 'succeeded' };
    }

    if (run.runKind === 'candidate_draft') {
      const generationId = run.generationId ?? `${run.id}-generation`;
      const draft = await persistAiCandidateDraft({
        db,
        transportId: run.transportId,
        threadId: run.threadId,
        replyToMessageId: run.triggerMessageId,
        createdByUserId: 'ai-worker',
        generationId,
        model: run.modelId,
        promptVersion: run.promptVersion,
        contextMessageIds: [run.triggerMessageId],
        toAddresses: ['guest@example.com'],
        subject: 'Re: Your inquiry',
        textBody: 'Thank you for contacting us.',
        htmlBody: '<p>Thank you for contacting us.</p>',
      });
      await markAiRunSucceeded({
        runId,
        generationId: draft.generationId ?? generationId,
        metrics: { draftId: draft.id },
      });
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
      await markAiRunSucceeded({
        runId,
        metrics: {
          labels: feedback.labels,
          ...feedback.metrics,
        },
      });
      return { runId, state: 'succeeded' };
    }

    throw new Error(`unsupported AI run kind: ${run.runKind}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = run.attempts + 1;
    if (attempts >= 3) {
      await markAiRunDeadLetter({ runId, lastError: message });
      return { runId, state: 'dead_letter' };
    }
    await markAiRunRetry({
      runId,
      attempts,
      nextRunAt: new Date(Date.now() + attempts * 60_000),
      lastError: message,
    });
    return { runId, state: 'retry_wait' };
  }
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
