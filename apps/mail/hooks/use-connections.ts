import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { getDemoActiveConnection, listDemoConnections } from '@/lib/demo-data/client';
import { getFrontendApi } from '@/lib/api/client';
import { resolveMailMode } from '@/lib/runtime/mail-mode';
import {
  connectionsGetDefaultQueryKey,
  connectionsListQueryKey,
  type ApiQueryContext,
} from '@/lib/api/query-options';

export const useConnections = () => {
  const demoMode = isFrontendOnlyDemo();
  const queryCtx = useMemo<ApiQueryContext>(
    () => ({ mode: resolveMailMode(), accountId: null }),
    [],
  );

  return useQuery({
    queryKey: demoMode ? (['demo', 'connections'] as const) : connectionsListQueryKey(queryCtx),
    queryFn: () => (demoMode ? listDemoConnections() : getFrontendApi().connections.list()),
    enabled: demoMode || queryCtx.mode === 'legacy',
    staleTime: Infinity,
  });
};

export const useActiveConnection = () => {
  const demoMode = isFrontendOnlyDemo();
  const queryCtx = useMemo<ApiQueryContext>(
    () => ({ mode: resolveMailMode(), accountId: null }),
    [],
  );

  return useQuery({
    queryKey: demoMode ? (['demo', 'connections', 'active'] as const) : connectionsGetDefaultQueryKey(queryCtx),
    queryFn: () => (demoMode ? getDemoActiveConnection() : getFrontendApi().connections.getDefault()),
    enabled: demoMode || queryCtx.mode === 'legacy',
    staleTime: 1000 * 60 * 60,
    gcTime: 1000 * 60 * 60 * 24,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });
};
