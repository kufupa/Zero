import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAIL_KINDS } from '../../db/schema/work.js';
import { MAIL_ACTIONS, type MailAction } from '../../mail/action-labels.js';
import { maskCardNumbers } from '../card-mask.js';
import { validIsoDate } from '../quote-workflow-llm.js';
import { anchorStayDateRange, type StayDateAnchorContext } from '../stay-date-anchoring.js';

/**
 * Inbound extraction (mail_extraction). The model fills `mailExtractionSchema`, which is lenient so one bad field
 * does not fail the read. `sanitizeExtraction` then drops invalid values, masks card numbers and assigns stable ids.
 * Stay ids hash the message id with the date set (and a guest confirmation or name only when two stays share dates).
 * Row ids hash the stay id with the room type. Position is a last-resort unique suffix, never a match key.
 */

export type MailKind = (typeof MAIL_KINDS)[number];
export type { MailAction };
export type ExtractionBoard = 'room_only' | 'bb' | 'dbb';
export type DateRange = { arrival: string | null; departure: string | null };
export const ACTION_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type ActionConfidence = (typeof ACTION_CONFIDENCE_LEVELS)[number];

const nullableText = z.string().nullable();
const dateRange = z.object({
  arrival: z.string().nullable().describe('ISO YYYY-MM-DD arrival, or null if not stated.'),
  departure: z
    .string()
    .nullable()
    .describe('ISO YYYY-MM-DD checkout day (exclusive), or null if not stated.'),
});
const extractionOriginSchema = z.enum(['person', 'system_notice']);

const mailExtractionObjectSchema = z.object({
  needsAction: z.boolean().describe('Whether this target message represents open or newly requested work.'),
  action: z.enum(MAIL_ACTIONS).describe('The target message action, considered with prior thread messages.'),
  actionEvidence: z.string().max(200).describe('Short supporting evidence, no card digits; empty when none.'),
  actionConfidence: z.enum(ACTION_CONFIDENCE_LEVELS).describe('Confidence in needsAction and action.'),
  sourceLanguage: z
    .string()
    .nullable()
    .describe('ISO 639-1 code of the main body text, lower case, e.g. "en" or "fr". Null if unclear.'),
  kind: z.enum(MAIL_KINDS),
  origin: extractionOriginSchema
    .nullable()
    .optional()
    .describe('Person-authored email, system-generated channel/agent notice, or null when unclear.'),
  agency: nullableText.describe(
    'The organisation of the sender (the From address), from the From domain, signature or letterhead. Null for a private sender.',
  ),
  endClient: nullableText.describe(
    'The client the booking is for, e.g. "our client X" or a client named in the subject, only when it differs from the sender. Null if the same or not stated.',
  ),
  contact: z.object({
    name: nullableText,
    email: nullableText,
    phone: nullableText,
  }),
  confirmationNumbers: z
    .array(z.string())
    .describe('Existing booking or confirmation numbers exactly as written, e.g. 57291630-1.'),
  stays: z.array(
    z.object({
      hotel: nullableText.describe('Target hotel as named in the mail, or null.'),
      requested: dateRange.describe('The dates the sender asks for now.'),
      requestedDateEvidence: z
        .string()
        .nullable()
        .optional()
        .describe('Exact source phrase for THIS stay’s requested dates, or null if not stated. Never reuse another stay’s phrase.'),
      booked: dateRange
        .nullable()
        .describe(
          'Only for amendment, cancellation or voucher_pop: the dates the mail or thread says are currently booked. Null for new requests.',
        ),
      totalRooms: z
        .number()
        .int()
        .nullable()
        .describe('Total rooms asked for in this stay, as stated. Null if not stated.'),
      guests: z
        .array(
          z.object({
            name: z.string().describe('Guest name as written for this stay.'),
            confirmationNumber: z
              .string()
              .nullable()
              .describe('Existing confirmation number for this guest exactly as written, or null.'),
          }),
        )
        .optional()
        .describe('Named guests on this stay, each with their own confirmation number when written.'),
      action: z
        .enum(MAIL_ACTIONS)
        .optional()
        .describe('Action for this stay; same enum as top-level action. Top-level action remains a summary.'),
      rows: z.array(
        z.object({
          roomType: nullableText.describe(
            'Room type as written, e.g. "Single" or "Double/Twin". Null if not stated.',
          ),
          rooms: z
            .number()
            .int()
            .nullable()
            .describe('Identical rooms of this type in this stay.'),
          adultsPerRoom: z
            .number()
            .int()
            .nullable()
            .describe('Adults in EACH room, not in total.'),
          childrenPerRoom: z
            .number()
            .int()
            .nullable()
            .optional()
            .describe('Children in EACH room: 0 when none are requested, null when children are mentioned but their number per room is unknown. Absent only in older reads.'),
          childAges: z.array(z.number().int()).describe('Known ages of children in EACH room; do not invent unknown ages.'),
          board: z.enum(['room_only', 'bb', 'dbb']).nullable(),
        }),
      ),
    }),
  ),
  missing: z.array(
    z.object({
      field: z.string(),
      question: z.string(),
    }),
  ),
});

export const mailExtractionSchema = mailExtractionObjectSchema.superRefine((value, context) => {
  if (value.needsAction === (value.action === 'no_action')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['needsAction'],
      message: 'needsAction must be false exactly when action is no_action.',
    });
  }
});
export type MailExtractionOutput = z.infer<typeof mailExtractionSchema>;

export type ExtractionRow = {
  id: string;
  roomType: string | null;
  rooms: number | null;
  adultsPerRoom: number | null;
  /** Absent in legacy reads; null means children were mentioned but their per-room count is unknown. */
  childrenPerRoom?: number | null;
  childAges: number[];
  board: ExtractionBoard | null;
};
export type ExtractionGuest = {
  name: string;
  confirmationNumber: string | null;
};
export type ExtractionStay = {
  id: string;
  hotel: string | null;
  requested: DateRange;
  booked: DateRange | null;
  /** Stay total as stated. Set when the mail gives a total without a per-type split (rows then carry rooms null). */
  totalRooms: number | null;
  rows: ExtractionRow[];
  guests?: ExtractionGuest[];
  action?: MailAction;
};

const storedExtractionRowSchema = mailExtractionObjectSchema.shape.stays.element.shape.rows.element.extend({
  id: z.string(),
});
const storedExtractionStaySchema = mailExtractionObjectSchema.shape.stays.element.extend({
  id: z.string(),
  rows: z.array(storedExtractionRowSchema),
});

/** Stored mail-extraction payload. Action fields, origin, and per-stay guests/action stay optional for legacy rows. */
export const mailExtractionPayloadSchema = z.object({
  needsAction: z.boolean().optional(),
  action: z.enum(MAIL_ACTIONS).optional(),
  actionEvidence: z.string().max(200).optional(),
  actionConfidence: z.enum(ACTION_CONFIDENCE_LEVELS).optional(),
  origin: extractionOriginSchema
    .nullable()
    .optional()
    .describe('Person-authored email or a system-generated notice; absent in older stored payloads.'),
  contact: mailExtractionObjectSchema.shape.contact,
  agency: mailExtractionObjectSchema.shape.agency,
  endClient: mailExtractionObjectSchema.shape.endClient,
  confirmationNumbers: mailExtractionObjectSchema.shape.confirmationNumbers,
  stays: z.array(storedExtractionStaySchema),
  missing: mailExtractionObjectSchema.shape.missing,
});

/** The stored payload (mail_extraction.payload). Every string is card-masked and capped. */
export type MailExtractionPayload = z.infer<typeof mailExtractionPayloadSchema>;
export type SanitizedExtraction = {
  kind: MailKind;
  needsAction: boolean;
  action: MailAction;
  actionEvidence: string;
  actionConfidence: ActionConfidence;
  sourceLanguage: string | null;
  payload: MailExtractionPayload;
};

const TEXT_MAX = 200;
const MAX_STAYS = 8; // the quote engine prices at most 8 groups
const MAX_ROWS = 40;
const MAX_GUESTS = 40;
const MAX_CONFIRMATIONS = 10;
const MAX_MISSING = 20;
const CONFIRMATION_PATTERN = /^\d+-\d+$/;
const LANGUAGE_PATTERN = /^[a-z]{2}$/;

/** Digits-dash-digits and present verbatim in the text the model read; otherwise null. */
function groundedConfirmationNumber(value: string, sourceText: string): string | null {
  const trimmed = value.trim();
  return CONFIRMATION_PATTERN.test(trimmed) && sourceText.includes(trimmed) ? trimmed : null;
}

/** Card-mask, then cap, so a number cut at the limit is never left half-unmasked. Empty becomes null. */
export function cleanText(value: string | null | undefined, max = TEXT_MAX): string | null {
  const text = maskCardNumbers(value?.trim() ?? '')
    .slice(0, max)
    .trim();
  return text || null;
}

/** A checkout on or before arrival is not a stay: keep the arrival and drop the departure. */
function dateRangeOf(value: DateRange): DateRange {
  const arrival = validIsoDate(value.arrival) ?? null;
  const departure = validIsoDate(value.departure) ?? null;
  return {
    arrival,
    departure: arrival && departure && departure <= arrival ? null : departure,
  };
}

function countOf(value: number | null, min: number, max: number): number | null {
  return value !== null && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export function stableId(prefix: 's' | 'r', ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 8)}`;
}

function dateKey(stay: { requested: DateRange }): string {
  return `${stay.requested.arrival ?? ''}\0${stay.requested.departure ?? ''}`;
}

function firstConfirmation(stay: { guests?: ExtractionGuest[] }): string {
  return stay.guests?.map((guest) => guest.confirmationNumber).find((value): value is string => Boolean(value)) ?? '';
}

function firstGuestName(stay: { guests?: ExtractionGuest[] }): string {
  return stay.guests?.[0]?.name ?? '';
}

/**
 * Content key for a stay among its siblings. Null when only array position could tell it apart (undated, or
 * same-date stays with no unique guest confirmation or name).
 */
export function stayContentKey(
  stay: { requested: DateRange; guests?: ExtractionGuest[] },
  among: Array<{ requested: DateRange; guests?: ExtractionGuest[] }>,
): string | null {
  const dates = dateKey(stay);
  if (dates === '\0') return null;
  const sameDates = among.filter((item) => dateKey(item) === dates);
  if (sameDates.length === 1) return dates;
  const confirmation = firstConfirmation(stay);
  if (confirmation && sameDates.filter((item) => firstConfirmation(item) === confirmation).length === 1) {
    return `${dates}\0c\0${confirmation}`;
  }
  const name = firstGuestName(stay);
  if (name && sameDates.filter((item) => firstGuestName(item) === name).length === 1) {
    return `${dates}\0g\0${name}`;
  }
  return null;
}

/** Room-type key among rows of one stay. Null when the type is missing or duplicated. */
export function rowContentKey(
  row: { roomType: string | null },
  among: Array<{ roomType: string | null }>,
): string | null {
  const roomType = row.roomType ?? '';
  if (!roomType) return null;
  return among.filter((item) => (item.roomType ?? '') === roomType).length === 1 ? roomType : null;
}

function stayStableId(
  messageId: string,
  stay: { requested: DateRange; guests?: ExtractionGuest[] },
  among: Array<{ requested: DateRange; guests?: ExtractionGuest[] }>,
  stayIndex: number,
): string {
  const content = stayContentKey(stay, among);
  if (content) return stableId('s', messageId, content);
  return stableId('s', messageId, dateKey(stay), 'p', String(stayIndex));
}

function rowStableId(
  stayId: string,
  row: { roomType: string | null },
  among: Array<{ roomType: string | null }>,
  rowIndex: number,
): string {
  const content = rowContentKey(row, among);
  if (content) return stableId('r', stayId, content);
  return stableId('r', stayId, row.roomType ?? '', 'p', String(rowIndex));
}

/**
 * Validates and grounds the model output. Confirmation numbers must be digits-dash-digits and appear verbatim
 * in the text the model read. The contact email must appear in that text too. Anything else is dropped to null.
 */
export function sanitizeExtraction(
  output: MailExtractionOutput,
  input: { messageId: string; sourceText: string; dateAnchor?: StayDateAnchorContext },
): SanitizedExtraction {
  const sourceLower = input.sourceText.toLowerCase();
  const email = cleanText(output.contact.email);
  const confirmationNumbers = [
    ...new Set(output.confirmationNumbers.map((value) => value.trim())),
  ]
    .filter((value) => groundedConfirmationNumber(value, input.sourceText) !== null)
    .slice(0, MAX_CONFIRMATIONS);
  const prepared = output.stays.slice(0, MAX_STAYS).map((stay) => {
    const dateEvidence = stay.requestedDateEvidence?.trim() ?? '';
    const selectionText = input.dateAnchor?.sourceText ?? '';
    const sourceText = dateEvidence && selectionText.includes(dateEvidence) ? dateEvidence : '';
    const dateAnchor: StayDateAnchorContext = {
      ...input.dateAnchor,
      allowYearlessRollover: output.kind === 'quote' || output.kind === 'booking',
      sourceText,
      subjectText: output.stays.length === 1 ? input.dateAnchor?.subjectText : undefined,
      yearEvidenceText:
        output.stays.length === 1
          ? input.dateAnchor?.yearEvidenceText ?? selectionText
          : undefined,
    };
    const guests =
      stay.guests === undefined
        ? undefined
        : stay.guests.slice(0, MAX_GUESTS).flatMap((guest) => {
            const name = cleanText(guest.name);
            if (!name) return [];
            return [
              {
                name,
                confirmationNumber:
                  guest.confirmationNumber == null
                    ? null
                    : groundedConfirmationNumber(guest.confirmationNumber, input.sourceText),
              },
            ];
          });
    return {
      hotel: cleanText(stay.hotel),
      requested: dateRangeOf(anchorStayDateRange(stay.requested, dateAnchor)),
      booked: stay.booked ? dateRangeOf(stay.booked) : null,
      totalRooms: countOf(stay.totalRooms, 1, 999),
      rows: stay.rows.slice(0, MAX_ROWS).map((row) => {
        const childAges = row.childAges
          .filter((age) => Number.isInteger(age) && age >= 0 && age <= 17)
          .slice(0, 9);
        return {
          roomType: cleanText(row.roomType),
          rooms: countOf(row.rooms, 1, 999),
          adultsPerRoom: countOf(row.adultsPerRoom, 1, 9),
          ...(row.childrenPerRoom !== undefined
            ? { childrenPerRoom: childAges.length === row.childAges.length ? countOf(row.childrenPerRoom, 0, 9) : null }
            : {}),
          childAges,
          board: row.board,
        };
      }),
      ...(guests !== undefined ? { guests } : {}),
      ...(stay.action !== undefined ? { action: stay.action } : {}),
    };
  });
  const identityStays = prepared.map((stay) => ({ requested: stay.requested, guests: stay.guests }));
  const stays = prepared.map((stay, stayIndex): ExtractionStay => {
    const id = stayStableId(input.messageId, stay, identityStays, stayIndex);
    return {
      id,
      hotel: stay.hotel,
      requested: stay.requested,
      booked: stay.booked,
      totalRooms: stay.totalRooms,
      rows: stay.rows.map((row, rowIndex) => ({
        id: rowStableId(id, row, stay.rows, rowIndex),
        ...row,
      })),
      ...(stay.guests !== undefined ? { guests: stay.guests } : {}),
      ...(stay.action !== undefined ? { action: stay.action } : {}),
    };
  });
  const reversedDateWarnings = output.stays.slice(0, MAX_STAYS).flatMap((stay) => {
    const arrival = validIsoDate(stay.requested.arrival);
    const departure = validIsoDate(stay.requested.departure);
    return arrival && departure && departure <= arrival
      ? [{ field: 'stayDates', question: 'Departure date must be after arrival; confirm the requested stay dates.' }]
      : [];
  });
  const incompleteChildren = stays.some((stay) => stay.rows.some((row) =>
    row.childrenPerRoom === null ||
    (row.childrenPerRoom !== undefined && row.childrenPerRoom !== row.childAges.length),
  ));
  const childWarnings = incompleteChildren && !output.missing.some((item) =>
    item.field === 'childrenPerRoom' || item.field === 'childAges',
  )
    ? [{ field: 'childAges', question: 'Confirm the number of children per room and each child’s age.' }]
    : [];
  const missing = [
    ...output.missing.slice(0, Math.max(0, MAX_MISSING - reversedDateWarnings.length - childWarnings.length)),
    ...reversedDateWarnings,
    ...childWarnings,
  ]
    .slice(0, MAX_MISSING)
    .map((item) => ({
      field: cleanText(item.field, 60) ?? '',
      question: cleanText(item.question) ?? '',
    }))
    .filter((item) => item.question);
  const actionEvidence = cleanText(output.actionEvidence, 200) ?? '';
  return {
    kind: output.kind,
    needsAction: output.needsAction,
    action: output.action,
    actionEvidence,
    actionConfidence: output.actionConfidence,
    sourceLanguage: LANGUAGE_PATTERN.test(output.sourceLanguage ?? '')
      ? output.sourceLanguage
      : null,
    payload: {
      needsAction: output.needsAction,
      action: output.action,
      actionEvidence,
      actionConfidence: output.actionConfidence,
      origin: output.origin ?? null,
      contact: {
        name: cleanText(output.contact.name),
        email: email && sourceLower.includes(email.toLowerCase()) ? email : null,
        phone: cleanText(output.contact.phone),
      },
      agency: cleanText(output.agency),
      endClient: cleanText(output.endClient),
      confirmationNumbers,
      stays,
      missing,
    },
  };
}
