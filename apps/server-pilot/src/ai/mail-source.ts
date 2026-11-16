import { MAIL_SOURCE_RULE_DATA, ROUTINE_NOTICE_EXCLUSION_DATA, type MailSourceRuleData, type RoutineNoticeExclusionData } from '../../config/mail-source-rules.js';

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
  | 'senderPatterns'
  | 'skipSubjectPatterns'
  | 'directSubjectPatterns'
  | 'skipBodyPatterns'
> & {
  senderPatterns?: readonly RegExp[];
  skipSubjectPatterns?: readonly RegExp[];
  directSubjectPatterns?: readonly RegExp[];
  skipBodyPatterns?: readonly RegExp[];
};

type MailSourcePatternData = NonNullable<MailSourceRuleData['senderPatterns']>[number];

function compilePatterns(patterns: readonly MailSourcePatternData[]): readonly RegExp[] {
  return patterns.map(({ source, flags }) => new RegExp(source, flags));
}

function compileRule(rule: MailSourceRuleData): MailSourceRule {
  return {
    id: rule.id,
    kind: rule.kind,
    source: rule.source,
    domains: rule.domains,
    ...(rule.exactHost === undefined ? {} : { exactHost: rule.exactHost }),
    ...(rule.otaChip === undefined ? {} : { otaChip: rule.otaChip }),
    ...(rule.bookingPhrase === undefined ? {} : { bookingPhrase: rule.bookingPhrase }),
    ...(rule.directSubjectPatterns === undefined
      ? {}
      : { directSubjectPatterns: compilePatterns(rule.directSubjectPatterns) }),
    ...(rule.skipSubjectPatterns === undefined
      ? {}
      : { skipSubjectPatterns: compilePatterns(rule.skipSubjectPatterns) }),
    ...(rule.senderPatterns === undefined ? {} : { senderPatterns: compilePatterns(rule.senderPatterns) }),
    ...(rule.skipBodyPatterns === undefined
      ? {}
      : { skipBodyPatterns: compilePatterns(rule.skipBodyPatterns) }),
    ...(rule.requiresNoAttachments === undefined ? {} : { requiresNoAttachments: rule.requiresNoAttachments }),
  };
}

/** Compile configured regex data once for the browser-safe server/pane registry. */
export const MAIL_SOURCE_RULES: readonly MailSourceRule[] = MAIL_SOURCE_RULE_DATA.map(compileRule);

type RoutineNoticeExclusion = Omit<RoutineNoticeExclusionData, 'senderPattern' | 'subjectPattern' | 'humanOrigin'> & {
  senderPattern: RegExp;
  subjectPattern: RegExp;
  humanOrigin?: boolean;
};

const ROUTINE_NOTICE_EXCLUSIONS: readonly RoutineNoticeExclusion[] = ROUTINE_NOTICE_EXCLUSION_DATA.map((entry) => ({
  id: entry.id,
  kind: entry.kind,
  source: entry.source,
  senderPattern: new RegExp(entry.senderPattern.source, entry.senderPattern.flags),
  subjectPattern: new RegExp(entry.subjectPattern.source, entry.subjectPattern.flags),
  ...(entry.humanOrigin === undefined ? {} : { humanOrigin: entry.humanOrigin }),
}));

const EMAIL_ADDRESS = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z0-9-]{2,63}/i;
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(?:\s+[^<>]*)?\s*\/?>/i;
const HTML_BLOCK_TAG = /<\/?(?:address|article|aside|blockquote|body|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|html|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)(?:\s+[^<>]*)?\s*\/?>/gi;
const HTML_ENTITY = /&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/gi;

function extractDomain(rawAddress: string | null | undefined): string {
  if (!rawAddress) return '';
  const address = EMAIL_ADDRESS.exec(rawAddress)?.[0];
  if (!address) return '';
  return address.slice(address.lastIndexOf('@') + 1).replace(/\.+$/, '').toLowerCase();
}

function domainMatches(domain: string, registeredDomain: string, exactHost?: boolean): boolean {
  return domain === registeredDomain || (!exactHost && domain.endsWith(`.${registeredDomain}`));
}

function ruleForDomain(domain: string): { rule: MailSourceRule; registeredDomain: string } | null {
  for (const rule of MAIL_SOURCE_RULES) {
    const registeredDomain = rule.domains.find((candidate) => domainMatches(domain, candidate, rule.exactHost));
    if (registeredDomain) return { rule, registeredDomain };
  }
  return null;
}

function matchedSource(
  rule: MailSourceRule,
  reason: string,
): MailSourceClassification {
  return { kind: rule.kind, source: rule.source, reason };
}

/** A known sender's mail stays direct when it relays a person's enquiry, or fails a configured skip-evidence gate. */
function directExemption(
  rule: MailSourceRule,
  subject: string | null | undefined,
  evidence: { fromAddress?: string | null; bodyText?: string | null; hasAttachments?: boolean },
): MailSourceClassification | null {
  const matches = (patterns: readonly RegExp[] | undefined) =>
    patterns?.some((pattern) => pattern.test(subject ?? '')) === true;
  if (rule.senderPatterns && !rule.senderPatterns.some((pattern) => pattern.test(evidence.fromAddress ?? ''))) {
    return { kind: 'direct', source: null, reason: `unmatched_sender:${rule.id}` };
  }
  if (matches(rule.directSubjectPatterns)) {
    return { kind: 'direct', source: null, reason: `relayed_enquiry:${rule.id}` };
  }
  if (rule.skipSubjectPatterns && !matches(rule.skipSubjectPatterns)) {
    return { kind: 'direct', source: null, reason: `unskipped_subject:${rule.id}` };
  }
  if (rule.skipBodyPatterns && !rule.skipBodyPatterns.every((pattern) => pattern.test(plainTextBody(evidence.bodyText ?? '')))) {
    return { kind: 'direct', source: null, reason: `unmatched_body:${rule.id}` };
  }
  if (rule.requiresNoAttachments && evidence.hasAttachments !== false) {
    return {
      kind: 'direct',
      source: null,
      reason: evidence.hasAttachments === true ? `attachments_present:${rule.id}` : `attachments_unverified:${rule.id}`,
    };
  }
  return null;
}

function plainTextBody(bodyText: string): string {
  if (!HTML_TAG.test(bodyText)) return bodyText;
  return bodyText
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
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

/**
 * A human-origin routine notice is suppressed only by a proven content-free
 * send: the subject must be the exact bare notice subject (enforced by the
 * exclusion's anchored pattern, so a reply, forward or any added text stays
 * reviewable), the body must be empty, and attachments must be proven absent.
 * Any body line could be staff-authored, and a present or unverified file can
 * carry a whole separate ask, so both keep the mail reviewable.
 */
function humanOriginNoticeSuppressed(input: {
  /** Body already reduced to plain text by the caller. */
  plainBody: string;
  /** Tri-state attachment evidence; only `false` (proven none) counts. */
  hasAttachments?: boolean;
}): boolean {
  return input.hasAttachments === false && !input.plainBody.trim();
}

/**
 * Classify only known sender domains and exact routine notices. Ordinary
 * message text is never evidence: a guest or travel agent can mention an OTA
 * without turning their direct request into channel mail, and a human forward
 * of a channel or notice can never be proved unannotated — any body line can
 * be staff-authored even when it resembles an embedded header — so every
 * human-origin forward stays reviewable for first-pass adjudication.
 */
export function classifyMailSource(input: {
  fromAddress?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  /** Whether the message carries at least one non-inline attachment; undefined means unknown. A human-origin send skips only on a proven-empty set, since a file can carry the whole ask. */
  hasAttachments?: boolean;
}): MailSourceClassification {
  const plainBody = plainTextBody(input.bodyText ?? '');
  const routineNotice = ROUTINE_NOTICE_EXCLUSIONS.find(
    (exclusion) =>
      exclusion.senderPattern.test(input.fromAddress?.trim() ?? '') &&
      exclusion.subjectPattern.test(input.subject?.trim() ?? '') &&
      (exclusion.humanOrigin !== true ||
        humanOriginNoticeSuppressed({ plainBody, hasAttachments: input.hasAttachments })),
  );
  if (routineNotice) {
    return { kind: 'system', source: routineNotice.source, reason: `routine_notice:${routineNotice.id}` };
  }
  const senderDomain = extractDomain(input.fromAddress);
  const senderMatch = ruleForDomain(senderDomain);
  if (senderMatch) {
    const exemption = directExemption(senderMatch.rule, input.subject, {
      fromAddress: input.fromAddress,
      bodyText: input.bodyText,
      hasAttachments: input.hasAttachments,
    });
    if (exemption) return exemption;
    return matchedSource(senderMatch.rule, `sender_domain:${senderMatch.registeredDomain}`);
  }

  return {
    kind: 'direct',
    source: null,
    reason: 'no_matching_sender',
  };
}

/**
 * Canonical body for source admission at every gate (ingest, live admission,
 * arrival, pane): the plain-text body when present, else the HTML body reduced
 * to text. An empty or whitespace-only text body never hides a real HTML body.
 */
export function canonicalSourceBodyText(input: {
  textBody?: string | null;
  htmlBody?: string | null;
}): string {
  if (input.textBody?.trim()) return input.textBody;
  return input.htmlBody ? plainTextBody(input.htmlBody) : '';
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
