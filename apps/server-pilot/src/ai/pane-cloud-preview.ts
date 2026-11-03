import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { message } from '../db/schema/mail.js';
import { workItem } from '../db/schema/work.js';
import { CREATE_GUARANTEES, createGuaranteeCode, isLabtestGuest, sameCreateGuest, validCreateDates } from '../../tooling/hms-cloud/cloud-create-policy.mjs';
import { isDaVinciMailboxOrigin } from '../hms/mailbox-hms-origin-bind.js';
import { acquisitionWithin, isPropertyReadLockDeadline, PANE_PROPERTY_LOCK_WAIT_MS } from '../hms/property-read-lock.js';
import { canonicalJson } from './draft-approval.js';
import { isSelfSentPreStayInformationMail } from './existing-stay-information.js';
import { persistHmsShots, verifyStoredHmsShot, type HmsShotMeta } from './hms-shots-store.js';
import { captureHmsLabtestDispatchEpoch, claimHmsLabtestDispatch, HmsLabtestDispatchError, hmsLabtestIntentTarget, nativeCreateSaveDigest,
  readResolvedHmsLabtestCreates, resolveHmsLabtestDispatch, resolveNeverDispatchedCreate,
  type HmsLabtestIntent, type HmsLabtestWriteHandle } from './hms-labtest-dispatch.js';
import { lockCreateActorAccess, lockCreateActorSession } from './pane-create-actor-lock.js';
import { digestPaneCloudCreateProof, mapPaneStayToCloudCreateInput } from './pane-create-cloud-input.js';
import { assertNoCreateDispatchFence, type CreateFenceTransaction } from './pane-create-dispatch-fence.js';
import { activePaneCreateIdentity, paneCreateIdentitySchema } from './pane-create-scope.js';
import { lockCreateSource, withLockedCreateSource, type LockedCreateSource } from './pane-create-source-loader.js';
import { hmsDispatchTargetKey, hmsDispatchTargetSchema, type HmsDispatchTarget } from './hms-dispatch-target.js';
import { PANE_PREVIEW_TTL_MS, PANE_SAVE_UNCONFIRMED, paneStayCreateTarget, paneStayDigest, paneStayModeRefusal,
  paneStayCloudTargetLock, paneStaySaveLoaders, paneStaySaveMode, registerPaneRun, type PaneStay, type PaneStayResult } from './pane-stay-save.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';

export const cloudPreviewSelection = z.object({
  source: z.object({ messageId: z.string().trim().min(1).max(200), threadId: z.string().trim().min(1).max(200),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  identity: paneCreateIdentitySchema, nativeGuestId: z.string().regex(/^\d+$/).optional(),
}).strict();
type Input = { transportId: string; mailboxAddress: string; actorUserId: string; workItemId: string; stayId: string;
  sessionId?: string; sessionProfile?: 'legacy' | 'remote';
  selection: z.infer<typeof cloudPreviewSelection>; stay: PaneStay; batch?: PaneCloudBatch };
export type PaneCloudBatch =
  | { kind: 'start'; id: string; rooms: Array<{ stayId: string; selection: z.infer<typeof cloudPreviewSelection>;
      stay: PaneStay; previewDigest: string }> }
  | { kind: 'continue'; id: string; index: number };
type Native = { outcome?: unknown; issue?: unknown; guestCandidates?: unknown; applied?: { guaranteeType?: unknown };
  requestBinding?: { request?: unknown; digest?: unknown }; screenshots?: Record<string, unknown>;
  writerSessionClosed?: unknown; save?: { dispatchCallbacksDrained?: unknown };
  confirmation?: unknown; readback?: { fields?: unknown; mismatches?: unknown } };
type NativeContinuation = (() => Promise<unknown>) & { proveNeverDispatched?: () => unknown };
type NativeOptions = { capturePrepareScreenshot?: boolean; requireExplicitGuestSelection?: boolean; expectedRequestDigest?: string;
  allowRealGuest?: boolean; expectedGuest?: { firstName: string; lastName: string }; cloudTargetKey?: string;
  authorizeCandidate?: (request: unknown) => Promise<boolean>;
  dispatchCandidate?: (request: unknown, next: NativeContinuation, evidence: unknown) => Promise<unknown>;
  verifyLabtestMatches?: (census: unknown) => Promise<boolean> };
export const paneCloudPreviewLoaders: {
  runtimeReady: () => boolean;
  authorityReady: () => boolean;
  run: (input: Record<string, unknown>, options: NativeOptions) => Promise<Native>;
  verifySiblings: (census: unknown, siblings: BatchSibling[]) => Promise<boolean>;
} = {
  // Enable only after all competing HRCEN writers are held or use the shared
  // durable claim. Preview remains available while this cutover flag is off.
  authorityReady: () => process.env.PANE_CLOUD_CREATE_DISPATCH === 'on',
  runtimeReady: () => {
    try {
      const require = createRequire(new URL('../../tooling/stagehand/package.json', import.meta.url));
      return (require('playwright/package.json') as { version?: unknown }).version === '1.63.0';
    } catch { return false; }
  },
  run: async (input, options) => {
    const tool = await import(new URL('../../tooling/hms-cloud/create-reservation.mjs', import.meta.url).href) as {
      createReservation: (input: Record<string, unknown>, options: unknown) => Promise<Native>;
    };
    return tool.createReservation(input, options);
  },
  verifySiblings: async (census, siblings) => {
    const tool = await import(new URL('../../tooling/hms-cloud/batch-sibling-readback.mjs', import.meta.url).href) as {
      verifyBatchSiblings: (census: unknown, siblings: BatchSibling[]) => Promise<boolean>;
    };
    return tool.verifyBatchSiblings(census, siblings);
  },
};
const refused = (reason: string): PaneStayResult => ({ status: 'refused', reason });

const cursorSchema = z.object({ extractionId: z.string().uuid(), revision: z.number().int().nonnegative(),
  revisionHead: z.number().int().nonnegative(), seq: z.number().int().nonnegative() }).strict();
type Cursor = z.infer<typeof cursorSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const day = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(day.valueOf()) && day.toISOString().slice(0, 10) === value;
});
const grantSchema = z.object({ version: z.literal('pane-cloud-preview/v1'), grantId: z.string().uuid(),
  digest, actorUserId: z.string().min(1), sessionId: z.string().min(1), sessionProfile: z.enum(['legacy', 'remote']),
  accessId: z.string().min(1), source: cloudPreviewSelection.shape.source,
  identity: paneCreateIdentitySchema, nativeGuestId: z.string().regex(/^\d+$/), cursor: cursorSchema,
  sourceDigest: digest, stateDigest: digest, requestDigest: digest, stayDigest: digest,
  approvedRequest: z.record(z.string(), z.unknown()),
  previewShot: z.object({ runId: z.string().uuid(), sha256: digest }).strict(), expiresAt: z.number().finite() }).strict();
type Grant = z.infer<typeof grantSchema>;
const PREVIEWS = 'cloudCreatePreviews';
const BATCH = 'cloudCreateBatch';
const PAST_BATCHES = 'cloudCreatePastBatches';
const BATCH_HOLDS = 'cloudCreateBatchHolds';
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const batchSchema = z.object({ version: z.literal('pane-cloud-batch/v1'), id: z.string().uuid(),
  rooms: z.array(z.object({ stayId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), grant: grantSchema }).strict()).min(2).max(8),
  digest }).strict();
type StoredBatch = z.infer<typeof batchSchema>;
type BatchSibling = { confirmation: string; approvedRequest: Record<string, unknown>; requestDigest: string };

function createTarget(stay: PaneStay): HmsDispatchTarget | null {
  const parsed = hmsDispatchTargetSchema.safeParse({ propertyCode: 'HRCEN', kind: 'create',
    firstName: stay.firstName, lastName: stay.lastName, arrival: stay.arrival });
  return parsed.success && parsed.data.kind === 'create' ? parsed.data : null;
}

// The legacy alias can report on; real guests require the dedicated flag itself.
function createAdmission(mode: 'off' | 'lab' | 'on', stay: PaneStay, preview = false) {
  const allowRealGuest = mode === 'on' && process.env.PANE_WRITE_CREATE === 'on';
  if (!isLabtestGuest(stay) && !allowRealGuest) return { reason: 'cloud_preview_labtest_only', allowRealGuest: false };
  const reason = paneStayModeRefusal(preview && mode === 'off' ? 'on' : mode, stay);
  if (reason) return { reason, allowRealGuest };
  if (!validCreateDates(stay.arrival, stay.departure, allowRealGuest)) {
    return { reason: allowRealGuest ? 'current_or_future_arrival_required' : 'pane_save_arrival_2027_required', allowRealGuest };
  }
  return { reason: null, allowRealGuest };
}

async function currentCursor(db: DB, input: Input): Promise<Cursor> {
  const [item] = await db.select({ extractionId: workItem.extractionId, revision: workItem.revision,
    revisionHead: workItem.revisionHead, seq: workItem.revisionSeq }).from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1);
  const parsed = cursorSchema.safeParse(item);
  if (!parsed.success) throw new Error('create_source_stale');
  return parsed.data;
}

function sourceKey(input: Input, cursor: Cursor) {
  return { transportId: input.transportId, workItemId: input.workItemId, threadId: input.selection.source.threadId,
    messageId: input.selection.source.messageId, cursor };
}

/** Recheck the exact source, extraction, mailbox and staff access while their rows are locked. */
async function checkSource(tx: CreateFenceTransaction, source: LockedCreateSource, input: Input, accessId?: string) {
  await assertNoCreateDispatchFence(tx, { transportId: input.transportId, workItemId: input.workItemId });
  const actor = await lockCreateActorAccess(tx, { transportId: input.transportId, actorUserId: input.actorUserId, accessId });
  const mail = source.snapshot.source;
  if (mail.historyOnly || staffQuoteSourceHash(mail) !== input.selection.source.sourceHash ||
      actor.mailboxAddress !== input.mailboxAddress) throw new Error('cloud_create_source_changed');
  const thread = await tx.select({ id: message.id, direction: message.direction, fromAddress: message.fromAddress,
    ownerHeaderValue: message.ownerHeaderValue, toAddresses: message.toAddresses, ccAddresses: message.ccAddresses })
    .from(message).where(and(eq(message.transportId, input.transportId), eq(message.threadId, input.selection.source.threadId)))
    .orderBy(message.id).limit(513).for('share');
  if (thread.length > 512 || !thread.some((row) => row.id === mail.id) ||
      thread.some((row) => (row.id === mail.id || row.direction === 'inbound') && isDaVinciMailboxOrigin(row))) {
    throw new Error('cloud_create_property_mismatch');
  }
  const payload = source.snapshot.extraction.payload;
  if (!activePaneCreateIdentity(payload, source.item.state, input.selection.identity)) throw new Error('cloud_create_scope_changed');
  const confirmations = payload && Array.isArray(payload.confirmationNumbers)
    ? payload.confirmationNumbers.filter((value): value is string => typeof value === 'string') : [];
  if (!actor.mailboxAddress || isSelfSentPreStayInformationMail({ fromAddress: mail.fromAddress, mailboxAddress: actor.mailboxAddress,
    subject: mail.subject, confirmationNumbers: confirmations })) throw new Error('cloud_create_existing_booking');
  // Staff may edit the booking. The grant binds their reviewed form and selected
  // room identity; the native request fence checks the same values before Save.
  const state = { ...source.item.state };
  for (const key of [PREVIEWS, BATCH, PAST_BATCHES, BATCH_HOLDS, 'stayPreviews', 'stays']) delete state[key];
  return { sourceDigest: source.sourceDigest, stateDigest: createHash('sha256').update(canonicalJson(state)).digest('hex'),
    accessId: actor.accessId };
}

function grantOf(state: Record<string, unknown>, stayId: string): Grant | null {
  const previews = state[PREVIEWS];
  if (!previews || typeof previews !== 'object' || Array.isArray(previews)) return null;
  const parsed = grantSchema.safeParse((previews as Record<string, unknown>)[stayId]);
  return parsed.success ? parsed.data : null;
}
function sameGrant(grant: Grant, input: Input, previewDigest: string): boolean {
  const { digest: grantDigest, ...draft } = grant;
  return grantDigest === previewDigest && hash(draft) === grantDigest && grant.actorUserId === input.actorUserId && grant.expiresAt > Date.now() &&
    grant.sessionId === input.sessionId && grant.sessionProfile === input.sessionProfile &&
    grant.stayDigest === paneStayDigest(input.stay) && grant.nativeGuestId === input.selection.nativeGuestId &&
    canonicalJson(grant.source) === canonicalJson(input.selection.source) &&
    canonicalJson(grant.identity) === canonicalJson(input.selection.identity);
}
function matchesSource(current: { sourceDigest: string; stateDigest: string; accessId: string }, expected: {
  sourceDigest: string; stateDigest: string; accessId: string;
}): boolean {
  return current.sourceDigest === expected.sourceDigest && current.stateDigest === expected.stateDigest && current.accessId === expected.accessId;
}
function staysClear(state: Record<string, unknown>, target?: HmsDispatchTarget): boolean {
  const stays = state.stays;
  if (stays === undefined) return true;
  if (!stays || typeof stays !== 'object' || Array.isArray(stays)) return false;
  return Object.values(stays).every((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const row = raw as Record<string, unknown>;
    if (row.status === 'booked' && typeof row.confirmationNumber === 'string' && row.confirmationNumber.trim()) return true;
    const other = hmsDispatchTargetSchema.safeParse(row.cloudCreateTarget);
    return Boolean(target && row.status === 'unknown' && other.success && other.data.kind === 'create' &&
      hmsDispatchTargetKey(other.data) !== hmsDispatchTargetKey(target));
  });
}
const hasStay = (state: Record<string, unknown>, stayId: string) =>
  !!state.stays && typeof state.stays === 'object' && !Array.isArray(state.stays) && Object.hasOwn(state.stays, stayId);
const previewShotValid = (grant: Grant, input: Input) => verifyStoredHmsShot({ ...grant.previewShot, name: 'filled.png',
  owner: `${input.actorUserId}:${input.transportId}`, propertyCode: 'HRCEN', workItemId: input.workItemId });

function storedBatch(state: Record<string, unknown>, id: string): StoredBatch | null {
  const current = state[BATCH];
  const past = state[PAST_BATCHES];
  const archived = past && typeof past === 'object' && !Array.isArray(past) ? (past as Record<string, unknown>)[id] : undefined;
  const parsed = batchSchema.safeParse((current as { id?: unknown } | undefined)?.id === id ? current : archived);
  if (!parsed.success || parsed.data.id !== id) return null;
  const { digest: actual, ...body } = parsed.data;
  return hash(body) === actual && new Set(body.rooms.map((room) => room.stayId)).size === body.rooms.length ? parsed.data : null;
}

function batchHolds(state: Record<string, unknown>): Record<string, string> | null {
  if (state[BATCH_HOLDS] === undefined) return {};
  const parsed = z.record(z.string().uuid(), z.string().uuid()).safeParse(state[BATCH_HOLDS]);
  return parsed.success ? parsed.data : null;
}

/** An unused preview captured by a stopped Go needs a new preview before a new Go. */
function grantInStoppedBatch(state: Record<string, unknown>, grantId: string): boolean {
  const holds = batchHolds(state);
  if (!holds) return true;
  for (const [id, heldGrantId] of Object.entries(holds)) {
    const batch = storedBatch(state, id);
    if (!batch || !batch.rooms.some((room) => room.grant.grantId === heldGrantId) ||
        batch.rooms.some((room) => room.grant.grantId === grantId)) return true;
  }
  return false;
}

type CreateDispatchTarget = Extract<HmsDispatchTarget, { kind: 'create' }>;
export type CloudCreateHoldProjection = {
  target: CreateDispatchTarget;
  batch?: { id: string; rooms: Array<{ stayId: string; target: CreateDispatchTarget }> };
};

/** Positive Create target provenance, separate from a stopped-Go projection. */
export function cloudCreateBookedTargetOf(state: Record<string, unknown>, stayId: string): CreateDispatchTarget | null {
  const stays = state.stays;
  if (!stays || typeof stays !== 'object' || Array.isArray(stays)) return null;
  const row = (stays as Record<string, unknown>)[stayId];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const saved = row as Record<string, unknown>, target = hmsDispatchTargetSchema.safeParse(saved.cloudCreateTarget);
  return saved.status === 'booked' && typeof saved.confirmationNumber === 'string' && saved.confirmationNumber.trim() &&
    saved.cloudCreateVerified === true && z.string().uuid().safeParse(saved.cloudCreateGrantId).success &&
    target.success && target.data.kind === 'create' ? target.data : null;
}

/** Read-only display of a stopped Create target and its sealed original Go. */
export function cloudCreateHoldOf(state: Record<string, unknown>, stayId: string): CloudCreateHoldProjection | null {
  const stays = state.stays;
  if (!stays || typeof stays !== 'object' || Array.isArray(stays)) return null;
  const raw = (stays as Record<string, unknown>)[stayId];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const unknown = row.status === 'unknown';
  if (!unknown && (row.status !== 'booked' || typeof row.confirmationNumber !== 'string' ||
      !row.confirmationNumber.trim())) return null;
  const target = hmsDispatchTargetSchema.safeParse(row.cloudCreateTarget);
  if (unknown && (!z.string().uuid().safeParse(row.cloudCreateGrantId).success ||
      !target.success || target.data.kind !== 'create')) return null;
  const holds = batchHolds(state);
  if (!holds) return null;

  // A missing or corrupt manifest cannot be mistaken for an independently held single room.
  const current = state[BATCH], archived = state[PAST_BATCHES];
  if (archived !== undefined && (!archived || typeof archived !== 'object' || Array.isArray(archived))) return null;
  if (Object.entries((archived ?? {}) as Record<string, unknown>).some(([id, value]) =>
    !value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).id !== id)) return null;
  const raws = [current, ...Object.values((archived ?? {}) as Record<string, unknown>)].filter((value) => value !== undefined);
  const batches: StoredBatch[] = [];
  for (const value of raws) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = (value as Record<string, unknown>).id;
    const batch = typeof id === 'string' ? storedBatch(state, id) : null;
    if (!batch || batches.some((other) => other.id === batch.id)) return null;
    batches.push(batch);
  }
  if (!unknown && row.cloudCreateRecovered === true && row.cloudCreateRecoveredBatchId === null &&
      z.string().uuid().safeParse(row.cloudCreateGrantId).success && target.success && target.data.kind === 'create' &&
      !Object.values(holds).includes(row.cloudCreateGrantId as string) &&
      !batches.some((batch) => batch.rooms.some((room) => room.grant.grantId === row.cloudCreateGrantId))) {
    return { target: target.data };
  }
  // Recovery intentionally keeps the batch hold, but older recovered rows did
  // not retain their original target/grant. Reconstruct that binding only
  // from the held grant in the sealed manifest for this exact stay.
  const recovered = unknown ? [] : batches.flatMap((batch) => batch.rooms.filter((room) =>
    room.stayId === stayId && room.grant.grantId === holds[batch.id]).map((room) => ({ batch, room })));
  if (!unknown && recovered.length !== 1) return null;
  const grantId = unknown ? row.cloudCreateGrantId : recovered[0]!.room.grant.grantId;
  if (!unknown && row.cloudCreateGrantId !== undefined && row.cloudCreateGrantId !== grantId) return null;
  const heldIds = Object.entries(holds).filter(([, value]) => value === grantId).map(([id]) => id);
  if (heldIds.length > 1) return null;
  const related = batches.filter((batch) => batch.rooms.some((room) => room.grant.grantId === grantId));
  if (heldIds.length === 0) return unknown && target.success && target.data.kind === 'create' && related.length === 0
    ? { target: target.data } : null;
  if (related.length !== 1 || related[0]?.id !== heldIds[0]) return null;
  const batch = related[0]!;
  const rooms: NonNullable<CloudCreateHoldProjection['batch']>['rooms'] = [];
  const grantIds = new Set<string>();
  for (const room of batch.rooms) {
    const { digest: grantDigest, ...grantBody } = room.grant;
    const request = z.object({ propertyCode: z.literal('HRCEN'),
      guest: z.object({ nativeId: z.string().regex(/^\d+$/), firstName: z.string(), lastName: z.string() }).passthrough(),
      stay: z.object({ arrival: z.string() }).passthrough() }).passthrough().safeParse(room.grant.approvedRequest);
    if (grantIds.has(room.grant.grantId) || hash(grantBody) !== grantDigest ||
        hash(room.grant.approvedRequest) !== room.grant.requestDigest ||
        room.stayId !== `${room.grant.identity.stayId}_${room.grant.identity.roomIndex}` ||
        !request.success || request.data.guest.nativeId !== room.grant.nativeGuestId) return null;
    grantIds.add(room.grant.grantId);
    const memberTarget = hmsDispatchTargetSchema.safeParse({ propertyCode: 'HRCEN', kind: 'create',
      firstName: request.data.guest.firstName, lastName: request.data.guest.lastName, arrival: request.data.stay.arrival });
    if (!memberTarget.success || memberTarget.data.kind !== 'create') return null;
    rooms.push({ stayId: room.stayId, target: memberTarget.data });
  }
  const held = batch.rooms.find((room) => room.stayId === stayId && room.grant.grantId === grantId);
  const heldTarget = rooms.find((room) => room.stayId === stayId)?.target;
  if (!held || !heldTarget || ((unknown || row.cloudCreateTarget !== undefined) &&
      (!target.success || target.data.kind !== 'create' || hmsDispatchTargetKey(heldTarget) !== hmsDispatchTargetKey(target.data)))) return null;
  return { target: heldTarget, batch: { id: batch.id, rooms } };
}

/** Check whether every room in the current batch has durable positive evidence. */
async function previousBatchComplete(tx: CreateFenceTransaction, state: Record<string, unknown>, input: Input): Promise<boolean> {
  const raw = state[BATCH];
  if (raw === undefined) return true;
  const id = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).id : null;
  const batch = typeof id === 'string' ? storedBatch(state, id) : null;
  const stays = state.stays && typeof state.stays === 'object' && !Array.isArray(state.stays)
    ? state.stays as Record<string, unknown> : null;
  if (!batch || !stays) return false;
  const completed = await readResolvedHmsLabtestCreates(tx, input.workItemId);
  const confirmations = new Set<string>();
  for (const room of batch.rooms) {
    const prior = stays[room.stayId];
    if (!prior || typeof prior !== 'object' || Array.isArray(prior)) return false;
    const row = prior as Record<string, unknown>, confirmation = row.confirmationNumber;
    if (row.status !== 'booked' || typeof confirmation !== 'string' || !confirmation.trim() || confirmations.has(confirmation)) return false;
    const evidence = completed.filter(({ intent, resolution }) =>
      intent.transportId === input.transportId && intent.actorUserId === room.grant.actorUserId &&
      intent.grantId === room.grant.grantId && intent.stayId === room.stayId &&
      intent.approvedDigest === room.grant.requestDigest && intent.sourceDigest === room.grant.sourceDigest &&
      intent.nativeGuestId === room.grant.nativeGuestId && resolution.confirmation === confirmation);
    if (evidence.length !== 1) return false;
    confirmations.add(confirmation);
  }
  return true;
}

/** The first Save transaction captures every previewed room under the single Go. */
async function prepareBatch(tx: CreateFenceTransaction, source: LockedCreateSource, input: Input, grant: Grant,
  previewDigest: string): Promise<{ batch: StoredBatch; pastBatches?: Record<string, unknown> } | null> {
  const batch = input.batch;
  if (!batch || batch.kind !== 'start') return null;
  if (!z.string().uuid().safeParse(batch.id).success || batch.rooms.length < 2 || batch.rooms.length > 8 ||
      new Set(batch.rooms.map((room) => room.stayId)).size !== batch.rooms.length ||
      batch.rooms[0]?.stayId !== input.stayId || batch.rooms[0]?.previewDigest !== previewDigest) {
    throw new Error('cloud_batch_stale');
  }
  let pastBatches: Record<string, unknown> | undefined;
  const raw = source.item.state[BATCH];
  const id = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).id : null;
  const holds = batchHolds(source.item.state);
  // Positive recovery can complete every room without releasing the original
  // batch hold. Its sealed manifest must survive the next unrelated Go.
  if (!await previousBatchComplete(tx, source.item.state, input) ||
      (typeof id === 'string' && holds && Object.hasOwn(holds, id))) {
    const previous = typeof id === 'string' ? storedBatch(source.item.state, id) : null;
    const archived = source.item.state[PAST_BATCHES];
    if (!previous || (archived !== undefined && (!archived || typeof archived !== 'object' || Array.isArray(archived))) ||
        (archived && Object.hasOwn(archived, previous.id)) || !holds ||
        !previous.rooms.some((room) => room.grant.grantId === holds[previous.id])) throw new Error('cloud_batch_stale');
    // Preserve the prior manifest and its in-flight hold while a separate batch runs.
    pastBatches = { ...(archived as Record<string, unknown> | undefined), [previous.id]: previous };
  }
  const rooms: StoredBatch['rooms'] = [];
  for (const room of batch.rooms) {
    const roomInput: Input = { ...input, stayId: room.stayId, stay: room.stay, selection: room.selection, batch: undefined };
    const candidate = grantOf(source.item.state, room.stayId);
    const current = await checkSource(tx, source, roomInput, grant.accessId);
    const roomTarget = createTarget(room.stay);
    if (!candidate || grantInStoppedBatch(source.item.state, candidate.grantId) ||
        room.stayId !== `${room.selection.identity.stayId}_${room.selection.identity.roomIndex}` ||
        !sameGrant(candidate, roomInput, room.previewDigest) || !matchesSource(current, candidate) ||
        canonicalJson(candidate.source) !== canonicalJson(grant.source) ||
        canonicalJson(candidate.cursor) !== canonicalJson(grant.cursor) ||
        !roomTarget || !staysClear(source.item.state, roomTarget) || hasStay(source.item.state, room.stayId) ||
        createAdmission(paneStaySaveLoaders.mode?.() ?? paneStaySaveMode(), room.stay).reason ||
        !await previewShotValid(candidate, roomInput)) throw new Error('cloud_batch_stale');
    rooms.push({ stayId: room.stayId, grant: candidate });
  }
  const body = { version: 'pane-cloud-batch/v1' as const, id: batch.id, rooms };
  return { batch: batchSchema.parse({ ...body, digest: hash(body) }), ...(pastBatches ? { pastBatches } : {}) };
}

/** Earlier confirmations come from this item's server-written evidence, never client JSON. */
async function checkedSiblings(tx: CreateFenceTransaction, state: Record<string, unknown>, input: Input,
  grant: Grant, previewDigest: string): Promise<BatchSibling[]> {
  if (!input.batch || input.batch.kind !== 'continue') throw new Error('cloud_batch_stale');
  const batch = storedBatch(state, input.batch.id), index = input.batch.index;
  const holds = batchHolds(state);
  const stays = state.stays as Record<string, unknown> | undefined;
  if (!batch || !Number.isInteger(index) || index < 1 || index >= batch.rooms.length ||
      batch.rooms[index]?.stayId !== input.stayId || batch.rooms[index]?.grant.digest !== previewDigest ||
      canonicalJson(batch.rooms[index]?.grant) !== canonicalJson(grant) || !holds || Object.hasOwn(holds, batch.id) ||
      batch.rooms.some((room) => (stays?.[room.stayId] as Record<string, unknown> | undefined)?.status === 'unknown')) {
    throw new Error('cloud_batch_stale');
  }
  const completed = await readResolvedHmsLabtestCreates(tx, input.workItemId);
  const siblings: BatchSibling[] = [];
  for (const room of batch.rooms.slice(0, index)) {
    const previous = stays?.[room.stayId] as Record<string, unknown> | undefined;
    const confirmation = previous?.confirmationNumber;
    const evidence = completed.filter(({ intent, resolution }) =>
      intent.transportId === input.transportId && intent.actorUserId === input.actorUserId &&
      intent.grantId === room.grant.grantId && intent.stayId === room.stayId &&
      intent.approvedDigest === room.grant.requestDigest && intent.sourceDigest === room.grant.sourceDigest &&
      intent.nativeGuestId === room.grant.nativeGuestId && resolution.confirmation === confirmation);
    if (previous?.status !== 'booked' || typeof confirmation !== 'string' || !confirmation.trim() ||
        evidence.length !== 1 || evidence[0]?.resolution.recovered === true) {
      throw new Error('cloud_batch_stale');
    }
    siblings.push({ confirmation, approvedRequest: room.grant.approvedRequest, requestDigest: room.grant.requestDigest });
  }
  if (new Set(siblings.map((item) => item.confirmation)).size !== siblings.length) throw new Error('cloud_batch_stale');
  return siblings;
}

async function saveScreenshots(native: Native, input: Input, beforeSha256: string) {
  const before = native.screenshots?.before;
  if (typeof before !== 'string') return null;
  const dir = dirname(before), match = /^hms-cloud-create-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(basename(dir));
  if (!match || before !== join('/tmp', basename(dir), 'before.png') || native.screenshots?.after !== join(dir, 'after.png')) return null;
  const runId = match[1]!, owner = `${input.actorUserId}:${input.transportId}`;
  await copyFile(join(dir, 'after.png'), join(dir, 'saved.png'));
  registerPaneRun({ runId, dir, owner, now: Date.now() });
  const shots = await persistHmsShots({ propertyCode: 'HRCEN', workItemId: input.workItemId, runId, sourceDir: dir, owner, now: Date.now() }).catch(() => null);
  const saved = shots?.find((shot) => shot.name === 'saved.png');
  if (!shots || !shots.some((shot) => shot.name === 'before.png' && shot.sha256 === beforeSha256) ||
      !saved || !await verifyStoredHmsShot({ runId, name: 'saved.png', sha256: saved.sha256, owner,
        propertyCode: 'HRCEN', workItemId: input.workItemId }, 'saved.png')) return null;
  return { runId, screenshots: ['before.png', 'saved.png'], shots };
}

/** Persist the last clean preimage and before image before creating an UNKNOWN intent. */
async function createRecoveryEvidence(value: unknown, input: Input, siblings: BatchSibling[]) {
  const parsed = z.object({ beforeScreenshot: z.string(), preimage: z.object({ outcome: z.literal('clear'),
    firstName: z.string().min(1), lastName: z.string().min(1), arrival: isoDate, departure: isoDate,
    searchedDateRange: z.object({ from: isoDate, to: isoDate }),
    expiresAt: z.string().datetime(),
    coverage: z.object({ displayed: z.number().int().nonnegative().safe(), total: z.number().int().nonnegative().safe(),
      complete: z.literal(true) }),
    sameArrival: z.array(z.object({ confirmation: z.string().regex(/^\d{6,10}-\d{1,2}$/), firstName: z.string().min(1), lastName: z.string().min(1),
      arrival: isoDate, departure: isoDate, status: z.literal('Reserved') }).passthrough()),
    verifiedExisting: z.literal(true).optional(),
  }).passthrough(), writer: z.unknown().optional(), guaranteeDisplay: z.string().min(1).max(200) }).strict().safeParse(value);
  const matchingSiblings = siblings.filter((sibling) => {
    const request = sibling.approvedRequest as { guest?: unknown; stay?: { arrival?: unknown } };
    return sameCreateGuest(request.guest, input.stay) && request.stay?.arrival === input.stay.arrival;
  });
  const guarantee = createGuaranteeCode(input.stay.guaranteeType);
  if (!parsed.success || parsed.data.preimage.firstName !== input.stay.firstName ||
      parsed.data.preimage.lastName !== input.stay.lastName || parsed.data.preimage.arrival !== input.stay.arrival ||
      parsed.data.preimage.departure !== input.stay.departure || input.stay.arrival >= input.stay.departure ||
      parsed.data.preimage.searchedDateRange.from > input.stay.arrival ||
      parsed.data.preimage.searchedDateRange.to < input.stay.arrival ||
      Date.parse(parsed.data.preimage.expiresAt) <= Date.now() ||
      parsed.data.preimage.coverage.displayed !== parsed.data.preimage.coverage.total ||
      parsed.data.preimage.coverage.displayed < parsed.data.preimage.sameArrival.length ||
      !guarantee || parsed.data.guaranteeDisplay !== CREATE_GUARANTEES[guarantee] ||
      parsed.data.preimage.sameArrival.length !== matchingSiblings.length ||
      (siblings.length > 0 && parsed.data.preimage.verifiedExisting !== true) ||
      new Set(parsed.data.preimage.sameArrival.map((row) => row.confirmation)).size !== matchingSiblings.length ||
      parsed.data.preimage.sameArrival.some((row) => !sameCreateGuest(row, input.stay) || row.arrival !== input.stay.arrival ||
        !matchingSiblings.some((sibling) => sibling.confirmation === row.confirmation))) {
    throw new Error('cloud_create_preimage_unavailable');
  }
  const before = parsed.data.beforeScreenshot, dir = dirname(before);
  const match = /^hms-cloud-create-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(basename(dir));
  if (!match || before !== join('/tmp', basename(dir), 'before.png')) throw new Error('cloud_create_before_unavailable');
  const runId = match[1]!, owner = `${input.actorUserId}:${input.transportId}`;
  const shots = await persistHmsShots({ propertyCode: 'HRCEN', workItemId: input.workItemId, runId, sourceDir: dir, owner, now: Date.now() });
  const shot = shots?.find((item) => item.name === 'before.png');
  if (!shot || !await verifyStoredHmsShot({ runId, name: 'before.png', sha256: shot.sha256, owner,
    propertyCode: 'HRCEN', workItemId: input.workItemId }, 'before.png')) throw new Error('cloud_create_before_unavailable');
  const { firstName, lastName, arrival, departure, searchedDateRange, coverage, expiresAt, sameArrival } = parsed.data.preimage;
  return { beforeShot: { runId, sha256: shot.sha256 },
    preimage: { firstName, lastName, arrival, departure, searchedDateRange, coverage, expiresAt, sameArrival },
    batchManifest: siblings, guaranteeDisplay: parsed.data.guaranteeDisplay };
}

/** Preview the exact request; a one-use Go grant is issued only when saving is enabled. */
export async function previewPaneCloud(db: DB, input: Input): Promise<PaneStayResult & { guestCandidates?: unknown[] }> {
  if (!cloudPreviewSelection.safeParse(input.selection).success ||
      input.stayId !== `${input.selection.identity.stayId}_${input.selection.identity.roomIndex}`) return refused('pane_preview_binding_required');
  const target = paneStayCreateTarget({ transportId: input.transportId, propertyCode: input.stay.propertyCode });
  if (!target.ok || target.target.propertyCode !== 'HRCEN' || target.target.browserSlot !== 'centurion') return refused('pane_save_property_mismatch');
  const dispatchTarget = createTarget(input.stay);
  if (!dispatchTarget) return refused('guest_name_required');
  const initialMode = paneStaySaveLoaders.mode?.() ?? paneStaySaveMode();
  const admission = createAdmission(initialMode, input.stay, true);
  if (admission.reason) return refused(admission.reason);
  if (!paneCloudPreviewLoaders.runtimeReady()) return refused('cloud_create_runtime_unavailable');
  const mapped = mapPaneStayToCloudCreateInput(input.stay, 'prepare', input.selection.nativeGuestId);
  if (mapped.outcome !== 'ok') return refused(mapped.reason);
  try {
    const cursor = await currentCursor(db, input), key = sourceKey(input, cursor);
    const before = await withLockedCreateSource(db, key, (tx, source) => checkSource(tx, source, input));
    const sourceUnchanged = async () => {
      const after = await withLockedCreateSource(db, key, (tx, source) => checkSource(tx, source, input, before.accessId));
      return matchesSource(after, before);
    };
    const native = await paneCloudPreviewLoaders.run(mapped.input, { capturePrepareScreenshot: Boolean(input.selection.nativeGuestId),
      requireExplicitGuestSelection: !input.selection.nativeGuestId, allowRealGuest: admission.allowRealGuest,
      expectedGuest: { firstName: input.stay.firstName, lastName: input.stay.lastName },
      cloudTargetKey: hmsDispatchTargetKey(dispatchTarget) });
    if (!input.selection.nativeGuestId && ['guest_ambiguous', 'guest_choice_required', 'guest_not_found'].includes(String(native.issue)) && Array.isArray(native.guestCandidates)) {
      if (!await sourceUnchanged()) return refused('cloud_create_scope_changed');
      const candidates = native.guestCandidates.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const row = value as Record<string, unknown>;
        if (typeof row.nativeId !== 'string' || !/^\d+$/.test(row.nativeId) || row.firstName !== input.stay.firstName || row.lastName !== input.stay.lastName) return [];
        return [{ nativeId: row.nativeId, firstName: row.firstName, lastName: row.lastName,
          ...(typeof row.city === 'string' && row.city ? { city: row.city } : {}),
          ...(typeof row.country === 'string' && row.country ? { country: row.country } : {}) }];
      }).slice(0, 50);
      return { ...refused('guest_choice_required'), guestCandidates: candidates };
    }
    if (!input.selection.nativeGuestId) return refused('prepared_guest_identity_required');
    if (native.outcome !== 'prepared' || !native.requestBinding) return refused('cloud_preview_unavailable');
    const proof = digestPaneCloudCreateProof(input.stay, native.requestBinding.request, native.applied?.guaranteeType,
      input.selection.nativeGuestId, true);
    if (proof.outcome !== 'ok' || native.requestBinding.digest !== proof.normalizedRequestDigest) return refused('cloud_create_proof_mismatch');
    const shot = native.screenshots?.filled;
    if (typeof shot !== 'string') return refused('cloud_preview_unavailable');
    const dir = dirname(shot), match = /^hms-cloud-create-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(basename(dir));
    if (!match || shot !== join('/tmp', basename(dir), 'filled.png')) return refused('cloud_preview_unavailable');
    const owner = `${input.actorUserId}:${input.transportId}`, runId = match[1]!;
    registerPaneRun({ runId, dir, owner, now: Date.now() });
    const shots = await persistHmsShots({ propertyCode: 'HRCEN', workItemId: input.workItemId, runId, sourceDir: dir, owner, now: Date.now() });
    const filled = shots?.find((item) => item.name === 'filled.png');
    if (!filled || !await verifyStoredHmsShot({ runId, name: filled.name, sha256: filled.sha256,
      owner, propertyCode: 'HRCEN', workItemId: input.workItemId })) return refused('cloud_preview_unavailable');
    return await withLockedCreateSource(db, key, async (tx, source) => {
      const after = await checkSource(tx, source, input, before.accessId);
      if (!matchesSource(after, before)) return refused('cloud_create_scope_changed');
      if (!staysClear(source.item.state, dispatchTarget)) return refused('cloud_create_recovery_required');
      if (hasStay(source.item.state, input.stayId)) return refused('pane_stay_already_booked');
      const currentMode = paneStaySaveLoaders.mode?.() ?? paneStaySaveMode();
      const currentAdmission = createAdmission(currentMode, input.stay, true);
      if (currentAdmission.reason) return refused(currentAdmission.reason);
      const sessionBinding = z.object({ sessionId: z.string().min(1), sessionProfile: z.enum(['legacy', 'remote']) })
        .safeParse({ sessionId: input.sessionId, sessionProfile: input.sessionProfile });
      if (initialMode === 'off' || currentMode === 'off' || currentAdmission.allowRealGuest !== admission.allowRealGuest ||
          !paneCloudPreviewLoaders.authorityReady() || !sessionBinding.success) {
        return { status: 'ok' as const, outcome: 'preview_only', runId, screenshots: ['filled.png'] };
      }
      await lockCreateActorSession(tx, { actorUserId: input.actorUserId, ...sessionBinding.data });
      const draft = { version: 'pane-cloud-preview/v1' as const, grantId: randomUUID(), actorUserId: input.actorUserId,
        ...sessionBinding.data, accessId: after.accessId, source: input.selection.source, identity: input.selection.identity,
        nativeGuestId: input.selection.nativeGuestId!, cursor, sourceDigest: after.sourceDigest, stateDigest: after.stateDigest,
        requestDigest: proof.normalizedRequestDigest, stayDigest: paneStayDigest(input.stay), approvedRequest: proof.request,
        previewShot: { runId, sha256: filled.sha256 }, expiresAt: Date.now() + PANE_PREVIEW_TTL_MS };
      const grant = grantSchema.parse({ ...draft, digest: hash(draft) });
      const previews = source.item.state[PREVIEWS];
      if (previews !== undefined && (!previews || typeof previews !== 'object' || Array.isArray(previews))) return refused('cloud_preview_unavailable');
      const state = { ...source.item.state, [PREVIEWS]: { ...(previews as Record<string, unknown> | undefined), [input.stayId]: grant } };
      await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
      return { status: 'ok' as const, outcome: 'previewed', previewDigest: grant.digest, runId, screenshots: ['filled.png'] };
    });
  } catch (error) {
    const sourceChanged = error instanceof Error && /^(create_source_|create_actor_|create_fence_|cloud_create_(source_changed|property_mismatch|existing_booking|scope_changed))/.test(error.message);
    return refused(sourceChanged ? 'cloud_create_scope_changed' : 'cloud_preview_unavailable');
  }
}

/** Consume one reviewed grant, write one fenced stay, and require fresh readback. */
export async function commitPaneCloud(db: DB, input: Input, previewDigest: string): Promise<PaneStayResult> {
  if (!cloudPreviewSelection.safeParse(input.selection).success || !z.string().uuid().safeParse(input.workItemId).success ||
      !/^[A-Za-z0-9_-]{1,40}$/.test(input.stayId) || input.stayId !== `${input.selection.identity.stayId}_${input.selection.identity.roomIndex}`) {
    return refused('pane_preview_binding_required');
  }
  const target = paneStayCreateTarget({ transportId: input.transportId, propertyCode: input.stay.propertyCode });
  if (!target.ok || target.target.propertyCode !== 'HRCEN' || target.target.browserSlot !== 'centurion') return refused('pane_save_property_mismatch');
  const dispatchTarget = createTarget(input.stay);
  if (!dispatchTarget) return refused('guest_name_required');
  const admission = createAdmission(paneStaySaveLoaders.mode?.() ?? paneStaySaveMode(), input.stay);
  if (admission.reason) return refused(admission.reason);
  if (!paneCloudPreviewLoaders.authorityReady()) return refused('cloud_create_authority_unavailable');
  if (!paneCloudPreviewLoaders.runtimeReady()) return refused('cloud_create_runtime_unavailable');
  const mapped = mapPaneStayToCloudCreateInput(input.stay, 'commit', input.selection.nativeGuestId,
    { allowRealGuest: admission.allowRealGuest });
  if (mapped.outcome !== 'ok') return refused(mapped.reason);
  if (!digest.safeParse(previewDigest).success) return refused('pane_save_preview_required');
  const lock = paneStaySaveLoaders.lock ?? paneStayCloudTargetLock(target.target, dispatchTarget, { kind: 'independent_cloud' });
  if (!lock) return refused('pane_save_lock_unavailable');
  let claimAttempted = false;
  const dispatch: { handle: HmsLabtestWriteHandle | null } = { handle: null };
  let beforeSha256: string | null = null;
  let claimError: unknown;
  let authorizationError: unknown;
  const noClaimResult = () => {
    if ((claimError instanceof HmsLabtestDispatchError && claimError.reason === 'occupied') ||
        (authorizationError instanceof Error && authorizationError.message === 'cloud_create_recovery_required')) {
      return refused('cloud_create_recovery_required');
    }
    if (authorizationError) return refused('cloud_create_scope_changed');
    return refused(claimAttempted ? PANE_SAVE_UNCONFIRMED : 'cloud_create_unavailable');
  };
  try {
    return await lock.withLock(async () => {
      const currentMode = paneStaySaveLoaders.mode?.() ?? paneStaySaveMode();
      const currentAdmission = createAdmission(currentMode, input.stay);
      if (currentAdmission.reason || currentAdmission.allowRealGuest !== admission.allowRealGuest) {
        return refused(currentAdmission.reason ?? 'pane_save_flag_off');
      }
      if (!paneCloudPreviewLoaders.authorityReady()) return refused('cloud_create_authority_unavailable');
      const [item] = await db.select({ state: workItem.state }).from(workItem)
        .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1);
      if (item && !staysClear(item.state, dispatchTarget)) return refused('cloud_create_recovery_required');
      if (item && hasStay(item.state, input.stayId)) return refused('pane_stay_already_booked');
      const grant = item && grantOf(item.state, input.stayId);
      if (!grant || !sameGrant(grant, input, previewDigest) || !await previewShotValid(grant, input)) return refused('pane_save_preview_required');
      const key = sourceKey(input, grant.cursor);
      const epoch = await captureHmsLabtestDispatchEpoch(db, dispatchTarget, input.workItemId);
      let siblings: BatchSibling[] = [];
      if (input.batch?.kind === 'continue') {
        siblings = await withLockedCreateSource(db, key, async (tx, source) => {
          const current = await checkSource(tx, source, input, grant.accessId);
          if (!matchesSource(current, grant)) throw new Error('cloud_batch_stale');
          return checkedSiblings(tx, source.item.state, input, grant, previewDigest);
        });
      }
      let verifiedSiblings = false;
      const native = await paneCloudPreviewLoaders.run(mapped.input, {
        expectedRequestDigest: grant.requestDigest, allowRealGuest: admission.allowRealGuest,
        expectedGuest: { firstName: input.stay.firstName, lastName: input.stay.lastName },
        cloudTargetKey: hmsDispatchTargetKey(dispatchTarget),
        authorizeCandidate: async () => grant.expiresAt > Date.now() && paneCloudPreviewLoaders.authorityReady() &&
          !createAdmission(paneStaySaveLoaders.mode?.() ?? paneStaySaveMode(), input.stay).reason,
        ...(siblings.length ? { verifyLabtestMatches: async (census: unknown) => {
          verifiedSiblings = await paneCloudPreviewLoaders.verifySiblings(census, siblings);
          return verifiedSiblings;
        } } : {}),
        dispatchCandidate: async (request, next, evidence) => {
          const firstRequestDigest = nativeCreateSaveDigest(request);
          if (siblings.length && !verifiedSiblings) throw new Error('cloud_batch_readback_unavailable');
          const recovery = await createRecoveryEvidence(evidence, input, siblings);
          const checked = digestPaneCloudCreateProof(input.stay, grant.approvedRequest, recovery.guaranteeDisplay, grant.nativeGuestId, true);
          if (checked.outcome !== 'ok' || checked.normalizedRequestDigest !== grant.requestDigest ||
              canonicalJson(checked.request) !== canonicalJson(grant.approvedRequest)) {
            throw new Error('cloud_create_recovery_invalid');
          }
          claimAttempted = true;
          try {
            dispatch.handle = await claimHmsLabtestDispatch(db, { workItemId: input.workItemId, transportId: input.transportId,
            actorUserId: input.actorUserId, grantId: grant.grantId, propertyCode: 'HRCEN',
            firstName: input.stay.firstName, lastName: input.stay.lastName, target: dispatchTarget,
            nativeGuestId: grant.nativeGuestId, operation: 'create', stayId: input.stayId, sourceDigest: grant.sourceDigest,
            approvedDigest: grant.requestDigest, requestDigest: firstRequestDigest,
            recovery: { request: grant.approvedRequest, previewShot: grant.previewShot, ...recovery } }, async (tx, claim) => {
            try { await lockCreateSource(tx, key, async (lockedTx, source) => {
              const current = await checkSource(lockedTx, source, input, grant.accessId);
              const liveGrant = grantOf(source.item.state, input.stayId), stays = source.item.state.stays;
              const mode = paneStaySaveLoaders.mode?.() ?? paneStaySaveMode();
              if (claim.stayId !== input.stayId || !liveGrant || grantInStoppedBatch(source.item.state, liveGrant.grantId) ||
                  !sameGrant(liveGrant, input, previewDigest) ||
                  !matchesSource(current, grant) || !staysClear(source.item.state, dispatchTarget) || hasStay(source.item.state, input.stayId) ||
                  createAdmission(mode, input.stay).reason || createAdmission(mode, input.stay).allowRealGuest !== admission.allowRealGuest ||
                  !paneCloudPreviewLoaders.authorityReady() ||
                  !await previewShotValid(grant, input)) throw new Error('cloud_create_dispatch_stale');
              await lockCreateActorSession(lockedTx, { actorUserId: input.actorUserId,
                sessionId: input.sessionId, sessionProfile: input.sessionProfile });
              const startedBatch = await prepareBatch(lockedTx, source, input, grant, previewDigest);
              if (input.batch?.kind === 'continue' &&
                  canonicalJson(await checkedSiblings(lockedTx, source.item.state, input, grant, previewDigest)) !== canonicalJson(siblings)) {
                throw new Error('cloud_batch_stale');
              }
              if (!sameGrant(liveGrant, input, previewDigest) || Date.parse(recovery.preimage.expiresAt) <= Date.now()) {
                throw new Error('cloud_create_dispatch_stale');
              }
              const holds = batchHolds(source.item.state);
              if (!holds || (input.batch && Object.hasOwn(holds, input.batch.id))) throw new Error('cloud_batch_stale');
              const previews = { ...(source.item.state[PREVIEWS] as Record<string, unknown>) };
              delete previews[input.stayId];
              const state = { ...source.item.state, [PREVIEWS]: previews,
                ...(startedBatch ? { [BATCH]: startedBatch.batch,
                  ...(startedBatch.pastBatches ? { [PAST_BATCHES]: startedBatch.pastBatches } : {}) } : {}),
                ...(input.batch ? { [BATCH_HOLDS]: { ...holds, [input.batch.id]: grant.grantId } } : {}),
                stays: { ...(stays as Record<string, unknown> | undefined), [input.stayId]: {
                  status: 'unknown', confirmationNumber: null, screenshotRef: null, cloudCreateGrantId: grant.grantId,
                  cloudCreateTarget: dispatchTarget } } };
              await lockedTx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
            }); } catch (error) { authorizationError = error; throw error; }
            }, epoch);
          } catch (error) { claimError = error; throw error; }
          try {
            beforeSha256 = recovery.beforeShot.sha256;
            if (Date.parse(recovery.preimage.expiresAt) <= Date.now()) throw new Error('cloud_create_preimage_expired');
            const live = createAdmission(paneStaySaveLoaders.mode?.() ?? paneStaySaveMode(), input.stay);
            if (live.reason || live.allowRealGuest !== admission.allowRealGuest || !paneCloudPreviewLoaders.authorityReady()) {
              throw new Error('cloud_create_dispatch_stale');
            }
            // Commit is the authority boundary. Source/access changes after this
            // point cannot change the captured, already-approved native request.
            return await next();
          } catch (error) {
            // The route permanently disarms before issuing this one-use proof.
            // It remains valid even when the initial callback drain has timed out.
            const proof = next.proveNeverDispatched?.();
            if (proof && dispatch.handle) {
              try {
                await resolveNeverDispatchedCreate(db, dispatch.handle, proof, request, async (tx, intent) => {
                  await recordNeverDispatchedCreate(tx, intent);
                });
                dispatch.handle = null;
              } catch { /* Ambiguous resolution remains held. */ }
            }
            throw error;
          }
        },
      });
      if (!dispatch.handle) return noClaimResult();
      const shots = beforeSha256 ? await saveScreenshots(native, input, beforeSha256) : null;
      const savedShot = shots?.shots.find((shot) => shot.name === 'saved.png');
      if (native.outcome !== 'saved' || native.writerSessionClosed !== true || native.save?.dispatchCallbacksDrained !== true ||
          typeof native.confirmation !== 'string' || !native.confirmation.trim() || !Array.isArray(native.readback?.fields) ||
          !Array.isArray(native.readback.mismatches) || native.readback.mismatches.length !== 0 || !shots || !savedShot) {
        return { ...refused(PANE_SAVE_UNCONFIRMED), ...shots };
      }
      const confirmationNumber = native.confirmation;
      await resolveHmsLabtestDispatch(db, dispatch.handle, { operation: 'create', confirmation: confirmationNumber,
        readbackDigest: hash(native.readback), savedShot: { runId: shots.runId, sha256: savedShot.sha256 } }, async (tx, intent) => {
        if (intent.workItemId !== input.workItemId || intent.transportId !== input.transportId ||
            intent.actorUserId !== input.actorUserId || intent.grantId !== grant.grantId || intent.stayId !== input.stayId ||
            intent.approvedDigest !== grant.requestDigest) throw new Error('cloud_create_result_scope_changed');
        await recordRecoveredCreate(tx, intent, { confirmation: confirmationNumber, readbackDigest: hash(native.readback),
          savedShot: { runId: shots.runId, sha256: savedShot.sha256 }, shots: shots.shots }, input.batch?.id, false);
      });
      return { status: 'ok', outcome: 'committed', confirmationNumber, clickedSave: true, ...shots };
    }, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
  } catch (error) {
    if (claimAttempted) return noClaimResult();
    if (error instanceof HmsLabtestDispatchError && error.reason === 'occupied') {
      return refused('cloud_create_recovery_required');
    }
    return refused(isPropertyReadLockDeadline(error) ? 'refused_lock_busy' : 'cloud_create_unavailable');
  }
}

/** Clear only the original unknown row, atomically with its no-dispatch event. */
async function recordNeverDispatchedCreate(tx: CreateFenceTransaction, intent: HmsLabtestIntent) {
  if (intent.operation !== 'create' || !intent.stayId) throw new Error('cloud_create_recovery_scope_changed');
  const [current] = await tx.select({ state: workItem.state }).from(workItem)
    .where(and(eq(workItem.id, intent.workItemId), eq(workItem.transportId, intent.transportId))).limit(1).for('update');
  const stays = current?.state.stays;
  if (!stays || typeof stays !== 'object' || Array.isArray(stays)) throw new Error('cloud_create_recovery_scope_changed');
  const stay = (stays as Record<string, unknown>)[intent.stayId] as Record<string, unknown> | undefined;
  if (!stay || stay.status !== 'unknown' || stay.cloudCreateGrantId !== intent.grantId ||
      stay.confirmationNumber !== null || stay.screenshotRef !== null) throw new Error('cloud_create_recovery_scope_changed');
  const remaining = { ...stays } as Record<string, unknown>;
  delete remaining[intent.stayId];
  const state: Record<string, unknown> = { ...current.state, stays: remaining };
  const holds = batchHolds(state);
  if (!holds) throw new Error('cloud_create_recovery_scope_changed');
  const heldBatches = Object.entries(holds).filter(([, grantId]) => grantId === intent.grantId);
  if (heldBatches.length > 1) throw new Error('cloud_create_recovery_scope_changed');
  if (heldBatches.length === 1) {
    delete holds[heldBatches[0]![0]];
    state[BATCH_HOLDS] = holds;
  }
  const rawBatch = state[BATCH];
  const batchId = rawBatch && typeof rawBatch === 'object' && !Array.isArray(rawBatch)
    ? (rawBatch as Record<string, unknown>).id : null;
  const batch = typeof batchId === 'string' ? storedBatch(state, batchId) : null;
  // If the first room provably never left the browser, no room in this batch
  // was saved. Discard its spent manifest so a fresh review can start again.
  // Keep partial batches when any earlier room has a durable outcome.
  if (batch?.rooms[0]?.stayId === intent.stayId && batch.rooms[0].grant.grantId === intent.grantId &&
      batch.rooms.every((room) => !Object.hasOwn(remaining, room.stayId))) delete state[BATCH];
  await tx.update(workItem).set({ state, updatedAt: new Date() })
    .where(eq(workItem.id, intent.workItemId));
}

const refs = z.object({ previewShot: grantSchema.shape.previewShot, beforeShot: grantSchema.shape.previewShot }).passthrough();

export type CreateRecoveryProof = { confirmation: string; readbackDigest: string;
  savedShot: { runId: string; sha256: string }; shots: HmsShotMeta[] };

/** Serialize recovery with writes for the same Cloud create target. */
export async function withRecoveryLock<T>(intent: HmsLabtestIntent, action: () => Promise<T>): Promise<T> {
  const target = paneStayCreateTarget({ transportId: intent.transportId, propertyCode: 'HRCEN' });
  const dispatchTarget = hmsLabtestIntentTarget(intent);
  if (!target.ok || target.target.propertyCode !== 'HRCEN' || target.target.browserSlot !== 'centurion' ||
      !dispatchTarget || dispatchTarget.kind !== 'create') {
    throw new Error('cloud_create_recovery_property_unavailable');
  }
  const lock = paneStaySaveLoaders.lock ?? paneStayCloudTargetLock(target.target, dispatchTarget, { kind: 'independent_cloud' });
  if (!lock) throw new Error('cloud_create_recovery_lock_unavailable');
  return lock.withLock(action, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
}

/** This uses the fixed read-only HMS reader, never caller-provided proof. */
export async function proveCreateRecovery(intent: HmsLabtestIntent): Promise<CreateRecoveryProof> {
  const parsed = refs.safeParse(intent.recovery);
  if (!parsed.success) throw new Error('cloud_create_recovery_evidence_unavailable');
  const owner = `${intent.actorUserId}:${intent.transportId}`;
  for (const [name, ref] of [['filled.png', parsed.data.previewShot], ['before.png', parsed.data.beforeShot]] as const) {
    if (!await verifyStoredHmsShot({ ...ref, name, owner, propertyCode: 'HRCEN', workItemId: intent.workItemId }, name)) {
      throw new Error('cloud_create_recovery_evidence_unavailable');
    }
  }
  const reader = await import(new URL('../../tooling/hms-cloud/create-positive-recovery.mjs', import.meta.url).href) as {
    provePositiveCreateRecovery: (intent: HmsLabtestIntent) => Promise<{
      outcome: string; confirmation?: unknown; readback?: unknown; screenshot?: unknown;
    }>;
  };
  const observed = await reader.provePositiveCreateRecovery(intent);
  if (observed.outcome !== 'verified' || typeof observed.confirmation !== 'string' ||
      !/^\d{6,10}-\d{1,2}$/.test(observed.confirmation) || !observed.readback ||
      !Buffer.isBuffer(observed.screenshot) || observed.screenshot.length > 20 * 1024 * 1024) {
    throw new Error('cloud_create_recovery_readback_unavailable');
  }
  const runId = randomUUID(), dir = await mkdtemp(join(tmpdir(), 'hms-create-recovery-'));
  try {
    await writeFile(join(dir, 'saved.png'), observed.screenshot, { flag: 'wx', mode: 0o600 });
    const shots = await persistHmsShots({ propertyCode: 'HRCEN', workItemId: intent.workItemId,
      runId, sourceDir: dir, owner, now: Date.now() });
    const saved = shots?.find((item) => item.name === 'saved.png');
    if (!shots || !saved || !await verifyStoredHmsShot({ runId, name: 'saved.png', sha256: saved.sha256,
      owner, propertyCode: 'HRCEN', workItemId: intent.workItemId }, 'saved.png')) {
      throw new Error('cloud_create_recovery_evidence_unavailable');
    }
    return { confirmation: observed.confirmation, readbackDigest: hash(observed.readback),
      savedShot: { runId, sha256: saved.sha256 }, shots };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Update only the original unknown stay and retain durable proof on the same transaction. */
export async function recordRecoveredCreate(tx: CreateFenceTransaction, intent: HmsLabtestIntent, proof: CreateRecoveryProof,
  completedBatchId?: string, operatorRecovery = true) {
  if (intent.operation !== 'create' || !intent.stayId) throw new Error('cloud_create_recovery_scope_changed');
  const [current] = await tx.select({ state: workItem.state }).from(workItem)
    .where(and(eq(workItem.id, intent.workItemId), eq(workItem.transportId, intent.transportId))).limit(1).for('update');
  if (!current) throw new Error('cloud_create_recovery_scope_changed');
  const stays = current.state.stays;
  if (!stays || typeof stays !== 'object' || Array.isArray(stays)) throw new Error('cloud_create_recovery_scope_changed');
  const stay = (stays as Record<string, unknown>)[intent.stayId] as Record<string, unknown> | undefined;
  if (!stay || stay.status !== 'unknown' || stay.cloudCreateGrantId !== intent.grantId) {
    throw new Error('cloud_create_recovery_scope_changed');
  }
  const recoveredTarget = hmsLabtestIntentTarget(intent);
  const storedTarget = hmsDispatchTargetSchema.safeParse(stay.cloudCreateTarget);
  if (!recoveredTarget || recoveredTarget.kind !== 'create' ||
      (stay.cloudCreateTarget !== undefined && (!storedTarget.success ||
        hmsDispatchTargetKey(storedTarget.data) !== hmsDispatchTargetKey(recoveredTarget)))) {
    throw new Error('cloud_create_recovery_scope_changed');
  }
  let legacyHolds: Record<string, string> | undefined;
  if (operatorRecovery && current.state[BATCH_HOLDS] === undefined && current.state[BATCH] !== undefined) {
    const raw = current.state[BATCH];
    const id = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).id : null;
    const batch = typeof id === 'string' ? storedBatch(current.state, id) : null;
    if (!batch) throw new Error('cloud_create_recovery_scope_changed');
    const members = batch.rooms.filter((room) => room.grant.grantId === intent.grantId);
    if (members.length > 1 || (members.length === 1 && (members[0]!.stayId !== intent.stayId ||
        members[0]!.grant.requestDigest !== intent.approvedDigest || members[0]!.grant.nativeGuestId !== intent.nativeGuestId))) {
      throw new Error('cloud_create_recovery_scope_changed');
    }
    if (members.length === 1) legacyHolds = { [batch.id]: intent.grantId };
  }
  let releasedHolds: Record<string, string> | undefined;
  if (completedBatchId) {
    const holds = batchHolds(current.state);
    if (!holds || holds[completedBatchId] !== intent.grantId) throw new Error('cloud_create_recovery_scope_changed');
    releasedHolds = { ...holds };
    delete releasedHolds[completedBatchId];
  }
  const recoveredBatches = Object.entries(legacyHolds ?? batchHolds(current.state) ?? {})
    .filter(([, grantId]) => grantId === intent.grantId).map(([id]) => id);
  if (operatorRecovery && recoveredBatches.length > 1) throw new Error('cloud_create_recovery_scope_changed');
  const state = { ...current.state, ...(legacyHolds ? { [BATCH_HOLDS]: legacyHolds } : {}),
    ...(releasedHolds ? { [BATCH_HOLDS]: releasedHolds } : {}),
    stays: { ...stays, [intent.stayId]: { status: 'booked',
    confirmationNumber: proof.confirmation, screenshotRef: { runId: proof.savedShot.runId, name: 'saved.png' },
    runId: proof.savedShot.runId, shots: proof.shots, cloudCreateVerified: true,
    cloudCreateTarget: recoveredTarget, cloudCreateGrantId: intent.grantId,
    ...(operatorRecovery ? { cloudCreateRecovered: true, cloudCreateRecoveredBatchId: recoveredBatches[0] ?? null } : {}) } } };
  await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, intent.workItemId));
}
