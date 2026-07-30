import { projectCidImages, type CidAttachmentMeta } from './cid-images.js';
import { sanitizeEmailHtml } from './sanitize-email-html.js';
import { processQuotedContent } from './collapse-quoted-html.js';

export function processEmailHtmlForDisplay(input: {
  html: string;
  messageId: string;
  shouldLoadImages: boolean;
  theme: 'light' | 'dark';
  origin: string;
  attachments: CidAttachmentMeta[];
}): { processedHtml: string; hasBlockedImages: boolean } {
  const sanitized = sanitizeEmailHtml(input.html, {
    shouldLoadImages: input.shouldLoadImages,
  });
  const projected = projectCidImages(sanitized.html, input.attachments, {
    messageId: input.messageId,
    origin: input.origin,
  });
  const processedHtml = processQuotedContent(projected.html, input.theme);
  return {
    processedHtml,
    hasBlockedImages: sanitized.hasBlockedImages || projected.hasBlockedImages,
  };
}
