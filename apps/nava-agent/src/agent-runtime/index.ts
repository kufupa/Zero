import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { RuntimeLoop } from './loop.js';
import type { AgentRuntime, ModelCall, RuntimeBlock, RuntimeDeps, TurnInput } from './loop.js';

export type { AgentRuntime, RuntimeBlock, RuntimeDeps, RuntimeMessage, RuntimeState, ToolDefinition, TurnInput } from './loop.js';
export { AzureRuntime } from './azure.js';

const REGION = 'eu-west-1';
const MODEL = 'global.anthropic.claude-haiku-5-5';
const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';
const thinking = { type: 'adaptive' as const, block_binding: { prefix_mismatch_behavior: 'drop_block' as const } };

function strictCompatible(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const schema = Object.fromEntries(Object.entries(value));
  if (schema.type === undefined && schema.anyOf === undefined && schema.allOf === undefined && schema.enum === undefined && schema.const === undefined) return false;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return false;
  if ((schema.type === 'object' || Array.isArray(schema.type) && schema.type.includes('object') || schema.properties !== undefined) && schema.additionalProperties !== false) return false;
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minProperties', 'maxProperties', 'maxItems', 'uniqueItems', 'pattern', '$ref', '$defs', 'definitions', 'patternProperties', 'oneOf', 'not', 'if', 'then', 'else']) {
    if (Object.hasOwn(schema, key)) return false;
  }
  if (schema.minItems !== undefined && schema.minItems !== 0 && schema.minItems !== 1) return false;
  if (Array.isArray(schema.enum) && schema.enum.some(item => typeof item === 'object' && item !== null)) return false;
  if (schema.format !== undefined && !['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid'].includes(String(schema.format))) return false;
  if (schema.properties !== undefined) {
    if (typeof schema.properties !== 'object' || schema.properties === null || Array.isArray(schema.properties)) return false;
    if (!Object.values(schema.properties).every(strictCompatible)) return false;
  }
  if (schema.items !== undefined && !strictCompatible(schema.items)) return false;
  for (const key of ['anyOf', 'allOf']) {
    if (schema[key] !== undefined && (!Array.isArray(schema[key]) || !schema[key].every(strictCompatible))) return false;
  }
  return true;
}

function checkNoCache(blocks: RuntimeBlock[]): void {
  for (const block of blocks) {
    if (Object.hasOwn(block, 'cache_control')) throw new Error('PROMPT_CACHE_DISABLED');
    if (Array.isArray(block.content)) {
      for (const nested of block.content) {
        if (typeof nested === 'object' && nested !== null && Object.hasOwn(nested, 'cache_control')) throw new Error('PROMPT_CACHE_DISABLED');
      }
    }
  }
}

export class BedrockRuntime implements AgentRuntime {
  private readonly loop: RuntimeLoop;

  constructor(deps: RuntimeDeps, options: { system?: string; maxSteps?: number; maxTokens?: number } = {}) {
    const maxTokens = options.maxTokens ?? 16384;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) throw new Error('INVALID_MAX_TOKENS');
    const client = new AnthropicBedrock({
      awsRegion: REGION,
      baseURL: `https://bedrock-runtime.${REGION}.amazonaws.com`,
      apiKey: null,
      maxRetries: 0,
    });
    const callModel: ModelCall = async request => {
      for (const message of request.messages) checkNoCache(message.content);
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        thinking,
        messages: request.messages.map(({ role, content }) => ({ role, content })) as unknown as MessageParam[],
        ...(request.system ? { system: [{ type: 'text' as const, text: request.system, cache_control: { type: 'ephemeral' as const } }] } : {}),
        ...(request.tools.length ? {
          tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema, ...(strictCompatible(tool.input_schema) ? { strict: true } : {}) })),
          tool_choice: { type: 'auto' as const, disable_parallel_tool_use: true },
        } : {}),
      }, { headers: { 'anthropic-beta': THINKING_BINDING_BETA } });
      return {
        content: response.content as unknown as RuntimeBlock[],
        stop_reason: response.stop_reason,
        usage: response.usage,
      };
    };
    this.loop = new RuntimeLoop(deps, callModel, {
      system: options.system,
      maxSteps: options.maxSteps,
      metadata: { provider: 'bedrock', model: MODEL, region: REGION, version: process.env.NAVA_DEPLOY_SHA ?? null },
    });
  }

  startTurn(threadId: string, input: TurnInput): Promise<void> {
    return this.loop.startTurn(threadId, input);
  }

  resumeWithToolResult(sessionId: string, toolUseId: string, result: unknown): Promise<void> {
    return this.loop.resumeWithToolResult(sessionId, toolUseId, result);
  }
}
