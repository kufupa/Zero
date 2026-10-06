import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { attachment, message } from '../db/schema/mail.js';

export type SyncedQuoteSelection = {
  subject: string;
  bodyText: string;
  preceding: Array<{ bodyText: string }>;
  attachments: Array<{
    id: string;
    filename: string;
    byteSize?: number;
    text?: string;
    bytesPresent: boolean;
  }>;
};

/**
 * Mailbox-scoped, PMS-free selection load for `quoteWorkflow.analyseSelection`.
 *
 * Bind targets on this branch (`origin/main`):
 * - `message` rows for `ctx.activeTransportId` + `messageIdHeader`
 * - preceding same-thread messages with `receivedAt <= selected.receivedAt`
 * - `attachment` identity (id, filename, size). S3 bodies are not fetched here:
 *   production-bucket reads are out of overnight scope; missing bytes stay missing.
 *
 * Not bound (must not be faked as analysis-only):
 * - `ai.enqueueHmsRead` / `hms_quote_stay`
 * - sibling `qualifiedProposalChoices` / `qualifiedQuoteProposalPdf` (not on main)
 */
export async function loadSyncedQuoteSelectionFromMailbox(input: {
  transportId: string;
  internetMessageId?: string;
}): Promise<SyncedQuoteSelection | null> {
  const internetMessageId = input.internetMessageId?.trim();
  if (!internetMessageId) return null;
  let db;
  try {
    db = getDb();
  } catch {
    return null;
  }
  const selected = await db
    .select({
      id: message.id,
      threadId: message.threadId,
      subject: message.subject,
      textBody: message.textBody,
      receivedAt: message.receivedAt,
    })
    .from(message)
    .where(
      and(eq(message.transportId, input.transportId), eq(message.messageIdHeader, internetMessageId)),
    )
    .limit(1);
  const row = selected[0];
  if (!row) return null;

  const threadRows = await db
    .select({
      id: message.id,
      textBody: message.textBody,
      receivedAt: message.receivedAt,
    })
    .from(message)
    .where(and(eq(message.transportId, input.transportId), eq(message.threadId, row.threadId)));

  const preceding = threadRows
    .filter((candidate) => candidate.id !== row.id)
    .filter((candidate) => {
      if (!row.receivedAt || !candidate.receivedAt) return false;
      return candidate.receivedAt.getTime() <= row.receivedAt.getTime();
    })
    .map((candidate) => ({ bodyText: candidate.textBody ?? '' }));

  const attachments = await db
    .select({
      id: attachment.id,
      filename: attachment.filename,
      sizeBytes: attachment.sizeBytes,
    })
    .from(attachment)
    .where(eq(attachment.messageId, row.id));

  return {
    subject: row.subject ?? '',
    bodyText: row.textBody ?? '',
    preceding,
    attachments: attachments.map((part) => ({
      id: part.id,
      filename: part.filename,
      byteSize: part.sizeBytes,
      bytesPresent: false,
    })),
  };
}
