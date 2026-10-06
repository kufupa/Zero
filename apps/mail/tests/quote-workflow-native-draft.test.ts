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

  it('returns reviewed HTML and exact PDF bytes only for authorised provenance that still passes canCreatePdf', () => {
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
      groups: [
        {
          id: 'g1',
          arrivalDate: '2026-11-12',
          departureDate: '2026-11-14',
          quantity: 1,
          roomPreference: 'standard king',
          adults: 1,
          childrenAges: [],
          board: 'bb',
          specialRequests: [],
          fields: { arrivalDate: 'extracted', departureDate: 'extracted', adults: 'extracted' },
        },
      ],
      offers: [
        {
          id: 'auth-1',
          kind: 'allocation',
          roomCode: 'SKNG',
          roomLabel: 'Standard King',
          board: 'bb',
          rateCode: 'BAR',
          currency: 'ZAR',
          nightly: [{ date: '2026-11-12', amountMinor: 136000 }],
          stayTotalMinor: 272000,
          observedAt: '2026-10-05T12:00:00Z',
          sourceRef: 'auth-src-1',
          restrictions: [],
          combinable: true,
          quoteRequestKey: '2026-11-12:2026-11-14',
          coversGroupIds: ['g1'],
          quantity: 1,
          adults: 1,
          childrenAges: [],
        },
      ],
      selectedOfferIds: ['auth-1'],
      staffSource: {
        messageId: 'mail-1',
        threadId: 'thread-1',
        sourceHash: 'ab'.repeat(32),
      },
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

  it('refuses native insert when canCreatePdf is false even with authorised html and pdf bytes', () => {
    expect(
      requireReviewedNativeDraft({
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
      }),
    ).toBeNull();
  });
});
