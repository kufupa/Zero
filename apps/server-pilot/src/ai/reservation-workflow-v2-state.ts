import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { MAIL_KINDS, workEvent, workItem } from '../db/schema/work.js';
import { mailboxAccess, mailThread, message } from '../db/schema/mail.js';
import { resolvePropertyTransport } from '../../tooling/playwright-quote/property-registry.mjs';
import { MESSAGE_ARRIVED_AT } from './message-arrival-time.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { advancePaneRevision, redoWorkItemRevision, undoWorkItemRevision } from './work-item-revision.js';
import {
  RESERVATION_PREFILL_SCHEMA_VERSION,
  RESERVATION_WORKFLOW_V2_VERSION,
  reservationWorkflowV2DraftSchema,
  reservationWorkflowV2FieldOverrideSchema,
  reservationWorkflowV2ObservationSchema,
  type ReservationWorkflowV2Draft,
  type ReservationWorkflowV2Observation,
  type ReservationWorkflowV2Proposal,
  type ReservationWorkflowV2Source,
} from './reservation-workflow-v2-contract.js';

export const RESERVATION_WORKFLOW_V2_STATE_KEY = 'reservationWorkflowV2';
type State = Record<string, unknown>;
export type ReservationWorkflowV2Context = { db: DB; transportId: string; userId?: string | null; propertyCode: string };
type Context = ReservationWorkflowV2Context;
type WorkTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

/** Serialize source seeding and legacy/v2 Create authorization for the same email. */
export async function lockReservationWorkflowV2Source(tx: Parameters<Parameters<DB['transaction']>[0]>[0],
  transportId: string, messageId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
    ${JSON.stringify(['reservation-v2-source', transportId, messageId])}, 0))`);
}

export type ReservationWorkflowV2Seed = {
  generationId?: string;
  status: ReservationWorkflowV2Draft['status'];
  proposal: ReservationWorkflowV2Proposal;
  observations: ReservationWorkflowV2Observation[];
  fieldReviewRequirements?: ReservationWorkflowV2Draft['fieldReviewRequirements'];
  errors?: ReservationWorkflowV2Draft['errors'];
};
export type ReservationWorkflowV2SourceInput = ReservationWorkflowV2Source;
export type ReservationWorkflowV2StateResult =
  | { status: 'ok'; draft: ReservationWorkflowV2Draft; revision: number; revisionHead: number; seq: number }
  | { status: 'not_found' | 'invalid_source' | 'wrong_property' | 'invalid_state' | 'stale_revision' | 'invalid_path' | 'invalid_value' };

export function reservationWorkflowV2DraftOf(state: State): ReservationWorkflowV2Draft | null {
  const parsed = reservationWorkflowV2DraftSchema.safeParse(state[RESERVATION_WORKFLOW_V2_STATE_KEY]);
  return parsed.success ? parsed.data : null;
}

export function hasReservationWorkflowV2Draft(state: State): boolean {
  return Object.hasOwn(state, RESERVATION_WORKFLOW_V2_STATE_KEY);
}

/** Revalidate canonical mailbox eligibility/cutoff before the model or native readers run. */
export async function validateReservationWorkflowV2Source(ctx: Context, source: ReservationWorkflowV2SourceInput): Promise<
  { status: 'ok' } | { status: 'invalid_source' | 'wrong_property' | 'not_found' }
> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  if (!(await hasMailboxAccess(ctx.db, ctx))) return { status: 'not_found' };
  return await sourceMail(ctx.db, ctx, source) ? { status: 'ok' } : { status: 'invalid_source' };
}

function propertyMatches(ctx: Context): boolean {
  const resolved = resolvePropertyTransport(ctx.transportId);
  return resolved.kind === 'property' && resolved.property.propertyCode === ctx.propertyCode;
}

async function sourceMail(db: WorkTx, ctx: Context, source: ReservationWorkflowV2Source) {
  const [row] = await db.select({
    id: message.id, threadId: message.threadId, transportId: message.transportId,
    direction: message.direction, historyOnly: message.historyOnly, sourceProvenance: message.sourceProvenance,
    subject: message.subject, textBody: message.textBody, htmlBody: message.htmlBody,
    arrivedAt: MESSAGE_ARRIVED_AT,
  }).from(message).innerJoin(mailThread, and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, message.transportId)))
    .where(and(eq(message.id, source.messageId), eq(message.threadId, source.threadId),
      eq(message.transportId, ctx.transportId), eq(message.direction, 'inbound'), eq(message.historyOnly, false),
      eq(mailThread.historyOnly, false), isNull(mailThread.trashedAt), isNull(mailThread.spamAt)))
    .limit(1);
  if (!row || row.sourceProvenance?.attention != null || staffQuoteSourceHash(row) !== source.sourceHash ||
      !(row.arrivedAt instanceof Date) || row.arrivedAt.toISOString() !== source.arrivedAt) return null;
  return row;
}

async function hasMailboxAccess(db: WorkTx, ctx: Context): Promise<boolean> {
  if (!ctx.userId) return true;
  const [access] = await db.select({ id: mailboxAccess.id }).from(mailboxAccess)
    .where(and(eq(mailboxAccess.userId, ctx.userId), eq(mailboxAccess.transportId, ctx.transportId))).limit(1);
  return Boolean(access);
}

type ItemRow = {
  id: string; transportId: string; threadId: string | null; sourceMessageId: string | null; kind: string;
  extractionId: string | null; state: State; revision: number; revisionHead: number; revisionSeq: number;
};

async function loadItem(db: WorkTx, ctx: Context, workItemId: string, lock = false): Promise<ItemRow | null> {
  const query = db.select({ id: workItem.id, transportId: workItem.transportId, threadId: workItem.threadId,
    sourceMessageId: workItem.sourceMessageId, kind: workItem.kind, extractionId: workItem.extractionId,
    state: workItem.state, revision: workItem.revision, revisionHead: workItem.revisionHead,
    revisionSeq: workItem.revisionSeq }).from(workItem)
    .where(and(eq(workItem.id, workItemId), eq(workItem.transportId, ctx.transportId))).limit(1);
  const [row] = lock ? await query.for('update') : await query;
  return row ? { ...row, state: row.state as State } : null;
}

async function buildResult(db: WorkTx, ctx: Context, item: ItemRow, source: ReservationWorkflowV2Source): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx) || !item.threadId || item.threadId !== source.threadId || item.sourceMessageId !== source.messageId) {
    return { status: 'invalid_source' };
  }
  if (!(await hasMailboxAccess(db, ctx))) return { status: 'not_found' };
  const mail = await sourceMail(db, ctx, source);
  if (!mail) return { status: 'invalid_source' };
  const draft = reservationWorkflowV2DraftOf(item.state);
  if (!draft) return { status: hasReservationWorkflowV2Draft(item.state) ? 'invalid_state' : 'not_found' };
  if (draft.workItemId !== item.id || draft.transportId !== ctx.transportId || draft.propertyCode !== ctx.propertyCode ||
      draft.source.sourceHash !== source.sourceHash || draft.source.messageId !== source.messageId ||
      draft.source.threadId !== source.threadId || draft.source.arrivedAt !== source.arrivedAt) return { status: 'invalid_source' };
  return { status: 'ok', draft: { ...draft, revision: item.revision }, revision: item.revision,
    revisionHead: item.revisionHead, seq: item.revisionSeq };
}

export async function getReservationWorkflowV2Draft(ctx: Context, input: {
  workItemId: string; source: ReservationWorkflowV2SourceInput;
}): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  const item = await loadItem(ctx.db, ctx, input.workItemId);
  return item ? buildResult(ctx.db, ctx, item, input.source) : { status: 'not_found' };
}

/** Source-keyed read lets ensure routes avoid re-running prefill for an already editable WorkItem. */
export async function getReservationWorkflowV2DraftForSource(ctx: Context, input: {
  source: ReservationWorkflowV2SourceInput;
}): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  const [item] = await ctx.db.select({ id: workItem.id, transportId: workItem.transportId, threadId: workItem.threadId,
    sourceMessageId: workItem.sourceMessageId, kind: workItem.kind, extractionId: workItem.extractionId,
    state: workItem.state, revision: workItem.revision, revisionHead: workItem.revisionHead,
    revisionSeq: workItem.revisionSeq }).from(workItem)
    .where(and(eq(workItem.transportId, ctx.transportId), eq(workItem.threadId, input.source.threadId),
      eq(workItem.sourceMessageId, input.source.messageId), sql`${workItem.state} ? ${RESERVATION_WORKFLOW_V2_STATE_KEY}`))
    .orderBy(desc(workItem.updatedAt), desc(workItem.id)).limit(1);
  if (!item || !hasReservationWorkflowV2Draft(item.state as State)) return { status: 'not_found' };
  return buildResult(ctx.db, ctx, { ...item, state: item.state as State }, input.source);
}

function initialKind(seed: ReservationWorkflowV2Seed): (typeof MAIL_KINDS)[number] {
  const first = seed.proposal.content.requests[0]?.kind;
  if (first === 'create') return 'booking';
  if (first === 'quote') return 'quote';
  if (first === 'amend') return 'amendment';
  if (first === 'cancel') return 'cancellation';
  if (first === 'filing') return 'voucher_pop';
  return 'other';
}

/** Creates/reuses one source WorkItem and seeds its only canonical v2 draft. Existing edits/results are never replaced. */
export async function ensureReservationWorkflowV2Draft(ctx: Context, input: {
  source: ReservationWorkflowV2SourceInput; extractionId?: string | null; seed: ReservationWorkflowV2Seed;
}): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  const saved = await ctx.db.transaction(async (tx) => {
    // Serialize v2 seeding for the email, even if competing runs infer different
    // legacy WorkItem kinds. Background reads may still add other-kind rows.
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    const [mail] = await sourceMail(tx, ctx, input.source).then((row) => row ? [row] : []);
    if (!mail || !(await hasMailboxAccess(tx, ctx))) return { status: 'invalid_source' as const };
    let [item] = await tx.select({ id: workItem.id, transportId: workItem.transportId, threadId: workItem.threadId,
      sourceMessageId: workItem.sourceMessageId, kind: workItem.kind, extractionId: workItem.extractionId,
      state: workItem.state, revision: workItem.revision, revisionHead: workItem.revisionHead,
      revisionSeq: workItem.revisionSeq }).from(workItem)
      .where(and(eq(workItem.transportId, ctx.transportId), eq(workItem.threadId, input.source.threadId),
        eq(workItem.sourceMessageId, input.source.messageId)))
      .orderBy(desc(sql`${workItem.state} ? ${RESERVATION_WORKFLOW_V2_STATE_KEY}`),
        desc(workItem.updatedAt), desc(workItem.id)).limit(1).for('update');
    if (!item) {
      const kind = initialKind(input.seed);
      const [inserted] = await tx.insert(workItem).values({ transportId: ctx.transportId, threadId: input.source.threadId,
        sourceMessageId: input.source.messageId, kind, extractionId: input.extractionId ?? null })
        .onConflictDoNothing().returning({ id: workItem.id, transportId: workItem.transportId, threadId: workItem.threadId,
          sourceMessageId: workItem.sourceMessageId, kind: workItem.kind, extractionId: workItem.extractionId,
          state: workItem.state, revision: workItem.revision, revisionHead: workItem.revisionHead,
          revisionSeq: workItem.revisionSeq });
      item = inserted;
      if (!item) {
        const [raced] = await tx.select({ id: workItem.id, transportId: workItem.transportId, threadId: workItem.threadId,
          sourceMessageId: workItem.sourceMessageId, kind: workItem.kind, extractionId: workItem.extractionId,
          state: workItem.state, revision: workItem.revision, revisionHead: workItem.revisionHead,
          revisionSeq: workItem.revisionSeq }).from(workItem)
          .where(and(eq(workItem.transportId, ctx.transportId), eq(workItem.threadId, input.source.threadId),
            eq(workItem.sourceMessageId, input.source.messageId)))
          .orderBy(desc(workItem.updatedAt), desc(workItem.id)).limit(1).for('update');
        item = raced;
      }
    }
    if (!item) return { status: 'not_found' as const };
    const itemRow = { ...item, state: item.state as State };
    const existing = reservationWorkflowV2DraftOf(itemRow.state);
    if (existing) return buildResult(tx, ctx, itemRow, input.source);
    if (hasReservationWorkflowV2Draft(itemRow.state)) return { status: 'invalid_state' as const };
    const draft = reservationWorkflowV2DraftSchema.parse({
      contractVersion: RESERVATION_WORKFLOW_V2_VERSION,
      schemaVersion: RESERVATION_PREFILL_SCHEMA_VERSION,
      workItemId: itemRow.id,
      transportId: ctx.transportId,
      propertyCode: ctx.propertyCode,
      source: input.source,
      generationId: input.seed.generationId ?? randomUUID(),
      revision: itemRow.revision,
      status: input.seed.status,
      proposal: input.seed.proposal,
      observations: input.seed.observations,
      fieldReviewRequirements: input.seed.fieldReviewRequirements ?? {},
      staffReviews: {},
      operationResults: [],
      fieldOverrides: {},
      errors: input.seed.errors ?? [],
    });
    const state = { ...itemRow.state, [RESERVATION_WORKFLOW_V2_STATE_KEY]: draft };
    await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, itemRow.id));
    await tx.insert(workEvent).values({ workItemId: itemRow.id, actorKind: 'ai', type: 'field.seed',
      fieldPath: RESERVATION_WORKFLOW_V2_STATE_KEY, value: { contractVersion: RESERVATION_WORKFLOW_V2_VERSION,
        status: draft.status, generationId: draft.generationId }, aiSource: RESERVATION_PREFILL_SCHEMA_VERSION,
      evidence: { sourceMessageId: input.source.messageId, sourceHash: input.source.sourceHash,
        extractionId: itemRow.extractionId } });
    return { status: 'ok' as const, draft, revision: itemRow.revision,
      revisionHead: itemRow.revisionHead, seq: itemRow.revisionSeq };
  });
  return saved;
}

type MutationInput = { workItemId: string; source: ReservationWorkflowV2SourceInput; expectedRevision: number; expectedSeq: number };
type V2Override = ReservationWorkflowV2Draft['fieldOverrides'][string];

function pathParts(path: string): string[] | null {
  if (!path.startsWith('/proposal/content/')) return null;
  const parts = path.slice(1).split('/').map((part) => {
    try { return decodeURIComponent(part); } catch { return ''; }
  });
  if (parts.some((part) => !part || part === '__proto__' || part === 'prototype' || part === 'constructor')) return null;
  return parts;
}

const NEVER_EDIT = new Set(['id', 'kind', 'sourceRefs', 'serviceRefs', 'documentRefs', 'candidateRefs', 'priceObservationRefs',
  'evidenceRefs', 'lookupResultRefs', 'annotations', 'issues', 'sourceClaims', 'observations', 'suggestedRef']);

function editableCancelBodyField(draft: ReservationWorkflowV2Draft, parts: string[]): boolean {
  if (parts[0] !== 'proposal' || parts[1] !== 'content' || parts[2] !== 'requests' || parts[4] !== 'body') return false;
  const request = draft.proposal.content.requests.find((entry) => entry.id === parts[3]);
  if (request?.kind !== 'cancel') return false;
  if (parts.length === 7 && parts[5] === 'targets' && parts[6] === 'mode') return true;
  if (parts.length === 7 && parts[5] === 'reason' && parts[6] === 'text') return true;
  if (parts.length === 6 && parts[5] === 'cancellationNote') return true;
  if (parts.length !== 9 || parts[5] !== 'targets' || parts[6] !== 'include' ||
      !/^(?:0|[1-9]\d*)$/.test(parts[7] ?? '')) return false;
  const hint = request.body.targets.include[Number(parts[7])];
  return Boolean(hint?.id && ['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture', 'suggestedRef'].includes(parts[8]!));
}

function editablePath(draft: ReservationWorkflowV2Draft, path: string): boolean {
  const parts = pathParts(path);
  if (!parts || parts.length < 5) return false;
  const [, section, collection, stableId, branch] = parts;
  if (section !== 'content' || !['requests', 'services', 'documents'].includes(collection!)) return false;
  const rows = collection === 'requests' ? draft.proposal.content.requests :
    collection === 'services' ? draft.proposal.content.services : draft.proposal.content.documents;
  const rowIndex = /^(?:0|[1-9]\d*)$/.test(stableId ?? '') ? Number(stableId) : -1;
  if (!rows.some((entry) => entry.id === stableId) && !(Number.isSafeInteger(rowIndex) && rowIndex >= 0 && rowIndex < rows.length)) return false;
  if (collection === 'requests') {
    const request = rows.find((entry) => entry.id === stableId) ?? rows[rowIndex];
    if (request?.kind === 'cancel') return branch === 'requestText' && parts.length === 5 || editableCancelBodyField(draft, parts);
    if (parts.some((part) => NEVER_EDIT.has(part))) return false;
    return branch === 'body' || (branch === 'requestText' && parts.length === 5);
  }
  if (parts.some((part) => NEVER_EDIT.has(part))) return false;
  return true;
}

function validateOverride(value: unknown): V2Override | null {
  const parsed = reservationWorkflowV2FieldOverrideSchema.safeParse(value);
  return parsed.success ? { ...parsed.data, updatedAt: new Date().toISOString() } : null;
}

function updateDraft(current: ReservationWorkflowV2Draft, input: {
  fieldPath: string; override?: V2Override; review?: ReservationWorkflowV2Draft['staffReviews'][string];
}): ReservationWorkflowV2Draft {
  const fieldOverrides = { ...current.fieldOverrides };
  const staffReviews = { ...current.staffReviews };
  if (input.override) {
    fieldOverrides[input.fieldPath] = input.override;
    // A review belongs to the displayed value and scope; replacing a parent also replaces its child values.
    for (const path of Object.keys(staffReviews)) {
      if (path === input.fieldPath || path.startsWith(`${input.fieldPath}/`) || input.fieldPath.startsWith(`${path}/`)) {
        delete staffReviews[path];
      }
    }
  }
  if (input.review) staffReviews[input.fieldPath] = input.review;
  return reservationWorkflowV2DraftSchema.parse({ ...current, revision: current.revision + 1, fieldOverrides, staffReviews });
}

async function mutateDraft(ctx: Context, input: MutationInput & { fieldPath: string; override?: V2Override;
  review?: ReservationWorkflowV2Draft['staffReviews'][string]; eventType: 'field.edit' | 'field.accept' | 'field.reject';
  value: unknown }): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  return ctx.db.transaction(async (tx) => {
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    if (item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq) return { status: 'stale_revision' as const };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok') return current;
    const next = updateDraft(current.draft, input);
    const nextState = { ...item.state, [RESERVATION_WORKFLOW_V2_STATE_KEY]: next };
    const advanced = advancePaneRevision({ revision: item.revision, revisionHead: item.revisionHead,
      seq: item.revisionSeq, previousState: item.state, nextState, extractionId: item.extractionId });
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'user', actorUserId: ctx.userId ?? null,
      type: input.eventType, fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:${input.fieldPath}`,
      aiValue: null, value: input.value, aiSource: RESERVATION_PREFILL_SCHEMA_VERSION,
      evidence: advanced.evidence });
    await tx.update(workItem).set({ state: nextState, revision: advanced.revision, revisionHead: advanced.revisionHead,
      revisionSeq: item.revisionSeq + 1, updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { status: 'ok' as const, draft: next, revision: advanced.revision,
      revisionHead: advanced.revisionHead, seq: item.revisionSeq + 1 };
  });
}

export async function editReservationWorkflowV2Draft(ctx: Context, input: MutationInput & {
  fieldPath: string; value: unknown;
}): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  const current = await getReservationWorkflowV2Draft(ctx, input);
  if (current.status !== 'ok') return current;
  if (!editablePath(current.draft, input.fieldPath)) return { status: 'invalid_path' };
  const override = validateOverride(input.value);
  if (!override) return { status: 'invalid_value' };
  return mutateDraft(ctx, { ...input, override, eventType: 'field.edit', value: override });
}

export async function reviewReservationWorkflowV2Draft(ctx: Context, input: MutationInput & {
  fieldPath: string; decision: 'accepted' | 'flagged'; note?: string | null;
}): Promise<ReservationWorkflowV2StateResult> {
  const current = await getReservationWorkflowV2Draft(ctx, input);
  if (current.status !== 'ok') return current;
  if (!editablePath(current.draft, input.fieldPath)) return { status: 'invalid_path' };
  const review = { status: input.decision, note: input.note ?? null, at: new Date().toISOString() } as const;
  return mutateDraft(ctx, { ...input, review, eventType: input.decision === 'accepted' ? 'field.accept' : 'field.reject', value: review });
}

export async function moveReservationWorkflowV2History(ctx: Context, input: MutationInput & {
  direction: 'undo' | 'redo';
}): Promise<ReservationWorkflowV2StateResult | { status: 'at_boundary' | 'history_stale'; revision: number; revisionHead: number; seq: number }> {
  const current = await getReservationWorkflowV2Draft(ctx, input);
  if (current.status !== 'ok') return current;
  const item = await loadItem(ctx.db, ctx, input.workItemId);
  if (!item) return { status: 'not_found' };
  if (item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq) return { status: 'stale_revision' };
  const result = input.direction === 'undo'
    ? await undoWorkItemRevision(ctx.db, { transportId: ctx.transportId, workItemId: input.workItemId,
      userId: ctx.userId ?? '', expectedSeq: input.expectedSeq, expectedExtractionId: item.extractionId })
    : await redoWorkItemRevision(ctx.db, { transportId: ctx.transportId, workItemId: input.workItemId,
      userId: ctx.userId ?? '', expectedSeq: input.expectedSeq, expectedExtractionId: item.extractionId });
  if (result.status === 'not_found') return { status: 'not_found' };
  if (result.status === 'stale') return { status: 'stale_revision' };
  if (result.status !== 'applied') return result;
  return getReservationWorkflowV2Draft(ctx, input);
}

/** Server-owned additions never replace staff overrides/reviews and are deliberately outside undo history. */
export async function appendReservationWorkflowV2Observation(ctx: Context, input: {
  workItemId: string; source: ReservationWorkflowV2SourceInput;
  observation: ReservationWorkflowV2Observation;
}): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  const parsed = reservationWorkflowV2ObservationSchema.safeParse(input.observation);
  if (!parsed.success || parsed.data.propertyCode !== ctx.propertyCode) return { status: 'invalid_value' };
  return ctx.db.transaction(async (tx) => {
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok') return current;
    const existingRefs = new Set(current.draft.observations.map((entry) => entry.ref));
    if (parsed.data.generationId !== current.draft.generationId ||
        parsed.data.sourceRefs.some((ref) => !existingRefs.has(ref)) || existingRefs.has(parsed.data.ref)) {
      return { status: 'invalid_value' as const };
    }
    const next = reservationWorkflowV2DraftSchema.parse({ ...current.draft, observations: [...current.draft.observations, parsed.data] });
    const nextState = { ...item.state, [RESERVATION_WORKFLOW_V2_STATE_KEY]: next };
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'system', type: 'hms.lookup.finished',
      value: { ref: parsed.data.ref, kind: parsed.data.kind, status: parsed.data.status },
      evidence: { sourceHash: input.source.sourceHash, observedAt: parsed.data.observedAt } });
    await tx.update(workItem).set({ state: nextState, updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { status: 'ok' as const, draft: next, revision: item.revision, revisionHead: item.revisionHead, seq: item.revisionSeq };
  });
}

export async function recordReservationWorkflowV2Result(ctx: Context, input: {
  workItemId: string; source: ReservationWorkflowV2SourceInput;
  result: ReservationWorkflowV2Draft['operationResults'][number];
}): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  return ctx.db.transaction(async (tx) => {
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    if (!(await hasMailboxAccess(tx, ctx))) return { status: 'not_found' as const };
    const currentDraft = reservationWorkflowV2DraftOf(item.state);
    if (!currentDraft) return { status: 'not_found' as const };
    if (currentDraft.workItemId !== item.id || currentDraft.transportId !== ctx.transportId ||
        currentDraft.propertyCode !== ctx.propertyCode || currentDraft.source.threadId !== input.source.threadId ||
        currentDraft.source.messageId !== input.source.messageId || currentDraft.source.sourceHash !== input.source.sourceHash ||
        currentDraft.source.arrivedAt !== input.source.arrivedAt || currentDraft.generationId !== input.result.generationId) {
      return { status: 'invalid_source' as const };
    }
    if (input.result.draftRevision > item.revisionHead ||
        input.result.observationRefs.some((ref) => !currentDraft.observations.some((o) => o.ref === ref))) {
      return { status: 'invalid_value' as const };
    }
    const previous = currentDraft.operationResults.find((result) => result.id === input.result.id);
    if (previous && (previous.requestId !== input.result.requestId || previous.allocationId !== input.result.allocationId ||
        previous.workflow !== input.result.workflow)) return { status: 'invalid_value' as const };
    // A later catch or concurrent reconciliation must not erase positive Save
    // evidence and make this room eligible for another Create.
    if (previous?.status === 'succeeded') return { status: 'ok' as const, draft: currentDraft,
      revision: item.revision, revisionHead: item.revisionHead, seq: item.revisionSeq };
    const operationResults = [...currentDraft.operationResults.filter((result) => result.id !== input.result.id), input.result];
    const next = reservationWorkflowV2DraftSchema.parse({ ...currentDraft, revision: item.revision, operationResults });
    const nextState = { ...item.state, [RESERVATION_WORKFLOW_V2_STATE_KEY]: next };
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'system', type: 'write.evidence',
      fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:operationResults:${input.result.id}`,
      value: { id: input.result.id, requestId: input.result.requestId, workflow: input.result.workflow,
        status: input.result.status, observationRefs: input.result.observationRefs },
      evidence: { sourceHash: input.source.sourceHash, seq: item.revisionSeq } });
    await tx.update(workItem).set({ state: nextState, updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { status: 'ok' as const, draft: next, revision: item.revision, revisionHead: item.revisionHead, seq: item.revisionSeq };
  });
}

export function reservationWorkflowV2Kind(value: unknown): (typeof MAIL_KINDS)[number] | null {
  return typeof value === 'string' && (MAIL_KINDS as readonly string[]).includes(value)
    ? value as (typeof MAIL_KINDS)[number] : null;
}
