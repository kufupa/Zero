import { MAIL_SOURCE_RULE_DATA, type MailSourceRuleData } from '../../config/mail-source-rules.js';

export type MailSourceKind = 'channel' | 'system' | 'direct';

export type MailSourceClassification =
  | { kind: 'channel' | 'system'; source: string; reason: string }
  | { kind: 'direct'; source: null; reason: string };

export function isMailSourceClassification(value: unknown): value is MailSourceClassification {
  if (!value || typeof value !== 'object') return false;
  const decision = value as Record<string, unknown>;
  if (
    (decision.kind !== 'channel' && decision.kind !== 'system' && decision.kind !== 'direct') ||
    typeof decision.reason !== 'string'
  ) {
    return false;
  }
  return decision.kind === 'direct'
    ? decision.source === null
    : typeof decision.source === 'string' && decision.source.trim().length > 0;
}

type MailSourceRule = Omit<
  MailSourceRuleData,
  'forwardedSubjectPatterns' | 'directSubjectPatterns' | 'skipSubjectPatterns'
> & {
  forwardedSubjectPatterns?: readonly RegExp[];
  directSubjectPatterns?: readonly RegExp[];
  skipSubjectPatterns?: readonly RegExp[];
};

type MailSourcePatternData = NonNullable<MailSourceRuleData['forwardedSubjectPatterns']>[number];

function compilePatterns(patterns: readonly MailSourcePatternData[]): readonly RegExp[] {
  return patterns.map(({ source, flags }) => new RegExp(source, flags));
}

function compileRule(rule: MailSourceRuleData): MailSourceRule {
  return {
    id: rule.id,
    kind: rule.kind,
    source: rule.source,
    domains: rule.domains,
    ...(rule.forwardedSubjectPatterns === undefined
      ? {}
      : { forwardedSubjectPatterns: compilePatterns(rule.forwardedSubjectPatterns) }),
    ...(rule.otaChip === undefined ? {} : { otaChip: rule.otaChip }),
    ...(rule.bookingPhrase === undefined ? {} : { bookingPhrase: rule.bookingPhrase }),
    ...(rule.directSubjectPatterns === undefined
      ? {}
      : { directSubjectPatterns: compilePatterns(rule.directSubjectPatterns) }),
    ...(rule.skipSubjectPatterns === undefined
      ? {}
      : { skipSubjectPatterns: compilePatterns(rule.skipSubjectPatterns) }),
  };
}

/** Compile configured regex data once for the browser-safe server/pane registry. */
export const MAIL_SOURCE_RULES: readonly MailSourceRule[] = MAIL_SOURCE_RULE_DATA.map(compileRule);

const INTERNAL_FORWARD_DOMAINS = ['legacyhotels.co.za'] as const;
const FORWARD_SUBJECT_PREFIX = /^(?:(?:fw|fwd|forwarded)\s*:\s*)+/i;
const FORWARDED_HEADER_LINE = /^\s*(?:>\s*)*(?:from|sender)\s*:\s*(.*?)\s*$/i;
const FORWARDED_SUBJECT_LINE = /^\s*(?:>\s*)*subject\s*:\s*(.*?)\s*$/i;
/** Header lines after the forwarded From line that may hold its Subject (Sent, To, Cc, Subject). */
const FORWARD_SUBJECT_LOOKAHEAD_LINES = 6;
const EMAIL_ADDRESS = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z0-9-]{2,63}/i;
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(?:\s+[^<>]*)?\s*\/?>/i;
const HTML_BLOCK_TAG = /<\/?(?:address|article|aside|blockquote|body|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|html|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)(?:\s+[^<>]*)?\s*\/?>/gi;
const HTML_ENTITY = /&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/gi;
const MAX_FORWARD_HEADER_CHARS = 5_000;

function extractDomain(rawAddress: string | null | undefined): string {
  if (!rawAddress) return '';
  const address = EMAIL_ADDRESS.exec(rawAddress)?.[0];
  if (!address) return '';
  return address.slice(address.lastIndexOf('@') + 1).replace(/\.+$/, '').toLowerCase();
}

function domainMatches(domain: string, registeredDomain: string): boolean {
  return domain === registeredDomain || domain.endsWith(`.${registeredDomain}`);
}

function ruleForDomain(domain: string): { rule: MailSourceRule; registeredDomain: string } | null {
  for (const rule of MAIL_SOURCE_RULES) {
    const registeredDomain = rule.domains.find((candidate) => domainMatches(domain, candidate));
    if (registeredDomain) return { rule, registeredDomain };
  }
  return null;
}

function isInternalForwardSender(domain: string): boolean {
  return INTERNAL_FORWARD_DOMAINS.some((registeredDomain) => domainMatches(domain, registeredDomain));
}

function matchedSource(
  rule: MailSourceRule,
  reason: string,
): MailSourceClassification {
  return { kind: rule.kind, source: rule.source, reason };
}

/** A known sender's mail stays direct when it relays a person's enquiry, or falls outside the rule's skip subjects. */
function directExemption(
  rule: MailSourceRule,
  subjects: readonly (string | null | undefined)[],
): MailSourceClassification | null {
  const matches = (patterns: readonly RegExp[] | undefined) =>
    subjects.some((subject) => patterns?.some((pattern) => pattern.test(subject ?? '')));
  if (matches(rule.directSubjectPatterns)) {
    return { kind: 'direct', source: null, reason: `relayed_enquiry:${rule.id}` };
  }
  if (rule.skipSubjectPatterns && !matches(rule.skipSubjectPatterns)) {
    return { kind: 'direct', source: null, reason: `unskipped_subject:${rule.id}` };
  }
  return null;
}

function plainTextBody(bodyText: string): string {
  if (!HTML_TAG.test(bodyText)) return bodyText;
  return bodyText
    .replace(HTML_BLOCK_TAG, '\n')
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s+[^<>]*)?\s*\/?>/gi, '')
    .replace(HTML_ENTITY, (entity) => {
      switch (entity.toLowerCase()) {
        case '&nbsp;':
          return ' ';
        case '&amp;':
          return '&';
        case '&lt;':
          return '<';
        case '&gt;':
          return '>';
        case '&quot;':
          return '"';
        case '&#39;':
          return "'";
        default:
          return entity;
      }
    });
}

function originalForwardSender(
  bodyText: string,
): { rule: MailSourceRule; domain: string; subject: string | null } | null {
  const lines = bodyText.slice(0, MAX_FORWARD_HEADER_CHARS).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const header = FORWARDED_HEADER_LINE.exec(line);
    if (!header) continue;
    const domain = extractDomain(header[1]);
    const match = ruleForDomain(domain);
    if (!match) return null;
    const subjectLine = lines
      .slice(index + 1, index + 1 + FORWARD_SUBJECT_LOOKAHEAD_LINES)
      .map((candidate) => FORWARDED_SUBJECT_LINE.exec(candidate)?.[1])
      .find((subject) => subject !== undefined);
    return { rule: match.rule, domain: match.registeredDomain, subject: subjectLine ?? null };
  }
  return null;
}

function forwardedSubject(subject: string): string | null {
  const trimmed = subject.trim();
  const prefix = FORWARD_SUBJECT_PREFIX.exec(trimmed);
  return prefix ? trimmed.slice(prefix[0].length).trim() : null;
}

/**
 * Classify only known sender domains, or a known source in an internal forward. Ordinary message text is never evidence:
 * a guest or travel agent can mention an OTA without turning their direct request into channel mail.
 */
export function classifyMailSource(input: {
  fromAddress?: string | null;
  subject?: string | null;
  bodyText?: string | null;
}): MailSourceClassification {
  const senderDomain = extractDomain(input.fromAddress);
  const senderMatch = ruleForDomain(senderDomain);
  if (senderMatch) {
    const exemption = directExemption(senderMatch.rule, [input.subject]);
    if (exemption) return exemption;
    return matchedSource(senderMatch.rule, `sender_domain:${senderMatch.registeredDomain}`);
  }

  if (isInternalForwardSender(senderDomain)) {
    const forwardedSender = originalForwardSender(plainTextBody(input.bodyText ?? ''));
    if (forwardedSender) {
      const exemption = directExemption(forwardedSender.rule, [input.subject, forwardedSender.subject]);
      if (exemption) return exemption;
      return matchedSource(forwardedSender.rule, `forwarded_sender:${forwardedSender.domain}`);
    }

    const originalSubject = forwardedSubject(input.subject ?? '');
    if (originalSubject) {
      for (const rule of MAIL_SOURCE_RULES) {
        if (rule.forwardedSubjectPatterns?.some((pattern) => pattern.test(originalSubject))) {
          return matchedSource(rule, `forwarded_subject:${rule.id}`);
        }
      }
    }
  }

  return {
    kind: 'direct',
    source: null,
    reason: 'no_matching_sender_or_forward_header',
  };
}

function channelPhrase(phrase: string): RegExp {
  const bounded = String.raw`(?<![\w.-])(?:${phrase})(?![\w-])`;
  return new RegExp(
    String.raw`(?:\b(?:book(?:ed|ing)|made|reserved)\s+(?:via|through|on|with)\s+${bounded})|(?:${bounded}\s+(?:reservation|booking)\s*(?:confirmation|number|no\.?|id|#|:))`,
    'i',
  );
}

/** Label used by the existing OTA chip. Text phrases are attribution only, never source classification. */
export function otaBookingChannel(input: {
  fromAddress?: string | null;
  subject?: string | null;
  bodyText?: string | null;
}): string | null {
  const senderSource = classifyMailSource({ fromAddress: input.fromAddress });
  if (senderSource.kind === 'channel') {
    const senderRule = MAIL_SOURCE_RULES.find((rule) => rule.source === senderSource.source);
    if (senderRule?.otaChip) return senderRule.source;
  }

  const content = `${input.subject ?? ''}\n${input.bodyText ?? ''}`;
  return (
    MAIL_SOURCE_RULES.find(
      (rule) => rule.bookingPhrase && channelPhrase(rule.bookingPhrase).test(content),
    )?.source ?? null
  );
}
