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

  it('returns the reviewed HTML and exact PDF bytes', () => {
    const payload = requireReviewedNativeDraft({
      ...initialQuoteSession(),
      reviewedReplyHtml: '<p>Parking is available on site.</p>',
      pdf: { fileName: 'Quote-fixture-not-live-hms.pdf', bytesBase64: 'JVBERi0xLjQK' },
    });
    expect(payload?.html).toContain('Parking is available on site.');
    expect(payload?.html).not.toContain('Thank you for Choosing The Centurion Hotel.');
    expect(payload?.pdf.fileName).toBe('Quote-fixture-not-live-hms.pdf');
    expect(payload?.pdf.pdfBase64).toBe('JVBERi0xLjQK');
  });
});
