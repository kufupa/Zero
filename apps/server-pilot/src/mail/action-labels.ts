/** Shared action vocabulary for imported predictions, agent labels and owner marks. */
export const MAIL_ACTIONS = [
  'no_action',
  'quote_availability',
  'new_booking',
  'amend',
  'cancel',
  'payment_proof',
  'billing',
  'group_event',
  'other_actionable',
] as const;

export type MailAction = (typeof MAIL_ACTIONS)[number];

export const MAIL_ACTION_LABEL_SOURCES = ['model', 'agent', 'owner'] as const;
export type MailActionLabelSource = (typeof MAIL_ACTION_LABEL_SOURCES)[number];
