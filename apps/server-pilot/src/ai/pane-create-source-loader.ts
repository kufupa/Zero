import { isDeepStrictEqual } from 'node:util';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { attachment, message } from '../db/schema/mail.js';
import { mailExtraction, workEvent, workItem } from '../db/schema/work.js';
import { lockCanonicalMailbox } from '../mail/ingest/canonical-identity.js';
import type { CreateFenceTransaction } from './pane-create-dispatch-fence.js';
import { createSourceSnapshotDigest, type CreateSourceSnapshot, type HistoricalCorrection } from './pane-create-source-snapshot.js';

const text = z.string().min(1).max(200).refine((value) => value === value.trim() &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
const cursorSchema = z.object({ extractionId: z.string().uuid(), revision: z.number().int().nonnegative().safe(),
  revisionHead: z.number().int().nonnegative().safe(), seq: z.number().int().nonnegative().safe() }).strict()
  .refine((cursor) => cursor.revision <= cursor.revisionHead);
const sourceKeySchema = z.object({ transportId: text, threadId: text, messageId: text,
  workItemId: z.string().uuid(), cursor: cursorSchema }).strict();
const MAX_SOURCE_ROWS = 512;

export type LockedCreateSource = {
  snapshot: CreateSourceSnapshot;
  sourceDigest: string;
  historicalEventIds: string[];
  item: typeof workItem.$inferSelect;
};

/**
 * Source locking and fingerprinting only, not authentication, staff approval,
 * fence ownership or native dispatch authority. The caller authenticates the
 * mailbox and binds the returned digest, cursor and event IDs to its grant.
 *
 * The callback runs inside this transaction. Mailbox, message, all message
 * extraction rows (including prior versions), attachments and item are locked
 * in that order. Translation and source rows remain locked through the callback.
 * Do not acquire these locks again through a second connection in the callback.
 * Query correction events only after the item lock and refuse a linked extraction
 * not in the locked set. Eligible field event writers must hold the item lock.
 * Neither metadata hashes nor this lock prove current object-store bytes.
 */
export async function withLockedCreateSource<T>(
  db: DB,
  raw: z.input<typeof sourceKeySchema>,
  continuation: (tx: CreateFenceTransaction, source: LockedCreateSource) => Promise<T>,
): Promise<T> {
  const input = sourceKeySchema.parse(raw);
  return db.transaction(async (tx) => {
    await lockCanonicalMailbox(tx as unknown as DB, input.transportId);
    const [source] = await tx.select().from(message)
      .where(and(eq(message.id, input.messageId), eq(message.transportId, input.transportId)))
      .limit(1).for('update');
    if (!source || source.threadId !== input.threadId) throw new Error('create_source_stale');

    const extractions = await tx.select().from(mailExtraction)
      .where(eq(mailExtraction.messageId, source.id)).orderBy(mailExtraction.id)
      .limit(MAX_SOURCE_ROWS + 1).for('update');
    if (extractions.length > MAX_SOURCE_ROWS) throw new Error('create_source_history_incomplete');
    const byId = new Map(extractions.map((row) => [row.id, row]));
    const extraction = byId.get(input.cursor.extractionId);
    if (!extraction) throw new Error('create_source_stale');

    const attachments = await tx.select().from(attachment)
      .where(eq(attachment.messageId, source.id)).orderBy(attachment.id)
      .limit(MAX_SOURCE_ROWS + 1).for('update');
    if (attachments.length > MAX_SOURCE_ROWS) throw new Error('create_source_history_incomplete');

    const [item] = await tx.select().from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1).for('update');
    if (!item || item.id !== input.workItemId || item.transportId !== input.transportId ||
        item.threadId !== input.threadId || item.sourceMessageId !== source.id ||
        item.extractionId !== input.cursor.extractionId || item.revision !== input.cursor.revision ||
        item.revisionHead !== input.cursor.revisionHead || item.revisionSeq !== input.cursor.seq ||
        item.status === 'done' || item.status === 'dismissed') throw new Error('create_source_stale');

    // This scan follows the item lock. Qualified event writers serialize on that
    // lock; historical events are append-only and extractions are still locked.
    const candidates = await tx.select({ event: workEvent, extractionId: mailExtraction.id }).from(workEvent)
      .innerJoin(mailExtraction, and(eq(mailExtraction.messageId, source.id),
        sql`${mailExtraction.id}::text = ${workEvent.evidence}->>'extractionId'`,
        eq(mailExtraction.extractorVersion, workEvent.aiSource), eq(mailExtraction.status, 'succeeded')))
      .where(and(eq(workEvent.workItemId, item.id), eq(workEvent.actorKind, 'user'),
        inArray(workEvent.type, ['field.edit', 'field.reject'])))
      .limit(MAX_SOURCE_ROWS + 1);
    if (candidates.length > MAX_SOURCE_ROWS) throw new Error('create_source_history_incomplete');
    const historicalCorrections: HistoricalCorrection[] = candidates.flatMap(({ event, extractionId }) => {
      const historic = byId.get(extractionId);
      if (!historic) throw new Error('create_source_history_unlocked');
      const evidence = event.evidence;
      if (!event.actorUserId || !event.fieldPath || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [];
      const proof = evidence as Record<string, unknown>, pane = proof.paneState;
      if (proof.extractionId !== historic.id || !Number.isSafeInteger(proof.paneSeq) || (proof.paneSeq as number) < 1 ||
          !pane || typeof pane !== 'object' || Array.isArray(pane) || !Object.hasOwn(pane, event.fieldPath) ||
          !isDeepStrictEqual((pane as Record<string, unknown>)[event.fieldPath], event.value)) return [];
      return [{ event, extraction: historic }];
    });
    const snapshot = { source, extraction, attachments, historicalCorrections };
    const sourceDigest = createSourceSnapshotDigest(snapshot);
    const historicalEventIds = historicalCorrections.map(({ event }) => event.id).sort();
    return continuation(tx, { snapshot, sourceDigest, historicalEventIds, item });
  });
}
