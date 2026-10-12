import type { QuoteSession } from '@/lib/quote-workflow/types';

/**
 * The one status line under the quote header. A single cause gets a single line:
 * the most specific reason wins, so a failed lookup no longer shows its error and
 * its mailbox state as two banners.
 */
export function paneStatusLine(session: QuoteSession): string | null {
  if (session.phase === 'missing_source') {
    const missing = session.missing.length ? ` Could not read: ${session.missing.join(', ')}.` : '';
    return `Nava could not read the attachment contents. Open the attachment in Outlook and check it by hand.${missing}`;
  }
  if (session.mailboxStatus === 'missing_source') {
    return 'Attachment contents are missing. Open the attachment in Outlook and check it by hand.';
  }
  if (session.mailboxStatus === 'unsynced') {
    return 'This email has not finished syncing, so this result may be out of date. Wait for sync, then select the email again.';
  }
  if (session.phase === 'failed') {
    return session.errorMessage ?? 'Nava could not read this email. Select it again, or enter the booking details by hand.';
  }
  if (session.errorMessage) return session.errorMessage;
  if (session.mailboxStatus === 'unavailable') {
    return 'Nava is not connected to this pane yet. Refresh the pane and try again.';
  }
  return null;
}

export function PaneStatusLine({ session }: { session: QuoteSession }) {
  const message = paneStatusLine(session);
  if (!message) return null;
  return (
    <p aria-live="polite" className="rounded-xs border border-[#e2e8f0] bg-white px-3 py-2 text-xs text-[#475569]">
      {message}
    </p>
  );
}
