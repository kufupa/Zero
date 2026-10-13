import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import type { ModelAdapter, ModelInvokeInput, ModelInvokeResult } from './adapter.js';
import { validateStructuredJsonOutput } from '../security/policy.js';

const DEFAULT_BEDROCK_REGION = 'us-east-1';

const NOVA_LITE_INPUT_USD_PER_MTOK = 0.06;
const NOVA_LITE_OUTPUT_USD_PER_MTOK = 0.24;
export const NOVA_LITE_RATE_TABLE_VERSION = 'nova-lite-v1-2026-07';

export function estimateNovaLiteCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1e6) * NOVA_LITE_INPUT_USD_PER_MTOK +
    (outputTokens / 1e6) * NOVA_LITE_OUTPUT_USD_PER_MTOK
  );
}

export interface BedrockModelAdapterConfig {
  region?: string;
  modelId?: string;
  guardrailId?: string;
  guardrailVersion?: string;
  client?: BedrockRuntimeClient;
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseModelJson(text: string): Record<string, unknown> {
  const cleaned = stripMarkdownFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('model output was not valid JSON');
  }
  return validateStructuredJsonOutput(parsed);
}

function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    throw new Error('model returned no text content');
  }
  const textBlock = content.find(
    (block): block is { text: string } =>
      typeof block === 'object' &&
      block !== null &&
      'text' in block &&
      typeof (block as { text?: unknown }).text === 'string',
  );
  if (!textBlock?.text.trim()) {
    throw new Error('model returned empty text content');
  }
  return textBlock.text;
}

function formatBedrockError(error: unknown, region: string, modelId: string): Error {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : 'BedrockError';
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);
  if (name === 'AccessDeniedException') {
    return new Error(
      `Bedrock AccessDenied for model ${modelId} in ${region}: ${message}`,
    );
  }
  return new Error(`Bedrock ${name} for model ${modelId} in ${region}: ${message}`);
}

/** @deprecated Explicit Nova Lite compatibility path only; new triage defaults to the Luna adapter. */
export class BedrockModelAdapter implements ModelAdapter {
  private readonly client: BedrockRuntimeClient;
  private readonly region: string;
  private readonly defaultModelId?: string;
  private readonly guardrailId?: string;
  private readonly guardrailVersion?: string;

  constructor(config: BedrockModelAdapterConfig = {}) {
    this.region = config.region ?? DEFAULT_BEDROCK_REGION;
    this.defaultModelId = config.modelId;
    this.guardrailId = config.guardrailId;
    this.guardrailVersion = config.guardrailVersion;
    this.client =
      config.client ??
      new BedrockRuntimeClient({
        region: this.region,
      });
  }

  async invoke(input: ModelInvokeInput): Promise<ModelInvokeResult> {
    const modelId = input.modelId || this.defaultModelId;
    if (!modelId) {
      throw new Error('modelId is required for Bedrock invoke');
    }

    const started = Date.now();
    const commandInput: ConverseCommandInput = {
      modelId,
      system: [{ text: input.systemPrompt }],
      messages: [{ role: 'user', content: [{ text: input.userPrompt }] }],
    };

    commandInput.inferenceConfig = { maxTokens: 2048, temperature: 0 };
    // Nova Converse models reject outputConfig; rely on prompt + parseModelJson.
    const supportsOutputConfig = !/amazon\.nova/i.test(modelId);
    if (input.responseSchema && supportsOutputConfig) {
      commandInput.outputConfig = {
        textFormat: {
          type: 'json_schema',
          structure: {
            jsonSchema: {
              schema: JSON.stringify(input.responseSchema),
              name: 'mail_ai_output',
              description: 'Structured output for server-pilot mail AI',
            },
          },
        },
      };
    }

    if (this.guardrailId && this.guardrailVersion) {
      commandInput.guardrailConfig = {
        guardrailIdentifier: this.guardrailId,
        guardrailVersion: this.guardrailVersion,
      };
    }

    const run = async () => this.client.send(new ConverseCommand(commandInput));

    let response;
    try {
      response = await run();
    } catch (error) {
      const name =
        typeof error === 'object' && error !== null && 'name' in error
          ? String((error as { name: unknown }).name)
          : '';
      if (name === 'ThrottlingException') {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          response = await run();
        } catch (retryError) {
          throw formatBedrockError(retryError, this.region, modelId);
        }
      } else {
        throw formatBedrockError(error, this.region, modelId);
      }
    }

    const text = extractTextContent(response.output?.message?.content);
    const output = parseModelJson(text);
    const latencyMs = Date.now() - started;
    const inputTokens = response.usage?.inputTokens ?? 0;
    const outputTokens = response.usage?.outputTokens ?? 0;

    return {
      modelId,
      output,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        latencyMs,
        estimatedCostUsd: estimateNovaLiteCostUsd(inputTokens, outputTokens),
        rateTableVersion: NOVA_LITE_RATE_TABLE_VERSION,
      },
    };
  }
}

export function createBedrockModelAdapter(
  config: BedrockModelAdapterConfig = {},
): ModelAdapter {
  return new BedrockModelAdapter(config);
}
