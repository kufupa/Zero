import { describe, expect, it } from 'vitest';
import { trustedRequesterAuthorizationV1Schema } from '../src/hms/contracts.js';
import {
  issueTrustedRequesterAuthorization,
  validateTrustedRequesterAuthorization,
} from '../src/hms/requester-authorization.js';

const KEY = Buffer.alloc(32, 0x41);
const KEY_VERSION = 'requester-key-v1';
const NOW = new Date('2026-08-06T10:00:00.000Z');

function currentState() {
  return {
    operationId: 'operation-11a',
    mailboxGrant: {
      sha256: 'a'.repeat(64),
      transportId: 'transport-private',
      active: true,
    },
    thread: {
      transportId: 'transport-private',
      threadId: 'thread-private',
      stateVersion: 'thread-state-v1',
    },
    requester: {
      identity: 'requester-private',
      requesterClass: 'reservation_guest',
      inquiryClass: 'labelled_narrow_status',
      allowedClaimKinds: ['reservation_summary', 'document_metadata'],
      forwarded: false,
      spoofed: false,
    },
  };
}

function issue(state: unknown = currentState()) {
  return issueTrustedRequesterAuthorization(state, {
    key: KEY,
    keyVersion: KEY_VERSION,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 5 * 60_000),
  });
}

function validate(
  authorization: unknown,
  state: unknown = currentState(),
  overrides: Partial<{
    requiredClaimKind:
      | 'reservation_summary'
      | 'quote'
      | 'document_metadata'
      | 'sent_email_audit'
      | 'folio_status'
      | 'company_billing'
      | 'group_status'
      | 'event_status';
    keyVersion: string;
    now: Date;
  }> = {},
) {
  return validateTrustedRequesterAuthorization({
    authorization,
    currentState: state,
    requiredClaimKind: overrides.requiredClaimKind ?? 'reservation_summary',
    key: KEY,
    expectedPrivateDigestKeyVersion: overrides.keyVersion ?? KEY_VERSION,
    now: overrides.now ?? NOW,
  });
}

describe('trusted requester authorization', () => {
  it('issues a closed authorization from current grant, thread, and requester state', () => {
    const authorization = issue();
    expect(authorization).not.toBeNull();
    expect(trustedRequesterAuthorizationV1Schema.parse(authorization)).toEqual(
      authorization,
    );
    expect(authorization).toMatchObject({
      schemaVersion: 1,
      authorizationId: expect.stringMatching(/^[a-f0-9]{64}$/),
      operationId: 'operation-11a',
      mailboxGrantSha256: 'a'.repeat(64),
      threadIdHmacSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      threadStateVersion: 'thread-state-v1',
      requesterIdentityHmacSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      requesterClass: 'reservation_guest',
      inquiryClass: 'labelled_narrow_status',
      allowedClaimKinds: ['document_metadata', 'reservation_summary'],
      privateDigestKeyVersion: KEY_VERSION,
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    });

    const serialized = JSON.stringify(authorization);
    expect(serialized).not.toContain('thread-private');
    expect(serialized).not.toContain('requester-private');
    expect(serialized).not.toContain('transport-private');
    expect(validate(authorization)).toEqual(authorization);
  });

  it('rejects expiry, thread/state drift, grant drift, and key rotation', () => {
    const authorization = issue();
    expect(authorization).not.toBeNull();

    expect(
      validate(authorization, currentState(), {
        now: new Date(NOW.getTime() + 5 * 60_000),
      }),
    ).toBeNull();
    expect(
      validate(authorization, {
        ...currentState(),
        thread: { ...currentState().thread, threadId: 'other-thread' },
      }),
    ).toBeNull();
    expect(
      validate(authorization, {
        ...currentState(),
        thread: { ...currentState().thread, stateVersion: 'thread-state-v2' },
      }),
    ).toBeNull();
    expect(
      validate(authorization, {
        ...currentState(),
        mailboxGrant: {
          ...currentState().mailboxGrant,
          sha256: 'b'.repeat(64),
        },
      }),
    ).toBeNull();
    expect(validate(authorization, currentState(), { keyVersion: 'rotated-v2' })).toBeNull();
  });

  it('rejects spoofed, forwarded, unknown, and cross-transport requester state', () => {
    for (const requester of [
      { ...currentState().requester, spoofed: true },
      { ...currentState().requester, forwarded: true },
      { ...currentState().requester, requesterClass: 'unknown' },
      { ...currentState().requester, requesterClass: 'third_party' },
    ]) {
      expect(issue({ ...currentState(), requester })).toBeNull();
    }
    expect(
      issue({
        ...currentState(),
        thread: { ...currentState().thread, transportId: 'other-transport' },
      }),
    ).toBeNull();
  });

  it('rejects forged fields and claim-kind escalation', () => {
    const authorization = issue();
    expect(authorization).not.toBeNull();
    if (!authorization) throw new Error('authorization fixture missing');

    expect(
      validate({ ...authorization, requesterClass: 'internal_finance' }),
    ).toBeNull();
    expect(
      validate({
        ...authorization,
        allowedClaimKinds: [...authorization.allowedClaimKinds, 'folio_status'],
      }),
    ).toBeNull();
    expect(
      validate(authorization, currentState(), { requiredClaimKind: 'folio_status' }),
    ).toBeNull();
  });

  it('does not let HMS observations mint requester trust', () => {
    const untrusted = {
      ...currentState(),
      requester: {
        ...currentState().requester,
        requesterClass: 'unknown',
        allowedClaimKinds: [],
      },
      observation: {
        requesterClass: 'reservation_guest',
        inquiryClass: 'labelled_narrow_status',
        allowedClaimKinds: ['reservation_summary'],
      },
    };
    expect(issue(untrusted)).toBeNull();
  });
});
