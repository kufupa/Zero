/**
 * Layer B conversation signal detector — port of
 * `.private/connected-mailbox-corpus/follow-up/_work/defensible-daily-chart-2026-09-01.py`
 * index builders from `staff-email-brief-analysis-2026-09-01.py`.
 */

export type ConversationSignal =
  | 'in_thread_outbound'
  | 'cross_thread_conf'
  | 'orphan_auto_confirm'
  | 'orphan_centurion_human'
  | 'quoted_hotel_header'
  | 'quoted_hotel_phrase';

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
};

export type ConversationMessage = IndexableMessage & {
  bodyText: string;
};

const INTERNAL_DOMAINS = [
  'legacyhotels',
  'navaai',
  'synxis',
  'reservecloud',
  'fortimail',
] as const;

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

function emailParts(addr: string): [local: string, domain: string] {
  const trimmed = addr.trim().toLowerCase();
  const match = /<?([^<>\s]+@[^>\s]+)>?/.exec(trimmed);
  const email = match?.[1] ?? trimmed;
  if (!email.includes('@')) return ['', email];
  const at = email.lastIndexOf('@');
  return [email.slice(0, at), email.slice(at + 1)];
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
  if (
    ['booking.com', 'expedia', 'guestrevu', 'fortimail'].some((hint) => toLower.includes(hint))
  ) {
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
    if (auto.day && triggerDay && auto.day < triggerDay) {
      continue;
    }
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
    const bucket = responderBucket(
      message.from,
      message.subject,
      message.to,
      message.direction,
    );
    if (bucket) {
      signals.push('in_thread_outbound');
      break;
    }
  }

  const threadText = messages
    .map((message) => `${message.subject}\n${message.bodyText}`)
    .join('\n');

  if (crossThreadMatched(threadText, triggerDay, autoConfirmIndex)) {
    signals.push('cross_thread_conf');
  }

  if (QUOTED_FROM_HOTEL_RE.test(threadText)) {
    signals.push('quoted_hotel_header');
  } else if (HOTEL_REPLY_PHRASE_RE.test(threadText)) {
    signals.push('quoted_hotel_phrase');
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
        signals.push('orphan_auto_confirm');
        break;
      }
      if (frm.includes('centurion@') && !orphan.isAuto) {
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
