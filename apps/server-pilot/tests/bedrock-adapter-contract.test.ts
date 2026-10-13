import { describe, expect, it, vi } from 'vitest';
import {
  BedrockModelAdapter,
  estimateNovaLiteCostUsd,
  NOVA_LITE_RATE_TABLE_VERSION,
} from '../src/ai/bedrock/bedrock.js';
import { createFakeModelAdapter } from '../src/ai/bedrock/fake.js';
import { resolveModelAdapter } from '../src/ai/bedrock/factory.js';
import { LunaModelAdapter } from '../src/ai/bedrock/luna.js';
import { validateStructuredJsonOutput } from '../src/ai/security/policy.js';

describe('bedrock adapter contract', () => {
  it('fake adapter returns full usage shape', async () => {
    const adapter = createFakeModelAdapter();
    const result = await adapter.invoke({
      modelId: 'amazon.nova-lite-v1:0',
      systemPrompt: 'classify',
      userPrompt: 'classify this inbound email: hello',
    });
    expect(result.usage).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      totalTokens: expect.any(Number),
      latencyMs: expect.any(Number),
      estimatedCostUsd: expect.any(Number),
      rateTableVersion: NOVA_LITE_RATE_TABLE_VERSION,
    });
    expect(result.usage.totalTokens).toBe(
      result.usage.inputTokens + result.usage.outputTokens,
    );
  });

  it('estimateNovaLiteCostUsd applies Nova Lite rates', () => {
    expect(estimateNovaLiteCostUsd(1_000_000, 0)).toBeCloseTo(0.06, 10);
    expect(estimateNovaLiteCostUsd(0, 1_000_000)).toBeCloseTo(0.24, 10);
    expect(estimateNovaLiteCostUsd(10, 5)).toBeCloseTo(0.0000018, 10);
  });

  it('fake adapter output validates as structured JSON', async () => {
    const adapter = createFakeModelAdapter();
    const result = await adapter.invoke({
      modelId: 'amazon.nova-lite-v1:0',
      systemPrompt: 'draft system',
      userPrompt: 'draft reply for guest booking',
    });
    expect(validateStructuredJsonOutput(result.output)).toMatchObject({
      subject: expect.any(String),
    });
  });

  it('resolveModelAdapter returns fake in test env', () => {
    const adapter = resolveModelAdapter({
      NODE_ENV: 'test',
      AI_ENABLED: true,
      AI_MODEL_ID: 'amazon.nova-lite-v1:0',
      BEDROCK_REGION: 'us-east-1',
    });
    expect(adapter.constructor.name).toBe('FakeModelAdapter');
  });

  it('resolveModelAdapter returns bedrock when AI enabled in production', () => {
    const adapter = resolveModelAdapter({
      NODE_ENV: 'production',
      AI_ENABLED: true,
      AI_MODEL_ID: 'amazon.nova-lite-v1:0',
      AI_TRIAGE_MODEL_PROFILE: 'nova_lite',
      BEDROCK_REGION: 'us-east-1',
    });
    expect(adapter).toBeInstanceOf(BedrockModelAdapter);
  });

  it('defaults production triage to Bedrock-backed Luna max, never Nova Lite', () => {
    const adapter = resolveModelAdapter({
      NODE_ENV: 'production',
      AI_ENABLED: true,
      AI_MODEL_ID: 'global.openai.gpt-6-luna',
      BEDROCK_REGION: 'us-east-1',
    });
    expect(adapter).toBeInstanceOf(LunaModelAdapter);
  });

  it('requires an explicit Nova Lite model id for the deprecated legacy profile', () => {
    expect(() =>
      resolveModelAdapter({
        NODE_ENV: 'production',
        AI_ENABLED: true,
        AI_MODEL_ID: 'global.openai.gpt-6-luna',
        AI_TRIAGE_MODEL_PROFILE: 'nova_lite',
        BEDROCK_REGION: 'us-east-1',
      }),
    ).toThrow(/deprecated.*explicit.*AI_MODEL_ID/i);
  });

  it('resolveModelAdapter throws in production when AI_ENABLED is false', () => {
    expect(() =>
      resolveModelAdapter({
        NODE_ENV: 'production',
        AI_ENABLED: false,
        AI_MODEL_ID: 'amazon.nova-lite-v1:0',
        BEDROCK_REGION: 'us-east-1',
      }),
    ).toThrow(/refusing silent FakeModelAdapter fallback/i);
  });

  it('resolveModelAdapter throws in production when AI_ENABLED is undefined', () => {
    expect(() =>
      resolveModelAdapter({
        NODE_ENV: 'production',
        AI_ENABLED: undefined as unknown as boolean,
        AI_MODEL_ID: 'amazon.nova-lite-v1:0',
        BEDROCK_REGION: 'us-east-1',
      }),
    ).toThrow(/refusing silent FakeModelAdapter fallback/i);
  });

  it('mocked converse returns parsed JSON with token counts', async () => {
    const send = vi.fn().mockResolvedValue({
      output: {
        message: {
          content: [{ text: '{"category":"new-bookings","urgent":false,"confidence":0.9,"rationale":"ok","policyFlags":[]}' }],
        },
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const adapter = new BedrockModelAdapter({
      region: 'us-east-1',
      client: { send } as never,
    });
    const result = await adapter.invoke({
      modelId: 'amazon.nova-lite-v1:0',
      systemPrompt: 'classify',
      userPrompt: 'classify inbound email',
    });
    expect(result.output).toMatchObject({ category: 'new-bookings' });
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.totalTokens).toBe(15);
    expect(result.usage.estimatedCostUsd).toBeCloseTo(0.0000018, 10);
    expect(result.usage.rateTableVersion).toBe(NOVA_LITE_RATE_TABLE_VERSION);
    expect(send).toHaveBeenCalledOnce();
  });

  it('Nova omits outputConfig even when responseSchema is provided', async () => {
    const send = vi.fn().mockResolvedValue({
      output: {
        message: {
          content: [{ text: '{"category":"groups-events","urgent":false,"confidence":0.9,"rationale":"ok","policyFlags":[]}' }],
        },
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const adapter = new BedrockModelAdapter({
      region: 'us-east-1',
      client: { send } as never,
    });
    const schema = {
      type: 'object',
      properties: { category: { type: 'string' } },
    };
    await adapter.invoke({
      modelId: 'amazon.nova-lite-v1:0',
      systemPrompt: 'classify',
      userPrompt: 'classify inbound email',
      responseSchema: schema,
    });
    const commandInput = send.mock.calls[0]?.[0]?.input as {
      outputConfig?: { textFormat?: { type?: string } };
    };
    expect(commandInput.outputConfig).toBeUndefined();
  });

  it('mocked non-Nova retains JSON schema outputConfig', async () => {
    const send = vi.fn().mockResolvedValue({
      output: {
        message: {
          content: [{ text: '{"category":"ops","urgent":false,"confidence":0.9,"rationale":"ok","policyFlags":[]}' }],
        },
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const adapter = new BedrockModelAdapter({
      region: 'us-east-1',
      client: { send } as never,
    });
    const schema = {
      type: 'object',
      properties: { category: { type: 'string' } },
    };
    await adapter.invoke({
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      systemPrompt: 'classify',
      userPrompt: 'classify inbound email',
      responseSchema: schema,
    });
    const commandInput = send.mock.calls[0]?.[0]?.input as {
      outputConfig?: { textFormat?: { type?: string } };
    };
    expect(commandInput.outputConfig?.textFormat?.type).toBe('json_schema');
  });

  it('strips markdown fences before JSON parse', async () => {
    const send = vi.fn().mockResolvedValue({
      output: {
        message: {
          content: [{ text: '```json\n{"ok":true,"value":1}\n```' }],
        },
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const adapter = new BedrockModelAdapter({
      region: 'us-east-1',
      client: { send } as never,
    });
    const result = await adapter.invoke({
      modelId: 'amazon.nova-lite-v1:0',
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(result.output).toEqual({ ok: true, value: 1 });
  });

  it('maps AccessDeniedException to actionable error', async () => {
    const send = vi.fn().mockRejectedValue(
      Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' }),
    );
    const adapter = new BedrockModelAdapter({
      region: 'us-east-1',
      client: { send } as never,
    });
    await expect(
      adapter.invoke({
        modelId: 'amazon.nova-lite-v1:0',
        systemPrompt: 's',
        userPrompt: 'u',
      }),
    ).rejects.toThrow(/AccessDenied.*us-east-1/);
  });

  it('throws on empty model content', async () => {
    const send = vi.fn().mockResolvedValue({
      output: { message: { content: [{ text: '   ' }] } },
      usage: {},
    });
    const adapter = new BedrockModelAdapter({
      region: 'us-east-1',
      client: { send } as never,
    });
    await expect(
      adapter.invoke({
        modelId: 'amazon.nova-lite-v1:0',
        systemPrompt: 's',
        userPrompt: 'u',
      }),
    ).rejects.toThrow(/empty text content/);
  });
});
