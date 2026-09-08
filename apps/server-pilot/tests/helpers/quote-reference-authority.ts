import type { QuoteReferenceAuthority } from '../../src/hms/quote-request-normalization.js';

/** Explicit fixture-only commercial snapshot; never used by normal production composition. */
export const syntheticQuoteReferenceAuthority: QuoteReferenceAuthority = {
  propertyCode: 'HRCEN',
  roomTypeRefs: ['STD', 'DLX'],
  ratePlanRefs: ['BAR', 'BAR2'],
  currencyCodes: ['ZAR', 'USD'],
  sourceRef: 'fixture:quote-reference-authority',
  version: 'fixture-v1',
  observedAt: '2026-09-08T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  organizationRefs: ['org-centurion'],
  agencyRefs: ['agency-7'],
  groupRefs: ['group-42'],
};

export function syntheticQuoteReferenceAuthorityLoader(
  authority: QuoteReferenceAuthority = syntheticQuoteReferenceAuthority,
) {
  return async () => ({ status: 'ready' as const, authority });
}
