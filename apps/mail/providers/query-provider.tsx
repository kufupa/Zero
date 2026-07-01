import {
  PersistQueryClientProvider,
  type PersistedClient,
  type Persister,
} from '@tanstack/react-query-persist-client';
import { QueryCache, QueryClient, hashKey, type InfiniteData } from '@tanstack/react-query';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { useMemo, type PropsWithChildren } from 'react';
import type { AppRouter } from '@zero/server/trpc';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { resolveDemoQueryPolicy } from '@/lib/demo/query-policy';
import { CACHE_BURST_KEY } from '@/lib/constants';
import { signOut } from '@/lib/auth-client';
import { get, set, del } from 'idb-keyval';
import superjson from 'superjson';
import { makeLiveQueryHashPrefix } from '@/lib/mail/query-cache-policy';
import {
  getMailCacheScope,
  idbCacheKeyForScope,
  setMailCacheScope,
  type MailCacheScope,
} from '@/lib/mail/mail-cache-scope';
import { useSession } from '@/lib/auth-client';
import { useActiveConnection } from '@/hooks/use-connections';
import { useEffect } from 'react';

const createBackendDisabledError = (path: string[]) => {
  const route = path.join('.');
  return new Error(`[demo mode] Backend TRPC route is disabled: ${route}`);
};

const makeQueryKey = (path: string[], input?: unknown) => {
  if (input === undefined) return ['demo', ...path];
  return ['demo', ...path, input];
};

const makeFailingPromise = (path: string[]) => () =>
  Promise.reject(createBackendDisabledError(path));

const createDemoProcedureNode = (path: string[]): unknown => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;

        if (prop === 'query') {
          return makeFailingPromise([...path, 'query']);
        }

        if (prop === 'mutate') {
          return makeFailingPromise([...path, 'mutate']);
        }

        if (prop === 'queryOptions') {
          return (input?: unknown) => ({
            queryKey: makeQueryKey(path, input),
            queryFn: makeFailingPromise([...path, 'query']) as never,
          });
        }

        if (prop === 'mutationOptions') {
          return (input?: unknown) => ({
            mutationKey: makeQueryKey(path, input),
            mutationFn: makeFailingPromise([...path, 'mutate']) as never,
          });
        }

        if (prop === 'infiniteQueryOptions') {
          return (input?: unknown) => ({
            queryKey: makeQueryKey(path, input),
            queryFn: makeFailingPromise([...path, 'query']) as never,
          });
        }

        if (prop === 'queryKey') {
          return (input?: unknown) => makeQueryKey(path, input);
        }

        if (prop === 'infiniteQueryKey') {
          return (input?: unknown) => makeQueryKey(path, input);
        }

        if (prop === 'mutationKey') {
          return (input?: unknown) => makeQueryKey(path, input);
        }

        return createDemoProcedureNode([...path, prop]);
      },
    },
  ) as unknown;
};

const createDemoTrpcClient = (): unknown => createDemoProcedureNode([]);

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

export const makeQueryClient = (_legacyConnectionId?: string | null) =>
  new QueryClient({
    queryCache: new QueryCache({
      onError: (err, { meta }) => {
        if (isFrontendOnlyDemo()) return;
        if (meta && meta.noGlobalError === true) return;
        if (meta && typeof meta.customError === 'string') console.error(meta.customError);
        else if (
          err.message === 'Required scopes missing' ||
          err.message.includes('Invalid connection') ||
          err.message.includes('not permitted') ||
          err.message.includes('FORBIDDEN')
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
        queryKeyHashFn: (queryKey) => {
          const scope = getMailCacheScope();
          const prefix =
            scope.userId && scope.activeTransportId
              ? makeLiveQueryHashPrefix({
                  userId: scope.userId,
                  activeTransportId: scope.activeTransportId,
                })
              : { userId: scope.userId ?? 'anon', activeTransportId: scope.activeTransportId ?? 'pending' };
          return hashKey([prefix, ...queryKey]);
        },
        gcTime: 1000 * 60 * 60 * 24, // 24 hours,
      },
      mutations: {
        onError: (err) => console.error(err.message),
      },
    },
  });

let browserQueryClient = {
  queryClient: null,
  activeConnectionId: null,
} as {
  queryClient: QueryClient | null;
  activeConnectionId: string | null;
};

const getQueryClient = (scopeKey: string) => {
  if (typeof window === 'undefined') {
    return makeQueryClient();
  } else {
    if (!browserQueryClient.queryClient || browserQueryClient.activeConnectionId !== scopeKey) {
      browserQueryClient.queryClient = makeQueryClient();
      browserQueryClient.activeConnectionId = scopeKey;
    }
    return browserQueryClient.queryClient;
  }
};

const getUrl = () => import.meta.env.VITE_PUBLIC_BACKEND_URL + '/api/trpc';

const fetchWithTimeout = (url: RequestInfo | URL, options?: RequestInit) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  if (options?.signal) {
    options.signal.addEventListener(
      'abort',
      () => {
        controller.abort();
      },
      { once: true },
    );
  }

  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timeout);
  });
};

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

export const trpcClient: AppRouter = isFrontendOnlyDemo()
  ? (createDemoTrpcClient() as AppRouter)
  : createTRPCClient<AppRouter>({
      links: [
        // loggerLink({ enabled: () => true }),
        httpBatchLink({
          transformer: superjson,
          url: getUrl(),
          methodOverride: 'POST',
          maxItems: 1,
          fetch: (url, options) => {
            const headers = new Headers(options?.headers);
            const transportId = getMailCacheScope().activeTransportId;
            if (transportId) {
              headers.set('x-zero-active-transport', transportId);
            }
            return fetchWithTimeout(url, { ...options, headers, credentials: 'include' }).then(
              (res) => {
                const currentPath = new URL(window.location.href).pathname;
                const redirectPath = res.headers.get('X-Zero-Redirect');
                if (!!redirectPath && redirectPath !== currentPath) {
                  window.location.href = redirectPath;
                  res.headers.delete('X-Zero-Redirect');
                }
                return res;
              },
            );
          },
        }),
      ],
    });

type TrpcHook = ReturnType<typeof useTRPC>;

/** Sync session + active mailbox into cache scope singleton (inside QueryProvider). */
export function MailCacheScopeSync() {
  const demoMode = isFrontendOnlyDemo();
  const { data: session } = useSession();
  const { data: activeConnection } = useActiveConnection();

  useEffect(() => {
    if (demoMode) {
      setMailCacheScope({ userId: 'demo', activeTransportId: 'demo' });
      return;
    }
    setMailCacheScope({
      userId: session?.user?.id ?? null,
      activeTransportId: activeConnection?.id ?? null,
    });
  }, [demoMode, session?.user?.id, activeConnection?.id]);

  return null;
}

export function QueryProvider({
  children,
  mailCacheScope,
}: PropsWithChildren<{ mailCacheScope?: MailCacheScope }>) {
  const demoQueryPolicy = resolveDemoQueryPolicy();
  const scope = mailCacheScope ?? getMailCacheScope();
  const scopeKey = idbCacheKeyForScope(scope);

  useEffect(() => {
    setMailCacheScope(scope);
  }, [scope.userId, scope.activeTransportId]);

  const persister = useMemo(
    () => createIDBPersister(scopeKey),
    [scopeKey],
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
  const queryClient = useMemo(() => getQueryClient(scopeKey), [scopeKey]);

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
        const threadQueryKey = [['mail', 'listThreads'], { type: 'infinite' }];
        queryClient.setQueriesData(
          { queryKey: threadQueryKey },
          (data: InfiniteData<TrpcHook['mail']['listThreads']['~types']['output']>) => {
            if (!data) return data;
            return {
              pages: data.pages.slice(0, 3),
              pageParams: data.pageParams.slice(0, 3),
            };
          },
        );
        queryClient.invalidateQueries({ queryKey: threadQueryKey });
      }}
    >
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </PersistQueryClientProvider>
  );
}
