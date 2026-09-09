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

function isRouteConfig(value: unknown): value is MailBaselineExtractionRouteConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<MailBaselineExtractionRouteConfig>;
  return (
    typeof candidate.route === 'object' &&
    candidate.route !== null &&
    typeof candidate.transport === 'function'
  );
}

/**
 * Read the explicitly configured, already-installed in-process lower edge at
 * normal startup.  A route marker or guessed endpoint never creates a
 * binding.  Deployments may point this at their reviewed local runtime
 * module; absent/invalid config remains unavailable.
 */
export function loadConfiguredMailBaselineExtractionRoute():
  | MailBaselineExtractionRouteConfig
  | undefined {
  if (process.env.AI_MODEL_ROUTE !== 'approved-local') return undefined;
  const moduleId = process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE?.trim();
  if (!moduleId) return undefined;
  try {
    const loaded = createRequire(import.meta.url)(moduleId) as ConfiguredRouteModule;
    const configured = loaded.createMailBaselineExtractionRoute
      ? loaded.createMailBaselineExtractionRoute()
      : (loaded.default ?? loaded);
    return isRouteConfig(configured) ? configured : undefined;
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
