export type ReservationistMessageView = { name: 'plain' | 'html'; start: number; end: number; quoted?: { start: number; end: number } };
export const HTML_ALTERNATIVE_MARKER = '[HTML alternative of the same message]\n';
const QUOTED_HISTORY = /^[\t ]*(?:>|From:\s|Sent:\s|Subject:\s|On .{1,250}wrote:|Begin forwarded message:|Forwarded message:|-{2,}\s*(?:Original Message|Forwarded message))/imu;

/** View offsets address one combined, hashed message; they never grant a different source. */
export function validReservationistMessageViews(text: string, views: unknown): views is ReservationistMessageView[] | undefined {
  if (!validBaseReservationistMessageViews(text, views)) return false;
  if (views === undefined) return true;
  const [plain, html] = views;
  const validQuoted = (range: unknown): boolean => {
    if (range === undefined) return true;
    if (typeof range !== 'object' || range === null) return false;
    const { start, end } = range as { start?: unknown; end?: unknown };
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
      (start as number) >= html.end && (end as number) > (start as number) && (end as number) <= text.length &&
      QUOTED_HISTORY.test(text.slice(start as number, end as number));
  };
  if (!validQuoted(plain.quoted) || !validQuoted(html.quoted)) return false;
  const plainHistory = plain.quoted, htmlHistory = html.quoted;
  if (plainHistory && htmlHistory)
    return text.slice(html.end, plainHistory.start) === '\n\n' &&
      text.slice(plainHistory.end, htmlHistory.start) === '\n\n[HTML alternative context]\n' && htmlHistory.end === text.length;
  if (plainHistory) return text.slice(html.end, plainHistory.start) === '\n\n' && plainHistory.end === text.length;
  if (htmlHistory) return text.slice(html.end, htmlHistory.start) === '\n\n[HTML alternative context]\n' && htmlHistory.end === text.length;
  return true;
}

function validBaseReservationistMessageViews(text: string, views: unknown): views is ReservationistMessageView[] | undefined {
  if (views === undefined) return true;
  if (!Array.isArray(views) || views.length !== 2) return false;
  const [plain, html] = views as ReservationistMessageView[];
  return plain?.name === 'plain' && html?.name === 'html' && plain.start === 0 &&
    [plain, html].every(v => Number.isSafeInteger(v.start) && Number.isSafeInteger(v.end) && v.start >= 0 && v.end > v.start && v.end <= text.length && !QUOTED_HISTORY.test(text.slice(v.start, v.end))) &&
    text.slice(plain.end, html.start) === `\n\n${HTML_ALTERNATIVE_MARKER}` &&
    (html.end === text.length || /^\n\n(?:\[HTML alternative context\]\n)?(?:>|From:\s|Sent:\s|Subject:\s|On .{1,250}wrote:|Begin forwarded message:|Forwarded message:|-{2,}\s*(?:Original Message|Forwarded message))/i.test(text.slice(html.end)));
}
