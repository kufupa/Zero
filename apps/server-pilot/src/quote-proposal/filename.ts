export const HOTEL_TELEPHONE = '0126433600';

/**
 * "Quote - <agency> <stay span>.pdf". The document id's first eight hex digits follow the span, so two options quoted
 * for the same agency and dates on the same day never share a name.
 */
export function quotePdfFileName(agency: string, dateLabel: string, documentId?: string): string {
  const org = agency.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || 'Guest';
  const dates = dateLabel.replace(/\s+/g, ' ').trim();
  const option = documentId ? ` (${documentId.replace(/^[a-z]+:/, '').slice(0, 8)})` : '';
  return `Quote - ${org} ${dates}${option}.pdf`;
}
