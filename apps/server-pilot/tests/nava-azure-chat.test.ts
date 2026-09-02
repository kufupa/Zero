import { describe, expect, it, vi } from 'vitest';
import { buildDashboard } from '../src/ops/nava-fte-dashboard';
import {
  askNavaAzure,
  buildAzureChatMessages,
  streamNavaAzure,
} from '../src/ops/nava-azure-chat';
import { navaLiveGreeting } from '../src/ops/nava-live-context';
import { NAVA_HOURS_CAVEAT, type NavaHoursStats } from '../src/ops/nava-fte-hours';

const hours: NavaHoursStats = {
  asOf: '2026-08-25T22:24:55.657Z',
  threadCount: 2403,
  threadsWithOutbound: 301,
  inboundOnlyThreads: 2102,
  nEligibleFirstResponse: 77,
  medianFirstResponseMinutes: 42,
  p90FirstResponseMinutes: 180,
  droppedNegativeOrMissing: 3,
  caveat: NAVA_HOURS_CAVEAT,
};

describe('nava-azure-chat', () => {
  it('builds system + history messages', () => {
    const messages = buildAzureChatMessages(buildDashboard(hours), [
      { role: 'user', content: 'What first?' },
    ]);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('You are Nava');
    expect(messages[1]).toEqual({ role: 'user', content: 'What first?' });
    expect(navaLiveGreeting()).toContain('NAVA_LIVE_OK');
    expect(navaLiveGreeting()).not.toMatch(/investor/i);
  });

  it('askNavaAzure parses non-stream reply', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Build read-only triage first.' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const result = await askNavaAzure({
      config: {
        baseUrl: 'https://example.test/openai/v1',
        apiKey: 'test-key',
        model: 'gpt-5.6-luna',
      },
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Build read-only triage first.');
  });

  it('streamNavaAzure accumulates SSE deltas', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const fetchImpl = vi.fn(async () =>
      new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    const deltas: string[] = [];
    const result = await streamNavaAzure({
      config: {
        baseUrl: 'https://example.test/openai/v1',
        apiKey: 'test-key',
        model: 'gpt-5.6-luna',
      },
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (text) => deltas.push(text),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Hello world');
    expect(deltas.at(-1)).toBe('Hello world');
  });
});
