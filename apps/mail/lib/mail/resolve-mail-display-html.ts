import { resolveMailHtml } from '@/lib/mail/resolve-mail-html';

export const UNSAFE_MAIL_CONTENT_PLACEHOLDER =
  '<p><em>Unable to load message content safely.</em></p>';

export function resolveMailDisplayHtml({
  frontendOnlyDemo,
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

  if (frontendOnlyDemo) {
    return resolveMailHtml({
      rawHtml,
      processedHtml,
    });
  }

  return UNSAFE_MAIL_CONTENT_PLACEHOLDER;
}
