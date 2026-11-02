import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { workEvent, workItem } from '../db/schema/work.js';

/** This API requires the transaction that also owns the work-item row lock. */
export type CreateFenceTransaction = Parameters<Parameters<DB['transaction']>[0]>[0];

const identifier = z.string().min(1).max(256).refine((s) =>
  s.trim() === s && ![...s].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single'), stayId: identifier, requestDigest: digest }).strict(),
  z.object({ kind: z.literal('batch'), manifestDigest: digest }).strict(),
]);
const bindingSchema = z.object({
  version: z.literal('pane-create-fence/v1'),
  actorUserId: identifier,
  grantId: z.string().uuid(),
  scope: scopeSchema,
}).strict();
export type CreateFenceScope = z.infer<typeof scopeSchema>;
export type CreateFenceBinding = z.infer<typeof bindingSchema>;
export type CreateFenceIdentity = CreateFenceBinding & { fenceId: string };

export class CreateFenceError extends Error {
  constructor(readonly reason: 'not_found' | 'active' | 'owner_mismatch' | 'invalid_binding') {
    super(`create_fence_${reason}`);
    this.name = 'CreateFenceError';
  }
}

type ItemKey = { transportId: string; workItemId: string };

/** Lock before both the event check and any dependent work-item mutation. */
async function lockAndRead(tx: CreateFenceTransaction, key: ItemKey) {
  const [item] = await tx.select({ id: workItem.id }).from(workItem)
    .where(and(eq(workItem.id, key.workItemId), eq(workItem.transportId, key.transportId)))
    .limit(1).for('update');
  if (!item) throw new CreateFenceError('not_found');
  // All beginnings currently stay open. A future release must be evidence-bound,
  // not a clock/lease expiry, and must update this reader in the same slice.
  return tx.select({ id: workEvent.id, value: workEvent.value }).from(workEvent)
    .where(and(eq(workEvent.workItemId, item.id), eq(workEvent.type, 'create.fence.started')))
    .limit(2);
}

/**
 * Begin only in the same transaction as consumption of the server-owned approval.
 * Callers must validate and consume that grant; this function does not authorize a
 * save. Never catch an error inside that transaction and commit a consumed grant.
 */
export async function beginCreateDispatchFence(
  tx: CreateFenceTransaction,
  key: ItemKey,
  binding: CreateFenceBinding,
): Promise<CreateFenceIdentity> {
  const parsed = bindingSchema.safeParse(binding);
  if (!parsed.success) throw new CreateFenceError('invalid_binding');
  if ((await lockAndRead(tx, key)).length) throw new CreateFenceError('active');
  const fenceId = randomUUID();
  await tx.insert(workEvent).values({
    id: fenceId,
    workItemId: key.workItemId,
    actorKind: 'system',
    actorUserId: parsed.data.actorUserId,
    type: 'create.fence.started',
    value: parsed.data,
  });
  return { fenceId, ...parsed.data };
}

/** External mutations must call this within their own locked transaction. */
export async function assertNoCreateDispatchFence(tx: CreateFenceTransaction, key: ItemKey): Promise<void> {
  if ((await lockAndRead(tx, key)).length) throw new CreateFenceError('active');
}

/**
 * Internal outcome/child operations may only proceed for the exact server-owned
 * fence, grant, actor and scope. This is not native-request authorization.
 */
export async function assertCreateDispatchFenceOwner(
  tx: CreateFenceTransaction,
  key: ItemKey,
  identity: CreateFenceIdentity,
): Promise<void> {
  const { fenceId, ...binding } = identity;
  const supplied = bindingSchema.safeParse(binding);
  if (!supplied.success || !z.string().uuid().safeParse(fenceId).success) {
    throw new CreateFenceError('invalid_binding');
  }
  const rows = await lockAndRead(tx, key);
  if (rows.length !== 1 || rows[0]?.id !== fenceId) throw new CreateFenceError('owner_mismatch');
  const stored = bindingSchema.safeParse(rows[0].value);
  if (!stored.success || stored.data.actorUserId !== supplied.data.actorUserId ||
      stored.data.grantId !== supplied.data.grantId ||
      stored.data.scope.kind !== supplied.data.scope.kind) throw new CreateFenceError('owner_mismatch');
  const a = stored.data.scope;
  const b = supplied.data.scope;
  if (a.kind === 'single' && b.kind === 'single') {
    if (a.stayId !== b.stayId || a.requestDigest !== b.requestDigest) throw new CreateFenceError('owner_mismatch');
  } else if (a.kind === 'batch' && b.kind === 'batch') {
    if (a.manifestDigest !== b.manifestDigest) throw new CreateFenceError('owner_mismatch');
  } else throw new CreateFenceError('owner_mismatch');
}
