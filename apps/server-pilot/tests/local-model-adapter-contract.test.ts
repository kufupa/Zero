import {
  LocalModelRouteUnavailableError,
  createLocalModelAdapter,
  type LocalModelRouteEvidence,
} from '../src/ai/bedrock/local.js';
import { describe, expect, it } from 'vitest';

const evidence: LocalModelRouteEvidence = {
  routeId: 'approved-local-test',
  protocol: 'in_process',
  access: 'current_app',
  egress: 'none',
  retention: 'bounded',
  usage: 'reported',
  modelId: 'local-test-model',
};

describe('approved local model adapter', () => {
  it('refuses before transport initialization when route evidence is absent', () => {
    let transportInitialized = false;
    expect(() =>
      createLocalModelAdapter({
        transport: async () => {
          transportInitialized = true;
          return {};
        },
      }),
    ).toThrow(LocalModelRouteUnavailableError);
    expect(transportInitialized).toBe(false);
  });

  it('passes prepared input through the local transport and preserves usage provenance', async () => {
    let receivedSignal: AbortSignal | undefined;
    const adapter = createLocalModelAdapter({
      route: evidence,
      transport: async (request) => {
        receivedSignal = request.signal;
        return {
          output: '{"outcome":"abstain","reason":"manual review"}',
          usage: { inputTokens: 3, outputTokens: 4, latencyMs: 5 },
        };
      },
    });

    const signal = new AbortController().signal;
    const result = await adapter.invoke({
      modelId: 'local-test-model',
      systemPrompt: 'system',
      userPrompt: '{"prepared":true}',
      signal,
    });

    expect(result.output).toEqual({ outcome: 'abstain', reason: 'manual review' });
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    expect(result.provenance).toMatchObject({ routeId: evidence.routeId, protocol: 'in_process' });
    expect(receivedSignal).toBe(signal);
  });

  it('returns a safe invalid-json error without exposing model output', async () => {
    const adapter = createLocalModelAdapter({
      route: evidence,
      transport: async () => ({
        output: 'not-json secret=do-not-log',
        usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 },
      }),
    });

    await expect(
      adapter.invoke({
        modelId: 'local-test-model',
        systemPrompt: 'system',
        userPrompt: '{}',
      }),
    ).rejects.toThrow(/valid JSON/i);
  });

  it('propagates a deadline to the approved transport and returns an abort error', async () => {
    const adapter = createLocalModelAdapter({
      route: evidence,
      transport: ({ signal }) =>
        new Promise((resolve) => {
          signal?.addEventListener(
            'abort',
            () =>
              resolve({
                output: { replyText: 'late' },
                usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 },
              }),
            { once: true },
          );
        }),
    });

    await expect(
      adapter.invoke({
        modelId: evidence.modelId,
        systemPrompt: 'system',
        userPrompt: '{}',
        deadlineAt: Date.now() + 5,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses a missing transport before any model call', () => {
    expect(() =>
      createLocalModelAdapter({
        route: evidence,
        transport: undefined as never,
      }),
    ).toThrow(LocalModelRouteUnavailableError);
  });
});
