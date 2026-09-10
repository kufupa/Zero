import { describe, expect, it } from 'vitest';
import {
  resolveEffectiveTimezone,
  parseAndValidateDate,
  formatMessageHeaderDate,
  formatThreadListDate,
  shouldShowSeparateTime,
} from '../lib/utils';

const GLOBAL_TIMEZONES = [
  'Africa/Johannesburg',
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Asia/Dubai',
  'Pacific/Auckland',
  'Asia/Kolkata',
] as const;

describe('Suite 1: Stress Timezone & Date/Time Integrity Battery', () => {
  describe('Timezone Resolution Fallback Chain', () => {
    it('prefers explicit userSettings timezone', () => {
      expect(resolveEffectiveTimezone('Europe/Paris')).toBe('Europe/Paris');
      expect(resolveEffectiveTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
    });

    it('falls back to Intl or Africa/Johannesburg if setting is null/empty/invalid', () => {
      const emptyResolved = resolveEffectiveTimezone('');
      expect(emptyResolved).toBeDefined();
      expect(typeof emptyResolved).toBe('string');

      const nullResolved = resolveEffectiveTimezone(null);
      expect(nullResolved).toBeDefined();

      const invalidResolved = resolveEffectiveTimezone('Not/A_Real_Timezone');
      expect(invalidResolved).toBeDefined();
    });
  });

  describe('Naive vs UTC ISO Handling (Zero 2-Hour Drift)', () => {
    it('correctly anchors naive ISO strings to UTC without browser local skew', () => {
      const naiveIso = '2026-09-09T14:30:00';
      const parsedNaive = parseAndValidateDate(naiveIso);
      expect(parsedNaive).not.toBeNull();
      expect(parsedNaive?.toISOString()).toBe('2026-09-09T14:30:00.000Z');

      const explicitUtc = '2026-09-09T14:30:00.000Z';
      const parsedUtc = parseAndValidateDate(explicitUtc);
      expect(parsedUtc).not.toBeNull();
      expect(parsedUtc?.toISOString()).toBe('2026-09-09T14:30:00.000Z');

      expect(parsedNaive?.getTime()).toBe(parsedUtc?.getTime());
    });

    it('handles millisecond timestamps without trailing Z', () => {
      const withMs = '2026-09-09T14:30:00.123';
      const parsed = parseAndValidateDate(withMs);
      expect(parsed?.toISOString()).toBe('2026-09-09T14:30:00.123Z');
    });
  });

  describe('Global 10-Timezone Header Date Formatting', () => {
    const fixedIso = '2026-09-09T12:00:00.000Z';

    it('formats consistent Outlook header dates across all 10 timezones', () => {
      const results = new Map<string, string>();

      for (const tz of GLOBAL_TIMEZONES) {
        const { display, tooltip } = formatMessageHeaderDate(fixedIso, tz);

        expect(display).toBeTruthy();
        expect(tooltip).toBeTruthy();

        // Must display both weekday/date AND time with AM/PM
        expect(display).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2} (AM|PM)$/);

        // Tooltip must display full expanded date + time
        expect(tooltip).toMatch(/2026/);
        expect(tooltip).toMatch(/(AM|PM)/);

        results.set(tz, display);
      }

      // Verify specific expected values:
      // UTC 12:00 PM -> Johannesburg is UTC+2 -> 2:00 PM
      expect(results.get('UTC')).toContain('12:00 PM');
      expect(results.get('Africa/Johannesburg')).toContain('2:00 PM');
      // New York is UTC-4 (EDT) -> 8:00 AM
      expect(results.get('America/New_York')).toContain('8:00 AM');
      // Tokyo is UTC+9 -> 9:00 PM
      expect(results.get('Asia/Tokyo')).toContain('9:00 PM');
      // Sydney is UTC+10 (AEST) -> 10:00 PM
      expect(results.get('Australia/Sydney')).toContain('10:00 PM');
    });
  });

  describe('Edge Dates: Leap Years, Year Boundaries, Epoch', () => {
    it('handles leap days correctly across timezones', () => {
      const leapDay = '2024-02-29T12:00:00.000Z';
      const jhb = formatMessageHeaderDate(leapDay, 'Africa/Johannesburg');
      expect(jhb.display).toBe('Thu 2/29/2024 2:00 PM');

      const futureLeap = '2028-02-29T23:45:00.000Z';
      const tokyo = formatMessageHeaderDate(futureLeap, 'Asia/Tokyo');
      // In Tokyo (UTC+9), 23:45 UTC on Feb 29 becomes 8:45 AM on Mar 1!
      expect(tokyo.display).toBe('Wed 3/1/2028 8:45 AM');
    });

    it('handles year rollover at UTC midnight', () => {
      const newYearEve = '2026-12-31T23:59:00.000Z';
      // In UTC: Dec 31, 2026 11:59 PM
      expect(formatMessageHeaderDate(newYearEve, 'UTC').display).toBe('Thu 12/31/2026 11:59 PM');
      // In Johannesburg (UTC+2): Jan 1, 2027 1:59 AM
      expect(formatMessageHeaderDate(newYearEve, 'Africa/Johannesburg').display).toBe('Fri 1/1/2027 1:59 AM');
      // In New York (UTC-5 EST): Dec 31, 2026 6:59 PM
      expect(formatMessageHeaderDate(newYearEve, 'America/New_York').display).toBe('Thu 12/31/2026 6:59 PM');
    });

    it('handles Unix epoch (1970-01-01)', () => {
      const epoch = '1970-01-01T00:00:00.000Z';
      expect(formatMessageHeaderDate(epoch, 'UTC').display).toBe('Thu 1/1/1970 12:00 AM');
    });
  });

  describe('Thread List Relative/Absolute Date Formatting', () => {
    it('formats today as time with AM/PM', () => {
      const now = new Date();
      const formatted = formatThreadListDate(now, 'Africa/Johannesburg');
      expect(formatted).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    });

    it('formats past years with 4-digit year', () => {
      const oldDate = '2023-05-15T10:00:00.000Z';
      const formatted = formatThreadListDate(oldDate, 'Africa/Johannesburg');
      expect(formatted).toContain('2023');
    });

    it('never crashes on invalid or null dates', () => {
      expect(formatThreadListDate(null, 'UTC')).toBe('');
      expect(formatThreadListDate(undefined, 'UTC')).toBe('');
      expect(formatThreadListDate('invalid-date-string', 'UTC')).toBe('');
      expect(formatMessageHeaderDate(null, 'UTC')).toEqual({ display: '', tooltip: '' });
      expect(formatMessageHeaderDate('gibberish', 'UTC')).toEqual({ display: '', tooltip: '' });
    });
  });

  describe('shouldShowSeparateTime Helper', () => {
    it('returns false for message headers because time is already included', () => {
      expect(shouldShowSeparateTime('Thu 9/9/2026 2:00 PM')).toBe(false);
      expect(shouldShowSeparateTime('10:45 AM')).toBe(false);
    });

    it('returns true for older dates (>12 hours and not today)', () => {
      expect(shouldShowSeparateTime('2025-01-15T10:00:00.000Z')).toBe(true);
      expect(shouldShowSeparateTime('2024-11-20T14:30:00.000Z')).toBe(true);
    });
  });
});
