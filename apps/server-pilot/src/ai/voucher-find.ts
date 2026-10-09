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
/** The distinct values that disagreed, for staff to choose from. An empty list means that field did not conflict. */
export type VoucherConflicts = { lastNames: string[]; arrivals: string[] };
/**
 * What the voucher says about the guest. Each field is null when it is missing or ambiguous; nothing is guessed.
 * `conflicts` is present only when two or more different surnames or arrival days were read.
 */
export type VoucherGuest = {
  lastName: string | null;
  arrival: string | null;
  conflicts?: VoucherConflicts;
};
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

/**
 * The PDFs whose text is read for the guest. Voucher-named PDFs come first, so unrelated PDFs cannot push the voucher
 * out of the reader's file and size caps. Payment mail with no voucher-named PDF falls back to every visible PDF.
 */
export function voucherReadFiles(files: QuoteAttachmentRow[]): QuoteAttachmentRow[] {
  const pdfs = files.filter((file) => !file.isInline && isPdfRow(file));
  const named = pdfs.filter((file) => VOUCHER_FILE.test(file.filename));
  return named.length > 0 ? named : pdfs;
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

// Label starts, global so one line can carry several labelled values ("Guest: Smith  Guest: Jones").
const GUEST_LABEL_START =
  /\b(?:guest(?:\s+name)?|lead\s+guest|passenger(?:\s+name)?|travell?er|surname|last\s+name|name\s+of\s+guest)\s*:/gi;
const ARRIVAL_LABEL_START = /\b(?:arrival(?:\s+date)?|arrives?|arriving|check[\s-]?in(?:\s+date)?)\s*:?/gi;
// Known voucher labels that end a value on the same line. Only these, so a name such as "Mary Smith  Arrival:" is cut
// after "Smith", and "Arrival: TBA  Departure: 15 Nov" gives no arrival.
const KNOWN_LABELS =
  'guest(?: name)?|lead guest|passenger(?: name)?|travell?er|surname|last name|name of guest|arrival(?: date)?|arrives?|arriving|check[ -]?in(?: date| time)?|departure(?: date)?|check[ -]?out(?: date| time)?|room(?: type| number)?|rooms|rate(?: plan| code| type)?|meal plan|board(?: basis)?|nights?|adults?|children|pax|number of (?:guests|rooms)|special requests?|remarks?|notes?|confirmation(?: number)?|booking(?: number| ref| reference)?|reservation(?: number)?|reference|voucher(?: number| no)?|company|agency|organi[sz]ation|hotel|property|status|total|balance|deposit|payment(?: method)?|price|amount|currency|e-?mail|phone|mobile|address|city|country|cancellation(?: policy)?|contact|booked by|created by|issued';
// A "Label:" left in a value once the known labels are cut, so the value runs into a field this list does not know.
const UNKNOWN_LABEL_COLON = /[A-Za-z]\s*:/;
const NEXT_LABEL = new RegExp(`\\s+(?=(?:${KNOWN_LABELS})\\s*:)`, 'i');
// Lines about the company, agency, contact or sender are not the guest, even when they say "name".
const NOT_THE_GUEST =
  /\b(?:company|agency|organi[sz]ation|corporate|contact|booked\s+by|your\s+name)\b|^\s*from\s*:/i;
const TITLE = /^(?:mr|mrs|ms|miss|mstr|dr|prof)\.?$/i;

/** The surname from a guest-name value: "Smith, John", "SMITH/JOHN MR", "Mr John Smith" all give the surname. */
export function surnameFrom(value: string): string | null {
  // The value ends at a column gap, a sentence end, or the next known label on the same line.
  const first = value.split(new RegExp(`\\s{2,}|\\||\\t|[.;](?:\\s|$)|${NEXT_LABEL.source}`, 'i'))[0]!.trim();
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

// Each labelled value on one line. A value runs from its label to the next label of the same kind, and stops at the
// next label of any kind. "Guest: Smith  Guest: Jones" gives two values; nothing on the line is skipped.
function labelledValues(line: string, start: RegExp): string[] {
  const matches = [...line.matchAll(start)];
  return matches.map((match, index) => {
    const from = match.index + match[0].length;
    const to = matches[index + 1]?.index ?? line.length;
    return (line.slice(from, to).trimStart().split(NEXT_LABEL)[0] ?? '').trimEnd();
  });
}

/**
 * Surname and arrival from the email text and the voucher's own PDF text. A field counts only when every labelled value
 * agrees. When two or more different values appear, the field stays null and the values are listed for staff, never
 * the first one read.
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
  // A guest value that runs into an unknown field may have its surname in the wrong word, so no surname is taken from it.
  let guestUnclear = false;
  for (const line of sources.join('\n').split(/\r?\n/)) {
    if (!NOT_THE_GUEST.test(line)) {
      for (const value of labelledValues(line, GUEST_LABEL_START)) {
        if (UNKNOWN_LABEL_COLON.test(value)) {
          guestUnclear = true;
          continue;
        }
        const surname = surnameFrom(value);
        // The first spelling wins, so "Smith" and "SMITH" are one guest and keep the spelling read first.
        if (surname && !surnames.has(surname.toLowerCase())) surnames.set(surname.toLowerCase(), surname);
      }
    }
    for (const value of labelledValues(line, ARRIVAL_LABEL_START)) {
      // Text after an unknown label is not the arrival, so a date beyond that label is never read.
      const label = UNKNOWN_LABEL_COLON.exec(value);
      const head = label ? value.slice(0, label.index) : value;
      const day = dayFromText(head.slice(0, LABEL_TAIL_CHARS));
      if (day) days.add(day);
    }
  }
  const lastNames = [...surnames.values()];
  const arrivals = [...days];
  const guest: VoucherGuest = {
    lastName: !guestUnclear && lastNames.length === 1 ? lastNames[0]! : null,
    arrival: arrivals.length === 1 ? arrivals[0]! : null,
  };
  if (lastNames.length > 1 || arrivals.length > 1) {
    guest.conflicts = {
      lastNames: lastNames.length > 1 ? lastNames : [],
      arrivals: arrivals.length > 1 ? arrivals : [],
    };
  }
  return guest;
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
