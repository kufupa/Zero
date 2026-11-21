import type { ThreadInput } from './schema.js';

type Email = ThreadInput['messages'][number];

const preStayFields = new Set([
  'address', 'postal code', 'city', 'country', 'nationality', 'passport', 'date of birth',
  'mobile', 'email', 'arrival time', 'transfer', 'lifestyle member', 'email marketing opt-in',
]);

function isRoutinePreStay(body: string): boolean {
  const [guest, arrival, departure, room, confirmation, ...fields] = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!guest || !/^Arrival\s*:\s*\d/i.test(arrival ?? '') || !/^Departure\s*:\s*\d/i.test(departure ?? '')
    || !/^Room Type\s*:\s*\w/i.test(room ?? '') || !/^Confirmation No\s*:\s*\w/i.test(confirmation ?? '')
    || !fields.length) return false;
  return fields.every(line => {
    const field = /^([^>]+?)\s*-->\s*(.*)$/.exec(line);
    if (!field) return false;
    const label = field[1].trim().toLowerCase();
    return preStayFields.has(label) || field[2].trim() === '';
  });
}

const otaChannelDomains = [
  'synxis.com', 'expediapartnercentral.com', 'expedia.com', 'webbeds.com', 'hotelbeds.com',
  'booking.com', 'get-e.com', 'hotels.com', 'agoda.com', 'trip.com', 'traveloka.com',
  'airbnb.com', 'tiket.com', 'travelit.co.za', 'travelit.com', 'tbo.com', 'tbohelp.zendesk.com',
];
const systemDomains = [
  'ratetiger.com', 'erevmax.com', 'erevmax.co.uk', 'erevmax.net', 'hospitality.cloud',
  'reviewpro.com', 'trustyou.com', 'revinate.com', 'medallia.com', 'tripadvisor.com', 'tvlinc.com',
];

export function mailPrefilterRule(message: Email): string | null {
  if (message.direction !== 'inbound') return null;
  const email = message.from.email.trim().toLowerCase();
  const host = /^[^@\s]+@([a-z0-9.-]+)$/.exec(email)?.[1];
  if (!host) return null;
  const from = (domain: string) => host === domain || host.endsWith('.' + domain);
  const subject = message.subject.trim();
  const ota = otaChannelDomains.find(from);
  if (ota) return `ota_channel:${ota}`;
  const sys = systemDomains.find(from);
  if (sys) return `system_notice:${sys}`;
  if (from('profitroom.com')) return /\bdefault contact form\b/i.test(subject) ? null : 'ota_channel:profitroom.com';
  if (/^fortimail-[a-z0-9-]+\.[a-z0-9.-]+$/i.test(host) && /^quarantine\s+summary\b/i.test(subject)) return 'system_notice:fortimail';
  if (email === 'calendar-notification@google.com' && /^(?:Invitation:|Declined:|Canceled event:)/i.test(subject)) return 'system_notice:google_calendar';
  if (email === 'epay-noreply@nedbank.co.za' && /^order\s+confirmation\s+from\s+nedbank\b/i.test(subject) && message.attachments.length === 0) return 'system_notice:nedbank_epay';
  if (from('legacyhotels.co.za') && /^pre[ -]stay\s*:\s*property\b/i.test(subject)
    && message.attachments.length === 0 && isRoutinePreStay(message.body_text)) return 'owner_prestay_form_only';
  if (from('grfeedback-b.com') && /\b(?:daily|weekly|monthly) summary for\b|^the centurion hotel\b/i.test(subject)) return 'corpus_guest_feedback_digest';
  return null;
}

/** Dedupe identical deliveries; never choose between conflicting versions of the same source message. */
export function uniqueMessages(messages: Email[]): Email[] {
  const byId = new Map<string, Email>();
  for (const message of messages) {
    const previous = byId.get(message.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(message)) throw new Error('MESSAGE_CONFLICT');
    if (!previous) byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at) || a.id.localeCompare(b.id));
}
