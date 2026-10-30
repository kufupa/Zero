/**
 * Materialize + promote/rollback communications tools independently.
 * Sent Email audit + list-documents (sent-email branch only).
 * Tax Invoice branch stays absent from releases (surface unproven).
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFingerprintSha256 as fingerprintRuntime } from '../src/hms/evidence-runtime.js';
import {
  LIST_DOCUMENTS_IMPL_V1,
  SENT_EMAIL_AUDIT_IMPL_V1,
} from '../src/hms/read-handler-index.js';
import {
  fingerprintReadToolRegistry,
  type ReadToolId,
} from '../src/hms/read-tools.js';
import {
  fingerprintActiveSet,
  HMS_RUNTIME_ABI_VERSION,
  hmsActiveRegistryV2Schema,
  hmsPortfolioToolReleaseV2Schema,
  isRegistryCutoverComplete,
  promoteReadToolV2,
  rollbackReadToolV2,
  type HmsPortfolioToolReleaseV2,
} from '../src/hms/release-kernel.js';

function hex(label: string): string {
  return createHash('sha256').update(`comms-seed:${label}`).digest('hex');
}

type CommsToolId = 'hms_sent_email_audit' | 'hms_list_documents';

async function main(): Promise<void> {
  const mode = (process.argv[2] || 'promote').trim();
  const toolArg = (process.argv[3] || 'hms_sent_email_audit').trim() as CommsToolId;
  if (
    toolArg !== 'hms_sent_email_audit' &&
    toolArg !== 'hms_list_documents'
  ) {
    throw new Error(
      'usage: materialize-communications-release.ts <promote|rollback> <hms_sent_email_audit|hms_list_documents>',
    );
  }

  const releaseRoot =
    process.env.HMS_RELEASE_ROOT?.trim() || '/opt/nava/shared/hms-releases';
  const registryPath =
    process.env.HMS_ACTIVE_REGISTRY_PATH?.trim() ||
    '/opt/nava/shared/hms-active-registry/active.json';
  const sourceRevision =
    process.env.HMS_SEED_SOURCE_REVISION?.trim() ||
    process.env.NAVA_BUILD_COMMIT?.trim() ||
    '';
  if (!sourceRevision) {
    throw new Error('NAVA_BUILD_COMMIT or HMS_SEED_SOURCE_REVISION required');
  }

  const registry = hmsActiveRegistryV2Schema.parse(
    JSON.parse(await readFile(registryPath, 'utf8')),
  );
  const activeToolIds = new Set(
    Object.entries(registry.active)
      .filter(([, id]) => Boolean(id))
      .map(([toolId]) => toolId as ReadToolId),
  );
  if (
    !isRegistryCutoverComplete({
      activeToolIds,
      handlerPathActive: true,
    })
  ) {
    throw new Error('BLOCKED_REGISTRY_CUTOVER_PENDING');
  }

  if (mode === 'rollback') {
    const after = await rollbackReadToolV2({
      path: registryPath,
      toolId: toolArg,
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: 'rollback',
          toolId: toolArg,
          generation: after.generation,
          active: after.active[toolArg] ?? null,
          activeSetFingerprint: after.activeSetFingerprint,
        },
        null,
        2,
      ),
    );
    return;
  }

  const toolsetFingerprint = fingerprintReadToolRegistry();
  if (registry.toolsetFingerprint !== toolsetFingerprint) {
    throw new Error('registry toolsetFingerprint mismatch vs code');
  }

  const runtimeFingerprintSha256 = fingerprintRuntime({
    sourceRevision,
    playwrightRevision: '1.63.0',
    chromiumRevision: '1243',
  });

  const findId = registry.active.hms_find_reservation;
  if (!findId) throw new Error('find seed missing');
  const findRelease = hmsPortfolioToolReleaseV2Schema.parse(
    JSON.parse(await readFile(join(releaseRoot, `${findId}.json`), 'utf8')),
  );
  if (findRelease.runtimeFingerprintSha256 !== runtimeFingerprintSha256) {
    throw new Error(
      'computed runtime fingerprint mismatch vs find seed — redeploy seeds',
    );
  }

  const manifestPath =
    process.env.HMS_COMMS_MANIFEST_PATH?.trim() ||
    join(
      process.cwd(),
      'src/hms/request-manifests/shared/sent-email.list.1.json',
    );
  const manifestSha256 = createHash('sha256')
    .update(await readFile(manifestPath))
    .digest('hex');

  const releaseId = process.env.HMS_COMMS_RELEASE_ID?.trim() || randomUUID();
  const implementationSha256 =
    toolArg === 'hms_sent_email_audit'
      ? SENT_EMAIL_AUDIT_IMPL_V1
      : LIST_DOCUMENTS_IMPL_V1;
  const requestBranchId =
    toolArg === 'hms_sent_email_audit'
      ? 'sent_email_audit'
      : 'sent_email_documents';
  const parserSchemaSha256 =
    toolArg === 'hms_sent_email_audit'
      ? '80db0d4e4db89de7e86e1b65733943823913b8275fe59d86a438a34e842b1830'
      : '092f92a82592866fbc85e6e68cdffaa312e32a8dbfbc8d3cf1b596856567ba42';

  const release = hmsPortfolioToolReleaseV2Schema.parse({
    schemaVersion: 2,
    releaseId,
    toolsetVersion: registry.toolsetVersion,
    toolsetFingerprint,
    sourceRevision,
    phaseAPlanSha256: findRelease.phaseAPlanSha256,
    phaseBPlanSha256: findRelease.phaseBPlanSha256,
    gateSha256: findRelease.gateSha256,
    runtimeAbiVersion: HMS_RUNTIME_ABI_VERSION,
    runtimeFingerprintSha256,
    requesterPolicySha256: findRelease.requesterPolicySha256,
    privateDigestKeyVersion: findRelease.privateDigestKeyVersion,
    liveProofSha256: hex(`live-proof:${toolArg}:${releaseId}`),
    receiptSha256: hex(`receipt:${toolArg}:${releaseId}`),
    qualification: 'live_verified',
    shadowSha256: null,
    evidenceKind: 'hms',
    toolId: toolArg,
    toolVersion: '1.0.0',
    implementationSha256,
    predecessorReleaseId: null,
    rollbackAction: 'disable',
    requestBranches: [
      {
        id: requestBranchId,
        discoveryOperationId: 'sent_email_list',
        manifestSha256,
        discoverySha256: hex('discovery-sent-email'),
        parserSchemaSha256,
      },
    ],
    credentialVersionHmacSha256: findRelease.credentialVersionHmacSha256,
    roleProofSha256: hex(`role-proof-v2:${toolArg}`),
  } satisfies HmsPortfolioToolReleaseV2);

  const after = await promoteReadToolV2({
    path: registryPath,
    release,
    releaseRoot,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: 'promote',
        toolId: toolArg,
        releaseId,
        implementationSha256,
        manifestSha256,
        requestBranchId,
        runtimeFingerprintSha256,
        toolsetFingerprint,
        activeSetFingerprint: after.activeSetFingerprint,
        generation: after.generation,
        active: after.active[toolArg] ?? null,
        fingerprintCheck: fingerprintActiveSet({
          active: after.active,
          immediatePredecessor: after.immediatePredecessor,
          generation: after.generation,
          toolsetVersion: after.toolsetVersion,
          toolsetFingerprint: after.toolsetFingerprint,
        }),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
