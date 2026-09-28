import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmsDocumentReadDataSchema } from '../src/hms/hms-document-read-contract.js';

describe('HMS document byte contract', () => {
  it('accepts bytes only when length and digest bind the payload', () => {
    const bytes = Buffer.from('%PDF-read-only%');
    const parsed = hmsDocumentReadDataSchema.parse({
      documentRef: 'doc-1',
      mimeType: 'application/pdf',
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytesBase64: bytes.toString('base64'),
      observedAt: '2026-09-16T10:00:00.000Z',
      source: 'hms',
    });
    expect(parsed.byteLength).toBe(bytes.byteLength);
  });

  it('rejects fabricated, malformed or mismatched bytes', () => {
    const base = {
      documentRef: 'doc-1',
      mimeType: 'application/pdf',
      byteLength: 3,
      sha256: 'a'.repeat(64),
      bytesBase64: Buffer.from('abc').toString('base64'),
      observedAt: '2026-09-16T10:00:00.000Z',
      source: 'hms' as const,
    };
    expect(() => hmsDocumentReadDataSchema.parse(base)).toThrow(/sha256/);
    expect(() =>
      hmsDocumentReadDataSchema.parse({ ...base, bytesBase64: 'not-base64!' }),
    ).toThrow(/base64/);
    expect(() =>
      hmsDocumentReadDataSchema.parse({ ...base, byteLength: 4 }),
    ).toThrow(/byteLength/);
  });
});
