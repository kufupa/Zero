import {
  LocalModelRouteUnavailableError,
  createLocalModelAdapter,
  type LocalModelRouteEvidence,
  type LocalModelTransportRequest,
} from '../src/ai/bedrock/local.js';
import { describe, expect, it, vi } from 'vitest';

const evidence: LocalModelRouteEvidence = {
  routeId: 'approved-local-test',
  purpose: 'draft',
  protocol: 'in_process',
  access: 'current_app',
  egress: 'none',
  retention: 'bounded',
  usage: 'reported',
  modelId: 'local-test-model',
};

describe('approved local model adapter', () => {
  it('forwards an explicitly supplied reservation without inventing one', async () => {
    const reserveCalls=vi.fn(async()=>{}),transport=vi.fn();
    const adapter=createLocalModelAdapter({route:evidence,transport,reserveCalls} as never);
    const signal=new AbortController().signal;
    await adapter.reserveCalls!(3,signal);
    expect(reserveCalls).toHaveBeenCalledExactlyOnceWith(3,signal);expect(transport).not.toHaveBeenCalled();
    expect(createLocalModelAdapter({route:evidence,transport}).reserveCalls).toBeUndefined();
  });
  it('preserves reservation rejection and rejects invalid counts or aborts without transport', async () => {
    const transport=vi.fn(),reserveCalls=vi.fn(async()=>{throw new Error('budget_denied');});
    const adapter=createLocalModelAdapter({route:evidence,transport,reserveCalls} as never),controller=new AbortController();
    await expect(adapter.reserveCalls!(2,controller.signal)).rejects.toThrow('budget_denied');
    for(const count of [0,-1,1.5,NaN])await expect(adapter.reserveCalls!(count,controller.signal)).rejects.toThrow();
    const reason=new Error('reservation_aborted');controller.abort(reason);await expect(adapter.reserveCalls!(2,controller.signal)).rejects.toBe(reason);
    expect(reserveCalls).toHaveBeenCalledTimes(1);expect(transport).not.toHaveBeenCalled();
  });
  it('rejects an abort occurring during reservation', async () => {
    const controller=new AbortController(),reason=new Error('during_reservation');
    const adapter=createLocalModelAdapter({route:evidence,transport:vi.fn(),reserveCalls:async()=>{controller.abort(reason);}} as never);
    await expect(adapter.reserveCalls!(2,controller.signal)).rejects.toBe(reason);
  });
  it('passes both admitted PDF and raster bytes through unchanged', async () => {
    const files=[{filename:'original.pdf',mediaType:'application/pdf' as const,data:new Uint8Array([1,2])}],images=[{filename:'original.png',mediaType:'image/png' as const,data:new Uint8Array([3,4])}];
    const transport=vi.fn(async(_request:LocalModelTransportRequest)=>({output:{},usage:{inputTokens:1,outputTokens:1,latencyMs:1}}));
    await createLocalModelAdapter({route:evidence,transport}).invoke({modelId:evidence.modelId,systemPrompt:'system',userPrompt:'{}',files,images});
    expect(transport.mock.calls[0]?.[0]).toMatchObject({files,images});
  });
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

  it('refuses a caller model that is not the exact purpose-bound route model', async () => {
    let transportCalls = 0;
    const purposeBoundEvidence = {
      ...evidence,
      purpose: 'draft',
    } as LocalModelRouteEvidence;
    const adapter = createLocalModelAdapter({
      route: purposeBoundEvidence,
      transport: async () => {
        transportCalls += 1;
        return {
          output: {},
          usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
        };
      },
    });

    await expect(
      adapter.invoke({
        modelId: 'unapproved-hosted-looking-model',
        systemPrompt: 'system',
        userPrompt: '{}',
      }),
    ).rejects.toThrow(LocalModelRouteUnavailableError);
    expect(transportCalls).toBe(0);
  });
});
