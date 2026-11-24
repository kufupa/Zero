/** HRCEN create-form guarantee codes — mirrors cloud-create-policy.mjs CREATE_GUARANTEES. */
export const CREATE_GUARANTEES = Object.freeze({
  AVOUCH: 'Awaiting Voucher',
  CNFREC: 'Confirmation Received',
  DEPREQ: 'Deposit Requested',
  GRPDEF: 'Group Definite',
  GTDAGT: 'Guaranteed By Agent',
  GTDCMP: 'Guaranteed By Company',
  GTDCC: 'Guaranteed By Credit Card',
  GTDDEP: 'Guaranteed By Deposit',
  NGG: 'Non-Guaranteed Group',
  NGI: 'Non-Guaranteed Individual',
});

/** Legacy misspellings → canonical native codes. */
const LEGACY_ALIASES = Object.freeze({
  AWVCH: 'AVOUCH',
  CNFRCV: 'CNFREC',
});

/** Email / voucher phrases staff map to native guarantee codes. */
const PHRASE_ALIASES = Object.freeze({
  'agency to pay supplier': 'GTDAGT',
  'agency to pay': 'GTDAGT',
  'bill-back': 'GTDAGT',
  billback: 'GTDAGT',
  'bill back': 'GTDAGT',
  'guaranteed by agent': 'GTDAGT',
  'guaranteed by company': 'GTDCMP',
  'guaranteed by deposit': 'GTDDEP',
  'guaranteed by credit card': 'GTDCC',
  'deposit requested': 'DEPREQ',
  'awaiting voucher': 'AVOUCH',
  'confirmation received': 'CNFREC',
  'non-guaranteed individual': 'NGI',
  'non guaranteed individual': 'NGI',
  '6pm hold': 'NGI',
});

/**
 * Accept native codes + display labels; map legacy aliases; refuse unknown.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeGuaranteeCode(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if (Object.hasOwn(CREATE_GUARANTEES, upper)) return upper;
  if (Object.hasOwn(LEGACY_ALIASES, upper)) return LEGACY_ALIASES[upper];
  const lower = trimmed.toLowerCase().replace(/\s+/g, ' ');
  if (Object.hasOwn(PHRASE_ALIASES, lower)) return PHRASE_ALIASES[lower];
  for (const [code, label] of Object.entries(CREATE_GUARANTEES)) {
    if (label.toLowerCase() === lower) return code;
  }
  return null;
}
