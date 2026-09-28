import { createHash } from 'node:crypto';
import { chmod, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { READ_TOOLS } from '../../../../../apps/server-pilot/src/hms/read-tools.js';
import {
  assertConnectedBundleSourceFingerprint,
  assertConnectedRuntimeFingerprint,
  assertConnectedSecretBinding,
  loadConnectedProofBinding,
  loadConnectedRoleProof,
  validateConnectedSessionAuthorization,
  type ConnectedProofBindingSidecar,
} from '../src/hms/connected-proof-binding.js';
import type { HmsSessionAuthorization } from '../../../../../apps/server-pilot/src/hms/release-kernel.js';

const NOW = new Date('2026-09-17T12:00:00.000Z');
const CREDENTIAL_DIGEST = 'a'.repeat(64);
const RUNTIME_DIGEST = 'b'.repeat(64);
const ROLE_DIGEST = 'c'.repeat(64);
const ACTOR_DIGEST = 'd'.repeat(64);
const PRIVATE_KEY_VERSION = 'private-key-v4';
const SOURCE_REVISION = 'source-revision-20260917';

const V1_PROOF = {
  schemaVersion: 1,
  propertyCode: 'HRCEN',
  allowedSurfaces: ['Guest Stay'],
  deniedActions: [
    'new_record',
    'save',
    'delete',
    'duplicate',
    'check_in',
    'check_out',
    'document_generate',
    'document_send',
  ],
  issuedAt: '2026-09-17T11:00:00.000Z',
  expiresAt: '2026-09-18T11:00:00.000Z',
  evidenceRef: 'proof-evidence:find:20260917',
  evidenceSha256: 'e'.repeat(64),
} as const;

function proofBytes(proof: unknown): string {
  return `${JSON.stringify(proof)}\n`;
}

function auth(input: Partial<HmsSessionAuthorization> = {}): HmsSessionAuthorization {
  return {
    operationId: 'standalone-operation',
    toolId: 'hms_find_reservation',
    discoveryOperationId: 'guest_stay_search',
    releaseId: 'pre-promotion-connected-proof',
    requestBranchId: 'guest_stay_search',
    manifest: {} as HmsSessionAuthorization['manifest'],
    manifestSha256: 'f'.repeat(64),
    roleProofPath: '/tmp/role-proof.v1.json',
    roleProofSha256: '0'.repeat(64),
    credentialVersionHmacSha256: CREDENTIAL_DIGEST,
    runtimeFingerprintSha256: RUNTIME_DIGEST,
    privateDigestKeyVersion: PRIVATE_KEY_VERSION,
    sourceRevision: SOURCE_REVISION,
    expiresAt: '2026-09-17T13:00:00.000Z',
    ...input,
  };
}

function sidecar(input: {
  proofPath: string;
  proofSha256: string;
  folio?: ConnectedProofBindingSidecar['folio'];
}): ConnectedProofBindingSidecar {
  return {
    schemaVersion: 'hms-connected-proof-binding/v1',
    mode: 'pre_promotion',
    bindingId: 'connected-prepromotion-test-20260917',
    propertyCode: 'HRCEN',
    bundleSourceFingerprintSha256: '9'.repeat(64),
    secretVersionId: 'secret-version-test-1',
    credentialVersionHmacSha256: CREDENTIAL_DIGEST,
    runtimeFingerprintSha256: RUNTIME_DIGEST,
    privateDigestKeyVersion: PRIVATE_KEY_VERSION,
    sourceRevision: SOURCE_REVISION,
    find: {
      schemaVersion: 1,
      roleProofPath: input.proofPath,
      roleProofSha256: input.proofSha256,
    },
    ...(input.folio ? { folio: input.folio } : {}),
  };
}

async function writeBinding(
  proof: unknown = V1_PROOF,
  customize: (binding: ConnectedProofBindingSidecar, proofPath: string) => ConnectedProofBindingSidecar =
    (binding) => binding,
): Promise<{ bindingPath: string; proofPath: string; proofSha256: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hms-connected-proof-'));
  const proofPath = join(root, 'role-proof.json');
  const bytes = proofBytes(proof);
  await writeFile(proofPath, bytes, { mode: 0o444 });
  await chmod(proofPath, 0o444);
  const proofSha256 = createHash('sha256').update(bytes).digest('hex');
  const bindingPath = join(root, 'binding.json');
  const value = customize(sidecar({ proofPath, proofSha256 }), proofPath);
  await writeFile(bindingPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return { bindingPath, proofPath, proofSha256 };
}

describe('connected private proof binding', () => {
  it('accepts an isolated pre-promotion sidecar only when the real v1 proof bytes and scope match', async () => {
    const files = await writeBinding();
    const binding = await loadConnectedProofBinding(files.bindingPath);
    await expect(
      validateConnectedSessionAuthorization({
        binding,
        authorization: auth({
          roleProofPath: files.proofPath,
          roleProofSha256: files.proofSha256,
        }),
        now: NOW,
      }),
    ).resolves.toBeUndefined();
  });

  it('loads the exact proof bytes that were validated even if the path is replaced before loading', async () => {
    const files = await writeBinding();
    const binding = await loadConnectedProofBinding(files.bindingPath);
    await validateConnectedSessionAuthorization({
      binding,
      authorization: auth({
        roleProofPath: files.proofPath,
        roleProofSha256: files.proofSha256,
      }),
      now: NOW,
    });

    const replacement = { ...V1_PROOF, evidenceRef: 'replacement-proof' };
    await chmod(files.proofPath, 0o644);
    await writeFile(files.proofPath, proofBytes(replacement));
    await chmod(files.proofPath, 0o444);

    await expect(
      loadConnectedRoleProof(binding, files.proofPath, NOW),
    ).resolves.toMatchObject({ evidenceRef: V1_PROOF.evidenceRef });
  });

  it('fails closed when proof bytes change after the sidecar was captured', async () => {
    const files = await writeBinding();
    const binding = await loadConnectedProofBinding(files.bindingPath);
    await chmod(files.proofPath, 0o644);
    await writeFile(files.proofPath, `${proofBytes({ ...V1_PROOF, propertyCode: 'HRCEN' })}tampered`);
    await chmod(files.proofPath, 0o444);
    await expect(
      validateConnectedSessionAuthorization({
        binding,
        authorization: auth({
          roleProofPath: files.proofPath,
          roleProofSha256: files.proofSha256,
        }),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTED_PROOF_HASH_MISMATCH' });
  });

  it('fails before context when source revision metadata is not the sidecar value', async () => {
    const files = await writeBinding();
    const binding = await loadConnectedProofBinding(files.bindingPath);
    await expect(
      validateConnectedSessionAuthorization({
        binding,
        authorization: auth({
          roleProofPath: files.proofPath,
          roleProofSha256: files.proofSha256,
          sourceRevision: 'unbound-source-revision',
        }),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTED_PROOF_BINDING_MISMATCH' });
  });

  it('binds the loaded bundle, runtime tuple, and credential version rather than sidecar text alone', async () => {
    const files = await writeBinding();
    const binding = await loadConnectedProofBinding(files.bindingPath);
    const manifestPath = join(dirname(files.bindingPath), 'bundle-manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 'hms-stagehand-bundle/v1',
        sourceFingerprint: '8'.repeat(64),
      }),
      { mode: 0o644 },
    );
    await expect(
      assertConnectedBundleSourceFingerprint(binding, manifestPath),
    ).rejects.toMatchObject({ code: 'CONNECTED_SOURCE_FINGERPRINT_MISMATCH' });
    expect(() =>
      assertConnectedRuntimeFingerprint(binding, {
        sourceRevision: SOURCE_REVISION,
        playwrightRevision: 'wrong-playwright',
        chromiumRevision: '1169',
      }),
    ).toThrowError(expect.objectContaining({ code: 'CONNECTED_RUNTIME_FINGERPRINT_MISMATCH' }));
    expect(() =>
      assertConnectedSecretBinding({
        binding,
        propertyCode: 'HRCEN',
        secretVersion: { versionId: 'different-secret-version', versionStages: ['AWSCURRENT'] },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CONNECTED_CREDENTIAL_VERSION_MISMATCH' }));
  });

  it('fails closed for a missing proof file and an expired session lease', async () => {
    const missingFiles = await writeBinding();
    const missingBinding = await loadConnectedProofBinding(missingFiles.bindingPath);
    await unlink(missingFiles.proofPath);
    await expect(
      validateConnectedSessionAuthorization({
        binding: missingBinding,
        authorization: auth({
          roleProofPath: missingFiles.proofPath,
          roleProofSha256: missingFiles.proofSha256,
        }),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTED_PROOF_MISSING' });

    const expiredFiles = await writeBinding();
    const expiredBinding = await loadConnectedProofBinding(expiredFiles.bindingPath);
    await expect(
      validateConnectedSessionAuthorization({
        binding: expiredBinding,
        authorization: auth({
          roleProofPath: expiredFiles.proofPath,
          roleProofSha256: expiredFiles.proofSha256,
          expiresAt: '2026-09-17T11:59:59.000Z',
        }),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTED_PROOF_EXPIRED' });
  });

  it('requires a folio v2 proof to carry the supplied actor and evidence scope', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111';
    const evidenceArtifactId = '22222222-2222-4222-8222-222222222222';
    const folioProof = {
      schemaVersion: 2,
      attestationKind: 'operator_observed_runtime',
      toolId: 'hms_read_folio',
      discoveryOperationId: 'folio_summary',
      operationId,
      observerSourceRevision: SOURCE_REVISION,
      evidenceArtifactId,
      privateDigestKeyVersion: PRIVATE_KEY_VERSION,
      actorHmacSha256: ACTOR_DIGEST,
      credentialVersionHmacSha256: CREDENTIAL_DIGEST,
      runtimeFingerprintSha256: RUNTIME_DIGEST,
      roleFingerprintSha256: ROLE_DIGEST,
      propertyCode: 'HRCEN',
      currency: 'ZAR',
      credentialMode: 'view_only',
      allowedSurfaces: ['folio', 'deposit_ledger'],
      deniedActions: [...READ_TOOLS.hms_read_folio.deniedActions],
      issuedAt: '2026-09-17T11:00:00.000Z',
      expiresAt: '2026-09-18T11:00:00.000Z',
      evidenceSha256: 'e'.repeat(64),
    } as const;
    const files = await writeBinding(folioProof, (binding, proofPath) => ({
      ...binding,
      folio: {
        schemaVersion: 2,
        roleProofPath: proofPath,
        roleProofSha256: createHash('sha256').update(proofBytes(folioProof)).digest('hex'),
        toolId: 'hms_read_folio',
        expectedActorHmacSha256: ACTOR_DIGEST,
        expectedEvidenceArtifactId: evidenceArtifactId,
        expectedEvidenceSha256: folioProof.evidenceSha256,
      },
    }));
    const binding = await loadConnectedProofBinding(files.bindingPath);
    await expect(
      validateConnectedSessionAuthorization({
        binding,
        authorization: auth({
          operationId,
          toolId: 'hms_read_folio',
          discoveryOperationId: 'folio_summary',
          requestBranchId: 'folio_summary',
          roleProofPath: files.proofPath,
          roleProofSha256: files.proofSha256,
        }),
        now: NOW,
      }),
    ).resolves.toBeUndefined();

    const mismatchedActorBinding = {
      ...binding,
      folio: {
        ...binding.folio!,
        expectedActorHmacSha256: '1'.repeat(64),
      },
    };
    await expect(
      validateConnectedSessionAuthorization({
        binding: mismatchedActorBinding,
        authorization: auth({
          operationId,
          toolId: 'hms_read_folio',
          discoveryOperationId: 'folio_summary',
          requestBranchId: 'folio_summary',
          roleProofPath: files.proofPath,
          roleProofSha256: files.proofSha256,
        }),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTED_PROOF_ACTOR_MISMATCH' });
  });

  it('rejects a v1 sent proof while retaining the notes/find v1 compatibility path', async () => {
    const files = await writeBinding(V1_PROOF, (binding, proofPath) => ({
      ...binding,
      sent: {
        schemaVersion: 1,
        roleProofPath: proofPath,
        roleProofSha256: binding.find.roleProofSha256,
      },
    }));
    const binding = await loadConnectedProofBinding(files.bindingPath);

    await expect(
      validateConnectedSessionAuthorization({
        binding,
        authorization: auth({
          toolId: 'hms_sent_email_audit',
          discoveryOperationId: 'sent_email_list',
          requestBranchId: 'sent_email_audit',
          roleProofPath: files.proofPath,
          roleProofSha256: files.proofSha256,
        }),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTED_PROOF_SCOPE_INVALID' });
  });
});
