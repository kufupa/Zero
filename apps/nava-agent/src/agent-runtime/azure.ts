import { setTimeout as sleep } from 'node:timers/promises';
import { strictCompatible } from './strict-schema.js';
import { RuntimeLoop } from './loop.js';
import type { AgentRuntime, ModelCall, ModelRequest, ModelResponse, RuntimeBlock, RuntimeDeps, RuntimeMessage, ToolDefinition, TurnInput } from './loop.js';

export type { AgentRuntime, RuntimeDeps, TurnInput } from './loop.js';

const DEFAULT_BASE_URL = 'https://nava.openai.azure.com/openai/v1';
const DEFAULT_DEPLOYMENT = 'gpt-6-luna';
const DEFAULT_REASONING = 'high';

export type AzureResponsesOptions = {
  baseURL: string;
  apiKey: string;
  deployment: string;
  effort: string;
  maxTokens: number;
  fetcher?: typeof fetch;
  wait?: (ms: number) => Promise<unknown>;
};

function azureConfig() {
  const baseURL = (process.env.AZURE_OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const apiKey = process.env.AZURE_FOUNDRY_API_KEY ?? process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.NAVA_AGENT_AZURE_DEPLOYMENT ?? DEFAULT_DEPLOYMENT;
  const effort = process.env.NAVA_AGENT_REASONING_EFFORT ?? DEFAULT_REASONING;
  if (!apiKey) throw new Error('AZURE_OPENAI_API_KEY_REQUIRED');
  if (!['low', 'medium', 'high', 'max'].includes(effort)) throw new Error('INVALID_REASONING_EFFORT');
  return { baseURL, apiKey, deployment, effort };
}

function toolArguments(input: unknown): string {
  if (typeof input === 'string') return input;
  const encoded = JSON.stringify(input ?? {});
  if (encoded === undefined) throw new Error('TOOL_INPUT_NOT_JSON');
  return encoded;
}

function toResponsesInput(messages: RuntimeMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const texts: string[] = [];
      for (const block of message.content) {
        if (block.type === 'text') {
          if (typeof block.text !== 'string') throw new Error('INVALID_TEXT_BLOCK');
          texts.push(block.text);
          continue;
        }
        if (block.type === 'tool_result') {
          if (typeof block.tool_use_id !== 'string' || typeof block.content !== 'string') throw new Error('INVALID_TOOL_RESULT');
          items.push({ type: 'function_call_output', call_id: block.tool_use_id, output: block.content });
          continue;
        }
        throw new Error('UNSUPPORTED_USER_BLOCK');
      }
      if (texts.length) items.push({ role: 'user', content: texts.join('\n') });
      continue;
    }
    const texts: string[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        if (texts.length) {
          items.push({ role: 'assistant', content: texts.splice(0).join('\n') });
        }
        if (typeof block.id !== 'string' || typeof block.name !== 'string') throw new Error('INVALID_TOOL_USE');
        items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: toolArguments(block.input) });
        continue;
      }
      if (block.type === 'text') {
        if (typeof block.text !== 'string') throw new Error('INVALID_TEXT_BLOCK');
        texts.push(block.text);
        continue;
      }
      if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
      throw new Error('UNSUPPORTED_ASSISTANT_BLOCK');
    }
    if (texts.length) items.push({ role: 'assistant', content: texts.join('\n') });
  }
  return items;
}

function toResponsesTools(tools: ToolDefinition[]) {
  return tools.map(tool => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    ...(strictCompatible(tool.input_schema, true) ? { strict: true as const } : {}),
  }));
}

function parseToolInput(argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText || '{}');
  } catch {
    throw new Error('INVALID_FUNCTION_CALL_ARGUMENTS');
  }
}

function fromResponsesOutput(payload: {
  output?: Array<Record<string, unknown>>;
}): { content: RuntimeBlock[]; stop_reason: string | null } {
  const content: RuntimeBlock[] = [];
  let sawTool = false;
  for (const item of payload.output ?? []) {
    if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') {
        throw new Error('INVALID_FUNCTION_CALL');
      }
      sawTool = true;
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: parseToolInput(item.arguments) });
      continue;
    }
    if (item.type === 'message') {
      const parts = Array.isArray(item.content) ? item.content : [];
      for (const part of parts) {
        if (typeof part !== 'object' || part === null) continue;
        const block = part as Record<string, unknown>;
        if (block.type === 'output_text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text });
      }
      continue;
    }
    if (item.type === 'reasoning') continue;
  }
  return { content, stop_reason: sawTool ? 'tool_use' : 'end_turn' };
}

function usageFrom(payload: Record<string, unknown>): ModelResponse['usage'] {
  const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : {};
  const details = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? usage.input_tokens_details as Record<string, unknown> : {};
  return {
    input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
    output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
    cache_read_input_tokens: typeof details.cached_tokens === 'number' ? details.cached_tokens : null,
    cache_creation_input_tokens: typeof details.cache_write_tokens === 'number' ? details.cache_write_tokens : null,
  };
}

async function fetchAzureResponses(request: ModelRequest, options: AzureResponsesOptions): Promise<Record<string, unknown>> {
  const fetcher = options.fetcher ?? fetch;
  const wait = options.wait ?? ((ms: number) => sleep(ms));
  let response: Response;
  const throttleDeadline = Date.now() + 5 * 60_000;
  for (let attempt = 0; ; attempt++) {
    response = await fetcher(`${options.baseURL}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': options.apiKey,
      },
      body: JSON.stringify({
        model: options.deployment,
        store: false,
        parallel_tool_calls: true,
        max_output_tokens: options.maxTokens,
        reasoning: { effort: options.effort },
        ...(request.system ? { instructions: request.system } : {}),
        input: toResponsesInput(request.messages),
        ...(request.tools.length ? {
          tools: toResponsesTools(request.tools),
          tool_choice: 'auto',
        } : {}),
      }),
    });
    const throttled = response.status === 429;
    if (response.ok || (!throttled && (attempt >= 3 || response.status < 500 || response.status >= 600))) break;
    const retry = response.headers.get('retry-after');
    const msHeader = response.headers.get('retry-after-ms');
    const requested = msHeader ? Number(msHeader) : retry ? (/^\d+(?:\.\d+)?$/.test(retry)
      ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
    const backoff = Math.min(30_000, 500 * 2 ** attempt);
    const retryAfter = Number.isFinite(requested) ? requested : 0;
    const delay = (throttled ? Math.max(backoff, retryAfter) : Math.min(30_000, Math.max(backoff, retryAfter))) + Math.random() * 500;
    if (throttled && Date.now() + delay >= throttleDeadline) break;
    await response.body?.cancel();
    await wait(delay);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`AZURE_RESPONSES_HTTP_${response.status}`);
  }
  const text = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`AZURE_RESPONSES_INVALID_JSON:${response.status}`);
  }
  if (payload.status === 'failed') throw new Error('AZURE_RESPONSES_FAILED:status');
  return payload;
}

export async function retryAzureOutput<T extends {
  status?: unknown; incomplete_details?: unknown; finish_reason?: unknown;
}>(maxTokens: number, load: (cap: number) => Promise<T>) {
  const truncated = (payload: T) => payload.finish_reason === 'length' ||
    (payload.status === 'incomplete' && typeof payload.incomplete_details === 'object' &&
      payload.incomplete_details !== null && 'reason' in payload.incomplete_details &&
      payload.incomplete_details.reason === 'max_output_tokens');
  const first = await load(maxTokens);
  const retryCap = Math.min(maxTokens * 2, 65536);
  const payload = truncated(first) && retryCap > maxTokens ? await load(retryCap) : first;
  return { payload, first: payload === first ? null : first,
    stop: truncated(payload) ? 'max_tokens' : payload.status === 'incomplete' ? 'incomplete' : null };
}

export function azureOutputUsage(payload: Record<string, unknown>, first: Record<string, unknown> | null) {
  const usage = usageFrom(payload);
  if (!first) return usage;
  const previous = usageFrom(first);
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    if (previous[key] != null) usage[key] = (usage[key] ?? 0) + previous[key];
  }
  return usage;
}

export async function callAzureResponses(request: ModelRequest, options: AzureResponsesOptions): Promise<ModelResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { payload, first, stop } = await retryAzureOutput(options.maxTokens,
        maxTokens => fetchAzureResponses(request, { ...options, maxTokens }));
      const usage = azureOutputUsage(payload, first);
      return stop ? { content: [], stop_reason: stop, usage } : { ...fromResponsesOutput(payload), usage };
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || error.message !== 'INVALID_FUNCTION_CALL_ARGUMENTS' || attempt > 0) throw error;
    }
  }
  throw lastError;
}

export class AzureRuntime implements AgentRuntime {
  private readonly loop: RuntimeLoop;

  constructor(deps: RuntimeDeps, options: { system?: string; maxSteps?: number; maxTokens?: number } = {}) {
    const maxTokens = options.maxTokens ?? 16384;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) throw new Error('INVALID_MAX_TOKENS');
    const config = azureConfig();
    const callModel: ModelCall = request => callAzureResponses(request, { ...config, maxTokens });
    this.loop = new RuntimeLoop(deps, callModel, {
      system: options.system,
      maxSteps: options.maxSteps,
      metadata: {
        provider: 'azure',
        model: config.deployment,
        region: 'azure-foundry',
        version: process.env.NAVA_DEPLOY_SHA ?? null,
      },
    });
  }

  startTurn(threadId: string, input: TurnInput): Promise<void> {
    return this.loop.startTurn(threadId, input);
  }

  resumeWithToolResult(sessionId: string, toolUseId: string, result: unknown): Promise<void> {
    return this.loop.resumeWithToolResult(sessionId, toolUseId, result);
  }
}
