/**
 * Key into HMS to-do card.
 *
 * What: a structured staff checklist of facts to type into HMS (new booking, amend,
 * cancel, post payment, send document) from fields Nava already extracted.
 * Why: HMS writes stay off. Staff still need what to key, the extracted values, and
 * what is missing — without Nava writing, calling HMS, or sending mail.
 * No-write guarantee: this module only shapes already-extracted fields. It never
 * calls HMS, never sends, and always returns `writesEnabled: false`.
 * Stay match uses pane find rows already in hand. No amount or document is invented.
 */

import type { BuildCreatePrefillOutput } from './aop/create-prefill.js';
import {
  BILLING_DOCUMENT_ASK_KINDS,
  pickBillingDocument,
  type BillingDocumentAskKind,
  type BillingDocumentRow,
} from './aop/billing-document-pick.js';
import { matchPaymentProof } from './aop/payment-proof-match.js';
import { pickReplyLine } from './aop/reply-lines.js';

export type HmsTodoKind = 'new_booking' | 'amend' | 'cancel' | 'payment_proof' | 'send_document';

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

export type HmsTodoStayCandidate = {
  confirmationNumber: string;
  lastName: string;
  arrival: string;
  departure: string;
  balanceDue?: number | null;
  company?: string | null;
};

export type HmsTodoPopFacts = {
  amount: number | null;
  amountText: string | null;
  currency: string | null;
  reference: string | null;
  payerName: string | null;
  paidOn: string | null;
  amountSource?: Exclude<HmsTodoStepSource, 'missing'>;
};

export type HmsTodoCardInput = {
  workflow?: string | null;
  todoTarget?: string | null;
  stayAsk?: HmsTodoStayAsk | null;
  groups?: readonly HmsTodoGroup[] | null;
  confirmationNumber?: string | null;
  guestLastName?: string | null;
  requestedChange?: string | null;
  party?: { reference?: string | null; name?: string | null } | null;
  attachmentFilenames?: readonly string[] | null;
  prefill?: BuildCreatePrefillOutput | null;
  stayCandidates?: readonly HmsTodoStayCandidate[] | null;
  pop?: HmsTodoPopFacts | null;
  documentKind?: string | null;
  billingDocuments?: readonly BillingDocumentRow[] | null;
};

const TITLE = 'Key into HMS';
const ASK_KIND_LABEL: Record<BillingDocumentAskKind, string> = {
  invoice: 'invoice',
  pro_forma: 'pro forma',
  folio: 'folio',
  statement: 'statement',
  credit_note: 'credit note',
};
const ALL_ASK_KINDS = BILLING_DOCUMENT_ASK_KINDS.map((kind) => ASK_KIND_LABEL[kind]).join(' / ');

const WORKFLOW_KIND: Record<string, HmsTodoKind> = {
  create: 'new_booking',
  create_booking: 'new_booking',
  new_booking: 'new_booking',
  booking: 'new_booking',
  amend: 'amend',
  amendment: 'amend',
  cancel: 'cancel',
  cancellation: 'cancel',
  payment_ack: 'payment_proof',
  payment_proof: 'payment_proof',
  send_document: 'send_document',
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

function kindOf(workflow: string | null | undefined, todoTarget?: string | null): HmsTodoKind | null {
  const key = workflow?.trim().toLowerCase();
  if (!key) return null;
  if (key === 'hms_todo') {
    const target = todoTarget?.trim().toLowerCase();
    if (target === 'post_payment') return 'payment_proof';
    if (target === 'document') return 'send_document';
    return null;
  }
  return WORKFLOW_KIND[key] ?? null;
}

const AMOUNT_TOKEN =
  /\b((?:ZAR|R)\s*)([0-9]{1,3}(?:[ ,][0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)\b/gi;
const ISO_DAY = /\b(\d{4}-\d{2}-\d{2})\b/g;
const ASK_KIND_RE: Array<[BillingDocumentAskKind, RegExp]> = [
  ['credit_note', /\bcredit\s*notes?\b/i],
  ['pro_forma', /\bpro[\s-]?formas?\b/i],
  ['statement', /\bstatements?\b/i],
  ['folio', /\bfolios?\b/i],
  ['invoice', /\b(?:tax\s+)?invoices?\b/i],
];

function parseAmountToken(raw: string): number | null {
  const n = Number(raw.replace(/[ ,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function uniqueStrings(values: string[]): string | null {
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0]! : null;
}

export function extractPopFacts(
  sourceText: string,
  luna: {
    rateClaims?: ReadonlyArray<{ kind: string; amount: string; currency?: string; quote?: string }>;
    guestLastName?: string | null;
    party?: { reference?: string | null; name?: string | null } | null;
  },
): HmsTodoPopFacts {
  const amounts: Array<{ value: number; text: string }> = [];
  for (const match of sourceText.matchAll(AMOUNT_TOKEN)) {
    const value = parseAmountToken(match[2] ?? '');
    if (value == null) continue;
    amounts.push({ value, text: match[0]!.replace(/\s+/g, ' ').trim() });
  }
  const uniqueAmount = [...new Set(amounts.map((row) => row.value))];
  const amount = uniqueAmount.length === 1 ? uniqueAmount[0]! : null;
  const amountText = amount == null ? null : (amounts.find((row) => row.value === amount)?.text ?? null);

  const days = [...sourceText.matchAll(ISO_DAY)].map((match) => match[1]!);
  const paidOn = uniqueStrings(days);

  const lastName = text(luna.guestLastName);
  const payerName = lastName && new RegExp(`(^|[^a-z0-9])${lastName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(sourceText)
    ? lastName
    : null;
  const reference = text(luna.party?.reference);
  const referenceInSource = reference && sourceText.includes(reference) ? reference : null;

  return {
    amount,
    amountText,
    currency: amount == null ? null : 'ZAR',
    reference: referenceInSource,
    payerName,
    paidOn,
    amountSource: 'mail',
  };
}

export function extractBillingAskKind(sourceText: string): BillingDocumentAskKind | null {
  const hits = ASK_KIND_RE.filter(([, re]) => re.test(sourceText)).map(([kind]) => kind);
  return hits.length === 1 ? hits[0]! : null;
}

function asAskKind(value: string | null | undefined): BillingDocumentAskKind | null {
  const key = value?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!key) return null;
  if ((BILLING_DOCUMENT_ASK_KINDS as readonly string[]).includes(key)) return key as BillingDocumentAskKind;
  if (key === 'tax_invoice') return 'invoice';
  return null;
}

function matchedStay(
  pop: HmsTodoPopFacts,
  candidates: readonly HmsTodoStayCandidate[],
): { status: 'exact' | 'unsure' | 'none'; stay: HmsTodoStayCandidate | null } {
  if (candidates.length === 0) return { status: 'none', stay: null };
  const result = matchPaymentProof({
    pop: {
      amount: pop.amount,
      reference: pop.reference,
      payerName: pop.payerName,
      paidOn: pop.paidOn,
    },
    candidates: candidates.map((stay) => ({ ...stay })),
  });
  if (result.status === 'exact' && result.confirmationNumber) {
    const stay = candidates.find((row) => row.confirmationNumber === result.confirmationNumber) ?? null;
    return { status: 'exact', stay };
  }
  return { status: 'unsure', stay: null };
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

function emptyPop(): HmsTodoPopFacts {
  return {
    amount: null,
    amountText: null,
    currency: null,
    reference: null,
    payerName: null,
    paidOn: null,
  };
}

function buildPaymentCard(input: HmsTodoCardInput, files: string | null): HmsTodoCard {
  const pop = input.pop ?? emptyPop();
  const candidates = input.stayCandidates ?? [];
  const match = matchedStay(pop, candidates);
  const steps: HmsTodoStep[] = [];
  const missing: string[] = [];
  const amountSource = pop.amountSource ?? 'mail';

  pushFact(steps, missing, 'Confirmation number', match.stay ? match.stay.confirmationNumber : null, true);
  if (match.stay) {
    pushFact(steps, missing, 'Guest last name', text(match.stay.lastName), false);
    pushFact(steps, missing, 'Arrival', text(match.stay.arrival), false);
    pushFact(steps, missing, 'Departure', text(match.stay.departure), false);
  }
  pushFact(steps, missing, 'Amount', pop.amount != null ? text(pop.amountText) : null, false, amountSource);
  pushFact(steps, missing, 'Currency', pop.amount != null ? text(pop.currency) : null, false, amountSource);
  pushFact(steps, missing, 'Payment date', text(pop.paidOn), false, amountSource);
  pushFact(steps, missing, 'Payment reference', text(pop.reference), false);
  if (!match.stay) pushFact(steps, missing, 'Payer', text(pop.payerName), false);
  if (match.status === 'none') pushFact(steps, missing, 'Next step', 'find the stay', true);
  if (match.status === 'unsure') pushFact(steps, missing, 'Next step', 'check conf#', true);
  pushFact(steps, missing, 'Attachments', files, false, 'attachment');
  return { kind: 'payment_proof', title: 'Post payment', steps, missing, writesEnabled: false };
}

function buildBillingCard(input: HmsTodoCardInput, files: string | null): HmsTodoCard {
  const steps: HmsTodoStep[] = [];
  const missing: string[] = [];
  const ask = asAskKind(input.documentKind);
  const documents = input.billingDocuments ?? [];
  let documentLabel = ask ? ASK_KIND_LABEL[ask] : ALL_ASK_KINDS;
  if (ask && documents.length > 0) {
    const picked = pickBillingDocument({ kind: ask, confirmationNumber: text(input.confirmationNumber) ?? undefined, documents: [...documents] });
    if (picked.status === 'one' && picked.document) documentLabel = picked.document.filename;
  }
  const confirmation = text(input.confirmationNumber);
  const lastName = text(input.guestLastName);
  pushFact(steps, missing, 'Document', documentLabel, true);
  pushFact(steps, missing, 'Confirmation number', confirmation, Boolean(confirmation));
  pushFact(steps, missing, 'Guest last name', lastName, false);
  if (input.stayAsk) appendStayAsk(steps, missing, input.stayAsk, false);
  const reply = pickReplyLine({
    code: 'S',
    attached: true,
    ...(ask ? { documentKind: ASK_KIND_LABEL[ask] } : {}),
  }).line;
  pushFact(steps, missing, 'Reply', reply, true);
  pushFact(steps, missing, 'Next step', 'HMS → Documents', true);
  if (!confirmation) pushFact(steps, missing, 'Stay', 'find the stay', true);
  pushFact(steps, missing, 'Attachments', files, false, 'attachment');
  return { kind: 'send_document', title: 'Send document', steps, missing, writesEnabled: false };
}

export function buildHmsTodoCard(input: HmsTodoCardInput): HmsTodoCard | null {
  const kind = kindOf(input.workflow, input.todoTarget);
  if (!kind) return null;

  const files = attachments(input);
  if (kind === 'payment_proof') return buildPaymentCard(input, files);
  if (kind === 'send_document') return buildBillingCard(input, files);

  const confirmation = text(input.confirmationNumber);
  const lastName = text(input.guestLastName);
  const change = text(input.requestedChange);
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
