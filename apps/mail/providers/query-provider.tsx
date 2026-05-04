import {
  PersistQueryClientProvider,
  type PersistedClient,
  type Persister,
} from '@tanstack/react-query-persist-client';
import { QueryCache, QueryClient, hashKey, type InfiniteData } from '@tanstack/react-query';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import { useMemo, type PropsWithChildren } from 'react';
import type { AppRouter } from '@zero/server/trpc';
import { resolveMailMode, type MailApiMode } from '@/lib/runtime/mail-mode';
import { mailListThreadsPrefixKey } from '@/lib/api/query-options';
import type { ThreadListResult } from '@/lib/api/contract';
import { resolveDemoQueryPolicy } from '@/lib/demo/query-policy';
import { CACHE_BURST_KEY } from '@/lib/constants';
import { signOut } from '@/lib/auth-client';
import { get, set, del } from 'idb-keyval';
import { api } from '@/lib/trpc';

function createIDBPersister(idbValidKey: IDBValidKey = 'zero-query-cache') {
  return {
    persistClient: async (client: PersistedClient) => {
      await set(idbValidKey, client);
    },
    restoreClient: async () => {
      return await get<PersistedClient>(idbValidKey);
    },
    removeClient: async () => {
      await del(idbValidKey);
    },
  } satisfies Persister;
}

export const makeQueryClient = (opts: { mode: ReturnType<typeof resolveMailMode>; connectionId: string | null }) =>
  new QueryClient({
    queryCache: new QueryCache({
      onError: (err, { meta }) => {
        if (resolveMailMode() === 'demo') return;
        if (meta && meta.noGlobalError === true) return;
        if (meta && typeof meta.customError === 'string') console.error(meta.customError);
        else if (
          err.message === 'Required scopes missing' ||
          err.message.includes('Invalid connection')
        ) {
          signOut({
            fetchOptions: {
              onSuccess: () => {
                if (window.location.href.includes('/login')) return;
                window.location.href = '/login?error=required_scopes_missing';
              },
            },
          });
        } else console.error(err.message || 'Something went wrong');
      },
    }),
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        queryKeyHashFn: (queryKey) =>
          hashKey([{ mode: opts.mode, connectionId: opts.connectionId }, ...queryKey]),
        gcTime: 1000 * 60 * 60 * 24, // 24 hours,
      },
      mutations: {
        onError: (err) => console.error(err.message),
      },
    },
  });

const browserQueryClient = {
  queryClient: null as QueryClient | null,
  activeConnectionId: null as string | null,
  activeMode: null as MailApiMode | null,
};

const getQueryClient = (connectionId: string | null, mode: MailApiMode) => {
  if (typeof window === 'undefined') {
    return makeQueryClient({ mode, connectionId });
  }
  if (
    !browserQueryClient.queryClient ||
    browserQueryClient.activeConnectionId !== connectionId ||
    browserQueryClient.activeMode !== mode
  ) {
    browserQueryClient.queryClient = makeQueryClient({ mode, connectionId });
    browserQueryClient.activeConnectionId = connectionId;
    browserQueryClient.activeMode = mode;
  }
  return browserQueryClient.queryClient;
};

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

/** Same singleton as `lib/trpc` `api` — for TRPC shell + direct `trpcClient` imports. Prefer `getFrontendApi()` in UI. */
export const trpcClient: AppRouter = api;

type TrpcHook = ReturnType<typeof useTRPC>;
export function QueryProvider({
  children,
  connectionId,
}: PropsWithChildren<{ connectionId: string | null }>) {
  const mode = resolveMailMode();
  const demoQueryPolicy = resolveDemoQueryPolicy();
  const persister = useMemo(
    () => createIDBPersister(`zero-query-cache-v2-${mode}-${connectionId ?? 'anon'}`),
    [connectionId, mode],
  );
  const policyAwarePersister = useMemo(
    () =>
      demoQueryPolicy.shouldHydratePersistedQueries
        ? persister
        : {
            persistClient: persister.persistClient,
            removeClient: persister.removeClient,
            restoreClient: async () => undefined,
          },
    [demoQueryPolicy.shouldHydratePersistedQueries, persister],
  );
  const queryClient = useMemo(() => getQueryClient(connectionId, mode), [connectionId, mode]);

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: policyAwarePersister,
        buster: CACHE_BURST_KEY,
        maxAge: 1000 * 60 * 60 * 24, // 24 hours
      }}
      onSuccess={() => {
        if (!demoQueryPolicy.shouldInvalidateHydratedThreadQueries) return;
        const trimInfinite = <T extends { pages: unknown[]; pageParams: unknown[] }>(data: T) => ({
          ...data,
          pages: data.pages.slice(0, 3),
          pageParams: data.pageParams.slice(0, 3),
        });
        const threadQueryKey = [['mail', 'listThreads'], { type: 'infinite' }];
        queryClient.setQueriesData(
          { queryKey: threadQueryKey },
          (data: InfiniteData<TrpcHook['mail']['listThreads']['~types']['output']>) => {
            if (!data) return data;
            return trimInfinite(data);
          },
        );
        queryClient.invalidateQueries({ queryKey: threadQueryKey });
        if (mode === 'legacy') {
          const feListKey = mailListThreadsPrefixKey({ mode, accountId: connectionId });
          queryClient.setQueriesData({ queryKey: feListKey }, (data: InfiniteData<ThreadListResult> | undefined) => {
            if (!data) return data;
            return trimInfinite(data);
          });
          queryClient.invalidateQueries({ queryKey: feListKey });
        }
      }}
    >
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </PersistQueryClientProvider>
  );
}

type IDBValidKey = string;
