type OtaSource = {
  label: string;
  domain: string;
  /** The OTA's name as it appears in mail text, never as part of another domain. */
  name: string;
};

const OTA_SOURCES: readonly OtaSource[] = [
  { label: 'Booking.com', domain: 'booking.com', name: String.raw`booking\s*\.?\s*com` },
  { label: 'Expedia', domain: 'expedia.com', name: String.raw`expedia(?:\.com)?` },
  { label: 'Hotels.com', domain: 'hotels.com', name: String.raw`hotels\.com` },
  { label: 'Agoda', domain: 'agoda.com', name: String.raw`agoda(?:\.com)?` },
  { label: 'Trip.com', domain: 'trip.com', name: String.raw`trip\.com` },
  { label: 'Traveloka', domain: 'traveloka.com', name: String.raw`traveloka(?:\.com)?` },
  { label: 'Airbnb', domain: 'airbnb.com', name: String.raw`airbnb(?:\.com)?` },
];

function senderUsesDomain(senderEmail: string, domain: string): boolean {
  const senderDomain = /@([a-z0-9.-]+)/i.exec(senderEmail)?.[1]?.replace(/\.+$/, '').toLowerCase();
  return senderDomain === domain || Boolean(senderDomain?.endsWith(`.${domain}`));
}

// Only channel phrases count in text: "booked via Booking.com", "Booking.com reservation number". A guest who says they
// saw a rate on an OTA, or a link to another site ending in the same letters, is not an OTA booking.
function channelPhrase(name: string): RegExp {
  const bounded = String.raw`(?<![\w.-])(?:${name})(?![\w-])`;
  return new RegExp(
    String.raw`(?:\b(?:book(?:ed|ing)|made|reserved)\s+(?:via|through|on|with)\s+${bounded})|(?:${bounded}\s+(?:reservation|booking)\s*(?:confirmation|number|no\.?|id|#|:))`,
    'i',
  );
}

/** A read-only label from the sender's domain, or an explicit OTA booking phrase in the email text. */
export function otaBookingChannel(input: {
  senderEmail?: string | null;
  subject?: string | null;
  bodyText?: string | null;
}): string | null {
  const sender = input.senderEmail?.trim() ?? '';
  const bySender = OTA_SOURCES.find((source) => senderUsesDomain(sender, source.domain));
  if (bySender) return bySender.label;
  const content = `${input.subject ?? ''}\n${input.bodyText ?? ''}`;
  return OTA_SOURCES.find((source) => channelPhrase(source.name).test(content))?.label ?? null;
}
