/**
 * Worker-scoped active registry load + per-tool session authorization builders.
 * Live path never unions every active manifest into process-wide Guest Stay authority.
 */
import {
  HMS_RUNTIME_ABI_VERSION,
  isRegistryCutoverComplete,
  loadValidatedActiveReadSet,
  sha256Hex,
  assertHmsPropertyIdentity,
  type HmsActiveRegistryV2,
  type HmsPortfolioToolReleaseV2,
  type HmsSessionAuthorization,
} from './release-kernel.js';
import {
  FIND_RESERVATION_IMPL_V1,
  FIND_RESERVATION_IMPL_V2,
  QUOTE_STAY_IMPL_V1,
  assertHandlerIndexCovers,
  createReadToolHandler,
  listHandlerIndexEntries,
} from './read-handler-index.js';
import type { RequestPolicyManifest } from './contracts.js';
import type { ActiveReadToolId, ReadToolId } from './read-tools.js';
import { access, lstat, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getPropertyRegistration } from '../../tooling/hms-cloud/property-registry.mjs';
import type { PropertyCode } from './property-registry.js';

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
  ActiveReadToolId,
  ReadonlySet<string>
> {
  const map = new Map<ActiveReadToolId, Set<string>>();
  for (const entry of listHandlerIndexEntries()) {
    if (entry.toolId === 'mail_read_artifact') continue;
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

const cached = new Map<PropertyCode, ActiveReadRuntimeState>();
export const DEFAULT_HMS_READ_ROLE_PROOF_V2_ROOT = '/etc/nava/hms-read-role-proofs/v2';

export function getActiveReadRuntime(propertyCode: PropertyCode): ActiveReadRuntimeState | null {
  return cached.get(propertyCode) ?? null;
}
/** Legacy route callers use the HRCEN partition explicitly. */
export function getCachedActiveReadRuntime(): ActiveReadRuntimeState | null {
  return getActiveReadRuntime('HRCEN');
}
export function clearCachedActiveReadRuntimeForTests(): void { cached.clear(); }
export function __setCachedActiveReadRuntimeForTests(state: ActiveReadRuntimeState | null): void {
  if (state) cached.set('HRCEN', state); else cached.delete('HRCEN');
}

export async function resolveWorkerActiveReadPaths(input: {
  propertyCode: PropertyCode; root?: string; legacyRegistryPath: string; legacyReleaseRoot: string;
}): Promise<{ registryPath: string; releaseRoot: string }> {
  const legacy = { registryPath: input.legacyRegistryPath, releaseRoot: input.legacyReleaseRoot };
  const root = input.root?.trim() || (input.propertyCode === 'HRCEN' ? undefined : DEFAULT_HMS_READ_ROLE_PROOF_V2_ROOT);
  if (!root) return legacy;
  const partition = { registryPath: join(root, input.propertyCode, 'active-registry.v2.json'),
    releaseRoot: join(root, input.propertyCode, 'releases') };
  if (input.propertyCode === 'HRCEN') {
    try { await lstat(partition.registryPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      for (const directory of [root, join(root, input.propertyCode)]) {
        let entry;
        try { entry = await lstat(directory); } catch (directoryError) {
          if ((directoryError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw directoryError;
        }
        if (entry.isSymbolicLink()) await stat(directory);
      }
      return legacy;
    }
  }
  return partition;
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
  propertyCode?: PropertyCode;
}): Promise<ActiveReadRuntimeState> {
  const propertyCode = input.propertyCode ?? 'HRCEN';
  try {
    await access(input.registryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const empty = emptyState();
    cached.set(propertyCode, empty);
    return empty;
  }

  const loaded = await loadValidatedActiveReadSet({
    registryPath: input.registryPath,
    propertyCode,
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
      throw new Error('excluded mail release cannot enter active worker runtime');
    }
  }

  const handlerPathActive = true;
  const cutoverComplete = isRegistryCutoverComplete({
    activeToolIds: loaded.toolIds,
    handlerPathActive,
  });

  const state = {
    releases: loaded.releases,
    predecessors: loaded.predecessors,
    toolIds: loaded.toolIds,
    registry: loaded.registry,
    handlerPathActive,
    cutoverComplete,
  };
  cached.set(propertyCode, state);
  return state;
}

function authorizationIdentity(input: {
  propertyCode?: PropertyCode; roleProofSha256: string; credentialVersionHmacSha256: string;
  runtimeFingerprintSha256: string; privateDigestKeyVersion: string; sourceRevision: string;
}, release: Extract<HmsPortfolioToolReleaseV2, { evidenceKind: 'hms' }> | null) {
  const propertyCode = input.propertyCode ?? 'HRCEN';
  const property = getPropertyRegistration(propertyCode);
  if (!property) throw new Error('unknown authorization property');
  if (release) {
    assertHmsPropertyIdentity(release, propertyCode);
    if (release.roleProofSha256 !== input.roleProofSha256 ||
        release.credentialVersionHmacSha256 !== input.credentialVersionHmacSha256 ||
        release.runtimeFingerprintSha256 !== input.runtimeFingerprintSha256 ||
        release.privateDigestKeyVersion !== input.privateDigestKeyVersion || release.sourceRevision !== input.sourceRevision) {
      throw new Error('release and authorization evidence mismatch');
    }
  } else if (propertyCode !== 'HRCEN') {
    throw new Error('property requires an active HMS release');
  }
  return { propertyCode, tenantId: property.expectedTenant, landingPropertyCode: property.landingPropertyCode, origin: property.origin };
}

export function buildHmsFindSessionAuthorization(input: {
  operationId: string;
  propertyCode?: PropertyCode;
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
  const identity = authorizationIdentity(input, release);
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
    ...identity,
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
  propertyCode?: PropertyCode;
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
  const identity = authorizationIdentity(input, release);
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
    ...identity,
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
  propertyCode?: PropertyCode;
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
  const identity = authorizationIdentity(input, release);
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
    ...identity,
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
