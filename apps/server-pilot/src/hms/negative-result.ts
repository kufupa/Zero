import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  hmsEvidenceBindingV1Schema,
  type HmsEvidenceBindingV1,
  assertHmsPropertyIdentity,
} from './release-kernel.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z
  .object({ evidenceId: z.string().uuid(), sha256: digest })
  .strict();

export { hmsEvidenceBindingV1Schema };
export type { HmsEvidenceBindingV1 };

const EVIDENCE_GATES = [
  'candidateSource',
  'surface',
  'nativeRequestDifferential',
  'response',
  'parserConservation',
  'scopeCompleteness',
  'controlPair',
  'candidateExhaustion',
] as const;

export type NegativeEvidenceGate = (typeof EVIDENCE_GATES)[number];

export const negativeResultCertificateV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    verifierVersion: z.string().min(1).max(64),
    binding: hmsEvidenceBindingV1Schema,
    candidateSource: evidence,
    surface: evidence,
    nativeRequestDifferential: evidence,
    response: evidence,
    parserConservation: evidence,
    scopeCompleteness: evidence,
    controlPair: evidence,
    candidateExhaustion: evidence,
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .superRefine((cert, ctx) => {
    try { assertHmsPropertyIdentity(cert.binding, cert.binding.propertyCode); } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'property identity mismatch', path: ['binding'] });
    }
    if (cert.verifierVersion !== cert.binding.verifierVersion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'verifierVersion must match binding.verifierVersion',
        path: ['verifierVersion'],
      });
    }
  });

export type NegativeResultCertificateV1 = z.infer<
  typeof negativeResultCertificateV1Schema
>;

/** Gate artifact fields that must equal certificate `HmsEvidenceBindingV1`. */
export type NegativeGateEvidenceArtifact = {
  evidenceId: string;
  sha256: string;
  toolId: HmsEvidenceBindingV1['toolId'];
  toolVersion: string;
  operationId: string;
  discoveryOperationId: HmsEvidenceBindingV1['discoveryOperationId'];
  candidateSnapshotSha256: string;
  propertyCode: HmsEvidenceBindingV1['propertyCode'];
  tenantId?: string; landingPropertyCode?: HmsEvidenceBindingV1['landingPropertyCode']; origin?: string;
  credentialVersionHmacSha256: string;
  runtimeFingerprintSha256: string;
  privateDigestKeyVersion: string;
  roleProofSha256: string;
  requestBranchId: string;
  sourceRevision: string;
  verifierVersion: string;
};

const ARTIFACT_BINDING_KEYS = [
  'toolId',
  'toolVersion',
  'operationId',
  'discoveryOperationId',
  'candidateSnapshotSha256',
  'propertyCode', 'tenantId', 'landingPropertyCode', 'origin',
  'credentialVersionHmacSha256',
  'runtimeFingerprintSha256',
  'privateDigestKeyVersion',
  'roleProofSha256',
  'requestBranchId',
  'sourceRevision',
  'verifierVersion',
] as const satisfies ReadonlyArray<keyof HmsEvidenceBindingV1>;

export function evidenceArtifactForBinding(
  ref: { evidenceId: string; sha256: string },
  binding: HmsEvidenceBindingV1,
): NegativeGateEvidenceArtifact {
  return {
    evidenceId: ref.evidenceId,
    sha256: ref.sha256,
    toolId: binding.toolId,
    toolVersion: binding.toolVersion,
    operationId: binding.operationId,
    discoveryOperationId: binding.discoveryOperationId,
    candidateSnapshotSha256: binding.candidateSnapshotSha256,
    propertyCode: binding.propertyCode, tenantId: binding.tenantId,
    landingPropertyCode: binding.landingPropertyCode, origin: binding.origin,
    credentialVersionHmacSha256: binding.credentialVersionHmacSha256,
    runtimeFingerprintSha256: binding.runtimeFingerprintSha256,
    privateDigestKeyVersion: binding.privateDigestKeyVersion,
    roleProofSha256: binding.roleProofSha256,
    requestBranchId: binding.requestBranchId,
    sourceRevision: binding.sourceRevision,
    verifierVersion: binding.verifierVersion,
  };
}

export function negativeGateEvidenceMatchesBinding(
  artifact: NegativeGateEvidenceArtifact,
  binding: HmsEvidenceBindingV1,
): boolean {
  for (const key of ARTIFACT_BINDING_KEYS) {
    if (artifact[key] !== binding[key]) return false;
  }
  return true;
}

export type QuarantinedNegative = {
  status: 'UNVERIFIED_NEGATIVE';
  diagnostic:
    | 'CANDIDATE_EXTRACTION_UNVERIFIED'
    | 'UNVERIFIED_NEGATIVE'
    | 'REQUEST_DRIFT'
    | 'RESPONSE_SCHEMA_DRIFT'
    | 'PARSER_GAP'
    | 'CORRELATION_GAP'
    | 'WINDOW_OR_PAGINATION_MISS'
    | 'ROLE_OR_PROPERTY_SCOPE'
    | 'BLOCKED_NO_CANDIDATE_AFTER_VERIFIED_SOURCE_EXHAUSTION'
    | 'BLOCKED_NO_POSITIVE_CONTROL';
};

/**
 * Module-private brand. Only `validateNegativeResultCertificate` can attach it,
 * so a forged plain `{ status: 'BUSINESS_NOT_FOUND' }` can never be promoted.
 */
const validatedNegativeBrand: unique symbol = Symbol('hms.validatedNegative');

export type ValidatedBusinessNotFound = {
  status: 'BUSINESS_NOT_FOUND';
  certificateSha256: string;
  readonly [validatedNegativeBrand]: true;
};

function isValidatedBusinessNotFound(
  result: ValidatedBusinessNotFound | QuarantinedNegative,
): result is ValidatedBusinessNotFound {
  return (
    result.status === 'BUSINESS_NOT_FOUND' &&
    (result as ValidatedBusinessNotFound)[validatedNegativeBrand] === true
  );
}

/** Unbranded input fails closed to quarantine; it never reaches the model as not_found. */
export function toBusinessNotFoundToolStatus(
  result: ValidatedBusinessNotFound | QuarantinedNegative,
): 'not_found' | 'unverified_negative' {
  return isValidatedBusinessNotFound(result) ? 'not_found' : 'unverified_negative';
}

const BINDING_FIELD_ORDER = [
  'toolId',
  'toolVersion',
  'operationId',
  'discoveryOperationId',
  'candidateSnapshotSha256',
  'propertyCode', 'tenantId', 'landingPropertyCode', 'origin',
  'credentialVersionHmacSha256',
  'runtimeFingerprintSha256',
  'privateDigestKeyVersion',
  'roleProofSha256',
  'requestBranchId',
  'sourceRevision',
  'verifierVersion',
] as const satisfies ReadonlyArray<keyof HmsEvidenceBindingV1>;

const CERT_FIELD_ORDER = [
  'schemaVersion',
  'verifierVersion',
  'binding',
  'candidateSource',
  'surface',
  'nativeRequestDifferential',
  'response',
  'parserConservation',
  'scopeCompleteness',
  'controlPair',
  'candidateExhaustion',
  'issuedAt',
  'expiresAt',
] as const satisfies ReadonlyArray<keyof NegativeResultCertificateV1>;

function orderedEvidence(ref: { evidenceId: string; sha256: string }) {
  return { evidenceId: ref.evidenceId, sha256: ref.sha256 };
}

function orderedBinding(binding: HmsEvidenceBindingV1): HmsEvidenceBindingV1 {
  const out = {} as HmsEvidenceBindingV1;
  for (const key of BINDING_FIELD_ORDER) {
    out[key] = binding[key] as never;
  }
  return out;
}

/** Schema-field-order canonical SHA-256; key-order permutations hash identically. */
export function canonicalNegativeCertificateSha256(
  certificate: NegativeResultCertificateV1,
): string {
  const cert = negativeResultCertificateV1Schema.parse(certificate);
  const ordered: Record<string, unknown> = {};
  for (const key of CERT_FIELD_ORDER) {
    if (key === 'binding') {
      ordered.binding = orderedBinding(cert.binding);
    } else if (
      key === 'candidateSource' ||
      key === 'surface' ||
      key === 'nativeRequestDifferential' ||
      key === 'response' ||
      key === 'parserConservation' ||
      key === 'scopeCompleteness' ||
      key === 'controlPair' ||
      key === 'candidateExhaustion'
    ) {
      ordered[key] = orderedEvidence(cert[key]);
    } else {
      ordered[key] = cert[key];
    }
  }
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

function hasDuplicateEvidenceIds(cert: NegativeResultCertificateV1): boolean {
  const ids = EVIDENCE_GATES.map((gate) => cert[gate].evidenceId);
  return new Set(ids).size !== ids.length;
}

export async function validateNegativeResultCertificate(input: {
  certificate: unknown;
  certificateSha256: string;
  now?: Date;
  /**
   * Load gate artifact. Return `null` when missing.
   * Validator checks digest + binding correlation; callback must not skip that.
   */
  verifyEvidence: (
    gate: NegativeEvidenceGate,
    ref: { evidenceId: string; sha256: string },
    binding: HmsEvidenceBindingV1,
  ) => Promise<NegativeGateEvidenceArtifact | null>;
}): Promise<ValidatedBusinessNotFound | QuarantinedNegative> {
  const parsed = negativeResultCertificateV1Schema.safeParse(input.certificate);
  if (!parsed.success || !digest.safeParse(input.certificateSha256).success) {
    return { status: 'UNVERIFIED_NEGATIVE', diagnostic: 'UNVERIFIED_NEGATIVE' };
  }
  const cert = parsed.data;
  if (hasDuplicateEvidenceIds(cert)) {
    return { status: 'UNVERIFIED_NEGATIVE', diagnostic: 'UNVERIFIED_NEGATIVE' };
  }
  const recomputed = canonicalNegativeCertificateSha256(cert);
  if (recomputed !== input.certificateSha256) {
    return { status: 'UNVERIFIED_NEGATIVE', diagnostic: 'UNVERIFIED_NEGATIVE' };
  }
  const now = (input.now ?? new Date()).getTime();
  if (Date.parse(cert.issuedAt) > now || Date.parse(cert.expiresAt) <= now) {
    return { status: 'UNVERIFIED_NEGATIVE', diagnostic: 'UNVERIFIED_NEGATIVE' };
  }
  const diagnostics: QuarantinedNegative['diagnostic'][] = [
    'CANDIDATE_EXTRACTION_UNVERIFIED',
    'ROLE_OR_PROPERTY_SCOPE',
    'REQUEST_DRIFT',
    'RESPONSE_SCHEMA_DRIFT',
    'PARSER_GAP',
    'WINDOW_OR_PAGINATION_MISS',
    'BLOCKED_NO_POSITIVE_CONTROL',
    'BLOCKED_NO_CANDIDATE_AFTER_VERIFIED_SOURCE_EXHAUSTION',
  ];
  for (const [index, gate] of EVIDENCE_GATES.entries()) {
    const ref = cert[gate];
    const artifact = await input.verifyEvidence(gate, ref, cert.binding);
    if (
      !artifact ||
      artifact.evidenceId !== ref.evidenceId ||
      artifact.sha256 !== ref.sha256 ||
      !negativeGateEvidenceMatchesBinding(artifact, cert.binding)
    ) {
      return { status: 'UNVERIFIED_NEGATIVE', diagnostic: diagnostics[index]! };
    }
  }
  return {
    status: 'BUSINESS_NOT_FOUND',
    certificateSha256: recomputed,
    [validatedNegativeBrand]: true,
  };
}
