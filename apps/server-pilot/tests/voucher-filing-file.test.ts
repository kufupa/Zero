import { describe, expect, it } from 'vitest';
import { isVoucherPdfFilename, isVoucherPdfMime } from '../src/ai/voucher-filing-file.js';

describe('filing PDF metadata prefilter', () => {
  it('accepts Unicode, apostrophes and brackets without allowing paths or controls', () => {
    for (const name of ['Voucher Müller.pdf', "O'Neil [voucher].PDF", '旅行.pdf']) {
      expect(isVoucherPdfFilename(name)).toBe(true);
    }
    for (const name of ['', '../voucher.pdf', 'folder\\voucher.pdf', 'bad\u0000name.pdf', 'voucher.txt']) {
      expect(isVoucherPdfFilename(name)).toBe(false);
    }
  });
  it('accepts PDF and generic binary MIME but not unrelated types', () => {
    for (const mime of ['application/pdf', 'Application/PDF; name=booking.pdf', 'application/x-pdf', 'application/octet-stream']) {
      expect(isVoucherPdfMime(mime)).toBe(true);
    }
    for (const mime of ['', 'image/png', 'text/html']) expect(isVoucherPdfMime(mime)).toBe(false);
  });
});
