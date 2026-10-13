import { describe, expect, it } from 'vitest';
import { staffQuoteResultExpiry, staffQuoteResultReusable } from '../src/ai/hms-jobs.js';

describe('staffQuoteResultExpiry', () => {
  const now = new Date('2026-10-13T10:24:00.000Z');

  it('reuses a priced result only while its HMS evidence backs a PDF', () => {
    expect(staffQuoteResultExpiry({ status: 'ready', freshUntil: '2026-10-13T10:38:18.382Z' }, now).toISOString()).toBe(
      '2026-10-13T10:38:18.382Z',
    );
  });

  it('keeps the 6-hour reuse for results without evidence', () => {
    expect(staffQuoteResultExpiry({ status: 'unavailable' }, now).toISOString()).toBe('2026-10-13T16:24:00.000Z');
    expect(staffQuoteResultExpiry({ status: 'ready', freshUntil: 'not a date' }, now).toISOString()).toBe(
      '2026-10-13T16:24:00.000Z',
    );
  });

  it('never extends reuse past 6 hours', () => {
    expect(staffQuoteResultExpiry({ freshUntil: '2026-10-14T10:00:00.000Z' }, now).toISOString()).toBe(
      '2026-10-13T16:24:00.000Z',
    );
  });
});

describe('staffQuoteResultReusable', () => {
  const now = new Date('2026-10-13T10:40:00.000Z');

  it('reuses a priced result only before freshUntil', () => {
    expect(staffQuoteResultReusable({ status: 'ready', freshUntil: '2026-10-13T10:45:00.000Z' }, now)).toBe(true);
    expect(staffQuoteResultReusable({ status: 'ready', freshUntil: '2026-10-13T10:38:18.382Z' }, now)).toBe(false);
  });

  it('never reuses a priced result stored without freshUntil', () => {
    expect(staffQuoteResultReusable({ status: 'ready' }, now)).toBe(false);
  });

  it('keeps reusing refusals and no-rate answers', () => {
    expect(staffQuoteResultReusable({ status: 'unavailable' }, now)).toBe(true);
  });
});
