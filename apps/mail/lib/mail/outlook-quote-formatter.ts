import { formatInTimeZone } from 'date-fns-tz';
import { parseAndValidateDate, resolveEffectiveTimezone } from '../utils';
import type { Sender } from '@/types';

export interface OutlookReplyHeaderOptions {
  formattedMessage: string;
  originalDate: string | Date | number;
  originalSender?: Sender | null;
  toRecipients?: Sender[] | null;
  ccRecipients?: Sender[] | null;
  subject?: string | null;
  quotedMessage?: string | null;
  isForward?: boolean;
  timezone?: string;
}

export function formatOutlookHeaderDate(
  dateInput: string | Date | number | undefined | null,
  timezone?: string,
): string {
  const d = parseAndValidateDate(dateInput);
  if (!d) {
    return typeof dateInput === 'string' ? dateInput : '';
  }
  const tz = resolveEffectiveTimezone(timezone);
  try {
    return formatInTimeZone(d, tz, 'EEEE, MMMM d, yyyy h:mm a');
  } catch (error) {
    console.error('Error formatting Outlook header date', error);
    return '';
  }
}

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatRecipientList(recipients?: Sender[] | null): string {
  if (!recipients || !Array.isArray(recipients)) return '';
  return recipients
    .map((r) => {
      const email = r.email?.trim() || '';
      const name = r.name?.trim() || '';
      const safeName = escapeHtml(name);
      const safeEmail = escapeHtml(email);
      if (safeName && safeName !== safeEmail) {
        return `${safeName} &lt;${safeEmail}&gt;`;
      }
      return safeEmail ? `&lt;${safeEmail}&gt;` : safeName;
    })
    .filter(Boolean)
    .join('; ');
}

export function constructOutlookReplyHtml(
  input: OutlookReplyHeaderOptions | import('@/types').ParsedMessage,
  options?: {
    formattedMessage?: string;
    isForward?: boolean;
    userTimezone?: string;
  },
): string {
  let formattedMessage = '';
  let originalDate: string | Date | number = '';
  let originalSender: Sender | undefined;
  let toRecipients: Sender[] = [];
  let ccRecipients: Sender[] = [];
  let subject = '';
  let quotedMessage = '';
  let isForward = false;
  let timezone: string | undefined;

  if ('sender' in input && typeof input.sender === 'object') {
    const msg = input as import('@/types').ParsedMessage;
    formattedMessage = options?.formattedMessage || '';
    originalDate = msg.receivedOn;
    originalSender = msg.sender;
    toRecipients = msg.to || [];
    ccRecipients = msg.cc || [];
    subject = msg.subject || msg.title || '';
    quotedMessage = msg.decodedBody || msg.body || '';
    isForward = options?.isForward ?? false;
    timezone = options?.userTimezone;
  } else {
    const opts = input as OutlookReplyHeaderOptions;
    formattedMessage = opts.formattedMessage;
    originalDate = opts.originalDate;
    originalSender = opts.originalSender;
    toRecipients = opts.toRecipients || [];
    ccRecipients = opts.ccRecipients || [];
    subject = opts.subject || '';
    quotedMessage = opts.quotedMessage || '';
    isForward = opts.isForward || false;
    timezone = opts.timezone;
  }

  const senderName = originalSender?.name?.trim() || '';
  const senderEmail = originalSender?.email?.trim() || '';
  const safeSenderName = escapeHtml(senderName);
  const safeSenderEmail = escapeHtml(senderEmail);
  const fromDisplay =
    safeSenderName && safeSenderName !== safeSenderEmail
      ? `${safeSenderName} &lt;${safeSenderEmail}&gt;`
      : safeSenderEmail
        ? `&lt;${safeSenderEmail}&gt;`
        : safeSenderName || 'Unknown Sender';

  const dateDisplay = formatOutlookHeaderDate(originalDate, timezone);
  const toDisplay = formatRecipientList(toRecipients);
  const ccDisplay = formatRecipientList(ccRecipients);

  let formattedSubject = subject;
  if (isForward) {
    if (formattedSubject && !/^fw:/i.test(formattedSubject)) {
      formattedSubject = `FW: ${formattedSubject}`;
    }
  } else {
    if (formattedSubject && !/^re:/i.test(formattedSubject)) {
      formattedSubject = `RE: ${formattedSubject}`;
    }
  }

  return `
    <div class="nava-mail-body" style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #000000;">
      <div>
        ${formattedMessage}
      </div>
      <div id="divRplyFwdMsg" dir="ltr" class="gmail_quote" style="border-top: 1px solid #E1E1E1; padding-top: 3pt;">
        <hr style="display:inline-block;width:98%" size="1">
        <div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #000000;">
          <b>From:</b> ${fromDisplay}<br>
          <b>Sent:</b> ${dateDisplay}<br>
          ${toDisplay ? `<b>To:</b> ${toDisplay}<br>` : ''}
          ${ccDisplay ? `<b>Cc:</b> ${ccDisplay}<br>` : ''}
          ${formattedSubject ? `<b>Subject:</b> ${formattedSubject}<br>` : ''}
        </div>
        <div><br></div>
        <div id="zero-quoted-content">
          ${quotedMessage || ''}
        </div>
      </div>
    </div>
  `;
}
