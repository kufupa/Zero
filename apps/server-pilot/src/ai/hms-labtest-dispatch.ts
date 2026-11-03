import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { consumeNeverDispatchedCreateProof } from '../../tooling/hms-cloud/saved-stay-save-route-chain.mjs';
import type { DB } from '../db/client.js';
import { workEvent } from '../db/schema/work.js';
import { canonicalJson } from './draft-approval.js';
import type { CreateFenceTransaction } from './pane-create-dispatch-fence.js';
import { hmsDispatchTargetKey, hmsDispatchTargetSchema, hmsDispatchWorkItemKey,
  type HmsDispatchTarget } from './hms-dispatch-target.js';

// All Cloud writers must join this protocol before any is enabled.
const FIELD = 'nava.hms.labtest.dispatch.v1';
const identifier = z.string().min(1).max(256).refine((s) => s === s.trim() &&
  ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const operation = z.enum(['create', 'attach_document', 'amend', 'cancel']);
const shot = z.object({ runId: z.string().uuid(), sha256: digest }).strict();
const claimSchema = z.object({
  workItemId: uuid, transportId: identifier, actorUserId: identifier, grantId: uuid,
  propertyCode: z.literal('HRCEN'), firstName: z.string().trim().min(1).max(256), lastName: z.string().trim().min(1).max(256),
  nativeGuestId: z.string().regex(/^[0-9]{1,30}$/), operation,
  stayId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  sourceDigest: digest, approvedDigest: digest, requestDigest: digest,
  recovery: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0),
  // Optional in the stored schema for append-only legacy rows. New claims require it.
  target: hmsDispatchTargetSchema.optional(),
}).strict();
const intentSchema = claimSchema.extend({ version: z.literal(1), kind: z.literal('intent'),
  holdId: uuid, ownerDigest: digest }).strict();
const resolutionSchema = z.object({ version: z.literal(1), kind: z.literal('resolved'),
  holdId: uuid, operation, confirmation: z.string().max(40).regex(/^\d+-\d+$/),
  readbackDigest: digest, savedShot: shot, recovered: z.literal(true).optional() }).strict();
const noDispatchSchema = z.object({ version: z.literal(1), kind: z.literal('not_dispatched'),
  holdId: uuid, operation: z.enum(['create', 'attach_document']) }).strict();
const eventSchema = z.discriminatedUnion('kind', [intentSchema, resolutionSchema, noDispatchSchema]);
type Claim = z.infer<typeof claimSchema>;
type Intent = z.infer<typeof intentSchema>;
export type HmsLabtestIntent = Intent;
type Resolution = Omit<z.infer<typeof resolutionSchema>, 'version' | 'kind' | 'holdId'>;
export type HmsLabtestWriteHandle = { holdId: string; ownerToken: string };

export class HmsLabtestDispatchError extends Error {
  constructor(readonly reason: 'invalid' | 'occupied' | 'corrupt' | 'owner' | 'phase') {
    super(`hms_labtest_dispatch_${reason}`);
    this.name = 'HmsLabtestDispatchError';
  }
}

const ownerHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Bind the exact intercepted native request, including its body and destination. */
export function nativeCreateSaveDigest(raw: unknown): string {
  if (!raw || typeof raw !== 'object') throw new Error('cloud_create_request_unavailable');
  const request = raw as { method?: () => string; url?: () => string; headers?: () => Record<string, string>;
    postDataBuffer?: () => Buffer | null };
  if (request.method?.() !== 'POST' || typeof request.url !== 'function' || typeof request.headers !== 'function' ||
      typeof request.postDataBuffer !== 'function') throw new Error('cloud_create_request_unavailable');
  const url = new URL(request.url()), contentType = request.headers()['content-type'] ?? '';
  const bytes = request.postDataBuffer();
  if (url.origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com' || url.pathname !== '/web/base/OSRESV.HDR' ||
      url.hash || [...url.searchParams].length !== 1 || url.searchParams.get('pageaction') !== 'SAVE' ||
      !/^application\/x-www-form-urlencoded(?:;|$)/i.test(contentType) || !Buffer.isBuffer(bytes) ||
      bytes.length === 0 || bytes.length > 1024 * 1024) throw new Error('cloud_create_request_unavailable');
  return createHash('sha256').update(JSON.stringify(['POST', url.href, contentType])).update('\0').update(bytes).digest('hex');
}

async function lockTarget(tx: CreateFenceTransaction, key: string) {
  // All participants acquire this before mailbox, source, item or lease locks.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('nava-hms-target-write-v1'), hashtext(${key}))`);
}

async function lockGrant(tx: CreateFenceTransaction, grantId: string) {
  // Different targets can share a malicious/replayed grant, so target locks alone are insufficient.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('nava-hms-write-grant-v1'), hashtext(${grantId}))`);
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Derive legacy identities from sealed data. Never fall back to work item when a booking identity exists. */
function evidenceTargets(raw: unknown): HmsDispatchTarget[] {
  const value = object(raw), recovery = object(value.recovery), request = object(recovery.request);
  const preimage = object(recovery.preimage), native = object(preimage.native), guest = object(request.guest);
  const results: HmsDispatchTarget[] = [];
  const add = (candidate: unknown) => {
    const parsed = hmsDispatchTargetSchema.safeParse(candidate);
    if (parsed.success && !results.some((entry) => hmsDispatchTargetKey(entry) === hmsDispatchTargetKey(parsed.data))) {
      results.push(parsed.data);
    }
  };
  if (value.operation === 'create') {
    const names = [[value.firstName, value.lastName], [guest.firstName, guest.lastName]];
    const arrivals = [object(request.stay).arrival, preimage.arrival, recovery.arrival];
    for (const [firstName, lastName] of names) for (const arrival of arrivals) {
      add({ propertyCode: value.propertyCode, kind: 'create', firstName, lastName, arrival });
    }
  } else {
    const selected = object(recovery.selected);
    const confirmations = [recovery.confirmation, request.confirmation, selected.confirmation, native.confirmation];
    for (const confirmation of confirmations) add({ propertyCode: value.propertyCode, kind: 'saved', confirmation });
    // A native ID is a fallback only when no confirmation is present in the evidence.
    if (!results.length && !confirmations.some((entry) => typeof entry === 'string' && entry.trim())) {
      for (const nativeStayId of [recovery.reservationStayId, recovery.nativeStayId, native.reservationStayId]) {
        add({ propertyCode: value.propertyCode, kind: 'saved', nativeStayId });
      }
    }
  }
  return results;
}

/** The operation-specific recovery wrappers use the same target as the original writer. */
export function hmsLabtestIntentTarget(intent: HmsLabtestIntent): HmsDispatchTarget | null {
  const explicit = hmsDispatchTargetSchema.safeParse(intent.target);
  if (explicit.success) return explicit.data;
  const derived = evidenceTargets(intent);
  return derived.length === 1 ? derived[0]! : null;
}

function confirmationMatchesIntent(intent: Intent, confirmation: string): boolean {
  const target = hmsLabtestIntentTarget(intent);
  if (target?.kind !== 'saved' || !target.confirmation) return true;
  const reported = hmsDispatchTargetSchema.safeParse({ propertyCode: 'HRCEN', kind: 'saved', confirmation });
  return reported.success && hmsDispatchTargetKey(target) === hmsDispatchTargetKey(reported.data);
}

type HistoryEntry = { intent: Intent; key: string };

async function readHistory(tx: CreateFenceTransaction) {
  const rows = await tx.select({ id: workEvent.id, itemId: workEvent.workItemId, type: workEvent.type,
    actorKind: workEvent.actorKind, value: workEvent.value }).from(workEvent).where(eq(workEvent.fieldPath, FIELD));
  const intents = new Map<string, HistoryEntry>(), resolved = new Set<string>(), grants = new Set<string>();
  const corruptTargets = new Set<string>(), corruptItems = new Set<string>();
  const grantOwners = new Map<string, HistoryEntry>();
  const completions: Array<{ itemId: string; value: z.infer<typeof resolutionSchema> | z.infer<typeof noDispatchSchema> }> = [];
  const markCorrupt = (itemId: string, keys: string[]) => {
    corruptItems.add(itemId.toLowerCase());
    for (const key of keys) corruptTargets.add(key);
  };
  for (const row of rows) {
    const raw = object(row.value);
    // Retain global replay protection even if the older intent itself is malformed.
    if (typeof raw.grantId === 'string') grants.add(raw.grantId.toLowerCase());
    const explicit = hmsDispatchTargetSchema.safeParse(raw.target);
    const derived = evidenceTargets(raw);
    const keys = [...new Set([...(explicit.success ? [hmsDispatchTargetKey(explicit.data)] : []),
      ...derived.map(hmsDispatchTargetKey)])];
    const event = eventSchema.safeParse(row.value);
    if (!event.success || row.type !== 'write.evidence' || row.actorKind !== 'system') {
      markCorrupt(row.itemId, keys);
      continue;
    }
    const value = event.data;
    if (value.kind !== 'intent') {
      completions.push({ itemId: row.itemId, value });
    } else {
      const key = keys[0] ?? hmsDispatchWorkItemKey(row.itemId);
      const existing = intents.get(value.holdId), grantOwner = grantOwners.get(value.grantId);
      if (row.id.toLowerCase() !== value.holdId || row.itemId.toLowerCase() !== value.workItemId ||
          (value.operation === 'create') !== Boolean(value.stayId) ||
          keys.length > 1 || existing || grantOwner ||
          (value.target && (!derived.length || hmsDispatchTargetKey(value.target) !== hmsDispatchTargetKey(derived[0]!)))) {
        markCorrupt(row.itemId, [...keys, ...(existing ? [existing.key] : []), ...(grantOwner ? [grantOwner.key] : [])]);
        if (existing) corruptItems.add(existing.intent.workItemId);
        if (grantOwner) corruptItems.add(grantOwner.intent.workItemId);
        continue;
      }
      const entry = { intent: value, key };
      intents.set(value.holdId, entry);
      grantOwners.set(value.grantId, entry);
    }
  }
  for (const { itemId, value } of completions) {
    const entry = intents.get(value.holdId), intent = entry?.intent;
    if (!intent || intent.workItemId !== itemId.toLowerCase() || intent.operation !== value.operation || resolved.has(value.holdId) ||
        (value.kind === 'resolved' && ((intent.operation === 'create' && !/^\d{6,10}-\d{1,2}$/.test(value.confirmation)) ||
          !confirmationMatchesIntent(intent, value.confirmation)))) {
      markCorrupt(itemId, entry ? [entry.key] : [...intents.values()].filter((item) => item.intent.workItemId === itemId.toLowerCase()).map((item) => item.key));
      if (intent) corruptItems.add(intent.workItemId);
      continue;
    }
    resolved.add(value.holdId);
  }
  const active = [...intents.values()].filter(({ intent }) => !resolved.has(intent.holdId));
  for (const entry of active) {
    if (active.filter((other) => other.key === entry.key).length > 1) {
      markCorrupt(entry.intent.workItemId, [entry.key]);
    }
  }
  // A malformed orphan/completion inherits the known targets of its own work item.
  for (const entry of intents.values()) {
    if (corruptItems.has(entry.intent.workItemId)) corruptTargets.add(entry.key);
  }
  const completed = completions.flatMap(({ itemId, value }) => {
    const entry = intents.get(value.holdId);
    return entry && resolved.has(value.holdId) && itemId.toLowerCase() === entry.intent.workItemId
      ? [{ ...entry, resolution: value }] : [];
  });
  return { intents, active, grants, completed, corruptTargets, corruptItems };
}

/** Read only validated intent/resolution pairs for this work item. */
export async function readResolvedHmsLabtestCreates(tx: CreateFenceTransaction, workItemId: string) {
  const history = await readHistory(tx);
  if (history.corruptItems.has(workItemId.toLowerCase())) throw new HmsLabtestDispatchError('corrupt');
  return history.completed.flatMap(({ intent, resolution }) =>
    intent.operation === 'create' && intent.workItemId === workItemId.toLowerCase() && resolution.kind === 'resolved'
      ? [{ intent, resolution }]
      : []);
}

const historyEpoch = (history: Awaited<ReturnType<typeof readHistory>>, key: string) =>
  createHash('sha256').update([...history.intents.values()].filter((entry) => entry.key === key)
    .map(({ intent }) => intent.holdId).sort().join('\0')).digest('hex');

function assertTargetHistory(history: Awaited<ReturnType<typeof readHistory>>, key: string, workItemId?: string) {
  if (history.corruptTargets.has(key) || (workItemId && history.corruptItems.has(workItemId.toLowerCase()))) {
    throw new HmsLabtestDispatchError('corrupt');
  }
  if (history.active.some((entry) => entry.key === key ||
      (workItemId && entry.key === hmsDispatchWorkItemKey(workItemId)))) {
    throw new HmsLabtestDispatchError('occupied');
  }
}

/** Snapshot the append-only writer history before reading an HMS preimage. */
export async function captureHmsLabtestDispatchEpoch(db: DB, target?: HmsDispatchTarget, workItemId?: string): Promise<string> {
  const parsed = hmsDispatchTargetSchema.safeParse(target);
  if (!parsed.success || (workItemId !== undefined && !z.string().uuid().safeParse(workItemId).success)) {
    throw new HmsLabtestDispatchError('invalid');
  }
  const key = hmsDispatchTargetKey(parsed.data);
  return db.transaction(async (tx) => {
    await lockTarget(tx, key);
    const history = await readHistory(tx);
    assertTargetHistory(history, key, workItemId);
    return historyEpoch(history, key);
  }, { isolationLevel: 'read committed' });
}

/**
 * Atomic one-shot claim for the selected target. The caller must
 * independently verify the native profile and validate operation-specific
 * recovery data. In `authorize`, lock and recheck the staff/session, access,
 * source, reviewed form, grant, lease and intercepted request, and consume Go
 * or claim an earlier consumed Go. Never do network I/O or nest a transaction.
 *
 * Only a confirmed transaction commit permits native continuation. A lost or
 * ambiguous commit is never dispatched. Old writers and direct SQL cannot be
 * constrained by this helper and must be held during the pilot cutover.
 */
export async function claimHmsLabtestDispatch(
  db: DB, raw: Claim, authorize: (tx: CreateFenceTransaction, input: Readonly<Claim>) => Promise<void>,
  expectedEpoch: string,
): Promise<HmsLabtestWriteHandle> {
  const parsed = claimSchema.safeParse(raw);
  if (!parsed.success || typeof authorize !== 'function' || !digest.safeParse(expectedEpoch).success ||
      (parsed.data.operation === 'create') !== Boolean(parsed.data.stayId) || !parsed.data.target ||
      (parsed.data.operation === 'create') !== (parsed.data.target.kind === 'create')) throw new HmsLabtestDispatchError('invalid');
  const key = hmsDispatchTargetKey(parsed.data.target), derived = evidenceTargets(parsed.data);
  if (!derived.length || derived.some((target) => hmsDispatchTargetKey(target) !== key)) {
    throw new HmsLabtestDispatchError('invalid');
  }
  const input = Object.freeze(parsed.data);
  let encoded: string;
  try { encoded = canonicalJson(input); } catch { throw new HmsLabtestDispatchError('invalid'); }
  if (Buffer.byteLength(encoded) > 16_384) throw new HmsLabtestDispatchError('invalid');
  const holdId = randomUUID(), ownerToken = randomBytes(32).toString('hex');
  // Clone nested evidence: retaining the authorization callback's object must
  // not permit changing the value that was authorized and will be persisted.
  const intent: Intent = { ...(JSON.parse(encoded) as Claim), version: 1, kind: 'intent', holdId, ownerDigest: ownerHash(ownerToken) };
  await db.transaction(async (tx) => {
    await lockTarget(tx, key);
    await lockGrant(tx, input.grantId);
    const history = await readHistory(tx);
    assertTargetHistory(history, key, input.workItemId);
    if (historyEpoch(history, key) !== expectedEpoch || history.grants.has(input.grantId)) {
      throw new HmsLabtestDispatchError('occupied');
    }
    await authorize(tx, input);
    if (canonicalJson(input) !== encoded) throw new HmsLabtestDispatchError('invalid');
    await tx.insert(workEvent).values({ id: holdId, workItemId: input.workItemId, actorKind: 'system',
      type: 'write.evidence', fieldPath: FIELD, value: intent });
  }, { isolationLevel: 'read committed' });
  return { holdId, ownerToken };
}

async function finishDispatch(db: DB, holdId: string, evidence: Resolution | { operation: 'create' | 'attach_document'; notDispatched: true },
  authorize: (intent: Intent) => void, record: (tx: CreateFenceTransaction, intent: Intent) => Promise<void>) {
  await db.transaction(async (tx) => {
    const first = (await readHistory(tx)).intents.get(holdId);
    if (!first) throw new HmsLabtestDispatchError('owner');
    await lockTarget(tx, first.key);
    const history = await readHistory(tx), entry = history.active.find((item) => item.intent.holdId === holdId);
    if (!entry || entry.key !== first.key) throw new HmsLabtestDispatchError('owner');
    const intent = entry.intent;
    if (history.corruptTargets.has(entry.key) || history.corruptItems.has(intent.workItemId)) {
      throw new HmsLabtestDispatchError('corrupt');
    }
    authorize(intent);
    if (intent.operation !== evidence.operation) throw new HmsLabtestDispatchError('phase');
    if (!('notDispatched' in evidence) && !confirmationMatchesIntent(intent, evidence.confirmation)) {
      throw new HmsLabtestDispatchError('phase');
    }
    const immutableIntent = canonicalJson(intent);
    await record(tx, intent);
    if (canonicalJson(intent) !== immutableIntent) throw new HmsLabtestDispatchError('invalid');
    const value = 'notDispatched' in evidence
      ? { version: 1, kind: 'not_dispatched', holdId: intent.holdId, operation: evidence.operation }
      : { version: 1, kind: 'resolved', holdId: intent.holdId, ...evidence };
    await tx.insert(workEvent).values({ workItemId: intent.workItemId, actorKind: 'system', type: 'write.evidence',
      fieldPath: FIELD, value });
  }, { isolationLevel: 'read committed' });
}

/** A route-owned, one-use proof can release only the exact Save it never continued. */
export async function resolveNeverDispatchedCreate(db: DB, handle: HmsLabtestWriteHandle, proof: unknown,
  request: unknown, record: (tx: CreateFenceTransaction, intent: Readonly<Intent>) => Promise<void>): Promise<void> {
  const requestDigest = nativeCreateSaveDigest(request);
  if (!z.string().uuid().safeParse(handle?.holdId).success || !digest.safeParse(handle?.ownerToken).success ||
      !digest.safeParse(requestDigest).success || typeof record !== 'function' ||
      !consumeNeverDispatchedCreateProof(proof, request)) throw new HmsLabtestDispatchError('invalid');
  await finishDispatch(db, handle.holdId, { operation: 'create', notDispatched: true }, (intent) => {
    if (intent.requestDigest !== requestDigest ||
        !timingSafeEqual(Buffer.from(intent.ownerDigest, 'hex'), Buffer.from(ownerHash(handle.ownerToken), 'hex'))) {
      throw new HmsLabtestDispatchError('owner');
    }
  }, record);
}

/** Only the upload gate can prove that its exact multipart request was never continued. */
export async function resolveNeverDispatchedAttach(db: DB, handle: HmsLabtestWriteHandle, proof: unknown,
  request: unknown, record: (tx: CreateFenceTransaction, intent: Readonly<Intent>) => Promise<void>): Promise<void> {
  const { consumeNeverDispatchedAttachProof, documentUploadRequestDigest } =
    await import('../../tooling/hms-cloud/stay360-document-attach.mjs' as string) as {
      consumeNeverDispatchedAttachProof(proof: unknown, request: unknown): boolean;
      documentUploadRequestDigest(request: unknown): string | null;
    };
  const requestDigest = documentUploadRequestDigest(request);
  if (!z.string().uuid().safeParse(handle?.holdId).success || !digest.safeParse(handle?.ownerToken).success ||
      !digest.safeParse(requestDigest).success || typeof record !== 'function' ||
      !consumeNeverDispatchedAttachProof(proof, request)) throw new HmsLabtestDispatchError('invalid');
  await finishDispatch(db, handle.holdId, { operation: 'attach_document', notDispatched: true }, (intent) => {
    if (intent.requestDigest !== requestDigest ||
        !timingSafeEqual(Buffer.from(intent.ownerDigest, 'hex'), Buffer.from(ownerHash(handle.ownerToken), 'hex'))) {
      throw new HmsLabtestDispatchError('owner');
    }
  }, record);
}

/**
 * Record the verified staff result and release its hold atomically. The caller
 * must first prove callback drain, owned-browser shutdown, screenshots and the
 * operation's independent positive readback. No timeout or negative-read clear
 * exists; all intents stay in history to reject reuse of a consumed Go.
 */
export async function resolveHmsLabtestDispatch(db: DB, handle: HmsLabtestWriteHandle, raw: Resolution,
  record: (tx: CreateFenceTransaction, intent: Readonly<Intent>) => Promise<void>): Promise<void> {
  const parsed = resolutionSchema.omit({ version: true, kind: true, holdId: true }).safeParse(raw);
  if (!parsed.success || typeof record !== 'function' || !z.string().uuid().safeParse(handle?.holdId).success ||
      !digest.safeParse(handle?.ownerToken).success ||
      (parsed.data.operation === 'create' && !/^\d{6,10}-\d{1,2}$/.test(parsed.data.confirmation))) {
    throw new HmsLabtestDispatchError('invalid');
  }
  const evidence = JSON.parse(canonicalJson(parsed.data)) as Resolution;
  await finishDispatch(db, handle.holdId, evidence, (intent) => {
    if (!timingSafeEqual(Buffer.from(intent.ownerDigest, 'hex'), Buffer.from(ownerHash(handle.ownerToken), 'hex'))) {
      throw new HmsLabtestDispatchError('owner');
    }
  }, record);
}

// Only operation-specific wrappers below can choose a driver. Neither this
// function nor its trusted reader accepts evidence or callbacks from clients.
async function recoverPositiveDispatch<P extends { confirmation: string; readbackDigest: string;
  savedShot: { runId: string; sha256: string } }>(db: DB, holdId: string, kind: z.infer<typeof operation>, driver: {
    withLock: <T>(intent: Intent, action: () => Promise<T>) => Promise<T>;
    prove: (intent: Intent) => Promise<P>;
    record: (tx: CreateFenceTransaction, intent: Intent, proof: P) => Promise<void>;
  }): Promise<void> {
  if (!z.string().uuid().safeParse(holdId).success) throw new HmsLabtestDispatchError('invalid');
  const original = await db.transaction(async (tx) => {
    const first = (await readHistory(tx)).intents.get(holdId);
    if (!first) throw new HmsLabtestDispatchError('phase');
    await lockTarget(tx, first.key);
    const history = await readHistory(tx), entry = history.active.find((item) => item.intent.holdId === holdId);
    if (!entry || entry.key !== first.key || entry.intent.operation !== kind ||
        history.corruptTargets.has(entry.key) || history.corruptItems.has(entry.intent.workItemId)) {
      throw new HmsLabtestDispatchError('phase');
    }
    const intent = entry.intent;
    return intent;
  }, { isolationLevel: 'read committed' });
  await driver.withLock(original, async () => {
    const proof = await driver.prove(original);
    const result = resolutionSchema.omit({ version: true, kind: true, holdId: true }).safeParse({ operation: kind,
      confirmation: proof.confirmation, readbackDigest: proof.readbackDigest, savedShot: proof.savedShot, recovered: true });
    if (!result.success || (kind === 'create' && !/^\d{6,10}-\d{1,2}$/.test(proof.confirmation))) {
      throw new HmsLabtestDispatchError('invalid');
    }
    await finishDispatch(db, holdId, result.data, (intent) => {
      if (canonicalJson(intent) !== canonicalJson(original)) {
        throw new HmsLabtestDispatchError('phase');
      }
    }, (tx, intent) => driver.record(tx, intent, proof));
  });
}

/** Operator-only positive Create reconciliation; no negative read or client evidence can clear a hold. */
export async function recoverHmsLabtestCreate(db: DB, holdId: string): Promise<void> {
  const driver = await import('./pane-cloud-preview.js');
  await recoverPositiveDispatch(db, holdId, 'create', {
    withLock: driver.withRecoveryLock, prove: driver.proveCreateRecovery, record: driver.recordRecoveredCreate,
  });
}

/** Operator-only positive Filing reconciliation; no client supplies proof or a driver. */
export async function recoverHmsLabtestAttach(db: DB, holdId: string): Promise<void> {
  const driver = await import('./pane-cloud-attach-recovery.js');
  await recoverPositiveDispatch(db, holdId, 'attach_document', {
    withLock: driver.withAttachRecoveryLock,
    prove: (intent) => driver.proveAttachRecovery(db, intent),
    record: driver.recordRecoveredAttach,
  });
}
