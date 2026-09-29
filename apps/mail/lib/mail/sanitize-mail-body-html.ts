import sanitizeHtml from 'sanitize-html';

/** Same inert pixel used by the server sanitizer while remote images are blocked. */
export const BLOCKED_MAIL_IMAGE =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function imageScheme(src: string): string {
  return src.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase() ?? '';
}

function isAllowedImageSource(src: string, shouldLoadImages: boolean): boolean {
  const scheme = imageScheme(src);
  if (scheme === 'cid') return true;
  if (scheme === 'data') return src === BLOCKED_MAIL_IMAGE;
  if (!shouldLoadImages) return false;
  if (!scheme) return true;
  return scheme === 'http' || scheme === 'https';
}

/**
 * Safe client-side fallback for when server-side email processing is unavailable.
 * Keep the inbound mail allowlist aligned with server-pilot/src/mail/sanitize-email-html.ts.
 */
export function sanitizeMailBodyHtml(
  html: string,
  options: { shouldLoadImages: boolean },
): { html: string; hasBlockedImages: boolean } {
  if (!html) return { html: '<p><em>No email content available</em></p>', hasBlockedImages: false };

  let hasBlockedImages = false;
  const allowedImgSchemes = options.shouldLoadImages
    ? ['http', 'https', 'data', 'cid']
    : ['cid', 'data'];
  const sanitized = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'title', 'details', 'summary']),
    allowedAttributes: {
      '*': [
        'class',
        'align',
        'valign',
        'width',
        'height',
        'cellpadding',
        'cellspacing',
        'border',
        'bgcolor',
        'colspan',
        'rowspan',
      ],
      a: ['href', 'name', 'target', 'rel', 'class'],
      img: ['src', 'alt', 'width', 'height', 'class'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: allowedImgSchemes },
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: 'a',
        attribs: { ...attribs, target: attribs.target || '_blank', rel: 'noopener noreferrer' },
      }),
      img: (_tagName, attribs) => {
        const rawSrc = attribs.src;
        const src = rawSrc?.trim() ?? '';
        if (src && !isAllowedImageSource(src, options.shouldLoadImages)) {
          hasBlockedImages = true;
          const blockedAttribs = { ...attribs };
          delete blockedAttribs.width;
          delete blockedAttribs.height;
          return { tagName: 'img', attribs: { ...blockedAttribs, src: BLOCKED_MAIL_IMAGE } };
        }
        if (rawSrc !== undefined && src !== rawSrc) {
          return { tagName: 'img', attribs: { ...attribs, src } };
        }
        return { tagName: 'img', attribs };
      },
    },
  });

  return { html: sanitized, hasBlockedImages };
}
