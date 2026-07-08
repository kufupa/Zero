import { describe, expect, it } from 'vitest';
import { parseSearchDate } from '../src/mail/search/query.js';

describe('parseSearchDate', () => {
  it('parses yyyy/mm/dd as UTC midnight', () => {
    const date = parseSearchDate('2026/07/15');
    expect(date).not.toBeNull();
    expect(date?.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  it('parses yyyy-mm-dd as UTC midnight', () => {
    const date = parseSearchDate('2026-07-15');
    expect(date).not.toBeNull();
    expect(date?.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  it('parses single-digit month and day', () => {
    const date = parseSearchDate('2026/7/5');
    expect(date).not.toBeNull();
    expect(date?.toISOString()).toBe('2026-07-05T00:00:00.000Z');
  });

  it('returns null for invalid date string', () => {
    expect(parseSearchDate('not-a-date')).toBeNull();
    expect(parseSearchDate('')).toBeNull();
  });
});
