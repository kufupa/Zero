import { normalizeEmailAddress } from './never-spam.js';
import { htmlToPlainText } from '../mail/inbound-reaction-parser.js';
import { load } from 'cheerio';

const PRE_STAY_SUBJECT = /\bpre[\s-]?(?:stay|arrival)\b/i;
const SUBJECT_CONFIRMATION_NUMBER =
  /\b(?:confirmation|conf(?:irmation)?\.?)\s*(?:number|no\.?|#)?\s*[:#]?\s*\d+(?:-\d+)*\b/i;
const BODY_CONFIRMATION_NUMBER = /\b\d{6,10}-\d{1,4}\b/;

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

/**
 * One self-prestay candidate gate for live admission, V2 arrival, the pane and
 * the legacy Create fence: the hotel's own mailbox, a pre-stay subject and a
 * confirmation number in the subject, the current body or the stored
 * extraction. A missing mailbox or confirmation is never evidence, so the
 * exemption simply does not apply.
 */
export function selfSentPreStayCandidate(input: {
  fromAddress?: string | null;
  mailboxAddress?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  confirmationNumbers?: readonly string[];
}): boolean {
  if (!isSelfSentPreStaySubject(input)) return false;
  return (
    SUBJECT_CONFIRMATION_NUMBER.test(input.subject ?? '') ||
    BODY_CONFIRMATION_NUMBER.test(`${input.subject ?? ''}\n${input.bodyText ?? ''}`) ||
    input.confirmationNumbers?.some((number) => number.trim().length > 0) === true
  );
}

const BODY_CONFIRMATION_NUMBER_GLOBAL = new RegExp(BODY_CONFIRMATION_NUMBER.source, 'g');

/** Every confirmation-shaped token the body scan accepts, for display when extraction stored none. */
export function selfSentPreStayBodyConfirmationNumbers(text: string | null | undefined): string[] {
  return text?.match(BODY_CONFIRMATION_NUMBER_GLOBAL) ?? [];
}

/** For HTML-only self-mail, give extraction and validation the same current-message text. */
export function preStaySourceText(textBody: string | null | undefined, htmlBody: string | null | undefined): string {
  if (textBody?.trim()) return textBody;
  if (!htmlBody) return '';
  const document = load(htmlBody, null, false);
  // Self-contained quotes can occur before more authored text. Outlook's
  // reply header instead marks the start of all following quoted history,
  // including bare text and siblings outside the header's parent.
  document('blockquote, .gmail_quote').remove();
  const boundary = document('#divRplyFwdMsg, .OutlookMessageHeader').first();
  let cursor = boundary;
  while (cursor.length) {
    const node = cursor[0];
    while (node?.next) document(node.next).remove();
    cursor = cursor.parent();
  }
  boundary.remove();
  return htmlToPlainText(document.root().html() ?? '');
}

/** Text authored in this message, excluding quoted or forwarded history. */
export function currentAuthoredMessageText(body: string | null | undefined): string {
  if (!body) return '';
  // A source excerpt in a forwarded or quoted thread is not, by itself, a
  // current request. Keep it only when the selected message authored it.
  const source = /<(?:html|body|div|p|br|table|blockquote)(?:\s|>|\/)/i.test(body)
    ? preStaySourceText(null, body)
    : body;
  const history = source.search(/^[\t ]*(?:>|From:\s|Sent:\s|Subject:\s|On [^\r\n]{1,250}(?:\r?\n[^\r\n]{0,250}){0,2}wrote:|Begin forwarded message:|Forwarded message:|-{2,}\s*(?:Original Message|Forwarded message))/imu);
  return source.slice(0, history < 0 ? source.length : history);
}

/** Accept only an excerpt of the current message, not a model summary or thread history. */
export function groundedSeparateAsk(body: string | null | undefined, value: unknown, maxCharacters = 200): string | null {
  if (typeof value !== 'string') return null;
  const excerpt = value.trim();
  if (!excerpt || excerpt.length > maxCharacters) return null;
  return currentAuthoredMessageText(body).includes(excerpt) ? excerpt : null;
}
