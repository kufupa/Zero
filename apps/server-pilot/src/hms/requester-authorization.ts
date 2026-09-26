import {
  inquiryClassSchema,
  requesterClassSchema,
  trustedRequesterAuthorizationV1Schema,
  trustedRequesterClaimKindSchema,
  type TrustedRequesterAuthorizationV1,
  type TrustedRequesterClaimKind,
} from './contracts.js';
import { equalDigestHex, hmacSha256PrivateValue } from './private-digests.js';
import { z } from 'zod';

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

const mailboxGrantStateSchema = z
  .object({
    sha256: sha256HexSchema,
    transportId: z.string().min(1),
    active: z.boolean(),
  })
  .strict();

const requesterStateSchema = z
  .object({
    identity: z.string().min(1),
    requesterClass: requesterClassSchema,
    inquiryClass: inquiryClassSchema,
    allowedClaimKinds: z.array(trustedRequesterClaimKindSchema).min(1),
    forwarded: z.boolean(),
    spoofed: z.boolean(),
  })
  .strict()
  .superRefine((requester, context) => {
    if (new Set(requester.allowedClaimKinds).size !== requester.allowedClaimKinds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedClaimKinds'],
        message: 'allowed claim kinds must be unique',
      });
    }
  });

export const trustedRequesterSourceStateSchema = z
  .object({
    operationId: z.string().min(1),
    mailboxGrant: mailboxGrantStateSchema,
    thread: z
      .object({
        transportId: z.string().min(1),
        threadId: z.string().min(1),
        stateVersion: z.string().min(1),
      })
      .strict(),
    requester: requesterStateSchema,
  })
  .strict();

export type TrustedRequesterSourceState = z.infer<typeof trustedRequesterSourceStateSchema>;

type PrivateDigestKey = string | Buffer;

const CURRENT_APP_ACCESS_PROOF_MARKER = Symbol('current-app-access-proof');

export type CurrentAppAccessProof = {
  readonly userId: string;
  readonly mailboxAccessId: string;
  readonly transportId: string;
  readonly threadId: string;
  readonly triggerMessageId: string;
  readonly expiresAt: string;
  readonly [CURRENT_APP_ACCESS_PROOF_MARKER]: true;
};

/**
 * Server-owned proof minted only after the authenticated worker revalidates
 * the current mailbox grant and scoped inbound trigger.  The private marker
 * prevents a JSON/requester claim from being treated as current app access.
 */
export function issueCurrentAppAccessProof(input: {
  userId: string;
  mailboxAccessId: string;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  expiresAt: Date | string;
  now: Date;
}): CurrentAppAccessProof {
  const values = [
    input.userId,
    input.mailboxAccessId,
    input.transportId,
    input.threadId,
    input.triggerMessageId,
  ];
  const expiresAt =
    input.expiresAt instanceof Date
      ? input.expiresAt.toISOString()
      : new Date(input.expiresAt).toISOString();
  if (
    values.some((value) => !value.trim()) ||
    !Number.isFinite(input.now.getTime()) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= input.now.getTime()
  ) {
    throw Object.assign(new Error('current app access proof is invalid or expired'), {
      code: 'READ_CURRENT_APP_ACCESS_REQUIRED',
    });
  }
  const proof = {
    userId: input.userId,
    mailboxAccessId: input.mailboxAccessId,
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    expiresAt,
  } as CurrentAppAccessProof;
  Object.defineProperty(proof, CURRENT_APP_ACCESS_PROOF_MARKER, {
    value: true,
    enumerable: false,
    writable: false,
  });
  return proof;
}

export function assertCurrentAppAccessProof(input: {
  proof: unknown;
  requesterAuthorizationId: string;
  context: {
    transportId: string;
    threadId: string;
    triggerMessageId: string;
  };
  now: Date;
}): void {
  const proof = input.proof as Partial<CurrentAppAccessProof> | null;
  if (!proof || proof[CURRENT_APP_ACCESS_PROOF_MARKER] !== true) {
    throw Object.assign(new Error('current authenticated app access is required'), {
      code: 'READ_CURRENT_APP_ACCESS_REQUIRED',
    });
  }
  const expiresAtMs = Date.parse(proof.expiresAt ?? '');
  if (!Number.isFinite(expiresAtMs) || input.now.getTime() >= expiresAtMs) {
    throw Object.assign(new Error('current authenticated app access has expired'), {
      code: 'READ_CURRENT_APP_ACCESS_EXPIRED',
    });
  }
  if (
    proof.mailboxAccessId !== input.requesterAuthorizationId ||
    proof.transportId !== input.context.transportId ||
    proof.threadId !== input.context.threadId ||
    proof.triggerMessageId !== input.context.triggerMessageId
  ) {
    throw Object.assign(new Error('current authenticated app access scope does not match read'), {
      code: 'READ_CURRENT_APP_ACCESS_SCOPE_MISMATCH',
    });
  }
}

export type IssueTrustedRequesterAuthorizationOptions = {
  key: PrivateDigestKey;
  keyVersion: string;
  issuedAt: Date;
  expiresAt: Date;
};

const TRUSTED_REQUESTER_CLASSES = new Set([
  'reservation_guest',
  'authorized_booking_contact',
  'internal_finance',
]);

function sourceStateCanAuthorize(state: TrustedRequesterSourceState): boolean {
  return (
    state.mailboxGrant.active &&
    state.mailboxGrant.transportId === state.thread.transportId &&
    !state.requester.forwarded &&
    !state.requester.spoofed &&
    TRUSTED_REQUESTER_CLASSES.has(state.requester.requesterClass)
  );
}

function sortedClaimKinds(
  claimKinds: readonly TrustedRequesterClaimKind[],
): TrustedRequesterClaimKind[] {
  return [...claimKinds].sort();
}

function authorizationMacPayload(
  authorization: Omit<TrustedRequesterAuthorizationV1, 'authorizationId'>,
): string {
  return JSON.stringify({
    schemaVersion: authorization.schemaVersion,
    operationId: authorization.operationId,
    mailboxGrantSha256: authorization.mailboxGrantSha256,
    threadIdHmacSha256: authorization.threadIdHmacSha256,
    threadStateVersion: authorization.threadStateVersion,
    requesterIdentityHmacSha256: authorization.requesterIdentityHmacSha256,
    requesterClass: authorization.requesterClass,
    inquiryClass: authorization.inquiryClass,
    allowedClaimKinds: authorization.allowedClaimKinds,
    privateDigestKeyVersion: authorization.privateDigestKeyVersion,
    issuedAt: authorization.issuedAt,
    expiresAt: authorization.expiresAt,
  });
}

function buildAuthorization(
  state: TrustedRequesterSourceState,
  options: IssueTrustedRequesterAuthorizationOptions,
): TrustedRequesterAuthorizationV1 | null {
  const issuedAtMs = options.issuedAt.getTime();
  const expiresAtMs = options.expiresAt.getTime();
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= issuedAtMs) {
    return null;
  }
  const keyVersion = options.keyVersion.trim();
  if (!keyVersion || !sourceStateCanAuthorize(state)) return null;

  const threadIdHmacSha256 = hmacSha256PrivateValue({
    key: options.key,
    keyVersion,
    purpose: 'thread_id',
    value: JSON.stringify({
      transportId: state.thread.transportId,
      threadId: state.thread.threadId,
    }),
  }).hmacSha256;
  const requesterIdentityHmacSha256 = hmacSha256PrivateValue({
    key: options.key,
    keyVersion,
    purpose: 'requester_identity',
    value: JSON.stringify({
      transportId: state.thread.transportId,
      threadId: state.thread.threadId,
      identity: state.requester.identity,
    }),
  }).hmacSha256;

  const unsigned: Omit<TrustedRequesterAuthorizationV1, 'authorizationId'> = {
    schemaVersion: 1,
    operationId: state.operationId,
    mailboxGrantSha256: state.mailboxGrant.sha256,
    threadIdHmacSha256,
    threadStateVersion: state.thread.stateVersion,
    requesterIdentityHmacSha256,
    requesterClass: state.requester.requesterClass,
    inquiryClass: state.requester.inquiryClass,
    allowedClaimKinds: sortedClaimKinds(state.requester.allowedClaimKinds),
    privateDigestKeyVersion: keyVersion,
    issuedAt: options.issuedAt.toISOString(),
    expiresAt: options.expiresAt.toISOString(),
  };
  const authorizationId = hmacSha256PrivateValue({
    key: options.key,
    keyVersion,
    purpose: 'requester_authorization',
    value: authorizationMacPayload(unsigned),
  }).hmacSha256;

  return trustedRequesterAuthorizationV1Schema.parse({
    schemaVersion: 1,
    authorizationId,
    operationId: unsigned.operationId,
    mailboxGrantSha256: unsigned.mailboxGrantSha256,
    threadIdHmacSha256: unsigned.threadIdHmacSha256,
    threadStateVersion: unsigned.threadStateVersion,
    requesterIdentityHmacSha256: unsigned.requesterIdentityHmacSha256,
    requesterClass: unsigned.requesterClass,
    inquiryClass: unsigned.inquiryClass,
    allowedClaimKinds: unsigned.allowedClaimKinds,
    privateDigestKeyVersion: unsigned.privateDigestKeyVersion,
    issuedAt: unsigned.issuedAt,
    expiresAt: unsigned.expiresAt,
  });
}

/**
 * Issue only from strict server-owned state. Unknown observation fields,
 * inactive/cross-transport grants, and untrusted requester classes fail closed.
 */
export function issueTrustedRequesterAuthorization(
  currentState: unknown,
  options: IssueTrustedRequesterAuthorizationOptions,
): TrustedRequesterAuthorizationV1 | null {
  const state = trustedRequesterSourceStateSchema.safeParse(currentState);
  if (!state.success) return null;
  try {
    return buildAuthorization(state.data, options);
  } catch {
    return null;
  }
}

export type ValidateTrustedRequesterAuthorizationInput = {
  authorization: unknown;
  currentState: unknown;
  requiredClaimKind: TrustedRequesterClaimKind;
  key: PrivateDigestKey;
  expectedPrivateDigestKeyVersion: string;
  now: Date;
};

/**
 * Rebuild authorization from current trusted state. Any stale, forged,
 * cross-thread, key-rotated, or claim-mismatched value returns null.
 */
export function validateTrustedRequesterAuthorization(
  input: ValidateTrustedRequesterAuthorizationInput,
): TrustedRequesterAuthorizationV1 | null {
  const authorization = trustedRequesterAuthorizationV1Schema.safeParse(input.authorization);
  const state = trustedRequesterSourceStateSchema.safeParse(input.currentState);
  const requiredClaimKind = trustedRequesterClaimKindSchema.safeParse(input.requiredClaimKind);
  if (!authorization.success || !state.success || !requiredClaimKind.success) {
    return null;
  }
  if (!sourceStateCanAuthorize(state.data)) return null;

  const nowMs = input.now.getTime();
  const issuedAtMs = Date.parse(authorization.data.issuedAt);
  const expiresAtMs = Date.parse(authorization.data.expiresAt);
  if (!Number.isFinite(nowMs) || nowMs < issuedAtMs || nowMs >= expiresAtMs) {
    return null;
  }
  if (
    authorization.data.privateDigestKeyVersion !== input.expectedPrivateDigestKeyVersion ||
    !authorization.data.allowedClaimKinds.includes(requiredClaimKind.data)
  ) {
    return null;
  }

  try {
    const expected = buildAuthorization(state.data, {
      key: input.key,
      keyVersion: input.expectedPrivateDigestKeyVersion,
      issuedAt: new Date(authorization.data.issuedAt),
      expiresAt: new Date(authorization.data.expiresAt),
    });
    if (
      !expected ||
      !equalDigestHex(authorization.data.authorizationId, expected.authorizationId) ||
      JSON.stringify(authorization.data) !== JSON.stringify(expected)
    ) {
      return null;
    }
    return authorization.data;
  } catch {
    return null;
  }
}

/**
 * Scope check used by the independent typed read lane.  The regular HMAC
 * authorization remains the source of truth; this small adapter binds the
 * already-issued grant to the concrete worker context before a read handler
 * is admitted.
 */
export function assertReadRequesterScope(input: {
  requester: {
    authorizationId: string;
    transportId: string;
    threadId: string;
    triggerMessageId: string;
    allowedClaimKinds: readonly string[];
    expiresAt: string;
  };
  /** Claim class required by the closed read tool (reservation by default). */
  requiredClaimKind?: string;
  context: {
    transportId: string;
    threadId: string;
    triggerMessageId: string;
  };
  now: Date;
  currentAppAccessProof?: CurrentAppAccessProof;
  requireCurrentAppAccess?: boolean;
}): void {
  const expiry = Date.parse(input.requester.expiresAt);
  if (
    !input.requester.authorizationId ||
    !Number.isFinite(expiry) ||
    !Number.isFinite(input.now.getTime()) ||
    input.now.getTime() >= expiry
  ) {
    throw Object.assign(new Error('read authorization is expired'), {
      code: 'READ_AUTHORIZATION_EXPIRED',
    });
  }
  if (
    input.requester.transportId !== input.context.transportId ||
    input.requester.threadId !== input.context.threadId ||
    input.requester.triggerMessageId !== input.context.triggerMessageId
  ) {
    throw Object.assign(new Error('read authorization scope does not match request'), {
      code: 'READ_AUTHORIZATION_SCOPE_MISMATCH',
    });
  }
  if (input.requireCurrentAppAccess) {
    assertCurrentAppAccessProof({
      proof: input.currentAppAccessProof,
      requesterAuthorizationId: input.requester.authorizationId,
      context: input.context,
      now: input.now,
    });
    return;
  }
  const requiredClaimKind = input.requiredClaimKind ?? 'reservation_summary';
  if (!input.requester.allowedClaimKinds.includes(requiredClaimKind)) {
    throw Object.assign(new Error(`requester is not entitled to ${requiredClaimKind} reads`), {
      code: 'READ_CLAIM_NOT_ALLOWED',
    });
  }
}
