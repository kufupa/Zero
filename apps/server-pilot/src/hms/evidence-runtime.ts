/**
 * Phase B evidence-key / credential-version / runtime-fingerprint helpers.
 * Raw HMAC key stays child-process-only; callers persist digests/ARN/version only.
 */
import { createHash } from 'node:crypto';
import {
  sha256Integrity,
} from './private-digests.js';
import { credentialVersionHmacSha256 as canonicalCredentialVersionHmacSha256 } from '../../tooling/hms-cloud/credential-version.mjs';
import { HmsRuntimeError } from './runtime.js';

export type HmsSecretVersionMetadata = {
  versionId: string;
  versionStages: readonly string[];
};

export type HmsEvidenceHmacConfig = {
  /** Secrets Manager ARN for the evidence HMAC secret (metadata only). */
  secretArn: string;
  /** AWSCURRENT VersionId of the evidence HMAC secret. */
  keyVersion: string;
  /** Child-only key bytes — never persist to MailEnv / .env.production. */
  key: string | Buffer;
};

export type RuntimeFingerprintInput = {
  sourceRevision: string;
  playwrightRevision: string;
  chromiumRevision: string;
  runtimeAbiVersion?: string;
};

/** Derive credentialVersionHmacSha256 from HMS secret ARN + Secrets Manager VersionId. */
export function credentialVersionHmacSha256(input: {
  evidenceKey: string | Buffer;
  evidenceKeyVersion: string;
  hmsSecretArn: string;
  hmsSecretVersionId: string;
}): string {
  const arn = input.hmsSecretArn.trim();
  const versionId = input.hmsSecretVersionId.trim();
  if (!arn || !versionId) {
    throw new HmsRuntimeError(
      'CREDENTIAL_VERSION_MISSING',
      'HMS secret ARN and VersionId required for credential version HMAC',
    );
  }
  return canonicalCredentialVersionHmacSha256({ ...input, hmsSecretArn: arn, hmsSecretVersionId: versionId });
}

/** Public integrity fingerprint over runtime revision tuple (SHA-256, not HMAC). */
export function runtimeFingerprintSha256(
  input: RuntimeFingerprintInput,
): string {
  const sourceRevision = input.sourceRevision.trim();
  const playwrightRevision = input.playwrightRevision.trim();
  const chromiumRevision = input.chromiumRevision.trim();
  if (!sourceRevision || !playwrightRevision || !chromiumRevision) {
    throw new HmsRuntimeError(
      'RUNTIME_FINGERPRINT_INVALID',
      'concrete runtime revisions required for fingerprint',
    );
  }
  return sha256Integrity(
    JSON.stringify({
      sourceRevision,
      playwrightRevision,
      chromiumRevision,
      runtimeAbiVersion: input.runtimeAbiVersion?.trim() || '1',
    }),
  );
}

/**
 * Revalidate AWSCURRENT stage + evidence-key version + optional runtime fingerprint
 * before context/claim. Injected metadata only — no live AWS reads in tests.
 */
export function revalidateEvidenceBindings(input: {
  secretVersion: HmsSecretVersionMetadata;
  evidence: HmsEvidenceHmacConfig;
  expectedCredentialVersionHmacSha256?: string;
  expectedRuntimeFingerprintSha256?: string;
  runtimeFingerprint?: RuntimeFingerprintInput;
  hmsSecretArn: string;
}): {
  credentialVersionHmacSha256: string;
  runtimeFingerprintSha256: string | null;
} {
  const versionId = input.secretVersion.versionId.trim();
  if (!versionId) {
    throw new HmsRuntimeError(
      'CREDENTIAL_VERSION_MISSING',
      'Secrets Manager VersionId missing',
    );
  }
  // Missing/empty VersionStages = fail-closed (do not invent AWSCURRENT).
  if (
    !input.secretVersion.versionStages ||
    input.secretVersion.versionStages.length === 0
  ) {
    throw new HmsRuntimeError(
      'CREDENTIAL_VERSION_STAGES_MISSING',
      'Secrets Manager VersionStages required for evidence binding',
    );
  }
  if (!input.secretVersion.versionStages.includes('AWSCURRENT')) {
    throw new HmsRuntimeError(
      'CREDENTIAL_VERSION_STALE',
      'HMS secret VersionId is not AWSCURRENT',
    );
  }
  if (input.evidence.keyVersion.trim() !== input.evidence.keyVersion) {
    throw new HmsRuntimeError(
      'EVIDENCE_KEY_VERSION_INVALID',
      'evidence key version invalid',
    );
  }
  if (!input.evidence.keyVersion.trim()) {
    throw new HmsRuntimeError(
      'EVIDENCE_KEY_VERSION_INVALID',
      'evidence key version required',
    );
  }
  if (!input.evidence.secretArn.trim()) {
    throw new HmsRuntimeError(
      'EVIDENCE_KEY_ARN_INVALID',
      'evidence HMAC secret ARN required',
    );
  }

  const credentialHmac = credentialVersionHmacSha256({
    evidenceKey: input.evidence.key,
    evidenceKeyVersion: input.evidence.keyVersion,
    hmsSecretArn: input.hmsSecretArn,
    hmsSecretVersionId: versionId,
  });

  if (
    input.expectedCredentialVersionHmacSha256 &&
    input.expectedCredentialVersionHmacSha256 !== credentialHmac
  ) {
    throw new HmsRuntimeError(
      'CREDENTIAL_VERSION_DRIFT',
      'credential version HMAC drift',
    );
  }

  let runtimeFp: string | null = null;
  if (input.runtimeFingerprint) {
    runtimeFp = runtimeFingerprintSha256(input.runtimeFingerprint);
    if (
      input.expectedRuntimeFingerprintSha256 &&
      input.expectedRuntimeFingerprintSha256 !== runtimeFp
    ) {
      throw new HmsRuntimeError(
        'RUNTIME_FINGERPRINT_DRIFT',
        'runtime fingerprint drift',
      );
    }
  } else if (input.expectedRuntimeFingerprintSha256) {
    throw new HmsRuntimeError(
      'RUNTIME_FINGERPRINT_DRIFT',
      'runtime fingerprint required for binding check',
    );
  }

  return {
    credentialVersionHmacSha256: credentialHmac,
    runtimeFingerprintSha256: runtimeFp,
  };
}

/** Child-only evidence key parser — never write this into MailEnv. */
export function parseChildOnlyEvidenceHmacKey(
  raw: string | undefined,
): Buffer {
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new HmsRuntimeError(
      'EVIDENCE_KEY_MISSING',
      'HMS_EVIDENCE_HMAC_KEY required in child process only',
    );
  }
  const buf = Buffer.from(trimmed, 'base64');
  if (buf.byteLength < 32) {
    throw new HmsRuntimeError(
      'EVIDENCE_KEY_INVALID',
      'evidence HMAC key must decode to at least 32 bytes',
    );
  }
  return buf;
}

/** Stable hex helper for tests / fingerprints without importing node:crypto callers. */
export function sha256HexOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
