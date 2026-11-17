import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';

export const PRIVATE_DIGEST_PURPOSES = [
  'actor',
  'credential_version',
  'thread_id',
  'requester_identity',
  'candidate',
  'scope',
  'result',
  'source_ref',
  'request_header',
  'requester_authorization',
] as const;

export const privateDigestPurposeSchema = z.enum(PRIVATE_DIGEST_PURPOSES);
export type PrivateDigestPurpose = z.infer<typeof privateDigestPurposeSchema>;

export type VersionedPrivateDigest = {
  privateDigestKeyVersion: string;
  hmacSha256: string;
};

const DOMAIN = Buffer.from('nava:hms:private-digest:v1', 'utf8');

function asBuffer(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
}

function updateFramed(
  hmac: ReturnType<typeof createHmac>,
  value: string | Buffer,
): void {
  const bytes = asBuffer(value);
  hmac.update(Buffer.from(`${bytes.byteLength}:`, 'ascii'));
  hmac.update(bytes);
}

/**
 * HMAC private values under an explicit domain, purpose, and key version.
 * Callers persist only returned metadata, never key or source value.
 */
export function hmacSha256PrivateValue(input: {
  key: string | Buffer;
  keyVersion: string;
  purpose: PrivateDigestPurpose;
  value: string | Buffer;
}): VersionedPrivateDigest {
  const key = asBuffer(input.key);
  if (key.byteLength < 32) {
    throw new Error('private digest key must contain at least 32 bytes');
  }
  const keyVersion = input.keyVersion.trim();
  if (!keyVersion) {
    throw new Error('private digest key version is required');
  }
  const purpose = privateDigestPurposeSchema.parse(input.purpose);
  const hmac = createHmac('sha256', key);
  updateFramed(hmac, DOMAIN);
  updateFramed(hmac, keyVersion);
  updateFramed(hmac, purpose);
  updateFramed(hmac, input.value);
  return {
    privateDigestKeyVersion: keyVersion,
    hmacSha256: hmac.digest('hex'),
  };
}

/** Plain SHA-256 remains reserved for public code/file integrity. */
export function sha256Integrity(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Constant-time comparison for validated SHA-256/HMAC hex values. */
export function equalDigestHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
