import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { workEvent, workItem } from '../db/schema/work.js';
import type { HmsReadTarget } from '../hms/hms-read-target.js';
import { cloudWriterQuiesced } from '../../tooling/hms-cloud/cloud-session.mjs';
import { acquisitionWithin, PANE_PROPERTY_LOCK_WAIT_MS } from '../hms/property-read-lock.js';
import { persistHmsShots, verifyStoredHmsShot } from './hms-shots-store.js';
import { canonicalJson } from './draft-approval.js';
import { hmsDispatchTargetKey } from './hms-dispatch-target.js';
import { hmsLabtestIntentTarget, type HmsLabtestIntent } from './hms-labtest-dispatch.js';
import { reservationWorkflowV2DraftSchema, type ReservationWorkflowV2Observation } from './reservation-workflow-v2-contract.js';
import { hasReservationWorkflowV2Draft, reservationWorkflowV2DraftOf,
  RESERVATION_WORKFLOW_V2_STATE_KEY } from './reservation-workflow-v2-state.js';
import type { CreateFenceTransaction } from './pane-create-dispatch-fence.js';
import { paneStayCloudTargetLock } from './pane-stay-save.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { readbackMatches } from './reservation-workflow-v2-amend.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const row = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const shotRef = z.object({ runId: uuid, sha256: digest }).strict();

const recoverySchema = z.object({
  runId: uuid,
  beforeShot: shotRef,
  selected: z.record(z.string(), z.unknown()),
  approvedAfter: z.record(z.string(), z.unknown()),
  approved: z.record(z.string(), z.unknown()),
  approvedPrices: z.record(z.string(), z.unknown()),
  preserved: z.record(z.string(), z.unknown()),
  applied: z.object({ mealPlan: z.string().min(1).max(120) }).passthrough(),
  expectedFinalCommission: z.number().finite().min(0).max(100).optional(),
  nativeDigest: digest,
  recoveryBaseline: z.object({
    beforeNote: z.string().max(2000), beforeParties: z.record(z.string(), z.unknown()),
    beforeRecipient: z.string().max(1000), beforeGuestEmail: z.string().max(1000).nullable(),
    beforeBookerName: z.string().max(1000).nullable(), beforeBookerContact: z.string().max(1000).nullable(),
    beforeGuaranteeCode: z.string().regex(/^[A-Z0-9]{1,40}$/), beforeSavedRates: z.unknown().nullable(),
  }).passthrough(),
  requestId: z.string().min(1).max(80), hintId: z.string().min(1).max(80), operationId: uuid,
  draftRevision: z.number().int().nonnegative(), prepareObservationRef: z.string().min(1).max(160),
}).passthrough();

const recoveryLock = new AsyncLocalStorage<{ holdId: string; targetKey: string; target: HmsReadTarget }>();

type AmendRecoveryProof = {
  confirmation: string;
  nativeStayId: string;
  nativeReadback: Record<string, unknown>;
  readbackDigest: string;
  savedShot: { runId: string; sha256: string };
};

function approvedReadbackMatches(readback: Record<string, unknown>, recovery: z.infer<typeof recoverySchema>): boolean {
  return Boolean(readbackMatches(readback, { target: recovery.approvedAfter, nativeChanges: recovery.approved,
    preserved: recovery.preserved, recoveryBaseline: recovery.recoveryBaseline, approvedPrices: recovery.approvedPrices,
    applied: recovery.applied, expectedFinalCommission: recovery.expectedFinalCommission }));
}

function checkedRecovery(intent: HmsLabtestIntent, value: unknown) {
  const parsed = recoverySchema.safeParse(value), target = hmsLabtestIntentTarget(intent);
  if (!parsed.success || intent.operation !== 'amend' || !target || target.kind !== 'saved' ||
      (parsed.data.selected.propertyCode ?? 'HRCEN') !== intent.propertyCode || target.propertyCode !== intent.propertyCode ||
      target.confirmation !== parsed.data.selected.confirmation || target.nativeStayId !== parsed.data.selected.reservationStayId ||
      intent.grantId !== parsed.data.operationId || !digest.safeParse(intent.approvedDigest).success ||
      parsed.data.beforeShot.runId !== parsed.data.runId ||
      !digest.safeParse(parsed.data.nativeDigest).success) throw new Error('amend_recovery_intent_invalid');
  return { recovery: parsed.data, dispatchTarget: target };
}

async function loadRecovery(db: DB, intent: HmsLabtestIntent) {
  const summary = row(intent.recovery);
  if (!summary || !cloudWriterQuiesced(summary.writer) || !digest.safeParse(summary.recoveryEvidenceDigest).success ||
      summary.operationId !== intent.grantId) throw new Error('amend_recovery_writer_unverified');
  const events = await db.select({ actorKind: workEvent.actorKind, value: workEvent.value }).from(workEvent)
    .where(and(eq(workEvent.workItemId, intent.workItemId), eq(workEvent.type, 'write.evidence'),
      eq(workEvent.fieldPath, 'nava.hms.amend.recovery.v1'),
      sql`${workEvent.value}->>'operationId' = ${intent.grantId}`)).limit(2);
  const event = events.length === 1 && events[0]?.actorKind === 'system' ? row(events[0].value) : null;
  const recovery = row(event?.recovery);
  if (!event || event.sourceDigest !== intent.sourceDigest || !recovery || sha256(recovery) !== summary.recoveryEvidenceDigest) {
    throw new Error('amend_recovery_evidence_unverified');
  }
  return checkedRecovery(intent, { ...recovery, runId: summary.runId, beforeShot: summary.beforeShot });
}

/** The original writer must be gone before opening a fresh reader under the same target aliases. */
export async function withAmendRecoveryLock<T>(intent: HmsLabtestIntent, action: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  const summary = row(intent.recovery), dispatchTarget = hmsLabtestIntentTarget(intent);
  const target = paneStayHmsTargetForTransport(intent.transportId, intent.propertyCode);
  if (!summary || !cloudWriterQuiesced(summary.writer) || intent.operation !== 'amend' ||
      !dispatchTarget || dispatchTarget.kind !== 'saved' || dispatchTarget.propertyCode !== intent.propertyCode ||
      dispatchTarget.confirmation !== summary.confirmation || dispatchTarget.nativeStayId !== summary.reservationStayId ||
      !target.ok || target.target.propertyCode !== intent.propertyCode) throw new Error('amend_recovery_target_unavailable');
  const lock = paneStayCloudTargetLock(target.target, dispatchTarget, { kind: 'independent_cloud' });
  if (!lock) throw new Error('amend_recovery_lock_unavailable');
  return lock.withLock((signal) => {
    signal?.throwIfAborted();
    if (!cloudWriterQuiesced(summary.writer)) throw new Error('amend_recovery_writer_unverified');
    return recoveryLock.run({ holdId: intent.holdId, targetKey: hmsDispatchTargetKey(dispatchTarget), target: target.target },
      () => action(signal));
  }, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
}

/** Re-read the approved native after-state in a fresh guarded session; never retries Save. */
export async function proveAmendRecovery(db: DB, intent: HmsLabtestIntent, signal?: AbortSignal): Promise<AmendRecoveryProof> {
  const { recovery, dispatchTarget } = await loadRecovery(db, intent), locked = recoveryLock.getStore();
  const owner = `${intent.actorUserId}:${intent.transportId}`;
  if (!locked || locked.holdId !== intent.holdId || locked.targetKey !== hmsDispatchTargetKey(dispatchTarget) ||
      !await verifyStoredHmsShot({ ...recovery.beforeShot, name: 'before.png', owner,
        propertyCode: intent.propertyCode, workItemId: intent.workItemId }, 'before.png')) {
    throw new Error('amend_recovery_before_image_unverified');
  }
  const work = await mkdtemp(join(tmpdir(), 'hms-amend-recovery-'));
  const screenshot = join(work, 'saved.png'), recoveryRunId = randomUUID();
  try {
    const native = await import(new URL('../../tooling/hms-cloud/pane-amend-session.mjs', import.meta.url).href) as {
      readCloudPaneAmend(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    const selected = recovery.selected;
    const observed = await native.readCloudPaneAmend({ ...recovery.recoveryBaseline,
      target: locked.target, transportId: intent.transportId, selected,
      confirmation: selected.confirmation, arrival: selected.arrival, changes: recovery.approved,
      allowRealGuest: true, approvedPrices: recovery.approvedPrices,
      capturePriceComponents: true, captureMealPlan: true, approvedMealPlan: recovery.applied.mealPlan,
      ...(recovery.expectedFinalCommission === undefined ? {} : { expectedFinalCommission: recovery.expectedFinalCommission }),
      afterScreenshot: screenshot, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8 * 60_000)]) : AbortSignal.timeout(8 * 60_000) });
    const readback = row(observed.readback);
    if (observed.outcome !== 'matched' || !readback || !approvedReadbackMatches(readback, recovery) ||
        readback.confirmation !== dispatchTarget.confirmation || readback.nativeStayId !== dispatchTarget.nativeStayId) {
      throw new Error('amend_recovery_readback_not_positive');
    }
    const stage = await mkdtemp(join(tmpdir(), 'hms-amend-recovery-shot-'));
    try {
      await copyFile(screenshot, join(stage, 'saved.png'));
      const shots = await persistHmsShots({ propertyCode: intent.propertyCode, workItemId: intent.workItemId,
        runId: recoveryRunId, sourceDir: stage, owner, now: Date.now() });
      const shot = shots?.find((item) => item.name === 'saved.png');
      if (!shot || !await verifyStoredHmsShot({ runId: recoveryRunId, name: 'saved.png', sha256: shot.sha256,
        owner, propertyCode: intent.propertyCode, workItemId: intent.workItemId }, 'saved.png')) {
        throw new Error('amend_recovery_saved_image_unverified');
      }
      return { confirmation: String(readback.confirmation), nativeStayId: String(readback.nativeStayId),
        nativeReadback: readback, readbackDigest: sha256(readback), savedShot: { runId: recoveryRunId, sha256: shot.sha256 } };
    } finally { await rm(stage, { recursive: true, force: true }); }
  } finally { await rm(work, { recursive: true, force: true }); }
}

/** Resolve only the exact unknown v2 operation bound into the original durable Amend intent. */
export async function recordRecoveredAmend(tx: CreateFenceTransaction, intent: HmsLabtestIntent, proof: AmendRecoveryProof): Promise<void> {
  const { recovery, dispatchTarget } = await loadRecovery(tx as unknown as DB, intent);
  if (proof.confirmation !== dispatchTarget.confirmation || proof.nativeStayId !== dispatchTarget.nativeStayId ||
      proof.savedShot.runId === recovery.runId || proof.readbackDigest !== sha256(proof.nativeReadback) ||
      !approvedReadbackMatches(proof.nativeReadback, recovery)) throw new Error('amend_recovery_proof_scope_changed');
  const owner = `${intent.actorUserId}:${intent.transportId}`;
  if (!await verifyStoredHmsShot({ ...recovery.beforeShot, name: 'before.png', owner, propertyCode: intent.propertyCode,
    workItemId: intent.workItemId }, 'before.png') ||
      !await verifyStoredHmsShot({ ...proof.savedShot, name: 'saved.png', owner, propertyCode: intent.propertyCode,
        workItemId: intent.workItemId }, 'saved.png')) throw new Error('amend_recovery_screenshot_scope_changed');
  const [item] = await tx.select({ state: workItem.state }).from(workItem)
    .where(and(eq(workItem.id, intent.workItemId), eq(workItem.transportId, intent.transportId))).limit(1).for('update');
  if (!item || !hasReservationWorkflowV2Draft(item.state as Record<string, unknown>)) {
    throw new Error('reservation_workflow_v2_amend_recovery_scope_changed');
  }
  const draftValue = reservationWorkflowV2DraftOf(item.state as Record<string, unknown>);
  const draft = draftValue && reservationWorkflowV2DraftSchema.parse(draftValue);
  const prior = draft?.operationResults.find((result) => result.id === recovery.operationId && result.workflow === 'amend' &&
    result.requestId === recovery.requestId && result.allocationId === recovery.hintId && result.status === 'unknown');
  const prepared = draft?.observations.find((observation) => observation.ref === recovery.prepareObservationRef &&
    observation.kind === 'rate_availability' && observation.status === 'complete' &&
    observation.criteria.workflow === 'amend' && observation.criteria.requestId === recovery.requestId &&
    observation.criteria.hintId === recovery.hintId && observation.criteria.semanticDigest === intent.approvedDigest);
  const preparedResult = row(prepared?.result);
  if (!draft || !prior || !preparedResult || intent.transportId !== draft.transportId || intent.propertyCode !== draft.propertyCode ||
      intent.sourceDigest !== draft.source.sourceHash ||
      prior.draftRevision !== recovery.draftRevision || canonicalJson(preparedResult.target) !== canonicalJson(recovery.approvedAfter) ||
      canonicalJson(preparedResult.before) !== canonicalJson(recovery.selected) ||
      canonicalJson(preparedResult.nativeChanges) !== canonicalJson(recovery.approved) ||
      canonicalJson(preparedResult.preserved) !== canonicalJson(recovery.preserved) ||
      canonicalJson(preparedResult.recoveryBaseline) !== canonicalJson(recovery.recoveryBaseline) ||
      canonicalJson(preparedResult.applied) !== canonicalJson(recovery.applied) ||
      preparedResult.expectedFinalCommission !== recovery.expectedFinalCommission ||
      preparedResult.nativeDigest !== recovery.nativeDigest ||
      canonicalJson(preparedResult.approvedPrices) !== canonicalJson(recovery.approvedPrices)) {
    throw new Error('reservation_workflow_v2_amend_recovery_scope_changed');
  }
  const observation: ReservationWorkflowV2Observation = {
    ref: randomUUID(), generationId: draft.generationId, kind: 'stay_candidate', status: 'complete',
    observedAt: new Date().toISOString(), propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId, sourceRefs: [],
    criteria: { workflow: 'amend', requestId: recovery.requestId, hintId: recovery.hintId,
      operationId: recovery.operationId, recovered: true, sourceHash: draft.source.sourceHash,
      approvedDigest: intent.approvedDigest, prepareObservationRef: recovery.prepareObservationRef },
    coverage: { complete: true, notes: [] },
    result: { outcome: 'amended', target: recovery.approvedAfter, nativeReadback: proof.nativeReadback,
      readbackDigest: proof.readbackDigest, approvedPrices: recovery.approvedPrices,
      beforeShot: recovery.beforeShot, savedShot: proof.savedShot },
  };
  const summary = `Recovered Amend ${proof.confirmation} from exact fresh HMS readback`;
  const operationResults = [...draft.operationResults.filter((result) => result.id !== recovery.operationId), {
    ...prior, status: 'succeeded' as const, observationRefs: [observation.ref], updatedAt: new Date().toISOString(), summary,
  }];
  const nextDraft = reservationWorkflowV2DraftSchema.parse({ ...draft, observations: [...draft.observations, observation], operationResults });
  await tx.update(workItem).set({ state: { ...(item.state as Record<string, unknown>),
    [RESERVATION_WORKFLOW_V2_STATE_KEY]: nextDraft },
    updatedAt: new Date() }).where(eq(workItem.id, intent.workItemId));
  await tx.insert(workEvent).values({ workItemId: intent.workItemId, actorKind: 'system', type: 'write.evidence',
    fieldPath: `reservationWorkflowV2:operationResults:${recovery.operationId}`,
    value: { id: recovery.operationId, requestId: recovery.requestId, allocationId: recovery.hintId,
      workflow: 'amend', status: 'succeeded', observationRefs: [observation.ref], recovered: true },
    evidence: { sourceHash: draft.source.sourceHash, confirmation: proof.confirmation,
      readbackDigest: proof.readbackDigest, approvedDigest: intent.approvedDigest } });
}
