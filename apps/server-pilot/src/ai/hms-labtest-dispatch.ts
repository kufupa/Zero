import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { propertyCodeSchema } from '../hms/property-registry.js';
import { getPropertyRegistration } from '../../tooling/hms-cloud/property-registry.mjs';
import { consumeNeverDispatchedCreateProof } from '../../tooling/hms-cloud/saved-stay-save-route-chain.mjs';
import type { DB } from '../db/client.js';
import { workEvent } from '../db/schema/work.js';
import { canonicalJson } from './draft-approval.js';
import type { CreateFenceTransaction } from './pane-create-dispatch-fence.js';
import { hmsDispatchTargetKey, hmsDispatchTargetKeys, hmsDispatchTargetSchema, hmsDispatchWorkItemKey,
  type HmsDispatchTarget } from './hms-dispatch-target.js';

// All Cloud writers must join this protocol before any is enabled.
const FIELD = 'nava.hms.labtest.dispatch.v1';
const identifier = z.string().min(1).max(256).refine((s) => s === s.trim() &&
  ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const operation = z.enum(['create', 'attach_document', 'amend', 'cancel', 'add_on']);
const shot = z.object({ runId: z.string().uuid(), sha256: digest }).strict();
const claimSchema = z.object({
  workItemId: uuid, transportId: identifier, actorUserId: identifier, grantId: uuid,
  propertyCode: propertyCodeSchema, tenantId: identifier.optional(),
  firstName: z.string().trim().min(1).max(256), lastName: z.string().trim().min(1).max(256),
  nativeGuestId: z.string().regex(/^[0-9]{1,30}$/), operation,
  stayId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/).optional(),
  sourceDigest: digest, approvedDigest: digest, requestDigest: digest,
  recovery: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0),
  // Optional in the stored schema for append-only legacy rows. New claims require it.
  target: hmsDispatchTargetSchema.optional(),
}).strict();
const intentSchema = claimSchema.extend({ version: z.literal(1), kind: z.literal('intent'),
  holdId: uuid, ownerDigest: digest }).strict();
const resolutionSchema = z.object({ version: z.literal(1), kind: z.literal('resolved'),
  holdId: uuid, operation, confirmation: z.string().max(40).regex(/^\d+-\d+$/),
  nativeStayId: z.string().trim().regex(/^\d{1,100}$/).optional(),
  nativeReadback: z.record(z.string(), z.unknown()).optional(),
  readbackDigest: digest, savedShot: shot.optional(), recovered: z.literal(true).optional() }).strict();
const noDispatchSchema = z.object({ version: z.literal(1), kind: z.literal('not_dispatched'),
  holdId: uuid, operation: z.enum(['create', 'attach_document', 'cancel']) }).strict();
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

function targetLockId(key: string): bigint {
  return createHash('sha256').update('nava-hms-target-write-v2\0').update(key).digest().readBigInt64BE(0);
}

async function lockTarget(tx: CreateFenceTransaction, id: bigint) {
  // All participants acquire this before mailbox, source, item or lease locks.
  // The bigint and two-integer PostgreSQL advisory-lock keyspaces are distinct.
  await tx.execute(sql`select pg_advisory_xact_lock(${id.toString()}::bigint)`);
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
    if (parsed.success && !results.some((entry) => JSON.stringify(hmsDispatchTargetKeys(entry)) === JSON.stringify(hmsDispatchTargetKeys(parsed.data)))) {
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
    for (const nativeStayId of [recovery.reservationStayId, recovery.nativeStayId, request.reservationStayId,
      request.nativeStayId, selected.reservationStayId, selected.nativeStayId, preimage.reservationStayId,
      native.reservationStayId, native.nativeStayId]) {
      add({ propertyCode: value.propertyCode, kind: 'saved', nativeStayId });
    }
  }
  return results;
}

/** Only identities bound together in one sealed intent may become aliases. */
function intentAliases(raw: unknown) {
  const value = object(raw), scope = propertyCodeSchema.safeParse(object(raw).propertyCode);
  if (!scope.success) return { keys: [] as string[], conflict: true, target: null, derivedKeys: new Set<string>() };
  const registration = getPropertyRegistration(scope.data);
  if (!registration) return { keys: [] as string[], conflict: true, target: null, derivedKeys: new Set<string>() };
  const tenantMismatch = value.tenantId !== undefined && value.tenantId !== registration.expectedTenant;
  const explicit = hmsDispatchTargetSchema.safeParse(value.target), derived = evidenceTargets(raw);
  const candidates = [...(explicit.success ? [explicit.data] : []), ...derived];
  const allKeys = [...new Set(candidates.flatMap(hmsDispatchTargetKeys))];
  const expectedKind = value.operation === 'create' ? 'create' : 'saved';
  const wrongKind = candidates.some((candidate) => candidate.kind !== expectedKind);
  const create = candidates.find((candidate) => candidate.kind === 'create');
  const saved = candidates.filter((candidate) => candidate.kind === 'saved');
  const confirmations = saved.filter((candidate) => candidate.confirmation).map((candidate) =>
    hmsDispatchTargetKey({ propertyCode: candidate.propertyCode, kind: 'saved', confirmation: candidate.confirmation }));
  const nativeIds = saved.filter((candidate) => candidate.nativeStayId).map((candidate) =>
    hmsDispatchTargetKey({ propertyCode: candidate.propertyCode, kind: 'saved', nativeStayId: candidate.nativeStayId }));
  const recovery = object(value.recovery), request = object(recovery.request), selected = object(recovery.selected);
  const preimage = object(recovery.preimage), native = object(preimage.native);
  const invalidIdentity = value.operation !== 'create' && [
    ...[recovery.confirmation, request.confirmation, selected.confirmation, native.confirmation]
      .map((confirmation) => ({ confirmation })),
    ...[recovery.reservationStayId, recovery.nativeStayId, request.reservationStayId, request.nativeStayId,
      selected.reservationStayId, selected.nativeStayId, preimage.reservationStayId, native.reservationStayId, native.nativeStayId]
      .map((nativeStayId) => ({ nativeStayId })),
  ].some((identity) => Object.values(identity).some((part) => part !== undefined && part !== null && part !== '') &&
    !hmsDispatchTargetSchema.safeParse({ propertyCode: scope.data, kind: 'saved', ...identity }).success);
  const derivedKeys = new Set(derived.flatMap(hmsDispatchTargetKeys));
  const explicitUnverified = explicit.success && hmsDispatchTargetKeys(explicit.data).some((key) => !derivedKeys.has(key));
  const conflict = tenantMismatch || wrongKind || invalidIdentity || explicitUnverified || (expectedKind === 'create' && allKeys.length > 1) ||
    new Set(confirmations).size > 1 || new Set(nativeIds).size > 1;
  const confirmation = saved.find((candidate) => candidate.confirmation)?.confirmation;
  const nativeStayId = saved.find((candidate) => candidate.nativeStayId)?.nativeStayId;
  const target: HmsDispatchTarget | null = conflict ? null : expectedKind === 'create' ? create ?? null
    : confirmation || nativeStayId ? { propertyCode: scope.data, kind: 'saved', confirmation, nativeStayId } : null;
  return { keys: allKeys, conflict, target, derivedKeys };
}

/** The operation-specific recovery wrappers use verified persisted/legacy aliases. */
export function hmsLabtestIntentTarget(intent: HmsLabtestIntent): HmsDispatchTarget | null {
  return intentAliases(intent).target;
}

function resolutionMatchesIntent(intent: Intent, evidence: { confirmation: string; nativeStayId?: string;
  nativeReadback?: Record<string, unknown>; readbackDigest: string; savedShot?: { runId: string; sha256: string } },
  requireNative: boolean): boolean {
  if (intent.operation === 'add_on') {
    const readback = evidence.nativeReadback, recovery = object(intent.recovery), service = object(recovery.serviceIntent);
    const coverage = object(service.baselineCoverage);
    if (!readback || !evidence.nativeStayId || !/^\d{1,100}$/.test(String(readback.nativeId ?? '')) ||
        !Array.isArray(service.baselineIds) || coverage.complete !== true || coverage.loaded !== service.baselineIds.length ||
        coverage.reportedTotal !== service.baselineIds.length || !Object.keys(object(service.approvedItem)).length ||
        service.operationId !== intent.grantId || service.workItemId !== intent.workItemId ||
        service.transportId !== intent.transportId || service.sourceDigest !== intent.sourceDigest ||
        service.dispatchDigest !== intent.requestDigest ||
        createHash('sha256').update(canonicalJson(service.approvedItem)).digest('hex') !== intent.approvedDigest) return false;
    const correction = service.variant === 'saved_target' && (service.operation === 'edit' || service.operation === 'remove');
    if (!correction) {
      // Preserve the original Add proof: the resulting row must be new to the complete baseline.
      if (service.baselineIds.includes(readback.nativeId) || canonicalJson(readback.item) !== canonicalJson(service.approvedItem)) return false;
    } else {
      if (service.nativeId !== readback.nativeId || !service.baselineIds.includes(readback.nativeId) ||
          !Object.keys(object(service.beforeItem)).length) return false;
      if (service.operation === 'edit') {
        if (canonicalJson(readback.item) !== canonicalJson(service.approvedItem)) return false;
      } else {
        const ids = readback.remainingIds, currentCoverage = object(readback.coverage);
        if (readback.removed !== true || !Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^\d{1,100}$/.test(id)) ||
            new Set(ids).size !== ids.length || ids.includes(readback.nativeId) || currentCoverage.complete !== true ||
            currentCoverage.loaded !== ids.length || currentCoverage.reportedTotal !== ids.length ||
            service.baselineIds.some(id => id !== readback.nativeId && !ids.includes(id))) return false;
      }
    }
  } else if (!evidence.savedShot) return false;
  const target = hmsLabtestIntentTarget(intent);
  if (!target) return intent.operation === 'create';
  if (target.kind !== 'saved') return true;
  if (target.confirmation) {
    const reported = hmsDispatchTargetSchema.safeParse({ propertyCode: intent.propertyCode, kind: 'saved', confirmation: evidence.confirmation });
    if (!reported.success || hmsDispatchTargetKey({ propertyCode: intent.propertyCode, kind: 'saved', confirmation: target.confirmation }) !==
        hmsDispatchTargetKey(reported.data)) return false;
  }
  if (evidence.nativeReadback) {
    const readback = hmsDispatchTargetSchema.safeParse({ propertyCode: intent.propertyCode, kind: 'saved',
      confirmation: evidence.nativeReadback.confirmation, nativeStayId: evidence.nativeReadback.nativeStayId });
    const reported = hmsDispatchTargetSchema.safeParse({ propertyCode: intent.propertyCode, kind: 'saved',
      confirmation: evidence.confirmation, nativeStayId: evidence.nativeStayId });
    let encoded: string;
    try { encoded = canonicalJson(evidence.nativeReadback); } catch { return false; }
    if (!readback.success || !reported.success || !evidence.nativeReadback.confirmation || !evidence.nativeReadback.nativeStayId ||
        JSON.stringify(hmsDispatchTargetKeys(readback.data)) !== JSON.stringify(hmsDispatchTargetKeys(reported.data)) ||
        Buffer.byteLength(encoded) > 16_384 || createHash('sha256').update(encoded).digest('hex') !== evidence.readbackDigest) return false;
  } else if ((requireNative && target.nativeStayId && !target.confirmation) ||
      (evidence.nativeStayId && !target.nativeStayId)) return false;
  if (!target.nativeStayId) return true;
  if (!evidence.nativeStayId) return !requireNative;
  return hmsDispatchTargetKey({ propertyCode: intent.propertyCode, kind: 'saved', nativeStayId: target.nativeStayId }) ===
    hmsDispatchTargetKey({ propertyCode: intent.propertyCode, kind: 'saved', nativeStayId: evidence.nativeStayId });
}

type HistoryEntry = { intent: Intent; keys: string[] };

function connectedKeys(entries: HistoryEntry[], keys: string[]): string[] {
  const connected = new Set(keys);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (!entry.keys.some((key) => connected.has(key))) continue;
      for (const key of entry.keys) if (!connected.has(key)) { connected.add(key); changed = true; }
    }
  }
  return [...connected].sort();
}

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
    const aliases = intentAliases(raw), keys = aliases.keys;
    const event = eventSchema.safeParse(row.value);
    if (!event.success || row.type !== 'write.evidence' || row.actorKind !== 'system') {
      markCorrupt(row.itemId, keys);
      continue;
    }
    const value = event.data;
    if (value.kind !== 'intent') {
      completions.push({ itemId: row.itemId, value });
    } else {
      const entryKeys = keys.length ? keys : [hmsDispatchWorkItemKey(row.itemId)];
      const existing = intents.get(value.holdId), grantOwner = grantOwners.get(value.grantId);
      if (row.id.toLowerCase() !== value.holdId || row.itemId.toLowerCase() !== value.workItemId ||
          (value.operation === 'create') !== Boolean(value.stayId) ||
          aliases.conflict || existing || grantOwner) {
        markCorrupt(row.itemId, [...keys, ...(existing?.keys ?? []), ...(grantOwner?.keys ?? [])]);
        if (existing) corruptItems.add(existing.intent.workItemId);
        if (grantOwner) corruptItems.add(grantOwner.intent.workItemId);
        continue;
      }
      const entry = { intent: value, keys: entryKeys };
      intents.set(value.holdId, entry);
      grantOwners.set(value.grantId, entry);
    }
  }
  for (const { itemId, value } of completions) {
    const entry = intents.get(value.holdId), intent = entry?.intent;
    const target = intent && hmsLabtestIntentTarget(intent);
    const requireNative = target?.kind === 'saved' && Boolean(target.nativeStayId) && !target.confirmation;
    if (!intent || intent.workItemId !== itemId.toLowerCase() || intent.operation !== value.operation || resolved.has(value.holdId) ||
        (value.kind === 'resolved' && ((intent.operation === 'create' && !/^\d{6,10}-\d{1,2}$/.test(value.confirmation)) ||
          !resolutionMatchesIntent(intent, value, requireNative)))) {
      markCorrupt(itemId, entry ? entry.keys : [...intents.values()].filter((item) => item.intent.workItemId === itemId.toLowerCase()).flatMap((item) => item.keys));
      if (intent) corruptItems.add(intent.workItemId);
      continue;
    }
    // A trusted positive readback can join a newly observed confirmation/native pair.
    if (value.kind === 'resolved' && intent.operation !== 'create' && value.nativeStayId) {
      entry!.keys = [...new Set([...entry!.keys, ...hmsDispatchTargetKeys({ propertyCode: intent.propertyCode, kind: 'saved',
        confirmation: value.confirmation, nativeStayId: value.nativeStayId })])];
    }
    resolved.add(value.holdId);
  }
  const active = [...intents.values()].filter(({ intent }) => !resolved.has(intent.holdId));
  const entries = [...intents.values()];
  for (const entry of entries) {
    const connected = connectedKeys(entries, entry.keys);
    const aliases = connected.map((key) => JSON.parse(key) as string[]);
    const confirmations = aliases.filter((key) => key[1] === 'saved');
    const nativeIds = aliases.filter((key) => key[1] === 'saved_native');
    if (confirmations.length > 1 || nativeIds.length > 1 ||
        active.filter((other) => other.keys.some((key) => connected.includes(key))).length > 1) {
      markCorrupt(entry.intent.workItemId, connected);
    }
  }
  // A malformed orphan/completion inherits the known targets of its own work item.
  for (const entry of intents.values()) {
    if (corruptItems.has(entry.intent.workItemId)) for (const key of entry.keys) corruptTargets.add(key);
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

type History = Awaited<ReturnType<typeof readHistory>>;

/** Changing selected property cannot discard an uncertain or corrupt dispatch. */
export async function assertNoUnresolvedHmsDispatchForWorkItem(tx: CreateFenceTransaction, workItemId: string): Promise<void> {
  const history = await readHistory(tx);
  const id = workItemId.toLowerCase();
  if (history.corruptItems.has(id) || history.active.some((entry) => entry.intent.workItemId === id)) {
    throw new HmsLabtestDispatchError('occupied');
  }
}
const historyEpoch = (history: History, keys: string[]) =>
  createHash('sha256').update([...history.intents.values()].filter((entry) => entry.keys.some((key) => keys.includes(key)))
    .map(({ intent }) => intent.holdId).sort().join('\0')).digest('hex');

function assertTargetHistory(history: History, keys: string[], workItemId?: string) {
  if (keys.some((key) => history.corruptTargets.has(key)) || (workItemId && history.corruptItems.has(workItemId.toLowerCase()))) {
    throw new HmsLabtestDispatchError('corrupt');
  }
  if (history.active.some((entry) => entry.keys.some((key) => keys.includes(key) ||
      (workItemId && key === hmsDispatchWorkItemKey(workItemId))))) {
    throw new HmsLabtestDispatchError('occupied');
  }
}

class AliasExpansion extends Error {}

/** Resolve known aliases, acquire locks in stable numeric order, then recheck the closure. */
async function withAliasLocks<T>(db: DB, seeds: (history: History) => string[],
  run: (tx: CreateFenceTransaction, history: History, keys: string[]) => Promise<T>, grantId?: string): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        const before = await readHistory(tx);
        const keys = connectedKeys([...before.intents.values()], seeds(before));
        const lockIds = [...new Set(keys.map(targetLockId))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
        for (const id of lockIds) await lockTarget(tx, id);
        if (grantId) await lockGrant(tx, grantId);
        const history = await readHistory(tx);
        const current = connectedKeys([...history.intents.values()], seeds(history));
        if (JSON.stringify(current) !== JSON.stringify(keys)) throw new AliasExpansion();
        return run(tx, history, current);
      }, { isolationLevel: 'read committed' });
    } catch (error) {
      if (!(error instanceof AliasExpansion)) throw error;
    }
  }
  throw new HmsLabtestDispatchError('occupied');
}

/** Snapshot the append-only writer history before reading an HMS preimage. */
export async function captureHmsLabtestDispatchEpoch(db: DB, target?: HmsDispatchTarget, workItemId?: string): Promise<string> {
  const parsed = hmsDispatchTargetSchema.safeParse(target);
  if (!parsed.success || (parsed.data.kind === 'saved' && !parsed.data.nativeStayId) ||
      (workItemId !== undefined && !z.string().uuid().safeParse(workItemId).success)) {
    throw new HmsLabtestDispatchError('invalid');
  }
  return withAliasLocks(db, () => hmsDispatchTargetKeys(parsed.data), async (_tx, history, keys) => {
    assertTargetHistory(history, keys, workItemId);
    return historyEpoch(history, keys);
  });
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
      (parsed.data.operation === 'create') !== (parsed.data.target.kind === 'create') ||
      (parsed.data.target.kind === 'saved' && !parsed.data.target.nativeStayId)) throw new HmsLabtestDispatchError('invalid');
  const targetKeys = hmsDispatchTargetKeys(parsed.data.target), aliases = intentAliases(parsed.data);
  if (aliases.conflict || !aliases.derivedKeys.size || aliases.derivedKeys.size !== targetKeys.length ||
      targetKeys.some((key) => !aliases.derivedKeys.has(key))) {
    throw new HmsLabtestDispatchError('invalid');
  }
  const registration = getPropertyRegistration(parsed.data.propertyCode);
  if (!registration || (parsed.data.tenantId !== undefined && parsed.data.tenantId !== registration.expectedTenant)) {
    throw new HmsLabtestDispatchError('invalid');
  }
  const input = Object.freeze({ ...parsed.data, tenantId: registration.expectedTenant });
  let encoded: string;
  try { encoded = canonicalJson(input); } catch { throw new HmsLabtestDispatchError('invalid'); }
  if (Buffer.byteLength(encoded) > 16_384) throw new HmsLabtestDispatchError('invalid');
  const holdId = randomUUID(), ownerToken = randomBytes(32).toString('hex');
  // Clone nested evidence: retaining the authorization callback's object must
  // not permit changing the value that was authorized and will be persisted.
  const intent: Intent = { ...(JSON.parse(encoded) as Claim), version: 1, kind: 'intent', holdId, ownerDigest: ownerHash(ownerToken) };
  await withAliasLocks(db, () => targetKeys, async (tx, history, keys) => {
    assertTargetHistory(history, keys, input.workItemId);
    if (historyEpoch(history, keys) !== expectedEpoch || history.grants.has(input.grantId)) {
      throw new HmsLabtestDispatchError('occupied');
    }
    await authorize(tx, input);
    if (canonicalJson(input) !== encoded) throw new HmsLabtestDispatchError('invalid');
    await tx.insert(workEvent).values({ id: holdId, workItemId: input.workItemId, actorKind: 'system',
      type: 'write.evidence', fieldPath: FIELD, value: intent });
  }, input.grantId);
  return { holdId, ownerToken };
}

async function finishDispatch(db: DB, holdId: string, evidence: Resolution | { operation: 'create' | 'attach_document' | 'cancel'; notDispatched: true },
  authorize: (intent: Intent) => void, record: (tx: CreateFenceTransaction, intent: Intent) => Promise<void>) {
  const normalizedHoldId = holdId.toLowerCase();
  const seeds = (history: History) => {
    const entry = history.intents.get(normalizedHoldId);
    if (!entry) throw new HmsLabtestDispatchError('owner');
    if (entry.intent.operation !== evidence.operation) throw new HmsLabtestDispatchError('phase');
    if (!('notDispatched' in evidence) && !resolutionMatchesIntent(entry.intent, evidence, true)) {
      throw new HmsLabtestDispatchError('phase');
    }
    return !('notDispatched' in evidence) && entry.intent.operation !== 'create' && evidence.nativeStayId
      ? [...entry.keys, ...hmsDispatchTargetKeys({ propertyCode: entry.intent.propertyCode, kind: 'saved',
        confirmation: evidence.confirmation, nativeStayId: evidence.nativeStayId })]
      : entry.keys;
  };
  await withAliasLocks(db, seeds, async (tx, history, keys) => {
    const entry = history.active.find((item) => item.intent.holdId === normalizedHoldId);
    if (!entry) throw new HmsLabtestDispatchError('owner');
    const intent = entry.intent;
    const parsedKeys = keys.map((key) => JSON.parse(key) as string[]);
    if (keys.some((key) => history.corruptTargets.has(key)) || history.corruptItems.has(intent.workItemId) ||
        parsedKeys.filter((key) => key[1] === 'saved').length > 1 ||
        parsedKeys.filter((key) => key[1] === 'saved_native').length > 1 ||
        history.active.some((other) => other.intent.holdId !== normalizedHoldId && other.keys.some((key) => keys.includes(key)))) {
      throw new HmsLabtestDispatchError('corrupt');
    }
    authorize(intent);
    const immutableIntent = canonicalJson(intent);
    await record(tx, intent);
    if (canonicalJson(intent) !== immutableIntent) throw new HmsLabtestDispatchError('invalid');
    const value = 'notDispatched' in evidence
      ? { version: 1, kind: 'not_dispatched', holdId: intent.holdId, operation: evidence.operation }
      : { version: 1, kind: 'resolved', holdId: intent.holdId, ...evidence };
    await tx.insert(workEvent).values({ workItemId: intent.workItemId, actorKind: 'system', type: 'write.evidence',
      fieldPath: FIELD, value });
  });
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

/** Only the closed HRCEN cancel runner can release its claim after proving no request continued. */
export async function resolveNeverDispatchedCancel(db: DB, handle: HmsLabtestWriteHandle, proof: unknown,
  record: (tx: CreateFenceTransaction, intent: Readonly<Intent>) => Promise<void>): Promise<void> {
  const { consumeNeverDispatchedCancelProof } = await import('../../tooling/hms-cloud/pane-cancel-session.mjs' as string) as {
    consumeNeverDispatchedCancelProof(proof: unknown, intent: unknown): boolean;
  };
  if (!z.string().uuid().safeParse(handle?.holdId).success || !digest.safeParse(handle?.ownerToken).success ||
      typeof record !== 'function') throw new HmsLabtestDispatchError('invalid');
  await finishDispatch(db, handle.holdId, { operation: 'cancel', notDispatched: true }, (intent) => {
    if (!timingSafeEqual(Buffer.from(intent.ownerDigest, 'hex'), Buffer.from(ownerHash(handle.ownerToken), 'hex')) ||
        !consumeNeverDispatchedCancelProof(proof, intent)) {
      throw new HmsLabtestDispatchError('owner');
    }
  }, record);
}

/** Consume a positively closed, no-dispatch result when no claim transaction committed. */
export async function consumeNeverDispatchedCancelProof(proof: unknown, binding: {
  runId: string; target: HmsDispatchTarget; cloudTargetKey: string;
}): Promise<boolean> {
  const { consumeNeverDispatchedCancelProof: consume } = await import('../../tooling/hms-cloud/pane-cancel-session.mjs' as string) as {
    consumeNeverDispatchedCancelProof(proof: unknown, intent: unknown): boolean;
  };
  const target = hmsDispatchTargetSchema.safeParse(binding.target);
  if (!target.success || target.data.kind !== 'saved' || !target.data.confirmation || !target.data.nativeStayId ||
      !z.string().uuid().safeParse(binding.runId).success || typeof binding.cloudTargetKey !== 'string') return false;
  return consume(proof, { operation: 'cancel', propertyCode: target.data.propertyCode, target: target.data,
    recovery: { runId: binding.runId, confirmation: target.data.confirmation,
      nativeStayId: target.data.nativeStayId, cloudTargetKey: binding.cloudTargetKey } });
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
async function recoverPositiveDispatch<P extends { confirmation: string; nativeStayId?: string;
  nativeReadback?: Record<string, unknown>; readbackDigest: string;
  savedShot?: { runId: string; sha256: string } }>(db: DB, holdId: string, kind: z.infer<typeof operation>, driver: {
    withLock: <T>(intent: Intent, action: () => Promise<T>) => Promise<T>;
    prove: (intent: Intent) => Promise<P>;
    record: (tx: CreateFenceTransaction, intent: Intent, proof: P) => Promise<void>;
  }): Promise<void> {
  if (!z.string().uuid().safeParse(holdId).success) throw new HmsLabtestDispatchError('invalid');
  const normalizedHoldId = holdId.toLowerCase();
  const original = await withAliasLocks(db, (history) => {
    const entry = history.intents.get(normalizedHoldId);
    if (!entry) throw new HmsLabtestDispatchError('phase');
    return entry.keys;
  }, async (_tx, history, keys) => {
    const entry = history.active.find((item) => item.intent.holdId === normalizedHoldId);
    if (!entry || entry.intent.operation !== kind || keys.some((key) => history.corruptTargets.has(key)) ||
        history.corruptItems.has(entry.intent.workItemId)) {
      throw new HmsLabtestDispatchError('phase');
    }
    const intent = entry.intent;
    return intent;
  });
  await driver.withLock(original, async () => {
    const proof = await driver.prove(original);
    const result = resolutionSchema.omit({ version: true, kind: true, holdId: true }).safeParse({ operation: kind,
      confirmation: proof.confirmation, ...(proof.nativeStayId ? { nativeStayId: proof.nativeStayId } : {}),
      ...(proof.nativeReadback ? { nativeReadback: proof.nativeReadback } : {}),
      readbackDigest: proof.readbackDigest, savedShot: proof.savedShot, recovered: true });
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

/** Positive-only Amend reconciliation. A saved-stay hold is never cleared on a negative or ambiguous read. */
export async function recoverHmsLabtestAmend(db: DB, holdId: string): Promise<void> {
  const driver = await import('./pane-cloud-amend-recovery.js');
  await recoverPositiveDispatch(db, holdId, 'amend', {
    withLock: driver.withAmendRecoveryLock,
    prove: (intent) => driver.proveAmendRecovery(db, intent),
    record: driver.recordRecoveredAmend,
  });
}

/** Positive-only Add-On reconciliation under the same target hold as every other writer. */
export async function recoverHmsLabtestAddOn(db: DB, holdId: string): Promise<void> {
  const driver = await import('./reservation-workflow-v2-services-execute.js');
  await recoverPositiveDispatch(db, holdId, 'add_on', {
    withLock: driver.withServiceRecoveryLock,
    prove: (intent) => driver.proveServiceRecovery(db, intent),
    record: driver.recordRecoveredService,
  });
}

/** Positive-only recovery for v2 Filing intents, which use the same native upload gate without a legacy grant. */
export async function recoverHmsLabtestV2Attach(db: DB, holdId: string,
  access?: import('./reservation-workflow-v2-filing.js').ReservationWorkflowV2FilingRecoveryAccess): Promise<void> {
  const driver = await import('./reservation-workflow-v2-filing.js');
  await recoverPositiveDispatch(db, holdId, 'attach_document', {
    withLock: driver.withReservationWorkflowV2AttachRecoveryLock,
    prove: (intent) => driver.proveReservationWorkflowV2AttachRecovery(db, intent, access),
    record: (tx, intent, proof) => driver.recordReservationWorkflowV2AttachRecovery(tx, intent, proof, access),
  });
}
