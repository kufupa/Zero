import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';
import { isFrontendOnlyDemo } from '@/lib/demo-frontonly';

export function useSettings() {
  const { data: session } = useSession();
  const trpc = useTRPC();
  const isDemoOnly = isFrontendOnlyDemo();

  const settingsQuery = useQuery(
    trpc.settings.get.queryOptions(void 0, {
      enabled: !isDemoOnly && !!session?.user.id,
      staleTime: Infinity,
    }),
  );

  return settingsQuery;
}
