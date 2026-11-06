import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { workEvent, workItem } from '../db/schema/work.js';
import { CENTURION_HMS_READ_TARGET, type HmsReadTarget } from '../hms/hms-read-target.js';
import { acquisitionWithin, PANE_PROPERTY_LOCK_WAIT_MS } from '../hms/property-read-lock.js';
import { persistHmsShots, verifyStoredHmsShot } from './hms-shots-store.js';
import { canonicalJson } from './draft-approval.js';
import { hmsDispatchTargetKey, hmsDispatchTargetSchema } from './hms-dispatch-target.js';
import { hmsLabtestIntentTarget, type HmsLabtestIntent } from './hms-labtest-dispatch.js';
import { paneStayCloudTargetLock } from './pane-stay-save.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { reservationWorkflowV2DraftSchema, type ReservationWorkflowV2Observation } from './reservation-workflow-v2-contract.js';
import { hasReservationWorkflowV2Draft, reservationWorkflowV2DraftOf,
  RESERVATION_WORKFLOW_V2_STATE_KEY } from './reservation-workflow-v2-state.js';
import type { CreateFenceTransaction } from './pane-create-dispatch-fence.js';

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
  nativeDigest: digest,
  recoveryBaseline: z.object({
    beforeNote: z.string().max(2000), beforeParties: z.record(z.string(), z.unknown()),
    beforeRecipient: z.string().max(1000), beforeGuestEmail: z.string().max(1000).nullable(),
    beforeBookerName: z.string().max(1000).nullable(), beforeBookerContact: z.string().max(1000).nullable(),
    beforeGuaranteeCode: z.string().regex(/^[A-Z0-9]{1,40}$/), beforeSavedRates: z.unknown().nullable(),
  }).strict(),
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
  const target = recovery.approvedAfter, changes = recovery.approved, preserved = recovery.preserved;
  for (const key of ['confirmation', 'nativeStayId', 'arrival', 'departure', 'roomType', 'ratePlan', 'adults', 'children',
    'firstName', 'lastName']) {
    if (readback[key] !== target[key]) return false;
  }
  if (Array.isArray(target.childAges)) {
    if (!Array.isArray(readback.childAges) || canonicalJson([...readback.childAges].sort((a, b) => Number(a) - Number(b))) !==
        canonicalJson([...target.childAges].sort((a, b) => Number(a) - Number(b)))) return false;
  }
  for (const key of ['guestEmail', 'bookerName', 'bookerContact']) {
    if (Object.hasOwn(changes, key) && readback[key] !== changes[key]) return false;
    if (!Object.hasOwn(changes, key) && Object.hasOwn(preserved, key) && readback[key] !== preserved[key]) return false;
  }
  if (readback.cmsSend !== changes.cmsSend) return false;
  if (changes.cmsSend === true) {
    if (readback.cmsMessageId !== changes.cmsMessageId || readback.cmsRecipient !== changes.cmsRecipient) return false;
  } else if (readback.cmsRecipient !== preserved.cmsRecipient ||
      (Object.hasOwn(preserved, 'cmsMessageId') && readback.cmsMessageId !== preserved.cmsMessageId)) return false;
  const actualPrice = row(readback.price), approvedPrice = recovery.approvedPrices;
  return Boolean(actualPrice && actualPrice.version === approvedPrice.version && actualPrice.currency === approvedPrice.currency &&
    actualPrice.totalCents === approvedPrice.totalCents && actualPrice.averageCents === approvedPrice.averageCents);
}

function checkedRecovery(intent: HmsLabtestIntent) {
  const parsed = recoverySchema.safeParse(intent.recovery), target = hmsLabtestIntentTarget(intent);
  if (!parsed.success || intent.operation !== 'amend' || intent.propertyCode !== 'HRCEN' || !target || target.kind !== 'saved' ||
      target.confirmation !== parsed.data.selected.confirmation || target.nativeStayId !== parsed.data.selected.reservationStayId ||
      intent.grantId !== parsed.data.operationId || !digest.safeParse(intent.approvedDigest).success ||
      parsed.data.beforeShot.runId !== parsed.data.runId ||
      !digest.safeParse(parsed.data.nativeDigest).success) throw new Error('amend_recovery_intent_invalid');
  return { recovery: parsed.data, dispatchTarget: target };
}

/** Hold the same exact saved stay while reading and committing the positive recovery receipt. */
export async function withAmendRecoveryLock<T>(intent: HmsLabtestIntent, action: () => Promise<T>): Promise<T> {
  const { recovery, dispatchTarget } = checkedRecovery(intent);
  const resolved = paneStayHmsTargetForTransport(intent.transportId);
  const keys = ['propertyCode', 'secretId', 'browserSlot', 'origin', 'installationEnvName'] as const;
  if (!resolved.ok || keys.some((key) => resolved.target[key] !== CENTURION_HMS_READ_TARGET[key])) {
    throw new Error('amend_recovery_property_unavailable');
  }
  const parsedTarget = hmsDispatchTargetSchema.safeParse(dispatchTarget);
  const normalizedTarget = parsedTarget.success ? parsedTarget.data : null;
  const lock = normalizedTarget
    ? paneStayCloudTargetLock(resolved.target, normalizedTarget, { kind: 'independent_cloud' }) : null;
  if (!lock || !normalizedTarget || hmsDispatchTargetKey(dispatchTarget) !== hmsDispatchTargetKey(normalizedTarget) ||
      !recovery.selected.confirmation || !recovery.selected.reservationStayId) {
    throw new Error('amend_recovery_target_lock_unavailable');
  }
  return lock.withLock(() => recoveryLock.run({ holdId: intent.holdId,
    targetKey: hmsDispatchTargetKey(dispatchTarget), target: resolved.target }, action),
  acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
}

/** Re-read the approved native after-state in a fresh guarded session; never retries Save. */
export async function proveAmendRecovery(_db: DB, intent: HmsLabtestIntent): Promise<AmendRecoveryProof> {
  const { recovery, dispatchTarget } = checkedRecovery(intent), locked = recoveryLock.getStore();
  const owner = `${intent.actorUserId}:${intent.transportId}`;
  if (!locked || locked.holdId !== intent.holdId || locked.targetKey !== hmsDispatchTargetKey(dispatchTarget) ||
      !await verifyStoredHmsShot({ ...recovery.beforeShot, name: 'before.png', owner,
        propertyCode: 'HRCEN', workItemId: intent.workItemId }, 'before.png')) {
    throw new Error('amend_recovery_before_image_unverified');
  }
  const work = await mkdtemp(join(tmpdir(), 'hms-amend-recovery-'));
  const screenshot = join(work, 'saved.png'), recoveryRunId = randomUUID();
  try {
    const native = await import(new URL('../../tooling/hms-cloud/pane-amend-session.mjs', import.meta.url).href) as {
      readCloudPaneAmend(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    const selected = recovery.selected;
    const observed = await native.readCloudPaneAmend({ target: locked.target, selected,
      confirmation: selected.confirmation, arrival: selected.arrival, changes: recovery.approved,
      allowRealGuest: true, beforeNote: recovery.recoveryBaseline.beforeNote,
      beforeParties: recovery.recoveryBaseline.beforeParties, beforeRecipient: recovery.recoveryBaseline.beforeRecipient,
      beforeGuestEmail: recovery.recoveryBaseline.beforeGuestEmail,
      beforeBookerName: recovery.recoveryBaseline.beforeBookerName,
      beforeBookerContact: recovery.recoveryBaseline.beforeBookerContact,
      beforeGuaranteeCode: recovery.recoveryBaseline.beforeGuaranteeCode,
      beforeSavedRates: recovery.recoveryBaseline.beforeSavedRates, approvedPrices: recovery.approvedPrices,
      afterScreenshot: screenshot, signal: AbortSignal.timeout(8 * 60_000) });
    const readback = row(observed.readback);
    if (observed.outcome !== 'matched' || !readback || !approvedReadbackMatches(readback, recovery) ||
        readback.confirmation !== dispatchTarget.confirmation || readback.nativeStayId !== dispatchTarget.nativeStayId) {
      throw new Error('amend_recovery_readback_not_positive');
    }
    const stage = await mkdtemp(join(tmpdir(), 'hms-amend-recovery-shot-'));
    try {
      await copyFile(screenshot, join(stage, 'saved.png'));
      const shots = await persistHmsShots({ propertyCode: 'HRCEN', workItemId: intent.workItemId,
        runId: recoveryRunId, sourceDir: stage, owner, now: Date.now() });
      const shot = shots?.find((item) => item.name === 'saved.png');
      if (!shot || !await verifyStoredHmsShot({ runId: recoveryRunId, name: 'saved.png', sha256: shot.sha256,
        owner, propertyCode: 'HRCEN', workItemId: intent.workItemId }, 'saved.png')) {
        throw new Error('amend_recovery_saved_image_unverified');
      }
      return { confirmation: String(readback.confirmation), nativeStayId: String(readback.nativeStayId),
        nativeReadback: readback, readbackDigest: sha256(readback), savedShot: { runId: recoveryRunId, sha256: shot.sha256 } };
    } finally { await rm(stage, { recursive: true, force: true }); }
  } finally { await rm(work, { recursive: true, force: true }); }
}

/** Resolve only the exact unknown v2 operation bound into the original durable Amend intent. */
export async function recordRecoveredAmend(tx: CreateFenceTransaction, intent: HmsLabtestIntent, proof: AmendRecoveryProof): Promise<void> {
  const { recovery, dispatchTarget } = checkedRecovery(intent);
  if (proof.confirmation !== dispatchTarget.confirmation || proof.nativeStayId !== dispatchTarget.nativeStayId ||
      proof.savedShot.runId === recovery.runId || proof.readbackDigest !== sha256(proof.nativeReadback) ||
      !approvedReadbackMatches(proof.nativeReadback, recovery)) throw new Error('amend_recovery_proof_scope_changed');
  const owner = `${intent.actorUserId}:${intent.transportId}`;
  if (!await verifyStoredHmsShot({ ...recovery.beforeShot, name: 'before.png', owner, propertyCode: 'HRCEN',
    workItemId: intent.workItemId }, 'before.png') ||
      !await verifyStoredHmsShot({ ...proof.savedShot, name: 'saved.png', owner, propertyCode: 'HRCEN',
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
      draft.propertyCode !== 'HRCEN' || intent.sourceDigest !== draft.source.sourceHash ||
      prior.draftRevision !== recovery.draftRevision || canonicalJson(preparedResult.target) !== canonicalJson(recovery.approvedAfter) ||
      canonicalJson(preparedResult.before) !== canonicalJson(recovery.selected) ||
      canonicalJson(preparedResult.nativeChanges) !== canonicalJson(recovery.approved) ||
      canonicalJson(preparedResult.preserved) !== canonicalJson(recovery.preserved) ||
      canonicalJson(preparedResult.recoveryBaseline) !== canonicalJson(recovery.recoveryBaseline) ||
      preparedResult.nativeDigest !== recovery.nativeDigest ||
      canonicalJson(preparedResult.approvedPrices) !== canonicalJson(recovery.approvedPrices)) {
    throw new Error('reservation_workflow_v2_amend_recovery_scope_changed');
  }
  const observation: ReservationWorkflowV2Observation = {
    ref: randomUUID(), generationId: draft.generationId, kind: 'stay_candidate', status: 'complete',
    observedAt: new Date().toISOString(), propertyCode: 'HRCEN', sourceMessageId: draft.source.messageId, sourceRefs: [],
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
