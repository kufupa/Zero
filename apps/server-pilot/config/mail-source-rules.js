/** Plain source data shared by server and mail; regexes stay serializable until compiled by mail-source.ts. */
export const MAIL_SOURCE_RULE_DATA = [
  {
    id: 'synxis',
    kind: 'channel',
    source: 'SynXis',
    domains: ['synxis.com'],
    otaChip: true,
  },
  {
    id: 'expedia-partner-central',
    kind: 'channel',
    source: 'Expedia Partner Central',
    domains: ['m.expediapartnercentral.com', 'expediapartnercentral.com'],
    otaChip: true,
  },
  {
    id: 'expedia',
    kind: 'channel',
    source: 'Expedia',
    domains: ['expedia.com'],
    otaChip: true,
    bookingPhrase: 'expedia(?:\\.com)?',
  },
  {
    id: 'webbeds',
    kind: 'channel',
    source: 'WebBeds',
    domains: ['webbeds.com'],
    otaChip: true,
  },
  {
    id: 'hotelbeds',
    kind: 'channel',
    source: 'Hotelbeds',
    domains: ['hotelbeds.com'],
    otaChip: true,
  },
  {
    id: 'booking-com',
    kind: 'channel',
    source: 'Booking.com',
    domains: ['booking.com'],
    otaChip: true,
    bookingPhrase: 'booking\\s*\\.?\\s*com',
  },
  {
    id: 'get-e',
    kind: 'channel',
    source: 'Get-e',
    domains: ['get-e.com'],
    otaChip: true,
  },
  {
    id: 'hotels-com',
    kind: 'channel',
    source: 'Hotels.com',
    domains: ['hotels.com'],
    otaChip: true,
    bookingPhrase: 'hotels\\.com',
  },
  {
    id: 'agoda',
    kind: 'channel',
    source: 'Agoda',
    domains: ['agoda.com'],
    otaChip: true,
    bookingPhrase: 'agoda(?:\\.com)?',
  },
  {
    id: 'trip-com',
    kind: 'channel',
    source: 'Trip.com',
    domains: ['trip.com'],
    otaChip: true,
    bookingPhrase: 'trip\\.com',
  },
  {
    id: 'traveloka',
    kind: 'channel',
    source: 'Traveloka',
    domains: ['traveloka.com'],
    otaChip: true,
    bookingPhrase: 'traveloka(?:\\.com)?',
  },
  {
    id: 'airbnb',
    kind: 'channel',
    source: 'Airbnb',
    domains: ['airbnb.com'],
    otaChip: true,
    bookingPhrase: 'airbnb(?:\\.com)?',
  },
  {
    id: 'tiket-com',
    kind: 'channel',
    source: 'Tiket.com',
    domains: ['tiket.com'],
    exactHost: true,
    otaChip: true,
    bookingPhrase: 'tiket(?:\\.com)?',
  },
  {
    id: 'profitroom',
    kind: 'channel',
    source: 'Profitroom',
    domains: ['profitroom.com'],
    exactHost: true,
  },
  {
    id: 'nedbank-epay',
    kind: 'system',
    source: 'Nedbank e-pay',
    domains: ['nedbank.co.za'],
    exactHost: true,
    senderPatterns: [{ source: '\\bepay-noreply@nedbank\\.co\\.za\\b', flags: 'i' }],
    skipSubjectPatterns: [{ source: '^order\\s+confirmation\\s+from\\s+nedbank\\b', flags: 'i' }],
    skipBodyPatterns: [
      { source: '\\bmerchant\\s+reference\\b', flags: 'i' },
      { source: '\\bsale\\b', flags: 'i' },
    ],
    requiresNoAttachments: true,
  },
  {
    id: 'ratetiger',
    kind: 'system',
    source: 'RateTiger',
    domains: ['ratetiger.com'],
    exactHost: true,
  },
  {
    id: 'h-pay',
    kind: 'system',
    source: 'H-Pay',
    domains: ['hospitality.cloud'],
    exactHost: true,
  },
  {
    id: 'reviewpro',
    kind: 'system',
    source: 'ReviewPro',
    domains: ['reviewpro.com'],
  },
  {
    id: 'trustyou',
    kind: 'system',
    source: 'TrustYou',
    domains: ['trustyou.com'],
  },
  {
    id: 'revinate',
    kind: 'system',
    source: 'Revinate',
    domains: ['revinate.com'],
  },
  {
    id: 'medallia',
    kind: 'system',
    source: 'Medallia',
    domains: ['medallia.com'],
  },
  {
    id: 'tripadvisor',
    kind: 'system',
    source: 'Tripadvisor',
    domains: ['tripadvisor.com'],
  },
];

/**
 * Exact routine-notice exclusions shared by every intake path: an internal
 * handover or automated digest whose sender and subject both match exactly.
 * Anchored senders keep human forwards (Fwd:/Re: prefixed subjects do not
 * match) staff-visible. Entries marked `humanOrigin` carry an exact bare
 * subject pattern and only suppress a proven content-free send — an empty
 * body and a proven-empty attachment set — because any body line or subject
 * addition could be a current staff ask.
 */
export const ROUTINE_NOTICE_EXCLUSION_DATA = [
  {
    id: 'fortimail-quarantine',
    kind: 'system',
    source: 'FortiMail',
    senderPattern: { source: '@fortimail-[a-z0-9-]+\\.[a-z0-9.-]+\\s*>?$', flags: 'i' },
    subjectPattern: { source: '^quarantine\\s+summary\\b', flags: 'i' },
  },
  {
    id: 'function-sheet',
    kind: 'system',
    source: 'Function Sheet',
    senderPattern: { source: '@legacyhotels\\.(?:co\\.za|com)\\s*>?$', flags: 'i' },
    // Internal mail can be answered or forwarded by staff; only the exact bare
    // notice subject with an empty body and proven-empty attachments counts as
    // the routine notice. Any suffix, reply/forward prefix or content keeps it
    // reviewable.
    subjectPattern: { source: '^(?:new\\s+|updated\\s+)?function\\s+sheet\\s*$', flags: 'i' },
    humanOrigin: true,
  },
  {
    id: 'guestrevu',
    kind: 'system',
    source: 'GuestRevu',
    senderPattern: { source: '^(?:[^<>]*<)?no-reply@grfeedback-b\\.com\\s*>?$', flags: 'i' },
    subjectPattern: {
      source:
        '^(?:The Centurion Hotel has received a new online review|The Centurion Hotel has received a Post-Stay survey response from |The Centurion Hotel - GuestRevu (?:Daily|Weekly) Summary)',
      flags: 'i',
    },
  },
  {
    id: 'google-calendar',
    kind: 'system',
    source: 'Google Calendar',
    senderPattern: { source: '^(?:[^<>]*<)?calendar-notification@google\\.com\\s*>?$', flags: 'i' },
    subjectPattern: { source: '^(?:Invitation:|Declined:|Canceled event:)', flags: 'i' },
  },
];
