export const PARTY_FIELDS = ['bookingAgency', 'bookingAgencyContract', 'organization', 'arAccount'];
export const SOURCES = ['E-Mail', 'Voice Call', 'Call Center'];
export const HINT_LABELS = { 'rate plan': 'ratePlan', 'room type': 'roomType', 'guarantee type': 'guaranteeType' };

export const text = value => typeof value === 'string' || typeof value === 'number'
  ? String(value).trim().replace(/\s+/g, ' ') : '';

export function confirmationKey(value) {
  const key = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return /[\p{L}\p{N}]/u.test(key) ? key : '';
}

export const combinationKey = combination => JSON.stringify(PARTY_FIELDS.map(field => combination[field] == null
  ? null : text(combination[field]).normalize('NFKC').toLowerCase()));

export function emailsIn(value) {
  return [...new Set((text(value).match(/[^\s@,;<>]+@[^\s@,;<>]+/g) || []).map(address =>
    address.replace(/^mailto:/i, '').replace(/[.!?]+$/, '').toLowerCase()))];
}

export function verifiedConfirmations(observations) {
  const groups = Map.groupBy(observations, item => item.confirmationKey);
  for (const copies of groups.values()) {
    if (copies.length < 2) continue;
    const ids = new Set(copies.map(item => confirmationKey(item.provenance?.verifiedStayId)));
    const sameNumber = copies.every(item => item.confirmationNumber === copies[0].confirmationNumber);
    if (!sameNumber || ids.size !== 1 || ids.has('')) throw new TypeError('Repeated confirmations require one verified stay ID.');
  }
  return groups;
}
