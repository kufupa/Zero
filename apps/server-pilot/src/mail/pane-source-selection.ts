import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { message } from '../db/schema/mail.js';
import { outlookSyncObservation, outlookSyncSource } from '../db/schema/outlook-sync.js';

/** Web uses canonical IDs; Outlook uses only its native synced locator. */
export const paneSourceSelectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('web'),
    messageId: z.string().min(1).max(512),
    threadId: z.string().min(1).max(512),
  }).strict(),
  z.object({
    kind: z.literal('outlook'),
    storeId: z.string().min(1).max(2048),
    entryId: z.string().min(1).max(512),
    folderEntryId: z.string().min(1).max(512).optional(),
  }).strict(),
]);
export type PaneSourceSelection = z.infer<typeof paneSourceSelectionSchema>;

/** Additional scope for a query already restricted to the mailbox and canonical RFC Message-ID. */
export function paneSourceSelectionCondition(selection?: PaneSourceSelection): SQL | undefined {
  if (!selection) return undefined;
  if (selection.kind === 'web') {
    return and(eq(message.id, selection.messageId), eq(message.threadId, selection.threadId));
  }
  // Reconciled Outlook observations may point to an existing POP3 message without copying their locator onto it.
  // Match only committed, unambiguous provenance and let the caller reject multiple canonical messages.
  return sql`exists (
    select 1 from ${outlookSyncObservation}
    inner join ${outlookSyncSource} on ${outlookSyncSource.id} = ${outlookSyncObservation.sourceId}
    where ${outlookSyncObservation.canonicalMessageId} = ${message.id}
      and ${outlookSyncSource.transportId} = ${message.transportId}
      and ${outlookSyncSource.storeId} = ${selection.storeId}
      and ${outlookSyncObservation.ingestionState} = 'committed'
      and ${outlookSyncObservation.direction} = ${message.direction}::text
      and ${outlookSyncObservation.evidence} #>> '{locator,storeId}' = ${selection.storeId}
      and ${outlookSyncObservation.evidence} #>> '{locator,entryId}' = ${selection.entryId}
      ${selection.folderEntryId !== undefined ? sql`and ${outlookSyncObservation.evidence} #>> '{locator,folderEntryId}' = ${selection.folderEntryId}` : sql``}
  )`;
}
