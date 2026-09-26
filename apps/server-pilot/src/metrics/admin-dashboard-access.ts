/** Server access guard for the configured executive dashboard metrics. */
import { TRPCError } from '@trpc/server';

export type AdminDashboardCohort = 'centurion' | 'research';
export type AdminDashboardGrantKind = 'aggregate' | 'drilldown' | 'export';

export type AdminDashboardGrant = {
  email: string;
  cohortId: AdminDashboardCohort;
  aggregate: boolean;
  drilldown: boolean;
  export: boolean;
};

/**
 * Every authenticated application user receives the same configured cohort
 * tools/data grant. There are no staff/finance or per-cohort user sub-roles;
 * authentication, tenant/source boundaries, and the selected cohort remain
 * enforced by their existing callers and query scope.
 */
function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

export function isAdminDashboardEmail(email: string | null | undefined): boolean {
  return normalizeEmail(email).length > 0;
}

export function resolveAdminDashboardGrant(
  email: string | null | undefined,
  cohortId: AdminDashboardCohort = 'centurion',
): AdminDashboardGrant {
  const normalized = normalizeEmail(email);
  if (!isAdminDashboardEmail(normalized)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'ADMIN_DASHBOARD_FORBIDDEN',
    });
  }
  return {
    email: normalized,
    cohortId,
    aggregate: true,
    drilldown: true,
    export: true,
  };
}

export function assertAdminDashboardGrant(
  grant: AdminDashboardGrant,
  kind: AdminDashboardGrantKind,
): void {
  if (grant[kind]) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: `ADMIN_DASHBOARD_${kind.toUpperCase()}_FORBIDDEN`,
  });
}

export function assertAdminDashboardAccess(email: string | null | undefined): void {
  resolveAdminDashboardGrant(email, 'centurion');
}
