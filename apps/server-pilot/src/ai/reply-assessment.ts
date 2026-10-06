import type { PreparedAsk, PreparedDraftAudience, PreparedFact } from './prepared-draft-input.js';

export type ReplyAssessmentIssueCode =
  | 'NEGATION_MISMATCH'
  | 'AMOUNT_OR_CURRENCY_MISMATCH'
  | 'MISSING_BRACKET'
  | 'UNSUPPORTED_ATTACHMENT_CLAIM'
  | 'UNSUPPORTED_ACTION_CLAIM'
  | 'UNSUPPORTED_DATE_CLAIM'
  | 'UNSUPPORTED_RECIPIENT_CLAIM';

export type ReplyAssessmentIssue = {
  code: ReplyAssessmentIssueCode;
  severity: 'critical' | 'warning';
  factKey?: string;
};

export type ReplyAssessment = {
  ok: boolean;
  coverage: { answered: number; total: number };
  issues: ReplyAssessmentIssue[];
  supportedFactKeys: string[];
};

export type ReplyAssessmentInput = {
  replyText: string;
  asks: readonly PreparedAsk[];
  facts: readonly PreparedFact[];
  audience?: PreparedDraftAudience;
  authorizedAttachmentRefs?: ReadonlySet<string> | readonly string[];
};

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function known(fact: PreparedFact, audience: PreparedDraftAudience = 'guest'): boolean {
  return (
    fact.status === 'known' &&
    fact.authority === 'authorized' &&
    fact.value != null &&
    (audience === 'internal' || fact.disclosure !== 'staff_only')
  );
}

function supports(fact: PreparedFact, ask: PreparedAsk, audience: PreparedDraftAudience): boolean {
  if (!known(fact, audience)) return false;
  if (ask.code.startsWith('quote_total_')) return fact.key === ask.code;
  const key = normalize(fact.key);
  const code = normalize(ask.code);
  if (code === 'child_ages') return key.includes('child') && key.includes('age');
  if (code === 'stay_dates')
    return (
      key.includes('arrival') ||
      key.includes('departure') ||
      key.includes('stay_dates') ||
      (key.includes('reservation') && key.includes('summary'))
    );
  if (code === 'reservation_status' || code === 'reservation') {
    return (
      key.includes('reservation') &&
      (key.includes('status') || key.includes('confirmation') || key.includes('summary'))
    );
  }
  if (code === 'price' || code === 'rate' || code === 'quote')
    return key.includes('price') || key.includes('rate') || key.includes('quote');
  if (code === 'payment_status' || code === 'payment' || code === 'deposit')
    return key.includes('payment') || key.includes('deposit') || key.includes('folio');
  if (code === 'document' || code === 'invoice')
    return key.includes('document') || key.includes('invoice');
  return key === code || key.endsWith(`_${code}`) || key.includes(code);
}

function factText(fact: PreparedFact): string {
  if (typeof fact.value === 'string') return fact.value;
  if (typeof fact.value === 'number' || typeof fact.value === 'boolean') return String(fact.value);
  if (fact.value && typeof fact.value === 'object') return JSON.stringify(fact.value);
  return '';
}

function factValueTexts(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (Array.isArray(value)) return value.flatMap((item) => factValueTexts(item, depth + 1));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      factValueTexts(item, depth + 1),
    );
  }
  return [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Select only fields whose semantics match the requested answer. */
function factValuesForAsk(fact: PreparedFact, ask: PreparedAsk): string[] {
  const code = normalize(ask.code);
  const record = recordValue(fact.value);
  if (!record) return factValueTexts(fact.value);
  const fields =
    code === 'reservation_status' || code === 'reservation'
      ? ['reservationStatus', 'bookingStatus', 'confirmationStatus', 'status']
      : code === 'stay_dates'
        ? ['arrivalDate', 'departureDate', 'checkIn', 'checkOut', 'stayDates']
        : code === 'price' || code === 'rate' || code === 'quote' || ask.code.startsWith('quote_total_')
          ? ['amount', 'currency', 'total', 'displayedAmount', 'rate']
          : code === 'payment_status' || code === 'payment' || code === 'deposit'
            ? ['paymentStatus', 'depositStatus', 'status', 'amount', 'currency']
            : [];
  return fields
    .filter((field) => record[field] !== undefined && record[field] !== null)
    .flatMap((field) => factValueTexts(record[field]))
    .filter((item) => item.trim().length > 0);
}

function replyAnswersFact(
  replyText: string,
  fact: PreparedFact,
  ask: PreparedAsk,
  audience: PreparedDraftAudience,
): boolean {
  if (!supports(fact, ask, audience)) return false;
  const lower = replyText.toLocaleLowerCase();
  const values = factValuesForAsk(fact, ask)
    .map((value) => value.trim().toLocaleLowerCase())
    .filter((value) => value.length >= 3);
  if (values.length === 0 || !values.some((value) => lower.includes(value))) return false;
  const code = normalize(ask.code);
  if (code === 'reservation_status' || code === 'reservation') {
    return /\b(?:reservation|booking|status|confirmation|confirmed|pending|cancelled|canceled)\b/i.test(
      lower,
    );
  }
  if (code === 'stay_dates')
    return /\b(?:stay|arrival|departure|check[- ]?in|check[- ]?out|\d{4}[-/]\d{1,2})\b/i.test(
      lower,
    );
  if (code === 'price' || code === 'rate' || code === 'quote' || ask.code.startsWith('quote_total_')) {
    return /\b(?:price|rate|quote|total|usd|zar|eur|gbp|r)\b/i.test(lower);
  }
  if (code === 'payment_status' || code === 'payment' || code === 'deposit') {
    return /\b(?:payment|deposit|paid|pending|receipt|cleared|received|unpaid)\b/i.test(lower);
  }
  return (
    lower.includes(normalize(ask.label).replace(/_/g, ' ')) ||
    lower.includes(normalize(fact.label).replace(/_/g, ' '))
  );
}

function extractMoney(text: string): Array<{ currency: string; amount: number }> {
  const out: Array<{ currency: string; amount: number }> = [];
  const expression = /\b(USD|ZAR|EUR|GBP|R)\s*((?:[0-9]{1,3}(?:[ \u00a0][0-9]{3})+|[0-9][0-9,]*)(?:\.[0-9]{1,2})?)\b/gi;
  for (const match of text.matchAll(expression)) {
    const amount = Number(match[2]!.replace(/[, \u00a0]/g, ''));
    if (Number.isFinite(amount)) out.push({ currency: match[1]!.toUpperCase() === 'R' ? 'ZAR' : match[1]!.toUpperCase(), amount });
  }
  return out;
}

function knownMoney(
  facts: readonly PreparedFact[],
  audience: PreparedDraftAudience,
): Array<{ key: string; currency?: string; amount?: number }> {
  const result: Array<{ key: string; currency?: string; amount?: number }> = [];
  for (const fact of facts) {
    if (
      !known(fact, audience) ||
      !/(?:price|rate|amount|balance|deposit|payment|total)/i.test(fact.key)
    )
      continue;
    if (typeof fact.value === 'object' && fact.value !== null && !Array.isArray(fact.value)) {
      const value = fact.value as Record<string, unknown>;
      const amount =
        value.amount == null ? undefined : Number(String(value.amount).replace(/,/g, ''));
      result.push({
        key: fact.key,
        currency: value.currency == null ? undefined : String(value.currency).toUpperCase(),
        amount: Number.isFinite(amount) ? amount : undefined,
      });
    }
  }
  return result;
}

function positiveActionEvidence(fact: PreparedFact, audience: PreparedDraftAudience): boolean {
  if (!known(fact, audience)) return false;
  const key = normalize(fact.key);
  const summary = recordValue(fact.value);
  const value =
    key.includes('summary') && summary?.reservationStatus !== undefined
      ? summary.reservationStatus
      : fact.value;
  const values = factValueTexts(value).join(' ');
  if (/(?:reservation|booking)/.test(key)) {
    return /\b(?:confirmed|booked|completed|approved|secured)\b/i.test(values);
  }
  if (/(?:payment|deposit|folio)/.test(key)) {
    return /\b(?:paid|settled|cleared|completed)\b/i.test(values);
  }
  if (key.includes('cancellation')) {
    return /\b(?:cancelled|canceled|completed)\b/i.test(values);
  }
  return (
    key.includes('action') && /\b(?:confirmed|completed|approved|secured|processed)\b/i.test(values)
  );
}

function dateLiterals(text: string): string[] {
  return [
    ...(text.match(/\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g) ?? []),
    ...(text.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g) ?? []),
    ...(text.match(
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*20\d{2})?\b/gi,
    ) ?? []),
  ].map((literal) => literal.toLocaleLowerCase());
}

function timeLiterals(text: string): string[] {
  return text.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g) ?? [];
}

function knownDateValues(
  facts: readonly PreparedFact[],
  audience: PreparedDraftAudience,
): string[] {
  return facts
    .filter(
      (fact) =>
        known(fact, audience) &&
        ((/(?:date|arrival|departure|check.?in|check.?out|stay)/i.test(fact.key) || fact.key === 'breakfast_time') ||
          (/(?:reservation|booking)/i.test(fact.key) && /summary/i.test(fact.key))),
    )
    .flatMap((fact) => {
      const record = recordValue(fact.value);
      if (record && /(?:reservation|booking|summary)/i.test(fact.key)) {
        return ['arrivalDate', 'departureDate', 'checkIn', 'checkOut', 'stayDates'].flatMap(
          (field) => (record[field] === undefined ? [] : factValueTexts(record[field])),
        );
      }
      return factValueTexts(fact.value);
    })
    .map((value) => value.toLocaleLowerCase());
}

function hasBracketFor(replyText: string, ask: PreparedAsk): boolean {
  const lower = replyText.toLocaleLowerCase();
  return lower.includes('[missing:') && lower.includes(ask.label.toLocaleLowerCase());
}

function addIssue(issues: ReplyAssessmentIssue[], issue: ReplyAssessmentIssue): void {
  if (
    !issues.some((existing) => existing.code === issue.code && existing.factKey === issue.factKey)
  ) {
    issues.push(issue);
  }
}

/** Deterministic factual/safety assessment; no language-model agreement is treated as truth. */
export function assessReply(input: ReplyAssessmentInput): ReplyAssessment {
  const issues: ReplyAssessmentIssue[] = [];
  const reply = input.replyText;
  const lower = reply.toLocaleLowerCase();
  const audience = input.audience ?? 'guest';
  const supportedFactKeys = input.facts
    .filter((fact) => known(fact, audience))
    .map((fact) => fact.key);
  const requiredAsks = input.asks.filter((ask) => ask.required !== false);
  const answered = requiredAsks.filter((ask) =>
    input.facts.some((fact) => replyAnswersFact(reply, fact, ask, audience)),
  ).length;

  const completionClaim =
    /\b(?:booking|reservation)\s+(?:is\s+|has\s+been\s+|was\s+)?(?:confirmed|booked|completed|secured|approved)\b/i.test(
      reply,
    ) ||
    /\bpayment\s+(?:is\s+|has\s+been\s+|was\s+)?(?:cleared|paid|settled|completed)\b/i.test(
      reply,
    ) ||
    /\b(?:we|i)\s+(?:have\s+|has\s+|just\s+)?(?:processed|confirmed|booked|secured|approved|completed|cancelled|canceled)\s+(?:your\s+)?(?:booking|reservation|cancellation)\b/i.test(
      reply,
    );
  const hasActionEvidence = input.facts.some((fact) => positiveActionEvidence(fact, audience));
  // A limitation does not authorize a separate unsupported action/date
  // clause. Every factual clause must still be justified by a typed fact; the
  // workflow's returned body is code-owned, while this check remains useful
  // telemetry for rejecting an untrusted model proposal.
  if (completionClaim && !hasActionEvidence) {
    addIssue(issues, { code: 'UNSUPPORTED_ACTION_CLAIM', severity: 'critical' });
  }

  const mentionedDates = dateLiterals(reply);
  const mentionedTimes = timeLiterals(reply);
  const knownDates = knownDateValues(input.facts, audience);
  const unsupportedDate =
    mentionedDates.some(
      (literal) => !knownDates.some((knownDate) => knownDate.includes(literal)),
    ) ||
    mentionedTimes.some(time => !knownDates.some(knownDate => timeLiterals(knownDate).includes(time)));
  if (unsupportedDate) {
    addIssue(issues, { code: 'UNSUPPORTED_DATE_CLAIM', severity: 'critical' });
  }

  for (const fact of input.facts) {
    if (!known(fact, audience)) continue;
    const factValue = factText(fact).toLocaleLowerCase();
    const key = normalize(fact.key);
    const positiveAction =
      /\b(?:confirmed|booked|paid|settled|cleared|completed|cancelled|canceled|attached|enclosed)\b/i.test(
        lower,
      );
    if (
      /(?:payment|receipt|funds|deposit)/.test(key) &&
      /(?:false|pending|receipt|received|unverified)/i.test(factValue) &&
      /\b(?:paid|settled|cleared|funds received)\b/i.test(lower)
    ) {
      addIssue(issues, { code: 'NEGATION_MISMATCH', severity: 'critical', factKey: fact.key });
    }
    if (
      (key.includes('booking') || key.includes('reservation')) &&
      /requested|pending/i.test(factValue) &&
      /\b(?:confirmed|booked)\b/i.test(lower)
    ) {
      addIssue(issues, { code: 'NEGATION_MISMATCH', severity: 'critical', factKey: fact.key });
    }
    if (
      key.includes('cancellation') &&
      /requested|pending/i.test(factValue) &&
      /\b(?:cancelled|canceled|completed)\b/i.test(lower)
    ) {
      addIssue(issues, { code: 'NEGATION_MISMATCH', severity: 'critical', factKey: fact.key });
    }
    if (key.includes('action') && /requested|pending|unknown/i.test(factValue) && positiveAction) {
      addIssue(issues, {
        code: 'UNSUPPORTED_ACTION_CLAIM',
        severity: 'critical',
        factKey: fact.key,
      });
    }
  }

  const mentionedMoney = extractMoney(reply);
  const availableMoney = knownMoney(input.facts, audience);
  if (mentionedMoney.length > 0) {
    if (availableMoney.length === 0) {
      addIssue(issues, { code: 'AMOUNT_OR_CURRENCY_MISMATCH', severity: 'critical' });
    } else {
      for (const mention of mentionedMoney) {
        const match = availableMoney.some(
          (fact) =>
            fact.amount === mention.amount &&
            fact.currency !== undefined &&
            fact.currency === mention.currency,
        );
        if (!match) addIssue(issues, { code: 'AMOUNT_OR_CURRENCY_MISMATCH', severity: 'critical' });
      }
    }
  }

  for (const ask of requiredAsks) {
    if (
      !input.facts.some((fact) => replyAnswersFact(reply, fact, ask, audience)) &&
      !hasBracketFor(reply, ask)
    ) {
      addIssue(issues, { code: 'MISSING_BRACKET', severity: 'warning' });
    }
  }

  const attachmentRefs =
    input.authorizedAttachmentRefs instanceof Set
      ? input.authorizedAttachmentRefs
      : new Set(input.authorizedAttachmentRefs ?? []);
  if (/\b(?:attached|enclosed|attachment)\b/i.test(reply) && attachmentRefs.size === 0) {
    addIssue(issues, { code: 'UNSUPPORTED_ATTACHMENT_CLAIM', severity: 'critical' });
  }
  if (
    /\b(?:bank|recipient|account)\b/i.test(reply) &&
    !input.facts.some(
      (fact) =>
        known(fact, audience) &&
        (fact.source === 'hms' || fact.source === 'property') &&
        /bank|recipient|account/i.test(fact.key),
    )
  ) {
    addIssue(issues, { code: 'UNSUPPORTED_RECIPIENT_CLAIM', severity: 'critical' });
  }

  return {
    ok: !issues.some((issue) => issue.severity === 'critical'),
    coverage: { answered, total: requiredAsks.length },
    issues,
    supportedFactKeys,
  };
}

export const assessDraftReply = assessReply;
