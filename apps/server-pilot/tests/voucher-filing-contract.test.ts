import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateVoucherFilingBytes, voucherFilingFormSchema } from '../src/ai/voucher-filing-contract.js';

const bytes = Buffer.from('%PDF-1.7 synthetic');
const form = {
  executor: 'cloud-write/v1' as const, action: 'attach_document' as const, propertyCode: 'HRCEN',
  payload: { source: { transportId: 'transport', messageId: 'message', attachmentId: 'attachment',
    filename: 'proof.pdf', mimeType: 'application/pdf' as const, sha256: createHash('sha256').update(bytes).digest('hex'),
    snapshotDigest: 'a'.repeat(64) },
    stay: { confirmation: '123456-1', arrival: '2027-01-02', firstName: 'Proof', lastName: 'Labtest' }, kind: 'proof_of_payment' as const },
};

describe('Cloud voucher filing approved form', () => {
  it('requires the source, property, exact document type and content hash', () => {
    expect(voucherFilingFormSchema.safeParse(form).success).toBe(true);
    for (const candidate of [
      { ...form, propertyCode: '' },
      { ...form, payload: { ...form.payload, source: { ...form.payload.source, sha256: '' } } },
      { ...form, payload: { ...form.payload, source: { ...form.payload.source, snapshotDigest: '' } } },
      { ...form, payload: { ...form.payload, source: { ...form.payload.source, messageId: '' } } },
      { ...form, payload: { ...form.payload, source: { ...form.payload.source, filename: '../proof.pdf' } } },
      { ...form, payload: { ...form.payload, kind: 'payment_settled' } },
      { ...form, executor: 'legacy' },
    ]) expect(voucherFilingFormSchema.safeParse(candidate).success).toBe(false);
  });
  it('refuses changed bytes, non-PDF bytes and incorrect size despite a PDF name', () => {
    expect(validateVoucherFilingBytes(form, bytes)).toBe('ok');
    expect(validateVoucherFilingBytes(form, Buffer.from('%PDF-1.7 changed'))).toBe('hash_mismatch');
    expect(validateVoucherFilingBytes(form, Buffer.from('not a PDF'))).toBe('unsupported_format');
    expect(validateVoucherFilingBytes(form, Buffer.alloc(0))).toBe('invalid_size');
    expect(validateVoucherFilingBytes(form, Buffer.alloc(10 * 1024 * 1024 + 1))).toBe('invalid_size');
  });
});
