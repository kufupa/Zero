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

  it('keeps unsupported action and date claims outside the closed-world evidence set', () => {
    const cases = [
      'Your booking has been secured.',
      'Your reservation is approved.',
      'We have processed your cancellation.',
    ];
    for (const replyText of cases) {
      const assessment = assessReply({ replyText, asks: [], facts: [] });
      expect(assessment.ok, replyText).toBe(false);
      expect(
        assessment.issues.map((issue) => issue.code),
        replyText,
      ).toContain('UNSUPPORTED_ACTION_CLAIM');
    }

    const dateAssessment = assessReply({
      replyText: 'Your stay is on 2027-12-31 at 14:00.',
      asks: [],
      facts: [],
    });
    expect(dateAssessment.ok).toBe(false);
    expect(dateAssessment.issues.map((issue) => issue.code)).toContain('UNSUPPORTED_DATE_CLAIM');
  });

  it('does not let unrelated or nested identity values answer reservation status', () => {
    const unrelated = assessReply({
      replyText: 'Your booking is confirmed.',
      asks: [],
      facts: [
        {
          key: 'reservation.guestName',
          label: 'guest name',
          value: 'Alice',
          source: 'hms',
          authority: 'authorized',
          status: 'known',
        },
      ],
    });
    expect(unrelated.ok).toBe(false);
    expect(unrelated.issues.map((issue) => issue.code)).toContain('UNSUPPORTED_ACTION_CLAIM');

    const nested = assessReply({
      replyText: 'Reservation for Alice.',
      asks: [{ code: 'reservation_status', label: 'reservation status', required: true }],
      facts: [
        {
          key: 'reservation.summary',
          label: 'reservation summary',
          value: { guestName: 'Alice', reservationStatus: 'Pending' },
          source: 'hms',
          authority: 'authorized',
          status: 'known',
        },
      ],
    });
    expect(nested.coverage).toEqual({ answered: 0, total: 1 });
    expect(nested.issues.map((issue) => issue.code)).toContain('MISSING_BRACKET');
  });

  it('does not complete a normal prepared reply when no task or evidence is identified', async () => {
    const prepared = prepareDraftInput({
      requestId: 'request-u5-no-task',
      audience: 'guest',
      requestText: 'Please help.',
    });
    for (const replyText of [
      'Thanks for your email.',
      'We will look into this.',
      'I cannot confirm this yet.',
    ]) {
      const adapter = createLocalModelAdapter({
        route: localRoute,
        transport: async () => ({
          output: JSON.stringify({ replyText }),
          usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 },
        }),
      });
      const result = await runPreparedReplyWorkflow({
        prepared,
        requestKind: 'general',
        adapter,
      });
      expect(result.outcome, replyText).not.toBe('complete');
    }
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
