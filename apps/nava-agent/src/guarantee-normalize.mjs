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
  const lower = trimmed.toLowerCase();
  for (const [code, label] of Object.entries(CREATE_GUARANTEES)) {
    if (label.toLowerCase() === lower) return code;
  }
  return null;
}
