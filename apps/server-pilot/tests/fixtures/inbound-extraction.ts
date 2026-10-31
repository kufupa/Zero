import type { ModelAdapter, ModelInvokeInput } from '../../src/ai/bedrock/adapter.js';
import type { SyncedQuoteSelection } from '../../src/ai/quote-workflow-synced-selection.js';

/*
 * Synthetic mail written from the plan's AE1 and AE2 descriptions. They are not copies of real mail and carry no
 * real guest details. The model outputs below stand in for a correct model answer. Tests never call a live model.
 */

export const AE1_RECEIVED_AT = '2026-10-09T08:00:00.000Z';

/**
 * Shaped like the real AE1 mail with invented names: a tour operator writes for its client, the client is named in
 * the subject, each date set lists two nights, and 30 rooms is a stay total with no split per room type.
 */
export const AE1_FROM = 'Priya Naidoo <priya@horizontrailtours.example>';
export const AE1_SUBJECT = 'Summit Africa: Rugby Tour 2027 / Grand Hotel';
export const AE1_TEXT = [
  'Reservations Team,',
  '',
  'Summit Africa is a long-standing client of ours who normally brings their running groups to South Africa. With the rugby tour next year they would like to bring groups for this tour. Please advise availability and rates for Single and Double/Twin occupancy at Grand Hotel for the dates below.',
  '',
  '  *   26th and 27th October - 30 rooms.',
  '',
  '  *   17th and 18th November - 30 rooms.',
  '',
  'We need 2 nights per date set for now; our client may add a 3rd night later.',
  '',
  'Kind regards,',
  'Priya',
  '',
  'Priya Naidoo',
  'Direct line: +27 31 555 0100 | Email: priya@horizontrailtours.example',
  'www.horizontrailtours.example',
].join('\n');

/**
 * A staff forward of an outside request, with invented names: a sales manager on the mailbox's own domain passes the
 * tour operator's AE1 request on to colleagues with a short note above it. The read is the operator's request.
 */
export const STAFF_FORWARD_FROM = 'Sam Ndlovu <sam@legacyhotels.co.za>';
export const STAFF_FORWARD_SUBJECT = `FW: ${AE1_SUBJECT}`;
export const STAFF_FORWARD_TEXT = [
  'With the tour dates out - please can we co-ordinate all bookings centrally on the right rates, with a spread of agents. Keep rooms for regulars.',
  'Lee / Kim - please manage this for all hotels.',
  'Thanks',
  'Sam',
  '',
  'Sam Ndlovu | Group Sales | Grand Hotel Group',
  '',
  'From: Priya Naidoo <priya@horizontrailtours.example>',
  'Sent: 08 October 2026 09:14',
  'To: Reservations <reservations@legacyhotels.co.za>',
  `Subject: ${AE1_SUBJECT}`,
  '',
  AE1_TEXT,
].join('\n');

export const AE2_TEXT = [
  'De : Marie Dupont <marie.dupont@example.fr>',
  'Objet : Modification de la réservation 57291630-1',
  '',
  'Bonjour,',
  '',
  'Nous avons une réservation 57291630-1 du 1er au 6 novembre.',
  '',
  'Pourriez-vous ajouter la nuit du 31 octobre ?',
  '',
  'Nous souhaitons aussi un départ tardif le 7 novembre.',
  '',
  "Merci d'avance,",
  'Marie Dupont',
].join('\n');

/** Card digits are spaced here, and the number is Luhn-valid. */
export const VOUCHER_TEXT = [
  'Subject: Proof of payment for booking 57291630-2',
  '',
  'Card used: 4111 1111 1111 1111, expiry 12/29.',
  '',
  'Please find the proof of payment attached.',
].join('\n');

export const SPAM_TEXT = [
  'Subject: You have won a cruise!!!',
  '',
  'Click the link to claim your prize now. Reply STOP to unsubscribe.',
].join('\n');

const EMPTY_OUTPUT = {
  needsAction: true,
  action: 'quote_availability',
  actionEvidence: '',
  actionConfidence: 'high',
  contact: { name: null, email: null, phone: null },
  agency: null,
  endClient: null,
  confirmationNumbers: [],
  stays: [],
  missing: [],
};

/** A stay total with no split: the rows keep their room types and leave rooms null. */
const ROWS_UNSPLIT = [
  { roomType: 'Single', rooms: null, adultsPerRoom: 1, childCount: 0, childAges: [], board: null },
  { roomType: 'Double/Twin', rooms: null, adultsPerRoom: 2, childCount: 0, childAges: [], board: null },
];

/** The correct read: the sender's organisation is the agency, the client in the subject is the end client. */
export const AE1_OUTPUT = {
  ...EMPTY_OUTPUT,
  sourceLanguage: 'en',
  kind: 'quote',
  agency: 'Horizon Trail Tours',
  endClient: 'Summit Africa',
  contact: {
    name: 'Priya Naidoo',
    email: 'priya@horizontrailtours.example',
    phone: '+27 31 555 0100',
  },
  stays: [
    {
      hotel: 'Grand Hotel',
      requested: { arrival: '2027-10-26', departure: '2027-10-28' },
      booked: null,
      totalRooms: 30,
      totalAdults: null,
      totalChildren: 0,
      rows: ROWS_UNSPLIT,
    },
    {
      hotel: 'Grand Hotel',
      requested: { arrival: '2027-11-17', departure: '2027-11-19' },
      booked: null,
      totalRooms: 30,
      totalAdults: null,
      totalChildren: 0,
      rows: ROWS_UNSPLIT,
    },
  ],
  missing: [{ field: 'rooms', question: 'How many single and how many double/twin rooms per stay?' }],
};

export const AE2_OUTPUT = {
  ...EMPTY_OUTPUT,
  sourceLanguage: 'fr',
  kind: 'amendment',
  contact: { name: 'Marie Dupont', email: 'marie.dupont@example.fr', phone: null },
  confirmationNumbers: ['57291630-1'],
  stays: [
    {
      hotel: null,
      requested: { arrival: '2026-10-31', departure: '2026-11-07' },
      booked: { arrival: '2026-11-01', departure: '2026-11-06' },
      totalRooms: null,
      totalAdults: null,
      totalChildren: null,
      rows: [],
    },
  ],
};

export const VOUCHER_OUTPUT = {
  ...EMPTY_OUTPUT,
  sourceLanguage: 'en',
  kind: 'voucher_pop',
  confirmationNumbers: ['57291630-2'],
};

export const SPAM_OUTPUT = {
  ...EMPTY_OUTPUT,
  sourceLanguage: 'en',
  kind: 'spam',
  needsAction: false,
  action: 'no_action',
};

export const CHANNEL_BOOKING_FROM = 'Reservations <notices@example-channel.test>';
export const CHANNEL_BOOKING_SUBJECT = 'New reservation confirmed - 73114001-1';
export const CHANNEL_BOOKING_TEXT = [
  'ExampleChannel reservation notification',
  'A new reservation was created and confirmed for Grand Hotel.',
  'Reservation number: 73114001-1',
  'Guest: Jamie Carter',
  'Guest email: jamie.carter@example.test',
  'Stay: 20 to 22 November 2026, one double room.',
  'The booking voucher is attached.',
].join('\n');
export const CHANNEL_BOOKING_VOUCHER_TEXT = [
  'Reservation voucher for 73114001-1',
  'Guest: Jamie Carter',
  'Stay: 20 to 22 November 2026, one double room.',
].join('\n');
export const CHANNEL_BOOKING_OUTPUT = {
  ...EMPTY_OUTPUT,
  sourceLanguage: 'en',
  kind: 'booking',
  origin: 'system_notice',
  contact: { name: 'Jamie Carter', email: 'jamie.carter@example.test', phone: null },
  confirmationNumbers: ['73114001-1'],
  stays: [
    {
      hotel: 'Grand Hotel',
      requested: { arrival: '2026-11-20', departure: '2026-11-22' },
      booked: null,
      totalRooms: 1,
      totalAdults: null,
      totalChildren: 0,
      rows: [{ roomType: 'Double', rooms: 1, adultsPerRoom: 2, childCount: 0, childAges: [], board: null }],
    },
  ],
};

export const CHANNEL_AMENDMENT_TEXT = [
  'ExampleChannel reservation update',
  'An existing reservation was modified: 73114001-1.',
  'The guest changed the stay from 20-22 November to 20-23 November 2026.',
].join('\n');
export const CHANNEL_AMENDMENT_OUTPUT = {
  ...CHANNEL_BOOKING_OUTPUT,
  kind: 'amendment',
  stays: [
    {
      ...CHANNEL_BOOKING_OUTPUT.stays[0],
      requested: { arrival: '2026-11-20', departure: '2026-11-23' },
      booked: { arrival: '2026-11-20', departure: '2026-11-22' },
    },
  ],
};

export const CHANNEL_CANCELLATION_TEXT = [
  'ExampleChannel reservation update',
  'The existing reservation 73114001-1 was cancelled.',
].join('\n');
export const CHANNEL_CANCELLATION_OUTPUT = {
  ...CHANNEL_BOOKING_OUTPUT,
  kind: 'cancellation',
};

export const CHANNEL_INTEGRATION_FAILURE_TEXT = [
  'ExampleChannel integration alert',
  'A new reservation, 73114002-1, was confirmed by the channel but failed to integrate into the hotel system.',
].join('\n');
export const CHANNEL_INTEGRATION_FAILURE_OUTPUT = {
  ...CHANNEL_BOOKING_OUTPUT,
  confirmationNumbers: ['73114002-1'],
};

export const STANDALONE_POP_TEXT = [
  'Subject: Remittance advice for existing reservation 73114001-1',
  'Payment has been made for this existing booking. Proof of payment is attached.',
  'No reservation details have changed.',
].join('\n');
export const STANDALONE_POP_OUTPUT = {
  ...EMPTY_OUTPUT,
  sourceLanguage: 'en',
  kind: 'voucher_pop',
  origin: 'person',
  contact: { name: 'Alex Finance', email: 'alex.finance@example.test', phone: null },
  confirmationNumbers: ['73114001-1'],
};

export const STAFF_FORWARD_BOOKING_FROM = 'Sam Ndlovu <sam@legacyhotels.co.za>';
export const STAFF_FORWARD_BOOKING_SUBJECT = 'FW: Booking request for Grand Hotel';
export const STAFF_FORWARD_BOOKING_GUEST_EMAIL = 'guest@example.test';
export const STAFF_FORWARD_BOOKING_TEXT = [
  'Reservations team, please process the forwarded guest booking request.',
  'Regards, Sam Ndlovu',
  '',
  'From: Jamie Carter <guest@example.test>',
  'Subject: Please book a room at Grand Hotel',
  'Please book one double room from 20 to 22 November 2026 under Jamie Carter.',
  'My email is guest@example.test.',
].join('\n');
export const STAFF_FORWARD_BOOKING_OUTPUT = {
  ...CHANNEL_BOOKING_OUTPUT,
  origin: 'person',
  contact: { name: 'Jamie Carter', email: STAFF_FORWARD_BOOKING_GUEST_EMAIL, phone: null },
  confirmationNumbers: [],
};

export const GROUP_RATE_ENQUIRY_SUBJECT = 'Group accommodation rates for annual conference';
export const GROUP_RATE_ENQUIRY_TEXT = [
  'We are organising our annual conference and need group accommodation.',
  'Please quote rates and availability for 30 rooms for 20 to 22 November 2026.',
  'We are comparing promotional group packages, so please send your best rate.',
].join('\n');
export const GROUP_RATE_ENQUIRY_OUTPUT = {
  ...EMPTY_OUTPUT,
  sourceLanguage: 'en',
  kind: 'quote',
  origin: 'person',
};

export function selectionFor(bodyText: string, subject = 'Rooms request'): SyncedQuoteSelection {
  return {
    subject,
    bodyText,
    receivedAt: AE1_RECEIVED_AT,
    preceding: [],
    attachments: [],
  };
}

/** A fake model. Records every call, and returns the usage shape the real adapter returns. */
export function fakeModel(
  respond: (input: ModelInvokeInput) => Record<string, unknown> | Promise<Record<string, unknown>>,
): { adapter: ModelAdapter; calls: ModelInvokeInput[] } {
  const calls: ModelInvokeInput[] = [];
  const adapter: ModelAdapter = {
    async invoke(input) {
      calls.push(input);
      const output = await respond(input);
      return {
        modelId: 'gpt-6-luna',
        output,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          latencyMs: 5,
          estimatedCostUsd: 0.002,
          rateTableVersion: 'test',
        },
      };
    },
  };
  return { adapter, calls };
}

/** Answers a translation call with one aligned clean and literal pair per numbered input segment. */
export function echoTranslation(input: ModelInvokeInput): Record<string, unknown> {
  const count = (input.userPrompt.match(/^\[\d+\] /gm) ?? []).length;
  return {
    segments: Array.from({ length: count }, (_, index) => ({
      clean: `Clean ${index + 1}`,
      literal: `Literal ${index + 1}`,
    })),
  };
}

/** A model that never answers, so only the call's deadline ends it. */
export function hangingResponder(): Promise<never> {
  return new Promise<never>(() => undefined);
}
