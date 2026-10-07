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
export type LunaReasoningEffort = 'low' | 'medium' | 'high' | 'max';

export function lunaProviderOptions(reasoningEffort: LunaReasoningEffort = LUNA_REASONING_EFFORT) {
  return {
    openai: {
      forceReasoning: true,
      reasoningEffort,
      store: false,
      include: ['reasoning.encrypted_content' as const],
    },
  };
}

export const LUNA_PROVIDER_OPTIONS = lunaProviderOptions();

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

/** Same Luna model through an Azure Foundry OpenAI v1 deployment (ZDR resource). */
export function createAzureLunaModel(
  options: { baseURL?: string; apiKey?: string; deployment?: string; fetch?: typeof fetch } = {},
): LunaLanguageModel {
  const baseURL = options.baseURL ?? process.env.AZURE_OPENAI_BASE_URL;
  const apiKey = options.apiKey ?? process.env.AZURE_FOUNDRY_API_KEY;
  if (!baseURL || !apiKey) throw new Error('AZURE_OPENAI_BASE_URL and AZURE_FOUNDRY_API_KEY required');
  return createOpenAI({ baseURL, apiKey, headers: { 'api-key': apiKey }, fetch: options.fetch }).responses(
    options.deployment ?? 'gpt-6-luna',
  );
}

const LUNA_INPUT_USD_PER_MTOK = 0.1;
const LUNA_OUTPUT_USD_PER_MTOK = 0.5;
export const LUNA_RATE_TABLE_VERSION = 'gpt-6-luna-global-cris-2026-09';

/** JSON-in/JSON-out adapter so the existing triage workflow can run on Luna. */
export class LunaModelAdapter implements ModelAdapter {
  private readonly model: LunaLanguageModel;
  private readonly reasoningEffort: LunaReasoningEffort;
  private readonly routeId: string;
  private readonly modelId: string;
  private readonly protocol: string;

  constructor(
    options: {
      model?: LunaLanguageModel;
      region?: string;
      reasoningEffort?: LunaReasoningEffort;
      routeId?: string;
      modelId?: string;
      protocol?: string;
    } = {},
  ) {
    this.model = options.model ?? createLunaModel({ region: options.region });
    this.reasoningEffort = options.reasoningEffort ?? LUNA_REASONING_EFFORT;
    this.routeId = options.routeId ?? 'gpt6_luna_max';
    this.modelId = options.modelId ?? LUNA_MODEL_ID;
    this.protocol = options.protocol ?? 'bedrock-openai-responses';
  }

  async invoke(input: ModelInvokeInput): Promise<ModelInvokeResult> {
    const files = input.files ?? [];
    if(input.maxOutputTokens!==undefined&&(!Number.isSafeInteger(input.maxOutputTokens)||input.maxOutputTokens<1||input.maxOutputTokens>32768))throw new Error('model_output_limit_invalid');
    const requestBytes=Buffer.byteLength(input.systemPrompt)+Buffer.byteLength(input.userPrompt)+Buffer.byteLength(JSON.stringify(input.responseSchema??{}))+files.reduce((sum,file)=>sum+file.data.byteLength,0);
    if(input.maxInputBytes!==undefined&&(!Number.isSafeInteger(input.maxInputBytes)||input.maxInputBytes<1||requestBytes>input.maxInputBytes))throw new Error('model_input_limit_exceeded');
    if (files.length > 8 || files.some(file => file.mediaType !== 'application/pdf' || file.data.byteLength > 20 * 1024 * 1024 || file.data.byteLength <= 5 || new TextDecoder().decode(file.data.subarray(0, 5)) !== '%PDF-')) throw new Error('invalid_model_file_input');
    const started = Date.now();
    const signals = [input.signal];
    if (input.deadlineAt) signals.push(AbortSignal.timeout(Math.max(0, input.deadlineAt - started)));
    const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    const result = await this.model.doGenerate({
      prompt: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: [{ type: 'text', text: input.userPrompt }, ...files.map(file => ({ type: 'file' as const, mediaType: file.mediaType, filename: file.filename, data: { type: 'data' as const, data: file.data } }))] },
      ],
      ...(input.maxOutputTokens!==undefined?{maxOutputTokens:input.maxOutputTokens}:{}),
      responseFormat: input.responseSchema
        ? { type: 'json', schema: input.responseSchema as never, name: 'mail_ai_output' }
        : { type: 'json' },
      // Triage schemas predate OpenAI strict mode; validation happens after parse.
      providerOptions: { openai: { ...lunaProviderOptions(this.reasoningEffort).openai, strictJsonSchema: false } },
      abortSignal: active.length ? AbortSignal.any(active) : undefined,
    });
    if (result.finishReason && result.finishReason.unified !== 'stop') {
      throw new Error(`model_response_incomplete:${result.finishReason.unified}`);
    }
    const text = result.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');
    const inputTokens = result.usage.inputTokens.total ?? 0;
    const outputTokens = result.usage.outputTokens.total ?? 0;
    return {
      modelId: this.modelId,
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
        routeId: this.routeId,
        protocol: `${this.protocol}/effort-${this.reasoningEffort}`,
        modelId: this.modelId,
        usageSource: result.usage.inputTokens.total === undefined ? 'unknown' : 'reported',
      },
    };
  }
}
