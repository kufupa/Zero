import { normalizeEmailAddress } from './never-spam.js';
import { htmlToPlainText } from '../mail/inbound-reaction-parser.js';

const PRE_STAY_SUBJECT = /\bpre[\s-]?(?:stay|arrival)\b/i;
const SUBJECT_CONFIRMATION_NUMBER =
  /\b(?:confirmation|conf(?:irmation)?\.?)\s*(?:number|no\.?|#)?\s*[:#]?\s*\d+(?:-\d+)*\b/i;

/** Owner rule: a self-sent pre-stay confirmation describes an existing stay, never a new booking. */
export function isSelfSentPreStaySubject(input: {
  fromAddress?: string | null;
  mailboxAddress?: string | null;
  subject?: string | null;
}): boolean {
  const sender = input.fromAddress?.trim();
  const mailbox = input.mailboxAddress?.trim();
  if (!sender || !mailbox || normalizeEmailAddress(sender) !== normalizeEmailAddress(mailbox)) {
    return false;
  }

  return PRE_STAY_SUBJECT.test(input.subject ?? '');
}

export function isSelfSentPreStayInformationMail(input: {
  fromAddress?: string | null;
  mailboxAddress?: string | null;
  subject?: string | null;
  confirmationNumbers?: readonly string[];
}): boolean {
  if (!isSelfSentPreStaySubject(input)) return false;
  return (
    SUBJECT_CONFIRMATION_NUMBER.test(input.subject ?? '') ||
    input.confirmationNumbers?.some((number) => number.trim().length > 0) === true
  );
}

/** For HTML-only self-mail, give extraction and validation the same current-message text. */
export function preStaySourceText(textBody: string | null | undefined, htmlBody: string | null | undefined): string {
  if (textBody?.trim()) return textBody;
  if (!htmlBody) return '';
  const quote = htmlBody.search(/<blockquote(?:\s|>)/i);
  return htmlToPlainText(quote < 0 ? htmlBody : htmlBody.slice(0, quote));
}

/** Accept only an excerpt of the current message, not a model summary or thread history. */
export function groundedSeparateAsk(body: string | null | undefined, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const excerpt = value.trim();
  if (!excerpt || excerpt.length > 200) return null;
  if (!body) return null;
  // A source excerpt in a forwarded or quoted thread is not, by itself, a
  // current request. Keep it only when the selected message authored it.
  const source = /<(?:html|body|div|p|br|table|blockquote)(?:\s|>|\/)/i.test(body)
    ? preStaySourceText(null, body)
    : body;
  const history = source.search(/^[\t ]*(?:>|From:\s|Sent:\s|Subject:\s|On [^\r\n]{1,250}(?:\r?\n[^\r\n]{0,250}){0,2}wrote:|Begin forwarded message:|Forwarded message:|-{2,}\s*(?:Original Message|Forwarded message))/imu);
  return source.slice(0, history < 0 ? source.length : history).includes(excerpt) ? excerpt : null;
}
