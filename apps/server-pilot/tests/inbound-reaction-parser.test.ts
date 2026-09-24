import { describe, expect, it } from 'vitest';
import { parseInboundReaction } from '../src/mail/inbound-reaction-parser.js';

describe('parseInboundReaction', () => {
  it('detects Outlook leading emoji format', () => {
    const text = '👍 Alice Smith reacted to your message:\n"Could you confirm the reservation date?"';
    const result = parseInboundReaction('Re: Booking Confirmation', text, null, 'Alice Smith <alice@hotel.com>');

    expect(result.isReaction).toBe(true);
    expect(result.emoji).toBe('👍');
    expect(result.reactorName).toBe('Alice Smith');
    expect(result.reactorEmail).toBe('alice@hotel.com');
    expect(result.quotedSnippet).toContain('Could you confirm the reservation date?');
  });

  it('detects Outlook trailing emoji format', () => {
    const text = 'Bob Jones reacted to your message: ❤️\n"Thanks for the quick response!"';
    const result = parseInboundReaction('Re: Quick question', text, null, 'Bob Jones <bob@hotel.com>');

    expect(result.isReaction).toBe(true);
    expect(result.emoji).toBe('❤️');
    expect(result.reactorName).toBe('Bob Jones');
    expect(result.reactorEmail).toBe('bob@hotel.com');
    expect(result.quotedSnippet).toContain('Thanks for the quick response!');
  });

  it('extracts reaction from HTML fallback container', () => {
    const html = `
      <div style="background-color: #FFF4CE; padding: 12px;">
        <span>🎉 Charlie reacted to your message:</span>
        <blockquote>Great news, see you tomorrow!</blockquote>
      </div>
    `;
    const result = parseInboundReaction('Re: Update', null, html, 'Charlie <charlie@hotel.com>');

    expect(result.isReaction).toBe(true);
    expect(result.emoji).toBe('🎉');
    expect(result.reactorName).toBe('Charlie');
    expect(result.reactorEmail).toBe('charlie@hotel.com');
  });

  it('returns false for normal email without reaction', () => {
    const text = 'Hi team,\nHere is the weekly report. Let me know if you have any questions.\nBest,\nDavid';
    const result = parseInboundReaction('Weekly Report', text, '<p>' + text + '</p>', 'david@hotel.com');

    expect(result.isReaction).toBe(false);
    expect(result.emoji).toBeNull();
    expect(result.reactorName).toBeNull();
  });
});
