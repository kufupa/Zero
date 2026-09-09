import type { LocalModelRouteEvidence, LocalModelTransport } from './bedrock/local.js';
import { createRequire } from 'node:module';

/** Explicitly configured lower edge for the normal draft-purpose route. */
export type DraftModelRouteConfig = {
  route: LocalModelRouteEvidence & { purpose: 'draft' };
  transport: LocalModelTransport;
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
};

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
    const parsed = JSON.parse(raw) as { module?: unknown; route?: unknown };
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.module !== 'string' ||
      parsed.module.trim().length === 0 ||
      !isDraftRouteEvidence(parsed.route)
    ) {
      return undefined;
    }
    return { module: parsed.module.trim(), route: parsed.route };
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
  if (!descriptor) return undefined;
  try {
    const loaded = createRequire(import.meta.url)(descriptor.module) as ConfiguredDraftRouteModule;
    const configured = loaded.createDraftModelRoute
      ? loaded.createDraftModelRoute()
      : loaded.createApprovedLocalDraftRoute
        ? loaded.createApprovedLocalDraftRoute()
        : (loaded.default ?? loaded);
    return isDraftRouteConfig(configured) && sameRouteEvidence(configured.route, descriptor.route)
      ? configured
      : undefined;
  } catch {
    return undefined;
  }
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
