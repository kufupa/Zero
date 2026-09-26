import type {
  AdminDashboardData,
  AdminDashboardMetrics,
  AdminDashboardSelection,
  DashboardCohortId,
  DashboardWindowPreset,
  AdminDashboardExport,
} from '@/lib/admin-dashboard/types';
import { isAdminDashboardEnabled, describeAdminSource } from '@/lib/admin-dashboard/access';
import { getMailCacheScope, subscribeMailCacheScope } from '@/lib/mail/mail-cache-scope';
import { ADMIN_DASHBOARD_PLACEHOLDER_DATA } from '@/lib/admin-dashboard/demo-data';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { normalizeAdminDashboardSelection } from '@/lib/admin-dashboard/types';
import { downloadAdminDashboardExport } from '@/lib/admin-dashboard/export';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useTRPC } from '@/providers/query-provider';
import { useSession } from '@/lib/auth-client';

export type AdminDashboardQueryInput = {
  cohortId?: DashboardCohortId;
  window?: DashboardWindowPreset;
  observationCutoff?: string;
};

/** Bump when the dashboard interpretation/provenance contract changes. */
export const ADMIN_DASHBOARD_REPORT_VERSION = 'executive-dashboard-v3-shadow-scorecard';

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
  /** Selection semantics for the snapshot currently displayed, scoped with the snapshot. */
  snapshotSelection: AdminDashboardSelection | null;
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
    selection: AdminDashboardSelection;
  } | null>(null);
  const currentSelection = normalizeAdminDashboardSelection(queryInput);
  const queryMetrics = metricsQuery.data as AdminDashboardMetrics | undefined;
  if (queryMetrics && !metricsQuery.isPlaceholderData && !metricsQuery.isError) {
    lastSuccessfulSnapshotRef.current = {
      scopeKey: cacheScopeKey,
      metrics: queryMetrics,
      selection: currentSelection,
    };
  }
  const retainedSnapshotRecord =
    lastSuccessfulSnapshotRef.current?.scopeKey === cacheScopeKey
      ? lastSuccessfulSnapshotRef.current
      : undefined;
  const retainedSnapshot = retainedSnapshotRecord?.metrics;
  const snapshotSelection =
    queryMetrics && !metricsQuery.isPlaceholderData
      ? currentSelection
      : (retainedSnapshotRecord?.selection ?? null);
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
      snapshotSelection: null,
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
      snapshotSelection: null,
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
      snapshotSelection: null,
    };
  }

  return {
    canAccess: true,
    isLoading: metricsQuery.isLoading && !metrics,
    isError: metricsQuery.isError,
    isStale:
      Boolean(metrics) &&
      (metricsQuery.isFetching || metricsQuery.isError || metricsQuery.isPlaceholderData),
    source: 'hosted',
    data: null,
    metrics,
    snapshotSelection,
  };
}

/** Fetch the server-authorized bounded export only on an explicit user action. */
export function useAdminDashboardExport(queryInput?: AdminDashboardQueryInput): {
  isDownloading: boolean;
  isError: boolean;
  download: () => Promise<boolean>;
} {
  const { data: session, isLoading: isSessionLoading, isError: isSessionError } = useSession();
  const canAccess = isAdminDashboardEnabled(session);
  const demoMode = isFrontendOnlyDemo();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
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
  const requestedSelection = normalizeAdminDashboardSelection(queryInput);
  const exportInput = { ...queryInput, operation: 'export' as const };
  const exportQueryOptions = trpc.adminDashboard.getMetrics.queryOptions(exportInput, {
    enabled: false,
  });
  const exportQueryKey = [
    ...(exportQueryOptions.queryKey as readonly unknown[]),
    ADMIN_DASHBOARD_REPORT_VERSION,
    viewerScopeKey,
  ] as typeof exportQueryOptions.queryKey;
  const exportQuery = useQuery({ ...exportQueryOptions, queryKey: exportQueryKey });
  const clearCachedExport = () => {
    queryClient.removeQueries({ queryKey: exportQueryKey, exact: true });
  };
  const download = async (): Promise<boolean> => {
    if (demoMode || !canAccess || isSessionLoading || isSessionError) return false;
    let result: Awaited<ReturnType<typeof exportQuery.refetch>>;
    try {
      result = await exportQuery.refetch();
    } catch {
      clearCachedExport();
      return false;
    }
    const payload = result.data as AdminDashboardExport | undefined;
    const payloadQuery = payload?.query;
    const queryMatchesSelection =
      payloadQuery !== undefined &&
      payloadQuery.cohortId === requestedSelection.cohortId &&
      payloadQuery.window === requestedSelection.window &&
      (requestedSelection.observationCutoff === undefined ||
        payloadQuery.observationCutoff === requestedSelection.observationCutoff);
    const scopeStillMatches =
      JSON.stringify({
        sessionUserId: session?.user?.id ?? null,
        cacheUserId: getMailCacheScope().userId,
        activeTransportId: getMailCacheScope().activeTransportId,
      }) === viewerScopeKey;
    if (
      result.isError ||
      !payload ||
      payload.schemaVersion !== 'admin-dashboard-export-v1' ||
      !queryMatchesSelection ||
      !scopeStillMatches
    ) {
      clearCachedExport();
      return false;
    }
    downloadAdminDashboardExport(payload);
    return true;
  };
  return {
    isDownloading: exportQuery.isFetching,
    isError: exportQuery.isError,
    download,
  };
}
