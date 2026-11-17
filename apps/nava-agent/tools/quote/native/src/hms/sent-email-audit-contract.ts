import { z } from 'zod';

export const SENT_EMAIL_AUDIT_MAX_ROWS = 50;
export const SENT_EMAIL_AUDIT_MAX_DURATION_MS = 5_000;
export const SENT_EMAIL_AUDIT_MAX_BYTES = 64 * 1024;

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const isoTimestamp = z.string().datetime();
const safeCode = z.string().regex(/^[A-Z0-9_-]{1,32}$/);

export const sentEmailAuditRowSchema = z
  .object({
    sentAt: isoTimestamp,
    emailType: z.enum(['transactional', 'report', 'system']),
    subjectClass: z.enum([
      'reservation_confirmation',
      'tax_invoice',
      'statement',
      'other_transactional',
    ]),
    attachmentPresent: z.boolean(),
    reportCode: safeCode.nullable(),
    errorClass: z.enum(['none', 'delivery_error']),
    observedAt: isoTimestamp,
  })
  .strict();

export const sentEmailAuditReadDataSchema = z
  .object({
    scopeClass: z.enum(['reservation', 'account']),
    recipientMatch: z.literal('exact_redacted'),
    rows: z.array(sentEmailAuditRowSchema).max(SENT_EMAIL_AUDIT_MAX_ROWS),
    rowsScanned: z.number().int().min(0).max(SENT_EMAIL_AUDIT_MAX_ROWS),
    bytesObserved: z.number().int().min(0).max(SENT_EMAIL_AUDIT_MAX_BYTES),
    durationMs: z.number().int().min(0).max(SENT_EMAIL_AUDIT_MAX_DURATION_MS),
    observedAt: isoTimestamp,
  })
  .strict();

export type SentEmailAuditReadData = z.infer<typeof sentEmailAuditReadDataSchema>;

type RawSentEmailRow = {
  scopeClass: 'reservation' | 'account';
  scopeHash: string;
  recipient: string;
  sentAt: string;
  emailType: string;
  subject: string;
  attachmentPresent: boolean;
  reportCode: string | null;
  errorClass: string | null;
};

export type SentEmailAuditFixtureInput = {
  scope: {
    class: 'reservation' | 'account';
    exactScopeHash: string;
  };
  expectedRecipient: string;
  rows: RawSentEmailRow[];
  observedAt: string;
  durationMs: number;
  bytesObserved: number;
};

export type SentEmailAuditKernelResult = {
  status: 'ok' | 'unverified_negative' | 'manual_required';
  data: SentEmailAuditReadData;
  blocker: string | null;
};

function classifySubject(subject: string): z.infer<
  typeof sentEmailAuditRowSchema
>['subjectClass'] {
  const normalized = subject.toLowerCase();
  if (/\b(reservation|booking)\b.*\b(confirm|confirmation)\b/.test(normalized)) {
    return 'reservation_confirmation';
  }
  if (/\b(tax\s*)?invoice\b/.test(normalized)) return 'tax_invoice';
  if (/\bstatement\b/.test(normalized)) return 'statement';
  return 'other_transactional';
}

function emptyData(input: SentEmailAuditFixtureInput): SentEmailAuditReadData {
  const scopeClass =
    input.scope.class === 'account' ? ('account' as const) : ('reservation' as const);
  const observedAt = isoTimestamp.safeParse(input.observedAt).success
    ? input.observedAt
    : new Date(0).toISOString();
  return {
    scopeClass,
    recipientMatch: 'exact_redacted',
    rows: [],
    rowsScanned: 0,
    bytesObserved: 0,
    durationMs: 0,
    observedAt,
  };
}

function fail(
  input: SentEmailAuditFixtureInput,
  blocker: string,
): SentEmailAuditKernelResult {
  return { status: 'manual_required', data: emptyData(input), blocker };
}

/**
 * Fixture-only fail-closed parser. Raw recipient and subject exist only in input
 * memory; output schema has no fields capable of carrying either value.
 */
export function parseSentEmailAuditFixture(
  input: SentEmailAuditFixtureInput,
): SentEmailAuditKernelResult {
  if (
    !sha256Hex.safeParse(input.scope.exactScopeHash).success ||
    !isoTimestamp.safeParse(input.observedAt).success ||
    !Number.isInteger(input.durationMs) ||
    !Number.isInteger(input.bytesObserved) ||
    input.durationMs < 0 ||
    input.durationMs > SENT_EMAIL_AUDIT_MAX_DURATION_MS ||
    input.bytesObserved < 0 ||
    input.bytesObserved > SENT_EMAIL_AUDIT_MAX_BYTES ||
    input.rows.length > SENT_EMAIL_AUDIT_MAX_ROWS
  ) {
    return fail(input, 'SENT_EMAIL_AUDIT_BOUNDS_OR_SCOPE_INVALID');
  }

  const expectedRecipient = input.expectedRecipient.trim().toLowerCase();
  if (!expectedRecipient || !expectedRecipient.includes('@')) {
    return fail(input, 'SENT_EMAIL_AUDIT_RECIPIENT_SCOPE_INVALID');
  }

  const rows: SentEmailAuditReadData['rows'] = [];
  for (const raw of input.rows) {
    if (
      raw.scopeClass !== input.scope.class ||
      raw.scopeHash !== input.scope.exactScopeHash
    ) {
      return fail(input, 'SENT_EMAIL_AUDIT_EXACT_SCOPE_MISMATCH');
    }
    if (raw.recipient.trim().toLowerCase() !== expectedRecipient) {
      return fail(input, 'SENT_EMAIL_AUDIT_RECIPIENT_MISMATCH');
    }
    let errorClass: 'none' | 'delivery_error';
    if (raw.errorClass === null) {
      errorClass = 'none';
    } else if (raw.errorClass === 'delivery_error') {
      errorClass = 'delivery_error';
    } else {
      return fail(input, 'SENT_EMAIL_AUDIT_ROW_SCHEMA_DRIFT');
    }
    const row = sentEmailAuditRowSchema.safeParse({
      sentAt: raw.sentAt,
      emailType: raw.emailType,
      subjectClass: classifySubject(raw.subject),
      attachmentPresent: raw.attachmentPresent,
      reportCode: raw.reportCode,
      errorClass,
      observedAt: input.observedAt,
    });
    if (!row.success) return fail(input, 'SENT_EMAIL_AUDIT_ROW_SCHEMA_DRIFT');
    rows.push(row.data);
  }

  const data = sentEmailAuditReadDataSchema.parse({
    scopeClass: input.scope.class,
    recipientMatch: 'exact_redacted',
    rows,
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

export const sentEmailAuditClaimValueSchema = z
  .object({
    scopeClass: z.enum(['reservation', 'account']),
    recipient: z.literal('redacted_exact_match'),
    rows: z.array(sentEmailAuditRowSchema).max(SENT_EMAIL_AUDIT_MAX_ROWS),
    observedAt: isoTimestamp,
  })
  .strict();

export type SentEmailAuditClaimValue = z.infer<
  typeof sentEmailAuditClaimValueSchema
>;

export function mapSentEmailAuditClaim(
  data: SentEmailAuditReadData,
): SentEmailAuditClaimValue {
  const parsed = sentEmailAuditReadDataSchema.parse(data);
  return sentEmailAuditClaimValueSchema.parse({
    scopeClass: parsed.scopeClass,
    recipient: 'redacted_exact_match',
    rows: parsed.rows,
    observedAt: parsed.observedAt,
  });
}
