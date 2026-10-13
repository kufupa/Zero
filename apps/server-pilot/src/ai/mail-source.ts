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

type MailSourceRule = {
  id: string;
  kind: Exclude<MailSourceKind, 'direct'>;
  source: string;
  domains: readonly string[];
  forwardedSubjectPatterns?: readonly RegExp[];
  otaChip?: boolean;
  bookingPhrase?: string;
};

/**
 * One registry for automated mail we do not handle as reservationist work. Add source domains and, when appropriate,
 * a forwarded-subject pattern here; both the server and the pane import this browser-safe module.
 */
export const MAIL_SOURCE_RULES: readonly MailSourceRule[] = [
  {
    id: 'synxis',
    kind: 'channel',
    source: 'SynXis',
    domains: ['synxis.com'],
    forwardedSubjectPatterns: [/^synxis\s+res(?:ervation)?\s+confirmed\b/i],
    otaChip: true,
  },
  {
    id: 'expedia-partner-central',
    kind: 'channel',
    source: 'Expedia Partner Central',
    domains: ['m.expediapartnercentral.com', 'expediapartnercentral.com'],
    forwardedSubjectPatterns: [/^(?:expedia\s+partner\s+central\b|new\s+(?:booking|reservation)\s+from\s+expedia\b)/i],
    otaChip: true,
  },
  {
    id: 'expedia',
    kind: 'channel',
    source: 'Expedia',
    domains: ['expedia.com'],
    forwardedSubjectPatterns: [/^expedia(?:\.com)?\s+(?:booking|reservation)\b/i],
    otaChip: true,
    bookingPhrase: String.raw`expedia(?:\.com)?`,
  },
  {
    id: 'webbeds',
    kind: 'channel',
    source: 'WebBeds',
    domains: ['webbeds.com'],
    forwardedSubjectPatterns: [/^webbeds\b/i],
    otaChip: true,
  },
  {
    id: 'hotelbeds',
    kind: 'channel',
    source: 'Hotelbeds',
    domains: ['hotelbeds.com'],
    forwardedSubjectPatterns: [/^hotelbeds\b/i],
    otaChip: true,
  },
  {
    id: 'booking-com',
    kind: 'channel',
    source: 'Booking.com',
    domains: ['booking.com'],
    forwardedSubjectPatterns: [/^booking\.com\b/i],
    otaChip: true,
    bookingPhrase: String.raw`booking\s*\.?\s*com`,
  },
  {
    id: 'get-e',
    kind: 'channel',
    source: 'Get-e',
    domains: ['get-e.com'],
    forwardedSubjectPatterns: [/^get-e\b/i],
    otaChip: true,
  },
  {
    id: 'hotels-com',
    kind: 'channel',
    source: 'Hotels.com',
    domains: ['hotels.com'],
    forwardedSubjectPatterns: [/^hotels\.com\b/i],
    otaChip: true,
    bookingPhrase: String.raw`hotels\.com`,
  },
  {
    id: 'agoda',
    kind: 'channel',
    source: 'Agoda',
    domains: ['agoda.com'],
    forwardedSubjectPatterns: [/^agoda\b/i],
    otaChip: true,
    bookingPhrase: String.raw`agoda(?:\.com)?`,
  },
  {
    id: 'trip-com',
    kind: 'channel',
    source: 'Trip.com',
    domains: ['trip.com'],
    forwardedSubjectPatterns: [/^trip\.com\b/i],
    otaChip: true,
    bookingPhrase: String.raw`trip\.com`,
  },
  {
    id: 'traveloka',
    kind: 'channel',
    source: 'Traveloka',
    domains: ['traveloka.com'],
    forwardedSubjectPatterns: [/^traveloka\b/i],
    otaChip: true,
    bookingPhrase: String.raw`traveloka(?:\.com)?`,
  },
  {
    id: 'airbnb',
    kind: 'channel',
    source: 'Airbnb',
    domains: ['airbnb.com'],
    forwardedSubjectPatterns: [/^airbnb\b/i],
    otaChip: true,
    bookingPhrase: String.raw`airbnb(?:\.com)?`,
  },
  {
    id: 'reviewpro',
    kind: 'system',
    source: 'ReviewPro',
    domains: ['reviewpro.com'],
    forwardedSubjectPatterns: [/^reviewpro\b/i],
  },
  {
    id: 'trustyou',
    kind: 'system',
    source: 'TrustYou',
    domains: ['trustyou.com'],
    forwardedSubjectPatterns: [/^trustyou\b/i],
  },
  {
    id: 'revinate',
    kind: 'system',
    source: 'Revinate',
    domains: ['revinate.com'],
    forwardedSubjectPatterns: [/^revinate\b/i],
  },
  {
    id: 'medallia',
    kind: 'system',
    source: 'Medallia',
    domains: ['medallia.com'],
    forwardedSubjectPatterns: [/^medallia\b/i],
  },
  {
    id: 'tripadvisor',
    kind: 'system',
    source: 'Tripadvisor',
    domains: ['tripadvisor.com'],
    forwardedSubjectPatterns: [/^tripadvisor\b/i],
  },
] as const;

const INTERNAL_FORWARD_DOMAINS = ['legacyhotels.co.za'] as const;
const FORWARD_SUBJECT_PREFIX = /^(?:(?:fw|fwd|forwarded)\s*:\s*)+/i;
const FORWARDED_HEADER_LINE = /^\s*(?:>\s*)*(?:from|sender)\s*:\s*(.*?)\s*$/i;
const EMAIL_ADDRESS = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z0-9-]{2,63}/i;
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

function originalForwardSender(bodyText: string): { rule: MailSourceRule; domain: string } | null {
  const firstPart = bodyText.slice(0, MAX_FORWARD_HEADER_CHARS);
  for (const line of firstPart.split(/\r?\n/)) {
    const header = FORWARDED_HEADER_LINE.exec(line);
    if (!header?.[1]) continue;
    const domain = extractDomain(header[1]);
    const match = ruleForDomain(domain);
    if (match) return { rule: match.rule, domain: match.registeredDomain };
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
    return matchedSource(senderMatch.rule, `sender_domain:${senderMatch.registeredDomain}`);
  }

  if (isInternalForwardSender(senderDomain)) {
    const forwardedSender = originalForwardSender(input.bodyText ?? '');
    if (forwardedSender) {
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
