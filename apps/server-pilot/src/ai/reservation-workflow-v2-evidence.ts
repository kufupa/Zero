import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { attachment, message } from '../db/schema/mail.js';

type WorkTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

/** Bind the usable attachment receipts and explicit missing roles, not their storage URLs. */
export async function reservationArrivalEvidence(db: WorkTx, messageId: string) {
  const [source] = await db.select({ provenance: message.sourceProvenance }).from(message)
    .where(eq(message.id, messageId)).limit(1);
  const attachments = await db.select({ sourceId: attachment.sourceAttachmentId, name: attachment.filename,
    mimeType: attachment.mimeType, bytes: attachment.sizeBytes, sha256: attachment.sha256,
    contentId: attachment.contentId, inline: attachment.isInline }).from(attachment)
    .where(eq(attachment.messageId, messageId));
  const raw = source?.provenance?.optionalMissing;
  const missing = Array.isArray(raw) ? raw.flatMap((value): { role: string; fileName: string | null }[] => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    if (typeof item.role !== 'string') return [];
    return [{ role: item.role, fileName: typeof item.fileName === 'string' ? item.fileName : null }];
  }) : [];
  const sortedAttachments = attachments.map((row) => JSON.stringify(row)).sort();
  const sortedMissing = missing.map((row) => JSON.stringify(row)).sort();
  return { hash: createHash('sha256').update(JSON.stringify([sortedAttachments, sortedMissing])).digest('hex'), missing };
}
