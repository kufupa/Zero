import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type DB } from '../db/client.js';
import { aiWorkflowRun, mailActionLabel } from '../db/schema/mail.js';
import { MAIL_KINDS, workEvent, workItem } from '../db/schema/work.js';
import type { HmsReadTarget } from '../hms/hms-read-target.js';
import { canonicalJson } from './draft-approval.js';
import { approveHmsWrite, assertHmsSelectedSource, assertHmsUnchangedBeforeSave, assertNoOpenWrite, consumeHmsWriteApproval,
  endHmsWriteRun, formDigest, hmsStateDigest, lockConsumedCloudCancelApproval, recordHmsWriteEvidence } from './hms-approval.js';
import { hmsDispatchTargetKey, type HmsDispatchTarget } from './hms-dispatch-target.js';
import { captureHmsLabtestDispatchEpoch, claimHmsLabtestDispatch, HmsLabtestDispatchError,
  resolveHmsLabtestDispatch, type HmsLabtestWriteHandle } from './hms-labtest-dispatch.js';
import { heartbeatAiRun, HMS_WRITE_RUN_KIND, mergeTerminalRunMetrics, type AiFailureClass, type AiRunFence } from './run-ledger.js';
import { lockCreateActorAccess, lockCreateActorSession } from './pane-create-actor-lock.js';
import { assertNoCreateDispatchFence, type CreateFenceTransaction } from './pane-create-dispatch-fence.js';
import { lockCreateSource, withLockedCreateSource, type LockedCreateSource } from './pane-create-source-loader.js';
import { paneStayClock, paneWriteMode, registerPaneRun } from './pane-stay-save.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import type { MailKind } from './extraction/schema.js';
import { safeParseStoredMailExtraction } from './extraction/stored-mail-extraction.js';
import { hydrateStoredWorkState } from './stored-work-state.js';
import type { AttachmentRead } from './extraction/extract.js';
import { projectCancelRequests } from './pane-cancel-draft.js';
import type { PaneStayCancelResult } from './pane-stay-cancel.js';
import type { PaneHmsWriteResult } from './pane-hms-write.js';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().trim().min(1).max(200);
export const cancelSelectionSchema = z.object({ threadId: id, messageId: id, sourceHash: digest }).strict();
export const cancelRequestBindingFields = { requestId: digest.optional(),
  expectedSeq: z.number().int().nonnegative().safe().optional(), expectedExtractionId: z.string().uuid().optional() };
export type CancelRequestBinding = { requestId?: string; expectedSeq?: number; expectedExtractionId?: string };
export const completeCancelRequestBinding = (input: CancelRequestBinding) => {
  const count = [input.requestId, input.expectedSeq, input.expectedExtractionId].filter((value) => value !== undefined).length;
  return count === 0 || count === 3;
};
const requestSchema = z.object({ requestId: digest, proposalDigest: digest }).strict();
const cursorSchema = z.object({ extractionId: z.string().uuid(), revision: z.number().int().nonnegative().safe(),
  revisionHead: z.number().int().nonnegative().safe(), seq: z.number().int().nonnegative().safe() }).strict()
  .refine((value) => value.revision <= value.revisionHead);
const preimageSchema = z.object({ confirmation: z.string().regex(/^\d+-\d+$/), guestId: z.string().regex(/^\d{1,30}$/),
  nativeStayId: z.string().regex(/^\d{1,100}$/), firstName: z.string().trim().min(1).max(200).refine((name) => !/[\p{Cc}]/u.test(name)),
  lastName: z.string().trim().min(1).max(200).refine((name) => !/[\p{Cc}]/u.test(name)), arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departure: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), roomType: z.string().min(1).max(12),
  ratePlan: z.string().min(1).max(12), note: z.string().max(2000), depositReceived: z.string().nullable(),
  expectedGuarantee: z.object({ code: z.string().max(200), display: z.string().max(200) }).strict(),
  cmsSend: z.boolean(),
  allowRealGuest: z.boolean() }).strict();
const reasonSchema = z.object({ value: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  display: z.string().trim().min(1).max(120) }).strict();
const previewBodySchema = z.object({ version: z.literal(1), nonce: z.string().uuid(), source: cancelSelectionSchema,
  cursor: cursorSchema, sourceDigest: digest, stateDigest: digest, accessId: id, preimage: preimageSchema,
  reasons: z.array(reasonSchema).min(1).max(100), policyFacts: z.array(z.string().trim().min(1).max(260)).max(12),
  penaltyText: z.string().trim().min(1).max(2000).nullable(), actorUserId: id, sessionId: z.string().min(1).max(512),
  sessionProfile: z.enum(['legacy', 'remote']), readAt: z.string().datetime(), expiresAt: z.number().int(),
  reviewFormDigest: digest.optional(), request: requestSchema.optional() }).strict();
const previewSchema = previewBodySchema.extend({ digest }).strict();
export const cloudCancelDispatchSchema = z.object({ version: z.literal(1), source: cancelSelectionSchema,
  cursor: cursorSchema, sourceDigest: digest, accessId: id, preimage: preimageSchema,
  reasonCode: reasonSchema.shape.value, reasonLabel: reasonSchema.shape.display,
  cancellationNote: z.string().max(200), previewDigest: digest, request: requestSchema.optional() }).strict();
export type CloudCancelDispatch = z.infer<typeof cloudCancelDispatchSchema>;

type CancelContext = CancelRequestBinding & { db?: DB; transportId: string; actorUserId: string; sessionId?: string;
  sessionProfile?: 'legacy' | 'remote'; workItemId: string; source: z.infer<typeof cancelSelectionSchema>;
  confirmation: string; arrival: string; target: HmsReadTarget; env?: NodeJS.Dict<string>;
  selectedInternetMessageId?: string; expectedFormDigest?: string };
type NativeResult = { outcome: string; expected?: unknown; reasons?: unknown; policyFacts?: string[]; penaltyText?: string | null;
  zeroPenaltyNotice?: string;
  runDir?: string; screenshots?: string[];
  requestDispatched?: boolean; nativeReadback?: unknown; dispatchCallbacksDrained?: boolean; writerSessionClosed?: boolean };
type NativeRunner = (input: Record<string, unknown>) => Promise<NativeResult>;
export const cloudCancelLoaders: { run: NativeRunner | null } = { run: null };
export async function runCloudCancellation(input: Record<string, unknown>): Promise<NativeResult> {
  const target = input.target as HmsReadTarget | undefined;
  if (target?.propertyCode === 'HRCEN' && typeof input.confirmation === 'string' && input.cloudTargetKey === undefined) {
    input = { ...input, cloudTargetKey: hmsDispatchTargetKey({ propertyCode: 'HRCEN', kind: 'saved',
      confirmation: input.confirmation }) };
  }
  if (cloudCancelLoaders.run) return cloudCancelLoaders.run(input);
  const native = await import('../../tooling/hms-cloud/pane-cancel-session.mjs' as string) as { runCloudPaneCancel: NativeRunner };
  return native.runCloudPaneCancel(input);
}
const emptyResult = (outcome: string): PaneStayCancelResult => ({ outcome, statusBefore: null, statusAfter: null,
  reasons: [], penaltyText: null, message: null, arrivalMismatch: false, requestedArrival: null, hmsArrival: null,
  screenshots: [], runId: null, previewDigest: null });
const previewKey = 'cloudCancelPreview';
const withoutPreview = (state: Record<string, unknown>) => { const value = { ...state }; delete value[previewKey]; return value; };
const cleanNote = (raw?: string) => typeof raw === 'string' && raw.length <= 200 && !/[\p{Cc}]/u.test(raw) ? raw : raw === undefined ? '' : null;

async function cursorFor(db: DB, input: CancelContext) {
  const [item] = await db.select({ extractionId: workItem.extractionId, revision: workItem.revision,
    revisionHead: workItem.revisionHead, seq: workItem.revisionSeq }).from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1);
  return cursorSchema.parse(item);
}
function key(input: CancelContext, cursor: z.infer<typeof cursorSchema>) {
  return { transportId: input.transportId, workItemId: input.workItemId,
    threadId: input.source.threadId, messageId: input.source.messageId, cursor };
}

/** Resolve only a currently actionable request from the selected extraction. */
export function selectedEffectiveCancel(input: { source: z.infer<typeof cancelSelectionSchema>; extractionId: string;
  payload: unknown; state: Record<string, unknown>; ownerAction: unknown; kind: MailKind;
  attachments: AttachmentRead[] | null; requestId: string; confirmation: string; arrival: string;
  proposalDigest?: string }) {
  const payload = safeParseStoredMailExtraction(input.payload);
  if (!payload.success) return null;
  const request = projectCancelRequests(input.source, payload.data, hydrateStoredWorkState(input.state),
    input.ownerAction, input.kind).requests.find((entry) => entry.requestId === input.requestId);
  if (!request || request.action !== 'cancel' || request.workflow !== 'cancel' || request.status !== 'pending' ||
      request.fields?.kind !== 'cancel' || (input.proposalDigest && input.proposalDigest !== request.proposalDigest)) return null;
  const fields = z.object({ target: z.object({ confirmation: z.string(), arrival: z.string() }).passthrough(),
    reason: z.string().nullable(), cancellationNote: z.string().nullable() }).passthrough().safeParse(request.fields.value);
  if (!fields.success || fields.data.target.confirmation !== input.confirmation || fields.data.target.arrival !== input.arrival) return null;
  return { requestId: request.requestId, proposalDigest: request.proposalDigest,
    reason: fields.data.reason, cancellationNote: fields.data.cancellationNote ?? '' };
}

async function lockedEffectiveCancel(tx: CreateFenceTransaction, source: LockedCreateSource, input: {
  transportId: string; source: z.infer<typeof cancelSelectionSchema>; requestId: string; confirmation: string; arrival: string;
  proposalDigest?: string }) {
  const [owner] = await tx.select({ action: mailActionLabel.action }).from(mailActionLabel)
    .where(and(eq(mailActionLabel.transportId, input.transportId), eq(mailActionLabel.messageId, input.source.messageId),
      eq(mailActionLabel.source, 'owner'), eq(mailActionLabel.version, 'owner')))
    .orderBy(desc(mailActionLabel.updatedAt), desc(mailActionLabel.id)).limit(1).for('share');
  const kind = source.snapshot.extraction.kind;
  if (!kind || !(MAIL_KINDS as readonly string[]).includes(kind)) throw new Error('cancel_request_changed');
  const selected = selectedEffectiveCancel({ ...input, extractionId: source.snapshot.extraction.id,
    payload: source.snapshot.extraction.payload, state: source.item.state, ownerAction: owner?.action,
    kind: kind as MailKind, attachments: source.snapshot.extraction.attachments as AttachmentRead[] | null });
  if (!selected) throw new Error('cancel_request_changed');
  return selected;
}

function assertExpectedCursor(input: CancelContext, cursor: z.infer<typeof cursorSchema>) {
  const valid = z.object(cancelRequestBindingFields).safeParse({ requestId: input.requestId,
    expectedSeq: input.expectedSeq, expectedExtractionId: input.expectedExtractionId });
  if (!valid.success || !completeCancelRequestBinding(input) || (input.requestId !== undefined &&
      (input.expectedSeq !== cursor.seq || input.expectedExtractionId !== cursor.extractionId))) {
    throw new Error('cancel_request_changed');
  }
}
async function checkSource(tx: CreateFenceTransaction, locked: LockedCreateSource, input: CancelContext,
  accessId?: string, sourceDigest?: string) {
  await assertNoCreateDispatchFence(tx, { transportId: input.transportId, workItemId: input.workItemId });
  if (input.selectedInternetMessageId !== undefined) {
    await assertHmsSelectedSource(tx as DB, { ...input, selectedSource: input.source }, locked.item, true);
  }
  const actor = await lockCreateActorAccess(tx, { transportId: input.transportId, actorUserId: input.actorUserId, accessId });
  await lockCreateActorSession(tx, { actorUserId: input.actorUserId, sessionId: input.sessionId,
    sessionProfile: input.sessionProfile });
  if (staffQuoteSourceHash(locked.snapshot.source) !== input.source.sourceHash ||
      (sourceDigest !== undefined && sourceDigest !== locked.sourceDigest)) throw new Error('cancel_source_changed');
  return { accessId: actor.accessId, sourceDigest: locked.sourceDigest };
}

/** Lock and verify the selected source, current extraction and exact actor in the claim transaction. */
export async function lockSelectedCloudCancel(tx: CreateFenceTransaction, input: {
  transportId: string; workItemId: string; source: z.infer<typeof cancelSelectionSchema>;
  actorUserId: string; sessionId?: string; sessionProfile?: 'legacy' | 'remote';
}): Promise<typeof workItem.$inferSelect> {
  const [seed] = await tx.select({ state: workItem.state }).from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1);
  const parsed = cloudCancelDispatchSchema.safeParse(seed?.state.cloudCancel);
  if (!parsed.success || canonicalJson(parsed.data.source) !== canonicalJson(input.source)) throw new Error('cancel_source_changed');
  const bound = parsed.data;
  return lockCreateSource(tx, { transportId: input.transportId, workItemId: input.workItemId,
    threadId: bound.source.threadId, messageId: bound.source.messageId, cursor: bound.cursor }, async (lockedTx, source) => {
    const actual = cloudCancelDispatchSchema.safeParse(source.item.state.cloudCancel);
    if (!actual.success || canonicalJson(actual.data) !== canonicalJson(bound)) throw new Error('cancel_source_changed');
    const context = { ...input, confirmation: bound.preimage.confirmation, arrival: bound.preimage.arrival,
      target: {} as HmsReadTarget };
    await checkSource(lockedTx, source, context, bound.accessId, bound.sourceDigest);
    if (bound.request) {
      const request = await lockedEffectiveCancel(lockedTx, source, { ...context, ...bound.request });
      if (request.reason !== bound.reasonLabel || request.cancellationNote !== bound.cancellationNote) {
        throw new Error('cancel_request_changed');
      }
    }
    return source.item;
  });
}

/** Preview opens only the native reason dialog. It persists a short-lived, source-bound preimage. */
export async function previewCloudCancel(input: CancelContext): Promise<PaneStayCancelResult> {
  const db = input.db ?? getDb(), mode = paneWriteMode('cancel', 'unpaid', input.env);
  if (mode === 'off') return emptyResult('refused_flag_off');
  if (!cancelSelectionSchema.safeParse(input.source).success || !z.string().uuid().safeParse(input.workItemId).success ||
      !input.sessionId || !input.sessionProfile ||
      Boolean(input.selectedInternetMessageId) !== Boolean(input.expectedFormDigest) ||
      (input.expectedFormDigest !== undefined && !digest.safeParse(input.expectedFormDigest).success)) return emptyResult('refused_source_changed');
  let native: NativeResult | null = null, keepRun = false;
  try {
    const cursor = await cursorFor(db, input);
    assertExpectedCursor(input, cursor);
    const initial = await withLockedCreateSource(db, key(input, cursor), async (tx, source) => {
      const locked = await checkSource(tx, source, input);
      await assertNoOpenWrite(tx as DB, input.workItemId);
      if (input.expectedFormDigest !== undefined && (formDigest(source.item.state) !== input.expectedFormDigest ||
          source.item.state.action !== 'cancel' || source.item.state.confirmation !== input.confirmation ||
          source.item.state.arrival !== input.arrival)) throw new Error('cancel_form_changed');
      const selected = input.requestId ? await lockedEffectiveCancel(tx, source, { ...input, requestId: input.requestId }) : null;
      return { ...locked, stateDigest: formDigest(withoutPreview(source.item.state)),
        request: selected ? { requestId: selected.requestId, proposalDigest: selected.proposalDigest } : undefined };
    });
    // Preview is read-only, so staff can prepare a real booking while the write flag is in lab mode.
    native = await runCloudCancellation({ mode: 'preview', target: input.target, confirmation: input.confirmation,
      arrival: input.arrival, allowRealGuest: true });
    const expected = preimageSchema.safeParse(native.expected), reasons = z.array(reasonSchema).min(1).max(100).safeParse(native.reasons);
    const policyFacts = z.array(z.string().trim().min(1).max(260)).max(12).safeParse(native.policyFacts ?? []);
    const penaltyText = z.string().trim().min(1).max(2000).nullable().safeParse(native.penaltyText ?? null);
    if (native.outcome !== 'preview_ok' || !expected.success || !reasons.success ||
        !policyFacts.success || !penaltyText.success ||
        expected.data.confirmation !== input.confirmation || expected.data.arrival !== input.arrival) {
      return { ...emptyResult(native.outcome === 'refused_preimage' ? 'refused_target_unverified' : native.outcome),
        penaltyText: native.penaltyText ?? null, policyFacts: native.policyFacts ?? [] };
    }
    const now = Date.now();
    const body = previewBodySchema.parse({ version: 1, nonce: randomUUID(), source: input.source, cursor,
      sourceDigest: initial.sourceDigest, stateDigest: initial.stateDigest, accessId: initial.accessId,
      preimage: expected.data, reasons: reasons.data, policyFacts: policyFacts.data, penaltyText: penaltyText.data,
      actorUserId: input.actorUserId, sessionId: input.sessionId,
      sessionProfile: input.sessionProfile, readAt: new Date(now).toISOString(), expiresAt: now + 10 * 60_000,
      ...(input.expectedFormDigest ? { reviewFormDigest: input.expectedFormDigest } : {}),
      ...(initial.request ? { request: initial.request } : {}) });
    const preview = { ...body, digest: hash(body) };
    await withLockedCreateSource(db, key(input, cursor), async (tx, source) => {
      await checkSource(tx, source, input, initial.accessId, initial.sourceDigest);
      await assertNoOpenWrite(tx as DB, input.workItemId);
      if (formDigest(withoutPreview(source.item.state)) !== initial.stateDigest) throw new Error('cancel_state_changed');
      if (initial.request) await lockedEffectiveCancel(tx, source, { ...input, ...initial.request });
      await tx.update(workItem).set({ state: { ...source.item.state, [previewKey]: preview }, updatedAt: new Date() })
        .where(eq(workItem.id, input.workItemId));
    });
    let runId: string | null = null;
    const screenshots = (native.screenshots ?? []).filter((path) => native?.runDir && dirname(path) === native.runDir && basename(path) === 'before.png');
    if (native.runDir && dirname(native.runDir) === tmpdir() && basename(native.runDir).startsWith('pane-cloud-cancel-') && screenshots.length) {
      runId = randomUUID();
      registerPaneRun({ runId, dir: native.runDir, owner: `${input.actorUserId}:${input.transportId}`, now: paneStayClock() });
      keepRun = true;
    }
    return { ...emptyResult('preview_ok'), statusBefore: 'Reserved', reasons: reasons.data.map((reason) => reason.display),
      requestedArrival: input.arrival, hmsArrival: expected.data.arrival, penaltyText: penaltyText.data,
      policyFacts: policyFacts.data,
      previewStay: { confirmation: expected.data.confirmation, firstName: expected.data.firstName, lastName: expected.data.lastName,
        arrival: expected.data.arrival, departure: expected.data.departure, roomType: expected.data.roomType,
        guarantee: expected.data.expectedGuarantee.display, depositReceived: expected.data.depositReceived },
      screenshots: screenshots.map((path) => basename(path)), runId, previewDigest: preview.digest };
  } catch { return emptyResult('refused_source_changed'); }
  finally { if (!keepRun && native?.runDir && dirname(native.runDir) === tmpdir() && basename(native.runDir).startsWith('pane-cloud-cancel-'))
    await rm(native.runDir, { recursive: true, force: true }).catch(() => {}); }
}

/** Staff Go binds the exact preview, source, native reason and note before enqueueing one write. */
export async function commitCloudCancel(input: CancelContext & { reason: string; previewDigest: string; cancellationNote?: string }): Promise<PaneStayCancelResult> {
  const db = input.db ?? getDb(), mode = paneWriteMode('cancel', 'unpaid', input.env), note = cleanNote(input.cancellationNote);
  if (mode === 'off') return emptyResult('refused_flag_off');
  if (note === null || !input.sessionId || !input.sessionProfile || !cancelSelectionSchema.safeParse(input.source).success ||
      !digest.safeParse(input.previewDigest).success ||
      Boolean(input.selectedInternetMessageId) !== Boolean(input.expectedFormDigest)) return emptyResult('cancel_preview_required');
  let approvalAttempted = false;
  try {
    const cursor = await cursorFor(db, input);
    assertExpectedCursor(input, cursor);
    const bound = await withLockedCreateSource(db, key(input, cursor), async (tx, source) => {
      const preview = previewSchema.safeParse(source.item.state[previewKey]);
      if (!preview.success) throw new Error('cancel_preview_changed');
      const { digest: previewDigest, ...body } = preview.data;
      const grant = preview.data;
      if (hash(body) !== previewDigest || previewDigest !== input.previewDigest || grant.expiresAt <= Date.now() ||
          grant.actorUserId !== input.actorUserId || grant.sessionId !== input.sessionId || grant.sessionProfile !== input.sessionProfile ||
          grant.preimage.confirmation !== input.confirmation || grant.preimage.arrival !== input.arrival ||
          grant.reviewFormDigest !== input.expectedFormDigest ||
          (grant.preimage.allowRealGuest && mode !== 'on') || canonicalJson(grant.source) !== canonicalJson(input.source) ||
          canonicalJson(grant.cursor) !== canonicalJson(cursor) ||
          grant.request?.requestId !== input.requestId ||
          formDigest(withoutPreview(source.item.state)) !== grant.stateDigest) throw new Error('cancel_preview_changed');
      const selected = grant.reasons.filter((reason) => reason.display === input.reason);
      if (selected.length !== 1) throw new Error('cancel_reason_changed');
      await checkSource(tx, source, input, grant.accessId, grant.sourceDigest);
      await assertNoOpenWrite(tx as DB, input.workItemId);
      if (grant.request) {
        const request = await lockedEffectiveCancel(tx, source, { ...input, ...grant.request });
        if (request.reason !== input.reason || request.cancellationNote !== note) throw new Error('cancel_request_changed');
      }
      const cloudCancel = cloudCancelDispatchSchema.parse({ version: 1, source: grant.source, cursor: grant.cursor,
        sourceDigest: grant.sourceDigest, accessId: grant.accessId, preimage: grant.preimage,
        reasonCode: selected[0]!.value, reasonLabel: selected[0]!.display, cancellationNote: note, previewDigest,
        ...(grant.request ? { request: grant.request } : {}) });
      const state: Record<string, unknown> = { ...withoutPreview(source.item.state) };
      // A work item may previously have held a Filing or Amend form. Only the new Cancel form is approved.
      for (const key of ['action', 'confirmation', 'arrival', 'lastName', 'attachmentId', 'documentName', 'pdfSha256',
        'sourceMessageId', 'sourceInternetMessageId', 'sourceSnapshotDigest', 'sourceThreadId', 'sourceHash', 'documentCode', 'filingStateDigest',
        'reason', 'fields', 'previewDigest', 'cloudAmend', 'cloudCancel', 'hmsSnapshot']) delete state[key];
      Object.assign(state, { action: 'cancel', confirmation: grant.preimage.confirmation,
        arrival: grant.preimage.arrival, lastName: grant.preimage.lastName, reason: selected[0]!.display, cloudCancel,
        hmsSnapshot: { digest: hmsStateDigest(grant.preimage), readAt: grant.readAt } });
      await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
      return formDigest(state);
    });
    approvalAttempted = true;
    const approved = await approveHmsWrite({ db, transportId: input.transportId, actorUserId: input.actorUserId,
      sessionId: input.sessionId, sessionProfile: input.sessionProfile, workItemId: input.workItemId,
      formDigest: bound, cloudCancelSelection: input.source, selectedSource: input.source,
      selectedInternetMessageId: input.selectedInternetMessageId, env: input.env });
    return { ...emptyResult('cancel_queued'), statusBefore: 'Reserved', requestedArrival: input.arrival,
      hmsArrival: input.arrival, runId: approved.runId };
  } catch { return emptyResult(approvalAttempted ? 'cancel_unconfirmed' : 'cancel_preview_required'); }
}

// A charge decision belongs to the live writer, the exact dialog, source, target and staff session.
// Storing it on the fenced run lets the HTTP process and the worker communicate without retaining
// a browser handle in the HTTP process. A dead or expired writer can never consume an approval.
const chargeKey = 'cloudCancelCharge';
const chargeSchema = z.object({ version: z.literal(1), id: z.string().uuid(), dialogDigest: digest,
  text: z.string().trim().min(1).max(2000), button: z.string().trim().min(1).max(40),
  confirmation: z.string().regex(/^\d+-\d+$/), nativeStayId: z.string().regex(/^\d{1,100}$/),
  actorUserId: id, sessionId: z.string().min(1).max(512), sessionProfile: z.enum(['legacy', 'remote']),
  grantId: z.string().uuid(), sourceDigest: digest, expiresAt: z.number().int(),
  status: z.enum(['pending', 'approved', 'consumed', 'dispatched', 'expired']),
  requestDigest: digest.optional(), cancellationStatus: z.literal('Cancelled').optional() }).strict();
type Charge = z.infer<typeof chargeSchema>;
type ChargeSelection = { db?: DB; transportId: string; actorUserId: string; sessionId?: string;
  sessionProfile?: 'legacy' | 'remote'; workItemId: string; runId: string;
  source: z.infer<typeof cancelSelectionSchema>; confirmation: string; arrival: string;
  selectedInternetMessageId?: string };

function chargeFrom(metrics: unknown): Charge | null {
  const object = metrics && typeof metrics === 'object' && !Array.isArray(metrics)
    ? metrics as Record<string, unknown> : {};
  const parsed = chargeSchema.safeParse(object[chargeKey]);
  return parsed.success ? parsed.data : null;
}

async function lockedCharge(input: ChargeSelection, action: (tx: CreateFenceTransaction,
  charge: Charge, metrics: Record<string, unknown>) => Promise<void>, allowInactive = false) {
  const db = input.db ?? getDb();
  if (!input.sessionId || !input.sessionProfile || !cancelSelectionSchema.safeParse(input.source).success) {
    throw new Error('cancel_charge_unavailable');
  }
  return db.transaction(async (tx) => {
    const item = await lockSelectedCloudCancel(tx, input);
    if (input.selectedInternetMessageId !== undefined) {
      await assertHmsSelectedSource(tx as DB, { ...input, selectedSource: input.source }, item, true);
    }
    const bound = cloudCancelDispatchSchema.parse(item.state.cloudCancel);
    const [run] = await tx.select({ metrics: aiWorkflowRun.metrics, state: aiWorkflowRun.state,
      deadlineAt: aiWorkflowRun.deadlineAt }).from(aiWorkflowRun)
      .where(and(eq(aiWorkflowRun.id, input.runId), eq(aiWorkflowRun.workItemId, input.workItemId),
        eq(aiWorkflowRun.transportId, input.transportId), eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND)))
      .limit(1).for('update');
    const charge = chargeFrom(run?.metrics), metrics = run?.metrics ?? {};
    const active = Boolean(run && ['claimed', 'running'].includes(run.state) && run.deadlineAt &&
      run.deadlineAt.getTime() > Date.now() && charge && charge.expiresAt > Date.now());
    if (!run || !charge || (!allowInactive && !active) ||
        charge.actorUserId !== input.actorUserId || charge.sessionId !== input.sessionId ||
        charge.sessionProfile !== input.sessionProfile || charge.confirmation !== input.confirmation ||
        charge.confirmation !== bound.preimage.confirmation || charge.nativeStayId !== bound.preimage.nativeStayId ||
        input.arrival !== bound.preimage.arrival || charge.sourceDigest !== bound.sourceDigest ||
        (!allowInactive && (paneWriteMode('cancel', 'unpaid') === 'off' ||
          (bound.preimage.allowRealGuest && paneWriteMode('cancel', 'unpaid') !== 'on')))) {
      throw new Error('cancel_charge_unavailable');
    }
    await action(tx, charge, metrics);
    return { charge, active };
  });
}

/** Keep the observed HMS text visible after the writer stops, without allowing a late Go. */
export async function pendingCloudCancelCharge(input: ChargeSelection) {
  try {
    const { charge, active } = await lockedCharge(input, async () => {}, true);
    return { status: !active || charge.status === 'expired' ? 'expired' as const
      : charge.status === 'pending' ? 'pending' as const : 'submitted' as const,
      challengeId: charge.id, dialogDigest: charge.dialogDigest, penaltyText: charge.text,
      expiresAt: new Date(charge.expiresAt).toISOString(),
      ...(charge.cancellationStatus ? { cancellationStatus: charge.cancellationStatus } : {}) };
  } catch { return { status: 'none' as const }; }
}

/** A distinct staff Go is recorded once; the browser rechecks the actual dialog before acting. */
export async function approveCloudCancelCharge(input: ChargeSelection & { challengeId: string; dialogDigest: string }) {
  try {
    await lockedCharge(input, async (tx, charge, metrics) => {
      if (charge.status !== 'pending' || charge.id !== input.challengeId || charge.dialogDigest !== input.dialogDigest) {
        throw new Error('cancel_charge_changed');
      }
      await tx.update(aiWorkflowRun).set({ metrics: { ...metrics, [chargeKey]: { ...charge, status: 'approved' } },
        updatedAt: new Date() }).where(eq(aiWorkflowRun.id, input.runId));
      await tx.insert(workEvent).values({ workItemId: input.workItemId, at: new Date(), actorKind: 'user',
        actorUserId: input.actorUserId, type: 'status.changed',
        value: { cancelChargeApproved: true, runId: input.runId, challengeId: charge.id,
          dialogDigest: charge.dialogDigest, confirmation: charge.confirmation } });
    });
    return { status: 'accepted' as const };
  } catch { return { status: 'unavailable' as const }; }
}

type CancelPreimage = z.infer<typeof preimageSchema>;
/** Compare live identity and business fields without pinning changing financial observations. */
export function cancelBusinessPreimage(current: CancelPreimage, approved: CancelPreimage): CancelPreimage {
  return { ...current, depositReceived: approved.depositReceived, expectedGuarantee: approved.expectedGuarantee };
}

const safeRunDir = (path: string | undefined): path is string => Boolean(path && dirname(path) === tmpdir() &&
  basename(path).startsWith('pane-cloud-cancel-'));

/** A new owned read obtains the native stay identity before the target lock. */
export async function readCloudCancelPreimage(input: { target: HmsReadTarget; confirmation: string; arrival: string;
  allowRealGuest: boolean; cloudTargetKey?: string }): Promise<CancelPreimage | null> {
  let result: NativeResult | null = null;
  try {
    result = await runCloudCancellation({ mode: 'read', ...input });
    const parsed = preimageSchema.safeParse(result.expected);
    return result.outcome === 'read' && parsed.success && parsed.data.confirmation === input.confirmation &&
      parsed.data.arrival === input.arrival && parsed.data.allowRealGuest === input.allowRealGuest ? parsed.data : null;
  } catch { return null; }
  finally { if (safeRunDir(result?.runDir)) await rm(result.runDir, { recursive: true, force: true }).catch(() => {}); }
}

const statusReadbackSchema = z.object({ confirmation: z.string(), nativeStayId: z.string().regex(/^\d{1,100}$/),
  nativeGuestId: z.string().regex(/^\d{1,30}$/), status: z.string().regex(/^cancel(?:l)?ed$/i),
  reasonCode: z.string().nullable(), cancellationNote: z.string().nullable() }).strict();
const readbackSchema = statusReadbackSchema.extend({ reasonCode: z.string(), cancellationNote: z.string() }).strict();

/** Execute only a consumed, source-bound Go while the verified target lock is held. */
export async function executeCloudCancel(input: {
  db: DB; fence: AiRunFence; transportId: string; workItemId: string; target: HmsReadTarget;
  dispatchTarget: HmsDispatchTarget; bound: CloudCancelDispatch;
  consumed: Awaited<ReturnType<typeof consumeHmsWriteApproval>>; env: NodeJS.Dict<string>;
  runDirs: string[]; pendingCloudEvidence: Map<string, boolean>;
}): Promise<PaneHmsWriteResult> {
  const { db, fence, bound, consumed, dispatchTarget } = input;
  const end = async (failureClass: AiFailureClass, reason: string): Promise<PaneHmsWriteResult> =>
    await endHmsWriteRun({ db, fence, failureClass, reason })
      ? { status: 'ended', failureClass, reason } : { status: 'lease_lost' };
  const currentMode = () => {
    const mode = paneWriteMode('cancel', 'unpaid', input.env);
    return mode !== 'off' && (!bound.preimage.allowRealGuest || mode === 'on');
  };
  if (!currentMode() || !consumed.authority || dispatchTarget.kind !== 'saved' || !dispatchTarget.nativeStayId ||
      dispatchTarget.nativeStayId !== bound.preimage.nativeStayId || dispatchTarget.confirmation !== bound.preimage.confirmation) {
    return end('POLICY_BLOCK', 'cancel_unavailable');
  }
  const authority = consumed.authority, cloudTargetKey = hmsDispatchTargetKey(dispatchTarget);
  const read = async () => {
    const current = await readCloudCancelPreimage({ target: input.target, confirmation: bound.preimage.confirmation,
      arrival: bound.preimage.arrival, allowRealGuest: bound.preimage.allowRealGuest, cloudTargetKey });
    // Keep the signed preview facts intact while rechecking current identity and business fields.
    return current && cancelBusinessPreimage(current, bound.preimage);
  };
  const current = await read();
  if (!current || canonicalJson(current) !== canonicalJson(bound.preimage)) return end('NEEDS_CHECK', 'cancel_target_changed');
  const epoch = await captureHmsLabtestDispatchEpoch(db, dispatchTarget, input.workItemId).catch(() => null);
  if (!epoch) return end('NEEDS_CHECK', 'cancel_target_unavailable');
  const pre = await assertHmsUnchangedBeforeSave({ db, runId: fence.runId, fence, readHmsState: async () => current });
  if (pre.status === 'lease_lost') return { status: 'lease_lost' };
  if (pre.status === 'needs_check') return { status: 'ended', failureClass: 'NEEDS_CHECK', reason: pre.reason };
  const finishCutoff = performance.now() + fence.deadlineAt.getTime() - Date.now() - 6 * 60_000;
  const hasBudget = () => currentMode() && performance.now() <= finishCutoff &&
    fence.deadlineAt.getTime() - Date.now() >= 6 * 60_000;
  const commitBudgetMs = Math.max(0, Math.min(20 * 60_000, Math.floor(finishCutoff - performance.now())));
  if (!hasBudget() || commitBudgetMs < 1) return end('NEEDS_CHECK', 'cancel_run_deadline');
  const dispatch: { handle: HmsLabtestWriteHandle | null; attempted: boolean; provedRefused: boolean;
    requestDigest: string | null; recovery: Record<string, unknown> | null;
    before: { eventId: string; sha256: string } | null } =
    { handle: null, attempted: false, provedRefused: false, requestDigest: null, recovery: null, before: null };
  let chargeApproval: Charge | null = null, preChargePrepared = false, cancelSaveReleased = false;
  const chargeRun = async (fn: (tx: CreateFenceTransaction, metrics: Record<string, unknown>) => Promise<void>) =>
    db.transaction(async (tx) => {
      const item = await lockSelectedCloudCancel(tx, { transportId: input.transportId, workItemId: input.workItemId,
        source: bound.source, actorUserId: authority.actorUserId, sessionId: authority.sessionId,
        sessionProfile: authority.sessionProfile });
      await lockConsumedCloudCancelApproval(tx, { fence, transportId: input.transportId, item,
        grantId: consumed.grantId, approvedDigest: formDigest(consumed.form), authority, env: input.env });
      const [run] = await tx.select({ metrics: aiWorkflowRun.metrics, deadlineAt: aiWorkflowRun.deadlineAt })
        .from(aiWorkflowRun).where(and(eq(aiWorkflowRun.id, fence.runId), eq(aiWorkflowRun.workItemId, input.workItemId),
          eq(aiWorkflowRun.transportId, input.transportId), eq(aiWorkflowRun.claimOwner, fence.claimOwner),
          eq(aiWorkflowRun.claimToken, fence.claimToken), inArray(aiWorkflowRun.state, ['claimed', 'running'])))
        .limit(1).for('update');
      if (!run?.deadlineAt || run.deadlineAt.getTime() !== fence.deadlineAt.getTime() || !hasBudget()) {
        throw new Error('cancel_charge_lease_lost');
      }
      await fn(tx, run.metrics ?? {});
    });
  const awaitChargeApproval = async (dialog: { text: string; button: string }) => {
    if (!hasBudget()) return false;
    const text = typeof dialog?.text === 'string' ? dialog.text.trim() : '';
    const button = typeof dialog?.button === 'string' ? dialog.button.trim() : '';
    if (!text || text.length > 2000 || !/penalt|fee|charge|deposit/i.test(text) ||
        !/^(?:OK|Yes|Accept)$/i.test(button)) return false;
    const expiresAt = Math.min(Date.now() + 2 * 60_000, fence.deadlineAt.getTime() - 6 * 60_000);
    if (expiresAt <= Date.now()) return false;
    const nonce = randomUUID();
    const body = { version: 1 as const, id: nonce, text, button, confirmation: bound.preimage.confirmation,
      nativeStayId: bound.preimage.nativeStayId, actorUserId: authority.actorUserId,
      sessionId: authority.sessionId, sessionProfile: authority.sessionProfile, grantId: consumed.grantId,
      sourceDigest: bound.sourceDigest, expiresAt, status: 'pending' as const };
    const challenge = chargeSchema.parse({ ...body, dialogDigest: hash({ ...body, runId: fence.runId,
      workItemId: input.workItemId, source: bound.source }) });
    try {
      await chargeRun(async (tx, metrics) => {
        const previous = chargeFrom(metrics);
        if (previous && (!preChargePrepared || previous.status !== 'dispatched')) {
          throw new Error('cancel_charge_already_issued');
        }
        await tx.update(aiWorkflowRun).set({ metrics: { ...metrics, [chargeKey]: challenge }, updatedAt: new Date() })
          .where(eq(aiWorkflowRun.id, fence.runId));
      });
      while (Date.now() < expiresAt && hasBudget()) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const [run] = await db.select({ metrics: aiWorkflowRun.metrics }).from(aiWorkflowRun)
          .where(and(eq(aiWorkflowRun.id, fence.runId), eq(aiWorkflowRun.claimOwner, fence.claimOwner),
            eq(aiWorkflowRun.claimToken, fence.claimToken), inArray(aiWorkflowRun.state, ['claimed', 'running'])))
          .limit(1);
        const current = chargeFrom(run?.metrics);
        if (!current || current.id !== challenge.id || current.dialogDigest !== challenge.dialogDigest) return false;
        if (current.status === 'pending') continue;
        if (current.status !== 'approved') return false;
        await chargeRun(async (tx, metrics) => {
          const approved = chargeFrom(metrics);
          if (!approved || approved.id !== challenge.id || approved.dialogDigest !== challenge.dialogDigest ||
              approved.status !== 'approved' || approved.expiresAt <= Date.now()) throw new Error('cancel_charge_changed');
          chargeApproval = { ...approved, status: 'consumed' };
          await tx.update(aiWorkflowRun).set({ metrics: { ...metrics, [chargeKey]: chargeApproval }, updatedAt: new Date() })
            .where(eq(aiWorkflowRun.id, fence.runId));
        });
        return true;
      }
    } catch { /* A stale session, source or lease cannot authorize the charge. */ }
    return false;
  };
  const dispatchChargeWithAuthority = async (send: () => Promise<unknown>, nativeDigest: string) => {
    if (!chargeApproval || !dispatch.handle || !digest.safeParse(nativeDigest).success || !hasBudget()) {
      throw new Error('cancel_charge_authority_unavailable');
    }
    const approved = chargeApproval;
    await chargeRun(async (tx, metrics) => {
      const current = chargeFrom(metrics);
      if (!current || current.id !== approved.id || current.dialogDigest !== approved.dialogDigest ||
          current.status !== 'consumed' || current.expiresAt <= Date.now()) throw new Error('cancel_charge_changed');
      chargeApproval = { ...current, status: 'dispatched', requestDigest: nativeDigest };
      await tx.update(aiWorkflowRun).set({ metrics: { ...metrics, [chargeKey]: chargeApproval }, updatedAt: new Date() })
        .where(eq(aiWorkflowRun.id, fence.runId));
    });
    return send();
  };
  const claimDispatch = async (nativeDigest: string, beforeShot: string) => {
    if (dispatch.attempted || !hasBudget() || !digest.safeParse(nativeDigest).success || basename(beforeShot) !== 'before.png' ||
        !safeRunDir(dirname(beforeShot))) throw new Error('cancel_authority_unavailable');
    const directory = await lstat(dirname(beforeShot)).catch(() => null);
    if (!directory?.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) {
      throw new Error('cancel_evidence_unavailable');
    }
    const sealed = await recordHmsWriteEvidence({ db, transportId: input.transportId, workItemId: input.workItemId,
      runId: fence.runId, name: 'before.png', png: await readFile(beforeShot) });
    dispatch.before = { eventId: sealed.eventId, sha256: sealed.sha256 };
    const approvedDigest = formDigest(consumed.form);
    const sealedRecovery = { confirmation: bound.preimage.confirmation, nativeStayId: bound.preimage.nativeStayId,
      preimage: bound.preimage, reasonCode: bound.reasonCode, reasonLabel: bound.reasonLabel,
      cancellationNote: bound.cancellationNote, cloudTargetKey, runId: fence.runId,
      claimDigest: hash({ claimOwner: fence.claimOwner, claimToken: fence.claimToken }), before: dispatch.before };
    dispatch.recovery = sealedRecovery;
    dispatch.attempted = true;
    let authorizationStarted = false, authorizationRefusal: unknown = null;
    try {
      dispatch.handle = await claimHmsLabtestDispatch(db, { workItemId: input.workItemId, transportId: input.transportId,
        actorUserId: authority.actorUserId, grantId: consumed.grantId, propertyCode: 'HRCEN',
        firstName: bound.preimage.firstName, lastName: bound.preimage.lastName, nativeGuestId: bound.preimage.guestId,
        operation: 'cancel', target: dispatchTarget, sourceDigest: bound.sourceDigest, approvedDigest,
        requestDigest: nativeDigest, recovery: sealedRecovery }, async (tx, claim) => {
        authorizationStarted = true;
        try {
          if (!hasBudget() || claim.requestDigest !== nativeDigest ||
              canonicalJson(claim.recovery) !== canonicalJson(sealedRecovery)) throw new Error('cancel_authority_changed');
          const item = await lockSelectedCloudCancel(tx, { transportId: input.transportId, workItemId: input.workItemId,
            source: bound.source, actorUserId: authority.actorUserId, sessionId: authority.sessionId,
            sessionProfile: authority.sessionProfile });
          await lockConsumedCloudCancelApproval(tx, { fence, transportId: input.transportId, item,
            grantId: consumed.grantId, approvedDigest, authority, env: input.env });
          if (!hasBudget()) throw new Error('cancel_authority_changed');
        } catch (error) { authorizationRefusal = error; throw error; }
      }, epoch);
    } catch (error) {
      dispatch.provedRefused = (authorizationRefusal !== null && error === authorizationRefusal) ||
        (!authorizationStarted && error instanceof HmsLabtestDispatchError && error.reason === 'occupied');
      throw error;
    }
    dispatch.requestDigest = nativeDigest;
    if (!hasBudget()) throw new Error('cancel_finish_deadline_unavailable');
  };
  // A charge presented before the reason Save gets a durable target hold before the browser is allowed to accept it.
  const prepareChargeWithAuthority = async (beforeShot: string) => {
    if (!chargeApproval || !hasBudget() || (dispatch.attempted && (!preChargePrepared || !dispatch.handle))) {
      throw new Error('cancel_charge_authority_unavailable');
    }
    const approved = chargeApproval;
    await chargeRun(async (_tx, metrics) => {
      const current = chargeFrom(metrics);
      if (!current || current.id !== approved.id || current.dialogDigest !== approved.dialogDigest ||
          current.status !== 'consumed' || current.expiresAt <= Date.now()) throw new Error('cancel_charge_changed');
    });
    const actionDigest = hash({ action: 'cancel_charge_dialog', runId: fence.runId,
      challengeId: approved.id, dialogDigest: approved.dialogDigest });
    if (!preChargePrepared) await claimDispatch(actionDigest, beforeShot);
    await chargeRun(async (tx, metrics) => {
      const current = chargeFrom(metrics);
      if (!current || current.id !== approved.id || current.dialogDigest !== approved.dialogDigest ||
          current.status !== 'consumed' || current.expiresAt <= Date.now()) throw new Error('cancel_charge_changed');
      chargeApproval = { ...current, status: 'dispatched', requestDigest: actionDigest };
      await tx.update(aiWorkflowRun).set({ metrics: { ...metrics, [chargeKey]: chargeApproval }, updatedAt: new Date() })
        .where(eq(aiWorkflowRun.id, fence.runId));
    });
    preChargePrepared = true;
  };
  const beat = setInterval(() => { void heartbeatAiRun(fence, db).catch(() => false); }, 30_000);
  let saved: NativeResult;
  try {
    saved = await runCloudCancellation({ mode: 'commit', target: input.target, confirmation: bound.preimage.confirmation,
      arrival: bound.preimage.arrival, allowRealGuest: bound.preimage.allowRealGuest, expected: bound.preimage,
      reasonCode: bound.reasonCode, reasonLabel: bound.reasonLabel, cancellationNote: bound.cancellationNote, cloudTargetKey,
      commitBudgetMs, continuationAllowed: hasBudget, awaitChargeApproval, dispatchChargeWithAuthority, prepareChargeWithAuthority,
      beforeDispatch: async () => {
        if (!hasBudget()) return false;
        const check = await assertHmsUnchangedBeforeSave({ db, runId: fence.runId, fence, readHmsState: read });
        return check.status === 'unchanged' && hasBudget();
      },
      dispatchWithAuthority: async (send: () => Promise<unknown>, nativeDigest: string, _request: unknown, beforeShot: string) => {
        if (preChargePrepared) {
          if (cancelSaveReleased || !dispatch.handle || !chargeApproval || !digest.safeParse(nativeDigest).success || !hasBudget()) {
            throw new Error('cancel_authority_unavailable');
          }
          const approved = chargeApproval;
          await chargeRun(async (tx, metrics) => {
            const current = chargeFrom(metrics);
            if (!current || current.id !== approved.id || current.status !== 'dispatched' ||
                metrics.cloudCancelSaveDigest !== undefined) throw new Error('cancel_authority_changed');
            await tx.update(aiWorkflowRun).set({ metrics: { ...metrics, cloudCancelSaveDigest: nativeDigest }, updatedAt: new Date() })
              .where(eq(aiWorkflowRun.id, fence.runId));
          });
          cancelSaveReleased = true;
        } else {
          await claimDispatch(nativeDigest, beforeShot);
        }
        return send();
      },
    });
  } catch { saved = { outcome: 'execution_failure', requestDispatched: false }; }
  finally { clearInterval(beat); }
  if (safeRunDir(saved.runDir)) {
    const directory = await lstat(saved.runDir).catch(() => null);
    if ((dispatch.attempted || saved.requestDispatched) && directory?.isDirectory() &&
        directory.uid === process.getuid?.() && !(directory.mode & 0o077)) input.pendingCloudEvidence.set(saved.runDir, false);
    else input.runDirs.push(saved.runDir);
  }
  if (['cancel_penalty_pending', 'refused_penalty', 'fee_accepted_unconfirmed'].includes(saved.outcome)) {
    const observed = statusReadbackSchema.safeParse(saved.nativeReadback);
    const cancelled = saved.writerSessionClosed === true && observed.success &&
      observed.data.confirmation === bound.preimage.confirmation && observed.data.nativeStayId === bound.preimage.nativeStayId &&
      observed.data.nativeGuestId === bound.preimage.guestId;
    const text = typeof saved.penaltyText === 'string' ? saved.penaltyText.trim() : '';
    try {
      await chargeRun(async (tx, metrics) => {
        const current = chargeFrom(metrics);
        const observation = current ?? (text && text.length <= 2000 && /penalt|fee|charge|deposit/i.test(text)
          ? chargeSchema.parse({ version: 1, id: randomUUID(), dialogDigest: hash({ text, runId: fence.runId }),
            text, button: 'Unavailable', confirmation: bound.preimage.confirmation, nativeStayId: bound.preimage.nativeStayId,
            actorUserId: authority.actorUserId, sessionId: authority.sessionId, sessionProfile: authority.sessionProfile,
            grantId: consumed.grantId, sourceDigest: bound.sourceDigest, expiresAt: Date.now(), status: 'expired' }) : null);
        if (observation && (cancelled || !current)) {
          await tx.update(aiWorkflowRun).set({ metrics: { ...metrics, [chargeKey]: {
            ...observation, ...(cancelled ? { cancellationStatus: 'Cancelled' as const } : {}) } }, updatedAt: new Date() })
            .where(eq(aiWorkflowRun.id, fence.runId));
        }
      });
    } catch { /* Keep the hold even if the observed status cannot be published. */ }
  }
  if (!saved.requestDispatched) {
    if (saved.writerSessionClosed !== true || saved.dispatchCallbacksDrained !== true ||
        (dispatch.attempted && !dispatch.provedRefused)) return end('UNKNOWN', 'cancel_dispatch_unresolved');
    return end('NEEDS_CHECK', saved.outcome === 'refused_penalty' ? 'cancel_penalty_pending' : saved.outcome);
  }
  if (!dispatch.handle || !dispatch.requestDigest || !dispatch.recovery || !dispatch.before || !safeRunDir(saved.runDir)) return end('UNKNOWN', 'cancel_unconfirmed');
  let after: { eventId: string; sha256: string } | null = null;
  try {
    if ((saved.screenshots ?? []).includes(join(saved.runDir, 'after.png'))) {
      const sealed = await recordHmsWriteEvidence({ db, transportId: input.transportId, workItemId: input.workItemId,
        runId: fence.runId, name: 'after.png', png: await readFile(join(saved.runDir, 'after.png')) });
      after = { eventId: sealed.eventId, sha256: sealed.sha256 };
    }
  } catch { /* Retain the local evidence and target hold. */ }
  if (dispatch.before && after && input.pendingCloudEvidence.has(saved.runDir)) input.pendingCloudEvidence.set(saved.runDir, true);
  if (saved.outcome === 'cancel_penalty_pending') return end('UNKNOWN', 'cancel_penalty_pending');
  const readback = readbackSchema.safeParse(saved.nativeReadback);
  if (saved.outcome !== 'cancelled' || saved.writerSessionClosed !== true || saved.dispatchCallbacksDrained !== true ||
      !after || !readback.success || readback.data.confirmation !== bound.preimage.confirmation ||
      readback.data.nativeStayId !== bound.preimage.nativeStayId || readback.data.nativeGuestId !== bound.preimage.guestId ||
      readback.data.reasonCode !== bound.reasonCode || readback.data.cancellationNote !== bound.cancellationNote) {
    return end('UNKNOWN', 'cancel_unconfirmed');
  }
  const hold = dispatch.handle, request = dispatch.requestDigest, sealedRecovery = dispatch.recovery,
    beforeReceipt = dispatch.before, afterReceipt = after;
  const readbackDigest = hash(readback.data);
  try {
    await resolveHmsLabtestDispatch(db, hold, { operation: 'cancel', confirmation: readback.data.confirmation,
      nativeStayId: readback.data.nativeStayId, nativeReadback: readback.data, readbackDigest,
      savedShot: { runId: fence.runId, sha256: afterReceipt.sha256 } }, async (tx, intent) => {
      if (intent.workItemId !== input.workItemId || intent.transportId !== input.transportId ||
          intent.actorUserId !== authority.actorUserId || intent.grantId !== consumed.grantId ||
          intent.sourceDigest !== bound.sourceDigest || intent.approvedDigest !== formDigest(consumed.form) ||
          intent.requestDigest !== request || intent.nativeGuestId !== bound.preimage.guestId ||
          canonicalJson(intent.recovery) !== canonicalJson(sealedRecovery)) throw new Error('cancel_result_changed');
      for (const [name, receipt] of [['before.png', beforeReceipt], ['after.png', afterReceipt]] as const) {
        const [event] = await tx.select({ value: workEvent.value, evidence: workEvent.evidence, actorKind: workEvent.actorKind })
          .from(workEvent).where(and(eq(workEvent.id, receipt.eventId), eq(workEvent.workItemId, input.workItemId),
            eq(workEvent.type, 'write.evidence'))).limit(1).for('share');
        const value = z.object({ runId: z.string(), name: z.string() }).safeParse(event?.value);
        const evidence = z.object({ sha256: digest }).passthrough().safeParse(event?.evidence);
        if (event?.actorKind !== 'system' || !value.success || value.data.runId !== fence.runId || value.data.name !== name ||
            !evidence.success || evidence.data.sha256 !== receipt.sha256) throw new Error('cancel_evidence_changed');
      }
      const [run] = await tx.select({ metrics: aiWorkflowRun.metrics, deadlineAt: aiWorkflowRun.deadlineAt }).from(aiWorkflowRun)
        .where(and(eq(aiWorkflowRun.id, fence.runId), eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND),
          eq(aiWorkflowRun.claimOwner, fence.claimOwner), eq(aiWorkflowRun.claimToken, fence.claimToken),
          inArray(aiWorkflowRun.state, ['claimed', 'running']))).limit(1).for('update');
      if (!run?.deadlineAt || run.deadlineAt.getTime() !== fence.deadlineAt.getTime() || Date.now() >= run.deadlineAt.getTime()) {
        throw new Error('cancel_lease_lost');
      }
      const now = new Date();
      await tx.update(aiWorkflowRun).set({ state: 'succeeded', finishedAt: now, updatedAt: now, claimOwner: null,
        claimToken: null, metrics: mergeTerminalRunMetrics(run.metrics, { action: 'cancel', outcome: 'cancelled',
          ...(saved.zeroPenaltyNotice === 'Cancellation Penalty of 0.00 may be added to account.'
            ? { cancelNotice: saved.zeroPenaltyNotice } : {}) }) })
        .where(eq(aiWorkflowRun.id, fence.runId));
    });
  } catch { return end('UNKNOWN', 'cancel_unconfirmed'); }
  return { status: 'succeeded', action: 'cancel', outcome: 'cancelled', evidence: ['before.png', 'after.png'] };
}
