import type { QuoteOffer } from '../../lib/quote-workflow/types';

/** Test double for a later authorised bind. Not fixture money and not a second engine. */
export const AUTHORISED_QUOTE_OFFERS: QuoteOffer[] = [
  {
    id: 'auth-1',
    kind: 'allocation',
    roomCode: 'SKNG',
    roomLabel: 'Standard King',
    board: 'bb',
    rateCode: 'BAR',
    currency: 'ZAR',
    nightly: [
      { date: '2026-11-12', amountMinor: 136000 },
      { date: '2026-11-13', amountMinor: 136000 },
    ],
    stayTotalMinor: 272000,
    observedAt: '2026-10-05T12:00:00Z',
    sourceRef: 'auth-src-1',
    restrictions: [],
    combinable: true,
    quoteRequestKey: '2026-11-12:2026-11-14',
    coversGroupIds: ['g1'],
    quantity: 1,
    adults: 1,
  },
];

export const AUTHORISED_QUOTE_PDF = {
  fileName: 'Quote-authorised.pdf',
  pdfBase64: 'JVBERi0xLjQK',
  pdfHash: 'e5c62df5dab5c87b6a015ef3d43597074d1eec433b15f51aec63b8582d0e4ab4',
  revisionId: 'rev-auth',
  totalMinor: 272000,
  centsReconciled: true as const,
};

export const AUTHORISED_REPLY_HTML =
  '<div><p>Good day David,</p><p>Please see attached quotation for the selected allocation only.</p><p>Kind regards,</p></div>';
