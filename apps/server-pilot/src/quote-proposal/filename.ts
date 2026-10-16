export const HOTEL_TELEPHONE = '0126433600';

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
