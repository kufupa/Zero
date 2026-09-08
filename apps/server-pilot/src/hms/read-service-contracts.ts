/**
 * Closed, model-independent contracts shared by the U8 read executor and its
 * proof/receipt callers.  Browser locators, URLs and credentials deliberately
 * do not have a representation in these schemas.
 */
import {
  documentsListExistingInputSchema,
  documentsReadExistingInputSchema,
} from '../mail/artifacts/existing-document-contracts.js';
import { quoteRequestSchema } from './quote-request-normalization.js';
import { quoteStayReadDataSchema } from './quote-stay-contract.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const readRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'expected opaque read reference');
export type ReadRef = z.infer<typeof readRefSchema>;

export const readTimestampSchema = z.string().datetime({ offset: true });

const readDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * Trusted worker-side admission binding. It is carried beside (never inside
 * model-visible) request fields and is checked before any external read.
 */
export const readAdmissionSchema = z
  .object({
    releaseId: readRefSchema,
    requestBranchId: z.string().min(1).max(128),
    requesterAuthorizationId: readRefSchema,
    inputDigest: readDigestSchema,
    captureRequired: z.boolean(),
    captureBindingRef: readRefSchema.nullable(),
    /** Server-minted reservation reference for resolved-context reads. */
    reservationRef: readRefSchema.nullable(),
    /** Issuance window carried by the trusted reservation admission. */
    reservationRefIssuedAt: readTimestampSchema.nullable(),
    reservationRefExpiresAt: readTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.captureRequired && value.captureBindingRef === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['captureBindingRef'],
        message: 'capture binding is required for this read admission',
      });
    }
    const hasReservationRef = value.reservationRef !== null;
    const hasIssuanceWindow =
      value.reservationRefIssuedAt !== null && value.reservationRefExpiresAt !== null;
    if (hasReservationRef !== hasIssuanceWindow) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reservationRef'],
        message: 'reservation reference issuance window must match the reference',
      });
    }
    if (hasIssuanceWindow) {
      const issuedAt = Date.parse(value.reservationRefIssuedAt!);
      const expiresAt = Date.parse(value.reservationRefExpiresAt!);
      if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reservationRefExpiresAt'],
          message: 'reservation reference expiry must follow issuance',
        });
      }
    }
  });
export type ReadAdmission = z.infer<typeof readAdmissionSchema>;

/** Closed normal-executor request branches for existing documents. */
export const documentsListReadRequestSchema = documentsListExistingInputSchema
  .extend({
    toolId: z.literal('documents_list_existing'),
    admission: readAdmissionSchema.optional(),
  })
  .strict();
export type DocumentsListReadRequest = z.infer<typeof documentsListReadRequestSchema>;

export const documentsReadReadRequestSchema = documentsReadExistingInputSchema
  .extend({
    toolId: z.literal('documents_read_existing'),
    admission: readAdmissionSchema.optional(),
  })
  .strict();
export type DocumentsReadReadRequest = z.infer<typeof documentsReadReadRequestSchema>;

/** Closed finance sections; selectors never expose PMS URLs or locators. */
export const folioReadSectionIdSchema = z.enum([
  'balance',
  'deposits',
  'transactions',
  'authorization',
]);

export const folioReadRequestSchema = z
  .object({
    toolId: z.literal('hms_read_folio'),
    reservationRef: readRefSchema,
    candidateId: readRefSchema,
    sections: z
      .array(folioReadSectionIdSchema)
      .min(1)
      .max(4)
      .default(['balance', 'deposits'])
      .refine((sections) => new Set(sections).size === sections.length, {
        message: 'folio sections must be unique',
      }),
    admission: readAdmissionSchema.optional(),
  })
  .strict();
export type FolioReadRequest = z.infer<typeof folioReadRequestSchema>;

/** Closed quote request issued by the trusted producer before queueing. */
export const quoteStayReadRequestSchema = z
  .object({
    toolId: z.literal('hms_quote_stay'),
    quoteRequestRef: readRefSchema,
    quoteRequest: quoteRequestSchema,
    detail: z.enum(['summary', 'detail']).default('summary'),
    admission: readAdmissionSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.quoteRequest.quoteRequestRef !== value.quoteRequestRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quoteRequestRef'],
        message: 'quote request reference must match the normalized request',
      });
    }
  });
export type QuoteStayReadRequest = z.infer<typeof quoteStayReadRequestSchema>;

/** Persisted server-side proof that a context admission was issued for this scope. */
export const readReservationBindingSchema = z
  .object({
    transportId: readRefSchema,
    threadId: readRefSchema,
    triggerMessageId: readRefSchema,
    candidateId: readRefSchema,
    reservationRef: readRefSchema,
    reservationRefIssuedAt: readTimestampSchema,
    reservationRefExpiresAt: readTimestampSchema,
  })
  .strict();
export type ReadReservationBinding = z.infer<typeof readReservationBindingSchema>;

function sortDigestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDigestValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortDigestValue(child)]),
  );
}

/** Stable private digest for the exact closed request, excluding admission. */
export function readInputDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortDigestValue(value)), 'utf8')
    .digest('hex');
}

/**
 * Derive the server-owned context reference from the exact mail scope and
 * opaque candidate. A candidate can recur in another thread; the scope bind
 * prevents that otherwise-valid reference from being replayed there.
 */
export function readReservationRef(input: {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  candidateId: string;
  reservationRefExpiresAt: string;
}): ReadRef {
  return readRefSchema.parse(
    createHash('sha256')
      .update(
        JSON.stringify([
          'hms-read-reservation/v1',
          input.transportId,
          input.threadId,
          input.triggerMessageId,
          input.candidateId,
          input.reservationRefExpiresAt,
        ]),
        'utf8',
      )
      .digest('hex'),
  );
}

export const readLocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const readReasonCodeSchema = z.enum([
  'INPUT_MISSING',
  'INVALID_INPUT',
  'SCOPE_DENIED',
  'REF_EXPIRED',
  'AMBIGUOUS_IDENTITY',
  'ROLE_UNAVAILABLE',
  'SURFACE_UNPROVEN',
  'STALE_EVIDENCE',
  'PARTIAL_WINDOW',
  'TRUNCATED',
  'SIZE_LIMIT',
  'TIMEOUT',
  'SOURCE_UNAVAILABLE',
  'UNSUPPORTED_FORMAT',
  'DOCUMENT_CHANGED',
  'POLICY_UNAPPROVED',
  'INCOMPLETE_QUOTE',
  'UNVERIFIED_NEGATIVE',
  'READ_EFFECT_BLOCKED',
  'NOT_REQUESTED',
  'NOT_APPLICABLE',
]);
export type ReadReasonCode = z.infer<typeof readReasonCodeSchema>;

export const readIssueSchema = z
  .object({
    code: readReasonCodeSchema,
    retryable: z.boolean(),
    safeNextAction: z.enum(['retry_same_read', 'request_input', 'manual_review', 'none']),
  })
  .strict();
export type ReadIssue = z.infer<typeof readIssueSchema>;

export const readEvidenceSchema = z
  .object({
    evidenceRef: readRefSchema,
    sourceSystem: z.enum(['hms', 'mail', 'approved_property_document']),
    sourceSurface: z.string().min(1).max(128),
    requestBranchId: z.string().min(1).max(128),
    observedAt: readTimestampSchema,
    sourceUpdatedAt: readTimestampSchema.nullable(),
    expiresAt: readTimestampSchema,
    scopeVerified: z.boolean(),
    artifactRef: readRefSchema.nullable(),
  })
  .strict();
export type ReadEvidence = z.infer<typeof readEvidenceSchema>;

export const readPageSchema = z
  .object({
    returnedCount: z.number().int().nonnegative(),
    hasMore: z.boolean().nullable(),
    nextCursor: readRefSchema.nullable(),
  })
  .strict();
export type ReadPage = z.infer<typeof readPageSchema>;

export const readFactKnownSchema = z
  .object({
    state: z.literal('known'),
    value: z.unknown(),
    // `data` is retained as a read-only compatibility alias for callers that
    // render a fact directly; `value` remains canonical for typed consumers.
    data: z.unknown().optional(),
    evidenceRef: readRefSchema,
    observedAt: readTimestampSchema,
    sourceUpdatedAt: readTimestampSchema.nullable(),
    expiresAt: readTimestampSchema,
  })
  .strict();

export const readFactUnknownSchema = z
  .object({
    state: z.enum(['unknown', 'not_authorized', 'not_applicable', 'not_requested', 'stale']),
    value: z.null(),
    data: z.null().optional(),
    reasonCode: readReasonCodeSchema,
    evidenceRef: readRefSchema.nullable(),
    observedAt: readTimestampSchema.nullable(),
    sourceUpdatedAt: readTimestampSchema.nullable(),
    expiresAt: readTimestampSchema.nullable(),
  })
  .strict();

export const readFactSchema = z.union([readFactKnownSchema, readFactUnknownSchema]);
export type ReadFact<T> =
  | {
      state: 'known';
      value: T;
      data: T;
      evidenceRef: ReadRef;
      observedAt: string;
      sourceUpdatedAt: string | null;
      expiresAt: string;
    }
  | {
      state: 'unknown' | 'not_authorized' | 'not_applicable' | 'not_requested' | 'stale';
      value: null;
      data: null;
      reasonCode: ReadReasonCode;
      evidenceRef: ReadRef | null;
      observedAt: string | null;
      sourceUpdatedAt: string | null;
      expiresAt: string | null;
    };

export const readSectionAvailableSchema = z
  .object({
    state: z.enum(['available', 'partial']),
    data: z.unknown(),
    completeness: z.enum(['complete', 'partial', 'unknown']),
    issues: z.array(readIssueSchema),
  })
  .strict();

export const readSectionUnavailableSchema = z
  .object({
    state: z.enum(['unavailable', 'not_requested']),
    data: z.null(),
    reasonCode: readReasonCodeSchema,
    issues: z.array(readIssueSchema),
  })
  .strict();

export const readSectionSchema = z.union([
  readSectionAvailableSchema,
  readSectionUnavailableSchema,
]);
export type ReadSection<T> =
  | {
      state: 'available' | 'partial';
      data: T;
      completeness: 'complete' | 'partial' | 'unknown';
      issues: ReadIssue[];
    }
  | {
      state: 'unavailable' | 'not_requested';
      data: null;
      reasonCode: ReadReasonCode;
      issues: ReadIssue[];
    };

const readFolioMoneyValueSchema = z
  .object({
    amount: z.string().regex(/^-?\d+(?:\.\d+)?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    basis: z.enum(['ledger_balance', 'ledger_movement']),
    taxTreatment: z.literal('unknown'),
  })
  .strict();

const readFolioMoneyFactSchema = z.union([
  z
    .object({
      state: z.literal('known'),
      value: readFolioMoneyValueSchema,
      data: readFolioMoneyValueSchema,
      evidenceRef: readRefSchema,
      observedAt: readTimestampSchema,
      sourceUpdatedAt: readTimestampSchema.nullable(),
      expiresAt: readTimestampSchema,
    })
    .strict(),
  readFactUnknownSchema,
]);

const readFolioBalanceDataSchema = z
  .object({
    items: z.array(
      z
        .object({
          folioRef: readFactSchema,
          folioType: readFactSchema,
          balance: readFolioMoneyFactSchema,
        })
        .strict(),
    ),
  })
  .strict();

const readFolioDepositDataSchema = z
  .object({
    items: z.array(
      z
        .object({
          due: readFolioMoneyFactSchema,
          paid: readFolioMoneyFactSchema,
          refunded: readFolioMoneyFactSchema,
          forfeited: readFolioMoneyFactSchema,
          transferred: readFolioMoneyFactSchema,
          untransferred: readFolioMoneyFactSchema,
        })
        .strict(),
    ),
  })
  .strict();

const readFolioSectionDataSchema = z.union([
  readFolioBalanceDataSchema,
  readFolioDepositDataSchema,
]);

/** Finance sections are closed at the receipt boundary, not merely top-level objects. */
export const readFolioSectionSchema = z.union([
  z
    .object({
      state: z.enum(['available', 'partial']),
      data: readFolioSectionDataSchema,
      completeness: z.enum(['complete', 'partial', 'unknown']),
      issues: z.array(readIssueSchema),
    })
    .strict(),
  readSectionUnavailableSchema,
]);

const readFolioCurrencySchema = z.string().regex(/^[A-Z]{3}$/);
const readFolioSignedMoneySchema = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/);
const readFolioUnsignedMoneySchema = z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/);
const readFolioDepositAmountSchema = z
  .object({
    amount: readFolioUnsignedMoneySchema,
    status: z.enum([
      'due',
      'none_due',
      'paid',
      'none_paid',
      'refunded',
      'none_refunded',
      'forfeited',
      'none_forfeited',
      'transferred',
      'none_transferred',
    ]),
  })
  .strict();
const readFolioDepositSummarySchema = z
  .object({
    total: readFolioUnsignedMoneySchema,
    due: readFolioDepositAmountSchema,
    paid: readFolioDepositAmountSchema,
    refunded: readFolioDepositAmountSchema,
    forfeited: readFolioDepositAmountSchema,
    transferred: readFolioDepositAmountSchema,
  })
  .strict();

/** Closed finance payload used by the outer receipt schema for hms_read_folio. */
export const readFolioDataSchema = z
  .object({
    reservationBinding: z.literal('exact_parent_redacted'),
    guestPrivacy: z.literal('identity_redacted'),
    currency: readFolioCurrencySchema,
    totalBalance: readFolioSignedMoneySchema.optional(),
    depositSummary: readFolioDepositSummarySchema.optional(),
    balance: readFolioSectionSchema.optional(),
    deposits: readFolioSectionSchema.optional(),
    transactions: readFolioSectionSchema.optional(),
    liabilityLocation: readFactSchema.optional(),
    authorization: readFactSchema.optional(),
    disclosure: z
      .object({
        recipientClass: z.enum([
          'reservation_guest',
          'authorized_booking_contact',
          'internal_finance',
          'third_party',
          'unknown',
        ]),
        inquiryClass: z.enum([
          'labelled_narrow_status',
          'refund_request',
          'settlement_request',
          'invoice_request',
          'other',
        ]),
        claimEligibility: z.enum(['full', 'partial', 'blocked']),
      })
      .strict(),
    rowsScanned: z.number().int().min(0).max(50),
    bytesObserved: z
      .number()
      .int()
      .min(0)
      .max(64 * 1024),
    durationMs: z.number().int().min(0).max(5_000),
    observedAt: readTimestampSchema,
  })
  .strict();

export const readStatusSchema = z.enum([
  'ok',
  'partial',
  'not_found',
  'unverified_negative',
  'ambiguous',
  'manual_required',
]);
export type ReadStatus = z.infer<typeof readStatusSchema>;

export const readToolResultIdSchema = z.enum([
  'hms_find_reservation',
  'hms_read_reservation',
  'documents_list_existing',
  'documents_read_existing',
  'hms_read_folio',
  'hms_quote_stay',
]);
export type ReadToolResultId = z.infer<typeof readToolResultIdSchema>;

const readResultDataSchema = z.unknown().nullable();

const readResultSchemaBase = z
  .object({
    toolId: readToolResultIdSchema,
    schemaVersion: z.string().min(1),
    status: readStatusSchema,
    data: readResultDataSchema,
    completeness: z.enum(['complete', 'partial', 'unknown']),
    unavailableSections: z.array(
      z.object({ section: z.string().min(1), reasonCode: readReasonCodeSchema }).strict(),
    ),
    scopeRef: readRefSchema,
    evidence: z.array(readEvidenceSchema),
    page: readPageSchema.nullable(),
    issues: z.array(readIssueSchema),
  })
  .strict();

const readResultSchemaBoundary = readResultSchemaBase.superRefine((value, context) => {
  if (
    value.toolId === 'hms_read_folio' &&
    value.data !== null &&
    !readFolioDataSchema.safeParse(value.data).success
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['data'],
      message: 'hms_read_folio result data is not a closed finance payload',
    });
  }
  if (value.toolId === 'hms_quote_stay' && value.data !== null) {
    if (!quoteStayReadDataSchema.safeParse(value.data).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['data'],
        message: 'hms_quote_stay result data is not a closed quote payload',
      });
    }
  }
});

/**
 * Reservation result schemas extend the shared object shape and replace its
 * data branch. Keep that object API while applying the finance discriminator
 * whenever the generic boundary itself parses a result.
 */
export const readResultSchema = Object.assign(readResultSchemaBoundary, {
  extend: readResultSchemaBase.extend.bind(readResultSchemaBase),
});
export type ReadResult<T> = Omit<z.infer<typeof readResultSchema>, 'data'> & { data: T | null };

export const readMoneySchema = z
  .object({
    amount: z.string().regex(/^-?\d+(?:\.\d+)?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    basis: z.enum([
      'per_room_per_night',
      'per_person',
      'per_stay',
      'per_item',
      'ledger_balance',
      'ledger_movement',
      'other',
      'unknown',
    ]),
    taxTreatment: z.enum(['inclusive', 'exclusive', 'mixed', 'not_applicable', 'unknown']),
  })
  .strict();

export function knownFact<T>(input: {
  value: T;
  evidenceRef: string;
  observedAt: Date | string;
  sourceUpdatedAt?: Date | string | null;
  expiresAt: Date | string;
}): ReadFact<T> {
  const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);
  return {
    state: 'known',
    value: input.value,
    data: input.value,
    evidenceRef: readRefSchema.parse(input.evidenceRef),
    observedAt: iso(input.observedAt),
    sourceUpdatedAt: input.sourceUpdatedAt == null ? null : iso(input.sourceUpdatedAt),
    expiresAt: iso(input.expiresAt),
  };
}

export function unknownFact(input: {
  state?: 'unknown' | 'not_authorized' | 'not_applicable' | 'not_requested' | 'stale';
  reasonCode: ReadReasonCode;
  evidenceRef?: string | null;
  observedAt?: Date | string | null;
  sourceUpdatedAt?: Date | string | null;
  expiresAt?: Date | string | null;
}): ReadFact<never> {
  const iso = (value: Date | string | null | undefined) =>
    value == null ? null : value instanceof Date ? value.toISOString() : value;
  return {
    state: input.state ?? 'unknown',
    value: null,
    data: null,
    reasonCode: input.reasonCode,
    evidenceRef: input.evidenceRef ?? null,
    observedAt: iso(input.observedAt),
    sourceUpdatedAt: iso(input.sourceUpdatedAt),
    expiresAt: iso(input.expiresAt),
  };
}

export function readIssue(
  code: ReadReasonCode,
  safeNextAction: ReadIssue['safeNextAction'] = 'manual_review',
  retryable = false,
): ReadIssue {
  return { code, retryable, safeNextAction };
}
