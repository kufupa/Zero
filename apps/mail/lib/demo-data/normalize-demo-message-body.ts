const SCRIPT_TAG_REGEX = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const BLOCK_HTML_FRAGMENT_REGEX = /^<(?:p|div|h[1-6]|ul|ol|li|blockquote|table|section|article|br)\b[\s\S]*>/i;

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

export function normalizeDemoMessageBody(input: { body: string; bodyFormat: 'text' | 'html' }): string {
  const normalized = input.body.trim();
  if (!normalized) return '';

  if (input.bodyFormat === 'html' || isHtmlFragment(normalized)) {
    return normalized.replace(SCRIPT_TAG_REGEX, '').trim();
  }

  const safe = escapeHtml(normalized);
  return safe
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<p>${line}</p>`)
    .join('');
}

function isHtmlFragment(value: string): boolean {
  return BLOCK_HTML_FRAGMENT_REGEX.test(value);
}
