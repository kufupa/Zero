import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { attachment, message } from '../db/schema/mail.js';
import {
  readAuthorizedArtifact,
  readAuthorizedArtifactBytes,
  type AttachmentLocator,
} from '../mail/artifacts/read-artifact.js';
import { getS3Storage } from '../storage/s3.js';

export type SyncedQuoteAttachment = {
  id: string;
  filename: string;
  byteSize?: number;
  text?: string;
  /** Scanned PDF bytes for the model when pdftotext found no text. Never serialised. */
  pdf?: Uint8Array;
  bytesPresent: boolean;
  /** Why staff must review this attachment themselves. */
  readFailure?: string;
};

export type SyncedQuoteSelection = {
  subject: string;
  bodyText: string;
  /** Selected message receipt time; anchors year inference. */
  receivedAt?: string;
  preceding: Array<{ bodyText: string }>;
  attachments: SyncedQuoteAttachment[];
};

export type QuoteAttachmentRow = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isInline: boolean;
  s3Key: string;
  messageId: string;
};

export type QuoteAttachmentReader = (
  row: QuoteAttachmentRow,
) => Promise<{ text: string | null; pdf?: Uint8Array; reason?: string }>;

export const QUOTE_ATTACHMENT_MAX_FILES = 3;
export const QUOTE_ATTACHMENT_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const OVER_LIMIT = 'over the 3 file / 5 MB analysis limit';

function isPdf(row: QuoteAttachmentRow): boolean {
  return row.mimeType === 'application/pdf' || /\.pdf$/i.test(row.filename);
}

/** Inline parts are dropped; only non-inline PDFs are read, within the file/byte caps. */
export async function readQuoteAttachments(
  rows: QuoteAttachmentRow[],
  reader: QuoteAttachmentReader,
): Promise<SyncedQuoteAttachment[]> {
  let files = 0;
  let bytes = 0;
  const plan = rows
    .filter((row) => !row.isInline)
    .map((row) => {
      if (!isPdf(row)) return { row, failure: 'not a PDF' };
      if (files >= QUOTE_ATTACHMENT_MAX_FILES || bytes + row.sizeBytes > QUOTE_ATTACHMENT_MAX_TOTAL_BYTES) {
        return { row, failure: OVER_LIMIT };
      }
      files += 1;
      bytes += row.sizeBytes;
      return { row, failure: undefined };
    });
  return Promise.all(
    plan.map(async ({ row, failure }): Promise<SyncedQuoteAttachment> => {
      const base = { id: row.id, filename: row.filename, byteSize: row.sizeBytes };
      if (failure) return { ...base, bytesPresent: false, readFailure: failure };
      try {
        const read = await reader(row);
        if (read.text?.trim()) return { ...base, bytesPresent: true, text: read.text };
        if (read.pdf) return { ...base, bytesPresent: true, pdf: read.pdf };
        return { ...base, bytesPresent: false, readFailure: read.reason ?? 'no readable text' };
      } catch {
        return { ...base, bytesPresent: false, readFailure: 'read failed' };
      }
    }),
  );
}

/** Locators come only from this mailbox's attachment rows; the caller never supplies keys. */
function createArtifactReader(rows: QuoteAttachmentRow[], signal: AbortSignal): QuoteAttachmentReader {
  const s3 = getS3Storage();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const authorizedAttachmentIds = new Set(byId.keys());
  const resolveLocator = async (attachmentId: string): Promise<AttachmentLocator | null> => {
    const row = byId.get(attachmentId);
    return row
      ? { s3Key: row.s3Key, mimeType: row.mimeType, sizeBytes: row.sizeBytes, messageId: row.messageId }
      : null;
  };
  return async (row) => {
    const common = { attachmentId: row.id, authorizedAttachmentIds, s3, signal, resolveLocator };
    const result = await readAuthorizedArtifact(common);
    if (result.data.text?.trim()) return { text: result.data.text };
    if (result.data.reason === 'no_embedded_text') {
      const raw = await readAuthorizedArtifactBytes(common);
      if (raw) return { text: null, pdf: new Uint8Array(raw.body) };
    }
    return { text: null, reason: result.data.reason.replaceAll('_', ' ') };
  };
}

/**
 * Causal preceding: same authorised mailbox thread, received at or before
 * the selected message, oldest first. Later replies are excluded. Missing
 * receivedAt is not treated as earlier.
 */
export function orderCausalPreceding(
  selected: { id: string; receivedAt: Date | null },
  threadRows: Array<{ id: string; textBody: string | null; receivedAt: Date | null }>,
): Array<{ bodyText: string }> {
  const selectedAt = selected.receivedAt?.getTime();
  if (selectedAt === undefined) return [];
  return threadRows
    .filter((candidate) => candidate.id !== selected.id)
    .filter((candidate) => {
      if (!candidate.receivedAt) return false;
      return candidate.receivedAt.getTime() <= selectedAt;
    })
    .sort((left, right) => {
      const delta = (left.receivedAt?.getTime() ?? 0) - (right.receivedAt?.getTime() ?? 0);
      if (delta !== 0) return delta;
      return left.id.localeCompare(right.id);
    })
    .map((candidate) => ({ bodyText: candidate.textBody ?? '' }));
}

/**
 * Mailbox-scoped, PMS-free selection load for `quoteWorkflow.analyseSelection`.
 *
 * Bind targets on this branch (`origin/main`):
 * - `message` rows for `ctx.activeTransportId` + `messageIdHeader`
 * - preceding same-thread messages with `receivedAt <= selected.receivedAt`, oldest first
 * - non-inline PDF attachments of that message, read via `readAuthorizedArtifact`
 *   (pdftotext) with locators from those rows only; failures become `readFailure`.
 *
 * Not bound (must not be faked as analysis-only):
 * - `ai.enqueueHmsRead` / `hms_quote_stay`
 * - sibling `qualifiedProposalChoices` / `qualifiedQuoteProposalPdf` (not on main)
 * This loader is not the reservationist agent.
 */
export async function loadSyncedQuoteSelectionFromMailbox(input: {
  transportId: string;
  internetMessageId?: string;
  signal?: AbortSignal;
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
    .limit(2);
  const row = selected[0];
  if (!row || selected.length !== 1) return null;

  const threadRows = await db
    .select({
      id: message.id,
      textBody: message.textBody,
      receivedAt: message.receivedAt,
    })
    .from(message)
    .where(and(eq(message.transportId, input.transportId), eq(message.threadId, row.threadId)));

  const preceding = orderCausalPreceding(row, threadRows);

  const rows = await db
    .select({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      isInline: attachment.isInline,
      s3Key: attachment.s3Key,
      messageId: attachment.messageId,
    })
    .from(attachment)
    .where(eq(attachment.messageId, row.id))
    .orderBy(asc(attachment.id));

  const signal = input.signal ?? AbortSignal.timeout(15_000);
  let reader: QuoteAttachmentReader;
  try {
    reader = createArtifactReader(rows, signal);
  } catch {
    reader = async () => ({ text: null, reason: 'storage unavailable' });
  }

  return {
    subject: row.subject ?? '',
    bodyText: row.textBody ?? '',
    receivedAt: row.receivedAt?.toISOString(),
    preceding,
    attachments: await readQuoteAttachments(rows, reader),
  };
}
