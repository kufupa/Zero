import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { attachment, message } from '../db/schema/mail.js';
import { MESSAGE_ARRIVED_AT } from './message-arrival-time.js';
import { orderThreadContext } from './quote-workflow-synced-selection.js';

type WorkTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

/** Bind the same causal thread evidence used by prefill, without loading attachment bytes. */
export async function reservationArrivalEvidence(db: WorkTx, messageId: string) {
  const fields = { id: message.id, threadId: message.threadId, transportId: message.transportId,
    direction: message.direction, subject: message.subject, textBody: message.textBody,
    receivedAt: message.receivedAt, sentAt: message.sentAt, createdAt: message.createdAt,
    arrivedAt: MESSAGE_ARRIVED_AT, provenance: message.sourceProvenance };
  const [source] = await db.select(fields).from(message)
    .where(eq(message.id, messageId)).limit(1);
  const thread = source ? await db.select(fields).from(message)
    .where(and(eq(message.transportId, source.transportId), eq(message.threadId, source.threadId))) : [];
  const prior = source ? orderThreadContext(source, thread) : [];
  const admitted = new Set([messageId, ...prior.flatMap((row) => row.messageId ? [row.messageId] : [])]);
  const attachments = await db.select({ messageId: attachment.messageId, sourceId: attachment.sourceAttachmentId, name: attachment.filename,
    mimeType: attachment.mimeType, bytes: attachment.sizeBytes, sha256: attachment.sha256,
    contentId: attachment.contentId, inline: attachment.isInline }).from(attachment)
    .where(inArray(attachment.messageId, [...admitted]));
  const missingWithParent = thread.filter((row) => admitted.has(row.id)).flatMap((row) => {
    const raw = row.provenance?.optionalMissing;
    return Array.isArray(raw) ? raw.flatMap((value): { messageId: string; role: string; fileName: string | null }[] => {
      if (!value || typeof value !== 'object') return [];
      const item = value as Record<string, unknown>;
      if (typeof item.role !== 'string') return [];
      return [{ messageId: row.id, role: item.role, fileName: typeof item.fileName === 'string' ? item.fileName : null }];
    }) : [];
  });
  const missing = missingWithParent.map(({ role, fileName }) => ({ role, fileName }));
  const sortedAttachments = attachments.map((row) => JSON.stringify(row)).sort();
  const sortedMissing = missingWithParent.map((row) => JSON.stringify(row)).sort();
  return { hash: createHash('sha256').update(JSON.stringify(['reservation-arrival-evidence/2', prior,
    sortedAttachments, sortedMissing])).digest('hex'), missing };
}
