import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';

export const useSummary = (threadId: string | null) => {
  const trpc = useTRPC();
  const frontendOnlyDemo = isFrontendOnlyDemo();
  const summaryQuery = useQuery(
    trpc.brain.generateSummary.queryOptions(
      { threadId: threadId! },
      {
        enabled: !!threadId && !frontendOnlyDemo,
      },
    ),
  );

  return summaryQuery;
};

export const useBrainState = () => {
  const trpc = useTRPC();
  const frontendOnlyDemo = isFrontendOnlyDemo();
  const brainStateQuery = useQuery(
    trpc.brain.getState.queryOptions(undefined, {
      enabled: !frontendOnlyDemo,
      staleTime: 1000 * 60 * 60, // 1 hour
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }),
  );

  return brainStateQuery;
};
