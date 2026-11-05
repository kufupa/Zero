import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAIL_KINDS } from '../../db/schema/work.js';
import { MAIL_ACTIONS, type MailAction } from '../../mail/action-labels.js';
import { maskCardNumbers } from '../card-mask.js';
import { currentAuthoredMessageText, groundedSeparateAsk } from '../existing-stay-information.js';
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

const proposalSourceSchema = z.object({
  kind: z.enum(['message', 'attachment_text', 'attachment_vision']),
  id: z.string().min(1).max(500),
  page: z.number().int().min(1).max(3).optional(),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reviewRequired: z.boolean().optional(),
}).strict();

/** Only sources actually admitted to the current model call may ground a proposal. */
export type CurrentProposalSource = {
  kind: 'attachment_text' | 'attachment_vision';
  id: string;
  page?: number;
  text?: string;
  digest: string;
};

// Each proposal carries the source phrase that states the requested change. It is
// kept separate from native IDs and from the sender/booker contact block.
const amendProposalValue = <T extends z.ZodTypeAny, R extends z.ZodTypeAny>(value: T, attributedTo: R) => z.object({
  value,
  excerpt: z.string(),
  attributedTo,
  source: proposalSourceSchema.optional(),
}).strict();
const amendTextProposal = (role: 'guest' | 'booker' | null) =>
  amendProposalValue(z.string(), role === null ? z.null() : z.literal(role));
const amendChoiceProposal = <T extends z.ZodTypeAny>(value: T) => amendProposalValue(value, z.null());
const amendProposalSchema = z.object({
  ratePlan: amendTextProposal(null).optional(),
  retainRates: amendChoiceProposal(z.enum(['yes', 'no'])).optional(),
  firstName: amendTextProposal('guest').optional(),
  lastName: amendTextProposal('guest').optional(),
  guestEmail: amendTextProposal('guest').optional(),
  bookerName: amendTextProposal('booker').optional(),
  bookerContact: amendTextProposal('booker').optional(),
  cmsSend: amendChoiceProposal(z.boolean()).optional(),
  cmsMessageId: amendTextProposal(null).optional(),
  cmsRecipient: amendProposalValue(z.string(), z.enum(['guest', 'booker'])).optional(),
}).strict().describe('Only explicit current amendment requests for this stay, each with an exact source excerpt.');

// Labels are source facts, never HMS profile/party IDs or an inferred selection.
const workflowProposalSchema = z.object({
  firstName: amendTextProposal('guest').optional(),
  lastName: amendTextProposal('guest').optional(),
  guestEmail: amendTextProposal('guest').optional(),
  guestMobile: amendTextProposal('guest').optional(),
  bookerName: amendTextProposal('booker').optional(),
  bookerEmail: amendTextProposal('booker').optional(),
  agencyName: amendProposalValue(z.string(), z.literal('agency')).optional(),
  organizationName: amendProposalValue(z.string(), z.literal('organization')).optional(),
  ratePlan: amendTextProposal(null).optional(),
  sourceOfBusiness: amendTextProposal(null).optional(),
  track: amendTextProposal(null).optional(),
  guaranteeType: amendTextProposal(null).optional(),
  reservationNote: amendTextProposal(null).optional(),
  cmsSend: amendChoiceProposal(z.boolean()).optional(),
  cmsMessageId: amendTextProposal(null).optional(),
  cmsRecipient: amendProposalValue(z.string(), z.enum(['guest', 'booker'])).optional(),
  cancelNote: amendTextProposal(null).optional(),
}).strict().describe('Explicit current Create facts or cancellation note, each with an exact source excerpt and role.');
const mailExtractionObjectSchema = z.object({
  separateAsk: z.string().max(200).nullable().optional().describe(
    'For self-sent pre-stay confirmation mail only, an exact excerpt of a separate current request in the target body; otherwise null.',
  ),
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
      totalAdults: z
        .number()
        .int()
        .nullable()
        .default(null)
        .describe('Total adults for this stay, only when stated as a stay-wide total. Null if not stated.'),
      totalChildren: z
        .number()
        .int()
        .nullable()
        .default(null)
        .describe('Total children for this stay, only when stated as a stay-wide total. Null if not stated.'),
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
      amendProposal: amendProposalSchema.optional(),
      workflowProposal: workflowProposalSchema.optional(),
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
          childAges: z
            .array(z.number().int())
            .nullable()
            .describe('Actual ages in these rooms; [] for explicit zero children or the source-clear person-authored Centurion quote-only adult convention, never for booking, children/family or ambiguous requests; null when child count or ages remain unknown.'),
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
  childAges: number[] | null;
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
  /** Stay-wide occupancy totals as stated; absent only on legacy stored rows. */
  totalAdults?: number | null;
  totalChildren?: number | null;
  rows: ExtractionRow[];
  guests?: ExtractionGuest[];
  action?: MailAction;
  amendProposal?: z.infer<typeof amendProposalSchema>;
  workflowProposal?: z.infer<typeof workflowProposalSchema>;
};

const sourceStaySchema = mailExtractionObjectSchema.shape.stays.element;
const storedExtractionRowSchema = sourceStaySchema.shape.rows.element.extend({
  id: z.string(),
});
const storedExtractionStaySchema = sourceStaySchema.extend({
  id: z.string(),
  totalAdults: sourceStaySchema.shape.totalAdults.optional(),
  totalChildren: sourceStaySchema.shape.totalChildren.optional(),
  rows: z.array(storedExtractionRowSchema),
});

/** Stored mail-extraction payload. Action fields, origin, and per-stay guests/action stay optional for legacy rows. */
export const mailExtractionPayloadSchema = z.object({
  separateAsk: z.string().max(200).optional(),
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
  missing: z.array(z.object({ field: z.string(), question: z.string(), stayId: z.string().optional() })),
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

/** Do not promote historical, inferred, ungrounded or native lookup values into an email proposal. */
function sanitizeAmendProposal(
  proposal: z.infer<typeof amendProposalSchema> | undefined,
  currentMessageText: string,
): z.infer<typeof amendProposalSchema> | undefined {
  if (!proposal) return undefined;
  const source = maskCardNumbers(currentMessageText);
  const grounded = (excerpt: string) =>
    excerpt.length > 0 && groundedSeparateAsk(source, excerpt) === excerpt && maskCardNumbers(excerpt) === excerpt;
  const text = <T extends { value: string; excerpt: string }>(item: T | undefined, max: number): T | undefined => {
    if (!item || !grounded(item.excerpt) || /[\p{Cc}]/u.test(item.value)) return undefined;
    const value = item.value.trim();
    if (!value || value.length > max || cleanText(value, max) !== value ||
        !item.excerpt.toLowerCase().includes(value.toLowerCase())) return undefined;
    return { ...item, value };
  };
  const ratePlan = text(proposal.ratePlan, 12);
  const messageId = text(proposal.cmsMessageId, 8);
  const retain = proposal.retainRates;
  const retainExcerpt = retain?.excerpt ?? '';
  const retainRates = retain && grounded(retainExcerpt) &&
    (retain.value === 'yes'
      ? /\bkeep\s+(?:the\s+)?(?:current|existing|same)\s+rates?\b/i.test(retainExcerpt) && !/\b(?:do not|don't|never|not)\s+keep\b/i.test(retainExcerpt)
      : /\breprice\b/i.test(retainExcerpt) && !/\b(?:do not|don't|never|not)\s+reprice\b/i.test(retainExcerpt))
    ? retain : undefined;
  const send = proposal.cmsSend;
  const sendExcerpt = send?.excerpt ?? '';
  const sendNegated = /\b(?:do not|don't|never|not)\s+send\s+(?:the\s+)?confirmation\b/i.test(sendExcerpt);
  const cmsSend = send && grounded(sendExcerpt) &&
    (send.value ? /\bsend\s+(?:the\s+)?confirmation\b/i.test(sendExcerpt) && !sendNegated : sendNegated)
    ? send : undefined;
  const result = {
    ...(ratePlan && /^[A-Z0-9]{1,12}$/.test(ratePlan.value) ? { ratePlan } : {}),
    ...(retainRates ? { retainRates } : {}),
    ...(text(proposal.firstName, 1000) ? { firstName: text(proposal.firstName, 1000) } : {}),
    ...(text(proposal.lastName, 1000) ? { lastName: text(proposal.lastName, 1000) } : {}),
    ...(text(proposal.guestEmail, 1000) ? { guestEmail: text(proposal.guestEmail, 1000) } : {}),
    ...(text(proposal.bookerName, 1000) ? { bookerName: text(proposal.bookerName, 1000) } : {}),
    ...(text(proposal.bookerContact, 1000) ? { bookerContact: text(proposal.bookerContact, 1000) } : {}),
    ...(cmsSend ? { cmsSend } : {}),
    ...(messageId ? { cmsMessageId: messageId } : {}),
    ...(text(proposal.cmsRecipient, 255) ? { cmsRecipient: text(proposal.cmsRecipient, 255) } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

function sanitizeWorkflowProposal(
  proposal: z.infer<typeof workflowProposalSchema> | undefined,
  currentMessageText: string,
  messageId: string,
  admittedSources: CurrentProposalSource[],
  currentMessageSubject: string,
  singleStay: boolean,
): z.infer<typeof workflowProposalSchema> | undefined {
  if (!proposal) return undefined;
  const source = maskCardNumbers(currentMessageText);
  const subject = maskCardNumbers(currentMessageSubject);
  const limits: Record<keyof typeof proposal, number> = {
    firstName: 1000, lastName: 1000, guestEmail: 1000, guestMobile: 1000,
    bookerName: 50, bookerEmail: 80, agencyName: 200, organizationName: 200, ratePlan: 12,
    sourceOfBusiness: 80, track: 80, guaranteeType: 80, reservationNote: 2000,
    cmsSend: 0, cmsMessageId: 8, cmsRecipient: 255, cancelNote: 200,
  };
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(proposal)) {
    if (!item || !item.excerpt || item.excerpt.length > 200 || maskCardNumbers(item.excerpt) !== item.excerpt) continue;
    const exact = (text: string) => groundedSeparateAsk(maskCardNumbers(text), item.excerpt) === item.excerpt ||
      subject.includes(item.excerpt);
    const attachmentExact = (text: string) => maskCardNumbers(text).includes(item.excerpt);
    let provenance: z.infer<typeof proposalSourceSchema> | undefined;
    let verifiedTexts: string[] = [];
    const checkCmsSource = key === 'cmsSend' && typeof item.value === 'boolean' && singleStay;
    if (item.source?.kind === 'message') {
      if (item.source.id !== messageId || !exact(source)) continue;
      provenance = { kind: 'message', id: messageId,
        digest: createHash('sha256').update(source).update('\0').update(subject).digest('hex') };
      if (checkCmsSource) verifiedTexts = [currentAuthoredMessageText(source), subject];
    } else if (item.source) {
      const matched = admittedSources.filter((candidate) => candidate.kind === item.source!.kind &&
        candidate.id === item.source!.id && (candidate.kind !== 'attachment_vision' || candidate.page === item.source!.page));
      if (matched.length !== 1) continue;
      const candidate = matched[0]!;
      if (candidate.kind === 'attachment_text' && !attachmentExact(candidate.text ?? '')) continue;
      if (checkCmsSource && candidate.kind === 'attachment_text') verifiedTexts = [maskCardNumbers(candidate.text ?? '')];
      provenance = { kind: candidate.kind, id: candidate.id, digest: candidate.digest,
        ...(candidate.page !== undefined ? { page: candidate.page } : {}),
        ...(candidate.kind === 'attachment_vision' ? { reviewRequired: true } : {}) };
    } else if (!exact(source)) {
      // Older model outputs may omit a pointer. Only one exact current text source is unambiguous.
      const matched = admittedSources.filter((candidate) => candidate.kind === 'attachment_text' && attachmentExact(candidate.text ?? ''));
      if (matched.length !== 1) continue;
      if (checkCmsSource) verifiedTexts = [maskCardNumbers(matched[0]!.text ?? '')];
      provenance = { kind: 'attachment_text', id: matched[0]!.id, digest: matched[0]!.digest };
    } else {
      if (checkCmsSource) verifiedTexts = [currentAuthoredMessageText(source), subject];
    }
    const groundedItem = provenance ? { ...item, source: provenance } : item;
    if (typeof item.value === 'boolean') {
      const negativePattern = /\b(?:do not|don't|never|not)\s+send\s+(?:the\s+)?confirmation\b|\bcms\s+send\s*[:=]\s*(?:off|false|no)\b/i;
      const citedNegative = negativePattern.test(item.excerpt);
      const sourceNegative = singleStay ? verifiedTexts.map((text) => text.match(negativePattern)?.[0])
        .find((excerpt) => excerpt && excerpt.length <= 200) : undefined;
      const positive = /\bsend\s+(?:the\s+)?confirmation\b/i.test(item.excerpt) ||
        /\bcms\s+send\s*[:=]\s*(?:on|true|yes)\b/i.test(item.excerpt);
      if (key === 'cmsSend') {
        if (citedNegative || sourceNegative) result[key] = { ...groundedItem, value: false,
          excerpt: citedNegative ? item.excerpt : sourceNegative };
        else if (item.value && positive) result[key] = groundedItem;
      }
      continue;
    }
    if (/[\p{Cc}]/u.test(item.value)) continue;
    const value = item.value.trim();
    const limit = limits[key as keyof typeof limits];
    if (!value || value.length > limit || cleanText(value, limit) !== value ||
        !item.excerpt.toLowerCase().includes(value.toLowerCase())) continue;
    if (key === 'ratePlan' && !/^[A-Z0-9]{1,12}$/.test(value)) continue;
    result[key] = { ...groundedItem, value };
  }
  return Object.keys(result).length ? workflowProposalSchema.parse(result) : undefined;
}

/**
 * Validates and grounds the model output. Confirmation numbers must be digits-dash-digits and appear verbatim
 * in the text the model read. The contact email must appear in that text too. Anything else is dropped to null.
 */
export function sanitizeExtraction(
  output: MailExtractionOutput,
  input: { messageId: string; sourceText: string; currentMessageText?: string;
    currentMessageSubject?: string; currentProposalSources?: CurrentProposalSource[]; dateAnchor?: StayDateAnchorContext },
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
      totalAdults: countOf(stay.totalAdults, 0, 999),
      totalChildren: countOf(stay.totalChildren, 0, 999),
      rows: stay.rows.slice(0, MAX_ROWS).map((row) => ({
        roomType: cleanText(row.roomType),
        rooms: countOf(row.rooms, 1, 999),
        adultsPerRoom: countOf(row.adultsPerRoom, 1, 9),
        childAges: row.childAges === null
          ? null
          : row.childAges.filter((age) => Number.isInteger(age) && age >= 0 && age <= 17).slice(0, 9),
        board: row.board,
      })),
      ...(guests !== undefined ? { guests } : {}),
      ...(stay.action !== undefined ? { action: stay.action } : {}),
      ...(output.kind === 'amendment' && (stay.action === undefined || stay.action === 'amend')
        ? { amendProposal: sanitizeAmendProposal(stay.amendProposal, input.currentMessageText ?? input.sourceText) }
        : {}),
      ...(stay.workflowProposal
        ? { workflowProposal: sanitizeWorkflowProposal(stay.workflowProposal, input.currentMessageText ?? input.sourceText,
            input.messageId, input.currentProposalSources ?? [], input.currentMessageSubject ?? '', output.stays.length === 1) }
        : {}),
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
      totalAdults: stay.totalAdults,
      totalChildren: stay.totalChildren,
      rows: stay.rows.map((row, rowIndex) => ({
        id: rowStableId(id, row, stay.rows, rowIndex),
        ...row,
      })),
      ...(stay.guests !== undefined ? { guests: stay.guests } : {}),
      ...(stay.action !== undefined ? { action: stay.action } : {}),
      ...(stay.amendProposal ? { amendProposal: stay.amendProposal } : {}),
      ...(stay.workflowProposal ? { workflowProposal: stay.workflowProposal } : {}),
    };
  });
  const reversedDateWarnings = output.stays.slice(0, MAX_STAYS).flatMap((stay, index) => {
    const arrival = validIsoDate(stay.requested.arrival);
    const departure = validIsoDate(stay.requested.departure);
    const stayId = stays[index]?.id;
    return arrival && departure && departure <= arrival
      ? [{ field: 'stayDates', question: 'Departure date must be after arrival; confirm the requested stay dates.', ...(stayId ? { stayId } : {}) }]
      : [];
  });
  const missing = [
    ...output.missing.slice(0, Math.max(0, MAX_MISSING - reversedDateWarnings.length)),
    ...reversedDateWarnings,
  ]
    .slice(0, MAX_MISSING)
    .map((item) => ({
      field: cleanText(item.field, 60) ?? '',
      question: cleanText(item.question) ?? '',
      ...('stayId' in item && typeof item.stayId === 'string' && item.stayId ? { stayId: item.stayId } : {}),
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
