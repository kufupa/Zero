import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { workEvent } from '../db/schema/work.js';
import { acquisitionWithin, PANE_PROPERTY_LOCK_WAIT_MS } from '../hms/property-read-lock.js';
import { getS3Storage } from '../storage/s3.js';
import { canonicalJson } from './draft-approval.js';
import { hmsWriteEvidenceKey, recordHmsWriteEvidence } from './hms-approval.js';
import { hmsDispatchTargetKey } from './hms-dispatch-target.js';
import { hmsLabtestIntentTarget, type HmsLabtestIntent } from './hms-labtest-dispatch.js';
import { cloudCancelDispatchSchema } from './pane-cloud-cancel.js';
import type { CreateFenceTransaction } from './pane-create-dispatch-fence.js';
import { paneStayCloudTargetLock } from './pane-stay-save.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z.object({ eventId: z.string().uuid(), sha256: digest }).strict();
const recoverySchema = z.object({ confirmation: z.string().regex(/^\d+-\d+$/), nativeStayId: z.string().regex(/^\d{1,100}$/),
  preimage: cloudCancelDispatchSchema.shape.preimage, reasonCode: cloudCancelDispatchSchema.shape.reasonCode,
  reasonLabel: cloudCancelDispatchSchema.shape.reasonLabel, cancellationNote: cloudCancelDispatchSchema.shape.cancellationNote,
  cloudTargetKey: z.string().min(1).max(1024), runId: z.string().uuid(), claimDigest: digest, before: receipt }).strict();
const readbackSchema = z.object({ confirmation: z.string(), nativeStayId: z.string().regex(/^\d{1,100}$/),
  nativeGuestId: z.string().regex(/^\d{1,30}$/), status: z.string().regex(/^cancel(?:l)?ed$/i),
  reasonCode: z.string(), cancellationNote: z.string() }).strict();
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const lockedTarget = new AsyncLocalStorage<{ holdId: string; nativeStayId: string }>();

type CancelRecoveryProof = { confirmation: string; nativeStayId: string; nativeReadback: z.infer<typeof readbackSchema>;
  readbackDigest: string; savedShot: { runId: string; sha256: string };
  screenshot: { eventId: string; sha256: string; name: string } };

function recoveryOf(intent: HmsLabtestIntent) {
  const parsed = recoverySchema.safeParse(intent.recovery);
  const target = hmsLabtestIntentTarget(intent);
  if (!parsed.success || intent.operation !== 'cancel' || target?.kind !== 'saved' || target.propertyCode !== intent.propertyCode ||
      (parsed.data.preimage.propertyCode ?? 'HRCEN') !== intent.propertyCode ||
      !target.nativeStayId || !target.confirmation || target.nativeStayId !== parsed.data.nativeStayId ||
      target.confirmation !== parsed.data.confirmation || parsed.data.preimage.nativeStayId !== target.nativeStayId ||
      parsed.data.preimage.confirmation !== target.confirmation || parsed.data.preimage.guestId !== intent.nativeGuestId ||
      parsed.data.preimage.firstName !== intent.firstName || parsed.data.preimage.lastName !== intent.lastName ||
      hmsDispatchTargetKey(target) !== parsed.data.cloudTargetKey) throw new Error('cancel_recovery_scope_changed');
  return { recovery: parsed.data, target };
}

/** Recover under the same target lock; the new session must be independently owned. */
export async function withCancelRecoveryLock<T>(intent: HmsLabtestIntent, action: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  const { target: dispatchTarget } = recoveryOf(intent);
  const target = paneStayHmsTargetForTransport(intent.transportId, intent.propertyCode);
  if (!target.ok || target.target.propertyCode !== intent.propertyCode) {
    throw new Error('cancel_recovery_property_unavailable');
  }
  const lock = paneStayCloudTargetLock(target.target, dispatchTarget, { kind: 'independent_cloud' });
  if (!lock || !dispatchTarget.nativeStayId) throw new Error('cancel_recovery_lock_unavailable');
  return lock.withLock((signal) => lockedTarget.run({ holdId: intent.holdId, nativeStayId: dispatchTarget.nativeStayId! }, () => action(signal)),
    acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
}

/** Collect identity evidence for a held cancellation; this cannot prove whether a fee appeared. */
export async function proveCancelRecovery(db: DB, intent: HmsLabtestIntent, signal?: AbortSignal): Promise<CancelRecoveryProof> {
  const { recovery } = recoveryOf(intent), scope = lockedTarget.getStore();
  if (!scope || scope.holdId !== intent.holdId || scope.nativeStayId !== recovery.nativeStayId) {
    throw new Error('cancel_recovery_lock_unavailable');
  }
  const beforeKey = hmsWriteEvidenceKey({ transportId: intent.transportId, workItemId: intent.workItemId,
    runId: recovery.runId, name: 'before.png' });
  const [before] = await db.select({ actorKind: workEvent.actorKind, value: workEvent.value, evidence: workEvent.evidence })
    .from(workEvent).where(and(eq(workEvent.id, recovery.before.eventId), eq(workEvent.workItemId, intent.workItemId),
      eq(workEvent.type, 'write.evidence'))).limit(1);
  const value = z.object({ runId: z.string(), name: z.string() }).safeParse(before?.value);
  const evidence = z.object({ key: z.string(), sha256: digest }).passthrough().safeParse(before?.evidence);
  if (before?.actorKind !== 'system' || !value.success || value.data.runId !== recovery.runId || value.data.name !== 'before.png' ||
      !evidence.success || evidence.data.key !== beforeKey || evidence.data.sha256 !== recovery.before.sha256) {
    throw new Error('cancel_recovery_evidence_unavailable');
  }
  const beforeObject = await getS3Storage().getObjectBounded(beforeKey, 10 * 1024 * 1024);
  if (!beforeObject || !pngSignature.equals(beforeObject.body.subarray(0, pngSignature.length)) ||
      sha256(beforeObject.body) !== recovery.before.sha256) throw new Error('cancel_recovery_evidence_unavailable');
  const reader = await import('../../tooling/hms-cloud/pane-cancel-session.mjs' as string) as {
    provePositiveCancelRecovery(intent: HmsLabtestIntent, options?: { signal?: AbortSignal }): Promise<{ outcome: string; confirmation?: unknown;
      readback?: unknown; screenshot?: unknown }>;
  };
  const observed = await reader.provePositiveCancelRecovery(intent, { signal }), readback = readbackSchema.safeParse(observed.readback);
  if (observed.outcome !== 'verified' || observed.confirmation !== recovery.confirmation || !readback.success ||
      readback.data.confirmation !== recovery.confirmation || readback.data.nativeStayId !== recovery.nativeStayId ||
      readback.data.nativeGuestId !== intent.nativeGuestId || readback.data.reasonCode !== recovery.reasonCode ||
      readback.data.cancellationNote !== recovery.cancellationNote || !Buffer.isBuffer(observed.screenshot)) {
    throw new Error('cancel_recovery_readback_unavailable');
  }
  const name = `recovery-${randomBytes(8).toString('hex')}.png`;
  const sealed = await recordHmsWriteEvidence({ db, transportId: intent.transportId, workItemId: intent.workItemId,
    runId: recovery.runId, name, png: observed.screenshot });
  const stored = await getS3Storage().getObjectBounded(sealed.key, 10 * 1024 * 1024);
  if (!stored || !pngSignature.equals(stored.body.subarray(0, pngSignature.length)) || sha256(stored.body) !== sealed.sha256) {
    throw new Error('cancel_recovery_evidence_unavailable');
  }
  return { confirmation: readback.data.confirmation, nativeStayId: readback.data.nativeStayId,
    nativeReadback: readback.data, readbackDigest: sha256(canonicalJson(readback.data)),
    savedShot: { runId: recovery.runId, sha256: sealed.sha256 },
    screenshot: { eventId: sealed.eventId, sha256: sealed.sha256, name } };
}

/** Native status alone cannot prove a crash did not interrupt a penalty dialog. */
export async function recordRecoveredCancel(_tx: CreateFenceTransaction, _intent: HmsLabtestIntent,
  _proof: CancelRecoveryProof): Promise<never> {
  throw new Error('cancel_recovery_penalty_unverified');
}
