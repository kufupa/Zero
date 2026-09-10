import { describe, expect, it } from 'vitest';
import {
  parseAndValidateDate,
  resolveEffectiveTimezone,
  formatMessageHeaderDate,
  formatThreadListDate,
} from '../lib/utils';

describe('Timezone & Date Integrity', () => {
  describe('parseAndValidateDate', () => {
    it('correctly parses strict UTC ISO with Z', () => {
      const parsed = parseAndValidateDate('2026-09-09T12:00:00.000Z');
      expect(parsed).not.toBeNull();
      expect(parsed?.toISOString()).toBe('2026-09-09T12:00:00.000Z');
    });

    it('anchors naive ISO string missing Z to UTC to avoid browser local offset drift', () => {
      const parsed = parseAndValidateDate('2026-09-09T12:00:00');
      expect(parsed).not.toBeNull();
      expect(parsed?.toISOString()).toBe('2026-09-09T12:00:00.000Z');
    });

    it('handles numeric epoch timestamps and Date objects', () => {
      const now = new Date();
      expect(parseAndValidateDate(now)).toEqual(now);
      expect(parseAndValidateDate(now.getTime())?.getTime()).toBe(now.getTime());
    });

    it('returns null on invalid or empty inputs', () => {
      expect(parseAndValidateDate('')).toBeNull();
      expect(parseAndValidateDate(null as any)).toBeNull();
      expect(parseAndValidateDate('not-a-date')).toBeNull();
    });
  });

  describe('resolveEffectiveTimezone', () => {
    it('uses configured timezone when valid and not UTC', () => {
      expect(resolveEffectiveTimezone('Europe/London')).toBe('Europe/London');
      expect(resolveEffectiveTimezone('America/New_York')).toBe('America/New_York');
      expect(resolveEffectiveTimezone('Africa/Johannesburg')).toBe('Africa/Johannesburg');
    });

    it('falls back to browser timezone or Africa/Johannesburg when unset or UTC', () => {
      const resolved = resolveEffectiveTimezone(undefined);
      expect(typeof resolved).toBe('string');
      expect(resolved.length).toBeGreaterThan(0);
    });
  });

  describe('formatMessageHeaderDate (Outlook Header Parity)', () => {
    it('always outputs both Date AND Time in the effective timezone', () => {
      // 12:00 UTC = 14:00 (2:00 PM) SAST
      const iso = '2026-09-09T12:00:00.000Z';
      const formatted = formatMessageHeaderDate(iso, 'Africa/Johannesburg');
      
      expect(formatted.display).toContain('Wed');
      expect(formatted.display).toContain('9/9/2026');
      expect(formatted.display).toContain('2:00 PM');
      expect(formatted.tooltip).toContain('2026');
    });

    it('returns empty string for null/empty dates without throwing', () => {
      expect(formatMessageHeaderDate(null).display).toBe('');
      expect(formatMessageHeaderDate('').display).toBe('');
    });
  });

  describe('formatThreadListDate & Invariance Contract', () => {
    it('formats thread list without losing timezone offset', () => {
      // 12:00 UTC = 2:00 PM SAST
      const iso = '2026-09-09T12:00:00.000Z';
      const listFormatted = formatThreadListDate(iso, 'Africa/Johannesburg');
      
      // Should show 2:00 PM (or Sep 9 depending on reference date), never 12:00
      expect(listFormatted).toContain('2:00 PM');
    });

    it('guarantees thread list and message header hour/minute match', () => {
      const iso = '2026-09-09T12:15:00.000Z';
      const listTime = formatThreadListDate(iso, 'Africa/Johannesburg');
      const headerTime = formatMessageHeaderDate(iso, 'Africa/Johannesburg');

      expect(listTime).toContain('2:15 PM');
      expect(headerTime.display).toContain('2:15 PM');
    });
  });
});
