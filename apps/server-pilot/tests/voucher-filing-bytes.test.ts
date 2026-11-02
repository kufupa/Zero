import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MAX_VOUCHER_FILING_BYTES, readVerifiedVoucherBytes } from '../src/ai/voucher-filing-bytes.js';

const pdf = Buffer.from('%PDF-1.7 synthetic voucher');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const request = () => ({
  expectedBytes: pdf.length,
  expectedSha256: sha256(pdf),
  signal: new AbortController().signal,
  readBounded: vi.fn(async (_maxBytes: number, _signal: AbortSignal): Promise<Uint8Array | null> => pdf),
});

describe('filing attachment byte binding', () => {
  it('returns owned bytes only after bounded read and matching hash', async () => {
    const input = request();
    const result = await readVerifiedVoucherBytes(input);
    expect(result).toEqual(pdf);
    expect(result).not.toBe(pdf);
    expect(input.readBounded).toHaveBeenCalledWith(pdf.length, input.signal);
  });

  it('refuses absent or malformed hashes and invalid size without reading', async () => {
    const input = request();
    for (const expectedSha256 of [null, '', 'A'.repeat(64), '0'.repeat(63)]) {
      expect(await readVerifiedVoucherBytes({ ...input, expectedSha256 })).toBeNull();
    }
    for (const expectedBytes of [0, -1, 1.5, NaN, MAX_VOUCHER_FILING_BYTES + 1]) {
      expect(await readVerifiedVoucherBytes({ ...input, expectedBytes })).toBeNull();
    }
    expect(input.readBounded).not.toHaveBeenCalled();
  });

  it('refuses missing, oversized, changed, or non-PDF bytes', async () => {
    const input = request();
    const changed = Buffer.from(pdf);
    changed[6] ^= 1;
    for (const bytes of [null, Buffer.concat([pdf, Buffer.from('x')]), changed]) {
      expect(await readVerifiedVoucherBytes({ ...input, readBounded: async () => bytes })).toBeNull();
    }
    const notPdf = Buffer.from('not a PDF');
    expect(await readVerifiedVoucherBytes({ ...input, expectedBytes: notPdf.length,
      expectedSha256: sha256(notPdf), readBounded: async () => notPdf })).toBeNull();
  });

  it('refuses storage errors and cancellation before or during the read', async () => {
    const input = request();
    expect(await readVerifiedVoucherBytes({ ...input, readBounded: async () => { throw new Error('storage'); } })).toBeNull();
    const preAborted = new AbortController();
    preAborted.abort();
    expect(await readVerifiedVoucherBytes({ ...input, signal: preAborted.signal })).toBeNull();
    expect(input.readBounded).not.toHaveBeenCalled();
    const duringRead = new AbortController();
    expect(await readVerifiedVoucherBytes({ ...input, signal: duringRead.signal, readBounded: async () => {
      duringRead.abort();
      return pdf;
    } })).toBeNull();
  });
});
