/**
 * Which attachments Nava could not read are worth a review row and the unread banner.
 *
 * Signatures, invites, contact cards, inline parts and tiny files are skipped silently: they are not booking
 * documents, and a row for each one reads as an alarm on most emails. A PDF Nava could not read always counts,
 * because it may hold the booking. Office documents and larger unknown files count too.
 *
 * A Content-ID never skips a part on its own. Images are skipped by type and inline parts by disposition, with or
 * without a cid. A document that the body refers to by cid is still a document.
 */

export type AttachmentReviewFacts = {
  filename: string;
  mimeType?: string;
  /** Size in bytes. An unknown size is never tiny, and never large. */
  byteSize?: number;
  isInline?: boolean;
};

const TINY_FILE_BYTES = 4 * 1024;
const LARGE_UNKNOWN_FILE_BYTES = 20 * 1024;

const IMAGE_FILE = /\.(png|jpe?g|gif|bmp|webp|svg)$/i;
const CALENDAR_OR_CONTACT_FILE = /\.(ics|vcf)$/i;
const DOCUMENT_FILE = /\.(doc|docx|xls|xlsx|odt)$/i;
const PDF_FILE = /\.pdf$/i;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLSX_FILE = /\.xlsx$/i;

const CALENDAR_OR_CONTACT_MIME = new Set(['text/calendar', 'text/x-vcalendar', 'text/vcard', 'text/x-vcard']);
const DOCUMENT_MIME = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
]);

function mimeOf(facts: Pick<AttachmentReviewFacts, 'mimeType'>): string {
  return (facts.mimeType ?? '').split(';')[0].trim().toLowerCase();
}

/** A PDF by its declared type or its name. */
export function isPdfAttachment(facts: Pick<AttachmentReviewFacts, 'filename' | 'mimeType'>): boolean {
  return mimeOf(facts) === 'application/pdf' || PDF_FILE.test(facts.filename);
}

/** A part whose declared type says nothing (octet-stream or none). Its bytes decide whether it is an image. */
export function isGenericAttachment(facts: Pick<AttachmentReviewFacts, 'mimeType'>): boolean {
  const mime = mimeOf(facts);
  return mime === '' || mime === 'application/octet-stream';
}

// Keyed by the reader's failure text, where underscores are read as spaces.
const UNREAD_REASON_WORDS: Record<string, string> = {
  encrypted: 'password-protected',
  'no embedded text': 'no text, maybe a scan',
  'too large': 'too large to read',
  'too many pages': 'more than 50 pages',
  malformed: 'damaged',
  timeout: 'timed out',
  'parser failure': 'reader failed',
  unsupported: 'file type not readable',
  'not a PDF': 'not a PDF',
  'office conversion failed': 'Word file could not be read',
  'page boundaries unavailable': 'page breaks could not be read',
  'spreadsheet too large': 'above the spreadsheet size limit',
  'spreadsheet encrypted': 'password-protected',
  'spreadsheet sheet limit': 'has too many sheets to read safely',
  'spreadsheet row limit': 'above the row reading limit',
  'spreadsheet cell limit': 'above the cell reading limit',
  'spreadsheet content limit': 'above a row or cell reading limit',
  'spreadsheet output limit': 'above the text reading limit',
  'spreadsheet formula cells': 'contains formulas that Nava does not recalculate',
  'spreadsheet error cells': 'contains spreadsheet error cells',
  'spreadsheet hidden sheet': 'contains hidden sheets',
  'spreadsheet hidden rows or columns': 'contains hidden rows or columns',
  'spreadsheet chart sheet': 'contains a chart sheet Nava cannot read',
  'spreadsheet unsupported format': 'uses an unsupported spreadsheet format',
  'spreadsheet unsupported content': 'contains unsupported spreadsheet content',
  'spreadsheet safety limit': 'exceeded safe spreadsheet reading limits',
  'spreadsheet parse failed': 'could not be read completely',
  'spreadsheet empty': 'contains no readable cell data',
};

/** Why Nava could not read a file, in words staff can act on. Null for a reason with no wording. */
export function unreadReasonWords(reason: string | undefined): string | null {
  return reason ? (UNREAD_REASON_WORDS[reason] ?? null) : null;
}

/** True when an attachment Nava could not read earns a review row and counts toward the unread banner. */
export function attachmentMattersForReview(facts: AttachmentReviewFacts): boolean {
  if (facts.isInline) return false;
  if (isPdfAttachment(facts)) return true;
  const mime = mimeOf(facts);
  if (mime.startsWith('image/') || IMAGE_FILE.test(facts.filename)) return false;
  if (CALENDAR_OR_CONTACT_MIME.has(mime) || CALENDAR_OR_CONTACT_FILE.test(facts.filename)) return false;
  // A small rooming workbook is still a booking source; don't treat it like a tiny signature.
  if (mime === XLSX_MIME || XLSX_FILE.test(facts.filename)) return true;
  if (facts.byteSize !== undefined && facts.byteSize < TINY_FILE_BYTES) return false;
  if (DOCUMENT_MIME.has(mime) || DOCUMENT_FILE.test(facts.filename)) return true;
  return facts.byteSize !== undefined && facts.byteSize > LARGE_UNKNOWN_FILE_BYTES;
}
