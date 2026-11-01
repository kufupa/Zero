import { describe, expect, it } from 'vitest';
import { HTML_ALTERNATIVE_MARKER, validReservationistMessageViews } from '../src/ai/reservationist-message-view.js';

describe('email message views', () => {
  it('accepts shared quoted history while rejecting a shifted history range', () => {
    const plain = 'Please quote.', html = 'Please quote with breakfast.';
    const prefix = `${plain}\n\n${HTML_ALTERNATIVE_MARKER}${html}`;
    const text = `${prefix}\n\nFrom: prior guest\nPlease advise.`;
    const quoted = { start: prefix.length + 2, end: text.length };
    const views = [
      { name: 'plain', start: 0, end: plain.length, quoted },
      { name: 'html', start: plain.length + 2 + HTML_ALTERNATIVE_MARKER.length, end: prefix.length, quoted },
    ];
    expect(validReservationistMessageViews(text, views)).toBe(true);
    expect(validReservationistMessageViews(text, [views[0], { ...views[1], quoted: { ...quoted, start: quoted.start + 1 } }])).toBe(false);
  });
});
