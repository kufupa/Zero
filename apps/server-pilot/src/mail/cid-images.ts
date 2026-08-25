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

/** Build normalized CID eligibility once for a complete message attachment set. */
export function buildCidEligibilityIndex(
  attachments: readonly CidAttachmentMeta[],
): Map<string, UniqueInlineAttachmentResult> {
  const byCid = new Map<string, UniqueInlineAttachmentResult>();
  for (const attachment of attachments) {
    const contentId = attachment.contentId ? normalizeContentId(attachment.contentId) : null;
    if (!contentId) continue;
    if (byCid.has(contentId)) {
      byCid.set(contentId, { kind: 'not-found' });
      continue;
    }

    const metadataEligibility = classifyInlineImageMetadata(attachment);
    byCid.set(
      contentId,
      metadataEligibility === 'eligible'
        ? { kind: 'eligible', attachment }
        : { kind: metadataEligibility },
    );
  }
  return byCid;
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
  return buildCidEligibilityIndex(attachments).get(contentId) ?? { kind: 'not-found' };
}

export function projectCidImages(
  html: string,
  attachments: CidAttachmentMeta[],
  opts: { messageId: string; origin: string },
): { html: string; hasBlockedImages: boolean } {
  const origin = opts.origin.replace(/\/$/, '');
  const eligibility = buildCidEligibilityIndex(attachments);
  let hasBlockedImages = false;
  const $ = load(html, null, false);
  $('img[src]').each((_i, el) => {
    const src = $(el).attr('src') ?? '';
    if (!/^cid:/i.test(src.trim())) return;
    const contentId = normalizeContentId(src);
    const resolved: UniqueInlineAttachmentResult = contentId
      ? (eligibility.get(contentId) ?? { kind: 'not-found' })
      : { kind: 'not-found' };
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
