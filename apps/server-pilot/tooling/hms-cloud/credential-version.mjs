import { createHmac } from 'node:crypto';

/** Canonical credential-version digest shared by native sessions and runtime proofs. */
export function credentialVersionHmacSha256(input) {
  const key = Buffer.isBuffer(input.evidenceKey) ? input.evidenceKey : Buffer.from(input.evidenceKey, 'utf8');
  if (key.byteLength < 32) throw new Error('private digest key must contain at least 32 bytes');
  const keyVersion = input.evidenceKeyVersion.trim();
  if (!keyVersion) throw new Error('private digest key version is required');
  const secretArn = input.hmsSecretArn.trim();
  const versionId = input.hmsSecretVersionId.trim();
  if (!secretArn || !versionId) throw new Error('HMS_CREDENTIAL_VERSION_MISSING');
  const hmac = createHmac('sha256', key);
  for (const value of ['nava:hms:private-digest:v1', keyVersion, 'credential_version',
    JSON.stringify({ secretArn, versionId })]) {
    const bytes = Buffer.from(value, 'utf8');
    hmac.update(Buffer.from(`${bytes.byteLength}:`, 'ascii'));
    hmac.update(bytes);
  }
  return hmac.digest('hex');
}
