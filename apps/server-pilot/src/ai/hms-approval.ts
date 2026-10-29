import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import { workEvent, workItem } from '../db/schema/work.js';
import { parseEnv } from '../env.js';
import { S3KeyExistsError, getS3Storage, type S3Storage } from '../storage/s3.js';
import { maskCardNumbers } from './card-mask.js';
import { canonicalJson } from './draft-approval.js';
import {
  HMS_WRITE_RUN_KIND,
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
 * - approveHmsWrite recomputes the form digest from stored work-item state and takes the HMS before-state digest
 *   from the snapshot, then enqueues one hms_write run in the same transaction. Create plans use the same
 *   append-only grant/consumption events, with their own property-wide create claim.
 * - consumeHmsWriteApproval consumes these before-state grants. The run's lease must still be held, and the grant must
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
  | 'run_changed';

export class HmsApprovalError extends Error {
  readonly refusal: HmsApprovalRefusal;

  constructor(refusal: HmsApprovalRefusal) {
    super(`hms write refused: ${refusal}`);
    this.name = 'HmsApprovalError';
    this.refusal = refusal;
  }
}

/** The approval payload. Stored as the approval.granted value, and its hash is the event's payload_hash. */
const hmsWriteGrantSchema = z
  .object({
    grantId: z.string().regex(UUID_PATTERN),
    workItemId: z.string(),
    transportId: z.string(),
    actorUserId: z.string(),
    formDigest: z.string(),
    hmsBeforeDigest: z.string(),
    hmsReadAt: z.string(),
  })
  .strict();
type HmsWriteGrant = z.infer<typeof hmsWriteGrantSchema>;

const snapshotSchema = z.object({ digest: z.string(), readAt: z.string() });

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Digest of an HMS before-state read. Prepare stores it as work_item.state.hmsSnapshot, and the pre-Save hook compares it. */
export function hmsStateDigest(hmsState: unknown): string {
  // JSON first: a Date or other non-JSON value must hash as the text a reader stores, not as an empty object.
  return sha256Hex(canonicalJson(JSON.parse(JSON.stringify(hmsState ?? null))));
}

/** The form the person saw: stored state without the snapshot key the reader writes. */
function formOf(state: Record<string, unknown>): Record<string, unknown> {
  const form: Record<string, unknown> = { ...state };
  delete form[HMS_SNAPSHOT_KEY];
  return form;
}

export function formDigest(state: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(formOf(state)));
}

function grantHash(grant: HmsWriteGrant): string {
  return sha256Hex(canonicalJson(grant));
}

function readSnapshot(state: Record<string, unknown>): { digest: string; readAt: string } | null {
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
): Promise<{ grant: HmsWriteGrant; payloadHash: string }> {
  const [row] = await db
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
  if (!row?.payloadHash) throw new HmsApprovalError('no_grant');
  const parsed = hmsWriteGrantSchema.safeParse(row.value);
  if (!parsed.success || grantHash(parsed.data) !== row.payloadHash) {
    throw new HmsApprovalError('no_grant');
  }
  return { grant: parsed.data, payloadHash: row.payloadHash };
}

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

/** A create claim or uncertain receipt also blocks a different write on the same case. */
function paneCreateNeedsCheck(state: Record<string, unknown>): boolean {
  const claims = state.paneStaySaveClaims;
  if (claims !== undefined && (!claims || typeof claims !== 'object' || Array.isArray(claims) || Object.keys(claims).length)) return true;
  const stays = state.stays;
  if (stays === undefined) return false;
  if (!stays || typeof stays !== 'object' || Array.isArray(stays)) return true;
  return Object.values(stays).some((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const stay = raw as Record<string, unknown>;
    if (stay.status === 'unknown') return true;
    return stay.status === 'booked' && (typeof stay.confirmationNumber !== 'string' ||
      !/^\d{6,10}-\d{1,2}$/.test(stay.confirmationNumber));
  });
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
  readHmsState: () => Promise<unknown>;
  now?: Date;
}): Promise<{ digest: string; readAt: string }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const snapshot = { digest: hmsStateDigest(await input.readHmsState()), readAt: now.toISOString() };
  await db.transaction(async (tx) => {
    const [item] = await tx
      .select({ id: workItem.id, state: workItem.state, status: workItem.status })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) throw new HmsApprovalError('not_found');
    if (item.status === 'done' || item.status === 'dismissed') throw new HmsApprovalError('not_open');
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
      await recordNeedsCheck(tx as DB, {
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

/**
 * Server-side approval of one HMS write. The client sends only the work item id. The server recomputes the form
 * digest from stored state. A stale or missing snapshot is re-read first (KTD11) when a reader is supplied.
 */
export async function approveHmsWrite(input: {
  db?: DB;
  transportId: string;
  actorUserId: string;
  workItemId: string;
  /**
   * The form digest of the values the card showed (hmsWriteStateOf.formDigest). When given, approval is refused unless
   * the stored form still has it, so staff never approve values they were not shown.
   */
  formDigest?: string;
  /** Re-reads HMS when the snapshot is stale. Without it, a stale snapshot is refused. */
  rereadHmsState?: () => Promise<unknown>;
  now?: Date;
}): Promise<{ grantId: string; runId: string; hmsReadAt: string; expiresAt: string }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) throw new HmsApprovalError('not_found');
    if (item.status === 'done' || item.status === 'dismissed') throw new HmsApprovalError('not_open');
    if (!item.threadId || !item.sourceMessageId) throw new HmsApprovalError('source_mail_missing');
    if (paneCreateNeedsCheck(item.state)) throw new HmsApprovalError('needs_check_open');
    if (input.formDigest !== undefined && input.formDigest !== formDigest(item.state)) {
      throw new HmsApprovalError('form_outdated');
    }
    await supersedeChangedQueuedWrite(tx as DB, item.id, formDigest(item.state), now);
    await assertNoOpenWrite(tx as DB, item.id);

    let state = item.state;
    let snapshot = readSnapshot(state);
    if (!snapshot || snapshotStale(snapshot.readAt, now)) {
      if (!input.rereadHmsState) {
        throw new HmsApprovalError(snapshot ? 'snapshot_stale' : 'snapshot_missing');
      }
      snapshot = { digest: hmsStateDigest(await input.rereadHmsState()), readAt: now.toISOString() };
      state = { ...state, [HMS_SNAPSHOT_KEY]: snapshot };
      await tx.update(workItem).set({ state, updatedAt: now }).where(eq(workItem.id, item.id));
    }

    // Random grantId: approving unchanged state again yields a new event id, so a new hash and a new run.
    const grant: HmsWriteGrant = {
      grantId: randomUUID(),
      workItemId: item.id,
      transportId: input.transportId,
      actorUserId: input.actorUserId,
      formDigest: formDigest(state),
      hmsBeforeDigest: snapshot.digest,
      hmsReadAt: snapshot.readAt,
    };
    const expiresAt = new Date(Date.parse(snapshot.readAt) + HMS_SNAPSHOT_MAX_AGE_MS);
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
        promptVersion: HMS_WRITE_PROMPT_VERSION,
        executorLane: 'hms',
        workItemId: item.id,
        priority: HMS_WRITE_PRIORITY,
      },
      tx as DB,
    );
    return {
      grantId: grant.grantId,
      runId: run.id,
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
    const [item] = await tx
      .select({ id: workItem.id, state: workItem.state })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) throw new HmsApprovalError('not_found');
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
    await tx.insert(workEvent).values({
      workItemId: item.id,
      at: now,
      actorKind: 'system',
      type: 'approval.consumed',
      payloadHash,
      value: { grantId, runId: run.id },
    });
    await tx
      .update(aiWorkflowRun)
      .set({ heartbeatAt: now, updatedAt: now })
      .where(eq(aiWorkflowRun.id, run.id));
    return { grantId, payloadHash, hmsBeforeDigest: grant.hmsBeforeDigest, form: formOf(item.state) };
  });
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
  if (!consumed) throw new HmsApprovalError('not_consumed');
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
}): Promise<{ status: 'ok'; dataUrl: string } | { status: 'unavailable'; reason: string }> {
  const db = input.db ?? getDb();
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
      idempotencyKey: aiWorkflowRun.idempotencyKey,
    })
    .from(aiWorkflowRun)
    .where(
      and(eq(aiWorkflowRun.workItemId, workItemId), eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND)),
    )
    .orderBy(desc(aiWorkflowRun.createdAt), desc(aiWorkflowRun.id))
    .limit(1);
  return run ?? null;
}

/** The write.evidence events one run sealed, oldest first. */
async function evidenceForRun(db: DB, workItemId: string, runId: string) {
  return db
    .select({ id: workEvent.id, name: sql<string>`${workEvent.value}->>'name'`, at: workEvent.at })
    .from(workEvent)
    .where(
      and(
        eq(workEvent.workItemId, workItemId),
        eq(workEvent.type, 'write.evidence'),
        sql`${workEvent.value}->>'runId' = ${runId}`,
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
 * one that stopped after sealing evidence. Nothing is reviewed while a needs-check is open. OK closes the item (done).
 * Flag needs a note and returns the item to needs_you. It also drops the stored snapshot: it was read before the write
 * changed HMS, so it must not back the next approval. That approval waits for a fresh read (prepareHmsWriteSnapshot,
 * the hmsApproval.reread procedure), which is not run here so HMS is never read under the work-item row lock.
 * Only one decision per run.
 */
export async function reviewHmsWrite(input: {
  db?: DB;
  transportId: string;
  actorUserId: string;
  workItemId: string;
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
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ id: workItem.id, status: workItem.status, state: workItem.state })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) throw new HmsApprovalError('not_found');
    if (item.status === 'done' || item.status === 'dismissed')
      throw new HmsApprovalError('not_open');
    await assertNoWriteInFlight(tx as DB, item.id);
    if (await unresolvedNeedsCheckRunId(tx as DB, item.id))
      throw new HmsApprovalError('needs_check_open');
    const run = await latestWriteRun(tx as DB, item.id);
    if (!run) throw new HmsApprovalError('no_executed_write');
    if (input.runId !== undefined && input.runId !== run.id) throw new HmsApprovalError('run_changed');
    const evidence = await evidenceForRun(tx as DB, item.id, run.id);
    if (run.state !== 'succeeded' && evidence.length === 0)
      throw new HmsApprovalError('no_executed_write');
    if (await reviewForRun(tx as DB, item.id, run.id))
      throw new HmsApprovalError('already_reviewed');
    // OK closes the item, so the stored form must be the one this write was approved for. A later edit was never written.
    if (input.decision === 'ok') {
      const grantId = grantIdForRun(run);
      if (!grantId) throw new HmsApprovalError('no_grant');
      const { grant } = await loadGrant(tx as DB, item.id, grantId);
      if (formDigest(item.state) !== grant.formDigest) throw new HmsApprovalError('state_changed');
    }

    const status = input.decision === 'ok' ? 'done' : 'needs_you';
    const state: Record<string, unknown> = { ...item.state };
    if (input.decision === 'flag') delete state[HMS_SNAPSHOT_KEY];
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
    return { runId: run.id, status };
  });
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
    evidence: Array<{ eventId: string; name: string; expired: boolean }>;
    reviewed: 'ok' | 'flag' | null;
  } | null;
  /** True while a needs-check blocks approval and review: the outcome is unknown until someone reads HMS back. */
  needsCheck: boolean;
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

/**
 * What the approve and review cards show for one work item: the form, the snapshot's age and display values, the latest
 * approval and whether it still matches the form, the latest write run with its evidence, and any open needs-check.
 * Read-only. Null when the work item is not in this transport.
 */
export async function hmsWriteStateOf(input: {
  db?: DB;
  transportId: string;
  workItemId: string;
  now?: Date;
}): Promise<HmsWriteStateView | null> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const [item] = await db
    .select({ id: workItem.id, status: workItem.status, state: workItem.state })
    .from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
    .limit(1);
  if (!item) return null;
  const snapshot = readSnapshot(item.state);
  const storedValues = z
    .record(z.unknown())
    .safeParse((item.state[HMS_SNAPSHOT_KEY] as { values?: unknown } | undefined)?.values);
  const run = await latestWriteRun(db, item.id);
  const grantId = run ? grantIdForRun(run) : null;
  let grant: HmsWriteStateView['grant'] = null;
  if (grantId) {
    const [row] = await db
      .select({ value: workEvent.value })
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
    if (parsed.success) {
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
        fingerprintMatches: formDigest(item.state) === parsed.data.formDigest,
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
      evidence: evidence.map((row) => ({
        eventId: row.id,
        name: row.name,
        expired: now.getTime() - row.at.getTime() >= HMS_WRITE_EVIDENCE_RETENTION_MS,
      })),
      reviewed,
    };
  }
  return {
    status: item.status,
    form: maskedStrings(formOf(item.state)),
    formDigest: formDigest(item.state),
    before: storedValues.success ? maskedStrings(storedValues.data) : null,
    snapshot: snapshot
      ? { readAt: snapshot.readAt, stale: snapshotStale(snapshot.readAt, now) }
      : null,
    grant,
    run: runView,
    // A run still in flight has no outcome yet, so it is not a needs-check until it ends.
    needsCheck:
      run !== null &&
      !(NONTERMINAL_AI_RUN_STATES as readonly string[]).includes(run.state) &&
      Boolean(await unresolvedNeedsCheckRunId(db, item.id)),
  };
}
