import { isSupportedInlineImageMime, MAX_INLINE_IMAGE_BYTES } from './safe-inline-image.js';
import { BLOCKED_IMAGE_PLACEHOLDER } from './sanitize-email-html.js';
import { load } from 'cheerio';

export type CidAttachmentMeta = {
  attachmentId: string;
  contentId: string | null;
  mimeType: string;
  sizeBytes: number;
  isInline: boolean;
};

export function normalizeContentId(raw: string): string | null {
  let s = raw.trim();
  if (/^cid:/i.test(s)) s = s.slice(4);
  try {
    s = decodeURIComponent(s);
  } catch {
    return null;
  }
  s = s.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1);
  s = s.trim().toLowerCase();
  if (!s || /[/?#]/.test(s) || [...s].some((c) => c.charCodeAt(0) < 0x20)) return null;
  return s;
}

/** Shared metadata gate for CID projection and direct inline-attachment serving. */
export function isEligibleInlineImageMetadata(attachment: CidAttachmentMeta): boolean {
  return (
    attachment.isInline === true &&
    isSupportedInlineImageMime(attachment.mimeType) &&
    Number.isSafeInteger(attachment.sizeBytes) &&
    attachment.sizeBytes > 0 &&
    attachment.sizeBytes <= MAX_INLINE_IMAGE_BYTES
  );
}

/**
 * Resolve a CID only when exactly one message attachment owns its normalized
 * ID and that attachment passes the shared inline-image metadata gate.
 */
export function findUniqueEligibleInlineAttachment(
  rawContentId: string | null,
  attachments: readonly CidAttachmentMeta[],
): CidAttachmentMeta | null {
  const contentId = rawContentId ? normalizeContentId(rawContentId) : null;
  if (!contentId) return null;

  let matched: CidAttachmentMeta | null = null;
  for (const attachment of attachments) {
    if (!attachment.contentId || normalizeContentId(attachment.contentId) !== contentId) continue;
    if (matched) return null;
    matched = attachment;
  }

  return matched && isEligibleInlineImageMetadata(matched) ? matched : null;
}

export function projectCidImages(
  html: string,
  attachments: CidAttachmentMeta[],
  opts: { messageId: string; origin: string },
): { html: string; hasBlockedImages: boolean } {
  const origin = opts.origin.replace(/\/$/, '');
  let hasBlockedImages = false;
  const $ = load(html, null, false);
  $('img[src]').each((_i, el) => {
    const src = $(el).attr('src') ?? '';
    if (!/^cid:/i.test(src.trim())) return;
    const att = findUniqueEligibleInlineAttachment(src, attachments);
    if (!att) {
      hasBlockedImages = true;
      $(el).removeAttr('width').removeAttr('height').attr('src', BLOCKED_IMAGE_PLACEHOLDER);
      return;
    }
    $(el).attr(
      'src',
      `${origin}/api/mail/messages/${encodeURIComponent(opts.messageId)}/attachments/${encodeURIComponent(att.attachmentId)}/inline`,
    );
  });
  return { html: $.html(), hasBlockedImages };
}
