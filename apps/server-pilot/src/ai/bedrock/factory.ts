import type { MailEnv } from '../../env.js';
import type { ModelAdapter } from './adapter.js';
import { createBedrockModelAdapter } from './bedrock.js';
import { createFakeModelAdapter } from './fake.js';

function isAiEnabled(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1';
}

export function resolveModelAdapter(env: Pick<
  MailEnv,
  'NODE_ENV' | 'AI_ENABLED' | 'AI_MODEL_ID' | 'BEDROCK_REGION' | 'BEDROCK_GUARDRAIL_ID' | 'BEDROCK_GUARDRAIL_VERSION'
>): ModelAdapter {
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

  return createBedrockModelAdapter({
    region: env.BEDROCK_REGION,
    modelId: env.AI_MODEL_ID,
    guardrailId: env.BEDROCK_GUARDRAIL_ID,
    guardrailVersion: env.BEDROCK_GUARDRAIL_VERSION,
  });
}

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
