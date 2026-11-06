/** Compare guest-name formatting without collapsing actual word boundaries. */
export function normalizeGuestName(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^(?:(?:mr|mrs|ms|miss|dr|prof|professor)\.?\s+)+/i, '')
    .normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/gu, ' ')
    .replace(/(^|\s)((?:[a-z]\.\s*)+[a-z]\.?)(?=\s|$)/g, (_match, prefix: string, initials: string) =>
      prefix + initials.replace(/[.\s]/g, ''))
    .replace(/\b([a-z])\.(?=\s|$)/g, '$1')
    .replace(/\b(?:[a-z]\s+)+[a-z]\b/g, (initials) => initials.replace(/\s+/g, ''));
}

export function sameGuestName(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const name = normalizeGuestName(left);
  return Boolean(name && name === normalizeGuestName(right));
}
