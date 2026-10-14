import { normalizeEmailAddress } from './never-spam.js';

const PRE_STAY_SUBJECT = /\bpre[\s-]?(?:stay|arrival)\b/i;
const SUBJECT_CONFIRMATION_NUMBER =
  /\b(?:confirmation|conf(?:irmation)?\.?)\s*(?:number|no\.?|#)?\s*[:#]?\s*\d+(?:-\d+)*\b/i;

/** Owner rule: a self-sent pre-stay confirmation describes an existing stay, never a new booking. */
export function isSelfSentPreStayInformationMail(input: {
  fromAddress?: string | null;
  mailboxAddress?: string | null;
  subject?: string | null;
  confirmationNumbers?: readonly string[];
}): boolean {
  const sender = input.fromAddress?.trim();
  const mailbox = input.mailboxAddress?.trim();
  if (!sender || !mailbox || normalizeEmailAddress(sender) !== normalizeEmailAddress(mailbox)) {
    return false;
  }

  const subject = input.subject ?? '';
  if (!PRE_STAY_SUBJECT.test(subject)) return false;

  return (
    SUBJECT_CONFIRMATION_NUMBER.test(subject) ||
    input.confirmationNumbers?.some((number) => number.trim().length > 0) === true
  );
}
