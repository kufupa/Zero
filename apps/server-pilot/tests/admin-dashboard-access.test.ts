import {
  assertAdminDashboardAccess,
  isAdminDashboardEmail,
} from '../src/metrics/admin-dashboard-access.js';
import { resolveAdminDashboardWindow } from '../src/trpc/routes/admin-dashboard.js';
import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';

describe('admin dashboard access', () => {
  it('allows every authenticated user email for the configured dashboard grant', () => {
    expect(isAdminDashboardEmail('navaai@legacyhotels.co.za')).toBe(true);
    expect(isAdminDashboardEmail('  NavaAI@LegacyHotels.co.za ')).toBe(true);
    expect(isAdminDashboardEmail('martha@legacyhotels.co.za')).toBe(true);
    expect(isAdminDashboardEmail('new-pilot-user@example.com')).toBe(true);
    expect(() => assertAdminDashboardAccess('navaai@legacyhotels.co.za')).not.toThrow();
    expect(() => assertAdminDashboardAccess('martha@legacyhotels.co.za')).not.toThrow();
    expect(() => assertAdminDashboardAccess('new-pilot-user@example.com')).not.toThrow();
  });

  it('denies missing authenticated identity', () => {
    expect(isAdminDashboardEmail('')).toBe(false);
    expect(isAdminDashboardEmail(null)).toBe(false);
    try {
      assertAdminDashboardAccess(null);
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe('FORBIDDEN');
      expect((error as TRPCError).message).toBe('ADMIN_DASHBOARD_FORBIDDEN');
    }
  });
});

describe('resolveAdminDashboardWindow', () => {
  it('returns a 7-day window ending at now', () => {
    const now = new Date('2026-08-08T12:00:00.000Z');
    const { windowStart, windowEnd } = resolveAdminDashboardWindow(now);
    expect(windowEnd.toISOString()).toBe('2026-08-08T12:00:00.000Z');
    expect(windowStart.toISOString()).toBe('2026-08-01T12:00:00.000Z');
  });
});
