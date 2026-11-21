import { strictCompatible } from './strict-schema.js';
import { RuntimeLoop } from './loop.js';
import type { AgentRuntime, ModelCall, ModelRequest, ModelResponse, RuntimeBlock, RuntimeDeps, RuntimeMessage, ToolDefinition, TurnInput } from './loop.js';

export type { AgentRuntime, RuntimeDeps, TurnInput } from './loop.js';

const DEFAULT_BASE_URL = 'https://nava.openai.azure.com/openai/v1';
const DEFAULT_DEPLOYMENT = 'gpt-6-luna';
const DEFAULT_REASONING = 'low';

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
  status?: string;
  incomplete_details?: { reason?: string } | null;
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
  if (payload.status === 'incomplete' && payload.incomplete_details?.reason === 'max_output_tokens') {
    return { content, stop_reason: 'max_tokens' };
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

export async function callAzureResponses(request: ModelRequest, options: {
  baseURL: string;
  apiKey: string;
  deployment: string;
  effort: string;
  maxTokens: number;
}): Promise<ModelResponse> {
  const response = await fetch(`${options.baseURL}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': options.apiKey,
    },
    body: JSON.stringify({
      model: options.deployment,
      store: false,
      parallel_tool_calls: false,
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
  const text = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`AZURE_RESPONSES_INVALID_JSON:${response.status}`);
  }
  if (!response.ok) {
    const code = typeof payload.error === 'object' && payload.error && typeof (payload.error as { code?: unknown }).code === 'string'
      ? (payload.error as { code: string }).code
      : `HTTP_${response.status}`;
    throw new Error(`AZURE_RESPONSES_FAILED:${code}`);
  }
  if (payload.status === 'failed') throw new Error('AZURE_RESPONSES_FAILED:status');
  const converted = fromResponsesOutput(payload);
  return { ...converted, usage: usageFrom(payload) };
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
