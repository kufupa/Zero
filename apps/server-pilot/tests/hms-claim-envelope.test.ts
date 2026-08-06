import { describe, expect, it } from 'vitest';
import {
  mapEnvelopeToClaims,
  parseClaimEnvelope,
} from '../src/hms/claim-envelope.js';

const observedAt = '2026-08-06T12:00:00.000Z';
const evidenceId = 'ev-envelope-1';
const expiresAt = '2026-08-06T14:00:00.000Z';

function findEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    toolId: 'hms_find_reservation',
    toolVersion: '1.2.0',
    status: 'ok',
    observedAt,
    evidenceId,
    data: {
      matches: [
        {
          confirmationNumber: 'CONF-1',
          externalReference: null,
          guestName: 'Guest',
          arrivalDate: '2026-08-01',
          departureDate: '2026-08-03',
          reservationStatus: 'Confirmed',
          roomType: 'STD',
          ratePlan: null,
        },
      ],
      matchCount: 1,
      capped: false,
    },
    ...overrides,
  };
}

describe('claim envelope', () => {
  it('parses closed generic envelope and rejects unknown keys', () => {
    expect(parseClaimEnvelope(findEnvelope()).success).toBe(true);
    expect(
      parseClaimEnvelope(findEnvelope({ extra: true })).success,
    ).toBe(false);
  });

  it('mapEnvelopeToClaims emits one reservation_summary with evidenceIds', () => {
    const claims = mapEnvelopeToClaims(findEnvelope(), { expiresAt });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      kind: 'reservation_summary',
      evidenceId,
      evidenceIds: [evidenceId],
      value: {
        confirmationNumber: 'CONF-1',
        guestName: 'Guest',
      },
    });
  });

  it('rejects wrong toolId, unverified_negative, and unknown keys in mapper', () => {
    expect(
      mapEnvelopeToClaims(
        findEnvelope({ toolId: 'hms_quote_stay', data: { observedAt } }),
      ),
    ).toEqual([]);
    expect(
      mapEnvelopeToClaims(findEnvelope({ status: 'unverified_negative' })),
    ).toEqual([]);
    expect(mapEnvelopeToClaims(findEnvelope({ rogue: 1 }))).toEqual([]);
  });

  it('runs disclosure gate before folio claim creation', () => {
    const folioOk = {
      toolId: 'hms_read_folio',
      toolVersion: '1.0.0',
      status: 'ok',
      observedAt,
      evidenceId,
      data: {
        reservationBinding: 'exact_parent_redacted',
        guestPrivacy: 'identity_redacted',
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
        disclosure: {
          recipientClass: 'reservation_guest',
          inquiryClass: 'labelled_narrow_status',
          claimEligibility: 'full',
        },
        rowsScanned: 5,
        bytesObserved: 2000,
        durationMs: 30,
        observedAt,
      },
    };
    expect(mapEnvelopeToClaims(folioOk)).toHaveLength(1);

    const blocked = {
      ...folioOk,
      data: {
        ...folioOk.data,
        disclosure: {
          recipientClass: 'third_party',
          inquiryClass: 'refund_request',
          claimEligibility: 'blocked',
        },
      },
    };
    expect(mapEnvelopeToClaims(blocked)).toEqual([]);
  });
});
