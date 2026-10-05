import type { QueryClient } from '@tanstack/react-query';
import type { MailCacheScope } from '@/lib/mail/mail-cache-scope';
import { idbCacheKeyForScope } from '@/lib/mail/mail-cache-scope';
import { runLogoutCleanup } from '@/lib/mail/query-cache-policy';

export function previousScopeBeforeSwitch(args: {
  current: MailCacheScope;
  nextTransportId: string;
}): MailCacheScope {
  return { ...args.current };
}

/** Same cache cleanup wiring as NavUser account switch (previous scope IDB + RQ clear). */
export async function runAccountSwitchCacheCleanup(args: {
  previousScope: MailCacheScope;
  queryClient: Pick<QueryClient, 'clear'>;
  deleteIdbKey: (key: string) => Promise<void>;
}): Promise<void> {
  await runLogoutCleanup({
    queryClient: args.queryClient,
    clearIdb: async () => {
      await args.deleteIdbKey(idbCacheKeyForScope(args.previousScope));
    },
  });
}
