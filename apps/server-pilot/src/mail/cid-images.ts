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

type InlineImageMetadataEligibility =
  | 'eligible'
  | 'not-found'
  | 'metadata-too-large'
  | 'unsupported-mime';

export type UniqueInlineAttachmentResult =
  | { kind: 'eligible'; attachment: CidAttachmentMeta }
  | { kind: Exclude<InlineImageMetadataEligibility, 'eligible'> };

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

function classifyInlineImageMetadata(
  attachment: CidAttachmentMeta,
): InlineImageMetadataEligibility {
  if (
    attachment.isInline !== true ||
    !Number.isSafeInteger(attachment.sizeBytes) ||
    attachment.sizeBytes <= 0
  ) {
    return 'not-found';
  }
  if (attachment.sizeBytes > MAX_INLINE_IMAGE_BYTES) return 'metadata-too-large';
  if (!isSupportedInlineImageMime(attachment.mimeType)) return 'unsupported-mime';
  return 'eligible';
}

/** Shared metadata gate for CID projection and direct inline-attachment serving. */
export function isEligibleInlineImageMetadata(attachment: CidAttachmentMeta): boolean {
  return classifyInlineImageMetadata(attachment) === 'eligible';
}

/**
 * Resolve a CID only when exactly one message attachment owns its normalized
 * ID. Projection only uses `eligible`; inline HTTP maps metadata failures to
 * its opaque status contract without reading storage.
 */
export function findUniqueEligibleInlineAttachment(
  rawContentId: string | null,
  attachments: readonly CidAttachmentMeta[],
): UniqueInlineAttachmentResult {
  const contentId = rawContentId ? normalizeContentId(rawContentId) : null;
  if (!contentId) return { kind: 'not-found' };

  let matched: CidAttachmentMeta | null = null;
  for (const attachment of attachments) {
    if (!attachment.contentId || normalizeContentId(attachment.contentId) !== contentId) continue;
    if (matched) return { kind: 'not-found' };
    matched = attachment;
  }

  if (!matched) return { kind: 'not-found' };
  const metadataEligibility = classifyInlineImageMetadata(matched);
  if (metadataEligibility !== 'eligible') return { kind: metadataEligibility };
  return { kind: 'eligible', attachment: matched };
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
    const resolved = findUniqueEligibleInlineAttachment(src, attachments);
    if (resolved.kind !== 'eligible') {
      hasBlockedImages = true;
      $(el).removeAttr('width').removeAttr('height').attr('src', BLOCKED_IMAGE_PLACEHOLDER);
      return;
    }
    const { attachment: att } = resolved;
    $(el).attr(
      'src',
      `${origin}/api/mail/messages/${encodeURIComponent(opts.messageId)}/attachments/${encodeURIComponent(att.attachmentId)}/inline`,
    );
  });
  return { html: $.html(), hasBlockedImages };
}
