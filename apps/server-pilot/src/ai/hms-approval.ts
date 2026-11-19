import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type DB } from '../db/client.js';
import { aiWorkflowRun, mailboxAccess, mailboxTransport, mailThread, message } from '../db/schema/mail.js';
import { remoteSession, session } from '../db/schema/auth.js';
import { workEvent, workItem } from '../db/schema/work.js';
import { parseEnv } from '../env.js';
import { lockCanonicalMailbox } from '../mail/ingest/canonical-identity.js';
import { canonicalMessageId } from '../mail/ingest/message-id.js';
import { S3KeyExistsError, getS3Storage, type S3Storage } from '../storage/s3.js';
import { maskCardNumbers } from './card-mask.js';
import { canonicalJson } from './draft-approval.js';
import { CENTURION_HMS_READ_TARGET } from '../hms/hms-read-target.js';
import { paneWriteMode } from './pane-stay-save.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { publicCloudAmendFields, retainedPricesForApproval } from './cloud-amend-price-projection.js';
import { HMS_LABTEST_AMEND_PROMPT_VERSION } from './pane-cloud-amend-readiness.js';
import type { CreateFenceTransaction } from './pane-create-dispatch-fence.js';
import { lockCreateActorAccess, lockCreateActorSession } from './pane-create-actor-lock.js';
import { propertyCodeSchema, resolvePropertyScope, type PropertySwitch } from '../hms/property-registry.js';
import { effectiveWorkflowPolicy } from '../../tooling/hms-cloud/hms-workflow-policy.mjs';
import { hmsOperationSchema, hmsPreparationSchema, hmsWriteGrantV2Schema, loadHmsPreparation,
  preparationDigest, recordHmsPreparation, staffSessionSchema, preparedSummarySchema, hmsConfigurationIdentities, hmsWorkflowForOperation,
  type HmsPreparation, type PreparedSummary } from '../hms/hms-preparation.js';
import { propertyConfigurationForScope } from '../hms/rate-catalogue.js';
import { verifyStaffGoForRun, type VerifiedStaffGo } from '../hms/staff-go-authority.js';
import { hmsDispatchTargetKeys, hmsDispatchTargetSchema, hmsDispatchWorkItemKey } from './hms-dispatch-target.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import {
  HMS_WRITE_RUN_KIND,
  HMS_V2_WRITE_PROMPT_VERSION,
  HMS_CLOUD_CANCEL_PROMPT_VERSION,
  HMS_LABTEST_ATTACH_PROMPT_VERSION,
  NONTERMINAL_AI_RUN_STATES,
  NOT_APPLICABLE_MODEL_ID,
  enqueueAiRun,
  heartbeatAiRun,
  markAiRunDeadLetter,
  markAiRunPolicyRefused,
  type AiFailureClass,
  type AiRunFence,
} from './run-ledger.js';

/**
 * Server-made, single-use, state-bound approvals for HMS writes (R14, KTD11, KTD12).
 *
 * - approveHmsWrite is the only producer of approval.granted. It recomputes the form digest from stored
 *   work-item state and takes the HMS before-state digest from the snapshot, then enqueues one hms_write run
 *   in the same transaction.
 * - consumeHmsWriteApproval is the only consumer. The run's lease must still be held, and the grant must
 *   verify, be under 30 minutes old, match the current form, and be unused.
 * - assertHmsUnchangedBeforeSave is the last check before Save. A mismatch dead-letters the run to needs-check.
 * - hms_write runs are never reclaimed by claimNextAiRun. sweepLostHmsWriteLeases turns a lost lease into
 *   needs-check. Nothing re-runs a write automatically.
 * - resolveHmsNeedsCheck closes a blocking needs-check after an HMS re-read or a staff check with a note.
 *
 * Needs-check is derived from ai_workflow_run.failure_class and recorded as a work_event status.changed.
 * NEEDS_CHECK is for failures before Save, where nothing was written. LEASE_LOST means the outcome is unknown,
 * so approval stays blocked until someone reads the booking back.
 */

/** KTD11: a snapshot older than this is re-read before approval, and an approval ends with it. */
export const HMS_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;
export const HMS_WRITE_PROMPT_VERSION = 'hms-write/1';
/** Claimed before default-lane work in the hms lane. */
const HMS_WRITE_PRIORITY = 10;
/** Sealed evidence prefix. deploy/aws-resources.md expires it at 90 days. */
export const HMS_WRITE_EVIDENCE_PREFIX = 'hms-write-evidence/v1/';
/** The lifecycle rule on that prefix. Evidence sealed this long ago is reported as expired (the object is gone). */
export const HMS_WRITE_EVIDENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const EVIDENCE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,40}\.png$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HMS_SNAPSHOT_KEY = 'hmsSnapshot';
/** Approval stays blocked while the outcome of the last write is unknown. */
const BLOCKING_FAILURE_CLASSES: ReadonlySet<string> = new Set<AiFailureClass>(['LEASE_LOST']);

export type HmsApprovalRefusal =
  | 'not_found'
  | 'not_open'
  | 'source_mail_missing'
  | 'source_mail_changed'
  | 'write_in_flight'
  | 'needs_check_open'
  | 'snapshot_missing'
  | 'snapshot_stale'
  | 'no_grant'
  | 'state_changed'
  | 'already_consumed'
  | 'lease_lost'
  | 'not_consumed'
  | 'evidence_invalid'
  | 'evidence_exists'
  | 'no_needs_check'
  | 'note_required'
  | 'no_executed_write'
  | 'already_reviewed'
  | 'form_outdated'
  | 'filing_unavailable'
  | 'cancel_reconciliation_required'
  | 'amend_save_unavailable'
  | 'amend_reconciliation_required'
  | 'run_changed'
  | 'write_unavailable';

export class HmsApprovalError extends Error {
  readonly refusal: HmsApprovalRefusal;

  constructor(refusal: HmsApprovalRefusal) {
    super(`hms write refused: ${refusal}`);
    this.name = 'HmsApprovalError';
    this.refusal = refusal;
  }
}

export type HmsSelectedSource = { threadId: string; messageId: string; sourceHash: string };
type SelectedHmsSource = { transportId: string; selectedInternetMessageId?: string; selectedSource?: HmsSelectedSource };
type HmsSourceItem = { sourceMessageId: string | null; threadId: string | null };

async function currentSelectedHmsSource(db: DB, transportId: string, source: HmsSelectedSource): Promise<boolean> {
  const { isSelectedHmsInboundMessage } = await import('./hms-jobs.js');
  return isSelectedHmsInboundMessage({ transportId, ...source }, db);
}

/** The public pane names the selected email; ambiguous legacy IDs or a mismatched selection never authorize a write. */
export async function assertHmsSelectedSource(db: DB, input: SelectedHmsSource, item: HmsSourceItem, lockRows = false): Promise<void> {
  if (input.selectedInternetMessageId !== undefined) {
    const selectedId = canonicalMessageId(input.selectedInternetMessageId.trim());
    if (!selectedId || !item.sourceMessageId || !item.threadId) throw new HmsApprovalError('source_mail_changed');
    const query = db.select({ id: message.id, threadId: message.threadId, direction: message.direction })
      .from(message).where(and(eq(message.transportId, input.transportId), eq(message.messageIdHeader, selectedId),
        input.selectedSource ? eq(message.id, input.selectedSource.messageId) : undefined,
        input.selectedSource ? eq(message.threadId, input.selectedSource.threadId) : undefined)).limit(2);
    const matches = lockRows ? await query.for('share') : await query;
    if (matches.length !== 1 || matches[0]?.id !== item.sourceMessageId ||
        matches[0].threadId !== item.threadId || matches[0].direction !== 'inbound') {
      throw new HmsApprovalError('source_mail_changed');
    }
  }
  if (input.selectedSource && (input.selectedSource.messageId !== item.sourceMessageId ||
      input.selectedSource.threadId !== item.threadId ||
      !await currentSelectedHmsSource(db, input.transportId, input.selectedSource))) {
    throw new HmsApprovalError('source_mail_changed');
  }
}

async function lockHmsSelectedMailbox(db: DB, input: SelectedHmsSource): Promise<void> {
  if (input.selectedInternetMessageId !== undefined || input.selectedSource !== undefined) await lockCanonicalMailbox(db, input.transportId);
}

async function assertCurrentHmsSelection(db: DB, input: SelectedHmsSource & { workItemId: string }): Promise<void> {
  if (input.selectedInternetMessageId === undefined && input.selectedSource === undefined) return;
  const [item] = await db.select({ sourceMessageId: workItem.sourceMessageId, threadId: workItem.threadId })
    .from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1);
  if (!item) throw new HmsApprovalError('not_found');
  await assertHmsSelectedSource(db, input, item);
}

/** The approval payload. Stored as the approval.granted value, and its hash is the event's payload_hash. */
const legacyHmsWriteGrantSchema = z
  .object({
    grantId: z.string().regex(UUID_PATTERN),
    workItemId: z.string(),
    transportId: z.string(),
    actorUserId: z.string(),
    sessionId: z.string().min(1).max(512).optional(),
    sessionProfile: z.enum(['legacy', 'remote']).optional(),
    formDigest: z.string(),
    hmsBeforeDigest: z.string(),
    hmsReadAt: z.string(),
  })
  .strict();
export const hmsWriteGrantSchema = z.union([hmsWriteGrantV2Schema, legacyHmsWriteGrantSchema]);
type HmsWriteGrant = z.infer<typeof hmsWriteGrantSchema>;

const snapshotSchema = z.object({ digest: z.string(), readAt: z.string(), expiresAt: z.string().datetime().optional() });

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Digest of an HMS before-state read. Prepare stores it as work_item.state.hmsSnapshot, and the pre-Save hook compares it. */
export function hmsStateDigest(hmsState: unknown): string {
  // JSON first: a Date or other non-JSON value must hash as the text a reader stores, not as an empty object.
  return sha256Hex(canonicalJson(JSON.parse(JSON.stringify(hmsState ?? null))));
}

/** The form the person saw, excluding read snapshots and staff request acknowledgements. */
function formOf(state: Record<string, unknown>): Record<string, unknown> {
  const form: Record<string, unknown> = { ...state };
  delete form[HMS_SNAPSHOT_KEY];
  delete form.__reservationActionLane;
  delete form.reservationistHandledRequests;
  delete form.cloudCancelPreview;
  for (const key of ['cloudCreatePreviews', 'cloudCreateBatch', 'cloudCreatePastBatches', 'cloudCreateBatchHolds', 'stayPreviews']) delete form[key];
  if (form.stays && typeof form.stays === 'object' && !Array.isArray(form.stays)) {
    form.stays = Object.fromEntries(Object.entries(form.stays).map(([id, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [id, value];
      return [id, Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('cloudCreate') &&
        !['status', 'confirmationNumber', 'screenshotRef', 'runId', 'readbackDigest', 'observationRef', 'nativePrice', 'shots', 'nativeStayId'].includes(key)))];
    }));
  }
  if (form.reservationWorkflowV2 && typeof form.reservationWorkflowV2 === 'object' && !Array.isArray(form.reservationWorkflowV2)) {
    const draft = Object.fromEntries(Object.entries(form.reservationWorkflowV2));
    // Native observations are bound separately; dispatch progress must not change approved staff fields.
    for (const key of ['observations', 'operationResults', 'errors', 'status', 'prefill']) delete draft[key];
    const proposal = draft.proposal && typeof draft.proposal === 'object' && !Array.isArray(draft.proposal)
      ? draft.proposal as Record<string, unknown> : null;
    const content = proposal?.content && typeof proposal.content === 'object' && !Array.isArray(proposal.content)
      ? proposal.content as Record<string, unknown> : null;
    if (Array.isArray(content?.requests) && content.requests.some(request => request && typeof request === 'object' &&
        !Array.isArray(request) && (request as Record<string, unknown>).kind === 'filing')) {
      // Filing mirrors are derived from the source-bound V2 proposal and sealed native observation.
      // The worker independently checks their exact PDF, target and document fields before dispatch.
      for (const key of ['action', 'confirmation', 'arrival', 'lastName', 'attachmentId', 'documentName',
        'sourceDocumentName', 'requestedDocumentName', 'documentDescription', 'pdfSha256', 'sourceMessageId',
        'sourceInternetMessageId', 'sourceSnapshotDigest', 'sourceThreadId', 'sourceHash', 'documentCode',
        'filingStateDigest', 'filingHistorySeq', 'reason', 'fields', 'previewDigest', 'cloudAmend', 'cloudCancel']) delete form[key];
    }
    form.reservationWorkflowV2 = draft;
  }
  return form;
}

/** Stable HMS upload name for one original attachment, stay confirmation, and PDF digest. */
export function nativeFilingDocumentName(sourceDocumentName: string, confirmation: string, pdfSha256: string): string {
  if (typeof sourceDocumentName !== 'string' || sourceDocumentName.length === 0 || sourceDocumentName.length > 150 ||
      /[\\/]/.test(sourceDocumentName) || !/\.pdf$/i.test(sourceDocumentName) ||
      /[\p{Cc}]/u.test(sourceDocumentName) ||
      !/^\d+-\d+$/.test(confirmation) || !/^[a-f0-9]{64}$/.test(pdfSha256)) {
    throw new Error('filing_native_document_name_input_invalid');
  }
  const sourceStem = sourceDocumentName.replace(/\.pdf$/i, '');
  const safeStem = sourceStem.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/[-_]{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '') || 'voucher';
  const suffix = `-${confirmation}-${pdfSha256.slice(0, 24)}.pdf`;
  const stemLength = Math.min(40, 80 - suffix.length);
  if (stemLength < 1) throw new Error('filing_native_document_name_too_long');
  return `${safeStem.slice(0, stemLength).replace(/[-_]+$/g, '') || 'v'}${suffix}`;
}

/** Bind the selected POP3 PDF and stay; only server on-mode admits real guests. */
function isBoundLabtestAttachment(state: Record<string, unknown>, sourceMessageId: string | null,
  attachMode: 'off' | 'lab' | 'on'): boolean {
  const arrival = typeof state.arrival === 'string' ? state.arrival : '';
  const date = new Date(`${arrival}T00:00:00Z`);
  const allowRealGuest = attachMode === 'on';
  const selected = typeof state.sourceInternetMessageId === 'string' ? canonicalMessageId(state.sourceInternetMessageId) : null;
  let expectedDocumentName: string | null = null;
  try {
    if (typeof state.sourceDocumentName === 'string' && typeof state.confirmation === 'string' &&
        typeof state.pdfSha256 === 'string') {
      const generatedName = nativeFilingDocumentName(state.sourceDocumentName, state.confirmation, state.pdfSha256);
      expectedDocumentName = typeof state.requestedDocumentName === 'string' ? state.requestedDocumentName : generatedName;
    }
  } catch { /* Historical/unbound names are not admitted for a live Labtest write. */ }
  return state.action === 'attach_document' && !!sourceMessageId && state.sourceMessageId === sourceMessageId &&
    !!selected && selected === state.sourceInternetMessageId && typeof state.lastName === 'string' &&
    !!state.lastName.trim() && state.lastName.length <= 200 && !/[\p{Cc}]/u.test(state.lastName) &&
    state.lastName === state.lastName.trim() && (allowRealGuest || /^labtest$/i.test(state.lastName)) &&
    /^\d{4}-\d{2}-\d{2}$/.test(arrival) && !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === arrival && (allowRealGuest || arrival >= '2027-01-01') &&
    typeof state.confirmation === 'string' && /^\d+-\d+$/.test(state.confirmation) &&
    typeof state.attachmentId === 'string' && state.attachmentId.length > 0 &&
    typeof state.documentName === 'string' && state.documentName === expectedDocumentName &&
    (state.requestedDocumentName === undefined || (typeof state.requestedDocumentName === 'string' &&
      state.requestedDocumentName.length <= 150 && /\.pdf$/i.test(state.requestedDocumentName) &&
      state.requestedDocumentName === state.requestedDocumentName.replace(/\s+/g, ' ').trim() &&
      !/[\\/\p{Cc}]/u.test(state.requestedDocumentName))) &&
    (state.documentDescription === undefined || (typeof state.documentDescription === 'string' &&
      state.documentDescription.length > 0 && state.documentDescription.length <= 200 &&
      state.documentDescription === state.documentDescription.trim() && !/[\p{Cc}]/u.test(state.documentDescription))) &&
    typeof state.pdfSha256 === 'string' && /^[a-f0-9]{64}$/.test(state.pdfSha256) &&
    typeof state.sourceSnapshotDigest === 'string' && /^[a-f0-9]{64}$/.test(state.sourceSnapshotDigest) &&
    typeof state.sourceThreadId === 'string' && state.sourceThreadId.length > 0 &&
    typeof state.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(state.sourceHash) &&
    typeof state.documentCode === 'string' && /^NAVA[A-Z2-7]{25}[AEIMQUY4]$/.test(state.documentCode) &&
    typeof state.filingStateDigest === 'string' && /^[a-f0-9]{64}$/.test(state.filingStateDigest);
}

function boundFilingSelectionMatches(state: Record<string, unknown>, source: HmsSelectedSource | undefined): boolean {
  return !!source && state.sourceMessageId === source.messageId && state.sourceThreadId === source.threadId &&
    state.sourceHash === source.sourceHash;
}

export function formDigest(state: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(formOf(state)));
}

function grantHash(grant: HmsWriteGrant): string {
  return sha256Hex(canonicalJson(grant));
}

function readSnapshot(state: Record<string, unknown>): { digest: string; readAt: string; expiresAt?: string } | null {
  const parsed = snapshotSchema.safeParse(state[HMS_SNAPSHOT_KEY]);
  if (!parsed.success || !Number.isFinite(Date.parse(parsed.data.readAt))) return null;
  return parsed.data;
}

/** KTD11: stale unless the snapshot is inside the window. A read stamped in the future is stale too. */
function snapshotStale(readAt: string, now: Date): boolean {
  const age = now.getTime() - Date.parse(readAt);
  return !(age >= 0 && age < HMS_SNAPSHOT_MAX_AGE_MS);
}

/** An hms_write run's idempotency key is `hms-write:<grantId>`, so each grant maps to one run. */
function grantIdForRun(run: { idempotencyKey: string }): string | null {
  const match = /^hms-write:(.+)$/.exec(run.idempotencyKey);
  return match?.[1] && UUID_PATTERN.test(match[1]) ? match[1] : null;
}

async function loadGrant(
  db: DB,
  workItemId: string,
  grantId: string,
  lockRow = false,
): Promise<{ grant: HmsWriteGrant; payloadHash: string }> {
  const query = db
    .select({ value: workEvent.value, payloadHash: workEvent.payloadHash })
    .from(workEvent)
    .where(
      and(
        eq(workEvent.id, grantId),
        eq(workEvent.workItemId, workItemId),
        eq(workEvent.type, 'approval.granted'),
      ),
    )
    .limit(1);
  const [row] = lockRow ? await query.for('share') : await query;
  if (!row?.payloadHash) throw new HmsApprovalError('no_grant');
  const parsed = hmsWriteGrantSchema.safeParse(row.value);
  if (!parsed.success || grantHash(parsed.data) !== row.payloadHash) {
    throw new HmsApprovalError('no_grant');
  }
  return { grant: parsed.data, payloadHash: row.payloadHash };
}

// Internal recovery reuses the same grant integrity check as the write path.
export { loadGrant as readVerifiedHmsWriteGrant };

async function assertNoWriteInFlight(db: DB, workItemId: string): Promise<void> {
  const [open] = await db
    .select({ id: aiWorkflowRun.id })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.workItemId, workItemId),
        eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND),
        inArray(aiWorkflowRun.state, NONTERMINAL_AI_RUN_STATES),
      ),
    )
    .limit(1);
  if (open) throw new HmsApprovalError('write_in_flight');
}

/**
 * The latest write run whose outcome is unknown and that nobody has resolved yet, or null. Call it after
 * assertNoWriteInFlight, so the latest run is terminal.
 */
async function unresolvedNeedsCheckRunId(db: DB, workItemId: string): Promise<string | null> {
  const [latest] = await db
    .select({
      id: aiWorkflowRun.id,
      state: aiWorkflowRun.state,
      failureClass: aiWorkflowRun.failureClass,
    })
    .from(aiWorkflowRun)
    .where(
      and(eq(aiWorkflowRun.workItemId, workItemId), eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND)),
    )
    .orderBy(desc(aiWorkflowRun.createdAt), desc(aiWorkflowRun.id))
    .limit(1);
  if (!latest) return null;
  if (!latest.failureClass || !BLOCKING_FAILURE_CLASSES.has(latest.failureClass)) {
    // A run that never consumed its grant never reached HMS, so a new approval is safe. A consumed run that neither
    // succeeded nor stopped at the pre-Save check may have written, so its outcome is unknown until read back.
    if (latest.state === 'succeeded' || latest.failureClass === 'NEEDS_CHECK') return null;
    const [consumed] = await db
      .select({ id: workEvent.id })
      .from(workEvent)
      .where(
        and(
          eq(workEvent.workItemId, workItemId),
          eq(workEvent.type, 'approval.consumed'),
          sql`${workEvent.value}->>'runId' = ${latest.id}`,
        ),
      )
      .limit(1);
    if (!consumed) return null;
  }
  const [resolved] = await db
    .select({ id: workEvent.id })
    .from(workEvent)
    .where(
      and(
        eq(workEvent.workItemId, workItemId),
        eq(workEvent.type, 'status.changed'),
        sql`${workEvent.value}->>'resolvedRunId' = ${latest.id}`,
      ),
    )
    .limit(1);
  return resolved ? null : latest.id;
}

export async function assertNoOpenWrite(db: DB, workItemId: string): Promise<void> {
  await assertNoWriteInFlight(db, workItemId);
  if (await unresolvedNeedsCheckRunId(db, workItemId)) throw new HmsApprovalError('needs_check_open');
}

async function recordNeedsCheck(
  tx: DB,
  input: {
    workItemId: string;
    runId: string;
    failureClass: AiFailureClass;
    reason: string;
    now: Date;
  },
): Promise<void> {
  await tx.insert(workEvent).values({
    workItemId: input.workItemId,
    at: input.now,
    actorKind: 'system',
    type: 'status.changed',
    value: {
      needsCheck: true,
      runId: input.runId,
      failureClass: input.failureClass,
      reason: input.reason,
    },
  });
}

/**
 * Prepare step: stores a fresh HMS before-state as work_item.state.hmsSnapshot. The read runs before the transaction,
 * so approval never reads HMS while it holds the work-item row lock. The snapshot key is outside the form digest, so
 * storing a new snapshot leaves an approved form valid.
 */
export async function storeHmsSnapshot(input: {
  db?: DB;
  transportId: string;
  workItemId: string;
  selectedInternetMessageId?: string;
  selectedSource?: HmsSelectedSource;
  expectedFormDigest?: string;
  readHmsState: () => Promise<unknown>;
  now?: Date;
}): Promise<{ digest: string; readAt: string }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const snapshot = { digest: hmsStateDigest(await input.readHmsState()), readAt: now.toISOString() };
  await db.transaction(async (tx) => {
    await lockHmsSelectedMailbox(tx as DB, input);
    const [item] = await tx
      .select({ id: workItem.id, state: workItem.state, status: workItem.status,
        sourceMessageId: workItem.sourceMessageId, threadId: workItem.threadId })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) throw new HmsApprovalError('not_found');
    await assertHmsSelectedSource(tx as DB, input, item, true);
    if (item.state.action === 'attach_document' && input.selectedSource &&
        !boundFilingSelectionMatches(item.state, input.selectedSource)) throw new HmsApprovalError('source_mail_changed');
    if (item.status === 'done' || item.status === 'dismissed') throw new HmsApprovalError('not_open');
    if (input.expectedFormDigest !== undefined && input.expectedFormDigest !== formDigest(item.state)) {
      throw new HmsApprovalError('form_outdated');
    }
    await tx
      .update(workItem)
      .set({ state: { ...item.state, [HMS_SNAPSHOT_KEY]: snapshot }, updatedAt: now })
      .where(eq(workItem.id, item.id));
  });
  return snapshot;
}

/**
 * Ends a claimed hms_write run and records a needs-check event in one transaction. POLICY_BLOCK is an expected
 * refusal, so the run is superseded rather than dead-lettered. A needs-check also drops the stored snapshot when
 * the class is NEEDS_CHECK, so the next approval re-reads HMS. Returns false when the claim is gone, so the caller
 * reports a lost lease and does not treat the run as ended. assertHmsUnchangedBeforeSave keeps its own block.
 */
export async function endHmsWriteRun(input: {
  db?: DB;
  fence: AiRunFence;
  failureClass: AiFailureClass;
  reason: string;
}): Promise<boolean> {
  const db = input.db ?? getDb();
  return db.transaction(async (tx) => {
    const now = new Date();
    const reviewCompleted = input.reason === 'hms_v2_native_review_ready' && input.failureClass === 'POLICY_BLOCK' &&
      await hmsWriteRunReviewCompleted(tx as DB, input.fence);
    if (input.reason === 'hms_v2_native_review_ready' && !reviewCompleted) throw new HmsApprovalError('state_changed');
    const mark = {
      runId: input.fence.runId,
      claimOwner: input.fence.claimOwner,
      claimToken: input.fence.claimToken,
      expectedStates: ['claimed' as const, 'running' as const],
      lastError: input.reason,
    };
    const row =
      input.failureClass === 'POLICY_BLOCK'
        ? await markAiRunPolicyRefused(mark, tx as DB)
        : await markAiRunDeadLetter({ ...mark, failureClass: input.failureClass }, tx as DB);
    if (!row) return false;
    if (row.workItemId) {
      if (input.failureClass === 'NEEDS_CHECK') {
        await tx
          .update(workItem)
          .set({ state: sql`${workItem.state} - 'hmsSnapshot'`, updatedAt: now })
          .where(eq(workItem.id, row.workItemId));
      }
      if (reviewCompleted) await tx.insert(workEvent).values({ workItemId: row.workItemId, at: now,
        actorKind: 'system', type: 'status.changed', value: { needsCheck: false, resolvedRunId: row.id,
          reason: input.reason, finalSave: false } });
      else await recordNeedsCheck(tx as DB, {
        workItemId: row.workItemId,
        runId: row.id,
        failureClass: input.failureClass,
        reason: input.reason,
        now,
      });
    }
    return true;
  });
}

/**
 * A queued write that no runner has claimed has not touched HMS. Once the form changed after its approval, its grant can
 * never be consumed (consume refuses state_changed), so it would only block the new approval as write_in_flight. It is
 * superseded instead. The update matches only the queued state, so a run a runner has claimed in the meantime is kept,
 * and the approval is refused as in flight.
 */
async function supersedeChangedQueuedWrite(
  db: DB,
  workItemId: string,
  currentFormDigest: string,
  now: Date,
): Promise<void> {
  const run = await latestWriteRun(db, workItemId);
  if (run?.state !== 'queued') return;
  const grantId = grantIdForRun(run);
  const [row] = grantId
    ? await db
        .select({ value: workEvent.value })
        .from(workEvent)
        .where(
          and(
            eq(workEvent.id, grantId),
            eq(workEvent.workItemId, workItemId),
            eq(workEvent.type, 'approval.granted'),
          ),
        )
        .limit(1)
    : [];
  const grant = hmsWriteGrantSchema.safeParse(row?.value);
  if (grant.success && grant.data.formDigest === currentFormDigest) return;
  await db
    .update(aiWorkflowRun)
    .set({ state: 'superseded', lastError: 'form_changed', finishedAt: now, updatedAt: now })
    .where(and(eq(aiWorkflowRun.id, run.id), eq(aiWorkflowRun.state, 'queued')));
}

/** Recheck the prepared target, business fields and observed price under the current write mode. */
async function assertCloudAmendForm(state: Record<string, unknown>, env?: NodeJS.Dict<string>, expectedPropertyCode?: HmsPreparation['scope']['propertyCode']): Promise<void> {
  const [{ cloudAmendDispatchFormSchema }, { cloudAmendFirstPilotScopeSupported }] = await Promise.all([
    import('./pane-cloud-amend-dispatch.js'), import('./pane-cloud-amend.js'),
  ]);
  const parsed = cloudAmendDispatchFormSchema.safeParse(state);
  if (!parsed.success) throw new HmsApprovalError('state_changed');
  const form = parsed.data, { binding, preimage, nativeDigest, approvedPrices, preserved } = form.cloudAmend;
  const propertyCode = propertyCodeSchema.parse(preimage.native.propertyCode);
  const mode = effectiveWorkflowPolicy(env ?? process.env, propertyCode, 'amend').admittedMode;
  if (expectedPropertyCode !== undefined && (propertyCode !== expectedPropertyCode || mode === 'off')) {
    throw new HmsApprovalError('amend_save_unavailable');
  }
  const price = retainedPricesForApproval(approvedPrices);
  const previewDigest = hmsStateDigest({ binding, preimage, changes: form.fields, nativeDigest, approvedPrices, preserved });
  if (form.confirmation !== preimage.native.confirmation || form.arrival !== preimage.native.arrival ||
      state.lastName !== preimage.native.lastName || previewDigest !== form.previewDigest || price?.version !== 2 ||
      !cloudAmendFirstPilotScopeSupported(preimage.native, form.fields, expectedPropertyCode === undefined || mode === 'on', preserved)) {
    throw new HmsApprovalError('state_changed');
  }
}

async function lockedPreparation(db: CreateFenceTransaction, input: {
  item: typeof workItem.$inferSelect; state: Record<string, unknown>;
  snapshot: { digest: string; readAt: string; expiresAt?: string }; actorUserId: string;
  sessionId?: string; sessionProfile?: 'legacy' | 'remote'; propertySwitch?: PropertySwitch;
  preparedRef?: string; expectedRevision?: number; now: Date;
  nativePreparation?: HmsNativePreparation;
  expectedSourceHash?: string;
  granting?: boolean;
}): Promise<HmsPreparation> {
  const { item, state, snapshot, now } = input;
  const supplied = input.preparedRef ? await loadHmsPreparation(db, input.preparedRef, item.id) : undefined;
  const native: HmsNativePreparation | undefined = supplied ?? input.nativePreparation;
  const v2 = native?.workflowContext ? { ...native, workflowContext: native.workflowContext } : undefined;
  // The v2 engine is retired; its preparations are refused.
  if (v2) throw new HmsApprovalError('state_changed');
  const revision = item.revisionSeq;
  const staff = staffSessionSchema.safeParse({ actorUserId: input.actorUserId,
    sessionId: input.sessionId, sessionProfile: input.sessionProfile });
  if (!staff.success || !item.threadId || !item.sourceMessageId) throw new HmsApprovalError('no_grant');
  const scope = resolvePropertyScope({ transportId: item.transportId, propertySwitch: input.propertySwitch });
  if (scope.propertyCode !== 'HRCEN' && !v2 && state.propertyCode !== scope.propertyCode) throw new HmsApprovalError('state_changed');
  await lockCreateActorAccess(db, { transportId: item.transportId, actorUserId: staff.data.actorUserId });
  await lockCreateActorSession(db, staff.data);
  const [thread] = await db.select().from(mailThread).where(and(eq(mailThread.id, item.threadId),
    eq(mailThread.transportId, item.transportId))).limit(1).for('share');
  const [mail] = await db.select().from(message).where(and(eq(message.id, item.sourceMessageId),
    eq(message.threadId, item.threadId), eq(message.transportId, item.transportId))).limit(1).for('share');
  if (!thread || thread.historyOnly || thread.trashedAt !== null || !mail || mail.direction !== 'inbound' ||
      mail.historyOnly || mail.sourceProvenance?.attention != null) throw new HmsApprovalError('source_mail_changed');
  const sourceHash = staffQuoteSourceHash(mail);
  if (input.expectedSourceHash !== undefined && input.expectedSourceHash !== sourceHash) {
    throw new HmsApprovalError('source_mail_changed');
  }
  const operation = hmsOperationSchema.safeParse(native?.operation ?? state.action ?? (state.stays ? 'create' : undefined));
  if (!operation.success) throw new HmsApprovalError('write_unavailable');
  const configuration = await propertyConfigurationForScope(scope);
  const identities = hmsConfigurationIdentities(scope, configuration, operation.data);
  const capability = configuration.capabilities[hmsWorkflowForOperation(operation.data)].status;
  if (capability === 'unavailable' || input.granting && !['lab', 'staff-enabled'].includes(capability)) {
    throw new HmsApprovalError('write_unavailable');
  }
  if (native && (native.policyIdentity !== identities.policyIdentity || native.catalogueIdentity !== identities.catalogueIdentity)) {
    throw new HmsApprovalError('state_changed');
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
    throw new HmsApprovalError('state_changed');
  }
  const generationId = (typeof state.generationId === 'string' ? state.generationId
    : `work-item:${item.id}:${item.revisionSeq}`);
  if (!input.preparedRef) {
    const [prior] = await db.select({ id: workEvent.id }).from(workEvent).where(and(
      eq(workEvent.workItemId, item.id), eq(workEvent.type, 'hms.prepared'),
      sql`${workEvent.value}->>'businessDigest' = ${formDigest(state)}`,
      sql`${workEvent.value}->>'generationId' = ${generationId}`,
      sql`${workEvent.value}->'nativeObservation'->>'capturedAt' = ${snapshot.readAt}`,
      sql`${workEvent.value}->'session'->>'actorUserId' = ${staff.data.actorUserId}`,
      sql`${workEvent.value}->'session'->>'sessionId' = ${staff.data.sessionId}`,
      sql`${workEvent.value}->'session'->>'sessionProfile' = ${staff.data.sessionProfile}`,
      sql`${workEvent.value}->'scope'->>'propertyCode' = ${scope.propertyCode}`,
      sql`${workEvent.value}->>'revision' = ${String(item.revisionSeq)}`,
    )).orderBy(desc(workEvent.at), desc(workEvent.id)).limit(1).for('share');
    if (prior) {
      const [issued] = await db.select({ id: workEvent.id }).from(workEvent).where(and(
        eq(workEvent.workItemId, item.id), eq(workEvent.type, 'approval.granted'),
        sql`${workEvent.value}->>'preparedRef' = ${prior.id}`)).limit(1);
      // A safe stopped run may be approved again, but never with its previously granted preparation.
      // The caller has already checked open/uncertain writes under this same work-item lock.
      if (!issued) return lockedPreparation(db, { ...input, preparedRef: prior.id });
    }
  }
  if (input.preparedRef) {
    if (!supplied) throw new HmsApprovalError('state_changed');
    const prepared = supplied;
    if (prepared.scope.propertyCode !== scope.propertyCode || prepared.scope.tenantId !== scope.tenantId ||
        canonicalJson(prepared.session) !== canonicalJson(staff.data) ||
        prepared.source.transportId !== item.transportId || prepared.source.threadId !== item.threadId ||
        prepared.source.sourceMessageId !== item.sourceMessageId || prepared.source.sourceHash !== sourceHash ||
        prepared.businessDigest !== formDigest(state) || prepared.nativeObservation.beforeDigest !== snapshot.digest ||
        prepared.nativeObservation.capturedAt !== snapshot.readAt || prepared.revision !== revision ||
        prepared.generationId !== generationId || prepared.operation !== operation.data ||
        now.getTime() >= Date.parse(prepared.expiresAt)) throw new HmsApprovalError('state_changed');
    const [existingGrant] = await db.select({ id: workEvent.id }).from(workEvent).where(and(
      eq(workEvent.workItemId, item.id), eq(workEvent.type, 'approval.granted'),
      sql`${workEvent.value}->>'preparedRef' = ${prepared.preparedRef}`)).limit(1);
    if (existingGrant) throw new HmsApprovalError('already_consumed');
    const [revoked] = await db.select({ id: workEvent.id }).from(workEvent).where(and(
      eq(workEvent.workItemId, item.id), eq(workEvent.type, 'hms.prepare.revoked'),
      sql`${workEvent.value}->>'preparedRef' = ${prepared.preparedRef}`)).limit(1);
    if (revoked) throw new HmsApprovalError('state_changed');
    return prepared;
  }
  const saved = hmsDispatchTargetSchema.safeParse({ propertyCode: scope.propertyCode, kind: 'saved',
    confirmation: state.confirmation, nativeStayId: state.nativeStayId ?? state.reservationStayId });
  const allocations: NonNullable<HmsPreparation['allocations']> = [...(native?.allocations ?? [])];
  const targetAliases: string[] = [...(native?.targetAliases ?? [])];
  if (!native && operation.data === 'create' && state.stays && typeof state.stays === 'object') {
    for (const [stayId, rawStay] of Object.entries(state.stays)) {
      if (!rawStay || typeof rawStay !== 'object') throw new HmsApprovalError('state_changed');
      const stay = z.object({ rooms: z.number().int().min(1).max(8).default(1),
        arrival: z.string().optional(), firstName: z.string().optional(), lastName: z.string().optional() }).passthrough().parse(rawStay);
      const target = hmsDispatchTargetSchema.safeParse({ propertyCode: scope.propertyCode, kind: 'create',
        firstName: stay.firstName ?? state.firstName, lastName: stay.lastName ?? state.lastName, arrival: stay.arrival });
      if (target.success) targetAliases.push(...hmsDispatchTargetKeys(target.data));
      for (let room = 1; room <= stay.rooms; room++) allocations.push({ allocationId: `${stayId}_${room}`,
        businessDigest: preparationDigest({ stay, room }) });
    }
    if (allocations.length < 1 || allocations.length > 8) throw new HmsApprovalError('state_changed');
  }
  if (saved.success) targetAliases.push(...hmsDispatchTargetKeys(saved.data));
  // A positively bound legacy HRCEN preparation may lack a native target; DaVinci never takes this path.
  if (!targetAliases.length) {
    if (scope.propertyCode !== 'HRCEN') throw new HmsApprovalError('state_changed');
    targetAliases.push(hmsDispatchWorkItemKey(item.id));
  }
  const fields = formOf(state);
  const attachment = input.nativePreparation?.sourceAttachment ?? supplied?.source.attachment ?? (
    typeof state.attachmentId === 'string' && typeof state.pdfSha256 === 'string'
      ? { attachmentId: state.attachmentId, sha256: state.pdfSha256 } : undefined);
  const prepared = hmsPreparationSchema.parse({ version: 2, preparedRef: randomUUID(), workItemId: item.id,
    scope, session: staff.data, source: { transportId: item.transportId, threadId: item.threadId,
      sourceMessageId: item.sourceMessageId, sourceHash, ...(attachment ? { attachment } : {}) },
    generationId, revision, operation: operation.data, targetAliases: [...new Set(targetAliases)].sort(),
    businessFields: fields, businessDigest: formDigest(state), targetDigest: preparationDigest([...new Set(targetAliases)].sort()),
    nativeObservation: { beforeDigest: snapshot.digest, capturedAt: snapshot.readAt,
      price: native?.nativeObservation.price ?? state.approvedPrices ?? state.nativePrice ?? null, warnings: native?.nativeObservation.warnings ?? [] },
    ...identities,
    capturedAt: now.toISOString(), expiresAt: new Date(Math.min(Date.parse(snapshot.readAt) + HMS_SNAPSHOT_MAX_AGE_MS,
      snapshot.expiresAt ? Date.parse(snapshot.expiresAt) : Infinity)).toISOString(),
    ...(operation.data === 'create' ? { allocations } : {}) });
  return recordHmsPreparation(db, prepared);
}

/** Fence a possibly unsent filing Go against a late approval before allowing another check. */
export async function revokeUnsentFilingPreparation(input: {
  db: DB; transportId: string; workItemId: string; actorUserId: string; sessionId: string;
  sessionProfile: 'legacy' | 'remote'; propertySwitch?: PropertySwitch; selectedSource: HmsSelectedSource;
  requestId: string; preparedRef: string;
}): Promise<'revoked' | 'dispatched'> {
  return input.db.transaction(async tx => {
    await lockHmsSelectedMailbox(tx as DB, input);
    const [item] = await tx.select().from(workItem).where(and(eq(workItem.id, input.workItemId),
      eq(workItem.transportId, input.transportId))).limit(1).for('update');
    if (!item) throw new HmsApprovalError('not_found');
    await assertHmsSelectedSource(tx as DB, input, item, true);
    const prepared = await loadHmsPreparation(tx, input.preparedRef, item.id);
    const scope = resolvePropertyScope({ transportId: input.transportId, propertySwitch: input.propertySwitch });
    if (prepared.operation !== 'attach_document' || prepared.workflowContext?.endpoint !== 'execute' ||
        prepared.workflowContext.input.requestId !== input.requestId ||
        canonicalJson(prepared.scope) !== canonicalJson(scope) ||
        canonicalJson(prepared.session) !== canonicalJson({ actorUserId: input.actorUserId,
          sessionId: input.sessionId, sessionProfile: input.sessionProfile }) ||
        prepared.source.threadId !== input.selectedSource.threadId ||
        prepared.source.sourceMessageId !== input.selectedSource.messageId ||
        prepared.source.sourceHash !== input.selectedSource.sourceHash) throw new HmsApprovalError('state_changed');
    const [grant] = await tx.select({ id: workEvent.id }).from(workEvent).where(and(
      eq(workEvent.workItemId, item.id), eq(workEvent.type, 'approval.granted'),
      sql`${workEvent.value}->>'preparedRef' = ${input.preparedRef}`)).limit(1);
    if (grant) return 'dispatched';
    const [prior] = await tx.select({ id: workEvent.id }).from(workEvent).where(and(
      eq(workEvent.workItemId, item.id), eq(workEvent.type, 'hms.prepare.revoked'),
      sql`${workEvent.value}->>'preparedRef' = ${input.preparedRef}`)).limit(1);
    if (!prior) await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'system',
      actorUserId: input.actorUserId, type: 'hms.prepare.revoked', value: { preparedRef: input.preparedRef } });
    return 'revoked';
  });
}

export type HmsNativePreparation = Pick<HmsPreparation, 'operation' | 'targetAliases' | 'nativeObservation' |
  'policyIdentity' | 'catalogueIdentity' | 'allocations'> & {
    workflowContext?: HmsPreparation['workflowContext'];
    sourceAttachment?: HmsPreparation['source']['attachment'];
  };
export type V2HmsNativePreparation = HmsNativePreparation & { workflowContext: NonNullable<HmsPreparation['workflowContext']> };

/** Called after native staging closes, with the exact state captured before it began. */
export async function prepareNativeHmsWrite(input: {
  db: DB; transportId: string; workItemId: string; actorUserId: string;
  sessionId: string; sessionProfile: 'legacy' | 'remote'; propertySwitch?: PropertySwitch;
  expectedBusinessDigest: string; expectedSourceHash: string;
  expectedRevision: number; expectedSeq: number;
  native: HmsNativePreparation;
}): Promise<PreparedSummary> {
  if (input.native.workflowContext && input.native.workflowContext.input.workItemId !== input.workItemId) throw new HmsApprovalError('state_changed');
  const prepared = await input.db.transaction(async (tx) => {
    const [item] = await tx.select().from(workItem).where(and(eq(workItem.id, input.workItemId),
      eq(workItem.transportId, input.transportId))).limit(1).for('update');
    if (!item || item.status === 'done' || item.status === 'dismissed') throw new HmsApprovalError('not_open');
    if (formDigest(item.state) !== input.expectedBusinessDigest || item.revisionSeq !== input.expectedSeq ||
        (input.native.workflowContext ? item.revision : item.revisionSeq) !== input.expectedRevision) {
      throw new HmsApprovalError('state_changed');
    }
    await assertNoOpenWrite(tx as DB, item.id);
    const snapshot = { digest: input.native.nativeObservation.beforeDigest, readAt: input.native.nativeObservation.capturedAt };
    const now = new Date();
    if (snapshotStale(snapshot.readAt, now)) throw new HmsApprovalError('snapshot_stale');
    await tx.update(workItem).set({ state: { ...item.state, [HMS_SNAPSHOT_KEY]: snapshot }, updatedAt: now }).where(eq(workItem.id, item.id));
    return lockedPreparation(tx, { ...input, item, state: item.state, snapshot, now, nativePreparation: input.native });
  });
  return publicHmsPreparedSummary(prepared);
}

/** Persist the completed unsaved preview without granting Save. */
export async function prepareHmsWrite(input: {
  db?: DB; transportId: string; workItemId: string; actorUserId: string;
  sessionId?: string; sessionProfile?: 'legacy' | 'remote'; propertySwitch?: PropertySwitch;
  selectedInternetMessageId?: string; selectedSource?: HmsSelectedSource; expectedFormDigest?: string;
}): Promise<HmsPreparation> {
  const db = input.db ?? getDb();
  return db.transaction(async (tx) => {
    await lockHmsSelectedMailbox(tx as DB, input);
    const [item] = await tx.select().from(workItem).where(and(eq(workItem.id, input.workItemId),
      eq(workItem.transportId, input.transportId))).limit(1).for('update');
    if (!item) throw new HmsApprovalError('not_found');
    await assertHmsSelectedSource(tx as DB, input, item, true);
    if (item.status === 'done' || item.status === 'dismissed') throw new HmsApprovalError('not_open');
    if (input.expectedFormDigest !== undefined && formDigest(item.state) !== input.expectedFormDigest) {
      throw new HmsApprovalError('form_outdated');
    }
    await assertNoOpenWrite(tx as DB, item.id);
    if (Object.hasOwn(item.state, 'cloudAmend')) await assertCloudAmendForm(item.state);
    const snapshot = readSnapshot(item.state);
    const now = new Date();
    if (!snapshot || snapshotStale(snapshot.readAt, now)) throw new HmsApprovalError('snapshot_stale');
    return lockedPreparation(tx, { ...input, item, state: item.state, snapshot, now });
  });
}

/**
 * Server-side approval of one HMS write. The client sends only the work item id. The server recomputes the form
 * digest from stored state. A stale or missing snapshot is re-read first (KTD11) when a reader is supplied.
 */
export async function approveHmsWrite(input: {
  db?: DB;
  transportId: string;
  actorUserId: string;
  sessionId?: string;
  sessionProfile?: 'legacy' | 'remote';
  workItemId: string;
  selectedInternetMessageId?: string;
  selectedSource?: HmsSelectedSource;
  cloudCancelSelection?: HmsSelectedSource;
  cloudSelection?: HmsSelectedSource;
  propertySwitch?: PropertySwitch;
  preparedRef?: string;
  expectedRevision?: number;
  env?: NodeJS.Dict<string>;
  /**
   * The form digest of the values the card showed (hmsWriteStateOf.formDigest). When given, approval is refused unless
   * the stored form still has it, so staff never approve values they were not shown.
   */
  formDigest?: string;
  /** Re-reads HMS when the snapshot is stale. Without it, a stale snapshot is refused. */
  rereadHmsState?: () => Promise<unknown>;
  now?: Date;
}): Promise<{ grantId: string; runId: string; preparedRef: string; expectedRevision: number; hmsReadAt: string; expiresAt: string }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const scope = resolvePropertyScope({ transportId: input.transportId, propertySwitch: input.propertySwitch });
  const env = input.env ?? process.env;
  return db.transaction(async (tx) => {
    await lockHmsSelectedMailbox(tx as DB, input);
    const existingPreparation = input.preparedRef ? await loadHmsPreparation(tx, input.preparedRef, input.workItemId) : undefined;
    if (existingPreparation && canonicalJson(existingPreparation.scope) !== canonicalJson(scope)) throw new HmsApprovalError('state_changed');
    let cancelSourceBound = false;
    if (input.cloudCancelSelection) {
      if (effectiveWorkflowPolicy(env, scope.propertyCode, 'cancel').admittedMode === 'off' || !input.sessionId || !input.sessionProfile) {
        throw new HmsApprovalError('state_changed');
      }
      const { lockSelectedCloudCancel } = await import('./pane-cloud-cancel.js');
      await lockSelectedCloudCancel(tx, { workItemId: input.workItemId, transportId: input.transportId,
        source: input.cloudCancelSelection, actorUserId: input.actorUserId,
        sessionId: input.sessionId, sessionProfile: input.sessionProfile });
      cancelSourceBound = true;
    }
    let cloudSourceBound = false;
    if (input.cloudSelection) {
      if (effectiveWorkflowPolicy(env, scope.propertyCode, 'amend').admittedMode === 'off') throw new HmsApprovalError('amend_save_unavailable');
      const { lockSelectedBoundCloudAmend } = await import('./pane-cloud-amend.js');
      if (!await lockSelectedBoundCloudAmend(tx, { workItemId: input.workItemId, transportId: input.transportId,
        source: input.cloudSelection })) throw new HmsApprovalError('state_changed');
      cloudSourceBound = true;
    }
    const [item] = await tx
      .select()
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) throw new HmsApprovalError('not_found');
    await assertHmsSelectedSource(tx as DB, input, item, true);
    if (item.status === 'done' || item.status === 'dismissed') throw new HmsApprovalError('not_open');
    if (!item.threadId || !item.sourceMessageId) throw new HmsApprovalError('source_mail_missing');
    const target = paneStayHmsTargetForTransport(input.transportId, scope.propertyCode);
    const cloudCancel = !existingPreparation?.workflowContext && item.state.action === 'cancel';
    if (cloudCancel !== cancelSourceBound || (cloudCancel && !input.formDigest)) throw new HmsApprovalError('state_changed');
    if (cloudCancel) {
      const mode = effectiveWorkflowPolicy(env, scope.propertyCode, 'cancel').admittedMode;
      const { cloudCancelDispatchSchema } = await import('./pane-cloud-cancel.js');
      const bound = cloudCancelDispatchSchema.safeParse(item.state.cloudCancel);
      if (!bound.success || mode === 'off' || bound.data.preimage.propertyCode !== scope.propertyCode ||
          (bound.data.preimage.allowRealGuest && mode !== 'on')) {
        throw new HmsApprovalError('state_changed');
      }
    }
    const labtestAttach = !existingPreparation?.workflowContext && item.state.action === 'attach_document';
    const attachMode = effectiveWorkflowPolicy(env, scope.propertyCode, 'attach').admittedMode;
    if (labtestAttach && (!target.ok ||
        attachMode === 'off' || !isBoundLabtestAttachment(item.state, item.sourceMessageId, attachMode) ||
         !input.sessionId || !input.sessionProfile || !input.selectedInternetMessageId ||
         !boundFilingSelectionMatches(item.state, input.selectedSource) ||
         canonicalMessageId(input.selectedInternetMessageId.trim()) !== item.state.sourceInternetMessageId)) {
      throw new HmsApprovalError('filing_unavailable');
    }
    const cloudAmend = !existingPreparation?.workflowContext && item.state.action === 'amend' && Object.hasOwn(item.state, 'cloudAmend');
    if (cloudAmend !== cloudSourceBound || (cloudAmend && !input.formDigest)) throw new HmsApprovalError('state_changed');
    if (cloudAmend) {
      if (!target.ok || target.target.propertyCode !== scope.propertyCode) throw new HmsApprovalError('state_changed');
      await assertCloudAmendForm(item.state, input.env, scope.propertyCode);
    }
    const cloudSession = z.object({ sessionId: z.string().trim().min(1).max(512),
      sessionProfile: z.enum(['legacy', 'remote']) }).safeParse({ sessionId: input.sessionId, sessionProfile: input.sessionProfile });
    if (input.formDigest !== undefined && input.formDigest !== formDigest(item.state)) {
      throw new HmsApprovalError('form_outdated');
    }
    if (!cloudSession.success) throw new HmsApprovalError('no_grant');
    await supersedeChangedQueuedWrite(tx as DB, item.id, formDigest(item.state), now);
    await assertNoOpenWrite(tx as DB, item.id);
    if (labtestAttach || cloudAmend) {
      const previous = await latestWriteRun(tx as DB, item.id);
      const promptVersion = cloudAmend ? HMS_LABTEST_AMEND_PROMPT_VERSION : HMS_LABTEST_ATTACH_PROMPT_VERSION;
      if (previous?.state === 'succeeded' && [promptVersion, HMS_V2_WRITE_PROMPT_VERSION].includes(previous.promptVersion)) {
        const previousGrantId = grantIdForRun(previous);
        try {
          if (!previousGrantId) throw new HmsApprovalError('no_grant');
          const { grant: previousGrant } = await loadGrant(tx as DB, item.id, previousGrantId, true);
          if (previousGrant.grantId !== previousGrantId || previousGrant.workItemId !== item.id ||
              previousGrant.transportId !== input.transportId) throw new HmsApprovalError('no_grant');
        } catch (error) {
          if (error instanceof HmsApprovalError && error.refusal === 'no_grant') {
            throw new HmsApprovalError('needs_check_open');
          }
          throw error;
        }
      }
    }

    let state = item.state;
    let snapshot = existingPreparation
      ? { digest: existingPreparation.nativeObservation.beforeDigest, readAt: existingPreparation.nativeObservation.capturedAt }
      : readSnapshot(state);
    if (!snapshot || snapshotStale(snapshot.readAt, now)) {
      throw new HmsApprovalError(snapshot ? 'snapshot_stale' : 'snapshot_missing');
    }
    if (labtestAttach && snapshot.digest !== item.state.filingStateDigest) {
      throw new HmsApprovalError('snapshot_stale');
    }

    const prepared = await lockedPreparation(tx, { item, state, snapshot,
      actorUserId: input.actorUserId, sessionId: input.sessionId, sessionProfile: input.sessionProfile,
      propertySwitch: input.propertySwitch, preparedRef: input.preparedRef,
      expectedRevision: input.expectedRevision, now, granting: true });
    const grant = hmsWriteGrantV2Schema.parse({
      version: 2, grantId: randomUUID(), preparedRef: prepared.preparedRef,
      workItemId: item.id, transportId: input.transportId, ...prepared.session,
      threadId: prepared.source.threadId, sourceMessageId: prepared.source.sourceMessageId,
      sourceHash: prepared.source.sourceHash, ...(prepared.source.attachment ? { attachment: prepared.source.attachment } : {}),
      propertyCode: prepared.scope.propertyCode, tenantId: prepared.scope.tenantId,
      operation: prepared.operation, generationId: prepared.generationId, expectedRevision: prepared.revision,
      businessDigest: prepared.businessDigest, targetDigest: prepared.targetDigest,
      formDigest: prepared.businessDigest, hmsBeforeDigest: prepared.nativeObservation.beforeDigest,
      hmsReadAt: prepared.nativeObservation.capturedAt, issuedAt: now.toISOString(), expiresAt: prepared.expiresAt,
    });
    const expiresAt = new Date(prepared.expiresAt);
    await tx.insert(workEvent).values({
      id: grant.grantId,
      workItemId: item.id,
      at: now,
      actorKind: 'user',
      actorUserId: input.actorUserId,
      type: 'approval.granted',
      payloadHash: grantHash(grant),
      expiresAt,
      value: grant,
    });
    const run = await enqueueAiRun(
      {
        transportId: input.transportId,
        threadId: item.threadId,
        triggerMessageId: item.sourceMessageId,
        runKind: HMS_WRITE_RUN_KIND,
        idempotencyKey: `hms-write:${grant.grantId}`,
        modelId: NOT_APPLICABLE_MODEL_ID,
        promptVersion: HMS_V2_WRITE_PROMPT_VERSION,
        executorLane: 'hms',
        workItemId: item.id,
        priority: HMS_WRITE_PRIORITY,
      },
      tx as DB,
    );
    return {
      grantId: grant.grantId,
      runId: run.id,
      preparedRef: prepared.preparedRef,
      expectedRevision: prepared.revision,
      hmsReadAt: snapshot.readAt,
      expiresAt: expiresAt.toISOString(),
    };
  });
}

const RESOLVE_NOTE_MAX = 500;

/**
 * Closes a needs-check that blocks approval (KTD12 read-back), as an event with actor = session user. Either the server
 * re-reads HMS, and the read becomes the item's snapshot, or staff confirm they checked the booking in HMS and leave a
 * note. A staff resolve drops the stored snapshot, because HMS may have changed since it, so the next approval re-reads.
 * Nothing is re-run: a new write still needs a new approval.
 */
export async function resolveHmsNeedsCheck(input: {
  db?: DB;
  transportId: string;
  actorUserId: string;
  workItemId: string;
  selectedInternetMessageId?: string;
  selectedSource?: HmsSelectedSource;
  note?: string;
  rereadHmsState?: () => Promise<unknown>;
  now?: Date;
}): Promise<{ runId: string; resolution: 'hms_reread' | 'staff_checked' }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const note = input.note?.trim() ?? '';
  if (!input.rereadHmsState && note.length === 0) throw new HmsApprovalError('note_required');
  if (note.length > RESOLVE_NOTE_MAX) throw new HmsApprovalError('note_required');
  return db.transaction(async (tx) => {
    await lockHmsSelectedMailbox(tx as DB, input);
    const [item] = await tx
      .select({ id: workItem.id, state: workItem.state,
        sourceMessageId: workItem.sourceMessageId, threadId: workItem.threadId })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) throw new HmsApprovalError('not_found');
    await assertHmsSelectedSource(tx as DB, input, item, true);
    const target = paneStayHmsTargetForTransport(input.transportId);
    if (item.state.action === 'attach_document' && (!target.ok || target.target.propertyCode === 'HRCEN')) {
      throw new HmsApprovalError('filing_unavailable');
    }
    if (item.state.action === 'cancel' && Object.hasOwn(item.state, 'cloudCancel')) {
      throw new HmsApprovalError('cancel_reconciliation_required');
    }
    if (item.state.action === 'amend' && Object.hasOwn(item.state, 'cloudAmend')) {
      throw new HmsApprovalError('amend_reconciliation_required');
    }
    await assertNoWriteInFlight(tx as DB, item.id);
    const runId = await unresolvedNeedsCheckRunId(tx as DB, item.id);
    if (!runId) throw new HmsApprovalError('no_needs_check');
    const state: Record<string, unknown> = { ...item.state };
    let resolution: 'hms_reread' | 'staff_checked';
    if (input.rereadHmsState) {
      state[HMS_SNAPSHOT_KEY] = {
        digest: hmsStateDigest(await input.rereadHmsState()),
        readAt: now.toISOString(),
      };
      resolution = 'hms_reread';
    } else {
      delete state[HMS_SNAPSHOT_KEY];
      resolution = 'staff_checked';
    }
    await tx.update(workItem).set({ state, updatedAt: now }).where(eq(workItem.id, item.id));
    await tx.insert(workEvent).values({
      workItemId: item.id,
      at: now,
      actorKind: 'user',
      actorUserId: input.actorUserId,
      type: 'status.changed',
      value: { needsCheck: false, resolvedRunId: runId, resolution, ...(note ? { note } : {}) },
    });
    return { runId, resolution };
  });
}

/**
 * The runner's single use of an approval, made while it holds the run's lease. It refuses when the lease is
 * gone, the grant is missing or altered, the snapshot is 30 minutes old, the form changed, or the grant is used.
 */
export async function consumeHmsWriteApproval(input: {
  db?: DB;
  runId: string;
  fence: AiRunFence;
  now?: Date;
}): Promise<{
  grantId: string;
  payloadHash: string;
  hmsBeforeDigest: string;
  actorUserId: string;
  sessionId?: string;
  sessionProfile?: 'legacy' | 'remote';
  authority: { actorUserId: string; sessionId: string; sessionProfile: 'legacy' | 'remote' } | null;
  verifiedStaffGo?: VerifiedStaffGo;
  /** The approved form, read from the locked row. A runner writes this, not a fresh read of the work item. */
  form: Record<string, unknown>;
}> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    // Row lock plus a fresh updatedAt: a sweep that runs after this commit sees a live lease and leaves the run.
    const [run] = await tx
      .select()
      .from(aiWorkflowRun)
      .where(
        and(
          eq(aiWorkflowRun.id, input.runId),
          eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND),
          eq(aiWorkflowRun.claimOwner, input.fence.claimOwner),
          eq(aiWorkflowRun.claimToken, input.fence.claimToken),
          inArray(aiWorkflowRun.state, ['claimed', 'running']),
        ),
      )
      .limit(1)
      .for('update');
    if (!run) throw new HmsApprovalError('lease_lost');
    const grantId = grantIdForRun(run);
    if (!run.workItemId || !grantId) throw new HmsApprovalError('no_grant');
    const [item] = await tx
      .select()
      .from(workItem)
      .where(eq(workItem.id, run.workItemId))
      .limit(1)
      .for('update');
    if (!item) throw new HmsApprovalError('not_found');
    if (item.status === 'done' || item.status === 'dismissed') throw new HmsApprovalError('not_open');
    const { grant, payloadHash } = await loadGrant(tx as DB, item.id, grantId);
    let verified: VerifiedStaffGo | undefined;
    if ('version' in grant && grant.version === 2) {
      try { verified = await verifyStaffGoForRun(tx, input.fence); }
      catch { throw new HmsApprovalError('state_changed'); }
    } else {
      // Legacy authority is retained only for existing HRCEN runs with an authenticated session.
      if (!grant.sessionId || !grant.sessionProfile || resolvePropertyScope({ transportId: grant.transportId }).propertyCode !== 'HRCEN') {
        throw new HmsApprovalError('no_grant');
      }
      await lockCreateActorAccess(tx, { transportId: grant.transportId, actorUserId: grant.actorUserId });
      await lockCreateActorSession(tx, { actorUserId: grant.actorUserId, sessionId: grant.sessionId, sessionProfile: grant.sessionProfile });
    }
    if (snapshotStale(grant.hmsReadAt, now)) throw new HmsApprovalError('snapshot_stale');
    if (formDigest(item.state) !== grant.formDigest) throw new HmsApprovalError('state_changed');
    const [used] = await tx
      .select({ id: workEvent.id })
      .from(workEvent)
      .where(
        and(
          eq(workEvent.workItemId, item.id),
          eq(workEvent.type, 'approval.consumed'),
          eq(workEvent.payloadHash, payloadHash),
        ),
      )
      .limit(1);
    if (used) throw new HmsApprovalError('already_consumed');
    // V2 consumes only in the short native-dispatch transaction after restaging.
    // Existing V1 recovery retains its previously recorded consumption semantics.
    if (!verified) await tx.insert(workEvent).values({
      workItemId: item.id, at: now, actorKind: 'system', type: 'approval.consumed',
      payloadHash, value: { grantId, runId: run.id },
    });
    await tx
      .update(aiWorkflowRun)
      .set({ heartbeatAt: now, updatedAt: now })
      .where(eq(aiWorkflowRun.id, run.id));
    const authority = grant.sessionId && grant.sessionProfile
      ? { actorUserId: grant.actorUserId, sessionId: grant.sessionId, sessionProfile: grant.sessionProfile }
      : null;
    return { grantId, payloadHash, hmsBeforeDigest: grant.hmsBeforeDigest, actorUserId: grant.actorUserId,
      sessionId: grant.sessionId, sessionProfile: grant.sessionProfile, form: formOf(item.state), authority,
      ...(verified ? { verifiedStaffGo: verified } : {}) };
  });
}

type HmsDispatchTransaction = Parameters<Parameters<DB['transaction']>[0]>[0];

/** Runs within the native request's short authorization transaction. */
async function recordHmsDispatchStarted(tx: HmsDispatchTransaction, fence: AiRunFence, grant: HmsWriteGrant): Promise<void> {
  if (!('version' in grant) || grant.version !== 2) return;
  await consumeStaffGoAtDispatch(tx, fence);
}

/** The native request continues only after this transaction commits. */
export function hmsAllocationOperationId(grantId: string, allocationId: string): string {
  const hex = createHash('sha256').update('zero/hms-allocation/v2\0').update(grantId).update('\0').update(allocationId).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function consumeStaffGoAtDispatch(tx: HmsDispatchTransaction, fence: AiRunFence,
  signal?: AbortSignal, allocationId?: string, profilePhase?: 'initial' | 'confirm_distinct'): Promise<VerifiedStaffGo> {
  signal?.throwIfAborted();
  const authority = await verifyStaffGoForRun(tx, fence, allocationId !== undefined || profilePhase === 'confirm_distinct');
  const grant = authority.grant;
  const started = await tx.select({ value: workEvent.value }).from(workEvent).where(and(
    eq(workEvent.workItemId, grant.workItemId), eq(workEvent.type, 'hms.dispatch.started'),
    eq(workEvent.payloadHash, authority.payloadHash))).for('share');
  let operationId: string | undefined;
  if (allocationId !== undefined) {
    const allocations = authority.preparation.allocations;
    const index = allocations?.findIndex(allocation => allocation.allocationId === allocationId) ?? -1;
    if (grant.operation !== 'create' || !allocations ||
        index < 0 || started.length !== index) throw new HmsApprovalError('state_changed');
    const [item] = await tx.select({ state: workItem.state }).from(workItem)
      .where(eq(workItem.id, grant.workItemId)).limit(1).for('share');
    if (authority.preparation.workflowContext) throw new HmsApprovalError('state_changed');
    const evidence = await tx.select({ value: workEvent.value }).from(workEvent).where(and(
      eq(workEvent.workItemId, grant.workItemId), eq(workEvent.type, 'write.evidence'), eq(workEvent.actorKind, 'system'),
      eq(workEvent.fieldPath, 'nava.hms.labtest.dispatch.v1'))).for('share');
    for (const earlier of allocations.slice(0, index)) {
      const earlierId = hmsAllocationOperationId(grant.grantId, earlier.allocationId);
      const dispatched = started.some(event => {
        const parsed = z.object({ runId: z.string(), allocationId: z.string(), operationId: z.string() }).safeParse(event.value);
        return parsed.success && parsed.data.runId === fence.runId && parsed.data.allocationId === earlier.allocationId && parsed.data.operationId === earlierId;
      });
      const stays = item?.state.stays;
      const row = stays && typeof stays === 'object' && !Array.isArray(stays)
        ? (stays as Record<string, unknown>)[earlier.allocationId] : undefined;
      const booked = z.object({ status: z.literal('booked'), cloudCreateVerified: z.literal(true),
        cloudCreateGrantId: z.literal(earlierId), confirmationNumber: z.string().regex(/^\d+-\d+$/),
        readbackDigest: z.string().regex(/^[a-f0-9]{64}$/), observationRef: z.string().min(1) }).safeParse(row);
      const intent = evidence.map(event => z.object({ version: z.literal(1), kind: z.literal('intent'),
        holdId: z.string().uuid(), operation: z.literal('create'), grantId: z.literal(earlierId),
        stayId: z.literal(earlier.allocationId), transportId: z.literal(grant.transportId),
        propertyCode: z.literal(grant.propertyCode) }).safeParse(event.value)).filter(value => value.success);
      const readback = booked.success && intent.length === 1 && evidence.some(event => {
        const resolved = z.object({ version: z.literal(1), kind: z.literal('resolved'), operation: z.literal('create'),
          holdId: z.literal(intent[0]!.data.holdId), confirmation: z.literal(booked.data.confirmationNumber),
          readbackDigest: z.literal(booked.data.readbackDigest), nativeReadback: z.record(z.string(), z.unknown()) }).safeParse(event.value);
        return resolved.success && hmsStateDigest(resolved.data.nativeReadback) === resolved.data.readbackDigest;
      });
      if (!dispatched || !readback) throw new HmsApprovalError('state_changed');
    }
    operationId = hmsAllocationOperationId(grant.grantId, allocationId);
  } else if (profilePhase) {
    const context = authority.preparation.workflowContext;
    if (grant.operation !== 'create_guest_profile' || context?.endpoint !== 'createGuestProfile' ||
        (profilePhase === 'initial' && started.length !== 0) ||
        (profilePhase === 'confirm_distinct' && (context.input.confirmDuplicateName !== true || started.length !== 1 ||
          !started.some(event => {
            const parsed = z.object({ runId: z.string(), profilePhase: z.literal('initial') }).safeParse(event.value);
            return parsed.success && parsed.data.runId === fence.runId;
          })))) throw new HmsApprovalError('state_changed');
  } else if (started.length) throw new HmsApprovalError('already_consumed');
  if (!started.length) await tx.insert(workEvent).values({ workItemId: grant.workItemId, actorKind: 'system',
    type: 'approval.consumed', payloadHash: authority.payloadHash, value: { grantId: grant.grantId, runId: fence.runId } });
  await tx.insert(workEvent).values({ workItemId: grant.workItemId, actorKind: 'system',
    type: 'hms.dispatch.started', payloadHash: authority.payloadHash,
    value: { version: 2, grantId: grant.grantId, preparedRef: grant.preparedRef, runId: fence.runId,
      propertyCode: grant.propertyCode, tenantId: grant.tenantId, operation: grant.operation,
      targetAliases: authority.preparation.targetAliases, allocations: authority.preparation.allocations ?? [],
      ...(allocationId === undefined ? {} : { allocationId, operationId }),
      ...(profilePhase === undefined ? {} : { profilePhase }) } });
  signal?.throwIfAborted();
  return authority;
}

/** A dispatched receipt remains evidence of uncertainty even after a worker restart. */
export async function hmsWriteRunStarted(db: DB, runId: string): Promise<boolean> {
  const [started] = await db.select({ id: workEvent.id }).from(workEvent).where(and(
    inArray(workEvent.type, ['approval.consumed', 'hms.dispatch.started']),
    sql`${workEvent.value}->>'runId' = ${runId}`)).limit(1);
  return Boolean(started);
}

/** Terminal success must name durable readback from this receipt, including every ordered room. */
export async function hmsWriteRunReadbackCompleted(db: DB, fence: AiRunFence, observationRef: string): Promise<boolean> {
  const [run] = await db.select().from(aiWorkflowRun).where(and(eq(aiWorkflowRun.id, fence.runId),
    eq(aiWorkflowRun.claimOwner, fence.claimOwner), eq(aiWorkflowRun.claimToken, fence.claimToken),
    eq(aiWorkflowRun.state, 'running'), eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND))).limit(1);
  const grantId = /^hms-write:([a-f0-9-]{36})$/.exec(run?.idempotencyKey ?? '')?.[1];
  if (!run?.workItemId || !grantId) return false;
  const [event] = await db.select().from(workEvent).where(and(eq(workEvent.id, grantId),
    eq(workEvent.workItemId, run.workItemId), eq(workEvent.type, 'approval.granted'))).limit(1);
  const parsed = hmsWriteGrantV2Schema.safeParse(event?.value);
  if (!parsed.success || event?.actorKind !== 'user' || event.actorUserId !== parsed.data.actorUserId ||
      event.payloadHash !== preparationDigest(parsed.data) || parsed.data.transportId !== run.transportId) return false;
  const grant = parsed.data, prepared = await loadHmsPreparation(db, grant.preparedRef, run.workItemId);
  const [item] = await db.select({ state: workItem.state }).from(workItem).where(and(eq(workItem.id, run.workItemId),
    eq(workItem.transportId, grant.transportId))).limit(1);
  if (!item) return false;
  if (prepared.workflowContext) return false;
  const evidence = await db.select({ id: workEvent.id, value: workEvent.value }).from(workEvent).where(and(
    eq(workEvent.workItemId, run.workItemId), eq(workEvent.type, 'write.evidence'), eq(workEvent.actorKind, 'system'),
    eq(workEvent.fieldPath, 'nava.hms.labtest.dispatch.v1')));
  const ids = grant.operation === 'create' ? prepared.allocations?.map(allocation => ({ id: hmsAllocationOperationId(grantId, allocation.allocationId),
    allocationId: allocation.allocationId })) : [{ id: grantId }];
  if (!ids?.length) return false;
  let returnedObservation = false;
  for (const operation of ids) {
    const intents = evidence.map(event => z.object({ kind: z.literal('intent'), holdId: z.string().uuid(),
      grantId: z.literal(operation.id), transportId: z.literal(grant.transportId), propertyCode: z.literal(grant.propertyCode),
      operation: z.literal(grant.operation) }).safeParse(event.value)).filter(value => value.success);
    if (intents.length !== 1) return false;
    const resolved = evidence.filter(event => {
      const result = z.object({ kind: z.literal('resolved'), holdId: z.literal(intents[0]!.data.holdId),
        operation: z.literal(grant.operation), nativeReadback: z.record(z.string(), z.unknown()),
        readbackDigest: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(event.value);
      return result.success && hmsStateDigest(result.data.nativeReadback) === result.data.readbackDigest;
    });
    if (resolved.length !== 1) return false;
    if ('allocationId' in operation) {
      const stays = item.state.stays;
      const row = stays && typeof stays === 'object' && !Array.isArray(stays) ? (stays as Record<string, unknown>)[operation.allocationId] : undefined;
      const saved = z.object({ status: z.literal('booked'), cloudCreateVerified: z.literal(true), cloudCreateGrantId: z.literal(operation.id),
        observationRef: z.string().min(1), readbackDigest: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(row);
      if (!saved.success || saved.data.readbackDigest !== (resolved[0]!.value as Record<string, unknown>).readbackDigest) return false;
      returnedObservation ||= saved.data.observationRef === observationRef;
    } else returnedObservation ||= resolved[0]!.id === observationRef;
  }
  return returnedObservation;
}

export async function hmsWriteRunReviewCompleted(db: DB, fence: AiRunFence): Promise<boolean> {
  const [run] = await db.select({ workItemId: aiWorkflowRun.workItemId, transportId: aiWorkflowRun.transportId,
    idempotencyKey: aiWorkflowRun.idempotencyKey }).from(aiWorkflowRun).where(and(eq(aiWorkflowRun.id, fence.runId),
      eq(aiWorkflowRun.claimOwner, fence.claimOwner), eq(aiWorkflowRun.claimToken, fence.claimToken),
      eq(aiWorkflowRun.state, 'running'), eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND))).limit(1);
  const grantId = /^hms-write:([a-f0-9-]{36})$/.exec(run?.idempotencyKey ?? '')?.[1];
  if (!run?.workItemId || !grantId) return false;
  const [granted] = await db.select().from(workEvent).where(and(eq(workEvent.id, grantId),
    eq(workEvent.workItemId, run.workItemId), eq(workEvent.type, 'approval.granted'))).limit(1);
  const grant = hmsWriteGrantV2Schema.safeParse(granted?.value);
  if (!grant.success || grant.data.operation !== 'amend' || grant.data.transportId !== run.transportId ||
      granted?.payloadHash !== preparationDigest(grant.data)) return false;
  const reviews = await db.select({ value: workEvent.value }).from(workEvent).where(and(
    eq(workEvent.workItemId, run.workItemId), eq(workEvent.type, 'hms.dispatch.reviewed'),
    eq(workEvent.actorKind, 'system'), eq(workEvent.payloadHash, granted.payloadHash),
    sql`${workEvent.value}->>'runId' = ${fence.runId}`)).limit(2);
  if (reviews.length !== 1) return false;
  const review = z.object({ version: z.literal(1), runId: z.string().uuid(), grantId: z.string().uuid(),
    preparedRef: z.string().uuid(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/), propertyCode: z.string(),
    observationRef: z.string().min(1), requestId: z.string().min(1), allocationId: z.string().min(1), holdId: z.string().uuid(),
    callbackReviewDigest: z.string().regex(/^[a-f0-9]{64}$/), freshReadbackDigest: z.string().regex(/^[a-f0-9]{64}$/),
    finalSave: z.literal(false) }).strict().safeParse(reviews[0]?.value);
  return review.success && review.data.runId === fence.runId && review.data.grantId === grantId &&
    review.data.preparedRef === grant.data.preparedRef && review.data.propertyCode === grant.data.propertyCode &&
    review.data.payloadHash === granted.payloadHash;
}

/** Revalidate the consumed Cloud cancel Go at the exact intercepted POST. */
export async function lockConsumedCloudCancelApproval(tx: HmsDispatchTransaction, input: {
  fence: AiRunFence;
  transportId: string;
  item: typeof workItem.$inferSelect;
  grantId: string;
  approvedDigest: string;
  authority: NonNullable<Awaited<ReturnType<typeof consumeHmsWriteApproval>>['authority']>;
  env?: NodeJS.Dict<string>;
  phase?: 'dispatch';
}): Promise<void> {
  const { item, authority, fence } = input;
  if (!item || item.transportId !== input.transportId || item.state.action !== 'cancel' ||
      !Object.hasOwn(item.state, 'cloudCancel') || !item.threadId || !item.sourceMessageId ||
      item.status === 'done' || item.status === 'dismissed') throw new HmsApprovalError('state_changed');
  const { cloudCancelDispatchSchema } = await import('./pane-cloud-cancel.js');
  const bound = cloudCancelDispatchSchema.safeParse(item.state.cloudCancel);
  if (!bound.success) throw new HmsApprovalError('state_changed');
  await lockCreateActorAccess(tx, { transportId: input.transportId, actorUserId: authority.actorUserId });
  await lockCreateActorSession(tx, authority);
  const [run] = await tx.select().from(aiWorkflowRun).where(and(
    eq(aiWorkflowRun.id, fence.runId), eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND),
    eq(aiWorkflowRun.claimOwner, fence.claimOwner), eq(aiWorkflowRun.claimToken, fence.claimToken),
    eq(aiWorkflowRun.workItemId, item.id), eq(aiWorkflowRun.transportId, input.transportId),
    inArray(aiWorkflowRun.promptVersion, [HMS_CLOUD_CANCEL_PROMPT_VERSION, HMS_V2_WRITE_PROMPT_VERSION]),
    inArray(aiWorkflowRun.state, ['claimed', 'running']),
  )).limit(1).for('update');
  const now = new Date();
  if (!run?.deadlineAt ||
      run.deadlineAt.getTime() !== fence.deadlineAt.getTime() ||
      run.deadlineAt.getTime() <= now.getTime() || run.threadId !== item.threadId ||
      run.triggerMessageId !== item.sourceMessageId) throw new HmsApprovalError('lease_lost');
  if (grantIdForRun(run) !== input.grantId) throw new HmsApprovalError('no_grant');
  const { grant, payloadHash } = await loadGrant(tx as DB, item.id, input.grantId, true);
  const v2 = 'version' in grant && grant.version === 2;
  const verified = v2 ? await verifyStaffGoForRun(tx, fence, input.phase !== 'dispatch') : undefined;
  const scope = verified?.preparation.scope ?? resolvePropertyScope({ transportId: grant.transportId });
  const expectedPrompt = v2 ? HMS_V2_WRITE_PROMPT_VERSION : HMS_CLOUD_CANCEL_PROMPT_VERSION;
  if (run.promptVersion !== expectedPrompt || (verified && (verified.grant.grantId !== input.grantId ||
      verified.grant.operation !== 'cancel')) || (!v2 && (scope.propertyCode !== 'HRCEN' || input.phase === 'dispatch'))) {
    throw new HmsApprovalError('no_grant');
  }
  const mode = effectiveWorkflowPolicy(input.env ?? process.env, scope.propertyCode, 'cancel').admittedMode;
  if (mode === 'off' || (bound.data.preimage.allowRealGuest && mode !== 'on') ||
      (bound.data.preimage.propertyCode ?? (!v2 ? 'HRCEN' : undefined)) !== scope.propertyCode) {
    throw new HmsApprovalError('state_changed');
  }
  const snapshot = verified ? { digest: verified.preparation.nativeObservation.beforeDigest,
    readAt: verified.preparation.nativeObservation.capturedAt } : readSnapshot(item.state);
  if (grant.workItemId !== item.id || grant.transportId !== input.transportId ||
      grant.actorUserId !== authority.actorUserId || grant.sessionId !== authority.sessionId ||
      grant.sessionProfile !== authority.sessionProfile || grant.formDigest !== input.approvedDigest ||
      formDigest(item.state) !== input.approvedDigest || snapshotStale(grant.hmsReadAt, now) ||
      !snapshot || snapshot.digest !== grant.hmsBeforeDigest || snapshot.readAt !== grant.hmsReadAt) {
    throw new HmsApprovalError('state_changed');
  }
  const consumed = await tx.select({ id: workEvent.id }).from(workEvent).where(and(
    eq(workEvent.workItemId, item.id), eq(workEvent.type, 'approval.consumed'), eq(workEvent.actorKind, 'system'),
    eq(workEvent.payloadHash, payloadHash), sql`${workEvent.value}->>'runId' = ${run.id}`,
    sql`${workEvent.value}->>'grantId' = ${input.grantId}`,
  )).limit(2).for('share');
  if (consumed.length !== (v2 && input.phase === 'dispatch' ? 0 : 1)) {
    throw new HmsApprovalError('not_consumed');
  }
  const at = new Date();
  if (run.deadlineAt.getTime() <= at.getTime() || snapshotStale(grant.hmsReadAt, at)) {
    throw new HmsApprovalError('lease_lost');
  }
  if (input.phase === 'dispatch') await recordHmsDispatchStarted(tx, input.fence, grant);
  await tx.update(aiWorkflowRun).set({ heartbeatAt: at, updatedAt: at }).where(eq(aiWorkflowRun.id, run.id));
}

/** Revalidate the consumed Cloud amend Go inside the durable dispatch claim. */
export async function lockConsumedCloudAmendApproval(tx: HmsDispatchTransaction, input: {
  fence: AiRunFence;
  transportId: string;
  item: typeof workItem.$inferSelect;
  grantId: string;
  approvedDigest: string;
  authority: NonNullable<Awaited<ReturnType<typeof consumeHmsWriteApproval>>['authority']>;
  env?: NodeJS.Dict<string>;
}): Promise<void> {
  const { item, authority, fence } = input;
  if (!item || item.transportId !== input.transportId || item.state.action !== 'amend' ||
      !Object.hasOwn(item.state, 'cloudAmend') || !item.threadId || !item.sourceMessageId ||
      item.status === 'done' || item.status === 'dismissed') throw new HmsApprovalError('state_changed');
  await lockCreateActorAccess(tx, { transportId: input.transportId, actorUserId: authority.actorUserId });
  await lockCreateActorSession(tx, authority);
  const [run] = await tx.select().from(aiWorkflowRun).where(and(
    eq(aiWorkflowRun.id, fence.runId), eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND),
    eq(aiWorkflowRun.claimOwner, fence.claimOwner), eq(aiWorkflowRun.claimToken, fence.claimToken),
    eq(aiWorkflowRun.workItemId, item.id), eq(aiWorkflowRun.transportId, input.transportId),
    inArray(aiWorkflowRun.promptVersion, [HMS_LABTEST_AMEND_PROMPT_VERSION, HMS_V2_WRITE_PROMPT_VERSION]),
    inArray(aiWorkflowRun.state, ['claimed', 'running']),
  )).limit(1).for('update');
  const now = new Date();
  if (!run?.deadlineAt ||
      run.deadlineAt.getTime() !== fence.deadlineAt.getTime() ||
      run.deadlineAt.getTime() <= now.getTime() || run.threadId !== item.threadId ||
      run.triggerMessageId !== item.sourceMessageId) throw new HmsApprovalError('lease_lost');
  if (grantIdForRun(run) !== input.grantId) throw new HmsApprovalError('no_grant');
  const { grant, payloadHash } = await loadGrant(tx as DB, item.id, input.grantId, true);
  if (!('version' in grant) || grant.version !== 2 || run.promptVersion !== HMS_V2_WRITE_PROMPT_VERSION) {
    throw new HmsApprovalError('no_grant');
  }
  const verified = await verifyStaffGoForRun(tx, fence);
  if (verified.grant.grantId !== input.grantId || verified.grant.operation !== 'amend') throw new HmsApprovalError('no_grant');
  await assertCloudAmendForm(item.state, input.env, verified.grant.propertyCode);
  const snapshot = { digest: verified.preparation.nativeObservation.beforeDigest,
    readAt: verified.preparation.nativeObservation.capturedAt };
  if (grant.workItemId !== item.id || grant.transportId !== input.transportId ||
      grant.actorUserId !== authority.actorUserId || grant.sessionId !== authority.sessionId ||
      grant.sessionProfile !== authority.sessionProfile || grant.formDigest !== input.approvedDigest ||
      formDigest(item.state) !== input.approvedDigest || snapshotStale(grant.hmsReadAt, now) ||
      !snapshot || snapshot.digest !== grant.hmsBeforeDigest || snapshot.readAt !== grant.hmsReadAt) {
    throw new HmsApprovalError('state_changed');
  }
  const consumed = await tx.select({ id: workEvent.id }).from(workEvent).where(and(
    eq(workEvent.workItemId, item.id), eq(workEvent.type, 'approval.consumed'), eq(workEvent.actorKind, 'system'),
    eq(workEvent.payloadHash, payloadHash), sql`${workEvent.value}->>'runId' = ${run.id}`,
    sql`${workEvent.value}->>'grantId' = ${input.grantId}`,
  )).limit(2).for('share');
  if (consumed.length !== 0) {
    throw new HmsApprovalError('not_consumed');
  }
  const at = new Date();
  if (run.deadlineAt.getTime() <= at.getTime() || snapshotStale(grant.hmsReadAt, at)) {
    throw new HmsApprovalError('lease_lost');
  }
  await recordHmsDispatchStarted(tx, input.fence, grant);
  await tx.update(aiWorkflowRun).set({ heartbeatAt: at, updatedAt: at }).where(eq(aiWorkflowRun.id, run.id));
}

type WorkTransaction = Parameters<Parameters<DB['transaction']>[0]>[0];

/** Revalidate the consumed Go and its source inside the shared native-dispatch claim. */
export async function authorizeConsumedLabtestAttach(tx: WorkTransaction, input: {
  fence: AiRunFence; transportId: string; workItemId: string; grantId: string; actorUserId: string;
  sessionId: string; sessionProfile: 'legacy' | 'remote'; sourceDigest: string; approvedDigest: string;
  confirmation: string; arrival: string; documentCode: string; documentName: string; pdfSha256: string;
  lockSource: (tx: WorkTransaction) => Promise<typeof workItem.$inferSelect | null>;
  env?: NodeJS.Dict<string>;
}): Promise<void> {
  if (!/^NAVA[A-Z2-7]{25}[AEIMQUY4]$/.test(input.documentCode) ||
      !/^[a-f0-9]{64}$/.test(input.sourceDigest) || !/^[a-f0-9]{64}$/.test(input.approvedDigest) ||
      !/^[a-f0-9]{64}$/.test(input.pdfSha256)) throw new HmsApprovalError('filing_unavailable');
  const item = await input.lockSource(tx);
  if (!item || item.id !== input.workItemId || item.transportId !== input.transportId ||
      item.state.action !== 'attach_document' || item.state.confirmation !== input.confirmation ||
      item.state.arrival !== input.arrival || item.state.sourceSnapshotDigest !== input.sourceDigest ||
      item.state.documentName !== input.documentName || item.state.pdfSha256 !== input.pdfSha256 ||
      item.state.documentCode !== input.documentCode) {
    throw new HmsApprovalError('state_changed');
  }
  if (item.state.sourceThreadId !== item.threadId || typeof item.state.sourceHash !== 'string' ||
      !item.threadId || !item.sourceMessageId || !await currentSelectedHmsSource(tx as DB, input.transportId, {
        threadId: item.threadId, messageId: item.sourceMessageId, sourceHash: item.state.sourceHash,
      })) throw new HmsApprovalError('source_mail_changed');
  const [transport] = await tx.select({ active: mailboxTransport.isActive }).from(mailboxTransport)
    .where(eq(mailboxTransport.id, input.transportId)).limit(1).for('share');
  const [access] = await tx.select({ userId: mailboxAccess.userId }).from(mailboxAccess).where(and(
    eq(mailboxAccess.userId, input.actorUserId), eq(mailboxAccess.transportId, input.transportId))).limit(1).for('share');
  const sessions = input.sessionProfile === 'remote' ? remoteSession : session;
  const [activeSession] = await tx.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.id, input.sessionId),
    eq(sessions.userId, input.actorUserId), sql`${sessions.expiresAt} > timezone('UTC', clock_timestamp())`)).limit(1).for('share');
  if (!transport?.active || !access || !activeSession) throw new HmsApprovalError('filing_unavailable');
  const [run] = await tx.select().from(aiWorkflowRun).where(and(eq(aiWorkflowRun.id, input.fence.runId),
    eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND), eq(aiWorkflowRun.claimOwner, input.fence.claimOwner),
    eq(aiWorkflowRun.claimToken, input.fence.claimToken), eq(aiWorkflowRun.workItemId, item.id),
    eq(aiWorkflowRun.transportId, input.transportId),
    inArray(aiWorkflowRun.promptVersion, [HMS_LABTEST_ATTACH_PROMPT_VERSION, HMS_V2_WRITE_PROMPT_VERSION]),
    inArray(aiWorkflowRun.state, ['claimed', 'running']))).limit(1).for('update');
  const now = new Date();
  if (!run?.deadlineAt || run.deadlineAt.getTime() !== input.fence.deadlineAt.getTime() ||
      run.deadlineAt.getTime() <= now.getTime() || run.threadId !== item.threadId ||
      run.triggerMessageId !== item.sourceMessageId || grantIdForRun(run) !== input.grantId) throw new HmsApprovalError('lease_lost');
  const { grant, payloadHash } = await loadGrant(tx as DB, item.id, input.grantId, true);
  if (!('version' in grant) || grant.version !== 2 || run.promptVersion !== HMS_V2_WRITE_PROMPT_VERSION) {
    throw new HmsApprovalError('no_grant');
  }
  const verified = await verifyStaffGoForRun(tx, input.fence);
  const mode = effectiveWorkflowPolicy(input.env ?? process.env, verified.grant.propertyCode, 'attach').admittedMode;
  if (verified.grant.grantId !== input.grantId || verified.grant.operation !== 'attach_document' || mode === 'off' ||
      !isBoundLabtestAttachment(item.state, item.sourceMessageId, mode)) {
    throw new HmsApprovalError('filing_unavailable');
  }
  const snapshot = { digest: verified.preparation.nativeObservation.beforeDigest,
    readAt: verified.preparation.nativeObservation.capturedAt };
  if (grant.workItemId !== item.id || grant.transportId !== input.transportId || grant.actorUserId !== input.actorUserId ||
      grant.sessionId !== input.sessionId || grant.sessionProfile !== input.sessionProfile ||
      formDigest(item.state) !== grant.formDigest || grant.formDigest !== input.approvedDigest ||
      grant.hmsBeforeDigest !== item.state.filingStateDigest ||
      snapshotStale(grant.hmsReadAt, now) || !snapshot || snapshot.digest !== grant.hmsBeforeDigest ||
      snapshot.readAt !== grant.hmsReadAt) throw new HmsApprovalError('state_changed');
  const consumed = await tx.select({ id: workEvent.id }).from(workEvent).where(and(eq(workEvent.workItemId, item.id),
    eq(workEvent.type, 'approval.consumed'), eq(workEvent.actorKind, 'system'), eq(workEvent.payloadHash, payloadHash),
    sql`${workEvent.value}->>'runId' = ${run.id}`, sql`${workEvent.value}->>'grantId' = ${input.grantId}`)).limit(2).for('share');
  if (consumed.length !== 0) {
    throw new HmsApprovalError('not_consumed');
  }
  const checkedAt = new Date();
  if (checkedAt.getTime() >= run.deadlineAt.getTime() || snapshotStale(grant.hmsReadAt, checkedAt)) {
    throw new HmsApprovalError('lease_lost');
  }
  await recordHmsDispatchStarted(tx, input.fence, grant);
  await tx.update(aiWorkflowRun).set({ heartbeatAt: checkedAt, updatedAt: checkedAt }).where(eq(aiWorkflowRun.id, run.id));
}

async function hmsRereadReason(
  read: () => Promise<unknown>,
  expectedDigest: string,
): Promise<'hms_changed' | 'reread_failed' | null> {
  try {
    return hmsStateDigest(await read()) === expectedDigest ? null : 'hms_changed';
  } catch {
    // Fail closed: an unreadable booking is not a booking we may write to.
    return 'reread_failed';
  }
}

type HmsPreSaveReason = 'hms_changed' | 'reread_failed' | 'form_changed' | 'not_open' | 'snapshot_stale';

export type HmsPreSaveOutcome =
  | { status: 'unchanged' }
  | { status: 'needs_check'; reason: HmsPreSaveReason }
  | { status: 'lease_lost' };

/**
 * Last check before Save, run by the hms_write runner. It proves the lease is held, that this run consumed its
 * grant, that the item is open with the approved form, and that HMS still matches the grant's before-state digest.
 * The item, the form, the approval's 30-minute window and the lease are checked again after the re-read, so a dismiss,
 * an edit, an expiry or a lost lease during it cannot allow Save. A mismatch or an unreadable booking dead-letters the
 * run to needs-check. Only 'unchanged' allows Save.
 */
export async function assertHmsUnchangedBeforeSave(input: {
  db?: DB;
  runId: string;
  fence: AiRunFence;
  readHmsState: () => Promise<unknown>;
  /** The clock for the approval's age, read after the HMS re-read. Defaults to the wall clock. */
  now?: () => Date;
}): Promise<HmsPreSaveOutcome> {
  const db = input.db ?? getDb();
  if (input.runId !== input.fence.runId) throw new HmsApprovalError('lease_lost');
  const [run] = await db
    .select()
    .from(aiWorkflowRun)
    .where(
      and(eq(aiWorkflowRun.id, input.fence.runId), eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND)),
    )
    .limit(1);
  const grantId = run ? grantIdForRun(run) : null;
  if (!run?.workItemId || !grantId) throw new HmsApprovalError('not_found');
  const { grant, payloadHash } = await loadGrant(db, run.workItemId, grantId);
  if (!(await heartbeatAiRun(input.fence, db))) return { status: 'lease_lost' };
  const [consumed] = await db
    .select({ id: workEvent.id })
    .from(workEvent)
    .where(
      and(
        eq(workEvent.workItemId, run.workItemId),
        eq(workEvent.type, 'approval.consumed'),
        eq(workEvent.payloadHash, payloadHash),
      ),
    )
    .limit(1);
  if (!consumed) {
    if (!('version' in grant) || grant.version !== 2) throw new HmsApprovalError('not_consumed');
    await db.transaction((tx) => verifyStaffGoForRun(tx, input.fence));
  }
  const workItemId = run.workItemId;
  const itemReason = async (): Promise<'not_open' | 'form_changed' | null> => {
    const [item] = await db
      .select({ state: workItem.state, status: workItem.status })
      .from(workItem)
      .where(eq(workItem.id, workItemId))
      .limit(1);
    if (!item || item.status === 'done' || item.status === 'dismissed') return 'not_open';
    return formDigest(item.state) === grant.formDigest ? null : 'form_changed';
  };
  let reason: HmsPreSaveReason | null =
    (await itemReason()) ?? (await hmsRereadReason(input.readHmsState, grant.hmsBeforeDigest));
  // The HMS read takes time: staff may dismiss or edit the item meanwhile, and the approval may pass 30 minutes.
  if (!reason) reason = await itemReason();
  if (!reason && snapshotStale(grant.hmsReadAt, input.now?.() ?? new Date())) reason = 'snapshot_stale';
  if (!(await heartbeatAiRun(input.fence, db))) return { status: 'lease_lost' };
  if (!reason) return { status: 'unchanged' };
  if ('version' in grant && grant.version === 2) return { status: 'needs_check', reason };
  await db.transaction(async (tx) => {
    const now = new Date();
    const row = await markAiRunDeadLetter(
      {
        runId: input.fence.runId,
        claimOwner: input.fence.claimOwner,
        claimToken: input.fence.claimToken,
        expectedStates: ['claimed', 'running'],
        lastError: reason,
        failureClass: 'NEEDS_CHECK',
      },
      tx as DB,
    );
    if (row?.workItemId) {
      if (reason === 'hms_changed') {
        // HMS moved on from the approved snapshot, so the next approval must re-read it (KTD11). A newer snapshot stays.
        await tx
          .update(workItem)
          .set({ state: sql`${workItem.state} - 'hmsSnapshot'`, updatedAt: now })
          .where(
            and(
              eq(workItem.id, row.workItemId),
              sql`${workItem.state}->'hmsSnapshot'->>'digest' = ${grant.hmsBeforeDigest}`,
            ),
          );
      }
      await recordNeedsCheck(tx as DB, {
        workItemId: row.workItemId,
        runId: row.id,
        failureClass: 'NEEDS_CHECK',
        reason,
        now,
      });
    }
  });
  return { status: 'needs_check', reason };
}

/**
 * Turns hms_write runs whose lease went stale into needs-check. It dead-letters them as LEASE_LOST, and it never
 * re-queues them. The compare-and-set on updatedAt keeps it from racing a live heartbeat or a consume.
 */
export async function sweepLostHmsWriteLeases(
  input: { db?: DB; now?: Date; staleRunTimeoutMs?: number } = {},
): Promise<number> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const staleRunTimeoutMs =
    input.staleRunTimeoutMs ??
    parseEnv(process.env as Record<string, string | undefined>).AI_STALE_RUN_TIMEOUT_MS;
  const staleBefore = new Date(now.getTime() - staleRunTimeoutMs);
  const stale = await db
    .select({ id: aiWorkflowRun.id })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND),
        inArray(aiWorkflowRun.state, ['claimed', 'running']),
        lte(aiWorkflowRun.updatedAt, staleBefore),
      ),
    )
    .limit(50);
  let swept = 0;
  for (const candidate of stale) {
    const lost = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(aiWorkflowRun)
        .set({
          state: 'dead_letter',
          failureClass: 'LEASE_LOST',
          lastError: 'LEASE_LOST',
          claimOwner: null,
          claimToken: null,
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(aiWorkflowRun.id, candidate.id),
            eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND),
            inArray(aiWorkflowRun.state, ['claimed', 'running']),
            lte(aiWorkflowRun.updatedAt, staleBefore),
          ),
        )
        .returning({ id: aiWorkflowRun.id, workItemId: aiWorkflowRun.workItemId });
      if (!row) return false;
      if (row.workItemId) {
        await recordNeedsCheck(tx as DB, {
          workItemId: row.workItemId,
          runId: row.id,
          failureClass: 'LEASE_LOST',
          reason: 'lease_lost',
          now,
        });
      }
      return true;
    });
    if (lost) swept += 1;
  }
  return swept;
}

export function hmsWriteEvidenceKey(input: {
  transportId: string;
  workItemId: string;
  runId: string;
  name: string;
}): string {
  if (
    !PATH_SEGMENT_PATTERN.test(input.transportId) ||
    !UUID_PATTERN.test(input.workItemId) ||
    !UUID_PATTERN.test(input.runId) ||
    !EVIDENCE_NAME_PATTERN.test(input.name)
  ) {
    throw new HmsApprovalError('evidence_invalid');
  }
  return `${HMS_WRITE_EVIDENCE_PREFIX}${input.transportId}/${input.workItemId}/${input.runId}/${input.name}`;
}

/**
 * Writes one sealed PNG for a write run: write-once (IfNoneMatch), SSE, with its sha256 recorded in a
 * write.evidence event. A key that already exists is refused, so a retry cannot upload a second copy.
 */
export async function recordHmsWriteEvidence(input: {
  db?: DB;
  storage?: S3Storage;
  transportId: string;
  workItemId: string;
  runId: string;
  name: string;
  png: Buffer;
  now?: Date;
}): Promise<{ eventId: string; key: string; sha256: string }> {
  const db = input.db ?? getDb();
  const storage = input.storage ?? getS3Storage();
  const now = input.now ?? new Date();
  if (
    input.png.byteLength > EVIDENCE_MAX_BYTES ||
    !PNG_SIGNATURE.equals(input.png.subarray(0, PNG_SIGNATURE.length))
  ) {
    throw new HmsApprovalError('evidence_invalid');
  }
  const key = hmsWriteEvidenceKey(input);
  const [item] = await db
    .select({ id: workItem.id })
    .from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
    .limit(1);
  if (!item) throw new HmsApprovalError('not_found');
  const [run] = await db
    .select({ id: aiWorkflowRun.id })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.id, input.runId),
        eq(aiWorkflowRun.workItemId, item.id),
        eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND),
      ),
    )
    .limit(1);
  if (!run) throw new HmsApprovalError('not_found');
  const sha256 = sha256Hex(input.png);
  try {
    await storage.putObject({
      key,
      body: input.png,
      contentType: 'image/png',
      ifNoneMatch: true,
    });
  } catch (err) {
    if (err instanceof S3KeyExistsError) throw new HmsApprovalError('evidence_exists');
    throw err;
  }
  // If this insert fails, the object is an orphan: no event names it, so the read route never serves it, and the
  // 90-day rule on the prefix expires it.
  const [event] = await db
    .insert(workEvent)
    .values({
      workItemId: item.id,
      at: now,
      actorKind: 'system',
      type: 'write.evidence',
      value: { runId: input.runId, name: input.name },
      evidence: { key, sha256, bytes: input.png.byteLength, contentType: 'image/png' },
    })
    .returning({ id: workEvent.id });
  return { eventId: event!.id, key, sha256 };
}

/**
 * Evidence bytes for one write.evidence event. The transport check goes through the work item, and the key is
 * rebuilt from the event's own fields and compared with the stored key. The bytes must match the recorded sha256.
 */
export async function readHmsWriteEvidence(input: {
  db?: DB;
  storage?: S3Storage;
  transportId: string;
  workItemId: string;
  eventId: string;
  selectedInternetMessageId?: string;
  selectedSource?: HmsSelectedSource;
}): Promise<{ status: 'ok'; dataUrl: string } | { status: 'unavailable'; reason: string }> {
  const db = input.db ?? getDb();
  await assertCurrentHmsSelection(db, input);
  const storage = input.storage ?? getS3Storage();
  const unavailable = { status: 'unavailable' as const, reason: 'evidence_unavailable' };
  const [row] = await db
    .select({ value: workEvent.value, evidence: workEvent.evidence })
    .from(workEvent)
    .innerJoin(workItem, eq(workItem.id, workEvent.workItemId))
    .where(
      and(
        eq(workEvent.id, input.eventId),
        eq(workEvent.workItemId, input.workItemId),
        eq(workEvent.type, 'write.evidence'),
        eq(workItem.transportId, input.transportId),
      ),
    )
    .limit(1);
  const value = z.object({ runId: z.string(), name: z.string() }).safeParse(row?.value);
  const evidence = z.object({ key: z.string(), sha256: z.string() }).safeParse(row?.evidence);
  if (!value.success || !evidence.success) return unavailable;
  let key: string;
  try {
    key = hmsWriteEvidenceKey({
      transportId: input.transportId,
      workItemId: input.workItemId,
      runId: value.data.runId,
      name: value.data.name,
    });
  } catch {
    return unavailable;
  }
  if (evidence.data.key !== key) return unavailable;
  try {
    const object = await storage.getObjectBounded(key, EVIDENCE_MAX_BYTES);
    if (!object || sha256Hex(object.body) !== evidence.data.sha256) return unavailable;
    await assertCurrentHmsSelection(db, input);
    return { status: 'ok', dataUrl: `data:image/png;base64,${object.body.toString('base64')}` };
  } catch {
    return unavailable;
  }
}

/** The latest hms_write run for a work item. Each approval makes one run, so this is also the latest grant. */
async function latestWriteRun(db: DB, workItemId: string) {
  const [run] = await db
    .select({
      id: aiWorkflowRun.id,
      state: aiWorkflowRun.state,
      failureClass: aiWorkflowRun.failureClass,
      lastError: aiWorkflowRun.lastError,
      metrics: aiWorkflowRun.metrics,
      idempotencyKey: aiWorkflowRun.idempotencyKey,
      promptVersion: aiWorkflowRun.promptVersion,
    })
    .from(aiWorkflowRun)
    .where(
      and(eq(aiWorkflowRun.workItemId, workItemId), eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND)),
    )
    .orderBy(desc(aiWorkflowRun.createdAt), desc(aiWorkflowRun.id))
    .limit(1);
  return run ?? null;
}

/** The screenshot evidence one run sealed, oldest first. */
async function evidenceForRun(db: DB, workItemId: string, runId: string) {
  return db
    .select({ id: workEvent.id, name: sql<string>`${workEvent.value}->>'name'`, at: workEvent.at })
    .from(workEvent)
    .where(
      and(
        eq(workEvent.workItemId, workItemId),
        eq(workEvent.type, 'write.evidence'),
        sql`${workEvent.value}->>'runId' = ${runId}`,
        sql`${workEvent.value}->>'name' ~ ${EVIDENCE_NAME_PATTERN.source}`,
        sql`${workEvent.evidence}->>'key' is not null`,
        sql`${workEvent.evidence}->>'sha256' is not null`,
      ),
    )
    .orderBy(workEvent.at, workEvent.id);
}

/** The latest review decision for one run (by at, then id), or null while it is unreviewed. */
async function reviewForRun(db: DB, workItemId: string, runId: string) {
  const [row] = await db
    .select({ type: workEvent.type })
    .from(workEvent)
    .where(
      and(
        eq(workEvent.workItemId, workItemId),
        inArray(workEvent.type, ['review.ok', 'review.flag']),
        sql`${workEvent.value}->>'runId' = ${runId}`,
      ),
    )
    .orderBy(desc(workEvent.at), desc(workEvent.id))
    .limit(1);
  return row ? (row.type === 'review.ok' ? 'ok' : 'flag') : null;
}

export type HmsReviewResult = { runId: string; status: 'done' | 'needs_you' };

/**
 * Review of an executed write, as an event with actor = session user. Review needs an outcome: a run that succeeded, or
 * one that stopped after sealing evidence. Nothing is reviewed while a needs-check is open. Reviewing one write does not
 * finish the email: other requests or a reply may still be outstanding. Both decisions keep the item in needs_you and
 * drop the stored snapshot, which was read before the write changed HMS. An OK also reapplies the existing hotel-reply
 * rule after the transaction, in case the reply arrived while the write was awaiting review. The next approval waits
 * for a fresh read (prepareHmsWriteSnapshot, the hmsApproval.reread procedure), outside the work-item row lock.
 * Only one decision per run.
 */
export async function reviewHmsWrite(input: {
  db?: DB;
  transportId: string;
  actorUserId: string;
  workItemId: string;
  selectedInternetMessageId?: string;
  selectedSource?: HmsSelectedSource;
  cloudSelection?: HmsSelectedSource;
  /** The run the reviewer was shown. When given, the review is refused unless it is still the latest write. */
  runId?: string;
  decision: 'ok' | 'flag';
  note?: string;
  now?: Date;
}): Promise<HmsReviewResult> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const note = input.note?.trim() ?? '';
  if (input.decision === 'flag' && (note.length === 0 || note.length > RESOLVE_NOTE_MAX)) {
    throw new HmsApprovalError('note_required');
  }
  const reviewed = await db.transaction(async (tx) => {
    await lockHmsSelectedMailbox(tx as DB, input);
    if (input.cloudSelection) {
      const { lockSelectedBoundCloudAmend } = await import('./pane-cloud-amend.js');
      if (!await lockSelectedBoundCloudAmend(tx, { workItemId: input.workItemId, transportId: input.transportId,
        source: input.cloudSelection })) throw new HmsApprovalError('state_changed');
    }
    const [item] = await tx
      .select({ id: workItem.id, status: workItem.status, state: workItem.state, threadId: workItem.threadId,
        sourceMessageId: workItem.sourceMessageId })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) throw new HmsApprovalError('not_found');
    await assertHmsSelectedSource(tx as DB, input, item, true);
    if ((item.state.action === 'amend' && Object.hasOwn(item.state, 'cloudAmend')) !== Boolean(input.cloudSelection)) {
      throw new HmsApprovalError('state_changed');
    }
    if (item.status === 'done' || item.status === 'dismissed')
      throw new HmsApprovalError('not_open');
    await assertNoWriteInFlight(tx as DB, item.id);
    if (await unresolvedNeedsCheckRunId(tx as DB, item.id))
      throw new HmsApprovalError('needs_check_open');
    const run = await latestWriteRun(tx as DB, item.id);
    if (!run) throw new HmsApprovalError('no_executed_write');
    if (input.runId !== undefined && input.runId !== run.id) throw new HmsApprovalError('run_changed');
    const target = paneStayHmsTargetForTransport(input.transportId);
    const cloudFiling = run.promptVersion === HMS_LABTEST_ATTACH_PROMPT_VERSION ||
      (target.ok && target.target.propertyCode === 'HRCEN' && item.state.action === 'attach_document');
    if (cloudFiling) {
      if (!target.ok || target.target.propertyCode !== 'HRCEN' || item.state.action !== 'attach_document' ||
          run.promptVersion !== HMS_LABTEST_ATTACH_PROMPT_VERSION) {
        throw new HmsApprovalError('no_executed_write');
      }
      if (!boundFilingSelectionMatches(item.state, input.selectedSource)) {
        throw new HmsApprovalError('source_mail_changed');
      }
    }
    const cloudAmend = run.promptVersion === HMS_LABTEST_AMEND_PROMPT_VERSION ||
      (item.state.action === 'amend' && Object.hasOwn(item.state, 'cloudAmend'));
    if (cloudAmend && (!input.cloudSelection || item.state.action !== 'amend' ||
        !Object.hasOwn(item.state, 'cloudAmend') || run.promptVersion !== HMS_LABTEST_AMEND_PROMPT_VERSION)) {
      throw new HmsApprovalError('no_executed_write');
    }
    const cloudCancel = run.promptVersion === HMS_CLOUD_CANCEL_PROMPT_VERSION ||
      (target.ok && target.target.propertyCode === 'HRCEN' && item.state.action === 'cancel' &&
        Object.hasOwn(item.state, 'cloudCancel'));
    if (cloudCancel) {
      const { cloudCancelDispatchSchema } = await import('./pane-cloud-cancel.js');
      const bound = cloudCancelDispatchSchema.safeParse(item.state.cloudCancel);
      const selectedTarget = target.ok ? target.target : null;
      const targetKeys = ['propertyCode', 'secretId', 'browserSlot', 'origin', 'installationEnvName'] as const;
      if (!selectedTarget || targetKeys.some((key) => selectedTarget[key] !== CENTURION_HMS_READ_TARGET[key]) ||
          item.state.action !== 'cancel' ||
          run.promptVersion !== HMS_CLOUD_CANCEL_PROMPT_VERSION || !bound.success || !input.selectedSource ||
          canonicalJson(bound.data.source) !== canonicalJson(input.selectedSource) ||
          item.state.confirmation !== bound.data.preimage.confirmation ||
          item.state.arrival !== bound.data.preimage.arrival) {
        throw new HmsApprovalError('no_executed_write');
      }
    }
    const evidence = await evidenceForRun(tx as DB, item.id, run.id);
    if (run.state !== 'succeeded' && evidence.length === 0)
      throw new HmsApprovalError('no_executed_write');
    if (await reviewForRun(tx as DB, item.id, run.id))
      throw new HmsApprovalError('already_reviewed');
    // The review applies only to the form this write was approved for. A later edit was never written.
    if (input.decision === 'ok' || cloudFiling || cloudCancel || cloudAmend) {
      const grantId = grantIdForRun(run);
      if (!grantId) throw new HmsApprovalError('no_grant');
      const { grant } = await loadGrant(tx as DB, item.id, grantId);
      if ((cloudFiling || cloudCancel || cloudAmend) && (grant.grantId !== grantId || grant.workItemId !== item.id ||
          grant.transportId !== input.transportId)) throw new HmsApprovalError('no_grant');
      if (formDigest(item.state) !== grant.formDigest) throw new HmsApprovalError('state_changed');
    }

    const status = 'needs_you' as const;
    const state: Record<string, unknown> = { ...item.state };
    delete state[HMS_SNAPSHOT_KEY];
    await tx.insert(workEvent).values({
      workItemId: item.id,
      at: now,
      actorKind: 'user',
      actorUserId: input.actorUserId,
      type: input.decision === 'ok' ? 'review.ok' : 'review.flag',
      value: input.decision === 'ok' ? { runId: run.id } : { runId: run.id, note },
    });
    await tx.insert(workEvent).values({
      workItemId: item.id,
      at: now,
      actorKind: 'user',
      actorUserId: input.actorUserId,
      type: 'status.changed',
      value: { from: item.status, to: status, reviewedRunId: run.id },
    });
    await tx
      .update(workItem)
      .set({ status, state, updatedAt: now })
      .where(eq(workItem.id, item.id));
    return { runId: run.id, status, threadId: item.threadId };
  });
  let status: HmsReviewResult['status'] = reviewed.status;
  if (input.decision === 'ok' && reviewed.threadId) {
    try {
      const { refreshThreadWork } = await import('./work-items.js');
      const changes = await refreshThreadWork(db, { transportId: input.transportId, threadId: reviewed.threadId });
      if (changes.some((change) => change.workItemId === input.workItemId && 'to' in change && change.to === 'done')) status = 'done';
    } catch {
      // The review is already recorded. Keep the item open for a later thread refresh rather than report a failed review.
      console.error('hms_review_reply_refresh_failed');
    }
  }
  return { runId: reviewed.runId, status };
}

export type HmsWriteStateView = {
  /** The work item's stored status. */
  status: string;
  /** The values she is approving: the stored state without the snapshot. */
  form: Record<string, unknown>;
  /** Digest of the stored form. The card sends it back on approve, so an edit it has not shown refuses the approval. */
  formDigest: string;
  /** Display values of the stored HMS snapshot (hmsSnapshot.values), keyed like the form. Null when none were stored. */
  before: Record<string, unknown> | null;
  snapshot: { readAt: string; stale: boolean } | null;
  /** The latest approval. fingerprintMatches is false once the form changed after it was made. */
  grant: { grantId: string; consumed: boolean; fingerprintMatches: boolean } | null;
  /** The latest hms_write run and what it sealed. expired is set once the evidence is past the retention window. */
  run: {
    runId: string;
    state: string;
    failureClass: string | null;
    lastError: string | null;
    cancelNotice?: string;
    evidence: Array<{ eventId: string; name: string; expired: boolean }>;
    reviewed: 'ok' | 'flag' | null;
  } | null;
  /** True while a needs-check blocks approval and review: the outcome is unknown until someone reads HMS back. */
  needsCheck: boolean;
  /** False when the Labtest filing worker or bound form is unavailable. */
  filingAvailable?: boolean;
  /** Whether a Labtest filing form may be prepared for this mailbox. */
  filingConfigured?: boolean;
  /** Whether this mailbox can start a source-bound cancellation. */
  cancelAvailable?: boolean;
  /** False when a staff note cannot reconcile a possibly dispatched Cloud write. */
  manualResolve?: boolean;
};

const HEX_SHA256 = /^[a-f0-9]{64}$/;

/** KTD13: every string the cards show passes the card mask, whoever wrote the value. */
function maskedStrings<T>(value: T, key?: string): T {
  if (typeof value === 'string') {
    if (key === 'pdfSha256' || HEX_SHA256.test(value)) return value;
    return maskCardNumbers(value) as T;
  }
  if (Array.isArray(value)) return value.map((child) => maskedStrings(child, key)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, maskedStrings(child, childKey)]),
    ) as T;
  }
  return value;
}

/** Keep the native cancellation preimage private while its digest remains bound to Go. */
export function publicHmsWriteForm(state: Record<string, unknown>): Record<string, unknown> {
  const form = formOf(state);
  delete form.cloudCancelPreview;
  if (form.action === 'cancel' && Object.hasOwn(form, 'cloudCancel')) form.cloudCancel = {};
  else delete form.cloudCancel;
  if (Object.hasOwn(form, 'cloudAmend')) form.cloudAmend = publicCloudAmendFields(form.cloudAmend);
  return maskedStrings(form);
}

/** Public preparation uses the same private-field and card masking as the pane's write state. */
export function publicHmsPreparedSummary(prepared: HmsPreparation): PreparedSummary {
  return { ...preparedSummarySchema.parse(prepared), stagedFields: publicHmsWriteForm(prepared.businessFields),
    price: retainedPricesForApproval(prepared.nativeObservation.price) ?? null };
}

function completedOtherHmsWrite(run: Awaited<ReturnType<typeof latestWriteRun>>, needsCheck: boolean): boolean {
  return run !== null && run.promptVersion !== HMS_CLOUD_CANCEL_PROMPT_VERSION && run.state === 'succeeded' &&
    run.failureClass === null && run.lastError === null && !needsCheck;
}

/** A restored cancel status must still name the same current email, target, form and run. */
async function assertCancelStateSource(input: {
  db: DB; transportId: string; workItemId: string; selectedInternetMessageId?: string;
  cancelSource: { threadId: string; messageId: string; sourceHash: string };
  initialFormDigest: string; initialPreview: string; run: Awaited<ReturnType<typeof latestWriteRun>>;
  grantBound: boolean; needsCheck: boolean;
}): Promise<void> {
  const { cancelSelectionSchema, cloudCancelDispatchSchema } = await import('./pane-cloud-cancel.js');
  const source = cancelSelectionSchema.safeParse(input.cancelSource);
  const target = paneStayHmsTargetForTransport(input.transportId);
  const targetKeys = ['propertyCode', 'secretId', 'browserSlot', 'origin', 'installationEnvName'] as const;
  const selectedTarget = target.ok ? target.target : null;
  if (!input.selectedInternetMessageId || !source.success || !selectedTarget ||
      targetKeys.some((key) => selectedTarget[key] !== CENTURION_HMS_READ_TARGET[key])) {
    throw new HmsApprovalError('source_mail_changed');
  }
  const [item] = await input.db.select({ state: workItem.state, sourceMessageId: workItem.sourceMessageId,
    threadId: workItem.threadId }).from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1);
  if (!item || item.threadId !== source.data.threadId || item.sourceMessageId !== source.data.messageId ||
      formDigest(item.state) !== input.initialFormDigest ||
      canonicalJson(item.state.cloudCancelPreview ?? null) !== input.initialPreview) {
    throw new HmsApprovalError('source_mail_changed');
  }
  const [thread] = await input.db.select({ id: mailThread.id, historyOnly: mailThread.historyOnly, trashedAt: mailThread.trashedAt })
    .from(mailThread).where(and(eq(mailThread.id, source.data.threadId), eq(mailThread.transportId, input.transportId))).limit(1);
  const [mail] = await input.db.select({ id: message.id, threadId: message.threadId, direction: message.direction,
    historyOnly: message.historyOnly, sourceProvenance: message.sourceProvenance, subject: message.subject,
    textBody: message.textBody, htmlBody: message.htmlBody }).from(message)
    .where(and(eq(message.id, source.data.messageId), eq(message.transportId, input.transportId),
      eq(message.threadId, source.data.threadId))).limit(1);
  if (!thread || thread.id !== source.data.threadId || thread.historyOnly || thread.trashedAt !== null ||
      !mail || mail.id !== source.data.messageId || mail.threadId !== source.data.threadId ||
      mail.direction !== 'inbound' || mail.historyOnly || mail.sourceProvenance?.attention != null ||
      staffQuoteSourceHash(mail) !== source.data.sourceHash) throw new HmsApprovalError('source_mail_changed');
  const hasCancel = Object.hasOwn(item.state, 'cloudCancel');
  const bound = cloudCancelDispatchSchema.safeParse(item.state.cloudCancel);
  // A completed filing or other write is history, not authority for this cancellation.
  const completedOtherWrite = completedOtherHmsWrite(input.run, input.needsCheck);
  if ((hasCancel && (!bound.success || item.state.action !== 'cancel' ||
      canonicalJson(bound.data.source) !== canonicalJson(source.data) ||
      item.state.confirmation !== bound.data.preimage.confirmation || item.state.arrival !== bound.data.preimage.arrival)) ||
      (input.run && !completedOtherWrite &&
        (input.run.promptVersion !== HMS_CLOUD_CANCEL_PROMPT_VERSION || !bound.success || !input.grantBound))) {
    throw new HmsApprovalError('source_mail_changed');
  }
  if (item.state.cloudCancelPreview != null) {
    const pending = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), source: cancelSelectionSchema,
      stateDigest: z.string().regex(/^[a-f0-9]{64}$/), preimage: z.object({
        confirmation: z.string().regex(/^\d+-\d+$/), nativeStayId: z.string().regex(/^\d{1,100}$/),
      }).passthrough() }).passthrough().safeParse(item.state.cloudCancelPreview);
    if (!pending.success) throw new HmsApprovalError('source_mail_changed');
    const { digest, ...preview } = pending.data;
    if (createHash('sha256').update(canonicalJson(preview)).digest('hex') !== digest ||
        canonicalJson(preview.source) !== canonicalJson(source.data) || preview.stateDigest !== input.initialFormDigest ||
        (input.run && !completedOtherWrite && (input.run.state !== 'succeeded' || input.run.failureClass !== null || input.run.lastError !== null ||
          input.needsCheck || !bound.success || preview.preimage.confirmation === bound.data.preimage.confirmation ||
          preview.preimage.nativeStayId === bound.data.preimage.nativeStayId))) {
      throw new HmsApprovalError('source_mail_changed');
    }
  }
  const latest = await latestWriteRun(input.db, input.workItemId);
  if (latest?.id !== input.run?.id || latest?.state !== input.run?.state ||
      latest?.failureClass !== input.run?.failureClass || latest?.lastError !== input.run?.lastError ||
      latest?.idempotencyKey !== input.run?.idempotencyKey || latest?.promptVersion !== input.run?.promptVersion) {
    throw new HmsApprovalError('source_mail_changed');
  }
}

/**
 * What the approve and review cards show for one work item: the form, the snapshot's age and display values, the latest
 * approval and whether it still matches the form, the latest write run with its evidence, and any open needs-check.
 * Read-only. Null when the work item is not in this transport.
 */
export async function hmsWriteStateOf(input: {
  db?: DB;
  transportId: string;
  propertySwitch?: PropertySwitch;
  workItemId: string;
  selectedInternetMessageId?: string;
  selectedSource?: HmsSelectedSource;
  cancelSource?: HmsSelectedSource;
  /** Internal Cloud Amend card: show only a run for its current bound form. */
  cloudAmendOnly?: boolean;
  now?: Date;
}): Promise<HmsWriteStateView | null> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const [item] = await db
    .select({ id: workItem.id, status: workItem.status, state: workItem.state,
      sourceMessageId: workItem.sourceMessageId, threadId: workItem.threadId })
    .from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
    .limit(1);
  if (!item) return null;
  await assertHmsSelectedSource(db, input, item);
  const currentFormDigest = formDigest(item.state);
  const currentCancelPreview = canonicalJson(item.state.cloudCancelPreview ?? null);
  const snapshot = readSnapshot(item.state);
  const storedValues = z
    .record(z.unknown())
    .safeParse((item.state[HMS_SNAPSHOT_KEY] as { values?: unknown } | undefined)?.values);
  const target = paneStayHmsTargetForTransport(input.transportId, input.propertySwitch);
  const cloudFiling = item.state.action === 'attach_document' && target.ok;
  const run = await latestWriteRun(db, item.id);
  const grantFormDigest = currentFormDigest;
  const grantId = run ? grantIdForRun(run) : null;
  let grant: HmsWriteStateView['grant'] = null;
  let grantBound = false;
  if (grantId) {
    const [row] = await db
      .select({ value: workEvent.value, payloadHash: workEvent.payloadHash })
      .from(workEvent)
      .where(
        and(
          eq(workEvent.id, grantId),
          eq(workEvent.workItemId, item.id),
          eq(workEvent.type, 'approval.granted'),
        ),
      )
      .limit(1);
    const parsed = hmsWriteGrantSchema.safeParse(row?.value);
    if (parsed.success && (!(cloudFiling || input.cloudAmendOnly) ||
        (row?.payloadHash === grantHash(parsed.data) && (!input.cloudAmendOnly ||
          (parsed.data.grantId === grantId && parsed.data.workItemId === item.id && parsed.data.transportId === input.transportId))))) {
      grantBound = row?.payloadHash === grantHash(parsed.data) && parsed.data.grantId === grantId && parsed.data.workItemId === item.id &&
        parsed.data.transportId === input.transportId && parsed.data.formDigest === grantFormDigest;
      const [consumed] = await db
        .select({ id: workEvent.id })
        .from(workEvent)
        .where(
          and(
            eq(workEvent.workItemId, item.id),
            eq(workEvent.type, 'approval.consumed'),
            sql`${workEvent.value}->>'grantId' = ${grantId}`,
          ),
        )
        .limit(1);
      grant = {
        grantId,
        consumed: Boolean(consumed),
        fingerprintMatches: grantFormDigest === parsed.data.formDigest,
      };
    }
  }
  let runView: HmsWriteStateView['run'] = null;
  if (run) {
    const evidence = await evidenceForRun(db, item.id, run.id);
    const reviewed = await reviewForRun(db, item.id, run.id);
    runView = {
      runId: run.id,
      state: run.state,
      failureClass: run.failureClass,
      lastError: run.lastError,
      ...(run.state === 'succeeded' && run.metrics?.action === 'cancel' &&
          run.metrics?.cancelNotice === 'Cancellation Penalty of 0.00 may be added to account.'
        ? { cancelNotice: run.metrics.cancelNotice } : {}),
      evidence: evidence.map((row) => ({
        eventId: row.id,
        name: row.name,
        expired: now.getTime() - row.at.getTime() >= HMS_WRITE_EVIDENCE_RETENTION_MS,
      })),
      reviewed,
    };
  }
  let needsCheck = run !== null && !(NONTERMINAL_AI_RUN_STATES as readonly string[]).includes(run.state) &&
    Boolean(await unresolvedNeedsCheckRunId(db, item.id));
  if (input.cloudAmendOnly && run &&
      (run.promptVersion !== HMS_LABTEST_AMEND_PROMPT_VERSION || !grant?.fingerprintMatches)) {
    // Other workflows and earlier forms may still hold the item. Show the hold,
    // but never present their evidence or review as this amendment's outcome.
    const missingAmendGrant = run.promptVersion === HMS_LABTEST_AMEND_PROMPT_VERSION &&
      run.state === 'succeeded' && !grant;
    needsCheck ||= missingAmendGrant;
    grant = null;
    runView = (NONTERMINAL_AI_RUN_STATES as readonly string[]).includes(run.state) || needsCheck
      ? { runId: run.id, state: run.state, failureClass: run.failureClass,
          lastError: missingAmendGrant ? 'amend_approval_unverified' : run.lastError,
          evidence: [], reviewed: null }
      : null;
  }
  const filingRun = run && [HMS_LABTEST_ATTACH_PROMPT_VERSION, HMS_V2_WRITE_PROMPT_VERSION].includes(run.promptVersion);
  if (cloudFiling && run && (!filingRun || !grant?.fingerprintMatches)) {
    // A completed write for another workflow or form is history, not this upload.
    // If a Filing success lacks its grant, its relationship to this form is unknown.
    const missingFilingGrant = filingRun && run.state === 'succeeded' && !grant;
    needsCheck ||= missingFilingGrant;
    grant = null;
    runView = (NONTERMINAL_AI_RUN_STATES as readonly string[]).includes(run.state) || needsCheck
      ? { runId: run.id, state: run.state, failureClass: run.failureClass,
          lastError: missingFilingGrant ? 'filing_approval_unverified' : run.lastError, evidence: [], reviewed: null }
      : null;
  }
  await assertCurrentHmsSelection(db, input);
  if (input.cancelSource) await assertCancelStateSource({ db, transportId: input.transportId, workItemId: item.id,
    selectedInternetMessageId: input.selectedInternetMessageId, cancelSource: input.cancelSource,
    initialFormDigest: currentFormDigest, initialPreview: currentCancelPreview, run, grantBound, needsCheck });
  const priorWriteIsHistory = Boolean(input.cancelSource && completedOtherHmsWrite(run, needsCheck));
  const attachMode = target.ok
    ? effectiveWorkflowPolicy(process.env, propertyCodeSchema.parse(target.target.propertyCode), 'attach').admittedMode : 'off';
  return {
    status: item.status,
    ...(target.ok ? { filingConfigured: attachMode !== 'off' } : {}),
    ...(item.state.action === 'attach_document'
      ? { filingAvailable: target.ok && attachMode !== 'off' &&
          isBoundLabtestAttachment(item.state, item.sourceMessageId, attachMode) &&
          (!input.selectedSource || boundFilingSelectionMatches(item.state, input.selectedSource)),
        manualResolve: false } : {}),
    ...(item.state.action === 'cancel' && Object.hasOwn(item.state, 'cloudCancel') ? { manualResolve: false } : {}),
    ...(item.state.action === 'cancel' && target.ok && target.target.propertyCode === 'HRCEN'
      ? { cancelAvailable: paneWriteMode('cancel', 'unpaid') !== 'off', manualResolve: false } : {}),
    ...(item.state.action === 'amend' && Object.hasOwn(item.state, 'cloudAmend') ? { manualResolve: false } : {}),
    form: publicHmsWriteForm(item.state),
    formDigest: currentFormDigest,
    before: storedValues.success ? maskedStrings(storedValues.data) : null,
    snapshot: snapshot
      ? { readAt: snapshot.readAt, stale: snapshotStale(snapshot.readAt, now) }
      : null,
    grant: priorWriteIsHistory ? null : grant,
    run: priorWriteIsHistory ? null : runView,
    // A run still in flight has no outcome yet, so it is not a needs-check until it ends.
    needsCheck,
  };
}
