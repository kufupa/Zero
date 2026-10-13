type OtaSource = {
  label: string;
  domain: string;
  mention: RegExp;
};

const OTA_SOURCES: readonly OtaSource[] = [
  { label: 'Booking.com', domain: 'booking.com', mention: /\bbooking\s*\.?\s*com\b/i },
  { label: 'Expedia', domain: 'expedia.com', mention: /\bexpedia(?:\.com)?\b/i },
  { label: 'Hotels.com', domain: 'hotels.com', mention: /\bhotels\.com\b/i },
  { label: 'Agoda', domain: 'agoda.com', mention: /\bagoda(?:\.com)?\b/i },
  { label: 'Trip.com', domain: 'trip.com', mention: /\btrip\.com\b/i },
  { label: 'Traveloka', domain: 'traveloka.com', mention: /\btraveloka(?:\.com)?\b/i },
  { label: 'Airbnb', domain: 'airbnb.com', mention: /\bairbnb(?:\.com)?\b/i },
];

function senderUsesDomain(senderEmail: string, domain: string): boolean {
  const senderDomain = /@([a-z0-9.-]+)/i.exec(senderEmail)?.[1]?.replace(/\.+$/, '').toLowerCase();
  return senderDomain === domain || Boolean(senderDomain?.endsWith(`.${domain}`));
}

/** A read-only label from the sender's domain or an explicit OTA name in the email text. */
export function otaBookingChannel(input: {
  senderEmail?: string | null;
  subject?: string | null;
  bodyText?: string | null;
}): string | null {
  const sender = input.senderEmail?.trim() ?? '';
  const content = `${input.subject ?? ''}\n${input.bodyText ?? ''}`;
  for (const source of OTA_SOURCES) {
    if (senderUsesDomain(sender, source.domain) || source.mention.test(content)) return source.label;
  }
  return null;
}
