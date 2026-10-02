import { resolveMailHtml } from '@/lib/mail/resolve-mail-html';
import { sanitizeMailBodyHtml } from '@/lib/mail/sanitize-mail-body-html';

export const UNSAFE_MAIL_CONTENT_PLACEHOLDER =
  '<p><em>Unable to load message content safely.</em></p>';

/**
 * Keep the client fallback available when server processing is unavailable,
 * but sanitize it with the same mail allowlist and image policy before display.
 */
export function resolveMailDisplayContent({
  frontendOnlyDemo: _frontendOnlyDemo,
  processedHtml,
  rawHtml,
  shouldLoadImages,
}: {
  frontendOnlyDemo: boolean;
  processedHtml?: string | null;
  rawHtml: string;
  shouldLoadImages: boolean;
}): { html: string; hasBlockedImages: boolean } {
  if (processedHtml) {
    return { html: processedHtml, hasBlockedImages: false };
  }

  const sanitized = sanitizeMailBodyHtml(rawHtml, { shouldLoadImages });
  return {
    html: resolveMailHtml({ rawHtml: sanitized.html, processedHtml }),
    hasBlockedImages: sanitized.hasBlockedImages,
  };
}

export function resolveMailDisplayHtml(input: {
  frontendOnlyDemo: boolean;
  processedHtml?: string | null;
  rawHtml: string;
  shouldLoadImages?: boolean;
}): string {
  return resolveMailDisplayContent({ ...input, shouldLoadImages: input.shouldLoadImages ?? false }).html;
}
