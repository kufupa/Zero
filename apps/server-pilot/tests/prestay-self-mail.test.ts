import { CHANNEL_BOOKING_OUTPUT, fakeModel, selectionFor } from './fixtures/inbound-extraction.js';
import { groundedSeparateAsk, isSelfSentPreStayInformationMail, preStaySourceText } from '../src/ai/existing-stay-information.js';
import { admissionMailSource } from '../src/mail/ingest/live-admission.js';
import { classifyMailSource } from '../src/ai/mail-source.js';
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

  it('admits confirmed self-sent pre-stay mail for extraction even when it quotes a channel', () => {
    const fromAddress = 'reservations@legacyhotels.co.za';
    const source = classifyMailSource({
      fromAddress,
      subject,
      bodyText: 'Please book another room.\nFrom: Booking.com <noreply@messages.booking.com>\nSubject: Booking confirmation',
    });
    expect(source.kind).toBe('channel');
    expect(admissionMailSource(source, { fromAddress, subject, mailboxAddress: fromAddress })).toEqual({
      kind: 'direct', source: null, reason: 'self_sent_pre_stay_candidate',
    });
    expect(admissionMailSource(source, { fromAddress, subject, mailboxAddress: 'other@example.invalid' })).toEqual(source);
    expect(admissionMailSource(source, { fromAddress, subject: 'Booking confirmation', mailboxAddress: fromAddress })).toEqual(source);
  });

  it('admits a self-sent pre-arrival candidate whose confirmation is only in the body', () => {
    const fromAddress = 'reservations@legacyhotels.co.za';
    const subject = 'Pre-arrival guest details';
    const source = classifyMailSource({ fromAddress, subject,
      bodyText: 'Confirmation No 57291630-1. Please send the menu.\nFrom: Booking.com <noreply@messages.booking.com>' });
    expect(source.kind).toBe('channel');
    expect(admissionMailSource(source, { fromAddress, subject, mailboxAddress: fromAddress })).toEqual({
      kind: 'direct', source: null, reason: 'self_sent_pre_stay_candidate',
    });
  });

  it('keeps current HTML after a quoted block while excluding nested Gmail history', () => {
    const current = 'Please send the catering menu.';
    const old = 'Please book the old room.';
    const html = `<p>Arrival details.</p><blockquote><div class="gmail_quote">${old}</div></blockquote><p>${current}</p>`;
    expect(preStaySourceText(null, html)).toContain(current);
    expect(preStaySourceText(null, html)).not.toContain(old);
    expect(groundedSeparateAsk(html, current)).toBe(current);
    expect(groundedSeparateAsk(html, old)).toBeNull();
    const gmail = `<div class="gmail_quote"><p>${old}</p></div><p>${current}</p>`;
    expect(groundedSeparateAsk(gmail, old)).toBeNull();
    expect(groundedSeparateAsk(gmail, current)).toBe(current);
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
      kind: 'other', action: 'no_action', needsAction: false,
      payload: { confirmationNumbers: [confirmationNumber], action: 'no_action' },
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

  it.each(['hotel@example.invalid', 'other-property@example.invalid'])(
    'retains a separately requested non-stay task for mailbox %s',
    async (mailbox) => {
      const ask = 'Please send the conference catering menu.';
      const model = fakeModel(() => ({
        ...CHANNEL_BOOKING_OUTPUT,
        needsAction: true,
        action: 'group_event',
        actionEvidence: ask,
        separateAsk: ask,
        confirmationNumbers: ['57291630-1'],
      }));
      const result = await extractInboundMail({
        adapter: model.adapter,
        selection: selectionFor(`Arrival details for 57291630-1. ${ask}`, subject),
        messageId: 'mixed-prestay', from: mailbox, mailbox,
      });
      expect(result).toMatchObject({
        ok: true, kind: 'other', action: 'group_event',
        payload: { separateAsk: ask },
      });
    },
  );

  it('does not retain an ungrounded model claim as a separate ask', async () => {
    const result = await extractInboundMail({
      adapter: fakeModel(() => ({ ...CHANNEL_BOOKING_OUTPUT, action: 'other_actionable', needsAction: true,
        separateAsk: 'Please send a menu that is not in the email.', confirmationNumbers: ['57291630-1'] })).adapter,
      selection: selectionFor('Arrival details for 57291630-1.', subject),
      messageId: 'unsafe-prestay', from: mailboxAddress, mailbox: mailboxAddress,
    });
    expect(result).toMatchObject({ ok: true, kind: 'other', needsAction: false, action: 'no_action' });
    if (result.ok) expect(result.payload.separateAsk).toBeUndefined();
  });

  it('keeps a short but grounded separate request', async () => {
    const ask = 'Call me';
    const result = await extractInboundMail({
      adapter: fakeModel(() => ({ ...CHANNEL_BOOKING_OUTPUT, action: 'other_actionable', needsAction: true,
        separateAsk: ask, confirmationNumbers: ['57291630-1'] })).adapter,
      selection: selectionFor(`Arrival details for 57291630-1. ${ask}`, subject),
      messageId: 'short-prestay', from: mailboxAddress, mailbox: mailboxAddress,
    });
    expect(result).toMatchObject({ ok: true, kind: 'other', payload: { separateAsk: ask } });
  });

  it('extracts and grounds a current ask in HTML-only self-mail without quoted history', async () => {
    const ask = 'Please book a separate room for another guest.';
    const oldAsk = 'Please book the old room.';
    const html = `<div>Arrival details for 57291630-1.</div><p>${ask}</p><blockquote><p>${oldAsk}</p></blockquote>`;
    const text = preStaySourceText(null, html);
    expect(groundedSeparateAsk(html, ask)).toBe(ask);
    expect(groundedSeparateAsk(html, oldAsk)).toBeNull();
    const result = await extractInboundMail({
      adapter: fakeModel(() => ({ ...CHANNEL_BOOKING_OUTPUT, action: 'new_booking', needsAction: true,
        separateAsk: ask, confirmationNumbers: ['57291630-1'] })).adapter,
      selection: selectionFor(text, subject), messageId: 'html-prestay', from: mailboxAddress, mailbox: mailboxAddress,
    });
    expect(result).toMatchObject({ ok: true, kind: 'other', action: 'other_actionable', payload: { separateAsk: ask } });
  });

  it('does not treat a request appearing only in quoted history as a current ask', async () => {
    const ask = 'Please book a separate room for another guest.';
    const result = await extractInboundMail({
      adapter: fakeModel(() => ({ ...CHANNEL_BOOKING_OUTPUT, action: 'new_booking', needsAction: true,
        separateAsk: ask, confirmationNumbers: ['57291630-1'] })).adapter,
      selection: selectionFor(`Arrival details only.\n\nOn Monday Guest wrote:\n${ask}`, subject),
      messageId: 'historical-prestay', from: mailboxAddress, mailbox: mailboxAddress,
    });
    expect(result).toMatchObject({ ok: true, kind: 'other', needsAction: false, action: 'no_action' });
    if (result.ok) expect(result.payload.separateAsk).toBeUndefined();
  });

  it.each(['new_booking', 'quote_availability', 'amend', 'cancel', 'no_action'] as const)(
    'keeps a grounded second request for review without granting %s on a pre-stay', async (action) => {
      const ask = 'Please book a separate room for another guest.';
      const result = await extractInboundMail({
        adapter: fakeModel(() => ({ ...CHANNEL_BOOKING_OUTPUT, action, needsAction: action !== 'no_action',
          actionEvidence: 'Existing reservation', separateAsk: ask, confirmationNumbers: ['57291630-1'] })).adapter,
        selection: selectionFor(`Arrival details for 57291630-1. ${ask}`, subject),
        messageId: 'mixed-prestay-booking', from: mailboxAddress, mailbox: mailboxAddress,
      });
      expect(result).toMatchObject({ ok: true, kind: 'other', needsAction: true,
        action: 'other_actionable', actionEvidence: ask,
        payload: { separateAsk: ask, needsAction: true, action: 'other_actionable', actionEvidence: ask } });
      if (result.ok) expect(result.payload.stays.every((stay) => stay.action === 'no_action')).toBe(true);
    },
  );

  it('does not add a pre-stay marker to a non-self message', async () => {
    const ask = 'Please send the catering menu.';
    const result = await extractInboundMail({
      adapter: fakeModel(() => ({ ...CHANNEL_BOOKING_OUTPUT, action: 'group_event', needsAction: true,
        separateAsk: ask, confirmationNumbers: ['57291630-1'] })).adapter,
      selection: selectionFor(ask, subject), messageId: 'external-prestay',
      from: 'guest@example.invalid', mailbox: mailboxAddress,
    });
    expect(result).toMatchObject({ ok: true, kind: 'booking' });
    if (result.ok) expect(result.payload.separateAsk).toBeUndefined();
  });

  it('keeps a grounded separate ask in triage without any booking or quote overlay', async () => {
    const ask = 'Please send the conference catering menu.';
    const adapter: ModelAdapter = {
      invoke: vi.fn(async () => ({
        modelId: 'test-model',
        output: {
          primaryFolder: 'groups-events', priority: 'P2', urgent: false,
          overlays: { booking: true, quote: true }, isSpam: false, suggestedTools: [],
          sourceScope: 'internal_property', automationState: 'excluded_internal',
          humanAction: 'other', confidence: 0.8, rationale: 'Conference enquiry.',
          policyFlags: [], abstainReason: null, separateAsk: ask,
        },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 1,
          estimatedCostUsd: 0, rateTableVersion: 'test' },
      })),
    };
    const input = {
      transportId: 'transport-test', threadId: 'thread-mixed', triggerMessageId: 'mixed', mailboxAddress,
      messages: [{ id: 'mixed', from: mailboxAddress, subject,
        body: `Arrival details. ${ask}`, direction: 'inbound' as const,
        createdAt: new Date('2026-10-14T10:00:00.000Z') }],
      asOf: '2026-10-14T10:00:00.000Z', modelId: 'test-model', promptVersion: 'triage-v6',
    };
    const result = await classifyWorkflowMailTriage(input, adapter);
    expect(result.output).toMatchObject({ primaryFolder: 'groups-events', overlays: {},
      automationState: 'candidate', humanAction: 'other' });
    expect(result.output.policyFlags).toContain('separate-ask');
    const pure = await classifyWorkflowMailTriage({ ...input, messages: [{ ...input.messages[0]!,
      body: 'Arrival details only.' }] }, adapter);
    expect(pure.output).toMatchObject({ primaryFolder: 'internal-partner', overlays: {},
      humanAction: 'none', automationState: 'excluded_internal' });
    const historical = await classifyWorkflowMailTriage({ ...input, messages: [{ ...input.messages[0]!,
      body: `Arrival details only.\n\nOn Monday Guest wrote:\n${ask}` }] }, adapter);
    expect(historical.output).toMatchObject({ primaryFolder: 'internal-partner', overlays: {},
      humanAction: 'none', automationState: 'excluded_internal' });
    const external = await classifyWorkflowMailTriage({ ...input, messages: [{ ...input.messages[0]!,
      from: 'guest@example.invalid' }] }, adapter);
    expect(external.output.policyFlags).not.toContain('existing-stay-information');
  });

});
