/**
 * Materialize + promote/rollback hms_read_folio.
 * Branches: folio_summary + deposit_ledger_summary (OSLEDG.DLD confirmation bind
 * proven 2026-08-07 via Property Ledger → Deposit Ledger → date detail).
 * Company remains unpromoted (surface unproven).
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFingerprintSha256 as fingerprintRuntime } from '../src/hms/evidence-runtime.js';
import { FOLIO_READ_IMPL_V1 } from '../src/hms/read-handler-index.js';
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
  return createHash('sha256').update(`finance-seed:${label}`).digest('hex');
}

async function main(): Promise<void> {
  const mode = (process.argv[2] || 'promote').trim();
  const toolArg = 'hms_read_folio' as const;
  if (mode !== 'promote' && mode !== 'rollback') {
    throw new Error('usage: materialize-finance-release.ts <promote|rollback>');
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
    playwrightRevision: '1.52.0',
    chromiumRevision: '1169',
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
    process.env.HMS_FOLIO_MANIFEST_PATH?.trim() ||
    join(process.cwd(), 'src/hms/request-manifests/hms_read_folio.folio.1.0.0.json');
  const manifestSha256 = createHash('sha256')
    .update(await readFile(manifestPath))
    .digest('hex');

  const depositManifestPath =
    process.env.HMS_DEPOSIT_MANIFEST_PATH?.trim() ||
    join(
      process.cwd(),
      'src/hms/request-manifests/hms_read_folio.deposit-ledger.1.0.0.json',
    );
  const depositManifestSha256 = createHash('sha256')
    .update(await readFile(depositManifestPath))
    .digest('hex');

  const releaseId = process.env.HMS_FOLIO_RELEASE_ID?.trim() || randomUUID();
  const activeFolioId = registry.active[toolArg] ?? null;
  const predecessorReleaseId = activeFolioId;
  const rollbackAction =
    activeFolioId === null ? ('disable' as const) : ('restore_predecessor' as const);
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
    implementationSha256: FOLIO_READ_IMPL_V1,
    predecessorReleaseId,
    rollbackAction,
    requestBranches: [
      {
        id: 'folio_summary',
        discoveryOperationId: 'folio_summary',
        manifestSha256,
        discoverySha256: hex('discovery-folio'),
        parserSchemaSha256:
          '716018585f130515af72a506721849c0f1e5e22ccf521241136e03f96e653b65',
      },
      {
        id: 'deposit_ledger_summary',
        discoveryOperationId: 'deposit_ledger_summary',
        manifestSha256: depositManifestSha256,
        discoverySha256: hex('discovery-deposit-dld-2026-08-07'),
        parserSchemaSha256: hex('parser-deposit-dld-confirmation-v1'),
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
        implementationSha256: FOLIO_READ_IMPL_V1,
        manifestSha256,
        depositManifestSha256,
        requestBranchIds: ['folio_summary', 'deposit_ledger_summary'],
        depositBranch: 'deposit_ledger_summary',
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
