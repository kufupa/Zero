export const HOTEL_TELEPHONE = '0126433600';

export const HRCEN_PROPERTY_CODE = 'HRCEN';
export const HRDAV_PROPERTY_CODE = 'HRDAV';

/** Guest-facing hotel identity for a quote PDF, Excel, cover reply, or 66h follow-up. */
export type QuotePropertyIdentity = {
  propertyCode: typeof HRCEN_PROPERTY_CODE | typeof HRDAV_PROPERTY_CODE;
  name: string;
  /** City/street lines shown when there is no letterhead (fork 7). */
  addressLines: readonly string[];
  telephone: string | null;
  websiteLabel: string | null;
  websiteUrl: string;
  /** Centurion keeps the staff xlsx drawings. Da Vinci has no approved letterhead. */
  letterhead: 'centurion-template' | 'none';
};

export const HRCEN_QUOTE_IDENTITY: QuotePropertyIdentity = {
  propertyCode: HRCEN_PROPERTY_CODE,
  name: 'The Centurion Hotel',
  addressLines: [],
  telephone: HOTEL_TELEPHONE,
  websiteLabel: 'The Centurion Hotel Website',
  websiteUrl: 'https://www.legacyhotels.co.za',
  letterhead: 'centurion-template',
};

/** Staff Quick Parts: "DaVinci Hotel and Suites in Sandton". No street or logo in the D0 corpus. */
export const HRDAV_QUOTE_IDENTITY: QuotePropertyIdentity = {
  propertyCode: HRDAV_PROPERTY_CODE,
  name: 'Da Vinci Hotel and Suites',
  addressLines: ['Sandton'],
  telephone: null,
  websiteLabel: null,
  websiteUrl: 'https://www.legacyhotels.co.za',
  letterhead: 'none',
};

export function quotePropertyIdentity(propertyCode: string | null | undefined): QuotePropertyIdentity {
  if (!propertyCode?.trim()) throw new Error('quote_property_required');
  if (propertyCode === HRDAV_PROPERTY_CODE) return HRDAV_QUOTE_IDENTITY;
  if (propertyCode === HRCEN_PROPERTY_CODE) return HRCEN_QUOTE_IDENTITY;
  throw new Error(`unknown_quote_property:${propertyCode}`);
}
