import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export type RuntimeBlock = { type: string; [key: string]: unknown };
export interface RuntimeMessage {
  role: 'user' | 'assistant';
  content: RuntimeBlock[];
}
export interface RuntimeState {
  threadId: string;
  sessionId: string;
  messages: RuntimeMessage[];
  pendingToolUseId: string | null;
  toolOutcomes: Record<string, unknown>;
  version: number;
}
export interface TurnInput { sessionId: string; content: string }
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}
export interface RuntimeDeps {
  load(sessionId: string): Promise<RuntimeState>;
  append(sessionId: string, message: RuntimeMessage): Promise<void>;
  event(sessionId: string, kind: string, payload: unknown): Promise<void>;
  tools(sessionId: string): Promise<ToolDefinition[]>;
  runTool(sessionId: string, toolUse: ToolUse): Promise<{ kind: 'result'; result: unknown } | { kind: 'pause' }>;
  recordToolOutcome(sessionId: string, toolUseId: string, result: unknown): Promise<void>;
  assistantStopReason(sessionId: string, version: number, message: RuntimeMessage): Promise<string | null | undefined>;
  park(sessionId: string, toolUseId: string): Promise<void>;
  finish(sessionId: string, reason: string): Promise<void>;
}
export interface AgentRuntime {
  startTurn(threadId: string, input: TurnInput): Promise<void>;
  resumeWithToolResult(sessionId: string, toolUseId: string, result: unknown): Promise<void>;
}
interface ToolUse { id: string; name: string; input: unknown }
export interface ModelRequest { messages: RuntimeMessage[]; tools: ToolDefinition[]; system?: string }
export interface ModelResponse {
  content: RuntimeBlock[];
  stop_reason: string | null;
  usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
}
export type ModelCall = (request: ModelRequest) => Promise<ModelResponse>;

function toolUses(message: RuntimeMessage): ToolUse[] {
  const calls: ToolUse[] = [];
  for (const block of message.content) {
    if (block.type !== 'tool_use') continue;
    if (typeof block.id !== 'string' || typeof block.name !== 'string' || !('input' in block)) {
      throw new Error('INVALID_TOOL_USE');
    }
    if (calls.some(call => call.id === block.id)) throw new Error('DUPLICATE_TOOL_USE_ID');
    calls.push({ id: block.id, name: block.name, input: block.input });
  }
  return calls;
}

function resultContent(result: unknown): string {
  const content = JSON.stringify(result);
  if (content === undefined) throw new Error('TOOL_RESULT_NOT_JSON');
  return content;
}

function sameResult(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(resultContent(left)), JSON.parse(resultContent(right)));
}

// The caller binds each port to one live lease and a stable input delivery ID.
export class RuntimeLoop implements AgentRuntime {
  constructor(
    private readonly deps: RuntimeDeps,
    private readonly callModel: ModelCall,
    private readonly options: { system?: string; maxSteps?: number; metadata?: { provider: string; model: string; region: string; version: string | null } } = {},
  ) {
    const steps = options.maxSteps ?? 30;
    if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error('INVALID_MAX_STEPS');
  }

  async startTurn(threadId: string, input: TurnInput): Promise<void> {
    const state = await this.deps.load(input.sessionId);
    if (state.threadId !== threadId || state.sessionId !== input.sessionId) throw new Error('SESSION_MISMATCH');
    if (state.pendingToolUseId !== null) throw new Error('SESSION_WAITING_FOR_TOOL_RESULT');
    await this.deps.append(input.sessionId, { role: 'user', content: [{ type: 'text', text: input.content }] });
    await this.run(input.sessionId);
  }

  async resumeWithToolResult(sessionId: string, toolUseId: string, result: unknown): Promise<void> {
    const state = await this.depsLoad(sessionId);
    const last = state.messages.at(-1);
    if (state.pendingToolUseId === toolUseId && last?.role === 'assistant' && toolUses(last).some(call => call.id === toolUseId)) {
      resultContent(result);
      if (Object.hasOwn(state.toolOutcomes, toolUseId)) {
        if (!sameResult(state.toolOutcomes[toolUseId], result)) throw new Error('TOOL_OUTCOME_CONFLICT');
      } else {
        if (toolUses(last).some(call => call.id === toolUseId && call.name === 'hms_save')) throw new Error('SAVE_OUTCOME_NOT_DURABLE');
        await this.deps.recordToolOutcome(sessionId, toolUseId, result);
      }
      await this.run(sessionId);
      return;
    }
    if (state.pendingToolUseId === null) {
      let index = -1;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const message = state.messages[i];
        if (message.role === 'user' && message.content.some(block => {
          if (block.type !== 'tool_result' || block.tool_use_id !== toolUseId || typeof block.content !== 'string') return false;
          try { return sameResult(JSON.parse(block.content), result); } catch { return false; }
        })) {
          index = i;
          break;
        }
      }
      if (index >= 0 && state.messages.slice(index + 1).every(message => message.role === 'assistant')) {
        await this.run(sessionId);
        return;
      }
    }
    throw new Error('PENDING_TOOL_USE_MISMATCH');
  }

  private async depsLoad(sessionId: string): Promise<RuntimeState> {
    const state = await this.deps.load(sessionId);
    if (state.sessionId !== sessionId) throw new Error('SESSION_MISMATCH');
    return state;
  }

  private event(sessionId: string, kind: string, payload: Record<string, unknown>): Promise<void> {
    return this.deps.event(sessionId, kind, { ...payload, ...(this.options.metadata ? { metadata: this.options.metadata } : {}) });
  }

  private async run(sessionId: string): Promise<void> {
    let fresh: { version: number; reason: string | null } | undefined;
    let modelCalls = 0;
    for (;;) {
      const state = await this.depsLoad(sessionId);
      const last = state.messages.at(-1);
      if (!last) throw new Error('EMPTY_HISTORY');
      if (last.role === 'assistant') {
        const calls = toolUses(last);
        const reason = fresh?.version === state.version ? fresh.reason : state.pendingToolUseId !== null ? 'tool_use' : await this.deps.assistantStopReason(sessionId, state.version, last);
        if (reason === undefined) throw new Error('ASSISTANT_STOP_REASON_NOT_DURABLE');
        if (!calls.length) {
          await this.deps.finish(sessionId, reason ?? 'unknown_stop_reason');
          return;
        }
        if (reason !== 'tool_use') {
          for (const call of calls) {
            if (!Object.hasOwn(state.toolOutcomes, call.id)) {
              await this.deps.recordToolOutcome(sessionId, call.id, { ok: false, data: null, error: { code: 'MODEL_STOPPED', message: 'Tool was not executed because the model turn did not request a complete tool call.', retryable: false, outcome: 'known' } });
            }
          }
          const completed = await this.depsLoad(sessionId);
          await this.deps.append(sessionId, {
            role: 'user',
            content: calls.map(call => ({ type: 'tool_result', tool_use_id: call.id, content: resultContent(completed.toolOutcomes[call.id]) })),
          });
          await this.deps.finish(sessionId, reason ?? 'unknown_stop_reason');
          return;
        }
        if (state.pendingToolUseId !== null && !calls.some(call => call.id === state.pendingToolUseId)) throw new Error('PENDING_TOOL_USE_MISMATCH');
        const saves = calls.filter(call => call.name === 'hms_save');
        if (saves.length > 1) {
          for (const call of saves) {
            if (!Object.hasOwn(state.toolOutcomes, call.id)) {
              await this.deps.recordToolOutcome(sessionId, call.id, { ok: false, data: null, error: { code: 'MULTIPLE_SAVE_CALLS', message: 'Request one Save at a time.', retryable: false, outcome: 'known' } });
            }
          }
        }
        // Save is last: every sibling outcome is durable before it can park or dispatch.
        const ordered = [...calls.filter(call => call.name !== 'hms_save'), ...saves];
        for (const call of ordered) {
          const current = await this.depsLoad(sessionId);
          if (Object.hasOwn(current.toolOutcomes, call.id)) continue;
          if (current.pendingToolUseId !== null) return;
          const attemptId = randomUUID();
          const started = Date.now();
          await this.event(sessionId, 'tool_call', { attempt_id: attemptId, status: null, tool: call.name, tool_use_id: call.id, input: call.input });
          let outcome: Awaited<ReturnType<RuntimeDeps['runTool']>>;
          try {
            outcome = await this.deps.runTool(sessionId, call);
          } catch (error) {
            await this.event(sessionId, 'tool_call', { attempt_id: attemptId, status: 'error', tool: call.name, latency_ms: Date.now() - started });
            throw error;
          }
          if (outcome.kind === 'pause') {
            await this.deps.park(sessionId, call.id);
            await this.event(sessionId, 'tool_call', { attempt_id: attemptId, status: null, paused: true, tool: call.name, latency_ms: Date.now() - started });
            await this.event(sessionId, 'pause', { attempt_id: randomUUID(), reason: call.name, tool_use_id: call.id });
            return;
          }
          resultContent(outcome.result);
          const after = await this.depsLoad(sessionId);
          if (Object.hasOwn(after.toolOutcomes, call.id)) {
            if (!sameResult(after.toolOutcomes[call.id], outcome.result)) throw new Error('TOOL_OUTCOME_CONFLICT');
          } else {
            await this.deps.recordToolOutcome(sessionId, call.id, outcome.result);
          }
          const status = typeof outcome.result === 'object' && outcome.result !== null && 'ok' in outcome.result && outcome.result.ok === false ? 'error' : 'ok';
          await this.event(sessionId, 'tool_call', { attempt_id: attemptId, status, tool: call.name, latency_ms: Date.now() - started, result: outcome.result });
        }
        const completed = await this.depsLoad(sessionId);
        if (calls.some(call => !Object.hasOwn(completed.toolOutcomes, call.id))) return;
        await this.deps.append(sessionId, {
          role: 'user',
          content: calls.map(call => ({ type: 'tool_result', tool_use_id: call.id, content: resultContent(completed.toolOutcomes[call.id]) })),
        });
        continue;
      }
      if (state.pendingToolUseId !== null) throw new Error('PENDING_TOOL_USE_MISMATCH');
      if (modelCalls >= (this.options.maxSteps ?? 30)) {
        await this.deps.finish(sessionId, 'max_steps');
        return;
      }
      const tools = await this.deps.tools(sessionId);
      const request: ModelRequest = { messages: state.messages, tools, ...(this.options.system ? { system: this.options.system } : {}) };
      const attemptId = randomUUID();
      const started = Date.now();
      await this.event(sessionId, 'model_call', { attempt_id: attemptId, status: null, request });
      let response: ModelResponse;
      try {
        response = await this.callModel(request);
        modelCalls++;
      } catch (error) {
        await this.event(sessionId, 'model_call', { attempt_id: attemptId, status: 'error', latency_ms: Date.now() - started });
        throw error;
      }
      const assistant: RuntimeMessage = { role: 'assistant', content: response.content };
      await this.event(sessionId, 'model_call', { attempt_id: attemptId, status: 'success', latency_ms: Date.now() - started, stop_reason: response.stop_reason, assistant_version: state.version + 1, assistant, ...response.usage });
      await this.deps.append(sessionId, assistant);
      fresh = { version: state.version + 1, reason: response.stop_reason };
    }
  }
}
