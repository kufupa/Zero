import { useSession } from '@/lib/auth-client';
import { isAdminDashboardEnabled, describeAdminSource } from '@/lib/admin-dashboard/access';
import { ADMIN_DASHBOARD_PLACEHOLDER_DATA } from '@/lib/admin-dashboard/demo-data';
import type { AdminDashboardData } from '@/lib/admin-dashboard/types';

export type AdminDashboardState = {
  canAccess: boolean;
  isLoading: boolean;
  isError: boolean;
  source: 'demo' | 'hosted';
  data: AdminDashboardData | null;
};

export function useAdminDashboardData(): AdminDashboardState {
  const { data: session, isLoading: isSessionLoading, isError: isSessionError } = useSession();
  const source = describeAdminSource(session);
  const canAccess = isAdminDashboardEnabled(session);

  if (isSessionLoading) {
    return {
      canAccess: false,
      isLoading: true,
      isError: false,
      source,
      data: null,
    };
  }

  if (!canAccess || isSessionError) {
    return {
      canAccess: false,
      isLoading: false,
      isError: Boolean(isSessionError),
      source,
      data: null,
    };
  }

  return {
    canAccess: true,
    isLoading: false,
    isError: false,
    source,
    // Hosted adapter placeholder: swap this static payload for a real backend call
    // when the dashboard moves off demo mode.
    data: ADMIN_DASHBOARD_PLACEHOLDER_DATA,
  };
}
