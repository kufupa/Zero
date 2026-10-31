import { describe, expect, it } from 'vitest';
import { HTML_ALTERNATIVE_MARKER, validReservationistMessageViews } from '../src/ai/reservationist-message-view.js';

describe('reservationist message views', () => {
  it('accepts the two exact MIME ranges in one source', () => {
    const text = `plain\n\n${HTML_ALTERNATIVE_MARKER}html`;
    const htmlStart = text.indexOf('html', text.indexOf(HTML_ALTERNATIVE_MARKER) + HTML_ALTERNATIVE_MARKER.length);
    expect(validReservationistMessageViews(text, [
      { name: 'plain', start: 0, end: 5 }, { name: 'html', start: htmlStart, end: text.length },
    ])).toBe(true);
  });

  it('rejects an overlapping or unmarked alternative', () => {
    expect(validReservationistMessageViews('plain html', [
      { name: 'plain', start: 0, end: 5 }, { name: 'html', start: 4, end: 10 },
    ])).toBe(false);
  });

  it('keeps quoted history outside the view but rejects a truncated current alternative', () => {
    const text = `plain\n\n${HTML_ALTERNATIVE_MARKER}html\n\nFrom: earlier@example.invalid\nEarlier message`;
    const htmlStart = text.indexOf('html', text.indexOf(HTML_ALTERNATIVE_MARKER) + HTML_ALTERNATIVE_MARKER.length);
    const plain = { name: 'plain', start: 0, end: 5 };
    expect(validReservationistMessageViews(text, [plain, { name: 'html', start: htmlStart, end: htmlStart + 4 }])).toBe(true);
    expect(validReservationistMessageViews(text, [plain, { name: 'html', start: htmlStart, end: htmlStart + 1 }])).toBe(false);
  });
});
