import sanitizeHtml from 'sanitize-html';

export function mailListPlainPreview(input: string | null | undefined): string {
  const raw = input?.trim() ?? '';
  if (!raw) return '';

  const spacedHtml = raw.replace(/>\s*</g, '> <');
  const withoutTags = sanitizeHtml(spacedHtml, {
    allowedTags: [],
    allowedAttributes: {},
  });

  return withoutTags.replace(/\s+/g, ' ').trim();
}
