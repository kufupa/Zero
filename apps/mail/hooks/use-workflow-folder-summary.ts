import { useQuery } from '@tanstack/react-query';
import type { Outputs } from '@zero/server/trpc';
import { useActiveConnection } from '@/hooks/use-connections';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useTRPC } from '@/providers/query-provider';

type LiveWorkflowFolderSummary = Extract<
  Outputs['workflowFolders']['summary'],
  { quotes: { threads: number } }
>;

export function useWorkflowFolderSummary(enabled = true) {
  const trpc = useTRPC();
  const { data: activeConnection } = useActiveConnection();
  const isPilot = !isFrontendOnlyDemo() && activeConnection?.providerId === 'mailbox';

  return useQuery(
    trpc.workflowFolders.summary.queryOptions(undefined, {
      enabled: enabled && isPilot,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      select: (summary) => (isLiveWorkflowFolderSummary(summary) ? summary : undefined),
    }),
  );
}

function isLiveWorkflowFolderSummary(
  summary: Outputs['workflowFolders']['summary'],
): summary is LiveWorkflowFolderSummary {
  return 'threads' in summary.quotes;
}
