import sanitizeHtml from 'sanitize-html';

/** 1×1 transparent GIF — safe placeholder for blocked remote images. */
export const BLOCKED_IMAGE_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function imgScheme(src: string): string {
  const match = src.match(/^([a-z][a-z0-9+.-]*):/i);
  return match ? match[1].toLowerCase() : '';
}

function isAllowedImgSrc(src: string, shouldLoadImages: boolean): boolean {
  const scheme = imgScheme(src);
  if (scheme === 'cid') return true;
  if (scheme === 'data') return src === BLOCKED_IMAGE_PLACEHOLDER;
  if (!shouldLoadImages) return false;
  if (!scheme) return true;
  return scheme === 'http' || scheme === 'https';
}

export function sanitizeEmailHtml(
  html: string,
  opts: { shouldLoadImages: boolean },
): { html: string; hasBlockedImages: boolean } {
  let hasBlockedImages = false;

  // Always allow data: so BLOCKED_IMAGE_PLACEHOLDER survives sanitization.
  // Untrusted data: URIs are still replaced in transformTags via isAllowedImgSrc.
  const allowedImgSchemes = opts.shouldLoadImages
    ? ['http', 'https', 'data', 'cid']
    : ['cid', 'data'];

  const sanitizeConfig: sanitizeHtml.IOptions = {
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
        const rawSrc = attribs.src;
        const src = rawSrc?.trim() ?? '';
        if (src && !isAllowedImgSrc(src, opts.shouldLoadImages)) {
          hasBlockedImages = true;
          const blockedAttribs = { ...attribs };
          delete blockedAttribs.width;
          delete blockedAttribs.height;
          return {
            tagName,
            attribs: {
              ...blockedAttribs,
              src: BLOCKED_IMAGE_PLACEHOLDER,
            },
          };
        }
        if (rawSrc !== undefined && src !== rawSrc) {
          return { tagName, attribs: { ...attribs, src } };
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
  // XSS only — remote img URLs preserved; trust gate is processEmailContent.
  return sanitizeEmailHtml(html, { shouldLoadImages: true }).html;
}
