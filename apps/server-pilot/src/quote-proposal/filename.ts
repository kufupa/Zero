export const HOTEL_TELEPHONE = '0126433600';

export function quotePdfFileName(agency: string, dateLabel: string): string {
  const org = agency.replace(/\s+/g, ' ').trim();
  const dates = dateLabel.replace(/\s+/g, ' ').trim();
  return `Quote - ${org} ${dates}.pdf`;
}
