import type { ReservationWorkflowV2SystemReadContext } from './reservation-workflow-v2-system-read-context.js';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { attachment, mailboxAccess, mailboxTransport, mailThread, message } from '../db/schema/mail.js';
import { workEvent, workItem } from '../db/schema/work.js';
import { CENTURION_HMS_READ_TARGET } from '../hms/hms-read-target.js';
import { acquisitionWithin, PANE_PROPERTY_LOCK_WAIT_MS } from '../hms/property-read-lock.js';
import { reservationWorkflowV2DraftSchema, type ReservationWorkflowV2Draft,
  type ReservationWorkflowV2Observation, type ReservationWorkflowV2LookupInput,
  type ReservationWorkflowV2PrepareInput, type ReservationWorkflowV2ExecuteInput,
  type ReservationWorkflowV2ReconcileInput, type ReservationWorkflowV2Source } from './reservation-workflow-v2-contract.js';
import { appendReservationWorkflowV2Observation, getReservationWorkflowV2Draft,
  recordReservationWorkflowV2Result, reservationWorkflowV2DraftOf,
  type ReservationWorkflowV2Context } from './reservation-workflow-v2-state.js';
import { canonicalJson } from './draft-approval.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { isSelectedHmsInboundMessage } from './hms-jobs.js';
import { bindAttachDocumentForm, paneHmsWriteMode, parseHmsWriteForm, prepareHmsWriteSnapshot,
  readPaneCloudFilingRecord, type AttachForm, type CloudFilingRecord } from './pane-hms-write.js';
import { previewFiling } from './pane-filing-preview.js';
import { readBoundFilingSource, lockBoundFilingSource, type BoundFilingForm } from './pane-filing-source.js';
import { findStay, paneStayLookupEnabled } from './pane-stay-lookup.js';
import { projectCloudStayFind, runCloudStayFind } from './hms-cloud-saved-stay-find.js';
import { paneStayCloudTargetLock, paneStayPropertyLock } from './pane-stay-save.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { hmsDateToIso } from '../../tooling/playwright-quote/cancel-stay-rules.mjs';
import { canonicalMessageId } from '../mail/ingest/message-id.js';
import { MESSAGE_ARRIVED_AT } from './message-arrival-time.js';
import { hmsDispatchTargetKey, hmsDispatchTargetSchema, type HmsDispatchTarget } from './hms-dispatch-target.js';
import { captureHmsLabtestDispatchEpoch, claimHmsLabtestDispatch, HmsLabtestDispatchError,
  readResolvedHmsLabtestCreates, recoverHmsLabtestV2Attach, resolveHmsLabtestDispatch, resolveNeverDispatchedAttach,
  type HmsLabtestIntent, type HmsLabtestWriteHandle } from './hms-labtest-dispatch.js';
import { persistHmsShots, readStoredHmsShot, verifyStoredHmsShot } from './hms-shots-store.js';
import { lockCreateActorAccess, lockCreateActorSession } from './pane-create-actor-lock.js';

export type ReservationWorkflowV2FilingContext = {
  db: DB;
  transport: { id: string };
  user: { id: string; sessionId?: string; sessionProfile?: 'legacy' | 'remote' };
  property: { propertyCode: string };
  nativeBatch?: import('./reservation-workflow-v2-state.js').ReservationNativeCheckBatch;
  recovery?: ReservationWorkflowV2Context['recovery'];
};
type ReadContext = ReservationWorkflowV2FilingContext | ReservationWorkflowV2SystemReadContext;
type Outcome = { status: string; issue?: string; [key: string]: unknown };
type PreviewResult = Awaited<ReturnType<typeof previewFiling>>;
type WorkTransaction = Parameters<Parameters<DB['transaction']>[0]>[0];
type FilingRequest = Extract<ReservationWorkflowV2Draft['proposal']['content']['requests'][number], { kind: 'filing' }>;
type FilingDocument = ReservationWorkflowV2Draft['proposal']['content']['documents'][number];
type CreateAllocationTarget = Extract<FilingDocument['targetRefs'][number], { kind: 'allocation' }>;
type ResolvedCreateDispatch = Awaited<ReturnType<typeof readResolvedHmsLabtestCreates>>[number];
type CreateDependencyProof = { requestId: string; allocationId: string; operationId: string;
  observationRef: string; confirmation: string; arrival: string; departure: string };
type CreateDependencyResolution = { status: 'invalid' | 'pending' | 'failed' | 'needs_reconcile'; issue: string } |
  { status: 'succeeded'; proof: CreateDependencyProof };
type FilingSelection = {
  request: FilingRequest; requestIndex: number; document: FilingDocument; documentIndex: number;
  attachmentId: string; targetObservation: ReservationWorkflowV2Observation;
  targetPath: string; stay: Record<string, unknown>;
  confirmation: string; arrival: string; lastName: string; firstName: string; status: string; departure: string;
};
type TargetReadback = {
  confirmation: string; nativeStayId: string; nativeGuestId: string; documentCode: string;
  documentName: string; uniqueFreshListing: true;
};
type V2FilingRecovery = {
  version: 1; workItemId: string; operationId: string; requestId: string; documentId: string;
  documentSourceRef: string; source: ReservationWorkflowV2Source; attachmentId: string;
  sourceSnapshotDigest: string; pdfSha256: string; semanticDigest: string; documentName: string; documentCode: string;
  confirmation: string; arrival: string; departure: string; nativeStayId: string; nativeGuestId: string;
  firstName: string; lastName: string; status: string; cmsSend: boolean; allowRealGuest: boolean;
  targetObservationRef: string; prepareObservationRef: string; targetSnapshotDigest: string;
  beforeShot: { runId: string; sha256: string }; writer: unknown;
};
type PositiveFilingProof = { confirmation: string; nativeStayId: string; nativeReadback: TargetReadback;
  readbackDigest: string; savedShot: { runId: string; sha256: string } };
type ClosedWriterBinding = { handle: HmsLabtestWriteHandle; writer: unknown; requestDigest: string };

const FILING_WRITER_CLOSED_FIELD = 'nava.reservation.workflow.v2.filing.writer_closed.v1';

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const digestJson = (value: unknown): string => sha256(canonicalJson(value));
const ptr = (...parts: Array<string | number>): string => `/${parts.map((part) => encodeURIComponent(String(part))).join('/')}`;
const isoDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const sourceEvidenceRef = (messageId: string, role: string, identity: string): string =>
  `src_${sha256(`${messageId}\u001f${role}\u001f${identity}`).slice(0, 12)}`;
const stateContext = (ctx: ReadContext): ReservationWorkflowV2Context => ({ db: ctx.db,
  transportId: ctx.transport.id, userId: 'system' in ctx || ctx.nativeBatch ? null : ctx.user.id,
  propertyCode: ctx.property.propertyCode, nativeBatch: ctx.nativeBatch, recovery: ctx.recovery });
export type ReservationWorkflowV2FilingRecoveryAccess = {
  scope: NonNullable<ReservationWorkflowV2Context['recovery']>; userId: string;
};

/** Persist only the host runner's proof that this claimed writer is closed and its callbacks drained. */
async function recordFilingWriterClosed(ctx: ReservationWorkflowV2FilingContext, input: ReservationWorkflowV2ExecuteInput,
  binding: ClosedWriterBinding, sourceSnapshotDigest: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select({ value: workEvent.value, actorKind: workEvent.actorKind, type: workEvent.type,
      workItemId: workEvent.workItemId }).from(workEvent).where(and(eq(workEvent.id, binding.handle.holdId),
      eq(workEvent.fieldPath, 'nava.hms.labtest.dispatch.v1'))).limit(1);
    const intent = record(row?.value), recovery = record(intent?.recovery), source = record(recovery?.source);
    if (!row || row.actorKind !== 'system' || row.type !== 'write.evidence' || row.workItemId !== input.workItemId ||
        !intent || intent.kind !== 'intent' || intent.operation !== 'attach_document' || intent.holdId !== binding.handle.holdId ||
        intent.ownerDigest !== sha256(binding.handle.ownerToken) || intent.workItemId !== input.workItemId ||
        intent.transportId !== ctx.transport.id || intent.actorUserId !== ctx.user.id || intent.grantId !== input.idempotencyKey ||
        intent.propertyCode !== ctx.property.propertyCode || intent.sourceDigest !== sourceSnapshotDigest ||
        intent.requestDigest !== binding.requestDigest || recovery?.workItemId !== input.workItemId ||
        recovery.operationId !== input.idempotencyKey || recovery.requestId !== input.requestId ||
        source?.messageId !== input.source.messageId || source.threadId !== input.source.threadId ||
        source.sourceHash !== input.source.sourceHash || source.arrivedAt !== input.source.arrivedAt ||
        canonicalJson(recovery.writer) !== canonicalJson(binding.writer)) throw new Error('filing_writer_closed_scope_invalid');
    await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', actorUserId: ctx.user.id,
      type: 'write.evidence', fieldPath: FILING_WRITER_CLOSED_FIELD,
      value: { version: 1, kind: 'writer_closed', holdId: binding.handle.holdId, operationId: input.idempotencyKey,
        workItemId: input.workItemId, transportId: ctx.transport.id, actorUserId: ctx.user.id,
        sourceDigest: sourceSnapshotDigest, requestDigest: binding.requestDigest,
        ownerDigest: intent.ownerDigest, writerDigest: digestJson(binding.writer) } });
  });
}

async function hasFilingWriterClosedReceipt(db: DB, intent: HmsLabtestIntent, recovery: V2FilingRecovery): Promise<boolean> {
  const rows = await db.select({ value: workEvent.value, actorKind: workEvent.actorKind, actorUserId: workEvent.actorUserId })
    .from(workEvent).where(and(eq(workEvent.workItemId, intent.workItemId), eq(workEvent.type, 'write.evidence'),
      eq(workEvent.fieldPath, FILING_WRITER_CLOSED_FIELD), sql`${workEvent.value}->>'holdId' = ${intent.holdId}`)).limit(2);
  const expected = { version: 1, kind: 'writer_closed', holdId: intent.holdId, operationId: intent.grantId,
    workItemId: intent.workItemId, transportId: intent.transportId, actorUserId: intent.actorUserId,
    sourceDigest: intent.sourceDigest, requestDigest: intent.requestDigest,
    ownerDigest: intent.ownerDigest, writerDigest: digestJson(recovery.writer) };
  return rows.some((row) => row.actorKind === 'system' && row.actorUserId === intent.actorUserId &&
    canonicalJson(row.value) === canonicalJson(expected));
}

async function currentDraft(ctx: ReadContext, input: {
  workItemId: string; source: ReservationWorkflowV2Source; expectedRevision: number; expectedSeq: number;
}) {
  const result = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (result.status !== 'ok') return { result, draft: null } as const;
  if (result.revision !== input.expectedRevision || result.seq !== input.expectedSeq ||
      result.draft.revision !== input.expectedRevision) return { result: { status: 'stale_revision' }, draft: null } as const;
  return { result, draft: reservationWorkflowV2DraftSchema.parse(result.draft) } as const;
}

function staffAccepted(draft: ReservationWorkflowV2Draft, path: string): boolean {
  return draft.staffReviews[path]?.status === 'accepted';
}

function acceptedWhenRequested(draft: ReservationWorkflowV2Draft, path: string, value: string | null): boolean {
  return value === null || staffAccepted(draft, path);
}

function effectiveValue(draft: ReservationWorkflowV2Draft, path: string, source: unknown): unknown {
  const override = draft.fieldOverrides[path];
  if (!override || override.state === 'inherit') return source;
  return override.state === 'set' ? override.value : null;
}

function exactPdfName(value: string): boolean {
  return value.length > 0 && value.length <= 120 && /\.pdf$/i.test(value) && value === value.replace(/\s+/g, ' ').trim() &&
    !/[\\/\p{Cc}]/u.test(value);
}

const filingHintSchema = z.object({ id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  confirmation: z.string().max(200).optional(), guestName: z.string().max(300).optional(),
  bookedArrival: z.string().max(40).optional(), bookedDeparture: z.string().max(40).optional(),
  candidateRefs: z.array(z.string().min(1).max(160)).max(100), suggestedRef: z.string().min(1).max(160).nullable(),
  sourceRefs: z.array(z.string().min(1).max(160)).max(100) }).strict();
const filingTargetsSchema = z.object({ mode: z.enum(['explicit', 'scoped_all', 'unresolved']),
  include: z.array(filingHintSchema).max(100), exclude: z.array(filingHintSchema).max(100),
  sourceRefs: z.array(z.string().min(1).max(160)).max(100) }).strict();

function filingTargets(draft: ReservationWorkflowV2Draft, request: FilingRequest) {
  const path = ptr('proposal', 'content', 'requests', request.id, 'body', 'targets');
  const parsed = filingTargetsSchema.safeParse(effectiveFilingTargetValue(draft, path, request.body.targets));
  return parsed.success ? parsed.data : null;
}

function effectiveFilingTargetValue(draft: ReservationWorkflowV2Draft, path: string, source: unknown): unknown {
  const resolved = effectiveValue(draft, path, source);
  if (Array.isArray(resolved)) return resolved.map((value, index) => {
    const indexed = effectiveFilingTargetValue(draft, `${path}/${index}`, value);
    const id = text(record(value)?.id);
    return id ? effectiveFilingTargetValue(draft, `${path}/${encodeURIComponent(id)}`, indexed) : indexed;
  });
  if (!record(resolved)) return resolved;
  const fields = new Set(Object.keys(resolved as Record<string, unknown>));
  for (const overridePath of Object.keys(draft.fieldOverrides)) {
    if (!overridePath.startsWith(`${path}/`)) continue;
    const child = overridePath.slice(path.length + 1).split('/')[0];
    if (child) fields.add(decodeURIComponent(child));
  }
  return Object.fromEntries([...fields].map(key => [key,
    effectiveFilingTargetValue(draft, `${path}/${encodeURIComponent(key)}`, (resolved as Record<string, unknown>)[key]) ]));
}

async function attachmentForDocument(ctx: ReadContext, draft: ReservationWorkflowV2Draft,
  document: FilingDocument): Promise<{ attachmentId: string; filename: string; mimeType: string } | null> {
  const rows = await ctx.db.select({ id: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType,
    isInline: attachment.isInline }).from(attachment).where(eq(attachment.messageId, draft.source.messageId)).limit(100);
  const matches = rows.filter((row) => {
    if (row.isInline) return false;
    if (sourceEvidenceRef(draft.source.messageId, 'attachment_text', row.id) === document.documentSourceRef) return true;
    for (let page = 1; page <= 100; page += 1) {
      if (sourceEvidenceRef(draft.source.messageId, 'attachment_vision', `${row.id}:${page}`) === document.documentSourceRef) return true;
    }
    return false;
  });
  if (matches.length !== 1) return null;
  const row = matches[0]!;
  if (!/\.pdf$/i.test(row.filename) && row.mimeType.toLowerCase() !== 'application/pdf') return null;
  return { attachmentId: row.id, filename: row.filename, mimeType: row.mimeType };
}

function filingRequestAndDocument(draft: ReservationWorkflowV2Draft, requestId: string): {
  request: FilingRequest; requestIndex: number; document: FilingDocument; documentIndex: number;
} | null {
  const requestIndex = draft.proposal.content.requests.findIndex((entry) => entry.id === requestId && entry.kind === 'filing');
  const request = draft.proposal.content.requests[requestIndex];
  if (!request || request.kind !== 'filing') return null;
  const refs = effectiveValue(draft, ptr('proposal', 'content', 'requests', request.id, 'documentRefs'), request.documentRefs);
  if (!Array.isArray(refs) || !refs.every((ref) => typeof ref === 'string')) return null;
  const docs = draft.proposal.content.documents.flatMap((document, documentIndex) =>
    document.ownerRequestId === request.id && refs.includes(document.id) ? [{ document, documentIndex }] : []);
  if (docs.length !== 1) return null; // This first slice binds one selected PDF to one stay.
  return { request, requestIndex, document: docs[0]!.document, documentIndex: docs[0]!.documentIndex };
}

function createAllocationTarget(draft: ReservationWorkflowV2Draft, document: FilingDocument):
  { status: 'none' } | { status: 'linked'; target: CreateAllocationTarget } | { status: 'invalid' } {
  const refs = document.targetRefs.filter((target): target is CreateAllocationTarget => target.kind === 'allocation');
  const owner = draft.proposal.content.requests.find(row => row.id === document.ownerRequestId && row.kind === 'filing');
  if (!owner || owner.kind !== 'filing') return { status: 'invalid' };
  const bodyTarget = effectiveValue(draft, ptr('proposal', 'content', 'requests', owner.id, 'body', 'allocationTarget'), owner.body.allocationTarget);
  const body = record(bodyTarget);
  if (body && (refs.length !== 1 || body.requestId !== refs[0]?.requestId || body.allocationId !== refs[0]?.allocationId)) return { status: 'invalid' };
  if (!refs.length) return { status: 'none' };
  if (refs.length !== 1) return { status: 'invalid' };
  const target = refs[0]!;
  const request = draft.proposal.content.requests.find((entry) => entry.id === target.requestId);
  if (!request || request.kind !== 'create' || request.body.allocations.filter((allocation) => allocation.id === target.allocationId).length !== 1) {
    return { status: 'invalid' };
  }
  return { status: 'linked', target };
}

function validConfirmation(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6,10}-\d{1,2}$/.test(value);
}

function validSavedShot(value: unknown): boolean {
  const shot = record(value);
  return Boolean(shot && typeof shot.runId === 'string' && typeof shot.sha256 === 'string' && /^[a-f0-9]{64}$/.test(shot.sha256));
}

function verifiedCreateStayDates(readback: unknown, approvedRequest: unknown, confirmation: string):
  { arrival: string; departure: string } | null {
  const result = record(readback), fields = result?.fields;
  if (!result || !Array.isArray(fields) || !Array.isArray(result.mismatches) || result.mismatches.length !== 0 ||
      (result.confirmation !== undefined && result.confirmation !== confirmation)) return null;
  const day = (name: string) => {
    const matching = fields.filter((field) => record(field)?.name === name);
    return matching.length === 1 ? hmsDateToIso(record(matching[0])?.value) : null;
  };
  const arrival = day('arrivaldate'), departure = day('departuredate');
  const expectedStay = record(record(approvedRequest)?.stay);
  if (!arrival || !departure || departure <= arrival || expectedStay?.arrival !== arrival || expectedStay.departure !== departure) return null;
  return { arrival, departure };
}

/** Verify the two persisted Create receipt variants against one exact allocation; input order is irrelevant. */
export function verifyCreateAllocationDependency(draft: ReservationWorkflowV2Draft, target: CreateAllocationTarget,
  receipts: ResolvedCreateDispatch[], transportId: string): CreateDependencyResolution {
  const createRequest = draft.proposal.content.requests.find((request) => request.id === target.requestId);
  if (!createRequest || createRequest.kind !== 'create' ||
      !createRequest.body.allocations.some((allocation) => allocation.id === target.allocationId)) {
    return { status: 'invalid', issue: 'create_dependency_target_invalid' };
  }
  const operations = draft.operationResults.filter((operation) => operation.workflow === 'create' &&
    operation.requestId === target.requestId && operation.allocationId === target.allocationId);
  if (operations.some((operation) => operation.generationId !== draft.generationId &&
      (operation.status === 'succeeded' || operation.status === 'unknown'))) {
    return { status: 'needs_reconcile', issue: 'create_dependency_generation_changed' };
  }
  if (operations.some((operation) => operation.status === 'unknown')) {
    return { status: 'needs_reconcile', issue: 'create_dependency_outcome_unknown' };
  }
  const successes = operations.filter((operation) => operation.status === 'succeeded');
  if (!successes.length) return operations.some((operation) => operation.status === 'failed')
    ? { status: 'failed', issue: 'create_dependency_not_succeeded' }
    : { status: 'pending', issue: 'create_dependency_pending' };
  if (successes.length !== 1) return { status: 'needs_reconcile', issue: 'create_dependency_multiple_successes' };
  const operation = successes[0]!;
  if (operation.generationId !== draft.generationId || operation.observationRefs.length !== 1) {
    return { status: 'needs_reconcile', issue: 'create_dependency_receipt_invalid' };
  }
  const observationRefs = new Set(operation.observationRefs);
  const observations = draft.observations.filter((entry) => observationRefs.has(entry.ref));
  if (observations.length !== 1) return { status: 'needs_reconcile', issue: 'create_dependency_observation_missing' };
  const observation = observations[0]!;
  const result = record(observation.result), confirmation = result?.confirmation;
  if (observation.kind !== 'stay_candidate' || observation.status !== 'complete' || !observation.coverage.complete ||
      observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
      observation.sourceMessageId !== draft.source.messageId || observation.criteria.workflow !== 'create' ||
      observation.criteria.requestId !== target.requestId || observation.criteria.allocationId !== target.allocationId ||
      observation.criteria.draftRevision !== operation.draftRevision || !validConfirmation(confirmation)) {
    return { status: 'needs_reconcile', issue: 'create_dependency_observation_invalid' };
  }
  const matchingReceipts = receipts.filter(({ intent }) => intent.grantId === operation.id.toLowerCase());
  if (matchingReceipts.length !== 1) return { status: 'needs_reconcile', issue: 'create_dependency_dispatch_receipt_missing' };
  const receipt = matchingReceipts[0]!;
  const { intent, resolution } = receipt;
  const recovery = record(intent.recovery);
  if (intent.operation !== 'create' || resolution.operation !== 'create' || intent.workItemId !== draft.workItemId.toLowerCase() ||
      intent.transportId !== transportId || intent.propertyCode !== draft.propertyCode || intent.grantId !== operation.id.toLowerCase() ||
      intent.stayId !== `${target.requestId}_${target.allocationId}` || intent.sourceDigest !== draft.source.sourceHash ||
      recovery?.requestId !== target.requestId || recovery.allocationId !== target.allocationId || recovery.operationId !== operation.id ||
      recovery.draftRevision !== operation.draftRevision ||
      resolution.confirmation !== confirmation || !validSavedShot(resolution.savedShot)) {
    return { status: 'needs_reconcile', issue: 'create_dependency_scope_mismatch' };
  }
  if (resolution.recovered === true) {
    const observedReadback = record(result?.nativeReadback), resolvedReadback = record(resolution.nativeReadback);
    if (observation.criteria.recovered !== true || observation.criteria.operationId !== operation.id ||
        observation.criteria.sourceHash !== draft.source.sourceHash || !observedReadback || !resolvedReadback ||
        observedReadback.confirmation !== confirmation || resolvedReadback.confirmation !== confirmation ||
        result?.readbackDigest !== resolution.readbackDigest || !validSavedShot(result?.savedShot) ||
        canonicalJson(result?.savedShot) !== canonicalJson(resolution.savedShot) ||
        canonicalJson(observedReadback) !== canonicalJson(resolvedReadback)) {
      return { status: 'needs_reconcile', issue: 'create_dependency_recovery_proof_invalid' };
    }
  } else {
    const readback = record(result?.nativeReadback);
    if (observation.criteria.recovered === true || observation.criteria.idempotencyKey !== operation.id ||
        result?.requestDigest !== intent.approvedDigest || result?.priceMatched !== true || !readback ||
        digestJson(readback) !== resolution.readbackDigest || !validSavedShot(result?.savedShot) ||
        canonicalJson(result?.savedShot) !== canonicalJson(resolution.savedShot)) {
      return { status: 'needs_reconcile', issue: 'create_dependency_save_proof_invalid' };
    }
  }
  const stayDates = verifiedCreateStayDates(result?.nativeReadback, recovery?.request, confirmation);
  if (!stayDates) return { status: 'needs_reconcile', issue: 'create_dependency_dates_unverified' };
  return { status: 'succeeded', proof: { requestId: target.requestId, allocationId: target.allocationId,
    operationId: operation.id, observationRef: observation.ref, confirmation, ...stayDates } };
}

function linkedCreateObservationMatches(draft: ReservationWorkflowV2Draft, target: CreateAllocationTarget,
  filingObservation: ReservationWorkflowV2Observation, confirmation: string): boolean {
  if (filingObservation.criteria.createRequestId !== target.requestId ||
      filingObservation.criteria.createAllocationId !== target.allocationId ||
      filingObservation.criteria.createConfirmation !== confirmation ||
      filingObservation.criteria.confirmation !== confirmation) return false;
  const operationId = text(filingObservation.criteria.createOperationId), observationRef = text(filingObservation.criteria.createObservationRef);
  if (!operationId || !observationRef) return false;
  const operations = draft.operationResults.filter((operation) => operation.id === operationId && operation.workflow === 'create' &&
    operation.status === 'succeeded' && operation.generationId === draft.generationId && operation.requestId === target.requestId &&
    operation.allocationId === target.allocationId && operation.observationRefs.length === 1 && operation.observationRefs[0] === observationRef);
  const observations = draft.observations.filter((observation) => observation.ref === observationRef &&
    operations.some((operation) => operation.observationRefs.includes(observation.ref)));
  if (operations.length !== 1 || observations.length !== 1) return false;
  const operation = operations[0]!, observation = observations[0]!, result = record(observation.result);
  return observation.kind === 'stay_candidate' && observation.status === 'complete' && observation.coverage.complete &&
    observation.generationId === draft.generationId && observation.propertyCode === draft.propertyCode &&
    observation.sourceMessageId === draft.source.messageId && observation.criteria.workflow === 'create' &&
    observation.criteria.requestId === target.requestId && observation.criteria.allocationId === target.allocationId &&
    observation.criteria.draftRevision === operation.draftRevision && result?.confirmation === confirmation;
}

/** Only host lookup evidence backed by the exact successful Create can fill an empty linked confirmation. */
export function isVerifiedCreateFilingCandidate(draft: ReservationWorkflowV2Draft, requestId: string,
  observation: ReservationWorkflowV2Observation): boolean {
  const pair = filingRequestAndDocument(draft, requestId);
  if (!pair || observation.kind !== 'stay_candidate' || observation.criteria.workflow !== 'filing' ||
      observation.criteria.requestId !== requestId || observation.criteria.sourceHash !== draft.source.sourceHash ||
      observation.generationId !== draft.generationId || observation.sourceMessageId !== draft.source.messageId) return false;
  const dependency = createAllocationTarget(draft, pair.document);
  return dependency.status === 'linked' && validConfirmation(observation.criteria.confirmation) &&
    linkedCreateObservationMatches(draft, dependency.target, observation, observation.criteria.confirmation);
}

function findTargetHint(draft: ReservationWorkflowV2Draft, request: FilingRequest, document: FilingDocument) {
  const scope = filingTargets(draft, request);
  if (!scope || scope.mode !== 'explicit' || scope.include.length !== 1 || scope.exclude.length) return null;
  const hint = scope.include[0]!;
  if (!document.targetRefs.some((target) => target.kind === 'saved_target' && target.requestId === request.id && target.hintId === hint.id)) return null;
  const dependency = createAllocationTarget(draft, document);
  if (dependency.status === 'invalid') return null;
  const targetPath = ptr('proposal', 'content', 'requests', request.id, 'body', 'targets', 'include', hint.id, 'suggestedRef');
  const effectiveRef = effectiveValue(draft, targetPath, hint.suggestedRef);
  const proposedRef = typeof effectiveRef === 'string' ? effectiveRef : null;
  const candidates = [...new Set([proposedRef, ...hint.candidateRefs].filter((ref): ref is string => typeof ref === 'string'))]
    .map((ref) => draft.observations.find((observation) => observation.ref === ref))
    .filter((observation): observation is ReservationWorkflowV2Observation => Boolean(observation &&
      observation.kind === 'stay_candidate' && observation.status === 'complete' && observation.coverage.complete &&
      observation.propertyCode === draft.propertyCode && observation.generationId === draft.generationId &&
      observation.sourceMessageId === draft.source.messageId && observation.criteria.workflow === 'filing' &&
      observation.criteria.requestId === request.id && observation.criteria.targetHintId === hint.id &&
      (dependency.status !== 'linked' || linkedCreateObservationMatches(draft, dependency.target, observation,
        text(record(record(observation.result)?.stay)?.confirmation) ?? '')) &&
      record(observation.result)?.outcome === 'found' &&
      record(observation.result)?.stay && typeof record(observation.result)?.stay === 'object'));
  const targetObservation = proposedRef ? candidates.find((candidate) => candidate.ref === proposedRef) : undefined;
  const stay = targetObservation ? record(record(targetObservation.result)?.stay) : null;
  const confirmation = text(stay?.confirmation), arrival = text(stay?.arrival), lastName = text(stay?.lastName);
  const firstName = text(stay?.firstName), status = text(stay?.status), departure = text(stay?.departure);
  if (!targetObservation || !stay || !confirmation || !arrival || !lastName || !firstName || !status || !departure ||
      !isoDay(arrival) || !isoDay(departure) || departure <= arrival ||
      (hint.confirmation && hint.confirmation !== confirmation) ||
      (hint.bookedArrival && hint.bookedArrival !== arrival) ||
      (hint.bookedDeparture && hint.bookedDeparture !== departure) ||
      (hint.guestName && hint.guestName.trim().replace(/\s+/g, ' ').toLocaleLowerCase() !== `${firstName} ${lastName}`.replace(/\s+/g, ' ').toLocaleLowerCase())) return null;
  return { targetPath, targetObservation, stay, confirmation, arrival, lastName, firstName, status, departure };
}

function effectiveFilingDocument(draft: ReservationWorkflowV2Draft, source: FilingDocument): FilingDocument | null {
  const root = ptr('proposal', 'content', 'documents', source.id);
  const kind = effectiveValue(draft, `${root}/kind`, source.kind);
  const handling = effectiveValue(draft, `${root}/handling`, source.handling);
  if ((kind !== 'voucher' && kind !== 'payment_proof') || handling !== 'filing_requested') return null;
  return { ...source, kind, handling };
}

async function selectionFor(ctx: ReservationWorkflowV2FilingContext, draft: ReservationWorkflowV2Draft,
  requestId: string, requireReview: boolean): Promise<FilingSelection | null> {
  const pair = filingRequestAndDocument(draft, requestId);
  if (!pair) return null;
  const root = ptr('proposal', 'content', 'documents', pair.document.id);
  const document = effectiveFilingDocument(draft, pair.document);
  if (!document) return null;
  const source = await attachmentForDocument(ctx, draft, document);
  if (!source) return null;
  const target = findTargetHint(draft, pair.request, document);
  if (!target) return null;
  if (requireReview && (!staffAccepted(draft, `${root}/documentSourceRef`) ||
      !staffAccepted(draft, `${root}/kind`) || !staffAccepted(draft, `${root}/handling`) ||
      !acceptedWhenRequested(draft, `${root}/requestedName`, document.requestedName) ||
      !acceptedWhenRequested(draft, `${root}/requestedDescription`, document.requestedDescription) ||
      !staffAccepted(draft, target.targetPath))) return null;
  return { ...pair, document, attachmentId: source.attachmentId, targetObservation: target.targetObservation,
    targetPath: target.targetPath, stay: target.stay,
    confirmation: target.confirmation, arrival: target.arrival, lastName: target.lastName, firstName: target.firstName,
    status: target.status, departure: target.departure };
}

function selectionDigest(selection: FilingSelection, preview: Extract<PreviewResult, { status: 'ready' }>, documentName: string): string {
  return digestJson({ version: 1, requestId: selection.request.id, documentId: selection.document.id,
    documentSourceRef: selection.document.documentSourceRef, documentKind: selection.document.kind,
    handling: selection.document.handling, requestedName: selection.document.requestedName,
    requestedDescription: selection.document.requestedDescription, documentName,
    sourcePdfSha256: preview.documentSource.sha256, sourceSnapshotDigest: preview.documentSource.snapshotDigest,
    targetObservationRef: selection.targetObservation.ref, confirmation: selection.confirmation,
    arrival: selection.arrival, departure: selection.departure, firstName: selection.firstName,
    lastName: selection.lastName, status: selection.status });
}

async function selectedSource(ctx: ReadContext, source: ReservationWorkflowV2Source) {
  const ok = await isSelectedHmsInboundMessage({ transportId: ctx.transport.id, ...source }, ctx.db).catch(() => false);
  if (!ok) return null;
  const [row] = await ctx.db.select({ id: message.id, threadId: message.threadId,
    internetMessageId: message.messageIdHeader }).from(message).where(and(eq(message.id, source.messageId),
      eq(message.threadId, source.threadId), eq(message.transportId, ctx.transport.id))).limit(1);
  const internetMessageId = row?.internetMessageId ? canonicalMessageId(row.internetMessageId.trim()) : null;
  return row && internetMessageId ? { threadId: row.threadId, messageId: row.id, sourceHash: source.sourceHash, internetMessageId } : null;
}

async function runPreview(ctx: ReservationWorkflowV2FilingContext, input: ReservationWorkflowV2LookupInput | ReservationWorkflowV2PrepareInput,
  selection: FilingSelection): Promise<PreviewResult> {
  const selected = await selectedSource(ctx, input.source);
  if (!selected) return { status: 'refused', reason: 'source_mail_changed' };
  const preview = await previewFiling({ db: ctx.db, transportId: ctx.transport.id, actorUserId: ctx.user.id,
    workItemId: input.workItemId, sourceMessageId: input.source.messageId, attachmentId: selection.attachmentId,
    confirmation: selection.confirmation, arrival: selection.arrival, lastName: selection.lastName });
  if (preview.status === 'ready' && preview.revisionSeq !== input.expectedSeq) return { status: 'refused', reason: 'source_changed' };
  if (preview.status === 'ready' && !exactPdfName(preview.documentName)) return { status: 'refused', reason: 'source_pdf_name_unavailable' };
  return preview;
}

function filingObservation(draft: ReservationWorkflowV2Draft, input: { requestId: string; operationId?: string },
  selection: FilingSelection, status: ReservationWorkflowV2Observation['status'], result: Record<string, unknown>,
  notes: string[] = []): ReservationWorkflowV2Observation {
  return { ref: randomUUID(), generationId: draft.generationId, kind: 'document', status,
    observedAt: new Date().toISOString(), propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId,
    sourceRefs: [selection.targetObservation.ref], criteria: { workflow: 'filing', requestId: input.requestId,
      documentId: selection.document.id, documentSourceRef: selection.document.documentSourceRef,
      targetObservationRef: selection.targetObservation.ref, draftRevision: draft.revision,
      ...(input.operationId ? { operationId: input.operationId } : {}) },
    coverage: { complete: status === 'complete', notes }, result };
}

async function recordFilingOperation(ctx: ReservationWorkflowV2FilingContext,
  input: ReservationWorkflowV2PrepareInput | ReservationWorkflowV2ExecuteInput,
  observation: ReservationWorkflowV2Observation, status: 'prepared' | 'succeeded' | 'failed' | 'unknown',
  summary: string | null, operationId: string = randomUUID()) {
  const base = { workItemId: input.workItemId, source: input.source, expectedRevision: input.expectedRevision,
    expectedSeq: input.expectedSeq };
  const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), { ...base, observation });
  if (appended.status !== 'ok') return appended;
  return recordReservationWorkflowV2Result(stateContext(ctx), { ...base, result: {
    id: operationId, generationId: observation.generationId, requestId: observation.criteria.requestId as string,
    allocationId: null, workflow: 'filing', status, draftRevision: input.expectedRevision,
    observationRefs: [observation.ref], updatedAt: new Date().toISOString(), summary } });
}

function targetReadback(value: unknown): TargetReadback | null {
  const parsed = z.object({ confirmation: z.string(), nativeStayId: z.string().regex(/^\d{1,100}$/),
    nativeGuestId: z.string().regex(/^\d{1,30}$/), documentCode: z.string(), documentName: z.string(),
    uniqueFreshListing: z.literal(true) }).strict().safeParse(value);
  return parsed.success ? parsed.data : null;
}

function filingStateDigest(cloud: CloudFilingRecord): string {
  const { confirmation, firstName, lastName, status, arrival, departure } = cloud.stay;
  return digestJson({ confirmation, firstName, lastName, status, arrival, departure,
    nativeGuestId: cloud.nativeGuestId, nativeStayId: cloud.nativeStayId, cmsSend: cloud.filingSnapshot.cmsSend });
}

function approvedStay(cloud: CloudFilingRecord, allowRealGuest: boolean) {
  return { ...cloud.stay, nativeGuestId: cloud.nativeGuestId, nativeStayId: cloud.nativeStayId, allowRealGuest };
}

type V2BoundAttachForm = AttachForm & BoundFilingForm;

function itemAttachForm(state: Record<string, unknown>): V2BoundAttachForm | null {
  const form = parseHmsWriteForm(state);
  return form?.action === 'attach_document' && typeof form.pdfSha256 === 'string' &&
    typeof form.sourceSnapshotDigest === 'string' && typeof form.sourceThreadId === 'string' &&
    typeof form.sourceHash === 'string' && typeof form.documentCode === 'string' &&
    typeof form.filingStateDigest === 'string' && typeof form.sourceMessageId === 'string' &&
    typeof form.sourceInternetMessageId === 'string' ? form as V2BoundAttachForm : null;
}

async function persistFilingShots(ctx: ReservationWorkflowV2FilingContext, input: {
  workItemId: string; runId: string; beforePath: string; afterPath?: string;
}): Promise<{ beforeShot: { runId: string; sha256: string }; savedShot?: { runId: string; sha256: string } } | null> {
  const runDir = dirname(input.beforePath), root = dirname(runDir);
  if (basename(runDir).startsWith('hms-document-') !== true || basename(root).startsWith('pane-cloud-attach-') !== true ||
      input.beforePath !== join(runDir, 'before.png') ||
      (input.afterPath && (dirname(input.afterPath) !== runDir || input.afterPath !== join(runDir, 'after.png')))) return null;
  const stage = await mkdtemp(join(tmpdir(), 'reservation-v2-filing-shots-'));
  const owner = `${ctx.user.id}:${ctx.transport.id}`;
  try {
    await copyFile(input.beforePath, join(stage, 'before.png'));
    if (input.afterPath) await copyFile(input.afterPath, join(stage, 'saved.png'));
    const shots = await persistHmsShots({ propertyCode: ctx.property.propertyCode, workItemId: input.workItemId,
      runId: input.runId, sourceDir: stage, owner, now: Date.now() });
    const before = shots?.find((shot) => shot.name === 'before.png');
    const saved = shots?.find((shot) => shot.name === 'saved.png');
    if (!before || !await verifyStoredHmsShot({ runId: input.runId, name: 'before.png', sha256: before.sha256,
      owner, propertyCode: ctx.property.propertyCode, workItemId: input.workItemId }, 'before.png')) return null;
    if (input.afterPath && (!saved || !await verifyStoredHmsShot({ runId: input.runId, name: 'saved.png', sha256: saved.sha256,
      owner, propertyCode: ctx.property.propertyCode, workItemId: input.workItemId }, 'saved.png'))) return null;
    return { beforeShot: { runId: input.runId, sha256: before.sha256 },
      ...(saved ? { savedShot: { runId: input.runId, sha256: saved.sha256 } } : {}) };
  } catch { return null; }
  finally { await rm(stage, { recursive: true, force: true }).catch(() => {}); }
}

function latestPrepared(draft: ReservationWorkflowV2Draft, requestId: string, documentId: string) {
  const result = [...draft.operationResults].reverse().find((entry) => entry.requestId === requestId &&
    entry.allocationId === null && entry.workflow === 'filing' && entry.status === 'prepared' &&
    entry.generationId === draft.generationId && entry.draftRevision <= draft.revision);
  const observation = result && draft.observations.find((entry) => result.observationRefs.includes(entry.ref) &&
    entry.kind === 'document' && entry.generationId === draft.generationId && entry.criteria.workflow === 'filing' && entry.criteria.requestId === requestId &&
    entry.criteria.documentId === documentId && typeof record(entry.result)?.semanticDigest === 'string');
  return result && observation ? { result, observation } : null;
}

function liveTargetForSaved(ctx: ReservationWorkflowV2FilingContext, confirmation: string, nativeStayId: string): HmsDispatchTarget | null {
  const parsed = hmsDispatchTargetSchema.safeParse({ propertyCode: ctx.property.propertyCode, kind: 'saved', confirmation, nativeStayId });
  return parsed.success && parsed.data.kind === 'saved' ? parsed.data : null;
}

/** Source- and property-scoped, read-only Filing lookup. It can propose target candidates; it cannot authorize Go. */
export async function reservationWorkflowV2FilingLookup(ctx: ReadContext,
  input: ReservationWorkflowV2LookupInput): Promise<Outcome> {
  if (ctx.nativeBatch && !paneStayLookupEnabled()) return { status: 'needs_input', issue: 'stay_lookup_disabled' };
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  const requests = loaded.draft.proposal.content.requests.filter((request): request is FilingRequest => request.kind === 'filing' &&
    (!input.requestId || request.id === input.requestId));
  if (input.requestId && !requests.length) return { status: 'not_found' };
  if (ctx.property.propertyCode !== 'HRCEN') return { status: 'unsupported', issue: 'filing_property_unavailable' };
  const target = paneStayHmsTargetForTransport(ctx.transport.id);
  if (!target.ok || target.target.propertyCode !== CENTURION_HMS_READ_TARGET.propertyCode) {
    return { status: 'unsupported', issue: 'filing_property_unavailable' };
  }
  if (!await selectedSource(ctx, input.source)) return { status: 'refused', issue: 'source_mail_changed' };
  const lookups: Outcome[] = [], appended: ReservationWorkflowV2Observation[] = [];
  for (const request of requests) {
    const pair = filingRequestAndDocument(loaded.draft, request.id);
    if (!pair) { lookups.push({ status: 'needs_input', requestId: request.id, issue: 'select_one_document' }); continue; }
    const file = await attachmentForDocument(ctx, loaded.draft, pair.document);
    if (!file) { lookups.push({ status: 'needs_input', requestId: request.id, issue: 'source_pdf_not_admitted' }); continue; }
    const scope = filingTargets(loaded.draft, request);
    const hints = scope && scope.mode === 'explicit' ? scope.include : [];
    if (hints.length !== 1) { lookups.push({ status: 'needs_input', requestId: request.id, issue: 'select_one_saved_stay' }); continue; }
    const hint = hints[0]!;
    const dependency = createAllocationTarget(loaded.draft, pair.document);
    if (dependency.status === 'invalid') {
      lookups.push({ status: 'needs_input', requestId: request.id, documentId: pair.document.id,
        issue: 'create_dependency_target_invalid' });
      continue;
    }
    let linkedProof: CreateDependencyProof | null = null;
    if (dependency.status === 'linked') {
      let receipts: ResolvedCreateDispatch[];
      try {
        receipts = await ctx.db.transaction((tx) => readResolvedHmsLabtestCreates(tx, input.workItemId));
      } catch {
        lookups.push({ status: 'needs_reconcile', requestId: request.id, documentId: pair.document.id,
          createDependency: { status: 'needs_reconcile', requestId: dependency.target.requestId,
            allocationId: dependency.target.allocationId }, issue: 'create_dependency_receipt_unavailable' });
        continue;
      }
      const resolved = verifyCreateAllocationDependency(loaded.draft, dependency.target, receipts, ctx.transport.id);
      if (resolved.status !== 'succeeded') {
        lookups.push({ status: resolved.status === 'pending' ? 'queued' : resolved.status,
          requestId: request.id, documentId: pair.document.id,
          createDependency: { status: resolved.status, requestId: dependency.target.requestId,
            allocationId: dependency.target.allocationId },
          issue: resolved.issue });
        continue;
      }
      linkedProof = resolved.proof;
      if (hint.confirmation && hint.confirmation !== linkedProof.confirmation) {
        lookups.push({ status: 'needs_reconcile', requestId: request.id, documentId: pair.document.id,
          createDependency: { status: 'needs_reconcile', ...linkedProof }, issue: 'create_confirmation_conflict' });
        continue;
      }
    }
    const confirmation = linkedProof?.confirmation ?? hint.confirmation;
    if (!confirmation) {
      lookups.push({ status: 'needs_input', requestId: request.id, documentId: pair.document.id,
        issue: 'select_one_saved_stay' });
      continue;
    }
    // Explicit Lookup refreshes native state; old observations remain for receipt provenance.
    let candidate: ReservationWorkflowV2Observation | undefined;
    if (confirmation) {
      const lookupArrival = linkedProof?.arrival ?? hint.bookedArrival;
      const stayRequest = { confirmation, ...(lookupArrival ? { arrival: lookupArrival } : {}) };
      const found = ctx.nativeBatch ? await (async () => {
        const lock = paneStayPropertyLock(target.target);
        if (!lock) return null;
        return lock.withLock(async () => projectCloudStayFind(stayRequest,
          await runCloudStayFind({ request: stayRequest, target: target.target, signal: ctx.nativeBatch!.signal })),
        { ...acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS), signal: ctx.nativeBatch!.signal });
      })().catch(() => null) : await findStay(stayRequest, { target: target.target,
        lock: () => paneStayPropertyLock(target.target), acquisition: acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS) }).catch(() => null);
      const stay = found?.stay;
      const complete = found?.outcome === 'found' && Boolean(stay?.confirmation === confirmation && stay.firstName && stay.lastName && stay.status &&
        stay.arrival && stay.departure && !found.arrivalMismatch &&
        (!linkedProof || stay.arrival === linkedProof.arrival && stay.departure === linkedProof.departure));
      candidate = { ref: randomUUID(), generationId: loaded.draft.generationId, kind: 'stay_candidate',
        status: complete ? 'complete' : found?.outcome === 'execution_failure' ? 'failed' : 'partial',
        observedAt: new Date().toISOString(), propertyCode: loaded.draft.propertyCode, sourceMessageId: input.source.messageId,
        sourceRefs: [], criteria: { workflow: 'filing', requestId: request.id, targetHintId: hint.id, sourceHash: input.source.sourceHash,
          confirmation, bookedArrival: hint.bookedArrival || null,
          ...(linkedProof ? { createRequestId: linkedProof.requestId, createAllocationId: linkedProof.allocationId,
            createOperationId: linkedProof.operationId, createObservationRef: linkedProof.observationRef,
            createConfirmation: linkedProof.confirmation } : {}) },
        coverage: { complete, notes: complete ? [] : ['Fresh stay lookup did not verify one exact saved stay.'] },
        result: { outcome: found?.outcome ?? 'execution_failure', stay: complete ? stay : null,
          arrivalMismatch: found?.arrivalMismatch ?? false } };
      const saved = await appendReservationWorkflowV2Observation(stateContext(ctx), { workItemId: input.workItemId,
        source: input.source, observation: candidate });
      if (saved.status !== 'ok') return saved;
      appended.push(candidate);
    }
    lookups.push({ status: candidate?.status === 'complete' ? 'candidate' : 'needs_input', requestId: request.id,
      documentId: pair.document.id, ...(linkedProof ? { createDependency: { status: 'succeeded', ...linkedProof } } : {}),
      targetCandidate: candidate ? { observationRef: candidate.ref, stay: record(record(candidate.result)?.stay) } : null });
  }
  // Only a single complete host stay observation plus a source PDF can produce the no-Save target preview.
  const refreshed = await currentDraft(ctx, input);
  if (refreshed.draft && requests.length === 1 && !ctx.nativeBatch && !('system' in ctx)) {
    const selection = await selectionFor(ctx, refreshed.draft, requests[0]!.id, false);
    if (selection) {
      const preview = await runPreview(ctx, input, selection);
      if (preview.status === 'ready') {
        const observation = filingObservation(refreshed.draft, { requestId: selection.request.id }, selection, 'complete', {
          outcome: 'ready', documentId: selection.document.id, documentName: preview.documentName,
          mimeType: 'application/pdf', sha256: preview.documentSource.sha256,
          sourceSnapshotDigest: preview.documentSource.snapshotDigest,
          target: { confirmation: selection.confirmation, arrival: selection.arrival, departure: selection.departure,
            firstName: selection.firstName, lastName: selection.lastName, status: selection.status },
        });
        const saved = await appendReservationWorkflowV2Observation(stateContext(ctx), { workItemId: input.workItemId,
          source: input.source, observation });
        if (saved.status !== 'ok') return saved;
        appended.push(observation);
        lookups.push({ status: 'ready', requestId: selection.request.id, documentId: selection.document.id,
          observationRef: observation.ref, documentName: preview.documentName, sha256: preview.documentSource.sha256,
          target: { confirmation: selection.confirmation, arrival: selection.arrival, lastName: selection.lastName } });
      } else lookups.push({ status: 'needs_input', requestId: selection.request.id, issue: preview.reason });
    }
  }
  return { status: 'ok', lookups, observations: [...loaded.draft.observations, ...appended] };
}

/** No-Save native Documents form staging and exact source/target preview. */
export async function reservationWorkflowV2FilingPrepare(ctx: ReservationWorkflowV2FilingContext,
  input: ReservationWorkflowV2PrepareInput): Promise<Outcome> {
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  if (ctx.property.propertyCode !== 'HRCEN') return { status: 'unsupported', issue: 'filing_property_unavailable' };
  const selection = await selectionFor(ctx, loaded.draft, input.requestId, true);
  if (!selection) return { status: 'needs_input', issue: 'review_one_source_pdf_and_one_saved_stay' };
  const preview = await runPreview(ctx, input, selection);
  if (preview.status !== 'ready') return { status: preview.status, issue: preview.reason };
  if (preview.documentName !== selection.document.requestedName && selection.document.requestedName !== null) {
    return { status: 'unsupported', issue: 'requested_document_name_not_supported_by_bound_source' };
  }
  const requestedDescription = selection.document.requestedDescription;
  if (requestedDescription !== null && requestedDescription !== preview.documentName) {
    return { status: 'unsupported', issue: 'requested_document_description_not_supported' };
  }
  const selected = await selectedSource(ctx, input.source);
  if (!selected) return { status: 'refused', issue: 'source_mail_changed' };
  const expectedStay = { firstName: selection.firstName, status: selection.status, departure: selection.departure };
  const bound = await bindAttachDocumentForm({ db: ctx.db, transportId: ctx.transport.id, workItemId: input.workItemId,
    confirmation: selection.confirmation, arrival: selection.arrival, lastName: selection.lastName,
    attachmentId: selection.attachmentId, sourceMessageId: input.source.messageId,
    internetMessageId: selected.internetMessageId, actorUserId: ctx.user.id,
    selectedSource: { threadId: input.source.threadId, messageId: input.source.messageId, sourceHash: input.source.sourceHash },
    documentSource: preview.documentSource, revisionSeq: input.expectedSeq, expectedStay });
  if (bound.status !== 'bound' || !bound.formDigest) return { status: bound.status, issue: bound.status === 'refused' ? bound.reason : 'filing_bind_failed' };
  const snapshot = await prepareHmsWriteSnapshot({ db: ctx.db, transportId: ctx.transport.id, workItemId: input.workItemId,
    selectedInternetMessageId: selected.internetMessageId,
    selectedSource: { threadId: input.source.threadId, messageId: input.source.messageId, sourceHash: input.source.sourceHash },
    expectedFormDigest: bound.formDigest, confirmation: selection.confirmation, arrival: selection.arrival });
  if (snapshot.status !== 'stored') return { status: 'failed', issue: snapshot.reason };
  const target = paneStayHmsTargetForTransport(ctx.transport.id);
  if (!target.ok) return { status: 'unsupported', issue: 'filing_property_unavailable' };
  // Native staging is read-only; write admission is checked separately on Go.
  const allowRealGuest = true;
  const cloud = await readPaneCloudFilingRecord({ confirmation: selection.confirmation, arrival: selection.arrival,
    target: target.target, allowRealGuest });
  if (!cloud || cloud.nativeGuestId === '' || cloud.nativeStayId === '' ||
      bound.form.filingStateDigest !== filingStateDigest(cloud)) return { status: 'failed', issue: 'filing_target_unavailable' };
  const semanticDigest = selectionDigest(selection, preview, preview.documentName);
  const observation = filingObservation(loaded.draft, { requestId: input.requestId }, selection, 'complete', {
    outcome: 'prepared', documentId: selection.document.id, documentName: preview.documentName,
    mimeType: 'application/pdf', sha256: preview.documentSource.sha256,
    sourceSnapshotDigest: preview.documentSource.snapshotDigest, semanticDigest,
    target: { confirmation: cloud.stay.confirmation, arrival: cloud.stay.arrival, departure: cloud.stay.departure,
      firstName: cloud.stay.firstName, lastName: cloud.stay.lastName, status: cloud.stay.status,
      nativeGuestId: cloud.nativeGuestId, nativeStayId: cloud.nativeStayId, cmsSend: cloud.filingSnapshot.cmsSend },
    filingStateDigest: filingStateDigest(cloud), documentCode: bound.form.documentCode ?? null,
    prepareFormDigest: bound.formDigest, hmsReadAt: snapshot.readAt,
  });
  const saved = await recordFilingOperation(ctx, input, observation, 'prepared', 'PDF and saved stay prepared in HMS; nothing saved');
  if (saved.status !== 'ok') return saved;
  return { status: 'prepared', requestId: input.requestId, documentId: selection.document.id,
    observationRef: observation.ref, documentName: preview.documentName, sha256: preview.documentSource.sha256,
    documentCode: bound.form.documentCode, target: observation.result.target, hmsReadAt: snapshot.readAt };
}

function getPrepared(draft: ReservationWorkflowV2Draft, requestId: string, documentId: string) {
  const prepared = latestPrepared(draft, requestId, documentId);
  if (!prepared) return null;
  const result = record(prepared.observation.result), target = record(result?.target);
  if (!result || !target || typeof result.semanticDigest !== 'string' || typeof result.documentCode !== 'string' ||
      typeof result.sha256 !== 'string' || typeof result.sourceSnapshotDigest !== 'string' || typeof result.filingStateDigest !== 'string' ||
      typeof target.nativeGuestId !== 'string' || typeof target.nativeStayId !== 'string' ||
      typeof target.confirmation !== 'string' || typeof target.arrival !== 'string' || typeof target.departure !== 'string') return null;
  return { ...prepared, result: { ...result, semanticDigest: result.semanticDigest, documentCode: result.documentCode,
    sha256: result.sha256, sourceSnapshotDigest: result.sourceSnapshotDigest, filingStateDigest: result.filingStateDigest }, target };
}

function recoveryMatchesDraft(draft: ReservationWorkflowV2Draft, recovery: V2FilingRecovery): boolean {
  const prepare = draft.observations.find((entry) => entry.ref === recovery.prepareObservationRef);
  const target = draft.observations.find((entry) => entry.ref === recovery.targetObservationRef);
  // Editable selection may have been undone after dispatch; recovery remains tied to
  // the original host document and sealed preparation, never the current selection.
  const request = draft.proposal.content.requests.find((entry) => entry.id === recovery.requestId && entry.kind === 'filing');
  const document = draft.proposal.content.documents.find((entry) => entry.id === recovery.documentId && entry.ownerRequestId === recovery.requestId);
  const preparedResult = record(prepare?.result), preparedTarget = record(preparedResult?.target);
  const stay = record(record(target?.result)?.stay);
  if (!prepare || !target || !request || !document || !preparedResult || !preparedTarget || !stay) return false;
  return draft.generationId === prepare.generationId && draft.propertyCode === 'HRCEN' &&
    document.documentSourceRef === recovery.documentSourceRef &&
    target?.kind === 'stay_candidate' && target.status === 'complete' && target.coverage.complete &&
    target.propertyCode === 'HRCEN' && target.criteria.workflow === 'filing' &&
    target.criteria.requestId === recovery.requestId &&
    record(target.result)?.outcome === 'found' && stay?.confirmation === recovery.confirmation &&
    stay?.arrival === recovery.arrival && stay?.departure === recovery.departure &&
    stay?.firstName === recovery.firstName && stay?.lastName === recovery.lastName && stay?.status === recovery.status &&
    prepare.kind === 'document' && prepare.status === 'complete' && prepare.criteria.workflow === 'filing' &&
    prepare.criteria.requestId === recovery.requestId && prepare.criteria.documentId === recovery.documentId &&
    prepare.criteria.documentSourceRef === recovery.documentSourceRef &&
    prepare.criteria.targetObservationRef === recovery.targetObservationRef &&
    prepare.sourceRefs.includes(recovery.targetObservationRef) &&
    preparedResult?.semanticDigest === recovery.semanticDigest && preparedResult.sha256 === recovery.pdfSha256 &&
    preparedResult.sourceSnapshotDigest === recovery.sourceSnapshotDigest &&
    preparedResult.documentName === recovery.documentName && preparedResult.documentCode === recovery.documentCode &&
    preparedResult.filingStateDigest === recovery.targetSnapshotDigest &&
    preparedTarget?.confirmation === recovery.confirmation && preparedTarget.arrival === recovery.arrival &&
    preparedTarget.departure === recovery.departure && preparedTarget.nativeStayId === recovery.nativeStayId &&
    preparedTarget.nativeGuestId === recovery.nativeGuestId && preparedTarget.cmsSend === recovery.cmsSend;
}

async function currentV2Source(tx: WorkTransaction, ctx: ReservationWorkflowV2FilingContext,
  input: { workItemId: string; source: ReservationWorkflowV2Source }) {
  const [source] = await tx.select({ id: message.id, threadId: message.threadId, direction: message.direction,
    historyOnly: message.historyOnly, sourceProvenance: message.sourceProvenance,
    subject: message.subject, textBody: message.textBody, htmlBody: message.htmlBody, arrivedAt: MESSAGE_ARRIVED_AT })
    .from(message).innerJoin(mailThread, and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, message.transportId)))
    .where(and(eq(message.id, input.source.messageId), eq(message.threadId, input.source.threadId),
      eq(message.transportId, ctx.transport.id), eq(message.direction, 'inbound'), eq(message.historyOnly, false),
      eq(mailThread.historyOnly, false), isNull(mailThread.trashedAt), isNull(mailThread.spamAt))).limit(1).for('share');
  const [transport] = await tx.select({ active: mailboxTransport.isActive }).from(mailboxTransport)
    .where(eq(mailboxTransport.id, ctx.transport.id)).limit(1).for('share');
  const [access] = await tx.select({ id: mailboxAccess.id }).from(mailboxAccess)
    .where(and(eq(mailboxAccess.userId, ctx.user.id), eq(mailboxAccess.transportId, ctx.transport.id))).limit(1).for('share');
  return source && source.arrivedAt instanceof Date && source.arrivedAt.toISOString() === input.source.arrivedAt &&
    transport?.active && access && source.sourceProvenance?.attention == null &&
    staffQuoteSourceHash(source) === input.source.sourceHash ? source : null;
}

async function authorizeCurrentFiling(tx: WorkTransaction, ctx: ReservationWorkflowV2FilingContext,
  input: ReservationWorkflowV2ExecuteInput, selection: FilingSelection, prepared: NonNullable<ReturnType<typeof getPrepared>>,
  form: V2BoundAttachForm, approvedDigest: string, attempt: ReservationWorkflowV2Observation) {
  await lockCreateActorAccess(tx, { actorUserId: ctx.user.id, transportId: ctx.transport.id });
  await lockCreateActorSession(tx, { actorUserId: ctx.user.id, sessionId: ctx.user.sessionId,
    sessionProfile: ctx.user.sessionProfile });
  const item = await lockBoundFilingSource(tx, { transportId: ctx.transport.id,
    workItemId: input.workItemId, form });
  if (!item || item.id !== input.workItemId || item.transportId !== ctx.transport.id ||
      item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq ||
      ['done', 'dismissed'].includes(item.status)) throw new Error('reservation_workflow_v2_filing_stale');
  const source = await currentV2Source(tx, ctx, input);
  const draft = source && reservationWorkflowV2DraftOf(item.state as Record<string, unknown>);
  const pair = draft && filingRequestAndDocument(draft, selection.request.id);
  const document = draft && pair && effectiveFilingDocument(draft, pair.document);
  const target = draft && pair && document && findTargetHint(draft, pair.request, document);
  const prior = draft?.operationResults.find((entry) => entry.id === input.idempotencyKey ||
    (entry.workflow === 'filing' && entry.requestId === selection.request.id &&
      (entry.status === 'unknown' || entry.status === 'succeeded')));
  const currentPrepared = draft && getPrepared(draft, selection.request.id, selection.document.id);
  if (!source || !draft || !pair || !document || !target || prior || !currentPrepared ||
      draft.workItemId !== input.workItemId || draft.transportId !== ctx.transport.id ||
      draft.propertyCode !== ctx.property.propertyCode || draft.generationId !== attempt.generationId ||
      draft.revision !== input.expectedRevision || draft.source.threadId !== input.source.threadId ||
      draft.source.messageId !== input.source.messageId || draft.source.sourceHash !== input.source.sourceHash ||
      draft.source.arrivedAt !== input.source.arrivedAt || document.id !== selection.document.id ||
      document.documentSourceRef !== selection.document.documentSourceRef || document.kind !== selection.document.kind ||
      document.handling !== selection.document.handling || target.targetPath !== selection.targetPath ||
      target.targetObservation.ref !== selection.targetObservation.ref ||
      draft.observations.some((entry) => entry.ref === attempt.ref) ||
      currentPrepared.result.semanticDigest !== prepared.result.semanticDigest ||
      currentPrepared.result.documentCode !== prepared.result.documentCode ||
      currentPrepared.result.sourceSnapshotDigest !== prepared.result.sourceSnapshotDigest ||
      !staffAccepted(draft, ptr('proposal', 'content', 'documents', selection.document.id, 'documentSourceRef')) ||
      !staffAccepted(draft, ptr('proposal', 'content', 'documents', selection.document.id, 'kind')) ||
      !staffAccepted(draft, ptr('proposal', 'content', 'documents', selection.document.id, 'handling')) ||
      !acceptedWhenRequested(draft, ptr('proposal', 'content', 'documents', selection.document.id, 'requestedName'), selection.document.requestedName) ||
      !acceptedWhenRequested(draft, ptr('proposal', 'content', 'documents', selection.document.id, 'requestedDescription'), selection.document.requestedDescription) ||
      !staffAccepted(draft, selection.targetPath) || formDigestForStoredForm(item.state as Record<string, unknown>) !== approvedDigest) {
    throw new Error('reservation_workflow_v2_filing_approval_changed');
  }
  // Commit the pending receipt with the dispatch intent, never before it.
  const result = { id: input.idempotencyKey, generationId: draft.generationId, requestId: selection.request.id,
    allocationId: null, workflow: 'filing' as const, status: 'unknown' as const, draftRevision: draft.revision,
    observationRefs: [attempt.ref], updatedAt: new Date().toISOString(), summary: 'HMS upload claimed; outcome pending reconciliation' };
  const next = reservationWorkflowV2DraftSchema.parse({ ...draft,
    observations: [...draft.observations, attempt], operationResults: [...draft.operationResults, result] });
  await tx.update(workItem).set({ state: { ...(item.state as Record<string, unknown>), reservationWorkflowV2: next },
    updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
  await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
    fieldPath: `reservationWorkflowV2:operationResults:${result.id}`,
    value: { id: result.id, requestId: result.requestId, allocationId: null, workflow: 'filing', status: result.status,
      observationRefs: result.observationRefs }, evidence: { sourceHash: input.source.sourceHash, summary: result.summary } });
}

/** Record a one-use gate proof in the same transaction that releases its claim. */
async function persistNeverDispatchedFiling(tx: WorkTransaction, ctx: ReservationWorkflowV2FilingContext,
  input: ReservationWorkflowV2ExecuteInput, intent: Readonly<HmsLabtestIntent>, selection: FilingSelection,
  generationId: string, form: AttachForm, requestDigest: string) {
  const [item] = await tx.select({ state: workItem.state }).from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, ctx.transport.id))).limit(1).for('update');
  const draft = item && reservationWorkflowV2DraftOf(item.state as Record<string, unknown>);
  const prior = draft?.operationResults.find((entry) => entry.id === input.idempotencyKey && entry.workflow === 'filing' &&
    entry.requestId === selection.request.id && entry.status === 'unknown');
  const recovery = record(intent.recovery), source = record(recovery?.source);
  if (!item || !draft || !prior || draft.workItemId !== input.workItemId || draft.transportId !== ctx.transport.id ||
      draft.propertyCode !== ctx.property.propertyCode || draft.generationId !== generationId ||
      draft.source.threadId !== input.source.threadId || draft.source.messageId !== input.source.messageId ||
      draft.source.sourceHash !== input.source.sourceHash || draft.source.arrivedAt !== input.source.arrivedAt ||
      !draft.observations.some((entry) => entry.ref === selection.targetObservation.ref) ||
      intent.operation !== 'attach_document' || intent.workItemId !== input.workItemId.toLowerCase() ||
      intent.transportId !== ctx.transport.id || intent.actorUserId !== ctx.user.id || intent.propertyCode !== ctx.property.propertyCode ||
      intent.grantId !== input.idempotencyKey.toLowerCase() || intent.sourceDigest !== form.sourceSnapshotDigest ||
      intent.approvedDigest !== approvedDigestForForm(form) || intent.requestDigest !== requestDigest ||
      recovery?.workItemId !== input.workItemId || recovery.operationId !== input.idempotencyKey ||
      recovery.requestId !== selection.request.id || recovery.documentId !== selection.document.id ||
      recovery.documentSourceRef !== selection.document.documentSourceRef ||
      recovery.targetObservationRef !== selection.targetObservation.ref || source?.threadId !== input.source.threadId ||
      source?.messageId !== input.source.messageId || source?.sourceHash !== input.source.sourceHash || source?.arrivedAt !== input.source.arrivedAt) {
    throw new Error('reservation_workflow_v2_filing_never_dispatched_scope_changed');
  }
  const observation = filingObservation(draft, { requestId: selection.request.id, operationId: input.idempotencyKey }, selection,
    'failed', { outcome: 'not_dispatched', dispatchHoldId: intent.holdId }, ['The native gate proved no upload was sent.']);
  const summary = 'Native gate proved PDF upload was not sent';
  const result = { ...prior, status: 'failed' as const, observationRefs: [observation.ref], updatedAt: new Date().toISOString(), summary };
  const next = reservationWorkflowV2DraftSchema.parse({ ...draft, observations: [...draft.observations, observation],
    operationResults: [...draft.operationResults.filter((entry) => entry.id !== prior.id), result] });
  await tx.update(workItem).set({ state: { ...(item.state as Record<string, unknown>), reservationWorkflowV2: next },
    updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
  await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
    fieldPath: `reservationWorkflowV2:operationResults:${result.id}`,
    value: { id: result.id, requestId: result.requestId, allocationId: null, workflow: 'filing', status: result.status,
      observationRefs: result.observationRefs }, evidence: { sourceHash: input.source.sourceHash, dispatchHoldId: intent.holdId, summary } });
}

function formDigestForStoredForm(state: Record<string, unknown>): string {
  const values = ['action', 'confirmation', 'arrival', 'lastName', 'attachmentId', 'documentName', 'pdfSha256',
    'sourceMessageId', 'sourceInternetMessageId', 'sourceSnapshotDigest', 'sourceThreadId', 'sourceHash',
    'documentCode', 'filingStateDigest'];
  return digestJson(Object.fromEntries(values.map((key) => [key, state[key]])));
}

function approvedDigestForForm(form: AttachForm): string {
  return digestJson({ action: form.action, confirmation: form.confirmation, arrival: form.arrival, lastName: form.lastName,
    attachmentId: form.attachmentId, documentName: form.documentName, pdfSha256: form.pdfSha256,
    sourceMessageId: form.sourceMessageId, sourceInternetMessageId: form.sourceInternetMessageId,
    sourceSnapshotDigest: form.sourceSnapshotDigest, sourceThreadId: form.sourceThreadId, sourceHash: form.sourceHash,
    documentCode: form.documentCode, filingStateDigest: form.filingStateDigest });
}

/** Staff Go → one exact intercepted Cloud Documents upload → fresh metadata readback and durable target receipt. */
export async function reservationWorkflowV2FilingExecute(ctx: ReservationWorkflowV2FilingContext,
  input: ReservationWorkflowV2ExecuteInput): Promise<Outcome> {
  if (!ctx.user.sessionId || !ctx.user.sessionProfile) return { status: 'refused', issue: 'authenticated_staff_session_required' };
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  if (ctx.property.propertyCode !== 'HRCEN') return { status: 'unsupported', issue: 'filing_property_unavailable' };
  const prior = loaded.draft.operationResults.find((entry) => entry.id === input.idempotencyKey);
  if (prior?.status === 'succeeded') return { status: 'succeeded', operationId: prior.id,
    summary: prior.summary, observationRefs: prior.observationRefs };
  if (prior?.status === 'unknown') return { status: 'needs_reconcile', operationId: prior.id };
  if (prior?.status === 'failed') return { status: 'failed', operationId: prior.id, summary: prior.summary };
  const existing = loaded.draft.operationResults.find((entry) => entry.workflow === 'filing' && entry.requestId === input.requestId &&
    (entry.status === 'unknown' || entry.status === 'succeeded'));
  if (existing) return { status: existing.status === 'succeeded' ? 'already_succeeded' : 'needs_reconcile',
    operationId: existing.id, summary: existing.summary, observationRefs: existing.observationRefs };
  const selection = await selectionFor(ctx, loaded.draft, input.requestId, true);
  if (!selection) return { status: 'needs_input', issue: 'review_one_source_pdf_and_one_saved_stay' };
  const prepared = getPrepared(loaded.draft, input.requestId, selection.document.id);
  if (!prepared) return { status: 'needs_prepare', issue: 'fresh_filing_prepare_required' };
  const preview = await runPreview(ctx, input, selection);
  if (preview.status !== 'ready') return { status: 'needs_prepare', issue: preview.reason };
  const name = preview.documentName;
  const semanticDigest = selectionDigest(selection, preview, name);
  if (semanticDigest !== prepared.result.semanticDigest || preview.documentSource.sha256 !== prepared.result.sha256 ||
      preview.documentSource.snapshotDigest !== prepared.result.sourceSnapshotDigest ||
      selection.document.requestedName !== null && selection.document.requestedName !== name ||
      selection.document.requestedDescription !== null && selection.document.requestedDescription !== name) {
    return { status: 'needs_prepare', issue: 'filing_source_or_target_changed' };
  }
  const [item] = await ctx.db.select({ state: workItem.state, status: workItem.status }).from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, ctx.transport.id))).limit(1);
  const form = item && item.status !== 'done' && item.status !== 'dismissed' ? itemAttachForm(item.state as Record<string, unknown>) : null;
  const approvedFormDigest = item && form ? formDigestForStoredForm(item.state as Record<string, unknown>) : null;
  if (!form || typeof form.pdfSha256 !== 'string' || typeof form.sourceSnapshotDigest !== 'string' || !approvedFormDigest || form.confirmation !== selection.confirmation || form.arrival !== selection.arrival ||
      form.attachmentId !== selection.attachmentId || form.sourceMessageId !== input.source.messageId ||
      form.sourceThreadId !== input.source.threadId || form.sourceHash !== input.source.sourceHash ||
      form.pdfSha256 !== preview.documentSource.sha256 || form.sourceSnapshotDigest !== preview.documentSource.snapshotDigest ||
      form.documentName !== name || form.documentCode !== prepared.result.documentCode) {
    return { status: 'needs_prepare', issue: 'filing_binding_changed' };
  }
  const writeMode = paneHmsWriteMode();
  const allowRealGuest = writeMode === 'on';
  if (writeMode === 'off') return { status: 'unsupported', issue: 'filing_save_disabled' };
  const hmsTarget = paneStayHmsTargetForTransport(ctx.transport.id);
  if (!hmsTarget.ok || hmsTarget.target.propertyCode !== 'HRCEN') return { status: 'unsupported', issue: 'filing_property_unavailable' };
  const cloud = await readPaneCloudFilingRecord({ confirmation: selection.confirmation, arrival: selection.arrival,
    target: hmsTarget.target, allowRealGuest });
  if (!cloud || filingStateDigest(cloud) !== prepared.result.filingStateDigest ||
      cloud.nativeGuestId !== prepared.target.nativeGuestId || cloud.nativeStayId !== prepared.target.nativeStayId ||
      cloud.filingSnapshot.cmsSend !== prepared.target.cmsSend) return { status: 'needs_prepare', issue: 'filing_target_changed' };
  const target = liveTargetForSaved(ctx, selection.confirmation, cloud.nativeStayId);
  if (!target) return { status: 'needs_reconcile', issue: 'filing_target_identity_unavailable' };
  const lock = paneStayCloudTargetLock(hmsTarget.target, target, { kind: 'independent_cloud' });
  if (!lock) return { status: 'needs_reconcile', issue: 'filing_target_lock_unavailable' };
  let expectedEpoch: string;
  try { expectedEpoch = await captureHmsLabtestDispatchEpoch(ctx.db, target, input.workItemId); }
  catch { return { status: 'needs_reconcile', issue: 'filing_dispatch_history_unavailable' }; }
  const selected = await selectedSource(ctx, input.source);
  if (!selected) return { status: 'refused', issue: 'source_mail_changed' };
  const bytes = await readBoundFilingSource({ db: ctx.db, transportId: ctx.transport.id, workItemId: input.workItemId,
    form });
  if (!bytes || !bytes.length || bytes.length > 10 * 1024 * 1024 || sha256(bytes) !== form.pdfSha256 ||
      bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return { status: 'needs_prepare', issue: 'source_pdf_changed' };

  const sourceSnapshotDigest = form.sourceSnapshotDigest, pdfSha256 = form.pdfSha256;
  const operationId = input.idempotencyKey;
  const stage = await mkdtemp(join(tmpdir(), 'reservation-v2-filing-'));
  const sourcePath = join(stage, 'upload.pdf');
  let dispatch: HmsLabtestWriteHandle | null = null;
  let closedWriterBinding: ClosedWriterBinding | null = null;
  let provedNoDispatch = false;
  let keepCloudEvidence = false;
  let native: Record<string, unknown> = {};
  let cloudRoot: string | null = null;
  const continuationDeadline = performance.now() + 7 * 60_000;
  try {
    await writeFile(sourcePath, bytes, { flag: 'wx', mode: 0o600 });
    const attachModule = await import(new URL('../../tooling/hms-cloud/pane-attach-session.mjs', import.meta.url).href) as {
      runCloudPaneAttach: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const runInput: Record<string, unknown> = {
      confirmation: selection.confirmation, arrival: selection.arrival, file: sourcePath, documentName: name,
      pdfSha256: pdfSha256, documentCode: form.documentCode, target: hmsTarget.target,
      guestName: `${cloud.stay.firstName} ${cloud.stay.lastName}`, allowRealGuest,
      approvedStay: approvedStay(cloud, allowRealGuest), approvedSnapshot: cloud.filingSnapshot,
      cloudTargetKey: hmsDispatchTargetKey(target),
      beforeDispatch: async () => {
        const live = await currentDraft(ctx, input);
        if (paneHmsWriteMode() !== writeMode || !live.draft || !await selectedSource(ctx, input.source)) return false;
        const liveSelection = await selectionFor(ctx, live.draft, input.requestId, true);
        const livePrepared = liveSelection && getPrepared(live.draft, input.requestId, selection.document.id);
        if (!liveSelection || !livePrepared || livePrepared.result.semanticDigest !== semanticDigest ||
            livePrepared.result.documentCode !== form.documentCode) return false;
        const liveBytes = await readBoundFilingSource({ db: ctx.db, transportId: ctx.transport.id, workItemId: input.workItemId, form });
        if (!liveBytes || !liveBytes.length || liveBytes.length > 10 * 1024 * 1024 ||
            sha256(liveBytes) !== pdfSha256 || liveBytes.subarray(0, 5).toString('ascii') !== '%PDF-') return false;
        const current = await readPaneCloudFilingRecord({ confirmation: selection.confirmation, arrival: selection.arrival,
          target: hmsTarget.target, allowRealGuest, cloudTargetKey: hmsDispatchTargetKey(target) });
        return Boolean(current && filingStateDigest(current) === prepared.result.filingStateDigest &&
          current.nativeStayId === cloud.nativeStayId && current.nativeGuestId === cloud.nativeGuestId &&
          current.filingSnapshot.cmsSend === cloud.filingSnapshot.cmsSend);
      },
      finalAuthority: async (code: string) => {
        if (code !== form.documentCode) return false;
        const live = await currentDraft(ctx, input);
        if (paneHmsWriteMode() !== writeMode || !live.draft || !await selectedSource(ctx, input.source)) return false;
        const liveSelection = await selectionFor(ctx, live.draft, input.requestId, true);
        const livePrepared = liveSelection && getPrepared(live.draft, input.requestId, selection.document.id);
        if (!liveSelection || !livePrepared || livePrepared.result.semanticDigest !== semanticDigest ||
            livePrepared.result.documentCode !== form.documentCode) return false;
        const liveBytes = await readBoundFilingSource({ db: ctx.db, transportId: ctx.transport.id, workItemId: input.workItemId, form });
        if (!liveBytes || !liveBytes.length || liveBytes.length > 10 * 1024 * 1024 ||
            sha256(liveBytes) !== pdfSha256 || liveBytes.subarray(0, 5).toString('ascii') !== '%PDF-') return false;
        const current = await readPaneCloudFilingRecord({ confirmation: selection.confirmation, arrival: selection.arrival,
          target: hmsTarget.target, allowRealGuest, cloudTargetKey: hmsDispatchTargetKey(target) });
        return Boolean(current && filingStateDigest(current) === prepared.result.filingStateDigest &&
          current.nativeStayId === cloud.nativeStayId && current.nativeGuestId === cloud.nativeGuestId &&
          current.filingSnapshot.cmsSend === cloud.filingSnapshot.cmsSend);
      },
      continuationAllowed: () => performance.now() < continuationDeadline,
      dispatchWithAuthority: async (code: string, nativeGuestId: string, nativeStayId: string, requestDigest: string,
        continuation: (() => Promise<unknown>) & { proveNeverDispatched?: () => unknown }, writer: unknown,
        beforePath: string, request: unknown) => {
        if (code !== form.documentCode || nativeGuestId !== cloud.nativeGuestId || nativeStayId !== cloud.nativeStayId ||
            !/^[a-f0-9]{64}$/.test(requestDigest)) throw new Error('filing_native_binding_changed');
        const before = await persistFilingShots(ctx, { workItemId: input.workItemId, runId: operationId, beforePath });
        if (!before) throw new Error('filing_before_evidence_unavailable');
        const recovery: V2FilingRecovery = { version: 1, workItemId: input.workItemId, operationId,
          requestId: input.requestId, documentId: selection.document.id,
          documentSourceRef: selection.document.documentSourceRef, source: input.source,
          attachmentId: selection.attachmentId, sourceSnapshotDigest: sourceSnapshotDigest,
          pdfSha256: pdfSha256, semanticDigest, documentName: name, documentCode: form.documentCode,
          confirmation: selection.confirmation, arrival: selection.arrival, departure: cloud.stay.departure!,
          nativeStayId: cloud.nativeStayId, nativeGuestId: cloud.nativeGuestId,
          firstName: cloud.stay.firstName!, lastName: cloud.stay.lastName!, status: cloud.stay.status!,
          cmsSend: cloud.filingSnapshot.cmsSend, allowRealGuest, targetObservationRef: selection.targetObservation.ref,
          prepareObservationRef: prepared.observation.ref, targetSnapshotDigest: prepared.result.filingStateDigest,
          beforeShot: before.beforeShot, writer };
        const attempt = filingObservation(loaded.draft!, { requestId: input.requestId, operationId }, selection,
          'partial', { outcome: 'dispatch_claimed', requestDigest, beforeShot: before.beforeShot,
            prepareObservationRef: prepared.observation.ref, target: prepared.target,
            sourcePdfSha256: pdfSha256, actualStoredSha256: null }, ['Fresh Documents readback pending']);
        const tryClaim = async () => claimHmsLabtestDispatch(ctx.db, {
          workItemId: input.workItemId, transportId: ctx.transport.id, actorUserId: ctx.user.id,
          grantId: operationId, propertyCode: 'HRCEN', firstName: recovery.firstName, lastName: recovery.lastName,
          nativeGuestId: cloud.nativeGuestId, target, operation: 'attach_document',
          sourceDigest: sourceSnapshotDigest, approvedDigest: approvedDigestForForm(form), requestDigest,
          recovery: recovery as unknown as Record<string, unknown>,
        }, async (tx) => authorizeCurrentFiling(tx, ctx, input, selection, prepared, form, approvedDigestForForm(form), attempt), expectedEpoch);
        // An ambiguous claim commit may have stored both the intent and unknown
        // result. Leave them intact rather than writing an unproven failure.
        const handle = await tryClaim();
        dispatch = handle;
        closedWriterBinding = { handle, writer, requestDigest };
        const claimObservation = filingObservation(loaded.draft, { requestId: input.requestId, operationId }, selection,
          'partial', { outcome: 'dispatch_claimed', dispatchHoldId: handle.holdId,
            requestDigest, sourcePdfSha256: pdfSha256, actualStoredSha256: null,
            prepareObservationRef: prepared.observation.ref }, ['Fresh Documents readback pending']);
        try {
          const claimed = await recordFilingOperation(ctx, input, claimObservation, 'unknown',
            'HMS upload is authorized; fresh readback pending', operationId);
          if (claimed.status !== 'ok') throw new Error('reservation_workflow_v2_filing_receipt_unavailable');
          return await continuation();
        }
        catch (error) {
          const proof = continuation.proveNeverDispatched?.();
          if (proof) {
            await resolveNeverDispatchedAttach(ctx.db, handle, proof, request, async (tx, intent) =>
              persistNeverDispatchedFiling(tx, ctx, input, intent, selection, loaded.draft!.generationId, form, requestDigest));
            provedNoDispatch = true; dispatch = null;
          }
          throw error;
        }
      },
    };
    native = await lock.withLock(() => attachModule.runCloudPaneAttach(runInput), acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
    const closedWriter = closedWriterBinding as ClosedWriterBinding | null;
    if (closedWriter && native.writerSessionClosed === true && native.dispatchCallbacksDrained === true) {
      // This receipt only makes a later positive read eligible; it never releases the hold itself.
      await recordFilingWriterClosed(ctx, input, closedWriter, sourceSnapshotDigest).catch(() => {});
    }
    cloudRoot = typeof native.cleanupRoot === 'string' ? native.cleanupRoot : null;
    const screenshots = Array.isArray(native.screenshots) ? native.screenshots.filter((path): path is string => typeof path === 'string') : [];
    const beforePath = screenshots.find((path) => basename(path) === 'before.png');
    const afterPath = screenshots.find((path) => basename(path) === 'after.png');
    const nativeTarget = targetReadback(native.nativeReadback);
    const activeDispatch = dispatch as HmsLabtestWriteHandle | null;
    const success = Boolean(activeDispatch && native.outcome === 'confirmed' && native.uploadSent === true && native.listed === true &&
      native.dispatchCallbacksDrained === true && native.writerSessionClosed === true && native.documentCode === form.documentCode &&
      nativeTarget && nativeTarget.confirmation === selection.confirmation && nativeTarget.nativeStayId === cloud.nativeStayId &&
      nativeTarget.nativeGuestId === cloud.nativeGuestId && nativeTarget.documentCode === form.documentCode &&
      nativeTarget.documentName === name && beforePath && afterPath);
    if (!activeDispatch) {
      return { status: provedNoDispatch ? 'failed' : 'refused', operationId,
        issue: String(native.issue ?? native.outcome ?? 'filing_not_dispatched') };
    }
    if (!success || !nativeTarget || !beforePath || !afterPath) {
      const shots = beforePath ? await persistFilingShots(ctx, { workItemId: input.workItemId, runId: operationId,
        beforePath, ...(afterPath ? { afterPath } : {}) }) : null;
      const uncertain = filingObservation(loaded.draft, { requestId: input.requestId, operationId }, selection,
        'partial', { outcome: native.outcome ?? 'unknown', dispatchHoldId: activeDispatch.holdId,
          uploadSent: native.uploadSent === true, listed: native.listed === true, nativeReadback: native.nativeReadback ?? null,
          sourcePdfSha256: pdfSha256, actualStoredSha256: null, beforeShot: shots?.beforeShot ?? null,
          prepareObservationRef: prepared.observation.ref }, ['Upload may have reached HMS; fresh reconciliation is required.']);
      await recordFilingOperation(ctx, input, uncertain, 'unknown', 'PDF upload outcome needs fresh reconciliation', operationId);
      keepCloudEvidence = native.uploadSent === true && !shots;
      return { status: 'needs_reconcile', operationId, dispatchHoldId: activeDispatch.holdId,
        issue: 'filing_readback_unverified', nativeOutcome: native.outcome ?? 'unknown' };
    }
    const shots = await persistFilingShots(ctx, { workItemId: input.workItemId, runId: operationId, beforePath, afterPath });
    if (!shots?.savedShot) {
      const uncertain = filingObservation(loaded.draft, { requestId: input.requestId, operationId }, selection,
        'partial', { outcome: 'confirmed_but_evidence_unsealed', dispatchHoldId: activeDispatch.holdId,
          nativeReadback: nativeTarget, sourcePdfSha256: pdfSha256, actualStoredSha256: null,
          prepareObservationRef: prepared.observation.ref }, ['HMS listing is positive but durable screenshot evidence is unavailable.']);
      await recordFilingOperation(ctx, input, uncertain, 'unknown', 'HMS lists the PDF; durable write proof needs reconciliation', operationId);
      keepCloudEvidence = true;
      return { status: 'needs_reconcile', operationId, dispatchHoldId: activeDispatch.holdId, issue: 'filing_evidence_unavailable' };
    }
    const successObservation = filingObservation(loaded.draft, { requestId: input.requestId, operationId }, selection,
      'complete', { outcome: 'confirmed', dispatchHoldId: activeDispatch.holdId, nativeReadback: nativeTarget,
        readbackDigest: digestJson(nativeTarget), sourcePdfSha256: pdfSha256,
        actualStoredSha256: null, storedBytesHashVerified: false,
        storedHashNote: 'HMS Documents currently exposes unique document code/name listing only; stored bytes are not downloadable by this reader.',
        beforeShot: shots.beforeShot, savedShot: shots.savedShot, prepareObservationRef: prepared.observation.ref });
    try {
      await resolveHmsLabtestDispatch(ctx.db, activeDispatch, { operation: 'attach_document',
        confirmation: nativeTarget.confirmation, nativeStayId: nativeTarget.nativeStayId,
        nativeReadback: nativeTarget, readbackDigest: digestJson(nativeTarget), savedShot: shots.savedShot }, async (tx, intent) => {
        const recovery = record(intent.recovery);
        if (intent.workItemId !== input.workItemId || intent.transportId !== ctx.transport.id ||
            intent.actorUserId !== ctx.user.id || intent.grantId !== operationId ||
            intent.sourceDigest !== sourceSnapshotDigest || intent.approvedDigest !== approvedDigestForForm(form) ||
            intent.requestDigest === '' || recovery?.requestId !== input.requestId || recovery?.documentId !== selection.document.id ||
            recovery?.documentCode !== form.documentCode || recovery?.semanticDigest !== semanticDigest) {
          throw new Error('reservation_workflow_v2_filing_resolution_scope_changed');
        }
        await recordFilingOperationInTransaction(tx, ctx, intent, successObservation,
          `Filed ${name}; fresh Documents listing and stay identity verified`);
      });
    } catch {
      const uncertain = filingObservation(loaded.draft, { requestId: input.requestId, operationId }, selection,
        'partial', { outcome: 'durable_resolution_unconfirmed', dispatchHoldId: activeDispatch.holdId,
          nativeReadback: nativeTarget, sourcePdfSha256: pdfSha256, actualStoredSha256: null,
          savedShot: shots.savedShot, prepareObservationRef: prepared.observation.ref }, ['Native result is positive; durable dispatch release is pending reconciliation.']);
      await recordFilingOperation(ctx, input, uncertain, 'unknown', 'PDF appears in HMS; durable receipt needs reconciliation', operationId);
      return { status: 'needs_reconcile', operationId, dispatchHoldId: activeDispatch.holdId,
        issue: 'durable_filing_resolution_unconfirmed', nativeReadback: nativeTarget };
    }
    dispatch = null;
    return { status: 'succeeded', operationId, requestId: input.requestId, documentId: selection.document.id,
      target: { confirmation: nativeTarget.confirmation, nativeStayId: nativeTarget.nativeStayId },
      documentCode: nativeTarget.documentCode, documentName: nativeTarget.documentName,
      sourcePdfSha256: pdfSha256, actualStoredSha256: null, storedBytesHashVerified: false,
      observationRef: successObservation.ref };
  } catch (error) {
    const activeDispatch = dispatch as HmsLabtestWriteHandle | null;
    if (activeDispatch) {
      const uncertain = filingObservation(loaded.draft, { requestId: input.requestId, operationId }, selection,
        'partial', { outcome: 'uncertain', dispatchHoldId: activeDispatch.holdId, issue: 'native_dispatch_interrupted',
          sourcePdfSha256: pdfSha256, actualStoredSha256: null,
          prepareObservationRef: prepared.observation.ref }, ['Upload may have reached HMS; fresh reconciliation is required.']);
      await recordFilingOperation(ctx, input, uncertain, 'unknown', 'PDF upload was interrupted; reconcile before retry', operationId);
      keepCloudEvidence = true;
      return { status: 'needs_reconcile', operationId, dispatchHoldId: activeDispatch.holdId, issue: 'native_dispatch_interrupted' };
    }
    return { status: provedNoDispatch ? 'failed' : 'refused', operationId, issue: error instanceof HmsLabtestDispatchError
      ? `filing_dispatch_${error.reason}` : 'filing_execution_failed' };
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    if (cloudRoot && !keepCloudEvidence) await rm(cloudRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function recordFilingOperationInTransaction(tx: WorkTransaction, ctx: ReservationWorkflowV2FilingContext,
  intent: HmsLabtestIntent, observation: ReservationWorkflowV2Observation, summary: string) {
  const recovery = record(intent.recovery) as unknown as V2FilingRecovery | null;
  if (!recovery || recovery.version !== 1 || recovery.operationId !== intent.grantId ||
      recovery.workItemId !== intent.workItemId || recovery.requestId !== observation.criteria.requestId ||
      recovery.documentId !== observation.criteria.documentId) throw new Error('reservation_workflow_v2_filing_recovery_invalid');
  const [item] = await tx.select({ id: workItem.id, state: workItem.state, revision: workItem.revision,
    revisionSeq: workItem.revisionSeq, transportId: workItem.transportId, sourceMessageId: workItem.sourceMessageId,
    threadId: workItem.threadId }).from(workItem).where(and(eq(workItem.id, recovery.workItemId),
      eq(workItem.transportId, ctx.transport.id))).limit(1).for('update');
  const draft = item && reservationWorkflowV2DraftOf(item.state as Record<string, unknown>);
  const current = item && await currentV2Source(tx, ctx, { workItemId: recovery.workItemId, source: recovery.source });
  if (!item || !draft || !current || item.transportId !== intent.transportId || item.sourceMessageId !== recovery.source.messageId ||
      item.threadId !== recovery.source.threadId || draft.generationId !== observation.generationId ||
      draft.source.sourceHash !== recovery.source.sourceHash || draft.source.arrivedAt !== recovery.source.arrivedAt ||
      draft.propertyCode !== ctx.property.propertyCode || draft.transportId !== ctx.transport.id ||
      !recoveryMatchesDraft(draft, recovery)) {
    throw new Error('reservation_workflow_v2_filing_result_scope_changed');
  }
  const prior = draft.operationResults.find((entry) => entry.id === recovery.operationId);
  if (!prior || prior.requestId !== recovery.requestId || prior.workflow !== 'filing' || prior.status !== 'unknown') {
    throw new Error('reservation_workflow_v2_filing_result_not_pending');
  }
  const observations = [...draft.observations.filter((entry) => entry.ref !== observation.ref), observation];
  const result = { id: recovery.operationId, generationId: draft.generationId, requestId: recovery.requestId,
    allocationId: null, workflow: 'filing' as const, status: 'succeeded' as const, draftRevision: prior.draftRevision,
    observationRefs: [observation.ref], updatedAt: new Date().toISOString(), summary };
  const next = reservationWorkflowV2DraftSchema.parse({ ...draft, observations,
    operationResults: [...draft.operationResults.filter((entry) => entry.id !== result.id), result] });
  await tx.update(workItem).set({ state: { ...(item.state as Record<string, unknown>), reservationWorkflowV2: next },
    updatedAt: new Date() }).where(eq(workItem.id, item.id));
  await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'system', type: 'write.evidence',
    fieldPath: `reservationWorkflowV2:operationResults:${result.id}`,
    value: { id: result.id, requestId: result.requestId, allocationId: null, workflow: 'filing', status: 'succeeded',
      observationRefs: result.observationRefs },
    evidence: { sourceHash: recovery.source.sourceHash, dispatchHoldId: intent.holdId, summary } });
}

/** Positive-only reconcile: a fresh independent native Documents read must prove the same code/name/stay before release. */
export async function reservationWorkflowV2FilingReconcile(ctx: ReservationWorkflowV2FilingContext,
  input: ReservationWorkflowV2ReconcileInput): Promise<Outcome> {
  if (!z.string().uuid().safeParse(input.operationId).success) return { status: 'invalid_input', issue: 'operation_id_must_be_uuid' };
  const initial = await currentDraft(ctx, input);
  if (!initial.draft) return initial.result;
  const result = initial.draft.operationResults.find((entry) => entry.id === input.operationId);
  if (!result || result.workflow !== 'filing') return { status: 'not_found' };
  if (result.status === 'succeeded') return { status: 'succeeded', operationId: result.id,
    summary: result.summary, observationRefs: result.observationRefs };
  if (result.status === 'failed') return { status: 'failed', operationId: result.id, summary: result.summary };
  if (result.status !== 'unknown') return { status: 'not_reconcilable', operationId: result.id };
  const recordNotDispatched = async (generationId: string, note: string) => {
    const observation: ReservationWorkflowV2Observation = { ref: randomUUID(), generationId,
      kind: 'document', status: 'failed', observedAt: new Date().toISOString(), propertyCode: initial.draft!.propertyCode,
      sourceMessageId: initial.draft!.source.messageId, sourceRefs: [],
      criteria: { workflow: 'filing', operationId: input.operationId, sourceHash: input.source.sourceHash },
      coverage: { complete: false, notes: [note] }, result: { outcome: 'not_dispatched', sourcePdfSha256: null,
        actualStoredSha256: null } };
    const current = await currentDraft(ctx, input);
    if (!current.draft) return current.result;
    const base = { workItemId: input.workItemId, source: input.source,
      expectedRevision: current.result.revision, expectedSeq: current.result.seq };
    const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), { ...base, observation });
    if (appended.status !== 'ok') return appended;
    const failed = await recordReservationWorkflowV2Result(stateContext(ctx), { ...base, result: {
      id: input.operationId, generationId: current.draft.generationId, requestId: result.requestId,
      allocationId: null, workflow: 'filing', status: 'failed', draftRevision: result.draftRevision,
      observationRefs: [observation.ref], updatedAt: new Date().toISOString(), summary: 'No upload was dispatched',
    } });
    return failed.status === 'ok' ? { status: 'failed', operationId: input.operationId,
      issue: 'filing_not_dispatched' } : failed;
  };
  const rows = await ctx.db.select({ id: workEvent.id, value: workEvent.value }).from(workEvent)
    .where(and(eq(workEvent.workItemId, input.workItemId), eq(workEvent.type, 'write.evidence'),
      eq(workEvent.fieldPath, 'nava.hms.labtest.dispatch.v1'),
      sql`${workEvent.value}->>'kind' = 'intent'`, sql`${workEvent.value}->>'grantId' = ${input.operationId}`)).limit(2);
  const intents = rows.map((row) => record(row.value)).filter((value): value is Record<string, unknown> => Boolean(value && value.kind === 'intent' &&
    value.operation === 'attach_document' && value.grantId === input.operationId));
  if (!intents.length) return { status: 'needs_reconcile', operationId: input.operationId,
    issue: 'filing_dispatch_intent_not_yet_observed' };
  const intent = intents.find((value) => record(value.recovery)?.operationId === input.operationId &&
    record(value.recovery)?.requestId === result.requestId && record(value.recovery)?.workItemId === input.workItemId);
  if (!intent || typeof intent.holdId !== 'string' || !z.string().uuid().safeParse(intent.holdId).success) {
    return { status: 'needs_reconcile', operationId: result.id, issue: 'filing_dispatch_intent_scope_unverified' };
  }
  const terminal = await ctx.db.select({ value: workEvent.value }).from(workEvent).where(and(
    eq(workEvent.workItemId, input.workItemId), eq(workEvent.type, 'write.evidence'),
    eq(workEvent.fieldPath, 'nava.hms.labtest.dispatch.v1'),
    sql`${workEvent.value}->>'holdId' = ${intent.holdId}`)).limit(4);
  if (terminal.some((row) => {
    const value = record(row.value);
    return value?.kind === 'not_dispatched' && value.holdId === intent.holdId && value.operation === 'attach_document';
  })) return recordNotDispatched(initial.draft.generationId, 'The native gate proved this upload was never sent.');
  try { await recoverHmsLabtestV2Attach(ctx.db, intent.holdId,
    ctx.recovery ? { scope: ctx.recovery, userId: ctx.user.id } : undefined); }
  catch { return { status: 'needs_reconcile', operationId: result.id, issue: 'fresh_documents_readback_not_positive' }; }
  const resolved = await currentDraft(ctx, input);
  if (!resolved.draft) return resolved.result;
  const final = resolved.draft.operationResults.find((entry) => entry.id === input.operationId);
  return final?.status === 'succeeded' ? { status: 'succeeded', operationId: final.id,
    summary: final.summary, observationRefs: final.observationRefs }
    : { status: 'needs_reconcile', operationId: input.operationId, issue: 'filing_recovery_receipt_missing' };
}

/** Reconciliation driver hook; never accepts a target or proof from the client. */
export async function withReservationWorkflowV2AttachRecoveryLock<T>(intent: HmsLabtestIntent, action: () => Promise<T>): Promise<T> {
  const target = paneStayHmsTargetForTransport(intent.transportId);
  const saved = hmsDispatchTargetSchema.safeParse(intent.target);
  if (!target.ok || target.target.propertyCode !== 'HRCEN' || !saved.success || saved.data.kind !== 'saved' ||
      !saved.data.confirmation || !saved.data.nativeStayId) throw new Error('filing_recovery_target_unavailable');
  const lock = paneStayCloudTargetLock(target.target, saved.data, { kind: 'independent_cloud' });
  if (!lock) throw new Error('filing_recovery_lock_unavailable');
  return lock.withLock(action, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
}

/** Trusted fresh-session proof for a v2 upload intent. */
export async function proveReservationWorkflowV2AttachRecovery(db: DB, intent: HmsLabtestIntent,
  recoveryScope?: ReservationWorkflowV2FilingRecoveryAccess): Promise<PositiveFilingProof> {
  const recovery = z.object({ version: z.literal(1), workItemId: z.string().uuid(), operationId: z.string().uuid(),
    requestId: z.string(), documentId: z.string(), documentSourceRef: z.string(), source: z.object({
      threadId: z.string(), messageId: z.string(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
      arrivedAt: z.string().datetime({ offset: true }), }).strict(), attachmentId: z.string(),
    sourceSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/), pdfSha256: z.string().regex(/^[a-f0-9]{64}$/),
    semanticDigest: z.string().regex(/^[a-f0-9]{64}$/),
    documentName: z.string(), documentCode: z.string(), confirmation: z.string(), arrival: z.string(), departure: z.string(),
    nativeStayId: z.string(), nativeGuestId: z.string(), firstName: z.string(), lastName: z.string(), status: z.string(),
    cmsSend: z.boolean(), allowRealGuest: z.boolean(), targetObservationRef: z.string(), prepareObservationRef: z.string(),
    targetSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/), beforeShot: z.object({ runId: z.string().uuid(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), writer: z.record(z.unknown()) }).strict().safeParse(intent.recovery);
  if (!recovery.success || intent.operation !== 'attach_document' || intent.workItemId !== recovery.data.workItemId ||
      intent.grantId !== recovery.data.operationId || intent.propertyCode !== 'HRCEN' ||
      intent.sourceDigest !== recovery.data.sourceSnapshotDigest || !/^[a-f0-9]{64}$/.test(intent.approvedDigest) ||
      intent.nativeGuestId !== recovery.data.nativeGuestId || intent.firstName !== recovery.data.firstName ||
      intent.lastName !== recovery.data.lastName || intent.target?.kind !== 'saved' ||
      intent.target.confirmation !== recovery.data.confirmation || intent.target.nativeStayId !== recovery.data.nativeStayId) {
    throw new Error('filing_recovery_intent_invalid');
  }
  const [item] = await db.select({ id: workItem.id, transportId: workItem.transportId, threadId: workItem.threadId,
    sourceMessageId: workItem.sourceMessageId, state: workItem.state }).from(workItem)
    .where(and(eq(workItem.id, recovery.data.workItemId), eq(workItem.transportId, intent.transportId))).limit(1);
  if (recoveryScope && (recoveryScope.scope.workItemId !== recovery.data.workItemId ||
      recoveryScope.scope.operationId !== recovery.data.operationId)) throw new Error('filing_recovery_scope_changed');
  const recoveryUserId = recoveryScope?.userId ?? intent.actorUserId;
  const current = await getReservationWorkflowV2Draft({ db, transportId: intent.transportId,
    userId: recoveryUserId, propertyCode: 'HRCEN', recovery: recoveryScope?.scope }, { workItemId: recovery.data.workItemId,
    source: recovery.data.source });
  const draft = current.status === 'ok' ? current.draft : null;
  if (!item || !draft || draft.transportId !== intent.transportId || draft.propertyCode !== 'HRCEN' ||
      !recoveryMatchesDraft(draft, recovery.data) ||
      draft.source.sourceHash !== recovery.data.source.sourceHash || item.sourceMessageId !== recovery.data.source.messageId ||
      item.threadId !== recovery.data.source.threadId || item.sourceMessageId !== draft.source.messageId ||
      item.threadId !== draft.source.threadId) throw new Error('filing_recovery_source_changed');
  const [access] = await db.select({ id: mailboxAccess.id }).from(mailboxAccess).where(and(
    eq(mailboxAccess.userId, recoveryUserId), eq(mailboxAccess.transportId, intent.transportId))).limit(1);
  if (!access) throw new Error('filing_recovery_access_unavailable');
  const attachReader = await import(new URL('../../tooling/hms-cloud/pane-attach-session.mjs', import.meta.url).href) as {
    provePositiveAttachRecovery: (intent: HmsLabtestIntent, options?: { writerQuiesced: (writer: unknown) => boolean }) => Promise<Record<string, unknown>>;
  };
  const closed = await hasFilingWriterClosedReceipt(db, intent, recovery.data);
  const proof = await attachReader.provePositiveAttachRecovery(intent, closed ? {
    writerQuiesced: (writer) => canonicalJson(writer) === canonicalJson(recovery.data.writer),
  } : undefined);
  const nativeReadback = targetReadback(proof.readback);
  if (proof.outcome !== 'verified' || !nativeReadback || nativeReadback.confirmation !== recovery.data.confirmation ||
      nativeReadback.nativeStayId !== recovery.data.nativeStayId || nativeReadback.nativeGuestId !== recovery.data.nativeGuestId ||
      nativeReadback.documentCode !== recovery.data.documentCode || nativeReadback.documentName !== recovery.data.documentName ||
      !Buffer.isBuffer(proof.screenshot)) throw new Error('filing_recovery_readback_unavailable');
  const owner = `${intent.actorUserId}:${intent.transportId}`;
  const before = await readStoredHmsShot({ runId: recovery.data.beforeShot.runId, name: 'before.png', owner });
  if (!before || sha256(before) !== recovery.data.beforeShot.sha256) throw new Error('filing_recovery_before_shot_unavailable');
  const stage = await mkdtemp(join(tmpdir(), 'reservation-v2-filing-recovery-'));
  try {
    await writeFile(join(stage, 'before.png'), before, { flag: 'wx', mode: 0o600 });
    await writeFile(join(stage, 'saved.png'), proof.screenshot, { flag: 'wx', mode: 0o600 });
    const shots = await persistHmsShots({ propertyCode: 'HRCEN', workItemId: intent.workItemId,
      runId: recovery.data.operationId, sourceDir: stage, owner, now: Date.now() });
    const saved = shots?.find((shot) => shot.name === 'saved.png');
    if (!saved || !await verifyStoredHmsShot({ runId: recovery.data.operationId, name: 'saved.png', sha256: saved.sha256,
      owner, propertyCode: 'HRCEN', workItemId: intent.workItemId }, 'saved.png')) throw new Error('filing_recovery_saved_shot_unavailable');
    return { confirmation: nativeReadback.confirmation, nativeStayId: nativeReadback.nativeStayId,
      nativeReadback, readbackDigest: digestJson(nativeReadback),
      savedShot: { runId: recovery.data.operationId, sha256: saved.sha256 } };
  } finally { await rm(stage, { recursive: true, force: true }).catch(() => {}); }
}

/** Atomic v2 result recording inside the dispatch-resolution transaction. */
export async function recordReservationWorkflowV2AttachRecovery(tx: WorkTransaction, intent: HmsLabtestIntent,
  proof: PositiveFilingProof, recoveryScope?: ReservationWorkflowV2FilingRecoveryAccess) {
  const recovery = record(intent.recovery) as unknown as V2FilingRecovery | null;
  if (!recovery || recovery.operationId !== intent.grantId || proof.confirmation !== recovery.confirmation ||
      proof.nativeStayId !== recovery.nativeStayId || proof.nativeReadback.documentCode !== recovery.documentCode ||
      proof.nativeReadback.documentName !== recovery.documentName || proof.savedShot.runId !== recovery.operationId) {
    throw new Error('filing_recovery_scope_changed');
  }
  const [item] = await tx.select({ id: workItem.id, state: workItem.state, transportId: workItem.transportId,
    sourceMessageId: workItem.sourceMessageId, threadId: workItem.threadId }).from(workItem)
    .where(and(eq(workItem.id, recovery.workItemId), eq(workItem.transportId, intent.transportId))).limit(1).for('update');
  const draft = item && reservationWorkflowV2DraftOf(item.state as Record<string, unknown>);
  const prepare = draft?.observations.find((entry) => entry.ref === recovery.prepareObservationRef);
  const prior = draft?.operationResults.find((entry) => entry.id === recovery.operationId);
  if (recoveryScope && (recoveryScope.scope.workItemId !== recovery.workItemId ||
      recoveryScope.scope.operationId !== recovery.operationId)) throw new Error('filing_recovery_scope_changed');
  const recoveryContext: ReservationWorkflowV2FilingContext = { db: tx as unknown as DB,
    transport: { id: intent.transportId }, user: { id: recoveryScope?.userId ?? intent.actorUserId },
    property: { propertyCode: 'HRCEN' }, recovery: recoveryScope?.scope };
  const current = item && await getReservationWorkflowV2Draft(stateContext(recoveryContext),
    { workItemId: recovery.workItemId, source: recovery.source });
  const source = await currentV2Source(tx, recoveryContext, { workItemId: recovery.workItemId,
    source: recoveryScope?.scope.currentSource ?? recovery.source });
  if (!item || !draft || !prepare || !prior || !source || current?.status !== 'ok' ||
      !recoveryMatchesDraft(draft, recovery) || prior.status !== 'unknown' || prior.workflow !== 'filing' ||
      prior.requestId !== recovery.requestId || item.sourceMessageId !== recovery.source.messageId ||
      item.threadId !== recovery.source.threadId || draft.source.sourceHash !== recovery.source.sourceHash ||
      draft.source.arrivedAt !== recovery.source.arrivedAt ||
      draft.generationId !== prepare.generationId || draft.transportId !== ctxTransportId(intent) ||
      draft.propertyCode !== 'HRCEN') throw new Error('filing_recovery_state_changed');
  const observation: ReservationWorkflowV2Observation = { ref: randomUUID(), generationId: draft.generationId,
    kind: 'document', status: 'complete', observedAt: new Date().toISOString(), propertyCode: draft.propertyCode,
    sourceMessageId: draft.source.messageId, sourceRefs: [recovery.targetObservationRef, recovery.prepareObservationRef],
    criteria: { workflow: 'filing', requestId: recovery.requestId, documentId: recovery.documentId,
      operationId: recovery.operationId, targetObservationRef: recovery.targetObservationRef,
      prepareObservationRef: recovery.prepareObservationRef, sourceSnapshotDigest: recovery.sourceSnapshotDigest },
    coverage: { complete: true, notes: [] }, result: { outcome: 'confirmed', recovered: true,
      target: { confirmation: proof.confirmation, nativeStayId: proof.nativeStayId, nativeGuestId: recovery.nativeGuestId },
      documentCode: recovery.documentCode, documentName: recovery.documentName,
      sourcePdfSha256: recovery.pdfSha256, actualStoredSha256: null, storedBytesHashVerified: false,
      nativeReadback: proof.nativeReadback, readbackDigest: proof.readbackDigest, savedShot: proof.savedShot,
      prepareObservationRef: recovery.prepareObservationRef } };
  const result = { id: recovery.operationId, generationId: draft.generationId, requestId: recovery.requestId,
    allocationId: null, workflow: 'filing' as const, status: 'succeeded' as const, draftRevision: prior.draftRevision,
    observationRefs: [observation.ref], updatedAt: new Date().toISOString(),
    summary: `Filed ${recovery.documentName}; independent fresh Documents listing verified` };
  const next = reservationWorkflowV2DraftSchema.parse({ ...draft, observations: [...draft.observations, observation],
    operationResults: [...draft.operationResults.filter((entry) => entry.id !== result.id), result] });
  await tx.update(workItem).set({ state: { ...(item.state as Record<string, unknown>), reservationWorkflowV2: next },
    updatedAt: new Date() }).where(eq(workItem.id, item.id));
  await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'system', type: 'write.evidence',
    fieldPath: `reservationWorkflowV2:operationResults:${result.id}`,
    value: { id: result.id, requestId: result.requestId, allocationId: null, workflow: 'filing', status: 'succeeded',
      observationRefs: result.observationRefs },
    evidence: { sourceHash: recovery.source.sourceHash, dispatchHoldId: intent.holdId, summary: result.summary } });
}

function ctxTransportId(intent: HmsLabtestIntent): string { return intent.transportId; }
