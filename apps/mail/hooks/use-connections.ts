import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { isFrontendOnlyDemo } from '@/lib/demo-frontonly';

const DEMO_CONNECTION = {
  id: 'demo-connection',
  providerId: 'google',
  email: 'centurion@legacyhotels.com',
  name: 'The Centurion',
  picture: null,
  createdAt: '2026-04-08T00:00:00.000Z',
};

export const getDemoConnection = () => DEMO_CONNECTION;

export const useConnections = () => {
  const isDemoOnly = isFrontendOnlyDemo();
  const trpc = useTRPC();

  const demoConnectionsQuery = useQuery({
    queryKey: ['demo-mail', 'connections'],
    queryFn: () => Promise.resolve({ connections: [DEMO_CONNECTION] }),
    initialData: { connections: [DEMO_CONNECTION] },
    enabled: isDemoOnly,
    staleTime: 1000 * 60 * 60, // 1 hour
  });

  const trpcConnectionsQuery = useQuery(
    trpc.connections.list.queryOptions(void 0, {
      enabled: !isDemoOnly,
    }),
  );

  if (isDemoOnly) {
    return demoConnectionsQuery;
  }

  const connectionsQuery = trpcConnectionsQuery;
  return connectionsQuery;
};

export const useActiveConnection = () => {
  const isDemoOnly = isFrontendOnlyDemo();
  const trpc = useTRPC();
  const demoConnectionQuery = useQuery({
    queryKey: ['demo-mail', 'active-connection'],
    queryFn: () => Promise.resolve(DEMO_CONNECTION),
    initialData: DEMO_CONNECTION,
    enabled: isDemoOnly,
    staleTime: 1000 * 60 * 60, // 1 hour,
    gcTime: 1000 * 60 * 60 * 24, // 24 hours
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  const trpcConnectionQuery = useQuery(
    trpc.connections.getDefault.queryOptions(void 0, {
      staleTime: 1000 * 60 * 60, // 1 hour,
      gcTime: 1000 * 60 * 60 * 24, // 24 hours
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
      enabled: !isDemoOnly,
    }),
  );

  if (isDemoOnly) {
    return demoConnectionQuery;
  }

  return trpcConnectionQuery;
};
