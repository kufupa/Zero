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
  contact: { name: null, email: null, phone: null },
  agency: null,
  endClient: null,
  confirmationNumbers: [],
  stays: [],
  missing: [],
};

/** A stay total with no split: the rows keep their room types and leave rooms null. */
const ROWS_UNSPLIT = [
  { roomType: 'Single', rooms: null, adultsPerRoom: 1, childAges: [], board: null },
  { roomType: 'Double/Twin', rooms: null, adultsPerRoom: 2, childAges: [], board: null },
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
      rows: ROWS_UNSPLIT,
    },
    {
      hotel: 'Grand Hotel',
      requested: { arrival: '2027-11-17', departure: '2027-11-19' },
      booked: null,
      totalRooms: 30,
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

export const SPAM_OUTPUT = { ...EMPTY_OUTPUT, sourceLanguage: 'en', kind: 'spam' };

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
