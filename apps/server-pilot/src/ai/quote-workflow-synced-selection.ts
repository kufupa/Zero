import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { attachment, message } from '../db/schema/mail.js';
import {
  readAuthorizedArtifact,
  readAuthorizedArtifactBytes,
  isDocxMimeType,
  sniffImageBytes,
  type AttachmentLocator,
  type SandboxRunner,
} from '../mail/artifacts/read-artifact.js';
import { getS3Storage } from '../storage/s3.js';
import { confirmationBase } from '../hms/confirmation-match.js';
import { convertDocxWithGotenberg } from '../quote-proposal/gotenberg.js';
import {
  extractReservationistOfficeText,
  type ReservationistOfficeConverter,
} from './reservationist-attachment-input.js';
import { attachmentMattersForReview, isGenericAttachment, isPdfAttachment } from './quote-attachment-review.js';

export type SyncedQuoteAttachment = {
  id: string;
  filename: string;
  mimeType?: string;
  byteSize?: number;
  text?: string;
  /** Scanned PDF bytes for the model when pdftotext found no text. Never serialised. */
  pdf?: Uint8Array;
  /** Non-inline PNG/JPEG source bytes for extraction-only vision. Never serialised. */
  image?: { mediaType: 'image/png' | 'image/jpeg'; data: Uint8Array };
  /** Preserved for extraction vision admission; other callers may ignore it. */
  isInline?: boolean;
  bytesPresent: boolean;
  /** Why staff must review this attachment themselves. */
  readFailure?: string;
};

export type SyncedThreadMessage = {
  direction: 'inbound' | 'outbound';
  timestamp?: string;
  subject: string;
  bodyText: string;
};

export type SyncedQuoteSelection = {
  subject: string;
  bodyText: string;
  /** Selected message receipt time; anchors year inference. */
  receivedAt?: string;
  /** Selected message's best stored time for finding its closest thread neighbours when receivedAt is missing. */
  threadReferenceAt?: string;
  preceding: Array<{ bodyText: string; direction?: 'inbound' | 'outbound' }>;
  /** Optional full thread state, limited to prior messages, for inbound action classification. */
  threadMessages?: SyncedThreadMessage[];
  attachments: SyncedQuoteAttachment[];
  /** Stable DB ids of the selected message and its thread. Not part of the source hash. */
  messageId?: string;
  threadId?: string;
  /** Sender address of the selected message. Only the route reads it, to flag no-reply senders, so it is not hashed. */
  fromAddress?: string;
  /** Sibling/later confirmation files. Not guest-request body or `attachments`. */
  threadConfirmation?: ThreadConfirmationResolution;
};

const HMS_CONFIRMATION = /^\d{6,10}-\d{1,2}$/;
const DASHED_CONFIRMATION = /(?<![0-9])(\d{6,10}-\d{1,2})(?![0-9])/g;
/** Labelled 8–10 digit bases only: conf/confirmation/booking/res/reservation no/number. */
const LABELLED_BARE_BASE =
  /\b(?:conf(?:irmation)?|booking|res(?:ervation)?)\s*(?:#|n[o°º.]?|number)?\s*[:#]?\s*(\d{8,10})(?![0-9-])/gi;
/** Subject/thread `#88001122` tags. */
const HASH_BARE_BASE = /(?:^|[^\w])#(\d{8,10})(?![0-9-])/g;
/** Confirmation-letter `n°88001122` / `nº…-1`. Not VAT/Reg/Tax/Company/Account n°. */
const N_DEGREE_BARE_BASE =
  /(?<!(?:\b(?:VAT|Reg(?:istration)?|Tax|Company|Acc(?:ount)?)\b|Co\.?\s*Reg)[^\n]{0,25})\bn[°º]\s*(\d{6,10}(?:-\d{1,4})?)(?![0-9-])/gi;

export const THREAD_CONFIRMATION_AMBIGUOUS =
  'This thread has more than one booking number on its confirmation files. Check HMS for the right one.';

export type ThreadConfirmationResolution = {
  confirmation: string | null;
  reason: string | null;
};

export function isHmsConfirmation(value: string): boolean {
  return HMS_CONFIRMATION.test(value);
}

function isSkippedBareBase(token: string): boolean {
  return /^0\d+$/.test(token) || /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(token);
}

function collectDashedConfirmations(text: string, dashed: Set<string>): void {
  DASHED_CONFIRMATION.lastIndex = 0;
  for (const match of text.matchAll(DASHED_CONFIRMATION)) dashed.add(match[1]!);
}

function collectLabelledBareBases(text: string, bare: Set<string>): void {
  for (const re of [LABELLED_BARE_BASE, HASH_BARE_BASE, N_DEGREE_BARE_BASE]) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const token = match[1]!;
      if (isSkippedBareBase(token)) continue;
      bare.add(token);
    }
  }
}

export function resolveThreadConfirmationEvidence(
  sources: Array<{ filename: string; text?: string }>,
): ThreadConfirmationResolution {
  const dashed = new Set<string>();
  const labelledBare = new Set<string>();
  for (const source of sources) {
    collectDashedConfirmations(source.filename, dashed);
    if (source.text) {
      collectDashedConfirmations(source.text, dashed);
      collectLabelledBareBases(source.text, labelledBare);
    }
  }
  if (dashed.size === 1) {
    const only = [...dashed][0]!;
    const dashedBase = confirmationBase(only);
    if ([...labelledBare].some((base) => confirmationBase(base) !== dashedBase)) {
      return { confirmation: null, reason: THREAD_CONFIRMATION_AMBIGUOUS };
    }
    return { confirmation: only, reason: null };
  }
  if (dashed.size > 1) {
    return { confirmation: null, reason: THREAD_CONFIRMATION_AMBIGUOUS };
  }
  if (labelledBare.size === 1) {
    return { confirmation: [...labelledBare][0]!, reason: null };
  }
  return { confirmation: null, reason: null };
}

export function overlayHmsConfirmation(
  selected: string | null | undefined,
  evidence?: ThreadConfirmationResolution,
): ThreadConfirmationResolution {
  const trimmed = selected?.trim() || null;
  if (trimmed && isHmsConfirmation(trimmed)) return { confirmation: trimmed, reason: null };
  if (!evidence) return { confirmation: trimmed, reason: null };
  if (evidence.confirmation) return { confirmation: evidence.confirmation, reason: null };
  if (evidence.reason) return { confirmation: null, reason: evidence.reason };
  return { confirmation: trimmed, reason: null };
}

export type OverlayPayload = {
  luna?: { confirmationNumber?: string | null; missing?: Array<{ field: string; question: string }> } | null;
  amendment?: { confirmationNumber: string | null } | null;
  reviewItems?: Array<Record<string, unknown>>;
};

export function applyThreadConfirmationOverlay<T extends OverlayPayload>(
  payload: T,
  evidence: ThreadConfirmationResolution | undefined,
): T {
  if (evidence === undefined) return payload;
  const current = payload.luna?.confirmationNumber ?? payload.amendment?.confirmationNumber ?? null;
  const overlaid = overlayHmsConfirmation(current, evidence);
  if (overlaid.confirmation === current && !overlaid.reason) return payload;
  const missing = payload.luna?.missing ?? [];
  return {
    ...payload,
    luna: payload.luna
      ? {
          ...payload.luna,
          confirmationNumber: overlaid.confirmation,
          missing:
            overlaid.reason && !missing.some((item) => item.field === 'confirmationNumber')
              ? [...missing, { field: 'confirmationNumber', question: overlaid.reason }]
              : payload.luna.missing,
        }
      : payload.luna,
    amendment: payload.amendment
      ? { ...payload.amendment, confirmationNumber: overlaid.confirmation }
      : payload.amendment,
    reviewItems:
      overlaid.reason && payload.reviewItems
        ? [
            ...payload.reviewItems,
            {
              id: 'missing:confirmationNumber:thread',
              kind: 'question',
              rank: 'secondary',
              text: overlaid.reason,
              sourceLabel: 'confirmationNumber',
              blocking: false,
            },
          ]
        : payload.reviewItems,
  };
}

const ATTACHMENT_SELECT = {
  id: attachment.id,
  filename: attachment.filename,
  mimeType: attachment.mimeType,
  sizeBytes: attachment.sizeBytes,
  isInline: attachment.isInline,
  contentId: attachment.contentId,
  sha256: attachment.sha256,
  s3Key: attachment.s3Key,
  messageId: attachment.messageId,
};

async function readerForRows(
  rows: QuoteAttachmentRow[],
  transportId: string,
  signal: AbortSignal,
  options: { includeVisionImages?: boolean } = {},
): Promise<QuoteAttachmentReader> {
  try {
    return createArtifactReader(rows, signal, {
      revalidateOffice: (officeRow) => revalidateOfficeAttachment(officeRow, transportId),
      includeVisionImages: options.includeVisionImages,
      transportId,
    });
  } catch {
    return async () => ({ text: null, reason: 'storage unavailable' });
  }
}

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
) => Promise<{
  text: string | null;
  pdf?: Uint8Array;
  image?: { mediaType: 'image/png' | 'image/jpeg'; data: Uint8Array };
  reason?: string;
}>;

export const QUOTE_ATTACHMENT_MAX_FILES = 3;
export const QUOTE_ATTACHMENT_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const OVER_LIMIT = 'over the 3 file / 5 MB analysis limit';
const VISION_IMAGE_MIN_BYTES = 20 * 1024;
const VISION_MAX_DIRECT_IMAGES = 4;

type ArtifactReaderOptions = {
  revalidateOffice?: (row: QuoteAttachmentRow) => Promise<boolean>;
  officeConverter?: ReservationistOfficeConverter;
  runner?: SandboxRunner;
  includeVisionImages?: boolean;
  transportId?: string;
};

function rasterMediaType(row: Pick<QuoteAttachmentRow, 'mimeType'>): 'image/png' | 'image/jpeg' | null {
  const mimeType = row.mimeType.split(';')[0]?.trim().toLowerCase();
  return mimeType === 'image/png' || mimeType === 'image/jpeg' ? mimeType : null;
}

function isPngJpegAttachment(row: QuoteAttachmentRow): boolean {
  return !row.isInline && rasterMediaType(row) !== null;
}

function imageBytesMatchMediaType(body: Buffer, mediaType: 'image/png' | 'image/jpeg'): boolean {
  if (mediaType === 'image/png') {
    return body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
}

function isDocxAttachment(row: Pick<QuoteAttachmentRow, 'mimeType'>): boolean {
  return isDocxMimeType(row.mimeType);
}

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
 * rows. PDFs and DOCX request files are read within the file/byte caps. A part of unknown type is read the same way,
 * and is dropped when its bytes are an image (a logo). Other kinds are listed as not read.
 */
export async function readQuoteAttachments(
  rows: QuoteAttachmentRow[],
  reader: QuoteAttachmentReader,
  options: { includeVisionImages?: boolean; trackVisionImages?: boolean } = {},
): Promise<SyncedQuoteAttachment[]> {
  const documents = rows.filter((row) => attachmentMattersForReview(reviewFacts(row)));
  const visionImages =
    options.includeVisionImages || options.trackVisionImages ? rows.filter(isPngJpegAttachment) : [];
  const matters = [...documents, ...visionImages];
  // PDFs then DOCX claim the caps before unknown parts, so a logo cannot push a request document out.
  const claimOrder = [
    ...documents.filter((row) => isPdfAttachment(row) && !isDocxAttachment(row)),
    ...documents.filter(isDocxAttachment),
    ...documents.filter((row) => !isPdfAttachment(row) && !isDocxAttachment(row)),
  ];
  let files = 0;
  let bytes = 0;
  const failures = new Map<string, string>();
  for (const row of claimOrder) {
    if (!isPdfAttachment(row) && !isGenericAttachment(row) && !isDocxAttachment(row)) {
      failures.set(row.id, 'not a PDF');
    } else if (files >= QUOTE_ATTACHMENT_MAX_FILES || bytes + row.sizeBytes > QUOTE_ATTACHMENT_MAX_TOTAL_BYTES) {
      failures.set(row.id, OVER_LIMIT);
    } else {
      files += 1;
      bytes += row.sizeBytes;
    }
  }
  let directImages = 0;
  for (const row of visionImages) {
    if (!options.includeVisionImages) {
      failures.set(row.id, 'vision disabled by EXTRACTION_VISION');
    } else if (row.sizeBytes <= VISION_IMAGE_MIN_BYTES) {
      failures.set(row.id, 'image is 20 KB or smaller; skipped as a likely signature');
    } else if (directImages >= VISION_MAX_DIRECT_IMAGES) {
      failures.set(row.id, 'over the 4 direct image vision limit');
    } else if (bytes + row.sizeBytes > QUOTE_ATTACHMENT_MAX_TOTAL_BYTES) {
      failures.set(row.id, OVER_LIMIT);
    } else {
      directImages += 1;
      bytes += row.sizeBytes;
    }
  }
  const results = await Promise.all(
    matters.map(async (row): Promise<SyncedQuoteAttachment | null> => {
      const base = {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        byteSize: row.sizeBytes,
        isInline: row.isInline,
      };
      const failure = failures.get(row.id);
      if (failure) return { ...base, bytesPresent: false, readFailure: failure };
      try {
        const read = await reader(row);
        if (read.reason === 'image') return null;
        if (isPngJpegAttachment(row)) {
          if (read.image) return { ...base, bytesPresent: true, image: read.image };
          return { ...base, bytesPresent: false, readFailure: read.reason ?? 'image bytes unavailable' };
        }
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
export function createArtifactReader(
  rows: QuoteAttachmentRow[],
  signal: AbortSignal,
  options: ArtifactReaderOptions = {},
): QuoteAttachmentReader {
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
    const mediaType = rasterMediaType(row);
    if (options.includeVisionImages && mediaType && !row.isInline) {
      const expectedLocator = {
        s3Key: row.s3Key,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        messageId: row.messageId,
        sha256: row.sha256 ?? null,
      };
      const revalidate = async () => {
        if (!options.transportId) return false;
        return revalidateOfficeAttachment(row, options.transportId);
      };
      const raw = await readAuthorizedArtifactBytes({
        ...common,
        allowRaster: true,
        expectedLocator,
        revalidate,
      });
      if (raw && imageBytesMatchMediaType(raw.body, mediaType)) {
        return { text: null, image: { mediaType, data: new Uint8Array(raw.body) } };
      }
      return { text: null, reason: 'image read failed or MIME did not match image bytes' };
    }
    if (isDocxAttachment(row)) {
      if (!options.revalidateOffice) return { text: null, reason: 'not a PDF' };
      if (!/^[a-f0-9]{64}$/.test(row.sha256 ?? '')) {
        return { text: null, reason: 'identity or authorization changed' };
      }
      const expectedLocator = await resolveLocator(row.id);
      if (!expectedLocator) return { text: null, reason: 'identity or authorization changed' };
      const raw = await readAuthorizedArtifactBytes({
        ...common,
        allowOffice: true,
        expectedLocator,
        expectedSha256: row.sha256!,
        revalidate: () => options.revalidateOffice!(row),
      });
      if (!raw) return { text: null, reason: 'identity or authorization changed' };
      const officeConverter =
        options.officeConverter ??
        ((docx: Uint8Array, convertSignal: AbortSignal) =>
          convertDocxWithGotenberg(docx, {
            url: process.env.GOTENBERG_URL?.trim() ?? '',
            signal: convertSignal,
          }));
      const extracted = await extractReservationistOfficeText({
        body: raw.body,
        attachmentId: row.id,
        signal,
        officeConverter,
        runner: options.runner,
        revalidate: () => options.revalidateOffice!(row),
      });
      return extracted.pages
        ? { text: extracted.pages.join('\n') }
        : { text: null, reason: extracted.reason.replaceAll('_', ' ') };
    }
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

async function revalidateOfficeAttachment(row: QuoteAttachmentRow, transportId: string): Promise<boolean> {
  let db;
  try {
    db = getDb();
    const [currentAttachments, parentMessages] = await Promise.all([
      db
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
        .where(eq(attachment.id, row.id))
        .limit(2),
      db
        .select({ id: message.id })
        .from(message)
        .where(and(eq(message.id, row.messageId), eq(message.transportId, transportId)))
        .limit(2),
    ]);
    if (currentAttachments.length !== 1 || parentMessages.length !== 1) return false;
    const current = currentAttachments[0]!;
    return (
      current.id === row.id &&
      current.filename === row.filename &&
      current.mimeType === row.mimeType &&
      current.sizeBytes === row.sizeBytes &&
      current.isInline === row.isInline &&
      current.contentId === (row.contentId ?? null) &&
      current.sha256 === (row.sha256 ?? null) &&
      current.s3Key === row.s3Key &&
      current.messageId === row.messageId
    );
  } catch {
    return false;
  }
}

/**
 * Causal preceding: same authorised mailbox thread, received at or before
 * the selected message, oldest first. Later replies are excluded. Missing
 * receivedAt is not treated as earlier.
 */
export function orderCausalPreceding(
  selected: { id: string; receivedAt: Date | null },
  threadRows: Array<{
    id: string;
    textBody: string | null;
    receivedAt: Date | null;
    direction?: 'inbound' | 'outbound';
  }>,
): Array<{ bodyText: string; direction?: 'inbound' | 'outbound' }> {
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
    .map((candidate) => ({
      bodyText: candidate.textBody ?? '',
      ...(candidate.direction ? { direction: candidate.direction } : {}),
    }));
}

/** Prior thread messages by message time; later-ingested rows and ties are omitted. */
export function orderThreadContext(
  selected: {
    id: string;
    direction: 'inbound' | 'outbound';
    receivedAt: Date | null;
    sentAt: Date | null;
    createdAt: Date;
  },
  threadRows: Array<{
    id: string;
    direction: 'inbound' | 'outbound';
    subject: string | null;
    textBody: string | null;
    receivedAt: Date | null;
    sentAt: Date | null;
    createdAt: Date;
  }>,
): SyncedThreadMessage[] {
  const selectedAt =
    selected.direction === 'outbound'
      ? selected.sentAt ?? selected.receivedAt ?? selected.createdAt
      : selected.receivedAt ?? selected.sentAt ?? selected.createdAt;
  return threadRows
    .filter((candidate) => candidate.id !== selected.id)
    .map((candidate) => ({
      candidate,
      timestamp:
        candidate.direction === 'outbound'
          ? candidate.sentAt ?? candidate.receivedAt ?? candidate.createdAt
          : candidate.receivedAt ?? candidate.sentAt ?? candidate.createdAt,
    }))
    // Sender-authored dates can be backdated; ingestion time blocks mail received after the target.
    .filter(
      ({ candidate, timestamp }) =>
        timestamp.getTime() < selectedAt.getTime() &&
        candidate.createdAt.getTime() < selected.createdAt.getTime(),
    )
    .sort(
      (left, right) =>
        left.timestamp.getTime() - right.timestamp.getTime() ||
        left.candidate.id.localeCompare(right.candidate.id),
    )
    .map(({ candidate, timestamp }) => ({
      direction: candidate.direction,
      timestamp: timestamp.toISOString(),
      subject: candidate.subject ?? '',
      bodyText: candidate.textBody ?? '',
    }));
}

/**
 * Mailbox-scoped, PMS-free selection load for `quoteWorkflow.analyseSelection`.
 *
 * Bind targets on this branch (`origin/main`):
 * - `message` rows for `ctx.activeTransportId` + `messageIdHeader`
 * - preceding same-thread messages with `receivedAt <= selected.receivedAt`, oldest first
 * - non-inline PDF and DOCX attachments of that message, read via the authorized artifact path
 *   (pdftotext, or existing DOCX→PDF→pdftotext) with locators from those rows only; failures become `readFailure`.
 *
 * Not bound (must not be faked as analysis-only):
 * - `ai.enqueueHmsRead` / `hms_quote_stay`
 * - sibling `qualifiedProposalChoices` / `qualifiedQuoteProposalPdf` (not on main)
 * This loader is not the reservationist agent.
 */
export async function loadSyncedQuoteSelectionFromMailbox(input: {
  transportId: string;
  internetMessageId?: string;
  /** The stored row's id. When set it is used instead of the header, which can be missing or shared by two rows. */
  messageId?: string;
  /** Include all prior thread messages for action classification, instead of only causal preceding text. */
  includeThreadState?: boolean;
  /** Include bounded non-inline PNG/JPEG reads for the extraction vision route. */
  includeVisionImages?: boolean;
  /** Keep image metadata for an honest unread audit while the vision gate is off. */
  trackVisionImages?: boolean;
  signal?: AbortSignal;
}): Promise<SyncedQuoteSelection | null> {
  const internetMessageId = input.internetMessageId?.trim();
  if (!internetMessageId && !input.messageId) return null;
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
      sentAt: message.sentAt,
      createdAt: message.createdAt,
      direction: message.direction,
      fromAddress: message.fromAddress,
    })
    .from(message)
    .where(
      and(
        eq(message.transportId, input.transportId),
        input.messageId
          ? eq(message.id, input.messageId)
          : eq(message.messageIdHeader, internetMessageId ?? ''),
      ),
    )
    .limit(2);
  const row = selected[0];
  if (!row || selected.length !== 1) return null;

  const threadRows = await db
    .select({
      id: message.id,
      textBody: message.textBody,
      subject: message.subject,
      direction: message.direction,
      receivedAt: message.receivedAt,
      sentAt: message.sentAt,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(and(eq(message.transportId, input.transportId), eq(message.threadId, row.threadId)));

  const preceding = orderCausalPreceding(row, threadRows);
  const threadMessages = input.includeThreadState ? orderThreadContext(row, threadRows) : undefined;

  const threadMessageIds = threadRows.map((item) => item.id);
  const threadIdSet = new Set(threadMessageIds);
  const rows = (
    threadMessageIds.length
      ? await db
          .select(ATTACHMENT_SELECT)
          .from(attachment)
          .where(inArray(attachment.messageId, threadMessageIds))
          .orderBy(asc(attachment.id))
      : []
  ).filter((item) => threadIdSet.has(item.messageId));
  const selectedRows = rows.filter((item) => item.messageId === row.id);
  const siblingRows = rows.filter((item) => item.messageId !== row.id);

  const signal = input.signal ?? AbortSignal.timeout(15_000);
  const reader = await readerForRows(rows, input.transportId, signal, {
    includeVisionImages: input.includeVisionImages === true,
  });

  return {
    subject: row.subject ?? '',
    bodyText: row.textBody ?? '',
    receivedAt: row.receivedAt?.toISOString(),
    threadReferenceAt: (
      row.direction === 'outbound'
        ? row.sentAt ?? row.receivedAt ?? row.createdAt
        : row.receivedAt ?? row.sentAt ?? row.createdAt
    ).toISOString(),
    preceding,
    ...(threadMessages ? { threadMessages } : {}),
    attachments: await readQuoteAttachments(selectedRows, reader, {
      includeVisionImages: input.includeVisionImages === true,
      trackVisionImages: input.trackVisionImages === true,
    }),
    messageId: row.id,
    threadId: row.threadId,
    fromAddress: row.fromAddress,
    threadConfirmation: siblingRows.length
      ? resolveThreadConfirmationEvidence(await readQuoteAttachments(siblingRows, reader))
      : { confirmation: null, reason: null },
  };
}
