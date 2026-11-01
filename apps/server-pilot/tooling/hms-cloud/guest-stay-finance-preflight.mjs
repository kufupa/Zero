// Narrow billing preparation from verified Stay 360 display fields.
import { projectCancellationPreflight } from './guest-stay-cancel-preflight.mjs';

/**
 * Project only the displayed balance/deposit facts needed for staff review.
 * The shared cancellation projection owns exact 1A/1B target verification and
 * duplicate/conflict handling; this view never reads a ledger or posts payment.
 */
export function projectFinanceDisplayPreflight(input = {}) {
  const preflight = projectCancellationPreflight({
    confirmation: input.confirmation,
    requestedScope: 'unspecified',
    shallow: input.shallow,
    record: input.record,
  });
  if (preflight.outcome !== 'prepared_for_human_review') return preflight;

  return {
    outcome: 'prepared_for_human_review',
    target: preflight.target,
    recordView: {
      basis: 'stay360_display_only_not_ledger',
      balance: preflight.money.balance,
      depositReceived: preflight.money.depositReceived,
      depositDue: preflight.money.depositDue,
      depositDueDate: preflight.money.depositDueDate,
    },
    folioCard: {
      basis: '1a_folio_card_display_only',
      balance: preflight.folio.balance,
      depositReceived: preflight.folio.depositReceived,
      depositAmount: preflight.folio.depositAmount,
      depositDueDate: preflight.folio.depositDueDate,
    },
    interpretation: {
      ledgerBalance: 'not_established',
      depositCleared: 'not_established',
      depositDue: 'not_verified',
      transactionHistory: 'not_read',
    },
  };
}
