import sanitizeHtml from 'sanitize-html';

/** 1×1 transparent GIF — safe placeholder for blocked remote images. */
export const BLOCKED_IMAGE_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function imgScheme(src: string): string {
  let schemeCandidate = '';
  for (let index = 0; index < src.length; index += 1) {
    if (src.charCodeAt(index) > 0x20) schemeCandidate += src[index];
  }
  const match = schemeCandidate.match(/^([a-z][a-z0-9+.-]*):/i);
  return match ? match[1].toLowerCase() : '';
}

function isAllowedImgSrc(src: string, shouldLoadImages: boolean): boolean {
  if (src.includes('<') || src.includes('>')) return false;
  if (src === BLOCKED_IMAGE_PLACEHOLDER) return true;
  const scheme = imgScheme(src);
  if (scheme === 'cid') return true;
  if (!shouldLoadImages) return false;
  if (!scheme) return true;
  return scheme === 'http' || scheme === 'https';
}

export function sanitizeEmailHtml(
  html: string,
  opts: { shouldLoadImages: boolean },
): { html: string; hasBlockedImages: boolean } {
  let hasBlockedImages = false;

  // data: remains allowed at the sanitizer layer only so the exact generated
  // placeholder survives. Every other data: URI is replaced by transformTags.
  const allowedImgSchemes = opts.shouldLoadImages
    ? ['http', 'https', 'data', 'cid']
    : ['cid', 'data'];

  const sanitizeConfig: sanitizeHtml.IOptions = {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img',
      'title',
      'details',
      'summary',
    ]),
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
    allowedSchemesByTag: {
      img: allowedImgSchemes,
    },
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          target: attribs.target || '_blank',
          rel: 'noopener noreferrer',
        },
      }),
      img: (tagName, attribs) => {
        const src = attribs.src ?? '';
        if (src && !isAllowedImgSrc(src, opts.shouldLoadImages)) {
          hasBlockedImages = true;
          return {
            tagName,
            attribs: {
              ...attribs,
              src: BLOCKED_IMAGE_PLACEHOLDER,
            },
          };
        }
        return { tagName, attribs };
      },
    },
  };

  const sanitized = sanitizeHtml(html, sanitizeConfig);
  return { html: sanitized, hasBlockedImages };
}

/** Sanitize HTML before persisting to Postgres. Raw MIME remains in S3. */
export function sanitizeHtmlBodyForStorage(html: string | null): string | null {
  if (html == null || html === '') return html;
  if (!html.includes('<')) return html;
  // Preserve remote URLs for the later sender-trust gate while stripping XSS.
  return sanitizeEmailHtml(html, { shouldLoadImages: true }).html;
}
