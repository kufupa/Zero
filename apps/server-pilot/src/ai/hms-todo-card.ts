/**
 * Key into HMS to-do card.
 *
 * What: a structured staff checklist of facts to type into HMS (new booking, amend,
 * cancel) from fields Nava already extracted.
 * Why: HMS writes stay off. Staff still need what to key, the extracted values, and
 * what is missing — without Nava writing, calling HMS, or sending mail.
 * No-write guarantee: this module only shapes already-extracted fields. It never
 * calls HMS, never sends, and always returns `writesEnabled: false`.
 *
 * payment_proof is not a LunaAnalysis.workflow value, so this card does not invent
 * a payment kind. Proof-of-payment classification is a follow-up.
 */

import type { BuildCreatePrefillOutput } from './aop/create-prefill.js';

export type HmsTodoKind = 'new_booking' | 'amend' | 'cancel';

export type HmsTodoStepSource = 'mail' | 'attachment' | 'missing';

export type HmsTodoStep = {
  label: string;
  value: string | null;
  source: HmsTodoStepSource;
};

export type HmsTodoPrefill = {
  fields: { label: string; value: string }[];
  stillNeeded: string[];
};

export type HmsTodoCard = {
  kind: HmsTodoKind;
  title: string;
  steps: HmsTodoStep[];
  missing: string[];
  writesEnabled: false;
  prefill?: HmsTodoPrefill;
};

export type HmsTodoStayAsk = {
  arrivalDate?: string | null;
  departureDate?: string | null;
  adults?: number | null;
  children?: number | null;
  rooms?: number | null;
};

export type HmsTodoGroup = {
  arrival?: string | null;
  departure?: string | null;
  rooms?: number | null;
  adultsPerRoom?: number | null;
  childAges?: readonly number[] | null;
  guestNames?: readonly string[] | null;
};

export type HmsTodoCardInput = {
  workflow?: string | null;
  stayAsk?: HmsTodoStayAsk | null;
  groups?: readonly HmsTodoGroup[] | null;
  confirmationNumber?: string | null;
  guestLastName?: string | null;
  requestedChange?: string | null;
  party?: { reference?: string | null } | null;
  attachmentFilenames?: readonly string[] | null;
  prefill?: BuildCreatePrefillOutput | null;
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

function guestsOf(group: HmsTodoGroup): string | null {
  const names = (group.guestNames ?? [])
    .map((name) => text(name))
    .filter((name): name is string => Boolean(name));
  return names.length ? names.join(', ') : null;
}

const CODE_FIELDS: Array<{ keys: readonly string[]; label: string }> = [
  { keys: ['roomType'], label: 'Room type' },
  { keys: ['ratePlan'], label: 'Rate plan' },
  { keys: ['track'], label: 'Track' },
  { keys: ['sourceOfBusiness'], label: 'Source of business' },
  { keys: ['guaranteeType'], label: 'Guarantee' },
  { keys: ['agency', 'bookingAgency', 'organization'], label: 'Agency' },
  { keys: ['billingReference'], label: 'Billing reference' },
  { keys: ['reservationNote'], label: 'Reservation note' },
];

const MISSING_FACT: Record<string, string[]> = {
  arrival: ['Arrival'],
  departure: ['Departure'],
  rooms: ['Rooms'],
  guestName: ['Guests', 'Guest last name'],
};

function pickText(request: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const shown = typeof request[key] === 'string' ? text(request[key] as string) : null;
    if (shown) return shown;
  }
  return null;
}

function factAlreadyMissing(field: string, cardMissing: string[]): boolean {
  const facts = MISSING_FACT[field];
  if (!facts) return false;
  return cardMissing.some((label) => facts.includes(label.replace(/^Group \d+ /, '')));
}

function derivePrefill(prefill: BuildCreatePrefillOutput, cardMissing: string[]): HmsTodoPrefill {
  const requests = prefill.requests;
  const primary = (requests[0] ?? {}) as Record<string, unknown>;
  const fields: HmsTodoPrefill['fields'] = [];
  for (const spec of CODE_FIELDS) {
    const value = pickText(primary, spec.keys);
    if (value) fields.push({ label: spec.label, value });
  }
  for (let index = 1; index < requests.length; index += 1) {
    const room = requests[index] as Record<string, unknown>;
    for (const spec of CODE_FIELDS) {
      const value = pickText(room, spec.keys);
      if (value && value !== pickText(primary, spec.keys)) {
        fields.push({ label: `Room ${index + 1} ${spec.label.toLowerCase()}`, value });
      }
    }
  }
  const stillNeeded: string[] = [];
  const seen = new Set<string>();
  for (const row of prefill.missing) {
    const question = text(row.question);
    if (!question || seen.has(question) || factAlreadyMissing(row.field, cardMissing)) continue;
    seen.add(question);
    stillNeeded.push(question);
  }
  return { fields, stillNeeded };
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

function appendStayAsk(
  steps: HmsTodoStep[],
  missing: string[],
  stayAsk: HmsTodoStayAsk | null | undefined,
  required: boolean,
): void {
  pushFact(steps, missing, 'Arrival', text(stayAsk?.arrivalDate), required);
  pushFact(steps, missing, 'Departure', text(stayAsk?.departureDate), required);
  pushFact(steps, missing, 'Rooms', positiveCount(stayAsk?.rooms), required);
  pushFact(steps, missing, 'Adults', positiveCount(stayAsk?.adults), required);
  pushFact(steps, missing, 'Children', positiveCount(stayAsk?.children), false);
}

function appendGroups(
  steps: HmsTodoStep[],
  missing: string[],
  groups: readonly HmsTodoGroup[],
  required: boolean,
): void {
  const total = groups.length;
  for (const [index, group] of groups.entries()) {
    const prefix = total > 1 ? `Group ${index + 1} ` : '';
    pushFact(steps, missing, `${prefix}Arrival`, text(group.arrival), required);
    pushFact(steps, missing, `${prefix}Departure`, text(group.departure), required);
    pushFact(steps, missing, `${prefix}Rooms`, positiveCount(group.rooms ?? null), required);
    pushFact(
      steps,
      missing,
      `${prefix}Adults per room`,
      positiveCount(group.adultsPerRoom ?? null),
      required,
    );
    pushFact(
      steps,
      missing,
      `${prefix}Children`,
      positiveCount(group.childAges?.length ?? null),
      false,
    );
    pushFact(steps, missing, `${prefix}Guests`, guestsOf(group), false);
  }
}

export function buildHmsTodoCard(input: HmsTodoCardInput): HmsTodoCard | null {
  const kind = kindOf(input.workflow);
  if (!kind) return null;

  const confirmation = text(input.confirmationNumber);
  const lastName = text(input.guestLastName);
  const change = text(input.requestedChange);
  const files = attachments(input);
  const groups = input.groups ?? [];
  const stayRequired = kind === 'new_booking';

  const steps: HmsTodoStep[] = [];
  const missing: string[] = [];

  if (kind === 'amend') {
    pushFact(steps, missing, 'Confirmation number', confirmation, true);
    pushFact(steps, missing, 'Guest last name', lastName, false);
    pushFact(steps, missing, 'Requested change', change, true);
  } else if (kind === 'cancel') {
    pushFact(steps, missing, 'Confirmation number', confirmation, true);
    pushFact(steps, missing, 'Guest last name', lastName, false);
  }

  if (kind === 'new_booking' || kind === 'amend') {
    if (groups.length > 0) appendGroups(steps, missing, groups, stayRequired);
    else appendStayAsk(steps, missing, input.stayAsk, stayRequired);
  }

  if (kind === 'new_booking') {
    pushFact(steps, missing, 'Guest last name', lastName, false);
  }

  pushFact(steps, missing, 'Attachments', files, false, 'attachment');

  const card: HmsTodoCard = { kind, title: TITLE, steps, missing, writesEnabled: false };
  if (kind === 'new_booking' && input.prefill) card.prefill = derivePrefill(input.prefill, missing);
  return card;
}
