import { describe, expect, it } from 'vitest';
import { HTML_ALTERNATIVE_MARKER, validReservationistMessageViews } from '../src/ai/reservationist-message-view.js';

describe('email message views', () => {
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
    expect(validReservationistMessageViews(text, [plain, { name: 'html', start: htmlStart, end: text.length }])).toBe(false);
  });

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

  it('keeps distinct plain and HTML histories in their own ranges', () => {
    const plain = 'Quote please.', html = 'Quote with breakfast please.';
    const prefix = `${plain}\n\n${HTML_ALTERNATIVE_MARKER}${html}`;
    const plainHistory = 'From: plain guest\nFirst history.';
    const htmlHistory = 'From: html guest\nSecond history.';
    const separator = '\n\n[HTML alternative context]\n';
    const text = `${prefix}\n\n${plainHistory}${separator}${htmlHistory}`;
    const plainQuoted = { start: prefix.length + 2, end: prefix.length + 2 + plainHistory.length };
    const htmlQuoted = { start: plainQuoted.end + separator.length, end: text.length };
    const views = [
      { name: 'plain', start: 0, end: plain.length, quoted: plainQuoted },
      { name: 'html', start: plain.length + 2 + HTML_ALTERNATIVE_MARKER.length, end: prefix.length, quoted: htmlQuoted },
    ];
    expect(validReservationistMessageViews(text, views)).toBe(true);
    expect(validReservationistMessageViews(text, [
      { ...views[0], quoted: { ...plainQuoted, end: text.length } }, { ...views[1], quoted: undefined },
    ])).toBe(false);
  });
});
