import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import { CENTURION_HMS_READ_TARGET, type HmsReadTarget } from '../hms/hms-read-target.js';
import { acquisitionWithin, isPropertyReadLockDeadline, PANE_PROPERTY_LOCK_WAIT_MS } from '../hms/property-read-lock.js';
import { assertHmsUnchangedBeforeSave, consumeHmsWriteApproval, endHmsWriteRun, hmsStateDigest,
  HmsApprovalError, recordHmsWriteEvidence, type HmsPreSaveOutcome } from './hms-approval.js';
import { projectCloudStayFind, runCloudStayFind } from './hms-cloud-saved-stay-find.js';
import { cloudAmendPreimage } from './pane-cloud-amend.js';
import { cloudAmendDispatchCallbacks, cloudAmendDispatchFormSchema, requireCloudAmendEvidence } from './pane-cloud-amend-dispatch.js';
import { resolveHmsLabtestDispatch, type HmsLabtestWriteHandle } from './hms-labtest-dispatch.js';
import { cloudAmendWriteReady, HMS_LABTEST_AMEND_CLEANUP_RESERVE_MS, HMS_LABTEST_AMEND_DISPATCH_RESERVE_MS,
  HMS_LABTEST_AMEND_PROMPT_VERSION, HMS_LABTEST_AMEND_RUN_DEADLINE_MS, labtestAmendWorkerEnabled } from './pane-cloud-amend-readiness.js';
import { paneStayPropertyLock } from './pane-stay-save.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { heartbeatAiRun, HMS_WRITE_RUN_KIND, markAiRunRunning, mergeTerminalRunMetrics, type AiFailureClass, type AiRunFence } from './run-ledger.js';

type Result = { status: 'ended'; failureClass: AiFailureClass; reason: string } | { status: 'lease_lost' } |
  { status: 'succeeded'; action: 'amend'; outcome: 'amended'; evidence: string[] };
type NativeResult = { outcome: string; issue?: string; dispatchCallbacksDrained?: boolean;
  writerSessionClosed?: boolean; retainedPriceMatched?: boolean; readback?: unknown };

const readbackSchema = z.object({ confirmation: z.string(), arrival: z.string(), departure: z.string(),
  adults: z.number().int(), children: z.number().int(), childAges: z.union([z.literal('unknown'), z.array(z.number().int())]),
  ratePlan: z.string() }).strict();

/** Only a positive, independently read back match can complete the approved change. */
export function verifiedCloudAmendReadback(form: z.infer<typeof cloudAmendDispatchFormSchema>, result: NativeResult) {
  const actual = readbackSchema.safeParse(result.readback), before = form.cloudAmend.preimage.native, changes = form.fields;
  if (result.outcome !== 'amended' || result.dispatchCallbacksDrained !== true ||
      result.writerSessionClosed !== true || result.retainedPriceMatched !== true || !actual.success) return null;
  const expected = { confirmation: form.confirmation, arrival: before.arrival,
    departure: before.departure, adults: changes.adults,
    children: before.children, childAges: before.childAges,
    ratePlan: changes.ratePlan };
  return hmsStateDigest(actual.data) === hmsStateDigest(expected) ? actual.data : null;
}

async function end(db: DB, fence: AiRunFence, failureClass: AiFailureClass, reason: string): Promise<Result> {
  return await endHmsWriteRun({ db, fence, failureClass, reason })
    ? { status: 'ended', failureClass, reason } : { status: 'lease_lost' };
}

/** The only dispatch claim follows a fresh HMS and approval check while the request is paused. */
export async function authorizeFreshCloudAmend<T>(check: () => Promise<HmsPreSaveOutcome>,
  claim: () => Promise<T>, deadlineAt: Date, signal?: AbortSignal): Promise<T> {
  const permitted = () => !signal?.aborted && Number.isFinite(deadlineAt.getTime()) &&
    deadlineAt.getTime() - Date.now() >= HMS_LABTEST_AMEND_DISPATCH_RESERVE_MS;
  if (!permitted() || (await check()).status !== 'unchanged' || !permitted()) {
    throw new Error('CLOUD_AMEND_PREIMAGE_CHANGED');
  }
  const handle = await claim();
  // A claim that committed too slowly stays UNKNOWN; it cannot release a
  // native request without enough time for the bounded writer and readback.
  if (!permitted()) throw new Error('CLOUD_AMEND_DEADLINE_EXHAUSTED');
  return handle;
}

async function readApprovedStay(target: HmsReadTarget, form: { confirmation: string; arrival: string }, signal?: AbortSignal) {
  const request = { confirmation: form.confirmation, arrival: form.arrival };
  const deadline = AbortSignal.timeout(5 * 60_000);
  const found = projectCloudStayFind(request, await runCloudStayFind({ request, target,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline }));
  const preimage = cloudAmendPreimage(found);
  if (!preimage || preimage.native.confirmation !== form.confirmation || preimage.native.arrival !== form.arrival) {
    throw new Error('CLOUD_AMEND_PREIMAGE_UNVERIFIED');
  }
  return preimage;
}

/** The caller owns the property lock; the final shared claim owns native dispatch. */
async function executeClaim(input: { db: DB; fence: AiRunFence; workItemId: string; transportId: string;
  target: HmsReadTarget; signal?: AbortSignal }): Promise<Result> {
  const { db, fence, workItemId, transportId, target } = input;
  let consumed: Awaited<ReturnType<typeof consumeHmsWriteApproval>>;
  try { consumed = await consumeHmsWriteApproval({ db, runId: fence.runId, fence }); }
  catch (error) {
    if (!(error instanceof HmsApprovalError)) throw error;
    return error.refusal === 'lease_lost' ? { status: 'lease_lost' } : end(db, fence, 'NEEDS_CHECK', error.refusal);
  }
  const parsed = cloudAmendDispatchFormSchema.safeParse(consumed.form);
  if (!parsed.success || !consumed.authority) return end(db, fence, 'NEEDS_CHECK', 'form_invalid');
  const form = parsed.data;
  let callbacks: ReturnType<typeof cloudAmendDispatchCallbacks>;
  try { callbacks = cloudAmendDispatchCallbacks({ db, fence, transportId, workItemId, consumed }); }
  catch { return end(db, fence, 'NEEDS_CHECK', 'form_invalid'); }

  if (input.signal?.aborted) return end(db, fence, 'NEEDS_CHECK', 'worker_stopped');

  const work = await mkdtemp(join(tmpdir(), 'pane-cloud-amend-'));
  const screenshots = ['before.png', 'after.png'] as const;
  let retainPrivateFiles = false, result: NativeResult;
  let dispatch: HmsLabtestWriteHandle | null = null;
  let beforeSealStarted = false;
  let beforeEvidence: { eventId: string; sha256: string } | null = null;
  let afterEvidence: { eventId: string; sha256: string } | null = null;
  const sealBeforeEvidence = async () => {
    if (beforeSealStarted) throw new Error('AMEND_EVIDENCE_ALREADY_STARTED');
    beforeSealStarted = true;
    try {
      const png = await readFile(join(work, screenshots[0]));
      const sealed = await recordHmsWriteEvidence({ db, transportId, workItemId, runId: fence.runId,
        name: screenshots[0], png });
      beforeEvidence = { eventId: sealed.eventId, sha256: sealed.sha256 };
      return beforeEvidence;
    } catch (error) {
      // An upload/insert may have succeeded despite a lost response. Preserve
      // the private file; do not retry or proceed to the first native effect.
      retainPrivateFiles = true;
      throw error;
    }
  };
  // A paused native request is still fenced while this independent read runs.
  // Only the following transaction may consume the one-shot dispatch claim.
  const authorizeFirst = async (step: Omit<Parameters<typeof callbacks.authorizeFirst>[0], 'beforeEvidence'>) => {
    if (!beforeEvidence) throw new Error('AMEND_EVIDENCE_REQUIRED');
    return authorizeFreshCloudAmend(
      () => assertHmsUnchangedBeforeSave({ db, runId: fence.runId, fence,
        readHmsState: () => readApprovedStay(target, form, input.signal) }),
      async () => { const handle = await callbacks.authorizeFirst({ ...step, beforeEvidence: beforeEvidence! });
        dispatch = handle; return handle; }, fence.deadlineAt, input.signal);
  };
  const beat = setInterval(() => { void heartbeatAiRun(fence, db).catch(() => false); }, 30_000);
  try {
    const url = new URL('../../tooling/hms-cloud/pane-amend-session.mjs', import.meta.url);
    const native = await import(url.href) as { commitCloudPaneAmend(input: unknown, authorization: unknown): Promise<NativeResult> };
    try {
      result = await native.commitCloudPaneAmend({ target, selected: form.cloudAmend.preimage.native,
        confirmation: form.confirmation, arrival: form.arrival, changes: form.fields,
        nativeDigest: form.cloudAmend.nativeDigest, approvedPrices: form.cloudAmend.approvedPrices,
        beforeScreenshot: join(work, screenshots[0]),
        afterScreenshot: join(work, screenshots[1]), signal: input.signal }, { ...callbacks, authorizeFirst, sealBeforeEvidence });
    } catch { result = { outcome: 'uncertain', issue: 'native_failed' }; }
    // The before image is sealed inside the native prepare step, never after
    // a possible dispatch. Preserve any unsealed image for investigation.
    if (!beforeEvidence) {
      try { await stat(join(work, screenshots[0])); retainPrivateFiles = true; }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') retainPrivateFiles = true; }
    }
    for (const name of screenshots.slice(1)) {
      let imageRead = false;
      try {
        const png = await readFile(join(work, name));
        imageRead = true;
        const sealed = await recordHmsWriteEvidence({ db, transportId, workItemId, runId: fence.runId, name, png });
        afterEvidence = { eventId: sealed.eventId, sha256: sealed.sha256 };
      } catch (error) {
        // ENOENT is harmless only when the local image itself was absent.
        // Storage or ledger failures after a read must preserve the image.
        if (imageRead || (error as NodeJS.ErrnoException)?.code !== 'ENOENT') retainPrivateFiles = true;
      }
    }
  } finally {
    clearInterval(beat);
    // Preserve an unsealed screenshot in the private directory for recovery.
    if (!retainPrivateFiles) await rm(work, { recursive: true, force: true }).catch(() => {});
  }
  if (result.outcome === 'not_dispatched' && !dispatch) return end(db, fence, 'NEEDS_CHECK', result.issue ?? 'not_dispatched');
  const readback = verifiedCloudAmendReadback(form, result);
  if (!readback || !dispatch || !beforeEvidence || !afterEvidence) {
    return end(db, fence, 'UNKNOWN', result.issue ?? 'amend_unverified');
  }
  const before = beforeEvidence, after = afterEvidence;
  try {
    await resolveHmsLabtestDispatch(db, dispatch, { operation: 'amend', confirmation: form.confirmation,
      readbackDigest: hmsStateDigest({ readback, approvedPrices: form.cloudAmend.approvedPrices }),
      savedShot: { runId: fence.runId, sha256: after.sha256 } }, async (tx, intent) => {
      callbacks.assertResolutionIntent(intent);
      await requireCloudAmendEvidence(tx, { transportId, workItemId, runId: fence.runId, before, after });
      const [run] = await tx.select({ metrics: aiWorkflowRun.metrics, deadlineAt: aiWorkflowRun.deadlineAt })
        .from(aiWorkflowRun).where(and(eq(aiWorkflowRun.id, fence.runId), eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND),
          eq(aiWorkflowRun.workItemId, workItemId), eq(aiWorkflowRun.transportId, transportId),
          eq(aiWorkflowRun.claimOwner, fence.claimOwner), eq(aiWorkflowRun.claimToken, fence.claimToken),
          inArray(aiWorkflowRun.state, ['claimed', 'running']))).limit(1).for('update');
      if (!run?.deadlineAt || run.deadlineAt.getTime() !== fence.deadlineAt.getTime() || Date.now() >= run.deadlineAt.getTime()) {
        throw new Error('CLOUD_AMEND_LEASE_LOST');
      }
      const now = new Date();
      await tx.update(aiWorkflowRun).set({ state: 'succeeded', finishedAt: now, updatedAt: now,
        claimOwner: null, claimToken: null,
        metrics: mergeTerminalRunMetrics(run.metrics, { action: 'amend', outcome: 'amended' })
      }).where(eq(aiWorkflowRun.id, fence.runId));
    });
  } catch { return end(db, fence, 'UNKNOWN', 'amend_resolution_unverified'); }
  return { status: 'succeeded', action: 'amend', outcome: 'amended', evidence: ['before.png', 'after.png'] };
}

/** A claimed U7 run cannot consume a Go or start HMS until readiness is proven. */
export async function runCloudPaneAmendOnce(input: { runId: string; fence: AiRunFence; db?: DB;
  env?: NodeJS.Dict<string>; signal?: AbortSignal }): Promise<Result> {
  const { fence } = input;
  if (input.runId !== fence.runId) return { status: 'lease_lost' };
  const db = input.db ?? getDb();
  const [run] = await db.select({ workItemId: aiWorkflowRun.workItemId, transportId: aiWorkflowRun.transportId })
    .from(aiWorkflowRun).where(and(eq(aiWorkflowRun.id, fence.runId), eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND),
      eq(aiWorkflowRun.promptVersion, HMS_LABTEST_AMEND_PROMPT_VERSION), eq(aiWorkflowRun.claimOwner, fence.claimOwner),
      eq(aiWorkflowRun.claimToken, fence.claimToken), inArray(aiWorkflowRun.state, ['claimed', 'running']))).limit(1);
  if (!run) return { status: 'lease_lost' };
  if (!cloudAmendWriteReady() || !labtestAmendWorkerEnabled(input.env) || input.signal?.aborted) {
    return end(db, fence, 'POLICY_BLOCK', 'amend_save_unavailable');
  }
  if (!run.workItemId) return end(db, fence, 'POLICY_BLOCK', 'no_work_item');
  const budget = fence.deadlineAt.getTime() - Date.now() - HMS_LABTEST_AMEND_CLEANUP_RESERVE_MS;
  if (!Number.isFinite(budget) || budget <= 0) return end(db, fence, 'NEEDS_CHECK', 'amend_deadline_exhausted');
  const deadline = AbortSignal.timeout(Math.min(budget, HMS_LABTEST_AMEND_RUN_DEADLINE_MS));
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  if (!(await markAiRunRunning(fence, db))) return { status: 'lease_lost' };
  const resolved = paneStayHmsTargetForTransport(run.transportId);
  const targetKeys = ['propertyCode', 'secretId', 'browserSlot', 'origin', 'installationEnvName'] as const;
  if (!resolved.ok || targetKeys.some((key) => resolved.target[key] !== CENTURION_HMS_READ_TARGET[key])) {
    return end(db, fence, 'POLICY_BLOCK', 'refused_unknown_transport');
  }
  const lock = paneStayPropertyLock(resolved.target);
  if (!lock) return end(db, fence, 'POLICY_BLOCK', 'refused_lock_unavailable');
  try {
    return await lock.withLock(() => executeClaim({ db, fence, workItemId: run.workItemId!, transportId: run.transportId,
      target: resolved.target, signal }), acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return end(db, fence, 'HMS_LOCK_BUSY', 'refused_lock_busy');
    // An unexpected failure after a claim can never be presented as no write.
    return end(db, fence, 'UNKNOWN', 'amend_runner_failed');
  }
}
