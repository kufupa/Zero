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

export const MAIL_BODY_STYLE_TAG = `<style data-nava-mail-font="1">
:host, .mail-content-root, .nava-mail-body {
  display: block;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  contain: inline-size;
  font-family: Calibri, Arial, sans-serif;
  font-size: 11pt;
  color: #000000;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
}
:host table {
  table-layout: fixed !important;
  width: 100% !important;
  max-width: 100% !important;
}
:host img {
  max-width: 100% !important;
  height: auto !important;
  object-fit: contain;
}
:host td, :host th, :host p, :host div, :host li, :host span {
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
  max-width: 100% !important;
}
:host pre, :host code {
  white-space: pre-wrap !important;
  overflow-wrap: anywhere;
}
:host p.MsoNormal {
  margin: 0;
}
</style>`;

export function resolveMailHtml({
  rawHtml,
  processedHtml,
}: {
  rawHtml?: string | null;
  processedHtml?: string | null;
}): string {
  const normalizedProcessed = processedHtml?.trim();
  if (normalizedProcessed) {
    return normalizedProcessed.includes('data-nava-mail-font="1"')
      ? normalizedProcessed
      : `${MAIL_BODY_STYLE_TAG}${normalizedProcessed}`;
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
    return `${MAIL_BODY_STYLE_TAG}${cleanedRaw}`;
  }

  const escaped = escapeHtml(normalizeText(cleanedRaw)).replaceAll('\n', '<br />');
  return `${MAIL_BODY_STYLE_TAG}<div>${escaped}</div>`;
}
