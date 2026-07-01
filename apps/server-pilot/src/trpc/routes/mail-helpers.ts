/**
 * Shared mail-route helpers: thread/message scoping, NOT_FOUND guard.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, desc, asc, isNotNull, isNull } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import {
  mailThread,
  message,
} from '../../db/schema/mail.js';

/**
 * Load a thread scoped to `transportId`. Throws NOT_FOUND if the thread does
 * not exist OR exists on a different transport (so a user without access to
 * mailbox X gets NOT_FOUND, not FORBIDDEN, when guessing a thread id).
 */
export async function requireThreadForTransport(
  db: DB,
  threadId: string,
  transportId: string,
) {
  const rows = await db
    .select()
    .from(mailThread)
    .where(and(eq(mailThread.id, threadId), eq(mailThread.transportId, transportId)))
    .limit(1);
  if (rows.length === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: thread not found' });
  }
  return rows[0]!;
}

/**
 * Load a message scoped to `transportId`. Throws NOT_FOUND if the message
 * does not exist OR exists on a different transport.
 */
export async function requireMessageForTransport(
  db: DB,
  messageId: string,
  transportId: string,
) {
  const rows = await db
    .select()
    .from(message)
    .where(and(eq(message.id, messageId), eq(message.transportId, transportId)))
    .limit(1);
  if (rows.length === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: message not found' });
  }
  return rows[0]!;
}

export { and, eq, desc, asc, isNotNull, isNull };
