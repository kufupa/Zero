import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import { workEvent, workItem } from '../db/schema/work.js';
import { CENTURION_HMS_READ_TARGET } from '../hms/hms-read-target.js';
import { acquisitionWithin, PANE_PROPERTY_LOCK_WAIT_MS } from '../hms/property-read-lock.js';
import { getS3Storage } from '../storage/s3.js';
import { canonicalJson } from './draft-approval.js';
import { hmsWriteEvidenceKey, readVerifiedHmsWriteGrant, recordHmsWriteEvidence } from './hms-approval.js';
import { hmsDispatchTargetKey } from './hms-dispatch-target.js';
import { hmsLabtestIntentTarget, type HmsLabtestIntent } from './hms-labtest-dispatch.js';
import type { CreateFenceTransaction } from './pane-create-dispatch-fence.js';
import { paneStayCloudTargetLock } from './pane-stay-save.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { HMS_LABTEST_ATTACH_PROMPT_VERSION, HMS_WRITE_RUN_KIND, mergeTerminalRunMetrics, type AiRunFence } from './run-ledger.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z.object({ eventId: z.string().uuid(), sha256: digest }).strict();
const readbackSchema = z.object({ confirmation: z.string(), nativeStayId: z.string().regex(/^\d{1,100}$/),
  nativeGuestId: z.string(), documentCode: z.string(),
  documentName: z.string(), uniqueFreshListing: z.literal(true) }).strict();
const recoverySchema = z.object({
  confirmation: z.string().regex(/^\d+-\d+$/), arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departure: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), documentCode: z.string().regex(/^NAVA[A-Z2-7]{25}[AEIMQUY4]$/),
  documentName: z.string().max(120).refine((s) => /\.pdf$/i.test(s) && !/[\\/\p{Cc}]/u.test(s) && s === s.replace(/\s+/g, ' ').trim()),
  pdfSha256: digest, runId: z.string().uuid(), claimDigest: digest, before: receipt, writer: z.unknown().optional(),
  nativeStayId: z.string().regex(/^\d{1,100}$/).optional(), guestName: z.string().min(1).max(401).optional(),
  allowRealGuest: z.boolean().optional(), cloudTargetKey: z.string().max(1024).optional(),
}).strict();
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const recoveryTarget = new AsyncLocalStorage<{ holdId: string; nativeStayId: string }>();

type AttachRecoveryProof = { confirmation: string; nativeStayId: string; nativeReadback: z.infer<typeof readbackSchema>;
  readbackDigest: string; savedShot: { runId: string; sha256: string };
  screenshot: { eventId: string; sha256: string; name: string } };

/** Reset only the original run after its native upload gate proves no dispatch. */
export async function recordNeverDispatchedAttach(tx: CreateFenceTransaction, intent: HmsLabtestIntent, fence: AiRunFence) {
  const parsed = recoverySchema.safeParse(intent.recovery);
  if (!parsed.success || intent.operation !== 'attach_document' || parsed.data.runId !== fence.runId ||
      parsed.data.claimDigest !== sha256(canonicalJson({ claimOwner: fence.claimOwner, claimToken: fence.claimToken }))) {
    throw new Error('filing_no_dispatch_scope_changed');
  }
  // Match endHmsWriteRun's run-before-item lock order if its timeout races us.
  const [run] = await tx.select().from(aiWorkflowRun).where(and(eq(aiWorkflowRun.id, fence.runId),
    eq(aiWorkflowRun.workItemId, intent.workItemId), eq(aiWorkflowRun.transportId, intent.transportId),
    eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND), eq(aiWorkflowRun.promptVersion, HMS_LABTEST_ATTACH_PROMPT_VERSION),
    eq(aiWorkflowRun.idempotencyKey, `hms-write:${intent.grantId}`))).limit(1).for('update');
  const active = run && ['claimed', 'running'].includes(run.state) && run.claimOwner === fence.claimOwner && run.claimToken === fence.claimToken;
  const endedUnknown = run?.state === 'dead_letter' &&
    ['UNKNOWN', 'LEASE_LOST', 'RUN_DEADLINE', 'WORKER_SHUTDOWN', 'NEEDS_CHECK'].includes(run.failureClass ?? '');
  if (!active && !endedUnknown) throw new Error('filing_no_dispatch_run_changed');
  const [item] = await tx.select({ id: workItem.id }).from(workItem)
    .where(and(eq(workItem.id, intent.workItemId), eq(workItem.transportId, intent.transportId))).limit(1).for('update');
  if (!item) throw new Error('filing_no_dispatch_item_changed');
  const now = new Date(), reason = 'filing_not_dispatched';
  await tx.update(aiWorkflowRun).set({ state: 'dead_letter', failureClass: 'NEEDS_CHECK', lastError: reason,
    claimOwner: null, claimToken: null, finishedAt: now, updatedAt: now }).where(eq(aiWorkflowRun.id, fence.runId));
  await tx.update(workItem).set({ state: sql`${workItem.state} - 'hmsSnapshot'`, updatedAt: now }).where(eq(workItem.id, intent.workItemId));
  await tx.insert(workEvent).values({ workItemId: intent.workItemId, at: now, actorKind: 'system', type: 'status.changed',
    value: { needsCheck: true, runId: fence.runId, failureClass: 'NEEDS_CHECK', reason } });
}

/** The same verified booking target protects the original write and recovery. */
export async function withAttachRecoveryLock<T>(intent: HmsLabtestIntent, action: () => Promise<T>): Promise<T> {
  const target = paneStayHmsTargetForTransport(intent.transportId);
  const keys = ['propertyCode', 'secretId', 'browserSlot', 'origin', 'installationEnvName'] as const;
  if (!target.ok || keys.some((key) => target.target[key] !== CENTURION_HMS_READ_TARGET[key])) {
    throw new Error('filing_recovery_property_unavailable');
  }
  let dispatchTarget = hmsLabtestIntentTarget(intent);
  const recovery = recoverySchema.safeParse(intent.recovery);
  if (!recovery.success || intent.operation !== 'attach_document') throw new Error('filing_recovery_unavailable');
  if (dispatchTarget?.kind === 'saved' && !dispatchTarget.nativeStayId) {
    if (recovery.data.cloudTargetKey) throw new Error('filing_recovery_target_unavailable');
    // Older intents can lack the native alias. Establish it from a fresh
    // native read before taking the target lock, then prove it again inside.
    const reader = await import('../../tooling/hms-cloud/pane-attach-session.mjs' as string) as {
      provePositiveAttachRecovery(intent: HmsLabtestIntent): Promise<{ outcome: string; readback?: unknown }>;
    };
    const observed = await reader.provePositiveAttachRecovery(intent);
    const readback = readbackSchema.safeParse(observed.readback);
    if (observed.outcome !== 'verified' || !readback.success || readback.data.confirmation !== dispatchTarget.confirmation) {
      throw new Error('filing_recovery_target_unavailable');
    }
    dispatchTarget = { ...dispatchTarget, nativeStayId: readback.data.nativeStayId };
  }
  const lock = dispatchTarget?.kind === 'saved'
    ? paneStayCloudTargetLock(target.target, dispatchTarget, { kind: 'independent_cloud' }) : null;
  if (!lock) throw new Error('filing_recovery_lock_unavailable');
  const nativeStayId = dispatchTarget?.kind === 'saved' ? dispatchTarget.nativeStayId : undefined;
  if (!nativeStayId) throw new Error('filing_recovery_target_unavailable');
  if (recovery.data.cloudTargetKey && recovery.data.cloudTargetKey !== hmsDispatchTargetKey(dispatchTarget!)) {
    throw new Error('filing_recovery_target_unavailable');
  }
  return lock.withLock(() => recoveryTarget.run({ holdId: intent.holdId, nativeStayId }, action),
    acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
}

/** Verify the sealed before-image and obtain a fresh, independent positive listing. */
export async function proveAttachRecovery(db: DB, intent: HmsLabtestIntent): Promise<AttachRecoveryProof> {
  const parsed = recoverySchema.safeParse(intent.recovery);
  if (!parsed.success || intent.operation !== 'attach_document') throw new Error('filing_recovery_unavailable');
  const recovery = parsed.data;
  const beforeKey = hmsWriteEvidenceKey({ transportId: intent.transportId, workItemId: intent.workItemId,
    runId: recovery.runId, name: 'before.png' });
  const [before] = await db.select({ actorKind: workEvent.actorKind, value: workEvent.value, evidence: workEvent.evidence })
    .from(workEvent).where(and(eq(workEvent.id, recovery.before.eventId), eq(workEvent.workItemId, intent.workItemId),
      eq(workEvent.type, 'write.evidence'))).limit(1);
  const beforeValue = z.object({ runId: z.string(), name: z.string() }).safeParse(before?.value);
  const beforeEvidence = z.object({ key: z.string(), sha256: digest }).passthrough().safeParse(before?.evidence);
  if (before?.actorKind !== 'system' || !beforeValue.success || beforeValue.data.runId !== recovery.runId ||
      beforeValue.data.name !== 'before.png' || !beforeEvidence.success || beforeEvidence.data.key !== beforeKey ||
      beforeEvidence.data.sha256 !== recovery.before.sha256) throw new Error('filing_recovery_evidence_unavailable');
  const beforeObject = await getS3Storage().getObjectBounded(beforeKey, 10 * 1024 * 1024);
  if (!beforeObject || !pngSignature.equals(beforeObject.body.subarray(0, pngSignature.length)) ||
      sha256(beforeObject.body) !== recovery.before.sha256) throw new Error('filing_recovery_evidence_unavailable');
  const reader = await import('../../tooling/hms-cloud/pane-attach-session.mjs' as string) as {
    provePositiveAttachRecovery(intent: HmsLabtestIntent): Promise<{ outcome: string; confirmation?: unknown;
      readback?: unknown; screenshot?: unknown }>;
  };
  const observed = await reader.provePositiveAttachRecovery(intent);
  const readback = readbackSchema.safeParse(observed.readback);
  const lockedTarget = recoveryTarget.getStore();
  if (observed.outcome !== 'verified' || observed.confirmation !== recovery.confirmation || !readback.success ||
      !lockedTarget || lockedTarget.holdId !== intent.holdId || lockedTarget.nativeStayId !== readback.data.nativeStayId ||
      readback.data.confirmation !== recovery.confirmation || readback.data.nativeGuestId !== intent.nativeGuestId ||
      (recovery.nativeStayId !== undefined && readback.data.nativeStayId !== recovery.nativeStayId) ||
      readback.data.documentCode !== recovery.documentCode || readback.data.documentName !== recovery.documentName ||
      !Buffer.isBuffer(observed.screenshot)) throw new Error('filing_recovery_readback_unavailable');
  const name = `recovery-${randomBytes(8).toString('hex')}.png`;
  const sealed = await recordHmsWriteEvidence({ db, transportId: intent.transportId, workItemId: intent.workItemId,
    runId: recovery.runId, name, png: observed.screenshot });
  const stored = await getS3Storage().getObjectBounded(sealed.key, 10 * 1024 * 1024);
  if (!stored || !pngSignature.equals(stored.body.subarray(0, pngSignature.length)) || sha256(stored.body) !== sealed.sha256) {
    throw new Error('filing_recovery_evidence_unavailable');
  }
  return { confirmation: readback.data.confirmation, nativeStayId: readback.data.nativeStayId,
    nativeReadback: readback.data, readbackDigest: sha256(canonicalJson(readback.data)),
    savedShot: { runId: recovery.runId, sha256: sealed.sha256 },
    screenshot: { eventId: sealed.eventId, sha256: sealed.sha256, name } };
}

/** Mark only the original run, and resolve its hold in the caller's transaction. */
export async function recordRecoveredAttach(tx: CreateFenceTransaction, intent: HmsLabtestIntent, proof: AttachRecoveryProof) {
  const parsed = recoverySchema.safeParse(intent.recovery);
  if (!parsed.success || intent.operation !== 'attach_document' || proof.confirmation !== parsed.data.confirmation ||
      proof.savedShot.runId !== parsed.data.runId || proof.savedShot.sha256 !== proof.screenshot.sha256) {
    throw new Error('filing_recovery_scope_changed');
  }
  const recovery = parsed.data;
  const [run] = await tx.select().from(aiWorkflowRun).where(and(eq(aiWorkflowRun.id, recovery.runId),
    eq(aiWorkflowRun.workItemId, intent.workItemId), eq(aiWorkflowRun.transportId, intent.transportId),
    eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND), eq(aiWorkflowRun.promptVersion, HMS_LABTEST_ATTACH_PROMPT_VERSION),
    eq(aiWorkflowRun.idempotencyKey, `hms-write:${intent.grantId}`))).limit(1).for('update');
  if (!run || !(['claimed', 'running'].includes(run.state) ||
      (run.state === 'dead_letter' && ['UNKNOWN', 'LEASE_LOST', 'RUN_DEADLINE', 'WORKER_SHUTDOWN'].includes(run.failureClass ?? '')))) {
    throw new Error('filing_recovery_run_changed');
  }
  if (['claimed', 'running'].includes(run.state) && (!run.claimOwner || !run.claimToken ||
      sha256(canonicalJson({ claimOwner: run.claimOwner, claimToken: run.claimToken })) !== recovery.claimDigest)) {
    throw new Error('filing_recovery_run_changed');
  }
  const { grant, payloadHash } = await readVerifiedHmsWriteGrant(tx as DB, intent.workItemId, intent.grantId, true);
  if (grant.grantId !== intent.grantId || grant.workItemId !== intent.workItemId || grant.transportId !== intent.transportId ||
      grant.actorUserId !== intent.actorUserId || !grant.sessionId || !grant.sessionProfile || grant.formDigest !== intent.approvedDigest) {
    throw new Error('filing_recovery_grant_changed');
  }
  const consumed = await tx.select({ id: workEvent.id }).from(workEvent).where(and(eq(workEvent.workItemId, intent.workItemId),
    eq(workEvent.type, 'approval.consumed'), eq(workEvent.actorKind, 'system'), eq(workEvent.payloadHash, payloadHash),
    sql`${workEvent.value}->>'runId' = ${recovery.runId}`, sql`${workEvent.value}->>'grantId' = ${intent.grantId}`)).limit(2).for('share');
  if (consumed.length !== 1) throw new Error('filing_recovery_grant_changed');
  for (const [name, seal] of [['before.png', recovery.before], [proof.screenshot.name, proof.screenshot]] as const) {
    const [row] = await tx.select({ actorKind: workEvent.actorKind, value: workEvent.value, evidence: workEvent.evidence })
      .from(workEvent).where(and(eq(workEvent.id, seal.eventId), eq(workEvent.workItemId, intent.workItemId),
        eq(workEvent.type, 'write.evidence'))).limit(1).for('share');
    const value = z.object({ runId: z.string(), name: z.string() }).safeParse(row?.value);
    const evidence = z.object({ key: z.string(), sha256: digest }).passthrough().safeParse(row?.evidence);
    const key = hmsWriteEvidenceKey({ transportId: intent.transportId, workItemId: intent.workItemId, runId: recovery.runId, name });
    if (row?.actorKind !== 'system' || !value.success || value.data.runId !== recovery.runId || value.data.name !== name ||
        !evidence.success || evidence.data.key !== key || evidence.data.sha256 !== seal.sha256) {
      throw new Error('filing_recovery_evidence_changed');
    }
  }
  const now = new Date();
  await tx.update(aiWorkflowRun).set({ state: 'succeeded', failureClass: null, lastError: null,
    claimOwner: null, claimToken: null, finishedAt: now, updatedAt: now,
    metrics: mergeTerminalRunMetrics(run.metrics, { action: 'attach_document', outcome: 'confirmed', listed: true, recovered: true }),
  }).where(eq(aiWorkflowRun.id, recovery.runId));
  await tx.insert(workEvent).values({ workItemId: intent.workItemId, actorKind: 'system', type: 'write.evidence',
    value: { kind: 'hms_attach_verified', holdId: intent.holdId, grantId: intent.grantId,
      runId: recovery.runId, documentCode: recovery.documentCode, documentName: recovery.documentName,
      pdfSha256: recovery.pdfSha256, readbackDigest: proof.readbackDigest, recovered: true } });
}
