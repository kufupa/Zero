import { load } from 'cheerio';
import { BLOCKED_IMAGE_PLACEHOLDER } from './sanitize-email-html.js';
import { MAX_INLINE_IMAGE_BYTES } from './safe-inline-image.js';

export type CidAttachmentMeta = {
  attachmentId: string;
  contentId: string | null;
  mimeType: string;
  sizeBytes: number;
  isInline: boolean;
};

const INLINE_RASTER_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/**
 * Normalize MIME Content-ID using protocol order. Decode happens exactly once.
 */
export function normalizeContentId(raw: string): string | null {
  let normalized = raw;
  if (/^cid:/i.test(normalized)) normalized = normalized.slice(4);

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    return null;
  }

  if (/\p{Cc}/u.test(normalized)) return null;

  normalized = normalized.trim();
  if (normalized.startsWith('<') && normalized.endsWith('>')) {
    normalized = normalized.slice(1, -1);
  }
  normalized = normalized.toLowerCase();

  if (!normalized || /[\\/?#]/.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizedMimeType(mimeType: string): string {
  return (mimeType.split(';', 1)[0] ?? '').trim().toLowerCase();
}

function isProjectableAttachment(
  attachment: CidAttachmentMeta,
): boolean {
  return (
    attachment.isInline === true &&
    attachment.attachmentId.length > 0 &&
    Number.isSafeInteger(attachment.sizeBytes) &&
    attachment.sizeBytes >= 0 &&
    attachment.sizeBytes <= MAX_INLINE_IMAGE_BYTES &&
    INLINE_RASTER_MIME_TYPES.has(normalizedMimeType(attachment.mimeType))
  );
}

function indexUniqueContentIds(
  attachments: readonly CidAttachmentMeta[],
): Map<string, CidAttachmentMeta | null> {
  const byContentId = new Map<string, CidAttachmentMeta | null>();

  for (const attachment of attachments) {
    if (!attachment.contentId) continue;
    const contentId = normalizeContentId(attachment.contentId);
    if (!contentId) continue;

    if (byContentId.has(contentId)) {
      byContentId.set(contentId, null);
    } else {
      byContentId.set(contentId, attachment);
    }
  }

  return byContentId;
}

/**
 * Project sanitized CID img sources through the same-message inline endpoint.
 */
export function projectCidImages(
  html: string,
  attachments: readonly CidAttachmentMeta[],
  opts: { messageId: string; origin: string },
): { html: string; hasBlockedImages: boolean } {
  const byContentId = indexUniqueContentIds(attachments);
  const origin = opts.origin.replace(/\/+$/, '');
  const $ = load(html, null, false);
  let hasBlockedImages = false;

  $('img[src]').each((_index, node) => {
    const image = $(node);
    const src = image.attr('src') ?? '';
    if (!/^\s*cid:/i.test(src)) return;

    const contentId = normalizeContentId(src);
    const attachment = contentId
      ? byContentId.get(contentId)
      : undefined;

    if (!attachment || !isProjectableAttachment(attachment)) {
      image.attr('src', BLOCKED_IMAGE_PLACEHOLDER);
      hasBlockedImages = true;
      return;
    }

    image.attr(
      'src',
      `${origin}/api/mail/messages/${encodeURIComponent(opts.messageId)}/attachments/${encodeURIComponent(attachment.attachmentId)}/inline`,
    );
  });

  return { html: $.html(), hasBlockedImages };
}
