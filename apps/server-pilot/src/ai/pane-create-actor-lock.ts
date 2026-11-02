import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { mailboxAccess, mailboxTransport } from '../db/schema/mail.js';
import { assertCreateDispatchFenceOwner, type CreateFenceIdentity, type CreateFenceTransaction } from './pane-create-dispatch-fence.js';

const identifier = z.string().min(1).max(512).refine((value) => value === value.trim() &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
const keySchema = z.object({ transportId: identifier, workItemId: z.string().uuid(), accessId: identifier }).strict();
export type CreateActorBinding = z.infer<typeof keySchema> & { fence: CreateFenceIdentity };

/**
 * Disconnected, database-only seam: never use this to authorize or perform a
 * native request. Caller must independently authenticate and consume the grant,
 * bind its actor and run to the persisted fence, verify source/attachment
 * freshness and resolve the global lock order. Neither these row locks nor the
 * mocked tests prove phantom exclusion or PostgreSQL concurrency behavior.
 *
 * The caller's transaction owns the source and item locks. This revalidates the
 * exact existing fence, then locks active transport and actor access. The caller
 * must keep the transaction open for the awaited database-only continuation.
 */
export async function withLockedCreateActor<T>(
  tx: CreateFenceTransaction,
  raw: CreateActorBinding,
  continuation: () => Promise<T>,
): Promise<T> {
  const { fence: rawFence, ...rawKey } = raw;
  const key = keySchema.parse(rawKey);
  const fence = structuredClone(rawFence);
  await assertCreateDispatchFenceOwner(tx, { transportId: key.transportId, workItemId: key.workItemId }, fence);
  const [transport] = await tx.select({ id: mailboxTransport.id, isActive: mailboxTransport.isActive })
    .from(mailboxTransport).where(and(eq(mailboxTransport.id, key.transportId), eq(mailboxTransport.isActive, true)))
    .limit(1).for('share');
  if (!transport || transport.id !== key.transportId || !transport.isActive) throw new Error('create_actor_unavailable');
  const [access] = await tx.select({ id: mailboxAccess.id, userId: mailboxAccess.userId, transportId: mailboxAccess.transportId })
    .from(mailboxAccess).where(and(eq(mailboxAccess.id, key.accessId), eq(mailboxAccess.userId, fence.actorUserId),
      eq(mailboxAccess.transportId, key.transportId))).limit(1).for('share');
  if (!access || access.id !== key.accessId || access.userId !== fence.actorUserId ||
      access.transportId !== key.transportId) throw new Error('create_actor_unavailable');
  return await continuation();
}
