import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { isFrontendOnlyDemo, resolveMailMode } from '@/lib/runtime/mail-mode';
import { demoGenerateSummary } from '@/lib/demo/local-actions';
import { getFrontendApi } from '@/lib/api/client';
import {
  aiBrainStateQueryOptions,
  aiGenerateSummaryQueryKey,
  type ApiQueryContext,
} from '@/lib/api/query-options';

export const useSummary = (threadId: string | null) => {
  const frontendOnlyDemo = isFrontendOnlyDemo();
  const queryCtx = useMemo<ApiQueryContext>(
    () => ({ mode: resolveMailMode(), accountId: null }),
    [],
  );

  return useQuery({
    queryKey: frontendOnlyDemo
      ? (['demo', 'brain', 'generateSummary', threadId] as const)
      : aiGenerateSummaryQueryKey(queryCtx, threadId ?? ''),
    queryFn: () =>
      frontendOnlyDemo
        ? demoGenerateSummary({
            threadId: threadId || 'unknown',
            isFrontendOnlyDemoMode: true,
          })
        : getFrontendApi().ai.generateSummary({ threadId: threadId as string }),
    enabled: Boolean(threadId) && (frontendOnlyDemo || queryCtx.mode === 'legacy'),
  });
};

export const useBrainState = () => {
  const frontendOnlyDemo = isFrontendOnlyDemo();
  const queryCtx = useMemo<ApiQueryContext>(
    () => ({ mode: resolveMailMode(), accountId: null }),
    [],
  );

  return useQuery({
    ...aiBrainStateQueryOptions(getFrontendApi(), queryCtx),
    enabled: !frontendOnlyDemo && queryCtx.mode === 'legacy',
    staleTime: 1000 * 60 * 60, // 1 hour
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
};
