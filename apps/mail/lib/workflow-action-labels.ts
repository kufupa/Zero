import { MAIL_ACTIONS, type MailAction } from '../../server-pilot/src/mail/action-labels.js';
import type { NavaReadAs } from './quote-workflow/workflow-vocabulary';

export { MAIL_ACTIONS, type MailAction };

/** Labels shared by the workflow desk and the inbox gold-label control. */
export const MAIL_ACTION_LABELS: Record<MailAction, string> = {
  quote_availability: 'Quote',
  new_booking: 'New booking',
  amend: 'Amendment',
  cancel: 'Cancellation',
  payment_proof: 'Payment proof',
  billing: 'Billing',
  group_event: 'Group/event',
  other_actionable: 'Other to do',
  no_action: 'Not for Nava',
};

export const GOLD_ACTION_FOR_READ_AS: Record<NavaReadAs, MailAction> = {
  quote: 'quote_availability',
  new_booking: 'new_booking',
  amendment: 'amend',
  cancellation: 'cancel',
  payment: 'payment_proof',
  billing: 'billing',
  group: 'group_event',
  not_for_nava: 'no_action',
};

export const READ_AS_FOR_GOLD_ACTION = Object.fromEntries(
  Object.entries(GOLD_ACTION_FOR_READ_AS).map(([readAs, action]) => [action, readAs]),
) as Partial<Record<MailAction, NavaReadAs>>;

