import { strictCompatible } from './strict-schema.js';
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
