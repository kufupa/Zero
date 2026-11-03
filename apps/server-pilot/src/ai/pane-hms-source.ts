import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { mailThread, mailboxAccess, mailboxTransport, message } from '../db/schema/mail.js';
import { workItem } from '../db/schema/work.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';

export type PaneHmsSource = {
  transportId: string; actorUserId: string; workItemId: string; sourceMessageId: string;
  threadId?: string; sourceHash?: string;
};

/** Recheck the selected inbound and current mailbox access before and after a remote read. */
export async function currentPaneHmsSourceThread(db: DB, input: PaneHmsSource): Promise<string | null> {
  if (input.sourceHash !== undefined && !/^[a-f0-9]{64}$/.test(input.sourceHash)) return null;
  const rows = await db.select({ itemThread: workItem.threadId, messageThread: message.threadId,
    itemMessage: workItem.sourceMessageId, messageId: message.id, transportId: workItem.transportId,
    actorUserId: mailboxAccess.userId, active: mailboxTransport.isActive, status: workItem.status,
    direction: message.direction, messageHistoryOnly: message.historyOnly,
    threadHistoryOnly: mailThread.historyOnly, threadTrashedAt: mailThread.trashedAt,
    subject: message.subject, textBody: message.textBody, htmlBody: message.htmlBody }).from(workItem)
    .innerJoin(message, and(eq(message.id, workItem.sourceMessageId), eq(message.transportId, input.transportId)))
    .innerJoin(mailThread, and(eq(mailThread.id, workItem.threadId), eq(mailThread.transportId, input.transportId)))
    .innerJoin(mailboxTransport, eq(mailboxTransport.id, workItem.transportId))
    .innerJoin(mailboxAccess, and(eq(mailboxAccess.transportId, mailboxTransport.id),
      eq(mailboxAccess.userId, input.actorUserId)))
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId),
      eq(message.id, input.sourceMessageId), eq(mailboxTransport.isActive, true))).limit(2);
  const row = rows.length === 1 ? rows[0] : null;
  if (!row || !row.itemThread || row.itemThread !== row.messageThread || !row.active ||
      row.itemMessage !== input.sourceMessageId || row.messageId !== input.sourceMessageId ||
      row.transportId !== input.transportId || row.actorUserId !== input.actorUserId || row.direction !== 'inbound' ||
      row.messageHistoryOnly || row.threadHistoryOnly || row.threadTrashedAt !== null ||
      row.status === 'done' || row.status === 'dismissed' || (input.threadId && row.itemThread !== input.threadId)) return null;
  if (input.sourceHash !== undefined && staffQuoteSourceHash({ id: row.messageId, subject: row.subject,
    textBody: row.textBody, htmlBody: row.htmlBody }) !== input.sourceHash) return null;
  return row.itemThread;
}
