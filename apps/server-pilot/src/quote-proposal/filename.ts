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

/** 66h unsent follow-up body. Hotel name comes from the sending mailbox's property. */
export function quoteFollowUpBody(sentOn: string, signer: string | null, propertyCode: string): string {
  const hotel = quotePropertyIdentity(propertyCode).name;
  return [
    'Hello,',
    `I am following up on the quote we sent on ${sentOn} from ${hotel}. The quotation is due to expire shortly. Please let us know if you would like to go ahead, or if you need any changes.`,
    ['Kind regards,', signer].filter(Boolean).join('\n'),
  ].join('\n\n');
}

function sanitizePdfParty(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

/** Agency, then company, then guest/contact, then the From display name. Never "Guest". */
export function quotePdfPartyName(
  agency?: string | null,
  company?: string | null,
  guestName?: string | null,
  senderDisplayName?: string | null,
): string {
  for (const raw of [agency, company, guestName, senderDisplayName]) {
    const org = sanitizePdfParty(raw);
    if (org) return org;
  }
  return 'Quote';
}

/** Display name from `Name <email@host>`; a bare address is not a name. */
export function quotePdfSenderDisplayName(fromAddress: string | null | undefined): string {
  const trimmed = fromAddress?.trim() ?? '';
  const angle = trimmed.match(/^(.+?)\s*<[^>]+>$/);
  if (!angle) return '';
  return angle[1]!.trim().replace(/^["']|["']$/g, '');
}

/**
 * "Quote - <agency> <stay span>.pdf". The document id's first eight hex digits follow the span, so two options quoted
 * for the same agency and dates on the same day never share a name.
 */
export function quotePdfFileName(agency: string, dateLabel: string, documentId?: string): string {
  const org = quotePdfPartyName(agency);
  const dates = dateLabel.replace(/\s+/g, ' ').trim();
  const option = documentId ? ` (${documentId.replace(/^[a-z]+:/, '').slice(0, 8)})` : '';
  return `Quote - ${org} ${dates}${option}.pdf`;
}

/** Swap the party segment of an already-built PDF name. Dates and the option id stay. */
export function retargetQuotePdfFileName(
  fileName: string,
  partyName: string,
  previousParty?: string | null,
): string {
  const party = quotePdfPartyName(partyName);
  const previous = quotePdfPartyName(previousParty);
  const prefix = `Quote - ${previous} `;
  if (!fileName.startsWith(prefix)) return fileName;
  return `Quote - ${party} ${fileName.slice(prefix.length)}`;
}
