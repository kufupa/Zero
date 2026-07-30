import { load } from 'cheerio';
import { BLOCKED_IMAGE_PLACEHOLDER } from './sanitize-email-html.js';

export type CidAttachmentMeta = {
  attachmentId: string;
  contentId: string | null;
  mimeType: string;
  sizeBytes: number;
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

function isImageMime(mime: string): boolean {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  return m === 'image/png' || m === 'image/jpeg' || m === 'image/gif' || m === 'image/webp';
}

export function projectCidImages(
  html: string,
  attachments: CidAttachmentMeta[],
  opts: { messageId: string; origin: string },
): { html: string; hasBlockedImages: boolean } {
  const byCid = new Map<string, CidAttachmentMeta>();
  const ambiguous = new Set<string>();
  for (const a of attachments) {
    if (!a.contentId || !isImageMime(a.mimeType)) continue;
    const id = normalizeContentId(a.contentId);
    if (!id) continue;
    if (byCid.has(id) || ambiguous.has(id)) {
      byCid.delete(id);
      ambiguous.add(id);
      continue;
    }
    byCid.set(id, a);
  }

  const origin = opts.origin.replace(/\/$/, '');
  let hasBlockedImages = false;
  const $ = load(html, null, false);
  $('img[src]').each((_i, el) => {
    const src = $(el).attr('src') ?? '';
    if (!/^cid:/i.test(src.trim())) return;
    const id = normalizeContentId(src);
    const att = id ? byCid.get(id) : undefined;
    if (!att) {
      hasBlockedImages = true;
      $(el).attr('src', BLOCKED_IMAGE_PLACEHOLDER);
      return;
    }
    $(el).attr(
      'src',
      `${origin}/api/mail/messages/${encodeURIComponent(opts.messageId)}/attachments/${encodeURIComponent(att.attachmentId)}/inline`,
    );
  });
  return { html: $.html(), hasBlockedImages };
}
