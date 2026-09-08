import { z } from 'zod';

/**
 * Existing-document reads are deliberately separate from the legacy HMS
 * metadata result. A document ref is an opaque server-issued handle; source
 * records, mailbox IDs, object keys, and URLs never cross this boundary.
 */

export const EXISTING_DOCUMENT_MAX_LIMIT = 50;
export const EXISTING_DOCUMENT_MAX_CURSOR_BYTES = 256;
export const EXISTING_DOCUMENT_MAX_TEXT_BYTES = 256 * 1024;
export const EXISTING_DOCUMENT_ARTIFACT_TTL_MS = 5 * 60 * 1000;

const opaqueRefPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const sha256Pattern = /^[a-f0-9]{64}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const safeDateOrTimestamp = z
  .string()
  .refine((value) => datePattern.test(value) || !Number.isNaN(Date.parse(value)), {
    message: 'expected an ISO date or timestamp',
  });

export const existingDocumentRefSchema = z
  .string()
  .regex(opaqueRefPattern, 'invalid opaque document reference')
  .max(EXISTING_DOCUMENT_MAX_CURSOR_BYTES);

export const documentSourceSchema = z.enum([
  'mail_attachment',
  'hms_sent_attachment',
  'hms_finalized_document',
  'approved_property_document',
]);

export const documentKindSchema = z.enum([
  'reservation_confirmation',
  'tax_invoice',
  'pro_forma',
  'folio',
  'statement',
  'contract',
  'supplier_compliance',
  'property_information',
  'other_existing',
]);

export const documentStatusSchema = z.enum([
  'draft',
  'final',
  'sent',
  'void',
  'cancelled',
  'unknown',
]);

export const documentPriceVisibilitySchema = z.enum(['visible', 'hidden', 'unknown']);

export const documentRetrievalBlockerSchema = z.string().min(1).max(128);

export const documentMetadataSchema = z
  .object({
    documentRef: existingDocumentRefSchema.nullable(),
    source: documentSourceSchema,
    kind: documentKindSchema,
    version: z.string().min(1).max(128),
    issuedAt: safeDateOrTimestamp.nullable(),
    status: documentStatusSchema,
    parentRef: existingDocumentRefSchema.nullable(),
    payerRef: existingDocumentRefSchema.nullable(),
    displayName: z.string().min(1).max(128).nullable(),
    mime: z.string().min(1).max(128).nullable(),
    sizeBytes: z
      .number()
      .int()
      .min(0)
      .max(20 * 1024 * 1024)
      .nullable(),
    sha256: z.string().regex(sha256Pattern).nullable(),
    retrievable: z.boolean(),
    retrievalBlocker: documentRetrievalBlockerSchema.nullable(),
    priceVisibility: documentPriceVisibilitySchema,
    propertyRef: z.string().min(1).max(256),
    guestRef: existingDocumentRefSchema.nullable(),
    stayStart: z.string().regex(datePattern).nullable(),
    stayEnd: z.string().regex(datePattern).nullable(),
    currentVersion: z.boolean(),
  })
  .strict();

export type DocumentMetadata = z.infer<typeof documentMetadataSchema>;
export type DocumentSource = z.infer<typeof documentSourceSchema>;
export type DocumentKind = z.infer<typeof documentKindSchema>;

export const existingDocumentScopeSchema = z
  .object({
    scopeRef: existingDocumentRefSchema,
    propertyRef: z.string().min(1).max(256),
    guestRef: existingDocumentRefSchema.nullable().optional(),
    stayStart: z.string().regex(datePattern).nullable().optional(),
    stayEnd: z.string().regex(datePattern).nullable().optional(),
    payerRef: existingDocumentRefSchema.nullable().optional(),
    requestedKind: documentKindSchema.nullable().optional(),
    requestedPriceVisibility: z.enum(['allowed', 'forbidden', 'unknown']).optional(),
  })
  .strict();

export type ExistingDocumentScope = z.infer<typeof existingDocumentScopeSchema>;

export const documentValidationSchema = z
  .object({
    identity: z.enum(['match', 'mismatch', 'unknown']),
    stayDates: z.enum(['match', 'mismatch', 'unknown']),
    payer: z.enum(['match', 'mismatch', 'unknown']),
    kind: z.enum(['match', 'mismatch', 'unknown']),
    version: z.enum(['current', 'superseded', 'unknown']),
    priceVisibility: z.enum(['allowed', 'forbidden', 'unknown']),
  })
  .strict();

export type DocumentValidation = z.infer<typeof documentValidationSchema>;

function compareNullable(
  expected: string | null | undefined,
  actual: string | null | undefined,
): 'match' | 'mismatch' | 'unknown' {
  if (expected == null || actual == null) return 'unknown';
  return expected === actual ? 'match' : 'mismatch';
}

/**
 * Evaluate every scope constraint independently. Missing source fields stay
 * unknown; they are never upgraded to a match merely because the other side
 * is also missing.
 */
export function evaluateDocumentValidation(input: {
  document: DocumentMetadata;
  scope: ExistingDocumentScope;
}): DocumentValidation {
  const identity =
    input.document.propertyRef !== input.scope.propertyRef
      ? 'mismatch'
      : compareNullable(input.scope.guestRef, input.document.guestRef);

  const stayDates =
    input.scope.stayStart == null ||
    input.scope.stayEnd == null ||
    input.document.stayStart == null ||
    input.document.stayEnd == null
      ? 'unknown'
      : input.scope.stayStart === input.document.stayStart &&
          input.scope.stayEnd === input.document.stayEnd
        ? 'match'
        : 'mismatch';

  const payer = compareNullable(input.scope.payerRef, input.document.payerRef);
  const kind =
    input.scope.requestedKind == null
      ? 'match'
      : input.scope.requestedKind === input.document.kind
        ? 'match'
        : 'mismatch';
  const version = input.document.currentVersion ? 'current' : 'superseded';

  let priceVisibility: DocumentValidation['priceVisibility'];
  if (input.scope.requestedPriceVisibility === 'unknown') {
    priceVisibility = 'unknown';
  } else if (
    input.scope.requestedPriceVisibility === 'forbidden' &&
    input.document.priceVisibility === 'visible'
  ) {
    priceVisibility = 'forbidden';
  } else if (
    input.scope.requestedPriceVisibility == null ||
    input.document.priceVisibility === 'unknown'
  ) {
    priceVisibility = 'unknown';
  } else {
    priceVisibility = 'allowed';
  }

  return documentValidationSchema.parse({
    identity,
    stayDates,
    payer,
    kind,
    version,
    priceVisibility,
  });
}

/** A byte read is usable only after every required scope check is explicit. */
export function documentValidationIsUsable(validation: DocumentValidation): boolean {
  return (
    validation.identity === 'match' &&
    validation.stayDates === 'match' &&
    validation.payer === 'match' &&
    validation.kind === 'match' &&
    validation.version === 'current' &&
    validation.priceVisibility === 'allowed'
  );
}

export function documentValidationBlocker(validation: DocumentValidation): string | null {
  if (validation.identity === 'mismatch') return 'DOCUMENT_IDENTITY_MISMATCH';
  if (validation.stayDates === 'mismatch') return 'DOCUMENT_STAY_DATES_MISMATCH';
  if (validation.payer === 'mismatch') return 'DOCUMENT_PAYER_MISMATCH';
  if (validation.kind === 'mismatch') return 'DOCUMENT_KIND_MISMATCH';
  if (validation.version === 'superseded') return 'DOCUMENT_VERSION_SUPERSEDED';
  if (validation.priceVisibility === 'forbidden') {
    return 'PRICE_VISIBILITY_FORBIDDEN';
  }
  if (
    validation.identity === 'unknown' ||
    validation.stayDates === 'unknown' ||
    validation.payer === 'unknown' ||
    validation.kind === 'unknown' ||
    validation.version === 'unknown' ||
    validation.priceVisibility === 'unknown'
  ) {
    return 'DOCUMENT_VALIDATION_INCOMPLETE';
  }
  return null;
}

export const documentsListExistingInputSchema = z
  .object({
    scopeRef: existingDocumentRefSchema,
    source: documentSourceSchema,
    kinds: z.array(documentKindSchema).max(documentKindSchema.options.length).optional(),
    limit: z.number().int().min(1).max(EXISTING_DOCUMENT_MAX_LIMIT).optional(),
    cursor: existingDocumentRefSchema.optional(),
    requestedPriceVisibility: z.enum(['allowed', 'forbidden', 'unknown']).optional(),
  })
  .strict();

export type DocumentsListExistingInput = z.infer<typeof documentsListExistingInputSchema>;

export const documentsReadExistingInputSchema = z
  .object({
    documentRef: existingDocumentRefSchema,
    format: z.enum(['text', 'artifact']),
  })
  .strict();

export type DocumentsReadExistingInput = z.infer<typeof documentsReadExistingInputSchema>;

export const documentIssueSchema = z
  .object({
    code: z.string().min(1).max(128),
    field: z.string().min(1).max(128).nullable().optional(),
    detail: z.string().min(1).max(256).nullable().optional(),
  })
  .strict();

export type DocumentIssue = z.infer<typeof documentIssueSchema>;

export const documentSourceOutcomeSchema = z
  .object({
    source: documentSourceSchema,
    status: z.enum(['ok', 'partial', 'unavailable']),
    issues: z.array(documentIssueSchema).max(32),
  })
  .strict();

export type DocumentSourceOutcome = z.infer<typeof documentSourceOutcomeSchema>;

const pageSchema = z
  .object({
    returnedCount: z.number().int().min(0).max(EXISTING_DOCUMENT_MAX_LIMIT),
    hasMore: z.boolean(),
    nextCursor: existingDocumentRefSchema.nullable(),
  })
  .strict();

export const existingDocumentListDataSchema = z
  .object({
    documents: z.array(documentMetadataSchema).max(EXISTING_DOCUMENT_MAX_LIMIT),
    page: pageSchema,
    sourceOutcomes: z.array(documentSourceOutcomeSchema).max(8),
  })
  .strict();

export type ExistingDocumentListData = z.infer<typeof existingDocumentListDataSchema>;

export const extractionStateSchema = z.enum(['complete', 'partial', 'unsupported']);

export const existingDocumentReadDataSchema = z
  .object({
    document: documentMetadataSchema,
    artifactRef: existingDocumentRefSchema.nullable(),
    text: z.string().max(EXISTING_DOCUMENT_MAX_TEXT_BYTES).nullable(),
    extractionState: extractionStateSchema,
    pageCount: z.number().int().min(0).nullable(),
    validation: documentValidationSchema,
    format: z.enum(['text', 'artifact']),
    sourceHash: z.string().regex(sha256Pattern).nullable(),
    artifactExpiresAt: safeDateOrTimestamp.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.artifactRef !== null && value.text !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'artifact and text are exclusive' });
    }
    if (value.format === 'text' && value.artifactRef !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'text format cannot return artifact ref',
      });
    }
    if (value.format === 'artifact' && value.text !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'artifact format cannot return text' });
    }
  });

export type ExistingDocumentReadData = z.infer<typeof existingDocumentReadDataSchema>;

export const existingDocumentListResultSchema = z
  .object({
    status: z.enum(['ok', 'partial', 'unverified_negative', 'manual_required']),
    data: existingDocumentListDataSchema.nullable(),
    blocker: z.string().min(1).max(128).nullable(),
    issues: z.array(documentIssueSchema).max(32),
  })
  .strict();

export type ExistingDocumentListResult = z.infer<typeof existingDocumentListResultSchema>;

export const existingDocumentReadResultSchema = z
  .object({
    status: z.enum(['ok', 'partial', 'manual_required']),
    data: existingDocumentReadDataSchema.nullable(),
    blocker: z.string().min(1).max(128).nullable(),
    issues: z.array(documentIssueSchema).max(32),
  })
  .strict();

export type ExistingDocumentReadResult = z.infer<typeof existingDocumentReadResultSchema>;
