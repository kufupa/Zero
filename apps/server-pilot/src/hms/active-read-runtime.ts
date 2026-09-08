/**
 * Worker-scoped active registry load + per-tool session authorization builders.
 * Live path never unions every active manifest into process-wide Guest Stay authority.
 */
import {
  HMS_RUNTIME_ABI_VERSION,
  isRegistryCutoverComplete,
  loadValidatedActiveReadSet,
  sha256Hex,
  type HmsActiveRegistryV2,
  type HmsPortfolioToolReleaseV2,
  type HmsSessionAuthorization,
} from './release-kernel.js';
import {
  FIND_RESERVATION_IMPL_V1,
  FIND_RESERVATION_IMPL_V2,
  MAIL_ARTIFACT_IMPL_V1,
  QUOTE_STAY_IMPL_V1,
  assertHandlerIndexCovers,
  createReadToolHandler,
  listHandlerIndexEntries,
} from './read-handler-index.js';
import type { RequestPolicyManifest } from './contracts.js';
import type { ReadToolId } from './read-tools.js';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** Well-known Phase A find lease id — not a promoted release. */
export const PHASE_A_FIND_LEASE_RELEASE_ID = '00000000-0000-4000-8000-0000000000a1';

export type ActiveReadRuntimeState = {
  releases: Map<ReadToolId, HmsPortfolioToolReleaseV2>;
  predecessors: Map<ReadToolId, HmsPortfolioToolReleaseV2>;
  toolIds: Set<ReadToolId>;
  registry: HmsActiveRegistryV2 | null;
  handlerPathActive: boolean;
  cutoverComplete: boolean;
};

function emptyState(): ActiveReadRuntimeState {
  return {
    releases: new Map(),
    predecessors: new Map(),
    toolIds: new Set(),
    registry: null,
    handlerPathActive: false,
    cutoverComplete: false,
  };
}

export function availableImplementationDigestsFromHandlerIndex(): Map<
  ReadToolId,
  ReadonlySet<string>
> {
  const map = new Map<ReadToolId, Set<string>>();
  for (const entry of listHandlerIndexEntries()) {
    let set = map.get(entry.toolId);
    if (!set) {
      set = new Set();
      map.set(entry.toolId, set);
    }
    set.add(entry.implementationSha256);
  }
  // Ensure seed constants stay visible even if index iteration changes.
  for (const [toolId, digest] of [
    ['hms_find_reservation', FIND_RESERVATION_IMPL_V1],
    ['hms_find_reservation', FIND_RESERVATION_IMPL_V2],
    ['mail_read_artifact', MAIL_ARTIFACT_IMPL_V1],
    ['hms_quote_stay', QUOTE_STAY_IMPL_V1],
  ] as const) {
    let set = map.get(toolId);
    if (!set) {
      set = new Set();
      map.set(toolId, set);
    }
    set.add(digest);
  }
  return map;
}

let cached: ActiveReadRuntimeState | null = null;

export function getCachedActiveReadRuntime(): ActiveReadRuntimeState | null {
  return cached;
}

export function clearCachedActiveReadRuntimeForTests(): void {
  cached = null;
}

/** Test-only registry injection for route/worker contract tests; production never calls this. */
export function __setCachedActiveReadRuntimeForTests(state: ActiveReadRuntimeState | null): void {
  cached = state;
}

/**
 * Load validated active set at HMS worker startup.
 * Missing registry → empty (Phase A find lease path; promote stays blocked).
 * Present but invalid → fail closed (throw).
 */
export async function loadWorkerActiveReadSet(input: {
  registryPath: string;
  releaseRoot: string;
  runtimeFingerprintSha256: string;
}): Promise<ActiveReadRuntimeState> {
  try {
    await access(input.registryPath);
  } catch {
    cached = emptyState();
    return cached;
  }

  const loaded = await loadValidatedActiveReadSet({
    registryPath: input.registryPath,
    releaseRoot: input.releaseRoot,
    runtimeAbiVersion: HMS_RUNTIME_ABI_VERSION,
    runtimeFingerprintSha256: input.runtimeFingerprintSha256,
    availableImplementationDigests: availableImplementationDigestsFromHandlerIndex(),
  });

  assertHandlerIndexCovers({
    active: loaded.releases,
    immediatePredecessor: loaded.predecessors,
  });

  // Mail auth is self-contained. HMS handler binding is intentionally deferred
  // until the exact reviewed manifest is available; a synthetic stub must not
  // be allowed to stand in for a release payload digest.
  for (const [, release] of loaded.releases) {
    if (release.evidenceKind === 'mail') {
      createReadToolHandler(release, {
        operationId: randomUUID(),
        releaseId: release.releaseId,
        grantPolicySha256: release.grantPolicySha256,
        s3IdentitySha256: release.s3IdentitySha256,
        runtimeFingerprintSha256: release.runtimeFingerprintSha256,
        privateDigestKeyVersion: release.privateDigestKeyVersion,
        sourceRevision: release.sourceRevision,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }
  }

  const handlerPathActive = true;
  const cutoverComplete = isRegistryCutoverComplete({
    activeToolIds: loaded.toolIds,
    handlerPathActive,
  });

  cached = {
    releases: loaded.releases,
    predecessors: loaded.predecessors,
    toolIds: loaded.toolIds,
    registry: loaded.registry,
    handlerPathActive,
    cutoverComplete,
  };
  return cached;
}

export function buildHmsFindSessionAuthorization(input: {
  operationId: string;
  requestBranchId: string;
  manifest: RequestPolicyManifest;
  roleProofPath: string;
  roleProofSha256: string;
  credentialVersionHmacSha256: string;
  runtimeFingerprintSha256: string;
  privateDigestKeyVersion: string;
  sourceRevision: string;
  expiresAt?: string;
  release?: HmsPortfolioToolReleaseV2 | null;
}): HmsSessionAuthorization {
  const release = input.release && input.release.evidenceKind === 'hms' ? input.release : null;
  const branch = release?.requestBranches.find((b) => b.id === input.requestBranchId) ?? null;
  if (release && !branch) {
    throw new Error(`request branch is not enabled on release: ${input.requestBranchId}`);
  }
  const computedManifestSha = sha256Hex(JSON.stringify(input.manifest));
  if (branch && branch.manifestSha256 !== computedManifestSha) {
    throw new Error('find branch manifest digest mismatch');
  }
  return {
    operationId: input.operationId,
    toolId: 'hms_find_reservation',
    discoveryOperationId: branch?.discoveryOperationId ?? 'guest_stay_search',
    releaseId: release?.releaseId ?? PHASE_A_FIND_LEASE_RELEASE_ID,
    requestBranchId: branch?.id ?? 'guest_stay_search',
    manifest: input.manifest,
    manifestSha256: branch?.manifestSha256 ?? computedManifestSha,
    roleProofPath: input.roleProofPath,
    roleProofSha256: release?.roleProofSha256 ?? input.roleProofSha256,
    credentialVersionHmacSha256:
      release?.credentialVersionHmacSha256 ?? input.credentialVersionHmacSha256,
    runtimeFingerprintSha256: release?.runtimeFingerprintSha256 ?? input.runtimeFingerprintSha256,
    privateDigestKeyVersion: release?.privateDigestKeyVersion ?? input.privateDigestKeyVersion,
    sourceRevision: release?.sourceRevision ?? input.sourceRevision,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

/** Prove find release+auth bind through the static handler index. */
export function assertFindHandlerBound(
  release: HmsPortfolioToolReleaseV2,
  authorization: HmsSessionAuthorization,
): void {
  createReadToolHandler(release, authorization);
}

export function buildHmsQuoteSessionAuthorization(input: {
  operationId: string;
  manifest: RequestPolicyManifest;
  roleProofPath: string;
  roleProofSha256: string;
  credentialVersionHmacSha256: string;
  runtimeFingerprintSha256: string;
  privateDigestKeyVersion: string;
  sourceRevision: string;
  expiresAt?: string;
  release?: HmsPortfolioToolReleaseV2 | null;
}): HmsSessionAuthorization {
  const release = input.release && input.release.evidenceKind === 'hms' ? input.release : null;
  const branch =
    release?.requestBranches.find((b) => b.id === 'quote_availability_search') ??
    release?.requestBranches[0] ??
    null;
  const computedManifestSha = sha256Hex(JSON.stringify(input.manifest));
  if (branch && branch.manifestSha256 !== computedManifestSha) {
    throw new Error('quote branch manifest digest mismatch');
  }

  return {
    operationId: input.operationId,
    toolId: 'hms_quote_stay',
    discoveryOperationId: branch?.discoveryOperationId ?? 'quote_availability_search',
    releaseId: release?.releaseId ?? randomUUID(),
    requestBranchId: branch?.id ?? 'quote_availability_search',
    manifest: input.manifest,
    manifestSha256: computedManifestSha,
    roleProofPath: input.roleProofPath,
    roleProofSha256: release?.roleProofSha256 ?? input.roleProofSha256,
    credentialVersionHmacSha256:
      release?.credentialVersionHmacSha256 ?? input.credentialVersionHmacSha256,
    runtimeFingerprintSha256: release?.runtimeFingerprintSha256 ?? input.runtimeFingerprintSha256,
    privateDigestKeyVersion: release?.privateDigestKeyVersion ?? input.privateDigestKeyVersion,
    sourceRevision: release?.sourceRevision ?? input.sourceRevision,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

export function buildHmsFolioSessionAuthorization(input: {
  operationId: string;
  requestBranchId: 'folio_summary' | 'deposit_ledger_summary';
  manifest: RequestPolicyManifest;
  roleProofPath: string;
  roleProofSha256: string;
  credentialVersionHmacSha256: string;
  runtimeFingerprintSha256: string;
  privateDigestKeyVersion: string;
  sourceRevision: string;
  expiresAt?: string;
  release?: HmsPortfolioToolReleaseV2 | null;
}): HmsSessionAuthorization {
  const release = input.release && input.release.evidenceKind === 'hms' ? input.release : null;
  if (release && release.toolId !== 'hms_read_folio') {
    throw new Error('folio authorization requires hms_read_folio release');
  }
  const branch = release?.requestBranches.find((b) => b.id === input.requestBranchId) ?? null;
  if (release && !branch) {
    throw new Error(`request branch is not enabled on folio release: ${input.requestBranchId}`);
  }
  const computedManifestSha = sha256Hex(JSON.stringify(input.manifest));
  if (branch && branch.manifestSha256 !== computedManifestSha) {
    throw new Error('folio branch manifest digest mismatch');
  }

  return {
    operationId: input.operationId,
    toolId: 'hms_read_folio',
    discoveryOperationId: branch?.discoveryOperationId ?? input.requestBranchId,
    releaseId: release?.releaseId ?? randomUUID(),
    requestBranchId: branch?.id ?? input.requestBranchId,
    manifest: input.manifest,
    manifestSha256: computedManifestSha,
    roleProofPath: input.roleProofPath,
    roleProofSha256: release?.roleProofSha256 ?? input.roleProofSha256,
    credentialVersionHmacSha256:
      release?.credentialVersionHmacSha256 ?? input.credentialVersionHmacSha256,
    runtimeFingerprintSha256: release?.runtimeFingerprintSha256 ?? input.runtimeFingerprintSha256,
    privateDigestKeyVersion: release?.privateDigestKeyVersion ?? input.privateDigestKeyVersion,
    sourceRevision: release?.sourceRevision ?? input.sourceRevision,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

/** Prove quote release+auth bind through the static handler index. */
export function assertQuoteHandlerBound(
  release: HmsPortfolioToolReleaseV2,
  authorization: HmsSessionAuthorization,
): void {
  createReadToolHandler(release, authorization);
}

export function placeholderDigest(label: string): string {
  return sha256Hex(`phase-a-lease:${label}`);
}
