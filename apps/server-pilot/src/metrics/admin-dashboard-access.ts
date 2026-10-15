/** Server access guard for the configured executive dashboard metrics. */
import { TRPCError } from '@trpc/server';
import { NAVA_USER_EMAIL } from '../db/seed.js';

export type AdminDashboardCohort = 'centurion' | 'research';
export type AdminDashboardGrantKind = 'aggregate' | 'drilldown' | 'export';

export type AdminDashboardGrant = {
  email: string;
  cohortId: AdminDashboardCohort;
  aggregate: boolean;
  drilldown: boolean;
  export: boolean;
};

/** Allowlist, not mailbox_access role, because admin is app-wide not per-mailbox. */
export const ADMIN_DASHBOARD_EMAILS = [NAVA_USER_EMAIL] as const;

function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

export function isAdminDashboardEmail(email: string | null | undefined): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return ADMIN_DASHBOARD_EMAILS.some((allowed) => normalizeEmail(allowed) === normalized);
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
