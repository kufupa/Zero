/**
 * Bounded read-only adapter for the proven JSON reservation-notes inquiry.
 *
 * Source response has no reservation identity. Caller must supply the already
 * correlated HDR/LST parent proof; this adapter binds the request to that
 * proof and never derives identity from response text.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { NOTES_INQUIRY_READ_PATH } from './notes-traces-manifest.js';
import { HmsRuntimeError, type HmsReadSession } from '../../../../../../apps/server-pilot/src/hms/runtime.js';

export const NOTES_INQUIRY_EXPECTED_PROPERTY = 'HRCEN' as const;
export const NOTES_INQUIRY_MAX_BYTES = 32 * 1024;
export const NOTES_INQUIRY_MAX_ROWS = 50;
export const NOTES_INQUIRY_MAX_SOURCE_ROWS = 256;
export const NOTES_INQUIRY_MAX_NOTE_CHARS = 2_000;
export type NotesInquiryAudience = 'staff' | 'customer';
const DEFAULT_AUDIENCE: NotesInquiryAudience = 'customer';

const maskedNoteValues = new Set([
  'protected',
  'hidden',
  'masked',
  'redacted',
  'not authorized',
  'not authorised',
]);

const noteRowSchema = z
  .object({
    id: z.number().int().nonnegative().finite(),
    note: z.string(),
    categoryCode: z.string().min(1).max(64),
    categoryDescription: z.string().max(512),
    sourceCode: z.string().min(1).max(64),
    sourceDescription: z.string().max(512),
    propertyCode: z.string().min(1).max(64),
    propertyDescription: z.string().max(512),
    displayOnCheckin: z.boolean(),
    printOnConfirmation: z.boolean(),
    printOnRegistration: z.boolean(),
    printOnHouseKeeping: z.boolean(),
    displayOnCheckout: z.boolean(),
    displayOnCreateUpdateReservation: z.boolean(),
    displayOnReservationRetrieval: z.boolean(),
    private: z.boolean(),
  })
  .strict();

const noteCategorySchema = z
  .object({
    code: z.string().min(1).max(64),
    description: z.string().max(512),
  })
  .strict();

/** Exact shape observed in network-8 response, with bounded collections. */
export const notesInquiryResponseSchema = z
  .object({
    noteCategories: z.array(noteCategorySchema).max(NOTES_INQUIRY_MAX_SOURCE_ROWS),
    reservationNotes: z.array(noteRowSchema).max(NOTES_INQUIRY_MAX_SOURCE_ROWS),
    guestProfileNotes: z.array(noteRowSchema).max(NOTES_INQUIRY_MAX_SOURCE_ROWS),
    bookingAgencyNotes: z.array(noteRowSchema).max(NOTES_INQUIRY_MAX_SOURCE_ROWS),
    organizationNotes: z.array(noteRowSchema).max(NOTES_INQUIRY_MAX_SOURCE_ROWS),
    groupBookingNotes: z
      .union([z.array(noteRowSchema).max(NOTES_INQUIRY_MAX_SOURCE_ROWS), z.null()]),
    // Aggregate can contain text outside row-level printability. Validate type,
    // never project it into customer output.
    reservationNote: z.string(),
  })
  .strict();

export type NotesInquiryResponseFixture = z.infer<typeof notesInquiryResponseSchema>;
export type NotesInquirySourceRow = NotesInquiryResponseFixture['reservationNotes'][number];

export type NotesInquiryItem = Pick<
  NotesInquirySourceRow,
  | 'id'
  | 'note'
  | 'categoryCode'
  | 'categoryDescription'
  | 'sourceCode'
  | 'sourceDescription'
  | 'propertyCode'
  | 'propertyDescription'
  | 'displayOnCheckin'
  | 'printOnConfirmation'
  | 'printOnRegistration'
  | 'printOnHouseKeeping'
  | 'displayOnCheckout'
  | 'displayOnCreateUpdateReservation'
  | 'displayOnReservationRetrieval'
  | 'private'
>;

export type NotesInquiryIssueCode = 'MASKED_NOTE' | 'EMPTY_NOTE' | 'TRUNCATED';

export type NotesInquiryIssue = {
  code: NotesInquiryIssueCode;
  count: number;
};

export type NotesInquiryPage = {
  returnedCount: number;
  hasMore: boolean | null;
  nextCursor: null;
};

type NotesInquiryUnknownFact = {
  state: 'unknown';
  reasonCode: 'NOT_APPLICABLE';
};

/** Scalar HDR reservation note; staff may inspect text, customer may not. */
export type NotesInquiryScalarObservation = {
  audience: NotesInquiryAudience;
  state: 'known' | 'unavailable';
  reasonCode?: 'NOT_APPLICABLE' | 'POLICY_UNAPPROVED' | 'SOURCE_UNAVAILABLE';
  text: string | null;
  customerPrintable: NotesInquiryUnknownFact;
  status: NotesInquiryUnknownFact;
  createdAt: NotesInquiryUnknownFact;
  sourceLength: number;
  sourceHash: string;
};

export type NotesInquiryParseResult = {
  audience: NotesInquiryAudience;
  propertyCode: typeof NOTES_INQUIRY_EXPECTED_PROPERTY;
  /** Digest of full validated response, before audience/page/text projection. */
  sourceHash: string;
  /** Stable digest of validated source content for stateless pagination. */
  cursorHash: string;
  items: NotesInquiryItem[];
  /** All audience-eligible validated rows, before the public page slice. */
  allItems: NotesInquiryItem[];
  sourceCount: number;
  filteredCount: number;
  maskedCount: number;
  emptyCount: number;
  /** Safe metadata only; scalar source text never enters customer output. */
  reservationNote: NotesInquiryScalarObservation;
  completeness: 'complete' | 'partial';
  sourceCompleteness: 'complete' | 'partial';
  sourceIssues: NotesInquiryIssue[];
  page: NotesInquiryPage;
  issues: NotesInquiryIssue[];
};

export type NotesInquiryParentBinding = {
  propertyCode: typeof NOTES_INQUIRY_EXPECTED_PROPERTY;
  confirmationNumber: string;
  /** Final reservationstayid correlated from selected OSRESV.LST/HDR row. */
  reservationStayId: string;
  /** Optional caller resource scope; required when driver projects provider output. */
  resourceRef?: string;
};

export type NotesInquiryReadResult = NotesInquiryParseResult & {
  parentBinding: NotesInquiryParentBinding;
};

export type NotesInquiryReadInput = {
  parentBinding: NotesInquiryParentBinding;
  /** Optional duplicate assertion for callers; mismatch fails before request. */
  confirmationNumber?: string;
  /** Safe default is customer; staff must be explicit. */
  audience?: NotesInquiryAudience;
  limit?: number;
};

export class NotesInquiryParseError extends Error {
  readonly code:
    | 'MALFORMED_JSON'
    | 'OVERSIZED_BODY'
    | 'INVALID_RESPONSE'
    | 'PROPERTY_MISMATCH'
    | 'DUPLICATE_NOTE_ID'
    | 'DUPLICATE_CATEGORY';

  constructor(
    code: NotesInquiryParseError['code'],
    message = 'notes inquiry response rejected',
  ) {
    super(`${code}: ${message}`);
    this.name = 'NotesInquiryParseError';
    this.code = code;
  }
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return NOTES_INQUIRY_MAX_ROWS;
  if (!Number.isInteger(limit) || limit < 1 || limit > NOTES_INQUIRY_MAX_ROWS) {
    throw new NotesInquiryParseError('INVALID_RESPONSE', 'invalid page limit');
  }
  return limit;
}

function boundedAudience(audience: NotesInquiryAudience | undefined): NotesInquiryAudience {
  if (audience === undefined) return DEFAULT_AUDIENCE;
  if (audience !== 'staff' && audience !== 'customer') {
    throw new NotesInquiryParseError('INVALID_RESPONSE', 'invalid audience');
  }
  return audience;
}

function parseSource(input: string | unknown): NotesInquiryResponseFixture {
  let raw: unknown = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > NOTES_INQUIRY_MAX_BYTES) {
      throw new NotesInquiryParseError('OVERSIZED_BODY');
    }
    try {
      raw = JSON.parse(input) as unknown;
    } catch {
      throw new NotesInquiryParseError('MALFORMED_JSON');
    }
  } else {
    try {
      if (Buffer.byteLength(JSON.stringify(input), 'utf8') > NOTES_INQUIRY_MAX_BYTES) {
        throw new NotesInquiryParseError('OVERSIZED_BODY');
      }
    } catch (error) {
      if (error instanceof NotesInquiryParseError) throw error;
      throw new NotesInquiryParseError('INVALID_RESPONSE');
    }
  }

  const parsed = notesInquiryResponseSchema.safeParse(raw);
  if (!parsed.success) throw new NotesInquiryParseError('INVALID_RESPONSE');
  return parsed.data;
}

function isMaskedNote(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[()[\]]/g, '');
  return maskedNoteValues.has(normalized);
}

function issueCounts(
  counts: Partial<Record<NotesInquiryIssueCode, number>>,
): NotesInquiryIssue[] {
  return (Object.entries(counts) as Array<[NotesInquiryIssueCode, number | undefined]>)
    .filter((entry): entry is [NotesInquiryIssueCode, number] =>
      typeof entry[1] === 'number' && entry[1] > 0,
    )
    .map(([code, count]) => ({ code, count }));
}

function stableSourceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSourceValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableSourceValue(child)]),
  );
}

function notesInquirySourceHash(source: NotesInquiryResponseFixture): string {
  return createHash('sha256')
    .update(JSON.stringify(stableSourceValue(source)), 'utf8')
    .digest('hex');
}

function notesInquiryCursorHash(source: NotesInquiryResponseFixture): string {
  // Cursor identity deliberately contains only validated source payload. It
  // excludes evidence UUIDs, observed/expiry times, and response bookkeeping.
  return createHash('sha256')
    .update(
      JSON.stringify(
        stableSourceValue({
          noteCategories: source.noteCategories,
          reservationNotes: source.reservationNotes,
          guestProfileNotes: source.guestProfileNotes,
          bookingAgencyNotes: source.bookingAgencyNotes,
          organizationNotes: source.organizationNotes,
          groupBookingNotes: source.groupBookingNotes,
          reservationNote: source.reservationNote,
        }),
      ),
      'utf8',
    )
    .digest('hex');
}

/** Parse response; customer is safe default, staff requires explicit audience. */
export function parseNotesInquiryResponse(
  input: string | unknown,
  options: { audience?: NotesInquiryAudience; limit?: number } = {},
): NotesInquiryParseResult {
  const limit = boundedLimit(options.limit);
  const audience = boundedAudience(options.audience);
  const source = parseSource(input);
  const sourceHash = notesInquirySourceHash(source);
  const cursorHash = notesInquiryCursorHash(source);
  const categoryCodes = new Set<string>();
  for (const category of source.noteCategories) {
    if (categoryCodes.has(category.code)) {
      throw new NotesInquiryParseError('DUPLICATE_CATEGORY');
    }
    categoryCodes.add(category.code);
  }

  const auxiliaryRows: NotesInquirySourceRow[] = [
    ...source.guestProfileNotes,
    ...source.bookingAgencyNotes,
    ...source.organizationNotes,
    ...(source.groupBookingNotes ?? []),
  ];
  // Auxiliary collections have independent source scopes. Validate property,
  // but do not assume their numeric ids share reservationNotes id namespace.
  for (const row of auxiliaryRows) {
    if (row.propertyCode !== NOTES_INQUIRY_EXPECTED_PROPERTY) {
      throw new NotesInquiryParseError('PROPERTY_MISMATCH');
    }
  }
  const rowIds = new Set<number>();
  for (const row of source.reservationNotes) {
    if (rowIds.has(row.id)) throw new NotesInquiryParseError('DUPLICATE_NOTE_ID');
    rowIds.add(row.id);
    if (row.propertyCode !== NOTES_INQUIRY_EXPECTED_PROPERTY) {
      throw new NotesInquiryParseError('PROPERTY_MISMATCH');
    }
  }

  const sourceRows = source.reservationNotes;
  const visibleRows =
    audience === 'staff'
      ? sourceRows
      : sourceRows.filter((row) => row.private === false && row.printOnConfirmation === true);
  const filteredCount = audience === 'customer' ? sourceRows.length - visibleRows.length : 0;
  let maskedCount = 0;
  let emptyCount = 0;
  let longCount = 0;
  let scalarMasked = false;
  let scalarEmpty = false;
  const items: NotesInquiryItem[] = [];

  for (const row of visibleRows) {
    const trimmed = row.note.trim();
    if (isMaskedNote(trimmed)) {
      maskedCount += 1;
      continue;
    }
    if (!trimmed) {
      emptyCount += 1;
      continue;
    }
    const note = trimmed.slice(0, NOTES_INQUIRY_MAX_NOTE_CHARS);
    if (trimmed.length > NOTES_INQUIRY_MAX_NOTE_CHARS) longCount += 1;
    items.push({ ...row, note });
  }

  const allItems = items;
  const pageTruncated = allItems.length > limit;
  const returnedItems = pageTruncated ? allItems.slice(0, limit) : allItems;
  const scalarValue = source.reservationNote.trim();
  const scalarIsMasked = isMaskedNote(scalarValue);
  scalarMasked = audience === 'staff' && scalarIsMasked;
  scalarEmpty = audience === 'staff' && !scalarValue;
  const scalarLong = audience === 'staff' && scalarValue.length > NOTES_INQUIRY_MAX_NOTE_CHARS;
  const allSourceIssues = issueCounts({
    MASKED_NOTE: maskedCount + (scalarMasked ? 1 : 0),
    EMPTY_NOTE: emptyCount + (scalarEmpty ? 1 : 0),
    TRUNCATED: longCount + (scalarLong ? 1 : 0),
  });
  const sourceIssues = allSourceIssues.filter((issue) => issue.code !== 'EMPTY_NOTE');
  const pageIssues = pageTruncated ? [{ code: 'TRUNCATED' as const, count: 1 }] : [];
  const reservationNote: NotesInquiryScalarObservation =
    audience === 'customer'
      ? {
          audience,
          state: 'unavailable',
          reasonCode: 'NOT_APPLICABLE',
          text: null,
          customerPrintable: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
          status: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
          createdAt: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
          sourceLength: scalarValue.length,
          sourceHash: createHash('sha256').update(scalarValue).digest('hex'),
        }
      : scalarMasked
        ? {
            audience,
            state: 'unavailable',
            reasonCode: 'POLICY_UNAPPROVED',
            text: null,
            customerPrintable: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
            status: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
            createdAt: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
            sourceLength: scalarValue.length,
            sourceHash: createHash('sha256').update(scalarValue).digest('hex'),
          }
        : scalarEmpty
          ? {
              audience,
              state: 'unavailable',
              // Empty scalar is an observed, non-value source result. Keep it
              // distinct from a missing/unreadable provider response.
              reasonCode: 'NOT_APPLICABLE',
              text: null,
              customerPrintable: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
              status: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
              createdAt: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
              sourceLength: 0,
              sourceHash: createHash('sha256').update('').digest('hex'),
            }
          : {
              audience,
              state: 'known',
              text: scalarValue.slice(0, NOTES_INQUIRY_MAX_NOTE_CHARS),
              customerPrintable: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
              status: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
              createdAt: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
              sourceLength: scalarValue.length,
              sourceHash: createHash('sha256').update(scalarValue).digest('hex'),
            };
  return {
    audience,
    propertyCode: NOTES_INQUIRY_EXPECTED_PROPERTY,
    sourceHash,
    cursorHash,
    items: returnedItems,
    allItems,
    sourceCount: sourceRows.length,
    filteredCount,
    maskedCount,
    emptyCount,
    reservationNote,
    completeness: sourceIssues.length > 0 ? 'partial' : 'complete',
    sourceCompleteness: sourceIssues.length > 0 ? 'partial' : 'complete',
    sourceIssues,
    page: {
      returnedCount: returnedItems.length,
      // Source exposes no cursor. Do not claim a resumable page when bounded
      // output cut rows; driver may add cursor support only after proof.
      hasMore: pageTruncated || maskedCount > 0 ? null : false,
      nextCursor: null,
    },
    issues: [...allSourceIssues, ...pageIssues],
  };
}

const parentBindingSchema = z
  .object({
    propertyCode: z.literal(NOTES_INQUIRY_EXPECTED_PROPERTY),
    confirmationNumber: z.string().min(1).max(64),
    reservationStayId: z.string().min(1).max(64),
    resourceRef: z.string().min(1).max(128).optional(),
  })
  .strict();

export interface NotesInquiryReadFacade {
  read(input: NotesInquiryReadInput): Promise<NotesInquiryReadResult>;
}

/** Create facade. URL/path fixed internally; no caller-supplied endpoint. */
export function createNotesInquiryReadFacade(
  session: Pick<HmsReadSession, 'origin' | 'page'>,
): NotesInquiryReadFacade {
  return {
    async read(input) {
      const parentBinding = parentBindingSchema.safeParse(input.parentBinding);
      if (!parentBinding.success) {
        throw new HmsRuntimeError('PARENT_MISMATCH', 'HDR/LST parent binding invalid');
      }
      const bound = parentBinding.data;
      const confirmationNumber = input.confirmationNumber ?? bound.confirmationNumber;
      if (confirmationNumber !== bound.confirmationNumber) {
        throw new HmsRuntimeError('PARENT_MISMATCH', 'confirmation does not match HDR/LST binding');
      }
      const postJson = session.page.postJson;
      if (typeof postJson !== 'function') {
        throw new HmsRuntimeError('SOURCE_UNAVAILABLE', 'JSON page adapter unavailable');
      }
      let url: string;
      try {
        url = new URL(NOTES_INQUIRY_READ_PATH, session.origin).toString();
      } catch {
        throw new HmsRuntimeError('SOURCE_UNAVAILABLE', 'session origin invalid');
      }
      const body = await postJson(url, { confirmationNumber });
      let parsed: NotesInquiryParseResult;
      try {
        parsed = parseNotesInquiryResponse(body, {
          audience: input.audience,
          limit: input.limit,
        });
      } catch (error) {
        if (error instanceof NotesInquiryParseError) {
          throw new HmsRuntimeError(
            error.code === 'OVERSIZED_BODY' ? 'SIZE_LIMIT' : 'SCHEMA_DRIFT',
            'notes inquiry response rejected',
          );
        }
        throw error;
      }
      return { ...parsed, parentBinding: bound };
    },
  };
}

export { NOTES_INQUIRY_READ_PATH };
