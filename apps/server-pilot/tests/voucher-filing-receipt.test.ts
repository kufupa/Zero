import { describe, expect, it } from 'vitest';
import { parseVoucherFilingReceipt } from '../src/ai/voucher-filing-receipt.js';

const receipt = { key: 'outlook-sync-originals/v1/key/hash', bytes: 20, sha256: 'a'.repeat(64), eTag: '"etag"' };

describe('filing source receipt', () => {
  it('accepts both unversioned and versioned receipts', () => {
    expect(parseVoucherFilingReceipt(receipt)).toEqual(receipt);
    expect(parseVoucherFilingReceipt({ ...receipt, versionId: 'version' })?.versionId).toBe('version');
    // S3 may expose a mutable null-version object; byte and ETag validation still apply.
    expect(parseVoucherFilingReceipt({ ...receipt, versionId: 'null' })?.versionId).toBe('null');
  });
  it('rejects malformed identity and unsafe metadata', () => {
    for (const patch of [{ versionId: '' }, { versionId: 'x\ny' }, { eTag: 'x\ny' },
      { bytes: 0 }, { sha256: '' }, { extra: true }]) {
      expect(parseVoucherFilingReceipt({ ...receipt, ...patch })).toBeNull();
    }
  });
});
