import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import { workEvent } from '../db/schema/work.js';
import { CENTURION_HMS_READ_TARGET, type HmsReadTarget } from '../hms/hms-read-target.js';
import { acquisitionWithin, assertTargetAliasesHeld, isPropertyReadLockDeadline, PANE_PROPERTY_LOCK_WAIT_MS,
  type HeldTargetAliasLock } from '../hms/property-read-lock.js';
import type { VerifiedStaffGo } from '../hms/staff-go-authority.js';
import { effectiveWorkflowPolicy } from '../../tooling/hms-cloud/hms-workflow-policy.mjs';
import { assertHmsUnchangedBeforeSave, consumeHmsWriteApproval, endHmsWriteRun, hmsStateDigest,
  HmsApprovalError, recordHmsWriteEvidence, type HmsPreSaveOutcome } from './hms-approval.js';
import { projectCloudStayFind, runCloudStayFind } from './hms-cloud-saved-stay-find.js';
import { cloudAmendPreimage } from './pane-cloud-amend.js';
import { cloudAmendDispatchCallbacks, cloudAmendDispatchFormSchema, requireCloudAmendEvidence } from './pane-cloud-amend-dispatch.js';
import { captureHmsLabtestDispatchEpoch, resolveHmsLabtestDispatch, type HmsLabtestWriteHandle } from './hms-labtest-dispatch.js';
import { HMS_LABTEST_AMEND_CLEANUP_RESERVE_MS, HMS_LABTEST_AMEND_DISPATCH_RESERVE_MS,
  HMS_LABTEST_AMEND_PROMPT_VERSION, HMS_LABTEST_AMEND_RUN_DEADLINE_MS, labtestAmendWorkerEnabled } from './pane-cloud-amend-readiness.js';
import { paneStayCloudTargetLock } from './pane-stay-save.js';
import { hmsDispatchTargetKey, hmsDispatchTargetKeys, type HmsDispatchTarget } from './hms-dispatch-target.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { heartbeatAiRun, HMS_WRITE_RUN_KIND, HMS_V2_WRITE_PROMPT_VERSION, markAiRunRunning, mergeTerminalRunMetrics, type AiFailureClass, type AiRunFence } from './run-ledger.js';

type Result = { status: 'ended'; failureClass: AiFailureClass; reason: string } | { status: 'lease_lost' } |
  { status: 'succeeded'; action: 'amend'; outcome: 'amended'; evidence: string[]; observationRef?: string; nativeReadbackDigest?: string };
type NativeResult = { outcome: string; issue?: string; dispatchCallbacksDrained?: boolean;
  writerSessionClosed?: boolean; businessFieldsMatched?: boolean; readback?: unknown };

const readbackSchema = z.object({ confirmation: z.string(), nativeStayId: z.string(), arrival: z.string(), departure: z.string(),
  roomType: z.string(), ratePlan: z.string(), adults: z.number().int(), children: z.number().int(),
  childAges: z.union([z.literal('unknown'), z.array(z.number().int())]), firstName: z.string(), lastName: z.string(),
  guestEmail: z.string(), bookerName: z.string(), bookerContact: z.string(), cmsSend: z.boolean(),
  cmsMessageId: z.string(), cmsRecipient: z.string(),
  price: z.unknown().nullable() }).strict();

/** Complete only after a fresh read of the selected stay and requested business fields. */
export function verifiedCloudAmendReadback(form: z.infer<typeof cloudAmendDispatchFormSchema>, result: NativeResult) {
  const actual = readbackSchema.safeParse(result.readback), before = form.cloudAmend.preimage.native, changes = form.fields;
  if (result.outcome !== 'amended' || result.dispatchCallbacksDrained !== true ||
      result.writerSessionClosed !== true || result.businessFieldsMatched !== true || !actual.success) return null;
  const read = actual.data;
  if (read.confirmation !== form.confirmation || read.nativeStayId !== before.reservationStayId ||
      read.arrival !== (changes.arrival ?? before.arrival) || read.departure !== (changes.departure ?? before.departure) ||
      read.roomType !== (changes.roomType ?? before.roomType) || read.ratePlan !== changes.ratePlan ||
      read.adults !== (changes.adults ?? before.adults) || read.children !== (changes.children ?? before.children) ||
      read.firstName !== (changes.firstName ?? before.firstName) || read.lastName !== (changes.lastName ?? before.lastName)) return null;
  const ages = changes.childAges ?? before.childAges;
  if (Array.isArray(ages) && (!Array.isArray(read.childAges) ||
      JSON.stringify([...read.childAges].sort((a, b) => a - b)) !== JSON.stringify([...ages].sort((a, b) => a - b)))) return null;
  for (const name of ['guestEmail', 'bookerName', 'bookerContact'] as const) {
    if (changes[name] !== undefined && read[name] !== changes[name]) return null;
  }
  if (read.cmsSend !== changes.cmsSend ||
      (changes.cmsSend && (read.cmsMessageId !== changes.cmsMessageId || read.cmsRecipient !== changes.cmsRecipient))) return null;
  return read;
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

async function readApprovedStay(target: HmsReadTarget, form: { confirmation: string; arrival: string },
  allowRealGuest: boolean, signal?: AbortSignal, transportId?: string) {
  const request = { confirmation: form.confirmation, arrival: form.arrival };
  const deadline = AbortSignal.timeout(5 * 60_000);
  const found = projectCloudStayFind(request, await runCloudStayFind({ request, target, transportId,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline }), target.propertyCode);
  const preimage = cloudAmendPreimage(found, allowRealGuest, target.propertyCode);
  if (!preimage || preimage.native.confirmation !== form.confirmation || preimage.native.arrival !== form.arrival) {
    throw new Error('CLOUD_AMEND_PREIMAGE_UNVERIFIED');
  }
  return preimage;
}

/** Lock the reviewed native target before refreshing its preimage. */
async function executeClaim(input: { db: DB; fence: AiRunFence; workItemId: string; transportId: string;
  target: HmsReadTarget; allowRealGuest: boolean; env?: NodeJS.Dict<string>; signal?: AbortSignal; go?: VerifiedStaffGo }): Promise<Result> {
  const { db, fence, target } = input;
  const finish = (failureClass: AiFailureClass, reason: string): Promise<Result> => input.go
    ? Promise.resolve({ status: 'ended', failureClass, reason }) : end(db, fence, failureClass, reason);
  let consumed: Awaited<ReturnType<typeof consumeHmsWriteApproval>>;
  try { consumed = await consumeHmsWriteApproval({ db, runId: fence.runId, fence }); }
  catch (error) {
    if (!(error instanceof HmsApprovalError)) throw error;
    return error.refusal === 'lease_lost' ? { status: 'lease_lost' } : finish('NEEDS_CHECK', error.refusal);
  }
  const parsed = cloudAmendDispatchFormSchema.safeParse(consumed.form);
  if (!parsed.success || !consumed.authority || (input.go &&
      (consumed.verifiedStaffGo?.grant.grantId !== input.go.grant.grantId ||
       consumed.verifiedStaffGo.grant.propertyCode !== target.propertyCode))) return finish('NEEDS_CHECK', 'form_invalid');
  const form = parsed.data;
  if (input.signal?.aborted) return finish('NEEDS_CHECK', 'worker_stopped');
  const preimage = form.cloudAmend.preimage.native;
  if (preimage.propertyCode !== target.propertyCode) return finish('NEEDS_CHECK', 'form_invalid');
  const dispatchTarget: HmsDispatchTarget = { propertyCode: preimage.propertyCode, kind: 'saved',
    confirmation: preimage.confirmation, nativeStayId: preimage.reservationStayId };
  const lock = paneStayCloudTargetLock(target, dispatchTarget, { kind: 'independent_cloud',
    targetAliases: input.go?.preparation.targetAliases });
  if (!lock) return finish('POLICY_BLOCK', 'refused_lock_unavailable');
  try {
    return await lock.withLock((lockSignal, heldTargetLock) => executeLockedClaim({ ...input, consumed, form, dispatchTarget, heldTargetLock,
      signal: lockSignal && input.signal ? AbortSignal.any([lockSignal, input.signal]) : lockSignal ?? input.signal }),
      acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return finish('HMS_LOCK_BUSY', 'refused_lock_busy');
    return finish('UNKNOWN', 'amend_runner_failed');
  }
}

async function executeLockedClaim(input: { db: DB; fence: AiRunFence; workItemId: string; transportId: string;
  target: HmsReadTarget; allowRealGuest: boolean; env?: NodeJS.Dict<string>; signal?: AbortSignal;
  consumed: Awaited<ReturnType<typeof consumeHmsWriteApproval>>; form: z.infer<typeof cloudAmendDispatchFormSchema>;
  dispatchTarget: HmsDispatchTarget; go?: VerifiedStaffGo; heldTargetLock?: HeldTargetAliasLock }): Promise<Result> {
  const { db, fence, workItemId, transportId, target, consumed, form, dispatchTarget } = input;
  const finish = (failureClass: AiFailureClass, reason: string): Promise<Result> => input.go
    ? Promise.resolve({ status: 'ended', failureClass, reason }) : end(db, fence, failureClass, reason);
  const modeCurrent = () => input.go
    ? effectiveWorkflowPolicy(input.env ?? process.env, input.go.grant.propertyCode, 'amend').admittedMode !== 'off' &&
      input.allowRealGuest === (effectiveWorkflowPolicy(input.env ?? process.env, input.go.grant.propertyCode, 'amend').admittedMode === 'on')
    : labtestAmendWorkerEnabled(input.env) && input.allowRealGuest === ((input.env ?? process.env).PANE_WRITE_AMEND === 'on');
  const assertActive = () => {
    input.signal?.throwIfAborted();
    if (input.go) assertTargetAliasesHeld(input.heldTargetLock, { tenantId: input.go.grant.tenantId,
      propertyCode: input.go.grant.propertyCode,
      targetAliases: [...new Set([...input.go.preparation.targetAliases, ...hmsDispatchTargetKeys(dispatchTarget)])] });
  };
  if (!modeCurrent() || input.signal?.aborted) return finish('POLICY_BLOCK', 'amend_save_unavailable');
  const currentStay = await readApprovedStay(target, form, input.allowRealGuest, input.signal, input.transportId);
  assertActive();
  if (hmsStateDigest(currentStay) !== hmsStateDigest(form.cloudAmend.preimage)) return finish('NEEDS_CHECK', 'hms_preimage_changed');
  const revalidated = await assertHmsUnchangedBeforeSave({ db, runId: fence.runId, fence,
    readHmsState: async () => currentStay });
  if (revalidated.status !== 'unchanged') return finish('NEEDS_CHECK', 'hms_preimage_changed');
  // Revalidation and the scoped epoch both happen inside the owned target lock.
  let expectedEpoch: string;
  try { expectedEpoch = await captureHmsLabtestDispatchEpoch(db, dispatchTarget, workItemId); }
  catch { return finish('NEEDS_CHECK', 'labtest_write_in_flight'); }
  let callbacks: ReturnType<typeof cloudAmendDispatchCallbacks>;
  try { callbacks = cloudAmendDispatchCallbacks({ db, fence, transportId, workItemId, consumed, expectedEpoch,
    allowRealGuest: input.allowRealGuest, env: input.env, assertActive }); }
  catch { return finish('NEEDS_CHECK', 'form_invalid'); }

  if (input.signal?.aborted) return finish('NEEDS_CHECK', 'worker_stopped');

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
  // The writer rechecks the native preimage in its own session before this authority check.
  const authorizeFirst = async (step: Omit<Parameters<typeof callbacks.authorizeFirst>[0], 'beforeEvidence'>) => {
    assertActive();
    if (!beforeEvidence) throw new Error('AMEND_EVIDENCE_REQUIRED');
    if (!modeCurrent()) throw new Error('AMEND_MODE_CHANGED');
    return authorizeFreshCloudAmend(
      () => assertHmsUnchangedBeforeSave({ db, runId: fence.runId, fence,
        readHmsState: async () => currentStay }),
      async () => { if (!modeCurrent()) throw new Error('AMEND_MODE_CHANGED');
        const handle = await callbacks.authorizeFirst({ ...step, beforeEvidence: beforeEvidence! });
        dispatch = handle;
        if (!modeCurrent()) throw new Error('AMEND_MODE_CHANGED');
        return handle; }, fence.deadlineAt, input.signal);
  };
  const beat = setInterval(() => { void heartbeatAiRun(fence, db).catch(() => false); }, 30_000);
  try {
    const url = new URL('../../tooling/hms-cloud/pane-amend-session.mjs', import.meta.url);
    const native = await import(url.href) as { commitCloudPaneAmend(input: unknown, authorization: unknown): Promise<NativeResult> };
    try {
      result = await native.commitCloudPaneAmend({ target, transportId, selected: form.cloudAmend.preimage.native,
        confirmation: form.confirmation, arrival: form.arrival, changes: form.fields,
        nativeDigest: form.cloudAmend.nativeDigest, approvedPrices: form.cloudAmend.approvedPrices,
        preserved: form.cloudAmend.preserved, allowRealGuest: input.allowRealGuest,
        cloudTargetKey: hmsDispatchTargetKey(dispatchTarget),
        beforeScreenshot: join(work, screenshots[0]),
        afterScreenshot: join(work, screenshots[1]), signal: input.signal }, { ...callbacks, authorizeFirst, sealBeforeEvidence, isEnabled: modeCurrent });
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
  if (result.outcome === 'not_dispatched' && !dispatch) return finish('NEEDS_CHECK', result.issue ?? 'not_dispatched');
  const readback = verifiedCloudAmendReadback(form, result);
  if (!readback || !dispatch || !beforeEvidence || !afterEvidence) {
    return finish('UNKNOWN', result.issue ?? 'amend_unverified');
  }
  const before = beforeEvidence, after = afterEvidence;
  const nativeReadbackDigest = hmsStateDigest(readback);
  let observationRef: string | undefined;
  try {
    await resolveHmsLabtestDispatch(db, dispatch, { operation: 'amend', confirmation: form.confirmation,
      nativeStayId: readback.nativeStayId, nativeReadback: readback, readbackDigest: nativeReadbackDigest,
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
      assertActive();
      if (input.go) return;
      const now = new Date();
      await tx.update(aiWorkflowRun).set({ state: 'succeeded', finishedAt: now, updatedAt: now,
        claimOwner: null, claimToken: null,
        metrics: mergeTerminalRunMetrics(run.metrics, { action: 'amend', outcome: 'amended' })
      }).where(eq(aiWorkflowRun.id, fence.runId));
    });
    if (input.go) {
      const resolved = await db.select({ id: workEvent.id, value: workEvent.value }).from(workEvent).where(and(
        eq(workEvent.workItemId, workItemId), eq(workEvent.type, 'write.evidence'), eq(workEvent.actorKind, 'system'),
        eq(workEvent.fieldPath, 'nava.hms.labtest.dispatch.v1'), sql`${workEvent.value}->>'holdId' = ${dispatch.holdId}`,
        sql`${workEvent.value}->>'kind' = 'resolved'`)).limit(2);
      const receipt = z.object({ operation: z.literal('amend'), readbackDigest: z.literal(nativeReadbackDigest),
        nativeReadback: z.unknown() }).passthrough().safeParse(resolved[0]?.value);
      if (resolved.length !== 1 || !receipt.success || hmsStateDigest(receipt.data.nativeReadback) !== nativeReadbackDigest) {
        throw new Error('amend_resolution_receipt_unverified');
      }
      observationRef = resolved[0]!.id;
    }
  } catch { return finish('UNKNOWN', 'amend_resolution_unverified'); }
  return { status: 'succeeded', action: 'amend', outcome: 'amended', evidence: ['before.png', 'after.png'],
    ...(input.go ? { observationRef, nativeReadbackDigest } : {}) };
}

/** A claimed U7 run cannot consume a Go or start HMS until readiness is proven. */
export async function runCloudPaneAmendOnce(input: { runId: string; fence: AiRunFence; db?: DB;
  env?: NodeJS.Dict<string>; signal?: AbortSignal; go?: VerifiedStaffGo }): Promise<Result> {
  const { fence } = input;
  if (input.runId !== fence.runId) return { status: 'lease_lost' };
  const db = input.db ?? getDb();
  const finish = (failureClass: AiFailureClass, reason: string): Promise<Result> => input.go
    ? Promise.resolve({ status: 'ended', failureClass, reason }) : end(db, fence, failureClass, reason);
  const [run] = await db.select({ workItemId: aiWorkflowRun.workItemId, transportId: aiWorkflowRun.transportId })
    .from(aiWorkflowRun).where(and(eq(aiWorkflowRun.id, fence.runId), eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND),
      eq(aiWorkflowRun.promptVersion, input.go ? HMS_V2_WRITE_PROMPT_VERSION : HMS_LABTEST_AMEND_PROMPT_VERSION), eq(aiWorkflowRun.claimOwner, fence.claimOwner),
      eq(aiWorkflowRun.claimToken, fence.claimToken), inArray(aiWorkflowRun.state, ['claimed', 'running']))).limit(1);
  if (!run) return { status: 'lease_lost' };
  const mode = input.go ? effectiveWorkflowPolicy(input.env ?? process.env, input.go.grant.propertyCode, 'amend').admittedMode
    : labtestAmendWorkerEnabled(input.env) ? ((input.env ?? process.env).PANE_WRITE_AMEND === 'on' ? 'on' : 'lab') : 'off';
  if (mode === 'off' || input.signal?.aborted || (input.go &&
      (input.go.grant.operation !== 'amend' || input.go.grant.workItemId !== run.workItemId || input.go.grant.transportId !== run.transportId))) {
    return finish('POLICY_BLOCK', 'amend_save_unavailable');
  }
  if (!run.workItemId) return finish('POLICY_BLOCK', 'no_work_item');
  const budget = fence.deadlineAt.getTime() - Date.now() - HMS_LABTEST_AMEND_CLEANUP_RESERVE_MS;
  if (!Number.isFinite(budget) || budget <= 0) return finish('NEEDS_CHECK', 'amend_deadline_exhausted');
  const deadline = AbortSignal.timeout(Math.min(budget, HMS_LABTEST_AMEND_RUN_DEADLINE_MS));
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  if (!input.go && !(await markAiRunRunning(fence, db))) return { status: 'lease_lost' };
  const resolved = paneStayHmsTargetForTransport(run.transportId, input.go?.grant.propertyCode);
  const targetKeys = ['propertyCode', 'secretId', 'browserSlot', 'origin', 'installationEnvName'] as const;
  if (!resolved.ok || (!input.go && targetKeys.some((key) => resolved.target[key] !== CENTURION_HMS_READ_TARGET[key]))) {
    return finish('POLICY_BLOCK', 'refused_unknown_transport');
  }
  try {
    return await executeClaim({ db, fence, workItemId: run.workItemId, transportId: run.transportId,
      target: resolved.target, allowRealGuest: mode === 'on', env: input.env, signal, go: input.go });
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return finish('HMS_LOCK_BUSY', 'refused_lock_busy');
    // An unexpected failure after a claim can never be presented as no write.
    return finish('UNKNOWN', 'amend_runner_failed');
  }
}
