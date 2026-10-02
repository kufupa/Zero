import { getDemoActiveConnection, listDemoConnections } from '@/lib/demo-data/client';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';

export const useConnections = () => {
  const trpc = useTRPC();
  const demoMode = isFrontendOnlyDemo();
  const { data: session } = useSession();
  const demoConnectionsQuery = useQuery({
    queryKey: ['demo', 'connections'],
    queryFn: async () => listDemoConnections(),
    enabled: demoMode,
    staleTime: Infinity,
  });
  const connectionsQuery = useQuery(
    trpc.connections.list.queryOptions(void 0, {
      enabled: !demoMode && !!session?.user?.id,
    }),
  );
  return demoMode ? demoConnectionsQuery : connectionsQuery;
};

export const useActiveConnection = () => {
  const trpc = useTRPC();
  const demoMode = isFrontendOnlyDemo();
  const { data: session } = useSession();
  const demoActiveConnectionQuery = useQuery({
    queryKey: ['demo', 'connections', 'active'],
    queryFn: async () => getDemoActiveConnection(),
    enabled: demoMode,
    staleTime: Infinity,
  });
  const connectionsQuery = useQuery(
    trpc.connections.getDefault.queryOptions(void 0, {
      enabled: !demoMode && !!session?.user?.id,
      staleTime: 1000 * 60 * 60, // 1 hour,
      gcTime: 1000 * 60 * 60 * 24, // 24 hours
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
    }),
  );
  return demoMode ? demoActiveConnectionQuery : connectionsQuery;
};
