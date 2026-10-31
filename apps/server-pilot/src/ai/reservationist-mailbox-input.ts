import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiDraftGeneration, aiWorkflowRun, attachment, mailboxAccess, mailboxTransport, message } from '../db/schema/mail.js';
import { hashAuthorizedArtifactBytes, recheckAuthorizedArtifactIdentity, type AttachmentLocator, type SandboxRunner } from '../mail/artifacts/read-artifact.js';
import type { S3Storage } from '../storage/s3.js';
import { loadLiveThreadStateVersion } from './drafts.js';
import { MESSAGE_ARRIVED_AT } from './message-arrival-time.js';
import { deriveReplyToAddress } from './workflows/candidate-draft.js';
import { admitReservationistAttachment, type ReservationistOfficeConverter } from './reservationist-attachment-input.js';
import { buildReservationistWorkerInput, reservationistDisclosure, type ReservationistWorkerAttachment, type ReservationistWorkerMessage } from './reservationist-worker-input.js';
import { deriveArrivalDraftSources, draftSourceMessage, type ReservationistDraftSource } from './reservationist-draft-source.js';
import { deriveOperationalDraftSources } from './reservationist-operational-draft-source.js';
import type { ReservationistPersistedResult } from './drafts.js';
import type { RuntimePlan } from './reservationist-runtime.js';

/** Load only the current run's mailbox context, under its requesting user's live grant. */
export async function loadReservationistMailboxInput(options: {
  db: DB;
  runId: string;
  claimOwner: string;
  claimToken: string;
  deadlineAt: Date;
  propertyCode: string;
  s3: S3Storage;
  signal: AbortSignal;
  runner?: SandboxRunner;
  officeConverter?: ReservationistOfficeConverter;
}) {
  const { db, signal } = options;
  if (!options.runId || !options.claimOwner || !options.claimToken || !options.propertyCode ||
      !(options.deadlineAt instanceof Date) || !Number.isFinite(options.deadlineAt.getTime()) ||
      options.deadlineAt.getTime() <= Date.now()) throw new Error('mailbox_input_scope_invalid');

  const capture = async () => {
    signal.throwIfAborted();
    const [binding] = await db.select({
      id: aiWorkflowRun.id, transportId: aiWorkflowRun.transportId, threadId: aiWorkflowRun.threadId,
      triggerId: aiWorkflowRun.triggerMessageId, generationId: aiDraftGeneration.id,
      requestedByUserId: aiDraftGeneration.requestedByUserId, deadlineAt: aiWorkflowRun.deadlineAt,
      grantId: mailboxAccess.id, grantRole: mailboxAccess.role, grantUpdatedAt: mailboxAccess.updatedAt,
    }).from(aiWorkflowRun)
      .innerJoin(aiDraftGeneration, and(eq(aiWorkflowRun.generationId, aiDraftGeneration.id),
        eq(aiWorkflowRun.transportId, aiDraftGeneration.transportId), eq(aiWorkflowRun.threadId, aiDraftGeneration.threadId)))
      .innerJoin(mailboxAccess, and(eq(mailboxAccess.transportId, aiWorkflowRun.transportId),
        eq(mailboxAccess.userId, aiDraftGeneration.requestedByUserId)))
      .innerJoin(mailboxTransport, and(eq(mailboxTransport.id, aiWorkflowRun.transportId), eq(mailboxTransport.isActive, true)))
      .where(and(eq(aiWorkflowRun.id, options.runId), eq(aiWorkflowRun.runKind, 'candidate_draft'),
        eq(aiWorkflowRun.executorLane, 'default'), eq(aiWorkflowRun.state, 'running'),
        eq(aiWorkflowRun.claimOwner, options.claimOwner), eq(aiWorkflowRun.claimToken, options.claimToken)))
      .limit(1);
    if (!binding || !binding.requestedByUserId || !binding.grantId || !binding.deadlineAt ||
        binding.deadlineAt.getTime() !== options.deadlineAt.getTime() || binding.deadlineAt.getTime() <= Date.now())
      throw new Error('mailbox_input_authority_unavailable');

    const [trigger] = await db.select({ id: message.id, fromAddress: message.fromAddress,
      arrivedAt: MESSAGE_ARRIVED_AT, createdAt: message.createdAt })
      .from(message).where(and(eq(message.id, binding.triggerId), eq(message.threadId, binding.threadId),
        eq(message.transportId, binding.transportId), eq(message.direction, 'inbound'))).limit(1);
    const triggerAt = trigger?.arrivedAt ?? trigger?.createdAt;
    if (!trigger || !triggerAt || !Number.isFinite(triggerAt.getTime())) throw new Error('mailbox_input_trigger_unavailable');

    const rows = await db.select({ id: message.id, transportId: message.transportId, threadId: message.threadId,
      direction: message.direction, fromAddress: message.fromAddress, toAddresses: message.toAddresses,
      ccAddresses: message.ccAddresses, bccAddresses: message.bccAddresses, textBody: message.textBody, htmlBody: message.htmlBody,
      subject: message.subject, receivedAt: message.receivedAt, sentAt: message.sentAt,
      arrivedAt: MESSAGE_ARRIVED_AT, createdAt: message.createdAt })
      .from(message).where(and(eq(message.threadId, binding.threadId), eq(message.transportId, binding.transportId),
        sql`${MESSAGE_ARRIVED_AT} <= ${triggerAt.toISOString()}::timestamp`))
      .orderBy(asc(MESSAGE_ARRIVED_AT), asc(message.id)).limit(65);
    if (rows.length > 64 || !rows.some((row) => row.id === trigger.id)) throw new Error('mailbox_input_context_unavailable');
    const ids = rows.map((row) => row.id);
    const files = await db.select({ id: attachment.id, messageId: attachment.messageId, mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes, sha256: attachment.sha256, s3Key: attachment.s3Key,
      isInline: attachment.isInline, contentId: attachment.contentId })
      .from(attachment).innerJoin(message, eq(attachment.messageId, message.id))
      .where(and(eq(message.threadId, binding.threadId), eq(message.transportId, binding.transportId), inArray(message.id, ids)))
      .orderBy(asc(attachment.id)).limit(257);
    if (files.length > 256) throw new Error('mailbox_input_attachment_limit');
    const threadStateVersion = await loadLiveThreadStateVersion(db, { transportId: binding.transportId, threadId: binding.threadId });
    signal.throwIfAborted();
    return { binding, trigger, rows, files, threadStateVersion };
  };

  const snapshot = await capture();
  const digest = (value: typeof snapshot) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const initialDigest = digest(snapshot);
  const sameSnapshot = async () => {
    try { return digest(await capture()) === initialDigest; }
    catch { signal.throwIfAborted(); return false; }
  };
  const triggerAt = snapshot.trigger.arrivedAt ?? snapshot.trigger.createdAt;
  const guestAddress = deriveReplyToAddress(snapshot.trigger.fromAddress)?.toLowerCase();
  if (!guestAddress) throw new Error('mailbox_input_trigger_unavailable');
  const messages: ReservationistWorkerMessage[] = snapshot.rows.map((row) => ({
    ...row, disclosure: reservationistDisclosure(row, guestAddress),
  }));
  const messageDisclosure = new Map(messages.map((row) => [row.id, row.disclosure]));
  const attachments: ReservationistWorkerAttachment[] = snapshot.files.map((file) => ({
    ...file, disclosure: messageDisclosure.get(file.messageId) ?? 'staff_only',
  }));
  const locators = new Map<string, AttachmentLocator>(snapshot.files.map((file) => [file.id, {
    messageId: file.messageId, mimeType: file.mimeType, sizeBytes: file.sizeBytes, s3Key: file.s3Key, sha256: file.sha256,
  }]));
  const authorized = new Set(snapshot.files.map((file) => file.id));
  const resolvedHashes = new Set<string>();
  const resolveLocator = async (id: string) => locators.get(id) ?? null;
  const read = (id: string, edge: AbortSignal) => ({
    attachmentId: id, authorizedAttachmentIds: authorized, s3: options.s3, signal: edge,
    expectedLocator: locators.get(id), resolveLocator, revalidate: sameSnapshot,
  });
  const built = await buildReservationistWorkerInput({
    transportId: snapshot.binding.transportId, threadId: snapshot.binding.threadId,
    triggerMessageId: snapshot.trigger.id, requestId: snapshot.trigger.id, propertyCode: options.propertyCode,
    messages, attachments, sourceAt: new Date().toISOString(), deadlineAt: options.deadlineAt.getTime(), signal,
    resolveSourceHash: async (file, edge) => {
      const expectedLocator = locators.get(file.id);
      const hash = expectedLocator ? await hashAuthorizedArtifactBytes({ ...read(file.id, edge), expectedLocator }) : null;
      if (hash) resolvedHashes.add(file.id);
      return hash;
    },
    admit: async (metadata, edge) => admitReservationistAttachment({ metadata,
      scope: { ownerRef: snapshot.binding.transportId, threadId: snapshot.binding.threadId, requestAt: triggerAt.toISOString() },
      read: read(metadata.attachmentId, edge), runner: options.runner, officeConverter: options.officeConverter,
    }),
  });
  if (!await sameSnapshot()) throw new Error('mailbox_input_changed');
  const result = { ...built, threadStateVersion: snapshot.threadStateVersion,
    requestedByUserId: snapshot.binding.requestedByUserId, generationId: snapshot.binding.generationId };
  const admissionFingerprint = () => result.admissions.map((admission) => ({
    status: admission.status, reason: admission.reason, relation: admission.relation,
    metadata: admission.metadata, source: admission.source,
    bytes: admission.bytes && { sha256: createHash('sha256').update(admission.bytes.body).digest('hex'),
      contentType: admission.bytes.contentType, locator: admission.bytes.locator },
  }));
  const fingerprint = () => createHash('sha256').update(JSON.stringify({ input: result.input, admissions: admissionFingerprint() })).digest('hex');
  const originalFingerprint = fingerprint();
  const admittedSources = built.admissions.flatMap((admission) => admission.metadata.sourceIdentity !== 'metadata_only' &&
    (admission.bytes || resolvedHashes.has(admission.metadata.attachmentId))
    ? [{ id: admission.metadata.attachmentId, sha256: admission.metadata.sourceHash }] : []);
  let draftSources: typeof admittedSources = [];

  /** Must be called again before persisting or promoting a result. */
  const revalidateSources = async (): Promise<boolean> => {
    try {
      if (fingerprint() !== originalFingerprint || !await sameSnapshot()) return false;
      const sources = new Map([...admittedSources, ...draftSources].map((source) => [source.id, source]));
      for (const source of sources.values()) {
        const locator = locators.get(source.id);
        if (!locator || !await recheckAuthorizedArtifactIdentity({ attachmentId: source.id,
          authorizedAttachmentIds: authorized, expectedLocator: locator, expectedSha256: source.sha256,
          s3: options.s3, signal, resolveLocator })) return false;
      }
      return fingerprint() === originalFingerprint && await sameSnapshot();
    } catch { signal.throwIfAborted(); return false; }
  };

  /** Retain the exact mailbox source that a later staff review will recheck. */
  const createDraftSource = async (plan: RuntimePlan, persisted: ReservationistPersistedResult): Promise<Omit<ReservationistDraftSource, 'resultDigest'>> => {
    if (!await sameSnapshot()) throw new Error('mailbox_input_changed');
    const known = new Map(admittedSources.map((source) => [source.id, source.sha256]));
    const sources: typeof admittedSources = [];
    const files: ReservationistDraftSource['attachments'] = [];
    for (const file of snapshot.files) {
      const locator = locators.get(file.id)!;
      const metadataOnly = persisted.sourceRecoveries?.some((recovery) => recovery.kind === 'attachment_manual' &&
        recovery.sourceIdentity === 'metadata_only' && recovery.sourceHash === undefined &&
        recovery.sourceKind === 'attachment' && recovery.sourceRef === file.id && recovery.messageId === file.messageId &&
        recovery.disclosure === 'staff_only' && recovery.signatureNoise !== true);
      if (metadataOnly) {
        files.push({ attachmentId: file.id, messageId: file.messageId, s3Key: file.s3Key,
          mimeType: file.mimeType, sizeBytes: file.sizeBytes, inline: file.isInline,
          sourceIdentity: 'metadata_only', contentId: file.contentId });
        continue;
      }
      const sourceHash = known.get(file.id) ?? await hashAuthorizedArtifactBytes({ ...read(file.id, signal), expectedLocator: locator });
      if (!sourceHash) throw new Error('mailbox_draft_attachment_unavailable');
      sources.push({ id: file.id, sha256: sourceHash });
      files.push({ attachmentId: file.id, messageId: file.messageId, s3Key: file.s3Key,
        mimeType: file.mimeType, sizeBytes: file.sizeBytes, sourceHash, inline: file.isInline });
    }
    draftSources = sources;
    if (!await revalidateSources()) throw new Error('mailbox_input_changed');
    const arrivalAcknowledgements = deriveArrivalDraftSources(plan, built.input)
      .filter((proof) => persisted.preparedFacts?.some((fact) => fact.key === `requested_arrival_time_${proof.task.id}`));
    const operationalAnswers = options.propertyCode === 'HRCEN' ? deriveOperationalDraftSources(plan, persisted, {
      requestId: snapshot.trigger.id, ownerRef: snapshot.binding.transportId, threadId: snapshot.binding.threadId,
      propertyCode: 'HRCEN', triggerMessageId: snapshot.trigger.id, causalAt: triggerAt.toISOString(),
    }, snapshot.rows, signal) : [];
    return { version: 1, runId: options.runId, generationId: snapshot.binding.generationId,
      transportId: snapshot.binding.transportId, propertyCode: options.propertyCode, threadId: snapshot.binding.threadId,
      requestedByUserId: snapshot.binding.requestedByUserId, triggerMessageId: snapshot.trigger.id,
      causalAt: triggerAt.toISOString(), messages: snapshot.rows.map(draftSourceMessage).sort((a, b) => a.id.localeCompare(b.id)),
      attachments: files.sort((a, b) => a.attachmentId.localeCompare(b.attachmentId)),
      ...(arrivalAcknowledgements.length ? { arrivalAcknowledgements } : {}),
      ...(operationalAnswers.length ? { operationalAnswers } : {}),
    };
  };
  return Object.assign(result, { revalidateSources, createDraftSource });
}
