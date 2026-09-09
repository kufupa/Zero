/**
 * Server allowlist for admin dashboard metrics.
 * Keep in sync with apps/mail/lib/admin-dashboard/access.ts ALLOWED_ADMIN_EMAILS.
 */
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

export const ADMIN_DASHBOARD_ALLOWED_EMAILS = [
  'navaai@legacyhotels.co.za',
  'ropperman@legacyhotels.co.za',
  'dbezuidenhout@legacyhotels.co.za',
] as const;

/**
 * Every configured pilot dashboard user receives the same configured cohort
 * tools/data grant. There are no staff/finance or per-cohort user sub-roles;
 * tenant/source boundaries remain enforced by the selected cohort itself.
 */
function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

export function isAdminDashboardEmail(email: string | null | undefined): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return (ADMIN_DASHBOARD_ALLOWED_EMAILS as readonly string[]).includes(normalized);
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
