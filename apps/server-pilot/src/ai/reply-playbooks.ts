import type { PreparedAsk, PreparedDraftAudience, PreparedFact } from './prepared-draft-input.js';
import { formatMissingBracket, textToSafeHtml } from './draft-evidence.js';

export type ReplyOutcome = 'complete' | 'partial' | 'clarification' | 'internal_brief' | 'abstain';
export type ReplyRequestKind =
  | 'reservation'
  | 'quote'
  | 'finance'
  | 'document'
  | 'cancellation'
  | 'group'
  | 'general';

export type ReplyPlaybookInput = {
  audience: PreparedDraftAudience;
  requestKind: ReplyRequestKind;
  asks: readonly PreparedAsk[];
  facts: readonly PreparedFact[];
  releasedCapabilities?: Readonly<Record<string, string>>;
};

export type ReplyPlaybookResult = {
  outcome: ReplyOutcome;
  textBody: string;
  htmlBody: string;
  questions: string[];
  factsUsed: string[];
  limitations: string[];
  unsupportedAskCodes: string[];
  internalNotes: string[];
};

const QUESTION_TEXT: Record<string, string> = {
  child_ages: 'Could you confirm the child ages for each child travelling?',
  stay_dates: 'Could you confirm the arrival and departure dates?',
  reservation_status: 'Could you share the confirmation number so we can check the reservation?',
  confirmation: 'Could you share the confirmation number?',
  price: 'Could you confirm the dates, room type and occupancy needed for a price check?',
  payment_status: 'Could you share the receipt reference so we can verify the payment status?',
  document: 'Could you confirm which document and stay it relates to?',
  policy: 'Could you tell us which policy question you would like us to check?',
};

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function isKnownFact(fact: PreparedFact, audience: PreparedDraftAudience): boolean {
  if (fact.status !== 'known' || fact.authority !== 'authorized' || fact.value == null)
    return false;
  if (
    audience === 'guest' &&
    /(?:bank|recipient|account)/i.test(fact.key) &&
    fact.source !== 'hms' &&
    fact.source !== 'property'
  ) {
    return false;
  }
  return audience === 'internal' || fact.disclosure !== 'staff_only';
}

function factSupportsAsk(fact: PreparedFact, ask: PreparedAsk): boolean {
  if (!isKnownFact(fact, 'internal')) return false;
  const key = normalized(fact.key);
  const code = normalized(ask.code);
  if (code === 'child_ages') return key.includes('child') && key.includes('age');
  if (code === 'stay_dates')
    return key.includes('arrival') || key.includes('departure') || key.includes('stay_dates');
  if (code === 'reservation_status' || code === 'reservation') {
    return (
      key.includes('reservation') &&
      (key.includes('status') || key.includes('confirmation') || key.includes('summary'))
    );
  }
  if (code === 'price' || code === 'rate' || code === 'quote') {
    return key.includes('price') || key.includes('rate') || key.includes('quote');
  }
  if (code === 'payment_status' || code === 'payment' || code === 'deposit') {
    return key.includes('payment') || key.includes('deposit') || key.includes('folio');
  }
  if (code === 'document' || code === 'invoice')
    return key.includes('document') || key.includes('invoice');
  if (code === 'policy') return key.includes('policy');
  if (code === 'group_block' || code === 'group') return key.includes('group');
  return key === code || key.endsWith(`_${code}`) || key.includes(code);
}

function displayValue(fact: PreparedFact): string {
  const value = fact.value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.amount != null || record.currency != null) {
      return [record.amount, record.currency].filter((part) => part != null).join(' ');
    }
    if (record.state != null) return String(record.state);
    if (record.status != null) return String(record.status);
    if (record.text != null && typeof record.text === 'string') return record.text;
    return Object.entries(record)
      .filter(([key]) => !/(?:secret|token|password|credential)/i.test(key))
      .map(([key, part]) => `${key}: ${String(part)}`)
      .join(', ');
  }
  if (Array.isArray(value)) return value.map(String).join(', ');
  return 'not available';
}

function factLine(fact: PreparedFact): string {
  const value = displayValue(fact);
  const key = normalized(fact.key);
  if (
    (key === 'booking_state' || key.includes('reservation')) &&
    /requested|pending/i.test(value)
  ) {
    return `${fact.label}: ${value}; confirmation has not been observed.`;
  }
  if (key.includes('cancellation') && /requested|pending/i.test(value)) {
    return `${fact.label}: ${value}; cancellation completion has not been observed.`;
  }
  if (
    key.includes('payment') &&
    /receipt|received/i.test(fact.label) &&
    !/cleared|settled|paid/i.test(value)
  ) {
    return `${fact.label}: receipt observed; funds-cleared status is not established.`;
  }
  return `${fact.label}: ${value}.`;
}

function uniqueAsks(asks: readonly PreparedAsk[]): PreparedAsk[] {
  const seen = new Set<string>();
  return asks.filter((ask) => {
    const code = normalized(ask.code);
    if (seen.has(code)) return false;
    seen.add(code);
    return true;
  });
}

function questionFor(ask: PreparedAsk): string {
  return (
    QUESTION_TEXT[normalized(ask.code)] ?? `Could you provide the ${ask.label.toLocaleLowerCase()}?`
  );
}

function missingBracket(ask: PreparedAsk, released: Readonly<Record<string, string>>): string {
  const acquisition =
    ask.capabilityId && !released[ask.capabilityId]
      ? `${ask.capabilityId} (capability unavailable)`
      : (ask.acquisition ??
        `request ${ask.label.toLocaleLowerCase()} from the guest or approved read`);
  return formatMissingBracket({ need: ask.label, acquisition });
}

function renderGuest(
  outcome: Exclude<ReplyOutcome, 'internal_brief'>,
  lines: readonly string[],
  questions: readonly string[],
  limitations: readonly string[],
): string {
  const body: string[] = ['Hello,'];
  if (outcome === 'abstain') {
    body.push(
      'Thank you for your message. We need a staff member to perform a manual review before we provide an answer.',
    );
  } else if (outcome === 'clarification') {
    body.push(
      'Thank you for your message. Could you provide the following detail so we can check this accurately?',
    );
  } else {
    body.push(
      'Thank you for your message. Here is what we can confirm from the authorized records:',
    );
  }
  body.push(...lines);
  body.push(...questions.map((question) => `- ${question}`));
  body.push(...limitations.map((limitation) => `- ${limitation}`));
  body.push('Kind regards,\nCenturion Reservations');
  return body.join('\n\n');
}

function renderInternal(
  requestKind: ReplyRequestKind,
  lines: readonly string[],
  questions: readonly string[],
  limitations: readonly string[],
): string {
  const body = [
    `Internal brief — ${requestKind} request`,
    'Guest-facing response is not generated from this brief.',
  ];
  if (lines.length > 0) body.push('Known facts:', ...lines.map((line) => `- ${line}`));
  if (questions.length > 0)
    body.push('Open questions:', ...questions.map((question) => `- ${question}`));
  if (limitations.length > 0)
    body.push('Limitations:', ...limitations.map((limitation) => `- ${limitation}`));
  body.push('No booking, cancellation, payment, or sending action is implied.');
  return body.join('\n\n');
}

/** Select a controlled playbook from facts and asks; no model is trusted to invent facts. */
export function buildReplyPlaybook(input: ReplyPlaybookInput): ReplyPlaybookResult {
  const released = input.releasedCapabilities ?? {};
  const asks = uniqueAsks(input.asks);
  const usableFacts = input.facts.filter((fact) => isKnownFact(fact, input.audience));
  const guestFacts = usableFacts.filter(
    (fact) => input.audience === 'internal' || fact.disclosure !== 'staff_only',
  );
  const factsUsed = guestFacts.map((fact) => fact.key);
  const supportedAsks = new Set(
    asks
      .filter(
        (ask) =>
          (!ask.capabilityId || released[ask.capabilityId]) &&
          guestFacts.some((fact) => factSupportsAsk(fact, ask)),
      )
      .map((ask) => normalized(ask.code)),
  );
  const requiredAsks = asks.filter((ask) => ask.required !== false);
  const unsupported = requiredAsks.filter((ask) => !supportedAsks.has(normalized(ask.code)));
  const questions = unsupported.map(questionFor);
  const limitations = unsupported.map((ask) => missingBracket(ask, released));
  const lines = guestFacts.map(factLine);

  let outcome: ReplyOutcome;
  if (input.audience === 'internal' || input.requestKind === 'group') {
    outcome = 'internal_brief';
  } else if (guestFacts.length === 0) {
    // An empty evidence set can be resolved by a focused guest question;
    // an explicitly unavailable/unknown source must remain an abstention.
    outcome = questions.length > 0 && input.facts.length === 0 ? 'clarification' : 'abstain';
  } else if (unsupported.length === 0) {
    outcome = 'complete';
  } else {
    outcome = 'partial';
  }

  const textBody =
    outcome === 'internal_brief'
      ? renderInternal(input.requestKind, lines, questions, limitations)
      : renderGuest(outcome, lines, questions, limitations);
  return {
    outcome,
    textBody,
    htmlBody: textToSafeHtml(textBody),
    questions,
    factsUsed,
    limitations,
    unsupportedAskCodes: unsupported.map((ask) => ask.code),
    internalNotes:
      input.requestKind === 'group'
        ? ['Group/commercial context remains staff-only; no guest confirmation is implied.']
        : [],
  };
}

export const selectReplyPlaybook = buildReplyPlaybook;
