import {
  documentMetadataSchema,
  documentValidationSchema,
  evaluateDocumentValidation,
  type DocumentMetadata,
  type ExistingDocumentScope,
} from '../src/mail/artifacts/existing-document-contracts.js';
import { describe, expect, it } from 'vitest';

const NOW = '2026-09-08T12:00:00.000Z';

function metadata(overrides: Partial<DocumentMetadata> = {}): DocumentMetadata {
  return documentMetadataSchema.parse({
    documentRef: 'doc-ref-1',
    source: 'mail_attachment',
    kind: 'tax_invoice',
    version: 'v2',
    issuedAt: NOW,
    status: 'final',
    parentRef: 'parent-ref-1',
    payerRef: 'payer-ref-1',
    displayName: 'tax-invoice.pdf',
    mime: 'application/pdf',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    retrievable: true,
    retrievalBlocker: null,
    priceVisibility: 'hidden',
    propertyRef: 'property-ref-1',
    guestRef: 'guest-ref-1',
    stayStart: '2026-09-10',
    stayEnd: '2026-09-12',
    currentVersion: true,
    ...overrides,
  });
}

function scope(overrides: Partial<ExistingDocumentScope> = {}): ExistingDocumentScope {
  return {
    scopeRef: 'scope-ref-1',
    propertyRef: 'property-ref-1',
    guestRef: 'guest-ref-1',
    stayStart: '2026-09-10',
    stayEnd: '2026-09-12',
    payerRef: 'payer-ref-1',
    requestedKind: 'tax_invoice',
    requestedPriceVisibility: 'allowed',
    ...overrides,
  };
}

describe('existing-document validation contract', () => {
  it('keeps identity, version, format, and price visibility as closed fields', () => {
    const value = evaluateDocumentValidation({
      document: metadata(),
      scope: scope(),
    });

    expect(documentValidationSchema.parse(value)).toEqual({
      identity: 'match',
      stayDates: 'match',
      payer: 'match',
      kind: 'match',
      version: 'current',
      priceVisibility: 'allowed',
    });
  });

  it.each([
    ['wrong guest', { guestRef: 'guest-ref-other' }, { identity: 'mismatch' }],
    ['old stay dates', { stayStart: '2026-08-10' }, { stayDates: 'mismatch' }],
    ['wrong bill-to', { payerRef: 'payer-ref-other' }, { payer: 'mismatch' }],
    ['proforma for invoice request', { kind: 'pro_forma' }, { kind: 'mismatch' }],
    ['superseded version', { currentVersion: false }, { version: 'superseded' }],
  ] as const)(
    'marks %s unusable without hiding the mismatch',
    (_label, documentPatch, expected) => {
      const result = evaluateDocumentValidation({
        document: metadata(documentPatch),
        scope: scope(),
      });

      expect(result).toMatchObject(expected);
      if (result.version === 'superseded') {
        expect(result.version).toBe('superseded');
      } else {
        expect(Object.values(result)).toContain('mismatch');
      }
    },
  );

  it('forbids price-visible bytes when the request allows no price', () => {
    const result = evaluateDocumentValidation({
      document: metadata({ priceVisibility: 'visible' }),
      scope: scope({ requestedPriceVisibility: 'forbidden' }),
    });

    expect(result.priceVisibility).toBe('forbidden');
  });

  it('keeps missing constraints unknown rather than treating them as a match', () => {
    const result = evaluateDocumentValidation({
      document: metadata({ guestRef: null, payerRef: null, stayStart: null, stayEnd: null }),
      scope: scope({ guestRef: null, payerRef: null, stayStart: null, stayEnd: null }),
    });

    expect(result).toEqual({
      identity: 'unknown',
      stayDates: 'unknown',
      payer: 'unknown',
      kind: 'match',
      version: 'current',
      priceVisibility: 'allowed',
    });
  });
});
