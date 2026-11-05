import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { mailThread, message } from '../db/schema/mail.js';
import { mailExtraction, workItem } from '../db/schema/work.js';
import { lockCanonicalMailbox } from '../mail/ingest/canonical-identity.js';
import { canonicalJson } from './draft-approval.js';
import type { CreateFenceTransaction } from './pane-create-dispatch-fence.js';

const id = z.string().min(1).max(200).refine((value) => value === value.trim() && !/\p{Cc}/u.test(value));
const cursorSchema = z.object({ extractionId: z.string().uuid(), revision: z.number().int().nonnegative().safe(),
  revisionHead: z.number().int().nonnegative().safe(), seq: z.number().int().nonnegative().safe() }).strict()
  .refine((cursor) => cursor.revision <= cursor.revisionHead);
const keySchema = z.object({ transportId: id, threadId: id, messageId: id, workItemId: z.string().uuid(), cursor: cursorSchema }).strict();

export type LockedCreateSource = {
  snapshot: { source: typeof message.$inferSelect; extraction: typeof mailExtraction.$inferSelect };
  sourceDigest: string;
  item: typeof workItem.$inferSelect;
};

/**
 * Lock the selected source and current item under the caller's transaction.
 * Create approves the reviewed form, not attachment bytes or older extractions.
 * Filing has a separate byte/provenance contract. Lock order matches ingestion:
 * canonical mailbox, active thread, message, referenced extraction, then work item.
 */
export async function lockCreateSource<T>(tx: CreateFenceTransaction, raw: z.input<typeof keySchema>,
  continuation: (tx: CreateFenceTransaction, source: LockedCreateSource) => Promise<T>): Promise<T> {
  const input = keySchema.parse(raw);
  await lockCanonicalMailbox(tx as unknown as DB, input.transportId);
  const [thread] = await tx.select({ id: mailThread.id, transportId: mailThread.transportId,
    historyOnly: mailThread.historyOnly, trashedAt: mailThread.trashedAt }).from(mailThread)
    .where(and(eq(mailThread.id, input.threadId), eq(mailThread.transportId, input.transportId)))
    .limit(1).for('share');
  if (!thread || thread.historyOnly || thread.trashedAt !== null) throw new Error('create_source_stale');
  const [source] = await tx.select().from(message)
    .where(and(eq(message.id, input.messageId), eq(message.transportId, input.transportId)))
    .limit(1).for('no key update');
  if (!source || source.threadId !== input.threadId || source.direction !== 'inbound' || source.historyOnly) {
    throw new Error('create_source_stale');
  }
  const [extraction] = await tx.select().from(mailExtraction)
    .where(and(eq(mailExtraction.id, input.cursor.extractionId), eq(mailExtraction.messageId, source.id),
      eq(mailExtraction.status, 'succeeded'))).limit(1).for('no key update');
  if (!extraction) throw new Error('create_source_stale');
  const [item] = await tx.select().from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
    .limit(1).for('update');
  if (!item || item.threadId !== input.threadId || item.sourceMessageId !== source.id ||
      item.extractionId !== extraction.id || item.revision !== input.cursor.revision ||
      item.revisionHead !== input.cursor.revisionHead || item.revisionSeq !== input.cursor.seq ||
      item.status === 'done' || item.status === 'dismissed') throw new Error('create_source_stale');

  const sourceDigest = createHash('sha256').update(canonicalJson({
    message: { id: source.id, transportId: source.transportId, threadId: source.threadId, direction: source.direction,
      historyOnly: source.historyOnly, fromAddress: source.fromAddress, ownerHeaderValue: source.ownerHeaderValue,
      toAddresses: source.toAddresses, ccAddresses: source.ccAddresses, subject: source.subject,
      textBody: source.textBody, htmlBody: source.htmlBody },
    extraction: { id: extraction.id, messageId: extraction.messageId, status: extraction.status,
      extractorVersion: extraction.extractorVersion, kind: extraction.kind, language: extraction.language,
      payload: extraction.payload, translation: extraction.translation, attachments: extraction.attachments },
  })).digest('hex');
  return continuation(tx, { snapshot: { source, extraction }, sourceDigest, item });
}

export async function withLockedCreateSource<T>(db: DB, raw: z.input<typeof keySchema>,
  continuation: (tx: CreateFenceTransaction, source: LockedCreateSource) => Promise<T>): Promise<T> {
  return db.transaction((tx) => lockCreateSource(tx, raw, continuation), { isolationLevel: 'read committed' });
}
