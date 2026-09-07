import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useSession } from '@/lib/auth-client';
import { useTRPC } from '@/providers/query-provider';
import { isAdminDashboardEnabled, describeAdminSource } from '@/lib/admin-dashboard/access';
import { ADMIN_DASHBOARD_PLACEHOLDER_DATA } from '@/lib/admin-dashboard/demo-data';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { getMailCacheScope, subscribeMailCacheScope } from '@/lib/mail/mail-cache-scope';
import type {
  AdminDashboardData,
  AdminDashboardMetrics,
  DashboardCohortId,
  DashboardWindowPreset,
} from '@/lib/admin-dashboard/types';

export type AdminDashboardQueryInput = {
  cohortId?: DashboardCohortId;
  window?: DashboardWindowPreset;
  observationCutoff?: string;
};

/** Bump when the dashboard interpretation/provenance contract changes. */
export const ADMIN_DASHBOARD_REPORT_VERSION = 'executive-dashboard-v2';

export type AdminDashboardState = {
  canAccess: boolean;
  isLoading: boolean;
  isError: boolean;
  /** A previous snapshot remains visible while the selected query refreshes. */
  isStale: boolean;
  source: 'demo' | 'hosted';
  /** Demo fixtures only — never used for hosted LIVE numbers. */
  data: AdminDashboardData | null;
  /** Hosted compute-on-read metrics; null in demo mode. */
  metrics: AdminDashboardMetrics | null;
};

export function useAdminDashboardData(queryInput?: AdminDashboardQueryInput): AdminDashboardState {
  const { data: session, isLoading: isSessionLoading, isError: isSessionError } = useSession();
  const source = describeAdminSource(session);
  const canAccess = isAdminDashboardEnabled(session);
  const demoMode = isFrontendOnlyDemo();
  const trpc = useTRPC();
  const cacheScope = useSyncExternalStore(
    subscribeMailCacheScope,
    getMailCacheScope,
    getMailCacheScope,
  );
  const viewerScopeKey = JSON.stringify({
    sessionUserId: session?.user?.id ?? null,
    cacheUserId: cacheScope.userId,
    activeTransportId: cacheScope.activeTransportId,
  });
  const cacheScopeKey = viewerScopeKey;
  const previousScopeKeyRef = useRef(cacheScopeKey);
  const canReusePreviousSnapshot = previousScopeKeyRef.current === cacheScopeKey;

  useEffect(() => {
    previousScopeKeyRef.current = cacheScopeKey;
  }, [cacheScopeKey]);

  const dashboardQueryOptions = trpc.adminDashboard.getMetrics.queryOptions(queryInput, {
    enabled: !demoMode && canAccess && !isSessionLoading && !isSessionError,
    placeholderData: canReusePreviousSnapshot ? keepPreviousData : undefined,
  });
  const metricsQuery = useQuery({
    ...dashboardQueryOptions,
    queryKey: [
      ...(dashboardQueryOptions.queryKey as readonly unknown[]),
      ADMIN_DASHBOARD_REPORT_VERSION,
      viewerScopeKey,
    ] as unknown as typeof dashboardQueryOptions.queryKey,
  });
  const lastSuccessfulSnapshotRef = useRef<{
    scopeKey: string;
    metrics: AdminDashboardMetrics;
  } | null>(null);
  const queryMetrics = metricsQuery.data as AdminDashboardMetrics | undefined;
  if (queryMetrics && !metricsQuery.isPlaceholderData && !metricsQuery.isError) {
    lastSuccessfulSnapshotRef.current = { scopeKey: cacheScopeKey, metrics: queryMetrics };
  }
  const retainedSnapshot = lastSuccessfulSnapshotRef.current?.scopeKey === cacheScopeKey
    ? lastSuccessfulSnapshotRef.current.metrics
    : undefined;
  const metrics = queryMetrics ?? retainedSnapshot ?? null;

  if (isSessionLoading) {
    return {
      canAccess: false,
      isLoading: true,
      isError: false,
      isStale: false,
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
      isStale: false,
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
      isStale: false,
      source: 'demo',
      data: ADMIN_DASHBOARD_PLACEHOLDER_DATA,
      metrics: null,
    };
  }

  return {
    canAccess: true,
    isLoading: metricsQuery.isLoading && !metrics,
    isError: metricsQuery.isError,
    isStale: Boolean(metrics) && (metricsQuery.isFetching || metricsQuery.isError || metricsQuery.isPlaceholderData),
    source: 'hosted',
    data: null,
    metrics,
  };
}
