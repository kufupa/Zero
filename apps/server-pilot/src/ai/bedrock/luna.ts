import { createHash, createHmac, type BinaryLike } from 'node:crypto';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import type { ModelAdapter, ModelInvokeInput, ModelInvokeResult } from './adapter.js';
import { parseModelJson } from './bedrock.js';

/** Global CRIS profile; bedrock-runtime rejects the base model id in-Region. */
export const LUNA_MODEL_ID = 'global.openai.gpt-6-luna';
export const LUNA_REASONING_EFFORT = 'max';
const DEFAULT_LUNA_REGION = 'us-east-1';

/**
 * Pass on every generate. The profile id does not match the SDK's `gpt-N`
 * regex, so reasoning must be forced or effort is silently dropped. Bedrock
 * does not keep stored responses, so reasoning state travels encrypted.
 */
export const LUNA_PROVIDER_OPTIONS = {
  openai: {
    forceReasoning: true,
    reasoningEffort: LUNA_REASONING_EFFORT,
    store: false,
    include: ['reasoning.encrypted_content'],
  },
};

type SourceData = string | ArrayBuffer | ArrayBufferView;

function toBinary(data: SourceData): BinaryLike {
  if (typeof data === 'string') return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}

class NodeSha256 {
  private readonly hash;
  constructor(secret?: SourceData) {
    this.hash = secret ? createHmac('sha256', toBinary(secret)) : createHash('sha256');
  }
  update(data: SourceData): void {
    this.hash.update(toBinary(data));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }
}

export function createSigV4Fetch(
  region: string,
  credentials: ConstructorParameters<typeof SignatureV4>[0]['credentials'] = defaultProvider(),
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  const signer = new SignatureV4({ service: 'bedrock', region, credentials, sha256: NodeSha256 });
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      if (key !== 'authorization') headers[key] = value;
    });
    headers.host = url.host;
    const signed = await signer.sign({
      method: init?.method ?? 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      body: init?.body ?? undefined,
    });
    const { host: _host, ...sendHeaders } = signed.headers;
    return baseFetch(url, { ...init, headers: sendHeaders });
  };
}

export type LunaLanguageModel = ReturnType<OpenAIProvider['responses']>;

export function createLunaModel(
  options: { region?: string; modelId?: string; fetch?: typeof fetch } = {},
): LunaLanguageModel {
  const region = options.region ?? DEFAULT_LUNA_REGION;
  const provider = createOpenAI({
    baseURL: `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`,
    apiKey: 'sigv4',
    fetch: options.fetch ?? createSigV4Fetch(region),
  });
  return provider.responses(options.modelId ?? LUNA_MODEL_ID);
}

const LUNA_INPUT_USD_PER_MTOK = 0.1;
const LUNA_OUTPUT_USD_PER_MTOK = 0.5;
export const LUNA_RATE_TABLE_VERSION = 'gpt-6-luna-global-cris-2026-09';

/** JSON-in/JSON-out adapter so the existing triage workflow can run on Luna. */
export class LunaModelAdapter implements ModelAdapter {
  private readonly model: LunaLanguageModel;

  constructor(options: { model?: LunaLanguageModel; region?: string } = {}) {
    this.model = options.model ?? createLunaModel({ region: options.region });
  }

  async invoke(input: ModelInvokeInput): Promise<ModelInvokeResult> {
    const started = Date.now();
    const signals = [input.signal];
    if (input.deadlineAt) signals.push(AbortSignal.timeout(Math.max(0, input.deadlineAt - started)));
    const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    const result = await this.model.doGenerate({
      prompt: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: [{ type: 'text', text: input.userPrompt }] },
      ],
      responseFormat: input.responseSchema
        ? { type: 'json', schema: input.responseSchema as never, name: 'mail_ai_output' }
        : { type: 'json' },
      // Triage schemas predate OpenAI strict mode; validation happens after parse.
      providerOptions: { openai: { ...LUNA_PROVIDER_OPTIONS.openai, strictJsonSchema: false } },
      abortSignal: active.length ? AbortSignal.any(active) : undefined,
    });
    const text = result.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');
    const inputTokens = result.usage.inputTokens.total ?? 0;
    const outputTokens = result.usage.outputTokens.total ?? 0;
    return {
      modelId: LUNA_MODEL_ID,
      output: parseModelJson(text),
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        latencyMs: Date.now() - started,
        estimatedCostUsd:
          (inputTokens / 1e6) * LUNA_INPUT_USD_PER_MTOK +
          (outputTokens / 1e6) * LUNA_OUTPUT_USD_PER_MTOK,
        rateTableVersion: LUNA_RATE_TABLE_VERSION,
      },
      provenance: {
        routeId: 'gpt6_luna_max',
        protocol: `bedrock-openai-responses/effort-${LUNA_REASONING_EFFORT}`,
        modelId: LUNA_MODEL_ID,
        usageSource: result.usage.inputTokens.total === undefined ? 'unknown' : 'reported',
      },
    };
  }
}
