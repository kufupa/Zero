import { describe, expect, it } from 'vitest';
import { formatEmlFilename, synthesizeRfc822Eml } from '../src/mail/eml-export.js';
import { simpleParser } from 'mailparser';

describe('formatEmlFilename', () => {
  it('formats clean subject and date into safe .eml filename', () => {
    const filename = formatEmlFilename('Reservation Confirmation #12345', new Date('2026-09-09T12:00:00Z'));
    expect(filename).toBe('Reservation_Confirmation_#12345_2026-09-09.eml');
  });

  it('strips unsafe filesystem and control characters', () => {
    const filename = formatEmlFilename('Invoice: 12/34 *test* <foo>? "bar" |', new Date('2026-09-09'));
    expect(filename).not.toMatch(/[:/*?"<>|]/);
    expect(filename.endsWith('.eml')).toBe(true);
  });

  it('falls back when subject is missing or empty or only punctuation', () => {
    expect(formatEmlFilename('', new Date('2026-09-09'))).toBe('email_2026-09-09.eml');
    expect(formatEmlFilename('???', new Date('2026-09-09'))).toBe('email_2026-09-09.eml');
    expect(formatEmlFilename('___', new Date('2026-09-09'))).toBe('email_2026-09-09.eml');
  });

  it('preserves unicode surrogate pairs without splitting codepoints at 60 chars', () => {
    // 59 'a' characters + emoji '🏨' (which is 2 UTF-16 code units)
    const longSubject = 'a'.repeat(59) + '🏨';
    const filename = formatEmlFilename(longSubject, new Date('2026-09-09'));
    // Ensure encodeURIComponent does not throw URIError
    expect(() => encodeURIComponent(filename)).not.toThrow();
    expect(filename.endsWith('_2026-09-09.eml')).toBe(true);
  });
});

describe('synthesizeRfc822Eml', () => {
  it('generates a valid RFC 822 buffer parseable by mailparser', async () => {
    const buffer = await synthesizeRfc822Eml({
      from: 'reservations@legacyhotel.com',
      to: ['guest@example.com'],
      cc: ['frontdesk@legacyhotel.com'],
      subject: 'Welcome to Nava Hotel',
      date: new Date('2026-09-09T10:00:00Z'),
      textBody: 'Hello Guest, we look forward to your stay.',
      htmlBody: '<p>Hello Guest, we look forward to your stay.</p>',
      messageId: '<msg-123@legacyhotel.com>',
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(50);

    const parsed = await simpleParser(buffer);
    expect(parsed.subject).toBe('Welcome to Nava Hotel');
    expect(parsed.from?.text).toBe('reservations@legacyhotel.com');
    expect(parsed.to?.text).toBe('guest@example.com');
    expect(parsed.text?.trim()).toBe('Hello Guest, we look forward to your stay.');
    expect(parsed.messageId).toBe('<msg-123@legacyhotel.com>');
  });

  it('handles invalid date safely without throwing or invalid date header', async () => {
    const invalidDate = new Date('invalid');
    const buffer = await synthesizeRfc822Eml({
      from: 'test@legacyhotel.com',
      to: ['guest@example.com'],
      subject: 'Fallback Date',
      date: invalidDate,
      textBody: 'Body',
    });

    const parsed = await simpleParser(buffer);
    expect(parsed.date).toBeInstanceOf(Date);
    expect(Number.isNaN(parsed.date?.getTime())).toBe(false);
  });
});
