/**
 * Durable quote-PDF job on the AI run ledger (readRequest payload, readResult
 * artifact). Keyed by work item + revision. Queryable after disconnect.
 * PDF only — no send/attach. Unknown property refuses; no hotel default.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import { workItem } from '../db/schema/work.js';
import { hmsReadTargetForProperty } from '../hms/hms-read-target.js';
import {
  enqueueAiRun,
  markAiRunSucceeded,
  NOT_APPLICABLE_MODEL_ID,
  type AiRunFence,
  type AiWorkflowRun,
} from './run-ledger.js';

export const QUOTE_PDF_PROMPT_VERSION = 'quote-pdf/1';
/** Existing default-lane kind; promptVersion discriminates (same as hms-job/1). */
export const QUOTE_PDF_RUN_KIND = 'feedback_extraction' as const;

export const quotePdfRequestSchema = z
  .object({
    kind: z.literal('quote_pdf'),
    workItemId: z.string().uuid(),
    revisionId: z.string().min(1),
    propertyCode: z.string().min(1),
    transportId: z.string().min(1).optional(),
    userId: z.string().min(1).optional(),
    signerName: z.string().optional(),
    signerEmail: z.string().optional(),
    proposal: z.unknown().optional(),
  })
  .strict();

export const quotePdfResultSchema = z
  .object({
    kind: z.literal('quote_pdf'),
    revisionId: z.string().min(1),
    pdfHash: z.string().min(1),
    fileName: z.string().min(1),
    totalMinor: z.number().int(),
    pdfBase64: z.string().min(1),
  })
  .strict();

export type QuotePdfRequest = z.infer<typeof quotePdfRequestSchema>;
export type QuotePdfResult = z.infer<typeof quotePdfResultSchema>;

export function quotePdfIdempotencyKey(workItemId: string, revisionId: string): string {
  return `quote-pdf:${workItemId}:${revisionId}`;
}

/** Stay revisions (sorted) plus a header digest so combined quotes and contact edits do not collide. */
export function quotePdfDocumentKey(
  revisionRef: string,
  additionalStays: Array<{ revisionRef: string }> = [],
  header?: Record<string, unknown>,
): string {
  const revisions = [revisionRef, ...additionalStays.map((stay) => stay.revisionRef)].sort().join('\u001f');
  if (!header) return revisions;
  const digest = createHash('sha256').update(JSON.stringify(header)).digest('hex').slice(0, 16);
  return `${revisions}:${digest}`;
}

export function isQuotePdfRun(run: { promptVersion?: string | null }): boolean {
  return run.promptVersion === QUOTE_PDF_PROMPT_VERSION;
}

export function quotePdfResultOf(run: { readResult?: unknown } | null | undefined): QuotePdfResult | null {
  const parsed = quotePdfResultSchema.safeParse(run?.readResult);
  return parsed.success ? parsed.data : null;
}

function requireProperty(propertyCode: string): string {
  return hmsReadTargetForProperty(propertyCode).propertyCode;
}

export async function enqueueQuotePdfJob(input: {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  workItemId: string;
  revisionId: string;
  propertyCode: string;
  userId?: string;
  signerName?: string;
  signerEmail?: string;
  proposal?: unknown;
  db?: DB;
}): Promise<{ run: AiWorkflowRun; created: boolean }> {
  const db = input.db ?? getDb();
  const propertyCode = requireProperty(input.propertyCode);
  const [item] = await db
    .select({ id: workItem.id })
    .from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
    .limit(1);
  if (!item) throw new Error('quote_pdf_work_item_missing');
  const request: QuotePdfRequest = {
    kind: 'quote_pdf',
    workItemId: input.workItemId,
    revisionId: input.revisionId,
    propertyCode,
    transportId: input.transportId,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.signerName ? { signerName: input.signerName } : {}),
    ...(input.signerEmail ? { signerEmail: input.signerEmail } : {}),
    ...(input.proposal !== undefined ? { proposal: input.proposal } : {}),
  };
  const idempotencyKey = quotePdfIdempotencyKey(input.workItemId, input.revisionId);
  const run = await enqueueAiRun(
    {
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: input.triggerMessageId,
      runKind: QUOTE_PDF_RUN_KIND,
      idempotencyKey,
      modelId: NOT_APPLICABLE_MODEL_ID,
      promptVersion: QUOTE_PDF_PROMPT_VERSION,
      workItemId: input.workItemId,
      readRequest: request,
      metrics: { quotePdf: true, propertyCode },
    },
    db,
  );
  return { run, created: run.state === 'queued' && run.finishedAt == null && !quotePdfResultOf(run) };
}

export async function readQuotePdfJob(input: {
  transportId: string;
  workItemId: string;
  revisionId: string;
  db?: DB;
}): Promise<{ runId: string; state: AiWorkflowRun['state']; result: QuotePdfResult | null } | null> {
  const db = input.db ?? getDb();
  const [run] = await db
    .select()
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, input.transportId),
        eq(aiWorkflowRun.workItemId, input.workItemId),
        eq(aiWorkflowRun.promptVersion, QUOTE_PDF_PROMPT_VERSION),
        eq(aiWorkflowRun.idempotencyKey, quotePdfIdempotencyKey(input.workItemId, input.revisionId)),
      ),
    )
    .limit(1);
  if (!run) return null;
  return { runId: run.id, state: run.state, result: quotePdfResultOf(run) };
}

/** Persist bytes even if another worker currently holds the claim. First writer wins. */
export async function persistQuotePdfResult(
  runId: string,
  artifact: QuotePdfResult,
  db: DB = getDb(),
): Promise<QuotePdfResult> {
  const now = new Date();
  const [row] = await db
    .update(aiWorkflowRun)
    .set({
      state: 'succeeded',
      readResult: artifact,
      finishedAt: now,
      updatedAt: now,
      claimOwner: null,
      claimToken: null,
    })
    .where(and(eq(aiWorkflowRun.id, runId), sql`${aiWorkflowRun.readResult} IS NULL`))
    .returning();
  if (row) return artifact;
  const [existing] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId)).limit(1);
  return quotePdfResultOf(existing) ?? artifact;
}

async function fenceQueuedQuotePdf(
  run: AiWorkflowRun,
  db: DB,
): Promise<{ run: AiWorkflowRun; fence: AiRunFence } | 'ready' | 'busy'> {
  const [fresh] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id)).limit(1);
  if (!fresh) return 'busy';
  if (fresh.state === 'succeeded' && quotePdfResultOf(fresh)) return 'ready';
  const owner = `quote-pdf:${randomUUID()}`;
  const token = randomUUID();
  const deadlineAt = new Date(Date.now() + 120_000);
  const now = new Date();
  const [claimed] = await db
    .update(aiWorkflowRun)
    .set({
      state: 'running',
      claimOwner: owner,
      claimToken: token,
      claimedAt: now,
      startedAt: now,
      heartbeatAt: now,
      deadlineAt,
      updatedAt: now,
    })
    .where(and(eq(aiWorkflowRun.id, run.id), inArray(aiWorkflowRun.state, ['queued', 'retry_wait'])))
    .returning();
  if (claimed) {
    return { run: claimed, fence: { runId: claimed.id, claimOwner: owner, claimToken: token, deadlineAt } };
  }
  const [again] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id)).limit(1);
  return again?.state === 'succeeded' && quotePdfResultOf(again) ? 'ready' : 'busy';
}

export async function executeQuotePdfJob(input: {
  run: AiWorkflowRun;
  fence?: AiRunFence;
  generate?: (request: QuotePdfRequest) => Promise<QuotePdfResult>;
  db?: DB;
}): Promise<'succeeded' | 'retry_wait' | 'dead_letter'> {
  const db = input.db ?? getDb();
  const [fresh] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, input.run.id)).limit(1);
  const run = fresh ?? input.run;
  if (!isQuotePdfRun(run)) return 'dead_letter';
  if (run.state === 'succeeded' && quotePdfResultOf(run)) return 'succeeded';
  const parsed = quotePdfRequestSchema.safeParse(run.readRequest);
  if (!parsed.success) return 'dead_letter';
  requireProperty(parsed.data.propertyCode);

  let fence = input.fence;
  if (!fence) {
    const acquired = await fenceQueuedQuotePdf(run, db);
    if (acquired === 'ready') return 'succeeded';
    if (acquired === 'busy') return 'retry_wait';
    fence = acquired.fence;
  }
  if (!input.generate) return quotePdfResultOf(run) ? 'succeeded' : 'retry_wait';
  const artifact = await input.generate(parsed.data);
  const marked = await markAiRunSucceeded(
    {
      runId: fence.runId,
      claimOwner: fence.claimOwner,
      claimToken: fence.claimToken,
      expectedStates: ['running', 'claimed'],
      readResult: artifact,
      metrics: { quotePdf: true, propertyCode: parsed.data.propertyCode },
    },
    db,
  );
  return marked ? 'succeeded' : 'retry_wait';
}
