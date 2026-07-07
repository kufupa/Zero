import { describe, expect, it } from 'vitest';
import { extractDraftFeedbackLabels } from '../src/ai/feedback.js';

describe('AI feedback contract', () => {
  const aiGenerated = {
    toAddresses: ['guest@example.com'],
    ccAddresses: [],
    bccAddresses: [],
    subject: 'Re: Booking',
    textBody: 'Thank you for your inquiry.',
    htmlBody: '<p>Thank you for your inquiry.</p>',
  };

  it('labels tone, factual, recipient, subject, and missing-info edits', () => {
    const result = extractDraftFeedbackLabels({
      aiGenerated,
      sent: {
        toAddresses: ['guest@example.com', 'finance@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Re: Booking confirmation',
        textBody:
          'Thank you for your inquiry. We have confirmed your reservation and attached the tax invoice details you requested.',
        htmlBody: '<p>Thank you for your inquiry. Invoice attached.</p>',
      },
    });

    expect(result.labels).toEqual(
      expect.arrayContaining(['recipient', 'subject', 'tone', 'missing_info', 'factual']),
    );
    expect(result.metrics.edited).toBe(true);
  });

  it('returns no_edit when sent revision matches AI output', () => {
    const result = extractDraftFeedbackLabels({
      aiGenerated,
      sent: aiGenerated,
    });
    expect(result.labels).toEqual(['no_edit']);
    expect(result.metrics.edited).toBe(false);
  });
});
