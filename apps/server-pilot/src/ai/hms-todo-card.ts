/**
 * Key into HMS to-do card.
 *
 * What: a structured staff checklist of facts to type into HMS (new booking, amend,
 * cancel, proof of payment) from fields Nava already extracted.
 * Why: HMS writes stay off. Staff still need what to key, the extracted values, and
 * what is missing — without Nava writing, calling HMS, or sending mail.
 * No-write guarantee: this module only shapes already-extracted fields. It never
 * calls HMS, never sends, and always returns `writesEnabled: false`.
 */

export type HmsTodoKind = 'new_booking' | 'amend' | 'cancel' | 'payment_proof';

export type HmsTodoStepSource = 'mail' | 'attachment' | 'missing';

export type HmsTodoStep = {
  label: string;
  value: string | null;
  source: HmsTodoStepSource;
};

export type HmsTodoCard = {
  kind: HmsTodoKind;
  title: string;
  steps: HmsTodoStep[];
  missing: string[];
  writesEnabled: false;
};

export type HmsTodoStayAsk = {
  arrivalDate?: string | null;
  departureDate?: string | null;
  adults?: number | null;
  children?: number | null;
  rooms?: number | null;
};

export type HmsTodoRateClaim = {
  kind: string;
  amount?: string | null;
  currency?: string | null;
};

export type HmsTodoGroup = {
  arrival?: string | null;
  departure?: string | null;
  rooms?: number | null;
  adultsPerRoom?: number | null;
  childAges?: readonly number[] | null;
};

export type HmsTodoCardInput = {
  workflow?: string | null;
  stayAsk?: HmsTodoStayAsk | null;
  groups?: readonly HmsTodoGroup[] | null;
  confirmationNumber?: string | null;
  guestLastName?: string | null;
  requestedChange?: string | null;
  paymentAmount?: string | null;
  paymentReference?: string | null;
  rateClaims?: readonly HmsTodoRateClaim[] | null;
  party?: { reference?: string | null } | null;
  attachmentFilenames?: readonly string[] | null;
};

const TITLE = 'Key into HMS';

const WORKFLOW_KIND: Record<string, HmsTodoKind> = {
  create: 'new_booking',
  create_booking: 'new_booking',
  new_booking: 'new_booking',
  booking: 'new_booking',
  amend: 'amend',
  amendment: 'amend',
  cancel: 'cancel',
  cancellation: 'cancel',
  payment_proof: 'payment_proof',
  voucher_pop: 'payment_proof',
  pop: 'payment_proof',
};

function text(value: string | number | null | undefined): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return String(value);
  }
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function positiveCount(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  return String(value);
}

function kindOf(workflow: string | null | undefined): HmsTodoKind | null {
  const key = workflow?.trim().toLowerCase();
  return key ? (WORKFLOW_KIND[key] ?? null) : null;
}

function stayFields(input: HmsTodoCardInput): {
  arrival: string | null;
  departure: string | null;
  rooms: string | null;
  adults: string | null;
  children: string | null;
} {
  const group = input.groups?.[0];
  const childCount = group?.childAges?.length;
  return {
    arrival: text(input.stayAsk?.arrivalDate) ?? text(group?.arrival),
    departure: text(input.stayAsk?.departureDate) ?? text(group?.departure),
    rooms: positiveCount(input.stayAsk?.rooms) ?? positiveCount(group?.rooms ?? null),
    adults: positiveCount(input.stayAsk?.adults) ?? positiveCount(group?.adultsPerRoom ?? null),
    children: positiveCount(input.stayAsk?.children) ?? positiveCount(childCount ?? null),
  };
}

function paidAmount(input: HmsTodoCardInput): string | null {
  const direct = text(input.paymentAmount);
  if (direct) return direct;
  const paid = input.rateClaims?.find((claim) => claim.kind === 'paid');
  const amount = text(paid?.amount);
  if (!amount) return null;
  const currency = text(paid?.currency);
  return currency && !amount.startsWith(currency) ? `${currency} ${amount}` : amount;
}

function attachments(input: HmsTodoCardInput): string | null {
  const names = (input.attachmentFilenames ?? [])
    .map((name) => text(name))
    .filter((name): name is string => Boolean(name));
  return names.length ? [...new Set(names)].join(', ') : null;
}

function pushFact(
  steps: HmsTodoStep[],
  missing: string[],
  label: string,
  value: string | null,
  required: boolean,
  source: Exclude<HmsTodoStepSource, 'missing'> = 'mail',
): void {
  if (steps.some((step) => step.label === label)) return;
  if (!value && !required) return;
  if (!value) {
    steps.push({ label, value: null, source: 'missing' });
    missing.push(label);
    return;
  }
  steps.push({ label, value, source });
}

export function buildHmsTodoCard(input: HmsTodoCardInput): HmsTodoCard | null {
  const kind = kindOf(input.workflow);
  if (!kind) return null;

  const stay = stayFields(input);
  const confirmation = text(input.confirmationNumber);
  const lastName = text(input.guestLastName);
  const change = text(input.requestedChange);
  const amount = paidAmount(input);
  const reference = text(input.paymentReference) ?? text(input.party?.reference);
  const files = attachments(input);

  const steps: HmsTodoStep[] = [];
  const missing: string[] = [];

  if (kind === 'new_booking') {
    pushFact(steps, missing, 'Arrival', stay.arrival, true);
    pushFact(steps, missing, 'Departure', stay.departure, true);
    pushFact(steps, missing, 'Rooms', stay.rooms, true);
    pushFact(steps, missing, 'Adults', stay.adults, true);
    pushFact(steps, missing, 'Children', stay.children, false);
    pushFact(steps, missing, 'Guest last name', lastName, false);
  } else if (kind === 'amend') {
    pushFact(steps, missing, 'Confirmation number', confirmation, true);
    pushFact(steps, missing, 'Guest last name', lastName, false);
    pushFact(steps, missing, 'Requested change', change, true);
    pushFact(steps, missing, 'Arrival', stay.arrival, false);
    pushFact(steps, missing, 'Departure', stay.departure, false);
  } else if (kind === 'cancel') {
    pushFact(steps, missing, 'Confirmation number', confirmation, true);
    pushFact(steps, missing, 'Guest last name', lastName, false);
  } else {
    pushFact(steps, missing, 'Confirmation number', confirmation, false);
    pushFact(steps, missing, 'Guest last name', lastName, false);
    pushFact(steps, missing, 'Payment amount', amount, true);
    pushFact(steps, missing, 'Payment reference', reference, false);
  }

  pushFact(steps, missing, 'Attachments', files, false, 'attachment');

  return { kind, title: TITLE, steps, missing, writesEnabled: false };
}
