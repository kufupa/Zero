import {
  getMailCacheScope,
  idbCacheKeyForScope,
  setMailCacheScope,
  subscribeMailCacheScope,
} from '@/lib/mail/mail-cache-scope';
import {
  PersistQueryClientProvider,
  type PersistedClient,
  type Persister,
} from '@tanstack/react-query-persist-client';
import {
  createAuthBoundaryRecovery,
  isUnauthorizedTrpcError,
  sessionExpiredRedirect,
} from '@/lib/mail/auth-boundary';
import {
  MutationCache,
  QueryCache,
  QueryClient,
  hashKey,
  type InfiniteData,
} from '@tanstack/react-query';
import { resolveQueryHashPrefix, runLogoutCleanup } from '@/lib/mail/query-cache-policy';
import { useMemo, useRef, useSyncExternalStore, type PropsWithChildren } from 'react';
import { createTRPCClient, httpBatchLink, type TRPCClient } from '@trpc/client';
import { PERSIST_MAX_AGE, QUERY_GC_TIME } from '@/lib/mail/cache-ttl';
import { resolveDemoQueryPolicy } from '@/lib/demo/query-policy';
import { publicBackendTrpcUrl } from '@/lib/public-backend-url';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import { useActiveConnection } from '@/hooks/use-connections';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import type { AppRouter } from '@zero/server/trpc';
import { CACHE_BURST_KEY } from '@/lib/constants';
import { useSession } from '@/lib/auth-client';
import { signOut } from '@/lib/auth-client';
import { get, set, del } from 'idb-keyval';
import superjson from 'superjson';
import { useEffect } from 'react';
import { toast } from 'sonner';

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

const LEGACY_IDB_CACHE_KEY = 'zero-query-cache-default';

let idbPersistDegraded = false;
const recoverFromAuthBoundary = createAuthBoundaryRecovery();

function isIdbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

async function handleForbiddenSignOut(queryClient: QueryClient): Promise<void> {
  await runLogoutCleanup({
    queryClient,
    clearIdb: async () => {
      await del(idbCacheKeyForScope(getMailCacheScope()));
    },
  });
  signOut({
    fetchOptions: {
      onSuccess: () => {
        if (window.location.href.includes('/login')) return;
        window.location.href = '/login?error=required_scopes_missing';
      },
    },
  });
}

async function handleUnauthorizedSignOut(queryClient: QueryClient): Promise<void> {
  await recoverFromAuthBoundary({
    queryClient,
    clearIdb: async () => {
      await del(idbCacheKeyForScope(getMailCacheScope()));
    },
    signOut: () => signOut(),
    redirect: () => {
      if (typeof window === 'undefined' || window.location.pathname.includes('/login')) return;
      window.location.href = sessionExpiredRedirect(window.location.pathname);
    },
    onError: (error) => {
      console.error(
        '[auth] session recovery failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
    },
  });
}

function createIDBPersister(idbValidKey: IDBValidKey = 'zero-query-cache') {
  const noopPersister = {
    persistClient: async () => undefined,
    restoreClient: async () => undefined,
    removeClient: async () => undefined,
  } satisfies Persister;

  if (!isIdbAvailable()) {
    return noopPersister;
  }

  return {
    persistClient: async (client: PersistedClient) => {
      if (idbPersistDegraded) return;
      try {
        await set(idbValidKey, client);
      } catch (error) {
        if (!idbPersistDegraded) {
          idbPersistDegraded = true;
          console.warn('[query-cache] IndexedDB persist disabled:', error);
        }
      }
    },
    restoreClient: async () => {
      if (idbPersistDegraded) return undefined;
      try {
        return await get<PersistedClient>(idbValidKey);
      } catch (error) {
        if (!idbPersistDegraded) {
          idbPersistDegraded = true;
          console.warn('[query-cache] IndexedDB restore disabled:', error);
        }
        return undefined;
      }
    },
    removeClient: async () => {
      if (idbPersistDegraded) return;
      try {
        await del(idbValidKey);
      } catch (error) {
        if (!idbPersistDegraded) {
          idbPersistDegraded = true;
          console.warn('[query-cache] IndexedDB remove disabled:', error);
        }
      }
    },
  } satisfies Persister;
}

export const makeQueryClient = () => {
  const queryClient = new QueryClient({
    mutationCache: new MutationCache({
      onError: (err, _variables, _onMutateResult, mutation) => {
        const { meta } = mutation.options;
        if (isFrontendOnlyDemo()) return;
        if (meta && meta.noGlobalError === true) return;
        if (isUnauthorizedTrpcError(err)) {
          void handleUnauthorizedSignOut(queryClient);
        }
      },
    }),
    queryCache: new QueryCache({
      onError: (err, query) => {
        const { meta } = query;
        if (isFrontendOnlyDemo()) return;
        if (meta && meta.noGlobalError === true) return;
        if (isUnauthorizedTrpcError(err)) {
          void handleUnauthorizedSignOut(queryClient);
        } else if (meta && typeof meta.customError === 'string') {
          console.error(meta.customError);
        } else if (err.message === 'NO_MAILBOX') {
          toast.error('No mailbox assigned');
        } else if (
          err.message === 'Required scopes missing' ||
          err.message.includes('Invalid connection') ||
          err.message.includes('not permitted') ||
          err.message === 'FORBIDDEN'
        ) {
          void handleForbiddenSignOut(queryClient);
        } else console.error(err.message || 'Something went wrong');
      },
    }),
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        queryKeyHashFn: (queryKey) => {
          const prefix = resolveQueryHashPrefix(getMailCacheScope());
          return hashKey([prefix, ...queryKey]);
        },
        gcTime: QUERY_GC_TIME,
      },
      mutations: {
        onError: (err) => console.error(err.message),
      },
    },
  });
  return queryClient;
};

let browserQueryClient: QueryClient | null = null;

const getQueryClient = () => {
  if (typeof window === 'undefined') {
    return makeQueryClient();
  }
  if (!browserQueryClient) {
    browserQueryClient = makeQueryClient();
  }
  return browserQueryClient;
};

const getUrl = () => publicBackendTrpcUrl();

const fetchWithTimeout = (url: RequestInfo | URL, options?: RequestInit) => {
  const controller = new AbortController();
  const body = typeof options?.body === 'string' ? options.body : '';
  const timeoutMs = body.includes('quoteProposalPdf') ? 60_000 : 5_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

export const trpcClient: TRPCClient<AppRouter> = isFrontendOnlyDemo()
  ? (createDemoTrpcClient() as TRPCClient<AppRouter>)
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

export function QueryProvider({ children }: PropsWithChildren) {
  const demoQueryPolicy = resolveDemoQueryPolicy();
  const scope = useSyncExternalStore(subscribeMailCacheScope, getMailCacheScope, getMailCacheScope);
  const scopeKey = idbCacheKeyForScope(scope);
  const scopeReady = Boolean(scope.userId && scope.activeTransportId);
  const prevScopeKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !isIdbAvailable()) return;
    void del(LEGACY_IDB_CACHE_KEY).catch(() => undefined);
  }, []);

  const persister = useMemo(() => createIDBPersister(scopeKey), [scopeKey]);
  const policyAwarePersister = useMemo(() => {
    const gatedPersister = {
      persistClient: async () => undefined,
      restoreClient: async () => undefined,
      removeClient: persister.removeClient,
    } satisfies Persister;

    if (!demoQueryPolicy.shouldHydratePersistedQueries || !scopeReady) {
      return gatedPersister;
    }
    return persister;
  }, [demoQueryPolicy.shouldHydratePersistedQueries, persister, scopeReady]);
  const queryClient = useMemo(() => getQueryClient(), []);

  useEffect(() => {
    if (!scopeReady) return;
    if (prevScopeKeyRef.current === scopeKey) return;
    const hadPreviousScope = prevScopeKeyRef.current !== null;
    prevScopeKeyRef.current = scopeKey;
    if (hadPreviousScope) {
      void queryClient.invalidateQueries();
    }
  }, [scopeKey, scopeReady, queryClient]);

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: policyAwarePersister,
        buster: CACHE_BURST_KEY,
        maxAge: PERSIST_MAX_AGE,
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
