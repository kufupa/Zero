import type { PreparedAsk, PreparedDraftAudience, PreparedFact } from './prepared-draft-input.js';

export type ReplyAssessmentIssueCode =
  | 'NEGATION_MISMATCH'
  | 'AMOUNT_OR_CURRENCY_MISMATCH'
  | 'MISSING_BRACKET'
  | 'UNSUPPORTED_ATTACHMENT_CLAIM'
  | 'UNSUPPORTED_ACTION_CLAIM'
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
  const key = normalize(fact.key);
  const code = normalize(ask.code);
  if (code === 'child_ages') return key.includes('child') && key.includes('age');
  if (code === 'stay_dates')
    return key.includes('arrival') || key.includes('departure') || key.includes('stay_dates');
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

function replyAnswersFact(
  replyText: string,
  fact: PreparedFact,
  ask: PreparedAsk,
  audience: PreparedDraftAudience,
): boolean {
  if (!supports(fact, ask, audience)) return false;
  const lower = replyText.toLocaleLowerCase();
  const values = factValueTexts(fact.value)
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
  if (code === 'price' || code === 'rate' || code === 'quote') {
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
  const expression = /\b(USD|ZAR|EUR|GBP|R)\s*([0-9][0-9,.]*)\b/gi;
  for (const match of text.matchAll(expression)) {
    const amount = Number(match[2]!.replace(/,/g, ''));
    if (Number.isFinite(amount)) out.push({ currency: match[1]!.toUpperCase(), amount });
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
    /\b(?:booking|reservation)\s+(?:is\s+)?(?:confirmed|booked|completed)\b/i.test(reply) ||
    /\bpayment\s+(?:is\s+)?(?:cleared|paid|settled|completed)\b/i.test(reply);
  const hasActionEvidence = input.facts.some((fact) => {
    if (!known(fact, audience)) return false;
    const key = normalize(fact.key);
    return (
      /(booking|reservation|payment|deposit|folio|action)/.test(key) &&
      !/(?:pending|requested|unknown|false|unverified)/i.test(factText(fact))
    );
  });
  if (
    completionClaim &&
    !hasActionEvidence &&
    !/\b(?:cannot|can't|unable|not able|unverified)\b/i.test(reply)
  ) {
    addIssue(issues, { code: 'UNSUPPORTED_ACTION_CLAIM', severity: 'critical' });
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
