import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalNegativeCertificateSha256,
  evidenceArtifactForBinding,
  hmsEvidenceBindingV1Schema,
  negativeGateEvidenceMatchesBinding,
  negativeResultCertificateV1Schema,
  toBusinessNotFoundToolStatus,
  validateNegativeResultCertificate,
  type HmsEvidenceBindingV1,
  type NegativeGateEvidenceArtifact,
  type NegativeResultCertificateV1,
} from '../src/hms/negative-result.js';
import { READ_TOOLS } from '../src/hms/read-tools.js';

const sha = (n: number | string) =>
  createHash('sha256').update(String(n)).digest('hex');

function binding(
  overrides: Partial<HmsEvidenceBindingV1> = {},
): HmsEvidenceBindingV1 {
  return hmsEvidenceBindingV1Schema.parse({
    toolId: 'hms_find_reservation',
    toolVersion: READ_TOOLS.hms_find_reservation.version,
    operationId: randomUUID(),
    discoveryOperationId: 'guest_stay_search',
    candidateSnapshotSha256: sha('snap'),
    propertyCode: 'HRCEN',
    credentialVersionHmacSha256: sha('cred'),
    runtimeFingerprintSha256: sha('runtime'),
    privateDigestKeyVersion: 'v1',
    roleProofSha256: sha('role'),
    requestBranchId: 'guest_stay_search',
    sourceRevision: 'abc1234',
    verifierVersion: '1',
    ...overrides,
  });
}

function ref(id?: string, digest?: string) {
  return {
    evidenceId: id ?? randomUUID(),
    sha256: digest ?? sha(randomUUID()),
  };
}

function certificate(
  overrides: Partial<NegativeResultCertificateV1> = {},
): NegativeResultCertificateV1 {
  const b = overrides.binding ?? binding();
  return negativeResultCertificateV1Schema.parse({
    schemaVersion: 1,
    verifierVersion: b.verifierVersion,
    binding: b,
    candidateSource: ref(),
    surface: ref(),
    nativeRequestDifferential: ref(),
    response: ref(),
    parserConservation: ref(),
    scopeCompleteness: ref(),
    controlPair: ref(),
    candidateExhaustion: ref(),
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  });
}

/** Happy-path verifyEvidence: every gate returns artifact bound to certificate. */
function verifyMatching(
  overrides: Partial<NegativeGateEvidenceArtifact> = {},
): (
  gate: string,
  ref: { evidenceId: string; sha256: string },
  binding: HmsEvidenceBindingV1,
) => Promise<NegativeGateEvidenceArtifact | null> {
  return async (_gate, gateRef, b) => ({
    ...evidenceArtifactForBinding(gateRef, b),
    ...overrides,
  });
}

describe('HmsEvidenceBindingV1', () => {
  it('accepts closed HMS binding and rejects mail toolId', () => {
    expect(binding().propertyCode).toBe('HRCEN');
    expect(() =>
      hmsEvidenceBindingV1Schema.parse({
        ...binding(),
        toolId: 'mail_read_artifact',
      }),
    ).toThrow();
  });
});

describe('NegativeResultCertificateV1 canonical digest', () => {
  it('recomputes schema-ordered SHA-256 and ignores key-order permutations', () => {
    const cert = certificate();
    const digest = canonicalNegativeCertificateSha256(cert);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);

    const permuted = {
      expiresAt: cert.expiresAt,
      issuedAt: cert.issuedAt,
      candidateExhaustion: cert.candidateExhaustion,
      controlPair: cert.controlPair,
      scopeCompleteness: cert.scopeCompleteness,
      parserConservation: cert.parserConservation,
      response: cert.response,
      nativeRequestDifferential: cert.nativeRequestDifferential,
      surface: cert.surface,
      candidateSource: cert.candidateSource,
      binding: {
        verifierVersion: cert.binding.verifierVersion,
        sourceRevision: cert.binding.sourceRevision,
        requestBranchId: cert.binding.requestBranchId,
        roleProofSha256: cert.binding.roleProofSha256,
        privateDigestKeyVersion: cert.binding.privateDigestKeyVersion,
        runtimeFingerprintSha256: cert.binding.runtimeFingerprintSha256,
        credentialVersionHmacSha256: cert.binding.credentialVersionHmacSha256,
        propertyCode: cert.binding.propertyCode,
        candidateSnapshotSha256: cert.binding.candidateSnapshotSha256,
        discoveryOperationId: cert.binding.discoveryOperationId,
        operationId: cert.binding.operationId,
        toolVersion: cert.binding.toolVersion,
        toolId: cert.binding.toolId,
      },
      verifierVersion: cert.verifierVersion,
      schemaVersion: cert.schemaVersion,
    };
    expect(canonicalNegativeCertificateSha256(permuted as NegativeResultCertificateV1)).toBe(
      digest,
    );
  });

  it('rejects caller digest mismatch, duplicate evidence, and binding drift', async () => {
    const cert = certificate();
    const digest = canonicalNegativeCertificateSha256(cert);

    await expect(
      validateNegativeResultCertificate({
        certificate: cert,
        certificateSha256: sha('wrong'),
        verifyEvidence: verifyMatching(),
      }),
    ).resolves.toEqual({
      status: 'UNVERIFIED_NEGATIVE',
      diagnostic: 'UNVERIFIED_NEGATIVE',
    });

    const dupId = randomUUID();
    const duped = certificate({
      candidateSource: ref(dupId, sha('a')),
      surface: ref(dupId, sha('b')),
    });
    await expect(
      validateNegativeResultCertificate({
        certificate: duped,
        certificateSha256: canonicalNegativeCertificateSha256(duped),
        verifyEvidence: verifyMatching(),
      }),
    ).resolves.toEqual({
      status: 'UNVERIFIED_NEGATIVE',
      diagnostic: 'UNVERIFIED_NEGATIVE',
    });

    const driftedRaw = {
      ...cert,
      binding: binding({ verifierVersion: '1' }),
      verifierVersion: '2',
    };
    await expect(
      validateNegativeResultCertificate({
        certificate: driftedRaw,
        certificateSha256: sha('anything'),
        verifyEvidence: verifyMatching(),
      }),
    ).resolves.toEqual({
      status: 'UNVERIFIED_NEGATIVE',
      diagnostic: 'UNVERIFIED_NEGATIVE',
    });

    await expect(
      validateNegativeResultCertificate({
        certificate: cert,
        certificateSha256: digest,
        verifyEvidence: verifyMatching(),
      }),
    ).resolves.toMatchObject({
      status: 'BUSINESS_NOT_FOUND',
      certificateSha256: digest,
    });
  });

  it('rejects missing and cross-run gate evidence that does not match binding', async () => {
    const cert = certificate();
    const digest = canonicalNegativeCertificateSha256(cert);

    await expect(
      validateNegativeResultCertificate({
        certificate: cert,
        certificateSha256: digest,
        verifyEvidence: async (gate, gateRef, b) =>
          gate === 'surface' ? null : evidenceArtifactForBinding(gateRef, b),
      }),
    ).resolves.toEqual({
      status: 'UNVERIFIED_NEGATIVE',
      diagnostic: 'ROLE_OR_PROPERTY_SCOPE',
    });

    const crossRunOp = randomUUID();
    expect(
      negativeGateEvidenceMatchesBinding(
        {
          ...evidenceArtifactForBinding(cert.candidateSource, cert.binding),
          operationId: crossRunOp,
        },
        cert.binding,
      ),
    ).toBe(false);

    await expect(
      validateNegativeResultCertificate({
        certificate: cert,
        certificateSha256: digest,
        verifyEvidence: async (gate, gateRef, b) => {
          const artifact = evidenceArtifactForBinding(gateRef, b);
          return gate === 'candidateSource'
            ? { ...artifact, operationId: crossRunOp }
            : artifact;
        },
      }),
    ).resolves.toEqual({
      status: 'UNVERIFIED_NEGATIVE',
      diagnostic: 'CANDIDATE_EXTRACTION_UNVERIFIED',
    });
  });

  it('rejects binding drift on tool/version/snapshot/role/branch/source beyond verifierVersion', async () => {
    const cert = certificate();
    const digest = canonicalNegativeCertificateSha256(cert);
    const drifts: Array<{
      field: keyof HmsEvidenceBindingV1;
      value: string;
      gateDiagnostic: string;
    }> = [
      {
        field: 'toolVersion',
        value: '9.9.9',
        gateDiagnostic: 'CANDIDATE_EXTRACTION_UNVERIFIED',
      },
      {
        field: 'candidateSnapshotSha256',
        value: sha('other-snap'),
        gateDiagnostic: 'CANDIDATE_EXTRACTION_UNVERIFIED',
      },
      {
        field: 'roleProofSha256',
        value: sha('other-role'),
        gateDiagnostic: 'CANDIDATE_EXTRACTION_UNVERIFIED',
      },
      {
        field: 'requestBranchId',
        value: 'folio_summary',
        gateDiagnostic: 'CANDIDATE_EXTRACTION_UNVERIFIED',
      },
      {
        field: 'sourceRevision',
        value: 'other-rev',
        gateDiagnostic: 'CANDIDATE_EXTRACTION_UNVERIFIED',
      },
    ];

    for (const drift of drifts) {
      await expect(
        validateNegativeResultCertificate({
          certificate: cert,
          certificateSha256: digest,
          verifyEvidence: async (_gate, gateRef, b) => ({
            ...evidenceArtifactForBinding(gateRef, b),
            [drift.field]: drift.value,
          }),
        }),
      ).resolves.toEqual({
        status: 'UNVERIFIED_NEGATIVE',
        diagnostic: drift.gateDiagnostic,
      });
    }
  });

  it('maps only branded validator output to model-visible not_found', async () => {
    const cert = certificate();
    const digest = canonicalNegativeCertificateSha256(cert);
    const validated = await validateNegativeResultCertificate({
      certificate: cert,
      certificateSha256: digest,
      verifyEvidence: verifyMatching(),
    });
    expect(toBusinessNotFoundToolStatus(validated)).toBe('not_found');
    expect(
      toBusinessNotFoundToolStatus({
        status: 'BUSINESS_NOT_FOUND',
        certificateSha256: digest,
      } as never),
    ).toBe('unverified_negative');
  });

  it('returns gate-specific diagnostics when independent evidence fails', async () => {
    const cert = certificate();
    await expect(
      validateNegativeResultCertificate({
        certificate: cert,
        certificateSha256: canonicalNegativeCertificateSha256(cert),
        verifyEvidence: async (gate, gateRef, b) =>
          gate === 'parserConservation'
            ? null
            : evidenceArtifactForBinding(gateRef, b),
      }),
    ).resolves.toEqual({
      status: 'UNVERIFIED_NEGATIVE',
      diagnostic: 'PARSER_GAP',
    });
  });
});
