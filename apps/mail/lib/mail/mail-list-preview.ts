export function mailListPlainPreview(input: string | null | undefined): string {
  const raw = input?.trim() ?? '';
  if (!raw) return '';

  const spacedHtml = raw.replace(/>\s*</g, '> <');
  if (typeof document === 'undefined') {
    return spacedHtml.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }

  const container = document.createElement('div');
  container.innerHTML = spacedHtml;
  const withoutTags = container.textContent ?? '';

  return withoutTags.replace(/\s+/g, ' ').trim();
}
