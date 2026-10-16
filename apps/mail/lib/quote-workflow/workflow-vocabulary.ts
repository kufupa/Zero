import type { QuoteAnalysis } from './types';

/** The one reservation-staff label set used by both the selected-email banner and Needs-you rows. */
export type NavaReadAs =
  | 'quote'
  | 'new_booking'
  | 'amendment'
  | 'cancellation'
  | 'payment'
  | 'billing'
  | 'group'
  | 'not_for_nava';

export const NAVA_READ_AS_LABEL: Record<NavaReadAs, string> = {
  quote: 'Quote',
  new_booking: 'New booking',
  amendment: 'Amendment',
  cancellation: 'Cancellation',
  payment: 'Payment',
  billing: 'Billing',
  group: 'Group',
  not_for_nava: 'Not for Nava',
};

export type NavaWorkState = 'needs_you' | 'queued' | 'in_hms' | 'review';

export const NAVA_WORK_STATE_LABEL: Record<NavaWorkState, string> = {
  needs_you: 'Needs you',
  queued: 'Queued',
  in_hms: 'In HMS',
  review: 'Review',
};

export function workStateForStatus(status: string | null | undefined): NavaWorkState | null {
  if (status === 'needs_you' || status === 'review') return status;
  return null;
}

/** Maps the stored mail kind once, so the inbox list and selected email cannot drift apart. */
export function readAsForKind(kind: string | null | undefined): NavaReadAs {
  switch (kind?.trim().toLowerCase()) {
    case 'quote':
      return 'quote';
    case 'booking':
    case 'create_booking':
      return 'new_booking';
    case 'amendment':
    case 'amend':
      return 'amendment';
    case 'cancellation':
    case 'cancel':
      return 'cancellation';
    case 'voucher_pop':
    case 'payment':
    case 'proof_of_payment':
      return 'payment';
    case 'billing':
    case 'invoice':
    case 'folio':
      return 'billing';
    case 'group':
    case 'group_block':
    case 'conference':
      return 'group';
    default:
      return 'not_for_nava';
  }
}

/**
 * Read-as for the selected message. Stored kind wins for explicit reservation/document classes; analysis fills in
 * group/payment intent that the older mail-kind contract represents only as `quote` or `other`.
 */
/** The quote or booking workflow behind an email, even when its label shows something else (e.g. a paid claim). */
export function quoteOrBookingWorkflow(
  analysis: QuoteAnalysis | null | undefined,
  kind?: string | null,
): 'quote' | 'create_booking' | null {
  const kindReadAs = kind ? readAsForKind(kind) : null;
  if (analysis?.luna?.workflow === 'create_booking' || kindReadAs === 'new_booking') return 'create_booking';
  if (analysis?.luna?.workflow === 'quote' || analysis?.intent === 'quote' || kindReadAs === 'quote') return 'quote';
  return null;
}

/** The classifier-backed workflows a stored read can carry beyond quote/booking. */
const WORKFLOW_READ_AS: Record<string, NavaReadAs> = {
  amend: 'amendment',
  cancel: 'cancellation',
  payment_ack: 'payment',
  send_document: 'billing',
  forward_to_partner: 'group',
};

export function readAsForAnalysis(
  analysis: QuoteAnalysis | null | undefined,
  options: {
    kind?: string | null;
    treatAs?: 'quote' | 'create_booking' | null;
  } = {},
): NavaReadAs | null {
  const { kind, treatAs } = options;
  const kindReadAs = kind ? readAsForKind(kind) : null;
  const amendment = analysis?.amendment?.kind;
  if (amendment === 'amend') return 'amendment';
  if (amendment === 'cancel') return 'cancellation';

  const flags = analysis?.luna?.flags ?? [];
  if (flags.includes('conference_or_group') || flags.includes('rooms_only_group')) return 'group';

  if (kindReadAs && ['amendment', 'cancellation', 'payment', 'billing', 'group'].includes(kindReadAs)) {
    return kindReadAs;
  }
  const workflowReadAs = WORKFLOW_READ_AS[analysis?.luna?.workflow ?? ''];
  if (workflowReadAs) return workflowReadAs;
  if (treatAs === 'quote') return 'quote';
  if (treatAs === 'create_booking') return 'new_booking';
  if (analysis?.luna?.rateClaims.some((claim) => claim.kind === 'paid')) return 'payment';
  if (kindReadAs === 'quote' || kindReadAs === 'new_booking') return kindReadAs;
  if (analysis?.luna?.workflow === 'create_booking') return 'new_booking';
  if (analysis?.luna?.workflow === 'quote' || analysis?.intent === 'quote') return 'quote';
  if (kindReadAs === 'not_for_nava' || analysis) return 'not_for_nava';
  return null;
}
