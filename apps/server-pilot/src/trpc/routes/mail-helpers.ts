/**
 * Shared mail-route helpers: thread/message scoping, NOT_FOUND guard.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, desc, asc, isNotNull, isNull, sql, exists } from 'drizzle-orm';
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

export { and, eq, desc, asc, isNotNull, isNull, sql, exists };

/** Encode keyset cursor as ISO timestamp + id. */
export function encodePageCursor(ts: Date | null, id: string): string {
  return `${(ts ?? new Date(0)).toISOString()}|${id}`;
}

/** Decode keyset cursor; returns null when format is invalid. */
export function decodePageCursor(cursor: string): { ts: Date; id: string } | null {
  const pipe = cursor.indexOf('|');
  if (pipe === -1) return null;
  const tsStr = cursor.slice(0, pipe);
  const id = cursor.slice(pipe + 1);
  const ts = new Date(tsStr);
  if (Number.isNaN(ts.getTime()) || !id) return null;
  return { ts, id };
}

/** Keyset predicate for DESC (ts, id) pagination — rows strictly older than cursor. */
export function keysetBefore(tsColumn: unknown, idColumn: unknown, cursorTs: Date, cursorId: string) {
  return sql`(COALESCE(${tsColumn}, to_timestamp(0)), ${idColumn}) < (${cursorTs}, ${cursorId})`;
}
