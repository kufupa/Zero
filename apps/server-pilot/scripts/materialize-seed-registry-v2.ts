/**
 * Materialize find@1.2.0 + mail@2 seed release-v2 files and registry-candidate.
 * Digests/IDs only — no secrets. Run on EC2 from apps/server-pilot.
 * runtimeFingerprintSha256 must match worker (sourceRevision + PW/Chromium pins).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFingerprintSha256 as fingerprintRuntime } from '../src/hms/evidence-runtime.js';
import {
  FIND_RESERVATION_IMPL_V1,
  MAIL_ARTIFACT_IMPL_V1,
} from '../src/hms/read-handler-index.js';
import { fingerprintReadToolRegistry } from '../src/hms/read-tools.js';
import {
  fingerprintActiveSet,
  HMS_RUNTIME_ABI_VERSION,
  hmsPortfolioToolReleaseV2Schema,
  type HmsActiveRegistryV2,
  type HmsPortfolioToolReleaseV2,
} from '../src/hms/release-kernel.js';

function hex(label: string): string {
  return createHash('sha256').update(`seed:${label}`).digest('hex');
}

async function main(): Promise<void> {
  const releaseRoot =
    process.env.HMS_RELEASE_ROOT?.trim() || '/opt/nava/shared/hms-releases';
  const registryDir =
    process.env.HMS_ACTIVE_REGISTRY_DIR?.trim() ||
    '/opt/nava/shared/hms-active-registry';
  const sourceRevision =
    process.env.HMS_SEED_SOURCE_REVISION?.trim() ||
    process.env.NAVA_BUILD_COMMIT?.trim() ||
    '';
  if (!sourceRevision) {
    throw new Error('NAVA_BUILD_COMMIT or HMS_SEED_SOURCE_REVISION required');
  }

  const toolsetFingerprint = fingerprintReadToolRegistry();
  const runtimeFingerprintSha256 = fingerprintRuntime({
    sourceRevision,
    playwrightRevision: '1.63.0',
    chromiumRevision: '1243',
  });
  const requesterPolicySha256 = hex('requester-policy-v1');
  const findReleaseId = randomUUID();
  const mailReleaseId = randomUUID();

  const findRelease = hmsPortfolioToolReleaseV2Schema.parse({
    schemaVersion: 2,
    releaseId: findReleaseId,
    toolsetVersion: '3.0.0',
    toolsetFingerprint,
    sourceRevision,
    phaseAPlanSha256: hex('phase-a-plan'),
    phaseBPlanSha256: hex('phase-b-plan'),
    gateSha256: hex('gate'),
    runtimeAbiVersion: HMS_RUNTIME_ABI_VERSION,
    runtimeFingerprintSha256,
    requesterPolicySha256,
    privateDigestKeyVersion: 'v1',
    liveProofSha256: hex('find-live-proof'),
    receiptSha256: hex('find-receipt'),
    qualification: 'live_verified',
    shadowSha256: null,
    evidenceKind: 'hms',
    toolId: 'hms_find_reservation',
    toolVersion: '1.2.0',
    implementationSha256: FIND_RESERVATION_IMPL_V1,
    predecessorReleaseId: null,
    rollbackAction: 'disable',
    requestBranches: [
      {
        id: 'guest_stay_search',
        discoveryOperationId: 'guest_stay_search',
        manifestSha256: hex('find-manifest'),
        discoverySha256: hex('find-discovery'),
        parserSchemaSha256: hex('find-parser'),
      },
    ],
    credentialVersionHmacSha256: hex('find-cred'),
    roleProofSha256: hex('find-role'),
  } satisfies HmsPortfolioToolReleaseV2);

  const mailRelease = hmsPortfolioToolReleaseV2Schema.parse({
    schemaVersion: 2,
    releaseId: mailReleaseId,
    toolsetVersion: '3.0.0',
    toolsetFingerprint,
    sourceRevision,
    phaseAPlanSha256: hex('phase-a-plan'),
    phaseBPlanSha256: hex('phase-b-plan'),
    gateSha256: hex('gate'),
    runtimeAbiVersion: HMS_RUNTIME_ABI_VERSION,
    runtimeFingerprintSha256,
    requesterPolicySha256,
    privateDigestKeyVersion: 'v1',
    liveProofSha256: hex('mail-live-proof'),
    receiptSha256: hex('mail-receipt'),
    qualification: 'live_verified',
    shadowSha256: null,
    evidenceKind: 'mail',
    toolId: 'mail_read_artifact',
    toolVersion: '2',
    implementationSha256: MAIL_ARTIFACT_IMPL_V1,
    predecessorReleaseId: null,
    rollbackAction: 'disable',
    grantPolicySha256: hex('mail-grant'),
    s3IdentitySha256: hex('mail-s3'),
    parserSandboxSha256: hex('mail-parser'),
  } satisfies HmsPortfolioToolReleaseV2);

  await mkdir(releaseRoot, { recursive: true, mode: 0o700 });
  await mkdir(registryDir, { recursive: true, mode: 0o700 });

  for (const release of [findRelease, mailRelease]) {
    const path = join(releaseRoot, `${release.releaseId}.json`);
    await writeFile(path, `${JSON.stringify(release)}\n`, { mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
  }

  const active = {
    hms_find_reservation: findReleaseId,
    mail_read_artifact: mailReleaseId,
  };
  const immediatePredecessor = {};
  const generation = 1;
  const activeSetFingerprint = fingerprintActiveSet({
    active,
    immediatePredecessor,
    generation,
    toolsetVersion: '3.0.0',
    toolsetFingerprint,
  });

  const registry: HmsActiveRegistryV2 = {
    schemaVersion: 2,
    generation,
    toolsetVersion: '3.0.0',
    toolsetFingerprint,
    activeSetFingerprint,
    active,
    immediatePredecessor,
  };

  const candidatePath = join(registryDir, 'registry-candidate.json');
  const activePath = join(registryDir, 'active.json');
  await writeFile(candidatePath, `${JSON.stringify(registry)}\n`, {
    mode: 0o600,
  });
  // Bootstrap empty→seed: write active directly when no prior registry.
  await writeFile(activePath, `${JSON.stringify(registry)}\n`, { mode: 0o600 });

  const summary = {
    ok: true,
    sourceRevision,
    toolsetFingerprint,
    runtimeFingerprintSha256,
    activeSetFingerprint,
    findReleaseId,
    mailReleaseId,
    findImpl: FIND_RESERVATION_IMPL_V1,
    mailImpl: MAIL_ARTIFACT_IMPL_V1,
    releaseRoot,
    activePath,
    candidatePath,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
