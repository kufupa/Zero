import { PREPARED_DRAFT_INPUT_VERSION, prepareDraftInput } from '../src/ai/prepared-draft-input.js';
import { createLocalModelAdapter, type LocalModelRouteEvidence } from '../src/ai/bedrock/local.js';
import { runPreparedReplyWorkflow } from '../src/ai/workflows/candidate-draft.js';
import { assessReply } from '../src/ai/reply-assessment.js';
import { describe, expect, it } from 'vitest';

const localRoute: LocalModelRouteEvidence = {
  routeId: 'u5-workflow-test-route',
  purpose: 'draft',
  protocol: 'in_process',
  access: 'current_app',
  egress: 'none',
  retention: 'bounded',
  usage: 'reported',
  modelId: 'u5-workflow-test-model',
};

describe('reply assessment', () => {
  it('rejects a receipt as funds-cleared evidence', () => {
    const assessment = assessReply({
      replyText: 'We have received and cleared your payment.',
      asks: [{ code: 'payment_status', label: 'payment status', required: true }],
      facts: [
        {
          key: 'payment.receipt',
          label: 'payment receipt',
          value: { fundsCleared: false, amount: '1000.00', currency: 'ZAR' },
          source: 'mail',
          authority: 'authorized',
          status: 'known',
        },
      ],
    });

    expect(assessment.ok).toBe(false);
    expect(assessment.issues.map((issue) => issue.code)).toContain('NEGATION_MISMATCH');
  });

  it('rejects amount or currency mismatch and missing price coverage', () => {
    const assessment = assessReply({
      replyText: 'The total is USD 2,000.',
      asks: [{ code: 'price', label: 'price', required: true }],
      facts: [
        {
          key: 'price.total',
          label: 'total price',
          value: null,
          source: 'hms',
          authority: 'unknown',
          status: 'unknown',
        },
      ],
    });

    expect(assessment.ok).toBe(false);
    expect(assessment.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['MISSING_BRACKET', 'AMOUNT_OR_CURRENCY_MISMATCH']),
    );
  });

  it('allows a supported partial reply with an explicit limitation', () => {
    const assessment = assessReply({
      replyText: 'Your reservation is confirmed. [MISSING: price | how: hms_quote_stay]',
      asks: [
        { code: 'reservation_status', label: 'reservation status', required: true },
        { code: 'price', label: 'price', required: true },
      ],
      facts: [
        {
          key: 'reservation.status',
          label: 'reservation status',
          value: 'Confirmed',
          source: 'hms',
          authority: 'authorized',
          status: 'known',
        },
      ],
    });

    expect(assessment.ok).toBe(true);
    expect(assessment.coverage).toMatchObject({ answered: 1, total: 2 });
  });

  it('does not count a fact as an answered ask when the reply is only an acknowledgement', () => {
    const assessment = assessReply({
      replyText: 'Thanks, we will review this shortly.',
      asks: [{ code: 'reservation_status', label: 'reservation status', required: true }],
      facts: [
        {
          key: 'reservation.status',
          label: 'reservation status',
          value: 'Confirmed',
          source: 'hms',
          authority: 'authorized',
          status: 'known',
        },
      ],
    });

    expect(assessment.coverage).toMatchObject({ answered: 0, total: 1 });
    expect(assessment.issues.map((issue) => issue.code)).toContain('MISSING_BRACKET');
  });

  it('rejects booking and payment completion claims without supporting evidence', () => {
    const assessment = assessReply({
      replyText: 'Your booking is confirmed and payment is cleared.',
      asks: [],
      facts: [],
    });

    expect(assessment.ok).toBe(false);
    expect(assessment.issues.map((issue) => issue.code)).toContain('UNSUPPORTED_ACTION_CLAIM');
  });

  it('rejects an attachment claim without selected authorized bytes', () => {
    const assessment = assessReply({
      replyText: 'The invoice is attached for your records.',
      asks: [{ code: 'document', label: 'document', required: true }],
      facts: [
        {
          key: 'document.metadata',
          label: 'document metadata',
          value: { status: 'available' },
          source: 'attachment',
          authority: 'authorized',
          status: 'known',
        },
      ],
    });

    expect(assessment.ok).toBe(false);
    expect(assessment.issues.map((issue) => issue.code)).toContain('UNSUPPORTED_ATTACHMENT_CLAIM');
  });

  it('rejects a bank recipient claim when only inbound mail supports it', () => {
    const assessment = assessReply({
      replyText: 'Please pay the bank recipient listed below.',
      asks: [],
      facts: [
        {
          key: 'bank.recipient',
          label: 'bank recipient',
          value: 'untrusted-account',
          source: 'mail',
          authority: 'authorized',
          status: 'known',
        },
      ],
    });

    expect(assessment.ok).toBe(false);
    expect(assessment.issues.map((issue) => issue.code)).toContain('UNSUPPORTED_RECIPIENT_CLAIM');
  });

  it('passes prepared input through the normal workflow before adapter and assessment', async () => {
    const prepared = prepareDraftInput({
      requestId: 'request-u5-normal-path',
      threadId: 'thread-u5-normal-path',
      audience: 'guest',
      requestText: 'Please confirm my reservation status.',
      asks: [{ code: 'reservation_status', label: 'reservation status', required: true }],
      facts: [
        {
          key: 'reservation.status',
          label: 'Reservation status',
          value: 'Confirmed',
          source: 'hms',
          authority: 'authorized',
          status: 'known',
        },
      ],
    });
    const prompts: string[] = [];
    const adapter = createLocalModelAdapter({
      route: localRoute,
      transport: async ({ userPrompt }) => {
        prompts.push(userPrompt);
        return {
          output: JSON.stringify({ replyText: 'Your reservation is confirmed.' }),
          usage: { inputTokens: 12, outputTokens: 6, latencyMs: 2 },
        };
      },
    });

    const result = await runPreparedReplyWorkflow({
      prepared,
      requestKind: 'reservation',
      adapter,
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(PREPARED_DRAFT_INPUT_VERSION);
    expect(prompts[0]).toContain('request-u5-normal-path');
    expect(result.outcome).toBe('complete');
    expect(result.textBody).toBe('Your reservation is confirmed.');
    expect(result.assessment.ok).toBe(true);
    expect(result.metrics).toMatchObject({
      routeId: localRoute.routeId,
      usageSource: 'reported',
    });
  });
});
