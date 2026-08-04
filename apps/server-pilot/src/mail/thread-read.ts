/**
 * Mark thread(s) + all messages read for a mailbox transport.
 * Shared by markAsRead, mail.send auto-read, and hotel-sent ingest.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { mailThread, message } from '../db/schema/mail.js';
import type { DB } from '../db/client.js';

export async function markThreadRead(
  db: DB,
  transportId: string,
  threadIds: string[],
): Promise<number> {
  if (threadIds.length === 0) return 0;
  const now = new Date();
  await db
    .update(mailThread)
    .set({ isRead: true, updatedAt: now })
    .where(
      and(eq(mailThread.transportId, transportId), inArray(mailThread.id, threadIds)),
    );
  await db
    .update(message)
    .set({ isRead: true, updatedAt: now })
    .where(
      and(eq(message.transportId, transportId), inArray(message.threadId, threadIds)),
    );
  return threadIds.length;
}
