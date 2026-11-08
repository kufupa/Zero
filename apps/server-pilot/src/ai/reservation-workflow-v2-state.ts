import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { MAIL_KINDS, workEvent, workItem } from '../db/schema/work.js';
import { attachment, mailboxAccess, mailThread, message } from '../db/schema/mail.js';
import { resolvePropertyTransport } from '../../tooling/playwright-quote/property-registry.mjs';
import { MESSAGE_ARRIVED_AT } from './message-arrival-time.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { advancePaneRevision, redoWorkItemRevision, undoWorkItemRevision,
  rebaseReservationV2Path, rebaseReservationV2Observations, nativeStructureIsSafe } from './work-item-revision.js';
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
  prefill?: ReservationWorkflowV2Draft['prefill'];
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
      ...(input.seed.prefill ? { prefill: input.seed.prefill } : {}),
    });
    const state = { ...itemRow.state, [RESERVATION_WORKFLOW_V2_STATE_KEY]: draft };
    // WorkItems can predate V2. Snapshot existing activity under the item lock
    // so old events do not suppress prefill, while any later event still does.
    const prefillActivityCount = await countPrefillRetryActivity(tx, itemRow.id);
    await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, itemRow.id));
    await tx.insert(workEvent).values({ workItemId: itemRow.id, actorKind: 'ai', type: 'field.seed',
      fieldPath: RESERVATION_WORKFLOW_V2_STATE_KEY, value: { contractVersion: RESERVATION_WORKFLOW_V2_VERSION,
        status: draft.status, generationId: draft.generationId }, aiSource: RESERVATION_PREFILL_SCHEMA_VERSION,
      evidence: { sourceMessageId: input.source.messageId, sourceHash: input.source.sourceHash,
        extractionId: itemRow.extractionId, prefillActivityCount, prefillActivitySeq: itemRow.revisionSeq } });
    return { status: 'ok' as const, draft, revision: itemRow.revision,
      revisionHead: itemRow.revisionHead, seq: itemRow.revisionSeq };
  });
  return saved;
}

export async function initializeReservationWorkflowV2Draft(ctx: Context, source: ReservationWorkflowV2SourceInput) {
  return ensureReservationWorkflowV2Draft(ctx, { source, seed: { status: 'partial',
    proposal: { schemaVersion: RESERVATION_PREFILL_SCHEMA_VERSION,
      content: { requests: [], services: [], documents: [] }, annotations: [], issues: [], sourceClaims: [], lookupResultRefs: [] },
    observations: [], prefill: { status: 'idle', attemptId: null, attemptCount: 0, startedAt: null, finishedAt: null } } });
}

type PrefillClaim = { attemptId: string; revision: number; seq: number; snapshot: string };
function prefillSnapshot(draft: ReservationWorkflowV2Draft): string {
  const { prefill: _prefill, ...rest } = draft;
  return JSON.stringify(rest);
}

/** Metadata is not a human edit and never advances the pane cursor. */
export async function claimReservationWorkflowV2Prefill(ctx: Context, input: MutationInput & { allowRetry: boolean }): Promise<
  { result: ReservationWorkflowV2StateResult; claim?: PrefillClaim }
> {
  if (!propertyMatches(ctx)) return { result: { status: 'wrong_property' } };
  return ctx.db.transaction(async (tx) => {
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { result: { status: 'not_found' as const } };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok') return { result: current };
    if (item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq)
      return { result: { status: 'stale_revision' as const } };
    // Older untouched fallback drafts predate prefill metadata. Give those one
    // guarded retry; successful and staff-edited legacy drafts stay untouched.
    const meta = current.draft.prefill ?? (input.allowRetry && retryablePrefill(current.draft)
      ? { status: 'failed' as const, attemptId: null, attemptCount: 1, startedAt: null, finishedAt: null }
      : undefined);
    if (!meta || meta.status === 'running' || meta.status === 'complete' || meta.status === 'superseded' ||
        meta.attemptCount >= 2 || (meta.status === 'failed' && !input.allowRetry) ||
        Object.keys(current.draft.fieldOverrides).length || Object.keys(current.draft.staffReviews).length ||
        current.draft.operationResults.length || await hasPrefillRetryActivity(tx, item.id, current.draft.generationId, item.revisionSeq)) return { result: current };
    const attemptId = randomUUID();
    const draft = reservationWorkflowV2DraftSchema.parse({ ...current.draft, prefill: { status: 'running', attemptId,
      attemptCount: meta.attemptCount + 1, startedAt: new Date().toISOString(), finishedAt: null } });
    await tx.update(workItem).set({ state: { ...item.state, [RESERVATION_WORKFLOW_V2_STATE_KEY]: draft },
      updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { result: { ...current, draft }, claim: { attemptId, revision: item.revision, seq: item.revisionSeq,
      snapshot: prefillSnapshot(current.draft) } };
  });
}

/** Install only the exact claimed, still untouched generation; preserve concurrent staff/native state. */
export async function finishReservationWorkflowV2Prefill(ctx: Context, input: MutationInput & {
  claim: PrefillClaim; seed?: ReservationWorkflowV2Seed; failed: boolean;
}): Promise<ReservationWorkflowV2StateResult> {
  return ctx.db.transaction(async (tx) => {
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok') return current;
    const meta = current.draft.prefill;
    if (!meta || meta.attemptId !== input.claim.attemptId || meta.status !== 'running') return current;
    const superseded = item.revision !== input.claim.revision || item.revisionSeq !== input.claim.seq ||
      prefillSnapshot(current.draft) !== input.claim.snapshot ||
      await hasPrefillRetryActivity(tx, item.id, current.draft.generationId, item.revisionSeq);
    const prefill = { ...meta, status: superseded ? 'superseded' as const : input.failed ? 'failed' as const : 'complete' as const,
      finishedAt: new Date().toISOString() };
    const install = !superseded && input.seed;
    const next = reservationWorkflowV2DraftSchema.parse({ ...current.draft, prefill,
      ...(install ? { generationId: install.generationId ?? randomUUID(), status: install.status,
        proposal: install.proposal, observations: install.observations,
        fieldReviewRequirements: install.fieldReviewRequirements ?? {}, errors: install.errors ?? [], revision: item.revision + 1 }
        : !superseded && input.failed ? { status: 'prefill_failed', errors: [{ stage: 'extract', code: 'prefill_unavailable',
          message: 'Prefill could not finish. You can enter the request manually or retry.' }] } : {}) });
    const nextState = { ...item.state, [RESERVATION_WORKFLOW_V2_STATE_KEY]: next };
    if (!install) {
      await tx.update(workItem).set({ state: nextState, updatedAt: new Date() }).where(eq(workItem.id, item.id));
      return { ...current, draft: next };
    }
    const advanced = advancePaneRevision({ revision: item.revision, revisionHead: item.revisionHead,
      seq: item.revisionSeq, previousState: item.state, nextState, extractionId: item.extractionId });
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'ai', type: 'field.seed',
      fieldPath: RESERVATION_WORKFLOW_V2_STATE_KEY, value: { generationId: next.generationId, status: next.status },
      aiSource: RESERVATION_PREFILL_SCHEMA_VERSION, evidence: advanced.evidence });
    await tx.update(workItem).set({ state: nextState, revision: advanced.revision, revisionHead: advanced.revisionHead,
      revisionSeq: item.revisionSeq + 1, updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { status: 'ok' as const, draft: next, revision: advanced.revision,
      revisionHead: advanced.revisionHead, seq: item.revisionSeq + 1 };
  });
}

/** Record native work at dispatch, before a concurrent prefill can install. */
export async function markReservationWorkflowV2NativeActivity(ctx: Context, input: MutationInput): Promise<ReservationWorkflowV2StateResult> {
  return ctx.db.transaction(async (tx) => {
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    if (item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq) return { status: 'stale_revision' as const };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok') return current;
    if (current.draft.prefill?.status !== 'running') return current;
    const draft = { ...current.draft, prefill: { ...current.draft.prefill, status: 'superseded' as const,
      finishedAt: new Date().toISOString() } };
    await tx.update(workItem).set({ state: { ...item.state, [RESERVATION_WORKFLOW_V2_STATE_KEY]: draft },
      updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { ...current, draft };
  });
}

/** Only untouched extraction or zero-allocation Create synthesis fallbacks are eligible for retry. */
function retryablePrefill(draft: ReservationWorkflowV2Draft): boolean {
  if (draft.status !== 'partial' || draft.operationResults.length || Object.keys(draft.fieldOverrides).length ||
      Object.keys(draft.staffReviews).length) return false;
  const hasNoContentEntities = !draft.proposal.content.services.length && !draft.proposal.content.documents.length;
  if (draft.errors.some((error) => error.stage === 'extract' &&
      ['extract_unavailable', 'model_timeout', 'model_error', 'invalid_typed_extraction'].includes(error.code))) {
    return draft.proposal.content.requests.length === 1 && draft.proposal.content.requests[0]?.kind === 'other' &&
      hasNoContentEntities && draft.observations.length === 1 && draft.observations[0]?.kind === 'source';
  }
  const hasCreate = draft.proposal.content.requests.some((request) => request.kind === 'create');
  return draft.errors.some((error) => error.stage === 'synthesis' && ['model_timeout', 'model_error'].includes(error.code)) &&
    draft.proposal.issues.some((issue) => issue.path === '/' && issue.kind === 'prefill_partial') && hasCreate &&
    draft.proposal.content.requests.filter((request) => request.kind === 'create')
      .every((request) => request.body.allocations.length === 0) && hasNoContentEntities &&
    !Object.keys(draft.fieldReviewRequirements).length;
}

type PrefillRetryInput = { source: ReservationWorkflowV2SourceInput; workItemId: string;
  revision: number; seq: number; draft: ReservationWorkflowV2Draft };

function prefillActivityPredicate() {
  return or(and(eq(workEvent.actorKind, 'user'), ne(workEvent.type, 'pane.opened')),
    eq(workEvent.type, 'write.evidence'), eq(workEvent.type, 'hms.lookup.finished'));
}

async function countPrefillRetryActivity(tx: WorkTx, workItemId: string): Promise<number> {
  const [result] = await tx.select({ count: sql<number>`count(*)::integer` }).from(workEvent)
    .where(and(eq(workEvent.workItemId, workItemId), prefillActivityPredicate()));
  return Number(result?.count ?? 0);
}

async function hasPrefillRetryActivity(tx: WorkTx, workItemId: string, generationId: string, revisionSeq: number): Promise<boolean> {
  const [seed] = await tx.select({ id: workEvent.id, evidence: workEvent.evidence }).from(workEvent)
    .where(and(eq(workEvent.workItemId, workItemId), eq(workEvent.type, 'field.seed'),
      eq(workEvent.fieldPath, RESERVATION_WORKFLOW_V2_STATE_KEY), sql`${workEvent.value}->>'generationId' = ${generationId}`))
    .orderBy(desc(workEvent.at)).limit(1);
  if (!seed) return true;
  const evidence = seed.evidence && typeof seed.evidence === 'object' && !Array.isArray(seed.evidence)
    ? seed.evidence as Record<string, unknown> : {};
  if (Number.isSafeInteger(evidence.prefillActivityCount) && Number.isSafeInteger(evidence.prefillActivitySeq)) {
    return revisionSeq !== evidence.prefillActivitySeq ||
      await countPrefillRetryActivity(tx, workItemId) !== evidence.prefillActivityCount;
  }
  // Existing V2 seeds lack the count baseline. Treat equal timestamps as later;
  // use their revision cursor when available, and otherwise remain conservative.
  if (Number.isSafeInteger(evidence.paneSeq) && revisionSeq !== evidence.paneSeq) return true;
  const [activity] = await tx.select({ id: workEvent.id }).from(workEvent).where(and(eq(workEvent.workItemId, workItemId),
    prefillActivityPredicate(), sql`${workEvent.at} >= (select ${workEvent.at} from ${workEvent} where ${workEvent.id} = ${seed.id})`)).limit(1);
  return Boolean(activity);
}

/** Claim at most two retry attempts per failed generation, with a durable cooldown. */
export async function claimReservationWorkflowV2PrefillRetry(ctx: Context, input: PrefillRetryInput): Promise<boolean> {
  if (!propertyMatches(ctx) || !retryablePrefill(input.draft)) return false;
  return ctx.db.transaction(async (tx) => {
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item || item.revision !== input.revision || item.revisionSeq !== input.seq) return false;
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok' || !retryablePrefill(current.draft) ||
        JSON.stringify(current.draft) !== JSON.stringify(input.draft) ||
        await hasPrefillRetryActivity(tx, item.id, current.draft.generationId, item.revisionSeq)) return false;
    const fieldPath = `${RESERVATION_WORKFLOW_V2_STATE_KEY}:prefill_retry:${current.draft.generationId}`;
    const attempts = await tx.select({ at: workEvent.at }).from(workEvent).where(and(
      eq(workEvent.workItemId, item.id), eq(workEvent.type, 'field.seed'), eq(workEvent.fieldPath, fieldPath)))
      .orderBy(desc(workEvent.at)).limit(2);
    if (attempts.length >= 2 || (attempts[0] && Date.now() - attempts[0].at.getTime() < 15 * 60_000)) return false;
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'system', type: 'field.seed', fieldPath,
      value: { generationId: current.draft.generationId, attempt: attempts.length + 1 },
      evidence: { sourceHash: input.source.sourceHash } });
    return true;
  });
}

/** Install a successful retry only if the original fallback is still unchanged. */
export async function replaceReservationWorkflowV2PrefillRetry(ctx: Context,
  input: PrefillRetryInput & { seed: ReservationWorkflowV2Seed }): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  return ctx.db.transaction(async (tx) => {
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok') return current;
    if (item.revision !== input.revision || item.revisionSeq !== input.seq || !retryablePrefill(current.draft) ||
        JSON.stringify(current.draft) !== JSON.stringify(input.draft) ||
        await hasPrefillRetryActivity(tx, item.id, current.draft.generationId, item.revisionSeq)) return current;
    const next = reservationWorkflowV2DraftSchema.parse({ ...current.draft, revision: item.revision + 1,
      generationId: input.seed.generationId ?? randomUUID(), status: input.seed.status, proposal: input.seed.proposal,
      observations: input.seed.observations, fieldReviewRequirements: input.seed.fieldReviewRequirements ?? {},
      errors: input.seed.errors ?? [] });
    const nextState = { ...item.state, [RESERVATION_WORKFLOW_V2_STATE_KEY]: next };
    const advanced = advancePaneRevision({ revision: item.revision, revisionHead: item.revisionHead,
      seq: item.revisionSeq, previousState: item.state, nextState, extractionId: item.extractionId });
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'ai', type: 'field.seed',
      fieldPath: RESERVATION_WORKFLOW_V2_STATE_KEY,
      value: { contractVersion: RESERVATION_WORKFLOW_V2_VERSION, status: next.status, generationId: next.generationId },
      aiSource: RESERVATION_PREFILL_SCHEMA_VERSION, evidence: advanced.evidence });
    await tx.update(workItem).set({ state: nextState, revision: advanced.revision, revisionHead: advanced.revisionHead,
      revisionSeq: item.revisionSeq + 1, updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { status: 'ok' as const, draft: next, revision: advanced.revision,
      revisionHead: advanced.revisionHead, seq: item.revisionSeq + 1 };
  });
}

export type ReservationWorkflowV2MutationInput = { workItemId: string; source: ReservationWorkflowV2SourceInput; expectedRevision: number; expectedSeq: number };
type MutationInput = ReservationWorkflowV2MutationInput;

/** All command builders run under the same source validation, row lock, cursor and history. */
export async function withLockedV2DraftMutation(ctx: Context, input: MutationInput, command: {
  fieldPath: string; eventType?: 'field.edit' | 'field.accept' | 'field.reject'; value: unknown;
  apply: (draft: ReservationWorkflowV2Draft) => { draft: ReservationWorkflowV2Draft; createdId?: string } | null;
}): Promise<ReservationWorkflowV2StateResult & { createdId?: string }> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  return ctx.db.transaction(async (tx) => {
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    if (item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq) return { status: 'stale_revision' as const };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok') return current;
    const changed = command.apply(current.draft);
    if (!changed) return { status: 'invalid_value' as const };
    const parsed = reservationWorkflowV2DraftSchema.safeParse({ ...changed.draft, revision: item.revision + 1 });
    if (!parsed.success) return { status: 'invalid_value' as const };
    const next = parsed.data;
    const nextState = { ...item.state, [RESERVATION_WORKFLOW_V2_STATE_KEY]: next };
    const advanced = advancePaneRevision({ revision: item.revision, revisionHead: item.revisionHead,
      seq: item.revisionSeq, previousState: item.state, nextState, extractionId: item.extractionId });
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'user', actorUserId: ctx.userId ?? null,
      type: command.eventType ?? 'field.edit', fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:${command.fieldPath}`,
      value: command.value, aiSource: RESERVATION_PREFILL_SCHEMA_VERSION, evidence: advanced.evidence });
    await tx.update(workItem).set({ state: nextState, revision: advanced.revision, revisionHead: advanced.revisionHead,
      revisionSeq: item.revisionSeq + 1, updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { status: 'ok' as const, draft: next, revision: advanced.revision, revisionHead: advanced.revisionHead,
      seq: item.revisionSeq + 1, ...(changed.createdId ? { createdId: changed.createdId } : {}) };
  });
}
type V2Override = ReservationWorkflowV2Draft['fieldOverrides'][string];

function pathParts(path: string): string[] | null {
  if (!path.startsWith('/proposal/content/')) return null;
  const parts = path.slice(1).split('/').map((part) => {
    try { return decodeURIComponent(part); } catch { return ''; }
  });
  if (parts.some((part) => !part || part === '__proto__' || part === 'prototype' || part === 'constructor')) return null;
  return parts;
}

const NEVER_EDIT = new Set(['id', 'kind', 'dateSectionId', 'sourceRefs', 'serviceRefs', 'documentRefs', 'candidateRefs', 'priceObservationRefs',
  'evidenceRefs', 'lookupResultRefs', 'annotations', 'issues', 'sourceClaims', 'observations', 'suggestedRef']);

function effectiveSavedTargetRows(draft: ReservationWorkflowV2Draft, requestId: string): unknown[] {
  const request = draft.proposal.content.requests.find((entry) => entry.id === requestId);
  if (!request || !('targets' in request.body)) return [];
  let value: unknown = request.body;
  let path = `/proposal/content/requests/${encodeURIComponent(requestId)}/body`;
  for (const key of ['', 'targets', 'include']) {
    if (key) {
      value = value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key] : undefined;
      path += `/${key}`;
    }
    const override = draft.fieldOverrides[path];
    if (override?.state === 'set') value = override.value;
    else if (override && override.state !== 'inherit') value = undefined;
  }
  return Array.isArray(value) ? value : [];
}

function editableCancelBodyField(draft: ReservationWorkflowV2Draft, parts: string[]): boolean {
  if (parts[0] !== 'proposal' || parts[1] !== 'content' || parts[2] !== 'requests' || parts[4] !== 'body') return false;
  const request = draft.proposal.content.requests.find((entry) => entry.id === parts[3]);
  if (request?.kind !== 'cancel') return false;
  if (parts.length === 7 && parts[5] === 'targets' && parts[6] === 'mode') return true;
  if (parts.length === 7 && parts[5] === 'targets' && parts[6] === 'include') return true;
  if (parts.length === 7 && parts[5] === 'reason' && parts[6] === 'text') return true;
  if (parts.length === 6 && parts[5] === 'cancellationNote') return true;
  if (parts.length === 7 && parts[5] === 'previewObservationRefs' &&
      /^(?:0|[1-9]\d*)$/.test(parts[6] ?? '') && Number(parts[6]) < 100) return true;
  if (parts.length !== 9 || parts[5] !== 'targets' || parts[6] !== 'include' ||
      !/^(?:0|[1-9]\d*)$/.test(parts[7] ?? '')) return false;
  const hint = effectiveSavedTargetRows(draft, request.id)[Number(parts[7])];
  return Boolean(hint && typeof hint === 'object' && !Array.isArray(hint) &&
    typeof (hint as { id?: unknown }).id === 'string' &&
    ['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture', 'suggestedRef'].includes(parts[8]!));
}

function editableAmendTargetSuggestedRef(draft: ReservationWorkflowV2Draft, parts: string[]): boolean {
  if (parts.length !== 9 || parts[0] !== 'proposal' || parts[1] !== 'content' || parts[2] !== 'requests' ||
      parts[4] !== 'body' || parts[5] !== 'targets' || parts[6] !== 'include' || parts[8] !== 'suggestedRef' ||
      !/^(?:0|[1-9]\d*)$/.test(parts[7] ?? '')) return false;
  const request = draft.proposal.content.requests.find((entry) => entry.id === parts[3]);
  if (request?.kind !== 'amend') return false;
  const hint = effectiveSavedTargetRows(draft, request.id)[Number(parts[7])];
  return Boolean(hint && typeof hint === 'object' && !Array.isArray(hint) && typeof (hint as { id?: unknown }).id === 'string');
}

/** Only an empty Cancel scope may receive a new blank staff-owned hint. */
function validCancelIncludeEdit(draft: ReservationWorkflowV2Draft, path: string, override: V2Override): boolean {
  const parts = pathParts(path);
  if (!parts || parts.length !== 7 || parts[2] !== 'requests' || parts[4] !== 'body' ||
      parts[5] !== 'targets' || parts[6] !== 'include') return true;
  const request = draft.proposal.content.requests.find((entry) => entry.id === parts[3]);
  if (request?.kind !== 'cancel') return true;
  if (effectiveSavedTargetRows(draft, request.id).length || override.state !== 'set' ||
      !Array.isArray(override.value) || override.value.length !== 1) return false;
  const hint: unknown = override.value[0];
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return false;
  const row = hint as Record<string, unknown>;
  return Object.keys(row).length === 4 && typeof row.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(row.id) &&
    Array.isArray(row.candidateRefs) && row.candidateRefs.length === 0 && row.suggestedRef === null &&
    Array.isArray(row.sourceRefs) && row.sourceRefs.length === 0;
}

function cancelPreviewPath(draft: ReservationWorkflowV2Draft, path: string) {
  const parts = pathParts(path);
  if (!parts || parts.length !== 7 || parts[2] !== 'requests' || parts[4] !== 'body' ||
      parts[5] !== 'previewObservationRefs' || !/^(?:0|[1-9]\d*)$/.test(parts[6] ?? '')) return null;
  const request = draft.proposal.content.requests.find((entry) => entry.id === parts[3]);
  if (!request || request.kind !== 'cancel') return null;
  const parent = path.slice(0, path.lastIndexOf('/'));
  const override = draft.fieldOverrides[parent];
  const value = override?.state === 'set' ? override.value : request.body.previewObservationRefs;
  return { request, parent, index: Number(parts[6]), refs: Array.isArray(value) ? value : [] };
}

/** Only a host-recorded, ready preview for this exact target may be added for staff review. */
function validCancelPreviewEdit(draft: ReservationWorkflowV2Draft, path: string, override: V2Override): boolean {
  const preview = cancelPreviewPath(draft, path);
  if (!preview) return true;
  if (preview.index !== preview.refs.length || preview.index >= 100 || override.state !== 'set' ||
      typeof override.value !== 'string' || preview.refs.includes(override.value)) return false;
  const hints = effectiveSavedTargetRows(draft, preview.request.id);
  const hint = hints.length === 1 && hints[0] && typeof hints[0] === 'object' && !Array.isArray(hints[0])
    ? hints[0] as { id?: unknown } : null;
  return draft.observations.some((item) => item.ref === override.value && item.kind === 'stay_candidate' &&
    item.status === 'complete' && item.generationId === draft.generationId && item.propertyCode === draft.propertyCode &&
    item.sourceMessageId === draft.source.messageId && item.criteria.workflow === 'cancel' &&
    item.criteria.stage === 'prepare' && item.criteria.requestId === preview.request.id &&
    item.criteria.hintId === hint?.id && item.result.ready === true && typeof item.result.approvalDigest === 'string' &&
    item.criteria.approvalDigest === item.result.approvalDigest);
}

function editablePath(draft: ReservationWorkflowV2Draft, path: string): boolean {
  const parts = pathParts(path);
  if (!parts || parts.length < 5) return false;
  if (editableAmendTargetSuggestedRef(draft, parts)) return true;
  const documentKind = parts[2] === 'documents' && parts.length === 5 && parts[4] === 'kind';
  const request = draft.proposal.content.requests.find((entry) => entry.id === parts[3]);
  const targetPath = `/proposal/content/requests/${encodeURIComponent(parts[3] ?? '')}/body/targets`;
  const targetOverride = draft.fieldOverrides[targetPath];
  const rawTargets = targetOverride?.state === 'set' ? targetOverride.value
    : targetOverride && targetOverride.state !== 'inherit' ? null : request?.kind === 'filing' ? request.body.targets : null;
  const targets = rawTargets && typeof rawTargets === 'object' && !Array.isArray(rawTargets)
    ? rawTargets as { mode?: unknown; include?: unknown } : null;
  const targetSelection = request?.kind === 'filing' && parts.length === 9 && parts[4] === 'body'
    && parts[5] === 'targets' && parts[6] === 'include' && parts[8] === 'suggestedRef'
    && targets?.mode === 'explicit' && Array.isArray(targets.include)
    && targets.include.some((hint: unknown) => Boolean(hint && typeof hint === 'object' && !Array.isArray(hint)
      && (hint as { id?: unknown }).id === parts[7]));
  const [, section, collection, stableId, branch] = parts;
  if (section !== 'content' || !['requests', 'services', 'documents'].includes(collection!)) return false;
  const rows = collection === 'requests' ? draft.proposal.content.requests :
    collection === 'services' ? draft.proposal.content.services : draft.proposal.content.documents;
  const rowIndex = /^(?:0|[1-9]\d*)$/.test(stableId ?? '') ? Number(stableId) : -1;
  if (!rows.some((entry) => entry.id === stableId) && !(Number.isSafeInteger(rowIndex) && rowIndex >= 0 && rowIndex < rows.length)) return false;
  if (collection === 'requests') {
    const request = draft.proposal.content.requests.find((entry) => entry.id === stableId) ??
      draft.proposal.content.requests[rowIndex];
    if (request?.kind === 'cancel') return branch === 'requestText' && parts.length === 5 || editableCancelBodyField(draft, parts);
    if (parts.some((part) => NEVER_EDIT.has(part) && !(part === 'suggestedRef' && targetSelection))) return false;
    return branch === 'body' || (branch === 'requestText' && parts.length === 5);
  }
  if (collection === 'documents') {
    if (parts.some((part) => NEVER_EDIT.has(part) && !(part === 'kind' && documentKind))) return false;
    return true;
  }
  if (parts.some((part) => NEVER_EDIT.has(part))) return false;
  return true;
}

function validateOverride(value: unknown): V2Override | null {
  const parsed = reservationWorkflowV2FieldOverrideSchema.safeParse(value);
  return parsed.success ? { ...parsed.data, updatedAt: new Date().toISOString() } : null;
}

function validStructuredEdit(path: string, override: V2Override): boolean {
  if (/\/requestedMoney\/\d+\/staffAllowanceType$/.test(path))
    return override.state === 'set' && (override.value === 'dinner' || override.value === 'unsupported');
  if (!/\/(?:occupancy|requestedTotals)$/.test(path) || override.state !== 'set') return true;
  const value = override.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>, count = row.childCount, ages = row.childAges;
  if (count === null) return ages === null;
  return Number.isInteger(count) && (count as number) >= 0 && (count as number) <= 12 && Array.isArray(ages) &&
    ages.length === count && ages.every((age) => age === null || Number.isInteger(age) && age >= 0 && age <= 17);
}

function validServiceTargetEdit(draft: ReservationWorkflowV2Draft, path: string, override: V2Override): boolean {
  const parts = pathParts(path);
  if (!parts || parts[2] !== 'services' || parts[4] !== 'targets') return true;
  // Target identities are changed as one validated array, never through individual pointer edits.
  if (parts.length > 6 && /^\d+$/.test(parts[5] ?? '') && parts[6] === 'fields') return true;
  if (parts.length !== 5 || override.state !== 'set' || !Array.isArray(override.value) || override.value.length > 100) return false;
  const service = draft.proposal.content.services.find((row, index) => row.id === parts[3] || String(index) === parts[3]);
  if (!service) return false;
  const relevant = new Set([service.ownerRequestId, ...draft.proposal.content.requests.filter((row) => row.serviceRefs.includes(service.id)).map((row) => row.id)]);
  if (draft.operationResults.some((row) => (row.status === 'succeeded' || row.status === 'unknown') && relevant.has(row.requestId))) return false;
  const targets = override.value;
  if (new Set(targets.map((row) => JSON.stringify((row as { target?: unknown })?.target))).size !== targets.length) return false;
  for (const item of targets) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const target = (item as { target?: unknown }).target;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
    const ref = target as Record<string, unknown>;
    const request = draft.proposal.content.requests.find((row) => row.id === ref.requestId && row.serviceRefs.includes(service.id));
    if (!request || draft.operationResults.some((row) => row.requestId === request.id && (row.status === 'succeeded' || row.status === 'unknown'))) return false;
    if (ref.kind === 'allocation' && request.kind === 'create' && request.body.allocations.some((row) => row.id === ref.allocationId)) continue;
    if (ref.kind === 'quote_group' && request.kind === 'quote' && request.body.groups.some((row) => row.id === ref.groupId)) continue;
    if (ref.kind === 'saved_target' && 'targets' in request.body) {
      const root = `/proposal/content/requests/${encodeURIComponent(request.id)}/body/targets`;
      const base = request.body.targets, parent = draft.fieldOverrides[root];
      const resolved = parent?.state === 'set' ? parent.value : base;
      const include = draft.fieldOverrides[`${root}/include`];
      const rows = include?.state === 'set' ? include.value : resolved && typeof resolved === 'object' ? (resolved as { include?: unknown }).include : null;
      if (Array.isArray(rows) && rows.some((row) => row && typeof row === 'object' && (row as { id?: unknown }).id === ref.hintId)) continue;
    }
    return false;
  }
  // Validate the array against the proposal's actual service shape before accepting it.
  const proposal = structuredClone(draft.proposal), row = proposal.content.services.find((entry) => entry.id === service.id)!;
  row.targets = targets as typeof row.targets;
  return reservationWorkflowV2DraftSchema.shape.proposal.safeParse(proposal).success;
}

/** An unrelated Add-On receipt must not freeze every saved stay in the request. */
export function reservationWorkflowV2SavedTargetLocked(draft: ReservationWorkflowV2Draft, requestId: string, hintId: string): boolean {
  return draft.operationResults.some((result) => {
    if (result.requestId !== requestId || (result.status !== 'succeeded' && result.status !== 'unknown')) return false;
    if (result.workflow !== 'services') return true;
    const refs = new Set(result.observationRefs);
    const bound = draft.observations.find((row) => refs.has(row.ref) && row.criteria.workflow === 'services' &&
      row.criteria.requestId === requestId && row.criteria.targetRef && typeof row.criteria.targetRef === 'object');
    const target = bound?.criteria.targetRef as { kind?: unknown; requestId?: unknown; hintId?: unknown } | undefined;
    return !target || target.kind !== 'saved_target' || target.requestId !== requestId || typeof target.hintId !== 'string' || target.hintId === hintId;
  });
}

function safeSavedTargetEdit(draft: ReservationWorkflowV2Draft, path: string): boolean {
  const parts = pathParts(path);
  if (!parts || parts[2] !== 'requests' || parts[4] !== 'body' || parts[5] !== 'targets') return true;
  const request = draft.proposal.content.requests.find((row, index) => row.id === parts[3] || String(index) === parts[3]);
  if (!request) return false;
  const rows = effectiveSavedTargetRows(draft, request.id);
  const key = parts[6] === 'include' && parts.length >= 9 ? parts[7] : undefined;
  const hint = key === undefined ? undefined : /^\d+$/.test(key) ? rows[Number(key)] : rows.find((row) =>
    row && typeof row === 'object' && (row as { id?: unknown }).id === key);
  const hintId = hint && typeof hint === 'object' ? (hint as { id?: unknown }).id : undefined;
  if (typeof hintId === 'string') return !reservationWorkflowV2SavedTargetLocked(draft, request.id, hintId);
  return !draft.operationResults.some((row) => row.requestId === request.id && (row.status === 'succeeded' || row.status === 'unknown'));
}

function applyServiceTargetEdit(draft: ReservationWorkflowV2Draft, path: string, override: V2Override): ReservationWorkflowV2Draft | null {
  const parts = pathParts(path);
  if (!parts || parts[2] !== 'services' || parts[4] !== 'targets' || parts.length !== 5) return null;
  const index = draft.proposal.content.services.findIndex((row, i) => row.id === parts[3] || String(i) === parts[3]);
  if (index < 0 || !Array.isArray(override.value)) return null;
  const before = structuredClone(draft.proposal), currentArray = draft.fieldOverrides[path];
  if (currentArray?.state === 'set' && Array.isArray(currentArray.value)) before.content.services[index]!.targets = currentArray.value as typeof before.content.services[number]['targets'];
  const after = structuredClone(before);
  after.content.services[index]!.targets = structuredClone(override.value) as typeof after.content.services[number]['targets'];
  const remap = <T>(values: Record<string, T>) => {
    const result: Record<string, T> = {};
    for (const [key, value] of Object.entries(values)) {
      if (key === path) continue;
      const nextPath = rebaseReservationV2Path(key, before, after);
      if (nextPath) result[nextPath] = value;
    }
    return result;
  };
  const remapRows = <T extends { path: string }>(rows: T[]) => rows.flatMap((row) => {
    const nextPath = rebaseReservationV2Path(row.path, before, after);
    return nextPath ? [{ ...row, path: nextPath }] : [];
  });
  const next: ReservationWorkflowV2Draft = { ...draft, proposal: { ...after, annotations: remapRows(after.annotations),
    issues: remapRows(after.issues), sourceClaims: remapRows(after.sourceClaims) }, fieldOverrides: remap(draft.fieldOverrides),
    staffReviews: remap(draft.staffReviews), fieldReviewRequirements: remap(draft.fieldReviewRequirements),
    observations: rebaseReservationV2Observations(draft, before, after) };
  return nativeStructureIsSafe({ reservationWorkflowV2: draft }, { reservationWorkflowV2: next }) ? next : null;
}

function updateDraft(current: ReservationWorkflowV2Draft, input: {
  fieldPath: string; override?: V2Override; review?: ReservationWorkflowV2Draft['staffReviews'][string];
}): ReservationWorkflowV2Draft {
  const fieldOverrides = { ...current.fieldOverrides };
  const staffReviews = { ...current.staffReviews };
  if (input.override) {
    const preview = cancelPreviewPath(current, input.fieldPath);
    if (preview && input.override.state === 'set') {
      fieldOverrides[preview.parent] = { state: 'set', value: [...preview.refs, input.override.value],
        updatedAt: input.override.updatedAt };
    }
    fieldOverrides[input.fieldPath] = input.override;
    // Retyping a native identity or saved-stay query removes the old selection atomically.
    const guest = input.fieldPath.match(/^(.*\/guest)\/(?:firstName|lastName|email)$/);
    const party = input.fieldPath.match(/^(.*\/(?:bookingAgency|organization|arAccount|agency|company))(?:\/name)?$/);
    const target = input.fieldPath.match(/^(.*\/targets\/include\/\d+)\/(?:confirmation|guestName|bookedArrival|bookedDeparture)$/);
    const service = input.fieldPath.match(/^(\/proposal\/content\/services\/[^/]+)\/code$/);
    const selection = guest ? `${guest[1]}/nativeSelectionRef` : party ? `${party[1]}/nativeSelectionRef` :
      target ? `${target[1]}/suggestedRef` : service ? `${service[1]}/itemCandidateRef` : null;
    if (selection) fieldOverrides[selection] = { state: 'unknown', updatedAt: input.override.updatedAt };
    // A review belongs to the displayed value and scope; replacing a parent also replaces its child values.
    for (const path of Object.keys(staffReviews)) {
      if (path === input.fieldPath || path.startsWith(`${input.fieldPath}/`) || input.fieldPath.startsWith(`${path}/`)) {
        delete staffReviews[path];
      }
    }
  }
  if (input.review) staffReviews[input.fieldPath] = input.review;
  const proposal = input.override && input.fieldPath.endsWith('/guest/email') ? { ...current.proposal,
    issues: current.proposal.issues.filter((issue) => !(issue.kind === 'guest_email_conflict' && issue.path === input.fieldPath)) } : current.proposal;
  return reservationWorkflowV2DraftSchema.parse({ ...current, revision: current.revision + 1, proposal, fieldOverrides, staffReviews });
}

async function mutateDraft(ctx: Context, input: MutationInput & { fieldPath: string; override?: V2Override;
  review?: ReservationWorkflowV2Draft['staffReviews'][string]; eventType: 'field.edit' | 'field.accept' | 'field.reject';
  value: unknown }): Promise<ReservationWorkflowV2StateResult> {
  return withLockedV2DraftMutation(ctx, input, { fieldPath: input.fieldPath, eventType: input.eventType,
    value: input.value, apply: (draft) => {
      if (!editablePath(draft, input.fieldPath)) return null;
      if (input.override && (!validStructuredEdit(input.fieldPath, input.override) ||
          !validServiceTargetEdit(draft, input.fieldPath, input.override) || !safeSavedTargetEdit(draft, input.fieldPath) ||
          !validCancelIncludeEdit(draft, input.fieldPath, input.override) || !validCancelPreviewEdit(draft, input.fieldPath, input.override))) return null;
      if (input.override && /^\/proposal\/content\/services\/[^/]+\/targets$/.test(input.fieldPath)) {
        const next = applyServiceTargetEdit(draft, input.fieldPath, input.override);
        return next ? { draft: next } : null;
      }
      return { draft: updateDraft(draft, input) };
    } });
}

export async function editReservationWorkflowV2Draft(ctx: Context, input: MutationInput & {
  fieldPath: string; value: unknown;
}): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  const current = await getReservationWorkflowV2Draft(ctx, input);
  if (current.status !== 'ok') return current;
  if (!editablePath(current.draft, input.fieldPath)) return { status: 'invalid_path' };
  const override = validateOverride(input.value);
  if (!override || !validCancelIncludeEdit(current.draft, input.fieldPath, override) ||
      !validCancelPreviewEdit(current.draft, input.fieldPath, override)) return { status: 'invalid_value' };
  return mutateDraft(ctx, { ...input, override, eventType: 'field.edit', value: override });
}

/** Bind one staff-selected source attachment and an exact confirmation without a native write. */
export async function configureReservationWorkflowV2Filing(ctx: Context, input: MutationInput & {
  requestId: string; attachmentId: string; confirmation: string; kind: 'voucher' | 'payment_proof';
}): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  if (!ctx.userId || !/^\d+-\d+$/.test(input.confirmation) || !input.attachmentId) return { status: 'invalid_value' };
  return ctx.db.transaction(async (tx) => {
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    if (item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq) return { status: 'stale_revision' as const };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok') return current;
    const draft = current.draft;
    const request = draft.proposal.content.requests.find((entry) => entry.id === input.requestId && entry.kind === 'filing');
    if (!request || request.kind !== 'filing') return { status: 'not_found' as const };
    if (draft.operationResults.some((entry) => entry.requestId === request.id &&
        (entry.status === 'succeeded' || entry.status === 'unknown'))) return { status: 'invalid_value' as const };
    const [file] = await tx.select({ id: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes, isInline: attachment.isInline }).from(attachment).where(and(
      eq(attachment.id, input.attachmentId), eq(attachment.messageId, input.source.messageId))).limit(1);
    if (!file || file.isInline || file.sizeBytes > 10 * 1024 * 1024 ||
        (!/\.pdf$/i.test(file.filename) && file.mimeType.toLowerCase() !== 'application/pdf')) return { status: 'invalid_value' as const };
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const targetId = `staff_target_${hash(`${request.id}\u001f${input.confirmation}`).slice(0, 20)}`;
    const documentId = `staff_document_${hash(`${request.id}\u001f${file.id}\u001f${input.confirmation}`).slice(0, 20)}`;
    const documentSourceRef = `src_${hash(`${input.source.messageId}\u001fattachment_text\u001f${file.id}`).slice(0, 12)}`;
    const document = { id: documentId, ownerRequestId: request.id, documentSourceRef, kind: input.kind,
      handling: 'filing_requested' as const,
      targetRefs: [{ kind: 'saved_target' as const, requestId: request.id, hintId: targetId }],
      requestedName: null, requestedDescription: null, uploadArtifactRef: null, sourceRefs: [] };
    const existing = draft.proposal.content.documents.find((row) => row.id === documentId);
    if (existing && (existing.ownerRequestId !== request.id || existing.documentSourceRef !== documentSourceRef ||
        !existing.targetRefs.some((ref) => ref.kind === 'saved_target' && ref.requestId === request.id && ref.hintId === targetId))) {
      return { status: 'invalid_value' as const };
    }
    if (!existing && draft.proposal.content.documents.length >= 200) return { status: 'invalid_value' as const };
    const root = `/proposal/content/requests/${encodeURIComponent(request.id)}`;
    const docsPath = `${root}/documentRefs`, targetsPath = `${root}/body/targets`;
    const docRoot = `/proposal/content/documents/${encodeURIComponent(documentId)}`;
    const now = new Date().toISOString();
    const overrides = { ...draft.fieldOverrides }, reviews = { ...draft.staffReviews };
    // Configuration replaces the whole target selection; no old candidate or review may authorize it.
    for (const path of Object.keys(overrides)) if (path === targetsPath || path.startsWith(`${targetsPath}/`)) delete overrides[path];
    for (const path of Object.keys(reviews)) if (path === targetsPath || path.startsWith(`${targetsPath}/`)) delete reviews[path];
    overrides[docsPath] = { state: 'set', value: [documentId], updatedAt: now };
    overrides[targetsPath] = { state: 'set', value: { mode: 'explicit', include: [{ id: targetId,
      confirmation: input.confirmation, candidateRefs: [], suggestedRef: null, sourceRefs: [] }], exclude: [], sourceRefs: [] }, updatedAt: now };
    for (const [field, value] of [['documentSourceRef', documentSourceRef], ['kind', input.kind],
      ['handling', 'filing_requested']] as const) {
      const path = `${docRoot}/${field}`;
      overrides[path] = { state: 'set', value, updatedAt: now };
      reviews[path] = { status: 'accepted', note: 'Selected by staff', at: now };
    }
    const next = reservationWorkflowV2DraftSchema.parse({ ...draft, revision: item.revision + 1,
      proposal: { ...draft.proposal, content: { ...draft.proposal.content,
        documents: existing ? draft.proposal.content.documents : [...draft.proposal.content.documents, document] } },
      fieldOverrides: overrides, staffReviews: reviews });
    const nextState = { ...item.state, [RESERVATION_WORKFLOW_V2_STATE_KEY]: next };
    const advanced = advancePaneRevision({ revision: item.revision, revisionHead: item.revisionHead,
      seq: item.revisionSeq, previousState: item.state, nextState, extractionId: item.extractionId });
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'user', actorUserId: ctx.userId,
      type: 'field.edit', fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:${root}/filingSelection`,
      value: { requestId: request.id, attachmentId: file.id, confirmation: input.confirmation, kind: input.kind },
      evidence: advanced.evidence });
    await tx.update(workItem).set({ state: nextState, revision: advanced.revision, revisionHead: advanced.revisionHead,
      revisionSeq: item.revisionSeq + 1, updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { status: 'ok' as const, draft: next, revision: advanced.revision,
      revisionHead: advanced.revisionHead, seq: item.revisionSeq + 1 };
  });
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
