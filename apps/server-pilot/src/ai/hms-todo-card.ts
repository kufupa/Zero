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

export type HmsTodoKind = 'new_booking' | 'amend' | 'cancel';

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

  return { kind, title: TITLE, steps, missing, writesEnabled: false };
}
