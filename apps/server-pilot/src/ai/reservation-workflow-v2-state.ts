import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import type { AiRunFence } from './run-ledger.js';
import { consumeStaffGoAtDispatch } from './hms-approval.js';
import { MAIL_KINDS, workEvent, workItem } from '../db/schema/work.js';
import { aiWorkflowRun, attachment, mailboxAccess, mailThread, message } from '../db/schema/mail.js';
import { propertySwitchSchema, resolvePropertyScope } from '../hms/property-registry.js';
import { MESSAGE_ARRIVED_AT } from './message-arrival-time.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { reservationArrivalEvidence } from './reservation-workflow-v2-evidence.js';
import { lockCanonicalMailbox } from '../mail/ingest/canonical-identity.js';
import { lockCreateActorAccess, lockCreateActorSession } from './pane-create-actor-lock.js';
import { assertNoCreateDispatchFence } from './pane-create-dispatch-fence.js';
import { assertNoUnresolvedHmsDispatchForWorkItem } from './hms-labtest-dispatch.js';
import { hydrateStoredReservationWorkflowV2 } from './reservation-workflow-v2-stored-draft.js';
import { reservationWorkflowV2EditTrace } from './reservation-workflow-v2-edit-trace.js';
import { recoverReservationWorkflowV2SourceFields } from './reservation-workflow-v2-source-recovery.js';
import { advancePaneRevision, redoWorkItemRevision, undoWorkItemRevision,
  rebaseReservationV2Path, rebaseReservationV2Observations, nativeStructureIsSafe,
  RESERVATION_V2_PROPERTY_HISTORY_FLOOR_KEY } from './work-item-revision.js';
import {
  separatedQuoteMoneyLinked,
  RESERVATION_PREFILL_SCHEMA_VERSION,
  RESERVATION_WORKFLOW_V2_VERSION,
  reservationWorkflowV2DraftSchema,
  reservationWorkflowV2ExtractionSchema,
  reservationWorkflowV2FieldOverrideSchema,
  reservationWorkflowV2ObservationSchema,
  reservationWorkflowV2IntakeSchema,
  type ReservationWorkflowV2Disposition,
  type ReservationWorkflowV2Draft,
  type ReservationWorkflowV2Extraction,
  type ReservationWorkflowV2Observation,
  type ReservationWorkflowV2Proposal,
  type ReservationWorkflowV2Source,
} from './reservation-workflow-v2-contract.js';

export const RESERVATION_WORKFLOW_V2_STATE_KEY = 'reservationWorkflowV2';
/** Intake adjudication lives outside the strict draft so older builds still parse stored drafts. */
export const RESERVATION_WORKFLOW_V2_INTAKE_KEY = 'reservationWorkflowV2Intake';
type State = Record<string, unknown>;
const PROPERTY_SWITCH_PREPARATION_KEYS = [
  'hmsSnapshot', 'cloudCancelPreview', 'cloudCancel', 'cloudAmend', 'filingStateDigest',
  'nativePrices', 'nativePrice', 'approvedPrices', 'previewDigest', 'cloudCreatePreviews', 'stayPreviews',
  'preparedRef', 'prepareRef', 'preparation', 'approval', 'approvalId', 'policyIdentity', 'catalogueIdentity',
] as const;

function withoutPropertyPreparation(state: State): State {
  const next = { ...state };
  for (const key of [...PROPERTY_SWITCH_PREPARATION_KEYS, ...PROPERTY_NATIVE_ARRAY_FIELDS, ...PROPERTY_NATIVE_VALUE_FIELDS]) delete next[key];
  return next;
}

const PROPERTY_NATIVE_ARRAY_FIELDS = new Set(['candidateRefs', 'priceObservationRefs', 'previewObservationRefs',
  'currentObservationRefs', 'observationRefs', 'lookupResultRefs', 'roomCodes']);
const PROPERTY_NATIVE_VALUE_FIELDS = new Set(['nativeSelectionRef', 'suggestedRef', 'itemCandidateRef',
  'previewObservationRef', 'savedRowCandidateRef', 'roomType', 'roomTypeForCharge', 'ratePlan', 'guaranteeType',
  'sourceOfBusiness', 'track', 'code', 'titleCode', 'phoneTypeCode', 'emailTypeCode', 'frequency', 'pricingControl', 'folio']);
const PROPERTY_NATIVE_CHANGE_FIELDS = new Set(['roomType', 'roomTypeForCharge', 'ratePlan', 'guaranteeType', 'track']);

/** Keep source and staff facts while requiring fresh property-specific choices and evidence. */
function withoutPropertyNativeSelections(value: unknown, observations: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => withoutPropertyNativeSelections(entry, observations));
  if (!value || typeof value !== 'object') return value;
  const row = Object.fromEntries(Object.entries(value));
  return Object.fromEntries(Object.entries(row).map(([key, child]) => {
    if (PROPERTY_NATIVE_ARRAY_FIELDS.has(key)) return [key, []];
    if (PROPERTY_NATIVE_VALUE_FIELDS.has(key)) return [key, null];
    if (key === 'value' && row.op === 'set' && typeof row.field === 'string' && PROPERTY_NATIVE_CHANGE_FIELDS.has(row.field)) return [key, ''];
    if (key === 'evidenceRefs' && Array.isArray(child)) return [key, child.filter((ref) => typeof ref !== 'string' || !observations.has(ref))];
    if (key === 'annotations' && Array.isArray(child)) return [key, withoutPropertyNativeSelections(child.filter((entry) =>
      !entry || typeof entry !== 'object' || !('basis' in entry) || !['native_read', 'policy'].includes(String(entry.basis))), observations)];
    return [key, withoutPropertyNativeSelections(child, observations)];
  }));
}

function invalidatePropertyDraft(prior: ReservationWorkflowV2Draft, input: {
  generationId: string; revision: number; at: string; propertyCode?: string; source?: ReservationWorkflowV2Source;
}): ReservationWorkflowV2Draft {
  const observations = new Set(prior.observations.map((row) => row.ref));
  const fieldOverrides = Object.fromEntries(Object.entries(prior.fieldOverrides).map(([path, override]) => {
    const parts = pathParts(path);
    const change = path.match(/^(.*\/(?:sharedChanges|changes)\/[^/]+)\/value(?:\/|$)/);
    const field = change ? effectiveDraftPath(prior, `${change[1]}/field`) : null;
    const native = parts?.slice(4).some((part) => PROPERTY_NATIVE_ARRAY_FIELDS.has(part) || PROPERTY_NATIVE_VALUE_FIELDS.has(part)) ||
      typeof field === 'string' && PROPERTY_NATIVE_CHANGE_FIELDS.has(field);
    return [path, native ? { state: 'unknown', updatedAt: input.at } :
      { ...override, ...(Object.hasOwn(override, 'value') ? { value: withoutPropertyNativeSelections(override.value, observations) } : {}) }];
  }));
  return reservationWorkflowV2DraftSchema.parse({ ...prior, ...(input.propertyCode ? { propertyCode: input.propertyCode } : {}),
    ...(input.source ? { source: input.source } : {}), generationId: input.generationId, revision: input.revision,
    status: 'partial', proposal: withoutPropertyNativeSelections(prior.proposal, observations), observations: [],
    disposition: undefined, fieldReviewRequirements: {}, staffReviews: {}, fieldOverrides,
    operationResults: prior.operationResults.filter((result) => result.status !== 'prepared'),
    prefill: { status: 'superseded', attemptId: null, attemptCount: 0, startedAt: null, finishedAt: input.at,
      ...(prior.prefill?.evidenceHash ? { evidenceHash: prior.prefill.evidenceHash } : {}) },
  });
}
/** Only the internal arrival worker creates this buffer; nothing reaches the draft until its lease fence commits. */
export type ReservationNativeCheckBatch = {
  jobFence: ReservationPrefillJobFence; expectedRevision: number; expectedSeq: number; generationId: string;
  signal: AbortSignal; deadlineAt: number; observations: ReservationWorkflowV2Observation[];
  results: ReservationWorkflowV2Draft['operationResults'];
};
/** Internal, authenticated reconciliation of one operation against its original source. */
export type ReservationRecoveryScope = {
  workItemId: string; operationId: string; generationId: string; currentSource: ReservationWorkflowV2Source;
};
export type ReservationWorkflowV2Context = { db: DB; transportId: string; userId?: string | null; propertyCode: string;
  nativeBatch?: ReservationNativeCheckBatch; recovery?: ReservationRecoveryScope;
  writeRunFence?: AiRunFence; signal?: AbortSignal };
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
  extraction?: ReservationWorkflowV2Extraction;
  disposition?: ReservationWorkflowV2Disposition;
  proposal: ReservationWorkflowV2Proposal;
  observations: ReservationWorkflowV2Observation[];
  fieldReviewRequirements?: ReservationWorkflowV2Draft['fieldReviewRequirements'];
  errors?: ReservationWorkflowV2Draft['errors'];
  prefill?: ReservationWorkflowV2Draft['prefill'];
};
export type ReservationWorkflowV2SourceInput = ReservationWorkflowV2Source;
export type ReservationWorkflowV2StateResult =
  | { status: 'ok'; draft: ReservationWorkflowV2Draft; revision: number; revisionHead: number; seq: number; sourceChanged?: boolean }
  | { status: 'not_found' | 'invalid_source' | 'wrong_property' | 'invalid_state' | 'stale_revision' | 'invalid_path' | 'invalid_value'; issue?: string };

/** A persisted draft never stores the intake claim: the sibling record is the only trusted copy. */
function storedReservationWorkflowV2Draft(draft: ReservationWorkflowV2Draft): ReservationWorkflowV2Draft {
  return { ...draft, disposition: undefined,
    ...(draft.extraction ? { extraction: { ...draft.extraction, disposition: undefined } } : {}) };
}

/** The intake decision applies only while it still binds to this exact draft. */
function intakeRecordFor(draft: ReservationWorkflowV2Draft): Record<string, unknown> | undefined {
  const disposition = draft.disposition;
  if (!disposition || disposition.generationId !== draft.generationId ||
      disposition.sourceHash !== draft.source.sourceHash) return undefined;
  // A no-action decision is void the moment current asks or native work appear.
  if (disposition.decision === 'no_action' &&
      (draft.proposal.content.requests.length > 0 || draft.operationResults.length > 0)) return undefined;
  return reservationWorkflowV2IntakeSchema.parse({ contractVersion: RESERVATION_WORKFLOW_V2_VERSION,
    ...(draft.prefill?.evidenceHash ? { evidenceHash: draft.prefill.evidenceHash } : {}), disposition });
}

/**
 * Every draft write goes through this so the strict stored draft stays rollback-compatible:
 * the intake decision is stripped from the draft and re-persisted under its own state key,
 * and it survives only while generation, source hash and evidence hash still bind.
 */
export function withReservationWorkflowV2Draft(state: State, draft: ReservationWorkflowV2Draft): State {
  return { ...state,
    [RESERVATION_WORKFLOW_V2_STATE_KEY]: storedReservationWorkflowV2Draft(draft),
    [RESERVATION_WORKFLOW_V2_INTAKE_KEY]: intakeRecordFor(draft) };
}

export function reservationWorkflowV2DraftOf(state: State): ReservationWorkflowV2Draft | null {
  const parsed = reservationWorkflowV2DraftSchema.safeParse(hydrateStoredReservationWorkflowV2(state[RESERVATION_WORKFLOW_V2_STATE_KEY]));
  if (!parsed.success) return null;
  // Stored disposition keys are never honoured; only a bound sibling record attaches.
  const draft: ReservationWorkflowV2Draft = { ...parsed.data, disposition: undefined,
    ...(parsed.data.extraction ? { extraction: { ...parsed.data.extraction, disposition: undefined } } : {}) };
  const intake = reservationWorkflowV2IntakeSchema.safeParse(state[RESERVATION_WORKFLOW_V2_INTAKE_KEY]);
  if (intake.success) {
    const { disposition } = intake.data;
    const bound = disposition.generationId === draft.generationId && disposition.sourceHash === draft.source.sourceHash &&
      (intake.data.evidenceHash === undefined || intake.data.evidenceHash === draft.prefill?.evidenceHash);
    const consistent = disposition.decision !== 'no_action' ||
      (draft.proposal.content.requests.length === 0 && draft.operationResults.length === 0);
    if (bound && consistent) draft.disposition = disposition;
  }
  return draft;
}

export function hasReservationWorkflowV2Draft(state: State): boolean {
  return Object.hasOwn(state, RESERVATION_WORKFLOW_V2_STATE_KEY);
}

/** Revalidate canonical mailbox eligibility/cutoff before the model or native readers run. */
export async function validateReservationWorkflowV2Source(ctx: Context, source: ReservationWorkflowV2SourceInput): Promise<
  { status: 'ok' } | { status: 'invalid_source' | 'wrong_property' | 'not_found' }
> {
  if (!propertyMatches(ctx) || (source.propertyId ?? 'HRCEN') !== ctx.propertyCode) return { status: 'wrong_property' };
  if (!(await hasMailboxAccess(ctx.db, ctx))) return { status: 'not_found' };
  return await sourceMail(ctx.db, ctx, source) ? { status: 'ok' } : { status: 'invalid_source' };
}

function propertyMatches(ctx: Context): boolean {
  const parsedSwitch = propertySwitchSchema.safeParse(ctx.propertyCode);
  try {
    return resolvePropertyScope({ transportId: ctx.transportId, propertySwitch: parsedSwitch.success ? parsedSwitch.data : undefined }).propertyCode === ctx.propertyCode;
  } catch { return false; }
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

async function buildResult(db: WorkTx, ctx: Context, item: ItemRow, source: ReservationWorkflowV2Source,
  allowSourceChanged = false): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx) || (source.propertyId ?? 'HRCEN') !== ctx.propertyCode || !item.threadId || item.threadId !== source.threadId || item.sourceMessageId !== source.messageId) {
    return { status: 'invalid_source' };
  }
  if (!(await hasMailboxAccess(db, ctx))) return { status: 'not_found' };
  const draft = reservationWorkflowV2DraftOf(item.state);
  if (!draft) return { status: hasReservationWorkflowV2Draft(item.state) ? 'invalid_state' : 'not_found' };
  if (draft.workItemId !== item.id || draft.transportId !== ctx.transportId || draft.propertyCode !== ctx.propertyCode ||
      (draft.source.propertyId ?? 'HRCEN') !== ctx.propertyCode ||
      draft.source.messageId !== source.messageId ||
      draft.source.threadId !== source.threadId || draft.source.arrivedAt !== source.arrivedAt) return { status: 'invalid_source' };
  const recovery = ctx.recovery;
  if (recovery && (!ctx.userId || ctx.nativeBatch || recovery.workItemId !== item.id ||
      recovery.generationId !== draft.generationId || draft.source.sourceHash !== source.sourceHash ||
      recovery.currentSource.messageId !== source.messageId || recovery.currentSource.threadId !== source.threadId ||
      recovery.currentSource.arrivedAt !== source.arrivedAt || !draft.operationResults.some((operation) =>
        operation.id === recovery.operationId && operation.generationId === recovery.generationId &&
        ['unknown', 'succeeded', 'failed'].includes(operation.status)))) return { status: 'invalid_source' };
  const checkedSource = recovery?.currentSource ?? source;
  if (!(await sourceMail(db, ctx, checkedSource))) return { status: 'invalid_source' };
  // Drafts without a recorded attachment baseline need an explicit review too:
  // there is no safe way to tell whether their current attachments were repaired.
  const sourceChanged = draft.source.sourceHash !== checkedSource.sourceHash ||
    draft.prefill?.evidenceHash !== (await reservationArrivalEvidence(db, source.messageId)).hash;
  if (sourceChanged && !allowSourceChanged && !recovery) return { status: 'invalid_source' };
  return { status: 'ok', draft: { ...draft, revision: item.revision }, revision: item.revision,
    revisionHead: item.revisionHead, seq: item.revisionSeq, ...(sourceChanged ? { sourceChanged: true } : {}) };
}

export async function getReservationWorkflowV2Draft(ctx: Context, input: {
  workItemId: string; source: ReservationWorkflowV2SourceInput;
}, options?: { allowSourceChanged?: boolean; recoverSourceFields?: boolean }): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  const item = await loadItem(ctx.db, ctx, input.workItemId);
  if (!item) return { status: 'not_found' };
  const current = await buildResult(ctx.db, ctx, item, input.source, options?.allowSourceChanged);
  if (!options?.recoverSourceFields || ctx.nativeBatch || ctx.recovery || current.status !== 'ok' || current.sourceChanged ||
      item.revision < item.revisionHead || !recoverReservationWorkflowV2SourceFields(current.draft)) return current;
  return ctx.db.transaction(async tx => {
    await lockCanonicalMailbox(tx as unknown as DB, ctx.transportId);
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    const locked = await loadItem(tx, ctx, input.workItemId, true);
    if (!locked) return { status: 'not_found' as const };
    const latest = await buildResult(tx, ctx, locked, input.source, options?.allowSourceChanged);
    return recoverSourceFields(tx, locked, latest);
  });
}

async function recoverSourceFields(tx: WorkTx, item: ItemRow,
  current: ReservationWorkflowV2StateResult): Promise<ReservationWorkflowV2StateResult> {
  if (current.status !== 'ok' || current.sourceChanged || item.revision < item.revisionHead) return current;
  const recovered = recoverReservationWorkflowV2SourceFields(current.draft);
  if (!recovered) return current;
  const draft = { ...recovered.draft, revision: item.revision + 1 };
  const state = withReservationWorkflowV2Draft(item.state, draft);
  const advanced = advancePaneRevision({ revision: item.revision, revisionHead: item.revisionHead,
    seq: item.revisionSeq, previousState: item.state, nextState: state, extractionId: item.extractionId });
  await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'ai', type: 'field.edit',
    fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:source_fields`, value: { paths: recovered.paths },
    aiSource: RESERVATION_PREFILL_SCHEMA_VERSION, evidence: advanced.evidence });
  await tx.update(workItem).set({ state, revision: advanced.revision, revisionHead: advanced.revisionHead,
    revisionSeq: item.revisionSeq + 1, updatedAt: new Date() }).where(eq(workItem.id, item.id));
  return { status: 'ok', draft, revision: advanced.revision, revisionHead: advanced.revisionHead, seq: item.revisionSeq + 1 };
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
  return getReservationWorkflowV2Draft(ctx, { workItemId: item.id, source: input.source }, { recoverSourceFields: true });
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
  source: ReservationWorkflowV2SourceInput; extractionId?: string | null; seed: ReservationWorkflowV2Seed; allowSourceChanged?: boolean;
  allowPropertySwitch?: boolean;
}): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx) || (input.source.propertyId ?? 'HRCEN') !== ctx.propertyCode) return { status: 'wrong_property' };
  const saved = await ctx.db.transaction(async (tx) => {
    // Attachment repair takes this same lock. Capture a coherent source and
    // attachment baseline before any staff edit can supersede prefill.
    await lockCanonicalMailbox(tx as unknown as DB, ctx.transportId);
    // Serialize v2 seeding for the email, even if competing runs infer different
    // legacy WorkItem kinds. Background reads may still add other-kind rows.
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    const [mail] = await sourceMail(tx, ctx, input.source).then((row) => row ? [row] : []);
    if (!mail || !(await hasMailboxAccess(tx, ctx))) return { status: 'invalid_source' as const };
    const sourceItems = await tx.select({ id: workItem.id, transportId: workItem.transportId, threadId: workItem.threadId,
      sourceMessageId: workItem.sourceMessageId, kind: workItem.kind, extractionId: workItem.extractionId,
      state: workItem.state, revision: workItem.revision, revisionHead: workItem.revisionHead,
      revisionSeq: workItem.revisionSeq, updatedAt: workItem.updatedAt }).from(workItem)
      .where(and(eq(workItem.transportId, ctx.transportId), eq(workItem.threadId, input.source.threadId),
        eq(workItem.sourceMessageId, input.source.messageId)))
      .orderBy(workItem.id).for('update');
    const orderedItems = [...sourceItems].sort((a, b) =>
      Number(hasReservationWorkflowV2Draft(b.state as State)) - Number(hasReservationWorkflowV2Draft(a.state as State)) ||
      b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id));
    let item = orderedItems[0];
    if (!item) {
      const kind = initialKind(input.seed);
      const [inserted] = await tx.insert(workItem).values({ transportId: ctx.transportId, threadId: input.source.threadId,
        sourceMessageId: input.source.messageId, kind, extractionId: input.extractionId ?? null })
        .onConflictDoNothing().returning({ id: workItem.id, transportId: workItem.transportId, threadId: workItem.threadId,
          sourceMessageId: workItem.sourceMessageId, kind: workItem.kind, extractionId: workItem.extractionId,
          state: workItem.state, revision: workItem.revision, revisionHead: workItem.revisionHead,
          revisionSeq: workItem.revisionSeq, updatedAt: workItem.updatedAt });
      item = inserted;
      if (!item) {
        const [raced] = await tx.select({ id: workItem.id, transportId: workItem.transportId, threadId: workItem.threadId,
          sourceMessageId: workItem.sourceMessageId, kind: workItem.kind, extractionId: workItem.extractionId,
          state: workItem.state, revision: workItem.revision, revisionHead: workItem.revisionHead,
          revisionSeq: workItem.revisionSeq, updatedAt: workItem.updatedAt }).from(workItem)
          .where(and(eq(workItem.transportId, ctx.transportId), eq(workItem.threadId, input.source.threadId),
            eq(workItem.sourceMessageId, input.source.messageId)))
          .orderBy(desc(workItem.updatedAt), desc(workItem.id)).limit(1).for('update');
        item = raced;
      }
    }
    if (!item) return { status: 'not_found' as const };
    const itemRow = { ...item, state: item.state as State };
    const seedDraft = (evidenceHash: string, seedRevision = itemRow.revision,
      seedGenerationId = input.seed.generationId ?? randomUUID()) => {
      return reservationWorkflowV2DraftSchema.parse({
        contractVersion: RESERVATION_WORKFLOW_V2_VERSION,
        schemaVersion: RESERVATION_PREFILL_SCHEMA_VERSION,
        workItemId: itemRow.id,
        transportId: ctx.transportId,
        propertyCode: ctx.propertyCode,
        source: input.source,
        generationId: seedGenerationId,
        revision: seedRevision,
        status: input.seed.status,
        ...(input.seed.extraction ? { extraction: input.seed.extraction, extractionGenerationId: seedGenerationId } : {}),
        proposal: input.seed.proposal,
        observations: input.seed.observations,
        fieldReviewRequirements: input.seed.fieldReviewRequirements ?? {},
        staffReviews: {},
        operationResults: [],
        fieldOverrides: {},
        errors: input.seed.errors ?? [],
        prefill: { ...(input.seed.prefill ?? { status: 'complete', attemptId: null, attemptCount: 0,
          startedAt: null, finishedAt: null }), evidenceHash },
      });
    };
    const existing = reservationWorkflowV2DraftOf(itemRow.state);
    if ((existing && existing.propertyCode !== ctx.propertyCode) ||
        (!existing && !hasReservationWorkflowV2Draft(itemRow.state) && itemRow.state.propertyCode !== undefined &&
          itemRow.state.propertyCode !== ctx.propertyCode)) {
      if (input.allowPropertySwitch === false) return { status: 'wrong_property' as const };
      // Every source item is locked in ID order. Existing dispatch holds and
      // queued/claimed runs must finish or reconcile before the scope changes.
      const ids = sourceItems.map((row) => row.id);
      const [runningWrite] = ids.length ? await tx.select({ id: aiWorkflowRun.id }).from(aiWorkflowRun)
        .where(and(inArray(aiWorkflowRun.workItemId, ids), eq(aiWorkflowRun.runKind, 'hms_write'),
          inArray(aiWorkflowRun.state, ['queued', 'claimed', 'running', 'retry_wait']))).limit(1) : [];
      if (runningWrite || sourceItems.some((row) => {
        const prior = reservationWorkflowV2DraftOf(row.state as State);
        return (hasReservationWorkflowV2Draft(row.state as State) && !prior) ||
          prior?.operationResults.some((result) => result.status === 'unknown');
      })) return { status: 'invalid_state' as const, issue: 'A prior write must be reconciled before changing property.' };
      try {
        for (const row of sourceItems) {
          await assertNoCreateDispatchFence(tx, { transportId: ctx.transportId, workItemId: row.id });
          await assertNoUnresolvedHmsDispatchForWorkItem(tx, row.id);
        }
      } catch {
        return { status: 'invalid_state' as const, issue: 'A prior write must be reconciled before changing property.' };
      }
      const evidenceHash = (await reservationArrivalEvidence(tx, input.source.messageId)).hash;
      const revision = Math.max(itemRow.revision, itemRow.revisionHead) + 1;
      const switchedAt = new Date();
      const priorDraft = existing ?? seedDraft(evidenceHash);
      let draft = invalidatePropertyDraft(priorDraft, { propertyCode: ctx.propertyCode,
        source: { ...priorDraft.source, propertyId: input.source.propertyId }, generationId: randomUUID(), revision,
        at: switchedAt.toISOString() });
      const switchArrival = existing?.propertyCode === 'HRDAV' && ctx.propertyCode === 'HRDAVS' &&
        input.seed.prefill?.status === 'idle' && existing.source.sourceHash === input.source.sourceHash && existing.prefill &&
        existing.prefill.evidenceHash === evidenceHash &&
        ['idle', 'queued', 'running', 'failed'].includes(existing.prefill.status) &&
        existing.prefill.phase !== 'native_checks' && !Object.keys(existing.fieldOverrides).length &&
        !Object.keys(existing.staffReviews).length && !existing.operationResults.length &&
        !(await hasPrefillRetryActivity(tx, itemRow.id, existing.generationId, itemRow.revisionSeq));
      const [arrival] = switchArrival ? await tx.select({ id: aiWorkflowRun.id }).from(aiWorkflowRun)
        .where(and(eq(aiWorkflowRun.runKind, 'reservation_prefill'), eq(aiWorkflowRun.transportId, ctx.transportId),
          eq(aiWorkflowRun.triggerMessageId, input.source.messageId), eq(aiWorkflowRun.threadId, input.source.threadId)))
        .limit(1) : [];
      if (arrival) draft = seedDraft(evidenceHash, revision, draft.generationId);
      const sourceChanged = draft.source.sourceHash !== input.source.sourceHash || draft.prefill?.evidenceHash !== evidenceHash;
      const selectedUpdatedAt = new Date(Math.max(switchedAt.getTime(), ...sourceItems.map((row) => row.updatedAt.getTime())) + 1);
      for (const row of sourceItems) {
        if (row.id === itemRow.id) continue;
        const prior = reservationWorkflowV2DraftOf(row.state as State);
        const nextRevision = Math.max(row.revision, row.revisionHead) + 1;
        const generationId = randomUUID();
        const invalidated = prior && invalidatePropertyDraft(prior, { generationId, revision: nextRevision, at: switchedAt.toISOString() });
        const otherState = { ...withoutPropertyPreparation(row.state as State), propertyCode: ctx.propertyCode, generationId,
          [RESERVATION_V2_PROPERTY_HISTORY_FLOOR_KEY]: nextRevision,
          ...(invalidated ? withReservationWorkflowV2Draft({}, invalidated) : {}) };
        const otherAdvanced = advancePaneRevision({ revision: nextRevision - 1, revisionHead: row.revisionHead,
          seq: row.revisionSeq, previousState: otherState, nextState: otherState, extractionId: row.extractionId });
        await tx.insert(workEvent).values({ workItemId: row.id, actorKind: 'user', actorUserId: ctx.userId ?? null,
          type: 'field.edit', fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:property`,
          value: { propertyCode: ctx.propertyCode, generationId, invalidated: true }, evidence: otherAdvanced.evidence });
        await tx.update(workItem).set({ state: otherState, revision: otherAdvanced.revision,
          revisionHead: otherAdvanced.revisionHead, revisionSeq: row.revisionSeq + 1, updatedAt: switchedAt }).where(eq(workItem.id, row.id));
      }
      const state = { ...withoutPropertyPreparation(itemRow.state), propertyCode: ctx.propertyCode,
        ...withReservationWorkflowV2Draft({}, draft), generationId: draft.generationId,
        [RESERVATION_V2_PROPERTY_HISTORY_FLOOR_KEY]: revision };
      // Undo must not restore choices from the prior property into this generation.
      const advanced = advancePaneRevision({ revision: revision - 1, revisionHead: itemRow.revisionHead,
        seq: itemRow.revisionSeq, previousState: state, nextState: state, extractionId: itemRow.extractionId });
      await tx.insert(workEvent).values({ workItemId: itemRow.id, actorKind: 'user', actorUserId: ctx.userId ?? null,
        type: 'field.edit', fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:property`,
        value: { propertyCode: ctx.propertyCode, generationId: draft.generationId }, evidence: advanced.evidence });
      if (arrival) {
        // The property switch is the new baseline; later staff activity still blocks prefill.
        const prefillActivityCount = await countPrefillRetryActivity(tx, itemRow.id);
        await tx.insert(workEvent).values({ workItemId: itemRow.id, actorKind: 'ai', type: 'field.seed',
          fieldPath: RESERVATION_WORKFLOW_V2_STATE_KEY, value: { contractVersion: RESERVATION_WORKFLOW_V2_VERSION,
            status: draft.status, generationId: draft.generationId }, aiSource: RESERVATION_PREFILL_SCHEMA_VERSION,
          evidence: { sourceMessageId: input.source.messageId, sourceHash: input.source.sourceHash,
            prefillActivityCount, prefillActivitySeq: itemRow.revisionSeq + 1 } });
      }
      await tx.update(workItem).set({ state, revision: advanced.revision, revisionHead: advanced.revisionHead,
        revisionSeq: itemRow.revisionSeq + 1, updatedAt: selectedUpdatedAt }).where(eq(workItem.id, itemRow.id));
      return { status: 'ok' as const, draft, revision: advanced.revision, revisionHead: advanced.revisionHead,
        seq: itemRow.revisionSeq + 1, ...(sourceChanged ? { sourceChanged: true } : {}) };
    }
    if (existing) {
      if (itemRow.state.propertyCode !== undefined && itemRow.state.propertyCode !== ctx.propertyCode) {
        return { status: 'invalid_state' as const, issue: 'The saved property does not match this reservation.' };
      }
      if (itemRow.state.propertyCode === undefined) {
        itemRow.state = { ...itemRow.state, propertyCode: ctx.propertyCode };
        await tx.update(workItem).set({ state: itemRow.state, updatedAt: new Date() }).where(eq(workItem.id, itemRow.id));
      }
      const current = await buildResult(tx, ctx, itemRow, input.source, input.allowSourceChanged);
      return recoverSourceFields(tx, itemRow, current);
    }
    if (hasReservationWorkflowV2Draft(itemRow.state)) return { status: 'invalid_state' as const };
    const evidenceHash = (await reservationArrivalEvidence(tx, input.source.messageId)).hash;
    const draft = seedDraft(evidenceHash);
    if (itemRow.state.propertyCode !== undefined && itemRow.state.propertyCode !== ctx.propertyCode) {
      return { status: 'invalid_state' as const, issue: 'The saved property does not match this reservation.' };
    }
    const state = { ...itemRow.state, ...withReservationWorkflowV2Draft({}, draft), propertyCode: ctx.propertyCode };
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

export async function initializeReservationWorkflowV2Draft(ctx: Context, source: ReservationWorkflowV2SourceInput,
  options?: { allowSourceChanged?: boolean; allowPropertySwitch?: boolean }) {
  return ensureReservationWorkflowV2Draft(ctx, { source, allowSourceChanged: options?.allowSourceChanged,
    allowPropertySwitch: options?.allowPropertySwitch, seed: { status: 'partial',
    proposal: { schemaVersion: RESERVATION_PREFILL_SCHEMA_VERSION,
      content: { requests: [], services: [], documents: [] }, annotations: [], issues: [], sourceClaims: [], lookupResultRefs: [] },
    observations: [], prefill: { status: 'idle', attemptId: null, attemptCount: 0, startedAt: null, finishedAt: null } } });
}

type PrefillClaim = { attemptId: string; revision: number; seq: number; snapshot: string; generationId: string };
export type ReservationPrefillJobFence = { runId: string; claimOwner: string; claimToken: string };

/** Hold the ledger row while changing the draft: an expired or replaced worker cannot install. */
async function currentPrefillJob(tx: WorkTx, fence: ReservationPrefillJobFence, messageId: string): Promise<string | null> {
  const [run] = await tx.select({ deadlineAt: aiWorkflowRun.deadlineAt, triggerMessageId: aiWorkflowRun.triggerMessageId,
    metrics: aiWorkflowRun.metrics }).from(aiWorkflowRun)
    .where(and(eq(aiWorkflowRun.id, fence.runId), eq(aiWorkflowRun.runKind, 'reservation_prefill'),
      eq(aiWorkflowRun.claimOwner, fence.claimOwner), eq(aiWorkflowRun.claimToken, fence.claimToken),
      eq(aiWorkflowRun.state, 'running'))).limit(1).for('update');
  const expected = run?.metrics?.evidenceHash;
  if (!run?.deadlineAt || run.deadlineAt.getTime() <= Date.now() || run.triggerMessageId !== messageId ||
      typeof expected !== 'string' || expected !== (await reservationArrivalEvidence(tx, messageId)).hash) return null;
  return expected;
}

/** Queue metadata is not a staff edit and may only annotate the untouched idle draft. */
export async function markReservationWorkflowV2Queued(ctx: Context, input: MutationInput & { jobRunId: string }) {
  return ctx.db.transaction(async (tx) => {
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok' || item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq)
      return current;
    const meta = current.draft.prefill;
    if (!meta || (meta.status !== 'idle' && !(meta.status === 'failed' && !meta.jobRunId))) return current;
    const draft = reservationWorkflowV2DraftSchema.parse({ ...current.draft,
      prefill: { ...meta, status: 'queued', jobRunId: input.jobRunId } });
    await tx.update(workItem).set({ state: withReservationWorkflowV2Draft(item.state, draft),
      updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { ...current, draft };
  });
}

/** A staff retry may restart one terminal arrival job, but never replace staff work. */
export async function retryReservationWorkflowV2Arrival(ctx: Context, input: MutationInput & { jobRunId: string }): Promise<ReservationWorkflowV2StateResult> {
  if (!ctx.userId) return { status: 'not_found' };
  return ctx.db.transaction(async (tx) => {
    await lockCanonicalMailbox(tx as unknown as DB, ctx.transportId);
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    const [run] = await tx.select().from(aiWorkflowRun).where(and(eq(aiWorkflowRun.id, input.jobRunId),
      eq(aiWorkflowRun.runKind, 'reservation_prefill'), eq(aiWorkflowRun.transportId, ctx.transportId),
      eq(aiWorkflowRun.triggerMessageId, input.source.messageId), eq(aiWorkflowRun.threadId, input.source.threadId)))
      .limit(1).for('update');
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok' || item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq) return current;
    const meta = current.draft.prefill;
    if (!run || !meta || !['failed', 'running', 'idle', 'queued'].includes(meta.status) ||
        (meta.jobRunId && meta.jobRunId !== run.id) || run.metrics?.sourceHash !== input.source.sourceHash ||
        run.metrics?.evidenceHash !== (await reservationArrivalEvidence(tx, input.source.messageId)).hash ||
        !['dead_letter', 'succeeded', 'retry_wait'].includes(run.state)) return current;
    const nativeResume = meta.status === 'running' && meta.phase === 'native_checks';
    const terminal = run.state !== 'retry_wait';
    const exhaustedGenerationRetry = terminal && meta.status === 'failed' && meta.phase !== 'native_checks' && meta.attemptCount >= 2;
    if ((!nativeResume && meta.attemptCount >= 2 && !exhaustedGenerationRetry) || (nativeResume && meta.nativeActive && !run.heartbeatAt) ||
        Object.keys(current.draft.fieldOverrides).length || Object.keys(current.draft.staffReviews).length ||
        (nativeResume ? await hasUnsafeNativeResumeActivity(tx, item.id, current.draft, item.revisionSeq)
          : current.draft.operationResults.length || await hasPrefillRetryActivity(tx, item.id, current.draft.generationId, item.revisionSeq))) return current;
    if (terminal && Number(run.metrics?.staffRetryCount ?? 0) >= 1) return current;
    const metrics = { ...run.metrics, ...(terminal ? { staffRetryCount: 1 } : {}),
      ...(nativeResume && run.heartbeatAt ? { interruptedHeartbeatAt: run.heartbeatAt.toISOString() } : {}) };
    await tx.update(aiWorkflowRun).set({ state: 'queued', nextRunAt: new Date(), deadlineAt: null,
      claimOwner: null, claimToken: null, finishedAt: null, lastError: null, failureClass: null,
      // Staff asked for this retry: claim it ahead of admission work (priority 1).
      priority: Math.max(run.priority, 2), metrics, updatedAt: new Date() }).where(eq(aiWorkflowRun.id, run.id));
    const draft = reservationWorkflowV2DraftSchema.parse({ ...current.draft, prefill: { ...meta,
      // Leave one generation claim for the single terminal staff retry; automatic retries keep their cap.
      attemptCount: exhaustedGenerationRetry ? 1 : meta.attemptCount,
      status: meta.status === 'running' ? 'running' : 'queued', jobRunId: run.id } });
    await tx.update(workItem).set({ state: withReservationWorkflowV2Draft(item.state, draft),
      updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { ...current, draft };
  });
}
function prefillSnapshot(draft: ReservationWorkflowV2Draft): string {
  const { prefill: _prefill, ...rest } = draft;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

function abandonedPrefill(startedAt: string | null, now = Date.now()): boolean {
  if (!startedAt) return false;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) && now - started >= 12 * 60_000;
}

/** Metadata is not a human edit and never advances the pane cursor. */
export async function claimReservationWorkflowV2Prefill(ctx: Context, input: MutationInput & { allowRetry: boolean; jobFence?: ReservationPrefillJobFence }): Promise<
  { result: ReservationWorkflowV2StateResult; claim?: PrefillClaim }
> {
  if (!propertyMatches(ctx)) return { result: { status: 'wrong_property' } };
  return ctx.db.transaction(async (tx) => {
    if (input.jobFence) await lockCanonicalMailbox(tx as unknown as DB, ctx.transportId);
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    const evidenceHash = input.jobFence ? await currentPrefillJob(tx, input.jobFence, input.source.messageId) : null;
    if (input.jobFence && !evidenceHash) return { result: { status: 'stale_revision' as const } };
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { result: { status: 'not_found' as const } };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok') return { result: current };
    if (item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq)
      return { result: { status: 'stale_revision' as const } };
    // Older untouched fallback drafts predate prefill metadata. Give those one
    // guarded retry; successful and staff-edited legacy drafts stay untouched.
    const meta = current.draft.prefill ?? (input.allowRetry && retryablePrefill(current.draft)
      ? { status: 'failed' as const, jobRunId: undefined, attemptId: null, attemptCount: 1, startedAt: null, finishedAt: null }
      : undefined);
    const reclaimed = input.jobFence && meta?.jobRunId === input.jobFence.runId;
    if (!meta || (meta.status === 'running' && !(input.allowRetry && (reclaimed || (!meta.jobRunId && abandonedPrefill(meta.startedAt))))) ||
        meta.status === 'complete' || meta.status === 'superseded' ||
        (meta.status === 'failed' && !input.allowRetry)) return { result: current };
    const intervened = Object.keys(current.draft.fieldOverrides).length || Object.keys(current.draft.staffReviews).length ||
      current.draft.operationResults.length || await hasPrefillRetryActivity(tx, item.id, current.draft.generationId, item.revisionSeq);
    if (intervened) {
      if (!input.jobFence || !['queued', 'running'].includes(meta.status)) return { result: current };
      const draft = reservationWorkflowV2DraftSchema.parse({ ...current.draft,
        prefill: { ...meta, status: 'superseded', finishedAt: new Date().toISOString() } });
      await tx.update(workItem).set({ state: withReservationWorkflowV2Draft(item.state, draft),
        updatedAt: new Date() }).where(eq(workItem.id, item.id));
      return { result: { ...current, draft } };
    }
    if (meta.attemptCount >= 2) {
      if (!reclaimed || meta.status !== 'running' || meta.phase !== 'generation') return { result: current };
      const draft = reservationWorkflowV2DraftSchema.parse({ ...current.draft, status: 'prefill_failed',
        errors: [{ stage: 'extract', code: 'prefill_unavailable',
          message: 'Prefill could not finish. You can enter the request manually.' }],
        prefill: { ...meta, status: 'failed', finishedAt: new Date().toISOString() } });
      await tx.update(workItem).set({ state: withReservationWorkflowV2Draft(item.state, draft),
        updatedAt: new Date() }).where(eq(workItem.id, item.id));
      return { result: { ...current, draft } };
    }
    const attemptId = randomUUID();
    const draft = reservationWorkflowV2DraftSchema.parse({ ...current.draft, prefill: { status: 'running', phase: 'generation', attemptId,
      attemptCount: meta.attemptCount + 1, startedAt: new Date().toISOString(), finishedAt: null,
      evidenceHash: evidenceHash ?? current.draft.prefill?.evidenceHash,
      ...(input.jobFence ? { jobRunId: input.jobFence.runId } : {}) } });
    await tx.update(workItem).set({ state: withReservationWorkflowV2Draft(item.state, draft),
      updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { result: { ...current, draft }, claim: { attemptId, revision: item.revision, seq: item.revisionSeq,
      snapshot: prefillSnapshot(current.draft), generationId: current.draft.generationId } };
  });
}

/** Persist only schema-valid, source/job/claim-bound extraction without advancing the pane revision. */
export async function checkpointReservationWorkflowV2Extraction(ctx: Context, input: MutationInput & {
  claim: PrefillClaim; generationId: string; extraction: ReservationWorkflowV2Extraction; jobFence?: ReservationPrefillJobFence;
}): Promise<{ result: ReservationWorkflowV2StateResult; claim?: PrefillClaim }> {
  const extraction = reservationWorkflowV2ExtractionSchema.safeParse(input.extraction);
  if (!extraction.success || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.generationId)) {
    return { result: { status: 'invalid_value', issue: 'validated extraction or generation ID is invalid' } };
  }
  return ctx.db.transaction(async (tx) => {
    if (input.jobFence) await lockCanonicalMailbox(tx as unknown as DB, ctx.transportId);
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    if (input.jobFence && !(await currentPrefillJob(tx, input.jobFence, input.source.messageId)))
      return { result: { status: 'stale_revision' as const } };
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { result: { status: 'not_found' as const } };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok') return { result: current };
    const meta = current.draft.prefill;
    if (item.revision !== input.claim.revision || item.revisionSeq !== input.claim.seq ||
        current.draft.generationId !== input.claim.generationId || !meta || meta.attemptId !== input.claim.attemptId ||
        meta.status !== 'running' || meta.phase !== 'generation' || prefillSnapshot(current.draft) !== input.claim.snapshot ||
        await hasPrefillRetryActivity(tx, item.id, current.draft.generationId, item.revisionSeq)) {
      return { result: { status: 'stale_revision' as const } };
    }
    const draft = reservationWorkflowV2DraftSchema.parse({ ...current.draft,
      extraction: extraction.data, extractionGenerationId: input.generationId });
    await tx.update(workItem).set({ state: withReservationWorkflowV2Draft(item.state, draft),
      updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { result: { ...current, draft }, claim: { ...input.claim, snapshot: prefillSnapshot(draft) } };
  });
}

/** Install only the exact claimed, still untouched generation; preserve concurrent staff/native state. */
export async function finishReservationWorkflowV2Prefill(ctx: Context, input: MutationInput & {
  claim: PrefillClaim; seed?: ReservationWorkflowV2Seed; failed: boolean; jobFence?: ReservationPrefillJobFence;
  failure?: ReservationWorkflowV2Draft['errors'][number];
}): Promise<ReservationWorkflowV2StateResult> {
  return ctx.db.transaction(async (tx) => {
    await lockCanonicalMailbox(tx as unknown as DB, ctx.transportId);
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    if (input.jobFence && !(await currentPrefillJob(tx, input.jobFence, input.source.messageId))) return { status: 'stale_revision' as const };
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok') return current;
    const meta = current.draft.prefill;
    if (!meta || meta.attemptId !== input.claim.attemptId || meta.status !== 'running') return current;
    const extractionGenerationMismatch = Boolean(input.seed?.extraction &&
      (!input.seed.generationId || input.seed.generationId !== current.draft.extractionGenerationId));
    const superseded = item.revision !== input.claim.revision || item.revisionSeq !== input.claim.seq ||
      current.draft.generationId !== input.claim.generationId || extractionGenerationMismatch ||
      prefillSnapshot(current.draft) !== input.claim.snapshot ||
      await hasPrefillRetryActivity(tx, item.id, current.draft.generationId, item.revisionSeq);
    // A source-bound no-action draft finishes generation with no native checks to run.
    const checking = Boolean(input.jobFence && !superseded && !input.failed && input.seed &&
      input.seed.disposition?.decision !== 'no_action');
    const prefill = { ...meta, status: superseded ? 'superseded' as const : input.failed ? 'failed' as const : checking ? 'running' as const : 'complete' as const,
      phase: checking ? 'native_checks' as const : 'complete' as const,
      ...(checking ? { nativeStartedAt: new Date().toISOString(), nativeSpentMs: 0, nativeActive: null, nativeChecks: [] } : {}),
      finishedAt: checking ? null : new Date().toISOString() };
    const install = !superseded && input.seed;
    const next = reservationWorkflowV2DraftSchema.parse({ ...current.draft, prefill,
      ...(install ? { generationId: install.generationId ?? randomUUID(), status: install.status,
        ...(install.extraction ? { extraction: install.extraction, extractionGenerationId: install.generationId } : {}),
        disposition: install.disposition,
        proposal: install.proposal, observations: install.observations,
        fieldReviewRequirements: install.fieldReviewRequirements ?? {}, errors: install.errors ?? [], revision: item.revision + 1 }
        : !superseded && input.failed ? { status: 'prefill_failed', errors: [input.failure ?? { stage: 'extract', code: 'prefill_unavailable',
          message: 'Prefill could not finish. You can enter the request manually or retry.' }] } : {}) });
    const nextState: State = withReservationWorkflowV2Draft(item.state, next);
    if (!install) {
      await tx.update(workItem).set({ state: nextState, updatedAt: new Date() }).where(eq(workItem.id, item.id));
      return { ...current, draft: next };
    }
    const classifiedKind = initialKind(install);
    const [kindConflict] = classifiedKind === item.kind ? [] : await tx.select({ id: workItem.id }).from(workItem)
      .where(and(eq(workItem.transportId, ctx.transportId), eq(workItem.threadId, input.source.threadId),
        eq(workItem.sourceMessageId, input.source.messageId), eq(workItem.kind, classifiedKind), ne(workItem.id, item.id)))
      .limit(1).for('update');
    if (kindConflict) nextState.reservationWorkflowV2Classification = { kind: classifiedKind,
      conflictingWorkItemId: kindConflict.id };
    else delete nextState.reservationWorkflowV2Classification;
    const advanced = advancePaneRevision({ revision: item.revision, revisionHead: item.revisionHead,
      seq: item.revisionSeq, previousState: item.state, nextState, extractionId: item.extractionId });
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'ai', type: 'field.seed',
      fieldPath: RESERVATION_WORKFLOW_V2_STATE_KEY, value: { generationId: next.generationId, status: next.status, kind: classifiedKind,
        ...(kindConflict ? { classificationConflictWorkItemId: kindConflict.id } : {}) },
      aiSource: RESERVATION_PREFILL_SCHEMA_VERSION, evidence: advanced.evidence });
    await tx.update(workItem).set({ state: nextState, kind: kindConflict ? item.kind : classifiedKind, revision: advanced.revision, revisionHead: advanced.revisionHead,
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
    if (!current.draft.prefill || !['queued', 'running'].includes(current.draft.prefill.status)) return current;
    const draft = { ...current.draft, prefill: { ...current.draft.prefill, status: 'superseded' as const,
      finishedAt: new Date().toISOString() } };
    await tx.update(workItem).set({ state: withReservationWorkflowV2Draft(item.state, draft),
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
  return or(and(eq(workEvent.actorKind, 'user'), ne(workEvent.type, 'pane.opened'), ne(workEvent.type, 'pane.error'),
    ne(workEvent.type, 'hms.prepare.failed')),
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

/** Only fenced arrival checks from this seed may precede a native-phase resume. */
async function hasUnsafeNativeResumeActivity(tx: WorkTx, workItemId: string,
  draft: ReservationWorkflowV2Draft, revisionSeq: number): Promise<boolean> {
  const [seed] = await tx.select({ id: workEvent.id, evidence: workEvent.evidence }).from(workEvent)
    .where(and(eq(workEvent.workItemId, workItemId), eq(workEvent.type, 'field.seed'),
      eq(workEvent.fieldPath, RESERVATION_WORKFLOW_V2_STATE_KEY), sql`${workEvent.value}->>'generationId' = ${draft.generationId}`))
    .orderBy(desc(workEvent.at)).limit(1);
  const seedEvidence = seed?.evidence && typeof seed.evidence === 'object' && !Array.isArray(seed.evidence)
    ? seed.evidence as Record<string, unknown> : {};
  if (!seed || !Number.isSafeInteger(seedEvidence.paneSeq) || revisionSeq !== seedEvidence.paneSeq) return true;
  const events = await tx.select({ actorKind: workEvent.actorKind, type: workEvent.type,
    value: workEvent.value, evidence: workEvent.evidence }).from(workEvent)
    .where(and(eq(workEvent.workItemId, workItemId), prefillActivityPredicate(),
      sql`${workEvent.at} >= (select ${workEvent.at} from ${workEvent} where ${workEvent.id} = ${seed.id})`));
  const checks = new Set(draft.prefill?.nativeChecks?.map((check) => check.key) ?? []);
  const resultIds = new Set<string>();
  for (const event of events) {
    const value = event.value && typeof event.value === 'object' && !Array.isArray(event.value)
      ? event.value as Record<string, unknown> : {};
    const evidence = event.evidence && typeof event.evidence === 'object' && !Array.isArray(event.evidence)
      ? event.evidence as Record<string, unknown> : {};
    if (event.actorKind !== 'system' || event.type !== 'hms.lookup.finished' || typeof value.check !== 'string' ||
        !checks.has(value.check) || evidence.generationId !== draft.generationId || evidence.sourceHash !== draft.source.sourceHash ||
        !Array.isArray(value.results) || !value.results.every((id) => typeof id === 'string')) return true;
    for (const id of value.results) resultIds.add(id);
  }
  return draft.operationResults.some((result) => !['prepared', 'failed'].includes(result.status) || result.generationId !== draft.generationId ||
    result.draftRevision !== draft.revision || !resultIds.has(result.id));
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
      errors: input.seed.errors ?? [], disposition: input.seed.disposition });
    const nextState = withReservationWorkflowV2Draft(item.state, next);
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

/** Staff explicitly reconciles changed evidence; old observations and receipts remain history, never current checks. */
export async function reconcileReservationWorkflowV2Source(ctx: Context, input: MutationInput): Promise<ReservationWorkflowV2StateResult> {
  if (!ctx.userId || !propertyMatches(ctx)) return { status: 'wrong_property' };
  return ctx.db.transaction(async (tx) => {
    await lockCanonicalMailbox(tx as unknown as DB, ctx.transportId);
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    if (item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq) return { status: 'stale_revision' as const };
    const current = await buildResult(tx, ctx, item, input.source, true);
    if (current.status !== 'ok' || !current.sourceChanged) return current;
    // Recovery of a dispatched operation is bound to its original source and
    // generation. Rebinding either while its outcome is unknown would strand
    // the receipt and could permit an unsafe repeat of the native action.
    if (current.draft.operationResults.some((row) => row.status === 'unknown')) {
      return { status: 'invalid_value' as const, issue: 'native_operation_needs_reconciliation_before_source_rebind' };
    }
    const evidence = await reservationArrivalEvidence(tx, input.source.messageId);
    const meta = current.draft.prefill;
    // A source review can safely restart only an untouched, still-empty prefill.
    // Keep completed proposals, edits, native work and uncertain outcomes bound
    // to their original generation instead of silently replacing them.
    const retryEmpty = Boolean(meta && ['idle', 'queued', 'running', 'failed'].includes(meta.status) &&
      meta.phase !== 'native_checks' && ['partial', 'prefill_failed'].includes(current.draft.status) &&
      !current.draft.proposal.content.requests.length && !current.draft.proposal.content.services.length &&
      !current.draft.proposal.content.documents.length && !current.draft.observations.length &&
      !current.draft.operationResults.length && !Object.keys(current.draft.fieldOverrides).length &&
      !Object.keys(current.draft.staffReviews).length &&
      !(await hasPrefillRetryActivity(tx, item.id, current.draft.generationId, item.revisionSeq)));
    const draft = reservationWorkflowV2DraftSchema.parse({ ...current.draft, source: input.source,
      generationId: randomUUID(), revision: item.revision + 1, disposition: undefined,
      prefill: retryEmpty ? { status: 'failed', attemptId: null, attemptCount: 0, startedAt: null,
        finishedAt: new Date().toISOString(), evidenceHash: evidence.hash }
        : { ...(meta ?? { attemptId: null, attemptCount: 0, startedAt: null }),
          status: 'superseded', evidenceHash: evidence.hash, finishedAt: new Date().toISOString() } });
    const nextState = withReservationWorkflowV2Draft(item.state, draft);
    const advanced = advancePaneRevision({ revision: item.revision, revisionHead: item.revisionHead,
      seq: item.revisionSeq, previousState: item.state, nextState, extractionId: item.extractionId });
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'user', actorUserId: ctx.userId,
      type: 'field.edit', fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:source`,
      value: { action: 'reconcile_source', previousSourceHash: current.draft.source.sourceHash,
        sourceHash: input.source.sourceHash, evidenceHash: evidence.hash }, evidence: advanced.evidence });
    if (retryEmpty) {
      // The explicit source review is the new baseline, not an intervening edit.
      const prefillActivityCount = await countPrefillRetryActivity(tx, item.id);
      await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'ai', type: 'field.seed',
        fieldPath: RESERVATION_WORKFLOW_V2_STATE_KEY, value: { contractVersion: RESERVATION_WORKFLOW_V2_VERSION,
          status: draft.status, generationId: draft.generationId }, aiSource: RESERVATION_PREFILL_SCHEMA_VERSION,
        evidence: { sourceMessageId: input.source.messageId, sourceHash: input.source.sourceHash,
          prefillActivityCount, prefillActivitySeq: item.revisionSeq + 1 } });
    }
    await tx.update(workItem).set({ state: nextState, revision: advanced.revision, revisionHead: advanced.revisionHead,
      revisionSeq: item.revisionSeq + 1, updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { status: 'ok' as const, draft, revision: advanced.revision, revisionHead: advanced.revisionHead, seq: item.revisionSeq + 1 };
  });
}

/** All command builders run under the same source validation, row lock, cursor and history. */
export async function withLockedV2DraftMutation(ctx: Context, input: MutationInput, command: {
  fieldPath: string; eventType?: 'field.edit' | 'field.accept' | 'field.reject'; value: unknown;
  apply: (draft: ReservationWorkflowV2Draft, tx: Parameters<Parameters<DB['transaction']>[0]>[0]) =>
    { draft: ReservationWorkflowV2Draft; createdId?: string } | null |
    Promise<{ draft: ReservationWorkflowV2Draft; createdId?: string } | null>;
}): Promise<ReservationWorkflowV2StateResult & { createdId?: string }> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  return ctx.db.transaction(async (tx) => {
    const serviceTargetEdit = /^\/proposal\/content\/services\/[^/]+\/targets$/.test(command.fieldPath);
    if (serviceTargetEdit) {
      await lockCanonicalMailbox(tx as unknown as DB, ctx.transportId);
      await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    }
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    if (item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq) return { status: 'stale_revision' as const };
    const current = await buildResult(tx, ctx, item, input.source, true);
    if (current.status !== 'ok') return current;
    if (current.sourceChanged && serviceTargetEdit) {
      return { status: 'invalid_source' as const };
    }
    // A profile Save runs outside the database transaction. Keep the reviewed
    // allocation stable until its journal has a definitive result.
    if (current.draft.operationResults.some((row) => row.workflow === 'guest_profile' && row.status === 'unknown')) {
      return { status: 'invalid_value' as const };
    }
    const changed = await command.apply(current.draft, tx);
    if (!changed) return { status: 'invalid_value' as const };
    const prefill = changed.draft.prefill && ['queued', 'running'].includes(changed.draft.prefill.status)
      ? { ...changed.draft.prefill, status: 'superseded' as const, finishedAt: new Date().toISOString() }
      : changed.draft.prefill;
    const parsed = reservationWorkflowV2DraftSchema.safeParse({ ...changed.draft, prefill, revision: item.revision + 1 });
    if (!parsed.success) return { status: 'invalid_value' as const };
    const next = parsed.data;
    const nextState = withReservationWorkflowV2Draft(item.state, next);
    const advanced = advancePaneRevision({ revision: item.revision, revisionHead: item.revisionHead,
      seq: item.revisionSeq, previousState: item.state, nextState, extractionId: item.extractionId });
    const traced = reservationWorkflowV2EditTrace(current.draft, command.fieldPath);
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'user', actorUserId: ctx.userId ?? null,
      type: command.eventType ?? 'field.edit', fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:${command.fieldPath}`,
      value: command.value, aiValue: traced.aiValue, aiSource: RESERVATION_PREFILL_SCHEMA_VERSION,
      evidence: { ...advanced.evidence, trace: traced.trace } });
    await tx.update(workItem).set({ state: nextState, revision: advanced.revision, revisionHead: advanced.revisionHead,
      revisionSeq: item.revisionSeq + 1, updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { status: 'ok' as const, draft: next, revision: advanced.revision, revisionHead: advanced.revisionHead,
      seq: item.revisionSeq + 1, ...(current.sourceChanged ? { sourceChanged: true } : {}),
      ...(changed.createdId ? { createdId: changed.createdId } : {}) };
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

function effectiveSavedTargetRows(draft: ReservationWorkflowV2Draft, requestId: string,
  collection: 'include' | 'exclude' = 'include'): unknown[] {
  const request = draft.proposal.content.requests.find((entry) => entry.id === requestId);
  if (!request || !('targets' in request.body)) return [];
  let value: unknown = request.body;
  let path = `/proposal/content/requests/${encodeURIComponent(requestId)}/body`;
  for (const key of ['', 'targets', collection]) {
    if (key) {
      value = value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key] : undefined;
      path += `/${key}`;
    }
    const override = draft.fieldOverrides[path];
    if (override?.state === 'set') value = override.value;
    else if (override && override.state !== 'inherit') value = undefined;
  }
  if (!Array.isArray(value)) return [];
  const rows = value.map((row) => row && typeof row === 'object' && !Array.isArray(row)
    ? { ...(row as Record<string, unknown>) } : row);
  // Array-scope corrections copy the effective row, including any staff edits
  // made through indexed or stable-ID pointers, without dropping source refs.
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const hint = row as Record<string, unknown>, id = typeof hint.id === 'string' ? hint.id : null;
    for (const field of ['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture', 'suggestedRef'] as const) {
      const paths = [`${path}/${index}/${field}`, ...(id ? [`${path}/${encodeURIComponent(id)}/${field}`] : [])];
      const overrides = [...new Set(paths)].flatMap((overridePath) => {
        const override = draft.fieldOverrides[overridePath];
        return override && override.state !== 'inherit' ? [{ overridePath, override }] : [];
      });
      const signatures = overrides.map(({ override }) => override.state === 'set'
        ? `set:${JSON.stringify(override.value)}` : override.state);
      if (new Set(signatures).size > 1) {
        hint[field] = { kind: 'ambiguous_target_hint_override' };
      } else {
        const entry = overrides[0];
        if (entry?.override.state === 'set') hint[field] = entry.override.value;
        else if (entry) hint[field] = null;
      }
    }
  }
  return rows;
}

function sameSavedTargetHint(left: unknown, right: unknown): boolean {
  if (!left || typeof left !== 'object' || Array.isArray(left) || !right || typeof right !== 'object' || Array.isArray(right)) return false;
  const leftRow = left as Record<string, unknown>, rightRow = right as Record<string, unknown>;
  const keys = Object.keys(leftRow);
  return keys.length === Object.keys(rightRow).length && keys.every((key) => Object.hasOwn(rightRow, key) &&
    JSON.stringify(leftRow[key]) === JSON.stringify(rightRow[key]));
}

function sameTargetList(left: unknown[], right: unknown[]): boolean {
  return left.length === right.length && left.every((row, index) => sameSavedTargetHint(row, right[index]));
}

function targetRowsWithOneAppended(before: unknown[], after: unknown[]): unknown | null {
  return after.length === before.length + 1 && before.every((row, index) => sameSavedTargetHint(row, after[index]))
    ? after.at(-1) ?? null : null;
}

function targetRowsWithOneRemoved(before: unknown[], after: unknown[]): { row: unknown; index: number } | null {
  if (before.length !== after.length + 1) return null;
  for (let index = 0; index < before.length; index += 1) {
    const remaining = before.filter((_, rowIndex) => rowIndex !== index);
    if (sameTargetList(remaining, after)) return { row: before[index], index };
  }
  return null;
}

function exactTargetConfirmation(value: unknown): string | null {
  const confirmation = value && typeof value === 'object' ? (value as Record<string, unknown>).confirmation : null;
  return typeof confirmation === 'string' && /^\d{6,10}-\d{1,2}$/.test(confirmation) ? confirmation : null;
}

function validTargetDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function targetGuestForms(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const normalize = (name: string) => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  const parts = value.split(',');
  return [...new Set([normalize(value), ...(parts.length === 2 ? [normalize(`${parts[1]?.trim()} ${parts[0]?.trim()}`)] : [])])]
    .filter(Boolean);
}

function savedTargetsDefinitelyDistinct(left: unknown, right: unknown): boolean {
  const first = left && typeof left === 'object' ? left as Record<string, unknown> : {};
  const second = right && typeof right === 'object' ? right as Record<string, unknown> : {};
  const firstConfirmation = exactTargetConfirmation(first), secondConfirmation = exactTargetConfirmation(second);
  if (firstConfirmation && secondConfirmation) return firstConfirmation !== secondConfirmation;
  const firstGuests = targetGuestForms(first.guestName), secondGuests = targetGuestForms(second.guestName);
  const differentGuests = firstGuests.length > 0 && secondGuests.length > 0 && !firstGuests.some((name) => secondGuests.includes(name));
  const firstArrival = first.bookedArrival, firstDeparture = first.bookedDeparture;
  const secondArrival = second.bookedArrival, secondDeparture = second.bookedDeparture;
  const disjointDates = validTargetDate(firstArrival) && validTargetDate(firstDeparture) &&
    validTargetDate(secondArrival) && validTargetDate(secondDeparture) &&
    (firstDeparture <= secondArrival || secondDeparture <= firstArrival);
  return Boolean(differentGuests && disjointDates);
}

function targetAlreadyIncluded(excluded: unknown, include: unknown[]): boolean {
  const row = excluded && typeof excluded === 'object' ? excluded as Record<string, unknown> : null;
  const id = typeof row?.id === 'string' ? row.id : null;
  const confirmation = exactTargetConfirmation(excluded);
  return include.some((candidate) => {
    const target = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : null;
    return Boolean(id && target?.id === id || confirmation && exactTargetConfirmation(candidate) === confirmation);
  });
}

function editableCancelBodyField(draft: ReservationWorkflowV2Draft, parts: string[]): boolean {
  if (parts[0] !== 'proposal' || parts[1] !== 'content' || parts[2] !== 'requests' || parts[4] !== 'body') return false;
  const request = draft.proposal.content.requests.find((entry) => entry.id === parts[3]);
  if (request?.kind !== 'cancel') return false;
  if (parts.length === 7 && parts[5] === 'targets' && parts[6] === 'mode') return true;
  if (parts.length === 7 && parts[5] === 'targets' && ['include', 'exclude'].includes(parts[6] ?? '')) return true;
  if (parts.length === 7 && parts[5] === 'reason' && parts[6] === 'text') return true;
  if (parts.length === 6 && parts[5] === 'cancellationNote') return true;
  if (parts.length === 7 && parts[5] === 'previewObservationRefs' &&
      /^(?:0|[1-9]\d*)$/.test(parts[6] ?? '') && Number(parts[6]) < 100) return true;
  if (parts.length !== 9 || parts[5] !== 'targets' || !['include', 'exclude'].includes(parts[6] ?? '')) return false;
  const rows = effectiveSavedTargetRows(draft, request.id, parts[6] as 'include' | 'exclude');
  const key = parts[7] ?? '';
  const index = /^(?:0|[1-9]\d*)$/.test(key) ? Number(key) : rows.findIndex((row) =>
    row && typeof row === 'object' && !Array.isArray(row) && (row as { id?: unknown }).id === key);
  if (!Number.isSafeInteger(index) || index < 0) return false;
  const hint = rows[index];
  return Boolean(hint && typeof hint === 'object' && !Array.isArray(hint) &&
    typeof (hint as { id?: unknown }).id === 'string' &&
    (['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture'].includes(parts[8]!) ||
      parts[6] === 'include' && parts[8] === 'suggestedRef'));
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
  if (override.state !== 'set' || !Array.isArray(override.value)) return false;
  const current = effectiveSavedTargetRows(draft, request.id), next = override.value;
  const excluded = effectiveSavedTargetRows(draft, request.id, 'exclude');
  const added = targetRowsWithOneAppended(current, next);
  if (added) return excluded.some((row) => sameSavedTargetHint(row, added)) &&
    !current.some((row) => sameSavedTargetHint(row, added)) && current.every((row) => savedTargetsDefinitelyDistinct(row, added));
  if (!current.length) {
    if (next.length !== 1) return false;
    const row = next[0] as Record<string, unknown> | undefined;
    const candidateRefs = row?.candidateRefs, sourceRefs = row?.sourceRefs;
    return Boolean(row && typeof row === 'object' && !Array.isArray(row) &&
      Object.keys(row).length === 4 && typeof (row as Record<string, unknown>).id === 'string' &&
      /^[A-Za-z0-9_-]{1,80}$/.test((row as Record<string, string>).id!) &&
      Array.isArray(candidateRefs) && candidateRefs.length === 0 &&
      row.suggestedRef === null && Array.isArray(sourceRefs) && sourceRefs.length === 0);
  }
  const removed = targetRowsWithOneRemoved(current, next);
  return Boolean(removed && next.length > 0 && excluded.some((row) => sameSavedTargetHint(row, removed.row) ||
    targetAlreadyIncluded(row, [removed.row])));
}

/** Cancel exclusion edits only preserve a whole hint row or clear an exact duplicate confirmation. */
function validCancelExcludeEdit(draft: ReservationWorkflowV2Draft, path: string, override: V2Override): boolean {
  const parts = pathParts(path);
  if (!parts || parts.length !== 7 || parts[2] !== 'requests' || parts[4] !== 'body' ||
      parts[5] !== 'targets' || parts[6] !== 'exclude') return true;
  const request = draft.proposal.content.requests.find((entry) => entry.id === parts[3]);
  if (request?.kind !== 'cancel') return true;
  if (override.state !== 'set' || !Array.isArray(override.value)) return false;
  const current = effectiveSavedTargetRows(draft, request.id, 'exclude'), next = override.value;
  const include = effectiveSavedTargetRows(draft, request.id);
  const added = targetRowsWithOneAppended(current, next);
  if (added) return include.some((row) => sameSavedTargetHint(row, added)) &&
    !current.some((row) => sameSavedTargetHint(row, added));
  const removed = targetRowsWithOneRemoved(current, next);
  return Boolean(removed && targetAlreadyIncluded(removed.row, include));
}

function validAmendTargetScopeEdit(draft: ReservationWorkflowV2Draft, path: string, override: V2Override): boolean {
  const parts = pathParts(path);
  if (!parts || parts.length !== 7 || parts[2] !== 'requests' || parts[4] !== 'body' ||
      parts[5] !== 'targets' || !['include', 'exclude'].includes(parts[6] ?? '')) return true;
  const request = draft.proposal.content.requests.find((entry) => entry.id === parts[3]);
  if (request?.kind !== 'amend') return true;
  if (override.state !== 'set' || !Array.isArray(override.value)) return false;
  const collection = parts[6] as 'include' | 'exclude', otherCollection = collection === 'include' ? 'exclude' : 'include';
  const current = effectiveSavedTargetRows(draft, request.id, collection), next = override.value;
  const other = effectiveSavedTargetRows(draft, request.id, otherCollection);
  const added = targetRowsWithOneAppended(current, next);
  if (added) return other.some((row) => sameSavedTargetHint(row, added)) &&
    !current.some((row) => sameSavedTargetHint(row, added)) && current.every((row) => savedTargetsDefinitelyDistinct(row, added));
  const removed = targetRowsWithOneRemoved(current, next);
  return Boolean(removed && (collection !== 'include' || next.length > 0) &&
    other.some((row) => sameSavedTargetHint(row, removed.row) || targetAlreadyIncluded(row, [removed.row])));
}

function materializableSavedTargetRows(rows: unknown[]): boolean {
  return rows.every((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return typeof row.id === 'string' && Array.isArray(row.candidateRefs) && Array.isArray(row.sourceRefs) &&
      (row.suggestedRef === null || typeof row.suggestedRef === 'string') &&
      ['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture'].every((field) =>
        row[field] === undefined || typeof row[field] === 'string');
  });
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

/** A Services stay can be reviewed only after the host bound that exact selection. */
function reviewablePath(draft: ReservationWorkflowV2Draft, path: string): boolean {
  if (editablePath(draft, path)) return true;
  const parts = pathParts(path);
  if (!parts || parts.length !== 9 || parts[2] !== 'requests' || parts[4] !== 'body' || parts[5] !== 'targets' ||
      parts[6] !== 'include' || parts[8] !== 'suggestedRef' || !/^(?:0|[1-9]\d*)$/.test(parts[7] ?? '')) return false;
  const request = draft.proposal.content.requests.find((row) => row.id === parts[3]);
  if (request?.kind !== 'services') return false;
  const hint = effectiveSavedTargetRows(draft, request.id)[Number(parts[7])];
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return false;
  const hintRow = hint as { id?: unknown; suggestedRef?: unknown }, override = draft.fieldOverrides[path];
  const ref = override ? override.state === 'set' ? override.value : override.state === 'inherit' ? hintRow.suggestedRef : null
    : hintRow.suggestedRef;
  return typeof hintRow.id === 'string' && typeof ref === 'string' && draft.observations.some((row) => row.ref === ref &&
    row.kind === 'stay_candidate' && row.status === 'complete' && row.coverage.complete && row.generationId === draft.generationId &&
    row.propertyCode === draft.propertyCode && row.sourceMessageId === draft.source.messageId && row.criteria.workflow === 'services' &&
    row.criteria.kind === 'saved_target' && row.criteria.requestId === request.id && row.criteria.hintId === hintRow.id &&
    row.criteria.fieldPath === path);
}

function validateOverride(value: unknown): V2Override | null {
  const parsed = reservationWorkflowV2FieldOverrideSchema.safeParse(value);
  return parsed.success ? { ...parsed.data, updatedAt: new Date().toISOString() } : null;
}

function validStructuredEdit(draft: ReservationWorkflowV2Draft, path: string, override: V2Override): boolean {
  const parts = pathParts(path);
  const requestKey = parts?.[3];
  const request = parts?.[2] === 'requests' && requestKey ? draft.proposal.content.requests.find((row) => row.id === requestKey) ??
    (/^\d+$/.test(requestKey) ? draft.proposal.content.requests[Number(requestKey)] : undefined) : undefined;
  if (request?.kind === 'create' && parts?.[4] === 'body' && override.state === 'set') {
    if (parts.at(-1) === 'reservationNote' && typeof override.value !== 'string') return false;
    let stable = '', indexed = '';
    for (const part of parts) {
      const parent = stable ? effectiveDraftPath(draft, stable, indexed) : draft;
      const index = Array.isArray(parent) ? (/^\d+$/.test(part) ? Number(part) : parent.findIndex((row) =>
        row && typeof row === 'object' && (row as { id?: unknown }).id === part)) : -1;
      const id = index >= 0 && Array.isArray(parent) ? parent[index]?.id : undefined;
      stable += `/${encodeURIComponent(typeof id === 'string' && !/^\d+$/.test(id) ? id : part)}`;
      indexed += `/${encodeURIComponent(index >= 0 ? String(index) : part)}`;
    }
    const requestId = encodeURIComponent(request.id), requestIndex = String(draft.proposal.content.requests.indexOf(request));
    const sameEffectiveNote = (value: string, stablePath: string, indexPath: string): boolean => {
      const aliases = new Set([stablePath, indexPath].flatMap((candidate) => [requestId, requestIndex].map((id) =>
        candidate.replace(/^(\/proposal\/content\/requests\/)[^/]+/, `$1${id}`))));
      return [...aliases].every((candidate) => effectiveDraftPath(draft, candidate) === value);
    };
    const unchanged = (value: unknown, stablePath: string, indexPath: string): boolean => {
      if (typeof value === 'string' && stablePath.endsWith('/reservationNote') && value.length > 2000)
        return sameEffectiveNote(value, stablePath, indexPath);
      if (Array.isArray(value)) {
        const previous = effectiveDraftPath(draft, stablePath, indexPath);
        return value.every((entry, index) => {
          const id = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as { id?: unknown }).id : null;
          const matches = typeof id === 'string' && Array.isArray(previous) ? previous.flatMap((row, position) =>
            row && typeof row === 'object' && row.id === id ? [position] : []) : [];
          const oldIndex = typeof id === 'string' ? (matches.length === 1 ? matches[0]! : -1) : index;
          const stableKey = typeof id === 'string' && !/^\d+$/.test(id) && oldIndex >= 0 ? id : String(oldIndex);
          return unchanged(entry, `${stablePath}/${encodeURIComponent(stableKey)}`, `${indexPath}/${oldIndex}`);
        });
      }
      return !value || typeof value !== 'object' || Object.entries(value).every(([key, entry]) =>
        unchanged(entry, `${stablePath}/${encodeURIComponent(key)}`, `${indexPath}/${encodeURIComponent(key)}`));
    };
    if (!unchanged(override.value, stable, indexed)) return false;
  }
  if (/\/requestedMoney\/\d+\/staffAllowanceType$/.test(path))
    return override.state === 'set' && ['dinner', 'lunch', 'airport_transfer', 'office_transfer', 'unsupported'].includes(String(override.value));
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
  if (draft.operationResults.some((row) => row.workflow !== 'guest_profile' &&
      (row.status === 'succeeded' || row.status === 'unknown') && relevant.has(row.requestId))) return false;
  const targets = override.value;
  if (new Set(targets.map((row) => JSON.stringify((row as { target?: unknown })?.target))).size !== targets.length) return false;
  for (const item of targets) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const target = (item as { target?: unknown }).target;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
    const ref = target as Record<string, unknown>;
    const request = draft.proposal.content.requests.find((row) => row.id === ref.requestId);
    const ownedUnlinked = request && service.ownerRequestId === request.id && !service.targets.length &&
      request.serviceRefs.length < 100 && !draft.proposal.content.requests.some((row) => row.serviceRefs.includes(service.id));
    if (request && !request.serviceRefs.includes(service.id) && !ownedUnlinked) return false;
    if (!request || draft.operationResults.some((row) => row.workflow !== 'guest_profile' && row.requestId === request.id &&
        (row.status === 'succeeded' || row.status === 'unknown'))) return false;
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

/** A failed unsaved check can be corrected; a write outcome still fixes its scope. */
export function reservationWorkflowV2SavedTargetOperationLocks(draft: ReservationWorkflowV2Draft,
  result: ReservationWorkflowV2Draft['operationResults'][number]): boolean {
  if (result.status === 'succeeded' || result.status === 'unknown') return true;
  if (result.status !== 'failed') return false;
  return !result.observationRefs.length || !result.observationRefs.every(ref => {
    const observation = draft.observations.find(row => row.ref === ref);
    return observation?.criteria.workflow === result.workflow && observation.criteria.requestId === result.requestId &&
      observation.criteria.stage === 'prepare';
  });
}

/** An unrelated Add-On receipt must not freeze every saved stay in the request. */
export function reservationWorkflowV2SavedTargetLocked(draft: ReservationWorkflowV2Draft, requestId: string, hintId: string): boolean {
  return draft.operationResults.some((result) => {
    if (result.requestId !== requestId || !reservationWorkflowV2SavedTargetOperationLocks(draft, result)) return false;
    if (result.workflow === 'amend') return !result.allocationId || result.allocationId === hintId;
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
  const collection = parts[6] === 'exclude' ? 'exclude' : 'include';
  const rows = effectiveSavedTargetRows(draft, request.id, collection);
  const key = ['include', 'exclude'].includes(parts[6] ?? '') && parts.length >= 9 ? parts[7] : undefined;
  const hint = key === undefined ? undefined : /^\d+$/.test(key) ? rows[Number(key)] : rows.find((row) =>
    row && typeof row === 'object' && (row as { id?: unknown }).id === key);
  const hintId = hint && typeof hint === 'object' ? (hint as { id?: unknown }).id : undefined;
  // Amend corrections are guarded per exact stay. A completed write for A must
  // not block a fresh identity or selection edit for untouched stay B.
  if (request.kind === 'amend' && ['include', 'exclude'].includes(parts[6] ?? '') && parts.length >= 9) {
    return typeof hintId === 'string' && !reservationWorkflowV2SavedTargetLocked(draft, request.id, hintId);
  }
  if (['mode', 'include', 'exclude'].includes(parts[6] ?? '') && draft.operationResults.some((row) =>
      row.requestId === request.id && reservationWorkflowV2SavedTargetOperationLocks(draft, row))) return false;
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
  const service = after.content.services[index]!;
  const owner = after.content.requests.find((row) => row.id === service.ownerRequestId);
  if (owner && !owner.serviceRefs.includes(service.id) && service.targets.some((row) => row.target.requestId === owner.id)) {
    owner.serviceRefs.push(service.id);
  }
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

function rebaseSavedTargetScopePath(path: string, before: ReservationWorkflowV2Proposal,
  after: ReservationWorkflowV2Proposal): string | null {
  let parts: string[];
  try { parts = path.slice(1).split('/').map(decodeURIComponent); } catch { return null; }
  const targetIndex = parts.indexOf('targets'), collectionIndex = targetIndex + 1, rowIndex = collectionIndex + 1;
  const collection = parts[collectionIndex];
  if (!['include', 'exclude'].includes(collection ?? '') || parts[rowIndex] === undefined) {
    return rebaseReservationV2Path(path, before, after);
  }
  const requestIndex = parts.indexOf('requests'), requestId = parts[requestIndex + 1];
  if (requestIndex < 0 || !requestId) return rebaseReservationV2Path(path, before, after);
  const oldRequest = before.content.requests.find((row) => row.id === requestId);
  const newRequest = after.content.requests.find((row) => row.id === requestId);
  if (!oldRequest || !newRequest || !('targets' in oldRequest.body) || !('targets' in newRequest.body)) return null;
  const oldRows = (oldRequest.body.targets as Record<string, unknown> | null)?.[collection as 'include' | 'exclude'];
  const key = parts[rowIndex]!, rows = Array.isArray(oldRows) ? oldRows : [];
  const index = /^(?:0|[1-9]\d*)$/.test(key) ? Number(key) : rows.findIndex((row) =>
    row && typeof row === 'object' && !Array.isArray(row) && (row as { id?: unknown }).id === key);
  const id = rows[index] && typeof rows[index] === 'object' && !Array.isArray(rows[index])
    ? (rows[index] as { id?: unknown }).id : null;
  if (typeof id !== 'string') return rebaseReservationV2Path(path, before, after);
  const nextTargets = newRequest.body.targets as Record<string, unknown> | null;
  const sameCollection = nextTargets?.[collection as 'include' | 'exclude'];
  const sameRows = Array.isArray(sameCollection) ? sameCollection : [];
  if (sameRows.some((row) => row && typeof row === 'object' && !Array.isArray(row) && (row as { id?: unknown }).id === id))
    return rebaseReservationV2Path(path, before, after);
  const otherCollection = collection === 'include' ? 'exclude' : 'include';
  const otherValue = nextTargets?.[otherCollection];
  const otherRows = Array.isArray(otherValue) ? otherValue : [];
  const nextIndex = otherRows.findIndex((row) => row && typeof row === 'object' && !Array.isArray(row) &&
    (row as { id?: unknown }).id === id);
  if (nextIndex < 0) return rebaseReservationV2Path(path, before, after);
  parts[collectionIndex] = otherCollection;
  if (/^(?:0|[1-9]\d*)$/.test(key)) parts[rowIndex] = String(nextIndex);
  return rebaseReservationV2Path(`/${parts.map(encodeURIComponent).join('/')}`, before, after);
}

/** Excluded hints identify scope only; a native selection there cannot authorize a write. */
function isExcludedSavedTargetSelectionPath(path: string): boolean {
  const parts = pathParts(path);
  return Boolean(parts && parts.length === 9 && parts[2] === 'requests' && parts[4] === 'body' &&
    parts[5] === 'targets' && parts[6] === 'exclude' && parts[8] === 'suggestedRef');
}

/** Materialize exact scope moves and rebase child evidence by stable hint ID. */
function applySavedTargetScopeEdit(draft: ReservationWorkflowV2Draft, path: string, override: V2Override): ReservationWorkflowV2Draft | null {
  const parts = pathParts(path);
  if (!parts || parts.length !== 7 || parts[0] !== 'proposal' || parts[1] !== 'content' || parts[2] !== 'requests' ||
      parts[4] !== 'body' || parts[5] !== 'targets' || !['include', 'exclude'].includes(parts[6] ?? '') ||
      override.state !== 'set' || !Array.isArray(override.value)) return null;
  const requestId = parts[3]!, request = draft.proposal.content.requests.find((row) => row.id === requestId);
  if (!request || !('targets' in request.body)) return null;
  const targetRoot = `/proposal/content/requests/${encodeURIComponent(requestId)}/body/targets`;
  const targetOverride = draft.fieldOverrides[targetRoot];
  if (targetOverride && targetOverride.state !== 'set' && targetOverride.state !== 'inherit') return null;
  const targetValue = targetOverride?.state === 'set' ? targetOverride.value : request.body.targets;
  if (!targetValue || typeof targetValue !== 'object' || Array.isArray(targetValue)) return null;
  const targets = targetValue as Record<string, unknown>;
  if (!Array.isArray(targets.include) || !Array.isArray(targets.exclude)) return null;
  const before = structuredClone(draft.proposal);
  const beforeRequest = before.content.requests.find((row) => row.id === requestId);
  if (!beforeRequest || !('targets' in beforeRequest.body)) return null;
  beforeRequest.body.targets = { ...targets,
    include: effectiveSavedTargetRows(draft, requestId, 'include'),
    exclude: effectiveSavedTargetRows(draft, requestId, 'exclude') } as typeof beforeRequest.body.targets;
  if (!beforeRequest.body.targets || !materializableSavedTargetRows(beforeRequest.body.targets.include) ||
      !materializableSavedTargetRows(beforeRequest.body.targets.exclude)) return null;
  const after = structuredClone(before);
  const afterRequest = after.content.requests.find((row) => row.id === requestId);
  if (!afterRequest || !('targets' in afterRequest.body)) return null;
  afterRequest.body.targets = { ...afterRequest.body.targets,
    [parts[6]!]: structuredClone(override.value) } as typeof afterRequest.body.targets;

  const targetCollectionPaths = new Set([targetRoot, `${targetRoot}/include`, `${targetRoot}/exclude`]);
  const remap = <T>(values: Record<string, T>, dropExcludedSelections = false) => {
    const result: Record<string, T> = {};
    for (const [key, value] of Object.entries(values)) {
      if (targetCollectionPaths.has(key)) continue;
      const nextPath = rebaseSavedTargetScopePath(key, before, after);
      if (nextPath && !(dropExcludedSelections && isExcludedSavedTargetSelectionPath(nextPath))) result[nextPath] = value;
    }
    return result;
  };
  const remapRows = <T extends { path: string }>(rows: T[]) => rows.flatMap((row) => {
    const nextPath = rebaseSavedTargetScopePath(row.path, before, after);
    return nextPath ? [{ ...row, path: nextPath }] : [];
  });
  const observations = draft.observations.map((observation) => {
    const criteria = { ...observation.criteria };
    for (const key of ['fieldPath', 'selectionPath'] as const) {
      if (typeof criteria[key] !== 'string') continue;
      const nextPath = rebaseSavedTargetScopePath(criteria[key] as string, before, after);
      if (nextPath) criteria[key] = nextPath;
      else delete criteria[key];
    }
    if (Array.isArray(criteria.fieldPaths)) criteria.fieldPaths = criteria.fieldPaths.flatMap((value) => {
      if (typeof value !== 'string') return [];
      const nextPath = rebaseSavedTargetScopePath(value, before, after);
      return nextPath ? [nextPath] : [];
    });
    return { ...observation, criteria };
  });
  // Observation paths were translated above by stable hint ID. Re-running the
  // generic index rebase would apply array movement a second time.
  const next: ReservationWorkflowV2Draft = { ...draft, proposal: { ...after, annotations: remapRows(after.annotations),
    issues: remapRows(after.issues), sourceClaims: remapRows(after.sourceClaims) },
    fieldOverrides: remap(draft.fieldOverrides, true), staffReviews: remap(draft.staffReviews),
    fieldReviewRequirements: remap(draft.fieldReviewRequirements), observations };
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
    if (input.override.state === 'set' && input.fieldPath.endsWith('/occupancy')) {
      // Count and age slots are one edit; older leaf overrides must not undo it.
      for (const path of Object.keys(fieldOverrides)) {
        if (path === `${input.fieldPath}/childCount` || path.startsWith(`${input.fieldPath}/childCount/`) ||
            path === `${input.fieldPath}/childAges` || path.startsWith(`${input.fieldPath}/childAges/`)) delete fieldOverrides[path];
      }
    }
    // Retyping a native identity or saved-stay query removes the old selection atomically.
    const guest = input.fieldPath.match(/^(.*\/guest)\/(?:firstName|lastName|email|mobile)$/);
    const party = input.fieldPath.match(/^(.*\/(?:bookingAgency|organization|arAccount))(?:\/name)?$/);
    const amendValue = input.fieldPath.match(/^(\/proposal\/content\/requests\/[^/]+\/body\/(?:sharedChanges\/\d+|perTarget\/\d+\/changes\/\d+)\/value)(?:\/name)?$/);
    const amendField = amendValue ? effectiveDraftPath(current, `${amendValue[1]!.slice(0, -'/value'.length)}/field`) : null;
    const amendParty = ['bookingAgency', 'organization', 'arAccount'].includes(String(amendField)) ? amendValue : null;
    const target = input.fieldPath.match(/^(.*\/targets\/(?:include|exclude)\/[^/]+)\/(?:confirmation|guestName|bookedArrival|bookedDeparture)$/);
    const service = input.fieldPath.match(/^(\/proposal\/content\/services\/[^/]+)\/code$/);
    const selection = guest ? `${guest[1]}/nativeSelectionRef` : party ? `${party[1]}/nativeSelectionRef` : amendParty ? `${amendParty[1]}/nativeSelectionRef` :
      target ? `${target[1]}/suggestedRef` : service ? `${service[1]}/itemCandidateRef` : null;
    const selections = new Set(selection ? [selection] : []);
    if (target) {
      const parts = pathParts(input.fieldPath);
      const request = current.proposal.content.requests.find(row => row.id === parts?.[3]);
      if (request?.kind === 'filing' && parts) {
        const rows = effectiveSavedTargetRows(current, request.id), key = parts[7]!;
        const index = /^\d+$/.test(key) ? Number(key) : rows.findIndex(row =>
          row && typeof row === 'object' && (row as { id?: unknown }).id === key);
        const row = rows[index] as { id?: unknown } | undefined;
        if (typeof row?.id === 'string') {
          const root = `/proposal/content/requests/${encodeURIComponent(request.id)}/body/targets/include`;
          selections.add(`${root}/${index}/suggestedRef`);
          selections.add(`${root}/${encodeURIComponent(row.id)}/suggestedRef`);
        }
      }
    }
    const oldPartyName = party || amendParty ? effectiveDraftPath(current, input.fieldPath) : undefined;
    const partyName = (value: unknown) => String(value && typeof value === 'object' && 'name' in value
      ? value.name ?? '' : value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    const unchangedPartyName = Boolean(party || amendParty) && input.override.state === 'set' &&
      Boolean(partyName(oldPartyName)) && partyName(oldPartyName) === partyName(input.override.value);
    const quoteParty = input.fieldPath.match(/^\/proposal\/content\/requests\/([^/]+)\/body\/parties\/(?:organization|bookingAgency)(?:\/name)?$/);
    const quotePartyKey = quoteParty ? decodeURIComponent(quoteParty[1]!) : null;
    const quotePartyRequest = quotePartyKey
      ? current.proposal.content.requests.find(row => row.id === quotePartyKey) ??
        (/^\d+$/.test(quotePartyKey) ? current.proposal.content.requests[Number(quotePartyKey)] : undefined)
      : undefined;
    if (quoteParty && quotePartyRequest?.kind === 'quote' && !input.fieldPath.endsWith('/name')) {
      for (const path of Object.keys(fieldOverrides)) if (path.startsWith(`${input.fieldPath}/`)) delete fieldOverrides[path];
    }
    for (const path of selections) {
      if (unchangedPartyName) {
        const override = current.fieldOverrides[path];
        const selected = effectiveDraftPath(current, path) ?? (override && override.state !== 'inherit' ? null
          : effectiveDraftPath(current, `${path.slice(0, -'/nativeSelectionRef'.length)}/suggestedRef`));
        if (typeof selected === 'string') fieldOverrides[path] = { state: 'set', value: selected, updatedAt: input.override.updatedAt };
        else if (override && override.state !== 'inherit') fieldOverrides[path] = quotePartyRequest?.kind === 'quote' && override.state === 'unknown'
          ? { state: 'none', updatedAt: input.override.updatedAt } : override;
        continue;
      }
      fieldOverrides[path] = { state: quotePartyRequest?.kind === 'quote' ? 'none' : 'unknown', updatedAt: input.override.updatedAt };
      delete staffReviews[path];
    }
    const quoteRate = input.fieldPath.match(/^(\/proposal\/content\/requests\/[^/]+\/body\/groups\/[^/]+)\/ratePlan$/);
    const quoteParts = quoteRate && pathParts(input.fieldPath);
    const quoteRequest = quoteParts && current.proposal.content.requests.find(row => row.id === quoteParts[3]);
    if (quoteRate && quoteRequest?.kind === 'quote') {
      const mealPlan = `${quoteRate[1]}/mealPlan`;
      fieldOverrides[mealPlan] = { state: 'unknown', updatedAt: input.override.updatedAt };
      delete staffReviews[mealPlan];
    }
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

function effectiveDraftPath(draft: ReservationWorkflowV2Draft, stablePath: string, indexPath = stablePath): unknown {
  const stable = stablePath.split('/').slice(1), indexed = indexPath.split('/').slice(1);
  if (stable.length !== indexed.length) return undefined;
  let value: unknown = draft, stablePrefix = '', indexPrefix = '';
  for (let position = 0; position < stable.length; position++) {
    const key = decodeURIComponent(stable[position]!);
    value = Array.isArray(value) ? (/^\d+$/.test(key) ? value[Number(key)] : value.find(row =>
      row && typeof row === 'object' && (row as { id?: unknown }).id === key))
      : value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    stablePrefix += `/${stable[position]}`;
    indexPrefix += `/${indexed[position]}`;
    const override = draft.fieldOverrides[stablePrefix] ?? draft.fieldOverrides[indexPrefix];
    if (override?.state === 'set') value = override.value;
    else if (override && override.state !== 'inherit') value = null;
  }
  return value;
}

function rebaseDraftAfterRequestRemoval(draft: ReservationWorkflowV2Draft, requestId: string): ReservationWorkflowV2Draft | null {
  const before = draft.proposal, after = structuredClone(before);
  after.content.requests = after.content.requests.filter(row => row.id !== requestId);
  const remap = <T>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).flatMap(([path, value]) => {
    const next = rebaseReservationV2Path(path, before, after);
    return next ? [[next, value]] : [];
  }));
  const remapRows = <T extends { path: string }>(values: T[]) => values.flatMap(row => {
    const path = rebaseReservationV2Path(row.path, before, after);
    return path ? [{ ...row, path }] : [];
  });
  const next = { ...draft, proposal: { ...after, annotations: remapRows(after.annotations),
    sourceClaims: remapRows(after.sourceClaims), issues: remapRows(after.issues) },
    fieldOverrides: remap(draft.fieldOverrides), staffReviews: remap(draft.staffReviews),
    fieldReviewRequirements: remap(draft.fieldReviewRequirements),
    observations: rebaseReservationV2Observations(draft, before, after) };
  return reservationWorkflowV2DraftSchema.safeParse(next).success ? next : null;
}

/** Keep an automatically separated Other task aligned with its quote claim after staff edits. */
function updateSeparatedQuoteMoney(current: ReservationWorkflowV2Draft, next: ReservationWorkflowV2Draft,
  fieldPath: string, override?: V2Override): ReservationWorkflowV2Draft | null {
  if (!override) return next;
  const parts = pathParts(fieldPath);
  if (!parts || parts[0] !== 'proposal' || parts[1] !== 'content' || parts[2] !== 'requests') return next;
  const requestIndex = /^\d+$/.test(parts[3] ?? '') ? Number(parts[3]) : -1;
  const request = current.proposal.content.requests.find(row => row.id === parts[3]) ??
    (requestIndex >= 0 ? current.proposal.content.requests[requestIndex] : undefined);
  if (request?.kind !== 'quote') return next;
  const indexedRequest = current.proposal.content.requests.indexOf(request);
  let claimIndexes: number[] = [];
  let changedHandling = false;
  if (parts.length === 5 && parts[4] === 'requestText') {
    claimIndexes = request.body.requestedMoney.map((_, index) => index);
  } else if (parts.length === 6 && parts[4] === 'body' && parts[5] === 'requestedMoney') {
    if (request.body.requestedMoney.some(claim => current.proposal.content.requests.some(row => row.kind === 'other' &&
        separatedQuoteMoneyLinked(row.body.separatedFrom, request.id, claim.id)))) return null;
    return next;
  } else if (parts[4] === 'body' && parts[5] === 'requestedMoney') {
    const claimIndex = /^\d+$/.test(parts[6] ?? '') ? Number(parts[6])
      : request.body.requestedMoney.findIndex(row => row.id === parts[6]);
    const field = parts[7];
    if (claimIndex < 0 || claimIndex >= request.body.requestedMoney.length ||
        (field && !['amount', 'currency', 'unit', 'scope', 'targetRefs', 'staffAllowanceType'].includes(field))) return next;
    claimIndexes = [claimIndex];
    changedHandling = field === 'staffAllowanceType';
  } else return next;

  const stableRoot = `/proposal/content/requests/${encodeURIComponent(request.id)}`;
  const indexedRoot = `/proposal/content/requests/${indexedRequest}`;
  const requestText = effectiveDraftPath(next, `${stableRoot}/requestText`, `${indexedRoot}/requestText`);
  const requestSummary = typeof requestText === 'string' ? requestText : request.requestText;
  let result = { ...next };
  for (const claimIndex of claimIndexes) {
    const claim = request.body.requestedMoney[claimIndex]!;
    const moneyStable = `${stableRoot}/body/requestedMoney/${claimIndex}`;
    const moneyIndexed = `${indexedRoot}/body/requestedMoney/${claimIndex}`;
    const link = current.proposal.content.requests.filter((row): row is Extract<typeof row, { kind: 'other' }> => row.kind === 'other' &&
      separatedQuoteMoneyLinked(row.body.separatedFrom, request.id, claim.id));
    if (!link.length) continue;
    const kind = effectiveDraftPath(result, `${moneyStable}/staffAllowanceType`, `${moneyIndexed}/staffAllowanceType`);
    if (['dinner', 'lunch', 'airport_transfer', 'office_transfer'].includes(String(kind))) {
      for (const other of link) {
        const root = `/proposal/content/requests/${encodeURIComponent(other.id)}`;
        const index = result.proposal.content.requests.findIndex(row => row.id === other.id);
        const indexed = `/proposal/content/requests/${index}`;
        const hasHistory = result.operationResults.some(row => row.requestId === other.id);
        const hasChildren = other.serviceRefs.length || other.documentRefs.length ||
          result.proposal.content.services.some(row => row.ownerRequestId === other.id) ||
          result.proposal.content.documents.some(row => row.ownerRequestId === other.id);
        const hasStaffText = [root, indexed].some(prefix => Object.keys(result.fieldOverrides)
          .some(path => path === prefix || path.startsWith(`${prefix}/`)) ||
          Object.keys(result.staffReviews).some(path => path === prefix || path.startsWith(`${prefix}/`)));
        if (hasHistory || hasChildren || hasStaffText) return null;
        const allowance = other.body.separatedFrom?.allowance;
        const remaining = allowance?.quoteRequestIds.filter(id => id !== request.id && result.proposal.content.requests.some(quote => {
          if (quote.kind !== 'quote' || quote.id !== id) return false;
          const index = quote.body.requestedMoney.findIndex(money => money.id === claim.id);
          if (index < 0) return false;
          const quoteIndex = result.proposal.content.requests.indexOf(quote);
          return effectiveDraftPath(result, `/proposal/content/requests/${encodeURIComponent(id)}/body/requestedMoney/${index}/staffAllowanceType`,
            `/proposal/content/requests/${quoteIndex}/body/requestedMoney/${index}/staffAllowanceType`) === 'unsupported';
        })) ?? [];
        if (allowance && remaining.length) {
          const proposal = structuredClone(result.proposal);
          const retained = proposal.content.requests.find(row => row.id === other.id);
          if (!retained || retained.kind !== 'other' || !retained.body.separatedFrom?.allowance) return null;
          const groupIds = new Set(proposal.content.requests.flatMap(quote => quote.kind === 'quote' && remaining.includes(quote.id)
            ? quote.body.groups.map(group => group.id) : []));
          retained.body.separatedFrom.allowance = { ...allowance, quoteRequestIds: remaining,
            groupIds: allowance.groupIds.filter(id => groupIds.has(id)) };
          result.proposal = proposal;
          continue;
        }
        const removed = rebaseDraftAfterRequestRemoval(result, other.id);
        if (!removed) return null;
        result = removed;
      }
      continue;
    }
    if (changedHandling) continue;
    for (const other of link) {
      if (result.operationResults.some(row => row.requestId === other.id && row.status !== 'failed')) return null;
      const otherIndex = result.proposal.content.requests.findIndex(row => row.id === other.id);
      const otherRoot = `/proposal/content/requests/${encodeURIComponent(other.id)}`;
      const otherIndexed = `/proposal/content/requests/${otherIndex}`;
      const textPath = `${otherRoot}/body/requestedText`, indexedTextPath = `${otherIndexed}/body/requestedText`;
      const priorText = effectiveDraftPath(current, textPath, indexedTextPath);
      const textParents = new Set([otherRoot, otherIndexed, `${otherRoot}/body`, `${otherIndexed}/body`]);
      if (Object.keys(current.fieldOverrides).some(path => textParents.has(path))) return null;
      const hasTextOverride = [textPath, indexedTextPath].some(path => Object.hasOwn(current.fieldOverrides, path));
      if ((typeof priorText === 'string' && priorText !== other.body.requestedText) ||
          hasTextOverride && typeof priorText !== 'string') return null;
      const readMoney = (key: string, fallback: unknown) => {
        const value = effectiveDraftPath(result, `${moneyStable}/${key}`, `${moneyIndexed}/${key}`);
        return value === undefined ? fallback : value;
      };
      const currency = readMoney('currency', claim.currency), amount = readMoney('amount', claim.amount),
        unit = readMoney('unit', claim.unit);
      const detail = [currency, amount, unit]
        .filter(value => value != null && typeof value !== 'object').map(value => String(value).trim()).join(' ');
      const generated = `Handle separately from the room quote: ${detail}. ${requestSummary}`.slice(0, 2000);
      const proposal = structuredClone(result.proposal);
      const target = proposal.content.requests.find(row => row.id === other.id);
      if (!target || target.kind !== 'other') return null;
      target.body.requestedText = generated;
      const allowance = target.body.separatedFrom?.allowance;
      if (allowance && kind === 'unsupported') {
        const ids = new Set(request.body.groups.map(group => group.id));
        const scope = readMoney('scope', claim.scope), refs = readMoney('targetRefs', claim.targetRefs);
        const selected = scope === 'overall' && Array.isArray(refs) && !refs.length ? [...ids]
          : scope === 'per_target' && Array.isArray(refs) ? [...ids].filter(id => refs.includes(id)) : [];
        allowance.groupIds = [...new Set([...allowance.groupIds.filter(id => !ids.has(id)), ...selected])];
      }
      const fieldOverrides = { ...result.fieldOverrides };
      for (const path of [textPath, indexedTextPath]) if (fieldOverrides[path]?.state === 'set') {
        fieldOverrides[path] = { ...fieldOverrides[path]!, value: generated, updatedAt: new Date().toISOString() };
      }
      const staffReviews = { ...result.staffReviews };
      for (const path of Object.keys(staffReviews)) if (path === textPath || path === indexedTextPath ||
          textPath.startsWith(`${path}/`) || indexedTextPath.startsWith(`${path}/`)) delete staffReviews[path];
      result = { ...result, proposal, fieldOverrides, staffReviews };
    }
  }
  return result;
}

async function mutateDraft(ctx: Context, input: MutationInput & { fieldPath: string; override?: V2Override;
  review?: ReservationWorkflowV2Draft['staffReviews'][string]; eventType: 'field.edit' | 'field.accept' | 'field.reject';
  value: unknown }): Promise<ReservationWorkflowV2StateResult> {
  return withLockedV2DraftMutation(ctx, input, { fieldPath: input.fieldPath, eventType: input.eventType,
    value: input.value, apply: (draft) => {
      if (!(input.review ? reviewablePath(draft, input.fieldPath) : editablePath(draft, input.fieldPath))) return null;
      if (input.override && (!validStructuredEdit(draft, input.fieldPath, input.override) ||
          !validServiceTargetEdit(draft, input.fieldPath, input.override) || !safeSavedTargetEdit(draft, input.fieldPath) ||
          !validCancelIncludeEdit(draft, input.fieldPath, input.override) || !validCancelExcludeEdit(draft, input.fieldPath, input.override) ||
          !validAmendTargetScopeEdit(draft, input.fieldPath, input.override) ||
          !validCancelPreviewEdit(draft, input.fieldPath, input.override))) return null;
      if (input.override && /^\/proposal\/content\/requests\/[^/]+\/body\/targets\/(?:include|exclude)$/.test(input.fieldPath)) {
        const next = applySavedTargetScopeEdit(draft, input.fieldPath, input.override);
        return next ? { draft: next } : null;
      }
      if (input.override && /^\/proposal\/content\/services\/[^/]+\/targets$/.test(input.fieldPath)) {
        const next = applyServiceTargetEdit(draft, input.fieldPath, input.override);
        return next ? { draft: next } : null;
      }
      const edited = updateDraft(draft, input);
      const next = updateSeparatedQuoteMoney(draft, edited, input.fieldPath, input.override);
      if (!next) return null;
      if (input.override && draft.operationResults.some((row) => row.workflow === 'amend' &&
          (row.status === 'succeeded' || row.status === 'unknown')) &&
          !nativeStructureIsSafe({ reservationWorkflowV2: draft }, { reservationWorkflowV2: next })) return null;
      return { draft: next };
    } });
}

export async function editReservationWorkflowV2Draft(ctx: Context, input: MutationInput & {
  fieldPath: string; value: unknown;
}): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  const current = await getReservationWorkflowV2Draft(ctx, input, { allowSourceChanged: true });
  if (current.status !== 'ok') return current;
  if (!editablePath(current.draft, input.fieldPath)) return { status: 'invalid_path' };
  const override = validateOverride(input.value);
  if (!override || !validCancelIncludeEdit(current.draft, input.fieldPath, override) ||
      !validCancelExcludeEdit(current.draft, input.fieldPath, override) ||
      !validAmendTargetScopeEdit(current.draft, input.fieldPath, override) ||
      !validCancelPreviewEdit(current.draft, input.fieldPath, override)) return { status: 'invalid_value' };
  return mutateDraft(ctx, { ...input, override, eventType: 'field.edit', value: override });
}

/** Bind one staff-selected source attachment and an exact confirmation without a native write. */
export async function configureReservationWorkflowV2Filing(ctx: Context, input: MutationInput & {
  requestId: string; attachmentId: string; confirmation?: string; guestName?: string;
  bookedArrival?: string; bookedDeparture?: string;
  allocationTarget?: { requestId: string; allocationId: string }; kind: 'voucher' | 'payment_proof';
}): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  const isoDay = (value: unknown) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  const staffHint = input.confirmation != null ? { guestName: input.guestName,
    bookedArrival: input.bookedArrival, bookedDeparture: input.bookedDeparture } : {};
  if (!ctx.userId || Boolean(input.confirmation) === Boolean(input.allocationTarget) ||
      (input.confirmation != null && !/^\d+-\d+$/.test(input.confirmation)) || !input.attachmentId ||
      (input.allocationTarget != null && (input.guestName !== undefined || input.bookedArrival !== undefined || input.bookedDeparture !== undefined)) ||
      (staffHint.guestName !== undefined && (typeof staffHint.guestName !== 'string' || !staffHint.guestName.trim() || staffHint.guestName.length > 300)) ||
      (staffHint.bookedArrival !== undefined && !isoDay(staffHint.bookedArrival)) ||
      (staffHint.bookedDeparture !== undefined && (!isoDay(staffHint.bookedDeparture) ||
        !isoDay(staffHint.bookedArrival) || staffHint.bookedDeparture! <= staffHint.bookedArrival!))) return { status: 'invalid_value' };
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
    if (input.allocationTarget) {
      const create = draft.proposal.content.requests.find(row => row.kind === 'create' && row.id === input.allocationTarget!.requestId);
      if (!create || create.kind !== 'create' || create.body.allocations.filter(row => row.id === input.allocationTarget!.allocationId).length !== 1)
        return { status: 'invalid_value' as const };
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const targetKey = input.allocationTarget ? `${input.allocationTarget.requestId}:${input.allocationTarget.allocationId}` : input.confirmation!;
    const targetId = `staff_target_${hash(`${request.id}\u001f${targetKey}`).slice(0, 20)}`;
    const documentId = `staff_document_${hash(`${request.id}\u001f${file.id}\u001f${targetKey}`).slice(0, 20)}`;
    const documentSourceRef = `src_${hash(`${input.source.messageId}\u001fattachment_text\u001f${file.id}`).slice(0, 12)}`;
    const document = { id: documentId, ownerRequestId: request.id, documentSourceRef, kind: input.kind,
      handling: 'filing_requested' as const,
      targetRefs: [{ kind: 'saved_target' as const, requestId: request.id, hintId: targetId },
        ...(input.allocationTarget ? [{ kind: 'allocation' as const, ...input.allocationTarget }] : [])],
      requestedName: null, requestedDescription: null, uploadArtifactRef: null, sourceRefs: [] };
    const existing = draft.proposal.content.documents.find((row) => row.id === documentId);
    if (existing && (existing.ownerRequestId !== request.id || existing.documentSourceRef !== documentSourceRef ||
        !existing.targetRefs.some((ref) => ref.kind === 'saved_target' && ref.requestId === request.id && ref.hintId === targetId))) {
      return { status: 'invalid_value' as const };
    }
    if (!existing && draft.proposal.content.documents.length >= 200) return { status: 'invalid_value' as const };
    const root = `/proposal/content/requests/${encodeURIComponent(request.id)}`;
    const docsPath = `${root}/documentRefs`, targetsPath = `${root}/body/targets`, allocationPath = `${root}/body/allocationTarget`;
    const docRoot = `/proposal/content/documents/${encodeURIComponent(documentId)}`;
    const now = new Date().toISOString();
    const overrides = { ...draft.fieldOverrides }, reviews = { ...draft.staffReviews };
    // Configuration replaces the whole target selection; no old candidate or review may authorize it.
    for (const path of Object.keys(overrides)) if (path === targetsPath || path.startsWith(`${targetsPath}/`)) delete overrides[path];
    for (const path of Object.keys(reviews)) if (path === targetsPath || path.startsWith(`${targetsPath}/`)) delete reviews[path];
    overrides[docsPath] = { state: 'set', value: [documentId], updatedAt: now };
    overrides[allocationPath] = input.allocationTarget ? { state: 'set', value: input.allocationTarget, updatedAt: now }
      : { state: 'unknown', updatedAt: now };
    overrides[targetsPath] = { state: 'set', value: { mode: 'explicit', include: [{ id: targetId,
      ...(input.confirmation ? { confirmation: input.confirmation } : {}),
      ...(staffHint.guestName ? { guestName: staffHint.guestName.trim() } : {}),
      ...(staffHint.bookedArrival ? { bookedArrival: staffHint.bookedArrival } : {}),
      ...(staffHint.bookedDeparture ? { bookedDeparture: staffHint.bookedDeparture } : {}),
      candidateRefs: [], suggestedRef: null, sourceRefs: [] }], exclude: [], sourceRefs: [] }, updatedAt: now };
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
    const nextState = withReservationWorkflowV2Draft(item.state, next);
    const advanced = advancePaneRevision({ revision: item.revision, revisionHead: item.revisionHead,
      seq: item.revisionSeq, previousState: item.state, nextState, extractionId: item.extractionId });
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'user', actorUserId: ctx.userId,
      type: 'field.edit', fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:${root}/filingSelection`,
      value: { requestId: request.id, attachmentId: file.id, ...(input.confirmation ? { confirmation: input.confirmation,
        ...(staffHint.guestName ? { guestName: staffHint.guestName.trim() } : {}),
        ...(staffHint.bookedArrival ? { bookedArrival: staffHint.bookedArrival } : {}),
        ...(staffHint.bookedDeparture ? { bookedDeparture: staffHint.bookedDeparture } : {}) } : { allocationTarget: input.allocationTarget }), kind: input.kind },
      evidence: { ...advanced.evidence, trace: reservationWorkflowV2EditTrace(draft, `${root}/filingSelection`).trace } });
    await tx.update(workItem).set({ state: nextState, revision: advanced.revision, revisionHead: advanced.revisionHead,
      revisionSeq: item.revisionSeq + 1, updatedAt: new Date() }).where(eq(workItem.id, item.id));
    return { status: 'ok' as const, draft: next, revision: advanced.revision,
      revisionHead: advanced.revisionHead, seq: item.revisionSeq + 1 };
  });
}

export async function reviewReservationWorkflowV2Draft(ctx: Context, input: MutationInput & {
  fieldPath: string; decision: 'accepted' | 'flagged'; note?: string | null;
}): Promise<ReservationWorkflowV2StateResult> {
  const current = await getReservationWorkflowV2Draft(ctx, input, { allowSourceChanged: true });
  if (current.status !== 'ok') return current;
  if (!reviewablePath(current.draft, input.fieldPath)) return { status: 'invalid_path' };
  const review = { status: input.decision, note: input.note ?? null, at: new Date().toISOString() } as const;
  return mutateDraft(ctx, { ...input, review, eventType: input.decision === 'accepted' ? 'field.accept' : 'field.reject', value: review });
}

export async function moveReservationWorkflowV2History(ctx: Context, input: MutationInput & {
  direction: 'undo' | 'redo';
}): Promise<ReservationWorkflowV2StateResult | { status: 'at_boundary' | 'history_stale'; revision: number; revisionHead: number; seq: number }> {
  const current = await getReservationWorkflowV2Draft(ctx, input, { allowSourceChanged: true });
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
  return getReservationWorkflowV2Draft(ctx, input, { allowSourceChanged: true });
}

/** Server-owned additions never replace staff overrides/reviews and are deliberately outside undo history. */
async function bufferedNativeResult(ctx: Context, input: { workItemId: string; source: ReservationWorkflowV2SourceInput }) {
  const batch = ctx.nativeBatch!;
  if (batch.signal.aborted) return { status: 'stale_revision' as const };
  const current = await getReservationWorkflowV2Draft({ ...ctx, nativeBatch: undefined }, input);
  if (current.status !== 'ok') return current;
  if (current.revision !== batch.expectedRevision || current.seq !== batch.expectedSeq ||
      current.draft.generationId !== batch.generationId || current.draft.prefill?.status !== 'running' ||
      current.draft.prefill.phase !== 'native_checks' || current.draft.prefill.jobRunId !== batch.jobFence.runId)
    return { status: 'stale_revision' as const };
  return { ...current, draft: reservationWorkflowV2DraftSchema.parse({ ...current.draft,
    observations: [...current.draft.observations, ...batch.observations],
    operationResults: [...current.draft.operationResults.filter((entry) => !batch.results.some((result) => result.id === entry.id)),
      ...batch.results] }) };
}

// Callback claims/results do not advance the editable draft revision. Recheck
// these hints under the same row lock as persistence, including batch commits.
function currentSavedAmendBaselineHint(draft: ReservationWorkflowV2Draft, hint: ReservationWorkflowV2Observation): boolean {
  if (hint.criteria.binding !== 'saved_amend_baseline') return true;
  const prepare = draft.observations.find(row => row.ref === hint.criteria.prepareRef);
  const target = draft.observations.find(row => row.ref === hint.criteria.selectedRef);
  const preparedAt = prepare ? Date.parse(prepare.observedAt) : NaN;
  if (!prepare || !target || !Number.isFinite(preparedAt) || hint.criteria.draftRevision !== draft.revision ||
      prepare.kind !== 'rate_availability' || prepare.status !== 'complete' || !prepare.coverage.complete ||
      prepare.result.outcome !== 'prepared' || prepare.generationId !== draft.generationId ||
      prepare.criteria.selectedRef !== target.ref || prepare.criteria.requestId !== hint.criteria.requestId ||
      prepare.criteria.hintId !== hint.criteria.hintId || prepare.criteria.draftRevision !== draft.revision ||
      target.kind !== 'stay_candidate' || target.status !== 'complete' || target.generationId !== draft.generationId ||
      !draft.operationResults.some(row => row.workflow === 'amend' && row.status === 'prepared' &&
        row.requestId === hint.criteria.requestId && row.allocationId === hint.criteria.hintId && row.observationRefs.includes(prepare.ref))) return false;
  return !draft.operationResults.some(row => row.workflow === 'amend' && row.generationId === draft.generationId &&
    (row.status === 'unknown' || (row.status === 'prepared' &&
      row.summary === 'Native details may have changed; review the refreshed price before Save') ||
      (row.status === 'succeeded' && Date.parse(row.updatedAt) >= preparedAt)));
}

/** Commit one completed native check and its evidence as a single fenced transaction. */
export async function commitReservationNativeCheck(ctx: Context, input: {
  workItemId: string; source: ReservationWorkflowV2SourceInput; batch: ReservationNativeCheckBatch;
  check?: { key: string; status: string; issue: string | null }; begin?: string;
  recoveryHeartbeat?: string; finish?: boolean;
}): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  return ctx.db.transaction(async (tx) => {
    await lockCanonicalMailbox(tx as unknown as DB, ctx.transportId);
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    if (!(await currentPrefillJob(tx, input.batch.jobFence, input.source.messageId))) return { status: 'stale_revision' as const };
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok') return current;
    const meta = current.draft.prefill;
    if (item.revision !== input.batch.expectedRevision || item.revisionSeq !== input.batch.expectedSeq ||
        current.draft.generationId !== input.batch.generationId || meta?.status !== 'running' ||
        meta.phase !== 'native_checks' || meta.jobRunId !== input.batch.jobFence.runId)
      return { status: 'stale_revision' as const };
    if (input.batch.signal.aborted || (!input.check && (input.batch.observations.length || input.batch.results.length)))
      return { status: 'stale_revision' as const };
    const active = meta.nativeActive;
    if (input.begin && (active || input.check || input.finish || input.recoveryHeartbeat)) return { status: 'invalid_value' as const };
    if (input.check && input.check.key !== 'native:unrun' && (!active || active.key !== input.check.key))
      return { status: 'stale_revision' as const };
    const activeStart = active ? Date.parse(active.startedAt) : 0;
    const recoveredAt = input.recoveryHeartbeat ? Date.parse(input.recoveryHeartbeat) : NaN;
    // A heartbeat is emitted every 20s. Charge the whole interval after the last one on recovery.
    const elapsed = active && !input.begin ? Math.max(0, (Number.isFinite(recoveredAt) ? recoveredAt + 20_000 : Date.now()) - activeStart) : 0;
    const nativeSpentMs = Math.min(420_000, (meta.nativeSpentMs ?? 0) + elapsed);
    const checks = meta.nativeChecks ?? [];
    const alreadyChecked = Boolean(input.check && checks.some((check) => check.key === input.check!.key));
    if (alreadyChecked && !input.finish) return current;
    const observations = [...current.draft.observations];
    for (const observation of input.batch.observations) {
      const parsed = reservationWorkflowV2ObservationSchema.safeParse(observation);
      if (!parsed.success || parsed.data.generationId !== current.draft.generationId ||
          parsed.data.propertyCode !== ctx.propertyCode || parsed.data.sourceMessageId !== input.source.messageId ||
          observations.some((entry) => entry.ref === parsed.data.ref) ||
          parsed.data.sourceRefs.some((ref) => !observations.some((entry) => entry.ref === ref))) return { status: 'invalid_value' as const };
      if (!currentSavedAmendBaselineHint({ ...current.draft, observations,
        operationResults: [...current.draft.operationResults, ...input.batch.results] }, parsed.data)) continue;
      observations.push(parsed.data);
    }
    const results = [...current.draft.operationResults];
    for (const result of input.batch.results) {
      if (!['prepared', 'failed'].includes(result.status) || result.generationId !== current.draft.generationId || result.draftRevision !== item.revision ||
          result.observationRefs.some((ref) => !observations.some((entry) => entry.ref === ref)) ||
          results.some((entry) => entry.id === result.id && (entry.status === 'succeeded' ||
            entry.requestId !== result.requestId || entry.allocationId !== result.allocationId || entry.workflow !== result.workflow)))
        return { status: 'invalid_value' as const };
      const old = results.findIndex((entry) => entry.id === result.id);
      if (old >= 0) results.splice(old, 1);
      results.push(result);
    }
    const next = reservationWorkflowV2DraftSchema.safeParse({ ...current.draft, observations, operationResults: results,
      status: current.draft.status === 'ready' && input.check && !['ok', 'prepared', 'priced', 'found', 'matches', 'candidate'].includes(input.check.status)
        ? 'partial' : current.draft.status,
      prefill: { ...meta, nativeSpentMs, nativeActive: input.begin ? { key: input.begin, startedAt: new Date().toISOString() } : null,
        nativeChecks: input.check && !alreadyChecked ? [...checks, input.check] : checks,
        ...(input.finish ? { status: 'complete', phase: 'complete', finishedAt: new Date().toISOString() } : {}) } });
    if (!next.success) return { status: 'invalid_value' as const };
    input.batch.signal.throwIfAborted();
    if (input.check) await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'system', type: 'hms.lookup.finished',
      value: { check: input.check.key, status: input.check.status, observations: input.batch.observations
        .filter(entry => observations.some(row => row.ref === entry.ref)).map(entry => entry.ref),
        results: input.batch.results.map((entry) => entry.id) },
      evidence: { sourceHash: input.source.sourceHash, generationId: current.draft.generationId } });
    input.batch.signal.throwIfAborted();
    await tx.update(workItem).set({ state: withReservationWorkflowV2Draft(item.state, next.data),
      updatedAt: new Date() }).where(eq(workItem.id, item.id));
    input.batch.signal.throwIfAborted();
    return { ...current, draft: next.data };
  });
}

export async function appendReservationWorkflowV2Observation(ctx: Context, input: {
  workItemId: string; source: ReservationWorkflowV2SourceInput;
  observation: ReservationWorkflowV2Observation;
  fence?: { expectedRevision: number; expectedSeq: number; generationId: string; signal: AbortSignal };
}): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  const parsed = reservationWorkflowV2ObservationSchema.safeParse(input.observation);
  if (!parsed.success || parsed.data.propertyCode !== ctx.propertyCode) return { status: 'invalid_value' };
  if (ctx.nativeBatch) {
    if (input.fence) return { status: 'invalid_value' };
    const current = await bufferedNativeResult(ctx, input);
    if (current.status !== 'ok') return current;
    if (parsed.data.generationId !== current.draft.generationId || parsed.data.sourceMessageId !== input.source.messageId ||
        current.draft.observations.some((entry) => entry.ref === parsed.data.ref) ||
        parsed.data.sourceRefs.some((ref) => !current.draft.observations.some((entry) => entry.ref === ref)) ||
        !currentSavedAmendBaselineHint(current.draft, parsed.data)) return { status: 'invalid_value' };
    ctx.nativeBatch.observations.push(parsed.data);
    return bufferedNativeResult(ctx, input);
  }
  const cancelled = Symbol('observation_cancelled');
  try { return await ctx.db.transaction(async (tx) => {
    if (input.fence) {
      await lockCanonicalMailbox(tx as unknown as DB, ctx.transportId);
      await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
      if (input.fence.signal.aborted) return { status: 'stale_revision' as const };
    }
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok') return current;
    if (input.fence && (input.fence.signal.aborted || item.revision !== input.fence.expectedRevision ||
        item.revisionSeq !== input.fence.expectedSeq || current.draft.generationId !== input.fence.generationId))
      return { status: 'stale_revision' as const };
    const existingRefs = new Set(current.draft.observations.map((entry) => entry.ref));
    if (parsed.data.generationId !== current.draft.generationId ||
        (input.fence && parsed.data.sourceMessageId !== input.source.messageId) ||
        parsed.data.sourceRefs.some((ref) => !existingRefs.has(ref)) || existingRefs.has(parsed.data.ref) ||
        !currentSavedAmendBaselineHint(current.draft, parsed.data)) {
      return { status: 'invalid_value' as const };
    }
    const next = reservationWorkflowV2DraftSchema.parse({ ...current.draft, observations: [...current.draft.observations, parsed.data] });
    const nextState = withReservationWorkflowV2Draft(item.state, next);
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'system', type: 'hms.lookup.finished',
      value: { ref: parsed.data.ref, kind: parsed.data.kind, status: parsed.data.status },
      evidence: { sourceHash: input.source.sourceHash, observedAt: parsed.data.observedAt } });
    if (input.fence?.signal.aborted) throw cancelled;
    await tx.update(workItem).set({ state: nextState, updatedAt: new Date() }).where(eq(workItem.id, item.id));
    if (input.fence?.signal.aborted) throw cancelled;
    return { status: 'ok' as const, draft: next, revision: item.revision, revisionHead: item.revisionHead, seq: item.revisionSeq };
  }); } catch (error) {
    if (error === cancelled) return { status: 'stale_revision' };
    throw error;
  }
}

/** Claim an allocation before native dispatch. The claim and attempt ID survive a process crash. */
export async function claimReservationWorkflowV2GuestProfile(ctx: Context, input: MutationInput & {
  requestId: string; allocationId: string; idempotencyKey: string; prepareRef: string;
}, validate: (draft: ReservationWorkflowV2Draft) => boolean): Promise<ReservationWorkflowV2StateResult & { alreadyClaimed?: boolean }> {
  if (!ctx.userId || !propertyMatches(ctx)) return { status: 'wrong_property' };
  return ctx.db.transaction(async (tx) => {
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok') return current;
    const prior = current.draft.operationResults.find((row) => row.id === input.idempotencyKey);
    if (prior) {
      return prior.workflow === 'guest_profile' && prior.requestId === input.requestId &&
        prior.allocationId === input.allocationId && prior.observationRefs.includes(input.prepareRef)
        ? { ...current, alreadyClaimed: true } : { status: 'invalid_value' as const };
    }
    if (item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq) return { status: 'stale_revision' as const };
    if (!validate(current.draft) || current.draft.operationResults.some((row) => row.workflow === 'guest_profile' &&
      row.requestId === input.requestId && row.allocationId === input.allocationId &&
      (row.status === 'unknown' || row.status === 'succeeded'))) return { status: 'invalid_value' as const };
    const result = { id: input.idempotencyKey, generationId: current.draft.generationId, requestId: input.requestId,
      allocationId: input.allocationId, workflow: 'guest_profile' as const, status: 'unknown' as const,
      draftRevision: item.revision, observationRefs: [input.prepareRef], updatedAt: new Date().toISOString(),
      summary: 'Guest profile creation claimed; outcome pending reconciliation' };
    const next = reservationWorkflowV2DraftSchema.parse({ ...current.draft,
      operationResults: [...current.draft.operationResults, result] });
    await tx.update(workItem).set({ state: withReservationWorkflowV2Draft(item.state, next), updatedAt: new Date() })
      .where(eq(workItem.id, item.id));
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'system', type: 'write.evidence',
      fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:operationResults:${result.id}`,
      value: { id: result.id, workflow: result.workflow, requestId: result.requestId, allocationId: result.allocationId,
        status: result.status, observationRefs: result.observationRefs }, evidence: { sourceHash: input.source.sourceHash } });
    return { ...current, draft: next };
  });
}

/** Keep the actual native request inside a live staff, source and allocation fence. */
export async function dispatchReservationWorkflowV2GuestProfile<T>(ctx: Context & {
  userId: string; sessionId: string; sessionProfile: 'legacy' | 'remote';
}, input: MutationInput, validate: (draft: ReservationWorkflowV2Draft) => boolean,
proceed: () => Promise<T>, phase: 'initial' | 'confirm_distinct'): Promise<T> {
  if (ctx.recovery) throw new Error('guest_profile_recovery_cannot_dispatch');
  const fence = ctx.writeRunFence;
  if (!fence) throw new Error('staff_go_required');
  ctx.signal?.throwIfAborted();
  await ctx.db.transaction(async (tx) => {
    await consumeStaffGoAtDispatch(tx, fence, ctx.signal, undefined, phase);
    await lockReservationWorkflowV2Source(tx, ctx.transportId, input.source.messageId);
    await lockCreateActorAccess(tx, { transportId: ctx.transportId, actorUserId: ctx.userId });
    await lockCreateActorSession(tx, { actorUserId: ctx.userId, sessionId: ctx.sessionId, sessionProfile: ctx.sessionProfile });
    const [thread] = await tx.select({ id: mailThread.id }).from(mailThread)
      .where(and(eq(mailThread.id, input.source.threadId), eq(mailThread.transportId, ctx.transportId))).limit(1).for('share');
    const [source] = await tx.select({ id: message.id }).from(message)
      .where(and(eq(message.id, input.source.messageId), eq(message.threadId, input.source.threadId),
        eq(message.transportId, ctx.transportId))).limit(1).for('share');
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!thread || !source || !item || item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq) {
      throw new Error('guest_profile_authority_stale');
    }
    const current = await buildResult(tx, ctx, item, input.source);
    if (current.status !== 'ok' || !validate(current.draft)) throw new Error('guest_profile_authority_stale');
  });
  ctx.signal?.throwIfAborted();
  return proceed();
}

/** Persist the ID and its selection together, independently of the editable revision cursor. */
export async function finishReservationWorkflowV2GuestProfile(ctx: Context, input: {
  workItemId: string; source: ReservationWorkflowV2SourceInput; operationId: string;
  status: 'succeeded' | 'failed' | 'unknown'; summary: string; observation?: ReservationWorkflowV2Observation;
}): Promise<ReservationWorkflowV2StateResult> {
  if (!ctx.userId || !propertyMatches(ctx)) return { status: 'wrong_property' };
  return ctx.db.transaction(async (tx) => {
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item || !(await hasMailboxAccess(tx, ctx))) return { status: 'not_found' as const };
    if (ctx.recovery) {
      if (ctx.recovery.operationId !== input.operationId) return { status: 'invalid_source' as const };
      const checked = await buildResult(tx, ctx, item, input.source);
      if (checked.status !== 'ok') return checked;
    }
    const draft = reservationWorkflowV2DraftOf(item.state);
    if (!draft || draft.transportId !== ctx.transportId || draft.propertyCode !== ctx.propertyCode ||
      draft.source.threadId !== input.source.threadId || draft.source.messageId !== input.source.messageId ||
      draft.source.sourceHash !== input.source.sourceHash || draft.source.arrivedAt !== input.source.arrivedAt) {
      return { status: 'invalid_source' as const };
    }
    const operation = draft.operationResults.find((row) => row.id === input.operationId && row.workflow === 'guest_profile');
    if (!operation) return { status: 'not_found' as const };
    if (operation.status === 'succeeded' || (operation.status === 'failed' && input.status === 'unknown')) {
      return { status: 'ok' as const, draft, revision: item.revision,
      revisionHead: item.revisionHead, seq: item.revisionSeq };
    }
    const observation = input.observation;
    const request = draft.proposal.content.requests.find((row) => row.id === operation.requestId);
    const index = request?.kind === 'create' ? request.body.allocations.findIndex((row) => row.id === operation.allocationId) : -1;
    if (index < 0 || !request || request.kind !== 'create' || (input.status === 'succeeded' && !observation)) {
      return { status: 'invalid_value' as const };
    }
    if (observation && (observation.generationId !== draft.generationId || observation.propertyCode !== ctx.propertyCode ||
        observation.sourceMessageId !== input.source.messageId || observation.criteria.requestId !== operation.requestId ||
        observation.criteria.allocationId !== operation.allocationId)) return { status: 'invalid_value' as const };
    const observations = observation && !draft.observations.some((row) => row.ref === observation.ref)
      ? [...draft.observations, observation] : draft.observations;
    const nextResult = { ...operation, status: input.status, updatedAt: new Date().toISOString(), summary: input.summary.slice(0, 2000),
      observationRefs: [...new Set([...operation.observationRefs, ...(observation ? [observation.ref] : [])])] };
    const fieldOverrides = { ...draft.fieldOverrides }, staffReviews = { ...draft.staffReviews };
    if (input.status === 'succeeded' && observation) {
      const path = `/proposal/content/requests/${encodeURIComponent(operation.requestId)}/body/allocations/${index}/guest`;
      const at = nextResult.updatedAt;
      fieldOverrides[`${path}/nativeSelectionRef`] = { state: 'set', value: observation.ref, updatedAt: at };
      fieldOverrides[`${path}/profileIntent`] = { state: 'set', value: 'existing_or_unknown', updatedAt: at };
      staffReviews[`${path}/nativeSelectionRef`] = { status: 'accepted', note: 'Created and verified in Infor', at };
    }
    const next = reservationWorkflowV2DraftSchema.parse({ ...draft, revision: item.revision, observations, fieldOverrides, staffReviews,
      operationResults: draft.operationResults.map((row) => row.id === operation.id ? nextResult : row) });
    await tx.update(workItem).set({ state: withReservationWorkflowV2Draft(item.state, next), updatedAt: new Date() })
      .where(eq(workItem.id, item.id));
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'system', type: 'write.evidence',
      fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:operationResults:${operation.id}`,
      value: { id: operation.id, workflow: operation.workflow, status: input.status, observationRefs: nextResult.observationRefs },
      evidence: { sourceHash: input.source.sourceHash, summary: nextResult.summary } });
    return { status: 'ok' as const, draft: next, revision: item.revision, revisionHead: item.revisionHead, seq: item.revisionSeq };
  });
}

export async function recordReservationWorkflowV2Result(ctx: Context, input: {
  workItemId: string; source: ReservationWorkflowV2SourceInput;
  result: ReservationWorkflowV2Draft['operationResults'][number];
}): Promise<ReservationWorkflowV2StateResult> {
  if (!propertyMatches(ctx)) return { status: 'wrong_property' };
  if (ctx.nativeBatch) {
    const current = await bufferedNativeResult(ctx, input);
    if (current.status !== 'ok') return current;
    if (input.result.generationId !== current.draft.generationId || input.result.draftRevision !== current.revision ||
        input.result.observationRefs.some((ref) => !current.draft.observations.some((entry) => entry.ref === ref))) return { status: 'invalid_value' };
    ctx.nativeBatch.results.push(input.result);
    return bufferedNativeResult(ctx, input);
  }
  return ctx.db.transaction(async (tx) => {
    const item = await loadItem(tx, ctx, input.workItemId, true);
    if (!item) return { status: 'not_found' as const };
    if (!(await hasMailboxAccess(tx, ctx))) return { status: 'not_found' as const };
    if (ctx.recovery) {
      if (ctx.recovery.operationId !== input.result.id) return { status: 'invalid_source' as const };
      const checked = await buildResult(tx, ctx, item, input.source);
      if (checked.status !== 'ok') return checked;
    }
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
    const nextState = withReservationWorkflowV2Draft(item.state, next);
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
