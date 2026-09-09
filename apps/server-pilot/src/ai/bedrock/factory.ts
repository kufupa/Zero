import { resolveModelRoute, type ModelRoutePurpose } from '../local-model-routing.js';
import type { LocalModelRouteEvidence, LocalModelTransport } from './local.js';
import { LocalModelRouteUnavailableError } from './local.js';
import type { AiModelRoute, MailEnv } from '../../env.js';
import { createBedrockModelAdapter } from './bedrock.js';
import { createFakeModelAdapter } from './fake.js';
import type { ModelAdapter } from './adapter.js';

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
  >,
): ModelAdapter {
  if (env.NODE_ENV === 'test') {
    return createFakeModelAdapter();
  }

  if (!env.AI_ENABLED) {
    return createFakeModelAdapter();
  }

  return createBedrockModelAdapter({
    region: env.BEDROCK_REGION,
    modelId: env.AI_MODEL_ID,
    guardrailId: env.BEDROCK_GUARDRAIL_ID,
    guardrailVersion: env.BEDROCK_GUARDRAIL_VERSION,
  });
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
