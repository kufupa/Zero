import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@zero/server/trpc';
import superjson from 'superjson';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';

const createBackendDisabledError = () =>
  new Error('[demo mode] Backend TRPC client is disabled in frontend-only mode');

const createFailingPromise = () => () => Promise.reject(createBackendDisabledError());

const createDemoProcedureNode = (path: string[]): unknown => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;

        if (prop === 'query') return createFailingPromise();
        if (prop === 'mutate') return createFailingPromise();

        if (prop === 'queryOptions') {
          return () => ({
            queryKey: ['demo', ...path],
            queryFn: createFailingPromise(),
          });
        }

        if (prop === 'mutationOptions' || prop === 'infiniteQueryOptions') {
          return () => ({
            mutationKey: ['demo', ...path],
            mutationFn: createFailingPromise(),
          });
        }

        if (prop === 'queryKey' || prop === 'infiniteQueryKey' || prop === 'mutationKey') {
          return () => ['demo', ...path];
        }

        return createDemoProcedureNode([...path, prop]);
      },
    },
  ) as unknown;
};

const createDemoTrpcClient = (): unknown => createDemoProcedureNode([]);

const getUrl = () => import.meta.env.VITE_PUBLIC_BACKEND_URL + '/api/trpc';

export const api: AppRouter = isFrontendOnlyDemo()
  ? (createDemoTrpcClient() as AppRouter)
  : createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          maxItems: 1,
          url: getUrl(),
          transformer: superjson,
          fetch: (url, options) =>
            fetch(url, { ...options, credentials: 'include' }).then((res) => {
              if (typeof window !== 'undefined') {
                const currentPath = new URL(window.location.href).pathname;
                const redirectPath = res.headers.get('X-Zero-Redirect');
                if (!!redirectPath && redirectPath !== currentPath) {
                  window.location.href = redirectPath;
                  res.headers.delete('X-Zero-Redirect');
                }
              }
              return res;
            }),
        }),
      ],
    });