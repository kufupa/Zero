import type { LocalModelRouteEvidence, LocalModelTransport } from './bedrock/local.js';
import { createRequire } from 'node:module';

/**
 * The normal worker composition owns this boundary.  A lower in-process
 * transport may be bound by an approved deployment/test composition, but an
 * absent binding is intentionally represented as `undefined` so extraction
 * stays an honest source observation.
 */
export type MailBaselineExtractionRouteConfig = {
  route: LocalModelRouteEvidence;
  transport: LocalModelTransport;
};

export type MailBaselineExtractionRouteFactory = () =>
  | MailBaselineExtractionRouteConfig
  | undefined;

type ConfiguredRouteModule = {
  default?: unknown;
  createMailBaselineExtractionRoute?: () => unknown;
};

type ConfiguredRouteDescriptor = {
  module: string;
  route: LocalModelRouteEvidence;
};

function isRouteConfig(value: unknown): value is MailBaselineExtractionRouteConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<MailBaselineExtractionRouteConfig>;
  return (
    typeof candidate.route === 'object' &&
    candidate.route !== null &&
    typeof candidate.transport === 'function'
  );
}

function isExtractionRouteEvidence(value: unknown): value is LocalModelRouteEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<LocalModelRouteEvidence>;
  return (
    typeof candidate.routeId === 'string' &&
    candidate.routeId.trim().length > 0 &&
    candidate.purpose === 'extraction' &&
    candidate.protocol === 'in_process' &&
    candidate.access === 'current_app' &&
    candidate.egress === 'none' &&
    candidate.retention === 'bounded' &&
    candidate.usage === 'reported' &&
    typeof candidate.modelId === 'string' &&
    candidate.modelId.trim().length > 0
  );
}

function parseConfiguredRouteDescriptor(): ConfiguredRouteDescriptor | undefined {
  const raw = process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      module?: unknown;
      route?: unknown;
    };
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.module !== 'string' ||
      parsed.module.trim().length === 0 ||
      !isExtractionRouteEvidence(parsed.route)
    ) {
      return undefined;
    }
    return { module: parsed.module.trim(), route: parsed.route };
  } catch {
    return undefined;
  }
}

function sameRouteEvidence(left: LocalModelRouteEvidence, right: LocalModelRouteEvidence): boolean {
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

/**
 * Read the explicitly configured, already-installed in-process lower edge at
 * normal startup.  The inert descriptor is independently purpose-bound before
 * this function imports or invokes the configured module.  A route marker,
 * module path, or guessed endpoint never creates a binding.  Deployments may
 * point the descriptor at their reviewed local runtime module; absent/invalid
 * config remains unavailable.
 */
export function loadConfiguredMailBaselineExtractionRoute():
  | MailBaselineExtractionRouteConfig
  | undefined {
  if (process.env.AI_MODEL_ROUTE !== 'approved-local') return undefined;
  const descriptor = parseConfiguredRouteDescriptor();
  if (!descriptor) return undefined;
  try {
    const loaded = createRequire(import.meta.url)(descriptor.module) as ConfiguredRouteModule;
    const configured = loaded.createMailBaselineExtractionRoute
      ? loaded.createMailBaselineExtractionRoute()
      : (loaded.default ?? loaded);
    return isRouteConfig(configured) && sameRouteEvidence(configured.route, descriptor.route)
      ? configured
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compose the purpose-bound route once at the worker entry boundary.  This
 * function does not infer approval from `AI_MODEL_ROUTE`, create a hosted
 * client, or fabricate a lower transport.  A missing config is unavailable.
 */
export function createMailBaselineExtractionRouteFactory(
  config?:
    | MailBaselineExtractionRouteConfig
    | (() => MailBaselineExtractionRouteConfig | undefined),
): MailBaselineExtractionRouteFactory {
  return () => (typeof config === 'function' ? config() : config);
}

/** Normal CLI/daemon composition. */
export function createProductionMailBaselineExtractionRouteFactory(): MailBaselineExtractionRouteFactory {
  return createMailBaselineExtractionRouteFactory(loadConfiguredMailBaselineExtractionRoute);
}
