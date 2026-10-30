export const PARTY_FIELDS = ['bookingAgency', 'bookingAgencyContract', 'organization', 'arAccount'];
export const SOURCES = ['E-Mail', 'Voice Call', 'Call Center'];

export function text(value) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim().replace(/\s+/g, ' ') : '';
}

export function confirmationKey(value) {
  const key = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return /[\p{L}\p{N}]/u.test(key) ? key : '';
}

export function combinationKey(combination) {
  return JSON.stringify(PARTY_FIELDS.map(field => combination[field] == null
    ? null : text(combination[field]).normalize('NFKC').toLowerCase()));
}

export function emailsIn(value) {
  const matches = text(value).match(/[^\s@,;<>]+@[^\s@,;<>]+/g) || [];
  return [...new Set(matches.map(address => address.replace(/^mailto:/i, '')
    .replace(/[.!?]+$/, '').toLowerCase()))];
}
