import {
  readFactSchema,
  readFolioSectionSchema,
  readFolioTransactionsSectionSchema,
  READ_SERVICE_MAX_DURATION_MS,
  validateFolioTransactionCurrencies,
  type ReadFact,
  type ReadSection,
} from './read-service-contracts.js';
import { z } from 'zod';

export const FOLIO_READ_MAX_ROWS = 50;
/** Total source rows reported by one bounded base-FOL + All Folios read. */
export const FOLIO_READ_MAX_TOTAL_ROWS = 250;
/**
 * Bound for the authenticated FOL source response.  This is deliberately
 * separate from any UI/capture transport cap: the reviewed FOL response is
 * about 85 KiB before its bounded transaction rows are projected.
 */
export const FOLIO_READ_MAX_BYTES = 256 * 1024;
export const FOLIO_READ_MAX_DURATION_MS = 5_000;
/** Bound-folio multi-read receipt cap; legacy paths remain five seconds. */
export const FOLIO_BOUND_READ_MAX_DURATION_MS = READ_SERVICE_MAX_DURATION_MS;
export const FOLIO_READ_MAX_SOURCE_AGE_MS = 5 * 60 * 1_000;

export const FOLIO_READ_PRIVACY_POLICY = {
  allowedSurfaces: ['Folio', 'Deposit Ledger'],
  deniedData: [
    'card_number',
    'virtual_card_number',
    'payment_credential',
    'bank_account',
    'transaction_free_text',
    'line_item',
  ],
  deniedActions: [
    'post',
    'transfer',
    'settle',
    'refund',
    'void',
    'email',
    'print',
    'export',
    'report_execution',
    'advance_deposit_form',
  ],
} as const;

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const isoTimestamp = z.string().datetime();
const currencyCode = z.string().regex(/^[A-Z]{3}$/);
const signedMoney = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/);
const unsignedMoney = z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/);

const recipientClassSchema = z.enum([
  'reservation_guest',
  'authorized_booking_contact',
  'internal_finance',
  'third_party',
  'unknown',
]);

const inquiryClassSchema = z.enum([
  'labelled_narrow_status',
  'refund_request',
  'settlement_request',
  'invoice_request',
  'other',
]);

/** Recompute claim eligibility from recipient/inquiry; never trust stored field. */
export function folioClaimEligibility(
  recipientClass: z.infer<typeof recipientClassSchema>,
  inquiryClass: z.infer<typeof inquiryClassSchema>,
): 'full' | 'partial' | 'blocked' {
  if (recipientClass === 'third_party' || recipientClass === 'unknown') {
    return 'blocked';
  }
  return inquiryClass === 'labelled_narrow_status' ? 'full' : 'partial';
}

const depositStatusAmountSchema = z
  .object({
    amount: unsignedMoney,
    status: z.string().min(1),
  })
  .strict();

const legacyDepositSummarySchema = z
  .object({
    total: unsignedMoney,
    due: depositStatusAmountSchema.extend({
      status: z.enum(['due', 'none_due']),
    }),
    paid: depositStatusAmountSchema.extend({
      status: z.enum(['paid', 'none_paid']),
    }),
    refunded: depositStatusAmountSchema.extend({
      status: z.enum(['refunded', 'none_refunded']),
    }),
    forfeited: depositStatusAmountSchema.extend({
      status: z.enum(['forfeited', 'none_forfeited']),
    }),
    transferred: depositStatusAmountSchema.extend({
      status: z.enum(['transferred', 'none_transferred']),
    }),
  })
  .strict();

export type FolioLegacyDepositSummary = z.infer<typeof legacyDepositSummarySchema>;

/**
 * Rich fields are optional so historical fixture/predecessor adapters remain
 * parseable. New partial/live results populate these sections; they never
 * substitute a legacy zero-valued deposit summary.
 */
export type FolioBalanceFact = ReadFact<{
  amount: string;
  currency: string;
  basis: 'ledger_balance';
  taxTreatment: 'unknown';
}>;
export type FolioDepositSection = ReadSection<{
  items: Array<{
    due: ReadFact<unknown>;
    paid: ReadFact<unknown>;
    refunded: ReadFact<unknown>;
    forfeited: ReadFact<unknown>;
    transferred: ReadFact<unknown>;
    untransferred: ReadFact<unknown>;
  }>;
}>;

export const folioReadDataSchema = z
  .object({
    reservationBinding: z.literal('exact_parent_redacted'),
    guestPrivacy: z.literal('identity_redacted'),
    currency: currencyCode,
    totalBalance: signedMoney.optional(),
    depositSummary: legacyDepositSummarySchema.optional(),
    balance: readFolioSectionSchema.optional(),
    deposits: readFolioSectionSchema.optional(),
    transactions: readFolioTransactionsSectionSchema.optional(),
    liabilityLocation: readFactSchema.optional(),
    authorization: readFactSchema.optional(),
    disclosure: z
      .object({
        recipientClass: recipientClassSchema,
        inquiryClass: inquiryClassSchema,
        claimEligibility: z.enum(['full', 'partial', 'blocked']),
      })
      .strict(),
    rowsScanned: z.number().int().min(0).max(FOLIO_READ_MAX_TOTAL_ROWS),
    bytesObserved: z.number().int().min(0).max(FOLIO_READ_MAX_BYTES),
    durationMs: z.number().int().min(0).max(FOLIO_BOUND_READ_MAX_DURATION_MS),
    observedAt: isoTimestamp,
  })
  .strict()
  .superRefine((value, context) => {
    validateFolioTransactionCurrencies(value, context);
  });

export type FolioReadData = z.infer<typeof folioReadDataSchema>;

const rawDepositSummarySchema = z
  .object({
    total: unsignedMoney,
    due: unsignedMoney,
    paid: unsignedMoney,
    refunded: unsignedMoney,
    forfeited: unsignedMoney,
    transferred: unsignedMoney,
  })
  .strict();

const privateFieldsSchema = z
  .object({
    guestDisplayName: z.string().optional(),
    cardNumber: z.string().optional(),
    virtualCardNumber: z.string().optional(),
    paymentCredential: z.string().optional(),
    transactionText: z.string().optional(),
  })
  .strict();

export const folioReadFixtureInputSchema = z
  .object({
    binding: z
      .object({
        parentToolId: z.literal('hms_find_reservation'),
        parentEvidenceId: z.string().min(1),
        exactReservationScopeHash: sha256Hex,
        observedScopeHash: sha256Hex,
      })
      .strict(),
    roleProof: z
      .object({
        schemaVersion: z.literal(2),
        credentialMode: z.literal('view_only'),
        financeRead: z.boolean(),
        propertyCurrency: currencyCode,
        allowedSurfaces: z.array(z.string().min(1)),
        deniedActions: z.array(z.string().min(1)),
        issuedAt: isoTimestamp,
        expiresAt: isoTimestamp,
      })
      .strict(),
    guestPrivacyClass: z.enum(['standard', 'vvip', 'incognito']),
    recipientClass: recipientClassSchema,
    inquiryClass: inquiryClassSchema,
    observedAt: isoTimestamp,
    evaluatedAt: isoTimestamp,
    durationMs: z.number().int(),
    bytesObserved: z.number().int(),
    rowsScanned: z.number().int(),
    currency: currencyCode,
    folioAccountBalances: z.array(signedMoney).max(FOLIO_READ_MAX_ROWS),
    totalBalance: signedMoney,
    depositSummary: rawDepositSummarySchema,
    privateFields: privateFieldsSchema.optional(),
  })
  .strict();

export type FolioReadFixtureInput = z.input<typeof folioReadFixtureInputSchema>;

export type FolioReadKernelResult = {
  status: 'ok' | 'unverified_negative' | 'manual_required';
  data: FolioReadData | null;
  blocker: string | null;
};

function fail(blocker: string): FolioReadKernelResult {
  return { status: 'manual_required', data: null, blocker };
}

function cents(value: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fractional] = unsigned.split('.');
  const parsed = BigInt(whole!) * 100n + BigInt(fractional!);
  return negative ? -parsed : parsed;
}

function status<TPresent extends string, TAbsent extends string>(
  amount: string,
  present: TPresent,
  absent: TAbsent,
): TPresent | TAbsent {
  return cents(amount) === 0n ? absent : present;
}

/**
 * Fixture-only Folio + Deposit Ledger kernel. Sensitive source fields exist
 * only in private input memory and cannot fit the closed output schema.
 */
export function parseFolioReadFixture(rawInput: FolioReadFixtureInput): FolioReadKernelResult {
  const parsed = folioReadFixtureInputSchema.safeParse(rawInput);
  if (!parsed.success) return fail('FOLIO_CONTRACT_OR_SCHEMA_DRIFT');
  const input = parsed.data;

  if (input.binding.exactReservationScopeHash !== input.binding.observedScopeHash) {
    return fail('FOLIO_EXACT_RESERVATION_BINDING_MISMATCH');
  }

  const evaluatedAt = Date.parse(input.evaluatedAt);
  const observedAt = Date.parse(input.observedAt);
  const issuedAt = Date.parse(input.roleProof.issuedAt);
  const expiresAt = Date.parse(input.roleProof.expiresAt);
  const hasRequiredSurfaces = FOLIO_READ_PRIVACY_POLICY.allowedSurfaces.every((surface) =>
    input.roleProof.allowedSurfaces.includes(surface),
  );
  const deniesEveryAction = FOLIO_READ_PRIVACY_POLICY.deniedActions.every((action) =>
    input.roleProof.deniedActions.includes(action),
  );
  if (
    !input.roleProof.financeRead ||
    !hasRequiredSurfaces ||
    !deniesEveryAction ||
    issuedAt > evaluatedAt ||
    expiresAt <= evaluatedAt
  ) {
    return fail('FOLIO_FINANCE_ROLE_REQUIRED');
  }

  if (
    input.rowsScanned < 0 ||
    input.rowsScanned > FOLIO_READ_MAX_ROWS ||
    input.bytesObserved < 0 ||
    input.bytesObserved > FOLIO_READ_MAX_BYTES ||
    input.durationMs < 0 ||
    input.durationMs > FOLIO_READ_MAX_DURATION_MS
  ) {
    return fail('FOLIO_BOUNDS_EXCEEDED');
  }

  const sourceAgeMs = evaluatedAt - observedAt;
  if (sourceAgeMs < 0 || sourceAgeMs > FOLIO_READ_MAX_SOURCE_AGE_MS) {
    return fail('FOLIO_SOURCE_STALE');
  }

  // Empty folio observation is unproven zero, not a certified empty envelope.
  if (input.folioAccountBalances.length === 0) {
    return {
      status: 'unverified_negative',
      data: null,
      blocker: 'UNVERIFIED_NEGATIVE',
    };
  }

  const observedFolioTotal = input.folioAccountBalances.reduce(
    (total, amount) => total + cents(amount),
    0n,
  );
  const observedDepositTotal = [
    input.depositSummary.due,
    input.depositSummary.paid,
    input.depositSummary.refunded,
    input.depositSummary.forfeited,
    input.depositSummary.transferred,
  ].reduce((total, amount) => total + cents(amount), 0n);
  if (
    input.currency !== input.roleProof.propertyCurrency ||
    observedFolioTotal !== cents(input.totalBalance) ||
    observedDepositTotal !== cents(input.depositSummary.total)
  ) {
    return fail('FOLIO_CURRENCY_OR_TOTAL_INCONSISTENT');
  }

  const data = folioReadDataSchema.parse({
    reservationBinding: 'exact_parent_redacted',
    guestPrivacy: 'identity_redacted',
    currency: input.currency,
    totalBalance: input.totalBalance,
    depositSummary: {
      total: input.depositSummary.total,
      due: {
        amount: input.depositSummary.due,
        status: status(input.depositSummary.due, 'due', 'none_due'),
      },
      paid: {
        amount: input.depositSummary.paid,
        status: status(input.depositSummary.paid, 'paid', 'none_paid'),
      },
      refunded: {
        amount: input.depositSummary.refunded,
        status: status(input.depositSummary.refunded, 'refunded', 'none_refunded'),
      },
      forfeited: {
        amount: input.depositSummary.forfeited,
        status: status(input.depositSummary.forfeited, 'forfeited', 'none_forfeited'),
      },
      transferred: {
        amount: input.depositSummary.transferred,
        status: status(input.depositSummary.transferred, 'transferred', 'none_transferred'),
      },
    },
    disclosure: {
      recipientClass: input.recipientClass,
      inquiryClass: input.inquiryClass,
      claimEligibility: folioClaimEligibility(input.recipientClass, input.inquiryClass),
    },
    rowsScanned: input.rowsScanned,
    bytesObserved: input.bytesObserved,
    durationMs: input.durationMs,
    observedAt: input.observedAt,
  });
  return { status: 'ok', data, blocker: null };
}

export const folioDepositClaimValueSchema = z
  .object({
    currency: currencyCode,
    totalBalance: signedMoney,
    depositSummary: legacyDepositSummarySchema,
    responseCredit: z.enum(['full_labelled_narrow_status', 'partial_status_only']),
    observedAt: isoTimestamp,
  })
  .strict();

export type FolioDepositClaimValue = z.infer<typeof folioDepositClaimValueSchema>;

export function mapFolioDepositClaim(data: FolioReadData): FolioDepositClaimValue | null {
  const parsed = folioReadDataSchema.parse(data);
  if (parsed.totalBalance == null || parsed.depositSummary == null) return null;
  const eligibility = folioClaimEligibility(
    parsed.disclosure.recipientClass,
    parsed.disclosure.inquiryClass,
  );
  if (eligibility === 'blocked') return null;
  return folioDepositClaimValueSchema.parse({
    currency: parsed.currency,
    totalBalance: parsed.totalBalance,
    depositSummary: parsed.depositSummary,
    responseCredit: eligibility === 'full' ? 'full_labelled_narrow_status' : 'partial_status_only',
    observedAt: parsed.observedAt,
  });
}
