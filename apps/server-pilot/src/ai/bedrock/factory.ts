import { resolveModelRoute, type ModelRoutePurpose } from '../local-model-routing.js';
import type { LocalModelRouteEvidence, LocalModelTransport } from './local.js';
import { LocalModelRouteUnavailableError } from './local.js';
import { parseAiTriageModelProfile, type AiModelRoute, type MailEnv } from '../../env.js';
import { createBedrockModelAdapter } from './bedrock.js';
import { AzureLunaModelAdapter } from './luna.js';
import { createFakeModelAdapter } from './fake.js';
import type { ModelAdapter } from './adapter.js';
import { createRequire } from 'node:module';

function isAiEnabled(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1';
}

export function resolveModelAdapter(
  env: Pick<
    MailEnv,
    | 'NODE_ENV'
    | 'AI_ENABLED'
    | 'AI_MODEL_ID'
    | 'BEDROCK_REGION'
    | 'BEDROCK_GUARDRAIL_ID'
    | 'BEDROCK_GUARDRAIL_VERSION'
  > & { AI_TRIAGE_MODEL_PROFILE?: MailEnv['AI_TRIAGE_MODEL_PROFILE'] },
): ModelAdapter {
  const profile = parseAiTriageModelProfile(env.AI_TRIAGE_MODEL_PROFILE);
  if (env.NODE_ENV === 'test') {
    return createFakeModelAdapter();
  }

  if (!env.AI_ENABLED) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'AI_ENABLED is false or missing in production: refusing silent FakeModelAdapter fallback',
      );
    }
    return createFakeModelAdapter();
  }

  if (profile === 'gpt6_luna_max') {
    try {
      return new AzureLunaModelAdapter();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `AI_TRIAGE_MODEL_PROFILE=gpt6_luna_max requires AZURE_OPENAI_BASE_URL and AZURE_FOUNDRY_API_KEY (${message}); refusing silent Bedrock fallback`,
      );
    }
  }

  return createBedrockModelAdapter({
    region: env.BEDROCK_REGION,
    modelId: env.AI_MODEL_ID,
    guardrailId: env.BEDROCK_GUARDRAIL_ID,
    guardrailVersion: env.BEDROCK_GUARDRAIL_VERSION,
  });
}

export type TriageModelLabels = {
  modelId: string;
  routeId: string;
  protocol: string;
};

/** Ledger/enqueue labels for the profile `resolveModelAdapter` will actually run. */
export function triageModelLabels(
  env: Record<string, string | undefined> = process.env,
): TriageModelLabels {
  const profile = parseAiTriageModelProfile(
    env.AI_TRIAGE_MODEL_PROFILE as MailEnv['AI_TRIAGE_MODEL_PROFILE'] | undefined,
  );
  if (profile === 'nova_lite') {
    return {
      modelId: env.AI_MODEL_ID?.trim() || 'amazon.nova-lite-v1:0',
      routeId: 'nova_lite',
      protocol: 'bedrock-converse',
    };
  }
  return {
    modelId: 'gpt-6-luna',
    routeId: 'azure_luna_max',
    protocol: 'azure-foundry-responses',
  };
}

export type ApprovedLocalModelAdapterInput = {
  purpose: ModelRoutePurpose;
  route?: LocalModelRouteEvidence;
  transport?: LocalModelTransport;
};

/**
 * Resolve a purpose-specific approved route. This deliberately lives beside
 * the legacy factory so existing off-mode/test callers remain compatible,
 * while new drafting/extraction/shadow/judge callers cannot fall through to
 * Bedrock or a fake model when the local route is absent.
 */
export function resolveApprovedLocalModelAdapter(
  env: Pick<MailEnv, 'AI_MODEL_ROUTE'> | { AI_MODEL_ROUTE?: AiModelRoute },
  input: ApprovedLocalModelAdapterInput,
): ModelAdapter {
  if (env.AI_MODEL_ROUTE !== 'approved-local') {
    throw new LocalModelRouteUnavailableError(
      `approved local model route unavailable for ${input.purpose}`,
    );
  }
  return resolveModelRoute(input);
}

export const resolveApprovedModelAdapter = resolveApprovedLocalModelAdapter;

/** Resolve adapter from runtime process env (ai-worker / workflow). */
export function createModelAdapter(): ModelAdapter {
  return resolveModelAdapter({
    NODE_ENV: (process.env.NODE_ENV as MailEnv['NODE_ENV']) ?? 'development',
    AI_ENABLED: isAiEnabled(process.env.AI_ENABLED),
    AI_MODEL_ID: process.env.AI_MODEL_ID,
    AI_TRIAGE_MODEL_PROFILE: process.env.AI_TRIAGE_MODEL_PROFILE as MailEnv['AI_TRIAGE_MODEL_PROFILE'],
    BEDROCK_REGION: process.env.BEDROCK_REGION,
    BEDROCK_GUARDRAIL_ID: process.env.BEDROCK_GUARDRAIL_ID,
    BEDROCK_GUARDRAIL_VERSION: process.env.BEDROCK_GUARDRAIL_VERSION,
  });
}

/** Runtime constructor for explicit callers; missing env/config fails closed. */
export function createApprovedLocalModelAdapter(
  input: ApprovedLocalModelAdapterInput,
): ModelAdapter {
  return resolveApprovedLocalModelAdapter(
    { AI_MODEL_ROUTE: process.env.AI_MODEL_ROUTE as AiModelRoute | undefined },
    input,
  );
}

export const createApprovedModelAdapter = createApprovedLocalModelAdapter;

export type ShadowModelRouteConfig = {
  route: LocalModelRouteEvidence & { purpose: 'shadow' };
  transport: LocalModelTransport;
};

export type ShadowModelRouteFactory = () => ShadowModelRouteConfig | undefined;

type ConfiguredShadowRouteModule = {
  default?: unknown;
  createShadowModelRoute?: () => unknown;
};

type ConfiguredShadowRouteDescriptor = {
  module: string;
  route: LocalModelRouteEvidence & { purpose: 'shadow' };
};

function isShadowRouteEvidence(value: unknown): value is ShadowModelRouteConfig['route'] {
  if (typeof value !== 'object' || value === null) return false;
  const route = value as Partial<LocalModelRouteEvidence>;
  return (
    typeof route.routeId === 'string' &&
    route.routeId.trim().length > 0 &&
    route.purpose === 'shadow' &&
    route.protocol === 'in_process' &&
    route.access === 'current_app' &&
    route.egress === 'none' &&
    route.retention === 'bounded' &&
    route.usage === 'reported' &&
    typeof route.modelId === 'string' &&
    route.modelId.trim().length > 0
  );
}

function isShadowRouteConfig(value: unknown): value is ShadowModelRouteConfig {
  if (typeof value !== 'object' || value === null) return false;
  const config = value as Partial<ShadowModelRouteConfig>;
  return isShadowRouteEvidence(config.route) && typeof config.transport === 'function';
}

function parseConfiguredShadowRouteDescriptor(): ConfiguredShadowRouteDescriptor | undefined {
  const raw = process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { module?: unknown; route?: unknown };
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.module !== 'string' ||
      parsed.module.trim().length === 0 ||
      !isShadowRouteEvidence(parsed.route)
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
 * Load the explicitly configured, already-installed shadow lower edge. The
 * descriptor is purpose-bound before importing its module; a route marker or
 * guessed module alone can never initialize a transport.
 */
export function loadConfiguredShadowModelRoute(): ShadowModelRouteConfig | undefined {
  if (process.env.AI_MODEL_ROUTE !== 'approved-local') return undefined;
  const descriptor = parseConfiguredShadowRouteDescriptor();
  if (!descriptor) return undefined;
  try {
    const loaded = createRequire(import.meta.url)(descriptor.module) as ConfiguredShadowRouteModule;
    const configured = loaded.createShadowModelRoute
      ? loaded.createShadowModelRoute()
      : (loaded.default ?? loaded);
    if (!isShadowRouteConfig(configured)) return undefined;
    return sameRouteEvidence(configured.route, descriptor.route) ? configured : undefined;
  } catch {
    return undefined;
  }
}

export function createShadowModelRouteFactory(
  config?: ShadowModelRouteConfig | ShadowModelRouteFactory,
): ShadowModelRouteFactory {
  return () => (typeof config === 'function' ? config() : config);
}

export function createProductionShadowModelRouteFactory(): ShadowModelRouteFactory {
  return createShadowModelRouteFactory(loadConfiguredShadowModelRoute);
}
