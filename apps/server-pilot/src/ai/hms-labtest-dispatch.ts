import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
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
  readbackDigest: digest, savedShot: shot }).strict();
const eventSchema = z.discriminatedUnion('kind', [intentSchema, resolutionSchema]);
type Claim = z.infer<typeof claimSchema>;
type Intent = z.infer<typeof intentSchema>;
type Resolution = Omit<z.infer<typeof resolutionSchema>, 'version' | 'kind' | 'holdId'>;
export type HmsLabtestWriteHandle = { holdId: string; ownerToken: string };

export class HmsLabtestDispatchError extends Error {
  constructor(readonly reason: 'invalid' | 'occupied' | 'corrupt' | 'owner' | 'phase') {
    super(`hms_labtest_dispatch_${reason}`);
    this.name = 'HmsLabtestDispatchError';
  }
}

const ownerHash = (token: string) => createHash('sha256').update(token).digest('hex');

async function lockProperty(tx: CreateFenceTransaction) {
  // All participants acquire this before mailbox, source, item or lease locks.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('nava-hms-labtest-write-v1'), hashtext('HRCEN'))`);
}

async function readHistory(tx: CreateFenceTransaction) {
  const rows = await tx.select({ id: workEvent.id, itemId: workEvent.workItemId, type: workEvent.type,
    actorKind: workEvent.actorKind, value: workEvent.value }).from(workEvent).where(eq(workEvent.fieldPath, FIELD));
  const intents = new Map<string, Intent>(), resolved = new Set<string>(), grants = new Set<string>();
  const completions: Array<{ itemId: string; value: z.infer<typeof resolutionSchema> }> = [];
  for (const row of rows) {
    const event = eventSchema.safeParse(row.value);
    if (!event.success || row.type !== 'write.evidence' || row.actorKind !== 'system') {
      throw new HmsLabtestDispatchError('corrupt');
    }
    const value = event.data;
    if (value.kind === 'resolved') {
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
        (intent.operation === 'create' && !/^\d{6,10}-\d{1,2}$/.test(value.confirmation))) {
      throw new HmsLabtestDispatchError('corrupt');
    }
    resolved.add(value.holdId);
  }
  const active = [...intents.values()].filter((intent) => !resolved.has(intent.holdId));
  if (active.length > 1) throw new HmsLabtestDispatchError('corrupt');
  return { active, grants };
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
): Promise<HmsLabtestWriteHandle> {
  const parsed = claimSchema.safeParse(raw);
  if (!parsed.success || typeof authorize !== 'function' ||
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
    if (history.active.length || history.grants.has(input.grantId)) throw new HmsLabtestDispatchError('occupied');
    await authorize(tx, input);
    if (canonicalJson(input) !== encoded) throw new HmsLabtestDispatchError('invalid');
    await tx.insert(workEvent).values({ id: holdId, workItemId: input.workItemId, actorKind: 'system',
      type: 'write.evidence', fieldPath: FIELD, value: intent });
  }, { isolationLevel: 'read committed' });
  return { holdId, ownerToken };
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
  await db.transaction(async (tx) => {
    await lockProperty(tx);
    const [intent] = (await readHistory(tx)).active;
    if (!intent || intent.holdId !== handle.holdId ||
        !timingSafeEqual(Buffer.from(intent.ownerDigest, 'hex'), Buffer.from(ownerHash(handle.ownerToken), 'hex'))) {
      throw new HmsLabtestDispatchError('owner');
    }
    if (intent.operation !== evidence.operation) throw new HmsLabtestDispatchError('phase');
    const immutableIntent = canonicalJson(intent);
    await record(tx, intent);
    if (canonicalJson(intent) !== immutableIntent) throw new HmsLabtestDispatchError('invalid');
    await tx.insert(workEvent).values({ workItemId: intent.workItemId, actorKind: 'system', type: 'write.evidence',
      fieldPath: FIELD, value: { version: 1, kind: 'resolved', holdId: intent.holdId, ...evidence } });
  }, { isolationLevel: 'read committed' });
}
