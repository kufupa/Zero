import { describe, expect, it, vi } from 'vitest';
import type { ModelAdapter, ModelInvokeInput, ModelInvokeResult } from '../src/ai/bedrock/adapter.js';
import { classifyWorkflowMailTriage } from '../src/ai/workflows/mail-triage.js';

describe('triage model-call budget', () => {
  it('bounds the Luna max call and forwards workflow cancellation', async () => {
    const calls: ModelInvokeInput[] = [];
    const adapter: ModelAdapter = {
      invoke: async (input) => {
        calls.push(input);
        return {
          modelId: input.modelId,
          output: {
            primaryFolder: 'bookings',
            priority: 'P3',
            urgent: false,
            overlays: { booking: true },
            isSpam: false,
            suggestedTools: [],
            sourceScope: 'external',
            automationState: 'candidate',
            humanAction: 'answer_or_quote',
            confidence: 0.8,
            rationale: 'classification',
            policyFlags: [],
            abstainReason: null,
          },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            latencyMs: 1,
            estimatedCostUsd: 0,
            rateTableVersion: 'test',
          },
        } satisfies ModelInvokeResult;
      },
    };
    const signal = new AbortController().signal;
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    try {
      await classifyWorkflowMailTriage(
        {
          transportId: 'transport-test',
          threadId: 'thread-test',
          triggerMessageId: 'message-test',
          messages: [
            {
              id: 'message-test',
              from: 'sender@example.test',
              subject: 'Subject',
              body: 'Synthetic test input.',
              direction: 'inbound',
              createdAt: new Date('2026-10-01T10:00:00.000Z'),
              receivedAt: new Date('2026-10-01T10:00:00.000Z'),
              sentAt: null,
            },
          ],
          asOf: '2026-10-01T12:00:00.000Z',
          modelId: 'global.openai.gpt-6-luna',
          promptVersion: 'triage-v6',
        },
        adapter,
        undefined,
        { signal },
      );
    } finally {
      vi.restoreAllMocks();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxOutputTokens).toBe(48_000);
    expect(calls[0]?.deadlineAt).toBe(1_180_000);
    expect(calls[0]?.signal).toBe(signal);
  });
});
