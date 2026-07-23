import { cleanEmailDisplay } from '@/lib/mail/mailbox-format';

/** Only collapse a single To into "You" for inbound mail addressed to the active mailbox. */
export function shouldCollapseRecipientToYou(args: {
  folder?: string | null;
  to: Array<{ email?: string }>;
  ccLength: number;
  mailboxEmail?: string | null;
  /** When set and equal to mailbox, message is sent-by-me — never show To: You. */
  fromEmail?: string | null;
}): boolean {
  if (args.folder === 'sent') return false;
  if (args.to.length !== 1 || args.ccLength !== 0) return false;
  const mailbox = cleanEmailDisplay(args.mailboxEmail ?? undefined).toLowerCase();
  if (!mailbox) return false;
  const from = cleanEmailDisplay(args.fromEmail ?? undefined).toLowerCase();
  if (from && from === mailbox) return false;
  const recipient = cleanEmailDisplay(args.to[0]?.email).toLowerCase();
  return recipient === mailbox;
}
