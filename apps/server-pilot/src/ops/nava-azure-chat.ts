import type { NavaDashboard } from './nava-fte-dashboard.js';
import { buildNavaLiveContext } from './nava-live-context.js';

export type NavaChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type NavaAzureChatConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
};

export type NavaAzureChatResult = {
  ok: boolean;
  text: string;
  error?: string;
};

export const NAVA_AZURE_DEFAULT_BASE =
  'https://nava.services.ai.azure.com/openai/v1';
export const NAVA_AZURE_DEFAULT_MODEL = 'gpt-5.6-luna';


export function buildAzureChatMessages(
  dashboard: NavaDashboard,
  history: readonly { role: 'user' | 'assistant'; content: string }[],
): NavaChatMessage[] {
  return [
    { role: 'system', content: buildNavaLiveContext(dashboard) },
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
  ];
}

function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`;
}

/** Non-stream ask (tests / smoke). */
export async function askNavaAzure(opts: {
  config: NavaAzureChatConfig;
  messages: readonly NavaChatMessage[];
  fetchImpl?: typeof fetch;
}): Promise<NavaAzureChatResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.config.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(chatCompletionsUrl(opts.config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': opts.config.apiKey,
        Authorization: `Bearer ${opts.config.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.config.model,
        messages: opts.messages,
        max_completion_tokens: 800,
        stream: false,
      }),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      return { ok: false, text: '', error: `azure ${String(res.status)}: ${raw.slice(0, 240)}` };
    }
    const data = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    return text
      ? { ok: true, text }
      : { ok: false, text: '', error: 'azure empty reply' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, text: '', error: message };
  } finally {
    clearTimeout(timer);
  }
}

/** Stream deltas via onDelta; returns final text. */
export async function streamNavaAzure(opts: {
  config: NavaAzureChatConfig;
  messages: readonly NavaChatMessage[];
  onDelta?: (fullText: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<NavaAzureChatResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.config.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(chatCompletionsUrl(opts.config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': opts.config.apiKey,
        Authorization: `Bearer ${opts.config.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.config.model,
        messages: opts.messages,
        max_completion_tokens: 800,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const raw = await res.text();
      return { ok: false, text: '', error: `azure ${String(res.status)}: ${raw.slice(0, 240)}` };
    }
    if (!res.body) {
      return { ok: false, text: '', error: 'azure missing body' };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const piece = chunk.choices?.[0]?.delta?.content;
          if (piece) {
            full += piece;
            opts.onDelta?.(full);
          }
        } catch {
          // ignore malformed SSE lines
        }
      }
    }
    const text = full.trim();
    return text
      ? { ok: true, text }
      : { ok: false, text: '', error: 'azure empty stream' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, text: '', error: message };
  } finally {
    clearTimeout(timer);
  }
}
