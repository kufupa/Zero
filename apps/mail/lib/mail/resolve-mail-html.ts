const NO_CONTENT_HTML = '<p><em>No email content available</em></p>';

const BODY_TAG_REGEX = /<body\b[^>]*>([\s\S]*?)<\/body>/i;
const HTML_TAG_REGEX = /<\/?[a-z][\s\S]*>/i;
const SCRIPT_TAG_REGEX = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
const STRIP_WRAPPER_TAGS_REGEX = /<\/?(?:html|head|body)\b[^>]*>/gi;

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const normalizeText = (value: string): string =>
  value
    .replace(/\r\n?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

export function resolveMailHtml({
  rawHtml,
  processedHtml,
}: {
  rawHtml?: string | null;
  processedHtml?: string | null;
}): string {
  const normalizedProcessed = processedHtml?.trim();
  if (normalizedProcessed) {
    return normalizedProcessed;
  }

  const normalizedRaw = rawHtml?.trim();
  if (!normalizedRaw) {
    return NO_CONTENT_HTML;
  }

  const bodyContent = normalizedRaw.match(BODY_TAG_REGEX)?.[1] ?? normalizedRaw;
  const cleanedRaw = bodyContent
    .replace(SCRIPT_TAG_REGEX, '')
    .replace(STRIP_WRAPPER_TAGS_REGEX, '')
    .trim();

  if (!cleanedRaw) {
    return NO_CONTENT_HTML;
  }

  if (HTML_TAG_REGEX.test(cleanedRaw)) {
    return cleanedRaw;
  }

  const escaped = escapeHtml(normalizeText(cleanedRaw)).replaceAll('\n', '<br />');
  return `<div>${escaped}</div>`;
}
