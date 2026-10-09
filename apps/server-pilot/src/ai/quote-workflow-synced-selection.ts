import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { attachment, message } from '../db/schema/mail.js';
import {
  readAuthorizedArtifact,
  readAuthorizedArtifactBytes,
  sniffImageBytes,
  type AttachmentLocator,
} from '../mail/artifacts/read-artifact.js';
import { getS3Storage } from '../storage/s3.js';
import { attachmentMattersForReview, isGenericAttachment, isPdfAttachment } from './quote-attachment-review.js';

export type SyncedQuoteAttachment = {
  id: string;
  filename: string;
  mimeType?: string;
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
  /** Stable DB ids of the selected message and its thread. Not part of the source hash. */
  messageId?: string;
  threadId?: string;
};

export type QuoteAttachmentRow = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isInline: boolean;
  s3Key: string;
  messageId: string;
  /** Content-ID of the part. A cid never skips a part on its own. */
  contentId?: string | null;
  /** The stored sha256. Binds an Outlook-sync original key to its bytes. */
  sha256?: string | null;
};

/** `reason: 'image'` is a logo or signature image: the caller drops it, with no warning. */
export type QuoteAttachmentReader = (
  row: QuoteAttachmentRow,
) => Promise<{ text: string | null; pdf?: Uint8Array; reason?: string }>;

export const QUOTE_ATTACHMENT_MAX_FILES = 3;
export const QUOTE_ATTACHMENT_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const OVER_LIMIT = 'over the 3 file / 5 MB analysis limit';

function reviewFacts(row: QuoteAttachmentRow) {
  return {
    filename: row.filename,
    mimeType: row.mimeType,
    byteSize: row.sizeBytes,
    isInline: row.isInline,
  };
}

/**
 * Signatures, invites, inline parts and tiny files are dropped here, so they never reach the reader or the review
 * rows. PDFs are read within the file/byte caps. A part of unknown type is read the same way, and is dropped when its
 * bytes are an image (a logo). Other kinds are listed as not read.
 */
export async function readQuoteAttachments(
  rows: QuoteAttachmentRow[],
  reader: QuoteAttachmentReader,
): Promise<SyncedQuoteAttachment[]> {
  const matters = rows.filter((row) => attachmentMattersForReview(reviewFacts(row)));
  // PDFs claim the file and byte caps first, so an unknown part cannot push a voucher out of them.
  const claimOrder = [...matters.filter(isPdfAttachment), ...matters.filter((row) => !isPdfAttachment(row))];
  let files = 0;
  let bytes = 0;
  const failures = new Map<string, string>();
  for (const row of claimOrder) {
    if (!isPdfAttachment(row) && !isGenericAttachment(row)) {
      failures.set(row.id, 'not a PDF');
    } else if (files >= QUOTE_ATTACHMENT_MAX_FILES || bytes + row.sizeBytes > QUOTE_ATTACHMENT_MAX_TOTAL_BYTES) {
      failures.set(row.id, OVER_LIMIT);
    } else {
      files += 1;
      bytes += row.sizeBytes;
    }
  }
  const results = await Promise.all(
    matters.map(async (row): Promise<SyncedQuoteAttachment | null> => {
      const base = { id: row.id, filename: row.filename, mimeType: row.mimeType, byteSize: row.sizeBytes };
      const failure = failures.get(row.id);
      if (failure) return { ...base, bytesPresent: false, readFailure: failure };
      try {
        const read = await reader(row);
        if (read.reason === 'image') return null;
        if (read.text?.trim()) return { ...base, bytesPresent: true, text: read.text };
        if (read.pdf) return { ...base, bytesPresent: true, pdf: read.pdf };
        return { ...base, bytesPresent: false, readFailure: read.reason ?? 'no readable text' };
      } catch {
        return { ...base, bytesPresent: false, readFailure: 'read failed' };
      }
    }),
  );
  return results.filter((result): result is SyncedQuoteAttachment => result !== null);
}

/** Locators come only from this mailbox's attachment rows; the caller never supplies keys. */
export function createArtifactReader(rows: QuoteAttachmentRow[], signal: AbortSignal): QuoteAttachmentReader {
  const s3 = getS3Storage();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const authorizedAttachmentIds = new Set(byId.keys());
  const resolveLocator = async (attachmentId: string): Promise<AttachmentLocator | null> => {
    const row = byId.get(attachmentId);
    return row
      ? {
          s3Key: row.s3Key,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          messageId: row.messageId,
          sha256: row.sha256 ?? null,
        }
      : null;
  };
  return async (row) => {
    const common = { attachmentId: row.id, authorizedAttachmentIds, s3, signal, resolveLocator };
    if (!isPdfAttachment(row)) {
      // A part of unknown type is a logo or a file Nava does not read. Its magic bytes say which; no text is read.
      const raw = await readAuthorizedArtifactBytes({ ...common, allowSniff: true });
      return { text: null, reason: raw && sniffImageBytes(raw.body) ? 'image' : 'not a PDF' };
    }
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
      contentId: attachment.contentId,
      sha256: attachment.sha256,
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
    messageId: row.id,
    threadId: row.threadId,
  };
}
