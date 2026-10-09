import {
  createArtifactReader,
  readQuoteAttachments,
  type QuoteAttachmentRow,
  type SyncedQuoteAttachment,
} from './quote-workflow-synced-selection.js';
import { attachment, message } from '../db/schema/mail.js';
import { isGuestSurname } from './pane-stay-lookup.js';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';

// Voucher and proof-of-payment mail. Only the subject and the start of the body are read, so quoted history
// further down cannot make an unrelated email look like a voucher.
const VOUCHER_WORDS = /\bvouchers?\b|\bvch\b|\bremittance\b|proof of payment/i;
// POP is read in capitals only, so "pop-up" and "POP3" do not match.
const POP_CAPS = /\bPOP\b/;
const VOUCHER_FILE = /_vch_|voucher/i;
const BODY_CHECK_CHARS = 2000;
const ATTACHMENT_TEXT_CHARS = 20_000;
const LABEL_TAIL_CHARS = 60;

export type VoucherFile = { id: string; filename: string; mimeType: string; sizeBytes: number };
/** What the voucher says about the guest. Each field is null when it is missing or ambiguous; nothing is guessed. */
export type VoucherGuest = { lastName: string | null; arrival: string | null };
export type VoucherFindReply =
  | { status: 'unsynced' }
  | { status: 'not_voucher' }
  | { status: 'voucher'; messageId: string; guest: VoucherGuest; file: VoucherFile | null };

/** The stored message and its attachment rows. Read from the database only, with no attachment bytes. */
export type VoucherCandidate = {
  messageId: string;
  subject: string;
  bodyText: string;
  attachments: QuoteAttachmentRow[];
};

export function isVoucherMail(input: {
  subject: string;
  bodyText: string;
  attachmentNames: string[];
}): boolean {
  const head = input.bodyText.slice(0, BODY_CHECK_CHARS);
  if (VOUCHER_WORDS.test(input.subject) || VOUCHER_WORDS.test(head)) return true;
  if (POP_CAPS.test(input.subject) || POP_CAPS.test(head)) return true;
  return input.attachmentNames.some((name) => VOUCHER_FILE.test(name));
}

function isPdfRow(row: QuoteAttachmentRow): boolean {
  return row.mimeType === 'application/pdf' || /\.pdf$/i.test(row.filename);
}

/** The file staff upload to HMS Documents: a voucher-named file, else the first PDF, else the first file. */
export function pickVoucherFile(files: QuoteAttachmentRow[]): VoucherFile | null {
  const visible = files.filter((file) => !file.isInline);
  const chosen =
    visible.find((file) => VOUCHER_FILE.test(file.filename)) ??
    visible.find(isPdfRow) ??
    visible[0];
  if (!chosen) return null;
  return {
    id: chosen.id,
    filename: chosen.filename,
    mimeType: chosen.mimeType,
    sizeBytes: chosen.sizeBytes,
  };
}

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function monthNumber(word: string): number | null {
  const lower = word.toLowerCase().replace(/\.$/, '');
  if (lower.length < 3) return null;
  const index = MONTH_NAMES.findIndex(
    (name) => name.startsWith(lower) || (lower === 'sept' && name === 'september'),
  );
  return index === -1 ? null : index + 1;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

// A real calendar day as YYYY-MM-DD, or null. 31 February is refused, not rolled over.
function isoDay(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

const DATE_SHAPES: Array<(text: string) => string | null> = [
  // 2026-11-12
  (text) => {
    const match = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text);
    return match ? isoDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  },
  // 12/11/2026, 12.11.2026, 12-11-2026: day first, as the hotel writes dates
  (text) => {
    const match = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/.exec(text);
    return match ? isoDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
  },
  // 12 Nov 2026, 12-Nov-2026, 12th November, 2026
  (text) => {
    const match = /\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4})\b/.exec(text);
    const month = match ? monthNumber(match[2]!) : null;
    return match && month ? isoDay(Number(match[3]), month, Number(match[1])) : null;
  },
  // Nov 12 2026, November 12, 2026
  (text) => {
    const match = /\b([A-Za-z]{3,9})\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s-]+(\d{4})\b/.exec(text);
    const month = match ? monthNumber(match[1]!) : null;
    return match && month ? isoDay(Number(match[3]), month, Number(match[2])) : null;
  },
];

export function dayFromText(text: string): string | null {
  for (const shape of DATE_SHAPES) {
    const day = shape(text);
    if (day) return day;
  }
  return null;
}

const GUEST_LABEL =
  /\b(?:guest(?:\s+name)?|lead\s+guest|passenger(?:\s+name)?|travell?er|surname|last\s+name|name\s+of\s+guest)\s*:\s*(.+)$/i;
const ARRIVAL_LABEL =
  /\b(?:arrival(?:\s+date)?|arrives?|arriving|check[\s-]?in(?:\s+date)?)\s*:?\s*(.*)$/i;
// Lines about the company, agency, contact or sender are not the guest, even when they say "name".
const NOT_THE_GUEST =
  /\b(?:company|agency|organi[sz]ation|corporate|contact|booked\s+by|your\s+name)\b|^\s*from\s*:/i;
const TITLE = /^(?:mr|mrs|ms|miss|mstr|dr|prof)\.?$/i;

/** The surname from a guest-name value: "Smith, John", "SMITH/JOHN MR", "Mr John Smith" all give the surname. */
export function surnameFrom(value: string): string | null {
  // The value ends at a column gap, a sentence end, or the next "Label:" on the same line.
  const first = value.split(/\s{2,}|\||\t|[.;](?:\s|$)|\s+(?=[A-Za-z][A-Za-z ]{0,30}:)/)[0]!.trim();
  const separated = /[,/]/.test(first);
  const words = first
    .split(/[,/]/)[0]!
    .trim()
    .split(/\s+/)
    .filter((word) => word && !TITLE.test(word));
  // A "Surname, First" or "SURNAME/FIRST" value leads with the surname. Otherwise the surname is the last word.
  const surname = separated ? words[0] : words[words.length - 1];
  return surname && isGuestSurname(surname) ? surname : null;
}

/**
 * Surname and arrival from the email text and the voucher's own PDF text. A value counts only when every labelled line
 * agrees, so two surnames or two arrival days leave that field null for staff to read.
 */
export function extractVoucherGuest(input: {
  subject: string;
  bodyText: string;
  attachmentTexts: string[];
}): VoucherGuest {
  const sources = [
    input.subject,
    input.bodyText,
    ...input.attachmentTexts.map((text) => text.slice(0, ATTACHMENT_TEXT_CHARS)),
  ];
  const surnames = new Map<string, string>();
  const days = new Set<string>();
  for (const line of sources.join('\n').split(/\r?\n/)) {
    if (!NOT_THE_GUEST.test(line)) {
      const guest = GUEST_LABEL.exec(line);
      const surname = guest ? surnameFrom(guest[1]!) : null;
      if (surname) surnames.set(surname.toLowerCase(), surname);
    }
    const arrival = ARRIVAL_LABEL.exec(line);
    const day = arrival ? dayFromText(arrival[1]!.slice(0, LABEL_TAIL_CHARS)) : null;
    if (day) days.add(day);
  }
  const [onlySurname] = surnames.values();
  const [onlyDay] = days;
  return {
    lastName: surnames.size === 1 && onlySurname ? onlySurname : null,
    arrival: days.size === 1 && onlyDay ? onlyDay : null,
  };
}

// The stored message and its attachment rows, found by the exact Message-ID for this transport. No S3 reads here.
export async function loadVoucherCandidate(input: {
  transportId: string;
  internetMessageId: string;
}): Promise<VoucherCandidate | null> {
  let db;
  try {
    db = getDb();
  } catch {
    return null;
  }
  const selected = await db
    .select({ id: message.id, subject: message.subject, textBody: message.textBody })
    .from(message)
    .where(
      and(
        eq(message.transportId, input.transportId),
        eq(message.messageIdHeader, input.internetMessageId),
      ),
    )
    .limit(2);
  const row = selected[0];
  if (!row || selected.length !== 1) return null;
  const attachments = await db
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
  return {
    messageId: row.id,
    subject: row.subject ?? '',
    bodyText: row.textBody ?? '',
    attachments,
  };
}

/** PDF text for the voucher's own files only. Same reader and caps as the analyse loader. */
export async function readVoucherAttachmentText(
  files: QuoteAttachmentRow[],
  signal: AbortSignal,
): Promise<SyncedQuoteAttachment[]> {
  let reader;
  try {
    reader = createArtifactReader(files, signal);
  } catch {
    reader = async () => ({ text: null, reason: 'storage unavailable' });
  }
  return readQuoteAttachments(files, reader);
}
