import { ReservationistTaskEvidenceUnavailable } from './reservationist-execution.js';

/** HMS flags no negotiated row for the picked party. The quote retries at public rates, as before party rates. */
export const PARTY_NO_CONTRACT_CODE = 'business_party_no_contract_rate';

/**
 * The codes a picked party can cause when HMS will not price its rate. Only these fall back to public rates, and only a
 * typed error carries them. A plain Error is never judged by its code or its message.
 */
export const PARTY_RATE_FAILURE_CODES: ReadonlySet<string> = new Set([
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
