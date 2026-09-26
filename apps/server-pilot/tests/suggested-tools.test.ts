import { DEFAULT_CANDIDATE_ACTIVE_TOOL_IDS } from '../src/ai/candidate-draft-agent.js';
import { classifyWorkflowMailTriage } from '../src/ai/workflows/mail-triage.js';
import { suggestReadTools } from '../src/ai/suggested-tools.js';
import { READ_TOOL_IDS } from '../src/hms/read-tools.js';
import { describe, expect, it } from 'vitest';

describe('suggestReadTools', () => {
  it('tags booking quote work with quote read only', () => {
    expect(suggestReadTools('bookings', { quote: true }, 'answer_or_quote')).toEqual([
      'hms_quote_stay',
    ]);
  });

  it('tags booking reconciliation with reservation lookup', () => {
    expect(suggestReadTools('bookings', { booking: true }, 'create_or_reconcile')).toEqual([
      'hms_find_reservation',
    ]);
  });

  it('tags groups, money, and document folders with their read tools', () => {
    expect(suggestReadTools('groups-events', {}, 'answer_or_quote')).toEqual([
      'hms_group_block_read',
      'hms_quote_stay',
    ]);
    expect(suggestReadTools('money-billing', {}, 'payment_or_finance')).toEqual([
      'hms_read_folio',
      'hms_find_reservation',
    ]);
    expect(suggestReadTools('documents-delivery', {}, 'document_or_delivery')).toEqual([
      'hms_list_documents',
    ]);
  });

  it('keeps clean and spam work untagged, while allowing explicit exceptions', () => {
    expect(suggestReadTools('automated-channel', {}, 'monitor')).toEqual([]);
    expect(suggestReadTools('unknown-review', {}, 'review_required')).toEqual([]);
    expect(suggestReadTools('internal-partner', {}, 'none')).toEqual([]);
    expect(suggestReadTools('unknown-review', { quote: true }, 'answer_or_quote')).toEqual([
      'hms_quote_stay',
    ]);
    expect(suggestReadTools('bookings', { booking: true }, 'create_or_reconcile', true)).toEqual(
      [],
    );
    expect(suggestReadTools('spam' as never, {}, 'review_required')).toEqual([]);
  });

  it('never returns write ids and does not change candidate activation defaults', () => {
    const tools = suggestReadTools(
      'bookings',
      { booking: true, quote: true },
      'create_or_reconcile',
    );

    expect(tools).toEqual(['hms_find_reservation', 'hms_quote_stay']);
    expect(tools).not.toContain('reservation_create');
    expect(
      tools.every((tool) => READ_TOOL_IDS.includes(tool as (typeof READ_TOOL_IDS)[number])),
    ).toBe(true);
    expect(DEFAULT_CANDIDATE_ACTIVE_TOOL_IDS).toEqual([
      'hms_find_reservation',
      'hms_quote_stay',
    ]);
  });

  it('applies deterministic tags after workflow refine', async () => {
    const classification = await classifyWorkflowMailTriage(
      {
        transportId: 'transport-test',
        threadId: 'thread-test',
        triggerMessageId: 'message-test',
        from: 'guest@example.test',
        subject: 'Quote request',
        body: 'Please send a quote for one stay.',
        messages: [
          {
            id: 'message-test',
            from: 'guest@example.test',
            subject: 'Quote request',
            body: 'Please send a quote for one stay.',
            direction: 'inbound',
            createdAt: new Date('2026-09-01T12:00:00.000Z'),
            receivedAt: null,
            sentAt: null,
            to: [],
            cc: [],
            bcc: [],
          },
        ],
        asOf: '2026-09-01T12:00:00.000Z',
        modelId: 'model-test',
        promptVersion: 'triage-v6',
      },
      {
        invoke: async () => ({
          modelId: 'model-test',
          output: {
            primaryFolder: 'bookings',
            priority: 'P3',
            urgent: false,
            overlays: { quote: true },
            isSpam: false,
            suggestedTools: [],
            sourceScope: 'external',
            automationState: 'candidate',
            humanAction: 'answer_or_quote',
            confidence: 0.9,
            rationale: 'quote request',
            policyFlags: [],
            abstainReason: null,
          },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            latencyMs: 0,
            estimatedCostUsd: 0,
            rateTableVersion: 'test',
          },
        }),
      },
    );

    expect(classification.output.suggestedTools).toEqual(['hms_quote_stay']);
  });
});
