import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@zero/server/trpc';
import superjson from 'superjson';

const getUrl = () => import.meta.env.VITE_PUBLIC_BACKEND_URL + '/api/trpc';

/** Request-scoped tRPC client for loaders / SSR (if used). Prefer `getFrontendApi()` in app code. */
export const getServerTrpc = (req: Request) =>
  createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        maxItems: 1,
        url: getUrl(),
        transformer: superjson,
        headers: req.headers,
      }),
    ],
  });
