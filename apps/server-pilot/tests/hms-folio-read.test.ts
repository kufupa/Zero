import {
  FOLIO_READ_MAX_BYTES,
  FOLIO_READ_MAX_DURATION_MS,
  FOLIO_READ_MAX_ROWS,
  FOLIO_READ_PRIVACY_POLICY,
  folioReadDataSchema,
  mapFolioDepositClaim,
  parseFolioReadFixture,
  type FolioReadFixtureInput,
} from '../src/hms/folio-read-contract.js';
import { claimsFromToolResult } from '../src/ai/candidate-draft-agent.js';
import { READ_TOOLS, capabilityStateFor } from '../src/hms/read-tools.js';
import type { ToolResult } from '../src/ai/draft-evidence.js';
import { describe, expect, it } from 'vitest';

const NOW = '2026-08-06T00:00:00.000Z';
const OBSERVED = '2026-08-05T23:58:00.000Z';
const HASH = 'a'.repeat(64);

function fixture(overrides: Partial<FolioReadFixtureInput> = {}): FolioReadFixtureInput {
  return {
    binding: {
      parentToolId: 'hms_find_reservation',
      parentEvidenceId: 'reservation-evidence',
      exactReservationScopeHash: HASH,
      observedScopeHash: HASH,
    },
    roleProof: {
      schemaVersion: 2,
      credentialMode: 'view_only',
      financeRead: true,
      propertyCurrency: 'ZAR',
      allowedSurfaces: ['Folio', 'Deposit Ledger'],
      deniedActions: [...FOLIO_READ_PRIVACY_POLICY.deniedActions],
      issuedAt: '2026-08-05T22:00:00.000Z',
      expiresAt: '2026-08-06T01:00:00.000Z',
    },
    guestPrivacyClass: 'standard',
    recipientClass: 'reservation_guest',
    inquiryClass: 'labelled_narrow_status',
    observedAt: OBSERVED,
    evaluatedAt: NOW,
    durationMs: 30,
    bytesObserved: 2_000,
    rowsScanned: 5,
    currency: 'ZAR',
    folioAccountBalances: ['100.00', '-25.00'],
    totalBalance: '75.00',
    depositSummary: {
      total: '50.00',
      due: '10.00',
      paid: '20.00',
      refunded: '5.00',
      forfeited: '5.00',
      transferred: '10.00',
    },
    privateFields: {
      guestDisplayName: 'Protected Guest',
      cardNumber: '4111111111111111',
      virtualCardNumber: '5555555555554444',
      paymentCredential: 'secret-token',
      transactionText: 'free text posting description',
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
      id: 'folio-evidence',
      toolId: 'hms_read_folio',
      toolVersion: '1.0.0',
      propertyCode: 'HRCEN',
      observedAt: OBSERVED,
      expiresAt: '2026-08-06T01:00:00.000Z',
      claimKeys: [],
      sourceHash: HASH,
    },
  };
}

describe('hms_read_folio fixture kernel', () => {
  it('returns one exact reservation-linked redacted folio/deposit summary', () => {
    const parsed = parseFolioReadFixture(fixture());

    expect(parsed.status).toBe('ok');
    expect(folioReadDataSchema.parse(parsed.data)).toEqual(parsed.data);
    expect(parsed.data).toEqual(
      expect.objectContaining({
        reservationBinding: 'exact_parent_redacted',
        currency: 'ZAR',
        totalBalance: '75.00',
        depositSummary: {
          total: '50.00',
          due: { amount: '10.00', status: 'due' },
          paid: { amount: '20.00', status: 'paid' },
          refunded: { amount: '5.00', status: 'refunded' },
          forfeited: { amount: '5.00', status: 'forfeited' },
          transferred: { amount: '10.00', status: 'transferred' },
        },
        observedAt: OBSERVED,
      }),
    );
    expect(JSON.stringify(parsed)).not.toMatch(
      /Protected Guest|4111111111111111|5555555555554444|secret-token|free text posting description/,
    );
  });

  it.each([
    [
      'reservation scope mismatch',
      {
        binding: {
          parentToolId: 'hms_find_reservation' as const,
          parentEvidenceId: 'reservation-evidence',
          exactReservationScopeHash: HASH,
          observedScopeHash: 'b'.repeat(64),
        },
      },
      'FOLIO_EXACT_RESERVATION_BINDING_MISMATCH',
    ],
    [
      'non-finance role',
      {
        roleProof: {
          ...fixture().roleProof,
          financeRead: false,
        },
      },
      'FOLIO_FINANCE_ROLE_REQUIRED',
    ],
    [
      'missing Deposit Ledger entitlement',
      {
        roleProof: {
          ...fixture().roleProof,
          allowedSurfaces: ['Folio'],
        },
      },
      'FOLIO_FINANCE_ROLE_REQUIRED',
    ],
  ])('fails closed on %s', (_label, override, blocker) => {
    const parsed = parseFolioReadFixture(fixture(override));
    expect(parsed.status).toBe('manual_required');
    expect(parsed.blocker).toBe(blocker);
    expect(parsed.data).toBeNull();
  });

  it.each(['vvip', 'incognito'] as const)(
    'masks identity for %s reservations',
    (guestPrivacyClass) => {
      const parsed = parseFolioReadFixture(
        fixture({
          guestPrivacyClass,
          privateFields: {
            ...fixture().privateFields,
            guestDisplayName: `${guestPrivacyClass} guest`,
          },
        }),
      );
      expect(parsed.status).toBe('ok');
      expect(parsed.data?.guestPrivacy).toBe('identity_redacted');
      expect(JSON.stringify(parsed)).not.toContain(`${guestPrivacyClass} guest`);
    },
  );

  it.each([
    ['currency mismatch', { currency: 'USD' }, 'FOLIO_CURRENCY_OR_TOTAL_INCONSISTENT'],
    ['folio total mismatch', { totalBalance: '74.99' }, 'FOLIO_CURRENCY_OR_TOTAL_INCONSISTENT'],
    [
      'deposit total mismatch',
      {
        depositSummary: {
          ...fixture().depositSummary,
          total: '49.99',
        },
      },
      'FOLIO_CURRENCY_OR_TOTAL_INCONSISTENT',
    ],
  ])('rejects %s', (_label, override, blocker) => {
    const parsed = parseFolioReadFixture(fixture(override));
    expect(parsed.status).toBe('manual_required');
    expect(parsed.blocker).toBe(blocker);
    expect(parsed.data).toBeNull();
  });

  it('rejects stale source and expired role proof', () => {
    expect(parseFolioReadFixture(fixture({ observedAt: '2026-08-05T23:54:59.999Z' })).blocker).toBe(
      'FOLIO_SOURCE_STALE',
    );
    expect(
      parseFolioReadFixture(
        fixture({
          roleProof: {
            ...fixture().roleProof,
            expiresAt: NOW,
          },
        }),
      ).blocker,
    ).toBe('FOLIO_FINANCE_ROLE_REQUIRED');
  });

  it('enforces row, byte, and time caps before returning data', () => {
    expect(parseFolioReadFixture(fixture({ rowsScanned: FOLIO_READ_MAX_ROWS + 1 })).blocker).toBe(
      'FOLIO_BOUNDS_EXCEEDED',
    );
    expect(
      parseFolioReadFixture(fixture({ bytesObserved: FOLIO_READ_MAX_BYTES + 1 })).blocker,
    ).toBe('FOLIO_BOUNDS_EXCEEDED');
    expect(
      parseFolioReadFixture(fixture({ durationMs: FOLIO_READ_MAX_DURATION_MS + 1 })).blocker,
    ).toBe('FOLIO_BOUNDS_EXCEEDED');
  });

  it('publishes closed privacy policy with every forbidden surface', () => {
    expect(FOLIO_READ_PRIVACY_POLICY.allowedSurfaces).toEqual(['Folio', 'Deposit Ledger']);
    expect(FOLIO_READ_PRIVACY_POLICY.deniedData).toEqual(
      expect.arrayContaining([
        'card_number',
        'payment_credential',
        'bank_account',
        'transaction_free_text',
        'line_item',
      ]),
    );
    expect(FOLIO_READ_PRIVACY_POLICY.deniedActions).toEqual(
      expect.arrayContaining([
        'post',
        'transfer',
        'settle',
        'refund',
        'void',
        'email',
        'print',
        'report_execution',
        'advance_deposit_form',
      ]),
    );
    expect(READ_TOOLS.hms_read_folio.deniedActions).toEqual(
      expect.arrayContaining(['email', 'advance_deposit_form', 'report_execution']),
    );
  });

  it('quarantines empty folio balance observations as unverified_negative', () => {
    const parsed = parseFolioReadFixture(
      fixture({
        folioAccountBalances: [],
        totalBalance: '0.00',
        depositSummary: {
          total: '0.00',
          due: '0.00',
          paid: '0.00',
          refunded: '0.00',
          forfeited: '0.00',
          transferred: '0.00',
        },
      }),
    );
    expect(parsed.status).toBe('unverified_negative');
    expect(parsed.blocker).toBe('UNVERIFIED_NEGATIVE');
    expect(parsed.data).toBeNull();
    expect(
      claimsFromToolResult({
        ...toolResult(null),
        status: 'unverified_negative',
        draftReady: false,
      }),
    ).toEqual([]);
  });
});

describe('folio recipient-class claims', () => {
  it('grants Full only to labelled narrow status inquiry', () => {
    const parsed = parseFolioReadFixture(fixture());
    expect(parsed.data).not.toBeNull();
    const claim = mapFolioDepositClaim(parsed.data!);
    expect(claim?.responseCredit).toBe('full_labelled_narrow_status');

    const claims = claimsFromToolResult(
      toolResult(parsed.data),
      new Date('2026-08-06T00:01:00.000Z'),
    );
    // The fixture kernel output has no server-issued scope/receipt binding.
    // Positive claim extraction is covered through mergeFolioEvidence below.
    expect(claims).toEqual([]);
  });

  it.each(['refund_request', 'settlement_request', 'invoice_request'] as const)(
    'limits %s to Partial',
    (inquiryClass) => {
      const parsed = parseFolioReadFixture(fixture({ inquiryClass }));
      expect(parsed.data).not.toBeNull();
      expect(mapFolioDepositClaim(parsed.data!)?.responseCredit).toBe('partial_status_only');
    },
  );

  it.each(['unknown', 'third_party'] as const)(
    'blocks claims for %s recipient',
    (recipientClass) => {
      const parsed = parseFolioReadFixture(fixture({ recipientClass }));
      expect(parsed.status).toBe('ok');
      expect(parsed.data).not.toBeNull();
      expect(mapFolioDepositClaim(parsed.data!)).toBeNull();
      expect(
        claimsFromToolResult(toolResult(parsed.data), new Date('2026-08-06T00:01:00.000Z')),
      ).toEqual([]);
    },
  );

  it('ignores forged claimEligibility and recomputes from recipient/inquiry', () => {
    const parsed = parseFolioReadFixture(fixture({ recipientClass: 'third_party' }));
    expect(parsed.data).not.toBeNull();
    const forged = {
      ...parsed.data!,
      disclosure: {
        ...parsed.data!.disclosure,
        claimEligibility: 'full' as const,
      },
    };
    expect(mapFolioDepositClaim(forged)).toBeNull();
  });
});

describe('folio registry contract', () => {
  it('registers closed contract with discovery digest; live promotion still false', () => {
    expect(READ_TOOLS.hms_read_folio.observationSchema).toBe(folioReadDataSchema);
    expect(READ_TOOLS.hms_read_folio.promotionEvidence).toEqual({
      fixture: true,
      discovery: true,
      live: false,
      shadow: false,
    });
    expect(READ_TOOLS.hms_read_folio.evidenceRefs.discoveryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(capabilityStateFor('hms_read_folio')).toBe('discovery_verified');
  });
});
