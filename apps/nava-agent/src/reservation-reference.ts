export function normalizeReservationReference(value: string): string {
  const reference = value.trim().replace(/^(?:confirmation\s+(?:no\.?|number)|no\.?|n[°º])\s*:?\s*/iu, '');
  const spaced = /^(\d{8})(?:\s*-\s*|\s+)(\d+)$/u.exec(reference);
  if (spaced) return `${spaced[1]}-${spaced[2]}`;
  if (/^\d{10}1$/.test(reference) && !reference.startsWith('27')) return `${reference.slice(0, 10)}-1`;
  return /^(\d{8})([1-9])$/.test(reference) ? reference.replace(/^(\d{8})(\d)$/, '$1-$2') : reference;
}

/** HMS-shaped confirmation only: 6–10 digits, optional -suffix. Agency/PNR/voucher refs fail. */
export function isHmsConfirmation(value: string): boolean {
  return /^(?:\d{6,10}-\d{1,10}|\d{6,10})$/.test(normalizeReservationReference(value));
}

export function arrivalWindow(arrival: string) {
  const day = Date.parse(arrival);
  const iso = (offset: number) => new Date(day + offset * 86_400_000).toISOString().slice(0, 10);
  return {from: iso(-3), to: iso(3)};
}
