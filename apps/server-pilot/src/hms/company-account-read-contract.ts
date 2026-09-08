import { z } from 'zod';

export const COMPANY_ACCOUNT_READ_MAX_BYTES = 16 * 1024;
export const COMPANY_ACCOUNT_READ_MAX_DURATION_MS = 5_000;
export const COMPANY_ACCOUNT_READ_MAX_SOURCE_AGE_MS = 5 * 60 * 1_000;

export const COMPANY_ACCOUNT_READ_PRIVACY_POLICY = {
  allowedSurfaces: ['Company/Agency Billing'],
  deniedData: ['account_identifier', 'contact', 'credit_limit', 'credit_status'],
  deniedActions: [
    'save',
    'submit',
    'autosave',
    'arbitrary_company_search',
    'credit_limit_read',
    'contact_read',
  ],
} as const;

/** Live surface blocker — billing mode/terms/contract absent on safe linked form. */
export const COMPANY_ACCOUNT_READ_SURFACE_BLOCKER = 'BLOCKED_COMPANY_READ_SURFACE_UNPROVEN';

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const isoTimestamp = z.string().datetime();
const billingModeSchema = z.enum([
  'direct_bill',
  'agency_bill',
  'guest_settlement',
  'prepaid_only',
]);
const paymentTermClassSchema = z.enum([
  'prepaid',
  'net_7',
  'net_14',
  'net_30',
  'net_60',
  'other_approved',
]);
const contractStatusSchema = z.enum(['active', 'inactive', 'suspended']);
const recipientClassSchema = z.enum([
  'authorized_booking_contact',
  'internal_finance',
  'reservation_guest',
  'third_party',
  'unknown',
]);
const inquiryClassSchema = z.enum([
  'labelled_company_billing',
  'contract_status',
  'rate_availability',
  'credit_request',
  'contact_request',
  'other',
]);

export function companyBillingClaimEligibility(
  recipientClass: z.infer<typeof recipientClassSchema>,
  inquiryClass: z.infer<typeof inquiryClassSchema>,
): 'eligible' | 'blocked' {
  const authorized =
    recipientClass === 'authorized_booking_contact' || recipientClass === 'internal_finance';
  return authorized && inquiryClass === 'labelled_company_billing' ? 'eligible' : 'blocked';
}

export const companyAccountReadDataSchema = z
  .object({
    organizationBinding: z.literal('exact_parent_redacted'),
    organizationClass: z.enum(['company', 'agency']),
    billingEligibility: z.enum(['eligible', 'ineligible']),
    billingMode: billingModeSchema,
    paymentTermClass: paymentTermClassSchema,
    contractStatus: contractStatusSchema,
    disclosure: z
      .object({
        recipientClass: recipientClassSchema,
        inquiryClass: inquiryClassSchema,
        claimEligibility: z.enum(['eligible', 'blocked']),
      })
      .strict(),
    observedAt: isoTimestamp,
  })
  .strict();

export type CompanyAccountReadData = z.infer<typeof companyAccountReadDataSchema>;

// Normal executor payload: field-level facts are intentionally distinct from
// the legacy fixture kernel above.
export {
  companyAccountContextDataSchema,
  type CompanyAccountContextData,
} from './context-read-contracts.js';

const privateFieldsSchema = z
  .object({
    accountIdentifier: z.string().optional(),
    contactName: z.string().optional(),
    contactEmail: z.string().optional(),
    creditLimit: z.string().optional(),
    creditStatus: z.string().optional(),
  })
  .strict();

export const companyAccountReadFixtureInputSchema = z
  .object({
    binding: z
      .object({
        parentToolId: z.literal('hms_find_reservation'),
        parentEvidenceId: z.string().min(1),
        exactReservationScopeHash: sha256Hex,
        observedReservationScopeHash: sha256Hex,
        linkSource: z.enum([
          'reservation_link',
          'arbitrary_profile_search',
          'fuzzy_profile_search',
        ]),
        linkedOrganizationCount: z.number().int().min(0),
      })
      .strict(),
    roleProof: z
      .object({
        schemaVersion: z.literal(2),
        credentialMode: z.enum(['view_only', 'write_capable']),
        companyBillingRead: z.boolean(),
        allowedSurfaces: z.array(z.string().min(1)),
        deniedActions: z.array(z.string().min(1)),
        issuedAt: isoTimestamp,
        expiresAt: isoTimestamp,
      })
      .strict(),
    surfaceProof: z
      .object({
        fieldSemantics: z.enum(['company_billing_terms', 'booking_agency_contract_availability']),
        billingModeFieldViewOnly: z.boolean(),
        paymentTermsFieldViewOnly: z.boolean(),
        contractStatusFieldViewOnly: z.boolean(),
        openingAutosaveObserved: z.boolean(),
        reviewedRequestManifest: z.boolean(),
      })
      .strict(),
    organizationClass: z.enum(['company', 'agency']),
    recipientClass: recipientClassSchema,
    inquiryClass: inquiryClassSchema,
    billingEligible: z.boolean(),
    billingMode: billingModeSchema.nullable(),
    paymentTermClass: paymentTermClassSchema.nullable(),
    contractStatus: contractStatusSchema.nullable(),
    observedAt: isoTimestamp,
    evaluatedAt: isoTimestamp,
    durationMs: z.number().int(),
    bytesObserved: z.number().int(),
    privateFields: privateFieldsSchema.optional(),
  })
  .strict();

export type CompanyAccountReadFixtureInput = z.input<typeof companyAccountReadFixtureInputSchema>;

export type CompanyAccountReadKernelResult = {
  status: 'ok' | 'unverified_negative' | 'manual_required';
  data: CompanyAccountReadData | null;
  blocker: string | null;
};

function fail(blocker: string): CompanyAccountReadKernelResult {
  return { status: 'manual_required', data: null, blocker };
}

/**
 * Fixture-only company/agency billing kernel. Private account, contact, and
 * credit fields exist only in input memory and cannot fit output schema.
 */
export function parseCompanyAccountReadFixture(
  rawInput: CompanyAccountReadFixtureInput,
): CompanyAccountReadKernelResult {
  const parsed = companyAccountReadFixtureInputSchema.safeParse(rawInput);
  if (!parsed.success) return fail('COMPANY_ACCOUNT_CONTRACT_OR_SCHEMA_DRIFT');
  const input = parsed.data;

  if (input.binding.linkSource !== 'reservation_link') {
    return fail('COMPANY_EXACT_RESERVATION_LINK_REQUIRED');
  }
  if (input.binding.exactReservationScopeHash !== input.binding.observedReservationScopeHash) {
    return fail('COMPANY_EXACT_RESERVATION_BINDING_MISMATCH');
  }
  if (input.binding.linkedOrganizationCount === 0) {
    return {
      status: 'unverified_negative',
      data: null,
      blocker: 'UNVERIFIED_NEGATIVE',
    };
  }
  if (input.binding.linkedOrganizationCount !== 1) {
    return fail('COMPANY_LINKED_ORGANIZATION_AMBIGUOUS');
  }

  const evaluatedAt = Date.parse(input.evaluatedAt);
  const observedAt = Date.parse(input.observedAt);
  const issuedAt = Date.parse(input.roleProof.issuedAt);
  const expiresAt = Date.parse(input.roleProof.expiresAt);
  const hasRequiredSurface = COMPANY_ACCOUNT_READ_PRIVACY_POLICY.allowedSurfaces.every((surface) =>
    input.roleProof.allowedSurfaces.includes(surface),
  );
  const deniesEveryAction = COMPANY_ACCOUNT_READ_PRIVACY_POLICY.deniedActions.every((action) =>
    input.roleProof.deniedActions.includes(action),
  );
  if (
    input.roleProof.credentialMode !== 'view_only' ||
    !input.roleProof.companyBillingRead ||
    !hasRequiredSurface ||
    !deniesEveryAction ||
    issuedAt > evaluatedAt ||
    expiresAt <= evaluatedAt
  ) {
    return fail('BLOCKED_NO_COMPANY_BILLING_ROLE_PROOF_V2');
  }

  if (
    input.bytesObserved < 0 ||
    input.bytesObserved > COMPANY_ACCOUNT_READ_MAX_BYTES ||
    input.durationMs < 0 ||
    input.durationMs > COMPANY_ACCOUNT_READ_MAX_DURATION_MS
  ) {
    return fail('COMPANY_ACCOUNT_BOUNDS_EXCEEDED');
  }
  const sourceAgeMs = evaluatedAt - observedAt;
  if (sourceAgeMs < 0 || sourceAgeMs > COMPANY_ACCOUNT_READ_MAX_SOURCE_AGE_MS) {
    return fail('COMPANY_ACCOUNT_SOURCE_STALE');
  }

  if (input.surfaceProof.fieldSemantics === 'booking_agency_contract_availability') {
    return fail('COMPANY_BOOKING_AGENCY_AVAILABILITY_NOT_BILLING_TERMS');
  }
  if (
    !input.surfaceProof.billingModeFieldViewOnly ||
    !input.surfaceProof.paymentTermsFieldViewOnly ||
    !input.surfaceProof.contractStatusFieldViewOnly ||
    input.surfaceProof.openingAutosaveObserved ||
    !input.surfaceProof.reviewedRequestManifest
  ) {
    return fail('BLOCKED_COMPANY_READ_SURFACE_UNPROVEN');
  }

  if (
    input.billingMode === null ||
    input.paymentTermClass === null ||
    input.contractStatus === null
  ) {
    return {
      status: 'unverified_negative',
      data: null,
      blocker: 'UNVERIFIED_NEGATIVE',
    };
  }

  const data = companyAccountReadDataSchema.parse({
    organizationBinding: 'exact_parent_redacted',
    organizationClass: input.organizationClass,
    billingEligibility: input.billingEligible ? 'eligible' : 'ineligible',
    billingMode: input.billingMode,
    paymentTermClass: input.paymentTermClass,
    contractStatus: input.contractStatus,
    disclosure: {
      recipientClass: input.recipientClass,
      inquiryClass: input.inquiryClass,
      claimEligibility: companyBillingClaimEligibility(input.recipientClass, input.inquiryClass),
    },
    observedAt: input.observedAt,
  });
  return { status: 'ok', data, blocker: null };
}

export const companyBillingClaimValueSchema = z
  .object({
    organizationClass: z.enum(['company', 'agency']),
    billingEligibility: z.enum(['eligible', 'ineligible']),
    billingMode: billingModeSchema,
    paymentTermClass: paymentTermClassSchema,
    contractStatus: contractStatusSchema,
    responseCredit: z.literal('full_labelled_company_billing'),
    observedAt: isoTimestamp,
  })
  .strict();

export type CompanyBillingClaimValue = z.infer<typeof companyBillingClaimValueSchema>;

export function mapCompanyBillingClaim(
  data: CompanyAccountReadData,
): CompanyBillingClaimValue | null {
  const parsed = companyAccountReadDataSchema.parse(data);
  const eligibility = companyBillingClaimEligibility(
    parsed.disclosure.recipientClass,
    parsed.disclosure.inquiryClass,
  );
  if (eligibility === 'blocked') return null;
  return companyBillingClaimValueSchema.parse({
    organizationClass: parsed.organizationClass,
    billingEligibility: parsed.billingEligibility,
    billingMode: parsed.billingMode,
    paymentTermClass: parsed.paymentTermClass,
    contractStatus: parsed.contractStatus,
    responseCredit: 'full_labelled_company_billing',
    observedAt: parsed.observedAt,
  });
}
