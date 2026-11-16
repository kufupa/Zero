import { getMailCacheScope, inMailbox, subscribeMailCacheScope } from '@/lib/mail/mail-cache-scope';
import type { RetroReport, RetroResponse } from '@/lib/admin-dashboard/retro-roi';
import { isAdminDashboardEnabled } from '@/lib/admin-dashboard/access';
import { useTRPCClient } from '@/providers/query-provider';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';
import { useSyncExternalStore } from 'react';

type RetroRoiState =
  | { status: 'loading' }
  | { status: 'denied' }
  | { status: 'demo' }
  | { status: 'error'; retry: () => void }
  | {
      status: 'unavailable';
      reason: Extract<RetroResponse, { status: 'unavailable' }>['reason'];
      retry: () => void;
    }
  | {
      status: 'ready';
      report: RetroReport;
      viewerScopeKey: string;
      refreshing: boolean;
      refresh: () => void;
    };

export function useRetroRoi(): RetroRoiState {
  const { data: session, isLoading: sessionLoading, isError: sessionError } = useSession();
  const client = useTRPCClient();
  const scope = useSyncExternalStore(subscribeMailCacheScope, getMailCacheScope, getMailCacheScope);
  const demo = isFrontendOnlyDemo();
  const canAccess = isAdminDashboardEnabled(session);
  const viewerScopeKey = JSON.stringify({
    sessionUserId: session?.user?.id ?? null,
    cacheUserId: scope.userId,
    activeTransportId: scope.activeTransportId,
  });
  const scopeReady = Boolean(session?.user?.id && scope.userId === session.user.id);
  const query = useQuery({
    queryKey: ['adminDashboard', 'retro-roi/1', viewerScopeKey],
    queryFn: ({ signal }) =>
      client.adminDashboard.getRetroReport.query(undefined, {
        ...inMailbox(scope.activeTransportId),
        signal,
      }),
    enabled: !demo && canAccess && scopeReady && !sessionLoading && !sessionError,
    staleTime: 60_000,
    refetchInterval: (query) => {
      const response = query.state.data;
      return response?.status === 'unavailable' ||
        (response?.status === 'ready' && response.report.coverage.status === 'partial')
        ? 60_000
        : false;
    },
    retry: false,
    // Do not display persisted reports until this viewer has revalidated access.
    refetchOnMount: 'always',
  });
  const retry = () => {
    void query.refetch();
  };

  if (sessionLoading) return { status: 'loading' };
  if (sessionError)
    return {
      status: 'error',
      retry: () => {
        window.location.reload();
      },
    };
  if (!canAccess) return { status: 'denied' };
  if (demo) return { status: 'demo' };
  if (!scopeReady || query.isPending || !query.isFetchedAfterMount) return { status: 'loading' };
  if (query.isError) return { status: 'error', retry };
  const response = query.data;
  if (!response) return { status: 'error', retry };
  if (response.status === 'unavailable') return { ...response, retry };
  return {
    status: 'ready',
    report: response.report,
    viewerScopeKey,
    refreshing: query.isFetching,
    refresh: retry,
  };
}
