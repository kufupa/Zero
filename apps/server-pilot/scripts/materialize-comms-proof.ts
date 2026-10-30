/**
 * Materialize masked communications proof artifacts on EC2 (digests only).
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { materializeMaskedCommsProofArtifacts } from '../src/hms/communications-proof-artifacts.js';
import { hmsActiveRegistryV2Schema } from '../src/hms/release-kernel.js';
import { runtimeFingerprintSha256 as fingerprintRuntime } from '../src/hms/evidence-runtime.js';

function dig(label: string): string {
  return createHash('sha256').update(`comms-mask:${label}`).digest('hex');
}

async function main(): Promise<void> {
  const toolId = (process.argv[2] || 'hms_sent_email_audit').trim() as
    | 'hms_sent_email_audit'
    | 'hms_list_documents';
  const registryPath =
    process.env.HMS_ACTIVE_REGISTRY_PATH?.trim() ||
    '/opt/nava/shared/hms-active-registry/active.json';
  const registry = hmsActiveRegistryV2Schema.parse(
    JSON.parse(await readFile(registryPath, 'utf8')),
  );
  const releaseId = registry.active[toolId];
  if (!releaseId) throw new Error(`${toolId} not active`);

  const sourceRevision =
    process.env.HMS_SEED_SOURCE_REVISION?.trim() ||
    process.env.NAVA_BUILD_COMMIT?.trim() ||
    '';
  if (!sourceRevision) throw new Error('source revision required');

  const runtimeFingerprintSha256 = fingerprintRuntime({
    sourceRevision,
    playwrightRevision: '1.63.0',
    chromiumRevision: '1243',
  });

  const out = await materializeMaskedCommsProofArtifacts({
    artifactRoot:
      process.env.HMS_BROWSER_ARTIFACT_ROOT?.trim() ||
      '/opt/nava/shared/hms-browser-artifacts',
    indexPath:
      process.env.HMS_PROTECTED_ARTIFACT_INDEX_PATH?.trim() ||
      '/opt/nava/shared/hms-protected-artifact-index/index.json',
    operationId: randomUUID(),
    releaseId,
    sourceRevision,
    toolId,
    credentialVersionHmacSha256: dig(`${toolId}:cred`),
    runtimeFingerprintSha256,
    privateDigestKeyVersion: 'v1',
    roleProofSha256: dig(`${toolId}:role`),
    requestBranchId:
      toolId === 'hms_sent_email_audit'
        ? 'sent_email_audit'
        : 'sent_email_documents',
    discoveryOperationId: 'sent_email_list',
    digests: {
      candidateSnapshotSha256: dig(`${toolId}:cand`),
      candidateHmacSha256: dig(`${toolId}:candH`),
      scopeHmacSha256: dig(`${toolId}:scope`),
      resultHmacSha256: dig(`${toolId}:result`),
      sourceRefHmacSha256: dig(`${toolId}:src`),
      discoveryReceiptSha256: dig(`${toolId}:disc`),
      oracleArtifactSha256: dig(`${toolId}:oracle`),
      maskedTraceSha256: dig(`${toolId}:trace`),
      maskedVideoSha256: null,
    },
  });

  console.log(
    JSON.stringify({
      ok: true,
      toolId,
      releaseId,
      artifactId: out.artifactId,
      privateArtifactIds: out.privateArtifactIds,
    }),
  );
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
