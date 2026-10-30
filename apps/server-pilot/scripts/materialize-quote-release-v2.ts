/**
 * Materialize hms_quote_stay@2.0.0 release-v2 and promote into active registry.
 * Digests/IDs only. Requires find+mail seed cutover already active.
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
import { QUOTE_STAY_IMPL_V1 } from '../src/hms/read-handler-index.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

function hex(label: string): string {
  return createHash('sha256').update(`quote-seed:${label}`).digest('hex');
}

/** Exact script-owned branch digest used by release materialization and tests. */
export function quoteReleaseManifestSha256(raw: string): string {
  return reviewedManifestSha256(raw, {
    toolId: 'hms_quote_stay',
    toolVersion: '2.0.0',
    discoveryOperationId: 'quote_availability_search',
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
export function assertQuotePromotionEligible(): void {
  if (!isProductionActiveReadTool('hms_quote_stay')) {
    throw new Error('BLOCKED_LIVE_PROOF_NOT_PROMOTION_ELIGIBLE');
  }
}

/** Test-only artifact seam shared by the real materializer after promotion eligibility. */
export async function quoteArtifactSha256(
  pathValue: string | undefined,
  label: string,
): Promise<string> {
  return requiredArtifactSha256(pathValue, label);
}

/**
 * Assemble the exact candidate release object used by the materializer.  This
 * function does not activate or write a registry; the caller must first pass
 * assertQuotePromotionEligible and then provide hashes of real private proof
 * artifacts.
 */
export function buildQuoteRelease(input: {
  registry: HmsActiveRegistryV2;
  findRelease: Extract<HmsPortfolioToolReleaseV2, { evidenceKind: 'hms' }>;
  sourceRevision: string;
  runtimeFingerprintSha256: string;
  manifestRaw: string;
  liveProofSha256: string;
  receiptSha256: string;
  releaseId?: string;
}): Extract<HmsPortfolioToolReleaseV2, { evidenceKind: 'hms' }> {
  const releaseId = input.releaseId?.trim() || randomUUID();
  const manifestSha256 = quoteReleaseManifestSha256(input.manifestRaw);
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
    toolId: 'hms_quote_stay',
    toolVersion: '2.0.0',
    implementationSha256: QUOTE_STAY_IMPL_V1,
    predecessorReleaseId: null,
    rollbackAction: 'disable',
    requestBranches: [
      {
        id: 'quote_availability_search',
        discoveryOperationId: 'quote_availability_search',
        manifestSha256,
        discoverySha256: hex('discovery'),
        parserSchemaSha256: hex('parser'),
      },
    ],
    credentialVersionHmacSha256: input.findRelease.credentialVersionHmacSha256,
    roleProofSha256: hex('role-proof-v2'),
  });
}

async function main(): Promise<void> {
  const mode = (process.argv[2] || 'promote').trim();
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
      toolId: 'hms_quote_stay',
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: 'rollback',
          generation: after.generation,
          activeQuote: after.active.hms_quote_stay ?? null,
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
  if (registry.toolsetVersion !== '3.0.0') {
    throw new Error(`unexpected toolsetVersion ${registry.toolsetVersion}`);
  }

  const runtimeFingerprintSha256 = fingerprintRuntime({
    sourceRevision,
    playwrightRevision: '1.63.0',
    chromiumRevision: '1243',
  });

  // Bind quote release to same runtime fp as seed find/mail releases.
  const findId = registry.active.hms_find_reservation;
  if (!findId) throw new Error('find seed missing');
  const findRelease = hmsPortfolioToolReleaseV2Schema.parse(
    JSON.parse(await readFile(join(releaseRoot, `${findId}.json`), 'utf8')),
  );
  if (findRelease.runtimeFingerprintSha256 !== runtimeFingerprintSha256) {
    throw new Error('computed runtime fingerprint mismatch vs find seed — redeploy seeds');
  }

  const manifestPath =
    process.env.HMS_QUOTE_MANIFEST_PATH?.trim() ||
    join(process.cwd(), 'src/hms/request-manifests/hms_quote_stay.availability.2.0.0.json');
  const manifestRaw = await readFile(manifestPath, 'utf8');

  assertQuotePromotionEligible();
  const liveProofSha256 = await quoteArtifactSha256(
    process.env.HMS_QUOTE_LIVE_PROOF_PATH,
    'HMS_QUOTE_LIVE_PROOF',
  );
  const receiptSha256 = await quoteArtifactSha256(
    process.env.HMS_QUOTE_RECEIPT_PATH,
    'HMS_QUOTE_FINALIZED_RECEIPT',
  );

  const release = buildQuoteRelease({
    registry,
    findRelease,
    sourceRevision,
    runtimeFingerprintSha256,
    manifestRaw,
    liveProofSha256,
    receiptSha256,
    releaseId: process.env.HMS_QUOTE_RELEASE_ID,
  });
  const manifestSha256 = release.requestBranches[0]!.manifestSha256;

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
        releaseId: release.releaseId,
        implementationSha256: QUOTE_STAY_IMPL_V1,
        manifestSha256,
        runtimeFingerprintSha256,
        toolsetFingerprint,
        activeSetFingerprint: after.activeSetFingerprint,
        generation: after.generation,
        activeQuote: after.active.hms_quote_stay ?? null,
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
