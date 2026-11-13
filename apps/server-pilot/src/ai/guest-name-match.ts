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
  const canonical = (value: string) => {
    const parts = value.split(',');
    if (parts.length === 2 && parts.every(part => part.trim())) value = `${parts[1]!.trim()} ${parts[0]!.trim()}`;
    return normalizeGuestName(value);
  };
  const name = canonical(left);
  return Boolean(name && name === canonical(right));
}
