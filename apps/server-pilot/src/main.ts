import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { authProviders, customProviders, isProviderEnabled } from './lib/auth-providers.js';
import { createAuth } from './lib/auth.js';

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

const port = Number(process.env.PORT ?? 8788);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server-pilot listening on http://0.0.0.0:${info.port}`);
});
