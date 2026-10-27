export type ShuttleProviderConfig = {
  provider: string;
  to: string[];
};

export type ShuttleTransferDetails = {
  serviceDate: string;
  pickupLocation: string;
  dropoffLocation: string;
  pickupTime: string;
  flight: string;
  passengers: string;
  bookingReference: string;
};

const EMAIL = /^[^\s@,<>;\x00-\x1f\x7f]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

const DETAIL_LABELS: ReadonlyArray<[keyof ShuttleTransferDetails, string]> = [
  ['serviceDate', 'Service date'],
  ['pickupLocation', 'Pickup location'],
  ['dropoffLocation', 'Drop-off location'],
  ['pickupTime', 'Pickup time'],
  ['flight', 'Flight'],
  ['passengers', 'Passengers'],
  ['bookingReference', 'Booking reference'],
];

/** Read the optional supplier settings without inventing a property-specific fallback. */
export function readShuttleProviderConfig(raw: unknown): ShuttleProviderConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as { provider?: unknown; to?: unknown };
  const provider = typeof candidate.provider === 'string' ? candidate.provider.trim() : '';
  if (!provider || provider.length > 120 || /[\u0000-\u001f\u007f]/.test(provider)) return null;
  if (!Array.isArray(candidate.to) || candidate.to.length === 0) return null;

  const to: string[] = [];
  const seen = new Set<string>();
  for (const value of candidate.to) {
    if (typeof value !== 'string') return null;
    const address = value.trim();
    if (!EMAIL.test(address)) return null;
    const key = address.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      to.push(address);
    }
  }
  return to.length ? { provider, to } : null;
}

export function buildShuttleDraftTemplate(
  config: ShuttleProviderConfig,
  details: ShuttleTransferDetails,
): { subject: string; html: string; noteText: string } {
  const rows = DETAIL_LABELS.flatMap(([key, label]) => {
    const value = details[key].trim().slice(0, 240);
    return value ? [{ label, value }] : [];
  });
  const escapeHtml = (value: string) => {
    const escaped: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return value.replace(/[&<>"']/g, (character) => escaped[character] ?? character);
  };
  const detailsHtml = rows.length
    ? `<ul>${rows.map(({ label, value }) => `<li><strong>${label}:</strong> ${escapeHtml(value)}</li>`).join('')}</ul>`
    : '<p>Transfer details to be confirmed.</p>';
  const serviceDate = details.serviceDate.trim().replace(/[\r\n]+/g, ' ').slice(0, 80);
  return {
    subject: `Shuttle request${serviceDate ? ` — ${serviceDate}` : ''}`,
    html: `<p>Good day,</p><p>Please arrange a shuttle transfer using these details:</p>${detailsHtml}<p>Kind regards</p>`,
    noteText: [`Shuttle with ${config.provider}`, ...rows.map(({ label, value }) => `${label}: ${value}`)].join('\n'),
  };
}
