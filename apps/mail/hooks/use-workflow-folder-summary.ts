import { useQuery } from '@tanstack/react-query';
import { useActiveConnection } from '@/hooks/use-connections';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useTRPC } from '@/providers/query-provider';

export function useWorkflowFolderSummary(enabled = true, set?: 'eval') {
  const trpc = useTRPC();
  const { data: activeConnection } = useActiveConnection();
  const isPilot = !isFrontendOnlyDemo() && activeConnection?.providerId === 'mailbox';

  return useQuery(
    trpc.workflowFolders.summary.queryOptions(set ? { set } : undefined, {
      enabled: enabled && isPilot,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    }),
  );
}
