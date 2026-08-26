import { resolveMailHtml } from '@/lib/mail/resolve-mail-html';

export const UNSAFE_MAIL_CONTENT_PLACEHOLDER =
  '<p><em>Unable to load message content safely.</em></p>';

/**
 * HOTFIX: when processed HTML is missing, always use the client fallback
 * (script-stripped raw HTML) instead of the hard "unable to load safely"
 * placeholder. Re-tighten after processEmailContent reliability is restored.
 */
export function resolveMailDisplayHtml({
  frontendOnlyDemo: _frontendOnlyDemo,
  processedHtml,
  rawHtml,
}: {
  frontendOnlyDemo: boolean;
  processedHtml?: string | null;
  rawHtml: string;
}): string {
  if (processedHtml) {
    return processedHtml;
  }

  return resolveMailHtml({
    rawHtml,
    processedHtml,
  });
}
