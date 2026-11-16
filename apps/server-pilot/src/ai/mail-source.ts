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
  | 'forwardedSubjectPatterns'
  | 'directSubjectPatterns'
  | 'skipSubjectPatterns'
  | 'senderPatterns'
  | 'skipBodyPatterns'
  | 'exactHost'
  | 'requiresNoAttachments'
  | 'directWhenForwarded'
> & {
  exactHost?: boolean;
  forwardedSubjectPatterns?: readonly RegExp[];
  directSubjectPatterns?: readonly RegExp[];
  skipSubjectPatterns?: readonly RegExp[];
  senderPatterns?: readonly RegExp[];
  skipBodyPatterns?: readonly RegExp[];
  requiresNoAttachments?: boolean;
  directWhenForwarded?: boolean;
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
    ...(rule.exactHost === undefined ? {} : { exactHost: rule.exactHost }),
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
    ...(rule.senderPatterns === undefined ? {} : { senderPatterns: compilePatterns(rule.senderPatterns) }),
    ...(rule.skipBodyPatterns === undefined
      ? {}
      : { skipBodyPatterns: compilePatterns(rule.skipBodyPatterns) }),
    ...(rule.requiresNoAttachments === undefined ? {} : { requiresNoAttachments: rule.requiresNoAttachments }),
    ...(rule.directWhenForwarded === undefined ? {} : { directWhenForwarded: rule.directWhenForwarded }),
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

const INTERNAL_FORWARD_DOMAINS = ['legacyhotels.co.za'] as const;
const FORWARD_SUBJECT_PREFIX = /^(?:(?:fw|fwd|forwarded)\s*:\s*)+/i;
const ENVELOPE_SUBJECT_PREFIX = /^(?:(?:re|fw|fwd|forwarded)\s*:\s*)+/i;
const FORWARDED_HEADER_LINE = /^\s*(?:>\s*)*(?:from|sender)\s*:\s*(.*?)\s*$/i;
const FORWARDED_SUBJECT_LINE = /^\s*(?:>\s*)*subject\s*:\s*(.*?)\s*$/i;
/** Header lines after the forwarded From line that may hold its Subject (Sent, To, Cc, Subject). */
const FORWARD_SUBJECT_LOOKAHEAD_LINES = 6;
const QUOTED_TEXT_LINE = /^\s*>/;
const FORWARD_SEPARATOR_LINE =
  /^\s*(?:-{2,}\s*(?:forwarded|original)\s+message\s*-{2,}\s*|begin\s+forwarded\s+message\s*:?\s*|forwarded\s+message\s*:?\s*)$/i;
const REPLY_INTRO_LINE = /^\s*on\s.+?\bwrote\s*:\s*$/i;
const ENVELOPE_FIELD_LINE = /^\s*(?:from|sender|sent|to|cc|bcc|date|subject)\s*:/i;
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

function isInternalForwardSender(domain: string): boolean {
  return INTERNAL_FORWARD_DOMAINS.some((registeredDomain) => domainMatches(domain, registeredDomain));
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
  subjects: readonly (string | null | undefined)[],
  evidence: { fromAddress?: string | null; bodyText?: string | null; hasAttachments?: boolean },
): MailSourceClassification | null {
  const matches = (patterns: readonly RegExp[] | undefined) =>
    subjects.some((subject) => patterns?.some((pattern) => pattern.test(subject ?? '')));
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

/** Lines the forwarding staff member could have authored: no quotes, forward markers, reply intros or embedded envelope fields. */
function authoredForwardLines(lines: readonly string[]): string {
  return lines
    .filter(
      (line) =>
        line.trim() !== '' &&
        !QUOTED_TEXT_LINE.test(line) &&
        !FORWARD_SEPARATOR_LINE.test(line) &&
        !REPLY_INTRO_LINE.test(line) &&
        !ENVELOPE_FIELD_LINE.test(line),
    )
    .join('\n')
    .trim();
}

/**
 * Text authored ahead of the forwarded content. Without an anchor From line,
 * forwarded prose would be indistinguishable from authored text, so only the
 * region before the first forward marker or embedded header counts.
 */
function forwardedSubjectAuthoredText(bodyLines: readonly string[]): string {
  const contentStart = bodyLines.findIndex(
    (line) =>
      FORWARD_SEPARATOR_LINE.test(line) || FORWARDED_HEADER_LINE.test(line) || REPLY_INTRO_LINE.test(line),
  );
  return authoredForwardLines(contentStart < 0 ? bodyLines : bodyLines.slice(0, contentStart));
}

/** The first embedded forwarded header block (From/Sender line plus its lookahead Subject). */
function forwardedHeaderBlock(
  lines: readonly string[],
): { index: number; domain: string; subject: string | null } | null {
  for (const [index, line] of lines.entries()) {
    const header = FORWARDED_HEADER_LINE.exec(line);
    if (!header) continue;
    // HTML forwards put blank lines between header fields, so only non-blank lines count toward the lookahead.
    const subjectLine = lines
      .slice(index + 1)
      .filter((candidate) => candidate.trim() !== '')
      .slice(0, FORWARD_SUBJECT_LOOKAHEAD_LINES)
      .map((candidate) => FORWARDED_SUBJECT_LINE.exec(candidate)?.[1])
      .find((subject) => subject !== undefined);
    return { index, domain: extractDomain(header[1]), subject: subjectLine ?? null };
  }
  return null;
}

function originalForwardSender(
  bodyText: string,
): { rule: MailSourceRule; domain: string; subject: string | null; authoredText: string } | null {
  const lines = bodyText.slice(0, MAX_FORWARD_HEADER_CHARS).split(/\r?\n/);
  const block = forwardedHeaderBlock(lines);
  if (!block) return null;
  const match = ruleForDomain(block.domain);
  if (!match) return null;
  return {
    rule: match.rule,
    domain: match.registeredDomain,
    subject: block.subject,
    authoredText: authoredForwardLines(lines.slice(0, block.index)),
  };
}

/**
 * A human-origin routine notice is suppressed only by an unannotated re-send:
 * a bare template subject is a system send, but a Re:/Fwd: envelope may carry
 * a current staff ask. It stays a notice only while nothing was authored ahead
 * of the forwarded content and the staff subject restates the embedded one.
 */
function humanOriginNoticeSuppressed(input: {
  subject?: string | null;
  /** Body already reduced to plain text by the caller. */
  plainBody: string;
}): boolean {
  const subject = input.subject?.trim() ?? '';
  const prefix = ENVELOPE_SUBJECT_PREFIX.exec(subject);
  if (!prefix) return true;
  const lines = input.plainBody.slice(0, MAX_FORWARD_HEADER_CHARS).split(/\r?\n/);
  if (forwardedSubjectAuthoredText(lines)) return false;
  const inner = forwardedHeaderBlock(lines)?.subject?.trim();
  return inner !== undefined && inner !== null && subject.slice(prefix[0].length).trim() === inner;
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
  /** Whether the message carries at least one non-inline attachment; undefined means unknown. */
  hasAttachments?: boolean;
}): MailSourceClassification {
  const plainBody = plainTextBody(input.bodyText ?? '');
  const routineNotice = ROUTINE_NOTICE_EXCLUSIONS.find(
    (exclusion) =>
      exclusion.senderPattern.test(input.fromAddress?.trim() ?? '') &&
      exclusion.subjectPattern.test(input.subject?.trim() ?? '') &&
      (exclusion.humanOrigin !== true || humanOriginNoticeSuppressed({ subject: input.subject, plainBody })),
  );
  if (routineNotice) {
    return { kind: 'system', source: routineNotice.source, reason: `routine_notice:${routineNotice.id}` };
  }
  const senderDomain = extractDomain(input.fromAddress);
  const senderMatch = ruleForDomain(senderDomain);
  if (senderMatch) {
    const exemption = directExemption(senderMatch.rule, [input.subject], {
      fromAddress: input.fromAddress,
      bodyText: input.bodyText,
      hasAttachments: input.hasAttachments,
    });
    if (exemption) return exemption;
    return matchedSource(senderMatch.rule, `sender_domain:${senderMatch.registeredDomain}`);
  }

  if (isInternalForwardSender(senderDomain)) {
    const forwardedSender = originalForwardSender(plainBody);
    if (forwardedSender) {
      // Fresh authored content above the forward keeps the message reviewable;
      // only an empty preamble is a clearly notice-only envelope.
      if (forwardedSender.authoredText) {
        return { kind: 'direct', source: null, reason: `forwarded_authored_content:${forwardedSender.rule.id}` };
      }
      if (forwardedSender.rule.directWhenForwarded) {
        return { kind: 'direct', source: null, reason: `forwarded_skip_exempt:${forwardedSender.rule.id}` };
      }
      const exemption = directExemption(forwardedSender.rule, [input.subject, forwardedSender.subject], {
        fromAddress: input.fromAddress,
        bodyText: input.bodyText,
        hasAttachments: input.hasAttachments,
      });
      if (exemption) return exemption;
      return matchedSource(forwardedSender.rule, `forwarded_sender:${forwardedSender.domain}`);
    }

    const originalSubject = forwardedSubject(input.subject ?? '');
    if (originalSubject) {
      for (const rule of MAIL_SOURCE_RULES) {
        if (rule.forwardedSubjectPatterns?.some((pattern) => pattern.test(originalSubject))) {
          const authoredText = forwardedSubjectAuthoredText(plainBody.split(/\r?\n/));
          if (authoredText) {
            return { kind: 'direct', source: null, reason: `forwarded_authored_content:${rule.id}` };
          }
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
