import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { mailboxAccess, mailThread, message } from '../db/schema/mail.js';
import { workEvent, workItem } from '../db/schema/work.js';
import { MESSAGE_ARRIVED_AT } from './message-arrival-time.js';
import { canonicalJson } from './draft-approval.js';
import { lockCreateActorSession, lockCreateActorAccess } from './pane-create-actor-lock.js';
import type { CreateFenceTransaction } from './pane-create-dispatch-fence.js';
import { readResolvedHmsLabtestCreates } from './hms-labtest-dispatch.js';
import { paneStayCloudTargetLock, paneStayCreateTarget, paneWriteMode, PANE_WRITE_CREATE } from './pane-stay-save.js';
import { acquisitionWithin, PANE_PROPERTY_LOCK_WAIT_MS, isPropertyReadLockDeadline } from '../hms/property-read-lock.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import {
  appendReservationWorkflowV2Observation,
  getReservationWorkflowV2Draft,
  RESERVATION_WORKFLOW_V2_STATE_KEY,
} from './reservation-workflow-v2-state.js';
import {
  reservationWorkflowV2DraftSchema,
  reservationWorkflowV2ExecuteInputSchema,
  type ReservationWorkflowV2Draft,
  type ReservationWorkflowV2Observation,
  type ReservationWorkflowV2ReconcileInput,
} from './reservation-workflow-v2-contract.js';
import {
  compileReservationWorkflowV2Create,
  type ReservationWorkflowV2ServerContext,
} from './reservation-workflow-v2-tools.js';
import {
  reservationWorkflowV2CompileServiceItem,
  reservationWorkflowV2ServicesForAllocation,
  type ReservationWorkflowV2CompiledServiceItem,
  type ReservationWorkflowV2ServiceRow,
  type ReservationWorkflowV2ServicesInput,
} from './reservation-workflow-v2-services.js';

const DISPATCH_FIELD = 'nava.reservation.workflow.v2.services.dispatch.v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const reservationWorkflowV2ServicesExecuteInputSchema = reservationWorkflowV2ExecuteInputSchema.extend({
  allocationId: z.string().min(1).max(80),
  serviceId: z.string().min(1).max(80),
}).strict();
export type ReservationWorkflowV2ServicesExecuteInput = z.infer<typeof reservationWorkflowV2ServicesExecuteInputSchema>;
type ExecuteInput = ReservationWorkflowV2ServicesExecuteInput;
type DispatchTx = CreateFenceTransaction;
type StoredIntent = {
  version: 1; kind: 'intent'; operationId: string; workItemId: string; transportId: string; actorUserId: string;
  sessionId: string; sessionProfile: 'legacy' | 'remote'; propertyCode: 'HRCEN'; sourceDigest: string;
  requestId: string; allocationId: string; serviceId: string; targetRef: { kind: 'allocation'; requestId: string; allocationId: string };
  target: { confirmation: string; nativeStayId: string; guestName: string; arrival: string; departure: string };
  generationId: string;
  createOperationId: string; createObservationRef: string; previewObservationRef: string; inputDigest: string;
  approvedItem: Record<string, unknown>; dispatchDigest: string; draftRevision: number; baselineIds: string[];
  baselineCoverage: Record<string, unknown>; createdAt: string;
};
type CompiledOk = Extract<ReservationWorkflowV2CompiledServiceItem, { outcome: 'ok' }>;
type ApprovedService = { draft: ReservationWorkflowV2Draft; plan: CompiledOk;
  preview: ReservationWorkflowV2Observation; create: CreateApproval };
type CreateApproval = { operationId: string; confirmation: string; observation: ReservationWorkflowV2Observation;
  expectedGuest: { firstName: string; lastName: string }; guestId: string; arrival: string; departure: string;
  semanticDigest: string; requestDigest: string };
type NativeTarget = { confirmation: string; nativeStayId: string; guestName: string; arrival: string; departure: string };

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const stateContext = (ctx: ReservationWorkflowV2ServerContext) => ({ db: ctx.db, transportId: ctx.transport.id,
  userId: ctx.user.id, propertyCode: ctx.property.propertyCode });

function sameName(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown) => typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase() : '';
  return normalize(left) !== '' && normalize(left) === normalize(right);
}

function normalizedItem(value: unknown): Record<string, unknown> | null {
  const item = object(value);
  if (!item) return null;
  const keys = ['code', 'name', 'itemId', 'quantity', 'startDate', 'endDate', 'unitPrice', 'frequency',
    'pricingControl', 'folio', 'comment', 'currency', 'averageDaily', 'totalCost', 'status'];
  if (keys.some((key) => !Object.hasOwn(item, key))) return null;
  return Object.fromEntries(keys.map((key) => [key, item[key]]));
}

function previewFor(draft: ReservationWorkflowV2Draft, input: ReservationWorkflowV2ServicesInput,
  row: ReservationWorkflowV2ServiceRow, plan: CompiledOk): ReservationWorkflowV2Observation | null {
  const observation = [...draft.observations].reverse().find((item) => item.kind === 'service_preview' &&
    item.status === 'complete' && item.propertyCode === 'HRCEN' && item.generationId === draft.generationId &&
    item.criteria.workflow === 'services' && item.criteria.kind === 'unsaved_addon_preview' &&
    item.criteria.serviceId === plan.serviceId && item.criteria.requestId === input.requestId &&
    item.criteria.allocationId === input.allocationId && item.criteria.targetRef &&
    canonicalJson(item.criteria.targetRef) === canonicalJson(plan.targetRef) && item.criteria.inputDigest === plan.inputDigest);
  const result = object(observation?.result);
  const expected = object(result?.requestedFields), native = normalizedItem(result?.native);
  if (!observation || !result || !expected || !native || result.saved !== false ||
      result.priceWasNativeCalculated !== true || canonicalJson(expected) !== canonicalJson(plan.items) ||
      native.code !== plan.candidate.code || native.itemId !== plan.candidate.itemId ||
      native.status !== 'VALID' || typeof native.unitPrice !== 'string' || typeof native.averageDaily !== 'string' ||
      typeof native.totalCost !== 'string' || typeof native.currency !== 'string') return null;
  return observation;
}

function createApproval(draft: ReservationWorkflowV2Draft, input: ReservationWorkflowV2ServicesInput): CreateApproval | null {
  const compiled = compileReservationWorkflowV2Create(draft, input.requestId, input.allocationId, 'HRCEN');
  if (compiled.outcome !== 'ok') return null;
  const operation = [...draft.operationResults].reverse().find((result) => result.workflow === 'create' &&
    result.requestId === input.requestId && result.allocationId === input.allocationId && result.status === 'succeeded');
  if (!operation) return null;
  const observation = draft.observations.find((item) => item.kind === 'stay_candidate' && item.status === 'complete' &&
    item.propertyCode === 'HRCEN' && item.generationId === draft.generationId && operation.observationRefs.includes(item.ref) &&
    item.criteria.workflow === 'create' && item.criteria.requestId === input.requestId &&
    item.criteria.allocationId === input.allocationId && item.criteria.idempotencyKey === operation.id);
  const result = object(observation?.result), confirmation = text(result?.confirmation);
  const prepareRef = text(result?.prepareObservationRef), prepare = draft.observations.find((item) => item.ref === prepareRef &&
    item.kind === 'rate_availability' && item.status === 'complete' && item.criteria.workflow === 'create' &&
    item.criteria.requestId === input.requestId && item.criteria.allocationId === input.allocationId);
  const prepareResult = object(prepare?.result), binding = object(prepareResult?.requestBinding);
  const request = object(binding?.request), guest = object(compiled.nativeInput.guest), stay = object(compiled.nativeInput.stay);
  const expectedGuest = compiled.expectedGuest;
  if (!observation || !result || !/^\d{6,10}-\d{1,2}$/.test(confirmation ?? '') ||
      result.priceMatched !== true || !object(result.savedShot) || !digest.safeParse(result.requestDigest).success ||
      !prepare || prepare.criteria.semanticDigest !== compiled.semanticDigest || !binding ||
      binding.digest !== result.requestDigest || !request || !guest || !/^[0-9]{1,30}$/.test(String(guest.profileId ?? '')) ||
      !stay || typeof stay.arrival !== 'string' || typeof stay.departure !== 'string' ||
      !sameName(object(request.guest)?.firstName, expectedGuest.firstName) ||
      !sameName(object(request.guest)?.lastName, expectedGuest.lastName) ||
      request.propertyCode !== 'HRCEN') return null;
  const nativePrice = object(result.savedPrice);
  if (!nativePrice || !text(nativePrice.averageRate) || !text(nativePrice.totalRate) || !text(nativePrice.currency)) return null;
  const nativeReadback = object(result.nativeReadback), nativeFields = Array.isArray(nativeReadback?.fields)
    ? nativeReadback.fields.map(object).filter(Boolean) : [];
  const labCms = nativeFields.filter((field) => field?.name === 'udfchkbox04');
  if (sameName(expectedGuest.firstName, 'Proof') && sameName(expectedGuest.lastName, 'Labtest') &&
      (labCms.length !== 1 || ![false, 'false', 0, '0'].includes(labCms[0]?.value as boolean | string | number))) return null;
  return { operationId: operation.id, confirmation, observation,
    expectedGuest: { firstName: expectedGuest.firstName, lastName: expectedGuest.lastName },
    guestId: String(guest.profileId), arrival: stay.arrival, departure: stay.departure,
    semanticDigest: compiled.semanticDigest, requestDigest: result.requestDigest as string };
}

function acceptedService(draft: ReservationWorkflowV2Draft, plan: CompiledOk): boolean {
  return plan.reviewPaths.every((path) => draft.fieldReviewRequirements[path]?.required === false ||
    draft.staffReviews[path]?.status === 'accepted');
}

function supportedGuestAdmission(approval: CreateApproval): { allowed: true } | { allowed: false; issue: string } {
  if (process.env.PANE_CLOUD_CREATE_DISPATCH !== 'on') return { allowed: false, issue: 'cloud_create_dispatch_flag_off' };
  const mode = paneWriteMode('create');
  if (mode === 'off') return { allowed: false, issue: 'pane_write_create_flag_off' };
  const isLabtest = sameName(approval.expectedGuest.firstName, 'Proof') && sameName(approval.expectedGuest.lastName, 'Labtest');
  if (!isLabtest && (mode !== 'on' || process.env[PANE_WRITE_CREATE] !== 'on')) {
    return { allowed: false, issue: 'real_guest_addon_requires_write_on' };
  }
  if (isLabtest && (approval.arrival < '2027-01-01')) return { allowed: false, issue: 'labtest_addon_requires_2027_stay' };
  return { allowed: true };
}

function approvedService(draft: ReservationWorkflowV2Draft, input: ReservationWorkflowV2ServicesInput):
  { outcome: 'ok'; value: ApprovedService } | { outcome: 'needs_input' | 'unsupported'; issue: string; fields?: string[] } {
  const links = reservationWorkflowV2ServicesForAllocation(draft, input);
  if (links.outcome !== 'ok') return { outcome: 'needs_input', issue: links.issue };
  if (!links.rows.length) return { outcome: 'needs_input', issue: 'service_target_not_found' };
  if (links.rows.length !== 1 || links.rows[0]?.service.id !== input.serviceId) {
    return { outcome: 'needs_input', issue: 'one_service_target_required' };
  }
  const row = links.rows[0]!;
  if (row.service.operation !== 'add') return { outcome: 'unsupported', issue: 'saved_addon_edit_remove_not_connected' };
  const compiled = reservationWorkflowV2CompileServiceItem(draft, input, row);
  if (compiled.outcome !== 'ok') return { outcome: compiled.outcome, issue: compiled.issue,
    fields: compiled.outcome === 'needs_input' ? compiled.fields : [] };
  if (!acceptedService(draft, compiled)) return { outcome: 'needs_input', issue: 'service_staff_review_required',
    fields: compiled.reviewPaths };
  const create = createApproval(draft, input);
  if (!create) return { outcome: 'needs_input', issue: 'confirmed_create_receipt_or_current_request_missing' };
  const preview = previewFor(draft, input, row, compiled);
  if (!preview) return { outcome: 'needs_input', issue: 'current_native_unsaved_addon_preview_required',
    fields: Object.values(compiled.fieldPaths) };
  return { outcome: 'ok', value: { draft, plan: compiled, preview, create } };
}

function sourceContextMatches(draft: ReservationWorkflowV2Draft, ctx: ReservationWorkflowV2ServerContext,
  input: ReservationWorkflowV2ServicesInput): boolean {
  return draft.workItemId === input.workItemId && draft.transportId === ctx.transport.id &&
    draft.propertyCode === ctx.property.propertyCode && draft.source.threadId === input.source.threadId &&
    draft.source.messageId === input.source.messageId && draft.source.sourceHash === input.source.sourceHash &&
    draft.source.arrivedAt === input.source.arrivedAt;
}

async function currentDraft(ctx: ReservationWorkflowV2ServerContext, input: ReservationWorkflowV2ServicesInput) {
  const loaded = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (loaded.status !== 'ok') return { draft: null, status: loaded.status } as const;
  if (loaded.draft.revision !== input.expectedRevision || loaded.seq !== input.expectedSeq ||
      !sourceContextMatches(loaded.draft, ctx, input)) return { draft: null, status: 'stale_revision' as const };
  return { draft: reservationWorkflowV2DraftSchema.parse(loaded.draft), status: 'ok' as const };
}

async function currentDraftTx(tx: DispatchTx, ctx: ReservationWorkflowV2ServerContext,
  input: ReservationWorkflowV2ServicesInput, exactCursor: boolean) {
  const [item] = await tx.select({ id: workItem.id, state: workItem.state, revision: workItem.revision,
    revisionHead: workItem.revisionHead, revisionSeq: workItem.revisionSeq, sourceMessageId: workItem.sourceMessageId,
    threadId: workItem.threadId }).from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, ctx.transport.id))).limit(1).for('update');
  const draft = item && reservationWorkflowV2DraftSchema.safeParse((item.state as Record<string, unknown>)[RESERVATION_WORKFLOW_V2_STATE_KEY]);
  if (!item || !draft?.success || !sourceContextMatches(draft.data, ctx, input) || item.sourceMessageId !== input.source.messageId ||
      item.threadId !== input.source.threadId || draft.data.revision !== item.revision ||
      (exactCursor && (item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq))) {
    throw new Error('reservation_workflow_v2_services_stale');
  }
  const [source] = await tx.select({ id: message.id, threadId: message.threadId, transportId: message.transportId,
    direction: message.direction, historyOnly: message.historyOnly, sourceProvenance: message.sourceProvenance,
    subject: message.subject, textBody: message.textBody, htmlBody: message.htmlBody, arrivedAt: MESSAGE_ARRIVED_AT })
    .from(message).innerJoin(mailThread, and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, message.transportId)))
    .where(and(eq(message.id, input.source.messageId), eq(message.threadId, input.source.threadId),
      eq(message.transportId, ctx.transport.id), eq(message.direction, 'inbound'), eq(message.historyOnly, false),
      eq(mailThread.historyOnly, false), isNull(mailThread.trashedAt), isNull(mailThread.spamAt))).limit(1).for('share');
  const [access] = await tx.select({ id: mailboxAccess.id }).from(mailboxAccess)
    .where(and(eq(mailboxAccess.userId, ctx.user.id), eq(mailboxAccess.transportId, ctx.transport.id))).limit(1).for('share');
  if (!source || !access || source.sourceProvenance?.attention != null ||
      staffQuoteSourceHash(source) !== input.source.sourceHash || !(source.arrivedAt instanceof Date) ||
      source.arrivedAt.toISOString() !== input.source.arrivedAt) throw new Error('reservation_workflow_v2_services_source_changed');
  await lockCreateActorAccess(tx, { transportId: ctx.transport.id, actorUserId: ctx.user.id });
  await lockCreateActorSession(tx, { actorUserId: ctx.user.id, sessionId: ctx.user.sessionId,
    sessionProfile: ctx.user.sessionProfile });
  return { item, draft: draft.data };
}

function createReceiptMatches(row: unknown, approval: CreateApproval, input: ReservationWorkflowV2ServicesInput,
  ctx: ReservationWorkflowV2ServerContext): boolean {
  const entry = object(row), intent = object(entry?.intent), resolution = object(entry?.resolution), recovery = object(intent?.recovery);
  return intent?.workItemId === input.workItemId && intent.transportId === ctx.transport.id &&
    intent.grantId === approval.operationId && intent.operation === 'create' &&
    intent.sourceDigest === input.source.sourceHash && intent.approvedDigest === approval.requestDigest &&
    recovery?.requestId === input.requestId && recovery.allocationId === input.allocationId &&
    resolution?.confirmation === approval.confirmation && resolution.kind === 'resolved';
}

function nativeTargetMatches(actual: unknown, expected: NativeTarget): boolean {
  const target = object(actual);
  return Boolean(target && target.confirmation === expected.confirmation && target.propertyCode === 'HRCEN' &&
    target.arrival === expected.arrival && target.departure === expected.departure && target.status === 'Reserved' &&
    sameName(target.guestName, expected.guestName));
}

async function assertFreshGuard(tx: DispatchTx, ctx: ReservationWorkflowV2ServerContext, input: ExecuteInput,
  expected: ApprovedService, nativeTarget: NativeTarget, requireCursor: boolean): Promise<void> {
  const { draft } = await currentDraftTx(tx, ctx, input, requireCursor);
  const approved = approvedService(draft, input);
  if (approved.outcome !== 'ok' || approved.value.create.operationId !== expected.create.operationId ||
      approved.value.create.confirmation !== expected.create.confirmation ||
      approved.value.plan.inputDigest !== expected.plan.inputDigest || approved.value.preview.ref !== expected.preview.ref ||
      !acceptedService(draft, approved.value.plan)) throw new Error('reservation_workflow_v2_services_approval_changed');
  if (process.env.PANE_CLOUD_CREATE_DISPATCH !== 'on') throw new Error('cloud_create_dispatch_flag_off');
  const mode = paneWriteMode('create');
  const isLabtest = sameName(expected.create.expectedGuest.firstName, 'Proof') &&
    sameName(expected.create.expectedGuest.lastName, 'Labtest');
  if (mode === 'off' || (!isLabtest && (mode !== 'on' || process.env[PANE_WRITE_CREATE] !== 'on')) ||
      (isLabtest && expected.create.arrival < '2027-01-01')) throw new Error('service_write_flag_or_guest_admission_changed');
  const createRows = await readResolvedHmsLabtestCreates(tx, input.workItemId);
  if (createRows.filter((receipt) => createReceiptMatches(receipt, expected.create, input, ctx)).length !== 1) {
    throw new Error('confirmed_create_receipt_unavailable');
  }
  if (nativeTarget.confirmation !== expected.create.confirmation || nativeTarget.arrival !== expected.create.arrival ||
      nativeTarget.departure !== expected.create.departure || !sameName(nativeTarget.guestName,
        `${expected.create.expectedGuest.firstName} ${expected.create.expectedGuest.lastName}`)) {
    throw new Error('services_native_target_changed');
  }
}

async function readSavedNativeTarget(approval: CreateApproval): Promise<NativeTarget | null> {
  const [{ withCenturionStay360Page }, confirmationTool, recordTool] = await Promise.all([
    import(new URL('../../tooling/playwright-quote/centurion-stay360.mjs', import.meta.url).href) as Promise<{
      withCenturionStay360Page: (callback: (page: unknown) => Promise<unknown>, options?: Record<string, unknown>) => Promise<unknown>;
    }>,
    import(new URL('../../tooling/hms-cloud/stay360-confirmation.mjs', import.meta.url).href) as Promise<{
      readConfirmationFromStay360: (page: unknown, confirmation: string, options?: Record<string, unknown>) => Promise<unknown>;
    }>,
    import(new URL('../../tooling/hms-cloud/stay360-record-view.mjs', import.meta.url).href) as Promise<{
      readRecordViewFromStay360: (page: unknown, confirmation: string, options?: Record<string, unknown>) => Promise<unknown>;
    }>,
  ]);
  const expectedName = `${approval.expectedGuest.firstName} ${approval.expectedGuest.lastName}`;
  let value: unknown;
  try {
    value = await withCenturionStay360Page(async (page) => {
      await confirmationTool.readConfirmationFromStay360(page, approval.confirmation, {
        guestName: expectedName, arrivalDate: approval.arrival,
      });
      return recordTool.readRecordViewFromStay360(page, approval.confirmation, { nativePropertyCode: 'HRCEN' });
    }, { headless: true, blockServiceWorkers: true });
  } catch { return null; }
  const preimage = object(object(value)?.nativePreimage);
  if (!preimage || preimage.source !== 'record_view_ext_model' || preimage.propertyCode !== 'HRCEN' ||
      preimage.confirmation !== approval.confirmation || preimage.status !== 'Reserved' ||
      preimage.guestId !== approval.guestId || !sameName(preimage.firstName, approval.expectedGuest.firstName) ||
      !sameName(preimage.lastName, approval.expectedGuest.lastName) || preimage.arrival !== approval.arrival ||
      preimage.departure !== approval.departure || !/^\d{1,100}$/.test(String(preimage.reservationStayId ?? ''))) return null;
  return { confirmation: approval.confirmation, nativeStayId: String(preimage.reservationStayId), guestName: expectedName,
    arrival: approval.arrival, departure: approval.departure };
}

function nativeMatchesApproval(preparedItem: unknown, preview: ReservationWorkflowV2Observation, plan: CompiledOk):
  { matches: boolean; native: Record<string, unknown> | null; approved: Record<string, unknown> | null } {
  const approved = normalizedItem(object(preview.result)?.native), native = normalizedItem(preparedItem);
  const matches = Boolean(approved && native && canonicalJson(approved) === canonicalJson(native) &&
    native.code === plan.candidate.code && native.itemId === plan.candidate.itemId && native.status === 'VALID' &&
    canonicalJson(object(preview.result)?.requestedFields) === canonicalJson(plan.items));
  return { matches, native, approved };
}

function appendOperationResult(draft: ReservationWorkflowV2Draft, result: ReservationWorkflowV2Draft['operationResults'][number]) {
  const prior = draft.operationResults.find((entry) => entry.id === result.id);
  if (prior && (prior.workflow !== 'services' || prior.requestId !== result.requestId ||
      prior.allocationId !== result.allocationId)) throw new Error('services_operation_id_reused');
  if (prior?.status === 'succeeded' && result.status !== 'succeeded') return draft.operationResults;
  return [...draft.operationResults.filter((entry) => entry.id !== result.id), result];
}

async function claimServiceDispatch(ctx: ReservationWorkflowV2ServerContext, input: ExecuteInput,
  approved: ApprovedService, target: NativeTarget, dispatch: Record<string, unknown>): Promise<StoredIntent> {
  const operationId = input.idempotencyKey;
  const baselineIds = Array.isArray(dispatch.baselineIds) ? dispatch.baselineIds.filter((value): value is string =>
    typeof value === 'string' && /^\d{1,100}$/.test(value)) : [];
  const baselineCoverage = object(dispatch.baselineCoverage);
  const item = normalizedItem(object(approved.preview.result)?.native);
  const dispatchedItem = object(dispatch.item);
  const dispatchFields = ['code', 'quantity', 'startDate', 'endDate', 'unitPrice', 'frequency', 'pricingControl',
    'folio', 'comment', 'currency', 'totalCost'];
  if (dispatch.operation !== 'addOns' || dispatch.confirmation !== target.confirmation ||
      !nativeTargetMatches(dispatch.target, target) ||
      baselineCoverage?.complete !== true || !item || !dispatchedItem ||
      dispatchFields.some((key) => !Object.hasOwn(dispatchedItem, key) || dispatchedItem[key] !== item[key]) ||
      !nativeMatchesApproval(item, approved.preview, approved.plan).matches ||
      baselineIds.length !== new Set(baselineIds).size) throw new Error('services_save_dispatch_binding_invalid');
  const dispatchDigest = hash({ operationId, serviceId: approved.plan.serviceId, target, item,
    inputDigest: approved.plan.inputDigest, previewObservationRef: approved.preview.ref, baselineIds });
  const intent: StoredIntent = { version: 1, kind: 'intent', operationId, workItemId: input.workItemId,
    transportId: ctx.transport.id, actorUserId: ctx.user.id, sessionId: ctx.user.sessionId!,
    sessionProfile: ctx.user.sessionProfile!, propertyCode: 'HRCEN', sourceDigest: input.source.sourceHash,
    requestId: input.requestId, allocationId: input.allocationId, serviceId: input.serviceId,
    targetRef: approved.plan.targetRef, target, generationId: approved.draft.generationId,
    createOperationId: approved.create.operationId,
    createObservationRef: approved.create.observation.ref, previewObservationRef: approved.preview.ref,
    inputDigest: approved.plan.inputDigest, approvedItem: item, dispatchDigest,
    draftRevision: input.expectedRevision, baselineIds, baselineCoverage, createdAt: new Date().toISOString() };
  const intentRef = randomUUID();
  await ctx.db.transaction(async (tx) => {
    const { item: workItemRow, draft } = await currentDraftTx(tx, ctx, input, true);
    const current = approvedService(draft, input);
    if (current.outcome !== 'ok' || current.value.plan.inputDigest !== approved.plan.inputDigest ||
        current.value.preview.ref !== approved.preview.ref || current.value.create.confirmation !== target.confirmation) {
      throw new Error('services_current_approval_changed');
    }
    await assertFreshGuard(tx, ctx, input, approved, target, true);
    const history = await tx.select({ id: workEvent.id, value: workEvent.value }).from(workEvent)
      .where(and(eq(workEvent.workItemId, input.workItemId), eq(workEvent.type, 'write.evidence'),
        eq(workEvent.fieldPath, DISPATCH_FIELD))).orderBy(asc(workEvent.at)).limit(10000);
    const events = history.map((entry) => object(entry?.value)).filter((value): value is Record<string, unknown> =>
      Boolean(value && value.version === 1 && value.serviceId === input.serviceId &&
        value.requestId === input.requestId && value.allocationId === input.allocationId &&
        value.targetRef && canonicalJson(value.targetRef) === canonicalJson(approved.plan.targetRef)));
    const latest = events.at(-1);
    if (events.some((entry) => entry.operationId === operationId) ||
        latest?.kind === 'intent' || latest?.kind === 'receipt' || latest?.kind !== undefined && latest.kind !== 'resolved') {
      throw new Error('services_prior_dispatch_requires_reconciliation');
    }
    if (draft.operationResults.some((result) => result.workflow === 'services' &&
        result.requestId === input.requestId && result.allocationId === input.allocationId && result.status === 'unknown')) {
      throw new Error('services_prior_operation_requires_reconciliation');
    }
    if (draft.operationResults.some((result) => result.id === operationId && result.workflow !== 'services')) {
      throw new Error('services_operation_id_reused');
    }
    const priorSucceeded = draft.operationResults.find((result) => result.workflow === 'services' &&
      result.requestId === input.requestId && result.allocationId === input.allocationId && result.status === 'succeeded' &&
      result.observationRefs.some((ref) => draft.observations.some((observation) => observation.ref === ref &&
        observation.criteria.serviceId === input.serviceId &&
        canonicalJson(observation.criteria.targetRef) === canonicalJson(approved.plan.targetRef))));
    if (priorSucceeded) throw new Error('services_already_succeeded');
    const operation = { id: operationId, generationId: draft.generationId, requestId: input.requestId,
      allocationId: input.allocationId, workflow: 'services' as const, status: 'unknown' as const,
      draftRevision: input.expectedRevision, observationRefs: [approved.preview.ref], updatedAt: new Date().toISOString(),
      summary: 'Add-On Save may dispatch; fresh HMS reconciliation required before retry' };
    const operationResults = appendOperationResult(draft, operation);
    const nextDraft = reservationWorkflowV2DraftSchema.parse({ ...draft, operationResults });
    const nextState = { ...(workItemRow.state as Record<string, unknown>), [RESERVATION_WORKFLOW_V2_STATE_KEY]: nextDraft };
    await tx.update(workItem).set({ state: nextState, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
    await tx.insert(workEvent).values({ id: intentRef, workItemId: input.workItemId, actorKind: 'system', actorUserId: ctx.user.id,
      type: 'write.evidence', fieldPath: DISPATCH_FIELD, value: intent,
      evidence: { sourceHash: input.source.sourceHash, seq: input.expectedSeq, operationId, dispatchDigest } });
    await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', actorUserId: ctx.user.id,
      type: 'write.evidence',
      fieldPath: `reservationWorkflowV2:operationResults:${operationId}`,
      value: { id: operationId, requestId: input.requestId, allocationId: input.allocationId,
        workflow: 'services', status: 'unknown', observationRefs: [approved.preview.ref] },
      evidence: { sourceHash: input.source.sourceHash, seq: input.expectedSeq, summary: operation.summary } });
  });
  return intent;
}

async function appendServiceEvent(ctx: ReservationWorkflowV2ServerContext, intent: StoredIntent,
  value: Record<string, unknown>): Promise<void> {
  await ctx.db.insert(workEvent).values({ workItemId: intent.workItemId, actorKind: 'system', actorUserId: intent.actorUserId,
    type: 'write.evidence', fieldPath: DISPATCH_FIELD, value: { version: 1, kind: 'receipt', operationId: intent.operationId,
      requestId: intent.requestId, allocationId: intent.allocationId, serviceId: intent.serviceId,
      targetRef: intent.targetRef, ...value },
    evidence: { sourceHash: intent.sourceDigest, operationId: intent.operationId, dispatchDigest: intent.dispatchDigest } });
}

async function persistResolvedService(ctx: ReservationWorkflowV2ServerContext, input: ReservationWorkflowV2ServicesInput,
  intent: StoredIntent, result: Record<string, unknown>, readbackDigest: string): Promise<string | null> {
  const observationRef = randomUUID();
  const observation = serviceObservationFromRef(observationRef, intent, input, result);
  const summary = `Saved ${intent.serviceId} Add-On on ${intent.target.confirmation}; fresh native readback verified`;
  await ctx.db.transaction(async (tx) => {
    const [item] = await tx.select({ state: workItem.state, revision: workItem.revision, revisionSeq: workItem.revisionSeq })
      .from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, ctx.transport.id)))
      .limit(1).for('update');
    const parsed = item && reservationWorkflowV2DraftSchema.safeParse((item.state as Record<string, unknown>)[RESERVATION_WORKFLOW_V2_STATE_KEY]);
    if (!item || !parsed?.success || !sourceContextMatches(parsed.data, ctx, input) ||
        item.revisionSeq !== input.expectedSeq || parsed.data.generationId !== intent.generationId ||
        intent.workItemId !== input.workItemId || intent.transportId !== ctx.transport.id ||
        intent.requestId !== input.requestId || intent.allocationId !== input.allocationId ||
        intent.serviceId !== input.serviceId || intent.sourceDigest !== input.source.sourceHash) {
      throw new Error('services_result_scope_changed');
    }
    const draft = parsed.data;
    const pending = draft.operationResults.find((entry) => entry.id === intent.operationId && entry.workflow === 'services' &&
      entry.requestId === input.requestId && entry.allocationId === input.allocationId);
    if (!pending || !['unknown', 'succeeded'].includes(pending.status) ||
        !pending.observationRefs.includes(intent.previewObservationRef) ||
        !draft.observations.some((entry) => entry.ref === intent.previewObservationRef) ||
        !draft.observations.some((entry) => entry.ref === intent.createObservationRef)) {
      throw new Error('services_result_receipt_missing');
    }
    if (pending.status === 'succeeded') return;
    const nextResult = { id: intent.operationId, generationId: draft.generationId,
      requestId: input.requestId, allocationId: input.allocationId, workflow: 'services' as const,
      status: 'succeeded' as const, draftRevision: intent.draftRevision, observationRefs: [observation.ref],
      updatedAt: new Date().toISOString(), summary };
    const nextDraft = reservationWorkflowV2DraftSchema.parse({ ...draft, observations: [...draft.observations, observation],
      operationResults: appendOperationResult(draft, nextResult) });
    await tx.update(workItem).set({ state: { ...(item.state as Record<string, unknown>),
      [RESERVATION_WORKFLOW_V2_STATE_KEY]: nextDraft }, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
    await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
      fieldPath: `reservationWorkflowV2:operationResults:${intent.operationId}`,
      value: { id: intent.operationId, requestId: input.requestId, allocationId: input.allocationId,
        workflow: 'services', status: 'succeeded', observationRefs: [observation.ref] },
      evidence: { sourceHash: input.source.sourceHash, seq: item.revisionSeq, summary } });
    await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
      fieldPath: DISPATCH_FIELD, value: { version: 1, kind: 'resolved', operationId: intent.operationId,
        requestId: intent.requestId, allocationId: intent.allocationId, serviceId: intent.serviceId,
        targetRef: intent.targetRef, nativeId: result.nativeId, readbackDigest, status: 'verified' },
      evidence: { sourceHash: intent.sourceDigest, operationId: intent.operationId,
        dispatchDigest: intent.dispatchDigest, readbackDigest } });
  });
  return observation.ref;
}

function serviceObservationFromRef(ref: string, intent: StoredIntent, input: ReservationWorkflowV2ServicesInput,
  result: Record<string, unknown>): ReservationWorkflowV2Observation {
  return { ref, generationId: intent.generationId, kind: 'service_preview', status: 'complete', observedAt: new Date().toISOString(),
    propertyCode: 'HRCEN', sourceMessageId: input.source.messageId,
    sourceRefs: [intent.createObservationRef, intent.previewObservationRef],
    criteria: { workflow: 'services', kind: 'saved_addon_receipt', requestId: input.requestId,
      allocationId: input.allocationId, serviceId: input.serviceId, targetRef: intent.targetRef,
      operationId: intent.operationId, createOperationId: intent.createOperationId,
      createObservationRef: intent.createObservationRef, previewObservationRef: intent.previewObservationRef,
      inputDigest: intent.inputDigest, draftRevision: intent.draftRevision, dispatchDigest: intent.dispatchDigest },
    coverage: { complete: true, notes: [] }, result };
}

async function appendFreshPrepare(ctx: ReservationWorkflowV2ServerContext, input: ReservationWorkflowV2ServicesInput,
  approved: ApprovedService, target: NativeTarget, comparison: { matches: boolean;
    native: Record<string, unknown> | null; approved: Record<string, unknown> | null }, prepareVerified: boolean): Promise<string | null> {
  const nativeVerified = prepareVerified && Boolean(comparison.native && comparison.native.status === 'VALID' &&
    text(comparison.native.unitPrice) && text(comparison.native.averageDaily) && text(comparison.native.totalCost) &&
    text(comparison.native.currency));
  const result = { operation: 'add', saved: false, targetRef: approved.plan.targetRef, serviceId: approved.plan.serviceId,
    createConfirmation: approved.create.confirmation, createObservationRef: approved.create.observation.ref,
    itemCandidate: approved.plan.candidate, requestedFields: approved.plan.items,
    native: comparison.native, previouslyApprovedNative: comparison.approved,
    matchesUnsavedPreview: comparison.matches, hostValuesRequireReview: Object.values(approved.plan.fieldPaths),
    target: { confirmation: target.confirmation, arrival: target.arrival, departure: target.departure,
      nativeStayId: target.nativeStayId }, priceWasNativeCalculated: Boolean(nativeVerified && comparison.native?.averageDaily &&
      comparison.native?.totalCost) };
  const observation: ReservationWorkflowV2Observation = { ref: randomUUID(), generationId: approved.draft.generationId,
    kind: 'service_preview', status: nativeVerified ? 'complete' : 'partial', observedAt: new Date().toISOString(),
    propertyCode: 'HRCEN', sourceMessageId: input.source.messageId, sourceRefs: [approved.preview.ref, approved.create.observation.ref],
    criteria: { workflow: 'services', kind: 'saved_addon_fresh_prepare', requestId: input.requestId,
      allocationId: input.allocationId, serviceId: input.serviceId, targetRef: approved.plan.targetRef,
      inputDigest: approved.plan.inputDigest, createObservationRef: approved.create.observation.ref,
      unsavedPreviewRef: approved.preview.ref, reviewPaths: Object.values(approved.plan.fieldPaths) },
    coverage: { complete: nativeVerified, notes: nativeVerified ? [] : ['saved_target_prepare_incomplete'] }, result };
  const stored = await appendReservationWorkflowV2Observation(stateContext(ctx), { workItemId: input.workItemId,
    source: input.source, observation });
  return stored.status === 'ok' ? observation.ref : null;
}

function decodeIntent(value: unknown): StoredIntent | null {
  const candidate = object(value);
  if (!candidate || candidate.version !== 1 || candidate.kind !== 'intent' || typeof candidate.operationId !== 'string' ||
      typeof candidate.target !== 'object' || !object(candidate.target) || !digest.safeParse(candidate.sourceDigest).success ||
      !digest.safeParse(candidate.dispatchDigest).success || !Array.isArray(candidate.baselineIds) ||
      !object(candidate.baselineCoverage)) return null;
  return candidate as unknown as StoredIntent;
}

async function eventsForOperation(ctx: ReservationWorkflowV2ServerContext, input: ReservationWorkflowV2ReconcileInput) {
  const rows = await ctx.db.select({ id: workEvent.id, value: workEvent.value }).from(workEvent)
    .where(and(eq(workEvent.workItemId, input.workItemId), eq(workEvent.type, 'write.evidence'),
      eq(workEvent.fieldPath, DISPATCH_FIELD))).orderBy(asc(workEvent.at)).limit(10000);
  const events = rows.map((row) => object(row.value)).filter((value): value is Record<string, unknown> =>
    Boolean(value && value.operationId === input.operationId));
  const intent = events.map(decodeIntent).find((value): value is StoredIntent => Boolean(value));
  return { rows, events, intent };
}

function reconcileSave(intent: StoredIntent, receiptEvent: Record<string, unknown> | undefined) {
  const receipt = object(receiptEvent?.receipt), nativeId = text(receipt?.nativeId);
  const item = intent.approvedItem;
  const attempt = { index: 0, itemId: String(item.itemId), item, nativeId, dispatched: true,
    baselineIds: intent.baselineIds };
  return { confirmation: intent.target.confirmation, requestedCount: 1, receipts: [attempt], attempts: [attempt],
    baseline: intent.baselineIds.map((id) => ({ enhexpsequencekey: id })),
    baselineCoverage: intent.baselineCoverage, target: intent.target };
}

/**
 * Commit one reviewed Add-On to the exact stay previously confirmed by V2 Create.
 * A saved-target prepare is always fresh; changed fields/amounts become review evidence,
 * never a Save. The service dispatch intent is separate from Create/Amend dispatch kinds.
 */
export async function reservationWorkflowV2ExecuteServices(ctx: ReservationWorkflowV2ServerContext,
  rawInput: ReservationWorkflowV2ServicesExecuteInput): Promise<Record<string, unknown>> {
  const parsed = reservationWorkflowV2ServicesExecuteInputSchema.safeParse(rawInput);
  if (!parsed.success) return { status: 'invalid_input', issue: 'service_execute_input_invalid' };
  const input = parsed.data;
  if (ctx.property.propertyCode !== 'HRCEN') return { status: 'unsupported', issue: 'service_property_not_supported' };
  if (!input.go || !ctx.user.sessionId || !ctx.user.sessionProfile) return { status: 'refused', issue: 'staff_go_and_session_required' };
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return { status: loaded.status, issue: 'service_draft_unavailable' };
  const prior = loaded.draft.operationResults.find((entry) => entry.id === input.idempotencyKey);
  if (prior && prior.workflow !== 'services') return { status: 'refused', issue: 'services_operation_id_reused' };
  if (prior?.status === 'unknown') return { status: 'needs_reconcile', operationId: prior.id };
  if (prior?.status === 'failed') return { status: 'failed', operationId: prior.id, summary: prior.summary };
  if (prior && prior.status !== 'succeeded') return { status: 'refused', issue: 'services_operation_id_reserved' };
  if (loaded.draft.operationResults.some((entry) => entry.workflow === 'services' && entry.requestId === input.requestId &&
      entry.allocationId === input.allocationId && entry.status === 'unknown')) {
    return { status: 'needs_reconcile', issue: 'service_operation_already_unknown' };
  }
  const approvedResult = approvedService(loaded.draft, input);
  if (approvedResult.outcome !== 'ok') return { status: approvedResult.outcome, issue: approvedResult.issue,
    ...(approvedResult.fields ? { fields: approvedResult.fields } : {}) };
  const approved = approvedResult.value;
  if (prior?.status === 'succeeded') {
    const priorObservation = prior.observationRefs.map((ref) => loaded.draft!.observations.find((item) => item.ref === ref))
      .find((item) => Boolean(item && item.criteria.serviceId === input.serviceId &&
        item.criteria.requestId === input.requestId && item.criteria.allocationId === input.allocationId &&
        canonicalJson(item.criteria.targetRef) === canonicalJson(approved.plan.targetRef)));
    if (priorObservation) return { status: 'succeeded', operationId: prior.id, summary: prior.summary,
      observationRefs: prior.observationRefs, idempotent: true };
    return { status: 'refused', issue: 'services_operation_id_reused' };
  }
  const admission = supportedGuestAdmission(approved.create);
  if (!admission.allowed) return { status: 'refused', issue: admission.issue };
  if (loaded.draft.operationResults.some((entry) => entry.workflow === 'services' && entry.requestId === input.requestId &&
      entry.allocationId === input.allocationId && entry.status === 'succeeded' && entry.observationRefs.some((ref) =>
        loaded.draft!.observations.some((observation) => observation.ref === ref && observation.criteria.serviceId === input.serviceId &&
          canonicalJson(observation.criteria.targetRef) === canonicalJson(approved.plan.targetRef))))) {
    return { status: 'already_succeeded', issue: 'service_target_already_saved' };
  }
  const target = await readSavedNativeTarget(approved.create);
  if (!target) return { status: 'needs_reconcile', issue: 'created_native_stay_identity_unavailable',
    confirmation: approved.create.confirmation };
  const resolvedTarget = paneStayCreateTarget({ transportId: ctx.transport.id, propertyCode: 'HRCEN' });
  if (!resolvedTarget.ok || resolvedTarget.target.browserSlot !== 'centurion') return { status: 'unsupported', issue: 'service_property_session_unavailable' };
  const lock = paneStayCloudTargetLock(resolvedTarget.target,
    { propertyCode: 'HRCEN', kind: 'saved', confirmation: target.confirmation, nativeStayId: target.nativeStayId },
    { kind: 'independent_cloud' });
  if (!lock) return { status: 'needs_reconcile', issue: 'service_target_lock_unavailable' };
  let claimed: StoredIntent | null = null, claimAttempted = false;
  try {
    return await lock.withLock(async () => {
      const addon = await import(new URL('../../tooling/hms-cloud/stay360-addons-session.mjs', import.meta.url).href) as {
        withStay360AddOnSession: (callback: (session: { runTool: (request: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>,
          options: Record<string, unknown>) => Promise<unknown>;
      };
      const result = await addon.withStay360AddOnSession(async ({ runTool }) => {
        const read = object(await runTool({ tool: 'read', confirmation: target.confirmation,
          guestName: target.guestName, arrivalDate: target.arrival }));
        const observedTarget = object(read?.target);
        if (read?.outcome !== 'ok' || read.propertyCode !== 'HRCEN' || !nativeTargetMatches(observedTarget, target)) {
          return { outcome: 'needs_input', issue: 'saved_addon_target_read_unverified' };
        }
        const prepared = object(await runTool({ tool: 'prepare', confirmation: target.confirmation,
          items: [approved.plan.items] }));
        const nativeItem = object(Array.isArray(prepared?.items) ? prepared.items[0] : null);
        const itemFields = nativeItem?.item ?? nativeItem;
        const compared = nativeMatchesApproval(itemFields, approved.preview, approved.plan);
        if (prepared?.outcome !== 'prepared' || prepared.propertyCode !== 'HRCEN' || prepared.saved !== false ||
            typeof prepared.preparedId !== 'string' || !compared.matches) {
          const prepareVerified = prepared?.outcome === 'prepared' && prepared.propertyCode === 'HRCEN' &&
            prepared.saved === false && typeof prepared.preparedId === 'string';
          const observationRef = await appendFreshPrepare(ctx, input, approved, target, compared, prepareVerified);
          return { status: 'needs_review', issue: 'saved_addon_prepare_differs_from_approved_preview',
            observationRef, saved: false, native: compared.native, approved: compared.approved };
        }
        const save = await runTool({ tool: 'save', confirmation: target.confirmation, preparedId: prepared.preparedId });
        return { save };
      }, {
        authorize: async (prepared: unknown) => {
          const actual = object(prepared), items = Array.isArray(actual?.items) ? actual.items : [];
          if (!actual || actual.confirmation !== target.confirmation ||
              !nativeTargetMatches(actual.target, target) ||
              items.length !== 1 || !nativeMatchesApproval(items[0], approved.preview, approved.plan).matches ||
              canonicalJson(actual.requestedItems) !== canonicalJson([approved.plan.items])) return false;
          try {
            await ctx.db.transaction(async (tx) => assertFreshGuard(tx, ctx, input, approved, target, true));
            return true;
          } catch { return false; }
        },
        beforeDispatch: async (dispatch: unknown) => {
          const raw = object(dispatch);
          if (!raw) throw new Error('services_save_dispatch_invalid');
          claimAttempted = true;
          claimed = await claimServiceDispatch(ctx, input, approved, target, raw);
          return true;
        },
        afterDispatch: async (receipt: unknown) => {
          if (!claimed) throw new Error('services_save_claim_missing');
          await appendServiceEvent(ctx, claimed, { receipt: object(receipt) ?? {} });
        },
        withWriteLock: async (_confirmation: string, save: () => Promise<unknown>) => save(),
      });
      const objectResult = object(result), saveResult = object(objectResult?.save);
      if (!saveResult) {
        if (objectResult?.status === 'needs_review') return { ...objectResult, serviceId: input.serviceId,
          requestId: input.requestId, allocationId: input.allocationId };
        return { status: 'needs_input', issue: text(objectResult?.issue) ?? 'native_addon_save_not_started', saved: false };
      }
      if (!claimed) return claimAttempted
        ? { status: 'needs_reconcile', operationId: input.idempotencyKey, issue: 'services_save_claim_unconfirmed', saved: false }
        : { status: 'refused', issue: text(saveResult.issue) ?? 'services_save_not_authorized', saved: false };
      const verified = verifySavedResult(saveResult, approved);
      if (!verified.ok) return { status: 'needs_reconcile', operationId: claimed.operationId,
        issue: 'addon_save_or_fresh_readback_unverified', nativeOutcome: saveResult.outcome ?? null };
      const current = await getReservationWorkflowV2Draft(stateContext(ctx), input);
      if (current.status !== 'ok') return { status: 'needs_reconcile', operationId: claimed.operationId,
        issue: 'saved_addon_draft_receipt_unavailable', nativeId: verified.nativeId };
      const resultEvidence = { operation: 'add', saved: true, requestId: input.requestId, allocationId: input.allocationId,
        serviceId: input.serviceId, targetRef: approved.plan.targetRef, confirmation: target.confirmation,
        nativeStayId: target.nativeStayId, nativeId: verified.nativeId, requestedFields: approved.plan.items,
        itemCandidate: approved.plan.candidate, native: verified.native, previewObservationRef: approved.preview.ref,
        createObservationRef: approved.create.observation.ref, priceWasNativeCalculated: true,
        freshReadback: verified.readback };
      const readbackDigest = hash({ operationId: claimed.operationId, target, nativeId: verified.nativeId,
        businessItem: verified.native, readback: verified.readback });
      const observationRef = await persistResolvedService(ctx, input, claimed, resultEvidence, readbackDigest);
      if (!observationRef) return { status: 'needs_reconcile', operationId: claimed.operationId,
        issue: 'saved_addon_result_persist_unconfirmed', nativeId: verified.nativeId };
      return { status: 'succeeded', operationId: claimed.operationId, requestId: input.requestId,
        allocationId: input.allocationId, serviceId: input.serviceId, targetRef: approved.plan.targetRef,
        confirmation: target.confirmation, nativeId: verified.nativeId, item: verified.native, saved: true,
        observationRef };
    }, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
  } catch (error) {
    if (claimed || claimAttempted) return { status: 'needs_reconcile', operationId: claimed?.operationId ?? input.idempotencyKey,
      issue: isPropertyReadLockDeadline(error) ? 'service_target_lock_busy' : 'native_addon_outcome_unknown' };
    return { status: 'failed', issue: isPropertyReadLockDeadline(error) ? 'service_target_lock_busy' : 'native_addon_prepare_failed', saved: false };
  }
}

function verifySavedResult(save: Record<string, unknown>, approved: ApprovedService) {
  const reconciliation = object(save.reconciliation), verified = Array.isArray(reconciliation?.verified)
    ? reconciliation.verified.map(object).filter(Boolean) : [];
  const readback = object(reconciliation?.readback);
  const details = Array.isArray(readback?.details) ? readback.details.map(object).filter(Boolean) : [];
  const nativeId = text(verified[0]?.nativeId);
  const actual = normalizedItem(details.find((detail) => detail.nativeId === nativeId)?.fields);
  const expected = normalizedItem(object(approved.preview.result)?.native);
  return { ok: save.outcome === 'saved' && reconciliation?.outcome === 'verified' && verified.length === 1 &&
    Array.isArray(reconciliation.mismatches) && reconciliation.mismatches.length === 0 && readback?.outcome === 'ok' &&
    Boolean(nativeId && actual && expected && canonicalJson(actual) === canonicalJson(expected) &&
      actual.itemId === approved.plan.candidate.itemId), nativeId, native: actual, readback: reconciliation?.readback ?? null };
}

/** Positive-only recovery for an Add-On Save whose callback/receipt was interrupted. */
export async function reservationWorkflowV2ReconcileServices(ctx: ReservationWorkflowV2ServerContext,
  input: ReservationWorkflowV2ReconcileInput): Promise<Record<string, unknown>> {
  if (!z.string().uuid().safeParse(input.operationId).success || ctx.property.propertyCode !== 'HRCEN') {
    return { status: 'invalid_input', issue: 'service_operation_id_invalid' };
  }
  const loaded = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (loaded.status !== 'ok') return { status: loaded.status };
  const operation = loaded.draft.operationResults.find((entry) => entry.id === input.operationId);
  if (!operation || operation.workflow !== 'services') return { status: 'not_found' };
  if (operation.status === 'succeeded') return { status: 'succeeded', operationId: operation.id,
    summary: operation.summary, observationRefs: operation.observationRefs };
  if (operation.status !== 'unknown') return { status: 'not_reconcilable', operationId: operation.id };
  const { events, intent } = await eventsForOperation(ctx, input);
  if (!intent || intent.workItemId !== input.workItemId || intent.transportId !== ctx.transport.id ||
      intent.sourceDigest !== loaded.draft.source.sourceHash || intent.generationId !== loaded.draft.generationId ||
      intent.operationId !== input.operationId || operation.requestId !== intent.requestId ||
      operation.allocationId !== intent.allocationId) {
    return { status: 'needs_reconcile', operationId: input.operationId, issue: 'service_dispatch_claim_unavailable' };
  }
  const receipt = [...events].reverse().find((entry) => entry.kind === 'receipt');
  const save = reconcileSave(intent, receipt);
  const addon = await import(new URL('../../tooling/hms-cloud/stay360-addons-session.mjs', import.meta.url).href) as {
    reconcileStay360AddOns: (save: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
  };
  let result: unknown;
  try { result = await addon.reconcileStay360AddOns(save, { target: intent.target }); }
  catch { return { status: 'needs_reconcile', operationId: input.operationId, issue: 'service_fresh_read_unavailable' }; }
  const planItem = normalizedItem(intent.approvedItem), reconciliation = object(result);
  const verified = Array.isArray(reconciliation?.verified) ? reconciliation.verified.map(object).filter(Boolean) : [];
  const readback = object(reconciliation?.readback), details = Array.isArray(readback?.details) ? readback.details.map(object).filter(Boolean) : [];
  const nativeId = text(verified[0]?.nativeId), native = normalizedItem(details.find((detail) => detail.nativeId === nativeId)?.fields);
  if (reconciliation?.outcome !== 'verified' || verified.length !== 1 || !nativeId || !native || !planItem ||
      canonicalJson(native) !== canonicalJson(planItem) || !Array.isArray(reconciliation.mismatches) || reconciliation.mismatches.length) {
    return { status: 'needs_reconcile', operationId: input.operationId, issue: 'service_positive_readback_not_proven', reconciliation: result };
  }
  const sourceInput = { workItemId: input.workItemId, source: loaded.draft.source, expectedRevision: loaded.revision,
    expectedSeq: loaded.seq, requestId: intent.requestId, allocationId: intent.allocationId, serviceId: intent.serviceId };
  const resultEvidence = { operation: 'add', saved: true, requestId: intent.requestId, allocationId: intent.allocationId,
    serviceId: intent.serviceId, targetRef: intent.targetRef, confirmation: intent.target.confirmation,
    nativeStayId: intent.target.nativeStayId, nativeId, requestedFields: object(loaded.draft.observations.find((item) =>
      item.ref === intent.previewObservationRef)?.result)?.requestedFields ?? null,
    native, recovered: true, priceWasNativeCalculated: true, freshReadback: readback };
  const readbackDigest = hash({ operationId: intent.operationId, target: intent.target, nativeId, native, readback });
  let observationRef: string | null;
  try { observationRef = await persistResolvedService(ctx, sourceInput, intent, resultEvidence, readbackDigest); }
  catch { observationRef = null; }
  if (!observationRef) return { status: 'needs_reconcile', operationId: input.operationId, issue: 'service_resolution_persist_failed' };
  return { status: 'succeeded', operationId: input.operationId, serviceId: intent.serviceId,
    confirmation: intent.target.confirmation, nativeId, observationRef, recovered: true };
}
