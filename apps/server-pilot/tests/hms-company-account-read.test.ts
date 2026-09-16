import { describe, expect, it } from 'vitest';
import { claimsFromToolResult } from '../src/ai/candidate-draft-agent.js';
import { type ToolResult } from '../src/ai/draft-evidence.js';
import {
  COMPANY_ACCOUNT_READ_MAX_BYTES,
  COMPANY_ACCOUNT_READ_MAX_DURATION_MS,
  COMPANY_ACCOUNT_READ_PRIVACY_POLICY,
  companyAccountReadDataSchema,
  mapCompanyBillingClaim,
  parseCompanyAccountReadFixture,
  type CompanyAccountReadFixtureInput,
} from '../src/hms/company-account-read-contract.js';
import { READ_TOOLS, capabilityStateFor } from '../src/hms/read-tools.js';

const NOW = '2026-08-06T00:00:00.000Z';
const OBSERVED = '2026-08-05T23:58:00.000Z';
const HASH = 'a'.repeat(64);

function fixture(
  overrides: Partial<CompanyAccountReadFixtureInput> = {},
): CompanyAccountReadFixtureInput {
  return {
    binding: {
      parentToolId: 'hms_find_reservation',
      parentEvidenceId: 'reservation-evidence',
      exactReservationScopeHash: HASH,
      observedReservationScopeHash: HASH,
      linkSource: 'reservation_link',
      linkedOrganizationCount: 1,
    },
    roleProof: {
      schemaVersion: 2,
      credentialMode: 'view_only',
      companyBillingRead: true,
      allowedSurfaces: ['Company/Agency Billing'],
      deniedActions: [...COMPANY_ACCOUNT_READ_PRIVACY_POLICY.deniedActions],
      issuedAt: '2026-08-05T22:00:00.000Z',
      expiresAt: '2026-08-06T01:00:00.000Z',
    },
    surfaceProof: {
      fieldSemantics: 'company_billing_terms',
      billingModeFieldViewOnly: true,
      paymentTermsFieldViewOnly: true,
      contractStatusFieldViewOnly: true,
      openingAutosaveObserved: false,
      reviewedRequestManifest: true,
    },
    organizationClass: 'company',
    recipientClass: 'authorized_booking_contact',
    inquiryClass: 'labelled_company_billing',
    billingEligible: true,
    billingMode: 'direct_bill',
    paymentTermClass: 'net_30',
    contractStatus: 'active',
    observedAt: OBSERVED,
    evaluatedAt: NOW,
    durationMs: 20,
    bytesObserved: 1_000,
    privateFields: {
      accountIdentifier: 'PRIVATE-ACCOUNT-ID',
      contactName: 'Private Contact',
      contactEmail: 'private@example.test',
      creditLimit: '999999.00',
      creditStatus: 'confidential',
    },
    ...overrides,
  };
}

function toolResult(data: unknown): ToolResult<unknown> {
  return {
    status: 'ok',
    draftReady: true,
    data,
    unresolvedFields: [],
    evidence: {
      kind: 'hms',
      id: 'company-evidence',
      toolId: 'hms_company_account_read',
      toolVersion: '1.0.0',
      propertyCode: 'HRCEN',
      observedAt: OBSERVED,
      expiresAt: '2026-08-06T01:00:00.000Z',
      claimKeys: [],
      sourceHash: HASH,
    },
  };
}

describe('hms_company_account_read fixture kernel', () => {
  it('returns only minimized billing terms from exact reservation-linked organization', () => {
    const parsed = parseCompanyAccountReadFixture(fixture());

    expect(parsed.status).toBe('ok');
    expect(companyAccountReadDataSchema.parse(parsed.data)).toEqual(parsed.data);
    expect(parsed.data).toEqual(
      expect.objectContaining({
        organizationBinding: 'exact_parent_redacted',
        organizationClass: 'company',
        billingEligibility: 'eligible',
        billingMode: 'direct_bill',
        paymentTermClass: 'net_30',
        contractStatus: 'active',
        observedAt: OBSERVED,
      }),
    );
    expect(JSON.stringify(parsed)).not.toMatch(
      /PRIVATE-ACCOUNT-ID|Private Contact|private@example\.test|999999\.00|confidential/,
    );
    expect(parsed.data).not.toHaveProperty('accountIdentifier');
    expect(parsed.data).not.toHaveProperty('contact');
    expect(parsed.data).not.toHaveProperty('creditLimit');
  });

  it.each(['arbitrary_profile_search', 'fuzzy_profile_search'] as const)(
    'rejects %s candidates',
    (linkSource) => {
      const parsed = parseCompanyAccountReadFixture(
        fixture({
          binding: { ...fixture().binding, linkSource },
        }),
      );
      expect(parsed.status).toBe('manual_required');
      expect(parsed.blocker).toBe('COMPANY_EXACT_RESERVATION_LINK_REQUIRED');
      expect(parsed.data).toBeNull();
    },
  );

  it('rejects wrong reservation scope and non-singleton organization links', () => {
    expect(
      parseCompanyAccountReadFixture(
        fixture({
          binding: {
            ...fixture().binding,
            observedReservationScopeHash: 'b'.repeat(64),
          },
        }),
      ).blocker,
    ).toBe('COMPANY_EXACT_RESERVATION_BINDING_MISMATCH');
    const zeroLinks = parseCompanyAccountReadFixture(
      fixture({
        binding: { ...fixture().binding, linkedOrganizationCount: 0 },
      }),
    );
    expect(zeroLinks.status).toBe('unverified_negative');
    expect(zeroLinks.blocker).toBe('UNVERIFIED_NEGATIVE');
    expect(
      parseCompanyAccountReadFixture(
        fixture({
          binding: { ...fixture().binding, linkedOrganizationCount: 2 },
        }),
      ).blocker,
    ).toBe('COMPANY_LINKED_ORGANIZATION_AMBIGUOUS');
  });

  it('requires current view-only company billing role and complete denied actions', () => {
    expect(
      parseCompanyAccountReadFixture(
        fixture({
          roleProof: { ...fixture().roleProof, companyBillingRead: false },
        }),
      ).blocker,
    ).toBe('BLOCKED_NO_COMPANY_BILLING_ROLE_PROOF_V2');
    expect(
      parseCompanyAccountReadFixture(
        fixture({
          roleProof: { ...fixture().roleProof, credentialMode: 'write_capable' },
        }),
      ).blocker,
    ).toBe('BLOCKED_NO_COMPANY_BILLING_ROLE_PROOF_V2');
    expect(
      parseCompanyAccountReadFixture(
        fixture({
          roleProof: { ...fixture().roleProof, deniedActions: [] },
        }),
      ).blocker,
    ).toBe('BLOCKED_NO_COMPANY_BILLING_ROLE_PROOF_V2');
  });

  it('fails closed when exact view-only fields, inert opening, or manifest are unproven', () => {
    for (const surfaceProof of [
      { ...fixture().surfaceProof, billingModeFieldViewOnly: false },
      { ...fixture().surfaceProof, paymentTermsFieldViewOnly: false },
      { ...fixture().surfaceProof, contractStatusFieldViewOnly: false },
      { ...fixture().surfaceProof, openingAutosaveObserved: true },
      { ...fixture().surfaceProof, reviewedRequestManifest: false },
    ]) {
      const parsed = parseCompanyAccountReadFixture(fixture({ surfaceProof }));
      expect(parsed.status).toBe('manual_required');
      expect(parsed.blocker).toBe('BLOCKED_COMPANY_READ_SURFACE_UNPROVEN');
      expect(parsed.data).toBeNull();
    }
  });

  it('never substitutes booking-agency availability for billing terms', () => {
    const parsed = parseCompanyAccountReadFixture(
      fixture({
        surfaceProof: {
          ...fixture().surfaceProof,
          fieldSemantics: 'booking_agency_contract_availability',
        },
      }),
    );
    expect(parsed.status).toBe('manual_required');
    expect(parsed.blocker).toBe(
      'COMPANY_BOOKING_AGENCY_AVAILABILITY_NOT_BILLING_TERMS',
    );
    expect(parsed.data).toBeNull();
  });

  it('quarantines empty or incomplete observations as unverified_negative', () => {
    for (const override of [
      { billingMode: null },
      { paymentTermClass: null },
      { contractStatus: null },
    ]) {
      const parsed = parseCompanyAccountReadFixture(fixture(override));
      expect(parsed.status).toBe('unverified_negative');
      expect(parsed.blocker).toBe('UNVERIFIED_NEGATIVE');
      expect(parsed.data).toBeNull();
    }
    expect(
      claimsFromToolResult({
        ...toolResult(null),
        status: 'unverified_negative',
        draftReady: false,
      }),
    ).toEqual([]);
  });

  it('rejects stale observations and bounded-read overruns', () => {
    expect(
      parseCompanyAccountReadFixture(
        fixture({ observedAt: '2026-08-05T23:54:59.999Z' }),
      ).blocker,
    ).toBe('COMPANY_ACCOUNT_SOURCE_STALE');
    expect(
      parseCompanyAccountReadFixture(
        fixture({ bytesObserved: COMPANY_ACCOUNT_READ_MAX_BYTES + 1 }),
      ).blocker,
    ).toBe('COMPANY_ACCOUNT_BOUNDS_EXCEEDED');
    expect(
      parseCompanyAccountReadFixture(
        fixture({ durationMs: COMPANY_ACCOUNT_READ_MAX_DURATION_MS + 1 }),
      ).blocker,
    ).toBe('COMPANY_ACCOUNT_BOUNDS_EXCEEDED');
  });

  it('publishes privacy policy and retains registry search/data denials', () => {
    expect(COMPANY_ACCOUNT_READ_PRIVACY_POLICY.deniedData).toEqual(
      expect.arrayContaining([
        'account_identifier',
        'contact',
        'credit_limit',
        'credit_status',
      ]),
    );
    expect(READ_TOOLS.hms_company_account_read.deniedActions).toEqual(
      expect.arrayContaining([
        'autosave',
        'arbitrary_company_search',
        'credit_limit_read',
        'contact_read',
      ]),
    );
  });
});

describe('company billing claims', () => {
  it('maps eligible minimized observation to one atomic claim', () => {
    const parsed = parseCompanyAccountReadFixture(fixture());
    expect(parsed.data).not.toBeNull();
    const mapped = mapCompanyBillingClaim(parsed.data!);
    expect(mapped).toEqual(
      expect.objectContaining({
        billingEligibility: 'eligible',
        billingMode: 'direct_bill',
        paymentTermClass: 'net_30',
        contractStatus: 'active',
      }),
    );

    const claims = claimsFromToolResult(
      toolResult(parsed.data),
      new Date('2026-08-06T00:01:00.000Z'),
    );
    // Fixture observations do not carry separately issued requester authority;
    // the closed claim envelope must therefore emit no claim.
    expect(claims).toEqual([]);
  });

  it.each(['reservation_guest', 'third_party', 'unknown'] as const)(
    'blocks claims for %s recipient',
    (recipientClass) => {
      const parsed = parseCompanyAccountReadFixture(fixture({ recipientClass }));
      expect(parsed.status).toBe('ok');
      expect(parsed.data).not.toBeNull();
      expect(mapCompanyBillingClaim(parsed.data!)).toBeNull();
      expect(claimsFromToolResult(toolResult(parsed.data))).toEqual([]);
    },
  );

  it.each(['credit_request', 'contact_request'] as const)(
    'blocks claims for %s inquiry attack path',
    (inquiryClass) => {
      const parsed = parseCompanyAccountReadFixture(fixture({ inquiryClass }));
      expect(parsed.status).toBe('ok');
      expect(parsed.data).not.toBeNull();
      expect(mapCompanyBillingClaim(parsed.data!)).toBeNull();
      expect(claimsFromToolResult(toolResult(parsed.data))).toEqual([]);
    },
  );

  it('recomputes eligibility and rejects forged stored eligibility', () => {
    const parsed = parseCompanyAccountReadFixture(
      fixture({ recipientClass: 'third_party' }),
    );
    expect(parsed.data).not.toBeNull();
    const forged = {
      ...parsed.data!,
      disclosure: {
        ...parsed.data!.disclosure,
        claimEligibility: 'eligible' as const,
      },
    };
    expect(mapCompanyBillingClaim(forged)).toBeNull();
    expect(claimsFromToolResult(toolResult(forged))).toEqual([]);
  });
});

describe('company account registry contract', () => {
  it('registers closed fixture-only contract without live promotion', () => {
    expect(READ_TOOLS.hms_company_account_read.observationSchema).toBe(
      companyAccountReadDataSchema,
    );
    expect(READ_TOOLS.hms_company_account_read.promotionEvidence).toEqual({
      fixture: true,
      discovery: false,
      live: false,
      shadow: false,
    });
    expect(capabilityStateFor('hms_company_account_read')).toBe(
      'fixture_verified',
    );
  });
});
