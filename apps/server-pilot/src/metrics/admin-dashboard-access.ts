/**
 * Server allowlist for admin dashboard metrics.
 * Keep in sync with apps/mail/lib/admin-dashboard/access.ts ALLOWED_ADMIN_EMAILS.
 */
import { TRPCError } from '@trpc/server';

export const ADMIN_DASHBOARD_ALLOWED_EMAILS = [
  'navaai@legacyhotels.co.za',
  'ropperman@legacyhotels.co.za',
  'dbezuidenhout@legacyhotels.co.za',
] as const;

export function isAdminDashboardEmail(email: string | null | undefined): boolean {
  const normalized = (email ?? '').trim().toLowerCase();
  if (!normalized) return false;
  return (ADMIN_DASHBOARD_ALLOWED_EMAILS as readonly string[]).includes(normalized);
}

export function assertAdminDashboardAccess(email: string | null | undefined): void {
  if (isAdminDashboardEmail(email)) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'ADMIN_DASHBOARD_FORBIDDEN',
  });
}
