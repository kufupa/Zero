import {
  evidenceMatchesSession,
  optionLetter,
  requestedQuoteKeys,
  staffSourceReady,
} from './session';
import type { QuoteOffer, QuotePdf, QuoteSession, StaffQuoteAllocation } from './types';
import { approvedExecuteHeader } from './staff-quote-bind';
import { FIXTURE_PDF } from './fixtures';
import { withStaffNote } from './native-draft';

/**
 * One unsent reply that covers every date option staff completed. Each option keeps its own
 * staff run and PDF; this module only decides which options are complete and writes the body.
 */

export type CompletedDateOption = {
  key: string;
  letter: string;
  quote: StaffQuoteAllocation;
  offer: QuoteOffer;
  pdf: QuotePdf;
};

export type MultiOptionDraft = {
  html: string;
  attachments: Array<{ fileName: string; pdfBase64: string }>;
  letters: string[];
};

const PDF_HASH = /^[a-f0-9]{64}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BOARD_LABELS: Record<string, string> = { bb: 'Bed & breakfast', room_only: 'Room only' };
const INTRO =
  'Please see the date options below. Each option is quoted separately and has its own quotation PDF attached.';
const CLOSING = 'Each option is a separate quotation and is not a booking.';

/** Options in email date order whose staff run, allocation and PDF all belong to the current input. */
export function completedDateOptions(session: QuoteSession): CompletedDateOption[] {
  const source = session.staffSource;
  const binding = session.binding;
  if (!source || !staffSourceReady(session) || !binding) return [];
  if (session.evidence?.kind !== 'authorised' || !evidenceMatchesSession(session)) return [];
  let header: ReturnType<typeof approvedExecuteHeader>;
  try {
    header = approvedExecuteHeader(session.staffHeader);
  } catch {
    return [];
  }
  const options: CompletedDateOption[] = [];
  requestedQuoteKeys(session.groups).forEach((key, index) => {
    const quote = session.staffQuotes[key];
    const pdf = session.stayPdfs[key];
    const offer = quote
      ? session.offers.find((item) => item.id === quote.revisionRef && item.kind === 'allocation')
      : undefined;
    if (!quote || !pdf || !offer) return;
    const current =
      quote.totalMinor > 0 &&
      quote.quoteRequestKey === key &&
      quote.selectionEpoch === binding.selectionEpoch &&
      quote.inputRevision === session.inputRevision &&
      quote.sourceHash === source.sourceHash &&
      quote.messageId === source.messageId &&
      quote.threadId === source.threadId &&
      quote.approvedHeader.salesStrategy === header.salesStrategy &&
      quote.approvedHeader.company === header.company &&
      quote.approvedHeader.agency === header.agency &&
      offer.stayTotalMinor === quote.totalMinor &&
      offer.nightly.length === 0 &&
      pdf.revisionId === quote.revisionRef &&
      pdf.totalMinor === quote.totalMinor &&
      PDF_HASH.test(pdf.pdfHash ?? '') &&
      pdf.bytesBase64.trim() !== '' &&
      pdf.fileName !== FIXTURE_PDF.fileName;
    if (current) options.push({ key, letter: optionLetter(index), quote, offer, pdf });
  });
  return options;
}

/** What staff wrote in the combined reply, and the completed options it was written for. */
export type CombinedReplyEdit = { signature: string; html: string };

/** Identifies the completed options: an edit is used only while they are still the same runs and PDFs. */
export function multiOptionSignature(session: QuoteSession): string | null {
  const options = completedDateOptions(session);
  if (options.length < 2) return null;
  // The note is part of the reply, so changing it makes an earlier edited combined reply stale.
  const note = session.staffHeader?.notes?.trim() ?? '';
  return options
    .map((option) => `${option.letter}:${option.key}:${option.quote.totalMinor}:${option.pdf.pdfHash ?? ''}`)
    .concat(`note:${note}`)
    .join('|');
}

/** The one reply covering all completed options, or null unless at least two are complete. */
export function requireMultiOptionDraft(
  session: QuoteSession,
  edit?: CombinedReplyEdit | null,
): MultiOptionDraft | null {
  const options = completedDateOptions(session);
  if (options.length < 2) return null;
  const edited = edit && edit.signature === multiOptionSignature(session) ? edit.html : null;
  return {
    html: withStaffNote(edited ?? multiOptionDraftHtml(options), session.staffHeader?.notes),
    attachments: options.map((option) => ({
      fileName: optionAttachmentName(option.pdf.fileName, option.letter),
      pdfBase64: option.pdf.bytesBase64,
    })),
    letters: options.map((option) => option.letter),
  };
}

export function multiOptionDraftHtml(options: readonly CompletedDateOption[]): string {
  const sections = options.map((option) => {
    const [arrival = '', departure = ''] = option.key.split(':');
    const amount = draftMoney(option.quote.totalMinor);
    const description = [option.offer.roomLabel, BOARD_LABELS[option.offer.board]]
      .filter(Boolean)
      .join(' · ');
    return [
      `<h3>Option ${option.letter}: ${escapeHtml(formatStayRange(arrival, departure))}</h3>`,
      '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">',
      '<thead><tr><th align="left">DATE</th><th align="left">QTY</th><th align="left">DESCRIPTION</th>',
      '<th align="left">NIGHTS</th><th align="right">LINE TOTAL</th></tr></thead>',
      '<tbody><tr>',
      `<td>${escapeHtml(formatDate(arrival))} to ${escapeHtml(formatDate(departure))}</td>`,
      `<td>${escapeHtml(String(option.offer.quantity ?? ''))}</td>`,
      `<td>${escapeHtml(description)}</td>`,
      `<td>${escapeHtml(nightsBetween(arrival, departure))}</td>`,
      `<td align="right">${escapeHtml(amount)}</td>`,
      '</tr></tbody></table>',
      `<p><strong>Option ${option.letter} total: ${escapeHtml(amount)}</strong></p>`,
    ].join('');
  });
  return `<div><p>${INTRO}</p>${sections.join('')}<p>${CLOSING}</p></div>`;
}

/** Outlook keeps attachments by name, so each option's PDF gets its letter even when the server names match. */
export function optionAttachmentName(fileName: string, letter: string): string {
  const base = fileName.trim().replace(/\.pdf$/i, '') || 'Quotation';
  return `${base} - Option ${letter}.pdf`;
}

/** Same shape as the quotation PDF total (for example R2,720.00), so the draft and attachment agree. */
export function draftMoney(minor: number): string {
  return `R${Math.floor(minor / 100).toLocaleString('en-ZA')}.${String(minor % 100).padStart(2, '0')}`;
}

export function formatStayRange(arrival: string, departure: string): string {
  const from = parseIsoDate(arrival);
  const to = parseIsoDate(departure);
  if (!from || !to) return `${arrival} to ${departure}`;
  if (from.year === to.year && from.month === to.month) {
    return `${from.day}–${to.day} ${MONTHS[from.month - 1]} ${from.year}`;
  }
  if (from.year === to.year) {
    return `${from.day} ${MONTHS[from.month - 1]} – ${to.day} ${MONTHS[to.month - 1]} ${from.year}`;
  }
  return `${from.day} ${MONTHS[from.month - 1]} ${from.year} – ${to.day} ${MONTHS[to.month - 1]} ${to.year}`;
}

function formatDate(value: string): string {
  const parsed = parseIsoDate(value);
  return parsed ? `${parsed.day} ${MONTHS[parsed.month - 1]} ${parsed.year}` : value;
}

function nightsBetween(arrival: string, departure: string): string {
  const from = parseIsoDate(arrival);
  const to = parseIsoDate(departure);
  if (!from || !to) return '';
  const nights = Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
      86_400_000,
  );
  return nights > 0 ? String(nights) : '';
}

function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
