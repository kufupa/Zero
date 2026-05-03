import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@zero/server/trpc';
import superjson from 'superjson';
import { resolveMailMode } from '@/lib/runtime/mail-mode';

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

export const getServerTrpc = (req: Request) =>
  resolveMailMode() === 'demo'
    ? (createDemoTrpcClient() as AppRouter)
    : createTRPCClient<AppRouter>({
        links: [
          httpBatchLink({
            maxItems: 1,
            url: getUrl(),
            transformer: superjson,
            headers: req.headers,
          }),
        ],
      });
