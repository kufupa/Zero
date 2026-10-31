export type ReservationistMessageView = { name: 'plain' | 'html'; start: number; end: number };
export const HTML_ALTERNATIVE_MARKER = '[HTML alternative of the same message]\n';
const QUOTED_HISTORY = /^[\t ]*(?:>|From:\s|Sent:\s|Subject:\s|On .{1,250}wrote:|Begin forwarded message:|Forwarded message:|-{2,}\s*(?:Original Message|Forwarded message))/imu;

/** View offsets address one combined, hashed message; they never grant a different source. */
export function validReservationistMessageViews(text: string, views: unknown): views is ReservationistMessageView[] | undefined {
  if (views === undefined) return true;
  if (!Array.isArray(views) || views.length !== 2) return false;
  const [plain, html] = views as ReservationistMessageView[];
  return plain?.name === 'plain' && html?.name === 'html' && plain.start === 0 &&
    [plain, html].every(v => Number.isSafeInteger(v.start) && Number.isSafeInteger(v.end) && v.start >= 0 && v.end > v.start && v.end <= text.length && !QUOTED_HISTORY.test(text.slice(v.start, v.end))) &&
    text.slice(plain.end, html.start) === `\n\n${HTML_ALTERNATIVE_MARKER}` &&
    (html.end === text.length || /^\n\n(?:\[HTML alternative context\]\n)?(?:>|From:\s|Sent:\s|Subject:\s|On .{1,250}wrote:|Begin forwarded message:|Forwarded message:|-{2,}\s*(?:Original Message|Forwarded message))/i.test(text.slice(html.end)));
}
