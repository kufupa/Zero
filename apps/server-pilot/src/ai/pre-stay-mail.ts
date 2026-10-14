import { normalizeEmailAddress } from './never-spam.js';

const PRE_STAY_CONFIRMATION_SUBJECT =
  /^pre[\s-]+stay\b.*?\bconfirmation\s+no\.?\s+(\d+(?:-\d+)?)(?=\s|$)/i;

export function ownMailboxPreStayConfirmation(input: {
  fromAddress?: string | null;
  mailboxEmail?: string | null;
  subject?: string | null;
}): string | null {
  const sender = normalizeEmailAddress(input.fromAddress ?? '');
  const mailbox = normalizeEmailAddress(input.mailboxEmail ?? '');
  if (!sender || sender !== mailbox) return null;

  return PRE_STAY_CONFIRMATION_SUBJECT.exec((input.subject ?? '').trim())?.[1] ?? null;
}
