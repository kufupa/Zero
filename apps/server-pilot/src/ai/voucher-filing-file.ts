import { MAX_VOUCHER_FILING_BYTES } from './voucher-filing-bytes.js';

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
/** Same current-mail signal used by the Filing card; a PDF alone is not a voucher. */
export function isVoucherMail(input: { subject: string; bodyText: string; attachmentNames: string[] }): boolean {
  const head = input.bodyText.slice(0, 2000);
  return /\bvouchers?\b|\bvch\b|\bremittance\b|proof of payment/i.test(input.subject) ||
    /\bvouchers?\b|\bvch\b|\bremittance\b|proof of payment/i.test(head) ||
    /\bPOP\b/.test(input.subject) || /\bPOP\b/.test(head) ||
    input.attachmentNames.some((name) => /_vch_|voucher/i.test(name));
}

export function voucherFilingFiles<T extends { filename: string; mimeType: string; sizeBytes: number; isInline: boolean }>(files: T[]): T[] {
  return files.filter((file) => !file.isInline && isVoucherPdfFilename(file.filename) &&
    isVoucherPdfMime(file.mimeType) && Number.isSafeInteger(file.sizeBytes) &&
    file.sizeBytes > 0 && file.sizeBytes <= MAX_VOUCHER_FILING_BYTES);
}
