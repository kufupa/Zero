import { cleanEmailDisplay } from '@/lib/mail/mailbox-format';

/** Only collapse a single To into "You" when that address is the active mailbox. */
export function shouldCollapseRecipientToYou(args: {
  folder?: string | null;
  to: Array<{ email?: string }>;
  ccLength: number;
  mailboxEmail?: string | null;
}): boolean {
  if (args.folder === 'sent') return false;
  if (args.to.length !== 1 || args.ccLength !== 0) return false;
  const mailbox = cleanEmailDisplay(args.mailboxEmail ?? undefined).toLowerCase();
  if (!mailbox) return false;
  const recipient = cleanEmailDisplay(args.to[0]?.email).toLowerCase();
  return recipient === mailbox;
}
