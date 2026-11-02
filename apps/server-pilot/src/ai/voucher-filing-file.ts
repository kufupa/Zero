/** Metadata prefilter only. Callers must still read and verify the actual PDF bytes. */
export function isVoucherPdfFilename(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 150 &&
    /\.pdf$/i.test(value) && !value.includes('/') && !value.includes('\\') &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** POP3 uses octet-stream when the message supplies no content type. */
export function isVoucherPdfMime(value: string): boolean {
  if (typeof value !== 'string') return false;
  const mime = value.split(';', 1)[0]?.trim().toLowerCase();
  return mime === 'application/pdf' || mime === 'application/x-pdf' || mime === 'application/octet-stream';
}
