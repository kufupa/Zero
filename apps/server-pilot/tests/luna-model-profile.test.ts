import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { BedrockModelAdapter } from '../src/ai/bedrock/bedrock.js';
import { resolveModelAdapter } from '../src/ai/bedrock/factory.js';
import { LUNA_MODEL_ID, LunaModelAdapter, createAzureLunaModel, createLunaModel } from '../src/ai/bedrock/luna.js';
import { parseEnv } from '../src/env.js';

const BASE_ENV = {
  NODE_ENV: 'production',
  PORT: '8788',
  DATABASE_URL: 'postgres://zero:secret@host:5432/zero',
  BETTER_AUTH_URL: 'https://nava.legacy.local',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  AWS_REGION: 'af-south-1',
  S3_BUCKET: 'nava-mail-artifacts-test',
};

const ADAPTER_ENV = {
  NODE_ENV: 'production' as const,
  AI_ENABLED: true,
  AI_MODEL_ID: 'amazon.nova-lite-v1:0',
  BEDROCK_REGION: 'us-east-1',
};

function responsesFetch(text: string, captured: { url?: string; body?: Record<string, unknown> }) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        id: 'resp_1',
        object: 'response',
        created_at: 1,
        model: LUNA_MODEL_ID,
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }],
          },
        ],
        usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

describe('AI_TRIAGE_MODEL_PROFILE', () => {
  it('defaults to nova_lite when unset', () => {
    expect(parseEnv(BASE_ENV).AI_TRIAGE_MODEL_PROFILE).toBe('nova_lite');
  });

  it('accepts gpt6_luna_max', () => {
    expect(
      parseEnv({ ...BASE_ENV, AI_TRIAGE_MODEL_PROFILE: 'gpt6_luna_max' }).AI_TRIAGE_MODEL_PROFILE,
    ).toBe('gpt6_luna_max');
  });

  it('rejects unknown profiles instead of silently using Nova', () => {
    expect(() => parseEnv({ ...BASE_ENV, AI_TRIAGE_MODEL_PROFILE: 'luna' })).toThrow(
      /AI_TRIAGE_MODEL_PROFILE/,
    );
    expect(() =>
      resolveModelAdapter({ ...ADAPTER_ENV, AI_TRIAGE_MODEL_PROFILE: 'gpt6' as never }),
    ).toThrow(/AI_TRIAGE_MODEL_PROFILE/);
  });

  it('routes the adapter by profile', () => {
    expect(resolveModelAdapter(ADAPTER_ENV)).toBeInstanceOf(BedrockModelAdapter);
    expect(
      resolveModelAdapter({ ...ADAPTER_ENV, AI_TRIAGE_MODEL_PROFILE: 'gpt6_luna_max' }),
    ).toBeInstanceOf(LunaModelAdapter);
  });
});

describe('LunaModelAdapter', () => {
  it('calls Responses on the CRIS profile at max effort without temperature', async () => {
    const captured: { url?: string; body?: Record<string, unknown> } = {};
    const adapter = new LunaModelAdapter({
      model: createLunaModel({ fetch: responsesFetch('{"primaryFolder":"bookings"}', captured) }),
    });

    const result = await adapter.invoke({
      modelId: 'amazon.nova-lite-v1:0',
      systemPrompt: 'classify',
      userPrompt: 'hello',
    });

    expect(captured.url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses');
    expect(captured.body).toMatchObject({ model: LUNA_MODEL_ID, reasoning: { effort: 'max' } });
    expect(captured.body).not.toHaveProperty('temperature');
    expect(result.output).toEqual({ primaryFolder: 'bookings' });
    expect(result.modelId).toBe(LUNA_MODEL_ID);
    expect(result.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200, totalTokens: 1200 });
    expect(result.usage.estimatedCostUsd).toBeCloseTo(0.0002, 10);
    expect(result.provenance).toMatchObject({ routeId: 'gpt6_luna_max', modelId: LUNA_MODEL_ID });
  });

  it('targets an Azure Foundry deployment with the api-key header', async () => {
    const captured: { url?: string; body?: Record<string, unknown> } = {};
    let apiKey: string | null = null;
    const fake = responsesFetch('{"ok":true}', captured);
    const adapter = new LunaModelAdapter({
      model: createAzureLunaModel({
        baseURL: 'https://example.openai.azure.com/openai/v1',
        apiKey: 'k',
        fetch: (async (input, init) => {
          apiKey = new Headers(init?.headers).get('api-key');
          return fake(input, init);
        }) as typeof fetch,
      }),
    });

    await adapter.invoke({ modelId: 'x', systemPrompt: 's', userPrompt: 'u' });

    expect(captured.url).toBe('https://example.openai.azure.com/openai/v1/responses');
    expect(captured.body).toMatchObject({ model: 'gpt-6-luna', reasoning: { effort: 'max' } });
    expect(apiKey).toBe('k');
  });

  it('fails closed without Azure settings', () => {
    expect(() => createAzureLunaModel({ baseURL: '', apiKey: '' })).toThrow(/AZURE_OPENAI_BASE_URL/);
  });
});

describe('deploy wiring', () => {
  it('persists the profile across env rewrites and PM2 restarts', async () => {
    const script = await readFile(new URL('../deploy/write-ec2-env.sh', import.meta.url), 'utf8');
    const pm2 = await readFile(new URL('../deploy/pm2.config.cjs', import.meta.url), 'utf8');
    expect(script).toContain('append_env AI_TRIAGE_MODEL_PROFILE "${AI_TRIAGE_MODEL_PROFILE:-}"');
    expect(pm2.match(/AI_TRIAGE_MODEL_PROFILE: process\.env\.AI_TRIAGE_MODEL_PROFILE \?\? 'nova_lite'/g))
      .toHaveLength(2);
  });
});
