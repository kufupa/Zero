import { FIXTURE_PDF } from './fixtures';
import { canCreatePdf, currentStayRun, isMultiStay, optionLetter, requestedQuoteKeys, stayKeyForGroup } from './session';
import type { QuoteOffer, QuoteSession, StaffQuoteAllocation, StayGroupRequirement } from './types';
import { withStaffNote } from './native-draft';

/**
 * The one unsent reply for a multi-stay quote. Every stay is quoted in one combined PDF, so this module checks that the
 * PDF is still the one the current stay runs make, and writes the body that lists every room row.
 */

export type CompletedDateRoom = {
  quantity: number;
  description: string;
  lineTotalMinor: number;
};

export type CompletedDateOption = {
  key: string;
  letter: string;
  quote: StaffQuoteAllocation;
  offer: QuoteOffer;
  rooms: CompletedDateRoom[];
};

export type MultiOptionDraft = {
  html: string;
  attachments: Array<{ fileName: string; pdfBase64: string }>;
  letters: string[];
};

const PDF_HASH = /^[a-f0-9]{64}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BOARD_LABELS: Record<string, string> = { bb: 'Bed & breakfast', room_only: 'Room only' };
const DINNER_UNIT_LABELS = {
  per_person_per_night: 'per person per night',
  per_room_per_night: 'per room per night',
  per_person: 'per person',
} as const;
const INTRO = 'Please see the quote below for each date option. One quotation PDF covers all of them.';
const CLOSING = 'The options are quotes only and are not bookings.';

function roomDescription(offer: QuoteOffer, group?: StayGroupRequirement): string {
  const label = offer.roomLabel || group?.roomPreference?.trim() || '';
  const board = BOARD_LABELS[offer.board] ?? (group?.board ? BOARD_LABELS[group.board] : undefined);
  return [label, board].filter(Boolean).join(' · ');
}

function roomsForDateOption(
  session: QuoteSession,
  key: string,
  offer: QuoteOffer,
  quote: StaffQuoteAllocation,
): CompletedDateRoom[] {
  const dinnerTotal = quote.dinnerAddOn?.totalMinor ?? 0;
  const groups = session.groups.filter((group) => stayKeyForGroup(group) === key);
  const allocations = session.offers.filter((item) => item.kind === 'allocation' && item.quoteRequestKey === key);
  if (groups.length <= 1) {
    return [
      {
        quantity: offer.quantity ?? groups[0]?.quantity ?? 1,
        description: roomDescription(offer, groups[0]),
        lineTotalMinor: quote.totalMinor - dinnerTotal,
      },
    ];
  }
  return groups.map((group) => {
    const covered = allocations.find(
      (item) => item.coversGroupIds.length === 1 && item.coversGroupIds[0] === group.id,
    );
    return {
      quantity: group.quantity ?? covered?.quantity ?? 1,
      description: roomDescription(covered ?? offer, group),
      lineTotalMinor: covered
        ? covered.id === offer.id
          ? quote.totalMinor - dinnerTotal
          : covered.stayTotalMinor
        : 0,
    };
  });
}

/** Every date option in email date order whose staff run still matches the session, with its allocation. */
export function completedDateOptions(session: QuoteSession): CompletedDateOption[] {
  return requestedQuoteKeys(session.groups).flatMap((key, index) => {
    const quote = currentStayRun(session, key);
    const offer = quote
      ? session.offers.find((item) => item.id === quote.revisionRef && item.kind === 'allocation')
      : undefined;
    return quote && offer
      ? [{ key, letter: optionLetter(index), quote, offer, rooms: roomsForDateOption(session, key, offer, quote) }]
      : [];
  });
}

/** What staff wrote in the combined reply, and the stays it was written for. */
export type CombinedReplyEdit = { signature: string; html: string };

/** Identifies the combined reply: an edit is used only while the stays' runs, the PDF and the note are unchanged. */
export function multiOptionSignature(session: QuoteSession): string | null {
  if (!isMultiStay(session) || !session.pdf) return null;
  const options = completedDateOptions(session);
  if (options.length !== requestedQuoteKeys(session.groups).length) return null;
  // The note is part of the reply, so changing it makes an earlier edited combined reply stale.
  const note = session.staffHeader?.notes?.trim() ?? '';
  return options
    .map((option) => `${option.letter}:${option.key}:${option.quote.totalMinor}:${option.quote.revisionRef}`)
    .concat(`pdf:${session.pdf.pdfHash ?? ''}`, `note:${note}`)
    .join('|');
}

/** The one reply covering every stay, or null until every stay is rated and the combined PDF is the current one. */
export function requireMultiOptionDraft(
  session: QuoteSession,
  edit?: CombinedReplyEdit | null,
): MultiOptionDraft | null {
  const pdf = session.pdf;
  if (!isMultiStay(session) || !pdf || !canCreatePdf(session)) return null;
  const options = completedDateOptions(session);
  if (options.length !== requestedQuoteKeys(session.groups).length) return null;
  // The PDF may predate a stay edit or an unreadable amount. Its old charges must not reach a reply.
  const total = options.reduce((sum, option) => sum + option.quote.totalMinor, 0);
  const current =
    (pdf.revisionId ?? '').startsWith('quotes:') &&
    pdf.totalMinor === total &&
    PDF_HASH.test(pdf.pdfHash ?? '') &&
    pdf.bytesBase64.trim() !== '' &&
    pdf.fileName !== FIXTURE_PDF.fileName;
  if (!current) return null;
  const edited = edit && edit.signature === multiOptionSignature(session) ? edit.html : null;
  return {
    html: withStaffNote(edited ?? multiOptionDraftHtml(options), session.staffHeader?.notes),
    attachments: [{ fileName: pdf.fileName, pdfBase64: pdf.bytesBase64 }],
    letters: options.map((option) => option.letter),
  };
}

export function multiOptionDraftHtml(options: readonly CompletedDateOption[]): string {
  const sections = options.map((option) => {
    const [arrival = '', departure = ''] = option.key.split(':');
    const dinner = option.quote.dinnerAddOn;
    const optionTotal = draftMoney(option.quote.totalMinor);
    const dinnerLine = dinner
      ? `<p><strong>${escapeHtml(dinner.label)}</strong>: ${escapeHtml(draftMoney(dinner.amountMinor))} ${DINNER_UNIT_LABELS[dinner.unit]}; add-on total ${escapeHtml(draftMoney(dinner.totalMinor))}.</p>`
      : '';
    const dinnerTotal = dinner?.totalMinor ?? 0;
    const rooms = option.rooms?.length
      ? option.rooms.length === 1
        ? [{ ...option.rooms[0]!, lineTotalMinor: option.quote.totalMinor - dinnerTotal }]
        : option.rooms
      : [
          {
            quantity: option.offer.quantity ?? 1,
            description: roomDescription(option.offer),
            lineTotalMinor: option.quote.totalMinor - dinnerTotal,
          },
        ];
    const rows = rooms.map((room) =>
      [
        '<tr>',
        `<td>${escapeHtml(formatDate(arrival))} to ${escapeHtml(formatDate(departure))}</td>`,
        `<td>${escapeHtml(String(room.quantity))}</td>`,
        `<td>${escapeHtml(room.description)}</td>`,
        `<td>${escapeHtml(nightsBetween(arrival, departure))}</td>`,
        `<td align="right">${room.lineTotalMinor > 0 ? escapeHtml(draftMoney(room.lineTotalMinor)) : ''}</td>`,
        '</tr>',
      ].join(''),
    );
    return [
      `<h3>Option ${option.letter}: ${escapeHtml(formatStayRange(arrival, departure))}</h3>`,
      '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">',
      '<thead><tr><th align="left">DATE</th><th align="left">QTY</th><th align="left">DESCRIPTION</th>',
      '<th align="left">NIGHTS</th><th align="right">LINE TOTAL</th></tr></thead>',
      `<tbody>${rows.join('')}</tbody></table>`,
      dinnerLine,
      `<p><strong>Option ${option.letter} total: ${escapeHtml(optionTotal)}</strong></p>`,
    ].join('');
  });
  const total = draftMoney(options.reduce((sum, option) => sum + option.quote.totalMinor, 0));
  return `<div><p>${INTRO}</p>${sections.join('')}<p><strong>Total for all options: ${escapeHtml(total)}</strong></p><p>${CLOSING}</p></div>`;
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
