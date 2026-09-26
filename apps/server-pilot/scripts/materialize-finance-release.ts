/**
 * Materialize + promote/rollback hms_read_folio.
 * Branches: folio_summary + deposit_ledger_summary (OSLEDG.DLD confirmation bind
 * proven 2026-08-07 via Property Ledger → Deposit Ledger → date detail).
 * Company remains unpromoted (surface unproven).
 */
import {
  fingerprintActiveSet,
  HMS_RUNTIME_ABI_VERSION,
  hmsActiveRegistryV2Schema,
  hmsPortfolioToolReleaseV2Schema,
  isRegistryCutoverComplete,
  promoteReadToolV2,
  rollbackReadToolV2,
  type HmsActiveRegistryV2,
  type HmsPortfolioToolReleaseV2,
} from '../src/hms/release-kernel.js';
import {
  fingerprintReadToolRegistry,
  isProductionActiveReadTool,
  type ReadToolId,
} from '../src/hms/read-tools.js';
import { runtimeFingerprintSha256 as fingerprintRuntime } from '../src/hms/evidence-runtime.js';
import { reviewedManifestSha256 } from '../src/hms/release-manifest-binding.js';
import { FOLIO_READ_IMPL_V1 } from '../src/hms/read-handler-index.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

function hex(label: string): string {
  return createHash('sha256').update(`finance-seed:${label}`).digest('hex');
}

/** Exact script-owned branch digest used by release materialization and tests. */
export function financeReleaseManifestSha256(
  raw: string,
  branch: 'folio_summary' | 'deposit_ledger_summary',
): string {
  return reviewedManifestSha256(raw, {
    toolId: 'hms_read_folio',
    toolVersion: '1.0.0',
    discoveryOperationId: branch,
  });
}

async function requiredArtifactSha256(
  pathValue: string | undefined,
  label: string,
): Promise<string> {
  const path = pathValue?.trim();
  if (!path) throw new Error(`${label}_REQUIRED`);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error(`${label}_UNAVAILABLE`);
  }
  if (bytes.byteLength === 0) throw new Error(`${label}_EMPTY`);
  return createHash('sha256').update(bytes).digest('hex');
}

/** The registry's live flag is the promotion boundary; local proof labels cannot bypass it. */
export function assertFinancePromotionEligible(): void {
  if (!isProductionActiveReadTool('hms_read_folio')) {
    throw new Error('BLOCKED_LIVE_PROOF_NOT_PROMOTION_ELIGIBLE');
  }
}

/** Test-only artifact seam shared by the real materializer after promotion eligibility. */
export async function financeArtifactSha256(
  pathValue: string | undefined,
  label: string,
): Promise<string> {
  return requiredArtifactSha256(pathValue, label);
}

/**
 * Assemble the exact candidate release object used by the materializer.  This
 * function does not activate or write a registry; the caller must first pass
 * assertFinancePromotionEligible and then provide hashes of real private proof
 * artifacts.
 */
export function buildFinanceRelease(input: {
  registry: HmsActiveRegistryV2;
  findRelease: Extract<HmsPortfolioToolReleaseV2, { evidenceKind: 'hms' }>;
  sourceRevision: string;
  runtimeFingerprintSha256: string;
  folioManifestRaw: string;
  depositManifestRaw: string;
  liveProofSha256: string;
  receiptSha256: string;
  releaseId?: string;
}): Extract<HmsPortfolioToolReleaseV2, { evidenceKind: 'hms' }> {
  const releaseId = input.releaseId?.trim() || randomUUID();
  const manifestSha256 = financeReleaseManifestSha256(input.folioManifestRaw, 'folio_summary');
  const depositManifestSha256 = financeReleaseManifestSha256(
    input.depositManifestRaw,
    'deposit_ledger_summary',
  );
  const activeFolioId = input.registry.active.hms_read_folio ?? null;
  const predecessorReleaseId = activeFolioId;
  const rollbackAction =
    activeFolioId === null ? ('disable' as const) : ('restore_predecessor' as const);

  return hmsPortfolioToolReleaseV2Schema.parse({
    schemaVersion: 2,
    releaseId,
    toolsetVersion: input.registry.toolsetVersion,
    toolsetFingerprint: input.registry.toolsetFingerprint,
    sourceRevision: input.sourceRevision,
    phaseAPlanSha256: input.findRelease.phaseAPlanSha256,
    phaseBPlanSha256: input.findRelease.phaseBPlanSha256,
    gateSha256: input.findRelease.gateSha256,
    runtimeAbiVersion: HMS_RUNTIME_ABI_VERSION,
    runtimeFingerprintSha256: input.runtimeFingerprintSha256,
    requesterPolicySha256: input.findRelease.requesterPolicySha256,
    privateDigestKeyVersion: input.findRelease.privateDigestKeyVersion,
    liveProofSha256: input.liveProofSha256,
    receiptSha256: input.receiptSha256,
    qualification: 'live_verified',
    shadowSha256: null,
    evidenceKind: 'hms',
    toolId: 'hms_read_folio',
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
        parserSchemaSha256: '716018585f130515af72a506721849c0f1e5e22ccf521241136e03f96e653b65',
      },
      {
        id: 'deposit_ledger_summary',
        discoveryOperationId: 'deposit_ledger_summary',
        manifestSha256: depositManifestSha256,
        discoverySha256: hex('discovery-deposit-dld-2026-08-07'),
        parserSchemaSha256: hex('parser-deposit-dld-confirmation-v1'),
      },
    ],
    credentialVersionHmacSha256: input.findRelease.credentialVersionHmacSha256,
    roleProofSha256: hex('role-proof-v2:hms_read_folio'),
  });
}

async function main(): Promise<void> {
  const mode = (process.argv[2] || 'promote').trim();
  const toolArg = 'hms_read_folio' as const;
  if (mode !== 'promote' && mode !== 'rollback') {
    throw new Error('usage: materialize-finance-release.ts <promote|rollback>');
  }

  const releaseRoot = process.env.HMS_RELEASE_ROOT?.trim() || '/opt/nava/shared/hms-releases';
  const registryPath =
    process.env.HMS_ACTIVE_REGISTRY_PATH?.trim() ||
    '/opt/nava/shared/hms-active-registry/active.json';
  const sourceRevision =
    process.env.HMS_SEED_SOURCE_REVISION?.trim() || process.env.NAVA_BUILD_COMMIT?.trim() || '';
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
    throw new Error('computed runtime fingerprint mismatch vs find seed — redeploy seeds');
  }

  const manifestPath =
    process.env.HMS_FOLIO_MANIFEST_PATH?.trim() ||
    join(process.cwd(), 'src/hms/request-manifests/hms_read_folio.folio.1.0.0.json');
  const folioManifestRaw = await readFile(manifestPath, 'utf8');

  const depositManifestPath =
    process.env.HMS_DEPOSIT_MANIFEST_PATH?.trim() ||
    join(process.cwd(), 'src/hms/request-manifests/hms_read_folio.deposit-ledger.1.0.0.json');
  const depositManifestRaw = await readFile(depositManifestPath, 'utf8');

  assertFinancePromotionEligible();
  const liveProofSha256 = await financeArtifactSha256(
    process.env.HMS_FOLIO_LIVE_PROOF_PATH,
    'HMS_FOLIO_LIVE_PROOF',
  );
  const receiptSha256 = await financeArtifactSha256(
    process.env.HMS_FOLIO_RECEIPT_PATH,
    'HMS_FOLIO_FINALIZED_RECEIPT',
  );

  const release = buildFinanceRelease({
    registry,
    findRelease,
    sourceRevision,
    runtimeFingerprintSha256,
    folioManifestRaw,
    depositManifestRaw,
    liveProofSha256,
    receiptSha256,
    releaseId: process.env.HMS_FOLIO_RELEASE_ID,
  });
  const manifestSha256 = release.requestBranches.find(
    (branch) => branch.id === 'folio_summary',
  )!.manifestSha256;
  const depositManifestSha256 = release.requestBranches.find(
    (branch) => branch.id === 'deposit_ledger_summary',
  )!.manifestSha256;

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
        releaseId: release.releaseId,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
