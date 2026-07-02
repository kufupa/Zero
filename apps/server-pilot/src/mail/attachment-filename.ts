function isUnsafeFilenameChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return char === '"' || code <= 0x1f || code === 0x7f;
}

function stripUnsafeFilenameChars(raw: string): string {
  return [...raw].filter((char) => !isUnsafeFilenameChar(char)).join('');
}

function isAsciiPrintable(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e;
}

function asciiFilenameFallback(raw: string): string {
  const stripped = [...stripUnsafeFilenameChars(raw)]
    .map((char) => (isAsciiPrintable(char) ? char : '_'))
    .join('');
  return stripped || 'attachment';
}

function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build a safe `Content-Disposition` value for S3 `ResponseContentDisposition`.
 *
 * Legacy `filename=` strips quotes and control chars. Non-ASCII names also get
 * RFC 5987 `filename*=UTF-8''...` so browsers can recover the original label.
 */
export function formatContentDispositionFilename(raw: string): string {
  const sanitized = stripUnsafeFilenameChars(raw);
  const legacy = asciiFilenameFallback(raw);

  if ([...sanitized].every(isAsciiPrintable)) {
    return `attachment; filename="${legacy}"`;
  }

  const encoded = encodeRFC5987(sanitized);
  return `attachment; filename="${legacy}"; filename*=UTF-8''${encoded}`;
}
