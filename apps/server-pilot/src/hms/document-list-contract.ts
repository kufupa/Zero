import { z } from 'zod';

export const DOCUMENT_LIST_MAX_ROWS = 50;
export const DOCUMENT_LIST_MAX_DURATION_MS = 5_000;
export const DOCUMENT_LIST_MAX_BYTES = 64 * 1024;

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const isoTimestamp = z.string().datetime();

const documentTypeSchema = z.enum([
  'tax_invoice',
  'reservation_confirmation',
  'statement',
  'other_sent_document',
]);

export const finalizedTaxInvoiceMetadataSchema = z
  .object({
    documentType: z.literal('tax_invoice'),
    status: z.literal('finalized'),
    generatedAt: isoTimestamp,
    sentAt: z.null(),
    sourceClass: z.literal('finalized_tax_invoice'),
    attachmentPresent: z.literal(false),
    retrievable: z.literal(false),
  })
  .strict();

export const sentAttachmentMetadataSchema = z
  .object({
    documentType: documentTypeSchema,
    status: z.literal('sent'),
    generatedAt: z.null(),
    sentAt: isoTimestamp,
    sourceClass: z.literal('sent_email_attachment'),
    attachmentPresent: z.literal(true),
    retrievable: z.literal(false),
  })
  .strict();

export const documentMetadataRowSchema = z.discriminatedUnion('sourceClass', [
  finalizedTaxInvoiceMetadataSchema,
  sentAttachmentMetadataSchema,
]);

export const documentListReadDataSchema = z
  .object({
    sourceClass: z.enum(['finalized_tax_invoice', 'sent_email_attachment']),
    rows: z.array(documentMetadataRowSchema).max(DOCUMENT_LIST_MAX_ROWS),
    inventoryComplete: z.literal(false),
    rowsScanned: z.number().int().min(0).max(DOCUMENT_LIST_MAX_ROWS),
    bytesObserved: z.number().int().min(0).max(DOCUMENT_LIST_MAX_BYTES),
    durationMs: z.number().int().min(0).max(DOCUMENT_LIST_MAX_DURATION_MS),
    observedAt: isoTimestamp,
  })
  .strict()
  .refine(
    (value) => value.rows.every((row) => row.sourceClass === value.sourceClass),
    { message: 'document row sourceClass must match parent sourceClass' },
  );

export type DocumentListReadData = z.infer<typeof documentListReadDataSchema>;

type FinalizedTaxInvoiceInput = {
  sourceClass: 'finalized_tax_invoice';
  exactScopeHash: string;
  observedAt: string;
  durationMs: number;
  bytesObserved: number;
  rows: Array<{
    scopeHash: string;
    status: string;
    generatedAt: string;
  }>;
};

type SentAttachmentInput = {
  sourceClass: 'sent_email_attachment';
  exactScopeHash: string;
  observedAt: string;
  durationMs: number;
  bytesObserved: number;
  rows: Array<{
    scopeHash: string;
    attachmentName: string;
    documentType: string;
    sentAt: string | null;
    attachmentPresent: boolean;
  }>;
};

export type DocumentMetadataFixtureInput =
  | FinalizedTaxInvoiceInput
  | SentAttachmentInput;

export type DocumentMetadataKernelResult = {
  status: 'ok' | 'unverified_negative' | 'manual_required';
  data: DocumentListReadData;
  blocker: string | null;
};

function emptyData(input: DocumentMetadataFixtureInput): DocumentListReadData {
  const observedAt = isoTimestamp.safeParse(input.observedAt).success
    ? input.observedAt
    : new Date(0).toISOString();
  return {
    sourceClass: input.sourceClass,
    rows: [],
    inventoryComplete: false,
    rowsScanned: 0,
    bytesObserved: 0,
    durationMs: 0,
    observedAt,
  };
}

function fail(
  input: DocumentMetadataFixtureInput,
  blocker: string,
): DocumentMetadataKernelResult {
  return { status: 'manual_required', data: emptyData(input), blocker };
}

function classifyDocumentType(
  value: string,
): z.infer<typeof documentTypeSchema> | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'tax_invoice') return 'tax_invoice';
  if (normalized === 'reservation_confirmation') {
    return 'reservation_confirmation';
  }
  if (normalized === 'statement') return 'statement';
  if (normalized === 'other_sent_document') return 'other_sent_document';
  return null;
}

/**
 * Fixture-only metadata parser. Source class is caller-explicit and closed.
 * Attachment names are accepted only as private source input and never copied.
 */
export function parseDocumentMetadataFixture(
  input: DocumentMetadataFixtureInput,
): DocumentMetadataKernelResult {
  if (
    !sha256Hex.safeParse(input.exactScopeHash).success ||
    !isoTimestamp.safeParse(input.observedAt).success ||
    !Number.isInteger(input.durationMs) ||
    !Number.isInteger(input.bytesObserved) ||
    input.durationMs < 0 ||
    input.durationMs > DOCUMENT_LIST_MAX_DURATION_MS ||
    input.bytesObserved < 0 ||
    input.bytesObserved > DOCUMENT_LIST_MAX_BYTES ||
    input.rows.length > DOCUMENT_LIST_MAX_ROWS
  ) {
    return fail(input, 'DOCUMENT_LIST_BOUNDS_OR_SCOPE_INVALID');
  }

  const rows: DocumentListReadData['rows'] = [];
  if (input.sourceClass === 'finalized_tax_invoice') {
    for (const raw of input.rows) {
      if (raw.scopeHash !== input.exactScopeHash) {
        return fail(input, 'DOCUMENT_LIST_EXACT_SCOPE_MISMATCH');
      }
      if (raw.status !== 'finalized') {
        return fail(input, 'DOCUMENT_LIST_NON_FINAL_INVOICE_REJECTED');
      }
      const row = finalizedTaxInvoiceMetadataSchema.safeParse({
        documentType: 'tax_invoice',
        status: 'finalized',
        generatedAt: raw.generatedAt,
        sentAt: null,
        sourceClass: 'finalized_tax_invoice',
        attachmentPresent: false,
        retrievable: false,
      });
      if (!row.success) return fail(input, 'DOCUMENT_LIST_ROW_SCHEMA_DRIFT');
      rows.push(row.data);
    }
  } else {
    for (const raw of input.rows) {
      if (raw.scopeHash !== input.exactScopeHash) {
        return fail(input, 'DOCUMENT_LIST_EXACT_SCOPE_MISMATCH');
      }
      const documentType = classifyDocumentType(raw.documentType);
      if (
        !raw.attachmentPresent ||
        raw.sentAt === null ||
        !documentType ||
        raw.attachmentName.trim().length === 0
      ) {
        return fail(input, 'DOCUMENT_LIST_UNSENT_OR_UNKNOWN_ATTACHMENT_REJECTED');
      }
      const row = sentAttachmentMetadataSchema.safeParse({
        documentType,
        status: 'sent',
        generatedAt: null,
        sentAt: raw.sentAt,
        sourceClass: 'sent_email_attachment',
        attachmentPresent: true,
        retrievable: false,
      });
      if (!row.success) return fail(input, 'DOCUMENT_LIST_ROW_SCHEMA_DRIFT');
      rows.push(row.data);
    }
  }

  const data = documentListReadDataSchema.parse({
    sourceClass: input.sourceClass,
    rows,
    inventoryComplete: false,
    rowsScanned: input.rows.length,
    bytesObserved: input.bytesObserved,
    durationMs: input.durationMs,
    observedAt: input.observedAt,
  });
  return {
    status: rows.length === 0 ? 'unverified_negative' : 'ok',
    data,
    blocker: rows.length === 0 ? 'UNVERIFIED_NEGATIVE' : null,
  };
}

export const documentMetadataClaimValueSchema = z
  .object({
    sourceClass: z.enum(['finalized_tax_invoice', 'sent_email_attachment']),
    rows: z.array(documentMetadataRowSchema).max(DOCUMENT_LIST_MAX_ROWS),
    inventoryComplete: z.literal(false),
    deliveryCredit: z.literal('partial_metadata_only'),
    observedAt: isoTimestamp,
  })
  .strict();

export type DocumentMetadataClaimValue = z.infer<
  typeof documentMetadataClaimValueSchema
>;

export function mapDocumentMetadataClaim(
  data: DocumentListReadData,
): DocumentMetadataClaimValue {
  const parsed = documentListReadDataSchema.parse(data);
  return documentMetadataClaimValueSchema.parse({
    sourceClass: parsed.sourceClass,
    rows: parsed.rows,
    inventoryComplete: false,
    deliveryCredit: 'partial_metadata_only',
    observedAt: parsed.observedAt,
  });
}
