/**
 * Layer B conversation signal detector — port of
 * `.private/connected-mailbox-corpus/follow-up/_work/defensible-daily-chart-2026-09-01.py`
 * index builders from `staff-email-brief-analysis-2026-09-01.py`.
 */

export type ConversationSignal =
  | 'in_thread_outbound'
  /** EOD taxonomy name; keep in_thread_outbound for existing consumers. */
  | 'in_thread'
  | 'cross_thread_conf'
  | 'orphan_auto_confirm'
  | 'orphan_centurion_human'
  | 'quoted_hotel_header'
  | 'quoted_hotel_phrase'
  | 'quoted_outlook_legacy_from'
  | 'in_reply_to_hotel_msgid'
  | 'quoted_staff_sig'
  | 'quoted_gmail_hotel'
  | 'quoted_from_centurion_date'
  | 'quoted_applemail_hotel'
  | 'staff_inbound_commercial_reply';

export type AutoConfirmRow = {
  conf: string | null;
  guestNorm: string;
  day: string;
  threadId: string;
};

export type OrphanOutboundRow = {
  guestEmail: string;
  threadId: string;
  subject: string;
  from: string;
  isAuto: boolean;
  day: string;
};

export type IndexableMessage = {
  id: string;
  threadId: string;
  direction: 'inbound' | 'outbound';
  from: string;
  to: string;
  cc?: string;
  subject: string;
  receivedAt: string;
  /** RFC headers are optional because the original triage payload predates them. */
  messageIdHeader?: string | null;
  inReplyTo?: string | null;
  references?: readonly string[] | string | null;
};

export type ConversationMessage = IndexableMessage & {
  bodyText: string;
};

const INTERNAL_DOMAINS = ['legacyhotels', 'navaai', 'synxis', 'reservecloud', 'fortimail'] as const;

const STAFF_RESPONDER_MAP: Readonly<Record<string, string>> = {
  'centurion@legacyhotels.co.za': 'centurion',
  'navaai@legacyhotels.co.za': 'navaai',
  'kdouglas@legacyhotels.co.za': 'kamala',
  'pmbobo@legacyhotels.co.za': 'penny',
  'pmbobo@eu.mail.reservecloud.com': 'penny',
  'marthamthembu@legacyhotels.co.za': 'martha',
  'isaacseabi@legacyhotels.co.za': 'isaac',
  'pmahlangu@legacyhotels.co.za': 'pmahlangu',
  'jvermaak@legacyhotels.co.za': 'jvermaak',
  'rfourie@legacyhotels.co.za': 'rfourie',
  'centurionrec@legacyhotels.co.za': 'centurion_rec',
  'centurionnight@legacyhotels.co.za': 'centurion_night',
  'hotels@legacyhotels.co.za': 'hotels_shared',
};

const SYSTEM_LOCALPART_HINTS = [
  'noreply',
  'no-reply',
  'donotreply',
  'mailer-daemon',
  'postmaster',
  'bounce',
  'notification',
  'notifications',
  'alert',
  'alerts',
  'system',
] as const;

const CHANNEL_BODY_SUBJECT = [
  'confirmation letter',
  'booking update',
  'reservation confirmation',
  'new booking',
  'cancellation',
  'modification',
  'folio',
  'invoice',
  'voucher',
  'pre-arrival',
  'guestrevu',
  'review',
  'fortimail',
  'quarantine',
  'unpaid',
  'failure notification',
  'update failure',
] as const;

const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
const CONF_RE = /n[°º]\s*(\d{6,})-1/i;
const GUEST_FROM_AUTO_RE = /confirmation letter_([^(_]+)/i;
const QUOTED_FROM_HOTEL_RE =
  /From:\s*(?:Centurion Hotel Reservations|Martha Mthembu|Isaac Seabi)\s*<(?:centurion|marthamthembu|isaacseabi)@legacyhotels/i;
const HOTEL_REPLY_PHRASE_RE =
  /please (?:find|see) attached (?:quotation|quote|proforma)|voucher well received|kindly find attached.*quotation/i;
const QUOTED_GMAIL_HOTEL_RE =
  /On .{8,120}? (?:Centurion Hotel Reservations|Martha Mthembu|Isaac Seabi|Bongi Kolanisi|[A-Z][a-z]+ [A-Z][a-z]+)\s*<\s*(?:\n\s*)?[\w.+-]+@legacyhotels\.co\.za>\s*wrote:/is;
const QUOTED_APPLEMAIL_HOTEL_RE = /On .{8,80}?[\w.+-]+@legacyhotels\.co\.za\s*wrote:/is;
const QUOTED_FROM_CENTURION_DATE_RE = /From:\s*Centurion Hotel Reservations\s*(?:\r?\n)\s*Date:/i;
const QUOTED_OUTLOOK_LEGACY_FROM_RE =
  /From:\s*(?:[^<\n]{0,80}<)?[\w.+-]+@legacyhotels\.co\.za>?[\s\S]{0,40}?Sent:/i;
const QUOTED_STAFF_SIG_RE =
  /(?:Bongi(?:we)?\s+Kolanisi|Martha\s+Mthembu|Isaac\s+Seabi)\s+(?:Reservationist|Reservations)\b/i;
const HOTEL_MSGID_RE = /@(?:legacyhotels\.co\.za|mail\.legacyhotels\.com)>?$/i;
// EOD matching is deliberately short-lived: a later auto-confirm/name overlap
// is ambiguous without a quoted hotel block, so do not carry it across a
// multi-day booking window.
const MAX_CROSS_THREAD_DAYS = 3;
const STAFF_COMMERCIAL_REPLY_RE =
  /(?:agreed (?:to )?(?:an )?industry rate|please\s+find\s+attached\s+(?:the\s+)?(?:pro\s*forma|quotation|quote|provisional\s+confirmation)|please\s+find\s+attached.{0,80}pro\s*forma|please\s+see\s+attached\s+(?:the\s+)?(?:rooming list|quotation|quote|pro\s*forma)|rates?\s+(?:are|for)\s+(?:our hotel|as follows)|kindly\s+sign\s+(?:the\s+)?quotation|thank you for (?:the |your )?booking|noted and thanks for (?:the )?update|please be advised|no[\s-]?show|settle (?:by cash|upon arrival)|airport transfers?|pleased to confirm|provisional\s+confirmation|availability (?:is dynamic|at (?:the )?centurion))/i;

function emailParts(addr: string): [local: string, domain: string] {
  const trimmed = addr.trim().toLowerCase();
  const match = /<?([^<>\s]+@[^>\s]+)>?/.exec(trimmed);
  const email = match?.[1] ?? trimmed;
  if (!email.includes('@')) return ['', email];
  const at = email.lastIndexOf('@');
  return [email.slice(0, at), email.slice(at + 1)];
}

/**
 * True when the sender is an automated mailbox staff cannot answer (noreply, notifications, bounce and the like).
 * The pane hides Insert draft for these. Separators are ignored, so no-reply and do-not-reply match too.
 */
export function isNoReplyAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const [local] = emailParts(address);
  const compact = local.replace(/[-._]/g, '');
  return SYSTEM_LOCALPART_HINTS.some((hint) => compact.includes(hint.replace(/[-._]/g, '')));
}

function emailAddr(raw: string): string {
  const [local, domain] = emailParts(raw);
  return domain ? `${local}@${domain}` : raw.trim().toLowerCase();
}

function dayFromReceived(receivedAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(receivedAt ?? '');
  return match?.[1] ?? '';
}

function normalizeGuestName(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

function extractConf(subject: string): string | null {
  const match = CONF_RE.exec(subject);
  return match?.[1] ?? null;
}

function headerTokens(value: readonly string[] | string | null | undefined): string[] {
  if (!value) return [];
  if (typeof value !== 'string') return value.flatMap((entry) => headerTokens(entry));
  return value.match(/<[^>]+>|[^\s,]+/g) ?? [];
}

function isHotelMessageId(value: string): boolean {
  const normalized = value.trim().replace(/^<+|>+$/g, '');
  return HOTEL_MSGID_RE.test(normalized);
}

function hasHotelReplyHeader(message: ConversationMessage): boolean {
  return [message.inReplyTo, ...headerTokens(message.references)].some(
    (value) => value != null && isHotelMessageId(value),
  );
}

function hasStrongQuotedHotelBlock(threadText: string): boolean {
  return (
    QUOTED_FROM_HOTEL_RE.test(threadText) ||
    QUOTED_GMAIL_HOTEL_RE.test(threadText) ||
    QUOTED_APPLEMAIL_HOTEL_RE.test(threadText) ||
    QUOTED_FROM_CENTURION_DATE_RE.test(threadText) ||
    QUOTED_OUTLOOK_LEGACY_FROM_RE.test(threadText) ||
    QUOTED_STAFF_SIG_RE.test(threadText)
  );
}

function withinDayWindow(triggerDay: string, otherDay: string): boolean {
  if (!triggerDay || !otherDay) return false;
  const trigger = Date.parse(`${triggerDay}T00:00:00Z`);
  const other = Date.parse(`${otherDay}T00:00:00Z`);
  if (!Number.isFinite(trigger) || !Number.isFinite(other)) return false;
  const deltaDays = (other - trigger) / (24 * 60 * 60 * 1000);
  return deltaDays >= 0 && deltaDays <= MAX_CROSS_THREAD_DAYS;
}

export function externalEmails(blob: string): Set<string> {
  const out = new Set<string>();
  for (const email of blob.match(EMAIL_RE) ?? []) {
    const lower = email.toLowerCase();
    if (!INTERNAL_DOMAINS.some((domain) => lower.includes(domain))) {
      out.add(lower);
    }
  }
  return out;
}

export function isAutoOutbound(subject: string, toAddrs: string): boolean {
  const subj = (subject ?? '').toLowerCase();
  const toLower = (toAddrs ?? '').toLowerCase();
  let autoSignals = 0;

  if (CHANNEL_BODY_SUBJECT.some((hint) => subj.includes(hint))) {
    autoSignals += 1;
  }
  if (
    ['confirmation letter', 'booking update', 'daily summary', 'notification'].some((hint) =>
      subj.includes(hint),
    )
  ) {
    autoSignals += 1;
  }
  if (['booking.com', 'expedia', 'guestrevu', 'fortimail'].some((hint) => toLower.includes(hint))) {
    autoSignals += 1;
  }

  return (
    autoSignals >= 2 ||
    (autoSignals === 1 &&
      ['confirmation letter', 'booking update', 'notification'].some((hint) => subj.includes(hint)))
  );
}

function responderBucket(
  fromAddr: string,
  subject: string,
  toAddr: string,
  direction: string,
): string | null {
  const addr = emailAddr(fromAddr);
  const mapped = STAFF_RESPONDER_MAP[addr];
  if (mapped) {
    if ((mapped === 'centurion' || mapped === 'navaai') && direction === 'outbound') {
      return isAutoOutbound(subject, toAddr) ? 'centurion_auto' : 'centurion_human';
    }
    return mapped;
  }

  const [local, domain] = emailParts(fromAddr);
  if (domain === 'legacyhotels.co.za' && local !== 'mail' && local !== 'postmaster') {
    if (SYSTEM_LOCALPART_HINTS.some((hint) => local.includes(hint))) {
      return null;
    }
    return `staff:${local}`;
  }

  if (addr.includes('pmbobo') && addr.includes('reservecloud')) {
    return 'penny';
  }

  return null;
}

function crossThreadMatched(
  threadText: string,
  triggerDay: string,
  autoIndex: readonly AutoConfirmRow[],
): boolean {
  const confMatches = new Set<string>();
  const confRe = new RegExp(CONF_RE.source, 'gi');
  for (const match of threadText.matchAll(confRe)) {
    if (match[1]) confMatches.add(match[1]);
  }

  const norm = threadText.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const auto of autoIndex) {
    if (!withinDayWindow(triggerDay, auto.day)) continue;
    if (auto.conf && confMatches.has(auto.conf)) {
      return true;
    }
    if (auto.guestNorm.length > 4 && norm.includes(auto.guestNorm)) {
      return true;
    }
  }

  return false;
}

export function buildAutoConfirmIndex(
  messages: readonly IndexableMessage[],
): readonly AutoConfirmRow[] {
  const auto: AutoConfirmRow[] = [];

  for (const message of messages) {
    if (message.direction !== 'outbound') continue;
    if (!isAutoOutbound(message.subject, message.to)) continue;

    const conf = extractConf(message.subject);
    const guestMatch = GUEST_FROM_AUTO_RE.exec(message.subject);
    const guestNorm = guestMatch ? normalizeGuestName(guestMatch[1]!) : '';
    const day = dayFromReceived(message.receivedAt);
    if (!day) continue;

    auto.push({
      conf,
      guestNorm,
      day,
      threadId: message.threadId,
    });
  }

  return auto;
}

export function buildOrphanOutboundIndex(
  messages: readonly IndexableMessage[],
): ReadonlyMap<string, readonly OrphanOutboundRow[]> {
  const index = new Map<string, OrphanOutboundRow[]>();

  for (const message of messages) {
    if (message.direction !== 'outbound') continue;

    const addressBlob = `${message.to} ${message.cc ?? ''}`;
    for (const guestEmail of externalEmails(addressBlob)) {
      const row: OrphanOutboundRow = {
        guestEmail,
        threadId: message.threadId,
        subject: message.subject,
        from: message.from,
        isAuto: isAutoOutbound(message.subject, message.to),
        day: dayFromReceived(message.receivedAt),
      };
      const existing = index.get(guestEmail) ?? [];
      existing.push(row);
      index.set(guestEmail, existing);
    }
  }

  return index;
}

export function detectConversationSignals(input: {
  threadId: string;
  triggerMessageId: string;
  messages: readonly ConversationMessage[];
  autoConfirmIndex: readonly AutoConfirmRow[];
  orphanByGuest: ReadonlyMap<string, readonly OrphanOutboundRow[]>;
}): ConversationSignal[] {
  const { threadId, triggerMessageId, messages, autoConfirmIndex, orphanByGuest } = input;
  const triggerIdx = messages.findIndex((message) => message.id === triggerMessageId);
  if (triggerIdx < 0) return [];

  const signals: ConversationSignal[] = [];
  const outbound = messages.filter((message) => message.direction === 'outbound');
  const after = messages.slice(triggerIdx + 1);
  const trigger = messages[triggerIdx]!;
  const triggerDay = dayFromReceived(trigger.receivedAt);

  for (const message of [...after, ...outbound]) {
    if (message.direction !== 'outbound') continue;
    const bucket = responderBucket(message.from, message.subject, message.to, message.direction);
    if (bucket) {
      signals.push('in_thread_outbound');
      signals.push('in_thread');
      break;
    }
  }

  const threadText = messages
    .map((message) => `${message.subject}\n${message.bodyText}`)
    .join('\n');

  if (crossThreadMatched(threadText, triggerDay, autoConfirmIndex)) {
    signals.push('cross_thread_conf');
  }

  const strongQuotedHotelBlock = hasStrongQuotedHotelBlock(threadText);
  if (QUOTED_FROM_HOTEL_RE.test(threadText)) {
    signals.push('quoted_hotel_header');
  }
  if (QUOTED_GMAIL_HOTEL_RE.test(threadText)) {
    signals.push('quoted_gmail_hotel');
  }
  if (QUOTED_APPLEMAIL_HOTEL_RE.test(threadText)) {
    signals.push('quoted_applemail_hotel');
  }
  if (QUOTED_FROM_CENTURION_DATE_RE.test(threadText)) {
    signals.push('quoted_from_centurion_date');
  }
  if (QUOTED_OUTLOOK_LEGACY_FROM_RE.test(threadText)) {
    signals.push('quoted_outlook_legacy_from');
  }
  if (HOTEL_REPLY_PHRASE_RE.test(threadText)) {
    signals.push('quoted_hotel_phrase');
  }
  if (QUOTED_STAFF_SIG_RE.test(threadText)) {
    signals.push('quoted_staff_sig');
  }

  // A staff commercial reply only answers the actionable trigger when it
  // occurs after that trigger in the causal message order.
  for (const message of after) {
    if (message.direction !== 'inbound') continue;
    const from = message.from.toLowerCase();
    if (!from.includes('@legacyhotels.co.za')) continue;
    if (!responderBucket(message.from, message.subject, message.to, message.direction)) {
      continue;
    }
    if (
      ['noreply', 'mailer', 'guestrevu', 'scans@', 'hotels@', 'donotreply'].some((hint) =>
        from.includes(hint),
      )
    ) {
      continue;
    }
    if (STAFF_COMMERCIAL_REPLY_RE.test(message.bodyText ?? '')) {
      signals.push('staff_inbound_commercial_reply');
      break;
    }
  }

  // The trigger itself may be the guest reply carrying the hotel RFC header;
  // later causal messages are also eligible in offline replay.
  for (const message of messages.slice(triggerIdx)) {
    if (message.direction !== 'inbound') continue;
    if (hasHotelReplyHeader(message)) {
      signals.push('in_reply_to_hotel_msgid');
      break;
    }
  }

  const guestEmails = new Set<string>();
  for (const message of messages.slice(0, triggerIdx + 1)) {
    if (message.direction === 'inbound') {
      for (const email of externalEmails(message.from)) {
        guestEmails.add(email);
      }
    }
  }

  for (const guestEmail of guestEmails) {
    const orphans = orphanByGuest.get(guestEmail) ?? [];
    for (const orphan of orphans) {
      if (orphan.threadId === threadId) continue;

      const subj = orphan.subject.toLowerCase();
      const frm = orphan.from.toLowerCase();

      if (subj.includes('confirmation letter')) {
        const orphanConf = extractConf(orphan.subject);
        const orphanGuestMatch = GUEST_FROM_AUTO_RE.exec(orphan.subject);
        const orphanGuestNorm = orphanGuestMatch ? normalizeGuestName(orphanGuestMatch[1]!) : '';
        const confMatches = new Set<string>();
        for (const match of threadText.matchAll(new RegExp(CONF_RE.source, 'gi'))) {
          if (match[1]) confMatches.add(match[1]);
        }
        const norm = threadText.toLowerCase().replace(/[^a-z0-9]/g, '');
        const hasStrongIdentity =
          (orphanConf !== null && confMatches.has(orphanConf)) ||
          (orphanGuestNorm.length >= 5 && norm.includes(orphanGuestNorm));
        if (
          withinDayWindow(triggerDay, orphan.day) &&
          (hasStrongIdentity || strongQuotedHotelBlock)
        ) {
          signals.push('orphan_auto_confirm');
          break;
        }
      }
      // Transport-wide human replies are only causal evidence when they are
      // recent relative to this trigger. Guest-email indexing is the request
      // identity; the short forward window prevents stale history leakage.
      if (frm.includes('centurion@') && !orphan.isAuto && withinDayWindow(triggerDay, orphan.day)) {
        signals.push('orphan_centurion_human');
        break;
      }
    }
    if (signals.some((signal) => signal.startsWith('orphan_'))) {
      break;
    }
  }

  return [...new Set(signals)].sort();
}

export function isConversationResponded(signals: readonly ConversationSignal[]): boolean {
  return signals.length > 0;
}
