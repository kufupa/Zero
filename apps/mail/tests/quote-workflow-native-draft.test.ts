import { describe, expect, it } from 'vitest';
import { requireReviewedNativeDraft } from '../lib/quote-workflow/native-draft';
import { initialQuoteSession } from '../lib/quote-workflow/session';

describe('native draft payload', () => {
  it('refuses wrapper-only insert until a reviewed reply and selected PDF exist', () => {
    const empty = initialQuoteSession();
    expect(requireReviewedNativeDraft(empty)).toBeNull();
    expect(
      requireReviewedNativeDraft({
        ...empty,
        reviewedReplyHtml: '<p>Parking is available on site.</p>',
      }),
    ).toBeNull();
  });

  it('refuses fixture PDF bytes even when html is present', () => {
    expect(
      requireReviewedNativeDraft({
        ...initialQuoteSession(),
        reviewedReplyHtml: '<p>Parking is available on site.</p>',
        pdf: { fileName: 'Quote-fixture-not-live-hms.pdf', bytesBase64: 'JVBERi0xLjQK' },
        evidence: {
          kind: 'fixture',
          selectionEpoch: 1,
          inputRevision: 1,
        },
      }),
    ).toBeNull();
  });

  it('returns reviewed HTML and exact PDF bytes only for authorised provenance', () => {
    const payload = requireReviewedNativeDraft({
      ...initialQuoteSession(),
      binding: {
        transportId: 't1',
        mailboxEmail: 'centurion@legacyhotels.co.za',
        storeId: 'store',
        folderEntryId: 'inbox',
        entryId: 'e1',
        selectionEpoch: 1,
        scopeEpoch: 1,
      },
      inputRevision: 1,
      reviewedReplyHtml: '<p>Parking is available on site.</p>',
      pdf: { fileName: 'Quote-authorised.pdf', bytesBase64: 'JVBERi0xLjQK' },
      evidence: {
        kind: 'authorised',
        selectionEpoch: 1,
        inputRevision: 1,
      },
    });
    expect(payload?.html).toContain('Parking is available on site.');
    expect(payload?.html).not.toContain('Thank you for Choosing The Centurion Hotel.');
    expect(payload?.pdf.fileName).toBe('Quote-authorised.pdf');
    expect(payload?.pdf.pdfBase64).toBe('JVBERi0xLjQK');
  });
});

