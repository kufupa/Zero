import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';

export function useEmailAliases() {
  const trpc = useTRPC();
  const demoMode = isFrontendOnlyDemo();
  const demoAliasesQuery = useQuery({
    queryKey: ['demo', 'mail', 'aliases'],
    queryFn: async () => [
      {
        email: 'demo@centurion.local',
        name: 'Centurion Demo Inbox',
        primary: true,
      },
    ],
    enabled: demoMode,
    staleTime: Infinity,
  });
  const emailAliasesQuery = useQuery(
    trpc.mail.getEmailAliases.queryOptions(void 0, {
      enabled: !demoMode,
      initialData: [] as { email: string; name: string; primary?: boolean }[],
    }),
  );
  return demoMode ? demoAliasesQuery : emailAliasesQuery;
}
