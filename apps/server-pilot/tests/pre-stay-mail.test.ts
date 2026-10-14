import { describe, expect, it } from 'vitest';
import { sanitizeExtraction, mailExtractionSchema } from '../src/ai/extraction/schema.js';
import { refineTriageOutput } from '../src/ai/triage.js';
import { ownMailboxPreStayConfirmation } from '../src/ai/pre-stay-mail.js';

const MAILBOX = 'reservations@example.test';
const SUBJECT = 'Pre Stay : Property Sample Confirmation No 12345678 Guestname';

const quoteModelOutput = {
  primaryFolder: 'bookings',
  priority: 'P3',
  urgent: false,
  overlays: { booking: true, quote: true },
  isSpam: false,
  suggestedTools: ['hms_quote_stay'],
  sourceScope: 'external',
  automationState: 'candidate',
  humanAction: 'answer_or_quote',
  confidence: 0.8,
  rationale: 'Synthetic model quote label.',
  policyFlags: [],
  abstainReason: null,
} as const;

describe('self-sent pre-stay confirmation routing', () => {
  it('recognizes a generic self-mailbox pre-stay subject and extracts its numeric confirmation', () => {
    expect(
      ownMailboxPreStayConfirmation({
        fromAddress: `Reservations <${MAILBOX}>`,
        mailboxEmail: MAILBOX.toUpperCase(),
        subject: SUBJECT,
      }),
    ).toBe('12345678');
  });

  it('does not treat a guest pre-stay email as self-mailbox mail', () => {
    expect(
      ownMailboxPreStayConfirmation({
        fromAddress: 'guest@example.test',
        mailboxEmail: MAILBOX,
        subject: SUBJECT,
      }),
    ).toBeNull();
  });

  it('does not treat self-mail without a confirmation number as pre-stay routing', () => {
    expect(
      ownMailboxPreStayConfirmation({
        fromAddress: MAILBOX,
        mailboxEmail: MAILBOX,
        subject: 'Pre Stay : Property Sample Guestname',
      }),
    ).toBeNull();
  });

  it('forces a matched message to manage-stay and removes quote/create labels before routing', () => {
    const output = refineTriageOutput(
      {
        from: MAILBOX,
        mailboxEmail: MAILBOX,
        subject: SUBJECT,
        body: 'Synthetic pre-arrival details.',
      },
      quoteModelOutput,
    );

    expect(output).toMatchObject({
      primaryFolder: 'manage-stay',
      isSpam: false,
      urgent: false,
      priority: 'P4',
      humanAction: 'verify_state',
      suggestedTools: ['hms_find_reservation'],
    });
    expect(output.overlays).not.toHaveProperty('quote', true);
    expect(output.overlays).not.toHaveProperty('booking', true);
    expect(output.suggestedTools).not.toContain('hms_quote_stay');
  });

  it('leaves guest mail on the normal model route even when its subject says pre-stay', () => {
    const output = refineTriageOutput(
      {
        from: 'guest@example.test',
        mailboxEmail: MAILBOX,
        subject: SUBJECT,
        body: 'Synthetic guest message.',
      },
      quoteModelOutput,
    );

    expect(output.primaryFolder).toBe('bookings');
    expect(output.overlays.quote).toBe(true);
  });

  it('leaves self-mail without a confirmation number on the normal model route', () => {
    const output = refineTriageOutput(
      {
        from: MAILBOX,
        mailboxEmail: MAILBOX,
        subject: 'Pre Stay : Property Sample Guestname',
        body: 'Synthetic pre-arrival details.',
      },
      quoteModelOutput,
    );

    expect(output.primaryFolder).toBe('bookings');
    expect(output.overlays.quote).toBe(true);
  });

  it('keeps a plain numeric confirmation through extraction sanitization when verbatim in source text', () => {
    const output = mailExtractionSchema.parse({
      sourceLanguage: 'en',
      kind: 'booking',
      origin: null,
      agency: null,
      endClient: null,
      contact: { name: null, email: null, phone: null },
      confirmationNumbers: ['12345678'],
      stays: [],
      missing: [],
    });

    const sanitized = sanitizeExtraction(output, {
      messageId: 'synthetic-message-id',
      sourceText: SUBJECT,
    });

    expect(sanitized.payload.confirmationNumbers).toEqual(['12345678']);
  });
});
