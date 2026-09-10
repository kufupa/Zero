import type { LocalModelRouteEvidence, LocalModelTransport } from './bedrock/local.js';
import { createRequire } from 'node:module';

/** Server-owned release identity for the configured draft-purpose route. */
export type DraftRouteReleaseDescriptor = {
  releaseId: string;
  releaseVersion: string;
  sourceRevision: string;
  fingerprint: string;
  purpose: 'draft';
  capabilityFamilyVersions: Record<string, string>;
  issuedAt: string;
  expiresAt: string;
  withdrawn: boolean;
};

export type DraftRouteAuthority = {
  route: DraftModelRouteConfig['route'];
  release: DraftRouteReleaseDescriptor;
};

/** Explicitly configured lower edge for the normal draft-purpose route. */
export type DraftModelRouteConfig = {
  route: LocalModelRouteEvidence & { purpose: 'draft' };
  transport: LocalModelTransport;
  /** Present on the normal configured factory; test-only injected routes may omit it. */
  release?: DraftRouteReleaseDescriptor;
};

export type DraftModelRouteFactory = () => DraftModelRouteConfig | undefined;

type ConfiguredDraftRouteModule = {
  default?: unknown;
  createDraftModelRoute?: () => unknown;
  createApprovedLocalDraftRoute?: () => unknown;
};

type ConfiguredDraftRouteDescriptor = {
  module: string;
  route: DraftModelRouteConfig['route'];
  release: DraftRouteReleaseDescriptor;
};

export function isDraftRouteReleaseDescriptor(
  value: unknown,
): value is DraftRouteReleaseDescriptor {
  if (typeof value !== 'object' || value === null) return false;
  const release = value as Partial<DraftRouteReleaseDescriptor>;
  const capabilityVersions = release.capabilityFamilyVersions;
  return (
    typeof release.releaseId === 'string' &&
    release.releaseId.trim().length > 0 &&
    typeof release.releaseVersion === 'string' &&
    release.releaseVersion.trim().length > 0 &&
    typeof release.sourceRevision === 'string' &&
    release.sourceRevision.trim().length > 0 &&
    typeof release.fingerprint === 'string' &&
    release.fingerprint.trim().length > 0 &&
    release.purpose === 'draft' &&
    typeof capabilityVersions === 'object' &&
    capabilityVersions !== null &&
    !Array.isArray(capabilityVersions) &&
    Object.keys(capabilityVersions).length > 0 &&
    Object.values(capabilityVersions).every(
      (version) => typeof version === 'string' && version.trim().length > 0,
    ) &&
    typeof release.issuedAt === 'string' &&
    !Number.isNaN(Date.parse(release.issuedAt)) &&
    typeof release.expiresAt === 'string' &&
    !Number.isNaN(Date.parse(release.expiresAt)) &&
    typeof release.withdrawn === 'boolean'
  );
}

function isActiveDraftRouteRelease(
  release: DraftRouteReleaseDescriptor,
  now = new Date(),
): boolean {
  return (
    !release.withdrawn &&
    Date.parse(release.issuedAt) <= now.getTime() &&
    Date.parse(release.expiresAt) > now.getTime()
  );
}

function sameDraftRouteRelease(
  left: DraftRouteReleaseDescriptor,
  right: DraftRouteReleaseDescriptor,
): boolean {
  return (
    left.releaseId === right.releaseId &&
    left.releaseVersion === right.releaseVersion &&
    left.sourceRevision === right.sourceRevision &&
    left.fingerprint === right.fingerprint &&
    left.purpose === right.purpose &&
    left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt &&
    left.withdrawn === right.withdrawn &&
    JSON.stringify(left.capabilityFamilyVersions) === JSON.stringify(right.capabilityFamilyVersions)
  );
}

function isDraftRouteEvidence(value: unknown): value is DraftModelRouteConfig['route'] {
  if (typeof value !== 'object' || value === null) return false;
  const route = value as Partial<LocalModelRouteEvidence>;
  return (
    typeof route.routeId === 'string' &&
    route.routeId.trim().length > 0 &&
    route.purpose === 'draft' &&
    route.protocol === 'in_process' &&
    route.access === 'current_app' &&
    route.egress === 'none' &&
    route.retention === 'bounded' &&
    route.usage === 'reported' &&
    typeof route.modelId === 'string' &&
    route.modelId.trim().length > 0
  );
}

function isDraftRouteConfig(value: unknown): value is DraftModelRouteConfig {
  if (typeof value !== 'object' || value === null) return false;
  const config = value as Partial<DraftModelRouteConfig>;
  return isDraftRouteEvidence(config.route) && typeof config.transport === 'function';
}

function sameRouteEvidence(
  left: DraftModelRouteConfig['route'],
  right: DraftModelRouteConfig['route'],
): boolean {
  return (
    left.routeId === right.routeId &&
    left.purpose === right.purpose &&
    left.protocol === right.protocol &&
    left.access === right.access &&
    left.egress === right.egress &&
    left.retention === right.retention &&
    left.usage === right.usage &&
    left.modelId === right.modelId
  );
}

function parseConfiguredDraftRouteDescriptor(): ConfiguredDraftRouteDescriptor | undefined {
  const raw = process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      module?: unknown;
      route?: unknown;
      release?: unknown;
    };
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.module !== 'string' ||
      parsed.module.trim().length === 0 ||
      !isDraftRouteEvidence(parsed.route) ||
      !isDraftRouteReleaseDescriptor(parsed.release)
    ) {
      return undefined;
    }
    return { module: parsed.module.trim(), route: parsed.route, release: parsed.release };
  } catch {
    return undefined;
  }
}

/**
 * Load only an explicitly installed, purpose-bound in-process route. A
 * missing or malformed descriptor remains unavailable; it never creates a
 * hosted client, infers a transport, or silently changes workflow purpose.
 */
export function loadConfiguredDraftModelRoute(): DraftModelRouteConfig | undefined {
  if (process.env.AI_MODEL_ROUTE !== 'approved-local') return undefined;
  const descriptor = parseConfiguredDraftRouteDescriptor();
  if (!descriptor || !isActiveDraftRouteRelease(descriptor.release)) return undefined;
  try {
    const loaded = createRequire(import.meta.url)(descriptor.module) as ConfiguredDraftRouteModule;
    const configured = loaded.createDraftModelRoute
      ? loaded.createDraftModelRoute()
      : loaded.createApprovedLocalDraftRoute
        ? loaded.createApprovedLocalDraftRoute()
        : (loaded.default ?? loaded);
    if (!isDraftRouteConfig(configured) || !sameRouteEvidence(configured.route, descriptor.route)) {
      return undefined;
    }
    if (configured.release && !sameDraftRouteRelease(configured.release, descriptor.release)) {
      return undefined;
    }
    return { ...configured, release: descriptor.release };
  } catch {
    return undefined;
  }
}

/** Current server-owned authority used when revalidating a reviewed draft. */
export function resolveCurrentDraftRouteAuthority(): DraftRouteAuthority | undefined {
  if (process.env.AI_MODEL_ROUTE !== 'approved-local') return undefined;
  const descriptor = parseConfiguredDraftRouteDescriptor();
  if (!descriptor || !isActiveDraftRouteRelease(descriptor.release)) return undefined;
  // Approval revalidation must not initialize a provider/model or invoke the
  // route factory. Resolve only the explicitly configured local module path;
  // a removed module means current authority is unavailable and fails closed.
  try {
    createRequire(import.meta.url).resolve(descriptor.module);
  } catch {
    return undefined;
  }
  return { route: descriptor.route, release: descriptor.release };
}

export function createDraftModelRouteFactory(
  config?: DraftModelRouteConfig | DraftModelRouteFactory,
): DraftModelRouteFactory {
  return () => (typeof config === 'function' ? config() : config);
}

/** Normal daemon/CLI composition. */
export function createProductionDraftModelRouteFactory(): DraftModelRouteFactory {
  return createDraftModelRouteFactory(loadConfiguredDraftModelRoute);
}
