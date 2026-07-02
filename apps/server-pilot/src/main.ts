import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { authProviders, customProviders, isProviderEnabled } from './lib/auth-providers.js';
import { createAuth } from './lib/auth.js';
import { appRouter } from './trpc/router.js';

const app = new Hono();

app.get('/health', (c) =>
  c.json({ ok: true, service: 'server-pilot' }),
);

// Public providers endpoint consumed by apps/mail login page.
app.get('/api/public/providers', (c) => {
  const env = process.env as Record<string, string>;
  const isProd = env.NODE_ENV === 'production';

  const authProviderStatus = authProviders(env).map((provider) => {
    const envVarStatus =
      provider.envVarInfo?.map((envVar) => {
        return {
          name: envVar.name,
          set: !!env[envVar.name],
          source: envVar.source,
          defaultValue: envVar.defaultValue,
        };
      }) || [];
    return {
      id: provider.id,
      name: provider.name,
      enabled: isProviderEnabled(provider, env),
      required: provider.required,
      envVarInfo: provider.envVarInfo,
      envVarStatus,
    };
  });

  const customProviderStatus = customProviders.map((provider) => ({
    id: provider.id,
    name: provider.name,
    enabled: true,
    isCustom: provider.isCustom,
    customRedirectPath: provider.customRedirectPath,
    envVarStatus: [],
  }));

  return c.json({
    allProviders: [...customProviderStatus, ...authProviderStatus],
    isProd,
  });
});

// Better Auth handlers mount at /api/auth/* (better-auth default basePath).
const auth = createAuth();
app.on(['GET', 'POST', 'OPTIONS'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// tRPC endpoint. We use `@trpc/server/adapters/fetch`'s `fetchRequestHandler`
// directly (instead of `@hono/trpc-server`) to avoid a dual-package types
// clash between the ESM `.d.mts` and CJS `.d.cts` declarations that the
// @hono/trpc-server wrapper pulls in under `moduleResolution: NodeNext`.
//
// Context factory hands the Better Auth instance + raw request headers to the
// procedure layer; `privateProcedure` resolves the session user from cookies,
// `mailboxProcedure` resolves the active transport from the
// `x-zero-active-transport` header (or the user's highest-role transport).
app.on(['GET', 'POST'], '/api/trpc/*', (c) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    router: appRouter,
    req: c.req.raw,
    allowMethodOverride: true,
    createContext: () => ({ auth, reqHeaders: c.req.raw.headers }),
    onError: (opts) => {
      console.error('tRPC error:', opts.error);
    },
  }),
);

const port = Number(process.env.PORT ?? 8788);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server-pilot listening on http://0.0.0.0:${info.port}`);
});
