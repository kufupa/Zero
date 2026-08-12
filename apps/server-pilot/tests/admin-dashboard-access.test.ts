import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import {
  ADMIN_DASHBOARD_ALLOWED_EMAILS,
  assertAdminDashboardAccess,
  isAdminDashboardEmail,
} from '../src/metrics/admin-dashboard-access.js';
import { resolveAdminDashboardWindow } from '../src/trpc/routes/admin-dashboard.js';

describe('admin dashboard access', () => {
  it('allows navaai, ropperman, and darren allowlist emails', () => {
    expect(isAdminDashboardEmail('navaai@legacyhotels.co.za')).toBe(true);
    expect(isAdminDashboardEmail('  NavaAI@LegacyHotels.co.za ')).toBe(true);
    expect(isAdminDashboardEmail('ropperman@legacyhotels.co.za')).toBe(true);
    expect(isAdminDashboardEmail('dbezuidenhout@legacyhotels.co.za')).toBe(true);
    expect(() => assertAdminDashboardAccess('navaai@legacyhotels.co.za')).not.toThrow();
    expect(() => assertAdminDashboardAccess('ropperman@legacyhotels.co.za')).not.toThrow();
    expect(() => assertAdminDashboardAccess('dbezuidenhout@legacyhotels.co.za')).not.toThrow();
  });

  it('denies non-allowlisted emails', () => {
    expect(isAdminDashboardEmail('centurion@legacyhotels.co.za')).toBe(false);
    expect(isAdminDashboardEmail('random@legacyhotels.co.za')).toBe(false);
    expect(isAdminDashboardEmail('')).toBe(false);
    expect(isAdminDashboardEmail(null)).toBe(false);
    try {
      assertAdminDashboardAccess('random@legacyhotels.co.za');
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe('FORBIDDEN');
      expect((error as TRPCError).message).toBe('ADMIN_DASHBOARD_FORBIDDEN');
    }
  });

  it('stays in sync with the client allowlist', () => {
    // The client list cannot be imported here (it pulls browser-only modules),
    // so the source is parsed instead. Server-permissive drift is a security hole.
    const clientSource = readFileSync(
      fileURLToPath(new URL('../../mail/lib/admin-dashboard/access.ts', import.meta.url)),
      'utf8',
    );
    const listLiteral = clientSource.match(/ALLOWED_ADMIN_EMAILS\s*=\s*\[([^\]]*)\]/)?.[1];
    expect(listLiteral, 'client ALLOWED_ADMIN_EMAILS literal not found').toBeDefined();

    const clientEmails = [...listLiteral!.matchAll(/['"]([^'"]+)['"]/g)].map((match) =>
      match[1]!.toLowerCase(),
    );
    expect([...clientEmails].sort()).toEqual([...ADMIN_DASHBOARD_ALLOWED_EMAILS].sort());
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
