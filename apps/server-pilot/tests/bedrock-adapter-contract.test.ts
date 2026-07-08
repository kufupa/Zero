import { describe, expect, it, vi } from 'vitest';
import { BedrockModelAdapter } from '../src/ai/bedrock/bedrock.js';
import { createFakeModelAdapter } from '../src/ai/bedrock/fake.js';
import { resolveModelAdapter } from '../src/ai/bedrock/factory.js';
import { validateStructuredJsonOutput } from '../src/ai/security/policy.js';

describe('bedrock adapter contract', () => {
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
      BEDROCK_REGION: 'us-east-1',
    });
    expect(adapter).toBeInstanceOf(BedrockModelAdapter);
  });

  it('mocked converse returns parsed JSON with token counts', async () => {
    const send = vi.fn().mockResolvedValue({
      output: {
        message: {
          content: [{ text: '{"category":"individual","urgent":false,"confidence":0.9,"rationale":"ok","policyFlags":[]}' }],
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
    expect(result.output).toMatchObject({ category: 'individual' });
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(send).toHaveBeenCalledOnce();
  });

  it('uses outputConfig when responseSchema is provided', async () => {
    const send = vi.fn().mockResolvedValue({
      output: {
        message: {
          content: [{ text: '{"category":"group","urgent":false,"confidence":0.9,"rationale":"ok","policyFlags":[]}' }],
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
