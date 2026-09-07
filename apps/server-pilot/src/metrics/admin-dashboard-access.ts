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
 * Client-facing dashboard access is aggregate-only by default.  The Nava
 * operator account is the only explicitly configured research/raw/export
 * principal; mailbox access itself never implies one of these grants.
 */
const ADMIN_DASHBOARD_OPERATOR_EMAIL = 'navaai@legacyhotels.co.za';

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
  if (cohortId === 'research' && normalized !== ADMIN_DASHBOARD_OPERATOR_EMAIL) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'ADMIN_DASHBOARD_RESEARCH_FORBIDDEN',
    });
  }

  const operator = normalized === ADMIN_DASHBOARD_OPERATOR_EMAIL;
  return {
    email: normalized,
    cohortId,
    aggregate: true,
    drilldown: operator,
    export: operator,
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
