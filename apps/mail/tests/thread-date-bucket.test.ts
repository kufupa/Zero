import { describe, expect, it } from 'vitest';
import { getDateBucket, MAIL_DATE_BUCKET_ORDER } from '../lib/mail/thread-date-bucket';

describe('getDateBucket', () => {
  const now = new Date('2026-04-13T12:00:00.000Z');

  it('classifies today', () => {
    expect(getDateBucket('2026-04-13T08:00:00.000Z', now)).toBe('today');
  });

  it('classifies yesterday', () => {
    // Noon UTC avoids "late evening UTC = next calendar day" in positive-offset zones.
    expect(getDateBucket('2026-04-12T12:00:00.000Z', now)).toBe('yesterday');
  });

  it('classifies last 7 days excluding today and yesterday as lastWeek', () => {
    expect(getDateBucket('2026-04-11T10:00:00.000Z', now)).toBe('lastWeek');
    expect(getDateBucket('2026-04-07T10:00:00.000Z', now)).toBe('lastWeek');
  });

  it('classifies before lastWeek but in current calendar month as thisMonth', () => {
    expect(getDateBucket('2026-04-01T10:00:00.000Z', now)).toBe('thisMonth');
  });

  it('classifies previous calendar month as lastMonth', () => {
    expect(getDateBucket('2026-03-20T10:00:00.000Z', now)).toBe('lastMonth');
  });

  it('classifies older as older', () => {
    expect(getDateBucket('2025-12-01T10:00:00.000Z', now)).toBe('older');
  });

  it('returns older for invalid date string', () => {
    expect(getDateBucket('not-a-date', now)).toBe('older');
  });
});

describe('MAIL_DATE_BUCKET_ORDER', () => {
  it('lists pinned first then chronological sections', () => {
    expect(MAIL_DATE_BUCKET_ORDER[0]).toBe('pinned');
    expect(MAIL_DATE_BUCKET_ORDER).toContain('today');
    expect(MAIL_DATE_BUCKET_ORDER).toContain('older');
  });
});
