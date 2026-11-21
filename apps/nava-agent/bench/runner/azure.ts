import {setTimeout as sleep} from 'node:timers/promises';
import type {ModelCall, RuntimeBlock} from '../../src/agent-runtime/loop.js';

export function azureReplayModel(model: string, effort: string, options: {fetcher?: typeof fetch; wait?: typeof sleep} = {}): ModelCall {
  const base = (process.env.AZURE_OPENAI_BASE_URL ?? 'https://nava.openai.azure.com/openai/v1').replace(/\/$/, '');
  const key = process.env.AZURE_FOUNDRY_API_KEY ?? process.env.AZURE_OPENAI_API_KEY;
  if (!key) throw new Error('AZURE_FOUNDRY_API_KEY_REQUIRED');
  if (!['low', 'medium', 'high', 'max'].includes(effort)) throw new Error('INVALID_REASONING_EFFORT');
  const fetcher = options.fetcher ?? fetch;
  const wait = options.wait ?? sleep;
  return async request => {
    const input = request.messages.flatMap(message => message.content.flatMap((block): object[] => {
      if (block.type === 'text') return [{role: message.role, content: block.text}];
      if (block.type === 'tool_use') return [{type: 'function_call', call_id: block.id, name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {})}];
      if (block.type === 'tool_result') return [{type: 'function_call_output', call_id: block.tool_use_id, output: block.content}];
      return [];
    }));
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await fetcher(`${base}/responses`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'api-key': key},
        body: JSON.stringify({
          model, store: false, parallel_tool_calls: false, max_output_tokens: 16384, reasoning: {effort},
          instructions: request.system, input,
          ...(request.tools.length ? {tool_choice: 'auto', tools: request.tools.map(tool => ({
            type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema, strict: false,
          }))} : {}),
        }),
      });
      if (response.ok || attempt === 3 || (response.status !== 429 && (response.status < 500 || response.status >= 600))) break;
      const retry = response.headers.get('retry-after');
      const msHeader = response.headers.get('retry-after-ms');
      const requested = msHeader ? Number(msHeader) : retry ? (/^\d+(?:\.\d+)?$/.test(retry)
        ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
      await response.body?.cancel();
      await wait(Math.min(30_000, Math.max(Number.isFinite(requested) ? requested : 0, 500 * 2 ** attempt)) + Math.random() * 500);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`AZURE_RESPONSES_HTTP_${response.status}`);
    }
    const payload: {
      status?: string; incomplete_details?: {reason?: string};
      output?: Array<{type: string; call_id?: string; name?: string; arguments?: string; content?: Array<{type: string; text?: string}>}>;
      usage?: {input_tokens?: number; output_tokens?: number; input_tokens_details?: {cached_tokens?: number}};
    } = await response.json();
    if (payload.status === 'failed') throw new Error('AZURE_RESPONSES_FAILED');
    const content: RuntimeBlock[] = [];
    for (const item of payload.output ?? []) {
      if (item.type === 'function_call') {
        if (!item.call_id || !item.name || typeof item.arguments !== 'string') throw new Error('INVALID_FUNCTION_CALL');
        content.push({type: 'tool_use', id: item.call_id, name: item.name, input: JSON.parse(item.arguments || '{}')});
      }
      if (item.type === 'message') for (const part of item.content ?? []) {
        if (part.type === 'output_text' && typeof part.text === 'string') content.push({type: 'text', text: part.text});
      }
    }
    return {
      content,
      stop_reason: payload.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens'
        : content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: {
        input_tokens: payload.usage?.input_tokens,
        output_tokens: payload.usage?.output_tokens,
        cache_read_input_tokens: payload.usage?.input_tokens_details?.cached_tokens ?? null,
      },
    };
  };
}
