import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { centurionWriterQuiesced } from '../../tooling/playwright-quote/centurion-stay360.mjs';
import { consumeNeverDispatchedCreateProof } from '../../tooling/hms-cloud/saved-stay-save-route-chain.mjs';
import type { DB } from '../db/client.js';
import { workEvent } from '../db/schema/work.js';
import { canonicalJson } from './draft-approval.js';
import type { CreateFenceTransaction } from './pane-create-dispatch-fence.js';

// All live fake writers must join this protocol before any is enabled.
const FIELD = 'nava.hms.labtest.dispatch.v1';
const identifier = z.string().min(1).max(256).refine((s) => s === s.trim() &&
  ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const operation = z.enum(['create', 'attach_document', 'amend', 'cancel']);
const shot = z.object({ runId: z.string().uuid(), sha256: digest }).strict();
const claimSchema = z.object({
  workItemId: z.string().uuid(), transportId: identifier, actorUserId: identifier, grantId: z.string().uuid(),
  propertyCode: z.literal('HRCEN'), firstName: z.literal('Proof'), lastName: z.literal('Labtest'),
  nativeGuestId: z.string().regex(/^[0-9]{1,30}$/), operation,
  stayId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  sourceDigest: digest, approvedDigest: digest, requestDigest: digest,
  recovery: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0),
}).strict();
const intentSchema = claimSchema.extend({ version: z.literal(1), kind: z.literal('intent'),
  holdId: z.string().uuid(), ownerDigest: digest }).strict();
const resolutionSchema = z.object({ version: z.literal(1), kind: z.literal('resolved'),
  holdId: z.string().uuid(), operation, confirmation: z.string().max(40).regex(/^\d+-\d+$/),
  readbackDigest: digest, savedShot: shot, recovered: z.literal(true).optional() }).strict();
const noDispatchSchema = z.object({ version: z.literal(1), kind: z.literal('not_dispatched'),
  holdId: z.string().uuid(), operation: z.enum(['create', 'attach_document']) }).strict();
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

async function lockProperty(tx: CreateFenceTransaction) {
  // All participants acquire this before mailbox, source, item or lease locks.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('nava-hms-labtest-write-v1'), hashtext('HRCEN'))`);
}

async function readHistory(tx: CreateFenceTransaction) {
  const rows = await tx.select({ id: workEvent.id, itemId: workEvent.workItemId, type: workEvent.type,
    actorKind: workEvent.actorKind, value: workEvent.value }).from(workEvent).where(eq(workEvent.fieldPath, FIELD));
  const intents = new Map<string, Intent>(), resolved = new Set<string>(), grants = new Set<string>();
  const completions: Array<{ itemId: string; value: z.infer<typeof resolutionSchema> | z.infer<typeof noDispatchSchema> }> = [];
  for (const row of rows) {
    const event = eventSchema.safeParse(row.value);
    if (!event.success || row.type !== 'write.evidence' || row.actorKind !== 'system') {
      throw new HmsLabtestDispatchError('corrupt');
    }
    const value = event.data;
    if (value.kind !== 'intent') {
      completions.push({ itemId: row.itemId, value });
    } else {
      if (row.id !== value.holdId || row.itemId !== value.workItemId ||
          (value.operation === 'create') !== Boolean(value.stayId) ||
          intents.has(value.holdId) || grants.has(value.grantId)) {
        throw new HmsLabtestDispatchError('corrupt');
      }
      intents.set(value.holdId, value);
      grants.add(value.grantId);
    }
  }
  for (const { itemId, value } of completions) {
    const intent = intents.get(value.holdId);
    if (!intent || intent.workItemId !== itemId || intent.operation !== value.operation || resolved.has(value.holdId) ||
        (value.kind === 'resolved' && intent.operation === 'create' && !/^\d{6,10}-\d{1,2}$/.test(value.confirmation))) {
      throw new HmsLabtestDispatchError('corrupt');
    }
    resolved.add(value.holdId);
  }
  const active = [...intents.values()].filter((intent) => !resolved.has(intent.holdId));
  if (active.length > 1) throw new HmsLabtestDispatchError('corrupt');
  const completed = completions.map(({ value }) => ({ intent: intents.get(value.holdId)!, resolution: value }));
  return { active, grants, completed };
}

/** Read only validated intent/resolution pairs for this work item. */
export async function readResolvedHmsLabtestCreates(tx: CreateFenceTransaction, workItemId: string) {
  const history = await readHistory(tx);
  return history.completed.flatMap(({ intent, resolution }) =>
    intent.operation === 'create' && intent.workItemId === workItemId && resolution.kind === 'resolved'
      ? [{ intent, resolution }]
      : []);
}

const historyEpoch = (history: Awaited<ReturnType<typeof readHistory>>) =>
  createHash('sha256').update([...history.grants].sort().join('\0')).digest('hex');

/** Snapshot the append-only writer history before reading an HMS preimage. */
export async function captureHmsLabtestDispatchEpoch(db: DB): Promise<string> {
  return db.transaction(async (tx) => {
    await lockProperty(tx);
    const history = await readHistory(tx);
    if (history.active.length) throw new HmsLabtestDispatchError('occupied');
    return historyEpoch(history);
  }, { isolationLevel: 'read committed' });
}

/**
 * Atomic one-shot claim across all HRCEN Proof Labtest profiles. The caller must
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
      (parsed.data.operation === 'create') !== Boolean(parsed.data.stayId)) throw new HmsLabtestDispatchError('invalid');
  const input = Object.freeze(parsed.data);
  let encoded: string;
  try { encoded = canonicalJson(input); } catch { throw new HmsLabtestDispatchError('invalid'); }
  if (Buffer.byteLength(encoded) > 16_384) throw new HmsLabtestDispatchError('invalid');
  const holdId = randomUUID(), ownerToken = randomBytes(32).toString('hex');
  // Clone nested evidence: retaining the authorization callback's object must
  // not permit changing the value that was authorized and will be persisted.
  const intent: Intent = { ...(JSON.parse(encoded) as Claim), version: 1, kind: 'intent', holdId, ownerDigest: ownerHash(ownerToken) };
  await db.transaction(async (tx) => {
    await lockProperty(tx);
    const history = await readHistory(tx);
    if (history.active.length || historyEpoch(history) !== expectedEpoch || history.grants.has(input.grantId)) {
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
    await lockProperty(tx);
    const [intent] = (await readHistory(tx)).active;
    if (!intent || intent.holdId !== holdId) throw new HmsLabtestDispatchError('owner');
    authorize(intent);
    if (intent.operation !== evidence.operation) throw new HmsLabtestDispatchError('phase');
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
    await lockProperty(tx);
    const [intent] = (await readHistory(tx)).active;
    if (!intent || intent.holdId !== holdId || intent.operation !== kind) throw new HmsLabtestDispatchError('phase');
    return intent;
  }, { isolationLevel: 'read committed' });
  await driver.withLock(original, async () => {
    if (!centurionWriterQuiesced(original.recovery.writer)) throw new HmsLabtestDispatchError('phase');
    const proof = await driver.prove(original);
    const result = resolutionSchema.omit({ version: true, kind: true, holdId: true }).safeParse({ operation: kind,
      confirmation: proof.confirmation, readbackDigest: proof.readbackDigest, savedShot: proof.savedShot, recovered: true });
    if (!result.success || (kind === 'create' && !/^\d{6,10}-\d{1,2}$/.test(proof.confirmation))) {
      throw new HmsLabtestDispatchError('invalid');
    }
    await finishDispatch(db, holdId, result.data, (intent) => {
      if (canonicalJson(intent) !== canonicalJson(original) || !centurionWriterQuiesced(intent.recovery.writer)) {
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
