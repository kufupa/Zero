import { CHANNEL_BOOKING_OUTPUT, fakeModel, selectionFor } from './fixtures/inbound-extraction.js';
import { isSelfSentPreStayInformationMail } from '../src/ai/existing-stay-information.js';
import { classifyWorkflowMailTriage } from '../src/ai/workflows/mail-triage.js';
import { extractInboundMail } from '../src/ai/extraction/extract.js';
import type { ModelAdapter } from '../src/ai/bedrock/adapter.js';
import { describe, expect, it, vi } from 'vitest';

describe('self-sent pre-stay information', () => {
  const mailboxAddress = 'hotel@example.invalid';
  const subject = 'Pre Stay: Property HRCEN Confirmation No 57291630 Guest';

  it('matches self-sent pre-stay mail with a confirmation in the subject', () => {
    expect(
      isSelfSentPreStayInformationMail({
        fromAddress: `Reservations <${mailboxAddress}>`,
        mailboxAddress,
        subject,
      }),
    ).toBe(true);
  });

  it('does not match an external sender with the same subject', () => {
    expect(
      isSelfSentPreStayInformationMail({
        fromAddress: 'guest@example.invalid',
        mailboxAddress,
        subject,
      }),
    ).toBe(false);
  });

  it('does not match self-sent mail without a pre-stay subject', () => {
    expect(
      isSelfSentPreStayInformationMail({
        fromAddress: mailboxAddress,
        mailboxAddress,
        subject: 'Confirmation No 57291630 guest arrival details',
      }),
    ).toBe(false);
  });

  it('does not match pre-stay mail without a confirmation number', () => {
    expect(
      isSelfSentPreStayInformationMail({
        fromAddress: mailboxAddress,
        mailboxAddress,
        subject: 'Pre-arrival details for guest',
      }),
    ).toBe(false);
  });

  it('uses an extracted confirmation number to override a model booking kind', async () => {
    const confirmationNumber = '57291630-1';
    const model = fakeModel(() => ({
      ...CHANNEL_BOOKING_OUTPUT,
      confirmationNumbers: [confirmationNumber],
    }));
    const result = await extractInboundMail({
      adapter: model.adapter,
      selection: selectionFor(
        `Arrival details for existing stay ${confirmationNumber}.`,
        'Pre-arrival guest details',
      ),
      messageId: 'prestay-extraction',
      from: `Reservations <${mailboxAddress}>`,
      mailbox: mailboxAddress,
    });

    expect(result).toMatchObject({
      ok: true,
      kind: 'other',
      payload: { confirmationNumbers: [confirmationNumber] },
    });
  });

  it('keeps self-sent pre-stay triage out of booking and quote work', async () => {
    const adapter: ModelAdapter = {
      invoke: vi.fn(async () => ({
        modelId: 'test-model',
        output: {
          primaryFolder: 'bookings',
          priority: 'P3',
          urgent: false,
          overlays: { booking: true, quote: true },
          isSpam: false,
          suggestedTools: [],
          sourceScope: 'internal_property',
          automationState: 'excluded_internal',
          humanAction: 'create_or_reconcile',
          confidence: 0.9,
          rationale: 'Model candidate for regression test.',
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
      })),
    };
    const messageId = 'prestay-triage';
    const result = await classifyWorkflowMailTriage(
      {
        transportId: 'transport-test',
        threadId: 'thread-prestay-triage',
        triggerMessageId: messageId,
        mailboxAddress,
        confirmationNumbers: ['57291630-1'],
        messages: [
          {
            id: messageId,
            from: mailboxAddress,
            subject: 'Pre Stay: Property HRCEN arrival details',
            body: 'Existing reservation arrival details.',
            direction: 'inbound',
            createdAt: new Date('2026-10-14T10:00:00.000Z'),
            receivedAt: null,
            sentAt: null,
          },
        ],
        asOf: '2026-10-14T10:00:00.000Z',
        modelId: 'test-model',
        promptVersion: 'triage-v6',
      },
      adapter,
    );

    expect(result.output).toMatchObject({
      primaryFolder: 'internal-partner',
      overlays: {},
      humanAction: 'none',
      sourceScope: 'internal_property',
      automationState: 'excluded_internal',
    });
    expect(result.output.primaryFolder).not.toBe('bookings');
    expect(result.output.overlays).not.toHaveProperty('booking', true);
    expect(result.output.overlays).not.toHaveProperty('quote', true);
  });
});
