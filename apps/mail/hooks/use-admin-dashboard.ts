import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';
import { useTRPC } from '@/providers/query-provider';
import { isAdminDashboardEnabled, describeAdminSource } from '@/lib/admin-dashboard/access';
import { ADMIN_DASHBOARD_PLACEHOLDER_DATA } from '@/lib/admin-dashboard/demo-data';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import type { AdminDashboardData, AdminDashboardMetrics } from '@/lib/admin-dashboard/types';

export type AdminDashboardState = {
  canAccess: boolean;
  isLoading: boolean;
  isError: boolean;
  source: 'demo' | 'hosted';
  /** Demo fixtures only — never used for hosted LIVE numbers. */
  data: AdminDashboardData | null;
  /** Hosted compute-on-read metrics; null in demo mode. */
  metrics: AdminDashboardMetrics | null;
};

export function useAdminDashboardData(): AdminDashboardState {
  const { data: session, isLoading: isSessionLoading, isError: isSessionError } = useSession();
  const source = describeAdminSource(session);
  const canAccess = isAdminDashboardEnabled(session);
  const demoMode = isFrontendOnlyDemo();
  const trpc = useTRPC();

  const metricsQuery = useQuery(
    trpc.adminDashboard.getMetrics.queryOptions(undefined, {
      enabled: !demoMode && canAccess && !isSessionLoading && !isSessionError,
    }),
  );

  if (isSessionLoading) {
    return {
      canAccess: false,
      isLoading: true,
      isError: false,
      source,
      data: null,
      metrics: null,
    };
  }

  if (!canAccess || isSessionError) {
    return {
      canAccess: false,
      isLoading: false,
      isError: Boolean(isSessionError),
      source,
      data: null,
      metrics: null,
    };
  }

  if (demoMode) {
    return {
      canAccess: true,
      isLoading: false,
      isError: false,
      source: 'demo',
      data: ADMIN_DASHBOARD_PLACEHOLDER_DATA,
      metrics: null,
    };
  }

  return {
    canAccess: true,
    isLoading: metricsQuery.isLoading,
    isError: metricsQuery.isError,
    source: 'hosted',
    data: null,
    metrics: (metricsQuery.data as AdminDashboardMetrics | undefined) ?? null,
  };
}
