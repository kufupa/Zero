export function quotePdfFileName(agency: string, dateLabel: string): string {
  const org = agency.replace(/\s+/g, ' ').trim();
  const dates = dateLabel.replace(/\s+/g, ' ').trim();
  return `Quote - ${org} ${dates}.pdf`;
}

export function lineTotal(qty: number, nights: number, rate: number): number {
  return qty * nights * rate;
}
