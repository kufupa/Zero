import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { message } from '../db/schema/mail.js';
import { outlookSyncObservation, outlookSyncSource } from '../db/schema/outlook-sync.js';
import { outlookDevice, outlookDeviceReadRoot } from '../db/schema/outlook-device.js';
import { canonicalMessageId } from './ingest/message-id.js';

/** Web uses stored IDs; Outlook uses its native locator or an approved mailbox copy. */
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
export function paneSourceSelectionCondition(selection?: PaneSourceSelection,
  mailboxCopy?: { userId: string; internetMessageId?: string }): SQL | undefined {
  if (!selection) return undefined;
  if (selection.kind === 'web') {
    return and(eq(message.id, selection.messageId), eq(message.threadId, selection.threadId));
  }
  // Reconciled Outlook observations may point to an existing POP3 message without copying their locator onto it.
  // Match only committed, unambiguous provenance and let the caller reject multiple canonical messages.
  const locator = sql`
      ${outlookSyncSource.transportId} = ${message.transportId}
      and ${outlookSyncSource.storeId} = ${selection.storeId}
      and ${outlookSyncObservation.ingestionState} = 'committed'
      and ${outlookSyncObservation.evidence} #>> '{locator,storeId}' = ${selection.storeId}
      and ${outlookSyncObservation.evidence} #>> '{locator,entryId}' = ${selection.entryId}
      ${selection.folderEntryId !== undefined ? sql`and ${outlookSyncObservation.evidence} #>> '{locator,folderEntryId}' = ${selection.folderEntryId}` : sql``}`;
  const committed = sql`exists (
    select 1 from ${outlookSyncObservation}
    inner join ${outlookSyncSource} on ${outlookSyncSource.id} = ${outlookSyncObservation.sourceId}
    where ${outlookSyncObservation.canonicalMessageId} = ${message.id}
      and ${locator} and ${outlookSyncObservation.direction} = ${message.direction}::text
  )`;
  const header = canonicalMessageId(mailboxCopy?.internetMessageId);
  if (!mailboxCopy?.userId || !header) return committed;
  // POP3/BCC admission and prefill can finish before native sync. Reading that
  // stored copy needs an approved store and an exact, unique mailbox Message-ID,
  // not a second upload. Callers reject multiple rows; subject/date are never keys.
  return or(committed, and(eq(message.messageIdHeader, header), sql`not exists (
    select 1 from ${message} as mailbox_copy
    where mailbox_copy.transport_id = ${message.transportId}
      and mailbox_copy.message_id_header = ${header} and mailbox_copy.id <> ${message.id}
  )`, sql`exists (
    select 1 from ${outlookDeviceReadRoot}
    inner join ${outlookDevice} on ${outlookDevice.deviceId} = ${outlookDeviceReadRoot.deviceId}
    where ${outlookDeviceReadRoot.userId} = ${mailboxCopy.userId}
      and ${outlookDeviceReadRoot.transportId} = ${message.transportId}
      and ${outlookDeviceReadRoot.storeId} = ${selection.storeId}
      and ${outlookDeviceReadRoot.revokedAt} is null and ${outlookDevice.revokedAt} is null
  )`, sql`not exists (
    select 1 from ${outlookSyncObservation}
    inner join ${outlookSyncSource} on ${outlookSyncSource.id} = ${outlookSyncObservation.sourceId}
    where ${locator} and ${outlookSyncObservation.canonicalMessageId} is not null
  )`));
}
