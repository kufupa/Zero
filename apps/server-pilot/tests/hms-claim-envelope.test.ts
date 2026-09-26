import { issueTrustedRequesterAuthorization } from '../src/hms/requester-authorization.js';
import { mapEnvelopeToClaims, parseClaimEnvelope } from '../src/hms/claim-envelope.js';
import { describe, expect, it } from 'vitest';

const observedAt = '2026-08-06T12:00:00.000Z';
const evidenceId = 'ev-envelope-1';
const expiresAt = '2026-08-06T14:00:00.000Z';
const KEY = Buffer.alloc(32, 0x41);
const KEY_VERSION = 'requester-key-v1';
const NOW = new Date('2026-08-06T12:00:00.000Z');

function currentState(
  overrides: {
    allowedClaimKinds?: string[];
    threadId?: string;
    spoofed?: boolean;
  } = {},
) {
  return {
    operationId: 'operation-11c',
    mailboxGrant: {
      sha256: 'a'.repeat(64),
      transportId: 'transport-private',
      active: true,
    },
    thread: {
      transportId: 'transport-private',
      threadId: overrides.threadId ?? 'thread-private',
      stateVersion: 'thread-state-v1',
    },
    requester: {
      identity: 'requester-private',
      requesterClass: 'reservation_guest',
      inquiryClass: 'labelled_narrow_status',
      allowedClaimKinds: overrides.allowedClaimKinds ?? ['reservation_summary', 'folio_status'],
      forwarded: false,
      spoofed: overrides.spoofed ?? false,
    },
  };
}

function issueAuth(state: unknown = currentState()) {
  return issueTrustedRequesterAuthorization(state, {
    key: KEY,
    keyVersion: KEY_VERSION,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 5 * 60_000),
  });
}

function authOpts(
  overrides: {
    state?: unknown;
    authorization?: unknown;
    now?: Date;
    keyVersion?: string;
  } = {},
) {
  const state = overrides.state ?? currentState();
  const authorization = overrides.authorization ?? issueAuth(state);
  return {
    expiresAt,
    requesterAuthorization: {
      authorization,
      currentState: state,
      key: KEY,
      expectedPrivateDigestKeyVersion: overrides.keyVersion ?? KEY_VERSION,
      now: overrides.now ?? NOW,
    },
  };
}

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
    expect(parseClaimEnvelope(findEnvelope({ extra: true })).success).toBe(false);
  });

  it('mapEnvelopeToClaims emits one reservation_summary with evidenceIds', () => {
    const claims = mapEnvelopeToClaims(findEnvelope(), authOpts());
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
        authOpts(),
      ),
    ).toEqual([]);
    expect(
      mapEnvelopeToClaims(findEnvelope({ status: 'unverified_negative' }), authOpts()),
    ).toEqual([]);
    expect(mapEnvelopeToClaims(findEnvelope({ rogue: 1 }), authOpts())).toEqual([]);
  });

  it('rejects missing, stale, cross-thread, spoofed, and claim-kind mismatch auth', () => {
    expect(
      mapEnvelopeToClaims(findEnvelope(), {
        expiresAt,
        requesterAuthorization: null,
      }),
    ).toEqual([]);

    const auth = issueAuth();
    expect(
      mapEnvelopeToClaims(
        findEnvelope(),
        authOpts({
          authorization: auth,
          now: new Date(NOW.getTime() + 10 * 60_000),
        }),
      ),
    ).toEqual([]);

    expect(
      mapEnvelopeToClaims(
        findEnvelope(),
        authOpts({
          authorization: auth,
          state: currentState({ threadId: 'other-thread' }),
        }),
      ),
    ).toEqual([]);

    expect(
      mapEnvelopeToClaims(
        findEnvelope(),
        authOpts({
          state: currentState({ spoofed: true }),
        }),
      ),
    ).toEqual([]);

    expect(
      mapEnvelopeToClaims(
        findEnvelope(),
        authOpts({
          state: currentState({ allowedClaimKinds: ['folio_status'] }),
        }),
      ),
    ).toEqual([]);
  });

  it('rejects observation self-trust fields', () => {
    expect(
      mapEnvelopeToClaims(
        findEnvelope({
          data: {
            ...findEnvelope().data,
            authorizationId: 'forged',
          },
        }),
        authOpts(),
      ),
    ).toEqual([]);
  });

  it('preserves scope joins and rejects mismatched or caller-invented requester authority', () => {
    const authorization = issueAuth();
    expect(authorization).not.toBeNull();
    const manifestSha256 = 'c'.repeat(64);
    const scopeHash = 'd'.repeat(64);
    const scoped = findEnvelope({
      manifestSha256,
      manifestSha256ByBranch: { guest_stay_search: manifestSha256 },
      scopeHash,
      requesterAuthorizationId: authorization!.authorizationId,
    });
    const claims = mapEnvelopeToClaims(scoped, authOpts({ authorization }));
    expect(claims[0]).toMatchObject({
      manifestSha256,
      manifestSha256ByBranch: { guest_stay_search: manifestSha256 },
      scopeHash,
      requesterAuthorizationId: authorization!.authorizationId,
    });

    expect(
      mapEnvelopeToClaims(
        findEnvelope({ requesterAuthorizationId: 'foreign-authorization' }),
        authOpts({ authorization }),
      ),
    ).toEqual([]);
    expect(
      mapEnvelopeToClaims(findEnvelope({ requesterAuthorizationId: 'caller-invented' })),
    ).toEqual([]);
    expect(
      mapEnvelopeToClaims(
        findEnvelope({
          manifestSha256: 'e'.repeat(64),
          manifestSha256ByBranch: { guest_stay_search: 'f'.repeat(64) },
        }),
        authOpts({ authorization }),
      ),
    ).toEqual([]);
  });

  it('omitted requester authorization cannot issue a claim', () => {
    expect(mapEnvelopeToClaims(findEnvelope(), { expiresAt })).toEqual([]);
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
    expect(mapEnvelopeToClaims(folioOk, authOpts())).toHaveLength(1);

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
    expect(mapEnvelopeToClaims(blocked, authOpts())).toEqual([]);
  });
});
