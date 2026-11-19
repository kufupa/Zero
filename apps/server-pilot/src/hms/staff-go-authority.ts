import { and, eq, inArray, sql } from 'drizzle-orm';
import type { CreateFenceTransaction } from '../ai/pane-create-dispatch-fence.js';
import { aiWorkflowRun, mailThread, message } from '../db/schema/mail.js';
import { workEvent, workItem } from '../db/schema/work.js';
import { canonicalJson } from '../ai/draft-approval.js';
import { formDigest } from '../ai/hms-approval.js';
import { lockCreateActorAccess, lockCreateActorSession } from '../ai/pane-create-actor-lock.js';
import type { AiRunFence } from '../ai/run-ledger.js';
import { staffQuoteSourceHash } from '../ai/staff-quote-workflow.js';
import { hmsWriteGrantV2Schema, loadHmsPreparation, preparationDigest, hmsConfigurationIdentities,
  hmsWorkflowForOperation, type HmsPreparation, type HmsWriteGrantV2 } from './hms-preparation.js';
import { resolvePropertyScope } from './property-registry.js';
import { propertyConfigurationForScope } from './rate-catalogue.js';

const verifiedStaffGo = Symbol('verified-staff-go');
export type VerifiedStaffGo = Readonly<{
  [verifiedStaffGo]: true;
  actorUserId: string; sessionId: string; sessionProfile: 'legacy' | 'remote';
  grant: HmsWriteGrantV2; preparation: HmsPreparation; payloadHash: string;
}>;

/** Private worker boundary: authority comes only from a currently fenced, durable run. */
export async function verifyStaffGoForRun(db: CreateFenceTransaction, fence: AiRunFence, allowConsumed = false): Promise<VerifiedStaffGo> {
  const [run] = await db.select({ id: aiWorkflowRun.id, workItemId: aiWorkflowRun.workItemId,
    transportId: aiWorkflowRun.transportId, threadId: aiWorkflowRun.threadId,
    triggerMessageId: aiWorkflowRun.triggerMessageId, idempotencyKey: aiWorkflowRun.idempotencyKey,
    deadlineAt: aiWorkflowRun.deadlineAt, databaseNow: sql<string>`clock_timestamp()::text` })
    .from(aiWorkflowRun).where(and(eq(aiWorkflowRun.id, fence.runId),
      eq(aiWorkflowRun.claimOwner, fence.claimOwner), eq(aiWorkflowRun.claimToken, fence.claimToken),
      eq(aiWorkflowRun.runKind, 'hms_write'), eq(aiWorkflowRun.executorLane, 'hms'),
      inArray(aiWorkflowRun.state, ['claimed', 'running']))).limit(1).for('update');
  const now = Date.parse(run?.databaseNow ?? '');
  if (!run?.workItemId || !run.deadlineAt || !Number.isFinite(now) ||
      run.deadlineAt.getTime() !== fence.deadlineAt.getTime() || now >= run.deadlineAt.getTime()) {
    throw new Error('hms_staff_go_lease_lost');
  }
  const grantId = /^hms-write:([a-f0-9-]{36})$/.exec(run.idempotencyKey)?.[1];
  if (!grantId) throw new Error('hms_staff_go_missing');
  const [event] = await db.select().from(workEvent).where(and(eq(workEvent.id, grantId),
    eq(workEvent.workItemId, run.workItemId), eq(workEvent.type, 'approval.granted'))).limit(1).for('share');
  const parsed = hmsWriteGrantV2Schema.safeParse(event?.value);
  if (!parsed.success || event?.actorKind !== 'user' || event.actorUserId !== parsed.data.actorUserId ||
      event.payloadHash !== preparationDigest(parsed.data) || event.expiresAt?.getTime() !== Date.parse(parsed.data.expiresAt)) {
    throw new Error('hms_staff_go_receipt_invalid');
  }
  const grant = parsed.data;
  const prepared = await loadHmsPreparation(db, grant.preparedRef, run.workItemId);
  const [item] = await db.select().from(workItem).where(eq(workItem.id, run.workItemId)).limit(1).for('update');
  // The v2 engine is retired; its preparations can never authorize a write.
  if (prepared.workflowContext) throw new Error('hms_staff_go_receipt_invalid');
  const scope = resolvePropertyScope({ transportId: grant.transportId,
    ...(grant.propertyCode === 'HRCEN' ? {} : { propertySwitch: grant.propertyCode }) });
  const configuration = await propertyConfigurationForScope(scope);
  const current = hmsConfigurationIdentities(scope, configuration, prepared.operation);
  if (current.policyIdentity !== prepared.policyIdentity || current.catalogueIdentity !== prepared.catalogueIdentity ||
      !['lab', 'staff-enabled'].includes(configuration.capabilities[hmsWorkflowForOperation(prepared.operation)].status)) {
    throw new Error('hms_staff_go_configuration_changed');
  }
  if (!item || item.status === 'done' || item.status === 'dismissed' ||
      grant.grantId !== grantId || grant.workItemId !== item.id || grant.transportId !== run.transportId ||
      item.transportId !== run.transportId || grant.threadId !== item.threadId || grant.threadId !== run.threadId ||
      grant.sourceMessageId !== item.sourceMessageId || grant.sourceMessageId !== run.triggerMessageId ||
      grant.expectedRevision !== item.revisionSeq || prepared.revision !== grant.expectedRevision ||
      prepared.generationId !== grant.generationId ||
      (typeof item.state.generationId === 'string' && item.state.generationId !== grant.generationId) ||
      (typeof item.state.propertyCode === 'string' && item.state.propertyCode !== grant.propertyCode) ||
      canonicalJson(scope) !== canonicalJson(prepared.scope) || grant.propertyCode !== scope.propertyCode ||
      grant.tenantId !== scope.tenantId || grant.businessDigest !== formDigest(item.state) ||
      grant.businessDigest !== prepared.businessDigest || grant.targetDigest !== prepared.targetDigest ||
      grant.operation !== prepared.operation || grant.hmsBeforeDigest !== prepared.nativeObservation.beforeDigest ||
      grant.hmsReadAt !== prepared.nativeObservation.capturedAt ||
      canonicalJson(prepared.source) !== canonicalJson({ transportId: grant.transportId, threadId: grant.threadId,
        sourceMessageId: grant.sourceMessageId, sourceHash: grant.sourceHash,
        ...(grant.attachment ? { attachment: grant.attachment } : {}) }) ||
      canonicalJson(prepared.session) !== canonicalJson({ actorUserId: grant.actorUserId,
        sessionId: grant.sessionId, sessionProfile: grant.sessionProfile }) ||
      now < Date.parse(grant.issuedAt) || now >= Date.parse(grant.expiresAt) || now >= Date.parse(prepared.expiresAt)) {
    throw new Error('hms_staff_go_state_changed');
  }
  await lockCreateActorAccess(db, { transportId: grant.transportId, actorUserId: grant.actorUserId });
  await lockCreateActorSession(db, { actorUserId: grant.actorUserId, sessionId: grant.sessionId, sessionProfile: grant.sessionProfile });
  const [thread] = await db.select().from(mailThread).where(and(eq(mailThread.id, grant.threadId),
    eq(mailThread.transportId, grant.transportId))).limit(1).for('share');
  const [mail] = await db.select().from(message).where(and(eq(message.id, grant.sourceMessageId),
    eq(message.threadId, grant.threadId), eq(message.transportId, grant.transportId))).limit(1).for('share');
  if (!thread || thread.historyOnly || thread.trashedAt !== null || !mail || mail.direction !== 'inbound' ||
      mail.historyOnly || mail.sourceProvenance?.attention != null || staffQuoteSourceHash(mail) !== grant.sourceHash) {
    throw new Error('hms_staff_go_source_changed');
  }
  const [used] = await db.select({ id: workEvent.id, value: workEvent.value }).from(workEvent)
    .where(and(eq(workEvent.workItemId, item.id), eq(workEvent.type, 'approval.consumed'),
      eq(workEvent.payloadHash, event.payloadHash))).limit(1).for('share');
  if (used && (!allowConsumed || !used.value || typeof used.value !== 'object' ||
      !('runId' in used.value) || used.value.runId !== run.id)) throw new Error('hms_staff_go_already_consumed');
  return Object.freeze({ [verifiedStaffGo]: true, actorUserId: grant.actorUserId,
    sessionId: grant.sessionId, sessionProfile: grant.sessionProfile,
    grant, preparation: prepared, payloadHash: event.payloadHash } satisfies VerifiedStaffGo);
}
