import { getMailCacheScope, inMailbox, subscribeMailCacheScope } from '@/lib/mail/mail-cache-scope';
import type { RetroReport, RetroResponse } from '@/lib/admin-dashboard/retro-roi';
import { isAdminDashboardEnabled } from '@/lib/admin-dashboard/access';
import { isUnauthorizedTrpcError } from '@/lib/mail/auth-boundary';
import { useTRPCClient } from '@/providers/query-provider';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useRef, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';
import { TRPCClientError } from '@trpc/client';

function isRetroAccessError(error: unknown): boolean {
  if (isUnauthorizedTrpcError(error)) return true;
  if (error instanceof TRPCClientError) {
    const response = error.meta?.response;
    if (
      error.data?.code === 'FORBIDDEN' ||
      error.data?.httpStatus === 401 ||
      error.data?.httpStatus === 403 ||
      (response instanceof Response && (response.status === 401 || response.status === 403))
    )
      return true;
  }
  return error instanceof Error && /\b(?:UNAUTHORIZED|FORBIDDEN)\b/i.test(error.message);
}

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
  const lastSuccessfulReport = useRef<{ scopeKey: string; report: RetroReport } | null>(null);
  if (lastSuccessfulReport.current?.scopeKey !== viewerScopeKey)
    lastSuccessfulReport.current = null;
  const query = useQuery({
    queryKey: ['adminDashboard', 'retro-roi/1', viewerScopeKey],
    queryFn: async ({ signal }) => {
      const response = await client.adminDashboard.getRetroReport.query(undefined, {
        ...inMailbox(scope.activeTransportId),
        signal,
      });
      const currentScope = getMailCacheScope();
      if (
        !signal.aborted &&
        currentScope.userId === scope.userId &&
        currentScope.activeTransportId === scope.activeTransportId
      ) {
        lastSuccessfulReport.current =
          response.status === 'ready'
            ? { scopeKey: viewerScopeKey, report: response.report }
            : null;
      }
      return response;
    },
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
  if (sessionError) {
    lastSuccessfulReport.current = null;
    return {
      status: 'error',
      retry: () => {
        window.location.reload();
      },
    };
  }
  if (!canAccess) {
    lastSuccessfulReport.current = null;
    return { status: 'denied' };
  }
  if (demo) return { status: 'demo' };
  if (!scopeReady || query.isPending || !query.isFetchedAfterMount) return { status: 'loading' };
  let response = query.data;
  if (query.isError) {
    if (isRetroAccessError(query.error)) {
      lastSuccessfulReport.current = null;
      return { status: 'denied' };
    }
    const retained = lastSuccessfulReport.current;
    if (!retained || retained.scopeKey !== viewerScopeKey) return { status: 'error', retry };
    response = { status: 'ready', report: retained.report };
  }
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
