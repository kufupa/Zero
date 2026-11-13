export const AWAITING_PAYMENT_PREFIX = 'Awaiting payment - ';
export const RESERVATION_NOTE_MAX = 2000;

export const RESERVATION_NOTE_PRESETS: readonly { id: string; label: string; text: string }[] = [
  { id: 'dbb-agent', label: 'DBB to agent', text: 'DBB to agent, extras direct' },
  { id: 'settle-direct', label: 'Settle direct', text: 'Settle direct' },
  { id: 'bb-agent', label: 'BB to agent', text: 'BB to agent, extras direct' },
  { id: 'dbb-organization', label: 'DBB to company', text: 'DBB to company, extras direct' },
  { id: 'bb-organization', label: 'BB to company', text: 'BB to company, extras direct' },
  { id: 'bb-prepaid', label: 'BB prepaid', text: 'BB prepaid, extras direct' },
  { id: 'dbb-prepaid', label: 'DBB prepaid', text: 'DBB prepaid, extras direct' },
];
