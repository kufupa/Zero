import {
  assertAdminDashboardAccess,
  assertAdminDashboardGrant,
  isAdminDashboardEmail,
  resolveAdminDashboardGrant,
} from '../src/metrics/admin-dashboard-access.js';
import { resolveAdminDashboardWindow } from '../src/trpc/routes/admin-dashboard.js';
import { CENTURION_USER_EMAIL, NAVA_USER_EMAIL } from '../src/db/seed.js';
import { __setDbForTests } from '../src/db/client.js';
import { appRouter } from '../src/trpc/router.js';
import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';

const STAFF_EMAIL = CENTURION_USER_EMAIL;
const GRANT_KINDS = ['aggregate', 'drilldown', 'export'] as const;

function expectDashboardForbidden(run: () => unknown): void {
  try {
    run();
    expect.unreachable('should throw');
  } catch (error) {
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('FORBIDDEN');
    expect((error as TRPCError).message).toBe('ADMIN_DASHBOARD_FORBIDDEN');
  }
}

describe('admin dashboard access', () => {
  it('allows the owner email for aggregate, drilldown, and export', () => {
    expect(isAdminDashboardEmail(NAVA_USER_EMAIL)).toBe(true);
    const grant = resolveAdminDashboardGrant(NAVA_USER_EMAIL);
    expect(grant).toMatchObject({
      email: NAVA_USER_EMAIL,
      aggregate: true,
      drilldown: true,
      export: true,
    });
    expect(() => assertAdminDashboardAccess(NAVA_USER_EMAIL)).not.toThrow();
    for (const kind of GRANT_KINDS) {
      expect(() => assertAdminDashboardGrant(grant, kind)).not.toThrow();
    }
  });

  it('normalizes owner email case and surrounding whitespace', () => {
    expect(isAdminDashboardEmail('  NavaAI@LegacyHotels.co.za ')).toBe(true);
    const grant = resolveAdminDashboardGrant('  NavaAI@LegacyHotels.co.za ');
    expect(grant.email).toBe(NAVA_USER_EMAIL);
    for (const kind of GRANT_KINDS) {
      expect(() => assertAdminDashboardGrant(grant, kind)).not.toThrow();
    }
  });

  it('forbids centurion and staff emails for aggregate, drilldown, and export', () => {
    expect(isAdminDashboardEmail(STAFF_EMAIL)).toBe(false);
    expect(isAdminDashboardEmail('ropperman@legacyhotels.co.za')).toBe(false);
    expectDashboardForbidden(() => resolveAdminDashboardGrant(STAFF_EMAIL));
    expectDashboardForbidden(() => resolveAdminDashboardGrant('ropperman@legacyhotels.co.za'));
    expectDashboardForbidden(() => assertAdminDashboardAccess(STAFF_EMAIL));
    expectDashboardForbidden(() => assertAdminDashboardAccess('martha@legacyhotels.co.za'));
    expectDashboardForbidden(() => resolveAdminDashboardGrant(STAFF_EMAIL, 'centurion'));
  });

  it('denies missing authenticated identity', () => {
    expect(isAdminDashboardEmail('')).toBe(false);
    expect(isAdminDashboardEmail(null)).toBe(false);
    expect(isAdminDashboardEmail('   ')).toBe(false);
    expectDashboardForbidden(() => assertAdminDashboardAccess(null));
    expectDashboardForbidden(() => resolveAdminDashboardGrant(''));
  });

  it('rejects a non-admin export on the router without touching the database', async () => {
    const throwingDb = new Proxy(
      {},
      {
        get() {
          throw new Error('DB queried before admin dashboard grant');
        },
      },
    );
    __setDbForTests({ db: throwingDb as never, conn: null as never });
    try {
      const caller = appRouter.createCaller({
        auth: null as never,
        reqHeaders: new Headers(),
        sessionUser: { id: 'u-staff-export', email: STAFF_EMAIL, name: null },
      });
      await expect(caller.adminDashboard.getMetrics({ operation: 'export' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'ADMIN_DASHBOARD_FORBIDDEN',
      });
    } finally {
      __setDbForTests(null);
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
