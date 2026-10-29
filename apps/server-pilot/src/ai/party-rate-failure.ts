import { ReservationistTaskEvidenceUnavailable } from './reservationist-execution.js';

/** HMS flags no negotiated row for the picked party. The quote retries at public rates, as before party rates. */
export const PARTY_NO_CONTRACT_CODE = 'business_party_no_contract_rate';
/** HMS did not show every calendar page or matching row, so no contract can be ruled out. The quote is public and says so. */
export const PARTY_SEARCH_INCOMPLETE_CODE = 'business_party_search_incomplete';

/**
 * The codes a picked party can cause when HMS will not price its rate. Only these fall back to public rates, and only a
 * typed error carries them. A plain Error is never judged by its code or its message.
 */
export const PARTY_RATE_FAILURE_CODES: ReadonlySet<string> = new Set([
  PARTY_SEARCH_INCOMPLETE_CODE,
  PARTY_NO_CONTRACT_CODE,
  'business_party_identity_unavailable',
  'business_party_lookup_unavailable',
  'business_party_source_unbound',
  'business_selected_price_unavailable',
  'business_selected_joint_inventory_unavailable',
  'staff_quote_party_unavailable',
  'staff_quote_party_invalid',
  'staff_quote_party_changed',
]);

/** A failure on a picked party's rate, raised by our own throw sites with one of the codes above. */
export class PartyRateFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PartyRateFailure';
  }
}

/**
 * True for a failure HMS caused on a picked party's rate: our PartyRateFailure, or the evidence error the business services
 * raise with a party code. Anything else, including a plain Error with a matching message, is not a party-rate failure.
 */
export function isPartyRateFailure(error: unknown): boolean {
  if (error instanceof PartyRateFailure) return PARTY_RATE_FAILURE_CODES.has(error.code);
  if (error instanceof ReservationistTaskEvidenceUnavailable) return PARTY_RATE_FAILURE_CODES.has(error.code);
  return false;
}

/** Search issues that mean HMS did not show every calendar page or every matching row. */
export const COVERAGE_ISSUE_CODES: ReadonlySet<string> = new Set([
  'NULL_OR_INVALID_CALENDAR',
  'CHANGED_CALENDAR_HEADERS',
  'STALE_CALENDAR_PAGE',
  'PROPERTY_RESULT_MISSING',
  'OPTION_LIMIT',
]);

/**
 * True when a group's search covered its dates and rooms with no coverage issue. A missing calendar page or a cut list
 * (OPTION_LIMIT) is not covered: a flagged row may be among the rows HMS did not show.
 */
export function partySearchCovered(group: { completeness?: { search?: unknown }; issues?: Array<{ code?: unknown }> }): boolean {
  return (
    group.completeness?.search === 'complete' &&
    !(group.issues ?? []).some((issue) => COVERAGE_ISSUE_CODES.has(String(issue.code)))
  );
}

/**
 * What a capture's groups say about a picked party's contract, when there is no flagged row.
 * no_contract only when every group's search covered its dates and rooms with no coverage issue. incomplete when any group
 * did not, because a missing calendar page can hide a flagged row, an option's scope is unknown, or
 * PARTY_RATES_NOT_CHECKED is present. null for anything else, including a flagged row.
 */
export function partyReadingOf(groups: unknown, rateContext: unknown, propertyCode?: string): 'no_contract' | 'incomplete' | null {
  if (!rateContext || !Array.isArray(groups)) return null;
  const list = groups as Array<{
    completeness?: { search?: unknown };
    issues?: Array<{ code?: unknown }>;
    options?: Array<{ rateScope?: unknown }>;
  }>;
  const rows = list.flatMap((group) => group.options ?? []);
  if (rows.some((row) => row.rateScope === 'contextual')) return null;
  // A narrowed full read can contain only the previously selected contract row. If its
  // negotiated flag disappears, allow a fresh public retry without claiming no contract.
  if (propertyCode === 'HRCEN' && rows.some((row) => row.rateScope !== 'public')) return 'incomplete';
  if (!rows.some((row) => row.rateScope === 'public')) return null;
  if (list.some((group) => (group.issues ?? []).some((issue) => issue.code === 'PARTY_RATES_NOT_CHECKED'))) {
    return 'incomplete';
  }
  return list.every(partySearchCovered) ? 'no_contract' : 'incomplete';
}
