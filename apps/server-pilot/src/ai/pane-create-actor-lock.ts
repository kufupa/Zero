import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { remoteSession, session } from '../db/schema/auth.js';
import { mailboxAccess, mailboxTransport } from '../db/schema/mail.js';
import type { CreateFenceTransaction } from './pane-create-dispatch-fence.js';

const identifier = z.string().min(1).max(512).refine((value) => value === value.trim() &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
/** Lock the active mailbox and exact staff access under the caller's source/item transaction. */
export async function lockCreateActorAccess(tx: CreateFenceTransaction, raw: {
  transportId: string; actorUserId: string; accessId?: string;
}): Promise<{ accessId: string; mailboxAddress: string }> {
  const input = z.object({ transportId: identifier, actorUserId: identifier, accessId: identifier.optional() }).strict().parse(raw);
  const [transport] = await tx.select({ id: mailboxTransport.id, isActive: mailboxTransport.isActive, email: mailboxTransport.email })
    .from(mailboxTransport).where(and(eq(mailboxTransport.id, input.transportId), eq(mailboxTransport.isActive, true)))
    .limit(1).for('share');
  if (!transport || transport.id !== input.transportId || !transport.isActive) throw new Error('create_actor_unavailable');
  const [access] = await tx.select({ id: mailboxAccess.id, userId: mailboxAccess.userId, transportId: mailboxAccess.transportId })
    .from(mailboxAccess).where(and(input.accessId ? eq(mailboxAccess.id, input.accessId) : undefined,
      eq(mailboxAccess.userId, input.actorUserId), eq(mailboxAccess.transportId, input.transportId))).limit(1).for('share');
  if (!access || (input.accessId && access.id !== input.accessId) || access.userId !== input.actorUserId ||
      access.transportId !== input.transportId) throw new Error('create_actor_unavailable');
  return { accessId: access.id, mailboxAddress: transport.email };
}

/** Check the exact Better Auth session while its row is locked through the claim commit. */
export async function lockCreateActorSession(tx: CreateFenceTransaction, raw: {
  actorUserId: string; sessionId?: string; sessionProfile?: 'legacy' | 'remote';
}): Promise<void> {
  const input = z.object({ actorUserId: identifier, sessionId: identifier,
    sessionProfile: z.enum(['legacy', 'remote']) }).strict().parse(raw);
  const table = input.sessionProfile === 'remote' ? remoteSession : session;
  const [current] = await tx.select({ id: table.id }).from(table)
    .where(and(eq(table.id, input.sessionId), eq(table.userId, input.actorUserId),
      sql`${table.expiresAt} > timezone('UTC', clock_timestamp())`)).limit(1).for('share');
  if (!current) throw new Error('create_actor_session_unavailable');
}
